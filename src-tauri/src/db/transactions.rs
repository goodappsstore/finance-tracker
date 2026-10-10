use super::*;

impl Db {
    pub fn add_transaction(&self, transaction: &NewTransaction) -> Result<i64, AppError> {
        let resolved = self.resolve_transaction_input(transaction)?;
        self.insert_transaction(&resolved)
    }

    pub fn add_transaction_with_fx(
        &self,
        transaction: &NewTransaction,
        fx: &TransactionFxInput,
    ) -> Result<i64, AppError> {
        let resolved = self.resolve_transaction_input(transaction)?;
        self.insert_transaction_with_fx(&resolved, fx)
    }

    pub fn edit_transaction_with_fx(
        &self,
        patch: &UpdateTransaction,
        fx: Option<&TransactionFxInput>,
    ) -> Result<(), AppError> {
        let existing = self.load_transaction(patch.id)?;
        let _ = (&existing.id, &existing.created_at, &existing.updated_at);
        if existing.deleted_at.is_some() {
            return Err(AppError::Validation(
                "deleted transactions must be restored before they can be edited".to_string(),
            ));
        }
        if self.transaction_has_reconciliations(patch.id)? {
            return Err(AppError::Validation(
                "reconciled transactions cannot be edited until the reconciliation is removed"
                    .to_string(),
            ));
        }

        let kind = patch.kind.unwrap_or(existing.kind);
        let account_id = match patch.account.as_deref() {
            Some(reference) => self.resolve_account_ref(reference)?,
            None => existing.account_id,
        };
        let to_account_id = if patch.clear_to_account {
            None
        } else if let Some(reference) = patch.to_account.as_deref() {
            Some(self.resolve_account_ref(reference)?)
        } else {
            existing.to_account_id
        };
        let category_id = if patch.clear_category {
            None
        } else if let Some(reference) = patch.category.as_deref() {
            let expected = expected_category_kind(kind);
            match expected.as_ref() {
                Some(expected_kind) => {
                    Some(self.resolve_category_ref(reference, Some(expected_kind))?)
                }
                None => Some(self.resolve_category_ref(reference, None)?),
            }
        } else {
            existing.category_id
        };

        let txn_date = match patch.txn_date.as_deref() {
            Some(value) => normalize_date_value(value)?,
            None => normalize_date_value(&existing.txn_date)?,
        };
        let resolved = ResolvedTransaction {
            txn_date,
            kind,
            amount_cents: patch.amount_cents.unwrap_or(existing.amount_cents),
            account_id,
            to_account_id,
            category_id,
            payee: resolve_optional_patch(existing.payee, &patch.payee, patch.clear_payee),
            note: resolve_optional_patch(existing.note, &patch.note, patch.clear_note),
            recurring_rule_id: existing.recurring_rule_id,
        };

        self.validate_resolved_transaction(&resolved)?;
        let fx = match fx {
            Some(value) => value.clone(),
            None if resolved.amount_cents != existing.amount_cents
                || resolved.account_id != existing.account_id
                || resolved.to_account_id != existing.to_account_id
                || resolved.kind != existing.kind
                || resolved.txn_date != existing.txn_date =>
            {
                self.resolve_transaction_fx(&resolved)?
            }
            None => TransactionFxInput {
                to_amount_cents: if resolved.kind == TransactionKind::Transfer {
                    Some(existing.to_amount_cents.unwrap_or(resolved.amount_cents))
                } else {
                    None
                },
                reporting_amount_cents: existing.reporting_amount_cents,
                exchange_rate: existing.exchange_rate,
                exchange_rate_source: existing.exchange_rate_source,
                exchange_rate_date: existing.exchange_rate_date,
            },
        };
        self.validate_transaction_fx(&resolved, &fx, true)?;
        self.conn.execute(
            "UPDATE transactions
             SET txn_date = ?1,
                 kind = ?2,
                 amount_cents = ?3,
                 to_amount_cents = ?4,
                 reporting_amount_cents = ?5,
                 exchange_rate = ?6,
                 exchange_rate_source = ?7,
                 exchange_rate_date = ?8,
                 account_id = ?9,
                 to_account_id = ?10,
                 category_id = ?11,
                 payee = ?12,
                 note = ?13,
                 updated_at = ?14
             WHERE id = ?15",
            params![
                resolved.txn_date,
                resolved.kind.as_db_str(),
                resolved.amount_cents,
                fx.to_amount_cents,
                fx.reporting_amount_cents,
                fx.exchange_rate,
                fx.exchange_rate_source,
                fx.exchange_rate_date,
                resolved.account_id,
                resolved.to_account_id,
                resolved.category_id,
                normalize_optional_text(&resolved.payee),
                normalize_optional_text(&resolved.note),
                now_timestamp(),
                patch.id
            ],
        )?;
        Ok(())
    }

