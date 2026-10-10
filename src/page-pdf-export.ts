import { invoke } from "@tauri-apps/api/core";
import {
  PdfDocBuilder,
  saveAndPromptPdf,
  generatePeriodOverviewPdf,
  generateBudgetPositionPdf,
  generateCashForecastPdf,
  generateBalanceSheetPdf,
  generateInvestmentPortfolioPdf,
  C_SUCCESS,
  C_DANGER,
  formatMoney,
  formatPercent,
} from "./pdf-reports";
import type {
  Account,
  Category,
  BalanceRecord,
  SummaryRecord,
  TransactionRecord,
  DashboardSnapshot,
  RecurringRuleRecord,
  PlanningScenarioRecord,
  PlanningItemRecord,
  PlanningGoalRecord,
  LoanRecord,
  ReconciliationRecord,
  CategorySpendingPoint,
  ImportPresetSummary,
  FireSnapshot,
  FinancialAuditSnapshot,
  DebtOptimizerSnapshot,
  TaxCenterSnapshot,
  TransactionRuleRecord,
  ComparativeAnalyticsSnapshot,
  PayeeSummary,
  PayeeSnapshot,
} from "./types";

export interface PagePdfExportContext {
  view: string;
  currency: string;
  dbPath: string;
  accounts: Account[];
  categories: Category[];
  balances: BalanceRecord[];
  txFilters: {
    from: string;
    to: string;
    accounts: string[];
    categories: string[];
    kinds: string[];
    search: string;
    include_deleted: boolean;
    limit: number;
    sort_by: string;
    sort_dir: string;
  };
  selectedAccountId: number | null;
  selectedPayee:string|null;
  selectedLoanId: number | null;
  selectedRecurringRuleId: number | null;
  selectedInvestmentAccountId: number | null;
  reconciliationSelectedAccount: string;
  planningTab: "scenarios" | "items" | "goals";
  dashboardAccountRef: string;
  dashboardMonths: number;
  toast: (msg: string, isErr?: boolean) => void;
}

export async function exportCurrentPagePdf(ctx: PagePdfExportContext): Promise<void> {
  try {
    switch (ctx.view) {
      case "transactions":
        await exportTransactionsPagePdf(ctx);
        break;
      case "dashboard":
        await exportDashboardPagePdf(ctx);
        break;
      case "accounts":
        await exportAccountsPagePdf(ctx);
        break;
      case "payees":
        await exportPayeesPagePdf(ctx);
        break;
      case "budgets":
        await exportBudgetsPagePdf(ctx);
        break;
      case "forecast":
        await exportForecastPagePdf(ctx);
        break;
      case "fire":
        await exportFirePagePdf(ctx);
        break;
      case "audit":
        await exportFinancialAuditPagePdf(ctx);
        break;
      case "networth":
        await exportNetWorthPagePdf(ctx);
        break;
      case "investments":
        await exportInvestmentsPagePdf(ctx);
        break;
      case "loans":
        await exportLoansPagePdf(ctx);
        break;
      case "debt":
        await exportDebtPagePdf(ctx);
        break;
      case "tax":
        await exportTaxPagePdf(ctx);
        break;
      case "rules":
        await exportRulesPagePdf(ctx);
        break;
      case "recurring":
        await exportRecurringPagePdf(ctx);
        break;
      case "planning":
        await exportPlanningPagePdf(ctx);
        break;
      case "categories":
        await exportCategoriesPagePdf(ctx);
        break;
      case "reconciliation":
        await exportReconciliationPagePdf(ctx);
        break;
      case "comparisons":
        await exportComparisonsPagePdf(ctx);
        break;
      case "import":
        await exportImportPagePdf(ctx);
        break;
      case "settings":
        await exportSettingsPagePdf(ctx);
        break;
      case "reports":
        await exportReportsPagePdf(ctx);
        break;
      default:
        ctx.toast(`PDF export not supported for view: ${ctx.view}`, true);
    }
  } catch (err: any) {
    console.error("Per-page PDF export failed:", err);
    ctx.toast(`Export failed: ${String(err)}`, true);
  }
}

async function exportPayeesPagePdf(ctx:PagePdfExportContext):Promise<void>{
  if(!ctx.selectedPayee){
    const payees=await invoke<PayeeSummary[]>("list_payees");
    const b=new PdfDocBuilder("Payee Directory","Recorded payees and lifetime expense totals.",ctx.currency);
    b.drawHeader([{label:"Payees",value:String(payees.length)}]);
    b.drawTable({head:[["Payee","Expenses","Lifetime spend","Last transaction"]],body:payees.map(payee=>[
      payee.name,String(payee.expense_count),formatMoney(payee.lifetime_spend_cents,ctx.currency),payee.last_transaction_on,
    ])});
    await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(),"payee_directory.pdf",ctx.toast);
    return;
  }
  const snapshot=await invoke<PayeeSnapshot>("get_payee_snapshot",{payee:ctx.selectedPayee});
  const b=new PdfDocBuilder(`${snapshot.name} — Payee Deep-Dive`,"Expense trend and transaction-size analysis from saved reporting amounts.",ctx.currency);
  b.drawHeader([{label:"First transaction",value:snapshot.first_transaction_on},{label:"Latest transaction",value:snapshot.last_transaction_on}]);
  b.drawKpis([{label:"Lifetime spend",value:formatMoney(snapshot.lifetime_spend_cents,ctx.currency),color:"danger"},
    ...(snapshot.income_count?[{label:"Lifetime income",value:formatMoney(snapshot.lifetime_income_cents,ctx.currency),color:"neutral" as const}]:[]),
    {label:"Past 90 days",value:formatMoney(snapshot.recent_spend_cents,ctx.currency),color:"neutral"},
    {label:"Expenses",value:String(snapshot.expense_count),color:"neutral"}]);
  b.drawSectionHeading("Monthly spending");
  b.drawTable({head:[["Month","Expenses","Spend"]],body:snapshot.monthly.map(month=>[month.month,String(month.transaction_count),formatMoney(month.spent_cents,ctx.currency)])});
  b.drawSectionHeading("Price creep watch");
  b.drawKpis([{label:"Recent median charge",value:snapshot.recent_median_cents===null?"—":formatMoney(snapshot.recent_median_cents,ctx.currency),color:"neutral"},
    {label:"Previous median charge",value:snapshot.previous_median_cents===null?"—":formatMoney(snapshot.previous_median_cents,ctx.currency),color:"neutral"},
    {label:"Change",value:snapshot.price_creep_percent===null?"Insufficient data":`${snapshot.price_creep_percent.toFixed(1)}%`,color:"neutral"}]);
  b.drawCallout("Median transaction size is a proxy; the ledger does not record item quantities or unit prices.","Interpretation","warn");
  b.drawSectionHeading("Top categories — past 365 days");
  b.drawTable({head:[["Category","Transactions","Spend"]],body:snapshot.categories.map(row=>[row.label,String(row.transaction_count),formatMoney(row.spent_cents,ctx.currency)])});
  b.drawSectionHeading("Recent activity");
  b.drawTable({head:[["Date","Type","Account","Category","Amount"]],body:snapshot.recent_activity.map(row=>[
    row.txn_date,row.kind,row.account_name,row.category_name??"—",formatMoney(row.amount_cents,ctx.currency),
  ])});
  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(),`payee_${snapshot.last_transaction_on}.pdf`,ctx.toast);
}

