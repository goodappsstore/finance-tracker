mod amount;
mod backup;
mod db;
mod error;
mod fx;
mod importer;
mod model;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::Local;
use db::Db;
use error::AppError;
use model::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

struct ActiveDataOperation {
    operation_id: String,
    cancelled: Arc<AtomicBool>,
    committing: Arc<AtomicBool>,
}

struct AppState {
    db_path: Mutex<PathBuf>,
    database: Mutex<Option<(PathBuf, Db)>>,
    active_data_operation: Mutex<Option<ActiveDataOperation>>,
}

const DB_PATH_SETTINGS_FILE: &str = "database-path.txt";

fn resolve_initial_db_path() -> PathBuf {
    // An environment override is intentionally ephemeral and takes precedence
    // over the path selected in Settings, which is used otherwise.
    if std::env::var_os("FINANCE_TRACKER_DB_PATH").is_none() {
        if let Some(path) = load_persisted_db_path(&db_path_settings_file()) {
            return path;
        }
    }
    db::resolve_db_path(None).unwrap_or_else(|_| {
        let mut p = dirs_next();
        p.push("tracker.db");
        p
    })
}

fn dirs_next() -> PathBuf {
    if let Some(d) = directories::ProjectDirs::from("", "", "Finance Tracker") {
        d.data_local_dir().to_path_buf()
    } else {
        std::env::temp_dir().join("finance-tracker")
    }
}

fn db_path_settings_file() -> PathBuf {
    dirs_next().join(DB_PATH_SETTINGS_FILE)
}

fn load_persisted_db_path(settings_file: &Path) -> Option<PathBuf> {
    let path = fs::read_to_string(settings_file).ok()?;
    let path = path.trim();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

fn persist_db_path(settings_file: &Path, db_path: &Path) -> Result<(), String> {
    let parent = settings_file
        .parent()
        .ok_or_else(|| "Unable to determine where to save the database path".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create database settings directory: {error}"))?;
    fs::write(settings_file, db_path.to_string_lossy().as_bytes())
        .map_err(|error| format!("Unable to save database path: {error}"))
}

fn normalize_db_path(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    if path.as_os_str().is_empty() {
        return Err("Database path cannot be empty".into());
    }
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path))
            .map_err(|error| format!("Unable to resolve database path: {error}"))
    }
}

fn with_db<F, T>(state: &State<AppState>, f: F) -> Result<T, String>
where
    F: FnOnce(&Db) -> Result<T, error::AppError>,
{
    let path_guard = state.db_path.lock().map_err(|e| e.to_string())?;
    let path = path_guard.clone();
    let mut database = state.database.lock().map_err(|e| e.to_string())?;
    if database.as_ref().map(|(p, _)| p) != Some(&path) {
        *database = Some((
            path.clone(),
            Db::open_existing(&path).map_err(|e| e.to_string())?,
        ));
    }
    f(&database.as_ref().unwrap().1).map_err(|e| e.to_string())
}

fn parse_cents(s: &str) -> Result<i64, String> {
    amount::parse_amount_to_cents(s).map_err(|e| e.to_string())
}
fn parse_balance_cents(s: &str) -> Result<i64, String> {
    amount::parse_balance_to_cents(s).map_err(|e| e.to_string())
}
fn parse_optional_positive_cents(value: Option<&str>) -> Result<Option<i64>, String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(parse_cents)
        .transpose()
}
fn parse_optional_quantity_micros(value: Option<&str>) -> Result<Option<i64>, String> {
    use rust_decimal::prelude::ToPrimitive;
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let quantity = value
        .parse::<rust_decimal::Decimal>()
        .map_err(|_| "Quantity must be a positive decimal with at most six places".to_string())?;
    if quantity <= rust_decimal::Decimal::ZERO {
        return Err("Quantity must be positive".to_string());
    }
    let scaled = quantity * rust_decimal::Decimal::new(1_000_000, 0);
    if scaled.fract() != rust_decimal::Decimal::ZERO {
        return Err("Quantity supports at most six decimal places".to_string());
    }
    scaled
        .to_i64()
        .map(Some)
        .ok_or_else(|| "Quantity is too large".to_string())
}

// ---------- App / DB ----------
#[tauri::command]
fn get_db_path(state: State<AppState>) -> String {
    state.db_path.lock().unwrap().to_string_lossy().to_string()
}

