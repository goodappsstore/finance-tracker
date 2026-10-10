use super::*;

impl Db {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn add_account(
        &self,
        name: &str,
        kind: &AccountKind,
        opening_balance_cents: i64,
        opened_on: &str,
    ) -> Result<i64, AppError> {
        let currency = self.currency_code()?;
        self.add_account_with_currency(name, kind, opening_balance_cents, &currency, opened_on)
    }

    pub fn add_account_with_currency(
        &self,
        name: &str,
        kind: &AccountKind,
        opening_balance_cents: i64,
        currency_code: &str,
        opened_on: &str,
    ) -> Result<i64, AppError> {
        let normalized_name = normalize_name("account", name)?;
        let opened_on = normalize_date_value(opened_on)?;
        let currency_code = normalize_currency_code(currency_code)?;
        match self.conn.execute(
            "INSERT INTO accounts (name, kind, opening_balance_cents, currency_code, opened_on) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![normalized_name, kind.as_db_str(), opening_balance_cents, currency_code, opened_on],
        ) {
            Ok(_) => Ok(self.conn.last_insert_rowid()),
            Err(error) if is_unique_constraint(&error) => {
                Err(AppError::duplicate(EntityKind::Account, &normalized_name))
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn list_accounts(&self) -> Result<Vec<Account>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, name, kind, opening_balance_cents, currency_code, opened_on, archived
             FROM accounts
             WHERE archived = 0
             ORDER BY name COLLATE NOCASE",
        )?;

        let rows = statement.query_map([], |row| {
            let kind: String = row.get(2)?;
            Ok(Account {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: AccountKind::from_db(&kind).map_err(map_db_error)?,
                opening_balance_cents: row.get(3)?,
                currency_code: row.get(4)?,
                opened_on: row.get(5)?,
                archived: row.get::<_, i64>(6)? == 1,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn edit_account(
        &self,
        reference: &str,
        name: Option<&str>,
        kind: Option<&AccountKind>,
        opening_balance_cents: Option<i64>,
        currency_code: Option<&str>,
        opened_on: Option<&str>,
    ) -> Result<i64, AppError> {
        let account_id = self.resolve_account_ref(reference)?;
        let current = self.load_account(account_id)?;
        let next_name = match name {
            Some(value) => normalize_name("account", value)?,
            None => current.name.clone(),
        };
        let next_kind = kind.copied().unwrap_or(current.kind);
        if next_kind != AccountKind::Credit {
            let has_debt_settings: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM debt_account_settings WHERE account_id=?1",
                params![account_id],
                |row| row.get(0),
            )?;
            if has_debt_settings > 0 {
                return Err(AppError::Validation(
                    "remove credit debt assumptions before changing this account type".into(),
                ));
            }
        }
        let next_opening_balance_cents =
            opening_balance_cents.unwrap_or(current.opening_balance_cents);
        let next_currency_code = match currency_code {
            Some(value) => normalize_currency_code(value)?,
            None => current.currency_code.clone(),
        };
        if next_currency_code != current.currency_code {
            let transaction_count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM transactions WHERE account_id = ?1 OR to_account_id = ?1",
                params![account_id],
                |row| row.get(0),
            )?;
            if transaction_count > 0 {
                return Err(AppError::Validation(
                    "cannot change an account currency after transactions exist".to_string(),
                ));
            }
        }
        let next_opened_on = match opened_on {
            Some(value) => normalize_date_value(value)?,
            None => normalize_date_value(&current.opened_on)?,
        };
        if next_opening_balance_cents != current.opening_balance_cents
            || next_opened_on != current.opened_on
        {
            let reconciled: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM reconciliations WHERE account_id = ?1)",
                params![account_id],
                |row| row.get(0),
            )?;
            if reconciled {
                return Err(AppError::Validation(
                    "remove account reconciliations before changing the opening balance or opening date".into(),
                ));
            }
        }

        match self.conn.execute(
            "UPDATE accounts
             SET name = ?1,
                 kind = ?2,
                 opening_balance_cents = ?3,
                 currency_code = ?4,
                 opened_on = ?5
             WHERE id = ?6",
            params![
                next_name,
                next_kind.as_db_str(),
                next_opening_balance_cents,
                next_currency_code,
                next_opened_on,
                account_id
            ],
        ) {
            Ok(0) => Err(AppError::invalid_ref(EntityKind::Account, reference.trim())),
            Ok(_) => Ok(account_id),
            Err(error) if is_unique_constraint(&error) => {
                Err(AppError::duplicate(EntityKind::Account, &next_name))
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn delete_account(&self, reference: &str) -> Result<i64, AppError> {
        let account_id = self.resolve_account_ref(reference)?;
        if let Some(blocker) = self.account_archive_blocker(account_id)? {
            return Err(AppError::Validation(format!(
                "cannot archive account while {blocker} still reference it"
            )));
        }
        let changed = self.conn.execute(
            "UPDATE accounts
             SET archived = 1
             WHERE id = ?1
               AND archived = 0",
            params![account_id],
        )?;
        if changed == 0 {
            return Err(AppError::invalid_ref(EntityKind::Account, reference.trim()));
        }
        Ok(account_id)
    }

    pub(super) fn account_name(&self, id: i64) -> Result<String, AppError> {
        self.conn
            .query_row(
                "SELECT name FROM accounts WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("account `{id}` was not found")))
    }

    pub(super) fn load_account(&self, id: i64) -> Result<Account, AppError> {
        self.conn
            .query_row(
                "SELECT id, name, kind, opening_balance_cents, currency_code, opened_on, archived
                 FROM accounts
                 WHERE id = ?1",
                params![id],
                |row| {
                    let kind: String = row.get(2)?;
                    Ok(Account {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        kind: AccountKind::from_db(&kind).map_err(map_db_error)?,
                        opening_balance_cents: row.get(3)?,
                        currency_code: row.get(4)?,
                        opened_on: row.get(5)?,
                        archived: row.get::<_, i64>(6)? == 1,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("account `{id}` was not found")))
    }

    pub(super) fn account_archive_blocker(
        &self,
        account_id: i64,
    ) -> Result<Option<&'static str>, AppError> {
        let transaction_count: i64 = self.conn.query_row(
            "SELECT COUNT(*)
             FROM transactions
             WHERE deleted_at IS NULL
               AND (account_id = ?1 OR to_account_id = ?1)",
            params![account_id],
            |row| row.get(0),
        )?;
        if transaction_count > 0 {
            return Ok(Some("transactions"));
        }

        let planning_item_count: i64 = self.conn.query_row(
            "SELECT COUNT(*)
             FROM planning_items
             WHERE archived = 0
               AND (account_id = ?1 OR to_account_id = ?1)",
            params![account_id],
            |row| row.get(0),
        )?;
        if planning_item_count > 0 {
            return Ok(Some("planning items"));
        }

        let goal_count: i64 = self.conn.query_row(
            "SELECT COUNT(*)
             FROM planning_goals
             WHERE archived = 0
               AND account_id = ?1",
            params![account_id],
            |row| row.get(0),
        )?;
        if goal_count > 0 {
            return Ok(Some("goals"));
        }

        let recurring_count: i64 = self.conn.query_row(
            "SELECT COUNT(*)
             FROM recurring_rules
             WHERE account_id = ?1
                OR to_account_id = ?1",
            params![account_id],
            |row| row.get(0),
        )?;
        if recurring_count > 0 {
            return Ok(Some("recurring rules"));
        }

        let budget_count: i64 = self.conn.query_row(
            "SELECT
                (SELECT COUNT(*) FROM budgets WHERE account_id = ?1)
              + (SELECT COUNT(*) FROM scenario_budget_overrides WHERE account_id = ?1)
              + (SELECT COUNT(*) FROM budget_rollovers WHERE account_id = ?1)
              + (SELECT COUNT(*) FROM budget_moves WHERE account_id = ?1)
              + (SELECT COUNT(*) FROM safe_spend_accounts WHERE account_id = ?1)",
            params![account_id],
            |row| row.get(0),
        )?;
        if budget_count > 0 {
            return Ok(Some("budgets"));
        }

        let advanced_count: i64 = self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM transaction_rules WHERE account_id=?1)
                  + (SELECT COUNT(*) FROM debt_account_settings WHERE account_id=?1)",
            params![account_id],
            |row| row.get(0),
        )?;
        if advanced_count > 0 {
            return Ok(Some("transaction rules or debt assumptions"));
        }

        let reconciliation_count: i64 = self.conn.query_row(
            "SELECT COUNT(*)
             FROM reconciliations
             WHERE account_id = ?1",
            params![account_id],
            |row| row.get(0),
        )?;
        if reconciliation_count > 0 {
            return Ok(Some("reconciliations"));
        }

        Ok(None)
    }

    pub(super) fn resolve_account_ref(&self, reference: &str) -> Result<i64, AppError> {
        let trimmed = reference.trim();
        let id_lookup = trimmed.parse::<i64>().ok();
        let id = self
            .conn
            .query_row(
                "SELECT id
                 FROM accounts
                 WHERE archived = 0
                   AND (id = ?1 OR name = ?2 COLLATE NOCASE)",
                params![id_lookup, trimmed],
                |row| row.get(0),
            )
            .optional()?;
        id.ok_or_else(|| AppError::invalid_ref(EntityKind::Account, trimmed))
    }
}
