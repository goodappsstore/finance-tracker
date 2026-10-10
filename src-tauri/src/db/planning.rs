use super::*;

#[derive(Clone, Debug)]
struct ScheduledForecastCommitment {
    month: String,
    category_id: i64,
    account_id: i64,
    amount: ScheduledForecastAmount,
}

#[derive(Clone, Debug)]
enum ScheduledForecastAmount {
    Reporting(i64),
    // Unposted amounts need a dated quote only when they consume a budget envelope.
    Native { cents: i64, due_on: String },
}

impl Db {
    pub fn add_planning_item(&self, item: &NewPlanningItem) -> Result<i64, AppError> {
        let resolved = self.resolve_planning_item_input(item)?;
        self.insert_planning_item(&resolved)
    }

    pub fn edit_planning_item(&self, patch: &UpdatePlanningItem) -> Result<(), AppError> {
        let existing = self.load_planning_item(patch.id)?;
        if existing.archived {
            return Err(AppError::Validation(
                "archived planning items cannot be edited".to_string(),
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
            match expected_category_kind(kind).as_ref() {
                Some(expected_kind) => {
                    Some(self.resolve_category_ref(reference, Some(expected_kind))?)
                }
                None => Some(self.resolve_category_ref(reference, None)?),
            }
        } else {
            existing.category_id
        };
        let scenario_id = if patch.clear_scenario {
            None
        } else if let Some(reference) = patch.scenario.as_deref() {
            Some(self.resolve_scenario_ref(reference)?)
        } else {
            existing.scenario_id
        };
        let resolved = ResolvedPlanningItem {
            scenario_id,
            title: patch.title.clone().unwrap_or(existing.title),
            kind,
            amount_cents: patch.amount_cents.unwrap_or(existing.amount_cents),
            account_id,
            to_account_id,
            category_id,
            due_on: patch.due_on.clone().unwrap_or(existing.due_on),
            payee: resolve_optional_patch(existing.payee, &patch.payee, patch.clear_payee),
            note: resolve_optional_patch(existing.note, &patch.note, patch.clear_note),
        };
        self.validate_resolved_planning_item(&resolved)?;

        let changed = self.conn.execute(
            "UPDATE planning_items
             SET scenario_id = ?1,
                 title = ?2,
                 kind = ?3,
                 amount_cents = ?4,
                 account_id = ?5,
                 to_account_id = ?6,
                 category_id = ?7,
                 due_on = ?8,
                 payee = ?9,
                 note = ?10,
                 updated_at = ?11
             WHERE id = ?12",
            params![
                resolved.scenario_id,
                resolved.title,
                resolved.kind.as_db_str(),
                resolved.amount_cents,
                resolved.account_id,
                resolved.to_account_id,
                resolved.category_id,
                resolved.due_on,
                normalize_optional_text(&resolved.payee),
                normalize_optional_text(&resolved.note),
                now_timestamp(),
                patch.id,
            ],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!(
                "planning item `{}` was not found",
                patch.id
            )));
        }
        Ok(())
    }