async function exportDebtPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const extra=(document.querySelector<HTMLInputElement>("#debt-extra")?.value||"0.00").trim();
  const snapshot=await invoke<DebtOptimizerSnapshot>("get_debt_optimizer",{extraPayment:extra});
  const b=new PdfDocBuilder("Debt Payoff Strategy Comparison","Avalanche and snowball projections using the configured fixed monthly payment pool.",ctx.currency);
  b.drawHeader([{label:"As of",value:snapshot.as_of},{label:"Extra monthly",value:formatMoney(snapshot.extra_payment_cents,ctx.currency)}]);
  for(const strategy of [snapshot.avalanche,snapshot.snowball]){
    b.drawSectionHeading(strategy.strategy==="avalanche"?"Avalanche — highest APR first":"Snowball — smallest balance first");
    b.drawKpis([{label:"Debt-free",value:strategy.debt_free_month??"Not projected",color:"neutral"},{label:"Total interest",value:formatMoney(strategy.total_interest_cents,ctx.currency),color:"danger"},{label:"Total paid",value:formatMoney(strategy.total_paid_cents,ctx.currency),color:"neutral"}]);
    strategy.warnings.forEach(warning=>b.drawCallout(warning,"Projection warning","warn"));
    b.drawTable({head:[["Debt","Starting balance","APR","Minimum","Payoff","Interest"]],body:strategy.items.map(item=>[item.name,formatMoney(item.starting_balance_cents,ctx.currency),`${(item.annual_rate_bps/100).toFixed(2)}%`,formatMoney(item.minimum_payment_cents,ctx.currency),item.payoff_month??"—",formatMoney(item.total_interest_cents,ctx.currency)])});
  }
  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(),`debt_payoff_${snapshot.as_of}.pdf`,ctx.toast);
}

async function exportTaxPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const year=Number(document.querySelector<HTMLInputElement>("#tax-year")?.value||new Date().getFullYear());
  const snapshot=await invoke<TaxCenterSnapshot>("get_tax_center",{taxYear:year});
  const b=new PdfDocBuilder(`Tax Preparation Summary — ${year}`,"FIFO realized gains, dividend income, and user-mapped deductible expense categories.",ctx.currency);
  b.drawHeader([{label:"Tax year",value:String(year)},{label:"Currency",value:ctx.currency}]);
  b.drawKpis([{label:"Sale proceeds",value:formatMoney(snapshot.realized_proceeds_cents,ctx.currency),color:"neutral"},{label:"Cost basis",value:formatMoney(snapshot.realized_cost_basis_cents,ctx.currency),color:"neutral"},{label:"Short-term gain",value:formatMoney(snapshot.short_term_gain_cents,ctx.currency),color:snapshot.short_term_gain_cents>=0?"success":"danger"},{label:"Long-term gain",value:formatMoney(snapshot.long_term_gain_cents,ctx.currency),color:snapshot.long_term_gain_cents>=0?"success":"danger"}]);
  snapshot.warnings.forEach(warning=>b.drawCallout(warning,"Tax summary note","warn"));
  b.drawSectionHeading("FIFO realized gain detail");
  b.drawTable({head:[["Sold","Account","Treatment","Security","Acquired","Term","Proceeds","Basis","Gain"]],body:snapshot.gains.map(g=>[g.sold_on,g.investment_account_name,g.treatment.replaceAll("_"," "),g.security_symbol,g.bought_on,g.term==="long_term"?"Long":"Short",formatMoney(g.proceeds_cents,ctx.currency),formatMoney(g.cost_basis_cents,ctx.currency),formatMoney(g.gain_cents,ctx.currency)])});
  b.drawSectionHeading("Dividend income");b.drawTable({head:[["Tax treatment","Amount"]],body:snapshot.dividends.map(v=>[v.treatment.replaceAll("_"," "),formatMoney(v.amount_cents,ctx.currency)])});
  b.drawSectionHeading("Deduction buckets");b.drawTable({head:[["Bucket","Transactions","Amount"]],body:snapshot.deductions.map(v=>[v.group,String(v.transaction_count),formatMoney(v.amount_cents,ctx.currency)])});
  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(),`tax_summary_${year}.pdf`,ctx.toast);
}

async function exportRulesPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const rules=await invoke<TransactionRuleRecord[]>("list_transaction_rules");
  const b=new PdfDocBuilder("Transaction Rules","Ordered local import and ledger cleanup rules.",ctx.currency);
  b.drawHeader([{label:"Rules",value:String(rules.length)},{label:"Enabled",value:String(rules.filter(rule=>rule.enabled).length)}]);
  b.drawTable({head:[["Priority","Name","Condition","Actions","Status"]],body:rules.map(rule=>[String(rule.priority),rule.name,`${rule.match_field} ${rule.match_operator.replaceAll("_"," ")} ${rule.match_value}`,[rule.set_payee&&`payee: ${rule.set_payee}`,rule.set_category_name&&`category: ${rule.set_category_name}`,rule.append_note&&"append note",rule.tags.length&&`tags: ${rule.tags.join(", ")}`].filter(Boolean).join("; "),rule.enabled?"Enabled":"Disabled"])});
  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(),"transaction_rules.pdf",ctx.toast);
}

/* =========================================================
   1. Transactions Ledger PDF (Honoring all filters & search)
   ========================================================= */
