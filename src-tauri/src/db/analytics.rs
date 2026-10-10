use super::*;

const RETIREMENT_HORIZON_YEARS: u32 = 30;

#[derive(Clone, Debug)]
struct LoanPayoffSummary {
    total_principal_cents: i64,
    total_emi_cents: i64,
    payoff_months: Option<u32>,
    mortgage_principal_cents: i64,
    mortgage_outstanding_cents: i64,
    mortgage_payoff_months: Option<u32>,
}

#[derive(Clone, Debug)]
struct CreepRow {
    name: String,
    previous_cents: i64,
    current_cents: i64,
    previous_count: i64,
    current_count: i64,
}

impl Db {
    #[allow(clippy::too_many_arguments)]
    pub fn fire_snapshot(
        &self,
        safe_withdrawal_rate_percent: f64,
        stock_allocation_percent: f64,
        expected_return_percent: f64,
        inflation_percent: f64,
        current_age: u32,
        retirement_age: u32,
        simulations: u32,
    ) -> Result<FireSnapshot, AppError> {
        validate_percent(
            "Safe withdrawal rate",
            safe_withdrawal_rate_percent,
            2.0,
            6.0,
        )?;
        validate_percent("Stock allocation", stock_allocation_percent, 0.0, 100.0)?;
        validate_percent("Expected return", expected_return_percent, -5.0, 20.0)?;
        validate_percent("Inflation", inflation_percent, 0.0, 15.0)?;
        if !(18..=100).contains(&current_age) {
            return Err(AppError::field_validation(
                "Current age",
                "must be between 18 and 100",
            ));
        }
        if retirement_age < current_age || retirement_age > 110 {
            return Err(AppError::field_validation(
                "Retirement age",
                "must be between your current age and 110",
            ));
        }

        let simulations = simulations.clamp(250, 5_000);
        let today = Local::now().date_naive();
        let year_ago = today - Duration::days(364);
        let earliest: Option<String> = self.conn.query_row(
            "SELECT MIN(txn_date) FROM transactions WHERE deleted_at IS NULL AND txn_date <= ?1",
            params![today.to_string()],
            |row| row.get(0),
        )?;
        let history_start = earliest
            .as_deref()
            .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
            .map(|date| date.max(year_ago))
            .unwrap_or(year_ago);
        let observed_days = (today - history_start).num_days().max(0) + 1;
        let history_months_f64 = (observed_days as f64 / 30.4375).clamp(1.0, 12.0);
        let (observed_income, observed_spending, transaction_count): (i64, i64, i64) =
            self.conn.query_row(
                "SELECT
                    COALESCE(SUM(CASE WHEN kind = 'income' THEN reporting_amount_cents ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'expense' THEN reporting_amount_cents ELSE 0 END), 0),
                    COUNT(*)
                 FROM transactions
                 WHERE deleted_at IS NULL AND txn_date BETWEEN ?1 AND ?2",
                params![history_start.to_string(), today.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        let annualization = 12.0 / history_months_f64;
        let annual_income_cents = money(observed_income as f64 * annualization);
        let annual_spending_cents = money(observed_spending as f64 * annualization);
        let annual_savings_cents = annual_income_cents - annual_spending_cents;
        let monthly_savings_cents = annual_savings_cents / 12;
        let fire_number_cents = if annual_spending_cents > 0 {
            money(annual_spending_cents as f64 / (safe_withdrawal_rate_percent / 100.0))
        } else {
            0
        };

        let net_worth = self.net_worth_snapshot()?;
        let investable_assets_cents =
            (net_worth.account_assets_cents + net_worth.investment_assets_cents).max(0);
        let debt_cents = net_worth.liabilities_cents.max(0);
        let loan_payoff = self.loan_payoff_summary()?;
        let real_return_percent = expected_return_percent - inflation_percent;
        let real_monthly_return = (1.0 + real_return_percent / 100.0)
            .max(0.01)
            .powf(1.0 / 12.0)
            - 1.0;

        let projection_months = (fire_number_cents > 0)
            .then(|| {
                project_months_to_target(
                    investable_assets_cents,
                    fire_number_cents,
                    monthly_savings_cents,
                    loan_payoff.total_emi_cents,
                    loan_payoff.payoff_months,
                    real_monthly_return,
                    1_200,
                )
            })
            .flatten();
        let projected_fire_date = projection_months.map(|months| add_months(today, months));
        let years_to_fire = projection_months.map(|months| round1(months as f64 / 12.0));
        let debt_free_date = if debt_cents == 0 {
            Some(today.to_string())
        } else if debt_cents == net_worth.loan_liabilities_cents {
            loan_payoff
                .payoff_months
                .map(|months| add_months(today, months))
        } else {
            None
        };

        let assumptions = FireAssumptions {
            safe_withdrawal_rate_percent,
            stock_allocation_percent,
            expected_return_percent,
            inflation_percent,
            real_return_percent,
            current_age,
            retirement_age,
            retirement_horizon_years: RETIREMENT_HORIZON_YEARS,
        };
        let projection = build_wealth_projection(
            today,
            investable_assets_cents,
            fire_number_cents,
            monthly_savings_cents,
            loan_payoff.total_emi_cents,
            loan_payoff.payoff_months,
            real_monthly_return,
            current_age,
        );
        let retirement_portfolio_cents = projection
            .iter()
            .find(|point| point.portfolio_cents >= fire_number_cents && fire_number_cents > 0)
            .map(|point| point.portfolio_cents)
            .unwrap_or(investable_assets_cents.max(fire_number_cents));
        let monte_carlo = monte_carlo(
            retirement_portfolio_cents,
            annual_spending_cents,
            stock_allocation_percent,
            inflation_percent,
            simulations,
            RETIREMENT_HORIZON_YEARS,
        );
        let stress_tests = historical_stress_tests(
            retirement_portfolio_cents,
            annual_spending_cents,
            stock_allocation_percent,
            inflation_percent,
        );
        let milestones = build_milestones(
            today,
            &net_worth,
            investable_assets_cents,
            fire_number_cents,
            monthly_savings_cents,
            loan_payoff.total_emi_cents,
            loan_payoff.payoff_months,
            real_monthly_return,
            current_age,
            retirement_age,
            debt_free_date.clone(),
            &loan_payoff,
        );

        let mut warnings = Vec::new();
        if transaction_count == 0 || observed_spending == 0 {
            warnings.push(
                "No historical expense data is available, so a FIRE target cannot be estimated yet."
                    .to_string(),
            );
        } else if history_months_f64 < 11.5 {
            warnings.push(format!(
                "Only {:.1} months of history are available; income and spending were annualized.",
                history_months_f64
            ));
        }
        if annual_savings_cents <= 0 && investable_assets_cents < fire_number_cents {
            warnings.push(
                "Recent spending is at or above income, so the current trajectory does not reach the FIRE target."
                    .to_string(),
            );
        }
        if debt_cents > net_worth.loan_liabilities_cents {
            warnings.push(
                "A debt-free date is unavailable because credit, overdraft, or manually tracked debt has no payment schedule."
                    .to_string(),
            );
        }
        warnings.push(
            "Monte Carlo and stress results are planning estimates in today's money; taxes, fees, and asset-specific holdings are not modeled."
                .to_string(),
        );

        Ok(FireSnapshot {
            as_of: today.to_string(),
            history_from: history_start.to_string(),
            history_to: today.to_string(),
            history_months: history_months_f64.ceil() as u32,
            annual_spending_cents,
            annual_income_cents,
            annual_savings_cents,
            monthly_savings_cents,
            fire_number_cents,
            investable_assets_cents,
            current_net_worth_cents: net_worth.net_worth_cents,
            debt_cents,
            progress_percent: progress(investable_assets_cents, fire_number_cents),
            projected_fire_date,
            years_to_fire,
            debt_free_date,
            assumptions,
            projection,
            monte_carlo,
            stress_tests,
            milestones,
            warnings,
        })
    }

    pub fn financial_audit(&self) -> Result<FinancialAuditSnapshot, AppError> {
        let today = Local::now().date_naive();
        let trailing_year = today - Duration::days(364);
        let quarter_start = today - Duration::days(89);
        let prior_quarter_start = quarter_start - Duration::days(90);
        let earliest: Option<String> = self.conn.query_row(
            "SELECT MIN(txn_date) FROM transactions WHERE deleted_at IS NULL AND txn_date <= ?1",
            params![today.to_string()],
            |row| row.get(0),
        )?;
        let transaction_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL AND txn_date <= ?1",
            params![today.to_string()],
            |row| row.get(0),
        )?;
        let (income, expense): (i64, i64) = self.conn.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN kind = 'income' THEN reporting_amount_cents ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'expense' THEN reporting_amount_cents ELSE 0 END), 0)
             FROM transactions
             WHERE deleted_at IS NULL AND txn_date BETWEEN ?1 AND ?2",
            params![trailing_year.to_string(), today.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (quarter_income, quarter_expense): (i64, i64) = self.conn.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN kind = 'income' THEN reporting_amount_cents ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'expense' THEN reporting_amount_cents ELSE 0 END), 0)
             FROM transactions
             WHERE deleted_at IS NULL AND txn_date BETWEEN ?1 AND ?2",
            params![quarter_start.to_string(), today.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (prior_income, prior_expense): (i64, i64) = self.conn.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN kind = 'income' THEN reporting_amount_cents ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'expense' THEN reporting_amount_cents ELSE 0 END), 0)
             FROM transactions
             WHERE deleted_at IS NULL AND txn_date BETWEEN ?1 AND ?2",
            params![
                prior_quarter_start.to_string(),
                (quarter_start - Duration::days(1)).to_string()
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let net_worth = self.net_worth_snapshot()?;
        let history_start = earliest
            .as_deref()
            .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
            .map(|date| date.max(trailing_year))
            .unwrap_or(trailing_year);
        let history_months =
            (((today - history_start).num_days().max(0) + 1) as f64 / 30.4375).clamp(1.0, 12.0);
        let liquid_cents: i64 = self
            .reporting_balances()?
            .iter()
            .filter(|balance| {
                matches!(
                    balance.account_kind,
                    AccountKind::Cash | AccountKind::Checking | AccountKind::Savings
                )
            })
            .map(|balance| balance.current_balance_cents.max(0))
            .sum();
        let monthly_expense = expense as f64 / history_months;
        let monthly_income = income as f64 / history_months;
        let monthly_debt_payments: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(emi_cents), 0) FROM loans WHERE outstanding_cents > 0",
            [],
            |row| row.get(0),
        )?;

        let savings_rate = if quarter_income > 0 {
            (quarter_income - quarter_expense) as f64 / quarter_income as f64 * 100.0
        } else {
            0.0
        };
        let liquidity_months = if monthly_expense > 0.0 {
            liquid_cents as f64 / monthly_expense
        } else {
            0.0
        };
        let debt_to_income = if monthly_income > 0.0 {
            monthly_debt_payments as f64 / monthly_income * 100.0
        } else if monthly_debt_payments > 0 {
            100.0
        } else {
            0.0
        };
        let prior_net = prior_income - prior_expense;
        let current_net = quarter_income - quarter_expense;
        let prior_net_worth = net_worth
            .trend
            .iter()
            .rev()
            .nth(3)
            .map(|point| point.balance_cents)
            .unwrap_or(net_worth.net_worth_cents - current_net);
        let net_worth_change = net_worth.net_worth_cents - prior_net_worth;
        let net_worth_velocity = if prior_net_worth != 0 {
            net_worth_change as f64 / prior_net_worth.abs() as f64 * 100.0
        } else if net_worth_change > 0 {
            100.0
        } else {
            0.0
        };

        let savings_score = score_savings(savings_rate);
        let liquidity_score = score_liquidity(liquidity_months);
        let debt_score = score_debt(debt_to_income);
        let velocity_score = score_velocity(net_worth_velocity);
        let score = if transaction_count == 0 {
            0
        } else {
            ((savings_score as f64 * 0.30)
                + (liquidity_score as f64 * 0.25)
                + (debt_score as f64 * 0.25)
                + (velocity_score as f64 * 0.20))
                .round() as u32
        };
        let metrics = vec![
            AuditMetric {
                key: "savings_rate".to_string(),
                label: "Savings rate".to_string(),
                value: round1(savings_rate),
                display_value: format!("{:.1}%", savings_rate),
                score: savings_score,
                status: metric_status(savings_score).to_string(),
                explanation: format!(
                    "Quarter income minus spending as a share of income ({} saved).",
                    format_signed_money(current_net)
                ),
            },
            AuditMetric {
                key: "liquidity".to_string(),
                label: "Liquidity".to_string(),
                value: round1(liquidity_months),
                display_value: format!("{:.1} months", liquidity_months),
                score: liquidity_score,
                status: metric_status(liquidity_score).to_string(),
                explanation: "Positive cash, checking, and savings balances divided by trailing average monthly spending."
                    .to_string(),
            },
            AuditMetric {
                key: "debt_to_income".to_string(),
                label: "Debt-to-income".to_string(),
                value: round1(debt_to_income),
                display_value: format!("{:.1}%", debt_to_income),
                score: debt_score,
                status: metric_status(debt_score).to_string(),
                explanation: "Scheduled loan payments as a share of trailing average monthly income."
                    .to_string(),
            },
            AuditMetric {
                key: "net_worth_velocity".to_string(),
                label: "Net worth velocity".to_string(),
                value: round1(net_worth_velocity),
                display_value: format!("{:+.1}%", net_worth_velocity),
                score: velocity_score,
                status: metric_status(velocity_score).to_string(),
                explanation: format!(
                    "Net worth changed {} over roughly three months; prior-quarter cash flow was {}.",
                    format_signed_money(net_worth_change), format_signed_money(prior_net)
                ),
            },
        ];

        let material_total = money(expense as f64 * 0.005).max(1);
        let material_change = money(expense as f64 * 0.001).max(1);
        let mut findings =
            self.creeping_expense_findings(today, "category", material_total, material_change)?;
        findings.extend(self.creeping_expense_findings(
            today,
            "payee",
            material_total,
            material_change,
        )?);
        findings.extend(self.duplicate_charge_findings(today)?);
        findings.sort_by(|a, b| {
            severity_rank(&b.severity)
                .cmp(&severity_rank(&a.severity))
                .then_with(|| {
                    b.change_percent
                        .partial_cmp(&a.change_percent)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });

        let mut suggestions = Vec::new();
        if savings_rate < 10.0 {
            suggestions.push(
                "Review the largest expense categories and set a near-term savings-rate target of at least 10%."
                    .to_string(),
            );
        }
        if liquidity_months < 3.0 && monthly_expense > 0.0 {
            suggestions.push(format!(
                "Build liquid reserves toward three months of spending; the current gap is {}.",
                format_signed_money(money(monthly_expense * 3.0) - liquid_cents)
            ));
        }
        if debt_to_income > 36.0 {
            suggestions.push(
                "Debt payments exceed 36% of average income; prioritize the highest-rate balance or refinance where practical."
                    .to_string(),
            );
        }
        if net_worth_velocity <= 0.0 {
            suggestions.push(
                "Net cash flow is not increasing net worth this quarter; compare recurring commitments with current income."
                    .to_string(),
            );
        }
        if findings
            .iter()
            .any(|finding| finding.kind == "duplicate_charge")
        {
            suggestions.push(
                "Review duplicate-charge candidates against card statements before disputing or deleting anything."
                    .to_string(),
            );
        }
        if suggestions.is_empty() {
            suggestions.push(
                "Core ratios are healthy. Review flagged spending changes and keep the next quarterly check-in."
                    .to_string(),
            );
        }

        let mut warnings = Vec::new();
        if transaction_count == 0 {
            warnings.push("No ledger history is available for an audit yet.".to_string());
        } else if earliest
            .as_deref()
            .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
            .map(|date| (today - date).num_days() < 365)
            .unwrap_or(true)
        {
            warnings.push(
                "Less than twelve months of ledger history is available, so year-over-year leak detection is limited."
                    .to_string(),
            );
        }
        warnings.push(
            "Potential duplicates are matches for review; no transaction is changed automatically."
                .to_string(),
        );

        Ok(FinancialAuditSnapshot {
            as_of: today.to_string(),
            quarter_label: format!("{} Q{}", today.year(), (today.month0() / 3) + 1),
            history_from: earliest.unwrap_or_else(|| today.to_string()),
            transaction_count,
            score,
            grade: audit_grade(score).to_string(),
            metrics,
            findings,
            suggestions,
            warnings,
        })
    }

    fn loan_payoff_summary(&self) -> Result<LoanPayoffSummary, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT name, lender, principal_cents, outstanding_cents, emi_cents, annual_rate_bps
             FROM loans",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        })?;
        let mut total_principal_cents = 0i64;
        let mut total_emi_cents = 0i64;
        let mut maximum_months = 0u32;
        let mut all_amortize = true;
        let mut mortgage_principal_cents = 0i64;
        let mut mortgage_outstanding_cents = 0i64;
        let mut maximum_mortgage_months = 0u32;
        let mut all_mortgages_amortize = true;
        for row in rows {
            let (name, lender, principal, outstanding, emi, rate_bps) = row?;
            total_principal_cents += principal;
            if outstanding > 0 {
                total_emi_cents += emi;
                match amortization_months(outstanding, emi, rate_bps.unwrap_or(0)) {
                    Some(months) => maximum_months = maximum_months.max(months),
                    None => all_amortize = false,
                }
            }
            let mortgage_text = format!("{} {}", name, lender.unwrap_or_default()).to_lowercase();
            if ["mortgage", "home loan", "housing loan", "property loan"]
                .iter()
                .any(|term| mortgage_text.contains(term))
            {
                mortgage_principal_cents += principal;
                mortgage_outstanding_cents += outstanding;
                if outstanding > 0 {
                    match amortization_months(outstanding, emi, rate_bps.unwrap_or(0)) {
                        Some(months) => {
                            maximum_mortgage_months = maximum_mortgage_months.max(months)
                        }
                        None => all_mortgages_amortize = false,
                    }
                }
            }
        }
        Ok(LoanPayoffSummary {
            total_principal_cents,
            total_emi_cents,
            payoff_months: all_amortize.then_some(maximum_months),
            mortgage_principal_cents,
            mortgage_outstanding_cents,
            mortgage_payoff_months: (mortgage_principal_cents > 0 && all_mortgages_amortize)
                .then_some(maximum_mortgage_months),
        })
    }

    fn creeping_expense_findings(
        &self,
        today: NaiveDate,
        dimension: &str,
        material_total_cents: i64,
        material_change_cents: i64,
    ) -> Result<Vec<AuditFinding>, AppError> {
        let current_month = NaiveDate::from_ymd_opt(today.year(), today.month(), 1)
            .expect("the first day of a valid month exists");
        let current_start = shift_months(current_month, -12);
        let previous_start = shift_months(current_month, -24);
        let (key_expression, display_expression) = if dimension == "category" {
            (
                "COALESCE(c.name, 'Uncategorized')",
                "COALESCE(c.name, 'Uncategorized')",
            )
        } else {
            (
                "LOWER(COALESCE(NULLIF(TRIM(t.payee), ''), 'Unknown payee'))",
                "COALESCE(NULLIF(TRIM(t.payee), ''), 'Unknown payee')",
            )
        };
        let sql = format!(
            "WITH expenses AS (
                SELECT id, txn_date, payee, category_id, reporting_amount_cents
                FROM transactions
                WHERE deleted_at IS NULL AND kind = 'expense'
                  AND txn_date >= ?1 AND txn_date < ?3
            ), allocations AS (
                SELECT t.* FROM expenses t
                WHERE ?6 != 'category' OR NOT EXISTS (
                    SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id
                )
                UNION ALL
                SELECT t.id, t.txn_date, t.payee, s.category_id, s.reporting_amount_cents
                FROM expenses t JOIN transaction_splits s ON s.transaction_id = t.id
                WHERE ?6 = 'category'
            ), grouped AS (
                SELECT MIN({display_expression}) AS entity,
                    SUM(CASE WHEN t.txn_date >= ?2 THEN t.reporting_amount_cents ELSE 0 END) AS current_total,
                    SUM(CASE WHEN t.txn_date < ?2 THEN t.reporting_amount_cents ELSE 0 END) AS previous_total,
                    COUNT(DISTINCT CASE WHEN t.txn_date >= ?2 THEN t.id END) AS current_count,
                    COUNT(DISTINCT CASE WHEN t.txn_date < ?2 THEN t.id END) AS previous_count,
                    SUM(CASE WHEN t.txn_date >= date(?3, '-3 months') THEN t.reporting_amount_cents ELSE 0 END) AS recent_quarter,
                    SUM(CASE WHEN t.txn_date >= ?2 AND t.txn_date < date(?2, '+3 months') THEN t.reporting_amount_cents ELSE 0 END) AS first_quarter
                FROM allocations t
                LEFT JOIN categories c ON c.id = t.category_id
                GROUP BY {key_expression}
            )
            SELECT entity, previous_total, current_total, previous_count, current_count
            FROM grouped
            WHERE previous_total > 0 AND previous_count >= 4 AND current_count >= 4
              AND current_total >= previous_total * 1.10
              AND recent_quarter >= first_quarter * 1.05
              AND current_total >= ?4
              AND (current_total - previous_total) >= ?5
            ORDER BY (current_total - previous_total) DESC
            LIMIT 8"
        );
        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(
            params![
                previous_start.to_string(),
                current_start.to_string(),
                current_month.to_string(),
                material_total_cents,
                material_change_cents,
                dimension,
            ],
            |row| {
                Ok(CreepRow {
                    name: row.get(0)?,
                    previous_cents: row.get(1)?,
                    current_cents: row.get(2)?,
                    previous_count: row.get(3)?,
                    current_count: row.get(4)?,
                })
            },
        )?;
        rows.map(|row| {
            let row = row?;
            let change = (row.current_cents - row.previous_cents) as f64
                / row.previous_cents as f64
                * 100.0;
            let severity = if change >= 25.0 { "high" } else { "medium" };
            let dimension_label = if dimension == "category" { "Category" } else { "Payee" };
            Ok(AuditFinding {
                kind: format!("{}_creep", dimension),
                severity: severity.to_string(),
                title: format!("{} spending increased {:.0}%", row.name, change),
                description: format!(
                    "{dimension_label} total rose from {} to {} year over year across {} recent charges ({} previously).",
                    format_signed_money(row.previous_cents),
                    format_signed_money(row.current_cents),
                    row.current_count,
                    row.previous_count
                ),
                entity_name: row.name,
                current_cents: row.current_cents,
                baseline_cents: row.previous_cents,
                change_percent: Some(round1(change)),
                transaction_ids: Vec::new(),
                occurred_on: None,
            })
        })
        .collect::<Result<Vec<_>, rusqlite::Error>>()
        .map_err(Into::into)
    }

    fn duplicate_charge_findings(&self, today: NaiveDate) -> Result<Vec<AuditFinding>, AppError> {
        let from = today - Duration::days(364);
        let mut statement = self.conn.prepare(
            "SELECT a.id, b.id, a.txn_date, b.txn_date, a.reporting_amount_cents,
                    COALESCE(NULLIF(TRIM(a.payee), ''), 'Unknown payee'), ac.name
             FROM transactions a
             JOIN transactions b
               ON b.id > a.id
              AND b.account_id = a.account_id
              AND b.kind = 'expense'
              AND b.amount_cents = a.amount_cents
              AND LOWER(COALESCE(TRIM(b.payee), '')) = LOWER(COALESCE(TRIM(a.payee), ''))
              AND ABS(julianday(b.txn_date) - julianday(a.txn_date)) <= 2
             JOIN accounts ac ON ac.id = a.account_id AND ac.kind = 'credit'
             WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
               AND a.kind = 'expense' AND NULLIF(TRIM(a.payee), '') IS NOT NULL
               AND a.txn_date BETWEEN ?1 AND ?2
               AND b.txn_date BETWEEN ?1 AND ?2
             ORDER BY a.txn_date DESC, a.id DESC
             LIMIT 20",
        )?;
        let rows = statement.query_map(params![from.to_string(), today.to_string()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        rows.map(|row| {
            let (first_id, second_id, first_date, second_date, amount, payee, account) = row?;
            Ok(AuditFinding {
                kind: "duplicate_charge".to_string(),
                severity: "high".to_string(),
                title: format!("Possible duplicate charge at {payee}"),
                description: format!(
                    "Two matching {} charges appeared on {} within 48 hours ({} and {}).",
                    format_signed_money(amount),
                    account,
                    first_date,
                    second_date
                ),
                entity_name: payee,
                current_cents: amount,
                baseline_cents: amount,
                change_percent: None,
                transaction_ids: vec![first_id, second_id],
                occurred_on: Some(second_date),
            })
        })
        .collect::<Result<Vec<_>, rusqlite::Error>>()
        .map_err(Into::into)
    }
}

fn validate_percent(field: &str, value: f64, minimum: f64, maximum: f64) -> Result<(), AppError> {
    if !value.is_finite() || value < minimum || value > maximum {
        return Err(AppError::field_validation(
            field,
            format!("must be between {minimum} and {maximum}"),
        ));
    }
    Ok(())
}

fn money(value: f64) -> i64 {
    value.round().clamp(i64::MIN as f64, i64::MAX as f64) as i64
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn progress(current: i64, target: i64) -> f64 {
    if target <= 0 {
        return 0.0;
    }
    round1((current.max(0) as f64 / target as f64 * 100.0).clamp(0.0, 100.0))
}

fn shift_months(date: NaiveDate, delta: i32) -> NaiveDate {
    let total = date.year() * 12 + date.month0() as i32 + delta;
    let year = total.div_euclid(12);
    let month = total.rem_euclid(12) as u32 + 1;
    NaiveDate::from_ymd_opt(year, month, 1).expect("shifted first-of-month date is valid")
}

fn add_months(date: NaiveDate, months: u32) -> String {
    let total = date.year() * 12 + date.month0() as i32 + months as i32;
    let year = total.div_euclid(12);
    let month = total.rem_euclid(12) as u32 + 1;
    let day = date.day().min(days_in_month(year, month));
    NaiveDate::from_ymd_opt(year, month, day)
        .expect("clamped projected date is valid")
        .to_string()
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let next = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    }
    .expect("next month is valid");
    (next - Duration::days(1)).day()
}

fn amortization_months(outstanding: i64, payment: i64, annual_rate_bps: i64) -> Option<u32> {
    if outstanding <= 0 {
        return Some(0);
    }
    if payment <= 0 {
        return None;
    }
    let rate_bps = annual_rate_bps.max(0);
    let mut balance = outstanding;
    for month in 1..=1_200 {
        let n = (balance as i128).checked_mul(rate_bps as i128)?;
        let interest = i64::try_from((n + 60_000) / 120_000).ok()?;
        if payment <= interest {
            return None;
        }
        balance = balance.checked_add(interest)?.saturating_sub(payment);
        if balance <= 0 {
            return Some(month);
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn project_months_to_target(
    starting_cents: i64,
    target_cents: i64,
    monthly_savings_cents: i64,
    released_debt_payment_cents: i64,
    debt_payoff_months: Option<u32>,
    monthly_return: f64,
    maximum_months: u32,
) -> Option<u32> {
    if target_cents <= 0 || starting_cents >= target_cents {
        return Some(0);
    }
    let mut portfolio = starting_cents.max(0) as f64;
    for month in 1..=maximum_months {
        let contribution = monthly_savings_cents
            + if debt_payoff_months.is_some_and(|payoff| month > payoff) {
                released_debt_payment_cents
            } else {
                0
            };
        portfolio = (portfolio * (1.0 + monthly_return) + contribution as f64).max(0.0);
        if portfolio >= target_cents as f64 {
            return Some(month);
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn build_wealth_projection(
    today: NaiveDate,
    starting_cents: i64,
    target_cents: i64,
    monthly_savings_cents: i64,
    released_debt_payment_cents: i64,
    debt_payoff_months: Option<u32>,
    monthly_return: f64,
    current_age: u32,
) -> Vec<WealthProjectionPoint> {
    let mut result = vec![WealthProjectionPoint {
        year: today.year(),
        age: current_age,
        portfolio_cents: starting_cents,
        fire_target_cents: target_cents,
        annual_contribution_cents: monthly_savings_cents * 12,
    }];
    let mut portfolio = starting_cents.max(0) as f64;
    for year_offset in 1..=50u32 {
        let mut contribution_total = 0i64;
        for month_in_year in 1..=12u32 {
            let elapsed = (year_offset - 1) * 12 + month_in_year;
            let contribution = monthly_savings_cents
                + if debt_payoff_months.is_some_and(|payoff| elapsed > payoff) {
                    released_debt_payment_cents
                } else {
                    0
                };
            contribution_total += contribution;
            portfolio = (portfolio * (1.0 + monthly_return) + contribution as f64).max(0.0);
        }
        result.push(WealthProjectionPoint {
            year: today.year() + year_offset as i32,
            age: current_age.saturating_add(year_offset),
            portfolio_cents: money(portfolio),
            fire_target_cents: target_cents,
            annual_contribution_cents: contribution_total,
        });
        if portfolio >= target_cents as f64 && year_offset >= 10 {
            break;
        }
    }
    result
}

fn monte_carlo(
    starting_cents: i64,
    annual_spending_cents: i64,
    stock_allocation_percent: f64,
    inflation_percent: f64,
    trials: u32,
    horizon_years: u32,
) -> PortfolioSimulation {
    if starting_cents <= 0 || annual_spending_cents <= 0 {
        return PortfolioSimulation {
            trials,
            horizon_years,
            success_rate_percent: 0.0,
            median_ending_balance_cents: 0,
            percentile_10_ending_balance_cents: 0,
            worst_ending_balance_cents: 0,
        };
    }
    let stock_weight = stock_allocation_percent / 100.0;
    let mean_nominal = stock_weight * 0.09 + (1.0 - stock_weight) * 0.045;
    let deviation = ((stock_weight * 0.18).powi(2) + ((1.0 - stock_weight) * 0.07).powi(2)).sqrt();
    let inflation = inflation_percent / 100.0;
    let mut generator = DeterministicNormal::new(
        (starting_cents as u64)
            ^ ((annual_spending_cents as u64).rotate_left(17))
            ^ (stock_allocation_percent.to_bits().rotate_left(31)),
    );
    let mut endings = Vec::with_capacity(trials as usize);
    let mut successes = 0u32;
    for _ in 0..trials {
        let mut balance = starting_cents as f64;
        for _ in 0..horizon_years {
            balance -= annual_spending_cents as f64;
            if balance <= 0.0 {
                balance = 0.0;
                break;
            }
            let nominal_return = (mean_nominal + deviation * generator.sample()).max(-0.95);
            let real_return = (1.0 + nominal_return) / (1.0 + inflation) - 1.0;
            balance *= 1.0 + real_return;
        }
        if balance > 0.0 {
            successes += 1;
        }
        endings.push(money(balance));
    }
    endings.sort_unstable();
    PortfolioSimulation {
        trials,
        horizon_years,
        success_rate_percent: round1(successes as f64 / trials as f64 * 100.0),
        median_ending_balance_cents: percentile(&endings, 0.50),
        percentile_10_ending_balance_cents: percentile(&endings, 0.10),
        worst_ending_balance_cents: endings.first().copied().unwrap_or(0),
    }
}

fn historical_stress_tests(
    starting_cents: i64,
    annual_spending_cents: i64,
    stock_allocation_percent: f64,
    inflation_percent: f64,
) -> Vec<HistoricalStressResult> {
    const DOT_COM_STOCKS: [f64; 10] = [-9.1, -11.9, -22.1, 28.7, 10.9, 4.9, 15.8, 5.5, -37.0, 26.5];
    const DOT_COM_BONDS: [f64; 10] = [11.6, 8.4, 10.3, 4.1, 4.3, 2.4, 4.3, 7.0, 5.2, 5.9];
    const GFC_STOCKS: [f64; 10] = [-37.0, 26.5, 15.1, 2.1, 16.0, 32.4, 13.7, 1.4, 12.0, 21.6];
    const GFC_BONDS: [f64; 10] = [5.2, 5.9, 6.5, 7.8, 4.2, -2.0, 6.0, 0.6, 2.7, 3.5];
    vec![
        run_stress(
            "Dot-com crash sequence",
            2000,
            "Replays the 2000–2009 stock and bond sequence, then returns to long-run assumptions.",
            &DOT_COM_STOCKS,
            &DOT_COM_BONDS,
            starting_cents,
            annual_spending_cents,
            stock_allocation_percent,
            inflation_percent,
        ),
        run_stress(
            "Global Financial Crisis sequence",
            2008,
            "Replays the 2008–2017 stock and bond sequence, then returns to long-run assumptions.",
            &GFC_STOCKS,
            &GFC_BONDS,
            starting_cents,
            annual_spending_cents,
            stock_allocation_percent,
            inflation_percent,
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
fn run_stress(
    name: &str,
    starting_year: i32,
    description: &str,
    stock_returns: &[f64],
    bond_returns: &[f64],
    starting_cents: i64,
    annual_spending_cents: i64,
    stock_allocation_percent: f64,
    inflation_percent: f64,
) -> HistoricalStressResult {
    let stock_weight = stock_allocation_percent / 100.0;
    let mut balance = starting_cents.max(0) as f64;
    let mut minimum = balance;
    for year in 0..RETIREMENT_HORIZON_YEARS as usize {
        balance -= annual_spending_cents.max(0) as f64;
        if balance <= 0.0 {
            balance = 0.0;
            minimum = 0.0;
            break;
        }
        let nominal_return = if year < stock_returns.len() {
            stock_weight * stock_returns[year] / 100.0
                + (1.0 - stock_weight) * bond_returns[year] / 100.0
        } else {
            stock_weight * 0.09 + (1.0 - stock_weight) * 0.045
        };
        let real_return = (1.0 + nominal_return) / (1.0 + inflation_percent / 100.0) - 1.0;
        balance *= 1.0 + real_return;
        minimum = minimum.min(balance);
    }
    HistoricalStressResult {
        name: name.to_string(),
        starting_year,
        description: description.to_string(),
        survived: balance > 0.0,
        minimum_balance_cents: money(minimum),
        ending_balance_cents: money(balance),
    }
}

#[allow(clippy::too_many_arguments)]
fn build_milestones(
    today: NaiveDate,
    net_worth: &NetWorthSnapshot,
    investable_assets_cents: i64,
    fire_number_cents: i64,
    monthly_savings_cents: i64,
    released_debt_payment_cents: i64,
    debt_payoff_months: Option<u32>,
    monthly_return: f64,
    current_age: u32,
    retirement_age: u32,
    debt_free_date: Option<String>,
    loans: &LoanPayoffSummary,
) -> Vec<WealthMilestone> {
    let mut milestones = Vec::new();
    let first_100k = 10_000_000i64;
    let first_100k_months = project_months_to_target(
        net_worth.net_worth_cents.max(0),
        first_100k,
        monthly_savings_cents,
        released_debt_payment_cents,
        debt_payoff_months,
        monthly_return,
        1_200,
    );
    milestones.push(WealthMilestone {
        kind: "first_100k".to_string(),
        name: "First 100k".to_string(),
        target_cents: first_100k,
        current_cents: net_worth.net_worth_cents.max(0),
        progress_percent: progress(net_worth.net_worth_cents, first_100k),
        estimated_date: first_100k_months.map(|months| add_months(today, months)),
        achieved: net_worth.net_worth_cents >= first_100k,
        detail: "Net worth milestone in your reporting currency.".to_string(),
    });

    let original_loan_debt: i64 = loans.total_principal_cents
        + (net_worth.liabilities_cents - net_worth.loan_liabilities_cents).max(0);
    let debt_target = original_loan_debt.max(net_worth.liabilities_cents);
    milestones.push(WealthMilestone {
        kind: "debt_free".to_string(),
        name: "Debt-Free".to_string(),
        target_cents: debt_target,
        current_cents: (debt_target - net_worth.liabilities_cents).max(0),
        progress_percent: if net_worth.liabilities_cents == 0 {
            100.0
        } else {
            progress(debt_target - net_worth.liabilities_cents, debt_target)
        },
        estimated_date: debt_free_date,
        achieved: net_worth.liabilities_cents == 0,
        detail: "Includes loans, credit balances, overdrafts, and manually tracked liabilities."
            .to_string(),
    });

    if fire_number_cents > 0 {
        let years_to_retirement = retirement_age.saturating_sub(current_age);
        let annual_real_return = (1.0 + monthly_return).powi(12) - 1.0;
        let coast_target = if years_to_retirement == 0 {
            fire_number_cents
        } else {
            money(
                fire_number_cents as f64
                    / (1.0 + annual_real_return).powf(years_to_retirement as f64),
            )
        };
        let coast_months = project_months_to_target(
            investable_assets_cents,
            coast_target,
            monthly_savings_cents,
            released_debt_payment_cents,
            debt_payoff_months,
            monthly_return,
            1_200,
        );
        milestones.push(WealthMilestone {
            kind: "coast_fire".to_string(),
            name: "Coast FIRE".to_string(),
            target_cents: coast_target,
            current_cents: investable_assets_cents,
            progress_percent: progress(investable_assets_cents, coast_target),
            estimated_date: coast_months.map(|months| add_months(today, months)),
            achieved: investable_assets_cents >= coast_target,
            detail: format!(
                "Amount needed today to grow to the FIRE number by age {retirement_age} without further contributions."
            ),
        });
        let fire_months = project_months_to_target(
            investable_assets_cents,
            fire_number_cents,
            monthly_savings_cents,
            released_debt_payment_cents,
            debt_payoff_months,
            monthly_return,
            1_200,
        );
        milestones.push(WealthMilestone {
            kind: "fire".to_string(),
            name: "Financial Independence".to_string(),
            target_cents: fire_number_cents,
            current_cents: investable_assets_cents,
            progress_percent: progress(investable_assets_cents, fire_number_cents),
            estimated_date: fire_months.map(|months| add_months(today, months)),
            achieved: investable_assets_cents >= fire_number_cents,
            detail: "Investable assets compared with annual spending divided by the selected withdrawal rate."
                .to_string(),
        });
    }

    if loans.mortgage_principal_cents > 0 {
        milestones.push(WealthMilestone {
            kind: "mortgage_free".to_string(),
            name: "Mortgage Freedom".to_string(),
            target_cents: loans.mortgage_principal_cents,
            current_cents: (loans.mortgage_principal_cents - loans.mortgage_outstanding_cents)
                .max(0),
            progress_percent: progress(
                loans.mortgage_principal_cents - loans.mortgage_outstanding_cents,
                loans.mortgage_principal_cents,
            ),
            estimated_date: loans
                .mortgage_payoff_months
                .map(|months| add_months(today, months)),
            achieved: loans.mortgage_outstanding_cents == 0,
            detail: "Detected from active loans named as a mortgage or home/property loan."
                .to_string(),
        });
    }
    milestones
}

struct DeterministicNormal {
    state: u64,
    spare: Option<f64>,
}

impl DeterministicNormal {
    fn new(seed: u64) -> Self {
        Self {
            state: seed.max(1),
            spare: None,
        }
    }

    fn uniform(&mut self) -> f64 {
        self.state = self
            .state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (((self.state >> 11) as f64) / ((1u64 << 53) as f64)).clamp(f64::EPSILON, 1.0)
    }

    fn sample(&mut self) -> f64 {
        if let Some(value) = self.spare.take() {
            return value;
        }
        let u1 = self.uniform();
        let u2 = self.uniform();
        let magnitude = (-2.0 * u1.ln()).sqrt();
        let angle = std::f64::consts::TAU * u2;
        self.spare = Some(magnitude * angle.sin());
        magnitude * angle.cos()
    }
}

fn percentile(values: &[i64], fraction: f64) -> i64 {
    if values.is_empty() {
        return 0;
    }
    let index = ((values.len() - 1) as f64 * fraction).round() as usize;
    values[index]
}

fn score_savings(value: f64) -> u32 {
    if value >= 20.0 {
        100
    } else if value >= 10.0 {
        75
    } else if value >= 0.0 {
        50
    } else {
        15
    }
}

fn score_liquidity(value: f64) -> u32 {
    if value >= 6.0 {
        100
    } else if value >= 3.0 {
        75
    } else if value >= 1.0 {
        50
    } else {
        20
    }
}

fn score_debt(value: f64) -> u32 {
    if value <= 20.0 {
        100
    } else if value <= 36.0 {
        75
    } else if value <= 50.0 {
        45
    } else {
        15
    }
}

fn score_velocity(value: f64) -> u32 {
    if value >= 3.0 {
        100
    } else if value > 0.0 {
        75
    } else if value == 0.0 {
        50
    } else {
        20
    }
}

fn metric_status(score: u32) -> &'static str {
    if score >= 75 {
        "healthy"
    } else if score >= 50 {
        "watch"
    } else {
        "risk"
    }
}

fn audit_grade(score: u32) -> &'static str {
    match score {
        90..=100 => "Excellent",
        75..=89 => "Strong",
        60..=74 => "Stable",
        40..=59 => "Needs attention",
        _ => "At risk",
    }
}

fn severity_rank(severity: &str) -> u8 {
    match severity {
        "high" => 3,
        "medium" => 2,
        _ => 1,
    }
}

fn format_signed_money(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let absolute = cents.unsigned_abs();
    format!("{sign}{}.{:02}", absolute / 100, absolute % 100)
}