    pub fn delete_transaction(&self, id: i64) -> Result<(), AppError> {
        let existing = self.load_transaction(id)?;
        if existing.deleted_at.is_some() {
            return Err(AppError::Validation(
                "transaction is already deleted".to_string(),
            ));
        }
        if self.transaction_has_reconciliations(id)? {
            return Err(AppError::Validation(
                "reconciled transactions cannot be deleted until the reconciliation is removed"
                    .to_string(),
            ));
        }

        self.conn.execute(
            "UPDATE transactions SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now_timestamp(), id],
        )?;
        Ok(())
    }

    pub fn restore_transaction(&self, id: i64) -> Result<(), AppError> {
        let existing = self.load_transaction(id)?;
        if existing.deleted_at.is_none() {
            return Err(AppError::Validation(
                "transaction is not deleted".to_string(),
            ));
        }

        let resolved = ResolvedTransaction {
            txn_date: existing.txn_date,
            kind: existing.kind,
            amount_cents: existing.amount_cents,
            account_id: existing.account_id,
            to_account_id: existing.to_account_id,
            category_id: existing.category_id,
            payee: existing.payee,
            note: existing.note,
            recurring_rule_id: existing.recurring_rule_id,
        };
        self.validate_resolved_transaction(&resolved)?;

        self.conn.execute(
            "UPDATE transactions SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
            params![now_timestamp(), id],
        )?;
        Ok(())
    }