#[tauri::command]
fn set_db_path(state: State<AppState>, path: String) -> Result<String, String> {
    let p = normalize_db_path(&path)?;
    persist_db_path(&db_path_settings_file(), &p)?;
    *state.db_path.lock().unwrap() = p.clone();
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn needs_init(state: State<AppState>) -> Result<bool, String> {
    let path = state.db_path.lock().unwrap().clone();
    db::db_requires_init(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_currency(state: State<AppState>) -> Result<String, String> {
    with_db(&state, |db| db.currency_code())
}

#[tauri::command]
fn set_currency(state: State<AppState>, currency: String) -> Result<String, String> {
    with_db(&state, |db| db.set_reporting_currency(&currency))
}

#[tauri::command]
fn get_fx_settings(state: State<AppState>) -> Result<db::fx::FxSettings, String> {
    with_db(&state, |db| db.fx_settings())
}

#[tauri::command]
fn set_fx_default_source(state: State<AppState>, source: String) -> Result<String, String> {
    with_db(&state, |db| db.set_fx_default_source(&source))
}

#[tauri::command]
fn save_manual_fx_rate(
    state: State<AppState>,
    base_currency: String,
    quote_currency: String,
    effective_on: String,
    rate: String,
) -> Result<db::fx::ManualFxRate, String> {
    with_db(&state, |db| {
        db.save_manual_fx_rate(&base_currency, &quote_currency, &effective_on, &rate)
    })
}

#[tauri::command]
fn list_manual_fx_rates(state: State<AppState>) -> Result<Vec<db::fx::ManualFxRate>, String> {
    with_db(&state, |db| db.list_manual_fx_rates())
}

#[tauri::command]
fn delete_manual_fx_rate(
    state: State<AppState>,
    base_currency: String,
    quote_currency: String,
    effective_on: String,
) -> Result<(), String> {
    with_db(&state, |db| {
        db.delete_manual_fx_rate(&base_currency, &quote_currency, &effective_on)
    })
}

#[tauri::command]
fn resolve_exchange_rate(
    state: State<AppState>,
    base_currency: String,
    quote_currency: String,
    date: String,
    source: String,
    force_refresh: Option<bool>,
) -> Result<db::fx::FxRateQuote, String> {
    match source.trim().to_ascii_lowercase().as_str() {
        "manual" => with_db(&state, |db| {
            db.lookup_manual_fx_rate(&base_currency, &quote_currency, &date)
        })?
        .ok_or_else(|| "No manual rate is available for this currency pair and date".to_string()),
        "frankfurter" => {
            let cached = with_db(&state, |db| {
                db.lookup_cached_frankfurter_rate(&base_currency, &quote_currency, &date)
            })?;
            if let Some(rate) = cached {
                if !force_refresh.unwrap_or(false) && !rate.stale {
                    return Ok(rate);
                }
            }
            let fetched = fx::fetch_rate(
                &base_currency.trim().to_ascii_uppercase(),
                &quote_currency.trim().to_ascii_uppercase(),
                &date,
            )?;
            let rate = fx::rate_as_text(&fetched.rate)?;
            with_db(&state, |db| {
                db.cache_frankfurter_rate(
                    &fetched.base,
                    &fetched.quote,
                    &date,
                    &fetched.date,
                    &rate,
                )
            })
        }
        _ => Err("Rate source must be Frankfurter or manual".to_string()),
    }
}

#[tauri::command]
fn init_db(state: State<AppState>, currency: String) -> Result<String, String> {
    let path = state.db_path.lock().unwrap().clone();
    let db = Db::open_for_init(&path).map_err(|e| e.to_string())?;
    db.init(&currency).map_err(|e| e.to_string())?;
    Ok(currency.trim().to_ascii_uppercase())
}

#[tauri::command]
fn today_iso() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

// ---------- Accounts ----------
#[tauri::command]
fn list_accounts(state: State<AppState>) -> Result<Vec<Account>, String> {
    with_db(&state, |db| db.list_accounts())
}

#[derive(Deserialize)]
struct AddAccountReq {
    name: String,
    kind: String,
    opening_balance: String,
    currency_code: Option<String>,
    opened_on: String,
}
#[tauri::command]
fn add_account(state: State<AppState>, req: AddAccountReq) -> Result<i64, String> {
    let kind = match req.kind.as_str() {
        "cash" => AccountKind::Cash,
        "checking" => AccountKind::Checking,
        "savings" => AccountKind::Savings,
        "credit" => AccountKind::Credit,
        _ => return Err("Invalid account kind".into()),
    };
    let cents = parse_balance_cents(&req.opening_balance)?;
    with_db(&state, |db| {
        let reporting_currency;
        let currency = match req.currency_code.as_deref() {
            Some(value) => value,
            None => {
                reporting_currency = db.currency_code()?;
                &reporting_currency
            }
        };
        db.add_account_with_currency(&req.name, &kind, cents, currency, &req.opened_on)
    })
}

#[derive(Deserialize)]
struct EditAccountReq {
    reference: String,
    name: Option<String>,
    kind: Option<String>,
    opening_balance: Option<String>,
    currency_code: Option<String>,
    opened_on: Option<String>,
}
#[tauri::command]
fn edit_account(state: State<AppState>, req: EditAccountReq) -> Result<i64, String> {
    let kind = match req.kind.as_deref() {
        Some("cash") => Some(AccountKind::Cash),
        Some("checking") => Some(AccountKind::Checking),
        Some("savings") => Some(AccountKind::Savings),
        Some("credit") => Some(AccountKind::Credit),
        Some(_) => return Err("Invalid account kind".into()),
        None => None,
    };
    let cents = req
        .opening_balance
        .as_deref()
        .map(parse_balance_cents)
        .transpose()?;
    with_db(&state, |db| {
        db.edit_account(
            &req.reference,
            req.name.as_deref(),
            kind.as_ref(),
            cents,
            req.currency_code.as_deref(),
            req.opened_on.as_deref(),
        )
    })
}

#[tauri::command]
fn delete_account(state: State<AppState>, reference: String) -> Result<i64, String> {
    with_db(&state, |db| db.delete_account(&reference))
}

// ---------- Categories ----------
#[tauri::command]
fn list_categories(state: State<AppState>) -> Result<Vec<Category>, String> {
    with_db(&state, |db| db.list_categories())
}

#[derive(Deserialize)]
struct AddCategoryReq {
    name: String,
    kind: String,
}
#[tauri::command]
fn add_category(state: State<AppState>, req: AddCategoryReq) -> Result<i64, String> {
    let kind = match req.kind.as_str() {
        "income" => CategoryKind::Income,
        "expense" => CategoryKind::Expense,
        _ => return Err("Invalid category kind".into()),
    };
    with_db(&state, |db| db.add_category(&req.name, &kind))
}

#[derive(Deserialize)]
struct EditCategoryReq {
    reference: String,
    name: Option<String>,
    kind: Option<String>,
}
#[tauri::command]
fn edit_category(state: State<AppState>, req: EditCategoryReq) -> Result<i64, String> {
    let kind = match req.kind.as_deref() {
        Some("income") => Some(CategoryKind::Income),
        Some("expense") => Some(CategoryKind::Expense),
        Some(_) => return Err("Invalid kind".into()),
        None => None,
    };
    with_db(&state, |db| {
        db.edit_category(&req.reference, req.name.as_deref(), kind.as_ref())
    })
}

#[tauri::command]
fn delete_category(state: State<AppState>, reference: String) -> Result<i64, String> {
    with_db(&state, |db| db.delete_category(&reference))
}

// ---------- Transactions ----------
#[derive(Deserialize)]
struct AddTxnReq {
    kind: String,
    amount: String,
    date: String,
    account: String,
    to_account: Option<String>,
    category: Option<String>,
    payee: Option<String>,
    note: Option<String>,
    to_amount: Option<String>,
    reporting_amount: Option<String>,
    exchange_rate: Option<String>,
    exchange_rate_source: Option<String>,
    exchange_rate_date: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    attachment_path: Option<String>,
    splits: Option<Vec<TxnSplitReq>>,
}
#[derive(Deserialize)]
struct TxnSplitReq {
    category: String,
    amount: String,
    reporting_amount: Option<String>,
    memo: Option<String>,
}

fn parse_split_requests(rows: Vec<TxnSplitReq>) -> Result<Vec<TransactionSplitInput>, String> {
    rows.into_iter()
        .map(|row| {
            Ok(TransactionSplitInput {
                category: row.category,
                amount_cents: parse_cents(&row.amount)?,
                reporting_amount_cents: row
                    .reporting_amount
                    .as_deref()
                    .map(parse_cents)
                    .transpose()?,
                memo: row.memo.filter(|value| !value.trim().is_empty()),
            })
        })
        .collect()
}
fn parse_txn_kind(s: &str) -> Result<TransactionKind, String> {
    match s {
        "income" => Ok(TransactionKind::Income),
        "expense" => Ok(TransactionKind::Expense),
        "transfer" => Ok(TransactionKind::Transfer),
        _ => Err("Invalid transaction kind".into()),
    }
}
#[tauri::command]
fn add_transaction(state: State<AppState>, req: AddTxnReq) -> Result<i64, String> {
    let kind = parse_txn_kind(&req.kind)?;
    let cents = parse_cents(&req.amount)?;
    let txn = NewTransaction {
        txn_date: req.date,
        kind,
        amount_cents: cents,
        account: req.account,
        to_account: req.to_account.filter(|s| !s.trim().is_empty()),
        category: req.category.filter(|s| !s.trim().is_empty()),
        payee: req.payee.filter(|s| !s.trim().is_empty()),
        note: req.note.filter(|s| !s.trim().is_empty()),
        recurring_rule_id: None,
    };
    let fx = transaction_fx_input(
        req.to_amount.as_deref(),
        req.reporting_amount.as_deref(),
        cents,
        req.exchange_rate,
        req.exchange_rate_source,
        req.exchange_rate_date,
    )?;
    let splits = req.splits.map(parse_split_requests).transpose()?;
    with_db(&state, |db| {
        db.atomic(|db| {
            let id = match fx {
                Some(fx) => db.add_transaction_with_fx(&txn, &fx)?,
                None => db.add_transaction(&txn)?,
            };
            for tag in req.tags {
                db.add_transaction_tag(id, &tag)?;
            }
            if let Some(path) = req.attachment_path {
                db.add_transaction_attachment(id, &path, None)?;
            }
            if let Some(splits) = splits.as_deref() {
                db.set_transaction_splits(id, splits)?;
            }
            Ok(id)
        })
    })
}

#[tauri::command]
fn record_loan_payment(
    state: State<AppState>,
    id: i64,
    amount: String,
    interest: String,
    date: String,
    next_due_on: Option<String>,
    account: Option<String>,
    category: Option<String>,
    note: Option<String>,
) -> Result<(), String> {
    let cents = parse_cents(&amount)?;
    let interest_cents = parse_balance_cents(&interest)?;
    with_db(&state, |db| {
        db.record_loan_payment(
            id,
            cents,
            interest_cents,
            &date,
            next_due_on.as_deref(),
            account.as_deref(),
            category.as_deref(),
            note.as_deref(),
        )
    })
}

#[derive(Deserialize)]
struct EditTxnReq {
    id: i64,
    kind: Option<String>,
    amount: Option<String>,
    date: Option<String>,
    account: Option<String>,
    to_account: Option<String>,
    category: Option<String>,
    payee: Option<String>,
    note: Option<String>,
    to_amount: Option<String>,
    reporting_amount: Option<String>,
    exchange_rate: Option<String>,
    exchange_rate_source: Option<String>,
    exchange_rate_date: Option<String>,
    clear_to_account: Option<bool>,
    clear_category: Option<bool>,
    clear_payee: Option<bool>,
    clear_note: Option<bool>,
    tags: Option<Vec<String>>,
    attachment_path: Option<String>,
    splits: Option<Vec<TxnSplitReq>>,
}
#[tauri::command]
fn edit_transaction(state: State<AppState>, req: EditTxnReq) -> Result<(), String> {
    let kind = req.kind.as_deref().map(parse_txn_kind).transpose()?;
    let cents = req.amount.as_deref().map(parse_cents).transpose()?;
    let patch = UpdateTransaction {
        id: req.id,
        txn_date: req.date.filter(|s| !s.trim().is_empty()),
        kind,
        amount_cents: cents,
        account: req.account.filter(|s| !s.trim().is_empty()),
        to_account: req.to_account.filter(|s| !s.trim().is_empty()),
        category: req.category.filter(|s| !s.trim().is_empty()),
        payee: req.payee.filter(|s| !s.trim().is_empty()),
        note: req.note.filter(|s| !s.trim().is_empty()),
        clear_to_account: req.clear_to_account.unwrap_or(false),
        clear_category: req.clear_category.unwrap_or(false),
        clear_payee: req.clear_payee.unwrap_or(false),
        clear_note: req.clear_note.unwrap_or(false),
    };
    let splits = req.splits.map(parse_split_requests).transpose()?;
    with_db(&state, |db| {
        db.atomic(|db| {
            let existing = db.load_transaction(patch.id)?;
            let fallback_reporting_cents = match cents {
                Some(amount) => amount,
                None if req
                    .exchange_rate
                    .as_deref()
                    .is_some_and(|rate| !rate.trim().is_empty()) =>
                {
                    existing.amount_cents
                }
                None => existing.reporting_amount_cents,
            };
            let fx = transaction_fx_input(
                req.to_amount.as_deref(),
                req.reporting_amount.as_deref(),
                fallback_reporting_cents,
                req.exchange_rate.clone(),
                req.exchange_rate_source.clone(),
                req.exchange_rate_date.clone(),
            )
            .map_err(AppError::Validation)?;
            db.edit_transaction_with_fx(&patch, fx.as_ref())?;
            if let Some(tags) = req.tags {
                for tag in db.list_transaction_tags(patch.id)? {
                    if !tags
                        .iter()
                        .any(|name| name.trim().eq_ignore_ascii_case(&tag.name))
                    {
                        db.remove_transaction_tag(patch.id, tag.id)?;
                    }
                }
                for tag in tags {
                    db.add_transaction_tag(patch.id, &tag)?;
                }
            }
            if let Some(path) = req.attachment_path {
                db.add_transaction_attachment(patch.id, &path, None)?;
            }
            match splits.as_deref() {
                Some(rows) => {
                    db.set_transaction_splits(patch.id, rows)?;
                }
                None => db.validate_transaction_splits(patch.id)?,
            }
            Ok(())
        })
    })
}

fn transaction_fx_input(
    to_amount: Option<&str>,
    reporting_amount: Option<&str>,
    fallback_reporting_cents: i64,
    exchange_rate: Option<String>,
    exchange_rate_source: Option<String>,
    exchange_rate_date: Option<String>,
) -> Result<Option<TransactionFxInput>, String> {
    let has_fx = to_amount.is_some()
        || reporting_amount.is_some()
        || exchange_rate.is_some()
        || exchange_rate_source.is_some()
        || exchange_rate_date.is_some();
    if !has_fx {
        return Ok(None);
    }
    let rate = exchange_rate.filter(|value| !value.trim().is_empty());
    let reporting_amount_cents = match reporting_amount.filter(|value| !value.trim().is_empty()) {
        Some(value) => parse_cents(value)?,
        None => match rate.as_deref() {
            Some(value) => convert_cents_at_rate(fallback_reporting_cents, value)?,
            None => fallback_reporting_cents,
        },
    };
    Ok(Some(TransactionFxInput {
        to_amount_cents: to_amount
            .filter(|value| !value.trim().is_empty())
            .map(parse_cents)
            .transpose()?,
        reporting_amount_cents,
        exchange_rate: rate,
        exchange_rate_source: exchange_rate_source
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.to_ascii_lowercase()),
        exchange_rate_date: exchange_rate_date.filter(|value| !value.trim().is_empty()),
    }))
}

fn convert_cents_at_rate(amount_cents: i64, rate: &str) -> Result<i64, String> {
    amount::convert_cents_at_rate(amount_cents, rate).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_transaction(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.delete_transaction(id))
}
#[tauri::command]
fn restore_transaction(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.restore_transaction(id))
}

#[derive(Deserialize)]
struct BulkTxnReq {
    transaction_ids: Vec<i64>,
    action: String,
    category: Option<String>,
    tags: Option<Vec<String>>,
}
#[tauri::command]
fn bulk_transactions(
    state: State<AppState>,
    req: BulkTxnReq,
) -> Result<BulkTransactionResult, String> {
    with_db(&state, |db| {
        db.bulk_transactions(
            &req.transaction_ids,
            req.action.trim(),
            req.category
                .as_deref()
                .filter(|value| !value.trim().is_empty()),
            &req.tags.unwrap_or_default(),
        )
    })
}

#[derive(Deserialize)]
struct ListTxnReq {
    from: Option<String>,
    to: Option<String>,
    account: Option<String>,
    category: Option<String>,
    kind: Option<String>,
    accounts: Option<Vec<String>>,
    categories: Option<Vec<String>>,
    kinds: Option<Vec<String>>,
    search: Option<String>,
    limit: Option<usize>,
    include_deleted: Option<bool>,
    sort_by: Option<String>,
    sort_dir: Option<String>,
}
#[tauri::command]
fn list_transactions(
    state: State<AppState>,
    req: ListTxnReq,
) -> Result<Vec<TransactionRecord>, String> {
    let filters = TransactionFilters {
        from: req.from.filter(|s| !s.trim().is_empty()),
        to: req.to.filter(|s| !s.trim().is_empty()),
        account: req.account.filter(|s| !s.trim().is_empty()),
        category: req.category.filter(|s| !s.trim().is_empty()),
        kind: req.kind.and_then(|v| TransactionKind::from_str(&v)),
        accounts: req
            .accounts
            .unwrap_or_default()
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .collect(),
        categories: req
            .categories
            .unwrap_or_default()
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .collect(),
        kinds: req
            .kinds
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| TransactionKind::from_str(&v))
            .collect(),
        search: req.search.filter(|s| !s.trim().is_empty()),
        limit: req.limit,
        include_deleted: req.include_deleted.unwrap_or(false),
        sort_by: req
            .sort_by
            .and_then(|v| TransactionSortColumn::from_str(&v)),
        sort_dir: req
            .sort_dir
            .and_then(|v| TransactionSortDirection::from_str(&v)),
    };
    with_db(&state, |db| db.list_transactions(&filters))
}