async function exportTransactionsPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { txFilters, currency, toast } = ctx;
  toast("Generating transactions PDF…");

  const txns = await invoke<TransactionRecord[]>("list_transactions", {
    req: {
      from: txFilters.from || null,
      to: txFilters.to || null,
      accounts: txFilters.accounts,
      categories: txFilters.categories,
      kinds: txFilters.kinds,
      search: txFilters.search || null,
      limit: 10_000,
      include_deleted: txFilters.include_deleted,
      sort_by: txFilters.sort_by || null,
      sort_dir: txFilters.sort_dir || null,
    },
  });

  const b = new PdfDocBuilder(
    "Transactions Ledger",
    "Current filtered ledger transactions with classifications, notes, and totals.",
    currency
  );

  const filterPills: { label: string; value: string }[] = [];
  filterPills.push({
    label: "Accounts",
    value: txFilters.accounts.length ? txFilters.accounts.join(", ") : "All accounts",
  });
  filterPills.push({
    label: "Categories",
    value: txFilters.categories.length ? txFilters.categories.join(", ") : "All categories",
  });
  filterPills.push({
    label: "Types",
    value: txFilters.kinds.length ? txFilters.kinds.join(", ") : "All types",
  });
  if (txFilters.from || txFilters.to) {
    filterPills.push({
      label: "Date Range",
      value: `${txFilters.from || "Beginning"} to ${txFilters.to || "Latest"}`,
    });
  } else {
    filterPills.push({ label: "Date Range", value: "All time" });
  }
  if (txFilters.search) {
    filterPills.push({ label: "Search", value: `"${txFilters.search}"` });
  }
  if (txFilters.include_deleted) {
    filterPills.push({ label: "Deleted", value: "Included" });
  }

  b.drawHeader(filterPills);

  let totalInflows = 0;
  let totalOutflows = 0;
  for (const t of txns) {
    if (t.kind === "income") totalInflows += t.amount_cents;
    else if (t.kind === "expense") totalOutflows += t.amount_cents;
  }
  const netCents = totalInflows - totalOutflows;

  b.drawKpis([
    { label: "Total Inflows", value: formatMoney(totalInflows, currency), color: "success" },
    { label: "Total Outflows", value: formatMoney(totalOutflows, currency), color: "danger" },
    { label: "Net Cash Flow", value: formatMoney(netCents, currency), color: netCents >= 0 ? "success" : "danger" },
    { label: "Records", value: `${txns.length} transactions`, color: "neutral" },
  ]);

  b.drawTable({
    head: [["#", "Date", "Type", "Amount", "Account", "Category", "Payee", "Note"]],
    body: txns.map(t => {
      const isExp = t.kind === "expense";
      const amountStr = `${isExp ? "-" : ""}${formatMoney(t.amount_cents, t.account_currency_code)}`;
      const dateStr = `${t.txn_date}${t.reconciliation_id ? " [R]" : ""}${t.deleted_at ? " [DEL]" : ""}`;
      const toAcc = t.to_account_name ? ` → ${t.to_account_name}` : "";
      return [
        String(t.id),
        dateStr,
        t.kind,
        amountStr,
        `${t.account_name}${toAcc}`,
        t.category_name ?? (t.kind === "transfer" ? "—" : ""),
        t.payee ?? "",
        t.note ?? "",
      ];
    }),
    columnStyles: {
      0: { cellWidth: 32, halign: "right" },
      1: { cellWidth: 58 },
      2: { cellWidth: 42, halign: "center" },
      3: { cellWidth: 68, halign: "right", fontStyle: "bold" },
      4: { cellWidth: 70 },
      5: { cellWidth: 65 },
      6: { cellWidth: 75 },
      7: { cellWidth: "auto" },
    },
    didParseCell: (data) => {
      if (data.section === "body" && data.column.index === 3) {
        const rowTx = txns[data.row.index];
        if (rowTx?.kind === "income") {
          data.cell.styles.textColor = C_SUCCESS;
        } else if (rowTx?.kind === "expense") {
          data.cell.styles.textColor = C_DANGER;
        }
      }
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  const filterSuffix = txFilters.search ? `_${txFilters.search.replace(/[^a-zA-Z0-9]/g, "_")}` : "";
  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(), `transactions_ledger_${today}${filterSuffix}.pdf`, toast);
}

/* =========================================================
   2. Dashboard Summary PDF
   ========================================================= */
async function exportDashboardPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { currency, toast, accounts } = ctx;
  toast("Generating dashboard summary PDF…");

  const accSel = document.querySelector<HTMLSelectElement>("#dash-account, #d-account, #dashboard-account");
  const monthSel = document.querySelector<HTMLSelectElement>("#dash-months, #d-months, #dashboard-months");
  const accountRef = accSel?.value ?? ctx.dashboardAccountRef;
  const months = monthSel?.value ? Number(monthSel.value) : ctx.dashboardMonths;

  const snap = await invoke<DashboardSnapshot>("dashboard_snapshot", {
    account: accountRef || null,
    months,
  });

  const selectedAcc = accountRef ? (accounts.find(a => String(a.id) === accountRef || a.name === accountRef) ?? null) : null;
  const activeCurrency = selectedAcc ? selectedAcc.currency_code : currency;

  const b = new PdfDocBuilder(
    "Financial Dashboard Summary",
    "Consolidated executive view: balances, monthly cash flow trends, and recent activity.",
    currency
  );

  b.drawHeader([
    { label: "Scope", value: selectedAcc ? selectedAcc.name : "Consolidated (All Accounts)" },
    { label: "Trend Window", value: `${months} Months` },
    { label: "Valuation Base", value: activeCurrency },
  ]);

  const totalBal = snap.balances.reduce((s, a) => s + a.current_balance_cents, 0);

  b.drawKpis([
    { label: "Total Balance", value: formatMoney(totalBal, activeCurrency), color: "neutral" },
    { label: "Monthly Inflows", value: formatMoney(snap.summary.income_cents, activeCurrency), color: "success" },
    { label: "Monthly Outflows", value: formatMoney(snap.summary.expense_cents, activeCurrency), color: "danger" },
    { label: "Net Cash Flow", value: formatMoney(snap.summary.net_cents, activeCurrency), color: snap.summary.net_cents >= 0 ? "success" : "danger" },
  ]);

  b.drawSectionHeading("Current Account Balances");
  b.drawTable({
    head: [["Account Name", "Type", "Currency", "Current Balance"]],
    body: snap.balances.map(a => [
      a.account_name,
      a.account_kind,
      a.currency_code,
      formatMoney(a.current_balance_cents, a.currency_code),
    ]),
    columnStyles: {
      3: { halign: "right", fontStyle: "bold" },
    },
  });

  if (snap.cashflow && snap.cashflow.length > 0) {
    b.drawSectionHeading("Monthly Cash Flow Trend");
    b.drawTable({
      head: [["Month", "Inflows", "Outflows", "Net Cash Flow"]],
      body: snap.cashflow.map(m => [
        m.month,
        formatMoney(m.income_cents, activeCurrency),
        formatMoney(m.expense_cents, activeCurrency),
        formatMoney(m.net_cents, activeCurrency),
      ]),
      columnStyles: {
        1: { halign: "right" },
        2: { halign: "right" },
        3: { halign: "right", fontStyle: "bold" },
      },
      didParseCell: (data) => {
        if (data.section === "body" && data.column.index === 3) {
          const pt = snap.cashflow[data.row.index];
          if (pt && pt.net_cents >= 0) data.cell.styles.textColor = C_SUCCESS;
          else if (pt) data.cell.styles.textColor = C_DANGER;
        }
      },
    });
  }

  if (snap.spending && snap.spending.length > 0) {
    b.drawSectionHeading("Top Spending Categories");
    b.drawTable({
      head: [["Category", "Amount Spent"]],
      body: snap.spending.map(c => [
        c.category_name,
        formatMoney(c.spent_cents, activeCurrency),
      ]),
      columnStyles: {
        1: { halign: "right", fontStyle: "bold", textColor: C_DANGER },
      },
    });
  }

  if (snap.recent_transactions.length > 0) {
    b.drawSectionHeading("Recent Activity");
    b.drawTable({
      head: [["Date", "Account", "Type", "Payee", "Category", "Amount"]],
      body: snap.recent_transactions.slice(0, 15).map(t => [
        t.txn_date,
        t.account_name,
        t.kind,
        t.payee ?? "",
        t.category_name ?? "",
        `${t.kind === "expense" ? "-" : ""}${formatMoney(t.amount_cents, t.account_currency_code)}`,
      ]),
      columnStyles: {
        5: { halign: "right", fontStyle: "bold" },
      },
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(), `dashboard_summary_${today}.pdf`, toast);
}

/* =========================================================
   3. Accounts Page PDF (Unified Register & Active Detail)
   ========================================================= */
async function exportAccountsPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { currency, toast, accounts } = ctx;
  toast("Generating accounts statement PDF…");
  const today = new Date().toISOString().slice(0, 10);

  const [balances, repBalances] = await Promise.all([
    invoke<BalanceRecord[]>("get_balances").catch(() => []),
    invoke<BalanceRecord[]>("get_reporting_balances").catch(() => []),
  ]);

  const selectedAcc = ctx.selectedAccountId
    ? (accounts.find(a => a.id === ctx.selectedAccountId) ?? accounts[0] ?? null)
    : (accounts[0] ?? null);

  const b = new PdfDocBuilder(
    selectedAcc ? `Accounts Overview & Detail: ${selectedAcc.name}` : "Accounts Register & Balances",
    "Consolidated register of all active financial accounts, balances, and ledger activity.",
    currency
  );

  const repMap = new Map<number, number>();
  for (const rb of repBalances) repMap.set(rb.account_id, rb.current_balance_cents);

  let totalLiquid = 0;
  let totalCredit = 0;
  for (const a of accounts) {
    const repCents = repMap.get(a.id) ?? 0;
    if (a.kind === "credit") totalCredit += Math.abs(repCents);
    else totalLiquid += repCents;
  }
  const netPosition = totalLiquid - totalCredit;

  b.drawHeader([
    { label: "Total Accounts", value: String(accounts.length) },
    { label: "Selected Account", value: selectedAcc ? selectedAcc.name : "All" },
    { label: "Base Currency", value: currency },
  ]);

  b.drawKpis([
    { label: "Total Accounts", value: String(accounts.length), color: "neutral" },
    { label: "Liquid Assets", value: formatMoney(totalLiquid, currency), color: "success" },
    { label: "Credit Liabilities", value: formatMoney(totalCredit, currency), color: "danger" },
    { label: "Net Liquid Position", value: formatMoney(netPosition, currency), color: netPosition >= 0 ? "success" : "danger" },
  ]);

  b.drawSectionHeading("Accounts Register");
  b.drawTable({
    head: [["Account Name", "Kind", "Opened On", "Currency", "Native Balance", "Reporting Valuation"]],
    body: accounts.map(a => {
      const bal = balances.find(b => b.account_id === a.id)?.current_balance_cents ?? a.opening_balance_cents;
      const rep = repMap.get(a.id) ?? 0;
      return [
        a.name,
        a.kind,
        a.opened_on || "—",
        a.currency_code,
        formatMoney(bal, a.currency_code),
        formatMoney(rep, currency),
      ];
    }),
    columnStyles: {
      4: { halign: "right" },
      5: { halign: "right", fontStyle: "bold" },
    },
  });

  // If there is an active selected account, render its deep-dive section
  if (selectedAcc) {
    const [summary, categories, txns] = await Promise.all([
      invoke<SummaryRecord>("get_summary", { from: "1970-01-01", to: today, account: String(selectedAcc.id) }).catch(() => null),
      invoke<CategorySpendingPoint[]>("category_spending", { from: "1970-01-01", to: today, limit: 8, account: String(selectedAcc.id) }).catch(() => []),
      invoke<TransactionRecord[]>("list_transactions", { req: { accounts: [selectedAcc.name], limit: 50 } }).catch(() => []),
    ]);

    b.drawSectionHeading(
      `Active Account Deep-Dive: ${selectedAcc.name}`,
      `Currency: ${selectedAcc.currency_code} · Type: ${selectedAcc.kind.toUpperCase()}`
    );

    if (summary) {
      b.drawKpis([
        { label: "Lifetime Inflows", value: formatMoney(summary.income_cents, selectedAcc.currency_code), color: "success" },
        { label: "Lifetime Outflows", value: formatMoney(summary.expense_cents, selectedAcc.currency_code), color: "danger" },
        { label: "Net Cash Flow", value: formatMoney(summary.net_cents, selectedAcc.currency_code), color: summary.net_cents >= 0 ? "success" : "danger" },
        { label: "Activity Count", value: `${summary.transaction_count} txns`, color: "neutral" },
      ]);
    }

    if (categories && categories.length > 0) {
      b.drawSectionHeading("Category Spending for this Account");
      b.drawTable({
        head: [["Category", "Total Spent"]],
        body: categories.map(c => [c.category_name, formatMoney(c.spent_cents, selectedAcc.currency_code)]),
        columnStyles: { 1: { halign: "right", fontStyle: "bold" } },
      });
    }

    if (txns && txns.length > 0) {
      b.drawSectionHeading("Recent Activity for this Account");
      b.drawTable({
        head: [["#", "Date", "Type", "Payee", "Category", "Amount"]],
        body: txns.map(t => [
          String(t.id),
          t.txn_date,
          t.kind,
          t.payee ?? "",
          t.category_name ?? "",
          `${t.kind === "expense" ? "-" : ""}${formatMoney(t.amount_cents, t.account_currency_code)}`,
        ]),
        columnStyles: {
          0: { cellWidth: 35, halign: "right" },
          5: { halign: "right", fontStyle: "bold" },
        },
      });
    }
  }

  const filename = selectedAcc
    ? `accounts_overview_${selectedAcc.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${today}.pdf`
    : `accounts_register_${today}.pdf`;
  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(), filename, toast);
}

