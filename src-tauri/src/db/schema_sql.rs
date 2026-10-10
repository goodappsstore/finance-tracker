pub(super) const FULL_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    currency TEXT NOT NULL,
    fx_rate_mode TEXT NOT NULL DEFAULT 'frankfurter' CHECK (fx_rate_mode IN ('frankfurter', 'manual')),
    schema_version INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('cash', 'checking', 'savings', 'credit')),
    opening_balance_cents INTEGER NOT NULL DEFAULT 0,
    currency_code TEXT NOT NULL,
    opened_on TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

CREATE TABLE IF NOT EXISTS reconciliations (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    statement_ending_on TEXT NOT NULL,
    statement_balance_cents INTEGER NOT NULL,
    cleared_balance_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliation_transaction_links (
    reconciliation_id INTEGER NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    PRIMARY KEY (reconciliation_id, transaction_id)
);

CREATE TABLE IF NOT EXISTS recurring_rules (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    to_account_id INTEGER REFERENCES accounts(id),
    category_id INTEGER REFERENCES categories(id),
    payee TEXT,
    note TEXT,
    cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
    interval INTEGER NOT NULL DEFAULT 1 CHECK (interval > 0),
    day_of_month INTEGER,
    weekday TEXT,
    start_on TEXT NOT NULL,
    end_on TEXT,
    next_due_on TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (kind IN ('income', 'expense') AND to_account_id IS NULL AND category_id IS NOT NULL)
        OR
        (kind = 'transfer' AND to_account_id IS NOT NULL AND category_id IS NULL AND to_account_id != account_id)
    ),
    CHECK (
        (cadence = 'weekly' AND weekday IS NOT NULL AND day_of_month IS NULL)
        OR
        (cadence = 'monthly' AND day_of_month BETWEEN 1 AND 28 AND weekday IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    txn_date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    to_amount_cents INTEGER,
    reporting_amount_cents INTEGER NOT NULL CHECK (reporting_amount_cents > 0),
    exchange_rate TEXT,
    exchange_rate_source TEXT CHECK (exchange_rate_source IN ('frankfurter', 'manual')),
    exchange_rate_date TEXT,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    to_account_id INTEGER REFERENCES accounts(id),
    category_id INTEGER REFERENCES categories(id),
    payee TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    recurring_rule_id INTEGER REFERENCES recurring_rules(id),
    reconciliation_id INTEGER REFERENCES reconciliations(id),
    CHECK (
        (kind IN ('income', 'expense') AND to_account_id IS NULL AND category_id IS NOT NULL)
        OR
        (kind = 'transfer' AND to_account_id IS NOT NULL AND category_id IS NULL AND to_account_id != account_id)
    )
);

-- A permanent local cache. Rates are stored as text to retain the exact
-- decimal returned by the provider rather than introducing binary rounding.
CREATE TABLE IF NOT EXISTS fx_rate_cache (
    base_currency TEXT NOT NULL,
    quote_currency TEXT NOT NULL,
    requested_on TEXT NOT NULL,
    quoted_on TEXT NOT NULL,
    rate TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (base_currency, quote_currency, requested_on)
);

CREATE TABLE IF NOT EXISTS manual_fx_rates (
    base_currency TEXT NOT NULL,
    quote_currency TEXT NOT NULL,
    effective_on TEXT NOT NULL,
    rate TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (base_currency, quote_currency, effective_on)
);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE
);

CREATE TABLE IF NOT EXISTS transaction_tags (
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (transaction_id, tag_id)
);

-- A payee default is deliberately independent of a particular account.  It is
-- applied only when the transaction kind is compatible with the category.
CREATE TABLE IF NOT EXISTS payee_category_defaults (
    payee TEXT PRIMARY KEY COLLATE NOCASE,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transaction_attachments (
    id INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- A split is a reporting/category allocation of one real bank transaction.
-- Both native and reporting amounts are stored so their exact parent totals
-- can be checked without reconstructing historical FX rounding.
CREATE TABLE IF NOT EXISTS transaction_splits (
    id INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL CHECK (line_number > 0),
    category_id INTEGER NOT NULL REFERENCES categories(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    reporting_amount_cents INTEGER NOT NULL CHECK (reporting_amount_cents >= 0),
    memo TEXT,
    UNIQUE(transaction_id, line_number)
);

CREATE TABLE IF NOT EXISTS transaction_rules (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    priority INTEGER NOT NULL CHECK (priority >= 0),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    match_field TEXT NOT NULL DEFAULT 'payee' CHECK (match_field IN ('payee', 'note')),
    match_operator TEXT NOT NULL CHECK (match_operator IN ('contains', 'exact', 'starts_with', 'ends_with')),
    match_value TEXT NOT NULL,
    account_id INTEGER REFERENCES accounts(id),
    kind TEXT CHECK (kind IN ('income', 'expense')),
    min_amount_cents INTEGER CHECK (min_amount_cents > 0),
    max_amount_cents INTEGER CHECK (max_amount_cents > 0),
    set_payee TEXT,
    set_category_id INTEGER REFERENCES categories(id),
    append_note TEXT,
    stop_processing INTEGER NOT NULL DEFAULT 1 CHECK (stop_processing IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (min_amount_cents IS NULL OR max_amount_cents IS NULL OR min_amount_cents <= max_amount_cents),
    CHECK (length(trim(match_value)) > 0)
);

CREATE TABLE IF NOT EXISTS transaction_rule_tags (
    rule_id INTEGER NOT NULL REFERENCES transaction_rules(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (rule_id, tag_id)
);

CREATE TABLE IF NOT EXISTS rule_application_runs (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    undone_at TEXT
);

CREATE TABLE IF NOT EXISTS rule_application_changes (
    run_id INTEGER NOT NULL REFERENCES rule_application_runs(id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    previous_payee TEXT,
    previous_category_id INTEGER REFERENCES categories(id),
    previous_note TEXT,
    previous_tag_ids TEXT NOT NULL,
    PRIMARY KEY (run_id, transaction_id)
);

-- Credit accounts need repayment assumptions that are not ledger facts.
-- Loan assumptions already live on the loans table.
CREATE TABLE IF NOT EXISTS debt_account_settings (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    annual_rate_bps INTEGER NOT NULL CHECK (annual_rate_bps >= 0),
    minimum_payment_cents INTEGER NOT NULL CHECK (minimum_payment_cents > 0),
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS investment_tax_settings (
    investment_account_id INTEGER PRIMARY KEY REFERENCES investment_accounts(id) ON DELETE CASCADE,
    treatment TEXT NOT NULL CHECK (treatment IN ('taxable', 'tax_advantaged', 'unknown')),
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tax_category_settings (
    category_id INTEGER PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
    deduction_group TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (length(trim(deduction_group)) > 0)
);

CREATE TABLE IF NOT EXISTS loans (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    lender TEXT,
    principal_cents INTEGER NOT NULL CHECK (principal_cents > 0),
    outstanding_cents INTEGER NOT NULL CHECK (outstanding_cents >= 0),
    emi_cents INTEGER NOT NULL CHECK (emi_cents > 0),
    annual_rate_bps INTEGER,
    next_due_on TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS net_worth_items (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('asset', 'liability')),
    value_cents INTEGER NOT NULL,
    as_of TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS investment_accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    institution TEXT,
    value_cents INTEGER NOT NULL CHECK (value_cents >= 0),
    contributed_cents INTEGER NOT NULL CHECK (contributed_cents >= 0),
    as_of TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS securities (
    id INTEGER PRIMARY KEY,
    symbol TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL,
    currency_code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Lots are immutable purchase records.  Remaining quantities and FIFO cost
-- basis are derived from these records together with sell events.
CREATE TABLE IF NOT EXISTS holdings_lots (
    id INTEGER PRIMARY KEY,
    investment_account_id INTEGER NOT NULL REFERENCES investment_accounts(id) ON DELETE CASCADE,
    security_id INTEGER NOT NULL REFERENCES securities(id),
    quantity_micros INTEGER NOT NULL CHECK (quantity_micros > 0),
    buy_price_cents INTEGER NOT NULL CHECK (buy_price_cents > 0),
    reporting_buy_price_cents INTEGER NOT NULL CHECK (reporting_buy_price_cents > 0),
    bought_on TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Prices are entered manually.  The reporting-price snapshot keeps portfolio
-- calculations offline and stable when a security uses another currency.
CREATE TABLE IF NOT EXISTS holding_events (
    id INTEGER PRIMARY KEY,
    investment_account_id INTEGER NOT NULL REFERENCES investment_accounts(id) ON DELETE CASCADE,
    security_id INTEGER NOT NULL REFERENCES securities(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('buy', 'sell', 'dividend', 'price_snapshot')),
    event_on TEXT NOT NULL,
    quantity_micros INTEGER,
    price_cents INTEGER,
    reporting_price_cents INTEGER,
    amount_cents INTEGER,
    reporting_amount_cents INTEGER,
    note TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recurring_occurrences (
    id INTEGER PRIMARY KEY,
    rule_id INTEGER NOT NULL REFERENCES recurring_rules(id) ON DELETE CASCADE,
    due_on TEXT NOT NULL,
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'skipped')),
    created_at TEXT NOT NULL,
    UNIQUE(rule_id, due_on)
);

CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY,
    month TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    account_id INTEGER REFERENCES accounts(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(month, category_id, account_id)
);

CREATE TABLE IF NOT EXISTS budget_rollovers (
    id INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    account_id INTEGER REFERENCES accounts(id),
    start_month TEXT NOT NULL,
    UNIQUE(category_id, account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_rollover_scope
    ON budget_rollovers(category_id, COALESCE(account_id, 0));

CREATE TABLE IF NOT EXISTS budget_moves (
    id INTEGER PRIMARY KEY,
    month TEXT NOT NULL,
    from_category_id INTEGER NOT NULL REFERENCES categories(id),
    to_category_id INTEGER NOT NULL REFERENCES categories(id),
    account_id INTEGER REFERENCES accounts(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    created_at TEXT NOT NULL,
    CHECK (from_category_id != to_category_id)
);

CREATE TABLE IF NOT EXISTS safe_spend_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payday TEXT,
    buffer_cents INTEGER NOT NULL DEFAULT 0 CHECK (buffer_cents >= 0),
    protected_cents INTEGER NOT NULL DEFAULT 0 CHECK (protected_cents >= 0),
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS safe_spend_accounts (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS planning_scenarios (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    note TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS planning_items (
    id INTEGER PRIMARY KEY,
    scenario_id INTEGER REFERENCES planning_scenarios(id),
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    to_account_id INTEGER REFERENCES accounts(id),
    category_id INTEGER REFERENCES categories(id),
    due_on TEXT NOT NULL,
    payee TEXT,
    note TEXT,
    linked_transaction_id INTEGER REFERENCES transactions(id),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (kind IN ('income', 'expense') AND to_account_id IS NULL)
        OR
        (kind = 'transfer' AND to_account_id IS NOT NULL AND to_account_id != account_id)
    )
);

CREATE TABLE IF NOT EXISTS scenario_budget_overrides (
    id INTEGER PRIMARY KEY,
    scenario_id INTEGER NOT NULL REFERENCES planning_scenarios(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    account_id INTEGER REFERENCES accounts(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(scenario_id, month, category_id, account_id)
);

CREATE TABLE IF NOT EXISTS planning_goals (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('sinking_fund', 'balance_target')),
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    target_amount_cents INTEGER,
    minimum_balance_cents INTEGER,
    due_on TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (kind = 'sinking_fund' AND target_amount_cents IS NOT NULL AND due_on IS NOT NULL AND minimum_balance_cents IS NULL)
        OR
        (kind = 'balance_target' AND minimum_balance_cents IS NOT NULL AND target_amount_cents IS NULL AND due_on IS NULL)
    )
);
"#;
