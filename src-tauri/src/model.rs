use std::path::PathBuf;

use serde::Serialize;

use crate::error::AppError;

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    Cash,
    Checking,
    Savings,
    Credit,
}

impl AccountKind {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            Self::Cash => "cash",
            Self::Checking => "checking",
            Self::Savings => "savings",
            Self::Credit => "credit",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, AppError> {
        match value {
            "cash" => Ok(Self::Cash),
            "checking" => Ok(Self::Checking),
            "savings" => Ok(Self::Savings),
            "credit" => Ok(Self::Credit),
            _ => Err(AppError::Config(format!(
                "unsupported account kind in database: {value}"
            ))),
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CategoryKind {
    Income,
    Expense,
}

impl CategoryKind {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            Self::Income => "income",
            Self::Expense => "expense",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, AppError> {
        match value {
            "income" => Ok(Self::Income),
            "expense" => Ok(Self::Expense),
            _ => Err(AppError::Config(format!(
                "unsupported category kind in database: {value}"
            ))),
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionKind {
    Income,
    Expense,
    Transfer,
}

impl TransactionKind {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            Self::Income => "income",
            Self::Expense => "expense",
            Self::Transfer => "transfer",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, AppError> {
        match value {
            "income" => Ok(Self::Income),
            "expense" => Ok(Self::Expense),
            "transfer" => Ok(Self::Transfer),
            _ => Err(AppError::Config(format!(
                "unsupported transaction kind in database: {value}"
            ))),
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "income" => Some(Self::Income),
            "expense" => Some(Self::Expense),
            "transfer" => Some(Self::Transfer),
            _ => None,
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[allow(dead_code)]
pub enum ImportDefaultKind {
    Income,
    Expense,
}

impl From<ImportDefaultKind> for TransactionKind {
    fn from(value: ImportDefaultKind) -> Self {
        match value {
            ImportDefaultKind::Income => Self::Income,
            ImportDefaultKind::Expense => Self::Expense,
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ExportKind {
    Transactions,
    Summary,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ImportKind {
    Csv,
    Camt053,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecurringCadence {
    Weekly,
    Monthly,
}

impl RecurringCadence {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, AppError> {
        match value {
            "weekly" => Ok(Self::Weekly),
            "monthly" => Ok(Self::Monthly),
            _ => Err(AppError::Config(format!(
                "unsupported recurring cadence in database: {value}"
            ))),
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningGoalKind {
    SinkingFund,
    BalanceTarget,
}

impl PlanningGoalKind {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            Self::SinkingFund => "sinking_fund",
            Self::BalanceTarget => "balance_target",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, AppError> {
        match value {
            "sinking_fund" => Ok(Self::SinkingFund),
            "balance_target" => Ok(Self::BalanceTarget),
            _ => Err(AppError::Config(format!(
                "unsupported planning goal kind in database: {value}"
            ))),
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl Weekday {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            Self::Mon => "mon",
            Self::Tue => "tue",
            Self::Wed => "wed",
            Self::Thu => "thu",
            Self::Fri => "fri",
            Self::Sat => "sat",
            Self::Sun => "sun",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, AppError> {
        match value {
            "mon" => Ok(Self::Mon),
            "tue" => Ok(Self::Tue),
            "wed" => Ok(Self::Wed),
            "thu" => Ok(Self::Thu),
            "fri" => Ok(Self::Fri),
            "sat" => Ok(Self::Sat),
            "sun" => Ok(Self::Sun),
            _ => Err(AppError::Config(format!(
                "unsupported recurring weekday in database: {value}"
            ))),
        }
    }

    #[allow(dead_code)]
    pub fn short_label(&self) -> &'static str {
        match self {
            Self::Mon => "Mon",
            Self::Tue => "Tue",
            Self::Wed => "Wed",
            Self::Thu => "Thu",
            Self::Fri => "Fri",
            Self::Sat => "Sat",
            Self::Sun => "Sun",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OccurrenceStatus {
    Pending,
    Posted,
    Skipped,
}

impl OccurrenceStatus {
    pub fn from_db(value: &str) -> Result<Self, AppError> {
        match value {
            "pending" => Ok(Self::Pending),
            "posted" => Ok(Self::Posted),
            "skipped" => Ok(Self::Skipped),
            _ => Err(AppError::Config(format!(
                "unsupported recurring occurrence status in database: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Account {
    pub id: i64,
    pub name: String,
    pub kind: AccountKind,
    pub opening_balance_cents: i64,
    pub currency_code: String,
    pub opened_on: String,
    pub archived: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub kind: CategoryKind,
    pub archived: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct PayeeSummary {
    pub name: String,
    pub transaction_count: i64,
    pub expense_count: i64,
    pub lifetime_spend_cents: i64,
    pub last_transaction_on: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct PayeeMonth {
    pub month: String,
    pub spent_cents: i64,
    pub transaction_count: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PayeeBreakdown {
    pub label: String,
    pub spent_cents: i64,
    pub transaction_count: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PayeeActivity {
    pub id: i64,
    pub txn_date: String,
    pub kind: TransactionKind,
    pub amount_cents: i64,
    pub account_name: String,
    pub category_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PayeeSnapshot {
    pub name: String,
    pub transaction_count: i64,
    pub expense_count: i64,
    pub lifetime_spend_cents: i64,
    pub income_count: i64,
    pub lifetime_income_cents: i64,
    pub recent_spend_cents: i64,
    pub previous_spend_cents: i64,
    pub recent_count: i64,
    pub previous_count: i64,
    pub recent_median_cents: Option<i64>,
    pub previous_median_cents: Option<i64>,
    pub price_creep_percent: Option<f64>,
    pub first_transaction_on: String,
    pub last_transaction_on: String,
    pub monthly: Vec<PayeeMonth>,
    pub categories: Vec<PayeeBreakdown>,
    pub accounts: Vec<PayeeBreakdown>,
    pub recent_activity: Vec<PayeeActivity>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TransactionRecord {
    pub id: i64,
    pub txn_date: String,
    pub kind: TransactionKind,
    pub amount_cents: i64,
    pub to_amount_cents: Option<i64>,
    pub reporting_amount_cents: i64,
    pub exchange_rate: Option<String>,
    pub exchange_rate_source: Option<String>,
    pub exchange_rate_date: Option<String>,
    pub account_id: i64,
    pub account_name: String,
    pub account_currency_code: String,
    pub to_account_id: Option<i64>,
    pub to_account_name: Option<String>,
    pub to_account_currency_code: Option<String>,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub payee: Option<String>,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub reconciliation_id: Option<i64>,
    pub recurring_rule_id: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TagRecord {
    pub id: i64,
    pub name: String,
    pub transaction_count: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BulkTransactionSkip {
    pub transaction_id: i64,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BulkTransactionResult {
    pub applied_ids: Vec<i64>,
    pub skipped: Vec<BulkTransactionSkip>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TransactionAttachment {
    pub id: i64,
    pub transaction_id: i64,
    pub file_path: String,
    pub label: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LoanRecord {
    pub id: i64,
    pub name: String,
    pub lender: Option<String>,
    pub principal_cents: i64,
    pub outstanding_cents: i64,
    pub emi_cents: i64,
    pub annual_rate_bps: Option<i64>,
    pub next_due_on: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct NetWorthItemRecord {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub value_cents: i64,
    pub as_of: String,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InvestmentAccountRecord {
    pub id: i64,
    pub name: String,
    pub institution: Option<String>,
    pub value_cents: i64,
    pub contributed_cents: i64,
    pub as_of: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SecurityRecord {
    pub id: i64,
    pub symbol: String,
    pub name: String,
    pub currency_code: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct HoldingLotRecord {
    pub id: i64,
    pub investment_account_id: i64,
    pub security_id: i64,
    pub security_symbol: String,
    pub security_name: String,
    pub security_currency_code: String,
    pub quantity_micros: i64,
    pub buy_price_cents: i64,
    pub reporting_buy_price_cents: i64,
    pub bought_on: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct HoldingEventRecord {
    pub id: i64,
    pub investment_account_id: i64,
    pub security_id: i64,
    pub security_symbol: String,
    pub event_type: String,
    pub event_on: String,
    pub quantity_micros: Option<i64>,
    pub price_cents: Option<i64>,
    pub reporting_price_cents: Option<i64>,
    pub amount_cents: Option<i64>,
    pub reporting_amount_cents: Option<i64>,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InvestmentPerformancePoint {
    pub date: String,
    pub value_cents: i64,
    pub cumulative_return_percent: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InvestmentPerformanceRecord {
    pub account_id: i64,
    pub account_name: String,
    pub value_cents: i64,
    pub cost_basis_cents: i64,
    pub unrealized_gain_cents: i64,
    pub realized_gain_cents: i64,
    pub time_weighted_return_percent: Option<f64>,
    pub points: Vec<InvestmentPerformancePoint>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PortfolioXirrRecord {
    pub annualized_return_percent: Option<f64>,
    pub as_of: Option<String>,
    pub cash_flow_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TransactionSplitRecord {
    pub id: i64,
    pub transaction_id: i64,
    pub line_number: i64,
    pub category_id: i64,
    pub category_name: String,
    pub amount_cents: i64,
    pub reporting_amount_cents: i64,
    pub memo: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionSplitInput {
    pub category: String,
    pub amount_cents: i64,
    pub reporting_amount_cents: Option<i64>,
    pub memo: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TransactionRuleRecord {
    pub id: i64,
    pub name: String,
    pub priority: i64,
    pub enabled: bool,
    pub match_field: String,
    pub match_operator: String,
    pub match_value: String,
    pub account_id: Option<i64>,
    pub account_name: Option<String>,
    pub kind: Option<String>,
    pub min_amount_cents: Option<i64>,
    pub max_amount_cents: Option<i64>,
    pub set_payee: Option<String>,
    pub set_category_id: Option<i64>,
    pub set_category_name: Option<String>,
    pub append_note: Option<String>,
    pub tags: Vec<String>,
    pub stop_processing: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionRuleInput {
    pub name: String,
    pub priority: i64,
    pub enabled: bool,
    pub match_field: String,
    pub match_operator: String,
    pub match_value: String,
    pub account: Option<String>,
    pub kind: Option<TransactionKind>,
    pub min_amount_cents: Option<i64>,
    pub max_amount_cents: Option<i64>,
    pub set_payee: Option<String>,
    pub set_category: Option<String>,
    pub append_note: Option<String>,
    pub tags: Vec<String>,
    pub stop_processing: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RulePreviewRecord {
    pub transaction_id: i64,
    pub txn_date: String,
    pub matched_rule_ids: Vec<i64>,
    pub before_payee: Option<String>,
    pub after_payee: Option<String>,
    pub before_category: Option<String>,
    pub after_category: Option<String>,
    pub before_note: Option<String>,
    pub after_note: Option<String>,
    pub added_tags: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RuleApplyResult {
    pub run_id: Option<i64>,
    pub changed_count: usize,
    pub skipped_reconciled_count: usize,
    pub preview: Vec<RulePreviewRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DebtItemProjection {
    pub key: String,
    pub name: String,
    pub source: String,
    pub starting_balance_cents: i64,
    pub annual_rate_bps: i64,
    pub minimum_payment_cents: i64,
    pub payoff_month: Option<String>,
    pub total_interest_cents: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DebtMonthProjection {
    pub month: String,
    pub payment_cents: i64,
    pub interest_cents: i64,
    pub remaining_cents: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DebtStrategyProjection {
    pub strategy: String,
    pub debt_free_month: Option<String>,
    pub total_interest_cents: i64,
    pub total_paid_cents: i64,
    pub items: Vec<DebtItemProjection>,
    pub monthly: Vec<DebtMonthProjection>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DebtOptimizerSnapshot {
    pub as_of: String,
    pub extra_payment_cents: i64,
    pub avalanche: DebtStrategyProjection,
    pub snowball: DebtStrategyProjection,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DebtAccountSettingRecord {
    pub account_id: i64,
    pub account_name: String,
    pub annual_rate_bps: i64,
    pub minimum_payment_cents: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TaxGainRecord {
    pub investment_account_id: i64,
    pub investment_account_name: String,
    pub treatment: String,
    pub security_symbol: String,
    pub sold_on: String,
    pub bought_on: String,
    pub quantity_micros: i64,
    pub proceeds_cents: i64,
    pub cost_basis_cents: i64,
    pub gain_cents: i64,
    pub term: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TaxDeductionRecord {
    pub group: String,
    pub amount_cents: i64,
    pub transaction_count: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TaxDividendRecord {
    pub treatment: String,
    pub amount_cents: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TaxCenterSnapshot {
    pub tax_year: i32,
    pub realized_proceeds_cents: i64,
    pub realized_cost_basis_cents: i64,
    pub short_term_gain_cents: i64,
    pub long_term_gain_cents: i64,
    pub gains: Vec<TaxGainRecord>,
    pub dividends: Vec<TaxDividendRecord>,
    pub deductions: Vec<TaxDeductionRecord>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct InvestmentTaxSettingRecord {
    pub investment_account_id: i64,
    pub treatment: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TaxCategorySettingRecord {
    pub category_id: i64,
    pub deduction_group: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ComparisonVarianceRecord {
    pub dimension: String,
    pub label: String,
    pub current_cents: i64,
    pub baseline_cents: i64,
    pub delta_cents: i64,
    pub delta_percent: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SeasonalityRecord {
    pub month_number: u32,
    pub month_name: String,
    pub average_expense_cents: i64,
    pub index: f64,
    pub observation_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ComparativeAnalyticsSnapshot {
    pub current: SummaryRecord,
    pub baseline: SummaryRecord,
    pub variances: Vec<ComparisonVarianceRecord>,
    pub seasonality: Vec<SeasonalityRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BalanceRecord {
    pub account_id: i64,
    pub account_name: String,
    pub account_kind: AccountKind,
    pub currency_code: String,
    pub current_balance_cents: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SummaryRecord {
    pub from: String,
    pub to: String,
    pub account_id: Option<i64>,
    pub account_name: Option<String>,
    pub transaction_count: i64,
    pub income_cents: i64,
    pub expense_cents: i64,
    pub net_cents: i64,
    pub transfer_in_cents: i64,
    pub transfer_out_cents: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ReconciliationRecord {
    pub id: i64,
    pub account_id: i64,
    pub account_name: String,
    pub statement_ending_on: String,
    pub statement_balance_cents: i64,
    pub cleared_balance_cents: i64,
    pub transaction_count: i64,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RecurringRuleRecord {
    pub id: i64,
    pub name: String,
    pub kind: TransactionKind,
    pub amount_cents: i64,
    pub account_id: i64,
    pub account_name: String,
    pub to_account_id: Option<i64>,
    pub to_account_name: Option<String>,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub payee: Option<String>,
    pub note: Option<String>,
    pub cadence: RecurringCadence,
    pub interval: i64,
    pub day_of_month: Option<u32>,
    pub weekday: Option<Weekday>,
    pub start_on: String,
    pub end_on: Option<String>,
    pub next_due_on: String,
    pub paused: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RecurringOccurrenceRecord {
    pub id: i64,
    pub rule_id: i64,
    pub rule_name: String,
    pub due_on: String,
    pub transaction_id: Option<i64>,
    pub status: OccurrenceStatus,
    pub kind: TransactionKind,
    pub amount_cents: i64,
    pub account_name: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BudgetRecord {
    pub id: i64,
    pub month: String,
    pub category_id: i64,
    pub category_name: String,
    pub scenario_id: Option<i64>,
    pub scenario_name: Option<String>,
    pub is_override: bool,
    pub account_id: Option<i64>,
    pub account_name: Option<String>,
    pub amount_cents: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BudgetStatusRecord {
    pub month: String,
    pub category_id: i64,
    pub category_name: String,
    pub scenario_id: Option<i64>,
    pub scenario_name: Option<String>,
    pub is_override: bool,
    pub account_id: Option<i64>,
    pub account_name: Option<String>,
    pub budget_cents: i64,
    pub allocated_cents: i64,
    pub rollover_cents: i64,
    pub moved_cents: i64,
    pub rollover_start_month: Option<String>,
    pub spent_cents: i64,
    pub remaining_cents: i64,
    pub over_budget: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BudgetMoveRecord {
    pub id: i64,
    pub month: String,
    pub from_category_id: i64,
    pub from_category_name: String,
    pub to_category_id: i64,
    pub to_category_name: String,
    pub account_id: Option<i64>,
    pub account_name: Option<String>,
    pub amount_cents: i64,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PlanningItemRecord {
    pub id: i64,
    pub scenario_id: Option<i64>,
    pub scenario_name: Option<String>,
    pub title: String,
    pub kind: TransactionKind,
    pub amount_cents: i64,
    pub account_id: i64,
    pub account_name: String,
    pub to_account_id: Option<i64>,
    pub to_account_name: Option<String>,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub due_on: String,
    pub payee: Option<String>,
    pub note: Option<String>,
    pub linked_transaction_id: Option<i64>,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PlanningScenarioRecord {
    pub id: i64,
    pub name: String,
    pub note: Option<String>,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PlanningGoalRecord {
    pub id: i64,
    pub name: String,
    pub kind: PlanningGoalKind,
    pub account_id: i64,
    pub account_name: String,
    pub target_amount_cents: Option<i64>,
    pub minimum_balance_cents: Option<i64>,
    pub due_on: Option<String>,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ForecastSelection {
    pub id: Option<i64>,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ForecastDailyPoint {
    pub date: String,
    pub opening_balance_cents: i64,
    pub inflow_cents: i64,
    pub outflow_cents: i64,
    pub net_cents: i64,
    pub closing_balance_cents: i64,
    pub alerts: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ForecastMonthlyPoint {
    pub month: String,
    pub inflow_cents: i64,
    pub outflow_cents: i64,
    pub net_cents: i64,
    pub ending_balance_cents: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BillCalendarItem {
    pub date: String,
    pub title: String,
    pub source: String,
    pub source_id: Option<i64>,
    pub kind: TransactionKind,
    pub amount_cents: i64,
    pub account_id: i64,
    pub account_name: String,
    pub category_name: Option<String>,
    pub scenario_name: Option<String>,
    pub linked_transaction_id: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct GoalStatusRecord {
    pub id: i64,
    pub name: String,
    pub kind: PlanningGoalKind,
    pub account_id: i64,
    pub account_name: String,
    pub target_amount_cents: Option<i64>,
    pub minimum_balance_cents: Option<i64>,
    pub due_on: Option<String>,
    pub current_balance_cents: i64,
    pub projected_balance_cents: i64,
    pub remaining_cents: i64,
    pub suggested_monthly_contribution_cents: i64,
    pub on_track: bool,
    pub breach_date: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ForecastSnapshot {
    pub scenario: ForecastSelection,
    pub as_of: String,
    pub account: ForecastSelection,
    pub warnings: Vec<String>,
    pub alerts: Vec<String>,
    pub daily: Vec<ForecastDailyPoint>,
    pub monthly: Vec<ForecastMonthlyPoint>,
    pub goal_status: Vec<GoalStatusRecord>,
    pub bill_calendar: Vec<BillCalendarItem>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct MonthlyCashFlowPoint {
    pub month: String,
    pub income_cents: i64,
    pub expense_cents: i64,
    pub net_cents: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CategorySpendingPoint {
    pub category_id: i64,
    pub category_name: String,
    pub spent_cents: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SpendingBreakdownPoint {
    pub label: String,
    pub spent_cents: i64,
    pub transaction_count: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BalanceTrendPoint {
    pub month: String,
    pub balance_cents: i64,
}

/// All of the read models required by the home dashboard.  Keeping this
/// response together lets the UI render one consistent view of the ledger
/// instead of stitching together values observed at different times.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DashboardSnapshot {
    pub as_of: String,
    pub from: String,
    pub to: String,
    pub account: ForecastSelection,
    pub summary: SummaryRecord,
    pub previous_summary: SummaryRecord,
    pub balances: Vec<BalanceRecord>,
    pub recent_transactions: Vec<TransactionRecord>,
    pub cashflow: Vec<MonthlyCashFlowPoint>,
    pub spending: Vec<CategorySpendingPoint>,
    pub trend: Vec<BalanceTrendPoint>,
    pub net_worth: NetWorthSnapshot,
    pub budget_status: Vec<BudgetStatusRecord>,
    pub forecast: ForecastSnapshot,
    pub recurring_due: Vec<RecurringRuleRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct NetWorthSnapshot {
    pub account_assets_cents: i64,
    pub investment_assets_cents: i64,
    pub manual_assets_cents: i64,
    pub loan_liabilities_cents: i64,
    pub credit_liabilities_cents: i64,
    pub manual_liabilities_cents: i64,
    pub account_liabilities_cents: i64,
    pub assets_cents: i64,
    pub liabilities_cents: i64,
    pub net_worth_cents: i64,
    pub month_over_month_cents: i64,
    pub trend: Vec<BalanceTrendPoint>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FireAssumptions {
    pub safe_withdrawal_rate_percent: f64,
    pub stock_allocation_percent: f64,
    pub expected_return_percent: f64,
    pub inflation_percent: f64,
    pub real_return_percent: f64,
    pub current_age: u32,
    pub retirement_age: u32,
    pub retirement_horizon_years: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WealthProjectionPoint {
    pub year: i32,
    pub age: u32,
    pub portfolio_cents: i64,
    pub fire_target_cents: i64,
    pub annual_contribution_cents: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PortfolioSimulation {
    pub trials: u32,
    pub horizon_years: u32,
    pub success_rate_percent: f64,
    pub median_ending_balance_cents: i64,
    pub percentile_10_ending_balance_cents: i64,
    pub worst_ending_balance_cents: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HistoricalStressResult {
    pub name: String,
    pub starting_year: i32,
    pub description: String,
    pub survived: bool,
    pub minimum_balance_cents: i64,
    pub ending_balance_cents: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WealthMilestone {
    pub kind: String,
    pub name: String,
    pub target_cents: i64,
    pub current_cents: i64,
    pub progress_percent: f64,
    pub estimated_date: Option<String>,
    pub achieved: bool,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FireSnapshot {
    pub as_of: String,
    pub history_from: String,
    pub history_to: String,
    pub history_months: u32,
    pub annual_spending_cents: i64,
    pub annual_income_cents: i64,
    pub annual_savings_cents: i64,
    pub monthly_savings_cents: i64,
    pub fire_number_cents: i64,
    pub investable_assets_cents: i64,
    pub current_net_worth_cents: i64,
    pub debt_cents: i64,
    pub progress_percent: f64,
    pub projected_fire_date: Option<String>,
    pub years_to_fire: Option<f64>,
    pub debt_free_date: Option<String>,
    pub assumptions: FireAssumptions,
    pub projection: Vec<WealthProjectionPoint>,
    pub monte_carlo: PortfolioSimulation,
    pub stress_tests: Vec<HistoricalStressResult>,
    pub milestones: Vec<WealthMilestone>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AuditMetric {
    pub key: String,
    pub label: String,
    pub value: f64,
    pub display_value: String,
    pub score: u32,
    pub status: String,
    pub explanation: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AuditFinding {
    pub kind: String,
    pub severity: String,
    pub title: String,
    pub description: String,
    pub entity_name: String,
    pub current_cents: i64,
    pub baseline_cents: i64,
    pub change_percent: Option<f64>,
    pub transaction_ids: Vec<i64>,
    pub occurred_on: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FinancialAuditSnapshot {
    pub as_of: String,
    pub quarter_label: String,
    pub history_from: String,
    pub transaction_count: i64,
    pub score: u32,
    pub grade: String,
    pub metrics: Vec<AuditMetric>,
    pub findings: Vec<AuditFinding>,
    pub suggestions: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[allow(dead_code)]
pub struct WeeklyBalancePoint {
    pub week_start: String,
    pub opening_balance_cents: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ImportedTransactionRow {
    pub line_number: usize,
    pub txn_date: String,
    pub kind: TransactionKind,
    pub amount_cents: i64,
    pub account_name: String,
    pub category_name: Option<String>,
    pub payee: Option<String>,
    pub note: Option<String>,
    pub duplicate: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ImportResult {
    pub dry_run: bool,
    pub imported_count: usize,
    pub duplicate_count: usize,
    pub preview: Vec<ImportedTransactionRow>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransactionSortColumn {
    Id,
    Date,
    Amount,
    Account,
    Category,
    Payee,
    Kind,
    CreatedAt,
}

impl TransactionSortColumn {
    pub fn from_str(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "id" | "transaction_id" => Some(Self::Id),
            "date" | "txn_date" => Some(Self::Date),
            "amount" | "amount_cents" => Some(Self::Amount),
            "account" | "account_name" => Some(Self::Account),
            "category" | "category_name" => Some(Self::Category),
            "payee" => Some(Self::Payee),
            "kind" | "type" => Some(Self::Kind),
            "created_at" => Some(Self::CreatedAt),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransactionSortDirection {
    Asc,
    Desc,
}

impl TransactionSortDirection {
    pub fn from_str(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "asc" | "ascending" => Some(Self::Asc),
            "desc" | "descending" => Some(Self::Desc),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionFilters {
    pub from: Option<String>,
    pub to: Option<String>,
    pub account: Option<String>,
    pub category: Option<String>,
    pub kind: Option<TransactionKind>,
    pub accounts: Vec<String>,
    pub categories: Vec<String>,
    pub kinds: Vec<TransactionKind>,
    pub search: Option<String>,
    pub limit: Option<usize>,
    pub include_deleted: bool,
    pub sort_by: Option<TransactionSortColumn>,
    pub sort_dir: Option<TransactionSortDirection>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NewTransaction {
    pub txn_date: String,
    pub kind: TransactionKind,
    pub amount_cents: i64,
    pub account: String,
    pub to_account: Option<String>,
    pub category: Option<String>,
    pub payee: Option<String>,
    pub note: Option<String>,
    pub recurring_rule_id: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateTransaction {
    pub id: i64,
    pub txn_date: Option<String>,
    pub kind: Option<TransactionKind>,
    pub amount_cents: Option<i64>,
    pub account: Option<String>,
    pub to_account: Option<String>,
    pub category: Option<String>,
    pub payee: Option<String>,
    pub note: Option<String>,
    pub clear_to_account: bool,
    pub clear_category: bool,
    pub clear_payee: bool,
    pub clear_note: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionFxInput {
    pub to_amount_cents: Option<i64>,
    pub reporting_amount_cents: i64,
    pub exchange_rate: Option<String>,
    pub exchange_rate_source: Option<String>,
    pub exchange_rate_date: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NewRecurringRule {
    pub name: String,
    pub kind: TransactionKind,
    pub amount_cents: i64,
    pub account: String,
    pub to_account: Option<String>,
    pub category: Option<String>,
    pub payee: Option<String>,
    pub note: Option<String>,
    pub cadence: RecurringCadence,
    pub interval: i64,
    pub day_of_month: Option<u32>,
    pub weekday: Option<Weekday>,
    pub start_on: String,
    pub next_due_on: Option<String>,
    pub end_on: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NewPlanningItem {
    pub scenario: Option<String>,
    pub title: String,
    pub kind: TransactionKind,
    pub amount_cents: i64,
    pub account: String,
    pub to_account: Option<String>,
    pub category: Option<String>,
    pub due_on: String,
    pub payee: Option<String>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdatePlanningItem {
    pub id: i64,
    pub scenario: Option<String>,
    pub title: Option<String>,
    pub kind: Option<TransactionKind>,
    pub amount_cents: Option<i64>,
    pub account: Option<String>,
    pub to_account: Option<String>,
    pub category: Option<String>,
    pub due_on: Option<String>,
    pub payee: Option<String>,
    pub note: Option<String>,
    pub clear_scenario: bool,
    pub clear_to_account: bool,
    pub clear_category: bool,
    pub clear_payee: bool,
    pub clear_note: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NewPlanningScenario {
    pub name: String,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdatePlanningScenario {
    pub id: i64,
    pub name: Option<String>,
    pub note: Option<String>,
    pub clear_note: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NewPlanningGoal {
    pub name: String,
    pub kind: PlanningGoalKind,
    pub account: String,
    pub target_amount_cents: Option<i64>,
    pub minimum_balance_cents: Option<i64>,
    pub due_on: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdatePlanningGoal {
    pub id: i64,
    pub name: Option<String>,
    pub kind: Option<PlanningGoalKind>,
    pub account: Option<String>,
    pub target_amount_cents: Option<i64>,
    pub minimum_balance_cents: Option<i64>,
    pub due_on: Option<String>,
    pub clear_target_amount: bool,
    pub clear_minimum_balance: bool,
    pub clear_due_on: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateRecurringRule {
    pub id: i64,
    pub name: Option<String>,
    pub kind: Option<TransactionKind>,
    pub amount_cents: Option<i64>,
    pub account: Option<String>,
    pub to_account: Option<String>,
    pub category: Option<String>,
    pub payee: Option<String>,
    pub note: Option<String>,
    pub cadence: Option<RecurringCadence>,
    pub interval: Option<i64>,
    pub day_of_month: Option<u32>,
    pub weekday: Option<Weekday>,
    pub start_on: Option<String>,
    pub next_due_on: Option<String>,
    pub end_on: Option<String>,
    pub clear_to_account: bool,
    pub clear_category: bool,
    pub clear_payee: bool,
    pub clear_note: bool,
    pub clear_day_of_month: bool,
    pub clear_weekday: bool,
    pub clear_next_due_on: bool,
    pub clear_end_on: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportColumn {
    pub name: String,
    pub aliases: Vec<String>,
}

impl ImportColumn {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            aliases: Vec::new(),
        }
    }

    pub fn with_aliases(
        name: impl Into<String>,
        aliases: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            name: name.into(),
            aliases: aliases.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CsvAmountStrategy {
    Signed {
        amount_column: ImportColumn,
    },
    Split {
        debit_column: ImportColumn,
        credit_column: ImportColumn,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CsvImportPlan {
    pub path: PathBuf,
    pub account: String,
    pub preset_id: Option<String>,
    pub date_column: ImportColumn,
    pub amount_strategy: CsvAmountStrategy,
    pub description_column: ImportColumn,
    pub category_column: Option<ImportColumn>,
    pub category: Option<String>,
    pub income_category: Option<String>,
    pub expense_category: Option<String>,
    pub payee_column: Option<ImportColumn>,
    pub note_column: Option<ImportColumn>,
    pub type_column: Option<ImportColumn>,
    pub default_kind: Option<TransactionKind>,
    pub date_format: String,
    pub delimiter: u8,
    pub dry_run: bool,
    pub allow_duplicates: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Camt053ImportPlan {
    pub path: PathBuf,
    pub account: String,
    pub income_category: Option<String>,
    pub expense_category: Option<String>,
    pub dry_run: bool,
    pub allow_duplicates: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextImportPlan {
    pub path: PathBuf,
    pub account: String,
    pub income_category: Option<String>,
    pub expense_category: Option<String>,
    pub date_format: Option<String>,
    pub dry_run: bool,
    pub allow_duplicates: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ImportPlan {
    Csv(Box<CsvImportPlan>),
    Camt053(Camt053ImportPlan),
    Ofx(TextImportPlan),
    Qif(TextImportPlan),
}

impl ImportPlan {
    pub fn account(&self) -> &str {
        match self {
            Self::Csv(plan) => &plan.account,
            Self::Camt053(plan) => &plan.account,
            Self::Ofx(plan) | Self::Qif(plan) => &plan.account,
        }
    }

    pub fn path(&self) -> &std::path::Path {
        match self {
            Self::Csv(plan) => plan.path.as_path(),
            Self::Camt053(plan) => plan.path.as_path(),
            Self::Ofx(plan) | Self::Qif(plan) => plan.path.as_path(),
        }
    }

    pub fn dry_run(&self) -> bool {
        match self {
            Self::Csv(plan) => plan.dry_run,
            Self::Camt053(plan) => plan.dry_run,
            Self::Ofx(plan) | Self::Qif(plan) => plan.dry_run,
        }
    }

    pub fn allow_duplicates(&self) -> bool {
        match self {
            Self::Csv(plan) => plan.allow_duplicates,
            Self::Camt053(plan) => plan.allow_duplicates,
            Self::Ofx(plan) | Self::Qif(plan) => plan.allow_duplicates,
        }
    }

    #[allow(dead_code)]
    pub fn set_dry_run(&mut self, dry_run: bool) {
        match self {
            Self::Csv(plan) => plan.dry_run = dry_run,
            Self::Camt053(plan) => plan.dry_run = dry_run,
            Self::Ofx(plan) | Self::Qif(plan) => plan.dry_run = dry_run,
        }
    }

    pub fn default_category_for_kind(&self, kind: TransactionKind) -> Option<&str> {
        match self {
            Self::Csv(plan) => match kind {
                TransactionKind::Income => {
                    plan.income_category.as_deref().or(plan.category.as_deref())
                }
                TransactionKind::Expense => plan
                    .expense_category
                    .as_deref()
                    .or(plan.category.as_deref()),
                TransactionKind::Transfer => None,
            },
            Self::Camt053(plan) => match kind {
                TransactionKind::Income => plan.income_category.as_deref(),
                TransactionKind::Expense => plan.expense_category.as_deref(),
                TransactionKind::Transfer => None,
            },
            Self::Ofx(plan) | Self::Qif(plan) => match kind {
                TransactionKind::Income => plan.income_category.as_deref(),
                TransactionKind::Expense => plan.expense_category.as_deref(),
                TransactionKind::Transfer => None,
            },
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportPresetVerification {
    FirstParty,
    Community,
}

impl ImportPresetVerification {
    #[allow(dead_code)]
    pub fn as_label(&self) -> &'static str {
        match self {
            Self::FirstParty => "first-party",
            Self::Community => "community",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ImportPresetSummary {
    pub id: String,
    pub label: String,
    pub verification: ImportPresetVerification,
}
// SPDX-License-Identifier: AGPL-3.0-only

#[derive(Clone, Debug, Serialize)]
pub struct SafeSpendSettings {
    pub payday: Option<String>,
    pub buffer_cents: i64,
    pub protected_cents: i64,
    pub account_ids: Vec<i64>,
    pub configured: bool,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SafeSpendCommitment {
    pub date: String,
    pub title: String,
    pub amount_cents: i64,
    pub account_id: i64,
    pub category_id: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SafeSpendSnapshot {
    pub as_of: String,
    pub calculated_at: String,
    pub payday: String,
    pub horizon_source: String,
    pub days: i64,
    pub cash_cents: i64,
    pub scheduled_cents: i64,
    pub budget_reserve_cents: i64,
    pub credit_reserve_cents: i64,
    pub protected_cents: i64,
    pub buffer_cents: i64,
    pub safe_cents: i64,
    pub shortfall_cents: i64,
    pub daily_cents: i64,
    pub latest_transaction_on: Option<String>,
    pub warnings: Vec<String>,
    pub commitments: Vec<SafeSpendCommitment>,
    pub settings: SafeSpendSettings,
}
