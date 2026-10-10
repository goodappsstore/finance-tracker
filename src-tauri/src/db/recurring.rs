use super::*;

impl Db {
    pub fn add_recurring_rule(&self, rule: &NewRecurringRule) -> Result<i64, AppError> {
        let resolved = self.resolve_recurring_rule_input(rule)?;
        self.insert_recurring_rule(&resolved)
    }

    pub fn edit_recurring_rule(&self, patch: &UpdateRecurringRule) -> Result<(), AppError> {
        let existing = self.load_recurring_rule(patch.id)?;
        let _ = (
            &existing.next_due_on,
            existing.paused,
            &existing.created_at,
            &existing.updated_at,
        );
        let kind = patch.kind.unwrap_or(existing.kind);
        let cadence = patch.cadence.unwrap_or(existing.cadence);
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

        let start_on = patch
            .start_on
            .clone()
            .unwrap_or_else(|| existing.start_on.clone());
        let end_on = if patch.clear_end_on {
            None
        } else if let Some(value) = patch.end_on.clone() {
            Some(value)
        } else {
            existing.end_on.clone()
        };
        let day_of_month = if patch.clear_day_of_month {
            None
        } else {
            patch.day_of_month.or(existing.day_of_month)
        };
        let weekday = if patch.clear_weekday {
            None
        } else {
            patch.weekday.or(existing.weekday)
        };
        let interval = patch.interval.unwrap_or(existing.interval);
        let minimum_next_due_on = self.compute_rule_next_due_after_edit(
            patch.id,
            &start_on,
            cadence,
            interval,
            day_of_month,
            weekday,
        )?;
        let schedule_changed = cadence != existing.cadence
            || interval != existing.interval
            || day_of_month != existing.day_of_month
            || weekday != existing.weekday
            || start_on != existing.start_on;
        let next_due_on = if patch.clear_next_due_on {
            minimum_next_due_on.clone()
        } else if let Some(value) = patch.next_due_on.as_deref() {
            self.resolve_recurring_next_due_on(
                parse_date(&start_on)?,
                cadence,
                interval,
                day_of_month,
                weekday,
                Some(value),
                parse_date(&minimum_next_due_on)?,
            )?
        } else if schedule_changed {
            minimum_next_due_on.clone()
        } else {
            existing.next_due_on.clone()
        };

        let resolved = ResolvedRecurringRule {
            name: patch.name.clone().unwrap_or(existing.name),
            kind,
            amount_cents: patch.amount_cents.unwrap_or(existing.amount_cents),
            account_id,
            to_account_id,
            category_id,
            payee: resolve_optional_patch(existing.payee, &patch.payee, patch.clear_payee),
            note: resolve_optional_patch(existing.note, &patch.note, patch.clear_note),
            cadence,
            interval,
            day_of_month,
            weekday,
            start_on,
            end_on,
            next_due_on,
        };
        self.validate_resolved_recurring_rule(&resolved)?;

        self.conn.execute(
            "DELETE FROM recurring_occurrences WHERE rule_id = ?1 AND status = 'pending'",
            params![patch.id],
        )?;
        self.conn.execute(
            "UPDATE recurring_rules
             SET name = ?1,
                 kind = ?2,
                 amount_cents = ?3,
                 account_id = ?4,
                 to_account_id = ?5,
                 category_id = ?6,
                 payee = ?7,
                 note = ?8,
                 cadence = ?9,
                 interval = ?10,
                 day_of_month = ?11,
                 weekday = ?12,
                 start_on = ?13,
                 end_on = ?14,
                 next_due_on = ?15,
                 updated_at = ?16
             WHERE id = ?17",
            params![
                resolved.name,
                resolved.kind.as_db_str(),
                resolved.amount_cents,
                resolved.account_id,
                resolved.to_account_id,
                resolved.category_id,
                normalize_optional_text(&resolved.payee),
                normalize_optional_text(&resolved.note),
                resolved.cadence.as_db_str(),
                resolved.interval,
                resolved.day_of_month.map(|value| value as i64),
                resolved.weekday.map(|value| value.as_db_str().to_string()),
                resolved.start_on,
                resolved.end_on,
                resolved.next_due_on,
                now_timestamp(),
                patch.id,
            ],
        )?;
        Ok(())
    }