/* =========================================================
   4. Budgets Page PDF (Honoring month & scenario filters)
   ========================================================= */
async function exportBudgetsPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { toast } = ctx;
  toast("Generating budgets position PDF…");

  const monthInput = document.querySelector<HTMLInputElement>("#b-month");
  const scenInput = document.querySelector<HTMLSelectElement>("#b-scenario");
  const month = monthInput?.value || new Date().toISOString().slice(0, 7);
  const scenario = scenInput?.value || null;

  let scenarioId: number | null = null;
  if (scenario) {
    const scenarios = await invoke<PlanningScenarioRecord[]>("list_scenarios").catch(() => []);
    const match = scenarios.find(s => s.name === scenario || String(s.id) === scenario);
    if (match) scenarioId = match.id;
  }

  const buffer = await generateBudgetPositionPdf({ month, scenarioId });
  const today = new Date().toISOString().slice(0, 10);
  await saveAndPromptPdf(buffer, `budget_position_${month}_${today}.pdf`, toast);
}

/* =========================================================
   5. Forecast Page PDF (Honoring horizon, account, & scenario)
   ========================================================= */
async function exportForecastPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { toast, accounts } = ctx;
  toast("Generating cash-flow forecast PDF…");

  const scenEl = document.querySelector<HTMLSelectElement>("#f-scen");
  const accEl = document.querySelector<HTMLSelectElement>("#f-acc");
  const daysEl = document.querySelector<HTMLSelectElement>("#f-days");

  const scenName = scenEl?.value || null;
  const accName = accEl?.value || null;
  const horizonDays = daysEl?.value ? Number(daysEl.value) : 90;

  let scenarioId: number | null = null;
  if (scenName) {
    const scenarios = await invoke<PlanningScenarioRecord[]>("list_scenarios").catch(() => []);
    const match = scenarios.find(s => s.name === scenName);
    if (match) scenarioId = match.id;
  }

  let accountId: number | null = null;
  if (accName) {
    const match = accounts.find(a => a.name === accName);
    if (match) accountId = match.id;
  }

  const buffer = await generateCashForecastPdf({ horizonDays, accountId, scenarioId });
  await saveAndPromptPdf(buffer, `cash_forecast_${horizonDays}d_${new Date().toISOString().slice(0, 10)}.pdf`, toast);
}