#[tauri::command]
fn recent_transactions(
    state: State<AppState>,
    limit: Option<usize>,
) -> Result<Vec<TransactionRecord>, String> {
    with_db(&state, |db| db.recent_transactions(limit.unwrap_or(20)))
}

#[tauri::command]
fn list_transaction_splits(
    state: State<AppState>,
    transaction_id: i64,
) -> Result<Vec<TransactionSplitRecord>, String> {
    with_db(&state, |db| db.list_transaction_splits(transaction_id))
}

#[derive(Deserialize)]
struct RuleReq {
    name: String,
    priority: i64,
    enabled: Option<bool>,
    match_field: String,
    match_operator: String,
    match_value: String,
    account: Option<String>,
    kind: Option<String>,
    min_amount: Option<String>,
    max_amount: Option<String>,
    set_payee: Option<String>,
    set_category: Option<String>,
    append_note: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    stop_processing: Option<bool>,
}

fn parse_rule_request(req: RuleReq) -> Result<TransactionRuleInput, String> {
    Ok(TransactionRuleInput {
        name: req.name,
        priority: req.priority,
        enabled: req.enabled.unwrap_or(true),
        match_field: req.match_field,
        match_operator: req.match_operator,
        match_value: req.match_value,
        account: req.account.filter(|v| !v.trim().is_empty()),
        kind: req
            .kind
            .as_deref()
            .filter(|v| !v.trim().is_empty())
            .map(parse_txn_kind)
            .transpose()?,
        min_amount_cents: req
            .min_amount
            .as_deref()
            .filter(|v| !v.trim().is_empty())
            .map(parse_cents)
            .transpose()?,
        max_amount_cents: req
            .max_amount
            .as_deref()
            .filter(|v| !v.trim().is_empty())
            .map(parse_cents)
            .transpose()?,
        set_payee: req.set_payee.filter(|v| !v.trim().is_empty()),
        set_category: req.set_category.filter(|v| !v.trim().is_empty()),
        append_note: req.append_note.filter(|v| !v.trim().is_empty()),
        tags: req.tags,
        stop_processing: req.stop_processing.unwrap_or(true),
    })
}

#[tauri::command]
fn list_transaction_rules(state: State<AppState>) -> Result<Vec<TransactionRuleRecord>, String> {
    with_db(&state, |db| db.list_transaction_rules())
}

#[tauri::command]
fn save_transaction_rule(
    state: State<AppState>,
    id: Option<i64>,
    req: RuleReq,
) -> Result<i64, String> {
    let input = parse_rule_request(req)?;
    with_db(&state, |db| {
        db.atomic(|db| db.save_transaction_rule(id, &input))
    })
}

#[tauri::command]
fn delete_transaction_rule(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.delete_transaction_rule(id))
}

#[tauri::command]
fn apply_transaction_rules(
    state: State<AppState>,
    transaction_ids: Option<Vec<i64>>,
    dry_run: Option<bool>,
) -> Result<RuleApplyResult, String> {
    with_db(&state, |db| {
        db.atomic(|db| {
            db.apply_transaction_rules(transaction_ids.as_deref(), dry_run.unwrap_or(true))
        })
    })
}

#[tauri::command]
fn undo_rule_application(state: State<AppState>, run_id: i64) -> Result<usize, String> {
    with_db(&state, |db| {
        db.atomic(|db| db.undo_rule_application(run_id))
    })
}

#[tauri::command]
fn save_credit_debt_settings(
    state: State<AppState>,
    account: String,
    annual_rate_bps: i64,
    minimum_payment: String,
) -> Result<(), String> {
    let minimum = parse_cents(&minimum_payment)?;
    with_db(&state, |db| {
        db.save_credit_debt_settings(&account, annual_rate_bps, minimum)
    })
}

#[tauri::command]
fn delete_credit_debt_settings(state: State<AppState>, account: String) -> Result<(), String> {
    with_db(&state, |db| db.delete_credit_debt_settings(&account))
}

#[tauri::command]
fn get_debt_optimizer(
    state: State<AppState>,
    extra_payment: String,
) -> Result<DebtOptimizerSnapshot, String> {
    let extra = amount::parse_balance_to_cents(&extra_payment).map_err(|e| e.to_string())?;
    with_db(&state, |db| db.debt_optimizer(extra))
}

#[tauri::command]
fn list_credit_debt_settings(
    state: State<AppState>,
) -> Result<Vec<DebtAccountSettingRecord>, String> {
    with_db(&state, |db| db.list_credit_debt_settings())
}

#[tauri::command]
fn set_investment_tax_treatment(
    state: State<AppState>,
    account_id: i64,
    treatment: String,
) -> Result<(), String> {
    with_db(&state, |db| {
        db.set_investment_tax_treatment(account_id, &treatment)
    })
}

#[tauri::command]
fn list_investment_tax_settings(
    state: State<AppState>,
) -> Result<Vec<InvestmentTaxSettingRecord>, String> {
    with_db(&state, |db| db.list_investment_tax_settings())
}

#[tauri::command]
fn set_tax_category(
    state: State<AppState>,
    category: String,
    deduction_group: Option<String>,
) -> Result<(), String> {
    with_db(&state, |db| {
        db.set_tax_category(&category, deduction_group.as_deref())
    })
}

#[tauri::command]
fn list_tax_category_settings(
    state: State<AppState>,
) -> Result<Vec<TaxCategorySettingRecord>, String> {
    with_db(&state, |db| db.list_tax_category_settings())
}

#[tauri::command]
fn get_tax_center(state: State<AppState>, tax_year: i32) -> Result<TaxCenterSnapshot, String> {
    with_db(&state, |db| db.tax_center(tax_year))
}

#[tauri::command]
fn get_comparative_analytics(
    state: State<AppState>,
    current_from: String,
    current_to: String,
    baseline_from: String,
    baseline_to: String,
    account: Option<String>,
) -> Result<ComparativeAnalyticsSnapshot, String> {
    with_db(&state, |db| {
        db.comparative_analytics(
            &current_from,
            &current_to,
            &baseline_from,
            &baseline_to,
            account.as_deref(),
        )
    })
}

// ---------- Tags, files, loans, net worth & investments ----------
#[tauri::command]
fn list_tags(state: State<AppState>) -> Result<Vec<TagRecord>, String> {
    with_db(&state, |db| db.list_tags())
}
#[tauri::command]
fn list_transaction_tags(
    state: State<AppState>,
    transaction_id: i64,
) -> Result<Vec<TagRecord>, String> {
    with_db(&state, |db| db.list_transaction_tags(transaction_id))
}
#[tauri::command]
fn add_transaction_tag(
    state: State<AppState>,
    transaction_id: i64,
    name: String,
) -> Result<(), String> {
    with_db(&state, |db| db.add_transaction_tag(transaction_id, &name))
}
#[tauri::command]
fn remove_transaction_tag(
    state: State<AppState>,
    transaction_id: i64,
    tag_id: i64,
) -> Result<(), String> {
    with_db(&state, |db| {
        db.remove_transaction_tag(transaction_id, tag_id)
    })
}
#[tauri::command]
fn list_transaction_attachments(
    state: State<AppState>,
    transaction_id: i64,
) -> Result<Vec<TransactionAttachment>, String> {
    with_db(&state, |db| db.list_transaction_attachments(transaction_id))
}
#[tauri::command]
fn add_transaction_attachment(
    state: State<AppState>,
    transaction_id: i64,
    file_path: String,
    label: Option<String>,
) -> Result<i64, String> {
    with_db(&state, |db| {
        db.add_transaction_attachment(transaction_id, &file_path, label.as_deref())
    })
}
#[tauri::command]
fn delete_transaction_attachment(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.delete_transaction_attachment(id))
}

