use super::*;

impl Db {
    pub fn set_budget(
        &self,
        month: &str,
        category_ref: &str,
        amount_cents: i64,
        account_ref: Option<&str>,
        scenario_ref: Option<&str>,
    ) -> Result<i64, AppError> {
        if amount_cents <= 0 {
            return Err(AppError::Validation(
                "budget amount must be positive".to_string(),
            ));
        }

        let month = normalize_month_key(month)?;
        let category_id = self.resolve_category_ref(category_ref, Some(&CategoryKind::Expense))?;
        let scenario_id = self.resolve_optional_scenario_ref(scenario_ref)?;
        let account_id = match account_ref.map(str::trim).filter(|value| !value.is_empty()) {
            Some(reference) => Some(self.resolve_account_ref(reference)?),
            None => None,
        };
        let timestamp = now_timestamp();
        match scenario_id {
            Some(scenario_id) => {
                let existing: Option<i64> = self
                    .conn
                    .query_row(
                        "SELECT id
                         FROM scenario_budget_overrides
                         WHERE scenario_id = ?1
                           AND month = ?2
                           AND category_id = ?3
                           AND ((?4 IS NULL AND account_id IS NULL) OR account_id = ?4)",
                        params![scenario_id, &month, category_id, account_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                match existing {
                    Some(id) => {
                        self.conn.execute(
                            "UPDATE scenario_budget_overrides
                             SET amount_cents = ?1,
                                 updated_at = ?2
                             WHERE id = ?3",
                            params![amount_cents, timestamp, id],
                        )?;
                        Ok(id)
                    }
                    None => {
                        self.conn.execute(
                            "INSERT INTO scenario_budget_overrides (
                                 scenario_id,
                                 month,
                                 category_id,
                                 account_id,
                                 amount_cents,
                                 created_at,
                                 updated_at
                             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                            params![
                                scenario_id,
                                month,
                                category_id,
                                account_id,
                                amount_cents,
                                timestamp,
                                timestamp,
                            ],
                        )?;
                        Ok(self.conn.last_insert_rowid())
                    }
                }
            }
            None => {
                let existing: Option<i64> = self
                    .conn
                    .query_row(
                        "SELECT id FROM budgets
                         WHERE month = ?1 AND category_id = ?2
                           AND ((?3 IS NULL AND account_id IS NULL) OR account_id = ?3)",
                        params![&month, category_id, account_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                match existing {
                    Some(id) => {
                        self.conn.execute(
                            "UPDATE budgets
                             SET amount_cents = ?1,
                                 updated_at = ?2
                             WHERE id = ?3",
                            params![amount_cents, timestamp, id],
                        )?;
                        Ok(id)
                    }
                    None => {
                        self.conn.execute(
                            "INSERT INTO budgets (
                                 month,
                                 category_id,
                                 account_id,
                                 amount_cents,
                                 created_at,
                                 updated_at
                             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                            params![
                                month,
                                category_id,
                                account_id,
                                amount_cents,
                                timestamp,
                                timestamp,
                            ],
                        )?;
                        Ok(self.conn.last_insert_rowid())
                    }
                }
            }
        }
    }

    pub fn delete_budget(
        &self,
        month: &str,
        category_ref: &str,
        account_ref: Option<&str>,
        scenario_ref: Option<&str>,
    ) -> Result<(), AppError> {
        let month = normalize_month_key(month)?;
        let category_id = self.resolve_category_ref(category_ref, Some(&CategoryKind::Expense))?;
        let scenario_id = self.resolve_optional_scenario_ref(scenario_ref)?;
        let account_id = match account_ref.map(str::trim).filter(|value| !value.is_empty()) {
            Some(reference) => Some(self.resolve_account_ref(reference)?),
            None => None,
        };
        let changed = match scenario_id {
            Some(scenario_id) => self.conn.execute(
                "DELETE FROM scenario_budget_overrides
                 WHERE scenario_id = ?1
                   AND month = ?2
                   AND category_id = ?3
                   AND ((?4 IS NULL AND account_id IS NULL) OR account_id = ?4)",
                params![scenario_id, &month, category_id, account_id],
            )?,
            None => self.conn.execute(
                "DELETE FROM budgets
                 WHERE month = ?1
                   AND category_id = ?2
                   AND ((?3 IS NULL AND account_id IS NULL) OR account_id = ?3)",
                params![&month, category_id, account_id],
            )?,
        };

        if changed == 0 {
            let message = match scenario_ref
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                Some(scenario) => format!(
                    "scenario budget override for `{}` in {} ({}) was not found",
                    category_ref.trim(),
                    month,
                    scenario
                ),
                None => format!(
                    "budget for `{}` in {} was not found",
                    category_ref.trim(),
                    month
                ),
            };
            return Err(AppError::NotFound(message));
        }

        Ok(())
    }

    pub fn list_budgets(
        &self,
        month: Option<&str>,
        scenario_ref: Option<&str>,
    ) -> Result<Vec<BudgetRecord>, AppError> {
        let normalized_month = match month {
            Some(value) => Some(normalize_month_key(value)?),
            None => None,
        };
        let scenario_id = self.resolve_optional_scenario_ref(scenario_ref)?;
        let scenario_name = match scenario_id {
            Some(id) => Some(self.scenario_name(id)?),
            None => None,
        };
        let mut rows_by_key: BTreeMap<(String, i64, Option<i64>), BudgetRecord> = BTreeMap::new();
        let mut statement = self.conn.prepare(
            "SELECT
                b.id,
                b.month,
                b.category_id,
                c.name,
                b.created_at,
                b.updated_at,
                b.account_id,
                a.name,
                b.amount_cents,
                0
             FROM budgets b
             JOIN categories c ON c.id = b.category_id
             LEFT JOIN accounts a ON a.id = b.account_id
             WHERE (?1 IS NULL OR b.month = ?1)
             ORDER BY b.month DESC, c.name COLLATE NOCASE",
        )?;
        let rows = statement.query_map(params![normalized_month.as_deref()], |row| {
            Ok(BudgetRecord {
                id: row.get(0)?,
                month: row.get(1)?,
                category_id: row.get(2)?,
                category_name: row.get(3)?,
                scenario_id,
                scenario_name: scenario_name.clone(),
                is_override: row.get::<_, i64>(9)? == 1,
                account_id: row.get(6)?,
                account_name: row.get(7)?,
                amount_cents: row.get(8)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        for row in rows {
            let row = row?;
            rows_by_key.insert((row.month.clone(), row.category_id, row.account_id), row);
        }

        if let Some(scenario_id) = scenario_id {
            let mut override_statement = self.conn.prepare(
                "SELECT
                    o.id,
                    o.month,
                    o.category_id,
                    c.name,
                    o.created_at,
                    o.updated_at,
                    o.account_id,
                    a.name,
                    o.amount_cents,
                    1
                 FROM scenario_budget_overrides o
                 JOIN categories c ON c.id = o.category_id
                 LEFT JOIN accounts a ON a.id = o.account_id
                 WHERE o.scenario_id = ?1
                   AND (?2 IS NULL OR o.month = ?2)
                 ORDER BY o.month DESC, c.name COLLATE NOCASE",
            )?;
            let override_rows = override_statement.query_map(
                params![scenario_id, normalized_month.as_deref()],
                |row| {
                    Ok(BudgetRecord {
                        id: row.get(0)?,
                        month: row.get(1)?,
                        category_id: row.get(2)?,
                        category_name: row.get(3)?,
                        scenario_id: Some(scenario_id),
                        scenario_name: scenario_name.clone(),
                        is_override: row.get::<_, i64>(9)? == 1,
                        account_id: row.get(6)?,
                        account_name: row.get(7)?,
                        amount_cents: row.get(8)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )?;
            for row in override_rows {
                let row = row?;
                rows_by_key.insert((row.month.clone(), row.category_id, row.account_id), row);
            }
        }

        let mut rows: Vec<_> = rows_by_key.into_values().collect();
        rows.sort_by(|left, right| {
            right.month.cmp(&left.month).then(
                left.category_name
                    .to_lowercase()
                    .cmp(&right.category_name.to_lowercase()),
            )
        });
        Ok(rows)
    }

    pub fn budget_status(
        &self,
        month: &str,
        scenario_ref: Option<&str>,
    ) -> Result<Vec<BudgetStatusRecord>, AppError> {
        self.budget_status_scoped(month, scenario_ref, None)
    }

    /// Budget allocations and spending are always expressed in reporting currency.
    /// Account-specific envelopes take precedence over the global envelope.
    pub fn budget_status_scoped(
        &self,
        month: &str,
        scenario_ref: Option<&str>,
        account_ref: Option<&str>,
    ) -> Result<Vec<BudgetStatusRecord>, AppError> {
        let mut rows = self.budget_status_at(month, scenario_ref, account_ref, None)?;
        if let Some(account) = account_ref {
            let id = self.resolve_account_ref(account)?;
            let (from, to) = month_bounds(month)?;
            let specific: HashSet<i64> = rows
                .iter()
                .filter(|r| r.account_id == Some(id))
                .map(|r| r.category_id)
                .collect();
            for row in &mut rows {
                row.spent_cents = if row.account_id.is_none() && specific.contains(&row.category_id)
                {
                    0
                } else {
                    self.conn.query_row("WITH allocations AS (SELECT t.category_id,t.reporting_amount_cents amount FROM transactions t WHERE t.deleted_at IS NULL AND t.kind='expense' AND t.account_id=?1 AND t.txn_date BETWEEN ?3 AND ?4 AND NOT EXISTS(SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id) UNION ALL SELECT s.category_id,s.reporting_amount_cents FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id WHERE t.deleted_at IS NULL AND t.kind='expense' AND t.account_id=?1 AND t.txn_date BETWEEN ?3 AND ?4) SELECT COALESCE(SUM(amount),0) FROM allocations WHERE category_id=?2",params![id,row.category_id,from,to],|r|r.get(0))?
                };
                row.remaining_cents = budget_add(row.budget_cents, -row.spent_cents)?;
                row.over_budget = row.remaining_cents < 0;
            }
        }
        Ok(rows)
    }

    pub(super) fn budget_status_at(
        &self,
        month: &str,
        scenario_ref: Option<&str>,
        account_ref: Option<&str>,
        as_of: Option<&str>,
    ) -> Result<Vec<BudgetStatusRecord>, AppError> {
        let month = normalize_month_key(month)?;
        let account_filter = account_ref
            .map(|a| self.resolve_account_ref(a))
            .transpose()?;
        let scenario_id = self.resolve_optional_scenario_ref(scenario_ref)?;
        let scenario_name = scenario_id.map(|id| self.scenario_name(id)).transpose()?;
        let policies = self.budget_rollover_policies()?;
        let budgets = self.list_budgets(None, scenario_ref)?;
        let start = policies
            .iter()
            .map(|p| p.2.as_str())
            .filter(|m| *m < month.as_str())
            .min()
            .unwrap_or(&month)
            .to_string();
        let mut cursor = parse_date(&format!("{start}-01"))?;
        let end = parse_date(&format!("{month}-01"))?;
        // One grouped ledger read for the entire rollover window.
        let mut statement = self.conn.prepare(
            "WITH allocations AS (
                SELECT substr(t.txn_date,1,7) month,t.category_id,t.account_id,t.reporting_amount_cents amount
                FROM transactions t WHERE t.deleted_at IS NULL AND t.kind='expense'
                  AND t.txn_date BETWEEN ?1 AND ?2
                  AND NOT EXISTS(SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id)
                UNION ALL
                SELECT substr(t.txn_date,1,7),s.category_id,t.account_id,s.reporting_amount_cents
                FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id
                WHERE t.deleted_at IS NULL AND t.kind='expense' AND t.txn_date BETWEEN ?1 AND ?2
             ) SELECT month,category_id,account_id,SUM(amount) FROM allocations
             GROUP BY month,category_id,account_id",
        )?;
        let spending = statement
            .query_map(
                params![
                    format!("{start}-01"),
                    as_of
                        .map(str::to_string)
                        .unwrap_or(month_bounds(&month)?.1)
                        .min(month_bounds(&month)?.1)
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let mut statement = self.conn.prepare(
            "SELECT month, from_category_id, to_category_id, account_id, amount_cents
             FROM budget_moves WHERE month >= ?1 AND month <= ?2",
        )?;
        let moves = statement
            .query_map(params![start, month], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut carry: BTreeMap<(i64, Option<i64>), i64> = BTreeMap::new();
        loop {
            let current = cursor.format("%Y-%m").to_string();
            let mut rows: BTreeMap<(i64, Option<i64>), BudgetStatusRecord> = BTreeMap::new();
            let new_row = |category_id: i64,
                           account_id: Option<i64>|
             -> Result<BudgetStatusRecord, AppError> {
                let category_name = self.conn.query_row(
                    "SELECT name FROM categories WHERE id=?1",
                    [category_id],
                    |r| r.get(0),
                )?;
                let account_name = account_id
                    .map(|id| {
                        self.conn
                            .query_row("SELECT name FROM accounts WHERE id=?1", [id], |r| r.get(0))
                    })
                    .transpose()?;
                Ok(BudgetStatusRecord {
                    month: current.clone(),
                    category_id,
                    category_name,
                    account_id,
                    account_name,
                    scenario_id,
                    scenario_name: scenario_name.clone(),
                    is_override: false,
                    budget_cents: 0,
                    allocated_cents: 0,
                    rollover_cents: 0,
                    moved_cents: 0,
                    rollover_start_month: None,
                    spent_cents: 0,
                    remaining_cents: 0,
                    over_budget: false,
                })
            };
            for b in budgets.iter().filter(|b| b.month == current) {
                let mut row = new_row(b.category_id, b.account_id)?;
                row.allocated_cents = b.amount_cents;
                row.is_override = b.is_override;
                rows.insert((b.category_id, b.account_id), row);
            }
            for (cat, acc, start) in policies.iter().filter(|p| p.2 <= current) {
                let key = (*cat, *acc);
                if !rows.contains_key(&key) {
                    rows.insert(key, new_row(*cat, *acc)?);
                }
                let row = rows.get_mut(&key).unwrap();
                row.rollover_start_month = Some(start.clone());
                row.rollover_cents = *carry.get(&key).unwrap_or(&0);
            }
            for (_, from, to, acc, amount) in moves.iter().filter(|m| m.0 == current) {
                for (cat, delta) in [(*from, -*amount), (*to, *amount)] {
                    let key = (cat, *acc);
                    if !rows.contains_key(&key) {
                        rows.insert(key, new_row(cat, *acc)?);
                    }
                    let row = rows.get_mut(&key).unwrap();
                    row.moved_cents = budget_add(row.moved_cents, delta)?;
                }
            }
            for (_, cat, acc, amount) in spending.iter().filter(|s| s.0 == current) {
                let key = if rows.contains_key(&(*cat, Some(*acc))) {
                    (*cat, Some(*acc))
                } else if rows.contains_key(&(*cat, None)) {
                    (*cat, None)
                } else {
                    (*cat, Some(*acc))
                };
                if !rows.contains_key(&key) {
                    rows.insert(key, new_row(key.0, key.1)?);
                }
                let row = rows.get_mut(&key).unwrap();
                row.spent_cents = budget_add(row.spent_cents, *amount)?;
            }
            for (key, row) in rows.iter_mut() {
                row.budget_cents = budget_add(
                    budget_add(row.allocated_cents, row.rollover_cents)?,
                    row.moved_cents,
                )?;
                row.remaining_cents = budget_add(row.budget_cents, -row.spent_cents)?;
                row.over_budget = row.remaining_cents < 0;
                if row.rollover_start_month.is_some() {
                    carry.insert(*key, row.remaining_cents);
                }
            }
            if cursor == end {
                let mut result: Vec<_> = rows
                    .into_values()
                    .filter(|r| {
                        account_filter.is_none()
                            || r.account_id.is_none()
                            || r.account_id == account_filter
                    })
                    .collect();
                result.sort_by(|a, b| {
                    a.category_name
                        .to_lowercase()
                        .cmp(&b.category_name.to_lowercase())
                        .then(a.account_id.cmp(&b.account_id))
                });
                return Ok(result);
            }
            cursor = add_months_with_day(cursor, 1, 1)?;
        }
    }

    pub(super) fn budget_rollover_policies(
        &self,
    ) -> Result<Vec<(i64, Option<i64>, String)>, AppError> {
        let mut s = self
            .conn
            .prepare("SELECT category_id,account_id,start_month FROM budget_rollovers")?;
        let rows = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn set_budget_rollover(
        &self,
        category: &str,
        account: Option<&str>,
        start_month: Option<&str>,
    ) -> Result<(), AppError> {
        let cat = self.resolve_category_ref(category, Some(&CategoryKind::Expense))?;
        let acc = account.map(|a| self.resolve_account_ref(a)).transpose()?;
        let start = start_month.map(normalize_month_key).transpose()?;
        if let Some(start) = start.as_deref() {
            let year = parse_date(&format!("{start}-01"))?.year();
            if !(1900..=Local::now().year() + 10).contains(&year) {
                return Err(AppError::Validation(
                    "rollover start must be between 1900 and ten years from now".into(),
                ));
            }
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM budget_rollovers WHERE category_id=?1 AND account_id IS ?2",
            params![cat, acc],
        )?;
        if let Some(start) = start {
            tx.execute(
                "INSERT INTO budget_rollovers(category_id,account_id,start_month) VALUES(?1,?2,?3)",
                params![cat, acc, start],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn move_budget_money(
        &self,
        month: &str,
        from: &str,
        to: &str,
        account: Option<&str>,
        amount: i64,
    ) -> Result<(), AppError> {
        let month = normalize_month_key(month)?;
        let from = self.resolve_category_ref(from, Some(&CategoryKind::Expense))?;
        let to = self.resolve_category_ref(to, Some(&CategoryKind::Expense))?;
        let acc = account.map(|a| self.resolve_account_ref(a)).transpose()?;
        if from == to || amount <= 0 {
            return Err(AppError::Validation(
                "choose different categories and a positive amount".into(),
            ));
        }
        let tx = self.conn.unchecked_transaction()?;
        let status = self.budget_status(&month, None)?;
        let available = status
            .iter()
            .find(|s| s.category_id == from && s.account_id == acc)
            .map(|s| s.remaining_cents)
            .unwrap_or(0);
        if amount > available {
            return Err(AppError::Validation(
                "amount exceeds the source category’s remaining budget".into(),
            ));
        }
        // Require an existing destination envelope to avoid changing global/account precedence implicitly.
        if !status
            .iter()
            .any(|s| s.category_id == to && s.account_id == acc)
        {
            return Err(AppError::Validation(
                "set a destination budget in the same account scope first".into(),
            ));
        }
        tx.execute("INSERT INTO budget_moves(month,from_category_id,to_category_id,account_id,amount_cents,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![month,from,to,acc,amount,now_timestamp()])?;
        tx.commit()?;
        Ok(())
    }

    pub fn list_budget_moves(
        &self,
        month: Option<&str>,
    ) -> Result<Vec<BudgetMoveRecord>, AppError> {
        let normalized_month = match month {
            Some(m) if !m.trim().is_empty() => Some(normalize_month_key(m)?),
            _ => None,
        };
        let mut statement = self.conn.prepare(
            "SELECT m.id, m.month, m.from_category_id, cf.name, m.to_category_id, ct.name,
                    m.account_id, a.name, m.amount_cents, m.created_at
             FROM budget_moves m
             JOIN categories cf ON cf.id = m.from_category_id
             JOIN categories ct ON ct.id = m.to_category_id
             LEFT JOIN accounts a ON a.id = m.account_id
             WHERE (?1 IS NULL OR m.month = ?1)
             ORDER BY m.created_at DESC, m.id DESC",
        )?;
        let rows = statement.query_map(params![normalized_month], |row| {
            Ok(BudgetMoveRecord {
                id: row.get(0)?,
                month: row.get(1)?,
                from_category_id: row.get(2)?,
                from_category_name: row.get(3)?,
                to_category_id: row.get(4)?,
                to_category_name: row.get(5)?,
                account_id: row.get(6)?,
                account_name: row.get(7)?,
                amount_cents: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}

pub(super) fn budget_add(a: i64, b: i64) -> Result<i64, AppError> {
    a.checked_add(b)
        .ok_or_else(|| AppError::Validation("budget amount exceeds the supported range".into()))
}
