# Finance Tracker

Local-first personal finance tracker. Rust + Tauri + SQLite. Single `.db` file, no cloud; the app remains usable offline and contacts Frankfurter only when the user requests an API exchange-rate quote.

Built as a modern desktop app around a robust local SQLite ledger engine, then wrapped in Tauri commands and a fresh frontend.

## Features (reference: original requirements)

| # | Feature | Status |
|---|---------|--------|
| 1 | **Accounts** — create/edit/archive, cash/checking/savings/credit, opening balance, derived current balance, interactive account deep-dive analytics (KPIs, balance history trend, monthly cash flow, category spending, top payees, recurring rules, goals, and recent activity) | ✅ |
| 2 | **Categories** — income/expense, create/edit/archive, used everywhere | ✅ |
| 3 | **Ledger** — income/expense/transfer, CRUD, soft-delete/restore, search/filter, reconciled-lock, filtered multi-select with category/tag/delete/restore/payee-default bulk actions and undo | ✅ |
| 4 | **Bank import** — CSV (25 presets: Chase, BofA, Citi, Barclays, HSBC, Lloyds, Revolut, N26, Wise, ING, Deutsche, DKB, Commerzbank, BNP, Santander, Intesa, CommBank, Starling, Monzo, Alpha/Eurobank/NBG/Piraeus GR, etc.) + manual column mapping (signed or debit/credit split, custom delimiter/date format), camt.053 XML, OFX/QFX, QIF, dry-run preview, duplicate detection, default categories, transactional rollback | ✅ |
| 5 | **Reconciliation** — architecture complete: `reconciliations` table, `reconciliation_id` on transactions, backend guards prevent editing/deleting reconciled rows, start/list/delete + eligible-transaction query. UI includes statement date/balance + multi-select and history. | ✅ Architecture + UI |
| 6 | **Budgets** — by category × month × optional account, base + scenario overrides, set/update/delete/list, status (actual vs budget, remaining/overspend, progress bars), configurable signed rollover and category budget moves | ✅ |
| 7 | **Recurring** — income/expense/transfer, weekly (weekday) / monthly (day 1-28), interval, start/end/next-due, pause/resume, run-due generation; feeds forecasting; interactive recurring deep-dive analytics (KPIs, monthly/annual impact, next projected occurrences, 90-day forecast integration, matched historical ledger activity, one-click posting) | ✅ |
| 8 | **Summaries** — current balances, monthly & date-range summaries, category & account breakdowns, net cashflow, trends, CSV export | ✅ |
| 9 | **Cash-flow forecasting** — 30/60/90/180/365-day read-only projection from current balance + recurring + future plans + budget rows + scenario overrides; daily + 12-month roll-ups, alerts, goal-aware | ✅ |
| 10 | **Scenarios / What-if** — Baseline + custom scenarios (Lose job, New house…), each can own plans & budget overrides without touching real ledger; forecasting is scenario-aware | ✅ |
| 11 | **Planned future transactions** — separate from recurring, with scenario association, list/post-to-transaction | ✅ |
| 12 | **Goals** — sinking_fund (target by date) + balance_target (floor); suggested monthly contribution, projected vs current, breach detection shown in forecast | ✅ |
| 13 | **Import/Export** — Filtered CSV transaction export honoring active search/dates/types, preset catalog, JSON-ready via SQLite, file pickers | ✅ |
| 14 | **Privacy** — SQLite file, WAL + foreign keys, one file per install, offline, custom DB path (`FINANCE_TRACKER_DB_PATH` or Settings picker) | ✅ |
| 15 | **Multi-currency** — per-account currency, reporting currency, manual rates or Frankfurter v2, durable SQLite rate cache, source/destination amounts for FX transfers | ✅ |
| 16 | **Loans & EMIs** — liabilities tracking, clickable interactive loan deep-dive with payoff progress bar, financial metrics, 12-month amortization projection schedule, linked recurring EMI bill automation, direct EMI payment recording into ledger, and matched historical payment transactions | ✅ |
| 17 | **HiDPI accessibility** — persistent 80–200% interface scaling from Settings with standard Ctrl/Cmd zoom shortcuts | ✅ |
| 18 | **Holdings & performance** — selectable investment-account list with clickable account deep-dives for holdings, manual-price coverage, FIFO lots, recent events, derived time-weighted charts, and portfolio XIRR | ✅ |
| 19 | **Assets & liabilities** — comprehensive balance sheet & net worth tracking across liquid cash, investment portfolios, loans, and off-ledger holdings (real estate, vehicles, valuables, private equity, personal debt). Features interactive 12-month net worth evolution chart, solvency & debt-to-asset metrics, asset allocation & debt composition bars, categorized deep-dive tables, real-time search, quick revaluation, and full CRUD for off-ledger records. | ✅ |
| 20 | **Safe to spend** — dashboard and budget guidance before payday, configurable spendable accounts, credit-card debt reserves, protected goals/savings, emergency buffer, payment and budget overlap handling, dated offline FX valuation, and an explainable breakdown | ✅ |
| 21 | **Browser-like navigation & history** — top-left back button conditionally displayed when history is available, recording page changes, account deep-dives, and cross-section jumps; full support for platform-specific keyboard shortcuts (⌘[ or ⌘← on macOS, Alt+← on Windows/Linux) and mouse back buttons | ✅ |
| 22 | **PDF Reports, Statements & Per-Page Exports** — universal top-right "Export as PDF" on every page exporting high-fidelity statements honoring active filters and deep-dives; plus dedicated PDF Reports suite with 10 statements and interactive previewer. Built with Blue Horizon theme styling, vector tables, auto-paging, KPI blocks, and direct system opener integration. | ✅ |
| 23 | **FIRE & wealth milestone simulator** — personalized FIRE number from trailing spending and adjustable SWR; investable-asset runway, real-return trajectory, debt-payment release modeling, Coast FIRE / First 100k / Debt-Free / Mortgage Freedom radar, deterministic 30-year Monte Carlo survivability, Dot-com and GFC stress sequences, and PDF export | ✅ |
| 24 | **Anomaly detection & financial health audit** — private SQLite-backed category/payee expense-creep detection, same-card duplicate-charge candidates within 48 hours, quarterly savings/liquidity/debt-to-income/net-worth-velocity scorecard, diagnostic suggestions, ledger drill-through, and PDF export | ✅ |
| 25 | **Backup & Restore** — safely snapshot the SQLite database, attachments/receipts, and settings into a portable timestamped folder; validate and restore a selected backup through an explicit overwrite warning, staged file replacement, and automatic rollback protection | ✅ |
| 26 | **Split transactions** — divide one reconciliable income or expense across two or more compatible categories, with exact native-cent totals and deterministic reporting-currency allocation; budgets, reports, comparisons, tax deductions, filters, and CSV export honor the split lines | ✅ |
| 27 | **Transaction rules** — ordered, local condition/action rules for imported or existing transactions; normalize payees, set categories, append notes and tags, preview changes, preserve reconciled locks, and undo an applied batch | ✅ |
| 28 | **Debt payoff optimizer** — compare avalanche and snowball timelines across loans and configured credit balances, including cascading minimum payments, exact integer-cent interest calculations, reporting-currency FX valuation, and non-amortization warnings | ✅ |
| 29 | **Tax center** — derive tax-year FIFO realized gains with short/long-term holding classification, dividends grouped by account tax treatment, user-mapped deduction buckets, and CSV/PDF output | ✅ |
| 30 | **Comparative analytics & seasonality** — compare arbitrary periods across categories, payees, and accounts with absolute/percentage variance and a zero-month-aware 12-month spending seasonality index | ✅ |
| 31 | **Local notifications** — configurable desktop alerts for recurring/EMI dues, overspent budgets, forecast breaches, planned items, passed paydays, and exhausted safe-to-spend, with per-rule snooze and an in-app log | ✅ |
| 32 | **Payee deep-dive** — searchable payee directory with per-payee spend trend, 90-day comparison, median charge watch, top categories and accounts, recent activity, and PDF export | ✅ |

```
Reporting currency
 ├── FX cache / manual rate overrides
 └── Accounts (each with a native currency)
      ├── Transactions ── Categories
      │     ├── Reconciliation (locked after reconcile)
      │     └── Reports / Export
      ├── Budgets (+ scenario overrides)
      ├── Recurring Rules
      └── Goals
Planning
 ├── Scenarios
 ├── Future Items (→ Forecast, → Post to ledger)
 ├── Budget Overrides
 ├── Goals → Forecast
 └── FIRE simulator → milestones / Monte Carlo / stress tests
         ▼
   Cashflow Forecast
Local analytics
 └── Financial audit → expense creep / duplicate sentinel / health score
```

## Stack

- **Backend:** Rust 1.77+, `tauri 2`, `rusqlite 0.31 (bundled)`, `chrono`, `csv`, `quick-xml`, `encoding_rs`, `reqwest` (Rustls), `rust_decimal`, `directories`, `serde`
- **Frontend:** Vite 7 + TypeScript, `jspdf` + `jspdf-autotable`, Tauri API + dialog/opener/fs/notification plugins, no framework (keeps bundle small; easy to swap to Svelte/React)
- **Design:** Fresh light finance theme (blue horizon with emerald, coral, amber, teal, and violet semantic accents), card grid, progress bars, timeline charts — deliberately distinct from Shelf's cream/paper aesthetic
- **Window & navigation:** Custom themed title bar with platform-aware window controls; windows at 900px or narrower use a menu button and dismissible navigation drawer.

## Run

```bash
# dev (hot reload)
npm install
npm run tauri dev

# production build
npm run build
# or Tauri bundle
npm run tauri build
```

On first launch you'll be prompted to pick a reporting currency (e.g. `USD`, `EUR`, `INR`) — this initializes the SQLite DB at:
- macOS: `~/Library/Application Support/Finance-Tracker/tracker.db`
- Linux: `~/.local/share/financetracker/tracker.db`
- Windows: `%LOCALAPPDATA%/Finance Tracker/tracker.db`
You can change the path in **Settings → Database** or via `FINANCE_TRACKER_DB_PATH=/path/to/file.db npm run tauri dev`.

## GitHub releases

Pushing a `v*` tag (for example `v1.0.0`) runs the release workflow (`.github/workflows/release.yml`): it creates a draft GitHub release, builds native installers for macOS (Intel + Apple Silicon), Linux (x86_64 + ARM64), and Windows (x86_64 + ARM64), then publishes the release once every build succeeds. Branch pushes and pull requests never trigger a release build.

Before tagging, keep the version identical in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, then:

```sh
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

macOS builds use ad-hoc signing (approve under **Privacy & Security** on first launch); Windows builds are unsigned and may show a SmartScreen warning.

### Local notifications

Open **Notifications** in the sidebar to allow system notifications, choose alert rules, set due-date lead times, snooze a rule for a day or a week, and review the local delivery log. Alerts are checked when the app opens, on focus, and every 15 minutes while it runs. The scheduler uses existing read-only finance snapshots; it never posts a transaction or fetches quotes. System permission is requested only when you select **Allow system notifications**. Preferences, deduplication, and the latest 200 log entries are stored on this device, scoped to the selected database path. Desktop alerts require the app process to be running; Windows notification support requires an installed build.

### Payee deep-dive

Open **Payees** in the sidebar, or select a payee name from the ledger or an account's Top Merchants list. The directory groups named income and expense transactions by trimmed, case-insensitive payee name. Each payee page shows lifetime expenses and income, last-90-day spending against the previous 90 days, a 12-month expense trend, top categories (including split allocations), account breakdown, and 12 recent transactions. The price-creep watch compares median expense transaction amounts across the two 90-day windows when each has at least three expenses. It is a transaction-size signal, not a measured unit-price change; item quantity and basket contents are not tracked. All cross-account amounts use the reporting-currency snapshot saved with each transaction. The page can be exported as a PDF.

### Safe to spend and rollover budgets

The Dashboard and Budgets pages show a conservative estimate of **additional, unbudgeted spending before payday**. Choose spendable accounts, an optional next-payday date, an emergency buffer, and additional protected savings. Automatic payday uses the next unposted recurring income into a selected account; without one, the window is 30 days. A passed manual payday requires updating.

The estimate subtracts upcoming and overdue recorded payments, remaining category reserves, all active credit-card debt, protected goals, and configured buffers from selected-account balances. Future income is excluded. Full remaining category budgets for each month touched by the window are reserved; scheduled category expenses consume that reserve first. Carry-in is reserved once across month boundaries. Credit repayments between selected cash accounts and credit cards are not reserved twice. Savings accounts are excluded by default. Goal floors and funded sinking goals protect selected-account money; additional savings and the emergency buffer are separate reserves.

Open **How this is calculated** for the amounts, payment list, calculation timestamp, latest ledger date, and assumptions. This uses recorded data rather than live bank balances. Foreign balances and planned amounts require a local dated manual or cached FX quote; missing quotes prevent a misleading estimate. Existing future ledger transactions use their saved reporting amounts.

Under **Budgets → Configure rollover**, choose the first month whose closing balance should carry forward. Both positive balances and overspending carry; months without a new allocation add zero. Historical edits recalculate carry. **Move money** shifts available category money within the same account scope without changing the ledger. Account-specific envelopes take precedence over global envelopes. Allocations, carry-in, moves, spending, and remaining money are displayed in reporting currency. Scenarios inherit rollover policies and base moves but calculate their own override history; real money moves are made in the base view.

Schema **14 → 15** upgrades through the app's versioned migration and creates a backup. It adds split lines, rules and undo journals, debt assumptions, and tax classifications without rewriting existing ledger rows. Earlier version steps, including 13 → 14, still run in order.

### FIRE simulator and financial audit

**FIRE & milestones** annualizes up to the latest twelve months of recorded income and expenses, divides annual spending by the selected safe withdrawal rate, and compares the result with positive account balances plus investment holdings. The real-return trajectory uses the selected return and inflation assumptions. It adds scheduled loan payments to contributions after their calculated payoff month, and updates milestone dates whenever ledger, investment, debt, or assumption data changes. Monte Carlo results use 1,000 deterministic 30-year stock/bond paths by default, so the same inputs remain reproducible. Historical stress cards replay representative Dot-com and GFC annual return sequences. All values are planning estimates in today's reporting-currency money.

**Financial audit** is read-only and runs locally. It compares complete rolling 12-month windows for category and payee increases, requires continued recent growth, and flags identical nonblank payee/amount pairs on the same credit account within 48 hours. Duplicate findings are review candidates and never change transactions. The quarterly score weights savings rate, liquid months of spending, scheduled loan-payment-to-income, and recent net worth velocity, then generates diagnostic suggestions. Both pages support the universal PDF export action.

## Project structure

```
src-tauri/
  Cargo.toml, tauri.conf.json, capabilities/default.json
  src/
    lib.rs        — all Tauri commands (accounts, categories, ledger, import, budgets, recurring, planning, forecast, reconciliation, settings, reports)
    backup.rs     — cancellable backup creation, manifest/SQLite validation, staged restore, and rollback safety
    db.rs         — SQLite engine (schema v15)
    db/advanced.rs — splits, transaction rules, debt optimizer, tax center, and comparative analytics
    db/analytics.rs — read-only FIRE simulation, milestone forecasting, anomaly detection, and health audit
    db/payees.rs — read-only payee directory and exact-payee analytics
    fx.rs         — Frankfurter v2 HTTP client (no API key)
    model.rs      — domain types
    amount.rs     — cents parsing/formatting
    importer.rs   — 25 CSV presets + camt.053, OFX and QIF parsing
    error.rs
    db/fx.rs      — durable FX cache, manual overrides, rate settings
  icons/
src/
  main.ts         — full SPA, including FIRE planning, milestone radar, anomaly detection, and health audit views
  notifications.ts — local alert scheduler, preferences, snooze, and delivery log
  payees.ts       — payee directory and deep-dive view
  page-pdf-export.ts — per-page PDF statement generators honoring active view filters and deep-dives
  pdf-reports.ts  — 10 dedicated PDF statement generators, interactive sheet previewer, and catalog navigation
  types.ts
  styles.css      — fresh design system
dist/             — Vite build output (frontendDist)
```

## Notes
- Every account owns a native currency. Ledger amounts remain `INTEGER` minor units (currently two-decimal input/display), while converted transaction snapshots are stored in the reporting currency.
- Frankfurter quotes are fetched only when requested from the transaction form, stored in SQLite, and reused for an hour for the current date; historical quotes remain cached. Manual dated rates override the matching API pair.
- Cross-currency transfers store separate source and destination amounts; historical reports use the rate snapshot saved on the transaction.
- Forecasts keep selected-account balances and goals in native currency. The all-account cash-flow projection starts at today’s reporting valuation, uses saved reporting amounts for future ledger entries and dated local rates for unposted plans, and treats internal transfers as net-zero without predicting FX revaluation. Transfer destinations use their own amounts. Reporting-currency budget remainders honor split spending, offset scheduled category expenses, and are converted once per monthly envelope before distributing native cents.
- Bulk category edits skip split transactions with an explanation; edit their split lines individually. Category expense-creep findings use split reporting allocations and count each transaction once per category.
- Import is transactional: whole import rolls back on error; duplicates are flagged and optionally skipped
- Imports (including camt.053, OFX and QIF), recurring postings, and planned postings use the account's native currency and resolve dated local FX rates. Missing rates stop the operation; import previews also check rate availability. OFX statement currency is checked against the target account; QIF date format is selected at import. QIF splits and account transfers are rejected to prevent silent data loss. Material transaction edits resolve FX again unless an explicit snapshot is supplied.
- Net worth and aggregate balance trends convert account balances at each valuation date using local manual rates or the latest cached quote on or before that date. Missing rates are reported. Individual-account balance trends remain in native currency. Non-ledger values in the net-worth chart remain current valuations, not historical appraisals.
- Reporting currency can only change before financial data is recorded. Existing amounts are never silently relabeled.
- Database commands reuse a serialized connection, with schema setup on first use or database switch and a five-second SQLite busy timeout. Loan payments, ledger creation/editing with tags, split lines and attachment references, rule application/undo, planning postings, recurring batches, and reconciliation deletion are atomic.
- Split transactions retain the parent bank amount for balance and reconciliation. Their lines are positive category allocations whose native cents must equal the parent exactly; reporting cents use a largest-remainder allocation and also equal the saved parent reporting amount exactly.
- Import rules run before duplicate detection, so normalized imported rows cannot bypass duplicate checks. Applying rules to existing transactions always previews first in the UI and records an undo journal; reconciled rows remain locked.
- Tax summaries are organizational estimates derived from saved FIFO lots, dividends, and explicit user classifications. They do not embed jurisdiction-specific tax rates or filing advice.
- Loan payments require the actual interest included in the payment; only payment minus interest reduces outstanding, while the optional ledger expense records the full cash payment. Previously recorded payments are not automatically reinterpreted. Payments can be recorded with loan/EMI tags, using an account in reporting currency. Investment account properties and legacy valuations can be edited; complete holding prices continue to supersede legacy values. XIRR uses cash flows through today and requires prices for all open positions; buy events alone do not establish a terminal market value.

### Holding and reconciliation integrity

Backdated holding sales are checked against the full chronological trade history, so they cannot consume shares needed by an already recorded later sale. Account opening balances and opening dates cannot change while the account has reconciliations.

Time-weighted returns chain valuations immediately before each trade or dividend, using trade execution prices and same-day manual prices for other open holdings. Events on the same date follow their recorded order; manual quotes provide a daily valuation, not intraday market data. Missing flow-date prices make returns unavailable instead of using stale valuations. Future events are excluded.

## License

MIT — see [LICENSE](LICENSE).