#[derive(Deserialize)]
struct AddLoanReq {
    name: String,
    lender: Option<String>,
    principal: String,
    outstanding: String,
    emi: String,
    annual_rate: Option<String>,
    next_due_on: Option<String>,
}
#[tauri::command]
fn add_loan(state: State<AppState>, req: AddLoanReq) -> Result<i64, String> {
    let rate = req
        .annual_rate
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse::<f64>()
                .map(|v| (v * 100.0).round() as i64)
                .map_err(|_| "Annual rate must be a number".to_string())
        })
        .transpose()?;
    let principal = parse_cents(&req.principal)?;
    let outstanding = parse_cents(&req.outstanding)?;
    let emi = parse_cents(&req.emi)?;
    with_db(&state, |db| {
        db.add_loan(
            &req.name,
            req.lender.as_deref(),
            principal,
            outstanding,
            emi,
            rate,
            req.next_due_on.as_deref(),
        )
    })
}
#[derive(Deserialize)]
struct EditLoanReq {
    id: i64,
    name: String,
    lender: Option<String>,
    principal: String,
    outstanding: String,
    emi: String,
    annual_rate: Option<String>,
    next_due_on: Option<String>,
}
#[tauri::command]
fn edit_loan(state: State<AppState>, req: EditLoanReq) -> Result<(), String> {
    let rate = req
        .annual_rate
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse::<f64>()
                .map(|v| (v * 100.0).round() as i64)
                .map_err(|_| "Annual rate must be a number".to_string())
        })
        .transpose()?;
    let principal = parse_cents(&req.principal)?;
    let outstanding = parse_cents(&req.outstanding)?;
    let emi = parse_cents(&req.emi)?;
    with_db(&state, |db| {
        db.edit_loan(
            req.id,
            &req.name,
            req.lender.as_deref(),
            principal,
            outstanding,
            emi,
            rate,
            req.next_due_on.as_deref(),
        )
    })
}
#[tauri::command]
fn list_loans(state: State<AppState>) -> Result<Vec<LoanRecord>, String> {
    with_db(&state, |db| db.list_loans())
}
#[tauri::command]
fn delete_loan(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.delete_loan(id))
}

#[derive(Deserialize)]
struct AddNetWorthItemReq {
    name: String,
    kind: String,
    value: String,
    as_of: String,
    note: Option<String>,
}
#[tauri::command]
fn add_net_worth_item(state: State<AppState>, req: AddNetWorthItemReq) -> Result<i64, String> {
    let value = parse_balance_cents(&req.value)?;
    with_db(&state, |db| {
        db.add_net_worth_item(&req.name, &req.kind, value, &req.as_of, req.note.as_deref())
    })
}
#[tauri::command]
fn list_net_worth_items(state: State<AppState>) -> Result<Vec<NetWorthItemRecord>, String> {
    with_db(&state, |db| db.list_net_worth_items())
}
#[derive(Deserialize)]
struct EditNetWorthItemReq {
    id: i64,
    name: String,
    kind: String,
    value: String,
    as_of: String,
    note: Option<String>,
}
#[tauri::command]
fn edit_net_worth_item(state: State<AppState>, req: EditNetWorthItemReq) -> Result<(), String> {
    let value = parse_balance_cents(&req.value)?;
    with_db(&state, |db| {
        db.edit_net_worth_item(req.id, &req.name, &req.kind, value, &req.as_of, req.note.as_deref())
    })
}
#[tauri::command]
fn delete_net_worth_item(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.delete_net_worth_item(id))
}
#[tauri::command]
fn get_net_worth_snapshot(state: State<AppState>) -> Result<NetWorthSnapshot, String> {
    with_db(&state, |db| db.net_worth_snapshot())
}

#[tauri::command]
fn get_reporting_balances(state: State<AppState>) -> Result<Vec<BalanceRecord>, String> {
    with_db(&state, |db| db.reporting_balances())
}

#[derive(Deserialize)]
struct AddInvestmentAccountReq {
    name: String,
    institution: Option<String>,
    value: String,
    contributed: String,
    as_of: String,
}
#[tauri::command]
fn add_investment_account(
    state: State<AppState>,
    req: AddInvestmentAccountReq,
) -> Result<i64, String> {
    let value = parse_balance_cents(&req.value)?;
    let contributed = parse_balance_cents(&req.contributed)?;
    with_db(&state, |db| {
        db.add_investment_account(
            &req.name,
            req.institution.as_deref(),
            value,
            contributed,
            &req.as_of,
        )
    })
}
#[tauri::command]
fn list_investment_accounts(
    state: State<AppState>,
) -> Result<Vec<InvestmentAccountRecord>, String> {
    with_db(&state, |db| db.list_investment_accounts())
}
#[tauri::command]
fn get_investment_account(
    state: State<AppState>,
    id: i64,
) -> Result<InvestmentAccountRecord, String> {
    with_db(&state, |db| db.investment_account_details(id))
}
#[tauri::command]
fn edit_investment_account(
    state: State<AppState>,
    id: i64,
    req: AddInvestmentAccountReq,
) -> Result<(), String> {
    let value = parse_balance_cents(&req.value)?;
    let contributed = parse_balance_cents(&req.contributed)?;
    with_db(&state, |db| {
        db.edit_investment_account(
            id,
            &req.name,
            req.institution.as_deref(),
            value,
            contributed,
            &req.as_of,
        )
    })
}
#[tauri::command]
fn delete_investment_account(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.delete_investment_account(id))
}

#[derive(Deserialize)]
struct AddSecurityReq {
    symbol: String,
    name: String,
    currency_code: String,
}
#[tauri::command]
fn add_security(state: State<AppState>, req: AddSecurityReq) -> Result<i64, String> {
    with_db(&state, |db| {
        db.add_security(&req.symbol, &req.name, &req.currency_code)
    })
}
#[tauri::command]
fn list_securities(state: State<AppState>) -> Result<Vec<SecurityRecord>, String> {
    with_db(&state, |db| db.list_securities())
}
#[tauri::command]
fn list_holding_lots(
    state: State<AppState>,
    investment_account_id: i64,
) -> Result<Vec<HoldingLotRecord>, String> {
    with_db(&state, |db| db.list_holding_lots(investment_account_id))
}
#[tauri::command]
fn list_holding_events(
    state: State<AppState>,
    investment_account_id: i64,
) -> Result<Vec<HoldingEventRecord>, String> {
    with_db(&state, |db| db.list_holding_events(investment_account_id))
}

#[derive(Deserialize)]
struct AddHoldingEventReq {
    investment_account_id: i64,
    security_id: i64,
    event_type: String,
    event_on: String,
    quantity: Option<String>,
    price: Option<String>,
    reporting_price: Option<String>,
    amount: Option<String>,
    reporting_amount: Option<String>,
    note: Option<String>,
}
#[tauri::command]
fn add_holding_event(state: State<AppState>, req: AddHoldingEventReq) -> Result<i64, String> {
    let quantity_micros = parse_optional_quantity_micros(req.quantity.as_deref())?;
    let price_cents = parse_optional_positive_cents(req.price.as_deref())?;
    let reporting_price_cents = parse_optional_positive_cents(req.reporting_price.as_deref())?;
    let amount_cents = parse_optional_positive_cents(req.amount.as_deref())?;
    let reporting_amount_cents = parse_optional_positive_cents(req.reporting_amount.as_deref())?;
    with_db(&state, |db| {
        db.add_holding_event(
            req.investment_account_id,
            req.security_id,
            req.event_type.trim(),
            &req.event_on,
            quantity_micros,
            price_cents,
            reporting_price_cents,
            amount_cents,
            reporting_amount_cents,
            req.note.as_deref(),
        )
    })
}
#[tauri::command]
fn investment_account_performance(
    state: State<AppState>,
    investment_account_id: i64,
) -> Result<InvestmentPerformanceRecord, String> {
    with_db(&state, |db| {
        db.investment_account_performance(investment_account_id)
    })
}
#[tauri::command]
fn portfolio_xirr(state: State<AppState>) -> Result<PortfolioXirrRecord, String> {
    with_db(&state, |db| db.portfolio_xirr())
}

// ---------- Balances / Summary ----------
#[tauri::command]
fn get_balances(
    state: State<AppState>,
    account: Option<String>,
) -> Result<Vec<BalanceRecord>, String> {
    let r = account.filter(|s| !s.trim().is_empty());
    with_db(&state, |db| db.balances(r.as_deref()))
}

#[tauri::command]
fn get_balances_as_of(
    state: State<AppState>,
    account: Option<String>,
    as_of: Option<String>,
) -> Result<Vec<BalanceRecord>, String> {
    let r = account.filter(|s| !s.trim().is_empty());
    let date = as_of.unwrap_or_else(|| Local::now().date_naive().to_string());
    with_db(&state, |db| db.balances_on(r.as_deref(), &date))
}

#[tauri::command]
fn get_reporting_balances_as_of(
    state: State<AppState>,
    as_of: Option<String>,
) -> Result<Vec<BalanceRecord>, String> {
    let date = as_of.unwrap_or_else(|| Local::now().date_naive().to_string());
    with_db(&state, |db| db.reporting_balances_on(&date))
}

#[derive(Serialize)]
struct SummaryResp {
    from: String,
    to: String,
    account_id: Option<i64>,
    account_name: Option<String>,
    transaction_count: i64,
    income_cents: i64,
    expense_cents: i64,
    net_cents: i64,
    transfer_in_cents: i64,
    transfer_out_cents: i64,
}

#[tauri::command]
fn get_summary(
    state: State<AppState>,
    from: Option<String>,
    to: Option<String>,
    account: Option<String>,
) -> Result<SummaryResp, String> {
    let from_str = from
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "1970-01-01".to_string());
    let to_str = to
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "9999-12-31".to_string());
    let r = account.filter(|s| !s.trim().is_empty());
    let s: SummaryRecord = with_db(&state, |db| db.summary(&from_str, &to_str, r.as_deref()))?;
    Ok(SummaryResp {
        from: s.from,
        to: s.to,
        account_id: s.account_id,
        account_name: s.account_name,
        transaction_count: s.transaction_count,
        income_cents: s.income_cents,
        expense_cents: s.expense_cents,
        net_cents: s.net_cents,
        transfer_in_cents: s.transfer_in_cents,
        transfer_out_cents: s.transfer_out_cents,
    })
}