    pub fn list_planning_items(
        &self,
        scenario_ref: Option<&str>,
        from: Option<&str>,
        to: Option<&str>,
    ) -> Result<Vec<PlanningItemRecord>, AppError> {
        let scenario_id = match scenario_ref
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(reference) => Some(self.resolve_scenario_ref(reference)?),
            None => None,
        };
        let include_baseline_for_scenario = if scenario_id.is_some() { 1_i64 } else { 0_i64 };
        let from = from.map(normalize_date_value).transpose()?;
        let to = to.map(normalize_date_value).transpose()?;
        let mut statement = self.conn.prepare(
            "SELECT
                p.id,
                p.scenario_id,
                s.name,
                p.title,
                p.kind,
                p.amount_cents,
                source.id,
                source.name,
                target.id,
                target.name,
                category.id,
                category.name,
                p.due_on,
                p.payee,
                p.note,
                p.linked_transaction_id,
                p.archived,
                p.created_at,
                p.updated_at
             FROM planning_items p
             JOIN accounts source ON source.id = p.account_id
             LEFT JOIN accounts target ON target.id = p.to_account_id
             LEFT JOIN categories category ON category.id = p.category_id
             LEFT JOIN planning_scenarios s ON s.id = p.scenario_id
             WHERE p.archived = 0
               AND (p.scenario_id IS NULL OR s.archived = 0)
               AND (?1 = 0 OR p.scenario_id IS NULL OR p.scenario_id = ?2)
               AND (?3 IS NULL OR p.due_on >= ?3)
               AND (?4 IS NULL OR p.due_on <= ?4)
             ORDER BY p.due_on ASC, p.id ASC",
        )?;
        let rows = statement.query_map(
            params![
                include_baseline_for_scenario,
                scenario_id,
                from.as_deref(),
                to.as_deref(),
            ],
            |row| {
                let kind: String = row.get(4)?;
                Ok(PlanningItemRecord {
                    id: row.get(0)?,
                    scenario_id: row.get(1)?,
                    scenario_name: row.get(2)?,
                    title: row.get(3)?,
                    kind: TransactionKind::from_db(&kind).map_err(map_db_error)?,
                    amount_cents: row.get(5)?,
                    account_id: row.get(6)?,
                    account_name: row.get(7)?,
                    to_account_id: row.get(8)?,
                    to_account_name: row.get(9)?,
                    category_id: row.get(10)?,
                    category_name: row.get(11)?,
                    due_on: row.get(12)?,
                    payee: row.get(13)?,
                    note: row.get(14)?,
                    linked_transaction_id: row.get(15)?,
                    archived: row.get::<_, i64>(16)? == 1,
                    created_at: row.get(17)?,
                    updated_at: row.get(18)?,
                })
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn delete_planning_item(&self, id: i64) -> Result<(), AppError> {
        let changed = self.conn.execute(
            "UPDATE planning_items SET archived = 1, updated_at = ?1 WHERE id = ?2 AND archived = 0",
            params![now_timestamp(), id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!(
                "planning item `{id}` was not found"
            )));
        }
        Ok(())
    }

    pub fn post_planning_item(&self, id: i64) -> Result<i64, AppError> {
        self.atomic(|db| db.post_planning_item_inner(id))
    }

    fn post_planning_item_inner(&self, id: i64) -> Result<i64, AppError> {
        let item = self.load_planning_item(id)?;
        if item.archived {
            return Err(AppError::Validation(
                "archived planning items cannot be posted".to_string(),
            ));
        }
        if item.linked_transaction_id.is_some() {
            return Err(AppError::Validation(
                "planning item is already linked to a real transaction".to_string(),
            ));
        }
        if matches!(
            item.kind,
            TransactionKind::Income | TransactionKind::Expense
        ) && item.category_id.is_none()
        {
            return Err(AppError::Validation(
                "income and expense planning items need a category before they can be posted"
                    .to_string(),
            ));
        }
        let transaction = ResolvedTransaction {
            txn_date: item.due_on.clone(),
            kind: item.kind,
            amount_cents: item.amount_cents,
            account_id: item.account_id,
            to_account_id: item.to_account_id,
            category_id: item.category_id,
            payee: item.payee.clone(),
            note: item.note.clone(),
            recurring_rule_id: None,
        };
        self.validate_resolved_transaction(&transaction)?;
        let transaction_id = self.insert_transaction(&transaction)?;
        self.conn.execute(
            "UPDATE planning_items
             SET linked_transaction_id = ?1,
                 updated_at = ?2
             WHERE id = ?3",
            params![transaction_id, now_timestamp(), id],
        )?;
        Ok(transaction_id)
    }

    pub fn add_planning_scenario(&self, scenario: &NewPlanningScenario) -> Result<i64, AppError> {
        let name = scenario.name.trim();
        if name.is_empty() {
            return Err(AppError::Validation(
                "scenario name cannot be empty".to_string(),
            ));
        }
        let timestamp = now_timestamp();
        match self.conn.execute(
            "INSERT INTO planning_scenarios (name, note, archived, created_at, updated_at)
             VALUES (?1, ?2, 0, ?3, ?3)",
            params![name, normalize_optional_text(&scenario.note), timestamp],
        ) {
            Ok(_) => Ok(self.conn.last_insert_rowid()),
            Err(error) if is_unique_constraint(&error) => {
                Err(AppError::duplicate(EntityKind::Scenario, name))
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn list_planning_scenarios(&self) -> Result<Vec<PlanningScenarioRecord>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, name, note, archived, created_at, updated_at
             FROM planning_scenarios
             WHERE archived = 0
             ORDER BY name COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(PlanningScenarioRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                note: row.get(2)?,
                archived: row.get::<_, i64>(3)? == 1,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn edit_planning_scenario(&self, patch: &UpdatePlanningScenario) -> Result<(), AppError> {
        let existing = self
            .conn
            .query_row(
                "SELECT name, note FROM planning_scenarios WHERE id = ?1 AND archived = 0",
                params![patch.id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("scenario `{}` was not found", patch.id)))?;
        let name = patch
            .name
            .as_deref()
            .unwrap_or(&existing.0)
            .trim()
            .to_string();
        if name.is_empty() {
            return Err(AppError::Validation(
                "scenario name cannot be empty".to_string(),
            ));
        }
        let note = resolve_optional_patch(existing.1, &patch.note, patch.clear_note);
        let changed = self.conn.execute(
            "UPDATE planning_scenarios
             SET name = ?1,
                 note = ?2,
                 updated_at = ?3
             WHERE id = ?4",
            params![
                name,
                normalize_optional_text(&note),
                now_timestamp(),
                patch.id
            ],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!(
                "scenario `{}` was not found",
                patch.id
            )));
        }
        Ok(())
    }

    pub fn delete_planning_scenario(&self, id: i64) -> Result<(), AppError> {
        let changed = self.conn.execute(
            "UPDATE planning_scenarios
             SET archived = 1,
                 updated_at = ?1
             WHERE id = ?2 AND archived = 0",
            params![now_timestamp(), id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!("scenario `{id}` was not found")));
        }
        Ok(())
    }

    pub fn add_planning_goal(&self, goal: &NewPlanningGoal) -> Result<i64, AppError> {
        let resolved = self.resolve_planning_goal_input(goal)?;
        self.insert_planning_goal(&resolved)
    }

    pub fn list_planning_goals(&self) -> Result<Vec<PlanningGoalRecord>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT
                g.id,
                g.name,
                g.kind,
                a.id,
                a.name,
                g.target_amount_cents,
                g.minimum_balance_cents,
                g.due_on,
                g.archived,
                g.created_at,
                g.updated_at
             FROM planning_goals g
             JOIN accounts a ON a.id = g.account_id
             WHERE g.archived = 0
             ORDER BY g.name COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            let kind: String = row.get(2)?;
            Ok(PlanningGoalRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: PlanningGoalKind::from_db(&kind).map_err(map_db_error)?,
                account_id: row.get(3)?,
                account_name: row.get(4)?,
                target_amount_cents: row.get(5)?,
                minimum_balance_cents: row.get(6)?,
                due_on: row.get(7)?,
                archived: row.get::<_, i64>(8)? == 1,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn edit_planning_goal(&self, patch: &UpdatePlanningGoal) -> Result<(), AppError> {
        let existing = self.load_planning_goal(patch.id)?;
        if existing.archived {
            return Err(AppError::Validation(
                "archived goals cannot be edited".to_string(),
            ));
        }
        let kind = patch.kind.unwrap_or(existing.kind);
        let account_id = match patch.account.as_deref() {
            Some(reference) => self.resolve_account_ref(reference)?,
            None => existing.account_id,
        };
        let target_amount_cents = if patch.clear_target_amount {
            None
        } else {
            patch.target_amount_cents.or(existing.target_amount_cents)
        };
        let minimum_balance_cents = if patch.clear_minimum_balance {
            None
        } else {
            patch
                .minimum_balance_cents
                .or(existing.minimum_balance_cents)
        };
        let due_on = if patch.clear_due_on {
            None
        } else {
            patch.due_on.clone().or(existing.due_on)
        };
        let resolved = StoredPlanningGoal {
            name: patch.name.clone().unwrap_or(existing.name),
            kind,
            account_id,
            target_amount_cents,
            minimum_balance_cents,
            due_on,
            archived: false,
            created_at: existing.created_at,
            updated_at: existing.updated_at,
        };
        self.validate_planning_goal(&resolved)?;

        let changed = self.conn.execute(
            "UPDATE planning_goals
             SET name = ?1,
                 kind = ?2,
                 account_id = ?3,
                 target_amount_cents = ?4,
                 minimum_balance_cents = ?5,
                 due_on = ?6,
                 updated_at = ?7
             WHERE id = ?8",
            params![
                resolved.name,
                resolved.kind.as_db_str(),
                resolved.account_id,
                resolved.target_amount_cents,
                resolved.minimum_balance_cents,
                resolved.due_on,
                now_timestamp(),
                patch.id,
            ],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!(
                "goal `{}` was not found",
                patch.id
            )));
        }
        Ok(())
    }

    pub fn delete_planning_goal(&self, id: i64) -> Result<(), AppError> {
        let changed = self.conn.execute(
            "UPDATE planning_goals
             SET archived = 1,
                 updated_at = ?1
             WHERE id = ?2 AND archived = 0",
            params![now_timestamp(), id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!("goal `{id}` was not found")));
        }
        Ok(())
    }

