use super::*;

pub(super) fn import_rows_are_duplicates(
    left: &ResolvedTransaction,
    right: &ResolvedTransaction,
) -> bool {
    left.txn_date == right.txn_date
        && left.kind == right.kind
        && left.amount_cents == right.amount_cents
        && left.account_id == right.account_id
        && left.to_account_id == right.to_account_id
        && left.category_id == right.category_id
        && normalize_optional_text(&left.payee) == normalize_optional_text(&right.payee)
        && normalize_optional_text(&left.note) == normalize_optional_text(&right.note)
}

pub(super) fn fuzzy_matches_transaction(record: &TransactionRecord, query: &str) -> bool {
    let haystacks: Vec<String> = vec![
        record.payee.clone().unwrap_or_default(),
        record.note.clone().unwrap_or_default(),
        record.account_name.clone(),
        record.to_account_name.clone().unwrap_or_default(),
        record.category_name.clone().unwrap_or_default(),
        record.kind.as_db_str().to_string(),
        record.txn_date.clone(),
        record.amount_cents.to_string(),
        (record.amount_cents as f64 / 100.0).to_string(),
    ];
    haystacks
        .iter()
        .any(|haystack| fuzzy_matches_text(haystack, query))
}

pub(super) fn fuzzy_matches_text(haystack: &str, query: &str) -> bool {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return true;
    }
    let h = haystack.to_lowercase();
    if h.is_empty() {
        return false;
    }
    // Fast exact substring check first (covers exact search).
    if h.contains(&q) {
        return true;
    }
    // Fuzzy per-token: split haystack into tokens, allow edit distance.
    let tokens: Vec<&str> = h
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    // Also try whole haystack as substring fuzzy if query > 3 chars.
    tokens
        .iter()
        .chain(std::iter::once(&h.as_str()))
        .any(|token| token.len() >= 2 && fuzzy_contains(token, &q))
}

pub(super) fn fuzzy_contains(hay: &str, needle: &str) -> bool {
    // needle is already lowercased
    if hay.contains(needle) {
        return true;
    }
    // Subsequence / approximate substring: allow up to 40% edits relative to needle length, at least 1, at most 3.
    // Also allow subsequence match (characters in order).
    if is_subsequence(hay, needle) {
        return true;
    }
    let needle_chars: Vec<char> = needle.chars().collect();
    let hay_chars: Vec<char> = hay.chars().collect();
    let max_dist = ((needle_chars.len() as f64 * 0.4).round() as usize).clamp(1, 3);
    // Use character offsets, never byte offsets: transaction text may be Unicode.
    let nlen = needle_chars.len();
    let hlen = hay_chars.len();
    if nlen > hlen + max_dist {
        return false;
    }
    for window_len in [nlen.saturating_sub(1), nlen, nlen.saturating_add(1)] {
        if window_len == 0 || window_len > hlen {
            continue;
        }
        for window in hay_chars.windows(window_len) {
            if levenshtein(window, &needle_chars) <= max_dist {
                return true;
            }
        }
    }
    false
}

pub(super) fn is_subsequence(hay: &str, needle: &str) -> bool {
    // True if all chars of needle appear in hay in order (allowing gaps), but only for short needles.
    let needle_len = needle.chars().count();
    if needle_len < 3 || needle_len > 10 {
        return false;
    }
    let mut hay_chars = hay.chars();
    for nc in needle.chars() {
        loop {
            match hay_chars.next() {
                Some(hc) if hc == nc => break,
                Some(_) => continue,
                None => return false,
            }
        }
    }
    true
}

