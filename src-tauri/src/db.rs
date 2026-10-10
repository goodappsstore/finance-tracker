use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{Datelike, Duration, Local, NaiveDate, Weekday as ChronoWeekday};
use directories::ProjectDirs;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use crate::error::{AppError, EntityKind};
use crate::importer::load_import_rows;
use crate::model::{
    Account, AccountKind, AuditFinding, AuditMetric, BalanceRecord, BalanceTrendPoint,
    BillCalendarItem, BudgetMoveRecord, BudgetRecord, BudgetStatusRecord, BulkTransactionResult,
    BulkTransactionSkip, Category, CategoryKind, CategorySpendingPoint,
    ComparativeAnalyticsSnapshot, DashboardSnapshot, DebtAccountSettingRecord, DebtOptimizerSnapshot, FinancialAuditSnapshot,
    FireAssumptions, FireSnapshot, ForecastDailyPoint, ForecastMonthlyPoint, ForecastSelection,
    ForecastSnapshot, GoalStatusRecord, HistoricalStressResult, HoldingEventRecord,
    HoldingLotRecord, ImportPlan, ImportResult, ImportedTransactionRow, InvestmentAccountRecord,
    InvestmentPerformancePoint, InvestmentPerformanceRecord, InvestmentTaxSettingRecord,
    LoanRecord, MonthlyCashFlowPoint, NetWorthItemRecord, NetWorthSnapshot, NewPlanningGoal,
    NewPlanningItem, NewPlanningScenario, NewRecurringRule, NewTransaction, OccurrenceStatus,
    PlanningGoalKind, PlanningGoalRecord, PlanningItemRecord, PlanningScenarioRecord,
    PortfolioSimulation, PortfolioXirrRecord, ReconciliationRecord, RecurringCadence,
    PayeeActivity, PayeeBreakdown, PayeeMonth, PayeeSnapshot, PayeeSummary,
    RecurringOccurrenceRecord, RecurringRuleRecord, RuleApplyResult, SecurityRecord,
    SpendingBreakdownPoint, SummaryRecord, TagRecord, TaxCategorySettingRecord, TaxCenterSnapshot,
    TransactionAttachment, TransactionFilters, TransactionFxInput, TransactionKind,
    TransactionRecord, TransactionRuleInput, TransactionRuleRecord, TransactionSplitInput,
    TransactionSplitRecord, UpdatePlanningGoal, UpdatePlanningItem, UpdatePlanningScenario,
    UpdateRecurringRule, UpdateTransaction, WealthMilestone, WealthProjectionPoint, Weekday,
    WeeklyBalancePoint,
};

pub const CURRENT_SCHEMA_VERSION: i64 = 15;

pub struct Db {
    conn: Connection,
    path: PathBuf,
}

#[derive(Clone, Debug)]
pub(crate) struct StoredTransaction {
    pub(crate) id: i64,
    pub(crate) txn_date: String,
    pub(crate) kind: TransactionKind,
    pub(crate) amount_cents: i64,
    pub(crate) to_amount_cents: Option<i64>,
    pub(crate) reporting_amount_cents: i64,
    pub(crate) exchange_rate: Option<String>,
    pub(crate) exchange_rate_source: Option<String>,
    pub(crate) exchange_rate_date: Option<String>,
    pub(crate) account_id: i64,
    pub(crate) to_account_id: Option<i64>,
    pub(crate) category_id: Option<i64>,
    pub(crate) payee: Option<String>,
    pub(crate) note: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) deleted_at: Option<String>,
    pub(crate) recurring_rule_id: Option<i64>,
}

#[derive(Clone, Debug)]
struct ResolvedTransaction {
    txn_date: String,
    kind: TransactionKind,
    amount_cents: i64,
    account_id: i64,
    to_account_id: Option<i64>,
    category_id: Option<i64>,
    payee: Option<String>,
    note: Option<String>,
    recurring_rule_id: Option<i64>,
}

#[derive(Clone, Debug)]
struct StoredRecurringRule {
    id: i64,
    name: String,
    kind: TransactionKind,
    amount_cents: i64,
    account_id: i64,
    to_account_id: Option<i64>,
    category_id: Option<i64>,
    payee: Option<String>,
    note: Option<String>,
    cadence: RecurringCadence,
    interval: i64,
    day_of_month: Option<u32>,
    weekday: Option<Weekday>,
    start_on: String,
    end_on: Option<String>,
    next_due_on: String,
    paused: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug)]
struct ResolvedRecurringRule {
    name: String,
    kind: TransactionKind,
    amount_cents: i64,
    account_id: i64,
    to_account_id: Option<i64>,
    category_id: Option<i64>,
    payee: Option<String>,
    note: Option<String>,
    cadence: RecurringCadence,
    interval: i64,
    day_of_month: Option<u32>,
    weekday: Option<Weekday>,
    start_on: String,
    end_on: Option<String>,
    next_due_on: String,
}