    pub fn forecast(
        &self,
        scenario_ref: Option<&str>,
        account_ref: Option<&str>,
        days: usize,
    ) -> Result<ForecastSnapshot, AppError> {
        let scenario_id = self.resolve_optional_scenario_ref(scenario_ref)?;
        let account_id = match account_ref.map(str::trim).filter(|value| !value.is_empty()) {
            Some(reference) => Some(self.resolve_account_ref(reference)?),
            None => None,
        };
        let days = days.clamp(1, 365);
        let today = Local::now().date_naive();
        let daily_end = today + Duration::days((days - 1) as i64);
        let month_start = NaiveDate::from_ymd_opt(today.year(), today.month(), 1)
            .expect("current month should always be valid");
        let final_month_start = add_months_with_day(month_start, 11, 1)?;
        let monthly_end = add_months_with_day(final_month_start, 1, 1)?
            .pred_opt()
            .expect("month boundary should have a previous day");
        let overall_end = if daily_end > monthly_end {
            daily_end
        } else {
            monthly_end
        };

        let planning_items =
            self.list_planning_items_for_forecast(scenario_id, today, overall_end)?;
        let recurring_occurrences = self.list_forecast_recurring_occurrences(today, overall_end)?;
        let future_ledger_transactions = self.list_transactions(&TransactionFilters {
            from: Some((today + Duration::days(1)).format("%Y-%m-%d").to_string()),
            to: Some(overall_end.format("%Y-%m-%d").to_string()),
            account: None,
            category: None,
            kind: None,
            accounts: vec![],
            categories: vec![],
            kinds: vec![],
            search: None,
            limit: None,
            include_deleted: false,
            sort_by: None,
            sort_dir: None,
        })?;

        let mut scheduled_commitments = Vec::new();
        for transaction in &future_ledger_transactions {
            if transaction.kind != TransactionKind::Expense {
                continue;
            }
            let month = transaction.txn_date.get(..7).unwrap_or("").to_string();
            if month.is_empty() {
                continue;
            }
            let splits = self.list_transaction_splits(transaction.id)?;
            if !splits.is_empty() {
                for split in splits {
                    scheduled_commitments.push(ScheduledForecastCommitment {
                        month: month.clone(),
                        category_id: split.category_id,
                        account_id: transaction.account_id,
                        amount: ScheduledForecastAmount::Reporting(split.reporting_amount_cents),
                    });
                }
            } else if let Some(category_id) = transaction.category_id {
                scheduled_commitments.push(ScheduledForecastCommitment {
                    month,
                    category_id,
                    account_id: transaction.account_id,
                    amount: ScheduledForecastAmount::Reporting(transaction.reporting_amount_cents),
                });
            }
        }

        for item in &planning_items {
            if item.kind != TransactionKind::Expense {
                continue;
            }
            if let Some(category_id) = item.category_id {
                let month = item.due_on.get(..7).unwrap_or("").to_string();
                if month.is_empty() {
                    continue;
                }
                scheduled_commitments.push(ScheduledForecastCommitment {
                    month,
                    category_id,
                    account_id: item.account_id,
                    amount: ScheduledForecastAmount::Native {
                        cents: item.amount_cents,
                        due_on: item.due_on.clone(),
                    },
                });
            }
        }

        for occurrence in &recurring_occurrences {
            if occurrence.kind != TransactionKind::Expense {
                continue;
            }
            if let Some(category_id) = occurrence.category_id {
                let month = occurrence.due_on.get(..7).unwrap_or("").to_string();
                if month.is_empty() {
                    continue;
                }
                scheduled_commitments.push(ScheduledForecastCommitment {
                    month,
                    category_id,
                    account_id: occurrence.account_id,
                    amount: ScheduledForecastAmount::Native {
                        cents: occurrence.amount_cents,
                        due_on: occurrence.due_on.clone(),
                    },
                });
            }
        }

        let (budget_rows, mut warnings) = self.load_budget_forecast_rows(
            scenario_id,
            today,
            overall_end,
            &scheduled_commitments,
        )?;
        if account_id.is_none() {
            warnings.push("Balances start at today's reporting-currency valuation; future cash flows use saved ledger amounts or dated local rates. Internal transfers are net-zero; future FX revaluation is not projected.".to_string());
        }
        let bill_calendar = self.build_bill_calendar(
            &planning_items,
            &recurring_occurrences,
            account_id,
            today,
            daily_end,
        );
        let goals = self.list_planning_goals()?;
        let tracked_goal_accounts: HashSet<i64> =
            goals.iter().map(|goal| goal.account_id).collect();

        let balances = self.balances(None)?;
        // Consolidated cash flow starts at today's reporting valuation, then uses
        // saved ledger snapshots and dated local quotes for unposted cash flows.
        let mut scope_balance = match account_id {
            Some(id) => balances
                .iter()
                .find(|b| b.account_id == id)
                .map(|b| b.current_balance_cents)
                .unwrap_or(0),
            None => balances.iter().try_fold(0_i64, |total, balance| {
                let amount = self.reporting_value(
                    balance.current_balance_cents,
                    &balance.currency_code,
                    &today.to_string(),
                )?;
                super::budgets::budget_add(total, amount)
            })?,
        };
        let mut account_balances = balances
            .into_iter()
            .map(|balance| (balance.account_id, balance.current_balance_cents))
            .collect::<HashMap<_, _>>();
        let initial_balances = account_balances.clone();
        let mut balance_history: HashMap<i64, Vec<(NaiveDate, i64)>> = tracked_goal_accounts
            .iter()
            .map(|account_id| (*account_id, Vec::new()))
            .collect();

        let mut events_by_date: BTreeMap<NaiveDate, Vec<ForecastEvent>> = BTreeMap::new();
        for transaction in &future_ledger_transactions {
            let to_amount_cents = match transaction.to_amount_cents {
                Some(amount) => Some(amount),
                None if transaction.kind == TransactionKind::Transfer => {
                    self.forecast_transaction_fx(
                        transaction.amount_cents,
                        transaction.account_id,
                        transaction.to_account_id,
                        &transaction.txn_date,
                        false,
                    )?
                    .to_amount_cents
                }
                None => None,
            };
            events_by_date
                .entry(parse_date(&transaction.txn_date)?)
                .or_default()
                .push(build_forecast_transaction_event(
                    transaction.kind,
                    transaction.amount_cents,
                    &TransactionFxInput {
                        to_amount_cents,
                        reporting_amount_cents: transaction.reporting_amount_cents,
                        exchange_rate: None,
                        exchange_rate_source: None,
                        exchange_rate_date: None,
                    },
                    transaction.account_id,
                    transaction.to_account_id,
                    account_id,
                ));
        }
        for item in &planning_items {
            events_by_date
                .entry(parse_date(&item.due_on)?)
                .or_default()
                .push(build_forecast_transaction_event(
                    item.kind,
                    item.amount_cents,
                    &self.forecast_transaction_fx(
                        item.amount_cents,
                        item.account_id,
                        item.to_account_id,
                        &item.due_on,
                        account_id.is_none(),
                    )?,
                    item.account_id,
                    item.to_account_id,
                    account_id,
                ));
        }
        for occurrence in &recurring_occurrences {
            events_by_date
                .entry(parse_date(&occurrence.due_on)?)
                .or_default()
                .push(build_forecast_transaction_event(
                    occurrence.kind,
                    occurrence.amount_cents,
                    &self.forecast_transaction_fx(
                        occurrence.amount_cents,
                        occurrence.account_id,
                        occurrence.to_account_id,
                        &occurrence.due_on,
                        account_id.is_none(),
                    )?,
                    occurrence.account_id,
                    occurrence.to_account_id,
                    account_id,
                ));
        }
        self.schedule_budget_forecast_events(
            &budget_rows,
            today,
            overall_end,
            account_id,
            &mut warnings,
            &mut events_by_date,
        )?;

        let mut monthly = initialize_forecast_months(month_start)?;
        let mut daily = Vec::with_capacity(days);
        let mut first_negative_date = None;
        let mut goal_breach_dates: HashMap<i64, String> = HashMap::new();

        let mut cursor = today;
        while cursor <= overall_end {
            let opening_balance = scope_balance;
            let mut inflow_cents = 0_i64;
            let mut outflow_cents = 0_i64;
            if let Some(events) = events_by_date.get(&cursor) {
                for event in events {
                    inflow_cents += event.inflow_cents;
                    outflow_cents += event.outflow_cents;
                    for (event_account_id, delta_cents) in &event.per_account_delta {
                        *account_balances.entry(*event_account_id).or_insert(0) += *delta_cents;
                    }
                }
            }
            scope_balance = super::budgets::budget_add(
                super::budgets::budget_add(scope_balance, inflow_cents)?,
                -outflow_cents,
            )?;
            let closing_balance = scope_balance;
            let month_key = cursor.format("%Y-%m").to_string();
            if let Some(point) = monthly.iter_mut().find(|point| point.month == month_key) {
                point.inflow_cents += inflow_cents;
                point.outflow_cents += outflow_cents;
                point.net_cents = point.inflow_cents - point.outflow_cents;
                point.ending_balance_cents = closing_balance;
            }

            for tracked_account_id in &tracked_goal_accounts {
                let balance = *account_balances.get(tracked_account_id).unwrap_or(&0);
                balance_history
                    .entry(*tracked_account_id)
                    .or_default()
                    .push((cursor, balance));
            }

            let mut point_alerts = Vec::new();
            if closing_balance < 0 && first_negative_date.is_none() {
                let date = cursor.format("%Y-%m-%d").to_string();
                first_negative_date = Some(date.clone());
                point_alerts.push(format!("Projected balance turns negative on {date}."));
            }
            for goal in &goals {
                if goal.kind != PlanningGoalKind::BalanceTarget {
                    continue;
                }
                let Some(minimum_balance_cents) = goal.minimum_balance_cents else {
                    continue;
                };
                let goal_balance = *account_balances.get(&goal.account_id).unwrap_or(&0);
                if goal_balance < minimum_balance_cents && !goal_breach_dates.contains_key(&goal.id)
                {
                    let date = cursor.format("%Y-%m-%d").to_string();
                    goal_breach_dates.insert(goal.id, date.clone());
                    point_alerts.push(format!(
                        "{} falls below its balance target on {}.",
                        goal.name, date
                    ));
                }
            }

            if cursor <= daily_end {
                daily.push(ForecastDailyPoint {
                    date: cursor.format("%Y-%m-%d").to_string(),
                    opening_balance_cents: opening_balance,
                    inflow_cents,
                    outflow_cents,
                    net_cents: inflow_cents - outflow_cents,
                    closing_balance_cents: closing_balance,
                    alerts: point_alerts,
                });
            }

            cursor += Duration::days(1);
        }

        let mut alerts = Vec::new();
        if let Some(date) = first_negative_date {
            alerts.push(format!("Projected balance turns negative on {date}."));
        }
        if let Some((goal_id, date)) = goal_breach_dates
            .iter()
            .min_by(|left, right| left.1.cmp(right.1))
        {
            if let Some(goal) = goals.iter().find(|goal| goal.id == *goal_id) {
                alerts.push(format!(
                    "{} falls below its minimum balance on {}.",
                    goal.name, date
                ));
            }
        }

        let goal_status = build_goal_status_records(
            &goals,
            &initial_balances,
            &balance_history,
            overall_end,
            &goal_breach_dates,
        )?;

        Ok(ForecastSnapshot {
            scenario: self.forecast_scenario_selection(scenario_id)?,
            as_of: today.format("%Y-%m-%d").to_string(),
            account: self.forecast_account_selection(account_id)?,
            warnings,
            alerts,
            daily,
            monthly,
            goal_status,
            bill_calendar,
        })
    }

