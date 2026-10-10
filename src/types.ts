export type AccountKind = "cash" | "checking" | "savings" | "credit";
export type CategoryKind = "income" | "expense";
export type TransactionKind = "income" | "expense" | "transfer";
export type RecurringCadence = "weekly" | "monthly";
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type PlanningGoalKind = "sinking_fund" | "balance_target";

export interface Account { id:number; name:string; kind:AccountKind; opening_balance_cents:number; currency_code:string; opened_on:string; archived:boolean; }
export interface Category { id:number; name:string; kind:CategoryKind; archived:boolean; }
export interface PayeeSummary { name:string; transaction_count:number; expense_count:number; lifetime_spend_cents:number; last_transaction_on:string; }
export interface PayeeMonth { month:string; spent_cents:number; transaction_count:number; }
export interface PayeeBreakdown { label:string; spent_cents:number; transaction_count:number; }
export interface PayeeActivity { id:number; txn_date:string; kind:TransactionKind; amount_cents:number; account_name:string; category_name:string|null; }
export interface PayeeSnapshot {
  name:string; transaction_count:number; expense_count:number; lifetime_spend_cents:number;
  income_count:number; lifetime_income_cents:number;
  recent_spend_cents:number; previous_spend_cents:number; recent_count:number; previous_count:number;
  recent_median_cents:number|null; previous_median_cents:number|null; price_creep_percent:number|null;
  first_transaction_on:string; last_transaction_on:string;
  monthly:PayeeMonth[]; categories:PayeeBreakdown[]; accounts:PayeeBreakdown[]; recent_activity:PayeeActivity[];
}
export interface TransactionRecord {
  id:number; txn_date:string; kind:TransactionKind; amount_cents:number;
  to_amount_cents:number|null; reporting_amount_cents:number; exchange_rate:string|null; exchange_rate_source:string|null; exchange_rate_date:string|null;
  account_id:number; account_name:string; account_currency_code:string; to_account_id:number|null; to_account_name:string|null; to_account_currency_code:string|null;
  category_id:number|null; category_name:string|null; payee:string|null; note:string|null;
  created_at:string; updated_at:string; deleted_at:string|null;
  reconciliation_id:number|null; recurring_rule_id:number|null;
}
export interface TagRecord { id:number; name:string; transaction_count:number; }
export interface BulkTransactionSkip { transaction_id:number; reason:string; }
export interface BulkTransactionResult { applied_ids:number[]; skipped:BulkTransactionSkip[]; }
export interface TransactionAttachment { id:number; transaction_id:number; file_path:string; label:string; created_at:string; }
export interface LoanRecord { id:number; name:string; lender:string|null; principal_cents:number; outstanding_cents:number; emi_cents:number; annual_rate_bps:number|null; next_due_on:string|null; created_at:string; updated_at:string; }
export interface NetWorthItemRecord { id:number; name:string; kind:"asset"|"liability"; value_cents:number; as_of:string; note:string|null; created_at:string; updated_at:string; }
export interface AddNetWorthItemReq { name:string; kind:"asset"|"liability"; value:string; as_of:string; note?:string|null; }
export interface EditNetWorthItemReq { id:number; name:string; kind:"asset"|"liability"; value:string; as_of:string; note?:string|null; }
export interface InvestmentAccountRecord { id:number; name:string; institution:string|null; value_cents:number; contributed_cents:number; as_of:string; created_at:string; updated_at:string; }
export interface SecurityRecord { id:number; symbol:string; name:string; currency_code:string; created_at:string; updated_at:string; }
export interface HoldingLotRecord {
  id:number; investment_account_id:number; security_id:number; security_symbol:string; security_name:string; security_currency_code:string;
  quantity_micros:number; buy_price_cents:number; reporting_buy_price_cents:number; bought_on:string; created_at:string;
}
export interface HoldingEventRecord {
  id:number; investment_account_id:number; security_id:number; security_symbol:string; event_type:"buy"|"sell"|"dividend"|"price_snapshot"; event_on:string;
  quantity_micros:number|null; price_cents:number|null; reporting_price_cents:number|null; amount_cents:number|null; reporting_amount_cents:number|null; note:string|null; created_at:string;
}
export interface InvestmentPerformancePoint { date:string; value_cents:number; cumulative_return_percent:number; }
export interface InvestmentPerformanceRecord {
  account_id:number; account_name:string; value_cents:number; cost_basis_cents:number; unrealized_gain_cents:number; realized_gain_cents:number;
  time_weighted_return_percent:number|null; points:InvestmentPerformancePoint[];
}
export interface PortfolioXirrRecord { annualized_return_percent:number|null; as_of:string|null; cash_flow_count:number; }
export interface BalanceRecord { account_id:number; account_name:string; account_kind:AccountKind; currency_code:string; current_balance_cents:number; }