#[tauri::command]
fn monthly_cash_flow(
    state: State<AppState>,
    months: Option<usize>,
    account: Option<String>,
) -> Result<Vec<MonthlyCashFlowPoint>, String> {
    let account = account.filter(|value| !value.trim().is_empty());
    with_db(&state, |db| {
        db.monthly_cash_flow_trend(months.unwrap_or(6), account.as_deref())
    })
}
#[tauri::command]
fn category_spending(
    state: State<AppState>,
    from: Option<String>,
    to: Option<String>,
    limit: Option<usize>,
    account: Option<String>,
) -> Result<Vec<CategorySpendingPoint>, String> {
    let from_str = from
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "1970-01-01".to_string());
    let to_str = to
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "9999-12-31".to_string());
    let account = account.filter(|value| !value.trim().is_empty());
    with_db(&state, |db| {
        db.category_spending(
            &from_str,
            &to_str,
            limit.unwrap_or(8).min(1_000),
            account.as_deref(),
        )
    })
}
#[tauri::command]
fn spending_by_payee(
    state: State<AppState>,
    from: Option<String>,
    to: Option<String>,
    limit: Option<usize>,
    account: Option<String>,
) -> Result<Vec<SpendingBreakdownPoint>, String> {
    let from_str = from
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "1970-01-01".to_string());
    let to_str = to
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "9999-12-31".to_string());
    let account = account.filter(|value| !value.trim().is_empty());
    with_db(&state, |db| {
        db.spending_by_payee(
            &from_str,
            &to_str,
            limit.unwrap_or(50).min(1_000),
            account.as_deref(),
        )
    })
}
#[tauri::command]
fn list_payees(state: State<AppState>) -> Result<Vec<PayeeSummary>, String> {
    with_db(&state, |db| db.list_payees())
}
#[tauri::command]
fn get_payee_snapshot(state: State<AppState>, payee: String) -> Result<PayeeSnapshot, String> {
    with_db(&state, |db| db.payee_snapshot(&payee))
}
#[tauri::command]
fn spending_by_tag(
    state: State<AppState>,
    from: Option<String>,
    to: Option<String>,
    limit: Option<usize>,
    account: Option<String>,
) -> Result<Vec<SpendingBreakdownPoint>, String> {
    let from_str = from
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "1970-01-01".to_string());
    let to_str = to
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "9999-12-31".to_string());
    let account = account.filter(|value| !value.trim().is_empty());
    with_db(&state, |db| {
        db.spending_by_tag(
            &from_str,
            &to_str,
            limit.unwrap_or(50).min(1_000),
            account.as_deref(),
        )
    })
}
#[tauri::command]
fn balance_trend(
    state: State<AppState>,
    months: Option<usize>,
    account: Option<String>,
) -> Result<Vec<BalanceTrendPoint>, String> {
    let account = account.filter(|value| !value.trim().is_empty());
    with_db(&state, |db| {
        db.total_balance_trend(months.unwrap_or(6), account.as_deref())
    })
}

#[tauri::command]
fn dashboard_snapshot(
    state: State<AppState>,
    account: Option<String>,
    months: Option<usize>,
) -> Result<DashboardSnapshot, String> {
    let account = account.filter(|value| !value.trim().is_empty());
    with_db(&state, |db| {
        db.dashboard_snapshot(account.as_deref(), months.unwrap_or(6))
    })
}

// ---------- Reconciliation (architecture ready, UI placeholder) ----------
#[tauri::command]
fn list_reconciliations(
    state: State<AppState>,
    account: Option<String>,
) -> Result<Vec<ReconciliationRecord>, String> {
    let r = account.filter(|s| !s.trim().is_empty());
    with_db(&state, |db| db.list_reconciliations(r.as_deref()))
}
#[tauri::command]
fn eligible_reconciliation_txns(
    state: State<AppState>,
    account: String,
    ending_on: String,
) -> Result<Vec<TransactionRecord>, String> {
    with_db(&state, |db| {
        db.list_eligible_reconciliation_transactions(&account, &ending_on)
    })
}
#[tauri::command]
fn start_reconciliation(
    state: State<AppState>,
    account: String,
    ending_on: String,
    balance: String,
    txn_ids: Vec<i64>,
) -> Result<i64, String> {
    let cents = parse_balance_cents(&balance)?;
    with_db(&state, |db| {
        db.start_reconciliation(&account, &ending_on, cents, &txn_ids)
    })
}
#[tauri::command]
fn delete_reconciliation(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.delete_reconciliation(id))
}

// ---------- Recurring ----------
#[derive(Deserialize)]
struct AddRecurringReq {
    name: String,
    kind: String,
    amount: String,
    account: String,
    to_account: Option<String>,
    category: Option<String>,
    payee: Option<String>,
    note: Option<String>,
    cadence: String,
    interval: i64,
    day_of_month: Option<u32>,
    weekday: Option<String>,
    start_on: String,
    next_due_on: Option<String>,
    end_on: Option<String>,
}
fn parse_cadence(s: &str) -> Result<RecurringCadence, String> {
    match s {
        "weekly" => Ok(RecurringCadence::Weekly),
        "monthly" => Ok(RecurringCadence::Monthly),
        _ => Err("invalid cadence".into()),
    }
}
fn parse_weekday(s: &str) -> Result<Weekday, String> {
    match s {
        "mon" => Ok(Weekday::Mon),
        "tue" => Ok(Weekday::Tue),
        "wed" => Ok(Weekday::Wed),
        "thu" => Ok(Weekday::Thu),
        "fri" => Ok(Weekday::Fri),
        "sat" => Ok(Weekday::Sat),
        "sun" => Ok(Weekday::Sun),
        _ => Err("invalid weekday".into()),
    }
}
#[tauri::command]
fn add_recurring(state: State<AppState>, req: AddRecurringReq) -> Result<i64, String> {
    let rule = NewRecurringRule {
        name: req.name,
        kind: parse_txn_kind(&req.kind)?,
        amount_cents: parse_cents(&req.amount)?,
        account: req.account,
        to_account: req.to_account.filter(|s| !s.trim().is_empty()),
        category: req.category.filter(|s| !s.trim().is_empty()),
        payee: req.payee.filter(|s| !s.trim().is_empty()),
        note: req.note.filter(|s| !s.trim().is_empty()),
        cadence: parse_cadence(&req.cadence)?,
        interval: req.interval,
        day_of_month: req.day_of_month,
        weekday: req.weekday.as_deref().map(parse_weekday).transpose()?,
        start_on: req.start_on,
        next_due_on: req.next_due_on.filter(|s| !s.trim().is_empty()),
        end_on: req.end_on.filter(|s| !s.trim().is_empty()),
    };
    with_db(&state, |db| db.add_recurring_rule(&rule))
}
#[tauri::command]
fn list_recurring(state: State<AppState>) -> Result<Vec<RecurringRuleRecord>, String> {
    with_db(&state, |db| db.list_recurring_rules())
}
#[tauri::command]
fn pause_recurring(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.pause_recurring_rule(id))
}
#[tauri::command]
fn resume_recurring(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.resume_recurring_rule(id))
}
#[tauri::command]
fn delete_recurring(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.delete_recurring_rule(id))
}
#[tauri::command]
fn run_recurring(state: State<AppState>, through: String) -> Result<usize, String> {
    with_db(&state, |db| db.run_due_recurring(&through))
}

#[derive(Deserialize)]
struct EditRecurringReq {
    id: i64,
    name: Option<String>,
    kind: Option<String>,
    amount: Option<String>,
    account: Option<String>,
    to_account: Option<String>,
    category: Option<String>,
    payee: Option<String>,
    note: Option<String>,
    cadence: Option<String>,
    interval: Option<i64>,
    day_of_month: Option<u32>,
    weekday: Option<String>,
    start_on: Option<String>,
    next_due_on: Option<String>,
    end_on: Option<String>,
    clear_to_account: Option<bool>,
    clear_category: Option<bool>,
    clear_payee: Option<bool>,
    clear_note: Option<bool>,
    clear_day_of_month: Option<bool>,
    clear_weekday: Option<bool>,
    clear_next_due_on: Option<bool>,
    clear_end_on: Option<bool>,
}
#[tauri::command]
fn edit_recurring(state: State<AppState>, req: EditRecurringReq) -> Result<(), String> {
    let patch = UpdateRecurringRule {
        id: req.id,
        name: req.name.filter(|s| !s.trim().is_empty()),
        kind: req.kind.as_deref().map(parse_txn_kind).transpose()?,
        amount_cents: req.amount.as_deref().map(parse_cents).transpose()?,
        account: req.account.filter(|s| !s.trim().is_empty()),
        to_account: req.to_account.filter(|s| !s.trim().is_empty()),
        category: req.category.filter(|s| !s.trim().is_empty()),
        payee: req.payee.filter(|s| !s.trim().is_empty()),
        note: req.note.filter(|s| !s.trim().is_empty()),
        cadence: req.cadence.as_deref().map(parse_cadence).transpose()?,
        interval: req.interval,
        day_of_month: req.day_of_month,
        weekday: req.weekday.as_deref().map(parse_weekday).transpose()?,
        start_on: req.start_on.filter(|s| !s.trim().is_empty()),
        next_due_on: req.next_due_on.filter(|s| !s.trim().is_empty()),
        end_on: req.end_on.filter(|s| !s.trim().is_empty()),
        clear_to_account: req.clear_to_account.unwrap_or(false),
        clear_category: req.clear_category.unwrap_or(false),
        clear_payee: req.clear_payee.unwrap_or(false),
        clear_note: req.clear_note.unwrap_or(false),
        clear_day_of_month: req.clear_day_of_month.unwrap_or(false),
        clear_weekday: req.clear_weekday.unwrap_or(false),
        clear_next_due_on: req.clear_next_due_on.unwrap_or(false),
        clear_end_on: req.clear_end_on.unwrap_or(false),
    };
    with_db(&state, |db| db.edit_recurring_rule(&patch))
}