#[derive(Clone, Debug)]
struct StoredPlanningItem {
    scenario_id: Option<i64>,
    title: String,
    kind: TransactionKind,
    amount_cents: i64,
    account_id: i64,
    to_account_id: Option<i64>,
    category_id: Option<i64>,
    due_on: String,
    payee: Option<String>,
    note: Option<String>,
    linked_transaction_id: Option<i64>,
    archived: bool,
}

#[derive(Clone, Debug)]
struct ResolvedPlanningItem {
    scenario_id: Option<i64>,
    title: String,
    kind: TransactionKind,
    amount_cents: i64,
    account_id: i64,
    to_account_id: Option<i64>,
    category_id: Option<i64>,
    due_on: String,
    payee: Option<String>,
    note: Option<String>,
}

#[derive(Clone, Debug)]
struct StoredPlanningGoal {
    name: String,
    kind: PlanningGoalKind,
    account_id: i64,
    target_amount_cents: Option<i64>,
    minimum_balance_cents: Option<i64>,
    due_on: Option<String>,
    archived: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug)]
struct ForecastEvent {
    inflow_cents: i64,
    outflow_cents: i64,
    per_account_delta: Vec<(i64, i64)>,
}

#[derive(Clone, Debug)]
struct BudgetForecastRow {
    month: String,
    category_name: String,
    account_id: Option<i64>,
    amount_cents: i64,
}

#[derive(Clone, Debug)]
struct RecurringForecastOccurrence {
    rule_id: i64,
    due_on: String,
    rule_name: String,
    kind: TransactionKind,
    amount_cents: i64,
    account_id: i64,
    account_name: String,
    to_account_id: Option<i64>,
    category_id: Option<i64>,
    category_name: Option<String>,
}

mod accounts;
mod advanced;
mod analytics;
mod budgets;
mod categories;
pub mod fx;
mod helpers;
mod imports;
mod paths;
mod payees;
mod planning;
mod portfolio;
mod reconciliation;
mod recurring;
mod reports;
mod safe_spend;
mod schema;
mod schema_sql;
mod transactions;

use helpers::*;
pub use paths::{db_requires_init, resolve_db_path};
use schema_sql::FULL_SCHEMA_SQL;

impl Db {
    pub fn open_existing(path: &Path) -> Result<Self, AppError> {
        if !path.exists() {
            return Err(AppError::missing_db(path));
        }

        let mut db = Self::open(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        if !db.is_initialized()? {
            return Err(AppError::missing_db(path));
        }

        // Recreate missing schema objects before versioned migrations.
        db.conn.execute_batch(FULL_SCHEMA_SQL)?;
        db.repair_schema_if_needed()?;
        db.migrate_if_needed()?;
        db.ensure_indexes()?;
        Ok(db)
    }

    pub fn open_for_init(path: &Path) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        Self::open(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )
    }

    fn open(path: &Path, flags: OpenFlags) -> Result<Self, AppError> {
        let conn = Connection::open_with_flags(path, flags)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        Ok(Self {
            conn,
            path: path.to_path_buf(),
        })
    }

    pub fn init(&self, currency: &str) -> Result<(), AppError> {
        let normalized_currency = normalize_currency_code(currency)?;
        if self.is_initialized()? {
            return Err(AppError::AlreadyExists(
                "database is already initialized".to_string(),
            ));
        }

        self.conn.execute_batch(FULL_SCHEMA_SQL)?;
        self.ensure_indexes()?;
        self.conn.execute(
            "INSERT INTO metadata (id, currency, schema_version, created_at) VALUES (1, ?1, ?2, ?3)",
            params![normalized_currency, CURRENT_SCHEMA_VERSION, now_timestamp()],
        )?;
        Ok(())
    }

    pub fn currency_code(&self) -> Result<String, AppError> {
        self.conn
            .query_row("SELECT currency FROM metadata WHERE id = 1", [], |row| {
                row.get(0)
            })
            .map_err(Into::into)
    }

    pub fn checkpoint_wal(&self) -> Result<(), AppError> {
        let (busy, _log_frames, _checkpointed_frames): (i64, i64, i64) =
            self.conn
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?;
        if busy != 0 {
            return Err(AppError::Validation(
                "The database is busy and could not be prepared for backup".into(),
            ));
        }
        Ok(())
    }

    pub fn with_backup_write_lock<T>(&self, action: impl FnOnce() -> T) -> Result<T, AppError> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let result = action();
        transaction.rollback()?;
        Ok(result)
    }

    pub fn atomic<T>(
        &self,
        action: impl FnOnce(&Self) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let result = action(self)?;
        tx.commit()?;
        Ok(result)
    }
}
// SPDX-License-Identifier: AGPL-3.0-only