export interface FxSettings { reporting_currency:string; default_source:"frankfurter"|"manual"; }
export interface FxRateQuote { base_currency:string; quote_currency:string; requested_on:string; quoted_on:string; rate:string; source:"frankfurter"|"manual"; cached:boolean; stale:boolean; }
export interface ManualFxRate { base_currency:string; quote_currency:string; effective_on:string; rate:string; updated_at:string; }
export interface SummaryRecord { from:string; to:string; account_id:number|null; account_name:string|null; transaction_count:number; income_cents:number; expense_cents:number; net_cents:number; transfer_in_cents:number; transfer_out_cents:number; }
export interface MonthlyCashFlowPoint { month:string; income_cents:number; expense_cents:number; net_cents:number; }
export interface CategorySpendingPoint { category_id:number; category_name:string; spent_cents:number; }
export interface SpendingBreakdownPoint { label:string; spent_cents:number; transaction_count:number; }
export interface BalanceTrendPoint { month:string; balance_cents:number; }
export interface NetWorthSnapshot {
  account_assets_cents:number; investment_assets_cents:number; manual_assets_cents:number;
  loan_liabilities_cents:number; credit_liabilities_cents:number; manual_liabilities_cents:number;
  account_liabilities_cents:number;
  assets_cents:number; liabilities_cents:number; net_worth_cents:number;
  month_over_month_cents:number; trend:BalanceTrendPoint[];
}
export interface FireAssumptions {
  safe_withdrawal_rate_percent:number; stock_allocation_percent:number;
  expected_return_percent:number; inflation_percent:number; real_return_percent:number;
  current_age:number; retirement_age:number; retirement_horizon_years:number;
}
export interface WealthProjectionPoint {
  year:number; age:number; portfolio_cents:number; fire_target_cents:number; annual_contribution_cents:number;
}
export interface PortfolioSimulation {
  trials:number; horizon_years:number; success_rate_percent:number;
  median_ending_balance_cents:number; percentile_10_ending_balance_cents:number; worst_ending_balance_cents:number;
}
export interface HistoricalStressResult {
  name:string; starting_year:number; description:string; survived:boolean;
  minimum_balance_cents:number; ending_balance_cents:number;
}
export interface WealthMilestone {
  kind:string; name:string; target_cents:number; current_cents:number; progress_percent:number;
  estimated_date:string|null; achieved:boolean; detail:string;
}
export interface FireSnapshot {
  as_of:string; history_from:string; history_to:string; history_months:number;
  annual_spending_cents:number; annual_income_cents:number; annual_savings_cents:number; monthly_savings_cents:number;
  fire_number_cents:number; investable_assets_cents:number; current_net_worth_cents:number; debt_cents:number;
  progress_percent:number; projected_fire_date:string|null; years_to_fire:number|null; debt_free_date:string|null;
  assumptions:FireAssumptions; projection:WealthProjectionPoint[]; monte_carlo:PortfolioSimulation;
  stress_tests:HistoricalStressResult[]; milestones:WealthMilestone[]; warnings:string[];
}
export interface AuditMetric {
  key:string; label:string; value:number; display_value:string; score:number;
  status:"healthy"|"watch"|"risk"; explanation:string;
}
export interface AuditFinding {
  kind:string; severity:"high"|"medium"|"low"; title:string; description:string; entity_name:string;
  current_cents:number; baseline_cents:number; change_percent:number|null; transaction_ids:number[]; occurred_on:string|null;
}
export interface FinancialAuditSnapshot {
  as_of:string; quarter_label:string; history_from:string; transaction_count:number; score:number; grade:string;
  metrics:AuditMetric[]; findings:AuditFinding[]; suggestions:string[]; warnings:string[];
}
export interface DashboardSnapshot {
  as_of:string; from:string; to:string; account:{id:number|null; name:string|null};
  summary:SummaryRecord; previous_summary:SummaryRecord;
  balances:BalanceRecord[]; recent_transactions:TransactionRecord[];
  cashflow:MonthlyCashFlowPoint[]; spending:CategorySpendingPoint[]; trend:BalanceTrendPoint[];
  net_worth:NetWorthSnapshot; budget_status:BudgetStatusRecord[];
  forecast:ForecastSnapshot; recurring_due:RecurringRuleRecord[];
}
export interface ReconciliationRecord { id:number; account_id:number; account_name:string; statement_ending_on:string; statement_balance_cents:number; cleared_balance_cents:number; transaction_count:number; created_at:string; }
export interface RecurringRuleRecord {
  id:number; name:string; kind:TransactionKind; amount_cents:number;
  account_id:number; account_name:string; to_account_id:number|null; to_account_name:string|null;
  category_id:number|null; category_name:string|null; payee:string|null; note:string|null;
  cadence:RecurringCadence; interval:number; day_of_month:number|null; weekday:Weekday|null;
  start_on:string; end_on:string|null; next_due_on:string; paused:boolean; created_at:string; updated_at:string;
}
export interface BudgetRecord { id:number; month:string; category_id:number; category_name:string; scenario_id:number|null; scenario_name:string|null; is_override:boolean; account_id:number|null; account_name:string|null; amount_cents:number; created_at:string; updated_at:string; }
export interface BudgetStatusRecord { month:string; category_id:number; category_name:string; scenario_id:number|null; scenario_name:string|null; is_override:boolean; account_id:number|null; account_name:string|null; budget_cents:number; allocated_cents:number; rollover_cents:number; moved_cents:number; rollover_start_month:string|null; spent_cents:number; remaining_cents:number; over_budget:boolean; }
export interface BudgetMoveRecord { id:number; month:string; from_category_id:number; from_category_name:string; to_category_id:number; to_category_name:string; account_id:number|null; account_name:string|null; amount_cents:number; created_at:string; }
export interface PlanningScenarioRecord { id:number; name:string; note:string|null; archived:boolean; created_at:string; updated_at:string; }
export interface PlanningItemRecord {
  id:number; scenario_id:number|null; scenario_name:string|null; title:string; kind:TransactionKind; amount_cents:number;
  account_id:number; account_name:string; to_account_id:number|null; to_account_name:string|null;
  category_id:number|null; category_name:string|null; due_on:string; payee:string|null; note:string|null;
  linked_transaction_id:number|null; archived:boolean; created_at:string; updated_at:string;
}
export interface PlanningGoalRecord { id:number; name:string; kind:PlanningGoalKind; account_id:number; account_name:string; target_amount_cents:number|null; minimum_balance_cents:number|null; due_on:string|null; archived:boolean; created_at:string; updated_at:string; }
export interface ForecastDailyPoint { date:string; opening_balance_cents:number; inflow_cents:number; outflow_cents:number; net_cents:number; closing_balance_cents:number; alerts:string[]; }
export interface ForecastMonthlyPoint { month:string; inflow_cents:number; outflow_cents:number; net_cents:number; ending_balance_cents:number; }
export interface BillCalendarItem { date:string; title:string; source:string; source_id:number|null; kind:TransactionKind; amount_cents:number; account_id:number; account_name:string; category_name:string|null; scenario_name:string|null; linked_transaction_id:number|null; }
export interface GoalStatusRecord {
  id:number; name:string; kind:PlanningGoalKind; account_id:number; account_name:string;
  target_amount_cents:number|null; minimum_balance_cents:number|null; due_on:string|null;
  current_balance_cents:number; projected_balance_cents:number; remaining_cents:number;
  suggested_monthly_contribution_cents:number; on_track:boolean; breach_date:string|null;
}
export interface ForecastSnapshot {
  scenario:{id:number|null; name:string|null}; as_of:string; account:{id:number|null; name:string|null};
  warnings:string[]; alerts:string[]; daily:ForecastDailyPoint[]; monthly:ForecastMonthlyPoint[];
  goal_status:GoalStatusRecord[]; bill_calendar:BillCalendarItem[];
}
export interface ImportPresetSummary { id:string; label:string; verification:"first-party"|"community"; }
export interface ImportedTransactionRow { line_number:number; txn_date:string; kind:TransactionKind; amount_cents:number; account_name:string; category_name:string|null; payee:string|null; note:string|null; duplicate:boolean; }
export interface ImportResult { dry_run:boolean; imported_count:number; duplicate_count:number; preview:ImportedTransactionRow[]; }

