use super::budgets::budget_add;
use super::*;
use crate::model::{SafeSpendCommitment, SafeSpendSettings, SafeSpendSnapshot};
use rust_decimal::{prelude::ToPrimitive, Decimal};

impl Db {
    pub fn safe_spend_settings(&self) -> Result<SafeSpendSettings, AppError> {
        let stored = self.conn.query_row(
            "SELECT payday,buffer_cents,protected_cents,updated_at FROM safe_spend_settings WHERE id=1", [],
            |r| Ok((r.get::<_,Option<String>>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?))).optional()?;
        let configured = stored.is_some();
        let (payday, buffer_cents, protected_cents, updated_at) =
            stored.unwrap_or((None, 0, 0, String::new()));
        let sql = if configured {
            "SELECT s.account_id FROM safe_spend_accounts s JOIN accounts a ON a.id=s.account_id WHERE a.archived=0 AND a.kind!='credit' ORDER BY s.account_id"
        } else {
            "SELECT id FROM accounts WHERE archived=0 AND kind IN ('cash','checking') ORDER BY id"
        };
        let mut stmt = self.conn.prepare(sql)?;
        let account_ids = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(SafeSpendSettings {
            payday,
            buffer_cents,
            protected_cents,
            account_ids,
            configured,
            updated_at,
        })
    }