async function exportFirePagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { toast, currency } = ctx;
  toast("Generating FIRE & milestones PDF…");
  const numberValue=(selector:string,fallback:number)=>{
    const value=Number(document.querySelector<HTMLInputElement>(selector)?.value);
    return Number.isFinite(value)?value:fallback;
  };
  const snapshot=await invoke<FireSnapshot>("get_fire_snapshot",{
    safeWithdrawalRatePercent:numberValue("#fire-swr",4),
    stockAllocationPercent:numberValue("#fire-stocks",70),
    expectedReturnPercent:numberValue("#fire-return",7),
    inflationPercent:numberValue("#fire-inflation",3),
    currentAge:numberValue("#fire-age",35),
    retirementAge:numberValue("#fire-retire-age",60),
    simulations:1000,
  });
  const b=new PdfDocBuilder(
    "FIRE & Wealth Milestone Plan",
    "Long-term independence projection from historical spending, investable assets, and debt schedules.",
    currency,
  );
  b.drawHeader([
    {label:"As of",value:snapshot.as_of},
    {label:"History",value:`${snapshot.history_from} to ${snapshot.history_to}`},
    {label:"SWR",value:`${snapshot.assumptions.safe_withdrawal_rate_percent.toFixed(2)}%`},
  ]);
  b.drawKpis([
    {label:"FIRE number",value:formatMoney(snapshot.fire_number_cents,currency),color:"neutral"},
    {label:"Investable assets",value:formatMoney(snapshot.investable_assets_cents,currency),color:"success"},
    {label:"Funded",value:`${snapshot.progress_percent.toFixed(1)}%`,color:snapshot.progress_percent>=100?"success":"warn"},
    {label:"Projected date",value:snapshot.projected_fire_date??"No current date",color:snapshot.projected_fire_date?"neutral":"danger"},
  ]);
  b.drawSectionHeading("Historical Cash Flow & Assumptions");
  b.drawTable({
    head:[["Measure","Value","Assumption","Value"]],
    body:[
      ["Annual spending",formatMoney(snapshot.annual_spending_cents,currency),"Stock allocation",`${snapshot.assumptions.stock_allocation_percent.toFixed(0)}%`],
      ["Annual income",formatMoney(snapshot.annual_income_cents,currency),"Expected return",`${snapshot.assumptions.expected_return_percent.toFixed(1)}%`],
      ["Annual savings",formatMoney(snapshot.annual_savings_cents,currency),"Inflation",`${snapshot.assumptions.inflation_percent.toFixed(1)}%`],
      ["Current net worth",formatMoney(snapshot.current_net_worth_cents,currency),"Real return",`${snapshot.assumptions.real_return_percent.toFixed(1)}%`],
    ],
    columnStyles:{1:{halign:"right"},3:{halign:"right"}},
  });
  b.drawSectionHeading("Milestone Radar");
  b.drawTable({
    head:[["Milestone","Progress","Current","Target","Estimated / achieved"]],
    body:snapshot.milestones.map(milestone=>[
      milestone.name,`${milestone.progress_percent.toFixed(1)}%`,formatMoney(milestone.current_cents,currency),
      formatMoney(milestone.target_cents,currency),milestone.achieved?"Achieved":milestone.estimated_date??"No current date",
    ]),
    columnStyles:{1:{halign:"right"},2:{halign:"right"},3:{halign:"right"}},
  });
  b.drawSectionHeading("30-Year Portfolio Survivability");
  b.drawKpis([
    {label:"Success rate",value:`${snapshot.monte_carlo.success_rate_percent.toFixed(1)}%`,color:snapshot.monte_carlo.success_rate_percent>=85?"success":"warn"},
    {label:"10th percentile",value:formatMoney(snapshot.monte_carlo.percentile_10_ending_balance_cents,currency),color:"neutral"},
    {label:"Median ending",value:formatMoney(snapshot.monte_carlo.median_ending_balance_cents,currency),color:"success"},
  ]);
  b.drawSectionHeading("Historical Stress Tests");
  b.drawTable({
    head:[["Sequence","Result","Lowest balance","Ending balance"]],
    body:snapshot.stress_tests.map(stress=>[stress.name,stress.survived?"Survived":"Depleted",formatMoney(stress.minimum_balance_cents,currency),formatMoney(stress.ending_balance_cents,currency)]),
    columnStyles:{2:{halign:"right"},3:{halign:"right"}},
  });
  snapshot.warnings.forEach(warning=>b.drawCallout(warning,"Planning limitation","warn"));
  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(),`fire_plan_${snapshot.as_of}.pdf`,toast);
}

async function exportFinancialAuditPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { toast, currency }=ctx;
  toast("Generating financial health audit PDF…");
  const audit=await invoke<FinancialAuditSnapshot>("get_financial_audit");
  const b=new PdfDocBuilder(
    "Financial Health Audit",
    "Private quarterly scorecard, spending leak radar, and duplicate-charge review.",
    currency,
  );
  b.drawHeader([
    {label:"Quarter",value:audit.quarter_label},
    {label:"As of",value:audit.as_of},
    {label:"Transactions",value:audit.transaction_count.toLocaleString()},
  ]);
  b.drawKpis([
    {label:"Health score",value:`${audit.score}/100`,sub:audit.grade,color:audit.score>=75?"success":audit.score>=50?"warn":"danger"},
    ...audit.metrics.slice(0,3).map(metric=>({label:metric.label,value:metric.display_value,sub:`${metric.score}/100`,color:metric.status==="healthy"?"success" as const:metric.status==="watch"?"warn" as const:"danger" as const})),
  ]);
  b.drawSectionHeading("Scorecard Diagnostics");
  b.drawTable({
    head:[["Metric","Value","Score","Diagnostic"]],
    body:audit.metrics.map(metric=>[metric.label,metric.display_value,`${metric.score}/100`,metric.explanation]),
    columnStyles:{1:{halign:"right"},2:{halign:"right"}},
  });
  b.drawSectionHeading("Anomalies & Spending Leaks");
  b.drawTable({
    head:[["Severity","Finding","Current","Baseline / match","Ledger IDs"]],
    body:audit.findings.length?audit.findings.map(finding=>[
      finding.severity.toUpperCase(),finding.title,formatMoney(finding.current_cents,currency),
      formatMoney(finding.baseline_cents,currency),finding.transaction_ids.map(id=>`#${id}`).join(", ")||"—",
    ]):[["—","No anomalies met the audit thresholds.","—","—","—"]],
    columnStyles:{2:{halign:"right"},3:{halign:"right"}},
  });
  b.drawSectionHeading("Diagnostic Suggestions");
  audit.suggestions.forEach((suggestion,index)=>b.drawCallout(suggestion,`Priority ${index+1}`,index===0&&audit.score<50?"danger":"info"));
  audit.warnings.forEach(warning=>b.drawCallout(warning,"Method note","warn"));
  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(),`financial_health_audit_${audit.as_of}.pdf`,toast);
}

/* =========================================================
   6. Balance Sheet & Net Worth PDF
   ========================================================= */
async function exportNetWorthPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { toast } = ctx;
  toast("Generating balance sheet & net worth PDF…");
  const today = new Date().toISOString().slice(0, 10);
  const buffer = await generateBalanceSheetPdf({ asOfDate: today });
  await saveAndPromptPdf(buffer, `balance_sheet_networth_${today}.pdf`, toast);
}

/* =========================================================
   7. Investment Accounts & Portfolios PDF
   ========================================================= */
async function exportInvestmentsPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { toast, selectedInvestmentAccountId } = ctx;
  toast("Generating investment portfolio PDF…");
  const buffer = await generateInvestmentPortfolioPdf({ investmentAccountId: selectedInvestmentAccountId });
  const today = new Date().toISOString().slice(0, 10);
  await saveAndPromptPdf(buffer, `investment_portfolio_${today}.pdf`, toast);
}

/* =========================================================
   8. Loans, Mortgages & EMIs PDF
   ========================================================= */