// ---------- Budgets ----------
#[tauri::command]
fn set_budget(
    state: State<AppState>,
    month: String,
    category: String,
    amount: String,
    account: Option<String>,
    scenario: Option<String>,
) -> Result<i64, String> {
    let cents = parse_cents(&amount)?;
    let acc = account.filter(|s| !s.trim().is_empty());
    let scen = scenario.filter(|s| !s.trim().is_empty());
    with_db(&state, |db| {
        db.set_budget(&month, &category, cents, acc.as_deref(), scen.as_deref())
    })
}
#[tauri::command]
fn delete_budget(
    state: State<AppState>,
    month: String,
    category: String,
    account: Option<String>,
    scenario: Option<String>,
) -> Result<(), String> {
    let acc = account.filter(|s| !s.trim().is_empty());
    let scen = scenario.filter(|s| !s.trim().is_empty());
    with_db(&state, |db| {
        db.delete_budget(&month, &category, acc.as_deref(), scen.as_deref())
    })
}
#[tauri::command]
fn list_budgets(
    state: State<AppState>,
    month: Option<String>,
    scenario: Option<String>,
) -> Result<Vec<BudgetRecord>, String> {
    let m = month.filter(|s| !s.trim().is_empty());
    let s = scenario.filter(|s| !s.trim().is_empty());
    with_db(&state, |db| db.list_budgets(m.as_deref(), s.as_deref()))
}
#[tauri::command]
fn budget_status(
    state: State<AppState>,
    month: String,
    scenario: Option<String>,
) -> Result<Vec<BudgetStatusRecord>, String> {
    let s = scenario.filter(|s| !s.trim().is_empty());
    with_db(&state, |db| db.budget_status(&month, s.as_deref()))
}

#[tauri::command]
fn set_budget_rollover(
    state: State<AppState>,
    category: String,
    account: Option<String>,
    start_month: Option<String>,
) -> Result<(), String> {
    with_db(&state, |db| {
        db.set_budget_rollover(&category, account.as_deref(), start_month.as_deref())
    })
}
#[tauri::command]
fn move_budget_money(
    state: State<AppState>,
    month: String,
    from: String,
    to: String,
    account: Option<String>,
    amount: String,
) -> Result<(), String> {
    let cents = parse_cents(&amount)?;
    with_db(&state, |db| {
        db.move_budget_money(&month, &from, &to, account.as_deref(), cents)
    })
}

#[tauri::command]
fn list_budget_moves(
    state: State<AppState>,
    month: Option<String>,
) -> Result<Vec<BudgetMoveRecord>, String> {
    with_db(&state, |db| db.list_budget_moves(month.as_deref()))
}

#[tauri::command]
fn get_safe_to_spend(state: State<AppState>) -> Result<SafeSpendSnapshot, String> {
    with_db(&state, |db| db.safe_to_spend())
}
#[tauri::command]
fn get_safe_spend_settings(state: State<AppState>) -> Result<SafeSpendSettings, String> {
    with_db(&state, |db| db.safe_spend_settings())
}
#[derive(Deserialize)]
struct SafeSpendSettingsReq {
    payday: Option<String>,
    buffer: String,
    protected: String,
    account_ids: Vec<i64>,
}
#[tauri::command]
fn save_safe_spend_settings(state: State<AppState>, req:SafeSpendSettingsReq) -> Result<(),String> {
    let settings=SafeSpendSettings {payday:req.payday,buffer_cents:parse_balance_cents(&req.buffer)?,
        protected_cents:parse_balance_cents(&req.protected)?,account_ids:req.account_ids,configured:true,updated_at:String::new()};
    with_db(&state, |db| db.save_safe_spend_settings(&settings))
}

// ---------- Planning ----------
#[derive(Deserialize)]
struct AddPlanningItemReq {
    scenario: Option<String>,
    title: String,
    kind: String,
    amount: String,
    account: String,
    to_account: Option<String>,
    category: Option<String>,
    due_on: String,
    payee: Option<String>,
    note: Option<String>,
}
#[tauri::command]
fn add_planning_item(state: State<AppState>, req: AddPlanningItemReq) -> Result<i64, String> {
    let item = NewPlanningItem {
        scenario: req.scenario.filter(|s| !s.trim().is_empty()),
        title: req.title,
        kind: parse_txn_kind(&req.kind)?,
        amount_cents: parse_cents(&req.amount)?,
        account: req.account,
        to_account: req.to_account.filter(|s| !s.trim().is_empty()),
        category: req.category.filter(|s| !s.trim().is_empty()),
        due_on: req.due_on,
        payee: req.payee.filter(|s| !s.trim().is_empty()),
        note: req.note.filter(|s| !s.trim().is_empty()),
    };
    with_db(&state, |db| db.add_planning_item(&item))
}
#[tauri::command]
fn list_planning_items(
    state: State<AppState>,
    scenario: Option<String>,
    from: Option<String>,
    to: Option<String>,
) -> Result<Vec<PlanningItemRecord>, String> {
    let sc = scenario.filter(|s| !s.trim().is_empty());
    let f = from.filter(|s| !s.trim().is_empty());
    let t = to.filter(|s| !s.trim().is_empty());
    with_db(&state, |db| {
        db.list_planning_items(sc.as_deref(), f.as_deref(), t.as_deref())
    })
}
#[tauri::command]
fn delete_planning_item(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.delete_planning_item(id))
}
#[tauri::command]
fn post_planning_item(state: State<AppState>, id: i64) -> Result<i64, String> {
    with_db(&state, |db| db.post_planning_item(id))
}

#[derive(Deserialize)]
struct EditPlanningItemReq {
    id: i64,
    scenario: Option<String>,
    title: Option<String>,
    kind: Option<String>,
    amount: Option<String>,
    account: Option<String>,
    to_account: Option<String>,
    category: Option<String>,
    due_on: Option<String>,
    payee: Option<String>,
    note: Option<String>,
    clear_scenario: Option<bool>,
    clear_to_account: Option<bool>,
    clear_category: Option<bool>,
    clear_payee: Option<bool>,
    clear_note: Option<bool>,
}
#[tauri::command]
fn edit_planning_item(state: State<AppState>, req: EditPlanningItemReq) -> Result<(), String> {
    let patch = UpdatePlanningItem {
        id: req.id,
        scenario: req.scenario.filter(|s| !s.trim().is_empty()),
        title: req.title.filter(|s| !s.trim().is_empty()),
        kind: req.kind.as_deref().map(parse_txn_kind).transpose()?,
        amount_cents: req.amount.as_deref().map(parse_cents).transpose()?,
        account: req.account.filter(|s| !s.trim().is_empty()),
        to_account: req.to_account.filter(|s| !s.trim().is_empty()),
        category: req.category.filter(|s| !s.trim().is_empty()),
        due_on: req.due_on.filter(|s| !s.trim().is_empty()),
        payee: req.payee.filter(|s| !s.trim().is_empty()),
        note: req.note.filter(|s| !s.trim().is_empty()),
        clear_scenario: req.clear_scenario.unwrap_or(false),
        clear_to_account: req.clear_to_account.unwrap_or(false),
        clear_category: req.clear_category.unwrap_or(false),
        clear_payee: req.clear_payee.unwrap_or(false),
        clear_note: req.clear_note.unwrap_or(false),
    };
    with_db(&state, |db| db.edit_planning_item(&patch))
}

#[tauri::command]
fn list_scenarios(state: State<AppState>) -> Result<Vec<PlanningScenarioRecord>, String> {
    with_db(&state, |db| db.list_planning_scenarios())
}
#[tauri::command]
fn add_scenario(state: State<AppState>, name: String, note: Option<String>) -> Result<i64, String> {
    let n = note.filter(|s| !s.trim().is_empty());
    with_db(&state, |db| {
        db.add_planning_scenario(&NewPlanningScenario { name, note: n })
    })
}
#[tauri::command]
fn edit_scenario(
    state: State<AppState>,
    id: i64,
    name: Option<String>,
    note: Option<String>,
    clear_note: Option<bool>,
) -> Result<(), String> {
    let patch = UpdatePlanningScenario {
        id,
        name: name.filter(|s| !s.trim().is_empty()),
        note: note.filter(|s| !s.trim().is_empty()),
        clear_note: clear_note.unwrap_or(false),
    };
    with_db(&state, |db| db.edit_planning_scenario(&patch))
}
#[tauri::command]
fn delete_scenario(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.delete_planning_scenario(id))
}

#[derive(Deserialize)]
struct AddGoalReq {
    name: String,
    kind: String,
    account: String,
    target_amount: Option<String>,
    minimum_balance: Option<String>,
    due_on: Option<String>,
}
fn parse_goal_kind(s: &str) -> Result<PlanningGoalKind, String> {
    match s {
        "sinking_fund" => Ok(PlanningGoalKind::SinkingFund),
        "balance_target" => Ok(PlanningGoalKind::BalanceTarget),
        _ => Err("invalid goal kind".into()),
    }
}
#[tauri::command]
fn add_goal(state: State<AppState>, req: AddGoalReq) -> Result<i64, String> {
    let goal = NewPlanningGoal {
        name: req.name,
        kind: parse_goal_kind(&req.kind)?,
        account: req.account,
        target_amount_cents: req
            .target_amount
            .filter(|s| !s.trim().is_empty())
            .map(|s| parse_cents(&s))
            .transpose()?,
        minimum_balance_cents: req
            .minimum_balance
            .filter(|s| !s.trim().is_empty())
            .map(|s| parse_cents(&s))
            .transpose()?,
        due_on: req.due_on.filter(|s| !s.trim().is_empty()),
    };
    with_db(&state, |db| db.add_planning_goal(&goal))
}
#[tauri::command]
fn list_goals(state: State<AppState>) -> Result<Vec<PlanningGoalRecord>, String> {
    with_db(&state, |db| db.list_planning_goals())
}
#[tauri::command]
fn delete_goal(state: State<AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |db| db.delete_planning_goal(id))
}
#[derive(Deserialize)]
struct EditGoalReq {
    id: i64,
    name: Option<String>,
    kind: Option<String>,
    account: Option<String>,
    target_amount: Option<String>,
    minimum_balance: Option<String>,
    due_on: Option<String>,
    clear_target_amount: Option<bool>,
    clear_minimum_balance: Option<bool>,
    clear_due_on: Option<bool>,
}
#[tauri::command]
fn edit_goal(state: State<AppState>, req: EditGoalReq) -> Result<(), String> {
    let patch = UpdatePlanningGoal {
        id: req.id,
        name: req.name.filter(|s| !s.trim().is_empty()),
        kind: req.kind.as_deref().map(parse_goal_kind).transpose()?,
        account: req.account.filter(|s| !s.trim().is_empty()),
        target_amount_cents: req
            .target_amount
            .filter(|s| !s.trim().is_empty())
            .map(|s| parse_cents(&s))
            .transpose()?,
        minimum_balance_cents: req
            .minimum_balance
            .filter(|s| !s.trim().is_empty())
            .map(|s| parse_cents(&s))
            .transpose()?,
        due_on: req.due_on.filter(|s| !s.trim().is_empty()),
        clear_target_amount: req.clear_target_amount.unwrap_or(false),
        clear_minimum_balance: req.clear_minimum_balance.unwrap_or(false),
        clear_due_on: req.clear_due_on.unwrap_or(false),
    };
    with_db(&state, |db| db.edit_planning_goal(&patch))
}

