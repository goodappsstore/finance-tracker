use super::*;

impl Db {
    pub fn record_loan_payment(
        &self,
        id: i64,
        cents: i64,
        interest_cents: i64,
        date: &str,
        next_due: Option<&str>,
        account: Option<&str>,
        category: Option<&str>,
        note: Option<&str>,
    ) -> Result<(), AppError> {
        self.atomic(|db| {
            let date = normalize_date_value(date)?;
            let next_due = next_due.map(normalize_date_value).transpose()?;
            let loan = db
                .list_loans()?
                .into_iter()
                .find(|loan| loan.id == id)
                .ok_or_else(|| AppError::NotFound(format!("loan `{id}` was not found")))?;
            if cents <= 0 || interest_cents < 0 || interest_cents > cents {
                return Err(AppError::Validation(
                    "Payment must be positive; interest must be between zero and the payment amount.".into(),
                ));
            }
            let principal_cents = cents - interest_cents;
            if principal_cents > loan.outstanding_cents {
                return Err(AppError::Validation(
                    "The principal portion cannot exceed the outstanding balance.".into(),
                ));
            }
            if let Some(account) = account {
                let account_id = db.resolve_account_ref(account)?;
                if db.account_currency(account_id)? != db.currency_code()? {
                    return Err(AppError::Validation(
                        "Loan payments require an account in the reporting currency.".into(),
                    ));
                }
                let txn = NewTransaction {
                    txn_date: date,
                    kind: TransactionKind::Expense,
                    amount_cents: cents,
                    account: account.into(),
                    to_account: None,
                    category: category.map(str::to_owned),
                    payee: Some(loan.lender.clone().unwrap_or_else(|| loan.name.clone())),
                    note: note.map(str::to_owned),
                    recurring_rule_id: None,
                };
                let txn_id = db.add_transaction(&txn)?;
                for tag in ["loan", "emi"] {
                    db.add_transaction_tag(txn_id, tag)?;
                }
            }
            db.conn.execute(
                "UPDATE loans SET outstanding_cents=?1, next_due_on=?2, updated_at=?3 WHERE id=?4",
                params![
                    loan.outstanding_cents - principal_cents,
                    next_due,
                    now_timestamp(),
                    id
                ],
            )?;
            Ok(())
        })
    }