async function exportLoansPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { currency, toast } = ctx;
  toast("Generating loans statement PDF…");
  const today = new Date().toISOString().slice(0, 10);

  const loans = await invoke<LoanRecord[]>("list_loans").catch(() => []);

  const totalPrincipal = loans.reduce((s, l) => s + l.principal_cents, 0);
  const totalCurrent = loans.reduce((s, l) => s + l.outstanding_cents, 0);
  const totalMonthly = loans.reduce((s, l) => s + l.emi_cents, 0);
  const totalPaid = Math.max(0, totalPrincipal - totalCurrent);
  const overallProgress = totalPrincipal > 0 ? (totalPaid / totalPrincipal) * 100 : 0;

  const selectedLoan = ctx.selectedLoanId
    ? (loans.find(l => l.id === ctx.selectedLoanId) ?? loans[0] ?? null)
    : (loans[0] ?? null);

  const b = new PdfDocBuilder(
    selectedLoan ? `Loans & EMI Statement: ${selectedLoan.name}` : "Loans, Mortgages & EMI Obligations",
    "Consolidated liabilities portfolio, interest rates, monthly debt service, and balances.",
    currency
  );

  b.drawHeader([
    { label: "Active Loans", value: String(loans.length) },
    { label: "Selected Loan", value: selectedLoan ? selectedLoan.name : "All" },
    { label: "Base Currency", value: currency },
  ]);

  b.drawKpis([
    { label: "Total Borrowed", value: formatMoney(totalPrincipal, currency), color: "neutral" },
    { label: "Total Outstanding", value: formatMoney(totalCurrent, currency), color: "danger" },
    { label: "Monthly Debt Service", value: formatMoney(totalMonthly, currency), color: "warn" },
    { label: "Overall Repaid", value: formatPercent(overallProgress), color: "success" },
  ]);

  b.drawSectionHeading("Active Loans Portfolio");
  b.drawTable({
    head: [["Loan Name", "Lender", "Rate %", "Monthly EMI", "Original Principal", "Current Balance", "Repaid %"]],
    body: loans.map(l => {
      const paid = Math.max(0, l.principal_cents - l.outstanding_cents);
      const pct = l.principal_cents > 0 ? (paid / l.principal_cents) * 100 : 0;
      const rateStr = l.annual_rate_bps !== null ? `${(l.annual_rate_bps / 100).toFixed(2)}%` : "—";
      return [
        l.name,
        l.lender ?? "—",
        rateStr,
        formatMoney(l.emi_cents, currency),
        formatMoney(l.principal_cents, currency),
        formatMoney(l.outstanding_cents, currency),
        formatPercent(pct),
      ];
    }),
    columnStyles: {
      2: { halign: "center" },
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right", fontStyle: "bold", textColor: C_DANGER },
      6: { halign: "center" },
    },
  });

  if (selectedLoan) {
    const paidCents = Math.max(0, selectedLoan.principal_cents - selectedLoan.outstanding_cents);
    const loanProgress = selectedLoan.principal_cents > 0 ? (paidCents / selectedLoan.principal_cents) * 100 : 0;
    const loanRateStr = selectedLoan.annual_rate_bps !== null ? `${(selectedLoan.annual_rate_bps / 100).toFixed(2)}%` : "—";

    b.drawSectionHeading(
      `Selected Loan Detail: ${selectedLoan.name}`,
      `Lender: ${selectedLoan.lender || "—"} · Rate: ${loanRateStr}`
    );
    b.drawKpis([
      { label: "Original Principal", value: formatMoney(selectedLoan.principal_cents, currency), color: "neutral" },
      { label: "Current Balance", value: formatMoney(selectedLoan.outstanding_cents, currency), color: "danger" },
      { label: "Monthly EMI", value: formatMoney(selectedLoan.emi_cents, currency), color: "warn" },
      { label: "Principal Repaid", value: formatPercent(loanProgress), color: "success" },
    ]);

    const txns = await invoke<TransactionRecord[]>("list_transactions", {
      req: { search: selectedLoan.name, limit: 50 },
    }).catch(() => []);

    if (txns && txns.length > 0) {
      b.drawSectionHeading("Recorded Payments for this Loan");
      b.drawTable({
        head: [["Date", "Account", "Amount", "Note"]],
        body: txns.map(t => [
          t.txn_date,
          t.account_name,
          formatMoney(t.amount_cents, t.account_currency_code),
          t.note ?? "",
        ]),
        columnStyles: { 2: { halign: "right", fontStyle: "bold" } },
      });
    }
  }

  const filename = selectedLoan
    ? `loans_statement_${selectedLoan.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${today}.pdf`
    : `loans_obligations_${today}.pdf`;
  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(), filename, toast);
}

/* =========================================================
   9. Recurring Rules PDF
   ========================================================= */
async function exportRecurringPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { currency, toast } = ctx;
  toast("Generating recurring commitments PDF…");
  const today = new Date().toISOString().slice(0, 10);

  const rules = await invoke<RecurringRuleRecord[]>("list_recurring").catch(() => []);

  let monthlyInflow = 0;
  let monthlyOutflow = 0;
  for (const r of rules) {
    if (r.paused) continue;
    const mult = r.cadence === "weekly" ? 52 / 12 : 1;
    const m = Math.round(r.amount_cents * mult);
    if (r.kind === "income") monthlyInflow += m;
    else if (r.kind === "expense") monthlyOutflow += m;
  }
  const netMonthly = monthlyInflow - monthlyOutflow;

  const selectedRule = ctx.selectedRecurringRuleId
    ? (rules.find(r => r.id === ctx.selectedRecurringRuleId) ?? rules[0] ?? null)
    : (rules[0] ?? null);

  const b = new PdfDocBuilder(
    selectedRule ? `Recurring Rule Analysis: ${selectedRule.name}` : "Recurring Rules & Scheduled Commitments",
    "Active subscriptions, scheduled bills, recurring salary, and upcoming automated transactions.",
    currency
  );

  b.drawHeader([
    { label: "Total Rules", value: String(rules.length) },
    { label: "Selected Rule", value: selectedRule ? selectedRule.name : "All" },
    { label: "Base Currency", value: currency },
  ]);

  b.drawKpis([
    { label: "Active Rules", value: String(rules.filter(r => !r.paused).length), color: "neutral" },
    { label: "Monthly Inflows", value: formatMoney(monthlyInflow, currency), color: "success" },
    { label: "Monthly Commitments", value: formatMoney(monthlyOutflow, currency), color: "danger" },
    { label: "Net Monthly Impact", value: formatMoney(netMonthly, currency), color: netMonthly >= 0 ? "success" : "danger" },
  ]);

  b.drawSectionHeading("Scheduled Commitments Register");
  b.drawTable({
    head: [["Name", "Type", "Cadence", "Account", "Category", "Amount", "Next Due", "Status"]],
    body: rules.map(r => {
      const cadence = r.cadence === "weekly" ? "Weekly" : `Monthly (Day ${r.day_of_month ?? 1})`;
      return [
        r.name,
        r.kind,
        cadence,
        r.account_name,
        r.category_name ?? (r.kind === "transfer" ? "—" : ""),
        `${r.kind === "expense" ? "-" : ""}${formatMoney(r.amount_cents, currency)}`,
        r.next_due_on,
        r.paused ? "PAUSED" : "ACTIVE",
      ];
    }),
    columnStyles: {
      1: { halign: "center" },
      5: { halign: "right", fontStyle: "bold" },
      6: { halign: "center" },
      7: { halign: "center" },
    },
  });

  if (selectedRule) {
    const mult = selectedRule.cadence === "weekly" ? 52 / 12 : 1;
    const monthlyEst = Math.round(selectedRule.amount_cents * mult);
    const annualEst = monthlyEst * 12;

    b.drawSectionHeading(
      `Selected Rule Insights: ${selectedRule.name}`,
      `Next Due: ${selectedRule.next_due_on} · Status: ${selectedRule.paused ? "PAUSED" : "ACTIVE"}`
    );
    b.drawKpis([
      { label: "Per Occurrence", value: formatMoney(selectedRule.amount_cents, currency), color: "neutral" },
      { label: "Est. Monthly Impact", value: formatMoney(monthlyEst, currency), color: selectedRule.kind === "income" ? "success" : "danger" },
      { label: "Est. Annual Impact", value: formatMoney(annualEst, currency), color: selectedRule.kind === "income" ? "success" : "danger" },
      { label: "Rule Status", value: selectedRule.paused ? "Paused" : "Active", color: selectedRule.paused ? "warn" : "success" },
    ]);

    const txns = await invoke<TransactionRecord[]>("list_transactions", {
      req: { search: selectedRule.name, limit: 50 },
    }).catch(() => []);

    if (txns && txns.length > 0) {
      b.drawSectionHeading("Historical Postings for this Rule");
      b.drawTable({
        head: [["Date", "Account", "Category", "Amount", "Note"]],
        body: txns.map(t => [
          t.txn_date,
          t.account_name,
          t.category_name ?? "",
          formatMoney(t.amount_cents, t.account_currency_code),
          t.note ?? "",
        ]),
        columnStyles: { 3: { halign: "right", fontStyle: "bold" } },
      });
    }
  }

  const filename = selectedRule
    ? `recurring_rule_${selectedRule.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${today}.pdf`
    : `recurring_rules_${today}.pdf`;
  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(), filename, toast);
}

/* =========================================================
   10. Planning, Scenarios & Goals PDF
   ========================================================= */