// ---------- Forecast ----------
#[tauri::command]
fn get_forecast(
    state: State<AppState>,
    scenario: Option<String>,
    account: Option<String>,
    days: Option<usize>,
) -> Result<ForecastSnapshot, String> {
    let sc = scenario.filter(|s| !s.trim().is_empty());
    let ac = account.filter(|s| !s.trim().is_empty());
    with_db(&state, |db| {
        db.forecast(sc.as_deref(), ac.as_deref(), days.unwrap_or(90))
    })
}

// ---------- Long-term planning & local financial audit ----------
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn get_fire_snapshot(
    state: State<AppState>,
    safe_withdrawal_rate_percent: Option<f64>,
    stock_allocation_percent: Option<f64>,
    expected_return_percent: Option<f64>,
    inflation_percent: Option<f64>,
    current_age: Option<u32>,
    retirement_age: Option<u32>,
    simulations: Option<u32>,
) -> Result<FireSnapshot, String> {
    with_db(&state, |db| {
        db.fire_snapshot(
            safe_withdrawal_rate_percent.unwrap_or(4.0),
            stock_allocation_percent.unwrap_or(70.0),
            expected_return_percent.unwrap_or(7.0),
            inflation_percent.unwrap_or(3.0),
            current_age.unwrap_or(35),
            retirement_age.unwrap_or(60),
            simulations.unwrap_or(1_000),
        )
    })
}

#[tauri::command]
fn get_financial_audit(state: State<AppState>) -> Result<FinancialAuditSnapshot, String> {
    with_db(&state, |db| db.financial_audit())
}

// ---------- Import / Export ----------
#[tauri::command]
fn list_import_presets() -> Vec<ImportPresetSummary> {
    importer::import_preset_summaries()
}
#[derive(Deserialize)]
struct CsvImportReq {
    path: String,
    account: String,
    preset_id: Option<String>,
    date_column: Option<String>,
    amount_column: Option<String>,
    debit_column: Option<String>,
    credit_column: Option<String>,
    description_column: Option<String>,
    category_column: Option<String>,
    category: Option<String>,
    income_category: Option<String>,
    expense_category: Option<String>,
    payee_column: Option<String>,
    note_column: Option<String>,
    type_column: Option<String>,
    default_kind: Option<String>,
    date_format: Option<String>,
    delimiter: Option<String>,
    dry_run: Option<bool>,
    allow_duplicates: Option<bool>,
}
#[tauri::command]
fn import_csv(state: State<AppState>, req: CsvImportReq) -> Result<ImportResult, String> {
    let preset_id = req.preset_id.filter(|s| !s.trim().is_empty());
    let delimiter = req
        .delimiter
        .as_deref()
        .and_then(|s| s.chars().next())
        .map(|c| c as u8);
    let default_kind = req
        .default_kind
        .as_deref()
        .map(|s| match s {
            "income" => Ok(TransactionKind::Income),
            "expense" => Ok(TransactionKind::Expense),
            _ => Err("invalid default_kind".to_string()),
        })
        .transpose()?;
    let plan_req = importer::CsvImportRequest {
        path: PathBuf::from(req.path),
        account: req.account,
        preset_id,
        date_column: req.date_column.filter(|s| !s.trim().is_empty()),
        amount_column: req.amount_column.filter(|s| !s.trim().is_empty()),
        debit_column: req.debit_column.filter(|s| !s.trim().is_empty()),
        credit_column: req.credit_column.filter(|s| !s.trim().is_empty()),
        description_column: req.description_column.filter(|s| !s.trim().is_empty()),
        category_column: req.category_column.filter(|s| !s.trim().is_empty()),
        category: req.category.filter(|s| !s.trim().is_empty()),
        income_category: req.income_category.filter(|s| !s.trim().is_empty()),
        expense_category: req.expense_category.filter(|s| !s.trim().is_empty()),
        payee_column: req.payee_column.filter(|s| !s.trim().is_empty()),
        note_column: req.note_column.filter(|s| !s.trim().is_empty()),
        type_column: req.type_column.filter(|s| !s.trim().is_empty()),
        default_kind,
        date_format: req.date_format.filter(|s| !s.trim().is_empty()),
        delimiter,
        dry_run: req.dry_run.unwrap_or(false),
        allow_duplicates: req.allow_duplicates.unwrap_or(false),
    };
    let csv_plan = importer::resolve_csv_import_plan(plan_req).map_err(|e| e.to_string())?;
    let import_plan = ImportPlan::Csv(Box::new(csv_plan));
    with_db(&state, |db| db.import_transactions(&import_plan))
}

#[derive(Deserialize)]
struct CamtImportReq {
    path: String,
    account: String,
    income_category: Option<String>,
    expense_category: Option<String>,
    dry_run: Option<bool>,
    allow_duplicates: Option<bool>,
}
#[tauri::command]
fn import_camt053(state: State<AppState>, req: CamtImportReq) -> Result<ImportResult, String> {
    let plan_req = importer::Camt053ImportRequest {
        path: PathBuf::from(req.path),
        account: req.account,
        income_category: req.income_category.filter(|s| !s.trim().is_empty()),
        expense_category: req.expense_category.filter(|s| !s.trim().is_empty()),
        dry_run: req.dry_run.unwrap_or(false),
        allow_duplicates: req.allow_duplicates.unwrap_or(false),
    };
    let camt_plan = importer::resolve_camt053_import_plan(plan_req).map_err(|e| e.to_string())?;
    let import_plan = ImportPlan::Camt053(camt_plan);
    with_db(&state, |db| db.import_transactions(&import_plan))
}

#[derive(Deserialize)]
struct TextImportReq {
    path: String,
    account: String,
    income_category: Option<String>,
    expense_category: Option<String>,
    date_format: Option<String>,
    dry_run: Option<bool>,
    allow_duplicates: Option<bool>,
}

fn text_import_plan(req: TextImportReq) -> Result<model::TextImportPlan, String> {
    importer::resolve_text_import_plan(importer::TextImportRequest {
        path: PathBuf::from(req.path),
        account: req.account,
        income_category: req.income_category,
        expense_category: req.expense_category,
        date_format: req.date_format,
        dry_run: req.dry_run.unwrap_or(false),
        allow_duplicates: req.allow_duplicates.unwrap_or(false),
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn import_ofx(state: State<AppState>, req: TextImportReq) -> Result<ImportResult, String> {
    let plan = ImportPlan::Ofx(text_import_plan(req)?);
    with_db(&state, |db| db.import_transactions(&plan))
}

#[tauri::command]
fn import_qif(state: State<AppState>, req: TextImportReq) -> Result<ImportResult, String> {
    let plan = ImportPlan::Qif(text_import_plan(req)?);
    with_db(&state, |db| db.import_transactions(&plan))
}

#[derive(Deserialize)]
struct CsvMappingReq {
    preset_id: Option<String>,
}
#[tauri::command]
fn csv_mapping_defaults(req: CsvMappingReq) -> Result<serde_json::Value, String> {
    let d = importer::csv_mapping_defaults(req.preset_id.as_deref()).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "preset_id": d.preset_id,
        "date_column": d.date_column,
        "amount_column": d.amount_column,
        "debit_column": d.debit_column,
        "credit_column": d.credit_column,
        "description_column": d.description_column,
        "category_column": d.category_column,
        "payee_column": d.payee_column,
        "note_column": d.note_column,
        "type_column": d.type_column,
        "default_kind": d.default_kind.map(|k| k.as_db_str()),
        "date_format": d.date_format,
        "delimiter": d.delimiter.to_string(),
    }))
}

