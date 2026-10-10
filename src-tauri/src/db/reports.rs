use super::*;

impl Db {
    pub fn balances(&self, account_ref: Option<&str>) -> Result<Vec<BalanceRecord>, AppError> {
        self.balances_on(account_ref, &Local::now().date_naive().to_string())
    }

    pub fn balances_on(
        &self,
        account_ref: Option<&str>,
        date: &str,
    ) -> Result<Vec<BalanceRecord>, AppError> {
        let account_id = match account_ref {
            Some(reference) => Some(self.resolve_account_ref(reference)?),
            None => None,
        };

        let mut statement = self.conn.prepare(
            "SELECT
                a.id,
                a.name,
                a.kind,
                a.currency_code,
                a.opening_balance_cents + COALESCE(SUM(
                    CASE
                        WHEN t.kind = 'income' AND t.account_id = a.id THEN t.amount_cents
                        WHEN t.kind = 'expense' AND t.account_id = a.id THEN -t.amount_cents
                        WHEN t.kind = 'transfer' AND t.account_id = a.id THEN -t.amount_cents
                        WHEN t.kind = 'transfer' AND t.to_account_id = a.id THEN COALESCE(t.to_amount_cents, t.amount_cents)
                        ELSE 0
                    END
                ), 0) AS current_balance_cents
             FROM accounts a
             LEFT JOIN transactions t
               ON (t.account_id = a.id OR t.to_account_id = a.id)
              AND t.deleted_at IS NULL
              AND t.txn_date <= ?2
             WHERE a.archived = 0
               AND a.opened_on <= ?2
               AND (?1 IS NULL OR a.id = ?1)
             GROUP BY a.id, a.name, a.kind, a.currency_code, a.opening_balance_cents
             ORDER BY a.name COLLATE NOCASE",
        )?;

        let rows = statement.query_map(params![account_id, date], |row| {
            let kind: String = row.get(2)?;
            Ok(BalanceRecord {
                account_id: row.get(0)?,
                account_name: row.get(1)?,
                account_kind: AccountKind::from_db(&kind).map_err(map_db_error)?,
                currency_code: row.get(3)?,
                current_balance_cents: row.get(4)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn summary(
        &self,
        from: &str,
        to: &str,
        account_ref: Option<&str>,
    ) -> Result<SummaryRecord, AppError> {
        match account_ref {
            Some(reference) => self.summary_for_account(from, to, reference),
            None => self.summary_all_accounts(from, to),
        }
    }

    pub fn monthly_cash_flow_trend(
        &self,
        months: usize,
        account_ref: Option<&str>,
    ) -> Result<Vec<MonthlyCashFlowPoint>, AppError> {
        let months = months.max(1);
        let account_id = account_ref
            .map(|reference| self.resolve_account_ref(reference))
            .transpose()?;
        let current = Local::now().date_naive();
        let current_start = NaiveDate::from_ymd_opt(current.year(), current.month(), 1)
            .expect("current month should always be valid");
        let first_start = add_months_with_day(current_start, -((months - 1) as i32), 1)?;
        let mut points = Vec::with_capacity(months);

        for step in 0..months {
            let month_start = add_months_with_day(first_start, step as i32, 1)?;
            let next_start = add_months_with_day(month_start, 1, 1)?;
            let month_end = next_start
                .pred_opt()
                .expect("previous day should exist for month boundary");
            let (income_cents, expense_cents): (i64, i64) = self.conn.query_row(
                "SELECT
                COALESCE(SUM(CASE WHEN kind = 'income' AND ?3 IS NULL THEN reporting_amount_cents WHEN kind = 'income' THEN amount_cents ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'expense' AND ?3 IS NULL THEN reporting_amount_cents WHEN kind = 'expense' THEN amount_cents ELSE 0 END), 0)
                 FROM transactions
                 WHERE deleted_at IS NULL
                   AND txn_date >= ?1
                   AND txn_date <= ?2
                   AND (?3 IS NULL OR account_id = ?3)",
                params![
                    month_start.format("%Y-%m-%d").to_string(),
                    month_end.format("%Y-%m-%d").to_string(),
                    account_id,
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            points.push(MonthlyCashFlowPoint {
                month: month_start.format("%Y-%m").to_string(),
                income_cents,
                expense_cents,
                net_cents: income_cents - expense_cents,
            });
        }

        Ok(points)
    }

    pub fn category_spending(
        &self,
        from: &str,
        to: &str,
        limit: usize,
        account_ref: Option<&str>,
    ) -> Result<Vec<CategorySpendingPoint>, AppError> {
        let account_id = account_ref
            .map(|reference| self.resolve_account_ref(reference))
            .transpose()?;
        let mut statement = self.conn.prepare(
            "WITH allocations AS (
                SELECT t.category_id, t.amount_cents native_amount, t.reporting_amount_cents reporting_amount
                FROM transactions t
                WHERE t.deleted_at IS NULL AND t.kind='expense'
                  AND t.txn_date BETWEEN ?1 AND ?2 AND (?3 IS NULL OR t.account_id=?3)
                  AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id)
                UNION ALL
                SELECT s.category_id, s.amount_cents, s.reporting_amount_cents
                FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id
                WHERE t.deleted_at IS NULL AND t.kind='expense'
                  AND t.txn_date BETWEEN ?1 AND ?2 AND (?3 IS NULL OR t.account_id=?3)
             )
             SELECT c.id,c.name,SUM(CASE WHEN ?3 IS NULL THEN a.reporting_amount ELSE a.native_amount END) AS spent_cents
             FROM allocations a JOIN categories c ON c.id=a.category_id
             GROUP BY c.id,c.name
             ORDER BY spent_cents DESC, c.name COLLATE NOCASE
             LIMIT ?4",
        )?;

        let rows = statement.query_map(params![from, to, account_id, limit as i64], |row| {
            Ok(CategorySpendingPoint {
                category_id: row.get(0)?,
                category_name: row.get(1)?,
                spent_cents: row.get(2)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn spending_by_payee(
        &self,
        from: &str,
        to: &str,
        limit: usize,
        account_ref: Option<&str>,
    ) -> Result<Vec<SpendingBreakdownPoint>, AppError> {
        let account_id = account_ref
            .map(|reference| self.resolve_account_ref(reference))
            .transpose()?;
        let mut statement = self.conn.prepare(
            "SELECT
                COALESCE(NULLIF(TRIM(t.payee), ''), 'Unassigned') AS label,
                SUM(CASE WHEN ?3 IS NULL THEN t.reporting_amount_cents ELSE t.amount_cents END) AS spent_cents,
                COUNT(*) AS transaction_count
             FROM transactions t
             WHERE t.deleted_at IS NULL
               AND t.kind = 'expense'
               AND t.txn_date >= ?1
               AND t.txn_date <= ?2
               AND (?3 IS NULL OR t.account_id = ?3)
             GROUP BY COALESCE(NULLIF(TRIM(t.payee), ''), 'Unassigned')
             ORDER BY spent_cents DESC, label COLLATE NOCASE
             LIMIT ?4",
        )?;
        let rows = statement.query_map(params![from, to, account_id, limit as i64], |row| {
            Ok(SpendingBreakdownPoint {
                label: row.get(0)?,
                spent_cents: row.get(1)?,
                transaction_count: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn spending_by_tag(
        &self,
        from: &str,
        to: &str,
        limit: usize,
        account_ref: Option<&str>,
    ) -> Result<Vec<SpendingBreakdownPoint>, AppError> {
        let account_id = account_ref
            .map(|reference| self.resolve_account_ref(reference))
            .transpose()?;
        let mut statement = self.conn.prepare(
            "SELECT
                tag.name AS label,
                SUM(CASE WHEN ?3 IS NULL THEN t.reporting_amount_cents ELSE t.amount_cents END) AS spent_cents,
                COUNT(DISTINCT t.id) AS transaction_count
             FROM transactions t
             JOIN transaction_tags tt ON tt.transaction_id = t.id
             JOIN tags tag ON tag.id = tt.tag_id
             WHERE t.deleted_at IS NULL
               AND t.kind = 'expense'
               AND t.txn_date >= ?1
               AND t.txn_date <= ?2
               AND (?3 IS NULL OR t.account_id = ?3)
             GROUP BY tag.id, tag.name
             ORDER BY spent_cents DESC, label COLLATE NOCASE
             LIMIT ?4",
        )?;
        let rows = statement.query_map(params![from, to, account_id, limit as i64], |row| {
            Ok(SpendingBreakdownPoint {
                label: row.get(0)?,
                spent_cents: row.get(1)?,
                transaction_count: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn total_balance_trend(
        &self,
        months: usize,
        account_ref: Option<&str>,
    ) -> Result<Vec<BalanceTrendPoint>, AppError> {
        let months = months.max(1);
        let current = Local::now().date_naive();
        let current_start = NaiveDate::from_ymd_opt(current.year(), current.month(), 1)
            .expect("current month should always be valid");
        let first_start = add_months_with_day(current_start, -((months - 1) as i32), 1)?;
        let mut points = Vec::with_capacity(months);

        for step in 0..months {
            let month_start = add_months_with_day(first_start, step as i32, 1)?;
            let next_start = add_months_with_day(month_start, 1, 1)?;
            let month_end = next_start
                .pred_opt()
                .expect("previous day should exist for month boundary");
            // Keep the current month's point consistent with `balances()`,
            // which caps at `today`. Without this, a transaction dated later
            // in the current month (e.g. 2026-09-20 while viewing on 2026-09-02)
            // would make `trend` disagree with the balances card and forecast.
            let effective_end = if month_end > current {
                current
            } else {
                month_end
            };
            let date = effective_end.to_string();
            let mut total = 0_i64;
            for balance in self.balances_on(account_ref, &date)? {
                let value = if account_ref.is_some() {
                    balance.current_balance_cents
                } else {
                    self.reporting_value(
                        balance.current_balance_cents,
                        &balance.currency_code,
                        &date,
                    )?
                };
                total = total
                    .checked_add(value)
                    .ok_or_else(|| AppError::Validation("total balance is too large".into()))?;
            }
            points.push(BalanceTrendPoint {
                month: month_start.format("%Y-%m").to_string(),
                balance_cents: total,
            });
        }

        Ok(points)
    }

    /// Read every dashboard widget under one SQLite read transaction.  This
    /// prevents a transaction posted mid-render from producing a dashboard
    /// whose cards disagree with its charts or alerts.
    pub fn dashboard_snapshot(
        &self,
        account_ref: Option<&str>,
        months: usize,
    ) -> Result<DashboardSnapshot, AppError> {
        self.conn.execute_batch("BEGIN DEFERRED TRANSACTION;")?;
        let result = self.dashboard_snapshot_in_transaction(account_ref, months.clamp(1, 24));
        match result {
            Ok(snapshot) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(snapshot)
            }
            Err(error) => {
                // Best effort: keep the original application error, which is
                // more actionable than a secondary rollback error.
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    pub(super) fn dashboard_snapshot_in_transaction(
        &self,
        account_ref: Option<&str>,
        months: usize,
    ) -> Result<DashboardSnapshot, AppError> {
        let account_ref = account_ref.map(str::trim).filter(|value| !value.is_empty());
        let account_id = account_ref
            .map(|reference| self.resolve_account_ref(reference))
            .transpose()?;
        let today = Local::now().date_naive();
        let current_start = NaiveDate::from_ymd_opt(today.year(), today.month(), 1)
            .expect("current month should always be valid");
        let next_start = add_months_with_day(current_start, 1, 1)?;
        let current_end = next_start
            .pred_opt()
            .expect("month boundary should have a previous day");
        let previous_start = add_months_with_day(current_start, -1, 1)?;
        let previous_end = current_start
            .pred_opt()
            .expect("month boundary should have a previous day");
        let from = current_start.format("%Y-%m-%d").to_string();
        let to = current_end.format("%Y-%m-%d").to_string();
        let previous_from = previous_start.format("%Y-%m-%d").to_string();
        let previous_to = previous_end.format("%Y-%m-%d").to_string();
        let month_key = current_start.format("%Y-%m").to_string();
        let as_of = today.format("%Y-%m-%d").to_string();

        let summary = self.summary(&from, &to, account_ref)?;
        let previous_summary = self.summary(&previous_from, &previous_to, account_ref)?;
        let balances = self.balances(account_ref)?;
        let recent_transactions = self.list_transactions(&TransactionFilters {
            from: None,
            to: None,
            account: account_ref.map(ToOwned::to_owned),
            category: None,
            kind: None,
            accounts: vec![],
            categories: vec![],
            kinds: vec![],
            search: None,
            limit: Some(8),
            include_deleted: false,
            sort_by: None,
            sort_dir: None,
        })?;
        let cashflow = self.monthly_cash_flow_trend(months, account_ref)?;
        let spending = self.category_spending(&from, &to, 6, account_ref)?;
        let trend = self.total_balance_trend(months, account_ref)?;
        let net_worth = self.net_worth_snapshot()?;
        let budget_status = self.budget_status_scoped(&month_key, None, account_ref)?;
        let forecast = self.forecast(None, account_ref, 30)?;
        let due_through = (today + Duration::days(30)).format("%Y-%m-%d").to_string();
        let recurring_due = self
            .list_recurring_rules()?
            .into_iter()
            .filter(|rule| {
                !rule.paused
                    && rule.next_due_on >= as_of
                    && rule.next_due_on <= due_through
                    && account_id.map_or(true, |id| {
                        rule.account_id == id || rule.to_account_id == Some(id)
                    })
            })
            .collect();

        Ok(DashboardSnapshot {
            as_of,
            from,
            to,
            account: self.forecast_account_selection(account_id)?,
            summary,
            previous_summary,
            balances,
            recent_transactions,
            cashflow,
            spending,
            trend,
            net_worth,
            budget_status,
            forecast,
            recurring_due,
        })
    }

    pub fn reporting_balances(&self) -> Result<Vec<BalanceRecord>, AppError> {
        self.reporting_balances_on(&Local::now().date_naive().to_string())
    }

    pub fn reporting_balances_on(&self, date: &str) -> Result<Vec<BalanceRecord>, AppError> {
        let mut balances = self.balances_on(None, date)?;
        for balance in &mut balances {
            balance.current_balance_cents =
                self.reporting_value(balance.current_balance_cents, &balance.currency_code, date)?;
            balance.currency_code = self.currency_code()?;
        }
        Ok(balances)
    }

    pub fn net_worth_snapshot(&self) -> Result<NetWorthSnapshot, AppError> {
        let balances = self.reporting_balances()?;
        let investments = self.list_investment_accounts()?;
        let items = self.list_net_worth_items()?;
        let loans = self.list_loans()?;

        // Credit accounts are ledger balances.  A negative credit balance is
        // debt, while an overpaid/positive credit balance remains an asset.
        // Non-credit accounts (checking/savings/cash) can also be overdrawn;
        // a negative balance there is a liability, not a negative asset.
        let account_assets_cents = balances
            .iter()
            .map(|balance| balance.current_balance_cents.max(0))
            .sum();
        let credit_liabilities_cents = balances
            .iter()
            .filter(|balance| balance.account_kind == AccountKind::Credit)
            .map(|balance| (-balance.current_balance_cents).max(0))
            .sum();
        let account_liabilities_cents = balances
            .iter()
            .filter(|balance| balance.account_kind != AccountKind::Credit)
            .map(|balance| (-balance.current_balance_cents).max(0))
            .sum();
        let investment_assets_cents = investments.iter().map(|item| item.value_cents).sum();
        let manual_assets_cents = items
            .iter()
            .filter(|item| item.kind == "asset")
            .map(|item| item.value_cents)
            .sum();
        let manual_liabilities_cents = items
            .iter()
            .filter(|item| item.kind == "liability")
            .map(|item| item.value_cents)
            .sum();
        let loan_liabilities_cents = loans.iter().map(|loan| loan.outstanding_cents).sum();
        let assets_cents = account_assets_cents + investment_assets_cents + manual_assets_cents;
        let liabilities_cents = loan_liabilities_cents
            + credit_liabilities_cents
            + manual_liabilities_cents
            + account_liabilities_cents;
        let net_worth_cents = assets_cents - liabilities_cents;
        let static_non_ledger_cents = investment_assets_cents + manual_assets_cents
            - loan_liabilities_cents
            - manual_liabilities_cents;
        let trend = self
            .total_balance_trend(12, None)?
            .into_iter()
            .map(|point| BalanceTrendPoint {
                month: point.month,
                balance_cents: point.balance_cents + static_non_ledger_cents,
            })
            .collect::<Vec<_>>();
        let month_over_month_cents = trend
            .iter()
            .rev()
            .nth(1)
            .map(|point| net_worth_cents - point.balance_cents)
            .unwrap_or(0);

        Ok(NetWorthSnapshot {
            account_assets_cents,
            investment_assets_cents,
            manual_assets_cents,
            loan_liabilities_cents,
            credit_liabilities_cents,
            manual_liabilities_cents,
            account_liabilities_cents,
            assets_cents,
            liabilities_cents,
            net_worth_cents,
            month_over_month_cents,
            trend,
        })
    }

    #[allow(dead_code)]
    pub fn weekly_opening_balance_history(
        &self,
        weeks: usize,
    ) -> Result<Vec<WeeklyBalancePoint>, AppError> {
        let weeks = weeks.max(1);
        let today = Local::now().date_naive();
        let current_week_start =
            today - Duration::days(today.weekday().num_days_from_monday() as i64);
        let first_week_start = current_week_start - Duration::weeks((weeks - 1) as i64);
        let opening_total: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(opening_balance_cents), 0) FROM accounts WHERE archived = 0",
            [],
            |row| row.get(0),
        )?;
        let mut points = Vec::with_capacity(weeks);

        for step in 0..weeks {
            let week_start = first_week_start + Duration::weeks(step as i64);
            let week_start_iso = week_start.format("%Y-%m-%d").to_string();
            let (income_cents, expense_cents): (i64, i64) = self.conn.query_row(
                "SELECT
                    COALESCE(SUM(CASE WHEN kind = 'income' THEN amount_cents ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_cents ELSE 0 END), 0)
                 FROM transactions
                 WHERE deleted_at IS NULL
                   AND txn_date < ?1",
                params![&week_start_iso],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            points.push(WeeklyBalancePoint {
                week_start: week_start_iso,
                opening_balance_cents: opening_total + income_cents - expense_cents,
            });
        }

        Ok(points)
    }

    pub(super) fn summary_all_accounts(
        &self,
        from: &str,
        to: &str,
    ) -> Result<SummaryRecord, AppError> {
        let (transaction_count, income_cents, expense_cents, transfer_cents): (i64, i64, i64, i64) =
            self.conn.query_row(
                "SELECT
                COUNT(*),
                COALESCE(SUM(CASE WHEN kind = 'income' THEN reporting_amount_cents ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'expense' THEN reporting_amount_cents ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'transfer' THEN reporting_amount_cents ELSE 0 END), 0)
             FROM transactions
             WHERE deleted_at IS NULL
               AND txn_date >= ?1
               AND txn_date <= ?2",
                params![from, to],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;

        Ok(SummaryRecord {
            from: from.to_string(),
            to: to.to_string(),
            account_id: None,
            account_name: None,
            transaction_count,
            income_cents,
            expense_cents,
            net_cents: income_cents - expense_cents,
            // Across every account, each internal transfer is both an inflow and an
            // outflow. It remains excluded from net cash flow.
            transfer_in_cents: transfer_cents,
            transfer_out_cents: transfer_cents,
        })
    }

    pub(super) fn summary_for_account(
        &self,
        from: &str,
        to: &str,
        account_ref: &str,
    ) -> Result<SummaryRecord, AppError> {
        let account_id = self.resolve_account_ref(account_ref)?;
        let account_name = self.account_name(account_id)?;
        let (transaction_count, income_cents, expense_cents, transfer_in_cents, transfer_out_cents):
            (i64, i64, i64, i64, i64) = self.conn.query_row(
            "SELECT
                COUNT(*),
                COALESCE(SUM(CASE WHEN kind = 'income' AND account_id = ?1 THEN amount_cents ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'expense' AND account_id = ?1 THEN amount_cents ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'transfer' AND to_account_id = ?1 THEN COALESCE(to_amount_cents, amount_cents) ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'transfer' AND account_id = ?1 THEN amount_cents ELSE 0 END), 0)
             FROM transactions
             WHERE deleted_at IS NULL
               AND txn_date >= ?2
               AND txn_date <= ?3
               AND (account_id = ?1 OR to_account_id = ?1)",
            params![account_id, from, to],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )?;

        Ok(SummaryRecord {
            from: from.to_string(),
            to: to.to_string(),
            account_id: Some(account_id),
            account_name: Some(account_name),
            transaction_count,
            income_cents,
            expense_cents,
            net_cents: income_cents - expense_cents + transfer_in_cents - transfer_out_cents,
            transfer_in_cents,
            transfer_out_cents,
        })
    }
}