pub(super) fn levenshtein(a: &[char], b: &[char]) -> usize {
    let (n, m) = (a.len(), b.len());
    if n == 0 {
        return m;
    }
    if m == 0 {
        return n;
    }
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut cur = vec![0; m + 1];
    for i in 1..=n {
        cur[0] = i;
        for j in 1..=m {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[m]
}

pub(super) fn map_transaction_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TransactionRecord> {
    let kind: String = row.get(2)?;
    Ok(TransactionRecord {
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
        account_name: row.get(10)?,
        account_currency_code: row.get(11)?,
        to_account_id: row.get(12)?,
        to_account_name: row.get(13)?,
        to_account_currency_code: row.get(14)?,
        category_id: row.get(15)?,
        category_name: row.get(16)?,
        payee: row.get(17)?,
        note: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
        deleted_at: row.get(21)?,
        reconciliation_id: row.get(22)?,
        recurring_rule_id: row.get(23)?,
    })
}

pub(super) fn normalize_month_key(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    let mut parts = trimmed.split('-');
    let year = parts
        .next()
        .ok_or_else(|| AppError::Validation("month must use YYYY-MM format".to_string()))?
        .parse::<i32>()
        .map_err(|_| AppError::Validation("month must use YYYY-MM format".to_string()))?;
    let month = parts
        .next()
        .ok_or_else(|| AppError::Validation("month must use YYYY-MM format".to_string()))?
        .parse::<u32>()
        .map_err(|_| AppError::Validation("month must use YYYY-MM format".to_string()))?;
    if parts.next().is_some() || NaiveDate::from_ymd_opt(year, month, 1).is_none() {
        return Err(AppError::Validation(
            "month must use a real calendar month in YYYY-MM format".to_string(),
        ));
    }
    Ok(format!("{year:04}-{month:02}"))
}

pub(super) fn month_bounds(month: &str) -> Result<(String, String), AppError> {
    let month = normalize_month_key(month)?;
    let mut parts = month.split('-');
    let year = parts.next().unwrap().parse::<i32>().unwrap();
    let month_num = parts.next().unwrap().parse::<u32>().unwrap();
    let first = NaiveDate::from_ymd_opt(year, month_num, 1).ok_or_else(|| {
        AppError::Validation("month must use a real calendar month in YYYY-MM format".to_string())
    })?;
    let next_month = if month_num == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month_num + 1, 1)
    }
    .ok_or_else(|| {
        AppError::Validation("month must use a real calendar month in YYYY-MM format".to_string())
    })?;
    let last = next_month.pred_opt().ok_or_else(|| {
        AppError::Validation("month must use a real calendar month in YYYY-MM format".to_string())
    })?;
    Ok((
        first.format("%Y-%m-%d").to_string(),
        last.format("%Y-%m-%d").to_string(),
    ))
}

pub(super) fn normalize_currency_code(currency: &str) -> Result<String, AppError> {
    let normalized = currency.trim().to_ascii_uppercase();
    let is_valid = normalized.len() == 3 && normalized.chars().all(|ch| ch.is_ascii_uppercase());
    if !is_valid {
        return Err(AppError::Validation(
            "currency must be a 3-letter uppercase code such as USD".to_string(),
        ));
    }
    Ok(normalized)
}

pub(super) fn normalize_name(entity: &str, value: &str) -> Result<String, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(format!(
            "{entity} name cannot be empty"
        )));
    }
    Ok(trimmed.to_string())
}