export interface SafeSpendSettings {
  payday:string|null; buffer_cents:number; protected_cents:number; account_ids:number[]; configured:boolean; updated_at:string;
}
export interface SafeSpendSnapshot {
  as_of:string; calculated_at:string; payday:string; horizon_source:string; days:number;
  cash_cents:number; scheduled_cents:number; budget_reserve_cents:number; credit_reserve_cents:number;
  protected_cents:number; buffer_cents:number; safe_cents:number; shortfall_cents:number; daily_cents:number;
  latest_transaction_on:string|null; warnings:string[]; settings:SafeSpendSettings;
  commitments:{date:string; title:string; amount_cents:number; account_id:number; category_id:number|null}[];
}

export interface BackupResult {
  source_dir: string;
  target_dir: string;
  folder_name: string;
  copied_files_count: number;
  copied_files: string[];
}

export interface BackupPreview {
  backup_dir: string;
  folder_name: string;
  database_file: string;
  reporting_currency: string;
  schema_version: number;
  file_count: number;
  total_bytes: number;
  created_at: string|null;
}

export interface RestoreResult {
  backup_dir: string;
  restored_files_count: number;
  restored_files: string[];
  warnings: string[];
}

export interface TransactionSplitRecord { id:number; transaction_id:number; line_number:number; category_id:number; category_name:string; amount_cents:number; reporting_amount_cents:number; memo:string|null; }
export interface TransactionRuleRecord { id:number; name:string; priority:number; enabled:boolean; match_field:"payee"|"note"; match_operator:"contains"|"exact"|"starts_with"|"ends_with"; match_value:string; account_id:number|null; account_name:string|null; kind:"income"|"expense"|null; min_amount_cents:number|null; max_amount_cents:number|null; set_payee:string|null; set_category_id:number|null; set_category_name:string|null; append_note:string|null; tags:string[]; stop_processing:boolean; }
export interface RulePreviewRecord { transaction_id:number; txn_date:string; matched_rule_ids:number[]; before_payee:string|null; after_payee:string|null; before_category:string|null; after_category:string|null; before_note:string|null; after_note:string|null; added_tags:string[]; }
export interface RuleApplyResult { run_id:number|null; changed_count:number; skipped_reconciled_count:number; preview:RulePreviewRecord[]; }
export interface DebtItemProjection { key:string; name:string; source:"loan"|"credit"; starting_balance_cents:number; annual_rate_bps:number; minimum_payment_cents:number; payoff_month:string|null; total_interest_cents:number; }
export interface DebtMonthProjection { month:string; payment_cents:number; interest_cents:number; remaining_cents:number; }
export interface DebtStrategyProjection { strategy:"avalanche"|"snowball"; debt_free_month:string|null; total_interest_cents:number; total_paid_cents:number; items:DebtItemProjection[]; monthly:DebtMonthProjection[]; warnings:string[]; }
export interface DebtOptimizerSnapshot { as_of:string; extra_payment_cents:number; avalanche:DebtStrategyProjection; snowball:DebtStrategyProjection; }
export interface DebtAccountSettingRecord { account_id:number; account_name:string; annual_rate_bps:number; minimum_payment_cents:number; }
export interface TaxGainRecord { investment_account_id:number; investment_account_name:string; treatment:"taxable"|"tax_advantaged"|"unknown"; security_symbol:string; sold_on:string; bought_on:string; quantity_micros:number; proceeds_cents:number; cost_basis_cents:number; gain_cents:number; term:"short_term"|"long_term"; }
export interface TaxCenterSnapshot { tax_year:number; realized_proceeds_cents:number; realized_cost_basis_cents:number; short_term_gain_cents:number; long_term_gain_cents:number; gains:TaxGainRecord[]; dividends:{treatment:string;amount_cents:number}[]; deductions:{group:string;amount_cents:number;transaction_count:number}[]; warnings:string[]; }
export interface InvestmentTaxSettingRecord { investment_account_id:number; treatment:"taxable"|"tax_advantaged"|"unknown"; }
export interface TaxCategorySettingRecord { category_id:number; deduction_group:string; }
export interface ComparativeAnalyticsSnapshot { current:SummaryRecord; baseline:SummaryRecord; variances:{dimension:string;label:string;current_cents:number;baseline_cents:number;delta_cents:number;delta_percent:number|null}[]; seasonality:{month_number:number;month_name:string;average_expense_cents:number;index:number;observation_count:number}[]; }