    pub fn list_recurring_rules(&self) -> Result<Vec<RecurringRuleRecord>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT
                r.id,
                r.name,
                r.kind,
                r.amount_cents,
                source.id,
                source.name,
                target.id,
                target.name,
                category.id,
                category.name,
                r.payee,
                r.note,
                r.cadence,
                r.interval,
                r.day_of_month,
                r.weekday,
                r.start_on,
                r.end_on,
                COALESCE(
                    (
                        SELECT MIN(o.due_on)
                        FROM recurring_occurrences o
                        WHERE o.rule_id = r.id
                          AND o.status = 'pending'
                    ),
                    r.next_due_on
                ) AS display_next_due_on,
                r.paused,
                r.created_at,
                r.updated_at
             FROM recurring_rules r
             JOIN accounts source ON source.id = r.account_id
             LEFT JOIN accounts target ON target.id = r.to_account_id
             LEFT JOIN categories category ON category.id = r.category_id
             ORDER BY r.name COLLATE NOCASE",
        )?;

        let rows = statement.query_map([], |row| {
            let kind: String = row.get(2)?;
            let cadence: String = row.get(12)?;
            let weekday: Option<String> = row.get(15)?;
            Ok(RecurringRuleRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: TransactionKind::from_db(&kind).map_err(map_db_error)?,
                amount_cents: row.get(3)?,
                account_id: row.get(4)?,
                account_name: row.get(5)?,
                to_account_id: row.get(6)?,
                to_account_name: row.get(7)?,
                category_id: row.get(8)?,
                category_name: row.get(9)?,
                payee: row.get(10)?,
                note: row.get(11)?,
                cadence: RecurringCadence::from_db(&cadence).map_err(map_db_error)?,
                interval: row.get(13)?,
                day_of_month: row.get::<_, Option<i64>>(14)?.map(|value| value as u32),
                weekday: match weekday {
                    Some(value) => Some(Weekday::from_db(&value).map_err(map_db_error)?),
                    None => None,
                },
                start_on: row.get(16)?,
                end_on: row.get(17)?,
                next_due_on: row.get(18)?,
                paused: row.get::<_, i64>(19)? == 1,
                created_at: row.get(20)?,
                updated_at: row.get(21)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
    pub fn pause_recurring_rule(&self, id: i64) -> Result<(), AppError> {
        self.atomic(|db| db.update_recurring_pause_state(id, true))
    }

    pub fn resume_recurring_rule(&self, id: i64) -> Result<(), AppError> {
        self.atomic(|db| db.update_recurring_pause_state(id, false))
    }

    pub fn delete_recurring_rule(&self, id: i64) -> Result<(), AppError> {
        let exists: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM recurring_rules WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!(
                "recurring rule `{id}` was not found"
            )));
        }

        self.conn.execute(
            "UPDATE transactions SET recurring_rule_id = NULL, updated_at = ?1 WHERE recurring_rule_id = ?2",
            params![now_timestamp(), id],
        )?;
        self.conn.execute(
            "DELETE FROM recurring_occurrences WHERE rule_id = ?1",
            params![id],
        )?;
        self.conn
            .execute("DELETE FROM recurring_rules WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn run_due_recurring(&self, through: &str) -> Result<usize, AppError> {
        self.atomic(|db| db.run_due_recurring_inner(through))
    }

    fn run_due_recurring_inner(&self, through: &str) -> Result<usize, AppError> {
        self.sync_due_occurrences(through)?;
        let due = self.list_due_occurrences(through)?;
        let mut posted = 0_usize;
        for occurrence in due {
            if occurrence.status != OccurrenceStatus::Pending {
                continue;
            }
            let rule = self.load_recurring_rule(occurrence.rule_id)?;
            let transaction = ResolvedTransaction {
                txn_date: occurrence.due_on.clone(),
                kind: rule.kind,
                amount_cents: rule.amount_cents,
                account_id: rule.account_id,
                to_account_id: rule.to_account_id,
                category_id: rule.category_id,
                payee: rule.payee.clone(),
                note: rule.note.clone(),
                recurring_rule_id: Some(rule.id),
            };
            self.validate_resolved_transaction(&transaction)?;
            let transaction_id = self.insert_transaction(&transaction)?;
            self.conn.execute(
                "UPDATE recurring_occurrences SET transaction_id = ?1, status = 'posted' WHERE id = ?2",
                params![transaction_id, occurrence.id],
            )?;
            posted += 1;
        }
        Ok(posted)
    }

    pub fn list_due_occurrences(
        &self,
        through: &str,
    ) -> Result<Vec<RecurringOccurrenceRecord>, AppError> {
        self.sync_due_occurrences(through)?;
        let mut statement = self.conn.prepare(
            "SELECT
                o.id,
                o.rule_id,
                r.name,
                o.due_on,
                o.transaction_id,
                o.status,
                r.kind,
                r.amount_cents,
                a.name,
                o.created_at
             FROM recurring_occurrences o
             JOIN recurring_rules r ON r.id = o.rule_id
             JOIN accounts a ON a.id = r.account_id
             WHERE o.status = 'pending' AND o.due_on <= ?1
             ORDER BY o.due_on ASC, o.id ASC",
        )?;

        let rows = statement.query_map(params![through], |row| {
            let status: String = row.get(5)?;
            let kind: String = row.get(6)?;
            Ok(RecurringOccurrenceRecord {
                id: row.get(0)?,
                rule_id: row.get(1)?,
                rule_name: row.get(2)?,
                due_on: row.get(3)?,
                transaction_id: row.get(4)?,
                status: OccurrenceStatus::from_db(&status).map_err(map_db_error)?,
                kind: TransactionKind::from_db(&kind).map_err(map_db_error)?,
                amount_cents: row.get(7)?,
                account_name: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    #[allow(dead_code)]

    pub(super) fn resolve_recurring_rule_input(
        &self,
        rule: &NewRecurringRule,
    ) -> Result<ResolvedRecurringRule, AppError> {
        let account_id = self.resolve_account_ref(&rule.account)?;
        let to_account_id = match rule.to_account.as_deref() {
            Some(reference) => Some(self.resolve_account_ref(reference)?),
            None => None,
        };
        let category_id = match rule.category.as_deref() {
            Some(reference) => match expected_category_kind(rule.kind).as_ref() {
                Some(expected_kind) => {
                    Some(self.resolve_category_ref(reference, Some(expected_kind))?)
                }
                None => Some(self.resolve_category_ref(reference, None)?),
            },
            None => None,
        };

        let start_on = parse_date(&rule.start_on)?;
        let next_due_on = self.resolve_recurring_next_due_on(
            start_on,
            rule.cadence,
            rule.interval,
            rule.day_of_month,
            rule.weekday,
            rule.next_due_on.as_deref(),
            start_on,
        )?;

        let resolved = ResolvedRecurringRule {
            name: normalize_name("recurring rule", &rule.name)?,
            kind: rule.kind,
            amount_cents: rule.amount_cents,
            account_id,
            to_account_id,
            category_id,
            payee: normalize_optional_text(&rule.payee),
            note: normalize_optional_text(&rule.note),
            cadence: rule.cadence,
            interval: rule.interval,
            day_of_month: rule.day_of_month,
            weekday: rule.weekday,
            start_on: rule.start_on.clone(),
            end_on: rule.end_on.clone(),
            next_due_on,
        };
        self.validate_resolved_recurring_rule(&resolved)?;
        Ok(resolved)
    }

    pub(super) fn validate_resolved_recurring_rule(
        &self,
        rule: &ResolvedRecurringRule,
    ) -> Result<(), AppError> {
        self.validate_resolved_transaction(&ResolvedTransaction {
            txn_date: rule.start_on.clone(),
            kind: rule.kind,
            amount_cents: rule.amount_cents,
            account_id: rule.account_id,
            to_account_id: rule.to_account_id,
            category_id: rule.category_id,
            payee: rule.payee.clone(),
            note: rule.note.clone(),
            recurring_rule_id: None,
        })?;

        if rule.interval <= 0 {
            return Err(AppError::Validation(
                "recurring interval must be positive".to_string(),
            ));
        }

        match rule.cadence {
            RecurringCadence::Weekly => {
                if rule.weekday.is_none() || rule.day_of_month.is_some() {
                    return Err(AppError::Validation(
                        "weekly recurring rules require --weekday and forbid --day-of-month"
                            .to_string(),
                    ));
                }
            }
            RecurringCadence::Monthly => {
                match rule.day_of_month {
                    Some(day) if (1..=28).contains(&day) && rule.weekday.is_none() => {}
                    _ => {
                        return Err(AppError::Validation(
                            "monthly recurring rules require --day-of-month between 1 and 28 and forbid --weekday"
                                .to_string(),
                        ))
                    }
                }
            }
        }

        let start_on = parse_date(&rule.start_on)?;
        let next_due_on = parse_date(&rule.next_due_on)?;
        if let Some(end_on) = rule.end_on.as_deref() {
            let end = parse_date(end_on)?;
            if end < start_on {
                return Err(AppError::Validation(
                    "recurring rule end date cannot be earlier than the start date".to_string(),
                ));
            }
            if next_due_on > end {
                return Err(AppError::Validation(
                    "next due date cannot be later than the recurring end date".to_string(),
                ));
            }
        }
        if next_due_on < start_on {
            return Err(AppError::Validation(
                "next due date cannot be earlier than the recurring start date".to_string(),
            ));
        }
        Ok(())
    }

    pub(super) fn insert_recurring_rule(
        &self,
        rule: &ResolvedRecurringRule,
    ) -> Result<i64, AppError> {
        let timestamp = now_timestamp();
        match self.conn.execute(
            "INSERT INTO recurring_rules (
                name,
                kind,
                amount_cents,
                account_id,
                to_account_id,
                category_id,
                payee,
                note,
                cadence,
                interval,
                day_of_month,
                weekday,
                start_on,
                end_on,
                next_due_on,
                paused,
                created_at,
                updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, ?16, ?17)",
            params![
                rule.name,
                rule.kind.as_db_str(),
                rule.amount_cents,
                rule.account_id,
                rule.to_account_id,
                rule.category_id,
                normalize_optional_text(&rule.payee),
                normalize_optional_text(&rule.note),
                rule.cadence.as_db_str(),
                rule.interval,
                rule.day_of_month.map(|value| value as i64),
                rule.weekday.map(|value| value.as_db_str().to_string()),
                rule.start_on,
                rule.end_on,
                rule.next_due_on,
                timestamp,
                timestamp,
            ],
        ) {
            Ok(_) => Ok(self.conn.last_insert_rowid()),
            Err(error) if is_unique_constraint(&error) => {
                Err(AppError::duplicate(EntityKind::RecurringRule, &rule.name))
            }
            Err(error) => Err(error.into()),
        }
    }

    pub(super) fn load_recurring_rule(&self, id: i64) -> Result<StoredRecurringRule, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT
                id,
                name,
                kind,
                amount_cents,
                account_id,
                to_account_id,
                category_id,
                payee,
                note,
                cadence,
                interval,
                day_of_month,
                weekday,
                start_on,
                end_on,
                next_due_on,
                paused,
                created_at,
                updated_at
             FROM recurring_rules
             WHERE id = ?1",
        )?;
        statement
            .query_row(params![id], |row| {
                let kind: String = row.get(2)?;
                let cadence: String = row.get(9)?;
                let weekday: Option<String> = row.get(12)?;
                Ok(StoredRecurringRule {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    kind: TransactionKind::from_db(&kind).map_err(map_db_error)?,
                    amount_cents: row.get(3)?,
                    account_id: row.get(4)?,
                    to_account_id: row.get(5)?,
                    category_id: row.get(6)?,
                    payee: row.get(7)?,
                    note: row.get(8)?,
                    cadence: RecurringCadence::from_db(&cadence).map_err(map_db_error)?,
                    interval: row.get(10)?,
                    day_of_month: row.get::<_, Option<i64>>(11)?.map(|value| value as u32),
                    weekday: match weekday {
                        Some(value) => Some(Weekday::from_db(&value).map_err(map_db_error)?),
                        None => None,
                    },
                    start_on: row.get(13)?,
                    end_on: row.get(14)?,
                    next_due_on: row.get(15)?,
                    paused: row.get::<_, i64>(16)? == 1,
                    created_at: row.get(17)?,
                    updated_at: row.get(18)?,
                })
            })
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("recurring rule `{id}` was not found")))
    }

    pub(super) fn compute_rule_next_due_after_edit(
        &self,
        rule_id: i64,
        start_on: &str,
        cadence: RecurringCadence,
        interval: i64,
        day_of_month: Option<u32>,
        weekday: Option<Weekday>,
    ) -> Result<String, AppError> {
        let start_date = parse_date(start_on)?;
        let last_posted_due: Option<String> = self.conn.query_row(
            "SELECT MAX(due_on) FROM recurring_occurrences WHERE rule_id = ?1 AND status = 'posted'",
            params![rule_id],
            |row| row.get(0),
        )?;
        let anchor = match last_posted_due {
            Some(value) => parse_date(&value)? + Duration::days(1),
            None => start_date,
        };
        compute_next_due_on_or_after(start_date, cadence, interval, day_of_month, weekday, anchor)
            .map(|date| date.format("%Y-%m-%d").to_string())
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn resolve_recurring_next_due_on(
        &self,
        start_on: NaiveDate,
        cadence: RecurringCadence,
        interval: i64,
        day_of_month: Option<u32>,
        weekday: Option<Weekday>,
        requested_next_due_on: Option<&str>,
        anchor: NaiveDate,
    ) -> Result<String, AppError> {
        let minimum_due_on = compute_next_due_on_or_after(
            start_on,
            cadence,
            interval,
            day_of_month,
            weekday,
            anchor,
        )?;
        let Some(raw_requested) = requested_next_due_on else {
            return Ok(minimum_due_on.format("%Y-%m-%d").to_string());
        };
        let requested_due_on = parse_date(raw_requested)?;
        if requested_due_on < minimum_due_on {
            return Err(AppError::Validation(format!(
                "next due date cannot be earlier than {}",
                minimum_due_on.format("%Y-%m-%d")
            )));
        }
        let aligned_due_on = compute_next_due_on_or_after(
            start_on,
            cadence,
            interval,
            day_of_month,
            weekday,
            requested_due_on,
        )?;
        if aligned_due_on != requested_due_on {
            return Err(AppError::Validation(
                "next due date must match the recurring schedule".to_string(),
            ));
        }
        Ok(requested_due_on.format("%Y-%m-%d").to_string())
    }

    pub(super) fn update_recurring_pause_state(
        &self,
        id: i64,
        paused: bool,
    ) -> Result<(), AppError> {
        let rule = self.load_recurring_rule(id)?;
        let today = Local::now().date_naive();
        let start_date = parse_date(&rule.start_on)?;
        let current_next_due = parse_date(&rule.next_due_on)?;

        let new_next_due_on = if !paused {
            let anchor = std::cmp::max(today, current_next_due);
            let next_date = compute_next_due_on_or_after(
                start_date,
                rule.cadence,
                rule.interval,
                rule.day_of_month,
                rule.weekday,
                anchor,
            )?;
            next_date.format("%Y-%m-%d").to_string()
        } else {
            rule.next_due_on
        };

        let changed = self.conn.execute(
            "UPDATE recurring_rules SET paused = ?1, next_due_on = ?2, updated_at = ?3 WHERE id = ?4",
            params![
                if paused { 1_i64 } else { 0_i64 },
                new_next_due_on,
                now_timestamp(),
                id
            ],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!(
                "recurring rule `{id}` was not found"
            )));
        }

        if paused {
            self.conn.execute(
                "DELETE FROM recurring_occurrences WHERE rule_id = ?1 AND status = 'pending'",
                params![id],
            )?;
        } else {
            self.conn.execute(
                "DELETE FROM recurring_occurrences WHERE rule_id = ?1 AND status = 'pending' AND due_on < ?2",
                params![id, new_next_due_on],
            )?;
        }

        Ok(())
    }

    pub(super) fn sync_due_occurrences(&self, through: &str) -> Result<(), AppError> {
        let through_date = parse_date(through)?;
        let mut statement = self
            .conn
            .prepare("SELECT id FROM recurring_rules WHERE paused = 0 ORDER BY id ASC")?;
        let ids = statement
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        for id in ids {
            let rule = self.load_recurring_rule(id)?;
            let mut due_on = parse_date(&rule.next_due_on)?;
            let end_on = rule.end_on.as_deref().map(parse_date).transpose()?;
            let mut changed = false;
            while due_on <= through_date {
                if let Some(limit) = end_on {
                    if due_on > limit {
                        break;
                    }
                }
                self.conn.execute(
                    "INSERT OR IGNORE INTO recurring_occurrences (rule_id, due_on, transaction_id, status, created_at)
                     VALUES (?1, ?2, NULL, 'pending', ?3)",
                    params![rule.id, due_on.format("%Y-%m-%d").to_string(), now_timestamp()],
                )?;
                due_on = advance_recurrence(
                    due_on,
                    rule.cadence,
                    rule.interval,
                    rule.day_of_month,
                    rule.weekday,
                )?;
                changed = true;
            }

            if changed {
                self.conn.execute(
                    "UPDATE recurring_rules SET next_due_on = ?1, updated_at = ?2 WHERE id = ?3",
                    params![
                        due_on.format("%Y-%m-%d").to_string(),
                        now_timestamp(),
                        rule.id
                    ],
                )?;
            }
        }

        Ok(())
    }
}