pub(super) fn normalize_optional_text(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn resolve_optional_patch(
    existing: Option<String>,
    replacement: &Option<String>,
    clear: bool,
) -> Option<String> {
    if clear {
        None
    } else {
        normalize_optional_text(replacement).or(existing)
    }
}

pub(super) fn normalize_date_value(raw: &str) -> Result<String, AppError> {
    Ok(parse_date(raw.trim())?.format("%Y-%m-%d").to_string())
}

// Display flows use the selected account's native currency, or reporting currency
// for the consolidated cash-flow projection. Account deltas always remain native.
pub(super) fn build_forecast_transaction_event(
    kind: TransactionKind,
    amount_cents: i64,
    fx: &TransactionFxInput,
    account_id: i64,
    to_account_id: Option<i64>,
    selected_account_id: Option<i64>,
) -> ForecastEvent {
    let source_amount = match selected_account_id {
        None => fx.reporting_amount_cents,
        Some(id) if id == account_id => amount_cents,
        Some(_) => 0,
    };
    match kind {
        TransactionKind::Income => ForecastEvent {
            inflow_cents: source_amount,
            outflow_cents: 0,
            per_account_delta: vec![(account_id, amount_cents)],
        },
        TransactionKind::Expense => ForecastEvent {
            inflow_cents: 0,
            outflow_cents: source_amount,
            per_account_delta: vec![(account_id, -amount_cents)],
        },
        TransactionKind::Transfer => {
            let target_id = to_account_id.expect("transfer requires a target account");
            let target_amount = fx
                .to_amount_cents
                .expect("transfer requires a destination amount");
            let inflow_cents = match selected_account_id {
                None => fx.reporting_amount_cents,
                Some(id) if id == target_id => target_amount,
                Some(_) => 0,
            };
            // Internal transfers move native balances but do not create or consume
            // reporting-currency cash in the consolidated cash-flow projection.
            ForecastEvent {
                inflow_cents,
                outflow_cents: source_amount,
                per_account_delta: vec![(account_id, -amount_cents), (target_id, target_amount)],
            }
        }
    }
}

pub(super) fn initialize_forecast_months(
    start_month: NaiveDate,
) -> Result<Vec<ForecastMonthlyPoint>, AppError> {
    let mut points = Vec::with_capacity(12);
    for step in 0..12 {
        let month = add_months_with_day(start_month, step, 1)?;
        points.push(ForecastMonthlyPoint {
            month: month.format("%Y-%m").to_string(),
            inflow_cents: 0,
            outflow_cents: 0,
            net_cents: 0,
            ending_balance_cents: 0,
        });
    }
    Ok(points)
}

pub(super) fn build_goal_status_records(
    goals: &[PlanningGoalRecord],
    initial_balances: &HashMap<i64, i64>,
    balance_history: &HashMap<i64, Vec<(NaiveDate, i64)>>,
    forecast_end: NaiveDate,
    goal_breach_dates: &HashMap<i64, String>,
) -> Result<Vec<GoalStatusRecord>, AppError> {
    let today = Local::now().date_naive();
    let mut rows = Vec::with_capacity(goals.len());
    for goal in goals {
        let current_balance_cents = *initial_balances.get(&goal.account_id).unwrap_or(&0);
        let history = balance_history.get(&goal.account_id);
        let projected_balance_cents = match (goal.kind, goal.due_on.as_deref()) {
            (PlanningGoalKind::SinkingFund, Some(due_on)) => {
                let due_on = parse_date(due_on)?;
                balance_on_or_before(history, due_on, current_balance_cents)
            }
            _ => balance_on_or_before(history, forecast_end, current_balance_cents),
        };
        let (remaining_cents, suggested_monthly_contribution_cents, on_track, breach_date) =
            match goal.kind {
                PlanningGoalKind::SinkingFund => {
                    let target_amount_cents = goal.target_amount_cents.unwrap_or_default();
                    let remaining_cents = (target_amount_cents - current_balance_cents).max(0);
                    let due_on = goal
                        .due_on
                        .as_deref()
                        .map(parse_date)
                        .transpose()?
                        .unwrap_or(forecast_end);
                    let months_remaining = months_until_calendar_month(today, due_on).max(1);
                    let suggested =
                        divide_round_up(remaining_cents.max(0), months_remaining as i64);
                    let on_track = projected_balance_cents >= target_amount_cents;
                    let breach_date = if on_track { None } else { goal.due_on.clone() };
                    (remaining_cents, suggested, on_track, breach_date)
                }
                PlanningGoalKind::BalanceTarget => {
                    let minimum_balance_cents = goal.minimum_balance_cents.unwrap_or_default();
                    let remaining_cents = (minimum_balance_cents - current_balance_cents).max(0);
                    let breach_date = goal_breach_dates.get(&goal.id).cloned();
                    (remaining_cents, 0, breach_date.is_none(), breach_date)
                }
            };

        rows.push(GoalStatusRecord {
            id: goal.id,
            name: goal.name.clone(),
            kind: goal.kind,
            account_id: goal.account_id,
            account_name: goal.account_name.clone(),
            target_amount_cents: goal.target_amount_cents,
            minimum_balance_cents: goal.minimum_balance_cents,
            due_on: goal.due_on.clone(),
            current_balance_cents,
            projected_balance_cents,
            remaining_cents,
            suggested_monthly_contribution_cents,
            on_track,
            breach_date,
        });
    }
    Ok(rows)
}

pub(super) fn balance_on_or_before(
    history: Option<&Vec<(NaiveDate, i64)>>,
    date: NaiveDate,
    initial_balance_cents: i64,
) -> i64 {
    let Some(history) = history else {
        return initial_balance_cents;
    };
    history
        .iter()
        .take_while(|(entry_date, _)| *entry_date <= date)
        .last()
        .map(|(_, balance)| *balance)
        .unwrap_or(initial_balance_cents)
}

pub(super) fn months_until_calendar_month(start: NaiveDate, end: NaiveDate) -> i32 {
    let start_index = start.year() * 12 + start.month0() as i32;
    let end_index = end.year() * 12 + end.month0() as i32;
    (end_index - start_index + 1).max(0)
}

pub(super) fn divide_round_up(value: i64, divisor: i64) -> i64 {
    if value <= 0 {
        0
    } else {
        (value + divisor - 1) / divisor
    }
}

pub(super) fn validate_transaction_input(
    kind: TransactionKind,
    has_to_account: bool,
    has_category: bool,
    amount_cents: i64,
) -> Result<(), AppError> {
    if amount_cents <= 0 {
        return Err(AppError::Validation("amount must be positive".to_string()));
    }

    match kind {
        TransactionKind::Income | TransactionKind::Expense => {
            if !has_category {
                return Err(AppError::Validation(
                    "income and expense transactions require a category".to_string(),
                ));
            }
            if has_to_account {
                return Err(AppError::Validation(
                    "income and expense transactions cannot include `--to-account`".to_string(),
                ));
            }
        }
        TransactionKind::Transfer => {
            if !has_to_account {
                return Err(AppError::Validation(
                    "transfer transactions require `--to-account`".to_string(),
                ));
            }
            if has_category {
                return Err(AppError::Validation(
                    "transfer transactions cannot include `--category`".to_string(),
                ));
            }
        }
    }

    Ok(())
}

pub(super) fn expected_category_kind(kind: TransactionKind) -> Option<CategoryKind> {
    match kind {
        TransactionKind::Income => Some(CategoryKind::Income),
        TransactionKind::Expense => Some(CategoryKind::Expense),
        TransactionKind::Transfer => None,
    }
}

pub(super) fn validate_category_kind(
    expected: &CategoryKind,
    actual_db_value: &str,
) -> Result<(), AppError> {
    let actual = CategoryKind::from_db(actual_db_value)?;
    if &actual != expected {
        return Err(AppError::Validation(format!(
            "category kind mismatch: expected {}, found {}",
            expected.as_db_str(),
            actual.as_db_str()
        )));
    }

    Ok(())
}
pub(super) fn transaction_effect_for_account(
    account_id: i64,
    kind: TransactionKind,
    amount_cents: i64,
    to_amount_cents: i64,
    source_account_id: i64,
    target_account_id: Option<i64>,
) -> i64 {
    match kind {
        TransactionKind::Income if source_account_id == account_id => amount_cents,
        TransactionKind::Expense if source_account_id == account_id => -amount_cents,
        TransactionKind::Transfer if source_account_id == account_id => -amount_cents,
        TransactionKind::Transfer if target_account_id == Some(account_id) => to_amount_cents,
        _ => 0,
    }
}

pub(super) fn compute_next_due_on_or_after(
    start_on: NaiveDate,
    cadence: RecurringCadence,
    interval: i64,
    day_of_month: Option<u32>,
    weekday: Option<Weekday>,
    anchor: NaiveDate,
) -> Result<NaiveDate, AppError> {
    let mut due = first_due_on(start_on, cadence, interval, day_of_month, weekday)?;
    while due < anchor {
        due = advance_recurrence(due, cadence, interval, day_of_month, weekday)?;
    }
    Ok(due)
}

pub(super) fn first_due_on(
    start_on: NaiveDate,
    cadence: RecurringCadence,
    interval: i64,
    day_of_month: Option<u32>,
    weekday: Option<Weekday>,
) -> Result<NaiveDate, AppError> {
    let _ = interval;
    match cadence {
        RecurringCadence::Weekly => {
            let target = weekday.ok_or_else(|| {
                AppError::Validation("weekly recurring rules require a weekday".to_string())
            })?;
            let mut due = start_on;
            while weekday_from_chrono(due.weekday()) != target {
                due += Duration::days(1);
            }
            Ok(due)
        }
        RecurringCadence::Monthly => {
            let day = day_of_month.ok_or_else(|| {
                AppError::Validation("monthly recurring rules require a day of month".to_string())
            })?;
            let candidate = NaiveDate::from_ymd_opt(start_on.year(), start_on.month(), day)
                .ok_or_else(|| {
                    AppError::Validation(
                        "monthly recurring rules require a day of month between 1 and 28"
                            .to_string(),
                    )
                })?;
            if candidate >= start_on {
                Ok(candidate)
            } else {
                advance_recurrence(candidate, cadence, interval, Some(day), None)
            }
        }
    }
}

pub(super) fn advance_recurrence(
    previous_due: NaiveDate,
    cadence: RecurringCadence,
    interval: i64,
    day_of_month: Option<u32>,
    _weekday: Option<Weekday>,
) -> Result<NaiveDate, AppError> {
    match cadence {
        RecurringCadence::Weekly => Ok(previous_due + Duration::days(7 * interval)),
        RecurringCadence::Monthly => {
            let day = day_of_month.ok_or_else(|| {
                AppError::Validation("monthly recurring rules require a day of month".to_string())
            })?;
            add_months_with_day(previous_due, interval as i32, day)
        }
    }
}

pub(super) fn add_months_with_day(
    date: NaiveDate,
    months_to_add: i32,
    day: u32,
) -> Result<NaiveDate, AppError> {
    let month_index = date.year() * 12 + date.month0() as i32 + months_to_add;
    let year = month_index.div_euclid(12);
    let month0 = month_index.rem_euclid(12) as u32;
    NaiveDate::from_ymd_opt(year, month0 + 1, day)
        .ok_or_else(|| AppError::Validation("invalid monthly recurring schedule".to_string()))
}

pub(super) fn weekday_from_chrono(value: ChronoWeekday) -> Weekday {
    match value {
        ChronoWeekday::Mon => Weekday::Mon,
        ChronoWeekday::Tue => Weekday::Tue,
        ChronoWeekday::Wed => Weekday::Wed,
        ChronoWeekday::Thu => Weekday::Thu,
        ChronoWeekday::Fri => Weekday::Fri,
        ChronoWeekday::Sat => Weekday::Sat,
        ChronoWeekday::Sun => Weekday::Sun,
    }
}

pub(super) fn parse_date(value: &str) -> Result<NaiveDate, AppError> {
    Ok(NaiveDate::parse_from_str(value, "%Y-%m-%d")?)
}

pub(super) fn is_unique_constraint(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(inner, _)
            if inner.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
                || inner.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
    )
}

pub(super) fn now_timestamp() -> String {
    Local::now().to_rfc3339()
}

pub(super) fn map_db_error(error: AppError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            error.to_string(),
        )),
    )
}
