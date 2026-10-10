use super::*;

impl Db {
    pub fn import_transactions(&self, plan: &ImportPlan) -> Result<ImportResult, AppError> {
        const DEFAULT_INCOME_CATEGORY: &str = "Uncategorized Income";
        const DEFAULT_EXPENSE_CATEGORY: &str = "Uncategorized Expense";

        let account_id = self.resolve_account_ref(plan.account())?;
        let account_name = self.account_name(account_id)?;
        let rows = load_import_rows(plan, &self.account_currency(account_id)?)?;
        let rules = self
            .list_transaction_rules()?
            .into_iter()
            .filter(|rule| rule.enabled)
            .collect::<Vec<_>>();

        self.conn.execute_batch("BEGIN IMMEDIATE")?;

        let outcome = (|| -> Result<ImportResult, AppError> {
            let mut preview = Vec::with_capacity(rows.len());
            let mut imported_count = 0_usize;
            let mut duplicate_count = 0_usize;
            let mut imported_rows = Vec::with_capacity(rows.len());

            for row in rows {
                if row.kind == TransactionKind::Transfer {
                    return Err(AppError::Validation(
                        "import plans do not support transfer rows in this release".to_string(),
                    ));
                }

                let category_id = match expected_category_kind(row.kind) {
                    Some(expected_kind) => {
                        let configured_category = row.category_ref.clone().or_else(|| {
                            plan.default_category_for_kind(row.kind)
                                .map(|value| value.to_string())
                        });
                        let category_id = match configured_category {
                            Some(category_ref) => {
                                self.ensure_import_category(&category_ref, &expected_kind)?
                            }
                            None => match self
                                .default_category_for_payee(row.payee.as_deref(), &expected_kind)?
                            {
                                Some(category_id) => category_id,
                                None => {
                                    let category_ref = match expected_kind {
                                        CategoryKind::Income => DEFAULT_INCOME_CATEGORY.to_string(),
                                        CategoryKind::Expense => {
                                            DEFAULT_EXPENSE_CATEGORY.to_string()
                                        }
                                    };
                                    self.ensure_import_category(&category_ref, &expected_kind)?
                                }
                            },
                        };
                        Some(category_id)
                    }
                    None => None,
                };
                let resolved = ResolvedTransaction {
                    txn_date: row.txn_date.clone(),
                    kind: row.kind,
                    amount_cents: row.amount_cents,
                    account_id,
                    to_account_id: None,
                    category_id,
                    payee: row.payee.clone(),
                    note: row.note.clone(),
                    recurring_rule_id: None,
                };
                let (resolved, rule_tags) = self.apply_rules_to_import(resolved, &rules)?;
                let category_name = resolved.category_id.map(|id| self.category_name(id)).transpose()?;

                let duplicate = if plan.allow_duplicates() {
                    false
                } else {
                    self.import_duplicate_exists(&resolved)?
                        || imported_rows
                            .iter()
                            .any(|prior| import_rows_are_duplicates(prior, &resolved))
                };
                if duplicate {
                    duplicate_count += 1;
                } else {
                    imported_count += 1;
                    imported_rows.push(resolved.clone());
                    self.resolve_transaction_fx(&resolved)?;
                    if !plan.dry_run() {
                        let id=self.insert_transaction(&resolved)?;
                        for tag in rule_tags { self.add_transaction_tag(id,&tag)?; }
                    }
                }

                preview.push(ImportedTransactionRow {
                    line_number: row.line_number,
                    txn_date: resolved.txn_date,
                    kind: resolved.kind,
                    amount_cents: resolved.amount_cents,
                    account_name: account_name.clone(),
                    category_name,
                    payee: resolved.payee,
                    note: resolved.note,
                    duplicate,
                });
            }

            Ok(ImportResult {
                dry_run: plan.dry_run(),
                imported_count,
                duplicate_count,
                preview,
            })
        })();

        match outcome {
            Ok(result) => {
                if plan.dry_run() {
                    self.conn.execute_batch("ROLLBACK")?;
                } else {
                    self.conn.execute_batch("COMMIT")?;
                }
                Ok(result)
            }
            Err(err) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(err)
            }
        }
    }

    pub(super) fn import_duplicate_exists(
        &self,
        transaction: &ResolvedTransaction,
    ) -> Result<bool, AppError> {
        let payee = normalize_optional_text(&transaction.payee);
        let note = normalize_optional_text(&transaction.note);
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*)
             FROM transactions
             WHERE deleted_at IS NULL
               AND txn_date = ?1
               AND kind = ?2
               AND amount_cents = ?3
               AND account_id = ?4
               AND ((to_account_id IS NULL AND ?5 IS NULL) OR to_account_id = ?5)
               AND ((category_id IS NULL AND ?6 IS NULL) OR category_id = ?6)
               AND ((payee IS NULL AND ?7 IS NULL) OR payee = ?7)
               AND ((note IS NULL AND ?8 IS NULL) OR note = ?8)",
            params![
                transaction.txn_date,
                transaction.kind.as_db_str(),
                transaction.amount_cents,
                transaction.account_id,
                transaction.to_account_id,
                transaction.category_id,
                payee,
                note,
            ],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }
}