    pub fn list_tags(&self) -> Result<Vec<TagRecord>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT t.id, t.name, COUNT(tt.transaction_id)
             FROM tags t
             LEFT JOIN transaction_tags tt ON tt.tag_id = t.id
             GROUP BY t.id, t.name
             ORDER BY t.name COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(TagRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                transaction_count: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_transaction_tags(&self, transaction_id: i64) -> Result<Vec<TagRecord>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT t.id, t.name, 0
             FROM transaction_tags tt
             JOIN tags t ON t.id = tt.tag_id
             WHERE tt.transaction_id = ?1
             ORDER BY t.name COLLATE NOCASE",
        )?;
        let rows = statement.query_map(params![transaction_id], |row| {
            Ok(TagRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                transaction_count: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn add_transaction_tag(&self, transaction_id: i64, name: &str) -> Result<(), AppError> {
        self.load_transaction(transaction_id)?;
        let name = normalize_name("tag", name)?;
        self.conn.execute(
            "INSERT OR IGNORE INTO tags (name) VALUES (?1)",
            params![name],
        )?;
        let tag_id: i64 = self.conn.query_row(
            "SELECT id FROM tags WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?1, ?2)",
            params![transaction_id, tag_id],
        )?;
        Ok(())
    }

    pub fn remove_transaction_tag(&self, transaction_id: i64, tag_id: i64) -> Result<(), AppError> {
        self.conn.execute(
            "DELETE FROM transaction_tags WHERE transaction_id = ?1 AND tag_id = ?2",
            params![transaction_id, tag_id],
        )?;
        self.conn.execute("DELETE FROM tags WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM transaction_tags WHERE tag_id = ?1)", params![tag_id])?;
        Ok(())
    }

    pub fn list_transaction_attachments(
        &self,
        transaction_id: i64,
    ) -> Result<Vec<TransactionAttachment>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, transaction_id, file_path, label, created_at
             FROM transaction_attachments WHERE transaction_id = ?1 ORDER BY id DESC",
        )?;
        let rows = statement.query_map(params![transaction_id], |row| {
            Ok(TransactionAttachment {
                id: row.get(0)?,
                transaction_id: row.get(1)?,
                file_path: row.get(2)?,
                label: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn add_transaction_attachment(
        &self,
        transaction_id: i64,
        file_path: &str,
        label: Option<&str>,
    ) -> Result<i64, AppError> {
        self.load_transaction(transaction_id)?;
        let file_path = file_path.trim();
        if file_path.is_empty() {
            return Err(AppError::Validation(
                "attachment path cannot be empty".to_string(),
            ));
        }
        let label = label
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| {
                Path::new(file_path)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(ToOwned::to_owned)
            })
            .unwrap_or_else(|| "Attachment".to_string());
        self.conn.execute(
            "INSERT INTO transaction_attachments (transaction_id, file_path, label, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![transaction_id, file_path, label, now_timestamp()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn delete_transaction_attachment(&self, id: i64) -> Result<(), AppError> {
        self.conn.execute(
            "DELETE FROM transaction_attachments WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn list_transactions(
        &self,
        filters: &TransactionFilters,
    ) -> Result<Vec<TransactionRecord>, AppError> {
        use crate::model::{TransactionSortColumn, TransactionSortDirection};
        let mut account_refs = filters.accounts.clone();
        if let Some(reference) = filters.account.as_ref() {
            account_refs.push(reference.clone());
        }
        let account_ids: Vec<i64> = account_refs
            .iter()
            .map(|reference| self.resolve_account_ref(reference))
            .collect::<Result<_, _>>()?;
        let mut category_refs = filters.categories.clone();
        if let Some(reference) = filters.category.as_ref() {
            category_refs.push(reference.clone());
        }
        let category_ids: Vec<i64> = category_refs
            .iter()
            .map(|reference| self.resolve_category_ref(reference, None))
            .collect::<Result<_, _>>()?;
        let search_query = filters
            .search
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());
        // Fuzzy matching happens in Rust so an SQL pre-filter would hide typo-tolerant
        // results. Therefore apply the requested limit only after fuzzy filtering.
        let limit = filters.limit.unwrap_or(1_000_000).min(1_000_000);
        let sql_limit = if search_query.is_some() {
            -1_i64
        } else {
            limit as i64
        };
        let include_deleted = if filters.include_deleted {
            1_i64
        } else {
            0_i64
        };
        let mut kinds = filters
            .kinds
            .iter()
            .map(|value| value.as_db_str())
            .collect::<Vec<_>>();
        if let Some(kind) = filters.kind {
            kinds.push(kind.as_db_str());
        }

        let order_clause = match (&filters.sort_by, &filters.sort_dir) {
            (Some(col), Some(dir)) => {
                let dir_str = match dir {
                    TransactionSortDirection::Asc => "ASC",
                    TransactionSortDirection::Desc => "DESC",
                };
                let col_expr = match col {
                    TransactionSortColumn::Id => "t.id",
                    TransactionSortColumn::Date => "t.txn_date",
                    TransactionSortColumn::Amount => "t.amount_cents",
                    TransactionSortColumn::Account => "source.name COLLATE NOCASE",
                    TransactionSortColumn::Category => "COALESCE(category.name, '') COLLATE NOCASE",
                    TransactionSortColumn::Payee => "COALESCE(t.payee, '') COLLATE NOCASE",
                    TransactionSortColumn::Kind => "t.kind",
                    TransactionSortColumn::CreatedAt => "t.created_at",
                };
                // Secondary tie-breaker keeps ordering stable.
                format!("ORDER BY {col_expr} {dir_str}, t.id DESC")
            }
            (Some(col), None) => {
                let col_expr = match col {
                    TransactionSortColumn::Id => "t.id",
                    TransactionSortColumn::Date => "t.txn_date",
                    TransactionSortColumn::Amount => "t.amount_cents",
                    TransactionSortColumn::Account => "source.name COLLATE NOCASE",
                    TransactionSortColumn::Category => "COALESCE(category.name, '') COLLATE NOCASE",
                    TransactionSortColumn::Payee => "COALESCE(t.payee, '') COLLATE NOCASE",
                    TransactionSortColumn::Kind => "t.kind",
                    TransactionSortColumn::CreatedAt => "t.created_at",
                };
                format!("ORDER BY {col_expr} DESC, t.id DESC")
            }
            _ => "ORDER BY t.txn_date DESC, t.id DESC".to_string(),
        };

        let placeholders = |count: usize| {
            std::iter::repeat("?")
                .take(count)
                .collect::<Vec<_>>()
                .join(", ")
        };
        let mut extra_filters = String::new();
        if !account_ids.is_empty() {
            let values = placeholders(account_ids.len());
            extra_filters.push_str(&format!(
                " AND (t.account_id IN ({values}) OR t.to_account_id IN ({values}))"
            ));
        }
        if !category_ids.is_empty() {
            extra_filters.push_str(&format!(
                " AND (t.category_id IN ({0}) OR EXISTS (SELECT 1 FROM transaction_splits sf WHERE sf.transaction_id=t.id AND sf.category_id IN ({0})))",
                placeholders(category_ids.len())
            ));
        }
        if !kinds.is_empty() {
            extra_filters.push_str(&format!(" AND t.kind IN ({})", placeholders(kinds.len())));
        }

        let sql = format!(
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
             WHERE (?1 IS NULL OR t.txn_date >= ?1)
               AND (?2 IS NULL OR t.txn_date <= ?2)
               AND (?3 = 1 OR t.deleted_at IS NULL)
             {extra_filters}
             {order_clause}
             LIMIT ?"
        );

        let mut statement = self.conn.prepare(&sql)?;
        let mut sql_params = vec![
            filters
                .from
                .as_ref()
                .map(|value| rusqlite::types::Value::Text(value.clone()))
                .unwrap_or(rusqlite::types::Value::Null),
            filters
                .to
                .as_ref()
                .map(|value| rusqlite::types::Value::Text(value.clone()))
                .unwrap_or(rusqlite::types::Value::Null),
            rusqlite::types::Value::Integer(include_deleted),
        ];
        sql_params.extend(
            account_ids
                .iter()
                .map(|value| rusqlite::types::Value::Integer(*value)),
        );
        sql_params.extend(
            account_ids
                .iter()
                .map(|value| rusqlite::types::Value::Integer(*value)),
        );
        sql_params.extend(
            category_ids
                .iter()
                .map(|value| rusqlite::types::Value::Integer(*value)),
        );
        sql_params.extend(
            category_ids
                .iter()
                .map(|value| rusqlite::types::Value::Integer(*value)),
        );
        sql_params.extend(
            kinds
                .iter()
                .map(|value| rusqlite::types::Value::Text((*value).to_string())),
        );
        sql_params.push(rusqlite::types::Value::Integer(sql_limit));
        let rows =
            statement.query_map(rusqlite::params_from_iter(sql_params), map_transaction_row)?;

        let mut out: Vec<TransactionRecord> = rows.collect::<Result<Vec<_>, _>>()?;
        if let Some(query) = search_query.as_deref() {
            let tagged_transaction_ids = self.transaction_ids_matching_tag_search(query)?;
            out.retain(|record| {
                fuzzy_matches_transaction(record, query)
                    || tagged_transaction_ids.contains(&record.id)
            });
            out.truncate(limit);
        }
        Ok(out)
    }

    pub(super) fn transaction_ids_matching_tag_search(
        &self,
        query: &str,
    ) -> Result<HashSet<i64>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT tt.transaction_id, t.name
             FROM transaction_tags tt
             JOIN tags t ON t.id = tt.tag_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut transaction_ids = HashSet::new();
        for row in rows {
            let (transaction_id, tag_name) = row?;
            if fuzzy_matches_text(&tag_name, query) {
                transaction_ids.insert(transaction_id);
            }
        }
        Ok(transaction_ids)
    }

    pub fn recent_transactions(&self, limit: usize) -> Result<Vec<TransactionRecord>, AppError> {
        self.list_transactions(&TransactionFilters {
            from: None,
            to: None,
            account: None,
            category: None,
            kind: None,
            accounts: vec![],
            categories: vec![],
            kinds: vec![],
            search: None,
            limit: Some(limit),
            include_deleted: false,
            sort_by: None,
            sort_dir: None,
        })
    }

    pub fn list_eligible_reconciliation_transactions(
        &self,
        account_ref: &str,
        statement_ending_on: &str,
    ) -> Result<Vec<TransactionRecord>, AppError> {
        let account_id = self.resolve_account_ref(account_ref)?;
        self.list_eligible_reconciliation_transactions_by_id(account_id, statement_ending_on)
    }

    pub(super) fn resolve_transaction_input(
        &self,
        transaction: &NewTransaction,
    ) -> Result<ResolvedTransaction, AppError> {
        let txn_date = normalize_date_value(&transaction.txn_date)?;
        let account_id = self.resolve_account_ref(&transaction.account)?;
        let to_account_id = match transaction.to_account.as_deref() {
            Some(reference) => Some(self.resolve_account_ref(reference)?),
            None => None,
        };
        let payee = normalize_optional_text(&transaction.payee);
        let category_id = match transaction.category.as_deref() {
            Some(reference) => match expected_category_kind(transaction.kind).as_ref() {
                Some(expected_kind) => {
                    Some(self.resolve_category_ref(reference, Some(expected_kind))?)
                }
                None => Some(self.resolve_category_ref(reference, None)?),
            },
            None => match expected_category_kind(transaction.kind).as_ref() {
                Some(expected_kind) => {
                    self.default_category_for_payee(payee.as_deref(), expected_kind)?
                }
                None => None,
            },
        };

        let resolved = ResolvedTransaction {
            txn_date,
            kind: transaction.kind,
            amount_cents: transaction.amount_cents,
            account_id,
            to_account_id,
            category_id,
            payee,
            note: normalize_optional_text(&transaction.note),
            recurring_rule_id: transaction.recurring_rule_id,
        };
        self.validate_resolved_transaction(&resolved)?;
        Ok(resolved)
    }

    pub(super) fn default_category_for_payee(
        &self,
        payee: Option<&str>,
        expected_kind: &CategoryKind,
    ) -> Result<Option<i64>, AppError> {
        let Some(payee) = payee.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let category = self
            .conn
            .query_row(
                "SELECT c.id, c.kind
             FROM payee_category_defaults d
             JOIN categories c ON c.id = d.category_id
             WHERE d.payee = ?1 COLLATE NOCASE AND c.archived = 0",
                params![payee],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        match category {
            Some((category_id, actual_kind)) => {
                if actual_kind == expected_kind.as_db_str() {
                    Ok(Some(category_id))
                } else {
                    // A payee can appear on either side of the ledger (for
                    // example, a merchant refund).  A mismatched default is
                    // simply inapplicable; callers can use their normal
                    // fallback category path without weakening the invariant.
                    Ok(None)
                }
            }
            None => Ok(None),
        }
    }

    pub fn bulk_transactions(
        &self,
        transaction_ids: &[i64],
        action: &str,
        category_ref: Option<&str>,
        tag_names: &[String],
    ) -> Result<BulkTransactionResult, AppError> {
        let mut ids = transaction_ids.to_vec();
        ids.sort_unstable();
        ids.dedup();
        if ids.is_empty() {
            return Err(AppError::Validation(
                "select at least one transaction".to_string(),
            ));
        }
        if !matches!(
            action,
            "set_category"
                | "add_tags"
                | "remove_tags"
                | "replace_tags"
                | "delete"
                | "restore"
                | "set_payee_default_category"
        ) {
            return Err(AppError::Validation("unsupported bulk action".to_string()));
        }

        let category = if matches!(action, "set_category" | "set_payee_default_category") {
            let reference = category_ref.ok_or_else(|| {
                AppError::Validation("choose a category for this bulk action".to_string())
            })?;
            let category_id = self.resolve_category_ref(reference, None)?;
            let category_kind: String = self.conn.query_row(
                "SELECT kind FROM categories WHERE id = ?1",
                params![category_id],
                |row| row.get(0),
            )?;
            Some((category_id, category_kind))
        } else {
            None
        };
        let normalized_tags = tag_names
            .iter()
            .map(|tag| normalize_name("tag", tag))
            .collect::<Result<Vec<_>, _>>()?;
        let mut normalized_tags = normalized_tags;
        normalized_tags.sort_by_key(|tag| tag.to_lowercase());
        normalized_tags.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        if matches!(action, "add_tags" | "remove_tags" | "replace_tags")
            && normalized_tags.is_empty()
        {
            return Err(AppError::Validation(
                "enter at least one tag for this bulk action".to_string(),
            ));
        }

        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> Result<BulkTransactionResult, AppError> {
            let mut tag_ids = Vec::new();
            if matches!(action, "add_tags" | "replace_tags") {
                for name in &normalized_tags {
                    self.conn.execute(
                        "INSERT OR IGNORE INTO tags (name) VALUES (?1)",
                        params![name],
                    )?;
                    let tag_id = self.conn.query_row(
                        "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                        params![name],
                        |row| row.get(0),
                    )?;
                    tag_ids.push(tag_id);
                }
            } else if action == "remove_tags" {
                let mut statement = self
                    .conn
                    .prepare("SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE")?;
                for name in &normalized_tags {
                    if let Some(tag_id) = statement
                        .query_row(params![name], |row| row.get::<_, i64>(0))
                        .optional()?
                    {
                        tag_ids.push(tag_id);
                    }
                }
            }

            let mut applied_ids = Vec::new();
            let mut skipped = Vec::new();
            for id in ids {
                let transaction = match self.load_transaction(id) {
                    Ok(value) => value,
                    Err(AppError::NotFound(_)) | Err(AppError::NotFoundEntity { .. }) => {
                        skipped.push(BulkTransactionSkip {
                            transaction_id: id,
                            reason: "not found".to_string(),
                        });
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                let reconciled = self.transaction_has_reconciliations(id)?;
                if reconciled {
                    skipped.push(BulkTransactionSkip {
                        transaction_id: id,
                        reason: "reconciled".to_string(),
                    });
                    continue;
                }
                let edits_existing = matches!(
                    action,
                    "set_category"
                        | "add_tags"
                        | "remove_tags"
                        | "replace_tags"
                        | "set_payee_default_category"
                );
                if edits_existing && transaction.deleted_at.is_some() {
                    skipped.push(BulkTransactionSkip {
                        transaction_id: id,
                        reason: "deleted — restore before editing".to_string(),
                    });
                    continue;
                }
                if action == "delete" && transaction.deleted_at.is_some() {
                    skipped.push(BulkTransactionSkip {
                        transaction_id: id,
                        reason: "already deleted".to_string(),
                    });
                    continue;
                }
                if action == "restore" && transaction.deleted_at.is_none() {
                    skipped.push(BulkTransactionSkip {
                        transaction_id: id,
                        reason: "not deleted".to_string(),
                    });
                    continue;
                }
                if matches!(action, "set_category" | "set_payee_default_category") {
                    if transaction.kind == TransactionKind::Transfer {
                        skipped.push(BulkTransactionSkip {
                            transaction_id: id,
                            reason: "transfers cannot have a category".to_string(),
                        });
                        continue;
                    }
                    let (_, category_kind) = category.as_ref().expect("category is preflighted");
                    let expected =
                        expected_category_kind(transaction.kind).expect("non-transfer has a kind");
                    if category_kind != expected.as_db_str() {
                        skipped.push(BulkTransactionSkip {
                            transaction_id: id,
                            reason: format!(
                                "category is {category_kind}; transaction is {}",
                                expected.as_db_str()
                            ),
                        });
                        continue;
                    }
                    if action == "set_payee_default_category"
                        && transaction
                            .payee
                            .as_deref()
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .is_none()
                    {
                        skipped.push(BulkTransactionSkip {
                            transaction_id: id,
                            reason: "no payee".to_string(),
                        });
                        continue;
                    }
                }

                if action == "set_category" && self.conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM transaction_splits WHERE transaction_id = ?1)",
                    [id], |row| row.get::<_, bool>(0),
                )? {
                    skipped.push(BulkTransactionSkip {
                        transaction_id: id,
                        reason: "split transaction — edit its split categories individually".to_string(),
                    });
                    continue;
                }

                let now = now_timestamp();
                match action {
                    "set_category" => {
                        self.conn.execute(
                            "UPDATE transactions SET category_id = ?1, updated_at = ?2 WHERE id = ?3",
                            params![category.as_ref().expect("category is preflighted").0, now, id],
                        )?;
                    }
                    "add_tags" => {
                        for tag_id in &tag_ids {
                            self.conn.execute(
                                "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?1, ?2)",
                                params![id, tag_id],
                            )?;
                        }
                    }
                    "remove_tags" => {
                        for tag_id in &tag_ids {
                            self.conn.execute(
                                "DELETE FROM transaction_tags WHERE transaction_id = ?1 AND tag_id = ?2",
                                params![id, tag_id],
                            )?;
                        }
                    }
                    "replace_tags" => {
                        self.conn.execute(
                            "DELETE FROM transaction_tags WHERE transaction_id = ?1",
                            params![id],
                        )?;
                        for tag_id in &tag_ids {
                            self.conn.execute(
                                "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?1, ?2)",
                                params![id, tag_id],
                            )?;
                        }
                    }
                    "delete" => {
                        self.conn.execute(
                            "UPDATE transactions SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
                            params![now, id],
                        )?;
                    }
                    "restore" => {
                        let resolved = ResolvedTransaction {
                            txn_date: transaction.txn_date,
                            kind: transaction.kind,
                            amount_cents: transaction.amount_cents,
                            account_id: transaction.account_id,
                            to_account_id: transaction.to_account_id,
                            category_id: transaction.category_id,
                            payee: transaction.payee,
                            note: transaction.note,
                            recurring_rule_id: transaction.recurring_rule_id,
                        };
                        match self.validate_resolved_transaction(&resolved) {
                            Ok(()) => self.conn.execute(
                                "UPDATE transactions SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
                                params![now, id],
                            )?,
                            Err(error) => {
                                skipped.push(BulkTransactionSkip { transaction_id: id, reason: error.to_string() });
                                continue;
                            }
                        };
                    }
                    "set_payee_default_category" => {
                        self.conn.execute(
                            "INSERT INTO payee_category_defaults (payee, category_id, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?3)
                             ON CONFLICT(payee) DO UPDATE SET category_id = excluded.category_id, updated_at = excluded.updated_at",
                            params![transaction.payee.as_deref().expect("payee checked").trim(), category.as_ref().expect("category is preflighted").0, now],
                        )?;
                    }
                    _ => unreachable!("bulk action was preflighted"),
                }
                applied_ids.push(id);
            }
            self.conn.execute(
                "DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM transaction_tags WHERE transaction_tags.tag_id = tags.id)",
                [],
            )?;
            Ok(BulkTransactionResult {
                applied_ids,
                skipped,
            })
        })();
        match outcome {
            Ok(result) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(result)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub(super) fn insert_transaction(
        &self,
        transaction: &ResolvedTransaction,
    ) -> Result<i64, AppError> {
        let fx = self.resolve_transaction_fx(transaction)?;
        self.insert_transaction_with_fx_inner(transaction, &fx, true)
    }

    pub(super) fn resolve_transaction_fx(
        &self,
        transaction: &ResolvedTransaction,
    ) -> Result<TransactionFxInput, AppError> {
        let source = self.account_currency(transaction.account_id)?;
        let reporting = self.currency_code()?;
        let target = transaction
            .to_account_id
            .map(|id| self.account_currency(id))
            .transpose()?;
        let quote_currency = target
            .as_deref()
            .filter(|target| *target != source)
            .unwrap_or(&reporting);
        let quote = self.local_fx_quote(&source, quote_currency, &transaction.txn_date)?;
        let to_amount_cents = target
            .as_deref()
            .map(|target| {
                if target == source {
                    Ok(transaction.amount_cents)
                } else {
                    crate::amount::convert_cents_at_rate(transaction.amount_cents, &quote.rate)
                }
            })
            .transpose()?;
        let fx = TransactionFxInput {
            to_amount_cents,
            reporting_amount_cents: self.reporting_value(
                transaction.amount_cents,
                &source,
                &transaction.txn_date,
            )?,
            exchange_rate: Some(quote.rate),
            exchange_rate_source: Some(quote.source),
            exchange_rate_date: Some(quote.quoted_on),
        };
        self.validate_transaction_fx(transaction, &fx, true)?;
        Ok(fx)
    }

    pub(super) fn insert_transaction_with_fx(
        &self,
        transaction: &ResolvedTransaction,
        fx: &TransactionFxInput,
    ) -> Result<i64, AppError> {
        self.insert_transaction_with_fx_inner(transaction, fx, true)
    }

    fn insert_transaction_with_fx_inner(
        &self,
        transaction: &ResolvedTransaction,
        fx: &TransactionFxInput,
        require_rate: bool,
    ) -> Result<i64, AppError> {
        self.validate_transaction_fx(transaction, fx, require_rate)?;
        let timestamp = now_timestamp();
        self.conn.execute(
            "INSERT INTO transactions (
                txn_date,
                kind,
                amount_cents,
                to_amount_cents,
                reporting_amount_cents,
                exchange_rate,
                exchange_rate_source,
                exchange_rate_date,
                account_id,
                to_account_id,
                category_id,
                payee,
                note,
                created_at,
                updated_at,
                deleted_at,
                recurring_rule_id,
                reconciliation_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, NULL, ?16, NULL)",
            params![
                transaction.txn_date,
                transaction.kind.as_db_str(),
                transaction.amount_cents,
                fx.to_amount_cents,
                fx.reporting_amount_cents,
                fx.exchange_rate,
                fx.exchange_rate_source,
                fx.exchange_rate_date,
                transaction.account_id,
                transaction.to_account_id,
                transaction.category_id,
                normalize_optional_text(&transaction.payee),
                normalize_optional_text(&transaction.note),
                timestamp,
                timestamp,
                transaction.recurring_rule_id,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub(crate) fn load_transaction(&self, id: i64) -> Result<StoredTransaction, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT
                id,
                txn_date,
                kind,
                amount_cents,
                to_amount_cents,
                reporting_amount_cents,
                exchange_rate,
                exchange_rate_source,
                exchange_rate_date,
                account_id,
                to_account_id,
                category_id,
                payee,
                note,
                created_at,
                updated_at,
                deleted_at,
                recurring_rule_id
             FROM transactions
             WHERE id = ?1",
        )?;

        statement
            .query_row(params![id], |row| {
                let kind: String = row.get(2)?;
                Ok(StoredTransaction {
                    id: row.get(0)?,
                    txn_date: row.get(1)?,
                    kind: TransactionKind::from_db(&kind).map_err(map_db_error)?,
                    amount_cents: row.get(3)?,
                    to_amount_cents: row.get(4)?,
                    reporting_amount_cents: row.get(5)?,
                    exchange_rate: row.get(6)?,
                    exchange_rate_source: row.get(7)?,
                    exchange_rate_date: row.get(8)?,
                    account_id: row.get(9)?,
                    to_account_id: row.get(10)?,
                    category_id: row.get(11)?,
                    payee: row.get(12)?,
                    note: row.get(13)?,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                    deleted_at: row.get(16)?,
                    recurring_rule_id: row.get(17)?,
                })
            })
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("transaction `{id}` was not found")))
    }

    pub(super) fn validate_resolved_transaction(
        &self,
        transaction: &ResolvedTransaction,
    ) -> Result<(), AppError> {
        validate_transaction_input(
            transaction.kind,
            transaction.to_account_id.is_some(),
            transaction.category_id.is_some(),
            transaction.amount_cents,
        )?;

        let account_exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM accounts WHERE id = ?1 AND archived = 0",
            params![transaction.account_id],
            |row| row.get(0),
        )?;
        if account_exists == 0 {
            return Err(AppError::NotFound(format!(
                "account `{}` was not found",
                transaction.account_id
            )));
        }

        if let Some(target_id) = transaction.to_account_id {
            let target_exists: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM accounts WHERE id = ?1 AND archived = 0",
                params![target_id],
                |row| row.get(0),
            )?;
            if target_exists == 0 {
                return Err(AppError::NotFound(format!(
                    "account `{target_id}` was not found"
                )));
            }
            if target_id == transaction.account_id {
                return Err(AppError::Validation(
                    "transfer destination account must be different from the source account"
                        .to_string(),
                ));
            }
        }

        if let Some(category_id) = transaction.category_id {
            let actual_kind: String = self
                .conn
                .query_row(
                    "SELECT kind FROM categories WHERE id = ?1 AND archived = 0",
                    params![category_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| {
                    AppError::NotFound(format!("category `{category_id}` was not found"))
                })?;
            if let Some(expected_kind) = expected_category_kind(transaction.kind) {
                validate_category_kind(&expected_kind, &actual_kind)?;
            }
        }

        Ok(())
    }

    fn validate_transaction_fx(
        &self,
        transaction: &ResolvedTransaction,
        fx: &TransactionFxInput,
        require_rate: bool,
    ) -> Result<(), AppError> {
        if fx.reporting_amount_cents <= 0 {
            return Err(AppError::Validation(
                "reporting amount must be positive".to_string(),
            ));
        }
        let source_currency: String = self.conn.query_row(
            "SELECT currency_code FROM accounts WHERE id = ?1",
            params![transaction.account_id],
            |row| row.get(0),
        )?;
        let reporting_currency = self.currency_code()?;
        let target_currency = transaction
            .to_account_id
            .map(|id| {
                self.conn.query_row(
                    "SELECT currency_code FROM accounts WHERE id = ?1",
                    params![id],
                    |row| row.get::<_, String>(0),
                )
            })
            .transpose()?;
        let needs_rate = source_currency != reporting_currency
            || target_currency
                .as_deref()
                .is_some_and(|currency| currency != source_currency);
        if require_rate && needs_rate && fx.exchange_rate.is_none() {
            return Err(AppError::Validation(
                "choose a manual or Frankfurter exchange rate for this conversion".to_string(),
            ));
        }
        if transaction.kind == TransactionKind::Transfer && fx.to_amount_cents.unwrap_or(0) <= 0 {
            return Err(AppError::Validation(
                "a transfer needs a positive destination amount".to_string(),
            ));
        }
        if let Some(rate) = fx.exchange_rate.as_deref() {
            let parsed = rate.parse::<rust_decimal::Decimal>().map_err(|_| {
                AppError::Validation("exchange rate must be a positive decimal".to_string())
            })?;
            if parsed <= rust_decimal::Decimal::ZERO {
                return Err(AppError::Validation(
                    "exchange rate must be positive".to_string(),
                ));
            }
            match fx.exchange_rate_source.as_deref() {
                Some("frankfurter") | Some("manual") => {}
                _ => {
                    return Err(AppError::Validation(
                        "exchange-rate source must be Frankfurter or manual".to_string(),
                    ))
                }
            }
            let quoted_on = fx.exchange_rate_date.as_deref().ok_or_else(|| {
                AppError::Validation("exchange-rate date is required".to_string())
            })?;
            normalize_date_value(quoted_on)?;
        }
        Ok(())
    }
}
