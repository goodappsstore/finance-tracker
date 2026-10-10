import { jsPDF } from "jspdf";
import autoTable, { UserOptions } from "jspdf-autotable";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  Account, Category, BalanceRecord, SummaryRecord,
  BudgetStatusRecord, BudgetMoveRecord, PlanningScenarioRecord,
  PlanningItemRecord, ForecastSnapshot, GoalStatusRecord,
  SafeSpendSnapshot, NetWorthSnapshot, LoanRecord, NetWorthItemRecord,
  InvestmentAccountRecord, SecurityRecord, HoldingLotRecord, HoldingEventRecord,
  InvestmentPerformanceRecord, PortfolioXirrRecord, MonthlyCashFlowPoint,
  CategorySpendingPoint, SpendingBreakdownPoint,
} from "./types";

export type ReportType =
  | "period_overview"
  | "cashflow_trend"
  | "budget_position"
  | "budget_rollover"
  | "cash_forecast"
  | "scenario_comparison"
  | "goals_outlook"
  | "safe_spend"
  | "balance_sheet"
  | "investment_portfolio";

export interface ReportMeta {
  id: ReportType;
  title: string;
  category: "Cash Flow & Performance" | "Budgets & Envelopes" | "Planning & Forecasts" | "Balance Sheet & Wealth";
  badge: string;
  description: string;
}

export const REPORT_CATALOG: ReportMeta[] = [
  {
    id: "period_overview",
    title: "Period Financial Overview",
    category: "Cash Flow & Performance",
    badge: "Income & Expense",
    description: "Period income, expenses, net cash flow, transfer breakdown, closing balances by active account, and top payees/categories.",
  },
  {
    id: "cashflow_trend",
    title: "Cash-Flow Trend & Spending Drivers",
    category: "Cash Flow & Performance",
    badge: "Multi-Month Trend",
    description: "Multi-month income and expense trends, month-on-month changes, top expense drivers, payees, and tag spending analysis.",
  },
  {
    id: "budget_position",
    title: "Budget Position Report",
    category: "Budgets & Envelopes",
    badge: "Budget vs Actual",
    description: "Monthly allocation, rollover carry, reallocations, available funds, actual spending, remaining envelopes, and precedence audit.",
  },
  {
    id: "budget_rollover",
    title: "Budget Rollover & Reallocation Report",
    category: "Budgets & Envelopes",
    badge: "Management Audit",
    description: "Audit companion tracking opening carry-in, base allocations, inter-category moves, spending, and closing rollover deficits.",
  },
  {
    id: "cash_forecast",
    title: "Upcoming Bills, Commitments & Forecast",
    category: "Planning & Forecasts",
    badge: "Cash Projections",
    description: "Projected balances over 30-365 days, negative-balance dates, 12-month roll-up, and concise upcoming bill calendar.",
  },
  {
    id: "scenario_comparison",
    title: "Scenario Comparison Report",
    category: "Planning & Forecasts",
    badge: "What-If Analysis",
    description: "Forward-looking comparative analysis of baseline projections against planning scenarios, planned items, and overrides.",
  },
  {
    id: "goals_outlook",
    title: "Goals & Funding Outlook",
    category: "Planning & Forecasts",
    badge: "Sinking Funds",
    description: "Sinking funds and balance target floors, target progress, required contributions, projected balance trajectories, and breach dates.",
  },
  {
    id: "safe_spend",
    title: "Safe-to-Spend Statement",
    category: "Balance Sheet & Wealth",
    badge: "Spendable Cash",
    description: "Conservative pre-payday available spending statement with reserves for credit debt, upcoming commitments, budgets, and savings.",
  },
  {
    id: "balance_sheet",
    title: "Balance Sheet & Net-Worth Snapshot",
    category: "Balance Sheet & Wealth",
    badge: "Executive Statement",
    description: "As-of-date consolidated balance sheet spanning liquid accounts, investments, properties, term loans, credit debt, and 12-mo trend.",
  },
  {
    id: "investment_portfolio",
    title: "Investment Portfolio Performance",
    category: "Balance Sheet & Wealth",
    badge: "Holdings & XIRR",
    description: "Portfolio valuation, FIFO cost basis, unrealized/realized gains, lot details, time-weighted returns, and consolidated portfolio XIRR.",
  },
];

/* =========================================================
   Design System & Color Tokens (Matching Blue Horizon Theme)
   ========================================================= */
export const C_NAVY: [number, number, number] = [30, 58, 138];       // #1e3a8a Primary Banner
export const C_BLUE: [number, number, number] = [37, 99, 235];       // #2563eb Accent
export const C_DARK: [number, number, number] = [22, 35, 59];        // #16233b Text
export const C_MUTED: [number, number, number] = [102, 120, 148];    // #667894 Secondary text
export const C_LIGHT_BG: [number, number, number] = [244, 247, 252]; // #f4f7fc Soft card background
export const C_CARD_BORDER: [number, number, number] = [226, 232, 240]; // #e2e8f0
export const C_SUCCESS: [number, number, number] = [5, 150, 105];    // #059669 Green
export const C_DANGER: [number, number, number] = [220, 38, 38];     // #dc2626 Red
export const C_WARN: [number, number, number] = [217, 119, 6];       // #d97706 Amber
export const C_INFO: [number, number, number] = [8, 145, 178];       // #0891b2 Cyan

export function formatMoney(cents: number, curr = "USD"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const units = Math.floor(abs / 100);
  const decimals = String(abs % 100).padStart(2, "0");
  return `${sign}${curr} ${units.toLocaleString("en-US")}.${decimals}`;
}

export function formatPercent(value: number | null): string {
  if (value === null || isNaN(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function formatQty(micros: number): string {
  return (micros / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function escHtml(s: any): string {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/* =========================================================
   Shared PDF Document Builder Helpers
   ========================================================= */
export class PdfDocBuilder {
  doc: jsPDF;
  pageWidth: number;
  pageHeight: number;
  margin: number;
  cursorY: number;
  title: string;
  subtitle: string;
  currency: string;
  dateStr: string;

  constructor(title: string, subtitle: string, currency = "USD") {
    this.doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    this.pageWidth = this.doc.internal.pageSize.getWidth();
    this.pageHeight = this.doc.internal.pageSize.getHeight();
    this.margin = 36; // 0.5 inch margins
    this.cursorY = this.margin;
    this.title = title;
    this.subtitle = subtitle;
    this.currency = currency;
    this.dateStr = new Date().toISOString().slice(0, 10);
  }

  ensureSpace(neededPt: number) {
    if (this.cursorY + neededPt > this.pageHeight - this.margin - 30) {
      this.doc.addPage();
      this.cursorY = this.margin;
    }
  }

  drawHeader(metadataPills: { label: string; value: string }[]) {
    const doc = this.doc;
    const contentW = this.pageWidth - this.margin * 2;

    // Top banner bar
    doc.setFillColor(...C_NAVY);
    doc.rect(this.margin, this.cursorY, contentW, 52, "F");

    // Brand label
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(255, 255, 255);
    doc.text("FINANCE TRACKER", this.margin + 16, this.cursorY + 20);

    // Document Title
    doc.setFontSize(15);
    doc.text(this.title, this.margin + 16, this.cursorY + 38);

    // Date & Currency badge on right
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const rightText = `Generated: ${this.dateStr}  |  Base: ${this.currency}`;
    const rightX = this.pageWidth - this.margin - 16;
    doc.text(rightText, rightX, this.cursorY + 30, { align: "right" });

    this.cursorY += 58;

    // Subtitle & description
    if (this.subtitle) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(...C_MUTED);
      doc.text(this.subtitle, this.margin, this.cursorY + 8);
      this.cursorY += 16;
    }

    // Metadata bar pills
    if (metadataPills.length > 0) {
      doc.setFillColor(...C_LIGHT_BG);
      doc.setDrawColor(...C_CARD_BORDER);
      doc.setLineWidth(0.8);
      doc.roundedRect(this.margin, this.cursorY, contentW, 26, 4, 4, "FD");

      let pillX = this.margin + 12;
      doc.setFontSize(8.5);
      for (const pill of metadataPills) {
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...C_DARK);
        doc.text(`${pill.label}: `, pillX, this.cursorY + 16);
        const labelW = doc.getTextWidth(`${pill.label}: `);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(...C_BLUE);
        doc.text(pill.value, pillX + labelW, this.cursorY + 16);
        pillX += labelW + doc.getTextWidth(pill.value) + 24;
      }
      this.cursorY += 34;
    }
  }

  drawKpis(cards: { label: string; value: string; sub?: string; color?: "success" | "danger" | "warn" | "neutral" }[]) {
    this.ensureSpace(60);
    const doc = this.doc;
    const contentW = this.pageWidth - this.margin * 2;
    const count = cards.length;
    const gap = 10;
    const cardW = (contentW - gap * (count - 1)) / count;
    const cardH = 50;

    for (let i = 0; i < count; i++) {
      const c = cards[i];
      const x = this.margin + i * (cardW + gap);
      const y = this.cursorY;

      // Card container
      doc.setFillColor(...C_LIGHT_BG);
      doc.setDrawColor(...C_CARD_BORDER);
      doc.setLineWidth(0.8);
      doc.roundedRect(x, y, cardW, cardH, 4, 4, "FD");

      // Label
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.5);
      doc.setTextColor(...C_MUTED);
      doc.text(c.label.toUpperCase(), x + 10, y + 14);

      // Value
      doc.setFontSize(11);
      if (c.color === "success") doc.setTextColor(...C_SUCCESS);
      else if (c.color === "danger") doc.setTextColor(...C_DANGER);
      else if (c.color === "warn") doc.setTextColor(...C_WARN);
      else doc.setTextColor(...C_DARK);
      doc.text(c.value, x + 10, y + 30);

      // Subtitle if present
      if (c.sub) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.5);
        doc.setTextColor(...C_MUTED);
        doc.text(c.sub, x + 10, y + 43);
      }
    }
    this.cursorY += cardH + 14;
  }

  drawSectionHeading(title: string, sub?: string) {
    this.ensureSpace(35);
    const doc = this.doc;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...C_NAVY);
    doc.text(title, this.margin, this.cursorY + 12);

    if (sub) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...C_MUTED);
      doc.text(sub, this.margin, this.cursorY + 24);
      this.cursorY += 30;
    } else {
      this.cursorY += 18;
    }
  }

  drawCallout(text: string, title = "NOTE", type: "info" | "warn" | "danger" = "info") {
    this.ensureSpace(45);
    const doc = this.doc;
    const contentW = this.pageWidth - this.margin * 2;
    const pad = 10;

    let barColor = C_INFO;
    let bgColor: [number, number, number] = [238, 248, 255]; // light cyan
    if (type === "warn") {
      barColor = C_WARN;
      bgColor = [254, 250, 235]; // light amber
    } else if (type === "danger") {
      barColor = C_DANGER;
      bgColor = [254, 242, 242]; // light red
    }

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    const splitLines = doc.splitTextToSize(text, contentW - pad * 2 - 8);
    const boxH = Math.max(34, 18 + splitLines.length * 10);

    // Background
    doc.setFillColor(...bgColor);
    doc.roundedRect(this.margin, this.cursorY, contentW, boxH, 4, 4, "F");

    // Left accent bar
    doc.setFillColor(...barColor);
    doc.rect(this.margin, this.cursorY, 4, boxH, "F");

    // Title
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...barColor);
    doc.text(title.toUpperCase(), this.margin + pad + 2, this.cursorY + 12);

    // Text
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...C_DARK);
    doc.setFontSize(8);
    doc.text(splitLines, this.margin + pad + 2, this.cursorY + 23);

    this.cursorY += boxH + 12;
  }

  drawTable(options: UserOptions) {
    autoTable(this.doc, {
      startY: this.cursorY,
      margin: { left: this.margin, right: this.margin },
      theme: "striped",
      styles: {
        fontSize: 8,
        cellPadding: 4.5,
        textColor: C_DARK,
        lineColor: C_CARD_BORDER,
        lineWidth: 0.5,
      },
      headStyles: {
        fillColor: C_NAVY,
        textColor: [255, 255, 255],
        fontStyle: "bold",
        fontSize: 8,
      },
      alternateRowStyles: {
        fillColor: [248, 250, 252],
      },
      ...options,
    });
    this.cursorY = (this.doc as any).lastAutoTable?.finalY ? (this.doc as any).lastAutoTable.finalY + 14 : this.cursorY + 20;
  }

  finalizeAndGetArrayBuffer(): ArrayBuffer {
    const doc = this.doc;
    const totalPages = doc.getNumberOfPages();

    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);

      // Running footer divider
      doc.setDrawColor(...C_CARD_BORDER);
      doc.setLineWidth(0.8);
      const footerY = this.pageHeight - this.margin + 12;
      doc.line(this.margin, footerY - 8, this.pageWidth - this.margin, footerY - 8);

      // Footer branding & date
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...C_MUTED);
      doc.text("Finance Tracker · Confidential Personal Statement · Local Ledger", this.margin, footerY + 2);

      // Page numbering
      doc.text(`Page ${i} of ${totalPages}`, this.pageWidth - this.margin, footerY + 2, { align: "right" });
    }

    return doc.output("arraybuffer");
  }
}

/* =========================================================
   10 Dedicated PDF Generators
   ========================================================= */