async function exportPlanningPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { currency, toast } = ctx;
  toast("Generating financial plans & goals PDF…");
  const today = new Date().toISOString().slice(0, 10);

  const [scenarios, items, goals] = await Promise.all([
    invoke<PlanningScenarioRecord[]>("list_scenarios").catch(() => []),
    invoke<PlanningItemRecord[]>("list_planning_items", { scenarioId: null }).catch(() => []),
    invoke<PlanningGoalRecord[]>("list_goals").catch(() => []),
  ]);

  const b = new PdfDocBuilder(
    "Financial Planning, Scenarios & Goals",
    "Forward-looking planned transactions, what-if scenarios, and savings goal milestones.",
    currency
  );

  b.drawHeader([
    { label: "Scenarios", value: String(scenarios.length) },
    { label: "Planned Items", value: String(items.length) },
    { label: "Active Goals", value: String(goals.length) },
    { label: "Base Currency", value: currency },
  ]);

  const totalGoalsTarget = goals.reduce((s, g) => s + (g.target_amount_cents ?? g.minimum_balance_cents ?? 0), 0);

  b.drawKpis([
    { label: "Scenarios Count", value: String(scenarios.length), color: "neutral" },
    { label: "Future Planned Items", value: String(items.length), color: "neutral" },
    { label: "Active Goals Count", value: String(goals.length), color: "neutral" },
    { label: "Total Goals Target", value: formatMoney(totalGoalsTarget, currency), color: "success" },
  ]);

  if (goals.length > 0) {
    b.drawSectionHeading("Savings Goals & Sinking Funds");
    b.drawTable({
      head: [["Goal Name", "Type", "Account", "Target / Minimum", "Target Date"]],
      body: goals.map(g => {
        const target = g.target_amount_cents ?? g.minimum_balance_cents ?? 0;
        return [
          g.name,
          g.kind === "sinking_fund" ? "Sinking Fund" : "Balance Floor",
          g.account_name,
          formatMoney(target, currency),
          g.due_on ?? "Ongoing",
        ];
      }),
      columnStyles: {
        3: { halign: "right", fontStyle: "bold" },
        4: { halign: "center" },
      },
    });
  }

  if (items.length > 0) {
    b.drawSectionHeading("Planned Future Transactions");
    b.drawTable({
      head: [["Date", "Title", "Type", "Account", "Category", "Amount", "Scenario"]],
      body: items.map(i => [
        i.due_on,
        i.title,
        i.kind,
        i.account_name,
        i.category_name ?? "",
        formatMoney(i.amount_cents, currency),
        i.scenario_name ?? "Baseline",
      ]),
      columnStyles: {
        5: { halign: "right", fontStyle: "bold" },
      },
    });
  }

  if (scenarios.length > 0) {
    b.drawSectionHeading("What-If Scenarios");
    b.drawTable({
      head: [["Scenario Name", "Description"]],
      body: scenarios.map(s => [s.name, s.note ?? "—"]),
    });
  }

  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(), `financial_planning_goals_${today}.pdf`, toast);
}

/* =========================================================
   11. Categories Directory PDF
   ========================================================= */
async function exportCategoriesPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { currency, toast, categories } = ctx;
  toast("Generating category taxonomy PDF…");
  const today = new Date().toISOString().slice(0, 10);

  const spending = await invoke<CategorySpendingPoint[]>("category_spending", { from: "1970-01-01", to: today, limit: 100 }).catch(() => []);
  const spendMap = new Map<number, number>();
  for (const s of spending) spendMap.set(s.category_id, s.spent_cents);

  const b = new PdfDocBuilder(
    "Category Directory & Classification Structure",
    "Active income and expense classification categories and recent spending totals.",
    currency
  );

  const expCats = categories.filter(c => c.kind === "expense");
  const incCats = categories.filter(c => c.kind === "income");

  b.drawHeader([
    { label: "Total Categories", value: String(categories.length) },
    { label: "Expense Categories", value: String(expCats.length) },
    { label: "Income Categories", value: String(incCats.length) },
    { label: "Base Currency", value: currency },
  ]);

  b.drawKpis([
    { label: "Total Categories", value: String(categories.length), color: "neutral" },
    { label: "Expense Categories", value: String(expCats.length), color: "danger" },
    { label: "Income Categories", value: String(incCats.length), color: "success" },
  ]);

  b.drawSectionHeading("Expense Categories");
  b.drawTable({
    head: [["Category Name", "Recent Period Spending"]],
    body: expCats.map(c => [
      c.name,
      formatMoney(spendMap.get(c.id) ?? 0, currency),
    ]),
    columnStyles: {
      1: { halign: "right", fontStyle: "bold" },
    },
  });

  b.drawSectionHeading("Income Categories");
  b.drawTable({
    head: [["Category Name", "Classification"]],
    body: incCats.map(c => [c.name, "Income"]),
  });

  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(), `category_directory_${today}.pdf`, toast);
}

/* =========================================================
   12. Reconciliation Summary PDF
   ========================================================= */
async function exportReconciliationPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { currency, toast, reconciliationSelectedAccount } = ctx;
  toast("Generating reconciliation statement PDF…");
  const today = new Date().toISOString().slice(0, 10);

  const recs = await invoke<ReconciliationRecord[]>("list_reconciliations", {
    account: reconciliationSelectedAccount || null,
  }).catch(() => []);

  const b = new PdfDocBuilder(
    "Reconciliation Statements & Audit Log",
    "Statement checkpoints, reconciled balances, and account audit history.",
    currency
  );

  b.drawHeader([
    { label: "Account Scope", value: reconciliationSelectedAccount || "All Accounts" },
    { label: "Reconciliation Sessions", value: String(recs.length) },
    { label: "Base Currency", value: currency },
  ]);

  b.drawKpis([
    { label: "Completed Reconciliations", value: String(recs.length), color: "neutral" },
    { label: "Latest Statement", value: recs[0]?.statement_ending_on ?? "None", color: "neutral" },
  ]);

  b.drawSectionHeading("Reconciliation History");
  b.drawTable({
    head: [["#", "Account", "Statement Ending", "Statement Balance", "Completed At"]],
    body: recs.map(r => [
      String(r.id),
      r.account_name,
      r.statement_ending_on,
      formatMoney(r.statement_balance_cents, currency),
      r.created_at?.slice(0, 10) ?? "—",
    ]),
    columnStyles: {
      0: { cellWidth: 35, halign: "right" },
      3: { halign: "right", fontStyle: "bold" },
      4: { halign: "center" },
    },
  });

  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(), `reconciliation_audit_${today}.pdf`, toast);
}

/* =========================================================
   13. Comparisons Page PDF
   ========================================================= */
