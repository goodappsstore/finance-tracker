use super::*;

impl Db {
    pub fn start_reconciliation(
        &self,
        account_ref: &str,
        statement_ending_on: &str,
        statement_balance_cents: i64,
        transaction_ids: &[i64],
    ) -> Result<i64, AppError> {
        if transaction_ids.is_empty() {
            return Err(AppError::Validation(
                "reconciliation requires at least one transaction selection".to_string(),
            ));
        }
        if transaction_ids
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            .len()
            != transaction_ids.len()
        {
            return Err(AppError::Validation(
                "a transaction can only be selected once for reconciliation".to_string(),
            ));
        }

        let account_id = self.resolve_account_ref(account_ref)?;
        let statement_ending_on = normalize_date_value(statement_ending_on)?;
        let latest_statement_ending_on: Option<String> = self.conn.query_row(
            "SELECT MAX(statement_ending_on) FROM reconciliations WHERE account_id = ?1",
            params![account_id],
            |row| row.get(0),
        )?;
        if let Some(latest) = latest_statement_ending_on {
            if statement_ending_on <= latest {
                return Err(AppError::Validation(format!(
                    "statement ending date must be after the latest reconciliation ({latest})"
                )));
            }
        }
        let eligible =
            self.list_eligible_reconciliation_transactions_by_id(account_id, &statement_ending_on)?;
        if eligible.is_empty() {
            return Err(AppError::Validation(
                "no eligible transactions were found for reconciliation".to_string(),
            ));
        }

        let eligible_ids: HashSet<i64> =
            eligible.iter().map(|transaction| transaction.id).collect();
        for transaction_id in transaction_ids {
            if !eligible_ids.contains(transaction_id) {
                return Err(AppError::Validation(format!(
                    "transaction {transaction_id} is not eligible for this reconciliation"
                )));
            }
        }

        let opening_balance_cents = self.lookup_account_opening_balance(account_id)?;
        let previously_cleared_delta =
            self.reconciled_delta_for_account(account_id, &statement_ending_on)?;
        let selected_lookup: HashSet<i64> = transaction_ids.iter().copied().collect();
        let mut cleared_delta = 0_i64;
        let mut selected_count = 0_i64;
        for transaction in &eligible {
            if selected_lookup.contains(&transaction.id) {
                selected_count += 1;
                cleared_delta += transaction_effect_for_account(
                    account_id,
                    transaction.kind,
                    transaction.amount_cents,
                    transaction
                        .to_amount_cents
                        .unwrap_or(transaction.amount_cents),
                    transaction.account_id,
                    transaction.to_account_id,
                );
            }
        }
        let cleared_balance_cents =
            opening_balance_cents + previously_cleared_delta + cleared_delta;
        if cleared_balance_cents != statement_balance_cents {
            return Err(AppError::Validation(format!(
                "selected transactions clear to {}, but the statement balance is {}",
                crate::amount::format_cents(cleared_balance_cents),
                crate::amount::format_cents(statement_balance_cents)
            )));
        }

        debug_assert!(selected_count > 0);
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> Result<i64, AppError> {
            let created_at = now_timestamp();
            self.conn.execute(
                "INSERT INTO reconciliations (account_id, statement_ending_on, statement_balance_cents, cleared_balance_cents, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    account_id,
                    &statement_ending_on,
                    statement_balance_cents,
                    cleared_balance_cents,
                    created_at
                ],
            )?;
            let reconciliation_id = self.conn.last_insert_rowid();
            for transaction_id in transaction_ids {
                self.conn.execute(
                    "INSERT INTO reconciliation_transaction_links (reconciliation_id, transaction_id)
                     VALUES (?1, ?2)",
                    params![reconciliation_id, transaction_id],
                )?;
                // Keep legacy `transactions.reconciliation_id` in sync so
                // `reconciliation_id IS NOT NULL` correctly reflects locked
                // rows and older databases stay consistent after migration v11.
                self.conn.execute(
                    "UPDATE transactions SET reconciliation_id = ?1, updated_at = ?2 WHERE id = ?3",
                    params![reconciliation_id, created_at, transaction_id],
                )?;
            }
            Ok(reconciliation_id)
        })();
        match outcome {
            Ok(reconciliation_id) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(reconciliation_id)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn list_reconciliations(
        &self,
        account_ref: Option<&str>,
    ) -> Result<Vec<ReconciliationRecord>, AppError> {
        let account_id = match account_ref {
            Some(reference) => Some(self.resolve_account_ref(reference)?),
            None => None,
        };

        let mut statement = self.conn.prepare(
            "SELECT
                r.id,
                r.account_id,
                a.name,
                r.statement_ending_on,
                r.statement_balance_cents,
                r.cleared_balance_cents,
                COUNT(l.transaction_id) AS transaction_count,
                r.created_at
             FROM reconciliations r
             JOIN accounts a ON a.id = r.account_id
             LEFT JOIN reconciliation_transaction_links l ON l.reconciliation_id = r.id
             WHERE (?1 IS NULL OR r.account_id = ?1)
             GROUP BY r.id, r.account_id, a.name, r.statement_ending_on, r.statement_balance_cents, r.cleared_balance_cents, r.created_at
             ORDER BY r.statement_ending_on DESC, r.id DESC",
        )?;

        let rows = statement.query_map(params![account_id], |row| {
            Ok(ReconciliationRecord {
                id: row.get(0)?,
                account_id: row.get(1)?,
                account_name: row.get(2)?,
                statement_ending_on: row.get(3)?,
                statement_balance_cents: row.get(4)?,
                cleared_balance_cents: row.get(5)?,
                transaction_count: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn delete_reconciliation(&self, id: i64) -> Result<(), AppError> {
        self.atomic(|db| db.delete_reconciliation_inner(id))
    }

    fn delete_reconciliation_inner(&self, id: i64) -> Result<(), AppError> {
        let exists: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM reconciliations WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!(
                "reconciliation `{id}` was not found"
            )));
        }

        self.conn.execute(
            "DELETE FROM reconciliation_transaction_links WHERE reconciliation_id = ?1",
            params![id],
        )?;
        self.conn.execute(
            "UPDATE transactions SET reconciliation_id = NULL, updated_at = ?1 WHERE reconciliation_id = ?2",
            params![now_timestamp(), id],
        )?;
        self.conn
            .execute("DELETE FROM reconciliations WHERE id = ?1", params![id])?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn unreconciled_account_count(&self) -> Result<i64, AppError> {
        self.conn
            .query_row(
                "WITH account_refs AS (
                    SELECT a.id
                    FROM accounts a
                    WHERE a.archived = 0
                      AND EXISTS (
                          SELECT 1
                          FROM transactions t
                          WHERE t.deleted_at IS NULL
                            AND (t.account_id = a.id OR t.to_account_id = a.id)
                            AND NOT EXISTS (
                                SELECT 1
                                FROM reconciliation_transaction_links l
                                JOIN reconciliations r ON r.id = l.reconciliation_id
                                WHERE l.transaction_id = t.id AND r.account_id = a.id
                            )
                      )
                 )
                 SELECT COUNT(*) FROM account_refs",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub(super) fn list_eligible_reconciliation_transactions_by_id(
        &self,
        account_id: i64,
        statement_ending_on: &str,
    ) -> Result<Vec<TransactionRecord>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT
                t.id,
                t.txn_date,
                t.kind,
                t.amount_cents,
                t.to_amount_cents,
                t.reporting_amount_cents,
                t.exchange_rate,
                t.exchange_rate_source,
                t.exchange_rate_date,
                source.id,
                source.name,
                source.currency_code,
                target.id,
                target.name,
                target.currency_code,
                category.id,
                category.name,
                t.payee,
                t.note,
                t.created_at,
                t.updated_at,
                t.deleted_at,
                (SELECT MIN(l.reconciliation_id)
                 FROM reconciliation_transaction_links l
                 WHERE l.transaction_id = t.id),
                t.recurring_rule_id
             FROM transactions t
             JOIN accounts source ON source.id = t.account_id
             LEFT JOIN accounts target ON target.id = t.to_account_id
             LEFT JOIN categories category ON category.id = t.category_id
             WHERE t.deleted_at IS NULL
               AND NOT EXISTS (
                    SELECT 1
                    FROM reconciliation_transaction_links l
                    JOIN reconciliations r ON r.id = l.reconciliation_id
                    WHERE l.transaction_id = t.id AND r.account_id = ?2
               )
               AND t.txn_date <= ?1
               AND (t.account_id = ?2 OR t.to_account_id = ?2)
             ORDER BY t.txn_date ASC, t.id ASC",
        )?;

        let rows = statement.query_map(params![statement_ending_on, account_id], |row| {
            map_transaction_row(row)
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub(super) fn lookup_account_opening_balance(&self, account_id: i64) -> Result<i64, AppError> {
        self.conn
            .query_row(
                "SELECT opening_balance_cents FROM accounts WHERE id = ?1",
                params![account_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("account `{account_id}` was not found")))
    }

    pub(super) fn transaction_has_reconciliations(
        &self,
        transaction_id: i64,
    ) -> Result<bool, AppError> {
        self.conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM reconciliation_transaction_links WHERE transaction_id = ?1
                 )",
                params![transaction_id],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub(super) fn reconciled_delta_for_account(
        &self,
        account_id: i64,
        statement_ending_on: &str,
    ) -> Result<i64, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT t.kind, t.amount_cents, COALESCE(t.to_amount_cents, t.amount_cents), t.account_id, t.to_account_id
             FROM reconciliation_transaction_links l
             JOIN reconciliations r ON r.id = l.reconciliation_id
             JOIN transactions t ON t.id = l.transaction_id
             WHERE r.account_id = ?1
               AND t.deleted_at IS NULL
               AND t.txn_date <= ?2",
        )?;
        let rows = statement.query_map(params![account_id, statement_ending_on], |row| {
            let kind: String = row.get(0)?;
            Ok((
                TransactionKind::from_db(&kind).map_err(map_db_error)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })?;
        let mut total = 0_i64;
        for row in rows {
            let (kind, amount_cents, to_amount_cents, source_account_id, target_account_id) = row?;
            total += transaction_effect_for_account(
                account_id,
                kind,
                amount_cents,
                to_amount_cents,
                source_account_id,
                target_account_id,
            );
        }
        Ok(total)
    }
}