    pub fn list_loans(&self) -> Result<Vec<LoanRecord>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, name, lender, principal_cents, outstanding_cents, emi_cents, annual_rate_bps, next_due_on, created_at, updated_at
             FROM loans ORDER BY next_due_on IS NULL, next_due_on ASC, name COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(LoanRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                lender: row.get(2)?,
                principal_cents: row.get(3)?,
                outstanding_cents: row.get(4)?,
                emi_cents: row.get(5)?,
                annual_rate_bps: row.get(6)?,
                next_due_on: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn add_loan(
        &self,
        name: &str,
        lender: Option<&str>,
        principal_cents: i64,
        outstanding_cents: i64,
        emi_cents: i64,
        annual_rate_bps: Option<i64>,
        next_due_on: Option<&str>,
    ) -> Result<i64, AppError> {
        let name = normalize_name("loan", name)?;
        if principal_cents <= 0 || outstanding_cents < 0 || emi_cents <= 0 {
            return Err(AppError::Validation(
                "principal and EMI must be positive; outstanding cannot be negative".to_string(),
            ));
        }
        let next_due_on = next_due_on.map(normalize_date_value).transpose()?;
        let now = now_timestamp();
        self.conn.execute(
            "INSERT INTO loans (name, lender, principal_cents, outstanding_cents, emi_cents, annual_rate_bps, next_due_on, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![name, normalize_optional_text(&lender.map(ToOwned::to_owned)), principal_cents, outstanding_cents, emi_cents, annual_rate_bps, next_due_on, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn edit_loan(
        &self,
        id: i64,
        name: &str,
        lender: Option<&str>,
        principal_cents: i64,
        outstanding_cents: i64,
        emi_cents: i64,
        annual_rate_bps: Option<i64>,
        next_due_on: Option<&str>,
    ) -> Result<(), AppError> {
        let name = normalize_name("loan", name)?;
        if principal_cents <= 0 || outstanding_cents < 0 || emi_cents <= 0 {
            return Err(AppError::Validation(
                "principal and EMI must be positive; outstanding cannot be negative".to_string(),
            ));
        }
        let next_due_on = next_due_on.map(normalize_date_value).transpose()?;
        let now = now_timestamp();
        let affected = self.conn.execute(
            "UPDATE loans SET name = ?1, lender = ?2, principal_cents = ?3, outstanding_cents = ?4, emi_cents = ?5, annual_rate_bps = ?6, next_due_on = ?7, updated_at = ?8 WHERE id = ?9",
            params![
                name,
                normalize_optional_text(&lender.map(ToOwned::to_owned)),
                principal_cents,
                outstanding_cents,
                emi_cents,
                annual_rate_bps,
                next_due_on,
                now,
                id
            ],
        )?;
        if affected == 0 {
            return Err(AppError::NotFoundEntity {
                kind: EntityKind::Goal,
                value: format!("loan #{id}"),
            });
        }
        Ok(())
    }

    pub fn delete_loan(&self, id: i64) -> Result<(), AppError> {
        self.conn
            .execute("DELETE FROM loans WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_net_worth_items(&self) -> Result<Vec<NetWorthItemRecord>, AppError> {
        let mut statement = self.conn.prepare("SELECT id, name, kind, value_cents, as_of, note, created_at, updated_at FROM net_worth_items ORDER BY kind, name COLLATE NOCASE")?;
        let rows = statement.query_map([], |row| {
            Ok(NetWorthItemRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                value_cents: row.get(3)?,
                as_of: row.get(4)?,
                note: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn add_net_worth_item(
        &self,
        name: &str,
        kind: &str,
        value_cents: i64,
        as_of: &str,
        note: Option<&str>,
    ) -> Result<i64, AppError> {
        if !matches!(kind, "asset" | "liability") {
            return Err(AppError::Validation(
                "net-worth item kind must be asset or liability".to_string(),
            ));
        }
        if value_cents <= 0 {
            return Err(AppError::Validation(
                "net-worth item value must be positive".to_string(),
            ));
        }
        let name = normalize_name("net-worth item", name)?;
        let as_of = normalize_date_value(as_of)?;
        let now = now_timestamp();
        self.conn.execute("INSERT INTO net_worth_items (name, kind, value_cents, as_of, note, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)", params![name, kind, value_cents, as_of, normalize_optional_text(&note.map(ToOwned::to_owned)), now])?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn edit_net_worth_item(
        &self,
        id: i64,
        name: &str,
        kind: &str,
        value_cents: i64,
        as_of: &str,
        note: Option<&str>,
    ) -> Result<(), AppError> {
        if !matches!(kind, "asset" | "liability") {
            return Err(AppError::Validation(
                "net-worth item kind must be asset or liability".to_string(),
            ));
        }
        if value_cents <= 0 {
            return Err(AppError::Validation(
                "net-worth item value must be positive".to_string(),
            ));
        }
        let name = normalize_name("net-worth item", name)?;
        let as_of = normalize_date_value(as_of)?;
        let now = now_timestamp();
        let affected = self.conn.execute(
            "UPDATE net_worth_items SET name = ?1, kind = ?2, value_cents = ?3, as_of = ?4, note = ?5, updated_at = ?6 WHERE id = ?7",
            params![
                name,
                kind,
                value_cents,
                as_of,
                normalize_optional_text(&note.map(ToOwned::to_owned)),
                now,
                id,
            ],
        )?;
        if affected == 0 {
            return Err(AppError::NotFoundEntity {
                kind: EntityKind::Goal,
                value: format!("net-worth item #{id}"),
            });
        }
        Ok(())
    }

    pub fn delete_net_worth_item(&self, id: i64) -> Result<(), AppError> {
        self.conn
            .execute("DELETE FROM net_worth_items WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_investment_accounts(&self) -> Result<Vec<InvestmentAccountRecord>, AppError> {
        let mut statement = self.conn.prepare("SELECT id, name, institution, value_cents, contributed_cents, as_of, created_at, updated_at FROM investment_accounts ORDER BY name COLLATE NOCASE")?;
        let rows = statement.query_map([], |row| {
            Ok(InvestmentAccountRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                institution: row.get(2)?,
                value_cents: row.get(3)?,
                contributed_cents: row.get(4)?,
                as_of: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;
        let mut accounts = rows.collect::<Result<Vec<_>, _>>()?;
        // A complete manual price set supersedes the legacy single value for
        // presentation and net-worth.  Incomplete sets continue to use the
        // old snapshot so a partially entered portfolio is never understated.
        for account in &mut accounts {
            if let Some(value_cents) = self.priced_investment_account_value(account.id, None)? {
                account.value_cents = value_cents;
            }
        }
        Ok(accounts)
    }

    pub fn add_investment_account(
        &self,
        name: &str,
        institution: Option<&str>,
        value_cents: i64,
        contributed_cents: i64,
        as_of: &str,
    ) -> Result<i64, AppError> {
        let name = normalize_name("investment account", name)?;
        if value_cents < 0 || contributed_cents < 0 {
            return Err(AppError::Validation(
                "investment values cannot be negative".to_string(),
            ));
        }
        let as_of = normalize_date_value(as_of)?;
        let now = now_timestamp();
        self.conn.execute("INSERT INTO investment_accounts (name, institution, value_cents, contributed_cents, as_of, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)", params![name, normalize_optional_text(&institution.map(ToOwned::to_owned)), value_cents, contributed_cents, as_of, now])?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn delete_investment_account(&self, id: i64) -> Result<(), AppError> {
        self.conn
            .execute("DELETE FROM investment_accounts WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn investment_account_details(&self, id: i64) -> Result<InvestmentAccountRecord, AppError> {
        self.conn.query_row(
            "SELECT id, name, institution, value_cents, contributed_cents, as_of, created_at, updated_at FROM investment_accounts WHERE id=?1", [id],
            |row| Ok(InvestmentAccountRecord {
                id: row.get(0)?, name: row.get(1)?, institution: row.get(2)?, value_cents: row.get(3)?,
                contributed_cents: row.get(4)?, as_of: row.get(5)?, created_at: row.get(6)?, updated_at: row.get(7)?,
            })).optional()?.ok_or_else(|| AppError::NotFound(format!("investment account `{id}` was not found")))
    }

    pub fn edit_investment_account(
        &self,
        id: i64,
        name: &str,
        institution: Option<&str>,
        value_cents: i64,
        contributed_cents: i64,
        as_of: &str,
    ) -> Result<(), AppError> {
        let name = normalize_name("investment account", name)?;
        let as_of = normalize_date_value(as_of)?;
        if value_cents < 0 || contributed_cents < 0 {
            return Err(AppError::Validation(
                "Investment value and contributions cannot be negative.".into(),
            ));
        }
        let changed = self.conn.execute(
            "UPDATE investment_accounts SET name=?1, institution=?2, value_cents=?3, contributed_cents=?4, as_of=?5, updated_at=?6 WHERE id=?7",
            params![name, normalize_optional_text(&institution.map(str::to_owned)), value_cents, contributed_cents, as_of, now_timestamp(), id])?;
        if changed == 0 {
            return Err(AppError::NotFound(format!(
                "investment account `{id}` was not found"
            )));
        }
        Ok(())
    }

    pub fn list_securities(&self) -> Result<Vec<SecurityRecord>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, symbol, name, currency_code, created_at, updated_at
             FROM securities ORDER BY symbol COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(SecurityRecord {
                id: row.get(0)?,
                symbol: row.get(1)?,
                name: row.get(2)?,
                currency_code: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn add_security(
        &self,
        symbol: &str,
        name: &str,
        currency_code: &str,
    ) -> Result<i64, AppError> {
        let symbol = normalize_name("security symbol", symbol)?.to_ascii_uppercase();
        let name = normalize_name("security", name)?;
        let currency_code = normalize_currency_code(currency_code)?;
        let now = now_timestamp();
        self.conn.execute(
            "INSERT INTO securities (symbol, name, currency_code, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![symbol, name, currency_code, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn list_holding_lots(
        &self,
        investment_account_id: i64,
    ) -> Result<Vec<HoldingLotRecord>, AppError> {
        self.ensure_investment_account(investment_account_id)?;
        let mut statement = self.conn.prepare(
            "SELECT l.id, l.investment_account_id, l.security_id, s.symbol, s.name,
                    s.currency_code, l.quantity_micros, l.buy_price_cents,
                    l.reporting_buy_price_cents, l.bought_on, l.created_at
             FROM holdings_lots l
             JOIN securities s ON s.id = l.security_id
             WHERE l.investment_account_id = ?1
             ORDER BY l.bought_on, l.id",
        )?;
        let rows = statement.query_map(params![investment_account_id], |row| {
            Ok(HoldingLotRecord {
                id: row.get(0)?,
                investment_account_id: row.get(1)?,
                security_id: row.get(2)?,
                security_symbol: row.get(3)?,
                security_name: row.get(4)?,
                security_currency_code: row.get(5)?,
                quantity_micros: row.get(6)?,
                buy_price_cents: row.get(7)?,
                reporting_buy_price_cents: row.get(8)?,
                bought_on: row.get(9)?,
                created_at: row.get(10)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_holding_events(
        &self,
        investment_account_id: i64,
    ) -> Result<Vec<HoldingEventRecord>, AppError> {
        self.ensure_investment_account(investment_account_id)?;
        let mut statement = self.conn.prepare(
            "SELECT e.id, e.investment_account_id, e.security_id, s.symbol, e.event_type,
                    e.event_on, e.quantity_micros, e.price_cents, e.reporting_price_cents,
                    e.amount_cents, e.reporting_amount_cents, e.note, e.created_at
             FROM holding_events e
             JOIN securities s ON s.id = e.security_id
             WHERE e.investment_account_id = ?1
             ORDER BY e.event_on DESC, e.id DESC",
        )?;
        let rows = statement.query_map(params![investment_account_id], |row| {
            Ok(HoldingEventRecord {
                id: row.get(0)?,
                investment_account_id: row.get(1)?,
                security_id: row.get(2)?,
                security_symbol: row.get(3)?,
                event_type: row.get(4)?,
                event_on: row.get(5)?,
                quantity_micros: row.get(6)?,
                price_cents: row.get(7)?,
                reporting_price_cents: row.get(8)?,
                amount_cents: row.get(9)?,
                reporting_amount_cents: row.get(10)?,
                note: row.get(11)?,
                created_at: row.get(12)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_holding_event(
        &self,
        investment_account_id: i64,
        security_id: i64,
        event_type: &str,
        event_on: &str,
        quantity_micros: Option<i64>,
        price_cents: Option<i64>,
        reporting_price_cents: Option<i64>,
        amount_cents: Option<i64>,
        reporting_amount_cents: Option<i64>,
        note: Option<&str>,
    ) -> Result<i64, AppError> {
        self.ensure_investment_account(investment_account_id)?;
        let security_currency: String = self
            .conn
            .query_row(
                "SELECT currency_code FROM securities WHERE id = ?1",
                params![security_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("security `{security_id}` was not found")))?;
        let event_on = normalize_date_value(event_on)?;
        if !matches!(event_type, "buy" | "sell" | "dividend" | "price_snapshot") {
            return Err(AppError::Validation(
                "holding event must be buy, sell, dividend, or price snapshot".to_string(),
            ));
        }
        let quantity_micros = quantity_micros.filter(|value| *value > 0);
        let price_cents = price_cents.filter(|value| *value > 0);
        let reporting_price_cents = reporting_price_cents.filter(|value| *value > 0);
        let amount_cents = amount_cents.filter(|value| *value > 0);
        let reporting_amount_cents = reporting_amount_cents.filter(|value| *value > 0);
        let reporting_currency = self.currency_code()?;
        let effective_reporting_price = if security_currency == reporting_currency {
            price_cents
        } else {
            reporting_price_cents
        };
        match event_type {
            "buy" | "sell" => {
                if quantity_micros.is_none()
                    || price_cents.is_none()
                    || effective_reporting_price.is_none()
                {
                    return Err(AppError::Validation(
                        "buy and sell events need quantity, security price, and reporting price"
                            .to_string(),
                    ));
                }
                if event_type == "sell" {
                    let held = self.security_quantity_micros_as_of(
                        investment_account_id,
                        security_id,
                        &event_on,
                    )?;
                    if quantity_micros.expect("checked") > held {
                        return Err(AppError::Validation(
                            "a sell cannot exceed the available FIFO holding quantity".to_string(),
                        ));
                    }
                }
            }
            "dividend" => {
                if amount_cents.is_none() {
                    return Err(AppError::Validation(
                        "a dividend needs a positive amount".to_string(),
                    ));
                }
                if security_currency != reporting_currency && reporting_amount_cents.is_none() {
                    return Err(AppError::Validation(
                        "a foreign-currency dividend needs a reporting amount snapshot".to_string(),
                    ));
                }
            }
            "price_snapshot" => {
                if price_cents.is_none() || effective_reporting_price.is_none() {
                    return Err(AppError::Validation(
                        "a price snapshot needs security and reporting prices".to_string(),
                    ));
                }
            }
            _ => unreachable!(),
        }
        let effective_reporting_amount = if security_currency == reporting_currency {
            amount_cents
        } else {
            reporting_amount_cents
        };
        let now = now_timestamp();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> Result<i64, AppError> {
            self.conn.execute(
                "INSERT INTO holding_events (
                    investment_account_id, security_id, event_type, event_on, quantity_micros,
                    price_cents, reporting_price_cents, amount_cents, reporting_amount_cents, note, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    investment_account_id, security_id, event_type, event_on, quantity_micros,
                    price_cents, effective_reporting_price, amount_cents, effective_reporting_amount,
                    normalize_optional_text(&note.map(ToOwned::to_owned)), now,
                ],
            )?;
            let id = self.conn.last_insert_rowid();
            if event_type == "sell" {
                // Check every chronological prefix, including later sales that a
                // backdated sale could leave without enough shares.
                let mut statement = self.conn.prepare(
                    "SELECT event_type, quantity_micros FROM holding_events
                     WHERE investment_account_id = ?1 AND security_id = ?2
                       AND event_type IN ('buy', 'sell')
                     ORDER BY event_on, id",
                )?;
                let rows = statement.query_map(params![investment_account_id, security_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?;
                let mut held = 0_i128;
                for row in rows {
                    let (kind, quantity) = row?;
                    held += if kind == "buy" { quantity as i128 } else { -(quantity as i128) };
                    if held < 0 {
                        return Err(AppError::Validation(
                            "a sell cannot leave any recorded sale without sufficient holdings".into(),
                        ));
                    }
                }
            }
            if event_type == "buy" {
                self.conn.execute(
                    "INSERT INTO holdings_lots (
                        investment_account_id, security_id, quantity_micros, buy_price_cents,
                        reporting_buy_price_cents, bought_on, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        investment_account_id,
                        security_id,
                        quantity_micros.expect("checked"),
                        price_cents.expect("checked"),
                        effective_reporting_price.expect("checked"),
                        event_on,
                        now,
                    ],
                )?;
            }
            Ok(id)
        })();
        match outcome {
            Ok(id) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(id)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn investment_account_performance(
        &self,
        investment_account_id: i64,
    ) -> Result<InvestmentPerformanceRecord, AppError> {
        let account_name = self.ensure_investment_account(investment_account_id)?;
        let legacy_value: i64 = self.conn.query_row(
            "SELECT value_cents FROM investment_accounts WHERE id = ?1",
            params![investment_account_id],
            |row| row.get(0),
        )?;
        let priced_value = self.priced_investment_account_value(investment_account_id, None)?;
        let value_cents = priced_value.unwrap_or(legacy_value);
        let cost_basis_cents = self.current_fifo_cost_basis_cents(investment_account_id)?;
        let realized_gain_cents = self.realized_fifo_gain_cents(investment_account_id)?;
        let points = self.time_weighted_points(investment_account_id)?;
        let time_weighted_return_percent = if points.len() >= 2 {
            points.last().map(|point| point.cumulative_return_percent)
        } else {
            None
        };
        Ok(InvestmentPerformanceRecord {
            account_id: investment_account_id,
            account_name,
            value_cents,
            cost_basis_cents,
            unrealized_gain_cents: if priced_value.is_some() {
                value_cents - cost_basis_cents
            } else {
                0
            },
            realized_gain_cents,
            time_weighted_return_percent,
            points,
        })
    }

    pub fn portfolio_xirr(&self) -> Result<PortfolioXirrRecord, AppError> {
        let accounts = self.list_investment_accounts()?;
        let mut cash_flows = Vec::<(NaiveDate, f64)>::new();
        let valuation_date = Local::now().date_naive();
        let valuation_on = valuation_date.to_string();
        let mut incomplete = false;
        for account in accounts {
            let mut statement = self.conn.prepare(
                "SELECT event_type, event_on, quantity_micros, reporting_price_cents, reporting_amount_cents
                 FROM holding_events
                 WHERE investment_account_id = ?1 AND event_type IN ('buy', 'sell', 'dividend') AND event_on <= ?2
                 ORDER BY event_on, id",
            )?;
            let events = statement
                .query_map(params![account.id, valuation_on], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            if events.is_empty() {
                continue;
            }
            for (event_type, event_on, quantity, reporting_price, reporting_amount) in events {
                let value = match event_type.as_str() {
                    "buy" | "sell" => minor_value_for_quantity(
                        quantity.ok_or_else(|| {
                            AppError::Config("trade event is missing quantity".to_string())
                        })?,
                        reporting_price.ok_or_else(|| {
                            AppError::Config("trade event is missing reporting price".to_string())
                        })?,
                    )?,
                    "dividend" => reporting_amount.ok_or_else(|| {
                        AppError::Config("dividend is missing reporting amount".to_string())
                    })?,
                    _ => 0,
                };
                let date = NaiveDate::parse_from_str(&event_on, "%Y-%m-%d")?;
                cash_flows.push((
                    date,
                    if event_type == "buy" {
                        -(value as f64)
                    } else {
                        value as f64
                    },
                ));
            }
            if let Some(value_cents) =
                self.priced_investment_account_value(account.id, Some(&valuation_on))?
            {
                if value_cents != 0 {
                    cash_flows.push((valuation_date, value_cents as f64));
                }
            } else {
                incomplete = true;
            }
        }
        let cash_flow_count = cash_flows.len();
        Ok(PortfolioXirrRecord {
            annualized_return_percent: if incomplete {
                None
            } else {
                xirr(&cash_flows).map(|value| value * 100.0)
            },
            as_of: if incomplete || cash_flows.is_empty() {
                None
            } else {
                Some(valuation_on)
            },
            cash_flow_count,
        })
    }

    fn ensure_investment_account(&self, id: i64) -> Result<String, AppError> {
        self.conn
            .query_row(
                "SELECT name FROM investment_accounts WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("investment account `{id}` was not found")))
    }

    fn fifo_remaining_lots(
        &self,
        investment_account_id: i64,
        security_id: i64,
        as_of: Option<&str>,
    ) -> Result<Vec<(i64, i64)>, AppError> {
        let mut lot_statement = self.conn.prepare(
            "SELECT quantity_micros, reporting_buy_price_cents
             FROM holdings_lots
             WHERE investment_account_id = ?1 AND security_id = ?2
               AND (?3 IS NULL OR bought_on <= ?3)
             ORDER BY bought_on, id",
        )?;
        let mut lots = lot_statement
            .query_map(params![investment_account_id, security_id, as_of], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut sell_statement = self.conn.prepare(
            "SELECT quantity_micros FROM holding_events
             WHERE investment_account_id = ?1 AND security_id = ?2 AND event_type = 'sell'
               AND (?3 IS NULL OR event_on <= ?3)
             ORDER BY event_on, id",
        )?;
        let sales = sell_statement
            .query_map(params![investment_account_id, security_id, as_of], |row| {
                row.get::<_, i64>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for mut sold in sales {
            for lot in &mut lots {
                if sold == 0 {
                    break;
                }
                let consumed = lot.0.min(sold);
                lot.0 -= consumed;
                sold -= consumed;
            }
        }
        Ok(lots)
    }

    fn security_quantity_micros_as_of(
        &self,
        investment_account_id: i64,
        security_id: i64,
        as_of: &str,
    ) -> Result<i64, AppError> {
        Ok(self
            .fifo_remaining_lots(investment_account_id, security_id, Some(as_of))?
            .into_iter()
            .map(|lot| lot.0)
            .sum())
    }

    fn priced_investment_account_value(
        &self,
        investment_account_id: i64,
        as_of: Option<&str>,
    ) -> Result<Option<i64>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT DISTINCT security_id FROM holdings_lots WHERE investment_account_id = ?1",
        )?;
        let securities = statement
            .query_map(params![investment_account_id], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if securities.is_empty() {
            return Ok(None);
        }
        let mut value = 0_i64;
        for security_id in securities {
            let quantity: i64 = self
                .fifo_remaining_lots(investment_account_id, security_id, as_of)?
                .into_iter()
                .map(|lot| lot.0)
                .sum();
            if quantity == 0 {
                continue;
            }
            let price: Option<i64> = self
                .conn
                .query_row(
                    "SELECT reporting_price_cents FROM holding_events
                 WHERE investment_account_id = ?1 AND security_id = ?2
                   AND event_type = 'price_snapshot' AND (?3 IS NULL OR event_on <= ?3)
                 ORDER BY event_on DESC, id DESC LIMIT 1",
                    params![investment_account_id, security_id, as_of],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(price) = price else {
                return Ok(None);
            };
            value = value
                .checked_add(minor_value_for_quantity(quantity, price)?)
                .ok_or_else(|| AppError::Validation("portfolio value is too large".to_string()))?;
        }
        Ok(Some(value))
    }

    fn current_fifo_cost_basis_cents(&self, investment_account_id: i64) -> Result<i64, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT DISTINCT security_id FROM holdings_lots WHERE investment_account_id = ?1",
        )?;
        let security_ids = statement
            .query_map(params![investment_account_id], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut cost = 0_i64;
        for security_id in security_ids {
            for (quantity, reporting_price) in
                self.fifo_remaining_lots(investment_account_id, security_id, None)?
            {
                cost = cost
                    .checked_add(minor_value_for_quantity(quantity, reporting_price)?)
                    .ok_or_else(|| {
                        AppError::Validation("portfolio cost basis is too large".to_string())
                    })?;
            }
        }
        Ok(cost)
    }

    fn realized_fifo_gain_cents(&self, investment_account_id: i64) -> Result<i64, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT DISTINCT security_id FROM holdings_lots WHERE investment_account_id = ?1",
        )?;
        let security_ids = statement
            .query_map(params![investment_account_id], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut gain = 0_i64;
        for security_id in security_ids {
            let mut lots =
                self.fifo_remaining_lots_before_sales(investment_account_id, security_id)?;
            let mut sell_statement = self.conn.prepare(
                "SELECT quantity_micros, reporting_price_cents FROM holding_events
                 WHERE investment_account_id = ?1 AND security_id = ?2 AND event_type = 'sell'
                 ORDER BY event_on, id",
            )?;
            let sales = sell_statement
                .query_map(params![investment_account_id, security_id], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (mut sold, sale_price) in sales {
                let proceeds = minor_value_for_quantity(sold, sale_price)?;
                let mut cost = 0_i64;
                for lot in &mut lots {
                    if sold == 0 {
                        break;
                    }
                    let consumed = lot.0.min(sold);
                    cost += minor_value_for_quantity(consumed, lot.1)?;
                    lot.0 -= consumed;
                    sold -= consumed;
                }
                gain = gain.checked_add(proceeds - cost).ok_or_else(|| {
                    AppError::Validation("realized gain is too large".to_string())
                })?;
            }
        }
        Ok(gain)
    }

    fn fifo_remaining_lots_before_sales(
        &self,
        investment_account_id: i64,
        security_id: i64,
    ) -> Result<Vec<(i64, i64)>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT quantity_micros, reporting_buy_price_cents FROM holdings_lots
             WHERE investment_account_id = ?1 AND security_id = ?2 ORDER BY bought_on, id",
        )?;
        let rows = statement
            .query_map(params![investment_account_id, security_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn time_weighted_points(
        &self,
        investment_account_id: i64,
    ) -> Result<Vec<InvestmentPerformancePoint>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT security_id, event_type, event_on, quantity_micros,
                    reporting_price_cents, reporting_amount_cents
             FROM holding_events
             WHERE investment_account_id = ?1 AND event_on <= ?2
             ORDER BY event_on, id",
        )?;
        let events = statement.query_map(
            params![investment_account_id, Local::now().date_naive().to_string()],
            |row| Ok((
                row.get::<_, i64>(0)?, row.get::<_, String>(1)?,
                row.get::<_, String>(2)?, row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?, row.get::<_, Option<i64>>(5)?,
            )),
        )?;
        let mut quantities = HashMap::<i64, i64>::new();
        let mut prices = HashMap::<i64, (i64, String)>::new();
        let mut points = Vec::<InvestmentPerformancePoint>::new();
        let mut prior_value = 0_i64;
        let mut growth = 1_f64;
        for event in events {
            let (security, kind, date, quantity, price, amount) = event?;
            let is_trade = kind == "buy" || kind == "sell";
            if is_trade || kind == "price_snapshot" {
                prices.insert(security, (price.ok_or_else(||
                    AppError::Config("holding event is missing reporting price".into())
                )?, date.clone()));
            }
            // Value the portfolio immediately BEFORE each external cash flow.
            // A trade supplies its execution price. Other open securities need
            // a same-day quote; stale quotes cannot establish TWR. Dates have
            // no intraday timestamps, so manual quotes represent that day's value.
            let mut before_flow = 0_i64;
            let mut complete = true;
            for (security_id, held) in &quantities {
                if *held == 0 { continue; }
                if !prices.get(security_id).is_some_and(|(_, priced_on)| priced_on == &date) {
                    let quote: Option<i64> = self.conn.query_row(
                        "SELECT reporting_price_cents FROM holding_events
                         WHERE investment_account_id = ?1 AND security_id = ?2
                           AND event_type = 'price_snapshot' AND event_on = ?3
                         ORDER BY id DESC LIMIT 1",
                        params![investment_account_id, security_id, date],
                        |row| row.get(0),
                    ).optional()?;
                    if let Some(quote) = quote {
                        prices.insert(*security_id, (quote, date.clone()));
                    }
                }
                let Some((price, _)) = prices.get(security_id)
                    .filter(|(_, priced_on)| priced_on == &date) else {
                    complete = false;
                    break;
                };
                before_flow = before_flow.checked_add(minor_value_for_quantity(*held, *price)?)
                    .ok_or_else(|| AppError::Validation("portfolio value is too large".into()))?;
            }
            if !complete {
                if kind != "price_snapshot" {
                    return Ok(Vec::new());
                }
                continue;
            }
            let dividend = if kind == "dividend" { amount.unwrap_or(0) } else { 0 };
            if prior_value > 0 {
                growth *= (before_flow as f64 + dividend as f64) / prior_value as f64;
            } else if before_flow != 0 || dividend != 0 {
                return Ok(Vec::new());
            }
            let mut after_flow = before_flow;
            if is_trade {
                let quantity = quantity.ok_or_else(||
                    AppError::Config("trade event is missing quantity".into())
                )?;
                let held = quantities.entry(security).or_default();
                let old_value = minor_value_for_quantity(*held, price.expect("validated price"))?;
                *held = if kind == "buy" { held.checked_add(quantity) }
                    else { held.checked_sub(quantity) }
                    .filter(|held| *held >= 0)
                    .ok_or_else(|| AppError::Validation("invalid chronological holding quantity".into()))?;
                let new_value = minor_value_for_quantity(*held, price.expect("validated price"))?;
                after_flow = before_flow.checked_sub(old_value)
                    .and_then(|value| value.checked_add(new_value))
                    .ok_or_else(|| AppError::Validation("portfolio value is too large".into()))?;
            }
            prior_value = after_flow;
            // Ignore snapshots before any capital is invested.
            if quantities.is_empty() { continue; }
            let point = InvestmentPerformancePoint {
                date: date.clone(), value_cents: after_flow,
                cumulative_return_percent: (growth - 1.0) * 100.0,
            };
            if points.last().is_some_and(|point| point.date == date) {
                *points.last_mut().expect("existing point") = point;
            } else {
                points.push(point);
            }
        }
        Ok(points)
    }

}

const QUANTITY_SCALE: i128 = 1_000_000;

fn minor_value_for_quantity(quantity_micros: i64, price_cents: i64) -> Result<i64, AppError> {
    if quantity_micros < 0 || price_cents < 0 {
        return Err(AppError::Config(
            "holding quantities and prices must be non-negative".to_string(),
        ));
    }
    let product = (quantity_micros as i128)
        .checked_mul(price_cents as i128)
        .ok_or_else(|| AppError::Validation("holding value is too large".to_string()))?;
    i64::try_from((product + QUANTITY_SCALE / 2) / QUANTITY_SCALE)
        .map_err(|_| AppError::Validation("holding value is too large".to_string()))
}

fn xirr(cash_flows: &[(NaiveDate, f64)]) -> Option<f64> {
    if cash_flows.len() < 2
        || !cash_flows.iter().any(|(_, value)| *value < 0.0)
        || !cash_flows.iter().any(|(_, value)| *value > 0.0)
    {
        return None;
    }
    let first = cash_flows.iter().map(|(date, _)| *date).min()?;
    let npv = |rate: f64| -> f64 {
        cash_flows
            .iter()
            .map(|(date, value)| {
                let years = (*date - first).num_days() as f64 / 365.0;
                value / (1.0 + rate).powf(years)
            })
            .sum()
    };
    let mut low = -0.999_999_f64;
    let mut high = 1.0_f64;
    let mut low_value = npv(low);
    let mut high_value = npv(high);
    while low_value.signum() == high_value.signum() && high < 1_000_000.0 {
        high *= 2.0;
        high_value = npv(high);
    }
    if !low_value.is_finite()
        || !high_value.is_finite()
        || low_value.signum() == high_value.signum()
    {
        return None;
    }
    for _ in 0..120 {
        let middle = (low + high) / 2.0;
        let middle_value = npv(middle);
        if !middle_value.is_finite() {
            return None;
        }
        if middle_value.abs() < 0.000_001 {
            return Some(middle);
        }
        if middle_value.signum() == low_value.signum() {
            low = middle;
            low_value = middle_value;
        } else {
            high = middle;
        }
    }
    Some((low + high) / 2.0)
}