    fn forecast_transaction_fx(
        &self,
        amount: i64,
        source_id: i64,
        target_id: Option<i64>,
        date: &str,
        reporting: bool,
    ) -> Result<TransactionFxInput, AppError> {
        let source = self.account_currency(source_id)?;
        let to_amount_cents = target_id
            .map(|id| {
                let target = self.account_currency(id)?;
                if source == target {
                    Ok(amount)
                } else {
                    let quote = self.local_fx_quote(&source, &target, date)?;
                    crate::amount::convert_cents_at_rate(amount, &quote.rate)
                }
            })
            .transpose()?;
        Ok(TransactionFxInput {
            to_amount_cents,
            reporting_amount_cents: if reporting {
                self.reporting_value(amount, &source, date)?
            } else {
                0
            },
            exchange_rate: None,
            exchange_rate_source: None,
            exchange_rate_date: None,
        })
    }

    pub(super) fn resolve_planning_item_input(
        &self,
        item: &NewPlanningItem,
    ) -> Result<ResolvedPlanningItem, AppError> {
        let scenario_id = self.resolve_optional_scenario_ref(item.scenario.as_deref())?;
        let account_id = self.resolve_account_ref(&item.account)?;
        let to_account_id = match item.to_account.as_deref() {
            Some(reference) => Some(self.resolve_account_ref(reference)?),
            None => None,
        };
        let category_id = match item.category.as_deref() {
            Some(reference) => match expected_category_kind(item.kind).as_ref() {
                Some(expected_kind) => {
                    Some(self.resolve_category_ref(reference, Some(expected_kind))?)
                }
                None => Some(self.resolve_category_ref(reference, None)?),
            },
            None => None,
        };
        let resolved = ResolvedPlanningItem {
            scenario_id,
            title: item.title.trim().to_string(),
            kind: item.kind,
            amount_cents: item.amount_cents,
            account_id,
            to_account_id,
            category_id,
            due_on: item.due_on.clone(),
            payee: item.payee.clone(),
            note: item.note.clone(),
        };
        self.validate_resolved_planning_item(&resolved)?;
        Ok(resolved)
    }