async function exportComparisonsPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { currency, toast } = ctx;
  toast("Generating comparisons report PDF…");
  const today = new Date().toISOString().slice(0, 10);

  const aFromEl = document.querySelector<HTMLInputElement>("#compare-a-from");
  const aToEl = document.querySelector<HTMLInputElement>("#compare-a-to");
  const aMonthEl = document.querySelector<HTMLInputElement>("#compare-a-month");
  const bFromEl = document.querySelector<HTMLInputElement>("#compare-b-from");
  const bToEl = document.querySelector<HTMLInputElement>("#compare-b-to");
  const bMonthEl = document.querySelector<HTMLInputElement>("#compare-b-month");
  const accEl = document.querySelector<HTMLSelectElement>("#compare-account");
  const comparisonState = document.querySelector<HTMLElement>("#comparison-result")?.dataset;

  const aFrom = comparisonState?.currentFrom || aFromEl?.value || (aMonthEl?.value ? `${aMonthEl.value}-01` : today);
  const aTo = comparisonState?.currentTo || aToEl?.value || today;
  const bFrom = comparisonState?.baselineFrom || bFromEl?.value || (bMonthEl?.value ? `${bMonthEl.value}-01` : today);
  const bTo = comparisonState?.baselineTo || bToEl?.value || today;
  const accountRef = comparisonState?.account || accEl?.value || null;
  const baselineDivisor = Math.max(1, Number(comparisonState?.baselineDivisor) || 1);
  const scopedAccount = accountRef ? ctx.accounts.find(account => String(account.id) === accountRef) : null;
  const displayCurrency = scopedAccount?.currency_code ?? currency;

  const analytics = await invoke<ComparativeAnalyticsSnapshot>("get_comparative_analytics", {
    currentFrom: aFrom,
    currentTo: aTo,
    baselineFrom: bFrom,
    baselineTo: bTo,
    account: accountRef,
  });
  const sumA = analytics.current;
  const sumB:SummaryRecord = Object.fromEntries(Object.entries(analytics.baseline).map(([key,value])=>[key,typeof value==="number"?value/baselineDivisor:value])) as unknown as SummaryRecord;
  const variances = analytics.variances.map(row=>{
    const baseline=row.baseline_cents/baselineDivisor;
    const delta=row.current_cents-baseline;
    return {...row,baseline_cents:baseline,delta_cents:delta,delta_percent:baseline===0?null:delta/Math.abs(baseline)*100};
  });

  const b = new PdfDocBuilder(
    "Period Comparison & Variance Analysis",
    "Side-by-side comparative analysis of income, expenditure, and variance drivers.",
    displayCurrency
  );

  b.drawHeader([
    { label: "Period A", value: `${aFrom} to ${aTo}` },
    { label: baselineDivisor > 1 ? `Period B average (÷${baselineDivisor})` : "Period B", value: `${bFrom} to ${bTo}` },
    { label: "Account Scope", value: scopedAccount?.name ?? "All Accounts" },
  ]);

  const varNet = sumA.net_cents - sumB.net_cents;
  const varExp = sumA.expense_cents - sumB.expense_cents;

  b.drawKpis([
    { label: "Period A Net", value: formatMoney(sumA.net_cents, displayCurrency), color: sumA.net_cents >= 0 ? "success" : "danger" },
    { label: "Period B Net", value: formatMoney(sumB.net_cents, displayCurrency), color: sumB.net_cents >= 0 ? "success" : "danger" },
    { label: "Net Variance", value: `${varNet >= 0 ? "+" : ""}${formatMoney(varNet, displayCurrency)}`, color: varNet >= 0 ? "success" : "danger" },
    { label: "Expense Variance", value: `${varExp <= 0 ? "-" : "+"}${formatMoney(Math.abs(varExp), displayCurrency)}`, color: varExp <= 0 ? "success" : "danger" },
  ]);

  const rows = variances.filter(row => row.dimension === "category");

  b.drawSectionHeading("Category Spending Comparison");
  b.drawTable({
    head: [["Category", "Period A Spent", "Period B Spent", "Difference ($)", "Difference (%)"]],
    body: rows.map(r => [
      r.label,
      formatMoney(r.current_cents, displayCurrency),
      formatMoney(r.baseline_cents, displayCurrency),
      `${r.delta_cents >= 0 ? "+" : ""}${formatMoney(r.delta_cents, displayCurrency)}`,
      formatPercent(r.delta_percent),
    ]),
    columnStyles: {
      1: { halign: "right" },
      2: { halign: "right" },
      3: { halign: "right", fontStyle: "bold" },
      4: { halign: "center" },
    },
  });

  for (const [dimension, title] of [["payee", "Payee Variance"], ["account", "Account Variance"]] as const) {
    const values = variances.filter(row => row.dimension === dimension);
    b.drawSectionHeading(title);
    b.drawTable({
      head: [[title.replace(" Variance", ""), "Period A", "Period B", "Difference", "Difference (%)"]],
      body: values.map(row => [row.label, formatMoney(row.current_cents, displayCurrency), formatMoney(row.baseline_cents, displayCurrency), formatMoney(row.delta_cents, displayCurrency), formatPercent(row.delta_percent)]),
    });
  }

  b.drawSectionHeading("Expense Seasonality");
  b.drawTable({
    head: [["Month", "Observed months", "Average expense", "Index"]],
    body: analytics.seasonality.map(point => [point.month_name, String(point.observation_count), formatMoney(point.average_expense_cents, displayCurrency), point.index.toFixed(2)]),
  });

  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(), `period_comparison_${today}.pdf`, toast);
}

/* =========================================================
   14. Bank Import Presets Catalog PDF
   ========================================================= */
async function exportImportPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { currency, toast } = ctx;
  toast("Generating bank import presets catalog PDF…");
  const presets = await invoke<ImportPresetSummary[]>("list_import_presets").catch(() => []);
  const today = new Date().toISOString().slice(0, 10);

  const b = new PdfDocBuilder(
    "Bank Import Presets & Mapping Profiles",
    "Pre-configured bank CSV/XML import presets, formats, and mapping profiles.",
    currency
  );

  b.drawHeader([
    { label: "Available Presets", value: String(presets.length) },
    { label: "Format Standards", value: "CSV, camt.053 XML" },
  ]);

  b.drawKpis([
    { label: "Supported Banks", value: `${presets.length} Presets`, color: "neutral" },
    { label: "Duplicate Detection", value: "Active", color: "success" },
  ]);

  b.drawSectionHeading("Configured Bank Presets");
  b.drawTable({
    head: [["Preset ID", "Bank / Financial Institution", "Verification Mode"]],
    body: presets.map(p => [
      p.id,
      p.label,
      p.verification === "first-party" ? "First-party Verified" : "Community Provided",
    ]),
    columnStyles: {
      0: { cellWidth: 90, fontStyle: "bold" },
      1: { cellWidth: 200 },
      2: { cellWidth: "auto", halign: "center" },
    },
  });

  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(), `bank_import_presets_${today}.pdf`, toast);
}

/* =========================================================
   15. Settings & Configuration PDF
   ========================================================= */
async function exportSettingsPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const { currency, dbPath, toast, accounts, categories } = ctx;
  toast("Generating system settings PDF…");
  const today = new Date().toISOString().slice(0, 10);

  const b = new PdfDocBuilder(
    "Finance Tracker System Configuration",
    "Ledger environment parameters, active currency settings, and system metadata.",
    currency
  );

  b.drawHeader([
    { label: "Reporting Currency", value: currency },
    { label: "Database", value: dbPath.split("/").slice(-2).join("/") },
  ]);

  b.drawKpis([
    { label: "Accounts Count", value: String(accounts.length), color: "neutral" },
    { label: "Categories Count", value: String(categories.length), color: "neutral" },
    { label: "Base Currency", value: currency, color: "neutral" },
  ]);

  b.drawSectionHeading("Ledger Environment");
  b.drawTable({
    head: [["Configuration Parameter", "Active Value"]],
    body: [
      ["Database Path", dbPath],
      ["Reporting Currency", currency],
      ["Storage Architecture", "Local SQLite (Single file, WAL mode, foreign keys enforced)"],
      ["Exchange Rate Provider", "Frankfurter v2 (Local SQLite cache, 1-hr quote validity)"],
      ["PDF Statements Suite", "Active (jsPDF + autoTable, vector tables, Blue Horizon theme)"],
    ],
  });

  await saveAndPromptPdf(b.finalizeAndGetArrayBuffer(), `system_settings_${today}.pdf`, toast);
}

/* =========================================================
   16. Reports Page PDF (Trigger active report)
   ========================================================= */
async function exportReportsPagePdf(ctx: PagePdfExportContext): Promise<void> {
  const btn = document.getElementById("btn-export-pdf") as HTMLButtonElement | null;
  if (btn) {
    btn.click();
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const firstDay = `${today.slice(0, 7)}-01`;
    const buffer = await generatePeriodOverviewPdf({ from: firstDay, to: today, accountId: null });
    await saveAndPromptPdf(buffer, `financial_overview_${firstDay}_${today}.pdf`, ctx.toast);
  }
}
