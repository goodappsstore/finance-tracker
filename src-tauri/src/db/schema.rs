use super::*;

impl Db {
    pub(super) fn is_initialized(&self) -> Result<bool, AppError> {
        let metadata_exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'metadata'",
            [],
            |row| row.get(0),
        )?;

        if metadata_exists == 0 {
            return Ok(false);
        }

        let metadata_rows = self
            .conn
            .query_row("SELECT COUNT(*) FROM metadata", [], |row| row.get(0))
            .unwrap_or(0_i64);

        Ok(metadata_rows > 0)
    }

    pub(super) fn repair_schema_if_needed(&mut self) -> Result<(), AppError> {
        match self.conn.execute_batch(
            "ALTER TABLE budgets ADD COLUMN account_id INTEGER REFERENCES accounts(id);",
        ) {
            Ok(_) => {}
            Err(error) => {
                let message = error.to_string();
                if !message.contains("duplicate column name")
                    && !message.contains("duplicate column name: account_id")
                {
                    return Err(error.into());
                }
            }
        }
        Ok(())
    }

    pub(super) fn migrate_if_needed(&mut self) -> Result<(), AppError> {
        let version = self.schema_version()?;
        if version >= CURRENT_SCHEMA_VERSION {
            return Ok(());
        }

        self.backup_before_migration(version, CURRENT_SCHEMA_VERSION)?;
        if version < 2 {
            self.migrate_v1_to_v2()?;
        }
        if self.schema_version()? < 3 {
            self.migrate_v2_to_v3()?;
        }
        if self.schema_version()? < 4 {
            self.migrate_v3_to_v4()?;
        }
        if self.schema_version()? < 5 {
            self.migrate_v4_to_v5()?;
        }
        if self.schema_version()? < 6 {
            self.migrate_v5_to_v6()?;
        }
        if self.schema_version()? < 7 {
            self.migrate_v6_to_v7()?;
        }
        if self.schema_version()? < 8 {
            self.migrate_v7_to_v8()?;
        }
        if self.schema_version()? < 9 {
            self.migrate_v8_to_v9()?;
        }
        if self.schema_version()? < 10 {
            self.migrate_v9_to_v10()?;
        }
        if self.schema_version()? < 11 {
            self.migrate_v10_to_v11()?;
        }
        if self.schema_version()? < 12 {
            self.migrate_v11_to_v12()?;
        }
        if self.schema_version()? < 13 {
            self.migrate_v12_to_v13()?;
        }
        if self.schema_version()? < 14 {
            self.migrate_v13_to_v14()?;
        }
        if self.schema_version()? < 15 {
            self.migrate_v14_to_v15()?;
        }
        Ok(())
    }

    fn migrate_v14_to_v15(&mut self) -> Result<(), AppError> {
        let tx = self.conn.transaction()?;
        tx.execute_batch(super::schema_sql::FULL_SCHEMA_SQL)?;
        tx.execute("UPDATE metadata SET schema_version = 15 WHERE id = 1", [])?;
        tx.commit()?;
        Ok(())
    }

    fn migrate_v13_to_v14(&mut self) -> Result<(), AppError> {
        // Table creation is idempotent for repaired databases as well as v13 upgrades.
        let tx = self.conn.transaction()?;
        tx.execute_batch(super::schema_sql::FULL_SCHEMA_SQL)?;
        tx.execute("UPDATE metadata SET schema_version = 14 WHERE id = 1", [])?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn schema_version(&self) -> Result<i64, AppError> {
        self.conn
            .query_row(
                "SELECT schema_version FROM metadata WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub(super) fn backup_before_migration(
        &self,
        from_version: i64,
        to_version: i64,
    ) -> Result<(), AppError> {
        self.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        let parent = self
            .path
            .parent()
            .ok_or_else(|| AppError::path_message("invalid database path", self.path.clone()))?;
        let stem = self
            .path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("tracker");
        let extension = self
            .path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("db");
        let timestamp = Local::now().format("%Y%m%dT%H%M%S");
        let backup_name =
            format!("{stem}.pre-v{from_version}-to-v{to_version}.{timestamp}.{extension}");
        fs::copy(&self.path, parent.join(backup_name))?;
        Ok(())
    }

    pub(super) fn migrate_v1_to_v2(&mut self) -> Result<(), AppError> {
        self.conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS reconciliations (
                 id INTEGER PRIMARY KEY,
                 account_id INTEGER NOT NULL REFERENCES accounts(id),
                 statement_ending_on TEXT NOT NULL,
                 statement_balance_cents INTEGER NOT NULL,
                 cleared_balance_cents INTEGER NOT NULL,
                 created_at TEXT NOT NULL
             );
             CREATE TABLE transactions_v2 (
                 id INTEGER PRIMARY KEY,
                 txn_date TEXT NOT NULL,
                 kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer')),
                 amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
                 account_id INTEGER NOT NULL REFERENCES accounts(id),
                 to_account_id INTEGER REFERENCES accounts(id),
                 category_id INTEGER REFERENCES categories(id),
                 payee TEXT,
                 note TEXT,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 deleted_at TEXT,
                 recurring_rule_id INTEGER REFERENCES recurring_rules(id),
                 reconciliation_id INTEGER REFERENCES reconciliations(id),
                 CHECK (
                     (kind IN ('income', 'expense') AND to_account_id IS NULL AND category_id IS NOT NULL)
                     OR
                     (kind = 'transfer' AND to_account_id IS NOT NULL AND category_id IS NULL AND to_account_id != account_id)
                 )
             );
             INSERT INTO transactions_v2 (
                 id, txn_date, kind, amount_cents, account_id, to_account_id, category_id,
                 payee, note, created_at, updated_at, deleted_at, recurring_rule_id, reconciliation_id
             )
             SELECT
                 id, txn_date, kind, amount_cents, account_id, to_account_id, category_id,
                 payee, note, created_at, created_at, NULL, NULL, NULL
             FROM transactions;
             DROP TABLE transactions;
             ALTER TABLE transactions_v2 RENAME TO transactions;
             UPDATE metadata SET schema_version = 2 WHERE id = 1;
             COMMIT;",
        )?;
        self.ensure_indexes()?;
        Ok(())
    }

    pub(super) fn migrate_v2_to_v3(&mut self) -> Result<(), AppError> {
        self.conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS recurring_rules (
                 id INTEGER PRIMARY KEY,
                 name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                 kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer')),
                 amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
                 account_id INTEGER NOT NULL REFERENCES accounts(id),
                 to_account_id INTEGER REFERENCES accounts(id),
                 category_id INTEGER REFERENCES categories(id),
                 payee TEXT,
                 note TEXT,
                 cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
                 interval INTEGER NOT NULL DEFAULT 1 CHECK (interval > 0),
                 day_of_month INTEGER,
                 weekday TEXT,
                 start_on TEXT NOT NULL,
                 end_on TEXT,
                 next_due_on TEXT NOT NULL,
                 paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 CHECK (
                     (kind IN ('income', 'expense') AND to_account_id IS NULL AND category_id IS NOT NULL)
                     OR
                     (kind = 'transfer' AND to_account_id IS NOT NULL AND category_id IS NULL AND to_account_id != account_id)
                 ),
                 CHECK (
                     (cadence = 'weekly' AND weekday IS NOT NULL AND day_of_month IS NULL)
                     OR
                     (cadence = 'monthly' AND day_of_month BETWEEN 1 AND 28 AND weekday IS NULL)
                 )
             );
             CREATE TABLE IF NOT EXISTS recurring_occurrences (
                 id INTEGER PRIMARY KEY,
                 rule_id INTEGER NOT NULL REFERENCES recurring_rules(id) ON DELETE CASCADE,
                 due_on TEXT NOT NULL,
                 transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
                 status TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'skipped')),
                 created_at TEXT NOT NULL,
                 UNIQUE(rule_id, due_on)
             );
             UPDATE metadata SET schema_version = 3 WHERE id = 1;
             COMMIT;",
        )?;
        self.ensure_indexes()?;
        Ok(())
    }

    pub(super) fn migrate_v3_to_v4(&mut self) -> Result<(), AppError> {
        self.conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS budgets (
                 id INTEGER PRIMARY KEY,
                 month TEXT NOT NULL,
                 category_id INTEGER NOT NULL REFERENCES categories(id),
                 amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 UNIQUE(month, category_id)
             );
             UPDATE metadata SET schema_version = 4 WHERE id = 1;
             COMMIT;",
        )?;
        self.ensure_indexes()?;
        Ok(())
    }

    pub(super) fn migrate_v4_to_v5(&mut self) -> Result<(), AppError> {
        self.conn.execute_batch(
            "BEGIN;
             UPDATE metadata SET schema_version = 5 WHERE id = 1;
             COMMIT;",
        )?;
        self.ensure_indexes()?;
        Ok(())
    }

    pub(super) fn migrate_v5_to_v6(&mut self) -> Result<(), AppError> {
        self.conn.execute_batch(
            "BEGIN;
             UPDATE metadata SET schema_version = 6 WHERE id = 1;
             COMMIT;",
        )?;
        self.ensure_indexes()?;
        Ok(())
    }

    pub(super) fn migrate_v6_to_v7(&mut self) -> Result<(), AppError> {
        self.conn.execute_batch(
            "BEGIN;
             UPDATE metadata SET schema_version = 7 WHERE id = 1;
             COMMIT;",
        )?;
        self.ensure_indexes()?;
        Ok(())
    }

    pub(super) fn migrate_v7_to_v8(&mut self) -> Result<(), AppError> {
        let has_budget_account = {
            let mut statement = self.conn.prepare("PRAGMA table_info(budgets)")?;
            let has_column = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .any(|column| column.eq_ignore_ascii_case("account_id"));
            has_column
        };
        self.conn.execute_batch("BEGIN;")?;
        if !has_budget_account {
            self.conn.execute_batch(
                "ALTER TABLE budgets ADD COLUMN account_id INTEGER REFERENCES accounts(id);",
            )?;
        }
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS planning_scenarios (
                 id INTEGER PRIMARY KEY,
                 name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                 note TEXT,
                 archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS planning_items (
                 id INTEGER PRIMARY KEY,
                 scenario_id INTEGER REFERENCES planning_scenarios(id),
                 title TEXT NOT NULL,
                 kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer')),
                 amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
                 account_id INTEGER NOT NULL REFERENCES accounts(id),
                 to_account_id INTEGER REFERENCES accounts(id),
                 category_id INTEGER REFERENCES categories(id),
                 due_on TEXT NOT NULL,
                 payee TEXT,
                 note TEXT,
                 linked_transaction_id INTEGER REFERENCES transactions(id),
                 archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 CHECK (
                     (kind IN ('income', 'expense') AND to_account_id IS NULL)
                     OR
                     (kind = 'transfer' AND to_account_id IS NOT NULL AND to_account_id != account_id)
                 )
             );
             CREATE TABLE IF NOT EXISTS scenario_budget_overrides (
                 id INTEGER PRIMARY KEY,
                 scenario_id INTEGER NOT NULL REFERENCES planning_scenarios(id) ON DELETE CASCADE,
                 month TEXT NOT NULL,
                 category_id INTEGER NOT NULL REFERENCES categories(id),
                 amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
                 account_id INTEGER REFERENCES accounts(id),
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 UNIQUE(scenario_id, month, category_id)
             );
             CREATE TABLE IF NOT EXISTS planning_goals (
                 id INTEGER PRIMARY KEY,
                 name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                 kind TEXT NOT NULL CHECK (kind IN ('sinking_fund', 'balance_target')),
                 account_id INTEGER NOT NULL REFERENCES accounts(id),
                 target_amount_cents INTEGER,
                 minimum_balance_cents INTEGER,
                 due_on TEXT,
                 archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 CHECK (
                     (kind = 'sinking_fund' AND target_amount_cents IS NOT NULL AND due_on IS NOT NULL AND minimum_balance_cents IS NULL)
                     OR
                     (kind = 'balance_target' AND minimum_balance_cents IS NOT NULL AND target_amount_cents IS NULL AND due_on IS NULL)
                 )
             );
             UPDATE metadata SET schema_version = 8 WHERE id = 1;
             COMMIT;",
        )?;
        self.ensure_indexes()?;
        Ok(())
    }

    pub(super) fn migrate_v8_to_v9(&mut self) -> Result<(), AppError> {
        let needs_budget_account = {
            let mut statement = self.conn.prepare("PRAGMA table_info(budgets)")?;
            let has_column = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .any(|column| column.eq_ignore_ascii_case("account_id"));
            !has_column
        };
        self.conn.execute_batch("BEGIN;")?;
        if needs_budget_account {
            self.conn.execute_batch(
                "ALTER TABLE budgets ADD COLUMN account_id INTEGER REFERENCES accounts(id);",
            )?;
        }
        self.conn.execute_batch(
            "ALTER TABLE budgets RENAME TO budgets_v8;
             CREATE TABLE budgets (
                 id INTEGER PRIMARY KEY,
                 month TEXT NOT NULL,
                 category_id INTEGER NOT NULL REFERENCES categories(id),
                 account_id INTEGER REFERENCES accounts(id),
                 amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 UNIQUE(month, category_id, account_id)
             );
             INSERT INTO budgets (id, month, category_id, account_id, amount_cents, created_at, updated_at)
             SELECT id, month, category_id, account_id, amount_cents, created_at, updated_at
             FROM budgets_v8;
             DROP TABLE budgets_v8;
             CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_unscoped_unique
                 ON budgets(month, category_id) WHERE account_id IS NULL;
             ALTER TABLE scenario_budget_overrides RENAME TO scenario_budget_overrides_v8;
             CREATE TABLE scenario_budget_overrides (
                 id INTEGER PRIMARY KEY,
                 scenario_id INTEGER NOT NULL REFERENCES planning_scenarios(id) ON DELETE CASCADE,
                 month TEXT NOT NULL,
                 category_id INTEGER NOT NULL REFERENCES categories(id),
                 amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
                 account_id INTEGER REFERENCES accounts(id),
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 UNIQUE(scenario_id, month, category_id, account_id)
             );
             INSERT INTO scenario_budget_overrides (id, scenario_id, month, category_id, amount_cents, account_id, created_at, updated_at)
             SELECT id, scenario_id, month, category_id, amount_cents, account_id, created_at, updated_at
             FROM scenario_budget_overrides_v8;
             DROP TABLE scenario_budget_overrides_v8;
             CREATE UNIQUE INDEX IF NOT EXISTS idx_scenario_budget_overrides_unscoped_unique
                 ON scenario_budget_overrides(scenario_id, month, category_id) WHERE account_id IS NULL;
             UPDATE metadata SET schema_version = 9 WHERE id = 1;
             COMMIT;",
        )?;
        self.ensure_indexes()?;
        Ok(())
    }

    pub(super) fn migrate_v9_to_v10(&mut self) -> Result<(), AppError> {
        // The new tables are created by FULL_SCHEMA_SQL before migrations run.
        self.conn
            .execute("UPDATE metadata SET schema_version = 10 WHERE id = 1", [])?;
        self.ensure_indexes()?;
        Ok(())
    }

    pub(super) fn migrate_v10_to_v11(&mut self) -> Result<(), AppError> {
        self.conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS reconciliation_transaction_links (
                 reconciliation_id INTEGER NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
                 transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
                 PRIMARY KEY (reconciliation_id, transaction_id)
             );
             INSERT OR IGNORE INTO reconciliation_transaction_links (reconciliation_id, transaction_id)
             SELECT reconciliation_id, id
             FROM transactions
             WHERE reconciliation_id IS NOT NULL;
             UPDATE metadata SET schema_version = 11 WHERE id = 1;
             COMMIT;",
        )?;
        self.ensure_indexes()?;
        Ok(())
    }

    pub(super) fn migrate_v11_to_v12(&mut self) -> Result<(), AppError> {
        // v12 is intentionally a development-friendly migration. Existing
        // records keep their original (single) currency and receive 1:1
        // reporting values; new records can use account-specific currencies.
        let has_column = |table: &str, column: &str| -> Result<bool, AppError> {
            let mut statement = self.conn.prepare(&format!("PRAGMA table_info({table})"))?;
            let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
            Ok(columns
                .collect::<Result<Vec<_>, _>>()?
                .iter()
                .any(|name| name.eq_ignore_ascii_case(column)))
        };
        if !has_column("metadata", "fx_rate_mode")? {
            self.conn.execute_batch(
                "ALTER TABLE metadata ADD COLUMN fx_rate_mode TEXT NOT NULL DEFAULT 'frankfurter';",
            )?;
        }
        if !has_column("accounts", "currency_code")? {
            self.conn.execute_batch(
                "ALTER TABLE accounts ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'USD';",
            )?;
        }
        self.conn.execute_batch("UPDATE accounts SET currency_code = (SELECT currency FROM metadata WHERE id = 1) WHERE currency_code = 'USD';")?;
        if !has_column("transactions", "to_amount_cents")? {
            self.conn
                .execute_batch("ALTER TABLE transactions ADD COLUMN to_amount_cents INTEGER;")?;
        }
        if !has_column("transactions", "reporting_amount_cents")? {
            self.conn.execute_batch("ALTER TABLE transactions ADD COLUMN reporting_amount_cents INTEGER NOT NULL DEFAULT 1; UPDATE transactions SET reporting_amount_cents = amount_cents;")?;
        }
        for column in [
            "exchange_rate",
            "exchange_rate_source",
            "exchange_rate_date",
        ] {
            if !has_column("transactions", column)? {
                self.conn.execute_batch(&format!(
                    "ALTER TABLE transactions ADD COLUMN {column} TEXT;"
                ))?;
            }
        }
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS fx_rate_cache (
                 base_currency TEXT NOT NULL, quote_currency TEXT NOT NULL, requested_on TEXT NOT NULL,
                 quoted_on TEXT NOT NULL, rate TEXT NOT NULL, fetched_at TEXT NOT NULL,
                 PRIMARY KEY (base_currency, quote_currency, requested_on)
             );
             CREATE TABLE IF NOT EXISTS manual_fx_rates (
                 base_currency TEXT NOT NULL, quote_currency TEXT NOT NULL, effective_on TEXT NOT NULL,
                 rate TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                 PRIMARY KEY (base_currency, quote_currency, effective_on)
             );
             UPDATE metadata SET schema_version = 12 WHERE id = 1;",
        )?;
        Ok(())
    }

    pub(super) fn migrate_v12_to_v13(&mut self) -> Result<(), AppError> {
        // FULL_SCHEMA_SQL has already created the new, data-independent
        // tables.  Existing investment snapshots remain valid fallback values
        // until the user records holdings and manual price snapshots.
        self.conn
            .execute("UPDATE metadata SET schema_version = 13 WHERE id = 1", [])?;
        self.ensure_indexes()?;
        Ok(())
    }

    pub(super) fn ensure_indexes(&self) -> Result<(), AppError> {
        self.conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(txn_date);
             CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, txn_date);
             CREATE INDEX IF NOT EXISTS idx_transactions_to_account_date ON transactions(to_account_id, txn_date);
             CREATE INDEX IF NOT EXISTS idx_transactions_category_date ON transactions(category_id, txn_date);
             CREATE INDEX IF NOT EXISTS idx_transactions_reconciliation ON transactions(reconciliation_id);
             CREATE INDEX IF NOT EXISTS idx_reconciliation_links_transaction
                 ON reconciliation_transaction_links(transaction_id);
             CREATE INDEX IF NOT EXISTS idx_transactions_recurring_rule ON transactions(recurring_rule_id);
             CREATE INDEX IF NOT EXISTS idx_payee_category_defaults_category ON payee_category_defaults(category_id);
             CREATE INDEX IF NOT EXISTS idx_reconciliations_account_date ON reconciliations(account_id, statement_ending_on);
             CREATE INDEX IF NOT EXISTS idx_recurring_rules_next_due ON recurring_rules(next_due_on);
             CREATE INDEX IF NOT EXISTS idx_recurring_occurrences_due_status ON recurring_occurrences(due_on, status);
             CREATE INDEX IF NOT EXISTS idx_budgets_month ON budgets(month);
             CREATE INDEX IF NOT EXISTS idx_budgets_account ON budgets(account_id);
             CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_unscoped_unique
                 ON budgets(month, category_id) WHERE account_id IS NULL;
             CREATE INDEX IF NOT EXISTS idx_planning_items_due ON planning_items(due_on);
             CREATE INDEX IF NOT EXISTS idx_planning_items_scenario_due ON planning_items(scenario_id, due_on);
             CREATE INDEX IF NOT EXISTS idx_planning_goals_account ON planning_goals(account_id);
             CREATE INDEX IF NOT EXISTS idx_planning_scenarios_name ON planning_scenarios(name);
             CREATE INDEX IF NOT EXISTS idx_scenario_budget_overrides_lookup ON scenario_budget_overrides(scenario_id, month, category_id);
             CREATE UNIQUE INDEX IF NOT EXISTS idx_scenario_budget_overrides_unscoped_unique
                 ON scenario_budget_overrides(scenario_id, month, category_id) WHERE account_id IS NULL;
             CREATE INDEX IF NOT EXISTS idx_holdings_lots_account_security_date
                 ON holdings_lots(investment_account_id, security_id, bought_on, id);
             CREATE INDEX IF NOT EXISTS idx_holding_events_account_security_date
                 ON holding_events(investment_account_id, security_id, event_on, id);
             CREATE INDEX IF NOT EXISTS idx_holding_events_snapshot
                 ON holding_events(investment_account_id, security_id, event_on DESC)
                 WHERE event_type = 'price_snapshot';
             CREATE INDEX IF NOT EXISTS idx_transaction_splits_transaction
                 ON transaction_splits(transaction_id, line_number);
             CREATE INDEX IF NOT EXISTS idx_transaction_splits_category
                 ON transaction_splits(category_id, transaction_id);
             CREATE INDEX IF NOT EXISTS idx_transaction_rules_priority
                 ON transaction_rules(enabled, priority, id);
             CREATE INDEX IF NOT EXISTS idx_rule_application_changes_transaction
                 ON rule_application_changes(transaction_id);
             CREATE INDEX IF NOT EXISTS idx_tax_category_group
                 ON tax_category_settings(deduction_group);",
        )?;
        Ok(())
    }
}