    pub fn save_safe_spend_settings(&self, settings: &SafeSpendSettings) -> Result<(), AppError> {
        if settings.buffer_cents < 0
            || settings.protected_cents < 0
            || settings.account_ids.is_empty()
        {
            return Err(AppError::Validation(
                "select at least one cash account and use nonnegative reserves".into(),
            ));
        }
        if let Some(date) = settings.payday.as_deref() {
            let days = (parse_date(date)? - Local::now().date_naive()).num_days();
            if !(1..=365).contains(&days) {
                return Err(AppError::Validation(
                    "payday must be within the next 365 days".into(),
                ));
            }
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("INSERT INTO safe_spend_settings(id,payday,buffer_cents,protected_cents,updated_at) VALUES(1,?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET payday=excluded.payday,buffer_cents=excluded.buffer_cents,protected_cents=excluded.protected_cents,updated_at=excluded.updated_at",
            params![settings.payday,settings.buffer_cents,settings.protected_cents,now_timestamp()])?;
        tx.execute("DELETE FROM safe_spend_accounts", [])?;
        for id in settings.account_ids.iter().collect::<HashSet<_>>() {
            let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM accounts WHERE id=?1 AND archived=0 AND kind!='credit')",[id],|r|r.get(0))?;
            if !valid {
                return Err(AppError::Validation(
                    "spendable accounts must be active cash, checking or savings accounts".into(),
                ));
            }
            tx.execute(
                "INSERT INTO safe_spend_accounts(account_id) VALUES(?1)",
                [id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Uses only local dated FX quotes. A missing quote is an error, never a 1:1 assumption.
    fn safe_reporting_amount(
        &self,
        amount: i64,
        currency: &str,
        date: &str,
        warnings: &mut Vec<String>,
    ) -> Result<i64, AppError> {
        if amount == 0 || currency == self.currency_code()? {
            return Ok(amount);
        }
        let target = self.currency_code()?;
        let quote = if let Some(q) = self.lookup_manual_fx_rate(currency, &target, date)? {
            (q.rate, q.quoted_on, "manual")
        } else {
            let cached:Option<(String,String)>=self.conn.query_row(
                "SELECT rate,quoted_on FROM fx_rate_cache WHERE base_currency=?1 AND quote_currency=?2 AND quoted_on<=?3 ORDER BY quoted_on DESC,fetched_at DESC LIMIT 1",
                params![currency,target,date],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let (rate,on)=cached.ok_or_else(||AppError::Validation(format!("Add a dated {currency}/{target} exchange rate in Settings to calculate safe to spend.")))?;
            (rate, on, "cached")
        };
        let note = format!("{currency}/{target}: {} rate from {}.", quote.2, quote.1);
        if !warnings.contains(&note) {
            warnings.push(note);
        }
        let rate = quote
            .0
            .parse::<Decimal>()
            .map_err(|_| AppError::Validation("invalid stored exchange rate".into()))?;
        if rate <= Decimal::ZERO {
            return Err(AppError::Validation(
                "exchange rate must be positive".into(),
            ));
        }
        Decimal::from(amount)
            .checked_mul(rate)
            .and_then(|v| v.round_dp(0).to_i64())
            .ok_or_else(|| {
                AppError::Validation("converted amount exceeds the supported range".into())
            })
    }

    pub fn safe_to_spend(&self) -> Result<SafeSpendSnapshot, AppError> {
        let tx = self.conn.unchecked_transaction()?;
        let result = self.safe_to_spend_snapshot()?;
        tx.commit()?;
        Ok(result)
    }

    fn safe_to_spend_snapshot(&self) -> Result<SafeSpendSnapshot, AppError> {
        let settings = self.safe_spend_settings()?;
        let today = Local::now().date_naive();
        let as_of = today.format("%Y-%m-%d").to_string();
        let balances = self.balances(None)?;
        let selected: HashSet<i64> = settings.account_ids.iter().copied().collect();
        let credit: HashSet<i64> = balances
            .iter()
            .filter(|b| b.account_kind == AccountKind::Credit)
            .map(|b| b.account_id)
            .collect();
        let mut warnings = vec![];
        if selected.is_empty() {
            return Err(AppError::Validation(
                "Select a spendable account to calculate safe to spend.".into(),
            ));
        }
        if !settings.configured {
            warnings.push("Using cash and checking accounts with no additional emergency buffer. Review your settings.".into());
        }
        let mut cash = 0;
        let mut credit_reserve = 0;
        let mut goals_reserve = 0;
        let goals = self.list_planning_goals()?;
        for b in &balances {
            if selected.contains(&b.account_id) {
                cash = budget_add(
                    cash,
                    self.safe_reporting_amount(
                        b.current_balance_cents,
                        &b.currency_code,
                        &as_of,
                        &mut warnings,
                    )?,
                )?;
                let mut floor = 0;
                let mut sinking = 0;
                for goal in goals.iter().filter(|g| g.account_id == b.account_id) {
                    floor = floor.max(goal.minimum_balance_cents.unwrap_or(0));
                    sinking = budget_add(sinking, goal.target_amount_cents.unwrap_or(0))?;
                }
                // Goal floors and sinking funds protect money already held in this account, not hypothetical future savings.
                let reserve = floor.max(sinking).min(b.current_balance_cents.max(0));
                goals_reserve = budget_add(
                    goals_reserve,
                    self.safe_reporting_amount(reserve, &b.currency_code, &as_of, &mut warnings)?,
                )?;
            }
            if credit.contains(&b.account_id) && b.current_balance_cents < 0 {
                credit_reserve = budget_add(
                    credit_reserve,
                    self.safe_reporting_amount(
                        b.current_balance_cents.checked_neg().ok_or_else(|| {
                            AppError::Validation("credit balance exceeds supported range".into())
                        })?,
                        &b.currency_code,
                        &as_of,
                        &mut warnings,
                    )?,
                )?;
            }
        }
        let earliest:String=self.conn.query_row(
            "SELECT MIN(due) FROM (SELECT ?1 AS due UNION ALL SELECT next_due_on FROM recurring_rules WHERE paused=0 UNION ALL SELECT due_on FROM recurring_occurrences WHERE status='pending')",[&as_of],|r|r.get(0))?;
        let recurring = self.list_forecast_recurring_occurrences(
            parse_date(&earliest)?,
            today + Duration::days(365),
        )?;
        // Ignore posted/skipped occurrences, including future-dated ledger postings.
        let mut occurrences = vec![];
        for o in recurring {
            let done:bool=self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM recurring_occurrences WHERE rule_id=?1 AND due_on=?2 AND status IN ('posted','skipped')) OR EXISTS(SELECT 1 FROM transactions WHERE recurring_rule_id=?1 AND txn_date=?2 AND deleted_at IS NULL)",
                params![o.rule_id,o.due_on],|r|r.get(0))?;
            if !done {
                occurrences.push(o);
            }
        }
        let inferred = occurrences
            .iter()
            .filter(|o| {
                o.kind == TransactionKind::Income
                    && selected.contains(&o.account_id)
                    && o.due_on > as_of
            })
            .map(|o| o.due_on.clone())
            .min();
        let (payday, horizon_source) = if let Some(date) = settings.payday.clone() {
            if parse_date(&date)? <= today {
                return Err(AppError::Validation("Your saved payday has passed. Update it or switch to automatic payday in safe-to-spend settings.".into()));
            }
            (date, "manual")
        } else if let Some(date) = inferred {
            (date, "next recurring income")
        } else {
            warnings
                .push("No upcoming recurring income found; using a 30-day planning window.".into());
            (
                (today + Duration::days(30)).format("%Y-%m-%d").to_string(),
                "30-day fallback",
            )
        };
        let end = parse_date(&payday)?;
        let days = (end - today).num_days();
        if !(1..=365).contains(&days) {
            return Err(AppError::Validation(
                "planning window must be 1–365 days".into(),
            ));
        }
        let mut commitments = vec![];
        let mut add_commitment = |date: String,
                                  title: String,
                                  kind: TransactionKind,
                                  amount: i64,
                                  account: i64,
                                  to: Option<i64>,
                                  category: Option<i64>,
                                  reporting: Option<i64>|
         -> Result<(), AppError> {
            if date >= payday || kind == TransactionKind::Income {
                return Ok(());
            }
            let eligible = match kind {
                TransactionKind::Expense => {
                    selected.contains(&account) || credit.contains(&account)
                }
                TransactionKind::Transfer => {
                    selected.contains(&account)
                        && !to
                            .map(|id| selected.contains(&id) || credit.contains(&id))
                            .unwrap_or(false)
                }
                _ => false,
            };
            if !eligible {
                return Ok(());
            }
            let currency = balances
                .iter()
                .find(|b| b.account_id == account)
                .ok_or_else(|| {
                    AppError::Validation(
                        "scheduled payment refers to an unavailable account".into(),
                    )
                })?
                .currency_code
                .clone();
            let amount = if let Some(value) = reporting {
                value
            } else {
                self.safe_reporting_amount(amount, &currency, &as_of, &mut warnings)?
            };
            commitments.push(SafeSpendCommitment {
                date,
                title,
                amount_cents: amount,
                account_id: account,
                category_id: category,
            });
            Ok(())
        };
        for o in occurrences {
            let category: Option<i64> = self.conn.query_row(
                "SELECT category_id FROM recurring_rules WHERE id=?1",
                [o.rule_id],
                |r| r.get(0),
            )?;
            add_commitment(
                o.due_on,
                o.rule_name,
                o.kind,
                o.amount_cents,
                o.account_id,
                o.to_account_id,
                category,
                None,
            )?;
        }
        for p in self
            .list_planning_items(None, None, Some(&payday))?
            .into_iter()
            .filter(|p| p.scenario_id.is_none() && p.linked_transaction_id.is_none())
        {
            add_commitment(
                p.due_on,
                p.title,
                p.kind,
                p.amount_cents,
                p.account_id,
                p.to_account_id,
                p.category_id,
                None,
            )?;
        }
        let mut statement=self.conn.prepare("SELECT txn_date,COALESCE(payee,'Scheduled transaction'),kind,amount_cents,account_id,to_account_id,category_id,reporting_amount_cents FROM transactions WHERE deleted_at IS NULL AND txn_date>?1 AND txn_date<?2")?;
        let future = statement
            .query_map(params![as_of, payday], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, i64>(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (date, title, kind, amount, account, to, category, reporting) in future {
            add_commitment(
                date,
                title,
                TransactionKind::from_db(&kind)?,
                amount,
                account,
                to,
                category,
                Some(reporting),
            )?;
        }
        drop(add_commitment);
        commitments.sort_by(|a, b| a.date.cmp(&b.date).then(a.title.cmp(&b.title)));
        if commitments.iter().any(|c| c.date < as_of) {
            warnings.push("Unposted overdue bills are included. Post or resolve them to keep this estimate current.".into());
        }
        let scheduled = commitments
            .iter()
            .try_fold(0, |sum, c| budget_add(sum, c.amount_cents))?;
        let mut budget_reserve = 0;
        let mut cursor = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap();
        while cursor < end {
            let month = cursor.format("%Y-%m").to_string();
            let rows = self.budget_status_at(&month, None, None, Some(&as_of))?;
            for row in &rows {
                if row
                    .account_id
                    .map(|id| !selected.contains(&id) && !credit.contains(&id))
                    .unwrap_or(false)
                {
                    continue;
                }
                let mut overlap = 0;
                for c in &commitments {
                    let specific = rows.iter().any(|r| {
                        r.category_id == row.category_id && r.account_id == Some(c.account_id)
                    });
                    if c.category_id == Some(row.category_id)
                        && c.date.starts_with(&month)
                        && (row.account_id == Some(c.account_id)
                            || (row.account_id.is_none() && !specific))
                    {
                        overlap = budget_add(overlap, c.amount_cents)?;
                    }
                }
                let available = if month == today.format("%Y-%m").to_string() {
                    row.remaining_cents
                } else {
                    budget_add(row.allocated_cents, row.moved_cents)?
                };
                budget_reserve =
                    budget_add(budget_reserve, budget_add(available, -overlap)?.max(0))?;
            }
            cursor = add_months_with_day(cursor, 1, 1)?;
        }
        let protected = budget_add(goals_reserve, settings.protected_cents)?;
        let reserved = [
            scheduled,
            budget_reserve,
            credit_reserve,
            protected,
            settings.buffer_cents,
        ]
        .into_iter()
        .try_fold(0, budget_add)?;
        let remaining = budget_add(cash, -reserved)?;
        let latest_transaction_on = self.conn.query_row(
            "SELECT MAX(txn_date) FROM transactions WHERE deleted_at IS NULL AND txn_date<=?1",
            [&as_of],
            |r| r.get(0),
        )?;
        Ok(SafeSpendSnapshot {
            as_of,
            calculated_at: now_timestamp(),
            payday,
            horizon_source: horizon_source.into(),
            days,
            cash_cents: cash,
            scheduled_cents: scheduled,
            budget_reserve_cents: budget_reserve,
            credit_reserve_cents: credit_reserve,
            protected_cents: protected,
            buffer_cents: settings.buffer_cents,
            safe_cents: remaining.max(0),
            shortfall_cents: remaining
                .min(0)
                .checked_neg()
                .ok_or_else(|| AppError::Validation("shortfall exceeds supported range".into()))?,
            daily_cents: remaining.max(0) / days,
            latest_transaction_on,
            warnings,
            commitments,
            settings,
        })
    }
}