    pub(super) fn validate_resolved_planning_item(
        &self,
        item: &ResolvedPlanningItem,
    ) -> Result<(), AppError> {
        if item.title.trim().is_empty() {
            return Err(AppError::Validation(
                "planning item title cannot be empty".to_string(),
            ));
        }
        parse_date(&item.due_on)?;
        if item.amount_cents <= 0 {
            return Err(AppError::Validation(
                "planning item amount must be positive".to_string(),
            ));
        }
        let account_exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM accounts WHERE id = ?1 AND archived = 0",
            params![item.account_id],
            |row| row.get(0),
        )?;
        if account_exists == 0 {
            return Err(AppError::NotFound(format!(
                "account `{}` was not found",
                item.account_id
            )));
        }
        if let Some(target_id) = item.to_account_id {
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
        }
        if let Some(category_id) = item.category_id {
            let category_exists: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM categories WHERE id = ?1 AND archived = 0",
                params![category_id],
                |row| row.get(0),
            )?;
            if category_exists == 0 {
                return Err(AppError::NotFound(format!(
                    "category `{category_id}` was not found"
                )));
            }
        }
        if let Some(scenario_id) = item.scenario_id {
            let scenario_exists: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM planning_scenarios WHERE id = ?1 AND archived = 0",
                params![scenario_id],
                |row| row.get(0),
            )?;
            if scenario_exists == 0 {
                return Err(AppError::NotFound(format!(
                    "scenario `{scenario_id}` was not found"
                )));
            }
        }

        match item.kind {
            TransactionKind::Income | TransactionKind::Expense => {
                if item.to_account_id.is_some() {
                    return Err(AppError::Validation(
                        "income and expense planning items cannot target a second account"
                            .to_string(),
                    ));
                }
                if item.category_id.is_none() {
                    return Err(AppError::Validation(
                        "income and expense planning items require a category".to_string(),
                    ));
                }
            }
            TransactionKind::Transfer => {
                if item.to_account_id.is_none() {
                    return Err(AppError::Validation(
                        "transfer planning items require --to-account".to_string(),
                    ));
                }
                if item.category_id.is_some() {
                    return Err(AppError::Validation(
                        "transfer planning items cannot use a category".to_string(),
                    ));
                }
                if item.to_account_id == Some(item.account_id) {
                    return Err(AppError::Validation(
                        "transfer planning items must use different source and destination accounts"
                            .to_string(),
                    ));
                }
            }
        }
        Ok(())
    }

    pub(super) fn insert_planning_item(
        &self,
        item: &ResolvedPlanningItem,
    ) -> Result<i64, AppError> {
        let timestamp = now_timestamp();
        self.conn.execute(
            "INSERT INTO planning_items (
                 scenario_id,
                 title,
                 kind,
                 amount_cents,
                 account_id,
                 to_account_id,
                 category_id,
                 due_on,
                 payee,
                 note,
                 linked_transaction_id,
                 archived,
                 created_at,
                 updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, 0, ?11, ?11)",
            params![
                item.scenario_id,
                item.title,
                item.kind.as_db_str(),
                item.amount_cents,
                item.account_id,
                item.to_account_id,
                item.category_id,
                item.due_on,
                normalize_optional_text(&item.payee),
                normalize_optional_text(&item.note),
                timestamp,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub(super) fn load_planning_item(&self, id: i64) -> Result<StoredPlanningItem, AppError> {
        self.conn
            .query_row(
                "SELECT
                    id,
                    scenario_id,
                    title,
                    kind,
                    amount_cents,
                    account_id,
                    to_account_id,
                    category_id,
                    due_on,
                    payee,
                    note,
                    linked_transaction_id,
                    archived,
                    created_at,
                    updated_at
                 FROM planning_items
                 WHERE id = ?1",
                params![id],
                |row| {
                    let kind: String = row.get(3)?;
                    Ok(StoredPlanningItem {
                        scenario_id: row.get(1)?,
                        title: row.get(2)?,
                        kind: TransactionKind::from_db(&kind).map_err(map_db_error)?,
                        amount_cents: row.get(4)?,
                        account_id: row.get(5)?,
                        to_account_id: row.get(6)?,
                        category_id: row.get(7)?,
                        due_on: row.get(8)?,
                        payee: row.get(9)?,
                        note: row.get(10)?,
                        linked_transaction_id: row.get(11)?,
                        archived: row.get::<_, i64>(12)? == 1,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("planning item `{id}` was not found")))
    }

    pub(super) fn resolve_optional_scenario_ref(
        &self,
        reference: Option<&str>,
    ) -> Result<Option<i64>, AppError> {
        match reference.map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) => Ok(Some(self.resolve_scenario_ref(value)?)),
            None => Ok(None),
        }
    }

    pub(super) fn resolve_scenario_ref(&self, reference: &str) -> Result<i64, AppError> {
        let trimmed = reference.trim();
        let id_lookup = trimmed.parse::<i64>().ok();
        let scenario_id = self
            .conn
            .query_row(
                "SELECT id
                 FROM planning_scenarios
                 WHERE archived = 0
                   AND (id = ?1 OR name = ?2 COLLATE NOCASE)",
                params![id_lookup, trimmed],
                |row| row.get(0),
            )
            .optional()?;
        scenario_id.ok_or_else(|| AppError::invalid_ref(EntityKind::Scenario, trimmed))
    }

    pub(super) fn resolve_planning_goal_input(
        &self,
        goal: &NewPlanningGoal,
    ) -> Result<StoredPlanningGoal, AppError> {
        let resolved = StoredPlanningGoal {
            name: goal.name.trim().to_string(),
            kind: goal.kind,
            account_id: self.resolve_account_ref(&goal.account)?,
            target_amount_cents: goal.target_amount_cents,
            minimum_balance_cents: goal.minimum_balance_cents,
            due_on: goal.due_on.clone(),
            archived: false,
            created_at: String::new(),
            updated_at: String::new(),
        };
        self.validate_planning_goal(&resolved)?;
        Ok(resolved)
    }

    pub(super) fn validate_planning_goal(&self, goal: &StoredPlanningGoal) -> Result<(), AppError> {
        if goal.name.trim().is_empty() {
            return Err(AppError::Validation(
                "goal name cannot be empty".to_string(),
            ));
        }
        let account_exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM accounts WHERE id = ?1 AND archived = 0",
            params![goal.account_id],
            |row| row.get(0),
        )?;
        if account_exists == 0 {
            return Err(AppError::NotFound(format!(
                "account `{}` was not found",
                goal.account_id
            )));
        }
        match goal.kind {
            PlanningGoalKind::SinkingFund => {
                if goal.minimum_balance_cents.is_some() {
                    return Err(AppError::Validation(
                        "sinking fund goals cannot define a minimum balance".to_string(),
                    ));
                }
                let target_amount_cents = goal.target_amount_cents.ok_or_else(|| {
                    AppError::Validation("sinking fund goals require --target-amount".to_string())
                })?;
                if target_amount_cents <= 0 {
                    return Err(AppError::Validation(
                        "target amount must be positive".to_string(),
                    ));
                }
                let due_on = goal.due_on.as_deref().ok_or_else(|| {
                    AppError::Validation("sinking fund goals require --due-on".to_string())
                })?;
                parse_date(due_on)?;
            }
            PlanningGoalKind::BalanceTarget => {
                if goal.target_amount_cents.is_some() || goal.due_on.is_some() {
                    return Err(AppError::Validation(
                        "balance target goals only accept --minimum-balance".to_string(),
                    ));
                }
                let minimum_balance_cents = goal.minimum_balance_cents.ok_or_else(|| {
                    AppError::Validation(
                        "balance target goals require --minimum-balance".to_string(),
                    )
                })?;
                if minimum_balance_cents <= 0 {
                    return Err(AppError::Validation(
                        "minimum balance must be positive".to_string(),
                    ));
                }
            }
        }
        Ok(())
    }

    pub(super) fn insert_planning_goal(&self, goal: &StoredPlanningGoal) -> Result<i64, AppError> {
        let timestamp = now_timestamp();
        match self.conn.execute(
            "INSERT INTO planning_goals (
                 name,
                 kind,
                 account_id,
                 target_amount_cents,
                 minimum_balance_cents,
                 due_on,
                 archived,
                 created_at,
                 updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)",
            params![
                goal.name,
                goal.kind.as_db_str(),
                goal.account_id,
                goal.target_amount_cents,
                goal.minimum_balance_cents,
                goal.due_on,
                timestamp,
            ],
        ) {
            Ok(_) => Ok(self.conn.last_insert_rowid()),
            Err(error) if is_unique_constraint(&error) => {
                Err(AppError::duplicate(EntityKind::Goal, &goal.name))
            }
            Err(error) => Err(error.into()),
        }
    }

    pub(super) fn load_planning_goal(&self, id: i64) -> Result<StoredPlanningGoal, AppError> {
        self.conn
            .query_row(
                "SELECT
                    id,
                    name,
                    kind,
                    account_id,
                    target_amount_cents,
                    minimum_balance_cents,
                    due_on,
                    archived,
                    created_at,
                    updated_at
                 FROM planning_goals
                 WHERE id = ?1",
                params![id],
                |row| {
                    let kind: String = row.get(2)?;
                    Ok(StoredPlanningGoal {
                        name: row.get(1)?,
                        kind: PlanningGoalKind::from_db(&kind).map_err(map_db_error)?,
                        account_id: row.get(3)?,
                        target_amount_cents: row.get(4)?,
                        minimum_balance_cents: row.get(5)?,
                        due_on: row.get(6)?,
                        archived: row.get::<_, i64>(7)? == 1,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("goal `{id}` was not found")))
    }

    pub(super) fn forecast_scenario_selection(
        &self,
        scenario_id: Option<i64>,
    ) -> Result<ForecastSelection, AppError> {
        match scenario_id {
            Some(id) => Ok(ForecastSelection {
                id: Some(id),
                name: Some(self.scenario_name(id)?),
            }),
            None => Ok(ForecastSelection {
                id: None,
                name: Some("baseline".to_string()),
            }),
        }
    }

    pub(super) fn forecast_account_selection(
        &self,
        account_id: Option<i64>,
    ) -> Result<ForecastSelection, AppError> {
        match account_id {
            Some(id) => Ok(ForecastSelection {
                id: Some(id),
                name: Some(self.account_name(id)?),
            }),
            None => Ok(ForecastSelection {
                id: None,
                name: None,
            }),
        }
    }

    pub(super) fn scenario_name(&self, scenario_id: i64) -> Result<String, AppError> {
        self.conn
            .query_row(
                "SELECT name FROM planning_scenarios WHERE id = ?1 AND archived = 0",
                params![scenario_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("scenario `{scenario_id}` was not found")))
    }

    pub(super) fn list_planning_items_for_forecast(
        &self,
        scenario_id: Option<i64>,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<PlanningItemRecord>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT
                p.id,
                p.scenario_id,
                s.name,
                p.title,
                p.kind,
                p.amount_cents,
                source.id,
                source.name,
                target.id,
                target.name,
                category.id,
                category.name,
                p.due_on,
                p.payee,
                p.note,
                p.linked_transaction_id,
                p.archived,
                p.created_at,
                p.updated_at
             FROM planning_items p
             JOIN accounts source ON source.id = p.account_id
             LEFT JOIN accounts target ON target.id = p.to_account_id
             LEFT JOIN categories category ON category.id = p.category_id
             LEFT JOIN planning_scenarios s ON s.id = p.scenario_id
             WHERE p.archived = 0
               AND p.linked_transaction_id IS NULL
               AND (p.scenario_id IS NULL OR s.archived = 0)
               AND (
                    (?1 IS NULL AND p.scenario_id IS NULL)
                    OR
                    (?1 IS NOT NULL AND (p.scenario_id IS NULL OR p.scenario_id = ?1))
               )
               AND p.due_on >= ?2
               AND p.due_on <= ?3
             ORDER BY p.due_on ASC, p.id ASC",
        )?;
        let rows = statement.query_map(
            params![
                scenario_id,
                start.format("%Y-%m-%d").to_string(),
                end.format("%Y-%m-%d").to_string(),
            ],
            |row| {
                let kind: String = row.get(4)?;
                Ok(PlanningItemRecord {
                    id: row.get(0)?,
                    scenario_id: row.get(1)?,
                    scenario_name: row.get(2)?,
                    title: row.get(3)?,
                    kind: TransactionKind::from_db(&kind).map_err(map_db_error)?,
                    amount_cents: row.get(5)?,
                    account_id: row.get(6)?,
                    account_name: row.get(7)?,
                    to_account_id: row.get(8)?,
                    to_account_name: row.get(9)?,
                    category_id: row.get(10)?,
                    category_name: row.get(11)?,
                    due_on: row.get(12)?,
                    payee: row.get(13)?,
                    note: row.get(14)?,
                    linked_transaction_id: row.get(15)?,
                    archived: row.get::<_, i64>(16)? == 1,
                    created_at: row.get(17)?,
                    updated_at: row.get(18)?,
                })
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub(super) fn list_forecast_recurring_occurrences(
        &self,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<RecurringForecastOccurrence>, AppError> {
        let mut pending_statement = self.conn.prepare(
            "SELECT
                r.id,
                o.due_on,
                r.name,
                r.kind,
                r.amount_cents,
                source.id,
                source.name,
                r.to_account_id,
                category.name,
                r.category_id
             FROM recurring_occurrences o
             JOIN recurring_rules r ON r.id = o.rule_id
             JOIN accounts source ON source.id = r.account_id
             LEFT JOIN categories category ON category.id = r.category_id
             WHERE o.status = 'pending'
               AND r.paused = 0
               AND o.due_on >= ?1
               AND o.due_on <= ?2
             ORDER BY o.due_on ASC, o.id ASC",
        )?;
        let rows = pending_statement.query_map(
            params![
                start.format("%Y-%m-%d").to_string(),
                end.format("%Y-%m-%d").to_string(),
            ],
            |row| {
                let kind: String = row.get(3)?;
                Ok(RecurringForecastOccurrence {
                    rule_id: row.get(0)?,
                    due_on: row.get(1)?,
                    rule_name: row.get(2)?,
                    kind: TransactionKind::from_db(&kind).map_err(map_db_error)?,
                    amount_cents: row.get(4)?,
                    account_id: row.get(5)?,
                    account_name: row.get(6)?,
                    to_account_id: row.get(7)?,
                    category_id: row.get(9)?,
                    category_name: row.get(8)?,
                })
            },
        )?;
        let mut occurrences = rows.collect::<Result<Vec<_>, _>>()?;
        let materialized_keys = occurrences
            .iter()
            .map(|occurrence| (occurrence.rule_id, occurrence.due_on.clone()))
            .collect::<HashSet<_>>();

        let mut rule_statement = self.conn.prepare(
            "SELECT
                r.id,
                r.name,
                r.kind,
                r.amount_cents,
                source.id,
                source.name,
                r.to_account_id,
                category.name,
                r.cadence,
                r.interval,
                r.day_of_month,
                r.weekday,
                r.end_on,
                r.next_due_on,
                r.category_id
             FROM recurring_rules r
             JOIN accounts source ON source.id = r.account_id
             LEFT JOIN categories category ON category.id = r.category_id
             WHERE r.paused = 0
             ORDER BY r.id ASC",
        )?;
        let rules = rule_statement.query_map([], |row| {
            let kind: String = row.get(2)?;
            let cadence: String = row.get(8)?;
            let weekday: Option<String> = row.get(11)?;
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                TransactionKind::from_db(&kind).map_err(map_db_error)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<String>>(7)?,
                RecurringCadence::from_db(&cadence).map_err(map_db_error)?,
                row.get::<_, i64>(9)?,
                row.get::<_, Option<i64>>(10)?.map(|value| value as u32),
                match weekday {
                    Some(value) => Some(Weekday::from_db(&value).map_err(map_db_error)?),
                    None => None,
                },
                row.get::<_, Option<String>>(12)?,
                row.get::<_, String>(13)?,
                row.get::<_, Option<i64>>(14)?,
            ))
        })?;

        for rule in rules {
            let (
                rule_id,
                rule_name,
                kind,
                amount_cents,
                account_id,
                account_name,
                to_account_id,
                category_name,
                cadence,
                interval,
                day_of_month,
                weekday,
                end_on,
                next_due_on,
                category_id,
            ) = rule?;

            let mut due_on = parse_date(&next_due_on)?;
            let limit = end_on.as_deref().map(parse_date).transpose()?;

            while due_on < start {
                if let Some(limit) = limit {
                    if due_on > limit {
                        break;
                    }
                }
                due_on = advance_recurrence(due_on, cadence, interval, day_of_month, weekday)?;
            }

            while due_on <= end {
                if let Some(limit) = limit {
                    if due_on > limit {
                        break;
                    }
                }
                let due_on_text = due_on.format("%Y-%m-%d").to_string();
                if !materialized_keys.contains(&(rule_id, due_on_text.clone())) {
                    occurrences.push(RecurringForecastOccurrence {
                        rule_id,
                        due_on: due_on_text,
                        rule_name: rule_name.clone(),
                        kind,
                        amount_cents,
                        account_id,
                        account_name: account_name.clone(),
                        to_account_id,
                        category_id,
                        category_name: category_name.clone(),
                    });
                }
                due_on = advance_recurrence(due_on, cadence, interval, day_of_month, weekday)?;
            }
        }

        occurrences.sort_by(|left, right| {
            left.due_on
                .cmp(&right.due_on)
                .then(left.rule_id.cmp(&right.rule_id))
        });
        Ok(occurrences)
    }
    fn load_budget_forecast_rows(
        &self,
        scenario_id: Option<i64>,
        start: NaiveDate,
        end: NaiveDate,
        scheduled_commitments: &[ScheduledForecastCommitment],
    ) -> Result<(Vec<BudgetForecastRow>, Vec<String>), AppError> {
        let scenario = scenario_id.map(|id| id.to_string());
        let mut cursor = NaiveDate::from_ymd_opt(start.year(), start.month(), 1).unwrap();
        let first_month = cursor.format("%Y-%m").to_string();
        let mut rows = Vec::new();
        while cursor <= end {
            let month = cursor.format("%Y-%m").to_string();
            let as_of = if month == first_month {
                Some(start.to_string())
            } else {
                None
            };
            let status_rows =
                self.budget_status_at(&month, scenario.as_deref(), None, as_of.as_deref())?;
            for status in &status_rows {
                // The forecast spends all available carry in its first month.
                // Future allocations must not include that same carry again.
                let carry = if month == first_month {
                    status.rollover_cents
                } else {
                    0
                };
                let spent = if month == first_month {
                    status.spent_cents
                } else {
                    0
                };
                let available = super::budgets::budget_add(
                    super::budgets::budget_add(
                        super::budgets::budget_add(status.allocated_cents, status.moved_cents)?,
                        carry,
                    )?,
                    -spent,
                )?
                .max(0);
                if available == 0 {
                    continue;
                }

                let mut overlap = 0_i64;
                for c in scheduled_commitments {
                    if overlap >= available {
                        break;
                    }
                    if c.month == month && c.category_id == status.category_id {
                        let specific = status_rows.iter().any(|r| {
                            r.category_id == status.category_id
                                && r.account_id == Some(c.account_id)
                        });
                        if status.account_id == Some(c.account_id)
                            || (status.account_id.is_none() && !specific)
                        {
                            let amount = match &c.amount {
                                ScheduledForecastAmount::Reporting(cents) => *cents,
                                ScheduledForecastAmount::Native { cents, due_on } => {
                                    let currency = self.account_currency(c.account_id)?;
                                    self.reporting_value(*cents, &currency, due_on)?
                                }
                            };
                            overlap = super::budgets::budget_add(overlap, amount)?;
                        }
                    }
                }

                let amount = super::budgets::budget_add(available, -overlap)?.max(0);
                if amount > 0 {
                    rows.push(BudgetForecastRow {
                        month: month.clone(),
                        category_name: status.category_name.clone(),
                        account_id: status.account_id,
                        amount_cents: amount,
                    });
                }
            }
            cursor = add_months_with_day(cursor, 1, 1)?;
        }
        Ok((rows, Vec::new()))
    }

    pub(super) fn build_bill_calendar(
        &self,
        planning_items: &[PlanningItemRecord],
        recurring_occurrences: &[RecurringForecastOccurrence],
        account_id: Option<i64>,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Vec<BillCalendarItem> {
        let start = start.format("%Y-%m-%d").to_string();
        let end = end.format("%Y-%m-%d").to_string();
        let mut items = Vec::new();
        for item in planning_items {
            if item.kind != TransactionKind::Expense {
                continue;
            }
            if item.due_on < start || item.due_on > end {
                continue;
            }
            if account_id.is_some() && item.account_id != account_id.unwrap() {
                continue;
            }
            items.push(BillCalendarItem {
                date: item.due_on.clone(),
                title: item.title.clone(),
                source: if item.scenario_id.is_some() {
                    "planned_scenario".to_string()
                } else {
                    "planned".to_string()
                },
                source_id: Some(item.id),
                kind: item.kind,
                amount_cents: item.amount_cents,
                account_id: item.account_id,
                account_name: item.account_name.clone(),
                category_name: item.category_name.clone(),
                scenario_name: item.scenario_name.clone(),
                linked_transaction_id: item.linked_transaction_id,
            });
        }
        for occurrence in recurring_occurrences {
            if occurrence.kind != TransactionKind::Expense {
                continue;
            }
            if occurrence.due_on < start || occurrence.due_on > end {
                continue;
            }
            if account_id.is_some() && occurrence.account_id != account_id.unwrap() {
                continue;
            }
            items.push(BillCalendarItem {
                date: occurrence.due_on.clone(),
                title: occurrence.rule_name.clone(),
                source: "recurring".to_string(),
                source_id: Some(occurrence.rule_id),
                kind: occurrence.kind,
                amount_cents: occurrence.amount_cents,
                account_id: occurrence.account_id,
                account_name: occurrence.account_name.clone(),
                category_name: occurrence.category_name.clone(),
                scenario_name: None,
                linked_transaction_id: None,
            });
        }
        items.sort_by(|left, right| {
            left.date
                .cmp(&right.date)
                .then(left.title.cmp(&right.title))
        });
        items
    }

    pub(super) fn schedule_budget_forecast_events(
        &self,
        budget_rows: &[BudgetForecastRow],
        today: NaiveDate,
        end: NaiveDate,
        selected_account_id: Option<i64>,
        warnings: &mut Vec<String>,
        events_by_date: &mut BTreeMap<NaiveDate, Vec<ForecastEvent>>,
    ) -> Result<(), AppError> {
        let current_month = today.format("%Y-%m").to_string();
        let reporting_currency = self.currency_code()?;
        let has_global = budget_rows.iter().any(|row| row.account_id.is_none());
        let fallback_account_id: Option<i64> = if has_global {
            self.conn
                .query_row(
                    "SELECT id FROM accounts WHERE archived = 0 ORDER BY id ASC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?
        } else {
            None
        };
        for row in budget_rows {
            let account_id = match row.account_id {
                Some(account_id) => account_id,
                None => {
                    if let Some(selected) = selected_account_id {
                        selected
                    } else if let Some(fallback) = fallback_account_id {
                        fallback
                    } else {
                        warnings.push(format!(
                            "Budget {} in {} has no account mapping and no accounts exist.",
                            row.category_name, row.month
                        ));
                        continue;
                    }
                }
            };
            let (month_start_raw, month_end_raw) = month_bounds(&row.month)?;
            let month_start = parse_date(&month_start_raw)?;
            let month_end = parse_date(&month_end_raw)?;
            let distribution_start = if row.month == current_month {
                today
            } else {
                month_start
            };
            let distribution_end = if month_end < end { month_end } else { end };
            if distribution_start > distribution_end {
                continue;
            }
            let amount_cents = row.amount_cents;
            // Convert the whole envelope before distributing cents, avoiding daily
            // rounding drift. Divide by native→reporting so no reverse quote is needed.
            let currency = self.account_currency(account_id)?;
            let native_amount = if currency == reporting_currency {
                amount_cents
            } else {
                use rust_decimal::{prelude::ToPrimitive, Decimal, RoundingStrategy};
                let quote = self.local_fx_quote(
                    &currency,
                    &reporting_currency,
                    &distribution_start.to_string(),
                )?;
                let rate = quote
                    .rate
                    .parse::<Decimal>()
                    .map_err(|_| AppError::Validation("invalid stored exchange rate".into()))?;
                if rate <= Decimal::ZERO {
                    return Err(AppError::Validation(
                        "exchange rate must be positive".into(),
                    ));
                }
                Decimal::from(amount_cents)
                    .checked_div(rate)
                    .and_then(|v| {
                        v.round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
                            .to_i64()
                    })
                    .ok_or_else(|| {
                        AppError::Validation("Converted budget amount is too large".into())
                    })?
            };
            let day_count = (distribution_end - distribution_start).num_days() + 1;
            let base_amount = amount_cents / day_count;
            let remainder = amount_cents % day_count;
            for step in 0..day_count {
                let amount_for_day = base_amount + if step < remainder { 1 } else { 0 };
                let native_for_day = native_amount / day_count
                    + if step < native_amount % day_count {
                        1
                    } else {
                        0
                    };
                if amount_for_day == 0 && native_for_day == 0 {
                    continue;
                }
                let date = distribution_start + Duration::days(step);
                events_by_date.entry(date).or_default().push(ForecastEvent {
                    inflow_cents: 0,
                    outflow_cents: match selected_account_id {
                        None => amount_for_day,
                        Some(id) if id == account_id => native_for_day,
                        Some(_) => 0,
                    },
                    per_account_delta: vec![(account_id, -native_for_day)],
                });
            }
        }
        Ok(())
    }
}