// 1. Period Financial Overview
export async function generatePeriodOverviewPdf(params: { from: string; to: string; accountId: number | null }): Promise<ArrayBuffer> {
  const currency = await invoke<string>("get_currency");
  const accounts = await invoke<Account[]>("list_accounts", { includeArchived: false });
  const selectedAcc = params.accountId ? (accounts.find(a => a.id === params.accountId) ?? null) : null;
  const accRef = selectedAcc ? String(selectedAcc.id) : null;
  const isIndividual = selectedAcc !== null;
  const activeCurrency = selectedAcc ? selectedAcc.currency_code : currency;

  const summary = await invoke<SummaryRecord>("get_summary", {
    from: params.from,
    to: params.to,
    account: accRef,
  });

  const balances = isIndividual
    ? await invoke<BalanceRecord[]>("get_balances_as_of", { account: accRef, asOf: params.to })
    : await invoke<BalanceRecord[]>("get_reporting_balances_as_of", { asOf: params.to });

  const topCats = await invoke<CategorySpendingPoint[]>("category_spending", {
    from: params.from,
    to: params.to,
    limit: 10,
    account: accRef,
  });

  const topPayees = await invoke<SpendingBreakdownPoint[]>("spending_by_payee", {
    from: params.from,
    to: params.to,
    limit: 10,
    account: accRef,
  });

  const b = new PdfDocBuilder(
    "Period Financial Overview",
    "Comprehensive summary of inflows, outflows, account closing balances, and expenditure distribution.",
    currency
  );

  b.drawHeader([
    { label: "Scope", value: selectedAcc ? selectedAcc.name : "Consolidated (All Accounts)" },
    { label: "Period", value: `${params.from} to ${params.to}` },
    { label: "Currency Mode", value: isIndividual ? `Native (${activeCurrency})` : `Reporting (${currency})` },
  ]);

  b.drawKpis([
    { label: "Total Income", value: formatMoney(summary.income_cents, activeCurrency), color: "success" },
    { label: "Total Expenses", value: formatMoney(summary.expense_cents, activeCurrency), color: "danger" },
    { label: "Net Cash Flow", value: formatMoney(summary.net_cents, activeCurrency), color: summary.net_cents >= 0 ? "success" : "danger" },
    { label: "Total Activity", value: `${summary.transaction_count} transactions`, color: "neutral" },
  ]);

  if (isIndividual) {
    b.drawSectionHeading("Account Transfer Activity");
    b.drawTable({
      head: [["Transfer Type", "Amount", "Net Direction"]],
      body: [
        ["Transfer In (Inflow to this account)", formatMoney(summary.transfer_in_cents, activeCurrency), "+ Positive Inflow"],
        ["Transfer Out (Outflow from this account)", formatMoney(summary.transfer_out_cents, activeCurrency), "- Outflow to another account"],
      ],
      columnStyles: { 1: { halign: "right", fontStyle: "bold" } },
    });
  }

  b.drawSectionHeading(`Closing Balances as of ${params.to}`);
  b.drawTable({
    head: [["Account Name", "Type", "Currency", "Closing Balance"]],
    body: balances.map(acc => [
      acc.account_name,
      acc.account_kind,
      acc.currency_code,
      formatMoney(acc.current_balance_cents, isIndividual ? acc.currency_code : currency),
    ]),
    columnStyles: { 3: { halign: "right", fontStyle: "bold" } },
  });

  b.drawSectionHeading("Top Expense Categories & Payees");
  const totalExp = summary.expense_cents || 1;
  b.drawTable({
    head: [["Top Expense Category", "Amount Spent", "% of Total Expense", "Top Payee", "Amount", "Tx Count"]],
    body: Array.from({ length: Math.max(topCats.length, topPayees.length) }).map((_, idx) => {
      const cat = topCats[idx];
      const payee = topPayees[idx];
      return [
        cat ? cat.category_name : "—",
        cat ? formatMoney(cat.spent_cents, activeCurrency) : "—",
        cat ? `${((cat.spent_cents / totalExp) * 100).toFixed(1)}%` : "—",
        payee ? payee.label : "—",
        payee ? formatMoney(payee.spent_cents, activeCurrency) : "—",
        payee ? String(payee.transaction_count) : "—",
      ];
    }),
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "center" } },
  });

  b.drawCallout(
    "Reporting Currency Snapshot Policy: For consolidated multi-account reports, all transactions and balances use historical local/cached FX quotes converted to the primary reporting currency. Individual account statements preserve exact native currency amounts.",
    "Currency & FX Rules",
    "info"
  );

  return b.finalizeAndGetArrayBuffer();
}

// 2. Cash-Flow Trend & Spending Drivers
export async function generateCashFlowTrendPdf(params: { months: number; accountId: number | null }): Promise<ArrayBuffer> {
  const currency = await invoke<string>("get_currency");
  const accounts = await invoke<Account[]>("list_accounts", { includeArchived: false });
  const selectedAcc = params.accountId ? accounts.find(a => a.id === params.accountId) : null;
  const accRef = selectedAcc ? String(selectedAcc.id) : null;

  const points = await invoke<MonthlyCashFlowPoint[]>("monthly_cash_flow", {
    months: params.months,
    account: accRef,
  });

  const fromMonth = points[0]?.month ? `${points[0].month}-01` : "2020-01-01";
  const toMonth = points[points.length - 1]?.month ? `${points[points.length - 1].month}-28` : "2099-12-31";

  const topCats = await invoke<CategorySpendingPoint[]>("category_spending", {
    from: fromMonth,
    to: toMonth,
    limit: 10,
    account: accRef,
  });

  const topPayees = await invoke<SpendingBreakdownPoint[]>("spending_by_payee", {
    from: fromMonth,
    to: toMonth,
    limit: 10,
    account: accRef,
  });

  const tagSpending = await invoke<SpendingBreakdownPoint[]>("spending_by_tag", {
    from: fromMonth,
    to: toMonth,
    limit: 15,
    account: accRef,
  });

  const b = new PdfDocBuilder(
    "Cash-Flow Trend & Spending Drivers",
    "Historical monthly cash-flow movement, month-on-month velocity, and major spending drivers.",
    currency
  );

  b.drawHeader([
    { label: "Scope", value: selectedAcc ? selectedAcc.name : "All Accounts Consolidated" },
    { label: "Timeframe", value: `Past ${params.months} Months (${points[0]?.month ?? ""} to ${points[points.length - 1]?.month ?? ""})` },
    { label: "Reporting Currency", value: currency },
  ]);

  const totalIncome = points.reduce((s, p) => s + p.income_cents, 0);
  const totalExpense = points.reduce((s, p) => s + p.expense_cents, 0);
  const netSavings = totalIncome - totalExpense;
  const avgMonthlyNet = points.length ? Math.round(netSavings / points.length) : 0;

  b.drawKpis([
    { label: "Total Inflows", value: formatMoney(totalIncome, currency), color: "success" },
    { label: "Total Outflows", value: formatMoney(totalExpense, currency), color: "danger" },
    { label: "Net Period Cash Flow", value: formatMoney(netSavings, currency), color: netSavings >= 0 ? "success" : "danger" },
    { label: "Avg Monthly Net", value: formatMoney(avgMonthlyNet, currency), color: avgMonthlyNet >= 0 ? "success" : "danger" },
  ]);

  b.drawSectionHeading("Monthly Cash Flow & Month-on-Month Variance");
  const tableRows = points.map((pt, idx) => {
    const prev = idx > 0 ? points[idx - 1] : null;
    const incChange = prev ? pt.income_cents - prev.income_cents : 0;
    const expChange = prev ? pt.expense_cents - prev.expense_cents : 0;
    const margin = pt.income_cents > 0 ? ((pt.net_cents / pt.income_cents) * 100).toFixed(1) + "%" : "—";
    return [
      pt.month,
      formatMoney(pt.income_cents, currency),
      prev ? `${incChange >= 0 ? "+" : ""}${formatMoney(incChange, currency)}` : "—",
      formatMoney(pt.expense_cents, currency),
      prev ? `${expChange >= 0 ? "+" : ""}${formatMoney(expChange, currency)}` : "—",
      formatMoney(pt.net_cents, currency),
      margin,
    ];
  });

  b.drawTable({
    head: [["Month", "Income", "MoM Income", "Expenses", "MoM Expense", "Net Cash Flow", "Savings %"]],
    body: tableRows,
    columnStyles: {
      1: { halign: "right" },
      2: { halign: "right" },
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right", fontStyle: "bold" },
      6: { halign: "center" },
    },
  });

  b.drawSectionHeading("Category Spending Drivers & Top Payees");
  b.drawTable({
    head: [["Top Category", "Spent", "Top Payee", "Spent", "Txns"]],
    body: Array.from({ length: Math.max(topCats.length, topPayees.length) }).map((_, i) => [
      topCats[i]?.category_name ?? "—",
      topCats[i] ? formatMoney(topCats[i].spent_cents, currency) : "—",
      topPayees[i]?.label ?? "—",
      topPayees[i] ? formatMoney(topPayees[i].spent_cents, currency) : "—",
      topPayees[i] ? String(topPayees[i].transaction_count) : "—",
    ]),
    columnStyles: { 1: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "center" } },
  });

  if (tagSpending.length > 0) {
    b.drawSectionHeading("Expenditure by Tag");
    b.drawTable({
      head: [["Tag Label", "Total Spending", "Transaction Count"]],
      body: tagSpending.map(t => [t.label, formatMoney(t.spent_cents, currency), String(t.transaction_count)]),
      columnStyles: { 1: { halign: "right", fontStyle: "bold" }, 2: { halign: "center" } },
    });
  }

  b.drawCallout(
    "Tag Aggregation Notice: A single transaction may carry multiple tags. Consequently, individual tag spending totals can overlap and are not additive across tags.",
    "Tag Allocation Notice",
    "info"
  );

  return b.finalizeAndGetArrayBuffer();
}

// 3. Budget Position Report
export async function generateBudgetPositionPdf(params: { month: string; scenarioId: number | null }): Promise<ArrayBuffer> {
  const currency = await invoke<string>("get_currency");
  const scenarios = await invoke<PlanningScenarioRecord[]>("list_scenarios");
  const activeScenario = params.scenarioId ? scenarios.find(s => s.id === params.scenarioId) : null;

  const rows = await invoke<BudgetStatusRecord[]>("budget_status", {
    month: params.month,
    scenario: activeScenario ? String(activeScenario.id) : null,
  });

  const b = new PdfDocBuilder(
    "Budget Position Report",
    `Monthly category allocations, rollover carry, movements, spending, and remaining envelope balances.`,
    currency
  );

  b.drawHeader([
    { label: "Budget Month", value: params.month },
    { label: "Planning Scenario", value: activeScenario ? activeScenario.name : "Baseline (Real World)" },
    { label: "Total Envelopes", value: String(rows.length) },
  ]);

  const totalAlloc = rows.reduce((s, r) => s + r.allocated_cents, 0);
  const totalRollover = rows.reduce((s, r) => s + r.rollover_cents, 0);
  const totalAvailable = rows.reduce((s, r) => s + r.budget_cents, 0);
  const totalSpent = rows.reduce((s, r) => s + r.spent_cents, 0);
  const totalRemaining = rows.reduce((s, r) => s + r.remaining_cents, 0);

  b.drawKpis([
    { label: "Base Allocation", value: formatMoney(totalAlloc, currency), color: "neutral" },
    { label: "Rollover Carry-In", value: formatMoney(totalRollover, currency), color: totalRollover >= 0 ? "success" : "warn" },
    { label: "Total Available", value: formatMoney(totalAvailable, currency), color: "neutral" },
    { label: "Actual Spending", value: formatMoney(totalSpent, currency), color: "danger" },
    { label: "Remaining Budget", value: formatMoney(totalRemaining, currency), color: totalRemaining >= 0 ? "success" : "danger" },
  ]);

  b.drawSectionHeading("Envelopes & Budget Performance");
  b.drawTable({
    head: [["Category", "Scope", "Allocated", "Rollover", "Moves", "Available", "Spent", "Remaining", "Status"]],
    body: rows.map(r => [
      r.category_name,
      r.account_name ? `Acc: ${r.account_name}` : "Global",
      formatMoney(r.allocated_cents, currency),
      formatMoney(r.rollover_cents, currency),
      formatMoney(r.moved_cents, currency),
      formatMoney(r.budget_cents, currency),
      formatMoney(r.spent_cents, currency),
      formatMoney(r.remaining_cents, currency),
      r.over_budget ? "OVER BUDGET" : "ON TRACK",
    ]),
    columnStyles: {
      2: { halign: "right" },
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right" },
      6: { halign: "right" },
      7: { halign: "right", fontStyle: "bold" },
      8: { halign: "center", fontStyle: "bold" },
    },
  });

  const unbudgetedRows = rows.filter(r => r.allocated_cents === 0 && r.spent_cents > 0);
  if (unbudgetedRows.length > 0) {
    b.drawSectionHeading("Categories with Spending but No Allocation", "Unbudgeted category expenses recorded during this month.");
    b.drawTable({
      head: [["Category Name", "Scope", "Actual Spent", "Deficit Impact"]],
      body: unbudgetedRows.map(r => [
        r.category_name,
        r.account_name ? `Acc: ${r.account_name}` : "Global",
        formatMoney(r.spent_cents, currency),
        formatMoney(r.remaining_cents, currency),
      ]),
      columnStyles: { 2: { halign: "right" }, 3: { halign: "right", fontStyle: "bold" } },
    });
  }

  b.drawCallout(
    "Envelope Precedence Rule: Account-specific envelopes consume ledger spending before global envelopes. If an account has a specific envelope configured for a category, transactions recorded on that account will deplete that specific envelope first, leaving the global envelope intact.",
    "Precedence Rule Enforced",
    "info"
  );

  return b.finalizeAndGetArrayBuffer();
}

