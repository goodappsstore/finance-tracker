use super::*;

struct PayeeRow {
    id: i64,
    date: String,
    kind: TransactionKind,
    amount: i64,
    account: String,
    category: Option<String>,
    display_name: String,
}

fn median(values: &mut [i64]) -> Option<i64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let middle = values.len() / 2;
    Some(if values.len() % 2 == 0 {
        ((i128::from(values[middle - 1]) + i128::from(values[middle])) / 2) as i64
    } else {
        values[middle]
    })
}

impl Db {
    pub fn list_payees(&self) -> Result<Vec<PayeeSummary>, AppError> {
        let today = Local::now().date_naive().to_string();
        let mut statement = self.conn.prepare(
            "SELECT MIN(TRIM(payee)) AS name, COUNT(*) AS transaction_count,
                    SUM(CASE WHEN kind='expense' THEN 1 ELSE 0 END) AS expense_count,
                    COALESCE(SUM(CASE WHEN kind='expense' THEN reporting_amount_cents ELSE 0 END),0) AS lifetime_spend_cents,
                    MAX(txn_date) AS last_transaction_on
             FROM transactions
             WHERE deleted_at IS NULL AND txn_date<=?1 AND NULLIF(TRIM(payee),'') IS NOT NULL
               AND kind IN ('expense','income')
             GROUP BY LOWER(TRIM(payee))
             ORDER BY lifetime_spend_cents DESC, name COLLATE NOCASE",
        )?;
        let rows = statement.query_map(params![today], |row| {
            Ok(PayeeSummary {
                name: row.get(0)?,
                transaction_count: row.get(1)?,
                expense_count: row.get(2)?,
                lifetime_spend_cents: row.get(3)?,
                last_transaction_on: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn payee_snapshot(&self, reference: &str) -> Result<PayeeSnapshot, AppError> {
        let reference = reference.trim();
        if reference.is_empty() {
            return Err(AppError::field_validation("payee", "cannot be empty"));
        }
        let today = Local::now().date_naive();
        let today_key = today.to_string();
        let recent_start = (today - Duration::days(89)).to_string();
        let previous_start = (today - Duration::days(179)).to_string();
        let year_start = (today - Duration::days(364)).to_string();
        let current_month = NaiveDate::from_ymd_opt(today.year(), today.month(), 1)
            .expect("current month must be valid");
        let first_month = add_months_with_day(current_month, -11, 1)?;
        let mut monthly = BTreeMap::new();
        for offset in 0..12 {
            let month = add_months_with_day(first_month, offset, 1)?;
            let key = month.format("%Y-%m").to_string();
            monthly.insert(
                key.clone(),
                PayeeMonth {
                    month: key,
                    spent_cents: 0,
                    transaction_count: 0,
                },
            );
        }

        let mut statement = self.conn.prepare(
            "SELECT t.id,t.txn_date,t.kind,t.reporting_amount_cents,a.name,
                    CASE WHEN EXISTS(SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id)
                         THEN 'Split' ELSE c.name END,TRIM(t.payee)
             FROM transactions t JOIN accounts a ON a.id=t.account_id
             LEFT JOIN categories c ON c.id=t.category_id
             WHERE t.deleted_at IS NULL AND t.txn_date<=?2 AND t.kind IN ('expense','income')
               AND LOWER(TRIM(t.payee))=LOWER(?1)
             ORDER BY t.txn_date,t.id",
        )?;
        let records = statement.query_map(params![reference, today_key], |row| {
            let kind: String = row.get(2)?;
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                kind,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        let mut rows = Vec::new();
        for result in records {
            let (id, date, kind, amount, account, category, display_name) = result?;
            rows.push(PayeeRow {
                id,
                date,
                kind: TransactionKind::from_db(&kind)?,
                amount,
                account,
                category,
                display_name,
            });
        }
        if rows.is_empty() {
            return Err(AppError::NotFound(format!(
                "payee `{reference}` was not found"
            )));
        }

        let mut lifetime_spend_cents = 0_i64;
        let mut expense_count = 0_i64;
        let mut lifetime_income_cents = 0_i64;
        let mut income_count = 0_i64;
        let mut recent_spend_cents = 0_i64;
        let mut previous_spend_cents = 0_i64;
        let mut recent_values = Vec::new();
        let mut previous_values = Vec::new();
        let mut accounts: HashMap<String, (i64, i64)> = HashMap::new();
        for row in &rows {
            if row.kind == TransactionKind::Income {
                income_count += 1;
                lifetime_income_cents =
                    lifetime_income_cents
                        .checked_add(row.amount)
                        .ok_or_else(|| {
                            AppError::Validation("payee income total is too large".into())
                        })?;
                continue;
            }
            if row.kind != TransactionKind::Expense {
                continue;
            }
            expense_count += 1;
            lifetime_spend_cents = lifetime_spend_cents
                .checked_add(row.amount)
                .ok_or_else(|| AppError::Validation("payee spend total is too large".into()))?;
            if let Some(month) = row.date.get(..7).and_then(|key| monthly.get_mut(key)) {
                month.spent_cents = month.spent_cents.checked_add(row.amount).ok_or_else(|| {
                    AppError::Validation("payee monthly spend is too large".into())
                })?;
                month.transaction_count += 1;
            }
            if row.date >= recent_start {
                recent_spend_cents += row.amount;
                recent_values.push(row.amount);
            } else if row.date >= previous_start {
                previous_spend_cents += row.amount;
                previous_values.push(row.amount);
            }
            if row.date >= year_start {
                let entry = accounts.entry(row.account.clone()).or_default();
                entry.0 += row.amount;
                entry.1 += 1;
            }
        }
        let recent_count = recent_values.len() as i64;
        let previous_count = previous_values.len() as i64;
        let recent_median_cents = median(&mut recent_values);
        let previous_median_cents = median(&mut previous_values);
        let price_creep_percent = if recent_count >= 3 && previous_count >= 3 {
            match (recent_median_cents, previous_median_cents) {
                (Some(recent), Some(previous)) if previous > 0 => {
                    Some((recent as f64 / previous as f64 - 1.0) * 100.0)
                }
                _ => None,
            }
        } else {
            None
        };

        let mut category_statement = self.conn.prepare(
            "SELECT COALESCE(c.name,'Uncategorized') AS label,
                    SUM(COALESCE(s.reporting_amount_cents,t.reporting_amount_cents)) AS spent_cents,
                    COUNT(DISTINCT t.id) AS transaction_count
             FROM transactions t
             LEFT JOIN transaction_splits s ON s.transaction_id=t.id
             LEFT JOIN categories c ON c.id=COALESCE(s.category_id,t.category_id)
             WHERE t.deleted_at IS NULL AND t.kind='expense' AND t.txn_date BETWEEN ?2 AND ?3
               AND LOWER(TRIM(t.payee))=LOWER(?1)
             GROUP BY COALESCE(c.id,-1),label
             ORDER BY spent_cents DESC,label COLLATE NOCASE LIMIT 8",
        )?;
        let categories = category_statement
            .query_map(params![reference, year_start, today_key], |row| {
                Ok(PayeeBreakdown {
                    label: row.get(0)?,
                    spent_cents: row.get(1)?,
                    transaction_count: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut accounts = accounts
            .into_iter()
            .map(|(label, (spent_cents, transaction_count))| PayeeBreakdown {
                label,
                spent_cents,
                transaction_count,
            })
            .collect::<Vec<_>>();
        accounts.sort_by(|a, b| {
            b.spent_cents
                .cmp(&a.spent_cents)
                .then(a.label.cmp(&b.label))
        });
        accounts.truncate(8);
        let recent_activity = rows
            .iter()
            .rev()
            .take(12)
            .map(|row| PayeeActivity {
                id: row.id,
                txn_date: row.date.clone(),
                kind: row.kind,
                amount_cents: row.amount,
                account_name: row.account.clone(),
                category_name: row.category.clone(),
            })
            .collect();
        Ok(PayeeSnapshot {
            name: rows.last().unwrap().display_name.clone(),
            transaction_count: rows.len() as i64,
            expense_count,
            lifetime_spend_cents,
            income_count,
            lifetime_income_cents,
            recent_spend_cents,
            previous_spend_cents,
            recent_count,
            previous_count,
            recent_median_cents,
            previous_median_cents,
            price_creep_percent,
            first_transaction_on: rows.first().unwrap().date.clone(),
            last_transaction_on: rows.last().unwrap().date.clone(),
            monthly: monthly.into_values().collect(),
            categories,
            accounts,
            recent_activity,
        })
    }
}