#[tauri::command]
fn export_transactions_csv(
    state: State<AppState>,
    path: String,
    from: Option<String>,
    to: Option<String>,
    account: Option<String>,
    category: Option<String>,
    req: Option<ListTxnReq>,
) -> Result<usize, String> {
    let filters = if let Some(r) = req {
        TransactionFilters {
            from: r.from.filter(|s| !s.trim().is_empty()),
            to: r.to.filter(|s| !s.trim().is_empty()),
            account: r.account.filter(|s| !s.trim().is_empty()),
            category: r.category.filter(|s| !s.trim().is_empty()),
            kind: r.kind.and_then(|v| TransactionKind::from_str(&v)),
            accounts: r
                .accounts
                .unwrap_or_default()
                .into_iter()
                .filter(|s| !s.trim().is_empty())
                .collect(),
            categories: r
                .categories
                .unwrap_or_default()
                .into_iter()
                .filter(|s| !s.trim().is_empty())
                .collect(),
            kinds: r
                .kinds
                .unwrap_or_default()
                .into_iter()
                .filter_map(|v| TransactionKind::from_str(&v))
                .collect(),
            search: r.search.filter(|s| !s.trim().is_empty()),
            limit: r.limit,
            include_deleted: r.include_deleted.unwrap_or(false),
            sort_by: r
                .sort_by
                .and_then(|v| TransactionSortColumn::from_str(&v)),
            sort_dir: r
                .sort_dir
                .and_then(|v| TransactionSortDirection::from_str(&v)),
        }
    } else {
        TransactionFilters {
            from: from.filter(|s| !s.trim().is_empty()),
            to: to.filter(|s| !s.trim().is_empty()),
            account: account.filter(|s| !s.trim().is_empty()),
            category: category.filter(|s| !s.trim().is_empty()),
            kind: None,
            accounts: vec![],
            categories: vec![],
            kinds: vec![],
            search: None,
            limit: None,
            include_deleted: false,
            sort_by: None,
            sort_dir: None,
        }
    };
    let txns: Vec<TransactionRecord> = with_db(&state, |db| db.list_transactions(&filters))?;
    let mut wtr = csv::Writer::from_path(&path).map_err(|e| e.to_string())?;
    wtr.write_record([
        "id",
        "date",
        "kind",
        "amount",
        "amount_currency",
        "reporting_amount",
        "reporting_currency",
        "account",
        "to_account",
        "category",
        "category_splits",
        "payee",
        "note",
    ])
    .map_err(|e| e.to_string())?;
    let reporting_currency = with_db(&state, |db| db.currency_code())?;
    for t in &txns {
        let splits = with_db(&state, |db| db.list_transaction_splits(t.id))?;
        let split_text = splits
            .iter()
            .map(|split| {
                let native = format!(
                    "{} {}",
                    amount::format_cents(split.amount_cents),
                    t.account_currency_code
                );
                if t.account_currency_code == reporting_currency {
                    format!("{}: {native}", split.category_name)
                } else {
                    format!(
                        "{}: {native} / {} {}",
                        split.category_name,
                        amount::format_cents(split.reporting_amount_cents),
                        reporting_currency
                    )
                }
            })
            .collect::<Vec<_>>()
            .join(" | ");
        wtr.write_record([
            t.id.to_string(),
            t.txn_date.clone(),
            t.kind.as_db_str().to_string(),
            amount::format_cents(t.amount_cents),
            t.account_currency_code.clone(),
            amount::format_cents(t.reporting_amount_cents),
            reporting_currency.clone(),
            t.account_name.clone(),
            t.to_account_name.clone().unwrap_or_default(),
            t.category_name.clone().unwrap_or_default(),
            split_text,
            t.payee.clone().unwrap_or_default(),
            t.note.clone().unwrap_or_default(),
        ])
        .map_err(|e| e.to_string())?;
    }
    wtr.flush().map_err(|e| e.to_string())?;
    Ok(txns.len())
}

#[tauri::command]
fn save_pdf_file(path: String, bytes: Vec<u8>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&p, &bytes).map_err(|e| format!("Failed to write PDF file: {e}"))?;
    Ok(path)
}

#[tauri::command]
async fn backup_data(
    app: AppHandle,
    destination_dir: String,
    operation_id: String,
) -> Result<backup::BackupResult, String> {
    let operation_id = operation_id.trim().to_string();
    if operation_id.is_empty() || operation_id.len() > 128 {
        return Err("Invalid backup operation identifier".into());
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    let committing = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<AppState>();
        let mut active = state
            .active_data_operation
            .lock()
            .map_err(|error| error.to_string())?;
        if active.is_some() {
            return Err("A backup or restore operation is already in progress".into());
        }
        *active = Some(ActiveDataOperation {
            operation_id: operation_id.clone(),
            cancelled: Arc::clone(&cancelled),
            committing: Arc::clone(&committing),
        });
    }

    let worker_app = app.clone();
    let worker_cancelled = Arc::clone(&cancelled);
    let worker_committing = Arc::clone(&committing);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<AppState>();
        backup::create_backup(
            &state,
            &destination_dir,
            &worker_cancelled,
            &worker_committing,
        )
    })
    .await
    .map_err(|error| format!("Backup worker stopped unexpectedly: {error}"))
    .and_then(|result| result);

    let state = app.state::<AppState>();
    let mut active = state
        .active_data_operation
        .lock()
        .map_err(|error| error.to_string())?;
    if active.as_ref().map(|backup| backup.operation_id.as_str()) == Some(operation_id.as_str()) {
        *active = None;
    }
    result
}

#[tauri::command]
async fn inspect_backup(app: AppHandle, backup_dir: String) -> Result<backup::BackupPreview, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<AppState>();
        backup::inspect_backup(&state, &backup_dir)
    })
    .await
    .map_err(|error| format!("Backup inspection stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn restore_data(
    app: AppHandle,
    backup_dir: String,
    operation_id: String,
    confirm_overwrite: bool,
) -> Result<backup::RestoreResult, String> {
    if !confirm_overwrite {
        return Err(
            "Restore requires explicit confirmation that existing data will be overwritten".into(),
        );
    }
    let operation_id = operation_id.trim().to_string();
    if operation_id.is_empty() || operation_id.len() > 128 {
        return Err("Invalid restore operation identifier".into());
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    let committing = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<AppState>();
        let mut active = state
            .active_data_operation
            .lock()
            .map_err(|error| error.to_string())?;
        if active.is_some() {
            return Err("A backup or restore operation is already in progress".into());
        }
        *active = Some(ActiveDataOperation {
            operation_id: operation_id.clone(),
            cancelled: Arc::clone(&cancelled),
            committing: Arc::clone(&committing),
        });
    }

    let worker_app = app.clone();
    let worker_cancelled = Arc::clone(&cancelled);
    let worker_committing = Arc::clone(&committing);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<AppState>();
        backup::restore_backup(
            &state,
            &backup_dir,
            &worker_cancelled,
            &worker_committing,
        )
    })
    .await
    .map_err(|error| format!("Restore worker stopped unexpectedly: {error}"))
    .and_then(|result| result);

    let state = app.state::<AppState>();
    let mut active = state
        .active_data_operation
        .lock()
        .map_err(|error| error.to_string())?;
    if active.as_ref().map(|operation| operation.operation_id.as_str())
        == Some(operation_id.as_str())
    {
        *active = None;
    }
    result
}

#[tauri::command]
fn cancel_data_operation(state: State<AppState>, operation_id: String) -> Result<bool, String> {
    let active = state
        .active_data_operation
        .lock()
        .map_err(|error| error.to_string())?;
    let Some(active) = active.as_ref() else {
        return Ok(false);
    };
    if active.operation_id != operation_id.trim() {
        return Ok(false);
    }
    if active.committing.load(Ordering::Acquire) {
        return Ok(false);
    }
    active.cancelled.store(true, Ordering::Release);
    Ok(true)
}

pub fn run() {
    let initial = resolve_initial_db_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            db_path: Mutex::new(initial),
            database: Mutex::new(None),
            active_data_operation: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_db_path,
            set_db_path,
            needs_init,
            get_currency,
            set_currency,
            get_fx_settings,
            set_fx_default_source,
            save_manual_fx_rate,
            list_manual_fx_rates,
            delete_manual_fx_rate,
            resolve_exchange_rate,
            init_db,
            today_iso,
            list_accounts,
            add_account,
            edit_account,
            delete_account,
            list_categories,
            add_category,
            edit_category,
            delete_category,
            add_transaction,
            edit_transaction,
            delete_transaction,
            restore_transaction,
            bulk_transactions,
            list_transactions,
            recent_transactions,
            list_transaction_splits,
            list_transaction_rules,
            save_transaction_rule,
            delete_transaction_rule,
            apply_transaction_rules,
            undo_rule_application,
            save_credit_debt_settings,
            delete_credit_debt_settings,
            get_debt_optimizer,
            list_credit_debt_settings,
            set_investment_tax_treatment,
            list_investment_tax_settings,
            set_tax_category,
            list_tax_category_settings,
            get_tax_center,
            get_comparative_analytics,
            list_tags,
            list_transaction_tags,
            add_transaction_tag,
            remove_transaction_tag,
            list_transaction_attachments,
            add_transaction_attachment,
            delete_transaction_attachment,
            add_loan,
            edit_loan,
            record_loan_payment,
            list_loans,
            delete_loan,
            add_net_worth_item,
            edit_net_worth_item,
            list_net_worth_items,
            delete_net_worth_item,
            get_net_worth_snapshot,
            get_reporting_balances,
            add_investment_account,
            list_investment_accounts,
            get_investment_account,
            edit_investment_account,
            delete_investment_account,
            add_security,
            list_securities,
            list_holding_lots,
            list_holding_events,
            add_holding_event,
            investment_account_performance,
            portfolio_xirr,
            get_balances,
            get_summary,
            monthly_cash_flow,
            category_spending,
            spending_by_payee,
            list_payees,
            get_payee_snapshot,
            spending_by_tag,
            balance_trend,
            dashboard_snapshot,
            list_reconciliations,
            eligible_reconciliation_txns,
            start_reconciliation,
            delete_reconciliation,
            add_recurring,
            list_recurring,
            pause_recurring,
            resume_recurring,
            delete_recurring,
            run_recurring,
            edit_recurring,
            set_budget,
            set_budget_rollover,
            move_budget_money,
            get_safe_to_spend,
            get_safe_spend_settings,
            save_safe_spend_settings,
            delete_budget,
            list_budgets,
            budget_status,
            add_planning_item,
            list_planning_items,
            delete_planning_item,
            post_planning_item,
            edit_planning_item,
            list_scenarios,
            add_scenario,
            edit_scenario,
            delete_scenario,
            add_goal,
            list_goals,
            delete_goal,
            edit_goal,
            get_forecast,
            get_fire_snapshot,
            get_financial_audit,
            list_import_presets,
            import_csv,
            import_camt053,
            import_ofx,
            import_qif,
            csv_mapping_defaults,
            export_transactions_csv,
            get_balances_as_of,
            get_reporting_balances_as_of,
            list_budget_moves,
            save_pdf_file,
            backup_data,
            inspect_backup,
            restore_data,
            cancel_data_operation
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let data_operation_active = state
                    .active_data_operation
                    .lock()
                    .map(|active| active.is_some())
                    .unwrap_or(true);
                if data_operation_active {
                    api.prevent_close();
                }
            }
        })
        .setup(|app| {
            let win = app.get_webview_window("main").unwrap();
            win.show().unwrap();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running finance tracker");
}