// 4. Budget Rollover & Reallocation Report
export async function generateBudgetRolloverPdf(params: { month: string; scenarioId: number | null }): Promise<ArrayBuffer> {
  const currency = await invoke<string>("get_currency");
  const scenarios = await invoke<PlanningScenarioRecord[]>("list_scenarios");
  const activeScenario = params.scenarioId ? scenarios.find(s => s.id === params.scenarioId) : null;

  const rows = await invoke<BudgetStatusRecord[]>("budget_status", {
    month: params.month,
    scenario: activeScenario ? String(activeScenario.id) : null,
  });

  let moves: BudgetMoveRecord[] = [];
  try {
    moves = await invoke<BudgetMoveRecord[]>("list_budget_moves", { month: params.month });
  } catch {
    moves = [];
  }

  const b = new PdfDocBuilder(
    "Budget Rollover & Reallocation Report",
    "Audit-grade schedule of envelope carry-ins, inter-category reallocations, and future deficit pressure.",
    currency
  );

  b.drawHeader([
    { label: "Audit Month", value: params.month },
    { label: "Scenario", value: activeScenario ? activeScenario.name : "Baseline" },
    { label: "Rollover Envelopes", value: String(rows.filter(r => r.rollover_start_month).length) },
  ]);

  const totalCarryIn = rows.reduce((s, r) => s + r.rollover_cents, 0);
  const totalAlloc = rows.reduce((s, r) => s + r.allocated_cents, 0);
  const totalMoved = rows.reduce((s, r) => s + Math.abs(r.moved_cents), 0) / 2;
  const totalClosingCarry = rows.filter(r => r.rollover_start_month).reduce((s, r) => s + r.remaining_cents, 0);

  b.drawKpis([
    { label: "Opening Carry-In", value: formatMoney(totalCarryIn, currency), color: totalCarryIn >= 0 ? "success" : "warn" },
    { label: "Monthly Allocations", value: formatMoney(totalAlloc, currency), color: "neutral" },
    { label: "Moves Reallocated", value: formatMoney(totalMoved, currency), color: "neutral" },
    { label: "Closing Carry-Out", value: formatMoney(totalClosingCarry, currency), color: totalClosingCarry >= 0 ? "success" : "danger" },
  ]);

  b.drawSectionHeading("Rollover Policy & Balance Carry Ledger");
  b.drawTable({
    head: [["Category", "Scope", "Policy Start", "Opening Carry", "Allocation", "Moves", "Spent", "Closing Carry"]],
    body: rows.map(r => [
      r.category_name,
      r.account_name ? `Acc: ${r.account_name}` : "Global",
      r.rollover_start_month ?? "No Rollover",
      formatMoney(r.rollover_cents, currency),
      formatMoney(r.allocated_cents, currency),
      formatMoney(r.moved_cents, currency),
      formatMoney(r.spent_cents, currency),
      formatMoney(r.remaining_cents, currency),
    ]),
    columnStyles: {
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right" },
      6: { halign: "right" },
      7: { halign: "right", fontStyle: "bold" },
    },
  });

  const negativeCarries = rows.filter(r => r.rollover_start_month && r.remaining_cents < 0);
  if (negativeCarries.length > 0) {
    b.drawSectionHeading("Categories Driving Future Deficit Pressure", "Overspent envelopes with active rollover policies that will penalize future budget months.");
    b.drawTable({
      head: [["Category", "Scope", "Closing Carry Deficit", "Management Recommendation"]],
      body: negativeCarries.map(r => [
        r.category_name,
        r.account_name ? `Acc: ${r.account_name}` : "Global",
        formatMoney(r.remaining_cents, currency),
        "Reallocate surplus from another category or increase future allocation.",
      ]),
      columnStyles: { 2: { halign: "right", fontStyle: "bold" } },
    });
  }

  if (moves.length > 0) {
    b.drawSectionHeading("Budget Reallocations (Money Moves)");
    b.drawTable({
      head: [["Date", "From Category", "To Category", "Account Scope", "Amount Moved"]],
      body: moves.map(m => [
        m.created_at.slice(0, 10),
        m.from_category_name,
        m.to_category_name,
        m.account_name ?? "Global Scope",
        formatMoney(m.amount_cents, currency),
      ]),
      columnStyles: { 4: { halign: "right", fontStyle: "bold" } },
    });
  }

  b.drawCallout(
    "Rollover Mechanics: Rollover carries both positive savings and overspending into subsequent months. Changing a category's rollover policy or back-dating an allocation recalculates carry forward systematically.",
    "Rollover Integrity",
    "info"
  );

  return b.finalizeAndGetArrayBuffer();
}

// 5. Upcoming Bills, Commitments & Cash Forecast
export async function generateCashForecastPdf(params: { horizonDays: number; accountId: number | null; scenarioId: number | null }): Promise<ArrayBuffer> {
  const reportingCurrency = await invoke<string>("get_currency");
  const accounts = await invoke<Account[]>("list_accounts", { includeArchived: false });
  const selectedAcc = params.accountId ? accounts.find(a => a.id === params.accountId) : null;
  const currency = selectedAcc?.currency_code ?? reportingCurrency;
  const scenarios = await invoke<PlanningScenarioRecord[]>("list_scenarios");
  const activeScenario = params.scenarioId ? scenarios.find(s => s.id === params.scenarioId) : null;

  const snapshot = await invoke<ForecastSnapshot>("get_forecast", {
    scenario: activeScenario ? String(activeScenario.id) : null,
    account: selectedAcc ? String(selectedAcc.id) : null,
    days: params.horizonDays,
  });

  const b = new PdfDocBuilder(
    "Upcoming Bills, Commitments & Cash Forecast",
    "Forward projection of cash balances, daily positions, upcoming bills, and liquidity warnings.",
    currency
  );

  b.drawHeader([
    { label: "Scope", value: snapshot.account.name ?? "All Accounts Consolidated" },
    { label: "Scenario", value: snapshot.scenario.name ?? "Baseline" },
    { label: "Projection Horizon", value: `${params.horizonDays} Days (through ${snapshot.daily.at(-1)?.date ?? ""})` },
  ]);

  const openingBal = snapshot.daily[0]?.opening_balance_cents ?? 0;
  const endingBal = snapshot.daily.at(-1)?.closing_balance_cents ?? 0;
  const totalInflows = snapshot.daily.reduce((s, d) => s + d.inflow_cents, 0);
  const totalOutflows = snapshot.daily.reduce((s, d) => s + d.outflow_cents, 0);
  const minClosing = Math.min(...snapshot.daily.map(d => d.closing_balance_cents), openingBal);

  b.drawKpis([
    { label: "Opening Cash", value: formatMoney(openingBal, currency), color: "neutral" },
    { label: "Projected Inflows", value: formatMoney(totalInflows, currency), color: "success" },
    { label: "Projected Outflows", value: formatMoney(totalOutflows, currency), color: "danger" },
    { label: "Projected Ending Cash", value: formatMoney(endingBal, currency), color: endingBal >= 0 ? "success" : "danger" },
    { label: "Horizon Minimum", value: formatMoney(minClosing, currency), color: minClosing >= 0 ? "success" : "warn" },
  ]);

  // Negative balance alerts
  const firstNegative = snapshot.daily.find(d => d.closing_balance_cents < 0);
  if (firstNegative) {
    b.drawCallout(
      `CRITICAL CASH SHORTFALL DETECTED: First negative closing balance projected on ${firstNegative.date} (${formatMoney(firstNegative.closing_balance_cents, currency)}). Review upcoming obligations immediately.`,
      "Negative Cash Alert",
      "danger"
    );
  } else if (snapshot.warnings.length > 0) {
    b.drawCallout(snapshot.warnings.join(" • "), "Forecast Warnings", "warn");
  }

  b.drawSectionHeading("Monthly 12-Month Roll-Up");
  b.drawTable({
    head: [["Month", "Projected Inflows", "Projected Outflows", "Net Cash Movement", "Ending Balance"]],
    body: snapshot.monthly.slice(0, 12).map(m => [
      m.month,
      formatMoney(m.inflow_cents, currency),
      formatMoney(m.outflow_cents, currency),
      formatMoney(m.net_cents, currency),
      formatMoney(m.ending_balance_cents, currency),
    ]),
    columnStyles: {
      1: { halign: "right" },
      2: { halign: "right" },
      3: { halign: "right" },
      4: { halign: "right", fontStyle: "bold" },
    },
  });

  b.drawSectionHeading("Upcoming Bill & Commitment Calendar", "Grouped scheduled items from recurring rules, planned transactions, future ledger items, and budget outflows.");
  b.drawTable({
    head: [["Due Date", "Title / Obligation", "Source", "Account", "Category", "Amount"]],
    body: snapshot.bill_calendar.slice(0, 25).map(item => [
      item.date,
      item.title,
      item.source,
      item.account_name,
      item.category_name ?? "—",
      formatMoney(item.amount_cents, accounts.find(a => a.id === item.account_id)?.currency_code ?? reportingCurrency),
    ]),
    columnStyles: { 5: { halign: "right", fontStyle: "bold" } },
  });

  return b.finalizeAndGetArrayBuffer();
}

// 6. Scenario Comparison Report
export async function generateScenarioComparisonPdf(params: { scenarioId: number; horizonDays: number }): Promise<ArrayBuffer> {
  const currency = await invoke<string>("get_currency");
  const scenarios = await invoke<PlanningScenarioRecord[]>("list_scenarios");
  const targetScenario = scenarios.find(s => s.id === params.scenarioId);
  if (!targetScenario) throw new Error("Please select a valid scenario to compare.");

  const [baseForecast, scenForecast, planItems, budgets] = await Promise.all([
    invoke<ForecastSnapshot>("get_forecast", { scenario: null, account: null, horizonDays: params.horizonDays }),
    invoke<ForecastSnapshot>("get_forecast", { scenario: String(targetScenario.id), account: null, horizonDays: params.horizonDays }),
    invoke<PlanningItemRecord[]>("list_planning_items", { scenario: String(targetScenario.id) }),
    invoke<any[]>("list_budgets", { month: null, scenario: String(targetScenario.id) }),
  ]);

  const b = new PdfDocBuilder(
    "Scenario Comparison Report",
    `Comparative analysis: Baseline vs "${targetScenario.name}" across forward liquidity, planned events, and budgets.`,
    currency
  );

  b.drawHeader([
    { label: "Baseline", value: "Real Ledger Current State" },
    { label: "Comparative Scenario", value: targetScenario.name },
    { label: "Horizon", value: `${params.horizonDays} Days` },
  ]);

  const baseEnd = baseForecast.daily.at(-1)?.closing_balance_cents ?? 0;
  const scenEnd = scenForecast.daily.at(-1)?.closing_balance_cents ?? 0;
  const endDelta = scenEnd - baseEnd;

  const baseInflows = baseForecast.daily.reduce((s, d) => s + d.inflow_cents, 0);
  const scenInflows = scenForecast.daily.reduce((s, d) => s + d.inflow_cents, 0);
  const baseOutflows = baseForecast.daily.reduce((s, d) => s + d.outflow_cents, 0);
  const scenOutflows = scenForecast.daily.reduce((s, d) => s + d.outflow_cents, 0);

  b.drawKpis([
    { label: "Baseline Ending Balance", value: formatMoney(baseEnd, currency), color: "neutral" },
    { label: "Scenario Ending Balance", value: formatMoney(scenEnd, currency), color: scenEnd >= 0 ? "success" : "danger" },
    { label: "Net Variance", value: `${endDelta >= 0 ? "+" : ""}${formatMoney(endDelta, currency)}`, color: endDelta >= 0 ? "success" : "danger" },
    { label: "Delta Net Outflows", value: formatMoney(scenOutflows - baseOutflows, currency), color: "neutral" },
  ]);

  b.drawSectionHeading("Monthly Trajectory: Baseline vs Scenario");
  const maxMonths = Math.min(baseForecast.monthly.length, scenForecast.monthly.length);
  const compRows = [];
  for (let i = 0; i < maxMonths; i++) {
    const bM = baseForecast.monthly[i];
    const sM = scenForecast.monthly[i];
    const netDiff = sM.ending_balance_cents - bM.ending_balance_cents;
    compRows.push([
      bM.month,
      formatMoney(bM.ending_balance_cents, currency),
      formatMoney(sM.ending_balance_cents, currency),
      `${netDiff >= 0 ? "+" : ""}${formatMoney(netDiff, currency)}`,
      formatMoney(sM.inflow_cents - bM.inflow_cents, currency),
      formatMoney(sM.outflow_cents - bM.outflow_cents, currency),
    ]);
  }

  b.drawTable({
    head: [["Month", "Baseline Ending", "Scenario Ending", "Ending Variance", "Inflow Delta", "Outflow Delta"]],
    body: compRows,
    columnStyles: {
      1: { halign: "right" },
      2: { halign: "right" },
      3: { halign: "right", fontStyle: "bold" },
      4: { halign: "right" },
      5: { halign: "right" },
    },
  });

  const scenarioItems = planItems.filter(p => p.scenario_id === targetScenario.id);
  if (scenarioItems.length > 0) {
    b.drawSectionHeading("Scenario-Specific Planned Transactions", "Transactions that exist purely in this what-if scenario.");
    b.drawTable({
      head: [["Due Date", "Title", "Kind", "Account", "Category", "Amount"]],
      body: scenarioItems.map(item => [
        item.due_on,
        item.title,
        item.kind,
        item.account_name,
        item.category_name ?? "—",
        formatMoney(item.amount_cents, currency),
      ]),
      columnStyles: { 5: { halign: "right", fontStyle: "bold" } },
    });
  }

  const overrides = budgets.filter((b: any) => b.is_override);
  if (overrides.length > 0) {
    b.drawSectionHeading("Budget Overrides in Scenario", "Category allocations modified for this scenario.");
    b.drawTable({
      head: [["Month", "Category", "Scope", "Scenario Allocation"]],
      body: overrides.map((o: any) => [
        o.month,
        o.category_name,
        o.account_name ? `Acc: ${o.account_name}` : "Global Scope",
        formatMoney(o.amount_cents, currency),
      ]),
      columnStyles: { 3: { halign: "right", fontStyle: "bold" } },
    });
  }

  b.drawCallout(
    "Non-Destructive Guarantee: Scenarios are strictly simulated planning models. They do not write to or mutate the historical ledger. Only explicitly posting a planned transaction enters it into real accounts.",
    "Forward-Looking Simulation",
    "info"
  );

  return b.finalizeAndGetArrayBuffer();
}

// 7. Goals & Funding Outlook
export async function generateGoalsOutlookPdf(params: { horizonDays: number }): Promise<ArrayBuffer> {
  const currency = await invoke<string>("get_currency");
  const forecast = await invoke<ForecastSnapshot>("get_forecast", {
    scenario: null,
    account: null,
    horizonDays: params.horizonDays,
  });

  const goals = forecast.goal_status;

  const b = new PdfDocBuilder(
    "Goals & Funding Outlook",
    "Sinking funds and balance target floors, funding trajectory, required monthly contributions, and breach checks.",
    currency
  );

  b.drawHeader([
    { label: "Goals Tracked", value: String(goals.length) },
    { label: "Projection Horizon", value: `${params.horizonDays} Days` },
    { label: "On Track", value: `${goals.filter(g => g.on_track).length} of ${goals.length}` },
  ]);

  const totalTargetAmount = goals.reduce((s, g) => s + (g.target_amount_cents ?? g.minimum_balance_cents ?? 0), 0);
  const totalCurrentBalance = goals.reduce((s, g) => s + g.current_balance_cents, 0);
  const totalProjected = goals.reduce((s, g) => s + g.projected_balance_cents, 0);
  const totalRequiredMonthly = goals.reduce((s, g) => s + g.suggested_monthly_contribution_cents, 0);

  b.drawKpis([
    { label: "Total Target Floor", value: formatMoney(totalTargetAmount, currency), color: "neutral" },
    { label: "Current Balance", value: formatMoney(totalCurrentBalance, currency), color: "neutral" },
    { label: "Projected Balance", value: formatMoney(totalProjected, currency), color: totalProjected >= totalTargetAmount ? "success" : "warn" },
    { label: "Req Monthly Inflow", value: formatMoney(totalRequiredMonthly, currency), color: "neutral" },
  ]);

  const sinkingFunds = goals.filter(g => g.kind === "sinking_fund");
  if (sinkingFunds.length > 0) {
    b.drawSectionHeading("Sinking Funds (Target Date Goals)");
    b.drawTable({
      head: [["Goal Name", "Account", "Due Date", "Target Amount", "Current Cash", "Projected", "Remaining", "Req Monthly", "Status"]],
      body: sinkingFunds.map(g => [
        g.name,
        g.account_name,
        g.due_on ?? "—",
        formatMoney(g.target_amount_cents ?? 0, currency),
        formatMoney(g.current_balance_cents, currency),
        formatMoney(g.projected_balance_cents, currency),
        formatMoney(g.remaining_cents, currency),
        formatMoney(g.suggested_monthly_contribution_cents, currency),
        g.on_track ? "ON TRACK" : "BEHIND",
      ]),
      columnStyles: {
        3: { halign: "right" },
        4: { halign: "right" },
        5: { halign: "right" },
        6: { halign: "right" },
        7: { halign: "right" },
        8: { halign: "center", fontStyle: "bold" },
      },
    });
  }

  const balanceTargets = goals.filter(g => g.kind === "balance_target");
  if (balanceTargets.length > 0) {
    b.drawSectionHeading("Balance Target Floors (Liquidity Reserves)");
    b.drawTable({
      head: [["Goal Name", "Target Account", "Minimum Floor", "Current Balance", "Projected Floor", "Breach Date", "Status"]],
      body: balanceTargets.map(g => [
        g.name,
        g.account_name,
        formatMoney(g.minimum_balance_cents ?? 0, currency),
        formatMoney(g.current_balance_cents, currency),
        formatMoney(g.projected_balance_cents, currency),
        g.breach_date ? g.breach_date : "No breach detected",
        g.on_track ? "PROTECTED" : "BREACH RISK",
      ]),
      columnStyles: {
        2: { halign: "right" },
        3: { halign: "right" },
        4: { halign: "right" },
        5: { halign: "center" },
        6: { halign: "center", fontStyle: "bold" },
      },
    });
  }

  b.drawCallout(
    "Goal Derivation Model: Sinking fund progress is derived from account balances and forward cash flow forecasts rather than synthetic transaction links. On-track status indicates whether the projected balance reaches the target by the deadline.",
    "Derived Goal Status",
    "info"
  );

  return b.finalizeAndGetArrayBuffer();
}

// 8. Safe-to-Spend Statement
export async function generateSafeSpendPdf(): Promise<ArrayBuffer> {
  const currency = await invoke<string>("get_currency");
  const snapshot = await invoke<SafeSpendSnapshot>("get_safe_to_spend");

  const b = new PdfDocBuilder(
    "Safe-to-Spend Statement",
    "Conservative executive statement of additional unbudgeted spending capacity before next payday.",
    currency
  );

  b.drawHeader([
    { label: "Statement Date", value: snapshot.as_of },
    { label: "Target Payday", value: snapshot.payday },
    { label: "Horizon Source", value: snapshot.horizon_source },
    { label: "Window", value: `${snapshot.days} Days` },
  ]);

  b.drawKpis([
    { label: "Available Cash", value: formatMoney(snapshot.cash_cents, currency), color: "neutral" },
    { label: "Total Reserves Deducted", value: formatMoney(
      snapshot.scheduled_cents + snapshot.budget_reserve_cents + snapshot.credit_reserve_cents +
      snapshot.protected_cents + snapshot.buffer_cents, currency), color: "warn" },
    { label: "Safe-to-Spend", value: formatMoney(snapshot.safe_cents, currency), color: snapshot.safe_cents > 0 ? "success" : "danger" },
    { label: "Daily Allowance", value: formatMoney(snapshot.daily_cents, currency), color: snapshot.daily_cents > 0 ? "success" : "neutral" },
  ]);

  if (snapshot.shortfall_cents > 0) {
    b.drawCallout(
      `LIQUIDITY SHORTFALL WARNING: Current spendable cash is insufficient to cover all commitments, reserves, and debt before payday. Estimated shortfall: ${formatMoney(snapshot.shortfall_cents, currency)}.`,
      "Shortfall Alert",
      "danger"
    );
  }

  b.drawSectionHeading("Detailed Reserve Accounting & Deductions");
  const deductions = [
    ["1. Available Cash in Spendable Accounts", formatMoney(snapshot.cash_cents, currency), "Selected cash and checking liquid accounts"],
    ["2. Credit-Card Debt Reserve", `-${formatMoney(snapshot.credit_reserve_cents, currency)}`, "Total outstanding debt on active credit accounts"],
    ["3. Scheduled Bills & Commitments", `-${formatMoney(snapshot.scheduled_cents, currency)}`, "Upcoming recurring and planned outflows before payday"],
    ["4. Category Budget Reserves", `-${formatMoney(snapshot.budget_reserve_cents, currency)}`, "Remaining envelope balances for months touched"],
    ["5. Protected Goals & Sinking Funds", `-${formatMoney(snapshot.protected_cents, currency)}`, "Funded targets and floor reserves in spendable accounts"],
    ["6. Emergency Buffer & Protected Savings", `-${formatMoney(snapshot.buffer_cents, currency)}`, "Configured emergency buffer and manually protected cash"],
    ["= Final Safe-to-Spend Available", formatMoney(snapshot.safe_cents, currency), "Unbudgeted discretionary spending allowance"],
  ];

  b.drawTable({
    head: [["Component", "Amount", "Calculation Basis"]],
    body: deductions,
    columnStyles: { 1: { halign: "right", fontStyle: "bold" } },
  });

  if (snapshot.commitments.length > 0) {
    b.drawSectionHeading("Upcoming Pending Commitments Reserved");
    b.drawTable({
      head: [["Date", "Description / Bill", "Account ID", "Category ID", "Reserved Outflow"]],
      body: snapshot.commitments.slice(0, 15).map(c => [
        c.date,
        c.title,
        `Account #${c.account_id}`,
        c.category_id ? `Category #${c.category_id}` : "Uncategorized",
        formatMoney(c.amount_cents, currency),
      ]),
      columnStyles: { 4: { halign: "right", fontStyle: "bold" } },
    });
  }

  b.drawCallout(
    "Conservative Calculation Rules: Full category budgets are reserved across all touched months. Recurring expenses already scheduled inside a category consume that category's reserve first. All active credit-card debt is protected upfront to ensure debt can be paid down.",
    "Accounting Rules",
    "info"
  );

  return b.finalizeAndGetArrayBuffer();
}

// 9. Balance Sheet & Net-Worth Snapshot
export async function generateBalanceSheetPdf(params: { asOfDate: string }): Promise<ArrayBuffer> {
  const currency = await invoke<string>("get_currency");
  const snapshot = await invoke<NetWorthSnapshot>("get_net_worth_snapshot");
  const balances = await invoke<BalanceRecord[]>("get_reporting_balances_as_of", { asOf: params.asOfDate });
  const investments = await invoke<InvestmentAccountRecord[]>("list_investment_accounts");
  const manualItems = await invoke<NetWorthItemRecord[]>("list_net_worth_items");
  const loans = await invoke<LoanRecord[]>("list_loans");

  const b = new PdfDocBuilder(
    "Balance Sheet & Net-Worth Snapshot",
    "As-of-date consolidated balance sheet across accounts, investments, tangible assets, and liabilities.",
    currency
  );

  b.drawHeader([
    { label: "As of Date", value: params.asOfDate },
    { label: "Total Asset Items", value: String(balances.length + investments.length + manualItems.filter(i => i.kind === "asset").length) },
    { label: "Reporting Currency", value: currency },
  ]);

  b.drawKpis([
    { label: "Total Assets", value: formatMoney(snapshot.assets_cents, currency), color: "success" },
    { label: "Total Liabilities", value: formatMoney(snapshot.liabilities_cents, currency), color: "danger" },
    { label: "Net Worth", value: formatMoney(snapshot.net_worth_cents, currency), color: snapshot.net_worth_cents >= 0 ? "success" : "danger" },
    { label: "30-Day MoM Change", value: `${snapshot.month_over_month_cents >= 0 ? "+" : ""}${formatMoney(snapshot.month_over_month_cents, currency)}`, color: snapshot.month_over_month_cents >= 0 ? "success" : "danger" },
  ]);

  b.drawSectionHeading("Assets Schedule");
  const assetRows = [];
  // Liquid accounts
  for (const a of balances.filter(b => b.current_balance_cents > 0)) {
    assetRows.push([`Liquid Account: ${a.account_name}`, a.account_kind, a.currency_code, params.asOfDate, formatMoney(a.current_balance_cents, currency)]);
  }
  // Investments
  for (const inv of investments) {
    assetRows.push([`Investment: ${inv.name}`, inv.institution ?? "Portfolio", currency, inv.as_of, formatMoney(inv.value_cents, currency)]);
  }
  // Manual assets
  for (const item of manualItems.filter(i => i.kind === "asset")) {
    assetRows.push([item.name, item.kind, currency, item.as_of, formatMoney(item.value_cents, currency)]);
  }

  b.drawTable({
    head: [["Asset Description", "Classification", "Currency", "Valuation Date", "Market Value"]],
    body: assetRows,
    columnStyles: { 4: { halign: "right", fontStyle: "bold" } },
  });

  b.drawSectionHeading("Liabilities & Obligations Schedule");
  const liabRows = [];
  // Credit cards & overdrawn
  for (const a of balances.filter(b => b.current_balance_cents < 0)) {
    liabRows.push([`Ledger Debt: ${a.account_name}`, a.account_kind, a.currency_code, "Immediate", formatMoney(Math.abs(a.current_balance_cents), currency)]);
  }
  // Loans
  for (const l of loans) {
    liabRows.push([`Loan: ${l.name}`, l.lender ?? "Term Debt", currency, l.next_due_on ?? "Monthly", formatMoney(l.outstanding_cents, currency)]);
  }
  // Manual liabilities
  for (const item of manualItems.filter(i => i.kind === "liability")) {
    liabRows.push([item.name, item.kind, currency, item.as_of, formatMoney(item.value_cents, currency)]);
  }

  b.drawTable({
    head: [["Obligation / Debt", "Classification", "Currency", "Due / Schedule", "Outstanding Balance"]],
    body: liabRows,
    columnStyles: { 4: { halign: "right", fontStyle: "bold", textColor: C_DANGER } },
  });

  b.drawCallout(
    "Valuation Limitation: The 12-month net-worth evolution combines historical ledger movements with current snapshots for non-ledger properties, vehicles, and investments. It is not an active historical mark-to-market appraisal.",
    "Valuation Methodology Notice",
    "warn"
  );

  return b.finalizeAndGetArrayBuffer();
}

// 10. Investment Portfolio Performance
export async function generateInvestmentPortfolioPdf(params: { investmentAccountId: number | null }): Promise<ArrayBuffer> {
  const currency = await invoke<string>("get_currency");
  const accounts = await invoke<InvestmentAccountRecord[]>("list_investment_accounts");
  const securities = await invoke<SecurityRecord[]>("list_securities");
  const xirr = await invoke<PortfolioXirrRecord>("portfolio_xirr");

  const selectedAcc = params.investmentAccountId ? accounts.find(a => a.id === params.investmentAccountId) : null;
  const targetAccounts = selectedAcc ? [selectedAcc] : accounts;

  // Gather account performance, lots, and events
  const details = await Promise.all(
    targetAccounts.map(async acc => {
      const [performance, lots, events] = await Promise.all([
        invoke<InvestmentPerformanceRecord>("investment_account_performance", { investmentAccountId: acc.id }),
        invoke<HoldingLotRecord[]>("list_holding_lots", { investmentAccountId: acc.id }),
        invoke<HoldingEventRecord[]>("list_holding_events", { investmentAccountId: acc.id }),
      ]);
      return { acc, performance, lots, events };
    })
  );

  const b = new PdfDocBuilder(
    "Investment Portfolio Performance",
    "Comprehensive holding valuations, FIFO cost basis, unrealized/realized gains, and XIRR/TWR returns.",
    currency
  );

  b.drawHeader([
    { label: "Scope", value: selectedAcc ? selectedAcc.name : "Consolidated Portfolio" },
    { label: "Active Accounts", value: String(targetAccounts.length) },
    { label: "Base Currency", value: currency },
  ]);

  const totalValue = details.reduce((s, d) => s + d.performance.value_cents, 0);
  const totalCost = details.reduce((s, d) => s + d.performance.cost_basis_cents, 0);
  const totalUnrealized = details.reduce((s, d) => s + d.performance.unrealized_gain_cents, 0);
  const totalRealized = details.reduce((s, d) => s + d.performance.realized_gain_cents, 0);
  const totalGain = totalUnrealized + totalRealized;

  b.drawKpis([
    { label: "Current Portfolio Value", value: formatMoney(totalValue, currency), color: "neutral" },
    { label: "Open Cost Basis", value: formatMoney(totalCost, currency), color: "neutral" },
    { label: "Unrealized Gain / Loss", value: `${totalUnrealized >= 0 ? "+" : ""}${formatMoney(totalUnrealized, currency)}`, color: totalUnrealized >= 0 ? "success" : "danger" },
    { label: "Realized Gain / Loss", value: `${totalRealized >= 0 ? "+" : ""}${formatMoney(totalRealized, currency)}`, color: totalRealized >= 0 ? "success" : "danger" },
    { label: "Portfolio XIRR", value: formatPercent(xirr.annualized_return_percent), color: (xirr.annualized_return_percent ?? 0) >= 0 ? "success" : "warn" },
  ]);

  b.drawSectionHeading("Accounts Breakdown");
  b.drawTable({
    head: [["Account Name", "Institution", "Value", "Cost Basis", "Unrealized Gain", "Realized Gain", "TWR %"]],
    body: details.map(d => [
      d.acc.name,
      d.acc.institution ?? "—",
      formatMoney(d.performance.value_cents, currency),
      formatMoney(d.performance.cost_basis_cents, currency),
      `${d.performance.unrealized_gain_cents >= 0 ? "+" : ""}${formatMoney(d.performance.unrealized_gain_cents, currency)}`,
      `${d.performance.realized_gain_cents >= 0 ? "+" : ""}${formatMoney(d.performance.realized_gain_cents, currency)}`,
      formatPercent(d.performance.time_weighted_return_percent),
    ]),
    columnStyles: {
      2: { halign: "right" },
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right" },
      6: { halign: "center", fontStyle: "bold" },
    },
  });

  // Securities Holdings Table across all targeted accounts
  const allLots = details.flatMap(d => d.lots);
  if (allLots.length > 0) {
    b.drawSectionHeading("Open Holdings & FIFO Lots");
    b.drawTable({
      head: [["Security Symbol", "Security Name", "Quantity Held", "Bought Date", "Buy Price", "Lot Cost Basis"]],
      body: allLots.map(l => [
        l.security_symbol,
        l.security_name,
        formatQty(l.quantity_micros),
        l.bought_on,
        formatMoney(l.reporting_buy_price_cents, currency),
        formatMoney(Math.round((l.quantity_micros / 1_000_000) * l.reporting_buy_price_cents), currency),
      ]),
      columnStyles: { 2: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right", fontStyle: "bold" } },
    });
  }

  b.drawCallout(
    "Price-Coverage & Mark-to-Market Rule: A portfolio valuation is strictly derived from open security lots when every held security has an active manual price snapshot. If any security lacks a price snapshot, the account falls back to its manual valuation snapshot to prevent misleading figures.",
    "Price Coverage Notice",
    "warn"
  );

  return b.finalizeAndGetArrayBuffer();
}

/* =========================================================
   Export Orchestrator with Tauri File Dialog & Opener
   ========================================================= */
export async function exportReportPdf(reportId: ReportType, options: any, toastFn: (msg: string, isErr?: boolean) => void) {
  try {
    toastFn("Generating report PDF…");
    let buffer: ArrayBuffer;
    let filename = `report_${reportId}_${new Date().toISOString().slice(0, 10)}.pdf`;

    switch (reportId) {
      case "period_overview":
        buffer = await generatePeriodOverviewPdf(options);
        filename = `financial_overview_${options.from}_${options.to}.pdf`;
        break;
      case "cashflow_trend":
        buffer = await generateCashFlowTrendPdf(options);
        filename = `cashflow_trend_${options.months}m.pdf`;
        break;
      case "budget_position":
        buffer = await generateBudgetPositionPdf(options);
        filename = `budget_position_${options.month}.pdf`;
        break;
      case "budget_rollover":
        buffer = await generateBudgetRolloverPdf(options);
        filename = `budget_rollover_audit_${options.month}.pdf`;
        break;
      case "cash_forecast":
        buffer = await generateCashForecastPdf(options);
        filename = `cash_forecast_${options.horizonDays}d.pdf`;
        break;
      case "scenario_comparison":
        buffer = await generateScenarioComparisonPdf(options);
        filename = `scenario_comparison_${options.horizonDays}d.pdf`;
        break;
      case "goals_outlook":
        buffer = await generateGoalsOutlookPdf(options);
        filename = `goals_outlook_${options.horizonDays}d.pdf`;
        break;
      case "safe_spend":
        buffer = await generateSafeSpendPdf();
        filename = `safe_to_spend_statement.pdf`;
        break;
      case "balance_sheet":
        buffer = await generateBalanceSheetPdf(options);
        filename = `balance_sheet_${options.asOfDate}.pdf`;
        break;
      case "investment_portfolio":
        buffer = await generateInvestmentPortfolioPdf(options);
        filename = `investment_portfolio_performance.pdf`;
        break;
      default:
        throw new Error("Unknown report type");
    }

    await saveAndPromptPdf(buffer, filename, toastFn);
  } catch (err: any) {
    console.error("PDF generation failed:", err);
    toastFn(`Export failed: ${String(err)}`, true);
  }
}

export async function saveAndPromptPdf(
  buffer: ArrayBuffer,
  defaultFilename: string,
  toastFn: (msg: string, isErr?: boolean) => void
): Promise<void> {
  const path = await save({
    filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    defaultPath: defaultFilename,
  });

  if (!path) return;

  const bytes = Array.from(new Uint8Array(buffer));
  await invoke<string>("save_pdf_file", { path, bytes });

  // Success notification with clickable open actions
  toastFn(`Report saved to ${path.split("/").pop()}`);
  showExportSuccessModal(path, defaultFilename);
}

export function showExportSuccessModal(path: string, filename: string) {
  const modalRoot = document.getElementById("modal-root");
  if (!modalRoot) return;

  const modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal card" style="max-width:480px">
      <div class="modal-header">
        <h3 style="display:flex;align-items:center;gap:8px;color:var(--success)">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          PDF Report Exported
        </h3>
        <button class="btn btn-sm" id="btn-close-pdf-modal">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
        <p>Your financial report <strong>${filename}</strong> has been generated and saved successfully.</p>
        <div class="card" style="background:var(--bg-2);padding:10px 14px;word-break:break-all;font-family:monospace;font-size:12px;color:var(--text-2)">
          ${path}
        </div>
      </div>
      <div class="modal-footer" style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
        <button class="btn btn-sm" id="btn-reveal-pdf">Show in Folder</button>
        <button class="btn btn-primary btn-sm" id="btn-open-pdf">Open PDF</button>
      </div>
    </div>
  `;

  modalRoot.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#btn-close-pdf-modal")?.addEventListener("click", close);
  modal.querySelector("#btn-reveal-pdf")?.addEventListener("click", async () => {
    try {
      await revealItemInDir(path);
    } catch (e: any) {
      console.error(e);
    }
  });
  modal.querySelector("#btn-open-pdf")?.addEventListener("click", async () => {
    try {
      await openPath(path);
      close();
    } catch (e: any) {
      console.error(e);
    }
  });
}

/* =========================================================
   Live HTML Report Preview Renderers
   ========================================================= */
export async function renderReportPreviewHtml(reportId: ReportType, options: any, currency = "USD"): Promise<string> {
  const meta = REPORT_CATALOG.find(r => r.id === reportId)!;

  try {
    switch (reportId) {
      case "period_overview": {
        const accounts = await invoke<Account[]>("list_accounts", { includeArchived: false });
        const selectedAcc = options.accountId ? (accounts.find(a => a.id === options.accountId) ?? null) : null;
        const accRef = selectedAcc ? String(selectedAcc.id) : null;
        const isIndividual = selectedAcc !== null;
        const activeCurrency = selectedAcc ? selectedAcc.currency_code : currency;

        const summary = await invoke<SummaryRecord>("get_summary", { from: options.from, to: options.to, account: accRef });
        const balances = isIndividual
          ? await invoke<BalanceRecord[]>("get_balances_as_of", { account: accRef, asOf: options.to })
          : await invoke<BalanceRecord[]>("get_reporting_balances_as_of", { asOf: options.to });
        const topCats = await invoke<CategorySpendingPoint[]>("category_spending", { from: options.from, to: options.to, limit: 8, account: accRef });
        const topPayees = await invoke<SpendingBreakdownPoint[]>("spending_by_payee", { from: options.from, to: options.to, limit: 8, account: accRef });

        return `
          <div class="report-doc-sheet">
            <div class="report-doc-header">
              <div>
                <div class="report-doc-brand">FINANCE TRACKER · FINANCIAL STATEMENT</div>
                <h1 class="report-doc-title">${escHtml(meta.title)}</h1>
                <div class="report-doc-meta">
                  <span><strong>Scope:</strong> ${selectedAcc ? escHtml(selectedAcc.name) : "Consolidated (All Accounts)"}</span>
                  <span><strong>Period:</strong> ${escHtml(options.from)} to ${escHtml(options.to)}</span>
                  <span><strong>Currency Mode:</strong> ${isIndividual ? `Native (${activeCurrency})` : `Reporting (${currency})`}</span>
                </div>
              </div>
              <div class="report-doc-stamp">
                <span class="pill pill-primary">${escHtml(currency)} Snapshot</span>
                <span class="small muted">${new Date().toISOString().slice(0, 10)}</span>
              </div>
            </div>

            <div class="report-doc-kpis">
              <div class="report-kpi"><div class="lbl">Total Income</div><div class="val text-positive">${formatMoney(summary.income_cents, activeCurrency)}</div></div>
              <div class="report-kpi"><div class="lbl">Total Expenses</div><div class="val text-negative">${formatMoney(summary.expense_cents, activeCurrency)}</div></div>
              <div class="report-kpi"><div class="lbl">Net Cash Flow</div><div class="val ${summary.net_cents >= 0 ? "text-positive" : "text-negative"}">${formatMoney(summary.net_cents, activeCurrency)}</div></div>
              <div class="report-kpi"><div class="lbl">Transaction Volume</div><div class="val">${summary.transaction_count} txns</div></div>
            </div>

            ${isIndividual ? `
              <div class="report-section">
                <h3>Account Transfers</h3>
                <table class="report-table">
                  <thead><tr><th>Transfer Type</th><th class="num">Amount</th><th>Impact</th></tr></thead>
                  <tbody>
                    <tr><td>Transfer In (Inflow)</td><td class="num text-positive">+${formatMoney(summary.transfer_in_cents, activeCurrency)}</td><td>Inflow to this account</td></tr>
                    <tr><td>Transfer Out (Outflow)</td><td class="num text-negative">-${formatMoney(summary.transfer_out_cents, activeCurrency)}</td><td>Outflow to other account</td></tr>
                  </tbody>
                </table>
              </div>
            ` : ""}

            <div class="report-section">
              <h3>Closing Balances as of ${escHtml(options.to)}</h3>
              <table class="report-table">
                <thead><tr><th>Account Name</th><th>Type</th><th>Currency</th><th class="num">Balance</th></tr></thead>
                <tbody>
                  ${balances.map(b => `
                    <tr>
                      <td><strong>${escHtml(b.account_name)}</strong></td>
                      <td><span class="pill">${escHtml(b.account_kind)}</span></td>
                      <td>${escHtml(b.currency_code)}</td>
                      <td class="num font-bold">${formatMoney(b.current_balance_cents, isIndividual ? b.currency_code : currency)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>

            <div class="grid2">
              <div class="report-section">
                <h3>Top Expense Categories</h3>
                <table class="report-table">
                  <thead><tr><th>Category</th><th class="num">Amount</th></tr></thead>
                  <tbody>
                    ${topCats.map(c => `<tr><td>${escHtml(c.category_name)}</td><td class="num">${formatMoney(c.spent_cents, activeCurrency)}</td></tr>`).join("") || "<tr><td colspan='2' class='muted text-center'>No expenses in period</td></tr>"}
                  </tbody>
                </table>
              </div>
              <div class="report-section">
                <h3>Top Payees</h3>
                <table class="report-table">
                  <thead><tr><th>Payee</th><th class="num">Amount</th><th class="num">Txns</th></tr></thead>
                  <tbody>
                    ${topPayees.map(p => `<tr><td>${escHtml(p.label)}</td><td class="num">${formatMoney(p.spent_cents, activeCurrency)}</td><td class="num">${p.transaction_count}</td></tr>`).join("") || "<tr><td colspan='3' class='muted text-center'>No payees in period</td></tr>"}
                  </tbody>
                </table>
              </div>
            </div>

            <div class="report-callout info">
              <strong>Reporting Currency Snapshot Rule:</strong> Consolidated results convert ledger amounts using historical FX rates stored on transactions. Individual account scope displays authentic native currency transactions and balance values.
            </div>
          </div>
        `;
      }

      case "cashflow_trend": {
        const accounts = await invoke<Account[]>("list_accounts", { includeArchived: false });
        const selectedAcc = options.accountId ? (accounts.find(a => a.id === options.accountId) ?? null) : null;
        const accRef = selectedAcc ? String(selectedAcc.id) : null;
        const points = await invoke<MonthlyCashFlowPoint[]>("monthly_cash_flow", { months: options.months, account: accRef });

        const fromMonth = points[0]?.month ? `${points[0].month}-01` : "2020-01-01";
        const toMonth = points[points.length - 1]?.month ? `${points[points.length - 1].month}-28` : "2099-12-31";

        const [topCats, topPayees, tagSpending] = await Promise.all([
          invoke<CategorySpendingPoint[]>("category_spending", { from: fromMonth, to: toMonth, limit: 8, account: accRef }),
          invoke<SpendingBreakdownPoint[]>("spending_by_payee", { from: fromMonth, to: toMonth, limit: 8, account: accRef }),
          invoke<SpendingBreakdownPoint[]>("spending_by_tag", { from: fromMonth, to: toMonth, limit: 8, account: accRef }),
        ]);

        const totalIncome = points.reduce((s, p) => s + p.income_cents, 0);
        const totalExpense = points.reduce((s, p) => s + p.expense_cents, 0);
        const netSavings = totalIncome - totalExpense;

        return `
          <div class="report-doc-sheet">
            <div class="report-doc-header">
              <div>
                <div class="report-doc-brand">FINANCE TRACKER · CASH FLOW AUDIT</div>
                <h1 class="report-doc-title">${escHtml(meta.title)}</h1>
                <div class="report-doc-meta">
                  <span><strong>Scope:</strong> ${selectedAcc ? escHtml(selectedAcc.name) : "All Accounts Consolidated"}</span>
                  <span><strong>Period:</strong> ${options.months} Months (${points[0]?.month ?? ""} to ${points[points.length - 1]?.month ?? ""})</span>
                  <span><strong>Reporting:</strong> ${escHtml(currency)}</span>
                </div>
              </div>
            </div>

            <div class="report-doc-kpis">
              <div class="report-kpi"><div class="lbl">Total Inflows</div><div class="val text-positive">${formatMoney(totalIncome, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Total Outflows</div><div class="val text-negative">${formatMoney(totalExpense, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Net Period Savings</div><div class="val ${netSavings >= 0 ? "text-positive" : "text-negative"}">${formatMoney(netSavings, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Avg Monthly Flow</div><div class="val">${formatMoney(Math.round(netSavings / (points.length || 1)), currency)}</div></div>
            </div>

            <div class="report-section">
              <h3>Monthly Cash-Flow & Month-on-Month Trends</h3>
              <table class="report-table">
                <thead><tr><th>Month</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Net Cash Flow</th><th class="num">Savings Rate</th></tr></thead>
                <tbody>
                  ${points.map(pt => {
                    const margin = pt.income_cents > 0 ? ((pt.net_cents / pt.income_cents) * 100).toFixed(1) + "%" : "—";
                    return `
                      <tr>
                        <td><strong>${escHtml(pt.month)}</strong></td>
                        <td class="num text-positive">${formatMoney(pt.income_cents, currency)}</td>
                        <td class="num text-negative">${formatMoney(pt.expense_cents, currency)}</td>
                        <td class="num font-bold ${pt.net_cents >= 0 ? "text-positive" : "text-negative"}">${formatMoney(pt.net_cents, currency)}</td>
                        <td class="num">${margin}</td>
                      </tr>
                    `;
                  }).join("")}
                </tbody>
              </table>
            </div>

            <div class="grid2">
              <div class="report-section">
                <h3>Top Spending Drivers</h3>
                <table class="report-table">
                  <thead><tr><th>Category</th><th class="num">Amount</th></tr></thead>
                  <tbody>${topCats.map(c => `<tr><td>${escHtml(c.category_name)}</td><td class="num">${formatMoney(c.spent_cents, currency)}</td></tr>`).join("")}</tbody>
                </table>
              </div>
              <div class="report-section">
                <h3>Spending by Tag</h3>
                <table class="report-table">
                  <thead><tr><th>Tag</th><th class="num">Amount</th><th class="num">Count</th></tr></thead>
                  <tbody>${tagSpending.map(t => `<tr><td><span class="pill">${escHtml(t.label)}</span></td><td class="num">${formatMoney(t.spent_cents, currency)}</td><td class="num">${t.transaction_count}</td></tr>`).join("") || "<tr><td colspan='3' class='muted text-center'>No tagged transactions</td></tr>"}</tbody>
                </table>
              </div>
            </div>

            <div class="report-callout info">
              <strong>Tag Spending Notice:</strong> A single transaction may carry multiple tags; tag spending totals reflect tagged occurrences and are not additive across tags.
            </div>
          </div>
        `;
      }

      case "budget_position": {
        const scenarios = await invoke<PlanningScenarioRecord[]>("list_scenarios");
        const activeScenario = options.scenarioId ? (scenarios.find(s => s.id === options.scenarioId) ?? null) : null;
        const rows = await invoke<BudgetStatusRecord[]>("budget_status", { month: options.month, scenario: activeScenario ? String(activeScenario.id) : null });

        const totalAlloc = rows.reduce((s, r) => s + r.allocated_cents, 0);
        const totalRollover = rows.reduce((s, r) => s + r.rollover_cents, 0);
        const totalAvailable = rows.reduce((s, r) => s + r.budget_cents, 0);
        const totalSpent = rows.reduce((s, r) => s + r.spent_cents, 0);
        const totalRemaining = rows.reduce((s, r) => s + r.remaining_cents, 0);

        return `
          <div class="report-doc-sheet">
            <div class="report-doc-header">
              <div>
                <div class="report-doc-brand">FINANCE TRACKER · BUDGET POSITION</div>
                <h1 class="report-doc-title">${escHtml(meta.title)}</h1>
                <div class="report-doc-meta">
                  <span><strong>Month:</strong> ${escHtml(options.month)}</span>
                  <span><strong>Scenario:</strong> ${activeScenario ? escHtml(activeScenario.name) : "Baseline (Real World)"}</span>
                  <span><strong>Envelopes:</strong> ${rows.length}</span>
                </div>
              </div>
            </div>

            <div class="report-doc-kpis">
              <div class="report-kpi"><div class="lbl">Total Allocated</div><div class="val">${formatMoney(totalAlloc, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Rollover Carry</div><div class="val ${totalRollover >= 0 ? "text-positive" : "text-warning"}">${formatMoney(totalRollover, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Available Funds</div><div class="val">${formatMoney(totalAvailable, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Actual Spent</div><div class="val text-negative">${formatMoney(totalSpent, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Remaining Net</div><div class="val ${totalRemaining >= 0 ? "text-positive" : "text-negative"}">${formatMoney(totalRemaining, currency)}</div></div>
            </div>

            <div class="report-section">
              <h3>Envelope Performance</h3>
              <table class="report-table">
                <thead><tr><th>Category</th><th>Scope</th><th class="num">Allocated</th><th class="num">Rollover</th><th class="num">Moves</th><th class="num">Available</th><th class="num">Spent</th><th class="num">Remaining</th><th>Status</th></tr></thead>
                <tbody>
                  ${rows.map(r => `
                    <tr>
                      <td><strong>${escHtml(r.category_name)}</strong></td>
                      <td><span class="pill">${r.account_name ? `Acc: ${escHtml(r.account_name)}` : "Global"}</span></td>
                      <td class="num">${formatMoney(r.allocated_cents, currency)}</td>
                      <td class="num">${formatMoney(r.rollover_cents, currency)}</td>
                      <td class="num">${formatMoney(r.moved_cents, currency)}</td>
                      <td class="num font-bold">${formatMoney(r.budget_cents, currency)}</td>
                      <td class="num text-negative">${formatMoney(r.spent_cents, currency)}</td>
                      <td class="num font-bold ${r.remaining_cents >= 0 ? "text-positive" : "text-negative"}">${formatMoney(r.remaining_cents, currency)}</td>
                      <td><span class="pill ${r.over_budget ? "pill-danger" : "pill-success"}">${r.over_budget ? "OVER" : "OK"}</span></td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>

            <div class="report-callout info">
              <strong>Envelope Precedence Rule:</strong> Account-specific envelopes consume ledger spending before global envelopes. Transactions on an account with a specific envelope deplete that envelope first, leaving global allowances intact.
            </div>
          </div>
        `;
      }

      case "budget_rollover": {
        const scenarios = await invoke<PlanningScenarioRecord[]>("list_scenarios");
        const activeScenario = options.scenarioId ? (scenarios.find(s => s.id === options.scenarioId) ?? null) : null;
        const rows = await invoke<BudgetStatusRecord[]>("budget_status", { month: options.month, scenario: activeScenario ? String(activeScenario.id) : null });
        let moves: BudgetMoveRecord[] = [];
        try { moves = await invoke<BudgetMoveRecord[]>("list_budget_moves", { month: options.month }); } catch {}

        const totalCarryIn = rows.reduce((s, r) => s + r.rollover_cents, 0);
        const totalAlloc = rows.reduce((s, r) => s + r.allocated_cents, 0);
        const totalClosingCarry = rows.filter(r => r.rollover_start_month).reduce((s, r) => s + r.remaining_cents, 0);

        return `
          <div class="report-doc-sheet">
            <div class="report-doc-header">
              <div>
                <div class="report-doc-brand">FINANCE TRACKER · ROLLOVER & REALLOCATION AUDIT</div>
                <h1 class="report-doc-title">${escHtml(meta.title)}</h1>
                <div class="report-doc-meta">
                  <span><strong>Audit Month:</strong> ${escHtml(options.month)}</span>
                  <span><strong>Scenario:</strong> ${activeScenario ? escHtml(activeScenario.name) : "Baseline"}</span>
                </div>
              </div>
            </div>

            <div class="report-doc-kpis">
              <div class="report-kpi"><div class="lbl">Opening Carry-In</div><div class="val ${totalCarryIn >= 0 ? "text-positive" : "text-warning"}">${formatMoney(totalCarryIn, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Base Allocations</div><div class="val">${formatMoney(totalAlloc, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Moves Logged</div><div class="val">${moves.length} moves</div></div>
              <div class="report-kpi"><div class="lbl">Closing Carry Forward</div><div class="val ${totalClosingCarry >= 0 ? "text-positive" : "text-negative"}">${formatMoney(totalClosingCarry, currency)}</div></div>
            </div>

            <div class="report-section">
              <h3>Rollover Carry-Forward Schedule</h3>
              <table class="report-table">
                <thead><tr><th>Category</th><th>Scope</th><th>Policy Start</th><th class="num">Opening Carry</th><th class="num">Allocation</th><th class="num">Moves</th><th class="num">Spent</th><th class="num">Closing Carry</th></tr></thead>
                <tbody>
                  ${rows.map(r => `
                    <tr>
                      <td><strong>${escHtml(r.category_name)}</strong></td>
                      <td><span class="pill">${r.account_name ? `Acc: ${escHtml(r.account_name)}` : "Global"}</span></td>
                      <td>${r.rollover_start_month ?? "No Rollover"}</td>
                      <td class="num">${formatMoney(r.rollover_cents, currency)}</td>
                      <td class="num">${formatMoney(r.allocated_cents, currency)}</td>
                      <td class="num">${formatMoney(r.moved_cents, currency)}</td>
                      <td class="num text-negative">${formatMoney(r.spent_cents, currency)}</td>
                      <td class="num font-bold ${r.remaining_cents >= 0 ? "text-positive" : "text-negative"}">${formatMoney(r.remaining_cents, currency)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>

            ${moves.length > 0 ? `
              <div class="report-section">
                <h3>Money Moves Reallocated in ${escHtml(options.month)}</h3>
                <table class="report-table">
                  <thead><tr><th>Date</th><th>From Category</th><th>To Category</th><th>Scope</th><th class="num">Amount</th></tr></thead>
                  <tbody>
                    ${moves.map(m => `
                      <tr>
                        <td>${m.created_at.slice(0, 10)}</td>
                        <td>${escHtml(m.from_category_name)}</td>
                        <td>${escHtml(m.to_category_name)}</td>
                        <td>${m.account_name ? escHtml(m.account_name) : "Global Scope"}</td>
                        <td class="num font-bold">${formatMoney(m.amount_cents, currency)}</td>
                      </tr>
                    `).join("")}
                  </tbody>
                </table>
              </div>
            ` : ""}

            <div class="report-callout info">
              <strong>Negative Carry Deficit Notice:</strong> Overspending on rollover-enabled envelopes carries into subsequent months as a negative starting balance, automatically enforcing future spending discipline.
            </div>
          </div>
        `;
      }

      case "cash_forecast": {
        const accounts = await invoke<Account[]>("list_accounts", { includeArchived: false });
        const selectedAcc = options.accountId ? (accounts.find(a => a.id === options.accountId) ?? null) : null;
        const scenarios = await invoke<PlanningScenarioRecord[]>("list_scenarios");
        const activeScenario = options.scenarioId ? (scenarios.find(s => s.id === options.scenarioId) ?? null) : null;

        const snapshot = await invoke<ForecastSnapshot>("get_forecast", {
          scenario: activeScenario ? String(activeScenario.id) : null,
          account: selectedAcc ? String(selectedAcc.id) : null,
          horizonDays: options.horizonDays,
        });

        const openingBal = snapshot.daily[0]?.opening_balance_cents ?? 0;
        const endingBal = snapshot.daily.at(-1)?.closing_balance_cents ?? 0;
        const totalInflows = snapshot.daily.reduce((s, d) => s + d.inflow_cents, 0);
        const totalOutflows = snapshot.daily.reduce((s, d) => s + d.outflow_cents, 0);

        return `
          <div class="report-doc-sheet">
            <div class="report-doc-header">
              <div>
                <div class="report-doc-brand">FINANCE TRACKER · CASH PROJECTIONS</div>
                <h1 class="report-doc-title">${escHtml(meta.title)}</h1>
                <div class="report-doc-meta">
                  <span><strong>Scope:</strong> ${snapshot.account.name ?? "All Accounts Consolidated"}</span>
                  <span><strong>Scenario:</strong> ${snapshot.scenario.name ?? "Baseline"}</span>
                  <span><strong>Horizon:</strong> ${options.horizonDays} Days</span>
                </div>
              </div>
            </div>

            <div class="report-doc-kpis">
              <div class="report-kpi"><div class="lbl">Opening Balance</div><div class="val">${formatMoney(openingBal, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Projected Inflows</div><div class="val text-positive">${formatMoney(totalInflows, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Projected Outflows</div><div class="val text-negative">${formatMoney(totalOutflows, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Projected Ending</div><div class="val ${endingBal >= 0 ? "text-positive" : "text-negative"}">${formatMoney(endingBal, currency)}</div></div>
            </div>

            ${snapshot.warnings.length > 0 ? `
              <div class="report-callout warn">
                <strong>Forecast Warnings:</strong> ${escHtml(snapshot.warnings.join(" • "))}
              </div>
            ` : ""}

            <div class="report-section">
              <h3>12-Month Roll-Up</h3>
              <table class="report-table">
                <thead><tr><th>Month</th><th class="num">Inflow</th><th class="num">Outflow</th><th class="num">Net</th><th class="num">Ending Balance</th></tr></thead>
                <tbody>
                  ${snapshot.monthly.slice(0, 12).map(m => `
                    <tr>
                      <td><strong>${escHtml(m.month)}</strong></td>
                      <td class="num text-positive">${formatMoney(m.inflow_cents, currency)}</td>
                      <td class="num text-negative">${formatMoney(m.outflow_cents, currency)}</td>
                      <td class="num font-bold ${m.net_cents >= 0 ? "text-positive" : "text-negative"}">${formatMoney(m.net_cents, currency)}</td>
                      <td class="num font-bold">${formatMoney(m.ending_balance_cents, currency)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>

            <div class="report-section">
              <h3>Upcoming Bill Calendar (Next 15 Obligations)</h3>
              <table class="report-table">
                <thead><tr><th>Date</th><th>Obligation / Description</th><th>Source</th><th>Account</th><th class="num">Amount</th></tr></thead>
                <tbody>
                  ${snapshot.bill_calendar.slice(0, 15).map(item => `
                    <tr>
                      <td>${escHtml(item.date)}</td>
                      <td><strong>${escHtml(item.title)}</strong></td>
                      <td><span class="pill">${escHtml(item.source)}</span></td>
                      <td>${escHtml(item.account_name)}</td>
                      <td class="num font-bold text-negative">${formatMoney(item.amount_cents, currency)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          </div>
        `;
      }

      case "scenario_comparison": {
        const scenarios = await invoke<PlanningScenarioRecord[]>("list_scenarios");
        const targetScenario = scenarios.find(s => s.id === options.scenarioId);
        if (!targetScenario) return `<div class="card empty">Select a valid comparative scenario</div>`;

        const [baseForecast, scenForecast, planItems] = await Promise.all([
          invoke<ForecastSnapshot>("get_forecast", { scenario: null, account: null, horizonDays: options.horizonDays }),
          invoke<ForecastSnapshot>("get_forecast", { scenario: String(targetScenario.id), account: null, horizonDays: options.horizonDays }),
          invoke<PlanningItemRecord[]>("list_planning_items", { scenario: String(targetScenario.id) }),
        ]);

        const baseEnd = baseForecast.daily.at(-1)?.closing_balance_cents ?? 0;
        const scenEnd = scenForecast.daily.at(-1)?.closing_balance_cents ?? 0;
        const endDelta = scenEnd - baseEnd;

        return `
          <div class="report-doc-sheet">
            <div class="report-doc-header">
              <div>
                <div class="report-doc-brand">FINANCE TRACKER · SCENARIO COMPARISON</div>
                <h1 class="report-doc-title">${escHtml(meta.title)}</h1>
                <div class="report-doc-meta">
                  <span><strong>Baseline:</strong> Real Ledger State</span>
                  <span><strong>What-If Scenario:</strong> ${escHtml(targetScenario.name)}</span>
                  <span><strong>Horizon:</strong> ${options.horizonDays} Days</span>
                </div>
              </div>
            </div>

            <div class="report-doc-kpis">
              <div class="report-kpi"><div class="lbl">Baseline Ending</div><div class="val">${formatMoney(baseEnd, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Scenario Ending</div><div class="val ${scenEnd >= 0 ? "text-positive" : "text-negative"}">${formatMoney(scenEnd, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Net Variance</div><div class="val font-bold ${endDelta >= 0 ? "text-positive" : "text-negative"}">${endDelta >= 0 ? "+" : ""}${formatMoney(endDelta, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Scenario-Only Items</div><div class="val">${planItems.length} planned</div></div>
            </div>

            <div class="report-section">
              <h3>Monthly Trajectory Comparison</h3>
              <table class="report-table">
                <thead><tr><th>Month</th><th class="num">Baseline Ending</th><th class="num">Scenario Ending</th><th class="num">Variance Delta</th></tr></thead>
                <tbody>
                  ${baseForecast.monthly.slice(0, 12).map((bM, i) => {
                    const sM = scenForecast.monthly[i];
                    const diff = sM ? sM.ending_balance_cents - bM.ending_balance_cents : 0;
                    return `
                      <tr>
                        <td><strong>${escHtml(bM.month)}</strong></td>
                        <td class="num">${formatMoney(bM.ending_balance_cents, currency)}</td>
                        <td class="num">${sM ? formatMoney(sM.ending_balance_cents, currency) : "—"}</td>
                        <td class="num font-bold ${diff >= 0 ? "text-positive" : "text-negative"}">${diff >= 0 ? "+" : ""}${formatMoney(diff, currency)}</td>
                      </tr>
                    `;
                  }).join("")}
                </tbody>
              </table>
            </div>

            <div class="report-callout info">
              <strong>Non-Destructive Simulation:</strong> Scenarios are strictly simulated models that alter forward cash flows without mutating or deleting real ledger transactions.
            </div>
          </div>
        `;
      }

      case "goals_outlook": {
        const forecast = await invoke<ForecastSnapshot>("get_forecast", { scenario: null, account: null, horizonDays: options.horizonDays });
        const goals = forecast.goal_status;
        const totalTarget = goals.reduce((s, g) => s + (g.target_amount_cents ?? g.minimum_balance_cents ?? 0), 0);
        const totalCurrent = goals.reduce((s, g) => s + g.current_balance_cents, 0);

        return `
          <div class="report-doc-sheet">
            <div class="report-doc-header">
              <div>
                <div class="report-doc-brand">FINANCE TRACKER · GOAL TRAJECTORY</div>
                <h1 class="report-doc-title">${escHtml(meta.title)}</h1>
                <div class="report-doc-meta">
                  <span><strong>Goals:</strong> ${goals.length} Tracked</span>
                  <span><strong>Horizon:</strong> ${options.horizonDays} Days</span>
                  <span><strong>On Track:</strong> ${goals.filter(g => g.on_track).length} of ${goals.length}</span>
                </div>
              </div>
            </div>

            <div class="report-doc-kpis">
              <div class="report-kpi"><div class="lbl">Total Targets / Floors</div><div class="val">${formatMoney(totalTarget, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Current Funded</div><div class="val">${formatMoney(totalCurrent, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">On-Track Goals</div><div class="val text-positive">${goals.filter(g => g.on_track).length} goals</div></div>
            </div>

            <div class="report-section">
              <h3>Goals Funding Schedule</h3>
              <table class="report-table">
                <thead><tr><th>Goal</th><th>Type</th><th>Account</th><th class="num">Target / Floor</th><th class="num">Current Cash</th><th class="num">Projected</th><th class="num">Req Monthly</th><th>Status</th></tr></thead>
                <tbody>
                  ${goals.map(g => `
                    <tr>
                      <td><strong>${escHtml(g.name)}</strong></td>
                      <td><span class="pill">${g.kind === "sinking_fund" ? "Sinking Fund" : "Balance Floor"}</span></td>
                      <td>${escHtml(g.account_name)}</td>
                      <td class="num">${formatMoney(g.target_amount_cents ?? g.minimum_balance_cents ?? 0, currency)}</td>
                      <td class="num">${formatMoney(g.current_balance_cents, currency)}</td>
                      <td class="num font-bold">${formatMoney(g.projected_balance_cents, currency)}</td>
                      <td class="num">${formatMoney(g.suggested_monthly_contribution_cents, currency)}</td>
                      <td><span class="pill ${g.on_track ? "pill-success" : "pill-danger"}">${g.on_track ? "ON TRACK" : "BEHIND"}</span></td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          </div>
        `;
      }

      case "safe_spend": {
        const snapshot = await invoke<SafeSpendSnapshot>("get_safe_to_spend");
        return `
          <div class="report-doc-sheet">
            <div class="report-doc-header">
              <div>
                <div class="report-doc-brand">FINANCE TRACKER · SAFE-TO-SPEND STATEMENT</div>
                <h1 class="report-doc-title">${escHtml(meta.title)}</h1>
                <div class="report-doc-meta">
                  <span><strong>As of:</strong> ${escHtml(snapshot.as_of)}</span>
                  <span><strong>Next Payday:</strong> ${escHtml(snapshot.payday)} (${snapshot.days} days)</span>
                  <span><strong>Horizon Source:</strong> ${escHtml(snapshot.horizon_source)}</span>
                </div>
              </div>
            </div>

            <div class="report-doc-kpis">
              <div class="report-kpi"><div class="lbl">Spendable Cash</div><div class="val">${formatMoney(snapshot.cash_cents, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Deducted Reserves</div><div class="val text-warning">${formatMoney(snapshot.scheduled_cents + snapshot.budget_reserve_cents + snapshot.credit_reserve_cents + snapshot.protected_cents + snapshot.buffer_cents, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Safe-to-Spend</div><div class="val font-bold ${snapshot.safe_cents > 0 ? "text-positive" : "text-negative"}">${formatMoney(snapshot.safe_cents, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Daily Allowance</div><div class="val text-positive">${formatMoney(snapshot.daily_cents, currency)}</div></div>
            </div>

            <div class="report-section">
              <h3>Reserve Accounting & Deductions</h3>
              <table class="report-table">
                <thead><tr><th>Deduction Component</th><th class="num">Amount</th><th>Policy & Purpose</th></tr></thead>
                <tbody>
                  <tr><td>Available Spendable Cash</td><td class="num font-bold">${formatMoney(snapshot.cash_cents, currency)}</td><td>Selected cash/checking liquid accounts</td></tr>
                  <tr><td>Credit-Card Debt Reserve</td><td class="num text-negative">-${formatMoney(snapshot.credit_reserve_cents, currency)}</td><td>Full active credit-card debt reserved</td></tr>
                  <tr><td>Scheduled Commitments</td><td class="num text-negative">-${formatMoney(snapshot.scheduled_cents, currency)}</td><td>Recurring/planned bills before payday</td></tr>
                  <tr><td>Category Budget Reserves</td><td class="num text-negative">-${formatMoney(snapshot.budget_reserve_cents, currency)}</td><td>Remaining envelope balances touched</td></tr>
                  <tr><td>Protected Goals & Sinking Funds</td><td class="num text-negative">-${formatMoney(snapshot.protected_cents, currency)}</td><td>Funded goal floors in spendable accounts</td></tr>
                  <tr><td>Emergency Buffer & Savings</td><td class="num text-negative">-${formatMoney(snapshot.buffer_cents, currency)}</td><td>Configured emergency protection</td></tr>
                  <tr style="border-top:2px solid var(--border)"><td><strong>Final Unbudgeted Safe-to-Spend</strong></td><td class="num font-bold text-positive">${formatMoney(snapshot.safe_cents, currency)}</td><td>Discretionary spending capacity</td></tr>
                </tbody>
              </table>
            </div>

            <div class="report-callout info">
              <strong>Guidance Policy:</strong> Safe-to-spend guarantees that all known bills, full category envelopes, and existing credit card balances are 100% covered before discretionary purchases occur.
            </div>
          </div>
        `;
      }

      case "balance_sheet": {
        const snapshot = await invoke<NetWorthSnapshot>("get_net_worth_snapshot");
        const balances = await invoke<BalanceRecord[]>("get_reporting_balances_as_of", { asOf: options.asOfDate });
        const investments = await invoke<InvestmentAccountRecord[]>("list_investment_accounts");
        const manualItems = await invoke<NetWorthItemRecord[]>("list_net_worth_items");
        const loans = await invoke<LoanRecord[]>("list_loans");

        return `
          <div class="report-doc-sheet">
            <div class="report-doc-header">
              <div>
                <div class="report-doc-brand">FINANCE TRACKER · CONSOLIDATED BALANCE SHEET</div>
                <h1 class="report-doc-title">${escHtml(meta.title)}</h1>
                <div class="report-doc-meta">
                  <span><strong>As of:</strong> ${escHtml(options.asOfDate)}</span>
                  <span><strong>Reporting Currency:</strong> ${escHtml(currency)}</span>
                </div>
              </div>
            </div>

            <div class="report-doc-kpis">
              <div class="report-kpi"><div class="lbl">Total Assets</div><div class="val text-positive">${formatMoney(snapshot.assets_cents, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Total Liabilities</div><div class="val text-negative">${formatMoney(snapshot.liabilities_cents, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Net Worth</div><div class="val font-bold ${snapshot.net_worth_cents >= 0 ? "text-positive" : "text-negative"}">${formatMoney(snapshot.net_worth_cents, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">30-Day MoM Change</div><div class="val ${snapshot.month_over_month_cents >= 0 ? "text-positive" : "text-negative"}">${snapshot.month_over_month_cents >= 0 ? "+" : ""}${formatMoney(snapshot.month_over_month_cents, currency)}</div></div>
            </div>

            <div class="grid2">
              <div class="report-section">
                <h3>Assets</h3>
                <table class="report-table">
                  <thead><tr><th>Asset</th><th class="num">Value</th></tr></thead>
                  <tbody>
                    ${balances.filter(b => b.current_balance_cents > 0).map(b => `<tr><td>${escHtml(b.account_name)}</td><td class="num">${formatMoney(b.current_balance_cents, currency)}</td></tr>`).join("")}
                    ${investments.map(i => `<tr><td>${escHtml(i.name)}</td><td class="num">${formatMoney(i.value_cents, currency)}</td></tr>`).join("")}
                    ${manualItems.filter(m => m.kind === "asset").map(m => `<tr><td>${escHtml(m.name)}</td><td class="num">${formatMoney(m.value_cents, currency)}</td></tr>`).join("")}
                  </tbody>
                </table>
              </div>

              <div class="report-section">
                <h3>Liabilities</h3>
                <table class="report-table">
                  <thead><tr><th>Liability</th><th class="num">Balance</th></tr></thead>
                  <tbody>
                    ${balances.filter(b => b.current_balance_cents < 0).map(b => `<tr><td>${escHtml(b.account_name)}</td><td class="num text-negative">${formatMoney(Math.abs(b.current_balance_cents), currency)}</td></tr>`).join("")}
                    ${loans.map(l => `<tr><td>${escHtml(l.name)}</td><td class="num text-negative">${formatMoney(l.outstanding_cents, currency)}</td></tr>`).join("")}
                    ${manualItems.filter(m => m.kind === "liability").map(m => `<tr><td>${escHtml(m.name)}</td><td class="num text-negative">${formatMoney(m.value_cents, currency)}</td></tr>`).join("")}
                  </tbody>
                </table>
              </div>
            </div>

            <div class="report-callout warn">
              <strong>Valuation Notice:</strong> 12-month net-worth evolution combines historical ledger balances with current valuations for non-ledger properties, loans, and investment accounts; it does not represent an active historical mark-to-market appraisal.
            </div>
          </div>
        `;
      }

      case "investment_portfolio": {
        const accounts = await invoke<InvestmentAccountRecord[]>("list_investment_accounts");
        const xirr = await invoke<PortfolioXirrRecord>("portfolio_xirr");
        const selectedAcc = options.investmentAccountId ? (accounts.find(a => a.id === options.investmentAccountId) ?? null) : null;
        const targetAccounts = selectedAcc ? [selectedAcc] : accounts;

        const details = await Promise.all(
          targetAccounts.map(async acc => {
            const [performance, lots] = await Promise.all([
              invoke<InvestmentPerformanceRecord>("investment_account_performance", { investmentAccountId: acc.id }),
              invoke<HoldingLotRecord[]>("list_holding_lots", { investmentAccountId: acc.id }),
            ]);
            return { acc, performance, lots };
          })
        );

        const totalValue = details.reduce((s, d) => s + d.performance.value_cents, 0);
        const totalCost = details.reduce((s, d) => s + d.performance.cost_basis_cents, 0);
        const totalUnrealized = details.reduce((s, d) => s + d.performance.unrealized_gain_cents, 0);

        return `
          <div class="report-doc-sheet">
            <div class="report-doc-header">
              <div>
                <div class="report-doc-brand">FINANCE TRACKER · INVESTMENT PORTFOLIO</div>
                <h1 class="report-doc-title">${escHtml(meta.title)}</h1>
                <div class="report-doc-meta">
                  <span><strong>Scope:</strong> ${selectedAcc ? escHtml(selectedAcc.name) : "Consolidated Portfolio"}</span>
                  <span><strong>Portfolios:</strong> ${targetAccounts.length}</span>
                </div>
              </div>
            </div>

            <div class="report-doc-kpis">
              <div class="report-kpi"><div class="lbl">Portfolio Value</div><div class="val font-bold">${formatMoney(totalValue, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">FIFO Cost Basis</div><div class="val">${formatMoney(totalCost, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Unrealized Gain</div><div class="val ${totalUnrealized >= 0 ? "text-positive" : "text-negative"}">${totalUnrealized >= 0 ? "+" : ""}${formatMoney(totalUnrealized, currency)}</div></div>
              <div class="report-kpi"><div class="lbl">Portfolio XIRR</div><div class="val text-positive">${formatPercent(xirr.annualized_return_percent)}</div></div>
            </div>

            <div class="report-section">
              <h3>Accounts Performance</h3>
              <table class="report-table">
                <thead><tr><th>Portfolio Account</th><th>Institution</th><th class="num">Value</th><th class="num">Cost Basis</th><th class="num">Unrealized Gain</th><th class="num">TWR</th></tr></thead>
                <tbody>
                  ${details.map(d => `
                    <tr>
                      <td><strong>${escHtml(d.acc.name)}</strong></td>
                      <td>${escHtml(d.acc.institution ?? "—")}</td>
                      <td class="num font-bold">${formatMoney(d.performance.value_cents, currency)}</td>
                      <td class="num">${formatMoney(d.performance.cost_basis_cents, currency)}</td>
                      <td class="num ${d.performance.unrealized_gain_cents >= 0 ? "text-positive" : "text-negative"}">${formatMoney(d.performance.unrealized_gain_cents, currency)}</td>
                      <td class="num font-bold">${formatPercent(d.performance.time_weighted_return_percent)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>

            <div class="report-callout warn">
              <strong>Price Coverage Rule:</strong> Marked gains and true portfolio returns require price snapshots for every held position. Accounts lacking current security quotes fall back to their stored manual valuation snapshots.
            </div>
          </div>
        `;
      }
    }
  } catch (e: any) {
    return `<div class="card empty">Unable to render preview: ${escHtml(String(e))}</div>`;
  }
}

/* =========================================================
   Reports Page View Renderer (Mounted in SPA)
   ========================================================= */
export async function renderReportsPage(main: HTMLElement, accounts: Account[], currency: string, toast: (msg: string, isErr?: boolean) => void) {
  let activeReportId: ReportType = "period_overview";
  let scenarios: PlanningScenarioRecord[] = [];
  let investmentAccounts: InvestmentAccountRecord[] = [];

  try {
    [scenarios, investmentAccounts] = await Promise.all([
      invoke<PlanningScenarioRecord[]>("list_scenarios"),
      invoke<InvestmentAccountRecord[]>("list_investment_accounts"),
    ]);
  } catch {}

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const firstDayThisMonth = `${currentMonth}-01`;
  const todayStr = now.toISOString().slice(0, 10);

  // Form State
  let state = {
    from: firstDayThisMonth,
    to: todayStr,
    accountId: null as number | null,
    months: 12,
    month: currentMonth,
    scenarioId: null as number | null,
    horizonDays: 90,
    asOfDate: todayStr,
    investmentAccountId: null as number | null,
  };

  function paint() {
    main.innerHTML = `
      <div class="page-head">
        <div>
          <h2>Financial Reports & PDF Statements</h2>
          <p>Generate, interactively preview, and export high-fidelity PDF statements across cash flow, budgeting, forecasting, net worth, and investments.</p>
        </div>
      </div>

      <!-- Report Catalog Nav Cards -->
      <div class="reports-catalog-grid">
        ${REPORT_CATALOG.map(r => `
          <div class="report-card ${r.id === activeReportId ? "active" : ""}" data-report="${r.id}">
            <div class="report-card-top">
              <span class="report-badge">${r.badge}</span>
              <span class="report-group">${r.category}</span>
            </div>
            <h4 class="report-card-title">${r.title}</h4>
            <p class="report-card-desc">${r.description}</p>
          </div>
        `).join("")}
      </div>

      <!-- Dynamic Parameter Controls Bar -->
      <div class="card report-controls-bar">
        <div class="report-controls-form">
          ${renderControlsForReport(activeReportId, state, accounts, scenarios, investmentAccounts)}
        </div>
        <div class="report-controls-actions">
          <button class="btn" id="btn-refresh-preview">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            Refresh Preview
          </button>
          <button class="btn btn-primary" id="btn-export-pdf">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
            Export PDF
          </button>
        </div>
      </div>

      <!-- Live Interactive Document Preview -->
      <div class="report-preview-container" id="report-preview-mount">
        <div class="card empty">Loading statement preview…</div>
      </div>
    `;

    // Bind Catalog Card clicks
    main.querySelectorAll("[data-report]").forEach(el => {
      el.addEventListener("click", () => {
        const id = (el as HTMLElement).dataset.report as ReportType;
        if (id === activeReportId) return;
        activeReportId = id;
        paint();
      });
    });

    // Bind Inputs
    bindControls(main, state, () => loadPreview());

    // Bind Actions
    main.querySelector("#btn-refresh-preview")?.addEventListener("click", () => loadPreview());
    main.querySelector("#btn-export-pdf")?.addEventListener("click", () => {
      exportReportPdf(activeReportId, state, toast);
    });

    loadPreview();
  }

  async function loadPreview() {
    const mount = main.querySelector("#report-preview-mount");
    if (!mount) return;
    mount.innerHTML = `<div class="card empty">Rendering high-resolution statement preview…</div>`;
    const html = await renderReportPreviewHtml(activeReportId, state, currency);
    mount.innerHTML = html;
  }

  paint();
}

function renderControlsForReport(
  id: ReportType,
  state: any,
  accounts: Account[],
  scenarios: PlanningScenarioRecord[],
  investments: InvestmentAccountRecord[]
): string {
  const accOpts = `<option value="">All accounts</option>` + accounts.map(a => `<option value="${a.id}" ${state.accountId === a.id ? "selected" : ""}>${escHtml(a.name)} (${escHtml(a.currency_code)})</option>`).join("");
  const scenOpts = `<option value="">Baseline (Real World)</option>` + scenarios.map(s => `<option value="${s.id}" ${state.scenarioId === s.id ? "selected" : ""}>${escHtml(s.name)}</option>`).join("");
  const invOpts = `<option value="">Consolidated Portfolio (All)</option>` + investments.map(i => `<option value="${i.id}" ${state.investmentAccountId === i.id ? "selected" : ""}>${escHtml(i.name)}</option>`).join("");

  switch (id) {
    case "period_overview":
      return `
        <div class="field" style="margin:0"><label>From Date</label><input class="input" type="date" id="rc-from" value="${state.from}"/></div>
        <div class="field" style="margin:0"><label>To Date</label><input class="input" type="date" id="rc-to" value="${state.to}"/></div>
        <div class="field" style="margin:0"><label>Account Scope</label><select id="rc-account">${accOpts}</select></div>
      `;
    case "cashflow_trend":
      return `
        <div class="field" style="margin:0"><label>History Window</label><select id="rc-months"><option value="6" ${state.months === 6 ? "selected" : ""}>6 Months</option><option value="12" ${state.months === 12 ? "selected" : ""}>12 Months</option><option value="18" ${state.months === 18 ? "selected" : ""}>18 Months</option><option value="24" ${state.months === 24 ? "selected" : ""}>24 Months</option></select></div>
        <div class="field" style="margin:0"><label>Account Scope</label><select id="rc-account">${accOpts}</select></div>
      `;
    case "budget_position":
    case "budget_rollover":
      return `
        <div class="field" style="margin:0"><label>Budget Month</label><input class="input" type="month" id="rc-month" value="${state.month}"/></div>
        <div class="field" style="margin:0"><label>Scenario</label><select id="rc-scenario">${scenOpts}</select></div>
      `;
    case "cash_forecast":
      return `
        <div class="field" style="margin:0"><label>Forecast Horizon</label><select id="rc-horizon"><option value="30" ${state.horizonDays === 30 ? "selected" : ""}>30 Days</option><option value="60" ${state.horizonDays === 60 ? "selected" : ""}>60 Days</option><option value="90" ${state.horizonDays === 90 ? "selected" : ""}>90 Days</option><option value="180" ${state.horizonDays === 180 ? "selected" : ""}>180 Days</option><option value="365" ${state.horizonDays === 365 ? "selected" : ""}>365 Days</option></select></div>
        <div class="field" style="margin:0"><label>Account Scope</label><select id="rc-account">${accOpts}</select></div>
        <div class="field" style="margin:0"><label>Scenario</label><select id="rc-scenario">${scenOpts}</select></div>
      `;
    case "scenario_comparison":
      return `
        <div class="field" style="margin:0"><label>Comparison Scenario</label><select id="rc-scenario">${scenarios.map(s => `<option value="${s.id}" ${state.scenarioId === s.id ? "selected" : ""}>${escHtml(s.name)}</option>`).join("")}</select></div>
        <div class="field" style="margin:0"><label>Forecast Horizon</label><select id="rc-horizon"><option value="90" ${state.horizonDays === 90 ? "selected" : ""}>90 Days</option><option value="180" ${state.horizonDays === 180 ? "selected" : ""}>180 Days</option><option value="365" ${state.horizonDays === 365 ? "selected" : ""}>365 Days</option></select></div>
      `;
    case "goals_outlook":
      return `
        <div class="field" style="margin:0"><label>Forecast Horizon</label><select id="rc-horizon"><option value="90" ${state.horizonDays === 90 ? "selected" : ""}>90 Days</option><option value="180" ${state.horizonDays === 180 ? "selected" : ""}>180 Days</option><option value="365" ${state.horizonDays === 365 ? "selected" : ""}>365 Days (1 Year)</option></select></div>
      `;
    case "safe_spend":
      return `
        <div class="small muted" style="align-self:center">Derives real-time safe spending guidance from current spendable cash, active debt, upcoming commitments, and envelope reserves.</div>
      `;
    case "balance_sheet":
      return `
        <div class="field" style="margin:0"><label>As of Date</label><input class="input" type="date" id="rc-asof" value="${state.asOfDate}"/></div>
      `;
    case "investment_portfolio":
      return `
        <div class="field" style="margin:0"><label>Portfolio Scope</label><select id="rc-inv-account">${invOpts}</select></div>
      `;
  }
}

function bindControls(main: HTMLElement, state: any, onChange: () => void) {
  const fromEl = main.querySelector<HTMLInputElement>("#rc-from");
  if (fromEl) fromEl.addEventListener("change", () => { state.from = fromEl.value; onChange(); });

  const toEl = main.querySelector<HTMLInputElement>("#rc-to");
  if (toEl) toEl.addEventListener("change", () => { state.to = toEl.value; onChange(); });

  const accEl = main.querySelector<HTMLSelectElement>("#rc-account");
  if (accEl) accEl.addEventListener("change", () => { state.accountId = accEl.value ? Number(accEl.value) : null; onChange(); });

  const monthsEl = main.querySelector<HTMLSelectElement>("#rc-months");
  if (monthsEl) monthsEl.addEventListener("change", () => { state.months = Number(monthsEl.value); onChange(); });

  const monthEl = main.querySelector<HTMLInputElement>("#rc-month");
  if (monthEl) monthEl.addEventListener("change", () => { state.month = monthEl.value; onChange(); });

  const scenEl = main.querySelector<HTMLSelectElement>("#rc-scenario");
  if (scenEl) scenEl.addEventListener("change", () => { state.scenarioId = scenEl.value ? Number(scenEl.value) : null; onChange(); });

  const horizEl = main.querySelector<HTMLSelectElement>("#rc-horizon");
  if (horizEl) horizEl.addEventListener("change", () => { state.horizonDays = Number(horizEl.value); onChange(); });

  const asOfEl = main.querySelector<HTMLInputElement>("#rc-asof");
  if (asOfEl) asOfEl.addEventListener("change", () => { state.asOfDate = asOfEl.value; onChange(); });

  const invAccEl = main.querySelector<HTMLSelectElement>("#rc-inv-account");
  if (invAccEl) invAccEl.addEventListener("change", () => { state.investmentAccountId = invAccEl.value ? Number(invAccEl.value) : null; onChange(); });
}
