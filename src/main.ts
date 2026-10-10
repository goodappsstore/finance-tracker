import { titlebarHtml, bindTitlebar, bindNavigationDrawer } from "./window-shell";
import { mountSafeSpend } from "./safe-spend";
import { renderReportsPage } from "./pdf-reports";
import { exportCurrentPagePdf } from "./page-pdf-export";
import { renderNotifications, startNotifications } from "./notifications";
import { renderPayees } from "./payees";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import "./styles.css";
import type {
  Account, Category, TransactionRecord, BalanceRecord, SummaryRecord,
  ReconciliationRecord, RecurringRuleRecord, BudgetStatusRecord, PlanningScenarioRecord,
  PlanningItemRecord, PlanningGoalRecord, ForecastSnapshot, ImportPresetSummary, ImportResult,
  BulkTransactionResult, TagRecord, TransactionAttachment, LoanRecord, NetWorthItemRecord, InvestmentAccountRecord,
  SecurityRecord, HoldingLotRecord, HoldingEventRecord, InvestmentPerformanceRecord, PortfolioXirrRecord,
  MonthlyCashFlowPoint, BalanceTrendPoint, CategorySpendingPoint, SpendingBreakdownPoint,
  DashboardSnapshot, NetWorthSnapshot,
  FireSnapshot, WealthProjectionPoint, FinancialAuditSnapshot, AuditFinding,
  FxSettings, ManualFxRate, FxRateQuote, BackupResult, BackupPreview, RestoreResult,
  TransactionSplitRecord, TransactionRuleRecord, RuleApplyResult, DebtOptimizerSnapshot, DebtAccountSettingRecord,
  TaxCenterSnapshot, InvestmentTaxSettingRecord, TaxCategorySettingRecord, ComparativeAnalyticsSnapshot,
} from "./types";

type View = "dashboard"|"accounts"|"payees"|"transactions"|"rules"|"categories"|"import"|"budgets"|"recurring"|"planning"|"forecast"|"fire"|"audit"|"reconciliation"|"loans"|"debt"|"networth"|"investments"|"tax"|"comparisons"|"reports"|"notifications"|"settings";

let view: View = "dashboard";
let currency = "USD";
let dbPath = "";
let needsInit = false;
let activeDataOperationId: string|null = null;
let dataOperationCancellationPending = false;
let restoreReloadRequired = false;
let dataOperationInteractionLocked = false;
let fxDefaultSource:"frankfurter"|"manual" = "frankfurter";
const appWebview = getCurrentWebview();
const INTERFACE_SCALE_LEVELS = [0.8, 1, 1.2, 1.4, 1.6, 1.8, 2] as const;
const DEFAULT_INTERFACE_SCALE = 1;
const storedInterfaceScale = Number(localStorage.getItem("finance-tracker-interface-scale"));
let interfaceScale = INTERFACE_SCALE_LEVELS.includes(storedInterfaceScale as typeof INTERFACE_SCALE_LEVELS[number])
  ? storedInterfaceScale
  : DEFAULT_INTERFACE_SCALE;

let accounts: Account[] = [];
let categories: Category[] = [];
let balances: BalanceRecord[] = [];
let recentTx: TransactionRecord[] = [];
let presets: ImportPresetSummary[] = [];
let dashboardAccountRef = "";
let dashboardMonths = 6;
let dashboardRenderVersion = 0;
let dashboardKeyAbort: AbortController|null = null;
let selectedAccountId: number|null = null;
let selectedPayee:string|null = null;
let accountDetailRenderVersion = 0;
let selectedLoanId: number|null = null;
let loanDetailRenderVersion = 0;
let selectedRecurringRuleId: number|null = null;
let recurringDetailRenderVersion = 0;
let selectedInvestmentAccountId: number|null = null;
let investmentDetailRenderVersion = 0;
let reconciliationSelectedAccount = "";
let planningTab: "scenarios"|"items"|"goals" = "scenarios";
interface FireInputs {
  safeWithdrawalRatePercent:number; stockAllocationPercent:number; expectedReturnPercent:number;
  inflationPercent:number; currentAge:number; retirementAge:number; simulations:number;
}
const defaultFireInputs:FireInputs={safeWithdrawalRatePercent:4,stockAllocationPercent:70,expectedReturnPercent:7,inflationPercent:3,currentAge:35,retirementAge:60,simulations:1000};
let fireInputs:FireInputs={...defaultFireInputs};
try{
  const stored=JSON.parse(localStorage.getItem("finance-tracker-fire-inputs")??"null");
  if(stored&&typeof stored==="object"){
    const candidate={...defaultFireInputs,...stored} as FireInputs;
    if(Object.values(candidate).every(value=>typeof value==="number"&&Number.isFinite(value))) fireInputs=candidate;
  }
}catch{}

type TxFilterState = {
  from:string, to:string, accounts:string[], categories:string[], kinds:string[], search:string,
  include_deleted:boolean, limit:number, sort_by:string, sort_dir:string
};
let txFilters:TxFilterState = {from:"",to:"",accounts:[],categories:[],kinds:[],search:"",include_deleted:false,limit:100,sort_by:"date",sort_dir:"desc"};

interface NavigationState {
  view: View;
  selectedAccountId: number | null;
  selectedPayee:string|null;
  selectedLoanId: number | null;
  selectedRecurringRuleId: number | null;
  selectedInvestmentAccountId: number | null;
  reconciliationSelectedAccount: string;
  planningTab: "scenarios" | "items" | "goals";
  dashboardAccountRef: string;
  txFilters: TxFilterState;
}

const historyStack: NavigationState[] = [];
const isMac = typeof navigator !== "undefined" &&
  (/Mac|iP(hone|od|ad)/i.test(navigator.platform || "") || /Mac/i.test(navigator.userAgent || ""));

function getBackShortcutHint(): string {
  return isMac ? "⌘[ or ⌘←" : "Alt+←";
}

function getCurrentNavigationState(): NavigationState {
  return {
    view,
    selectedAccountId,
    selectedPayee,
    selectedLoanId,
    selectedRecurringRuleId,
    selectedInvestmentAccountId,
    reconciliationSelectedAccount,
    planningTab,
    dashboardAccountRef,
    txFilters: {
      ...txFilters,
      accounts: [...txFilters.accounts],
      categories: [...txFilters.categories],
      kinds: [...txFilters.kinds],
    },
  };
}

function areStatesEqual(a: NavigationState, b: NavigationState): boolean {
  if (a.view !== b.view) return false;
  if (a.view === "accounts" && a.selectedAccountId !== b.selectedAccountId) return false;
  if (a.view === "payees" && a.selectedPayee !== b.selectedPayee) return false;
  if (a.view === "recurring" && a.selectedRecurringRuleId !== b.selectedRecurringRuleId) return false;
  if (a.view === "loans" && a.selectedLoanId !== b.selectedLoanId) return false;
  if (a.view === "investments" && a.selectedInvestmentAccountId !== b.selectedInvestmentAccountId) return false;
  if (a.view === "planning" && a.planningTab !== b.planningTab) return false;
  if (a.view === "reconciliation" && a.reconciliationSelectedAccount !== b.reconciliationSelectedAccount) return false;
  if (a.view === "dashboard" && a.dashboardAccountRef !== b.dashboardAccountRef) return false;
  if (a.view === "transactions") {
    if (JSON.stringify(a.txFilters) !== JSON.stringify(b.txFilters)) return false;
  }
  return true;
}

function pushNavigationState() {
  const current = getCurrentNavigationState();
  if (historyStack.length > 0 && areStatesEqual(historyStack[historyStack.length - 1], current)) {
    return;
  }
  historyStack.push(current);
  if (historyStack.length > 50) {
    historyStack.shift();
  }
}

function navigateTo(updater: () => void) {
  const currentState = getCurrentNavigationState();
  updater();
  const nextState = getCurrentNavigationState();
  if (!areStatesEqual(currentState, nextState)) {
    historyStack.push(currentState);
    if (historyStack.length > 50) {
      historyStack.shift();
    }
  }
  render();
}

function openPayee(name:string){
  if(!name.trim()) return;
  navigateTo(()=>{selectedPayee=name.trim();view="payees";});
}

function openPayeeLedger(name:string){
  navigateTo(()=>{
    txFilters={from:"",to:"",accounts:[],categories:[],kinds:[],search:name,
      include_deleted:false,limit:100,sort_by:"date",sort_dir:"desc"};
    view="transactions";
  });
}

function getHistoryEntryLabel(entry: NavigationState): string {
  switch (entry.view) {
    case "dashboard": return "Dashboard";
    case "accounts": {
      if (entry.selectedAccountId) {
        const acc = accounts.find(a => a.id === entry.selectedAccountId);
        if (acc) return `Account: ${acc.name}`;
      }
      return "Accounts";
    }
    case "payees": return entry.selectedPayee?`Payee: ${entry.selectedPayee}`:"Payees";
    case "transactions": return "Transactions";
    case "rules": return "Transaction rules";
    case "categories": return "Categories";
    case "import": return "Import";
    case "budgets": return "Budgets";
    case "recurring": return "Recurring";
    case "planning": {
      if (entry.planningTab === "goals") return "Goals";
      if (entry.planningTab === "items") return "Planned items";
      return "Planning";
    }
    case "forecast": return "Forecast";
    case "fire": return "FIRE simulator";
    case "audit": return "Financial audit";
    case "reconciliation": return "Reconcile";
    case "loans": return "Loans & EMIs";
    case "debt": return "Debt payoff";
    case "networth": return "Assets & liabilities";
    case "investments": return "Investment accounts";
    case "tax": return "Tax center";
    case "comparisons": return "Comparisons";
    case "reports": return "PDF Reports";
    case "notifications": return "Notifications";
    case "settings": return "Settings";
    default: return "previous page";
  }
}

function updateTopbarBackButton() {
  const topbarLeft = document.querySelector(".topbar-left");
  if (!topbarLeft) return;
  let backBtn = topbarLeft.querySelector<HTMLButtonElement>("#btn-topbar-back");
  const canGoBack = historyStack.length > 0;
  if (canGoBack) {
    const prevEntry = historyStack[historyStack.length - 1];
    const backTargetLabel = getHistoryEntryLabel(prevEntry);
    const backShortcutHint = getBackShortcutHint();
    const backTitle = `Back to ${backTargetLabel} (${backShortcutHint})`;
    const backAriaLabel = `Back to ${backTargetLabel}`;

    if (!backBtn) {
      backBtn = document.createElement("button");
      backBtn.className = "topbar-back-btn";
      backBtn.id = "btn-topbar-back";
      backBtn.type = "button";
      backBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5M12 19l-7-7 7-7"/>
        </svg>`;
      backBtn.addEventListener("click", () => {
        goBack();
      });
      topbarLeft.insertBefore(backBtn, topbarLeft.firstChild);
    }
    backBtn.title = backTitle;
    backBtn.setAttribute("aria-label", backAriaLabel);
  } else {
    if (backBtn) {
      backBtn.remove();
    }
  }
}

function goBack(): boolean {
  if(activeDataOperationId !== null || restoreReloadRequired || dataOperationInteractionLocked) return false;
  if (historyStack.length === 0) return false;
  const modalRoot = document.getElementById("modal-root");
  if (modalRoot && modalRoot.innerHTML.trim() !== "") {
    modalRoot.innerHTML = "";
  }
  const prevState = historyStack.pop()!;
  view = prevState.view;
  selectedAccountId = prevState.selectedAccountId;
  selectedPayee = prevState.selectedPayee;
  selectedLoanId = prevState.selectedLoanId;
  selectedRecurringRuleId = prevState.selectedRecurringRuleId;
  selectedInvestmentAccountId = prevState.selectedInvestmentAccountId;
  reconciliationSelectedAccount = prevState.reconciliationSelectedAccount;
  planningTab = prevState.planningTab;
  dashboardAccountRef = prevState.dashboardAccountRef;
  txFilters = {
    ...prevState.txFilters,
    accounts: [...prevState.txFilters.accounts],
    categories: [...prevState.txFilters.categories],
    kinds: [...prevState.txFilters.kinds],
  };
  render();
  return true;
}

function isEditingTextInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "textarea" || target.isContentEditable) return true;
  if (tag === "input") {
    const type = (target as HTMLInputElement).type.toLowerCase();
    return ["text", "search", "password", "email", "url", "number", "tel", "date", "month", "datetime-local"].includes(type);
  }
  return false;
}

function initNavigationShortcuts() {
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    const inTextInput = isEditingTextInput(e.target);

    // macOS: Cmd + [
    const macBracket = isMac && e.metaKey && e.key === "[";
    // macOS: Cmd + Left Arrow (when not editing text, so text caret navigation to line start is preserved)
    const macArrow = isMac && !inTextInput && e.metaKey && e.key === "ArrowLeft";
    // Windows / Linux: Alt + Left Arrow
    const winArrow = !isMac && e.altKey && e.key === "ArrowLeft";
    // Generic fallback: Alt + Left Arrow or Cmd + [
    const genericBack = (!inTextInput && e.altKey && e.key === "ArrowLeft") || (e.metaKey && e.key === "[");
    // Hardware BrowserBack multimedia key
    const browserBackKey = e.key === "BrowserBack";

    if (macBracket || macArrow || winArrow || genericBack || browserBackKey) {
      if (historyStack.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        goBack();
      }
    }
  }, { capture: true });

  const handleMouseBack = (e: MouseEvent) => {
    if (e.button === 3) {
      if (historyStack.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        goBack();
      }
    }
  };
  window.addEventListener("mouseup", handleMouseBack);
  window.addEventListener("auxclick", handleMouseBack);
}

const $ = (s:string)=>document.querySelector(s) as HTMLElement;
const $$ = (s:string)=>Array.from(document.querySelectorAll(s));

function toast(msg:string, err=false, action?:{label:string; run:()=>void|Promise<void>}){
  let stack = document.getElementById("toast-stack");
  if(!stack){
    document.body.insertAdjacentHTML("beforeend",'<div id="toast-stack" class="toast-stack"></div>');
    stack=document.getElementById("toast-stack");
  }
  const t=document.createElement("div");
  t.className=`toast ${err?"err":"ok"}`;
  t.textContent=msg;
  if(action){
    const button=document.createElement("button");
    button.className="toast-action";
    button.textContent=action.label;
    button.addEventListener("click",()=>{ void action.run(); t.remove(); });
    t.appendChild(button);
  }
  stack?.appendChild(t);
  setTimeout(()=>t.remove(),3200);
}

function syncInterfaceScaleControls(){
  const currentIndex=INTERFACE_SCALE_LEVELS.indexOf(interfaceScale as typeof INTERFACE_SCALE_LEVELS[number]);
  const value=document.querySelector<HTMLOutputElement>("#interface-scale-value");
  const decrease=document.querySelector<HTMLButtonElement>("#interface-scale-decrease");
  const increase=document.querySelector<HTMLButtonElement>("#interface-scale-increase");
  const reset=document.querySelector<HTMLButtonElement>("#interface-scale-reset");
  if(value) value.textContent=`${Math.round(interfaceScale*100)}%`;
  if(decrease) decrease.disabled=currentIndex<=0;
  if(increase) increase.disabled=currentIndex>=INTERFACE_SCALE_LEVELS.length-1;
  if(reset) reset.disabled=interfaceScale===DEFAULT_INTERFACE_SCALE;
}

async function setInterfaceScale(scale:number,announce=true){
  if(!INTERFACE_SCALE_LEVELS.includes(scale as typeof INTERFACE_SCALE_LEVELS[number])) return;
  try{
    await appWebview.setZoom(scale);
    interfaceScale=scale;
    localStorage.setItem("finance-tracker-interface-scale",String(scale));
    syncInterfaceScaleControls();
    if(announce) toast(`Interface scale set to ${Math.round(scale*100)}%`);
  }catch(error:any){
    if(announce) toast(`Could not change interface scale: ${String(error)}`,true);
  }
}

async function stepInterfaceScale(direction:-1|1){
  const currentIndex=INTERFACE_SCALE_LEVELS.indexOf(interfaceScale as typeof INTERFACE_SCALE_LEVELS[number]);
  const nextIndex=Math.max(0,Math.min(INTERFACE_SCALE_LEVELS.length-1,currentIndex+direction));
  if(nextIndex===currentIndex) return;
  await setInterfaceScale(INTERFACE_SCALE_LEVELS[nextIndex]);
}

const currencyCodes=["AUD","BRL","CAD","CHF","CNY","CZK","DKK","EUR","GBP","HKD","HUF","IDR","ILS","INR","ISK","JPY","KRW","MXN","MYR","NOK","NZD","PHP","PLN","RON","SEK","SGD","THB","TRY","USD","ZAR"];
function currencyOptions(selected:string){ const codes=currencyCodes.includes(selected)?currencyCodes:[selected,...currencyCodes]; return codes.map(code=>`<option value="${code}" ${code===selected?"selected":""}>${code}</option>`).join(""); }
function parentDirectory(path:string){
  const normalized=path.trim();
  const separator=Math.max(normalized.lastIndexOf("/"),normalized.lastIndexOf("\\"));
  if(separator<0) return normalized;
  if(separator===0) return normalized.slice(0,1);
  if(separator===2 && /^[A-Za-z]:[\\/]/.test(normalized)) return normalized.slice(0,3);
  return normalized.slice(0,separator);
}
function centsFmt(c:number, currencyCode=currency){
  const sign=c<0?"-":"";
  const a=Math.abs(Math.round(c));
  const units=Math.floor(a/100), cents=a%100;
  // simple symbol mapping
  const sym:Record<string,string>={USD:"$",EUR:"€",GBP:"£",INR:"₹",JPY:"¥",AUD:"A$",CAD:"C$",CHF:"CHF ",CNY:"CN¥",KRW:"₩",THB:"฿"};
  const s=sym[currencyCode]??currencyCode+" ";
  return `${sign}${s}${units.toLocaleString()}.${String(cents).padStart(2,"0")}`;
}
function todayISO():string{ return daysAgoISO(0); }
function daysAgoISO(days:number):string{
  const d = new Date();
  d.setDate(d.getDate() - days);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function monthKey(d=new Date()){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; }
function esc(s:any){ return String(s??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }

async function refreshCore(){
  try{ currency = await invoke<string>("get_currency"); }catch{}
  try{ const settings=await invoke<FxSettings>("get_fx_settings"); fxDefaultSource=settings.default_source; }catch{}
  try{ dbPath = await invoke<string>("get_db_path"); }catch{}
  try{ needsInit = await invoke<boolean>("needs_init"); }catch{ needsInit=false; }
  if(needsInit){ startNotifications(""); renderInit(); return; }
  try{ accounts = await invoke<Account[]>("list_accounts"); }catch{accounts=[]}
  try{ categories = await invoke<Category[]>("list_categories"); }catch{categories=[]}
  try{ balances = await invoke<BalanceRecord[]>("get_balances",{account:null}); }catch{balances=[]}
  try{ recentTx = await invoke<TransactionRecord[]>("recent_transactions",{limit:8}); }catch{recentTx=[]}
  try{ presets = await invoke<ImportPresetSummary[]>("list_import_presets"); }catch{presets=[]}
  render();
  startNotifications(dbPath);
}

// ---------- Render shell ----------
function renderInit(){
  const app=document.getElementById("app")!;
  const dataDirectory=parentDirectory(dbPath)||"—";
  app.innerHTML=`
    <div class="app">
      ${titlebarHtml()}
    <div class="init-wrap">
      <div class="card init-card">
        <h2 style="font-size:20px;font-weight:800;margin-bottom:6px">Welcome to Finance Tracker</h2>
        <p class="muted small" style="margin-bottom:16px">Local-first. 100% privacy. Your data stays on your computer only.</p>
        <div class="muted small" style="margin-bottom:10px;word-break:break-all">Your local data location: ${esc(dataDirectory)}</div>
        <div class="field"><label for="init-currency">Choose a currency to initialize your database.</label><select id="init-currency">${currencyOptions(currency)}</select></div>
        <div style="display:flex;gap:10px">
          <button class="btn btn-primary" id="init-btn" style="flex:1">Initialize</button>
          <button class="btn" id="pick-db">Change location</button>
        </div>
      </div>
    </div>
    </div>
    <div id="toast-stack" class="toast-stack"></div>`;
  bindTitlebar(app, message => toast(message, true));
  app.querySelector("#init-btn")!.addEventListener("click", async()=>{
    const cur=(app.querySelector("#init-currency") as HTMLSelectElement).value;
    try{ await invoke("init_db",{currency:cur}); toast("Database initialized"); await refreshCore(); }catch(e:any){ toast(String(e),true); }
  });
  app.querySelector("#pick-db")!.addEventListener("click", async()=>{
    const sel=await open({filters:[{name:"SQLite",extensions:["db","sqlite","sqlite3"]}]});
    if(typeof sel==="string"){
      await invoke("set_db_path",{path:sel});
      await refreshCore();
    }
  });
}

function navIcon(name:string){
  const icons:Record<string,string>={
    dashboard:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>`,
    accounts:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/><circle cx="16" cy="12" r="1.5"/></svg>`,
    transactions:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 6h8"/><path d="M8 12h8"/><path d="M8 18h8"/></svg>`,
    categories:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l7 4v8l-7 4-7-4V7z"/><path d="M12 11a2 2 0 100 4 2 2 0 000-4z"/></svg>`,
    import:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 16V3"/><path d="M8 12l4 4 4-4"/><path d="M3 18v2a1 1 0 001 1h16a1 1 0 001-1v-2"/></svg>`,
    budgets:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 10h18"/><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 14h8"/></svg>`,
    recurring:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 11-2.6-6.4"/><path d="M21 3v7h-7"/><path d="M12 7v6l4 2"/></svg>`,
    planning:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 6h8"/><path d="M8 12h8"/><path d="M8 18h8"/><path d="M3 6h2M3 12h2M3 18h2"/></svg>`,
    forecast:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 18l6-6 4 4 6-8"/><path d="M14 8h5V3"/></svg>`,
    fire:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22c4-2 7-5.4 7-9.2 0-2.7-1.5-5.2-4-7.3.1 2-1 3.8-2.5 4.8.1-3.1-1.5-6.1-4.4-8.3.1 3.8-3.1 6-3.1 10.6C5 17 8 20.4 12 22z"/><path d="M12 22c-1.7-1.2-2.5-2.7-2.5-4.4 0-1.5.8-2.8 2.3-4 .1 1.3.7 2.2 1.7 3 .6.5 1 1.3 1 2.1 0 1.4-.8 2.5-2.5 3.3z"/></svg>`,
    audit:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l8 3v5c0 5-3.4 8.7-8 10-4.6-1.3-8-5-8-10V6z"/><path d="M8 12l2.5 2.5L16 9"/></svg>`,
    reconciliation:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>`,
    tags:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 13l-7 7-10-10V3h7z"/><circle cx="7.5" cy="7.5" r="1"/></svg>`,
    loans:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M8 15h3"/></svg>`,
    networth:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19V9m5 10V5m5 14v-7m5 7V3"/></svg>`,
    investments:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 18l5-6 4 3 7-9"/><path d="M16 6h4v4"/></svg>`,
    search:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>`,
    comparisons:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19V9m8 10V5m8 14v-7"/><path d="M2 19h20"/></svg>`,
    reports:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>`,
    settings:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>`,
    notifications:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 00-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>`,
    backup:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/><circle cx="12" cy="16" r="1"/></svg>`,
  };
  return icons[name]??"";
}

function render(){
  dashboardRenderVersion++;
  dashboardKeyAbort?.abort();
  dashboardKeyAbort=null;
  if(view!=="transactions"){
    txFilterDocumentAbort?.abort();
    txFilterDocumentAbort=null;
  }
  const app=document.getElementById("app")!;
  const totalCents = balances.reduce((s,b)=>s+b.current_balance_cents,0);
  const canGoBack = historyStack.length > 0;
  const prevEntry = canGoBack ? historyStack[historyStack.length - 1] : null;
  const backTargetLabel = prevEntry ? getHistoryEntryLabel(prevEntry) : "";
  const backShortcutHint = getBackShortcutHint();
  const backTitle = prevEntry ? `Back to ${backTargetLabel} (${backShortcutHint})` : `Back (${backShortcutHint})`;
  const backAriaLabel = prevEntry ? `Back to ${backTargetLabel}` : "Back";
  const nav = (id:View,label:string,icon:string)=>`<button class="nav-item ${view===id?"active":""}" data-view="${id}">${navIcon(icon)}<span>${label}</span></button>`;
  app.innerHTML=`
  <div class="app">
    ${titlebarHtml()}
    <div class="topbar">
      <div class="topbar-left">
        <button class="topbar-back-btn menu-toggle" id="btn-menu" type="button" aria-label="Open navigation" aria-controls="app-sidebar" aria-expanded="false" title="Open navigation">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
        </button>
        ${canGoBack ? `
          <button class="topbar-back-btn" id="btn-topbar-back" type="button" title="${esc(backTitle)}" aria-label="${esc(backAriaLabel)}">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
          </button>
        ` : ""}
        <h1><i>₿</i> Finance Tracker <span class="topbar-publisher">| GoodApps (hello@goodapps.store)</span> <span class="pill">${esc(currency)} · ${balances.length} accounts</span></h1>
      </div>
      <div class="topbar-actions">
        <span class="pill" title="${esc(dbPath)}">${esc(dbPath.split("/").slice(-2).join("/"))}</span>
        <button class="btn btn-sm" id="btn-new-tx">+ Transaction</button>
        ${view==="notifications"?"":`<button class="btn btn-sm btn-primary" id="btn-export" title="Export current page view as PDF">Export as PDF</button>`}
      </div>
    </div>
    <div class="layout">
      <button class="sidebar-backdrop" type="button" aria-label="Close navigation" tabindex="-1"></button>
      <aside class="sidebar" id="app-sidebar" aria-label="Main navigation">
        <nav>
          ${nav("dashboard","Dashboard","dashboard")}
          ${nav("accounts","Accounts","accounts")}
          ${nav("payees","Payees","accounts")}
          ${nav("transactions","Transactions","transactions")}
          ${nav("rules","Transaction rules","recurring")}
          ${nav("categories","Categories","categories")}
          ${nav("import","Import","import")}
          <div class="nav-label">Planning</div>
          ${nav("budgets","Budgets","budgets")}
          ${nav("recurring","Recurring","recurring")}
          ${nav("planning","Scenarios & Plans","planning")}
          ${nav("forecast","Forecast","forecast")}
          ${nav("fire","FIRE & milestones","fire")}
          ${nav("reconciliation","Reconcile","reconciliation")}
          <div class="nav-label">Organize</div>
          ${nav("loans","Loans & EMIs","loans")}
          ${nav("debt","Debt payoff","forecast")}
          ${nav("networth","Assets & liabilities","networth")}
          ${nav("investments","Investment accounts","investments")}
          ${nav("tax","Tax center","reports")}
          ${nav("comparisons","Comparisons","comparisons")}
          ${nav("audit","Financial audit","audit")}
          <div class="nav-label">Statements</div>
          ${nav("reports","PDF Reports","reports")}
          <div style="flex:1"></div>
          ${nav("notifications","Notifications","notifications")}
          ${nav("settings","Settings","settings")}
          <button class="nav-item" id="btn-backup-restore">${navIcon("backup")}<span>Backup &amp; Restore</span></button>
        </nav>
      </aside>
      <main class="main" id="main"></main>
    </div>
  </div>
  <div id="modal-root"></div>
  <div id="toast-stack" class="toast-stack"></div>`;

  bindTitlebar(app, message => toast(message, true));
  bindNavigationDrawer(app);
  app.querySelector("#btn-topbar-back")?.addEventListener("click", () => {
    goBack();
  });

  // bind nav
  app.querySelectorAll("[data-view]").forEach(el=>el.addEventListener("click",()=>{
    const targetView = (el as HTMLElement).dataset.view as View;
    if(view === targetView) return;
    navigateTo(()=>{
      view = targetView;
    });
  }));
  app.querySelector("#btn-backup-restore")?.addEventListener("click", openBackupRestoreModal);
  app.querySelector("#btn-new-tx")!.addEventListener("click",()=>openTxnModal());
  app.querySelector("#btn-export")?.addEventListener("click",()=>doExport());
  // total already computed
  renderView(totalCents);
}

function renderView(totalCents:number){
  const main=$("#main")!;
  main.dataset.view=view;
  main.classList.toggle("reconciliation-page",view==="reconciliation");
  switch(view){
    case "dashboard": renderDashboard(main,totalCents); break;
    case "accounts": renderAccounts(main); break;
    case "payees": void renderPayees(main,{selected:selectedPayee,currency,format:centsFmt,escape:esc,
      select:name=>navigateTo(()=>{selectedPayee=name;view="payees";}),openLedger:openPayeeLedger}); break;
    case "transactions": renderTransactions(main); break;
    case "rules": renderRules(main); break;
    case "categories": renderCategories(main); break;
    case "import": renderImport(main); break;
    case "budgets": renderBudgets(main); break;
    case "recurring": renderRecurring(main); break;
    case "planning": renderPlanning(main); break;
    case "forecast": renderForecast(main); break;
    case "fire": renderFire(main); break;
    case "audit": renderFinancialAudit(main); break;
    case "reconciliation": renderReconciliation(main); break;
    case "loans": renderLoans(main); break;
    case "debt": renderDebtOptimizer(main); break;
    case "networth": renderNetWorth(main); break;
    case "investments": renderInvestmentPortfolios(main); break;
    case "tax": renderTaxCenter(main); break;
    case "comparisons": renderComparisons(main); break;
    case "reports": renderReportsPage(main, accounts, currency, toast); break;
    case "notifications": void renderNotifications(main, esc); break;
    case "settings": renderSettings(main); break;
  }
}

// ---------- Helpers ----------
async function doExport(){
  await exportCurrentPagePdf({
    view,
    currency,
    dbPath,
    accounts,
    categories,
    balances,
    txFilters,
    selectedAccountId,
    selectedPayee,
    selectedLoanId,
    selectedRecurringRuleId,
    selectedInvestmentAccountId,
    reconciliationSelectedAccount,
    planningTab,
    dashboardAccountRef,
    dashboardMonths,
    toast,
  });
}

// ---------- Dashboard ----------
function chartEmpty(message:string){
  return `<div class="chart-empty">${esc(message)}</div>`;
}

function dashboardDelta(current:number, previous:number, positiveIsGood:boolean){
  const change=current-previous;
  if(change===0) return `<span class="dashboard-delta neutral">↔ No change vs last month</span>`;
  const direction=change>0?"↑":"↓";
  const percent=previous===0 ? null : Math.abs(change/previous*100);
  const detail=percent===null ? "New vs last month" : `${percent.toFixed(percent>=10?0:1)}% vs last month`;
  const good=(change>0)===positiveIsGood;
  return `<span class="dashboard-delta ${good?"good":"bad"}">${direction} ${detail}</span>`;
}

function dashboardMonthRange(month:string){
  const [year, monthNumber]=month.split("-").map(Number);
  const lastDay=new Date(year,monthNumber,0).getDate();
  return {from:`${year}-${String(monthNumber).padStart(2,"0")}-01`,to:`${year}-${String(monthNumber).padStart(2,"0")}-${String(lastDay).padStart(2,"0")}`};
}

function dashboardWeekday(date:string){
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined,{weekday:"short"});
}

function cashflowChart(points:MonthlyCashFlowPoint[]){
  if(!points.length) return chartEmpty("No cash-flow data for this period.");

  const width=420, height=210, top=16, bottom=158, left=12, right=12;
  const maxAbs=Math.max(...points.map(p=>Math.abs(p.net_cents)), 1);
  const zeroY=Math.round(top+(bottom-top)/2);
  const step=(width-left-right)/points.length;
  const barWidth=Math.max(10, Math.min(38, step*0.56));
  const bars=points.map((point,index)=>{
    const magnitude=Math.max(2, Math.round(Math.abs(point.net_cents)/maxAbs*((bottom-top)/2-8)));
    const x=Math.round(left+index*step+(step-barWidth)/2);
    const y=point.net_cents>=0 ? zeroY-magnitude : zeroY;
    const label=esc(point.month.slice(5));
    const tooltip=`${point.month} · Net ${centsFmt(point.net_cents)} · Income ${centsFmt(point.income_cents)} · Expenses ${centsFmt(point.expense_cents)}`;
    return `<g class="dashboard-chart-bar ${point.net_cents>=0?"positive":"negative"}" data-dashboard-month="${esc(point.month)}" data-dashboard-tooltip="${esc(tooltip)}" role="button" tabindex="0" aria-label="Open transactions for ${esc(point.month)}">
      <rect x="${x}" y="${y}" width="${barWidth}" height="${magnitude}" rx="4"/>
      <text x="${Math.round(x+barWidth/2)}" y="${bottom+24}" text-anchor="middle">${label}</text>
    </g>`;
  }).join("");
  return `<div class="dashboard-chart">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly net cash flow for the last ${points.length} months" preserveAspectRatio="none">
      <line class="dashboard-chart-grid" x1="${left}" x2="${width-right}" y1="${top}" y2="${top}"/>
      <line class="dashboard-chart-zero" x1="${left}" x2="${width-right}" y1="${zeroY}" y2="${zeroY}"/>
      <line class="dashboard-chart-grid" x1="${left}" x2="${width-right}" y1="${bottom}" y2="${bottom}"/>
      ${bars}
    </svg>
    <div class="chart-legend"><span><i class="positive"></i>Positive</span><span><i class="negative"></i>Negative</span></div>
  </div>`;
}

function balanceTrendChart(points:BalanceTrendPoint[], label="Balance", moneyFmt:(value:number)=>string=centsFmt){
  if(!points.length) return chartEmpty("No balance history for this period.");

  const width=420, height=210, top=16, bottom=154, left=16, right=16;
  const values=points.map(p=>p.balance_cents);
  const rawMin=Math.min(...values), rawMax=Math.max(...values);
  const padding=Math.max(Math.round((rawMax-rawMin)*0.1), 1);
  const min=rawMin-padding, max=rawMax+padding;
  const xFor=(index:number)=>points.length===1 ? Math.round((left+width-right)/2) : Math.round(left+index*(width-left-right)/(points.length-1));
  const yFor=(value:number)=>Math.round(bottom-(value-min)/(max-min)*(bottom-top));
  const coords=points.map((point,index)=>`${xFor(index)},${yFor(point.balance_cents)}`);
  const line=coords.join(" ");
  const area=`${left},${bottom} ${line} ${width-right},${bottom}`;
  const labels=points.map((point,index)=>`<text x="${xFor(index)}" y="${bottom+26}" text-anchor="middle">${esc(point.month.slice(5))}</text>`).join("");
  const dots=points.map((point,index)=>{const tooltip=`${point.month} · ${label} ${moneyFmt(point.balance_cents)}`;return `<g class="dashboard-chart-dot" data-dashboard-tooltip="${esc(tooltip)}" tabindex="0"><title>${esc(tooltip)}</title><circle cx="${xFor(index)}" cy="${yFor(point.balance_cents)}" r="4"/></g>`;}).join("");
  return `<div class="dashboard-chart">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)} trend" preserveAspectRatio="none">
      <line class="dashboard-chart-grid" x1="${left}" x2="${width-right}" y1="${top}" y2="${top}"/>
      <line class="dashboard-chart-grid" x1="${left}" x2="${width-right}" y1="${Math.round((top+bottom)/2)}" y2="${Math.round((top+bottom)/2)}"/>
      <line class="dashboard-chart-grid" x1="${left}" x2="${width-right}" y1="${bottom}" y2="${bottom}"/>
      <polygon class="dashboard-chart-area" points="${area}"/>
      <polyline class="dashboard-chart-line" points="${line}"/>
      ${dots}
      ${labels}
    </svg>
  </div>`;
}

function netWorthSparkline(points:BalanceTrendPoint[]){
  if(!points.length) return "";
  const width=250, height=72, pad=6;
  const values=points.map(point=>point.balance_cents);
  const min=Math.min(...values), max=Math.max(...values), range=max-min||1;
  const xFor=(index:number)=>points.length===1?width/2:pad+index*(width-pad*2)/(points.length-1);
  const yFor=(value:number)=>height-pad-(value-min)/range*(height-pad*2);
  const line=points.map((point,index)=>`${xFor(index).toFixed(1)},${yFor(point.balance_cents).toFixed(1)}`).join(" ");
  const dots=points.map((point,index)=>`<circle class="dashboard-sparkline-dot" cx="${xFor(index).toFixed(1)}" cy="${yFor(point.balance_cents).toFixed(1)}" r="3" data-dashboard-tooltip="${esc(`${point.month} · Net worth ${centsFmt(point.balance_cents)}`)}" tabindex="0"/>`).join("");
  return `<div class="dashboard-sparkline-wrap"><svg class="dashboard-sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="Twelve-month net worth trend"><polyline points="${line}"/>${dots}</svg><span>12-month trend</span></div>`;
}

function dashboardBudgetGauges(statuses:BudgetStatusRecord[]){
  const gauges=statuses
    .filter(status=>status.budget_cents>0||status.over_budget)
    .sort((left,right)=>right.spent_cents/right.budget_cents-left.spent_cents/left.budget_cents)
    .slice(0,3);
  if(!gauges.length) return `<div class="small muted">Add a budget to see your closest limits here.</div>`;
  return `<div class="dashboard-budget-list">${gauges.map(status=>{
    const ratio=status.budget_cents>0?status.spent_cents/status.budget_cents:1;
    const pct=Math.min(100,Math.max(0,Math.round(ratio*100)));
    const tone=status.over_budget?"over":ratio>=.8?"warn":"ok";
    const remaining=status.remaining_cents>=0?`${centsFmt(status.remaining_cents)} left`:`${centsFmt(Math.abs(status.remaining_cents))} over`;
    return `<button class="dashboard-budget-gauge" type="button" data-dashboard-nav="budgets" aria-label="Open budgets">
      <span><strong>${esc(status.category_name)}</strong><small>${centsFmt(status.spent_cents)} of ${centsFmt(status.budget_cents)}</small></span>
      <span class="dashboard-budget-remaining ${status.remaining_cents<0?"over":""}">${remaining}</span>
      <span class="progress"><span class="progress-fill ${tone}" style="width:${pct}%"></span></span>
    </button>`;
  }).join("")}</div>`;
}

function dashboardAlertStrip(snapshot:DashboardSnapshot){
  const bills=snapshot.forecast.bill_calendar.slice(0,2);
  const atRisk=snapshot.forecast.goal_status.filter(goal=>!goal.on_track);
  const alerts=[
    ...bills.map(bill=>`<button class="dashboard-alert-item" type="button" data-forecast-bill-source="${esc(bill.source)}" data-forecast-bill-id="${bill.source_id??""}">⚡ <strong>${esc(bill.title)}</strong> due ${esc(dashboardWeekday(bill.date))} (${centsFmt(bill.amount_cents, accounts.find(a=>a.id===bill.account_id)?.currency_code ?? currency)})</button>`),
    ...snapshot.forecast.alerts.slice(0,1).map(alert=>`<button class="dashboard-alert-item warning" type="button" data-dashboard-nav="forecast">⚠ ${esc(alert)}</button>`),
    ...atRisk.slice(0,1).map(goal=>`<button class="dashboard-alert-item warning" type="button" data-open-goal="${goal.id}">⚠ ${esc(goal.name)} ${goal.breach_date?`breaches on ${esc(goal.breach_date)}`:"is at risk"}</button>`),
    ...(snapshot.recurring_due.length?[`<button class="dashboard-alert-item" type="button" data-open-recurring="${snapshot.recurring_due[0].id}">↻ ${snapshot.recurring_due.length} recurring item${snapshot.recurring_due.length===1?"":"s"} due in 30 days</button>`]:[]),
  ];
  return `<div class="dashboard-alert-strip" aria-label="Next 30 days">${alerts.join("<span class=\"dashboard-alert-separator\">·</span>")||`<span class="dashboard-alert-clear">✓ No bills, goal breaches, or recurring items due in the next 30 days.</span>`}</div>`;
}

function openDashboardTransactions(month:string, category?:string){
  const range=dashboardMonthRange(month);
  navigateTo(()=>{
    txFilters={from:range.from,to:range.to,accounts:dashboardAccountRef?[dashboardAccountRef]:[],categories:category?[category]:[],kinds:[],search:"",include_deleted:false,limit:100,sort_by:"date",sort_dir:"desc"};
    view="transactions";
  });
}

function openRecurringRule(ruleId:number){
  navigateTo(()=>{
    selectedRecurringRuleId=ruleId;
    view="recurring";
  });
}

async function openPlanningItem(itemId:number){
  try{
    const items=await invoke<PlanningItemRecord[]>("list_planning_items",{scenario:null, from:null, to:null});
    const item=items.find(candidate=>candidate.id===itemId);
    if(!item){ toast("This planned item is no longer available",true); return; }
    navigateTo(()=>{
      planningTab="items";
      view="planning";
    });
    openPlanningItemModal(item);
  }catch(error:any){ toast(String(error),true); }
}

async function openGoal(goalId:number){
  try{
    const goals=await invoke<PlanningGoalRecord[]>("list_goals");
    const goal=goals.find(candidate=>candidate.id===goalId);
    if(!goal){ toast("This goal is no longer available",true); return; }
    navigateTo(()=>{
      planningTab="goals";
      view="planning";
    });
    openGoalModal(goal);
  }catch(error:any){ toast(String(error),true); }
}

function openForecastBill(source:string, sourceId:number|null){
  if(sourceId===null){ toast("This forecast item has no editable source",true); return; }
  if(source==="recurring") openRecurringRule(sourceId);
  else void openPlanningItem(sourceId);
}

function bindDashboardChartTooltips(main:HTMLElement){
  const tooltip=main.querySelector<HTMLElement>("#dashboard-tooltip")!;
  const show=(element:HTMLElement,event:MouseEvent|FocusEvent)=>{
    tooltip.textContent=element.dataset.dashboardTooltip??"";
    tooltip.hidden=false;
    if(event instanceof MouseEvent) move(event);
    else {
      const rect=element.getBoundingClientRect();
      position(rect.left+rect.width/2,rect.top);
    }
  };
  const position=(x:number,y:number)=>{
    const tooltipWidth=tooltip.offsetWidth||220;
    tooltip.style.left=`${Math.min(x+12,window.innerWidth-tooltipWidth-10)}px`;
    tooltip.style.top=`${Math.max(10,y-38)}px`;
  };
  const move=(event:MouseEvent)=>position(event.clientX,event.clientY);
  main.querySelectorAll<HTMLElement>("[data-dashboard-tooltip]").forEach(element=>{
    element.addEventListener("mouseenter",event=>show(element,event));
    element.addEventListener("mousemove",move);
    element.addEventListener("mouseleave",()=>{tooltip.hidden=true;});
    element.addEventListener("focus",event=>show(element,event));
    element.addEventListener("blur",()=>{tooltip.hidden=true;});
  });
}

async function renderDashboard(main:HTMLElement, totalCents:number){
  const renderVersion=++dashboardRenderVersion;
  dashboardKeyAbort?.abort();
  dashboardKeyAbort=null;
  let snapshot:DashboardSnapshot;
  try{
    snapshot=await invoke<DashboardSnapshot>("dashboard_snapshot",{account:dashboardAccountRef||null,months:dashboardMonths});
  }catch(error:any){
    if(renderVersion!==dashboardRenderVersion || view!=="dashboard") return;
    console.error("Unable to load dashboard snapshot",error);
    main.innerHTML=`<div class="page-head"><h2>Dashboard</h2><p>Your money at a glance — local, private, offline-first.</p></div><div class="card dashboard-load-error"><strong>Dashboard data could not be loaded.</strong><span>${esc(String(error))}</span><button class="btn btn-primary" id="dashboard-retry">Retry dashboard</button></div>`;
    main.querySelector("#dashboard-retry")!.addEventListener("click",()=>void renderDashboard(main,totalCents));
    return;
  }
  if(renderVersion!==dashboardRenderVersion || view!=="dashboard") return;
  const summary=snapshot.summary, previous=snapshot.previous_summary, netWorth=snapshot.net_worth;
  const accountOptions=`<option value="">All accounts</option>`+accounts.map(account=>`<option value="${esc(account.name)}" ${dashboardAccountRef===account.name?"selected":""}>${esc(account.name)}</option>`).join("");
  const maxSpend=Math.max(...snapshot.spending.map(item=>item.spent_cents),1);
  const budgetCount=snapshot.budget_status.filter(status=>status.budget_cents>0).length;
  const balanceCurrencies=[...new Set(snapshot.balances.map(balance=>balance.currency_code))];
  const ledgerBalance=balanceCurrencies.length===1
    ? centsFmt(snapshot.balances.reduce((sum,balance)=>sum+balance.current_balance_cents,0),balanceCurrencies[0])
    : `${snapshot.balances.length} balances`;
  const netWorthHeadline=centsFmt(netWorth.net_worth_cents);
  const netWorthDetails=`<div class="dashboard-net-worth-breakdown"><span><small>Assets</small><strong>${centsFmt(netWorth.assets_cents)}</strong><em>Accounts ${centsFmt(netWorth.account_assets_cents)} · Investments ${centsFmt(netWorth.investment_assets_cents)} · Manual ${centsFmt(netWorth.manual_assets_cents)}</em></span><span><small>Liabilities</small><strong>${centsFmt(netWorth.liabilities_cents)}</strong><em>Loans ${centsFmt(netWorth.loan_liabilities_cents)} · Credit ${centsFmt(netWorth.credit_liabilities_cents)} · Manual ${centsFmt(netWorth.manual_liabilities_cents)}${netWorth.account_liabilities_cents ? ` · Overdraft ${centsFmt(netWorth.account_liabilities_cents)}` : ""}</em></span></div>`;

  main.innerHTML=`
    <div class="page-head dashboard-page-head"><div><h2>Dashboard</h2><p>Your daily money briefing — ${esc(snapshot.account.name??"all accounts")} · updated ${esc(snapshot.as_of)}</p></div><div class="dashboard-controls"><label>Account<select id="dashboard-account">${accountOptions}</select></label><label>Chart range<select id="dashboard-months"><option value="3" ${dashboardMonths===3?"selected":""}>3 months</option><option value="6" ${dashboardMonths===6?"selected":""}>6 months</option><option value="12" ${dashboardMonths===12?"selected":""}>12 months</option></select></label></div></div>
    <section class="dashboard-hero card">
      <div class="dashboard-hero-main"><div><div class="dashboard-eyebrow">Net worth ${dashboardAccountRef?`<span class="dashboard-global-scope">all accounts</span>`:""}</div><div class="dashboard-net-worth">${netWorthHeadline}</div>${dashboardDelta(netWorth.month_over_month_cents,0,true).replace("New vs last month",`${centsFmt(Math.abs(netWorth.month_over_month_cents))} vs last month`)}</div>${netWorthSparkline(netWorth.trend)}</div>
      ${netWorthDetails}
      <div class="dashboard-net-worth-note">Assets − liabilities. Historical points convert month-end ledger balances using dated local FX rates and use current non-ledger valuations.</div>
    </section>
    <div id="dashboard-safe-spend"></div>
    ${dashboardAlertStrip(snapshot)}
    <div class="stat-grid">
      <div class="card stat accent"><div class="label">Ledger balance</div><div class="value">${ledgerBalance}</div><div class="sub">${balanceCurrencies.length>1?"Native balances by currency":`${snapshot.balances.length} account${snapshot.balances.length===1?"":"s"} in scope`}</div></div>
      <div class="card stat"><div class="label">Income (this month)</div><div class="value amount-pos">${centsFmt(summary.income_cents)}</div><div class="sub">${dashboardDelta(summary.income_cents,previous.income_cents,true)} · ${summary.transaction_count} transactions</div></div>
      <div class="card stat"><div class="label">Expenses (this month)</div><div class="value amount-neg">${centsFmt(summary.expense_cents)}</div><div class="sub">${dashboardDelta(summary.expense_cents,previous.expense_cents,false)}</div></div>
      <div class="card stat"><div class="label">Net cashflow</div><div class="value" style="color:${summary.net_cents>0?"var(--success)":summary.net_cents<0?"var(--danger)":"var(--info)"}">${centsFmt(summary.net_cents)}</div><div class="sub">${dashboardDelta(summary.net_cents,previous.net_cents,true)}</div></div>
    </div>
    <div class="grid2 dashboard-primary-grid">
      <div class="card"><div class="card-title">Accounts</div><div class="dashboard-account-list">${snapshot.balances.map(balance=>`<button type="button" class="dashboard-account-row dashboard-row-button" data-open-account="${balance.account_id}"><span><strong>${esc(balance.account_name)}</strong><small>${esc(balance.account_kind)} · ${esc(balance.currency_code)}</small></span><strong>${centsFmt(balance.current_balance_cents,balance.currency_code)}</strong></button>`).join("")||`<div class="empty">No accounts yet</div>`}</div></div>
      <div class="card"><div class="card-title">Budget watch ${budgetCount?`<button class="dashboard-card-link" type="button" data-dashboard-nav="budgets">View budgets</button>`:""}</div>${dashboardBudgetGauges(snapshot.budget_status)}</div>
    </div>
    <div class="grid3" style="margin-top:14px">
      <div class="card"><div class="card-title">Monthly cashflow <span class="small muted">Click a month to drill in</span></div>${cashflowChart(snapshot.cashflow)}</div>
      <div class="card"><div class="card-title">Top spending categories <span class="small muted">Click a category</span></div><div class="dashboard-spending-list">${snapshot.spending.length?snapshot.spending.map(item=>{const pct=Math.round(item.spent_cents/maxSpend*100);return `<button type="button" class="dashboard-spending-row" data-dashboard-category="${esc(item.category_name)}"><span><strong>${esc(item.category_name)}</strong><em class="progress"><i class="progress-fill over" style="width:${pct}%"></i></em></span><strong>${centsFmt(item.spent_cents)}</strong></button>`;}).join(""):`<div class="muted small">No expenses this month</div>`}</div></div>
      <div class="card"><div class="card-title">Balance trend</div>${balanceTrendChart(snapshot.trend,"Ledger balance")}</div>
    </div>
    <div class="grid2" style="margin-top:14px"><div class="card"><div class="card-title">Recent transactions <button class="dashboard-card-link" type="button" data-dashboard-nav="transactions">View all</button></div><div class="dashboard-recent-list">${snapshot.recent_transactions.map(transaction=>`<button type="button" class="dashboard-recent-row dashboard-row-button" data-dashboard-transaction="${transaction.id}"><span><strong>${esc(transaction.payee||transaction.category_name||transaction.account_name)} <span class="badge badge-${transaction.kind}">${transaction.kind}</span></strong><small>${transaction.txn_date} · ${esc(transaction.account_name)} · ${esc(transaction.account_currency_code)}${transaction.category_name?` · ${esc(transaction.category_name)}`:""}</small></span><strong class="${transaction.kind==="expense"?"amount-neg":transaction.kind==="income"?"amount-pos":""}">${transaction.kind==="expense"?"-":""}${centsFmt(transaction.amount_cents,transaction.account_currency_code)}</strong></button>`).join("")||`<div class="muted small">No transactions</div>`}</div></div><div class="card"><div class="card-title">Next due recurring</div>${snapshot.recurring_due.length?`<div class="dashboard-recurring-list">${snapshot.recurring_due.slice(0,4).map(rule=>`<button type="button" class="dashboard-recurring-row" data-open-recurring="${rule.id}"><span><strong>${esc(rule.name)}</strong><small>Due ${esc(rule.next_due_on)} · ${esc(rule.account_name)}</small></span><strong class="${rule.kind==="expense"?"amount-neg":"amount-pos"}">${centsFmt(rule.amount_cents)}</strong></button>`).join("")}</div>`:`<div class="small muted">No active recurring items due in the next 30 days.</div>`}</div></div>
    <div id="dashboard-tooltip" class="dashboard-tooltip" role="status" hidden></div>
  `;
  void mountSafeSpend(main.querySelector<HTMLElement>("#dashboard-safe-spend")!,{accounts,currency,format:centsFmt,escape:esc});
  main.querySelector("#dashboard-account")!.addEventListener("change",event=>{dashboardAccountRef=(event.target as HTMLSelectElement).value;void renderDashboard(main,totalCents);});
  main.querySelector("#dashboard-months")!.addEventListener("change",event=>{dashboardMonths=Number((event.target as HTMLSelectElement).value)||6;void renderDashboard(main,totalCents);});
  main.querySelectorAll<HTMLElement>("[data-dashboard-nav]").forEach(button=>button.addEventListener("click",()=>{const targetView=button.dataset.dashboardNav as View;if(view===targetView) return;navigateTo(()=>{view=targetView;});}));
  main.querySelectorAll<HTMLElement>("[data-forecast-bill-source]").forEach(button=>button.addEventListener("click",()=>openForecastBill(button.dataset.forecastBillSource!,Number(button.dataset.forecastBillId)||null)));
  main.querySelectorAll<HTMLElement>("[data-open-goal]").forEach(button=>button.addEventListener("click",()=>void openGoal(Number(button.dataset.openGoal))));
  main.querySelectorAll<HTMLElement>("[data-open-recurring]").forEach(button=>button.addEventListener("click",()=>openRecurringRule(Number(button.dataset.openRecurring))));
  main.querySelectorAll<HTMLElement>("[data-open-account]").forEach(button=>button.addEventListener("click",()=>{const targetId=Number(button.dataset.openAccount);navigateTo(()=>{selectedAccountId=targetId;view="accounts";});}));
  main.querySelectorAll<HTMLElement>("[data-dashboard-transaction]").forEach(button=>button.addEventListener("click",()=>{const transaction=snapshot.recent_transactions.find(item=>item.id===Number(button.dataset.dashboardTransaction));if(transaction) openTxnModal(transaction,false,true);}));
  main.querySelectorAll<HTMLElement>("[data-dashboard-month]").forEach(element=>{
    const open=()=>openDashboardTransactions(element.dataset.dashboardMonth!);
    element.addEventListener("click",open);element.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();open();}});
  });
  main.querySelectorAll<HTMLElement>("[data-dashboard-category]").forEach(button=>button.addEventListener("click",()=>openDashboardTransactions(snapshot.from.slice(0,7),button.dataset.dashboardCategory)));
  bindDashboardChartTooltips(main);
}

// ---------- Accounts ----------
function accountCashflowChart(points:MonthlyCashFlowPoint[], currencyCode:string){
  if(!points || !points.length) return `<div class="chart-empty">No cash-flow data recorded for this account.</div>`;
  const width=420, height=190, top=16, bottom=142, left=12, right=12;
  const maxAbs=Math.max(...points.map(p=>Math.max(Math.abs(p.income_cents), Math.abs(p.expense_cents), Math.abs(p.net_cents))), 1);
  const zeroY=Math.round(top+(bottom-top)/2);
  const step=(width-left-right)/points.length;
  const barWidth=Math.max(12, Math.min(36, step*0.52));

  const bars=points.map((p,idx)=>{
    const magnitude=Math.max(2, Math.round(Math.abs(p.net_cents)/maxAbs*((bottom-top)/2-8)));
    const x=Math.round(left+idx*step+(step-barWidth)/2);
    const y=p.net_cents>=0 ? zeroY-magnitude : zeroY;
    const label=esc(p.month.slice(5));
    const tooltip=`${p.month} · Net: ${centsFmt(p.net_cents,currencyCode)} · In: ${centsFmt(p.income_cents,currencyCode)} · Out: ${centsFmt(p.expense_cents,currencyCode)}`;
    return `<g class="dashboard-chart-bar ${p.net_cents>=0?"positive":"negative"}" tabindex="0">
      <title>${esc(tooltip)}</title>
      <rect x="${x}" y="${y}" width="${barWidth}" height="${magnitude}" rx="4"/>
      <text x="${Math.round(x+barWidth/2)}" y="${bottom+22}" text-anchor="middle">${label}</text>
    </g>`;
  }).join("");

  return `<div class="dashboard-chart" style="height:190px">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <line class="dashboard-chart-grid" x1="${left}" x2="${width-right}" y1="${top}" y2="${top}"/>
      <line class="dashboard-chart-zero" x1="${left}" x2="${width-right}" y1="${zeroY}" y2="${zeroY}"/>
      <line class="dashboard-chart-grid" x1="${left}" x2="${width-right}" y1="${bottom}" y2="${bottom}"/>
      ${bars}
    </svg>
    <div class="chart-legend">
      <span><i class="positive"></i>Positive Net</span>
      <span><i class="negative"></i>Negative Net</span>
    </div>
  </div>`;
}

function accountBalanceTrendChart(points:BalanceTrendPoint[], currencyCode:string){
  if(!points || !points.length) return `<div class="chart-empty">No balance history recorded for this account.</div>`;
  const width=420, height=190, top=16, bottom=140, left=16, right=16;
  const values=points.map(p=>p.balance_cents);
  const rawMin=Math.min(...values), rawMax=Math.max(...values);
  const padding=Math.max(Math.round((rawMax-rawMin)*0.12), 100);
  const min=rawMin-padding, max=rawMax+padding;
  const xFor=(index:number)=>points.length===1 ? Math.round((left+width-right)/2) : Math.round(left+index*(width-left-right)/(points.length-1));
  const yFor=(value:number)=>Math.round(bottom-(value-min)/(max-min)*(bottom-top));
  const coords=points.map((p,idx)=>`${xFor(idx)},${yFor(p.balance_cents)}`);
  const line=coords.join(" ");
  const area=`${left},${bottom} ${line} ${width-right},${bottom}`;
  const labels=points.map((p,idx)=>`<text x="${xFor(idx)}" y="${bottom+24}" text-anchor="middle">${esc(p.month.slice(5))}</text>`).join("");
  const dots=points.map((p,idx)=>{
    const tooltip=`${p.month} · Balance: ${centsFmt(p.balance_cents,currencyCode)}`;
    return `<g class="dashboard-chart-dot" tabindex="0">
      <title>${esc(tooltip)}</title>
      <circle cx="${xFor(idx)}" cy="${yFor(p.balance_cents)}" r="4.5"/>
    </g>`;
  }).join("");

  return `<div class="dashboard-chart" style="height:190px">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <line class="dashboard-chart-grid" x1="${left}" x2="${width-right}" y1="${top}" y2="${top}"/>
      <line class="dashboard-chart-grid" x1="${left}" x2="${width-right}" y1="${Math.round((top+bottom)/2)}" y2="${Math.round((top+bottom)/2)}"/>
      <line class="dashboard-chart-grid" x1="${left}" x2="${width-right}" y1="${bottom}" y2="${bottom}"/>
      <polygon class="dashboard-chart-area" points="${area}"/>
      <polyline class="dashboard-chart-line" points="${line}"/>
      ${dots}
      ${labels}
    </svg>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:6px;padding:0 4px">
      <span>Low: <strong>${centsFmt(rawMin,currencyCode)}</strong></span>
      <span>Latest: <strong>${centsFmt(values[values.length-1],currencyCode)}</strong></span>
      <span>High: <strong>${centsFmt(rawMax,currencyCode)}</strong></span>
    </div>
  </div>`;
}

function highlightSelectedAccountRow(main:HTMLElement, id:number){
  main.querySelectorAll<HTMLElement>("[data-account-id]").forEach(r=>{
    const isThis = Number(r.dataset.accountId) === id;
    r.classList.toggle("is-selected", isThis);
    const badge = r.querySelector(".account-active-badge");
    const btn = r.querySelector(".account-name-btn");
    btn?.classList.toggle("is-active", isThis);
    if(isThis && !badge){
      btn?.insertAdjacentHTML("beforeend", `<span class="account-active-badge">Selected</span>`);
    } else if(!isThis && badge){
      badge.remove();
    }
  });
}

async function renderAccountDetails(container:HTMLElement, accountId:number){
  const renderVersion = ++accountDetailRenderVersion;
  const account = accounts.find(a=>a.id===accountId);
  if(!account){
    container.innerHTML="";
    return;
  }
  container.innerHTML=`
    <div class="account-detail-loading">
      <div class="small muted">Loading analytics and details for <strong>${esc(account.name)}</strong>…</div>
    </div>
  `;

  const accCur = account.currency_code;
  const today = todayISO();
  const thirtyDaysAgo = daysAgoISO(30);
  const ninetyDaysAgo = daysAgoISO(90);

  let recentSummary: SummaryRecord | null = null;
  let lifetimeSummary: SummaryRecord | null = null;
  let cashflowTrend: MonthlyCashFlowPoint[] = [];
  let balTrend: BalanceTrendPoint[] = [];
  let catSpending: CategorySpendingPoint[] = [];
  let payeeSpending: SpendingBreakdownPoint[] = [];
  let reconciliations: ReconciliationRecord[] = [];
  let eligibleReconTxns: TransactionRecord[] = [];
  let recurringRules: RecurringRuleRecord[] = [];
  let forecast: ForecastSnapshot | null = null;
  let recentTxns: TransactionRecord[] = [];

  try {
    [
      recentSummary,
      lifetimeSummary,
      cashflowTrend,
      balTrend,
      catSpending,
      payeeSpending,
      reconciliations,
      eligibleReconTxns,
      recurringRules,
      forecast,
      recentTxns
    ] = await Promise.all([
      invoke<SummaryRecord>("get_summary",{from:thirtyDaysAgo, to:today, account:account.name}).catch(()=>null),
      invoke<SummaryRecord>("get_summary",{from:"1970-01-01", to:today, account:account.name}).catch(()=>null),
      invoke<MonthlyCashFlowPoint[]>("monthly_cash_flow",{months:6, account:account.name}).catch(()=>[]),
      invoke<BalanceTrendPoint[]>("balance_trend",{months:6, account:account.name}).catch(()=>[]),
      invoke<CategorySpendingPoint[]>("category_spending",{from:ninetyDaysAgo, to:today, limit:5, account:account.name}).catch(()=>[]),
      invoke<SpendingBreakdownPoint[]>("spending_by_payee",{from:ninetyDaysAgo, to:today, limit:5, account:account.name}).catch(()=>[]),
      invoke<ReconciliationRecord[]>("list_reconciliations",{account:account.name}).catch(()=>[]),
      invoke<TransactionRecord[]>("eligible_reconciliation_txns",{account:account.name, endingOn:today}).catch(()=>[]),
      invoke<RecurringRuleRecord[]>("list_recurring").catch(()=>[]),
      invoke<ForecastSnapshot>("get_forecast",{account:account.name, days:60, scenario:null}).catch(()=>null),
      invoke<TransactionRecord[]>("list_transactions",{req:{account:account.name, limit:10, include_deleted:false, sort_by:"date", sort_dir:"desc"}}).catch(()=>[])
    ]);
  } catch {}

  if(renderVersion !== accountDetailRenderVersion || selectedAccountId !== accountId) return;

  const currentBal = balances.find(b=>b.account_id===account.id)?.current_balance_cents ?? account.opening_balance_cents;
  const netSinceOpen = currentBal - account.opening_balance_cents;
  const netSinceOpenPct = account.opening_balance_cents !== 0
    ? (netSinceOpen / Math.abs(account.opening_balance_cents) * 100).toFixed(1)
    : null;

  const in30 = (recentSummary?.income_cents ?? 0) + (recentSummary?.transfer_in_cents ?? 0);
  const out30 = (recentSummary?.expense_cents ?? 0) + (recentSummary?.transfer_out_cents ?? 0);
  const net30 = in30 - out30;

  const totalTxCount = lifetimeSummary?.transaction_count ?? 0;
  const lastRecon = reconciliations && reconciliations.length > 0 ? reconciliations[0] : null;
  const unclearedCount = eligibleReconTxns ? eligibleReconTxns.length : 0;

  const accRecurring = (recurringRules ?? []).filter(r => r.account_id === account.id || r.to_account_id === account.id);
  const accGoals = (forecast?.goal_status ?? []).filter(g => g.account_id === account.id);
  const alerts = forecast?.alerts ?? [];
  const billCalendar = (forecast?.bill_calendar ?? []).slice(0, 5);

  const totalCatSpent = catSpending.reduce((sum, c) => sum + c.spent_cents, 0);

  container.innerHTML=`
    <div class="account-detail-section">
      <div class="account-detail-head">
        <div>
          <div class="account-detail-title-wrap">
            <h3 class="account-detail-title">${esc(account.name)}</h3>
            <span class="badge badge-cash">${esc(account.kind)}</span>
            <span class="pill">${esc(account.currency_code)}</span>
            <span class="muted small">ID #${account.id}</span>
            ${account.archived ? '<span class="pill">Archived</span>' : ''}
          </div>
          <div class="small muted" style="margin-top:4px">
            Opened on ${esc(account.opened_on)} · ${totalTxCount} transaction${totalTxCount === 1 ? '' : 's'} all-time
            ${account.currency_code !== currency ? ` · Reporting currency is ${esc(currency)}` : ''}
          </div>
        </div>
        <div class="account-detail-actions">
          <button class="btn btn-primary btn-sm" id="acc-act-new-tx">+ Transaction</button>
          <button class="btn btn-sm" id="acc-act-transfer">⇄ Transfer</button>
          <button class="btn btn-sm" id="acc-act-ledger">📜 Full Ledger</button>
          <button class="btn btn-sm" id="acc-act-reconcile">⚖️ Reconcile</button>
          <button class="btn btn-sm" id="acc-act-edit">✏️ Edit</button>
        </div>
      </div>

      ${alerts.length > 0 ? `
        <div class="account-detail-alert">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div>
            <strong>Cashflow Warnings:</strong> ${alerts.map(a=>esc(a)).join(" · ")}
          </div>
        </div>
      ` : ''}

      <div class="stat-grid">
        <div class="card stat stat-${currentBal > 0 ? 'positive' : currentBal < 0 ? 'negative' : 'balance'}">
          <div class="label">Current Balance</div>
          <div class="value ${currentBal > 0 ? 'text-positive' : currentBal < 0 ? 'text-negative' : 'text-accent'}">${centsFmt(currentBal, accCur)}</div>
          <div class="sub">${account.currency_code !== currency ? `Reporting: ${esc(currency)}` : 'Live ledger balance'}</div>
        </div>
        <div class="card stat stat-neutral">
          <div class="label">Opening Balance</div>
          <div class="value ${account.opening_balance_cents < 0 ? 'text-negative' : 'text-info'}">${centsFmt(account.opening_balance_cents, accCur)}</div>
          <div class="sub">Opened on ${esc(account.opened_on)}</div>
        </div>
        <div class="card stat stat-${netSinceOpen > 0 ? 'positive' : netSinceOpen < 0 ? 'negative' : 'neutral'}">
          <div class="label">Net Growth</div>
          <div class="value ${netSinceOpen > 0 ? 'text-positive' : netSinceOpen < 0 ? 'text-negative' : 'text-info'}">
            ${netSinceOpen > 0 ? '+' : ''}${centsFmt(netSinceOpen, accCur)}
          </div>
          <div class="sub">${netSinceOpenPct !== null ? `${netSinceOpen > 0 ? '+' : ''}${netSinceOpenPct}% since opening` : 'Baseline'}</div>
        </div>
        <div class="card stat stat-positive">
          <div class="label">30-Day Inflow</div>
          <div class="value text-positive">+${centsFmt(in30, accCur)}</div>
          <div class="sub">Income & transfers received</div>
        </div>
        <div class="card stat stat-negative">
          <div class="label">30-Day Outflow</div>
          <div class="value text-negative">-${centsFmt(out30, accCur)}</div>
          <div class="sub">Expenses & transfers sent</div>
        </div>
        <div class="card stat stat-${net30 > 0 ? 'positive' : net30 < 0 ? 'negative' : 'neutral'}">
          <div class="label">30-Day Net Flow</div>
          <div class="value ${net30 > 0 ? 'text-positive' : net30 < 0 ? 'text-negative' : 'text-info'}">
            ${net30 > 0 ? '+' : ''}${centsFmt(net30, accCur)}
          </div>
          <div class="sub">${net30 > 0 ? 'Surplus this month' : net30 < 0 ? 'Deficit this month' : 'Balanced this month'}</div>
        </div>
        <div class="card stat stat-${unclearedCount > 0 ? 'warning' : lastRecon ? 'positive' : 'neutral'}">
          <div class="label">Reconciliation</div>
          <div class="value ${unclearedCount > 0 ? 'text-warning' : lastRecon ? 'text-positive' : 'text-info'}" style="font-size:16px">${lastRecon ? esc(lastRecon.statement_ending_on) : 'Never'}</div>
          <div class="sub">${unclearedCount > 0 ? `${unclearedCount} uncleared pending` : 'All cleared up to date'}</div>
        </div>
      </div>

      <div class="grid2">
        <div class="card">
          <div class="card-head-row">
            <div>
              <div class="card-title">Balance Trend</div>
              <div class="small muted">Closing balance over the last 6 months</div>
            </div>
          </div>
          ${accountBalanceTrendChart(balTrend, accCur)}
        </div>
        <div class="card">
          <div class="card-head-row">
            <div>
              <div class="card-title">Monthly Cash Flow</div>
              <div class="small muted">Net cash flow performance over the last 6 months</div>
            </div>
          </div>
          ${accountCashflowChart(cashflowTrend, accCur)}
        </div>
      </div>

      <div class="grid2">
        <div class="card">
          <div class="card-head-row">
            <div>
              <div class="card-title">Top Spending Categories</div>
              <div class="small muted">Expenses from this account (last 90 days)</div>
            </div>
            ${totalCatSpent > 0 ? `<span class="pill">${centsFmt(totalCatSpent, accCur)} total</span>` : ''}
          </div>
          <div class="account-item-list">
            ${catSpending.length ? catSpending.map(c => {
              const pct = totalCatSpent > 0 ? Math.round((c.spent_cents / totalCatSpent) * 100) : 0;
              return `<div class="account-item-row">
                <div class="account-cat-bar-wrap">
                  <div class="account-cat-header">
                    <strong>${esc(c.category_name)}</strong>
                    <span>${centsFmt(c.spent_cents, accCur)} <span class="muted">(${pct}%)</span></span>
                  </div>
                  <div class="progress"><div class="progress-fill ok" style="width:${Math.max(4, pct)}%"></div></div>
                </div>
              </div>`;
            }).join("") : `<div class="muted small" style="padding:16px 0">No categorized expenses recorded in the last 90 days.</div>`}
          </div>
        </div>

        <div class="card">
          <div class="card-head-row">
            <div>
              <div class="card-title">Top Merchants & Payees</div>
              <div class="small muted">Highest expenditure recipients (last 90 days)</div>
            </div>
          </div>
          <div class="account-item-list">
            ${payeeSpending.length ? payeeSpending.map(p => `
              <div class="account-item-row">
                <div>
                  ${p.label==="Unassigned"?`<strong>${esc(p.label)}</strong>`:`<button type="button" class="payee-link" data-account-payee="${esc(p.label)}">${esc(p.label)}</button>`}
                  <div class="small muted">${p.transaction_count} transaction${p.transaction_count === 1 ? '' : 's'}</div>
                </div>
                <div style="font-weight:700">${centsFmt(p.spent_cents, accCur)}</div>
              </div>
            `).join("") : `<div class="muted small" style="padding:16px 0">No payee transactions recorded in the last 90 days.</div>`}
          </div>
        </div>
      </div>

      <div class="grid2">
        <div class="card">
          <div class="card-head-row">
            <div>
              <div class="card-title">Recurring Rules & Subscriptions</div>
              <div class="small muted">Automated bills and scheduled transfers linked to this account</div>
            </div>
            <span class="pill">${accRecurring.length} rule${accRecurring.length === 1 ? '' : 's'}</span>
          </div>
          <div class="account-item-list">
            ${accRecurring.length ? accRecurring.map(r => `
              <div class="account-item-row">
                <div>
                  <div style="display:flex;gap:6px;align-items:center">
                    <strong>${esc(r.name)}</strong>
                    <span class="badge badge-${r.kind}">${r.kind}</span>
                    ${r.paused ? '<span class="pill">Paused</span>' : '<span class="pill pill-success">Active</span>'}
                  </div>
                  <div class="small muted" style="margin-top:2px">
                    ${r.cadence === "monthly" ? `Monthly on day ${r.day_of_month ?? 1}` : `Weekly on ${r.weekday ?? 'Mon'}`}
                    · Next due: ${esc(r.next_due_on)}
                    ${r.payee ? ` · ${esc(r.payee)}` : ''}
                  </div>
                </div>
                <div style="font-weight:700">${centsFmt(r.amount_cents, accCur)}</div>
              </div>
            `).join("") : `<div class="muted small" style="padding:16px 0">No recurring rules configured for this account.</div>`}
          </div>
        </div>

        <div class="card">
          <div class="card-head-row">
            <div>
              <div class="card-title">Goals & Upcoming Commitments</div>
              <div class="small muted">Linked financial goals and upcoming scheduled items</div>
            </div>
          </div>
          <div class="account-item-list">
            ${accGoals.length ? accGoals.map(g => {
              const target = g.target_amount_cents ?? g.minimum_balance_cents ?? 0;
              const progressPct = target > 0 ? Math.min(100, Math.round((currentBal / target) * 100)) : 0;
              return `<button type="button" class="account-item-row account-action-row" style="flex-direction:column;align-items:stretch" data-open-goal="${g.id}" aria-label="Manage goal ${esc(g.name)}">
                <span class="account-goal-head">
                  <span>
                    <strong>${esc(g.name)}</strong>
                    <span class="badge badge-cash" style="margin-left:6px">${g.kind === "sinking_fund" ? "sinking fund" : "balance target"}</span>
                  </span>
                  <span class="badge ${g.on_track ? 'badge-income' : 'badge-expense'}">${g.on_track ? 'On track' : 'Action needed'}</span>
                </span>
                <span class="small muted account-goal-meta">
                  <span>Current: ${centsFmt(currentBal, accCur)}</span>
                  <span>Target: ${centsFmt(target, accCur)}${g.due_on ? ` by ${esc(g.due_on)}` : ''}</span>
                </span>
                <span class="progress" style="margin-top:4px"><span class="progress-fill ${g.on_track ? 'ok' : 'warn'}" style="width:${Math.max(4, progressPct)}%"></span></span>
                ${g.suggested_monthly_contribution_cents ? `<span class="small muted account-goal-suggestion">Suggested monthly contribution: <strong>${centsFmt(g.suggested_monthly_contribution_cents, accCur)}</strong></span>` : ''}
              </button>`;
            }).join("") : ''}

            ${billCalendar.length ? `
              <div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-top:6px">Upcoming in next 30 days</div>
              ${billCalendar.map(b => `
                <button type="button" class="account-item-row account-action-row" data-forecast-bill-source="${esc(b.source)}" data-forecast-bill-id="${b.source_id??""}" aria-label="Manage ${esc(b.title)}">
                  <span>
                    <strong>${esc(b.title)}</strong>
                    <span class="small muted account-action-detail">${esc(b.date)} · <span class="badge badge-${b.kind}">${b.kind}</span></span>
                  </span>
                  <span style="font-weight:700">${centsFmt(b.amount_cents, accCur)}</span>
                </button>
              `).join("")}
            ` : ''}

            ${!accGoals.length && !billCalendar.length ? `<div class="muted small" style="padding:16px 0">No goals or upcoming scheduled bills found for this account.</div>` : ''}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head-row">
          <div>
            <div class="card-title">Recent Account Activity</div>
            <div class="small muted">Latest transactions posted to ${esc(account.name)}</div>
          </div>
          <button class="btn btn-sm" id="view-all-txns-top">View full ledger (${totalTxCount}) →</button>
        </div>
        <div class="table-wrap">
          <table class="account-tx-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Payee / Description</th>
                <th>Category</th>
                <th>Reconciliation</th>
                <th style="text-align:right">Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${recentTxns.length ? recentTxns.map(t => {
                const isTransferIn = t.kind === "transfer" && t.to_account_id === account.id;
                const isInflow = t.kind === "income" || isTransferIn;
                const amountCents = isTransferIn ? (t.to_amount_cents ?? t.amount_cents) : t.amount_cents;
                const desc = t.kind === "transfer"
                  ? (isTransferIn ? `Transfer from ${esc(t.account_name)}` : `Transfer to ${esc(t.to_account_name ?? "")}`)
                  : esc(t.payee || t.category_name || "—");
                const reconPill = t.reconciliation_id
                  ? `<span class="pill pill-success" title="Reconciled in #${t.reconciliation_id}">✓ Cleared</span>`
                  : `<span class="pill pill-muted">Pending</span>`;
                return `<tr>
                  <td class="small">${esc(t.txn_date)}</td>
                  <td><span class="badge badge-${t.kind}">${t.kind}</span></td>
                  <td>
                    <strong>${desc}</strong>
                    ${t.note ? `<div class="muted small">${esc(t.note)}</div>` : ''}
                  </td>
                  <td class="small muted">${t.kind === "transfer" ? "—" : esc(t.category_name ?? "—")}</td>
                  <td>${reconPill}</td>
                  <td style="text-align:right">
                    ${isInflow ? `<span class="text-positive">+${centsFmt(amountCents, accCur)}</span>` : `<span class="text-negative">-${centsFmt(amountCents, accCur)}</span>`}
                  </td>
                  <td style="text-align:right">
                    <button class="btn btn-sm" data-acc-tx-id="${t.id}">View</button>
                  </td>
                </tr>`;
              }).join("") : `<tr><td colspan="7" class="empty">No transactions found for this account yet.</td></tr>`}
            </tbody>
          </table>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;flex-wrap:wrap;gap:8px">
          <span class="small muted">Showing ${recentTxns.length} of ${totalTxCount} transaction${totalTxCount === 1 ? '' : 's'}</span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm" id="view-all-txns">Open in full Ledger →</button>
            <button class="btn btn-primary btn-sm" id="acc-act-quick-add">+ Add Transaction</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Attach button event handlers
  container.querySelector("#acc-act-new-tx")?.addEventListener("click", () => {
    openTxnModal(undefined, false, false, { accountName: account.name });
  });
  container.querySelector("#acc-act-quick-add")?.addEventListener("click", () => {
    openTxnModal(undefined, false, false, { accountName: account.name });
  });
  container.querySelector("#acc-act-transfer")?.addEventListener("click", () => {
    openTxnModal(undefined, false, false, { accountName: account.name, kind: "transfer" });
  });

  const openLedger = () => {
    txFilters = {
      from: "",
      to: "",
      accounts: [account.name],
      categories: [],
      kinds: [],
      search: "",
      include_deleted: false,
      limit: 100,
      sort_by: "date",
      sort_dir: "desc"
    };
    navigateTo(()=>{
      view = "transactions";
    });
  };
  container.querySelector("#acc-act-ledger")?.addEventListener("click", openLedger);
  container.querySelector("#view-all-txns")?.addEventListener("click", openLedger);
  container.querySelector("#view-all-txns-top")?.addEventListener("click", openLedger);

  container.querySelector("#acc-act-reconcile")?.addEventListener("click", () => {
    navigateTo(()=>{
      reconciliationSelectedAccount = account.name;
      view = "reconciliation";
    });
  });
  container.querySelectorAll<HTMLElement>("[data-forecast-bill-source]").forEach(button=>button.addEventListener("click",()=>openForecastBill(button.dataset.forecastBillSource!,Number(button.dataset.forecastBillId)||null)));
  container.querySelectorAll<HTMLElement>("[data-open-goal]").forEach(button=>button.addEventListener("click",()=>void openGoal(Number(button.dataset.openGoal))));
  container.querySelector("#acc-act-edit")?.addEventListener("click", () => {
    openAccountModal(account);
  });
  container.querySelectorAll<HTMLElement>("[data-acc-tx-id]").forEach(b => {
    b.addEventListener("click", () => {
      const id = Number(b.dataset.accTxId);
      const tx = recentTxns.find(x => x.id === id);
      if (tx) openTxnModal(tx, false, true);
    });
  });
  container.querySelectorAll<HTMLElement>("[data-account-payee]").forEach(button=>button.addEventListener("click",()=>openPayee(button.dataset.accountPayee!)));
}

function renderAccounts(main:HTMLElement){
  if(selectedAccountId === null && accounts.length > 0){
    selectedAccountId = accounts[0].id;
  }
  if(selectedAccountId !== null && !accounts.some(a=>a.id===selectedAccountId)){
    selectedAccountId = accounts.length > 0 ? accounts[0].id : null;
  }

  main.innerHTML=`
    <div class="page-head" style="display:flex;justify-content:space-between;align-items:flex-end">
      <div><h2>Accounts</h2><p>Click any account name to view detailed insights, cash flow, recurring rules, and recent ledger activity</p></div>
      <button class="btn btn-primary" id="add-acc">+ Account</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Type</th><th>Currency</th><th>Opening</th><th>Current balance</th><th>Opened</th><th></th></tr></thead>
      <tbody>
        ${accounts.map(a=>{
          const bal=balances.find(b=>b.account_id===a.id)?.current_balance_cents??a.opening_balance_cents;
          const isSelected = a.id === selectedAccountId;
          return `<tr class="account-row ${isSelected ? 'is-selected' : ''}" data-account-id="${a.id}">
            <td>
              <button type="button" class="account-name-btn ${isSelected ? 'is-active' : ''}" data-select-acc="${a.id}" title="Click to view details for ${esc(a.name)}">
                <span class="account-name-text">${esc(a.name)}</span>
                <span class="muted small">#${a.id}</span>
                ${isSelected ? '<span class="account-active-badge">Selected</span>' : ''}
              </button>
            </td>
            <td><span class="badge badge-cash">${esc(a.kind)}</span></td>
            <td><span class="pill">${esc(a.currency_code)}</span></td>
            <td class="${a.opening_balance_cents < 0 ? 'text-negative' : 'text-info'}">${centsFmt(a.opening_balance_cents,a.currency_code)}</td>
            <td class="${bal > 0 ? 'text-positive' : bal < 0 ? 'text-negative' : 'text-info'}">${centsFmt(bal,a.currency_code)}</td>
            <td class="small muted">${esc(a.opened_on)}</td>
            <td><div style="display:flex;gap:6px"><button class="btn btn-sm" data-edit-acc="${a.id}">Edit</button><button class="btn btn-sm" data-del-acc="${esc(a.name)}">Archive</button></div></td>
          </tr>`;
        }).join("") || `<tr><td colspan="7" class="empty">No accounts created yet. Click "+ Account" to add one.</td></tr>`}
      </tbody>
    </table></div>
    <div id="account-detail-root" class="account-detail-root"></div>
  `;

  const detailRoot = main.querySelector("#account-detail-root") as HTMLElement;
  const selectAccount = (id:number) => {
    if(selectedAccountId === id) return;
    pushNavigationState();
    selectedAccountId = id;
    highlightSelectedAccountRow(main, id);
    if(detailRoot) renderAccountDetails(detailRoot, id);
    updateTopbarBackButton();
  };

  main.querySelectorAll<HTMLElement>("[data-select-acc]").forEach(btn=>{
    btn.addEventListener("click",(e)=>{
      e.stopPropagation();
      selectAccount(Number(btn.dataset.selectAcc));
    });
  });

  main.querySelectorAll<HTMLElement>("[data-account-id]").forEach(row=>{
    row.addEventListener("click",(e)=>{
      if((e.target as HTMLElement).closest("button")) return;
      selectAccount(Number(row.dataset.accountId));
    });
  });

  main.querySelector("#add-acc")!.addEventListener("click",()=>openAccountModal());
  main.querySelectorAll("[data-edit-acc]").forEach(b=>b.addEventListener("click",(e)=>{
    e.stopPropagation();
    const id=Number((b as HTMLElement).dataset.editAcc);
    const acc=accounts.find(x=>x.id===id)!;
    openAccountModal(acc);
  }));
  main.querySelectorAll("[data-del-acc]").forEach(b=>b.addEventListener("click", async(e)=>{
    e.stopPropagation();
    const ref=(b as HTMLElement).dataset.delAcc!;
    if(!confirm(`Archive account "${ref}"? This is blocked if ledger/goals/budgets reference it.`)) return;
    try{ await invoke("delete_account",{reference:ref}); toast("Account archived"); await refreshCore(); }catch(e:any){ toast(String(e),true); }
  }));

  if(selectedAccountId !== null && detailRoot){
    renderAccountDetails(detailRoot, selectedAccountId);
  }
}
function openAccountModal(existing?:Account){
  const root=document.getElementById("modal-root")!;
  root.innerHTML=`
    <div class="modal-backdrop" id="backdrop">
      <div class="modal">
        <div class="modal-head"><h3>${existing?"Edit account":"New account"}</h3><button class="btn btn-ghost" id="close-m">✕</button></div>
        <div class="modal-body">
          <div class="field"><label>Name</label><input id="acc-name" class="input" value="${esc(existing?.name??"")}"/></div>
          <div class="row">
            <div class="field"><label>Type</label>
              <select id="acc-kind"><option value="checking">checking</option><option value="cash">cash</option><option value="savings">savings</option><option value="credit">credit</option></select>
            </div>
            <div class="field"><label>Opening balance</label><input id="acc-bal" class="input" value="${existing? (existing.opening_balance_cents/100).toFixed(2): "0.00"}"/></div>
          </div>
          <div class="field"><label>Account currency</label><select id="acc-currency">${currencyOptions(existing?.currency_code??currency)}</select><div class="small muted" style="margin-top:4px">Account balances and transactions stay in this currency.</div></div>
          <div class="field"><label>Opened on (YYYY-MM-DD)</label><input id="acc-date" class="input" value="${esc(existing?.opened_on ?? todayISO())}" type="date"/></div>
        </div>
        <div class="modal-foot"><button class="btn" id="cancel-m">Cancel</button><button class="btn btn-primary" id="save-m">${existing?"Update":"Create"}</button></div>
      </div>
    </div>`;
  if(existing) (root.querySelector("#acc-kind") as HTMLSelectElement).value=existing.kind;
  const close=()=>root.innerHTML="";
  root.querySelector("#close-m")!.addEventListener("click",close);
  root.querySelector("#cancel-m")!.addEventListener("click",close);
  root.querySelector("#backdrop")!.addEventListener("click",(e)=>{ if(e.target===e.currentTarget) close(); });
  root.querySelector("#save-m")!.addEventListener("click", async()=>{
    const name=(root.querySelector("#acc-name") as HTMLInputElement).value;
    const kind=(root.querySelector("#acc-kind") as HTMLSelectElement).value;
    const bal=(root.querySelector("#acc-bal") as HTMLInputElement).value;
    const currency_code=(root.querySelector("#acc-currency") as HTMLSelectElement).value;
    const date=(root.querySelector("#acc-date") as HTMLInputElement).value;
    try{
      if(existing) await invoke("edit_account",{req:{reference:existing.name, name, kind, opening_balance:bal, currency_code, opened_on:date}});
      else await invoke("add_account",{req:{name, kind, opening_balance:bal, currency_code, opened_on:date}});
      toast(existing?"Account updated":"Account created"); root.innerHTML=""; await refreshCore();
    }catch(e:any){ toast(String(e),true); }
  });
}

// ---------- Categories ----------
function renderCategories(main:HTMLElement){
  const income=categories.filter(c=>c.kind==="income"), expense=categories.filter(c=>c.kind==="expense");
  main.innerHTML=`
    <div class="page-head" style="display:flex;justify-content:space-between;align-items:flex-end">
      <div><h2>Categories</h2><p>Income & expense categories used across ledger, budgets, planning</p></div>
      <button class="btn btn-primary" id="add-cat">+ Category</button>
    </div>
    <div class="grid2">
      <div class="card"><div class="card-title">Income (${income.length})</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${income.map(c=>catRow(c)).join("")||`<div class="muted small">None</div>`}
        </div>
      </div>
      <div class="card"><div class="card-title">Expense (${expense.length})</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${expense.map(c=>catRow(c)).join("")||`<div class="muted small">None</div>`}
        </div>
      </div>
    </div>
  `;
  function catRow(c:Category){ return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--surface-2);border-radius:10px;border:1px solid var(--border)">
    <div><strong>${esc(c.name)}</strong> <span class="badge badge-${c.kind}" style="margin-left:6px">${c.kind}</span></div>
    <div style="display:flex;gap:6px"><button class="btn btn-sm" data-edit-cat="${c.id}">Edit</button><button class="btn btn-sm" data-del-cat="${esc(c.name)}">Archive</button></div>
  </div>`;}
  main.querySelector("#add-cat")!.addEventListener("click",()=>openCategoryModal());
  main.querySelectorAll("[data-edit-cat]").forEach(b=>b.addEventListener("click",()=>{
    const id=Number((b as HTMLElement).dataset.editCat);
    openCategoryModal(categories.find(x=>x.id===id)!);
  }));
  main.querySelectorAll("[data-del-cat]").forEach(b=>b.addEventListener("click", async()=>{
    const ref=(b as HTMLElement).dataset.delCat!;
    if(!confirm(`Archive category "${ref}"?`)) return;
    try{ await invoke("delete_category",{reference:ref}); toast("Category archived"); await refreshCore(); }catch(e:any){ toast(String(e),true); }
  }));
}
function openCategoryModal(existing?:Category){
  const root=document.getElementById("modal-root")!;
  root.innerHTML=`
    <div class="modal-backdrop" id="bd">
      <div class="modal">
        <div class="modal-head"><h3>${existing?"Edit category":"New category"}</h3><button class="btn btn-ghost" id="x">✕</button></div>
        <div class="modal-body">
          <div class="field"><label>Name</label><input id="cat-name" class="input" value="${esc(existing?.name??"")}"/></div>
          <div class="field"><label>Kind</label><select id="cat-kind"><option value="expense">expense</option><option value="income">income</option></select></div>
          ${existing?`<div class="small muted">Changing kind is blocked if transactions/budgets reference it.</div>`:""}
        </div>
        <div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn btn-primary" id="save">${existing?"Update":"Create"}</button></div>
      </div>
    </div>`;
  if(existing) (root.querySelector("#cat-kind") as HTMLSelectElement).value=existing.kind;
  const close=()=>root.innerHTML="";
  root.querySelector("#x")!.addEventListener("click",close);
  root.querySelector("#cancel")!.addEventListener("click",close);
  root.querySelector("#bd")!.addEventListener("click",(e)=>{ if(e.target===e.currentTarget) close();});
  root.querySelector("#save")!.addEventListener("click", async()=>{
    const name=(root.querySelector("#cat-name") as HTMLInputElement).value;
    const kind=(root.querySelector("#cat-kind") as HTMLSelectElement).value;
    try{
      if(existing) await invoke("edit_category",{req:{reference:existing.name, name, kind}});
      else await invoke("add_category",{req:{name, kind}});
      toast(existing?"Category updated":"Category created"); root.innerHTML=""; await refreshCore();
    }catch(e:any){ toast(String(e),true); }
  });
}

// ---------- Transactions ----------
let txList:TransactionRecord[]=[];
let selectedTxIds=new Set<number>();
let txSelectionFilterSignature="";
let txSearchTimer:any=null;
let txRenderVersion=0;
let txFilterDocumentAbort:AbortController|null=null;
type TxMultiFilter = "account"|"category"|"kind";

function txMultiFilterLabel(label:string, selected:string[], allLabel:string){
  if(!selected.length) return allLabel;
  if(selected.length===1) return selected[0];
  return `${label} · ${selected.length}`;
}
function txMultiFilterHtml(kind:TxMultiFilter, title:string, selected:string[], options:string[], allLabel:string){
  const id=`f-${kind}`;
  const optionRows=options.map(option=>`<label class="tx-filter-option">
    <input type="checkbox" data-tx-multi="${kind}" value="${esc(option)}" ${selected.includes(option)?"checked":""}/>
    <span>${esc(option)}</span>
  </label>`).join("") || `<div class="tx-filter-empty">No ${title.toLowerCase()} available yet.</div>`;
  return `<div class="tx-filter-picker">
    <button class="tx-filter-chip ${selected.length?"active":""}" id="${id}-trigger" type="button" aria-haspopup="dialog" aria-controls="${id}-options" aria-expanded="false" title="Filter by ${title.toLowerCase()}">
      <span>${esc(txMultiFilterLabel(title,selected,allLabel))}</span><span class="tx-filter-chevron" aria-hidden="true">⌄</span>
    </button>
    <div class="tx-filter-popover" id="${id}-options" role="group" aria-label="Filter by ${title.toLowerCase()}" hidden>
      <div class="tx-filter-popover-head"><strong>${esc(title)}</strong><span class="small muted">Select any</span></div>
      <div class="tx-filter-options">${optionRows}</div>
      <button class="tx-filter-clear" type="button" data-clear-tx-multi="${kind}" ${selected.length?"":"hidden"}>Clear ${esc(title.toLowerCase())}</button>
    </div>
  </div>`;
}
function closeTxMultiFilters(main:HTMLElement){
  main.querySelectorAll<HTMLElement>(".tx-filter-popover").forEach(popover=>popover.hidden=true);
  main.querySelectorAll<HTMLButtonElement>(".tx-filter-chip").forEach(trigger=>trigger.setAttribute("aria-expanded","false"));
}
function updateTxMultiFilterChip(main:HTMLElement, kind:TxMultiFilter){
  const selected=Array.from(main.querySelectorAll<HTMLInputElement>(`[data-tx-multi="${kind}"]:checked`)).map(input=>input.value);
  const map={account:["Accounts","All accounts"],category:["Categories","All categories"],kind:["Types","All types"]} as const;
  const trigger=main.querySelector<HTMLButtonElement>(`#f-${kind}-trigger`);
  if(!trigger) return;
  trigger.classList.toggle("active",selected.length>0);
  const label=trigger.querySelector("span");
  if(label) label.textContent=txMultiFilterLabel(map[kind][0],selected,map[kind][1]);
  const clear=main.querySelector<HTMLButtonElement>(`[data-clear-tx-multi="${kind}"]`);
  if(clear) clear.hidden=!selected.length;
}
function txSortIndicator(col:string){
  if(txFilters.sort_by!==col) return `<span class="sort-icon muted" style="opacity:.35">⇅</span>`;
  return txFilters.sort_dir==="asc" ? `<span class="sort-icon active">▲</span>` : `<span class="sort-icon active">▼</span>`;
}
function toggleTxSort(col:string){
  if(txFilters.sort_by===col){
    txFilters.sort_dir = txFilters.sort_dir==="asc"?"desc":"asc";
  } else {
    txFilters.sort_by=col;
    txFilters.sort_dir = col==="date"?"desc":"asc";
  }
}
function currentTxSelectionFilterSignature(){
  return JSON.stringify({from:txFilters.from,to:txFilters.to,accounts:txFilters.accounts,categories:txFilters.categories,kinds:txFilters.kinds,search:txFilters.search,include_deleted:txFilters.include_deleted});
}
async function exportFilteredTransactionsCsv(){
  try{
    const today = new Date().toISOString().slice(0, 10);
    const filterDesc = txFilters.search ? `_${txFilters.search.replace(/[^a-zA-Z0-9]/g, "_")}` : "";
    const defaultPath = `transactions_${today}${filterDesc}.csv`;
    const path = await save({filters:[{name:"CSV",extensions:["csv"]}], defaultPath});
    if(!path) return;
    const n = await invoke<number>("export_transactions_csv",{
      path,
      from: null,
      to: null,
      account: null,
      category: null,
      req: {
        from: txFilters.from || null,
        to: txFilters.to || null,
        accounts: txFilters.accounts,
        categories: txFilters.categories,
        kinds: txFilters.kinds,
        search: txFilters.search || null,
        limit: null,
        include_deleted: txFilters.include_deleted,
        sort_by: txFilters.sort_by || null,
        sort_dir: txFilters.sort_dir || null,
      }
    });
    toast(`Exported ${n} transactions to CSV`);
  }catch(e:any){ toast(String(e),true); }
}

async function renderTransactions(main:HTMLElement){
  txFilterDocumentAbort?.abort();
  txFilterDocumentAbort=null;
  const selectionFilterSignature=currentTxSelectionFilterSignature();
  if(txSelectionFilterSignature!==selectionFilterSignature){
    selectedTxIds.clear();
    txSelectionFilterSignature=selectionFilterSignature;
  }
  const renderVersion=++txRenderVersion;
  const previousSearch=main.querySelector("#f-search") as HTMLInputElement|null;
  const restoreSearchFocus=document.activeElement===previousSearch;
  const selectionStart=previousSearch?.selectionStart??null;
  const selectionEnd=previousSearch?.selectionEnd??null;
  let nextTxList:TransactionRecord[]=[];
  try{
    nextTxList = await invoke<TransactionRecord[]>("list_transactions",{req:{
      from:txFilters.from||null, to:txFilters.to||null, accounts:txFilters.accounts, categories:txFilters.categories,
      kinds:txFilters.kinds, search:txFilters.search||null, limit:txFilters.limit, include_deleted:txFilters.include_deleted,
      sort_by:txFilters.sort_by||null, sort_dir:txFilters.sort_dir||null
    }});
  }catch(e:any){ toast(String(e),true); }
  // Live searches can finish out of order. Only the latest request may update the page.
  if(renderVersion!==txRenderVersion || view!=="transactions") return;
  txList=nextTxList;

  // Result summary belongs with the results, rather than the filtering controls.
  const resultMeta = `${txList.length} transaction${txList.length===1?"":"s"} · sorted by ${esc(txFilters.sort_by)} ${esc(txFilters.sort_dir)}${txFilters.search?` · fuzzy search: “${esc(txFilters.search)}”` : ""}`;
  main.innerHTML=`
    <div class="page-head" style="display:flex;justify-content:space-between;align-items:flex-end">
      <div><h2>Transactions</h2><p>Ledger · income/expense/transfer · soft-delete & restore · balances derived · fuzzy search & sortable columns</p></div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-sm" id="btn-tx-export-csv" title="Export transactions matching current filters to CSV">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          Export CSV
        </button>
        <button class="btn btn-primary" id="add-tx">+ Transaction</button>
      </div>
    </div>
    <div class="tx-filter-bar" aria-label="Transaction filters">
        <div class="tx-search"><input id="f-search" class="input" aria-label="Search anything" placeholder="Try: grcry, starbks, amzn, slary…" value="${esc(txFilters.search)}"/></div>
        ${txMultiFilterHtml("account","Accounts",txFilters.accounts,accounts.map(account=>account.name),"All accounts")}
        ${txMultiFilterHtml("category","Categories",txFilters.categories,categories.map(category=>category.name),"All categories")}
        ${txMultiFilterHtml("kind","Types",txFilters.kinds,["income","expense","transfer"],"All types")}
        <input id="f-from" class="input" type="date" value="${esc(txFilters.from)}" style="min-width:140px"/>
        <input id="f-to" class="input" type="date" value="${esc(txFilters.to)}" style="min-width:140px"/>
        <select id="f-limit" title="Rows to show"><option value="50" ${txFilters.limit===50?"selected":""}>50</option><option value="100" ${txFilters.limit===100?"selected":""}>100</option><option value="250" ${txFilters.limit===250?"selected":""}>250</option><option value="500" ${txFilters.limit===500?"selected":""}>500</option></select>
        <label class="toggle-label" for="f-del"><input class="toggle-input" type="checkbox" id="f-del" ${txFilters.include_deleted?"checked":""}/><span class="toggle-control" aria-hidden="true"></span><span>Include deleted</span></label>
        <button class="btn btn-sm" id="apply-f">Apply</button>
        <button class="btn btn-ghost btn-sm" id="clear-f">Clear</button>
        <button class="btn btn-sm" id="btn-filter-export-csv" title="Export transactions matching current filters to CSV">Export CSV</button>
    </div>
    <div class="tx-result-meta small muted">${esc(resultMeta)}</div>
    ${selectedTxIds.size?`<div class="bulk-action-bar" role="status"><strong>${selectedTxIds.size} selected</strong><span>Bulk changes keep reconciled rows locked and skip incompatible or deleted rows.</span><button class="btn btn-primary btn-sm" id="open-bulk-tx">Bulk action…</button><button class="btn btn-ghost btn-sm" id="clear-tx-selection">Clear</button></div>`:""}
    <div class="table-wrap"><table>
      <thead><tr>
        <th class="tx-select-cell"><input type="checkbox" id="tx-select-all" aria-label="Select all filtered transactions" ${txList.length&&txList.every(transaction=>selectedTxIds.has(transaction.id))?"checked":""}/></th>
        <th class="sortable" data-sort="id" title="Click to sort">Transaction ID ${txSortIndicator("id")}</th>
        <th class="sortable" data-sort="date" title="Click to sort">Date ${txSortIndicator("date")}</th>
        <th class="sortable" data-sort="kind" title="Click to sort">Type ${txSortIndicator("kind")}</th>
        <th class="sortable" data-sort="amount" title="Click to sort">Amount ${txSortIndicator("amount")}</th>
        <th class="sortable" data-sort="account" title="Click to sort">Account ${txSortIndicator("account")}</th>
        <th class="sortable" data-sort="category" title="Click to sort">Category ${txSortIndicator("category")}</th>
        <th class="sortable" data-sort="payee" title="Click to sort">Payee ${txSortIndicator("payee")}</th>
        <th>Note</th><th></th>
      </tr></thead>
      <tbody>
        ${txList.map(t=>`
          <tr style="${t.deleted_at?"opacity:.45":""}">
            <td class="tx-select-cell"><input type="checkbox" data-tx-select="${t.id}" aria-label="Select transaction ${t.id}" ${selectedTxIds.has(t.id)?"checked":""}/></td>
            <td class="small">${t.id?`<button type="button" class="transaction-id-link" data-detail="${t.id}" aria-label="View details for transaction ${t.id}">#${t.id}</button>`:"—"}</td>
            <td class="small">${esc(t.txn_date)} ${t.reconciliation_id?`<span class="pill" title="Reconciled">reconciled</span>`:""} ${t.deleted_at?`<span class="pill">deleted</span>`:""}</td>
            <td><span class="badge badge-${t.kind}">${t.kind}</span></td>
            <td style="font-weight:800" class="${t.kind==="expense"?"amount-neg":t.kind==="income"?"amount-pos":""}">${t.kind==="expense"?"-":""}${centsFmt(t.amount_cents,t.account_currency_code)}${t.to_amount_cents!==null&&t.to_account_currency_code&&t.to_amount_cents!==t.amount_cents?` <span class="small muted">→ ${centsFmt(t.to_amount_cents,t.to_account_currency_code)}</span>`:""}</td>
            <td class="small">${esc(t.account_name)} <span class="muted">${esc(t.account_currency_code)}</span>${t.to_account_name?` → ${esc(t.to_account_name)} <span class="muted">${esc(t.to_account_currency_code??"")}</span>`:""}${t.exchange_rate?`<div class="muted" style="font-size:11px">${esc(t.exchange_rate_source??"rate")}: ${esc(t.exchange_rate)} · ${esc(t.exchange_rate_date??"")}</div>`:""}</td>
            <td class="small">${esc(t.category_name?? (t.kind==="transfer"?"—":""))}</td>
            <td class="small">${t.payee?.trim()?`<button type="button" class="payee-link" data-open-payee="${esc(t.payee.trim())}">${esc(t.payee)}</button>`:""}</td>
            <td class="small muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.note??"")}</td>
            <td><div style="display:flex;gap:6px;flex-wrap:wrap">
              ${t.deleted_at?`<button class="btn btn-sm" data-restore="${t.id}">Restore</button>`:`
                <button class="btn btn-sm" data-dup="${t.id}" title="Duplicate with today's date">Duplicate</button>
                <button class="btn btn-sm" data-edit="${t.id}">Edit</button>
                <button class="btn btn-sm" data-del="${t.id}">Delete</button>`}
            </div></td>
          </tr>
        `).join("") || `<tr><td colspan="10" class="empty">No transactions</td></tr>`}
      </tbody>
    </table></div>
  `;
  // sortable headers
  main.querySelectorAll("th.sortable").forEach(th=>th.addEventListener("click",()=>{
    const col=(th as HTMLElement).dataset.sort!;
    toggleTxSort(col);
    renderTransactions(main);
  }));
  main.querySelectorAll<HTMLElement>("[data-open-payee]").forEach(button=>button.addEventListener("click",()=>openPayee(button.dataset.openPayee!)));
  const selectAll=main.querySelector<HTMLInputElement>("#tx-select-all");
  selectAll?.addEventListener("change",async()=>{
    if(selectAll.checked){
      selectAll.disabled=true;
      try{
        const allFiltered=await invoke<TransactionRecord[]>("list_transactions",{req:{
          from:txFilters.from||null,to:txFilters.to||null,accounts:txFilters.accounts,categories:txFilters.categories,
          kinds:txFilters.kinds,search:txFilters.search||null,limit:1_000_000,include_deleted:txFilters.include_deleted,
          sort_by:txFilters.sort_by||null,sort_dir:txFilters.sort_dir||null
        }});
        if(currentTxSelectionFilterSignature()===selectionFilterSignature) allFiltered.forEach(transaction=>selectedTxIds.add(transaction.id));
      }catch(error:any){toast(String(error),true);}
    }else selectedTxIds.clear();
    renderTransactions(main);
  });
  main.querySelectorAll<HTMLInputElement>("[data-tx-select]").forEach(input=>input.addEventListener("change",()=>{
    const id=Number(input.dataset.txSelect);
    if(input.checked) selectedTxIds.add(id); else selectedTxIds.delete(id);
    renderTransactions(main);
  }));
  // live fuzzy search — debounce 320ms; also supports Enter / Apply
  const fSearch = main.querySelector("#f-search") as HTMLInputElement;
  if(restoreSearchFocus){
    fSearch.focus();
    fSearch.setSelectionRange(selectionStart,selectionEnd);
  }
  fSearch.addEventListener("input",()=>{
    clearTimeout(txSearchTimer);
    txSearchTimer=setTimeout(()=>{
      if(view!=="transactions") return;
      txFilters.search=fSearch.value.trim();
      renderTransactions(main);
    }, 320);
  });
  fSearch.addEventListener("keydown",(e)=>{ if(e.key==="Enter"){ clearTimeout(txSearchTimer); txSearchTimer=null; txFilters.search=fSearch.value.trim(); renderTransactions(main); }});

  main.querySelectorAll<HTMLButtonElement>(".tx-filter-chip").forEach(trigger=>trigger.addEventListener("click",event=>{
    event.stopPropagation();
    const popover=main.querySelector<HTMLElement>(`#${trigger.getAttribute("aria-controls")}`)!;
    const opening=popover.hidden;
    closeTxMultiFilters(main);
    popover.hidden=!opening;
    trigger.setAttribute("aria-expanded",String(opening));
  }));
  main.querySelectorAll<HTMLInputElement>("[data-tx-multi]").forEach(input=>input.addEventListener("change",()=>{
    updateTxMultiFilterChip(main,input.dataset.txMulti as TxMultiFilter);
  }));
  main.querySelectorAll<HTMLButtonElement>("[data-clear-tx-multi]").forEach(button=>button.addEventListener("click",()=>{
    const kind=button.dataset.clearTxMulti as TxMultiFilter;
    main.querySelectorAll<HTMLInputElement>(`[data-tx-multi="${kind}"]`).forEach(input=>input.checked=false);
    updateTxMultiFilterChip(main,kind);
  }));
  main.addEventListener("keydown",event=>{ if(event.key==="Escape") closeTxMultiFilters(main); });
  txFilterDocumentAbort=new AbortController();
  document.addEventListener("click",event=>{
    if(!(event.target as Element).closest(".tx-filter-picker")) closeTxMultiFilters(main);
  },{signal:txFilterDocumentAbort.signal});

  main.querySelector("#add-tx")!.addEventListener("click",()=>openTxnModal());
  main.querySelector("#btn-tx-export-csv")?.addEventListener("click",()=>exportFilteredTransactionsCsv());
  main.querySelector("#btn-filter-export-csv")?.addEventListener("click",()=>exportFilteredTransactionsCsv());
  main.querySelector("#open-bulk-tx")?.addEventListener("click",()=>openBulkTransactionModal(main));
  main.querySelector("#clear-tx-selection")?.addEventListener("click",()=>{ selectedTxIds.clear(); renderTransactions(main); });
  main.querySelector("#apply-f")!.addEventListener("click",()=>{
    clearTimeout(txSearchTimer); txSearchTimer=null;
    txFilters.search=(main.querySelector("#f-search") as HTMLInputElement).value.trim();
    txFilters.accounts=Array.from(main.querySelectorAll<HTMLInputElement>("[data-tx-multi=account]:checked")).map(input=>input.value);
    txFilters.categories=Array.from(main.querySelectorAll<HTMLInputElement>("[data-tx-multi=category]:checked")).map(input=>input.value);
    txFilters.from=(main.querySelector("#f-from") as HTMLInputElement).value;
    txFilters.to=(main.querySelector("#f-to") as HTMLInputElement).value;
    txFilters.include_deleted=(main.querySelector("#f-del") as HTMLInputElement).checked;
    txFilters.kinds=Array.from(main.querySelectorAll<HTMLInputElement>("[data-tx-multi=kind]:checked")).map(input=>input.value);
    txFilters.limit=Number((main.querySelector("#f-limit") as HTMLSelectElement).value)||100;
    renderTransactions(main);
  });
  main.querySelector("#clear-f")!.addEventListener("click",()=>{ clearTimeout(txSearchTimer); txSearchTimer=null; txFilters={from:"",to:"",accounts:[],categories:[],kinds:[],search:"",include_deleted:false,limit:100,sort_by:"date",sort_dir:"desc"}; renderTransactions(main); });
  main.querySelectorAll("[data-edit]").forEach(b=>b.addEventListener("click",()=>{
    const id=Number((b as HTMLElement).dataset.edit);
    openTxnModal(txList.find(x=>x.id===id)!);
  }));
  main.querySelectorAll("[data-detail]").forEach(b=>b.addEventListener("click",()=>{
    const id=Number((b as HTMLElement).dataset.detail);
    const transaction=txList.find(x=>x.id===id);
    if(transaction) openTxnModal(transaction,false,true);
  }));
  main.querySelectorAll("[data-del]").forEach(b=>b.addEventListener("click", async()=>{
    const id=Number((b as HTMLElement).dataset.del);
    if(!confirm("Soft-delete this transaction?")) return;
    try{ await invoke("delete_transaction",{id}); toast("Deleted"); await refreshCore(); renderTransactions(main); }catch(e:any){ toast(String(e),true); }
  }));
  main.querySelectorAll("[data-restore]").forEach(b=>b.addEventListener("click", async()=>{
    const id=Number((b as HTMLElement).dataset.restore);
    try{ await invoke("restore_transaction",{id}); toast("Restored"); await refreshCore(); renderTransactions(main); }catch(e:any){ toast(String(e),true); }
  }));
  main.querySelectorAll("[data-dup]").forEach(b=>b.addEventListener("click", async()=>{
    const id=Number((b as HTMLElement).dataset.dup);
    const t=txList.find(x=>x.id===id);
    if(!t) return;
    // prefill modal with same data but today's date so user can confirm/tweak
    openTxnModal({
      ...t,
      id: 0 as any,
      txn_date: todayISO(),
    } as any, true);
  }));
}
function bulkResultMessage(action:string,result:BulkTransactionResult){
  const applied=result.applied_ids.length;
  const verb={set_category:"updated",add_tags:"tagged",remove_tags:"updated",replace_tags:"tagged",delete:"deleted",restore:"restored",set_payee_default_category:"saved"}[action]??"updated";
  if(!result.skipped.length) return `${applied} transaction${applied===1?"":"s"} ${verb}.`;
  const reasons=new Map<string,number>();
  result.skipped.forEach(skip=>reasons.set(skip.reason,(reasons.get(skip.reason)??0)+1));
  const summary=[...reasons].map(([reason,count])=>`${count} ${reason}`).join(", ");
  return `${applied} ${verb}, ${result.skipped.length} skipped: ${summary}.`;
}
function openBulkTransactionModal(main:HTMLElement){
  const root=document.getElementById("modal-root")!;
  const selected=[...selectedTxIds];
  const categoryOptions=`<option value="">Choose category…</option>${categories.map(category=>`<option value="${esc(category.name)}">${esc(category.name)} (${category.kind})</option>`).join("")}`;
  root.innerHTML=`<div class="modal-backdrop" id="bd"><div class="modal bulk-modal">
    <div class="modal-head"><h3>Bulk action</h3><button class="btn btn-ghost" id="x">✕</button></div>
    <div class="modal-body">
      <div class="bulk-selection-summary"><strong>${selected.length} transaction${selected.length===1?"":"s"} selected</strong><span>Reconciled rows are always skipped. Deleted rows must be restored before changes.</span></div>
      <div class="field"><label>Action</label><select id="bulk-action">
        <option value="set_category">Set category</option><option value="add_tags">Add tags</option><option value="remove_tags">Remove tags</option><option value="replace_tags">Replace tags</option>
        <option value="set_payee_default_category">Set default category for payee</option><option value="delete">Soft-delete</option><option value="restore">Restore</option>
      </select></div>
      <div class="field" id="bulk-category-wrap"><label>Category</label><select id="bulk-category">${categoryOptions}</select><div class="small muted" id="bulk-category-note">Transfers and transactions whose kind does not match are skipped.</div></div>
      <div class="field" id="bulk-tags-wrap"><label>Tags</label><input id="bulk-tags" class="input" placeholder="e.g. reimbursable, tax"/><div class="small muted">Separate tags with commas.</div></div>
      <div class="bulk-action-note small muted" id="bulk-action-note"></div>
    </div>
    <div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn btn-primary" id="confirm-bulk">Confirm action</button></div>
  </div></div>`;
  const close=()=>root.innerHTML="";
  const action=root.querySelector<HTMLSelectElement>("#bulk-action")!;
  const categoryWrap=root.querySelector<HTMLElement>("#bulk-category-wrap")!;
  const tagsWrap=root.querySelector<HTMLElement>("#bulk-tags-wrap")!;
  const actionNote=root.querySelector<HTMLElement>("#bulk-action-note")!;
  const sync=()=>{
    const value=action.value;
    const needsCategory=value==="set_category"||value==="set_payee_default_category";
    const needsTags=value==="add_tags"||value==="remove_tags"||value==="replace_tags";
    categoryWrap.hidden=!needsCategory;
    tagsWrap.hidden=!needsTags;
    actionNote.textContent=value==="set_payee_default_category"
      ? "Saves one payee → category default for eligible selected rows. Future manual transactions and imports use it when no category is supplied."
      : value==="delete" ? "This is reversible: the result toast includes Undo."
      : value==="restore" ? "Restoration re-validates the original account and category before making a row active again."
      : "Each eligible transaction is changed atomically; incompatible rows are reported as skipped.";
  };
  sync(); action.addEventListener("change",sync);
  root.querySelector("#x")!.addEventListener("click",close);
  root.querySelector("#cancel")!.addEventListener("click",close);
  root.querySelector("#bd")!.addEventListener("click",event=>{if(event.target===event.currentTarget)close();});
  root.querySelector("#confirm-bulk")!.addEventListener("click",async()=>{
    const actionValue=action.value;
    const category=categoryWrap.hidden?null:(root.querySelector<HTMLSelectElement>("#bulk-category")!.value||null);
    const tags=tagsWrap.hidden?[]:root.querySelector<HTMLInputElement>("#bulk-tags")!.value.split(",").map(tag=>tag.trim()).filter(Boolean);
    if((actionValue==="set_category"||actionValue==="set_payee_default_category")&&!category){toast("Choose a category",true);return;}
    if((actionValue==="add_tags"||actionValue==="remove_tags"||actionValue==="replace_tags")&&!tags.length){toast("Enter at least one tag",true);return;}
    const confirm=root.querySelector<HTMLButtonElement>("#confirm-bulk")!;
    confirm.disabled=true; confirm.textContent="Applying…";
    try{
      const result=await invoke<BulkTransactionResult>("bulk_transactions",{req:{transaction_ids:selected,action:actionValue,category,tags}});
      close(); selectedTxIds.clear(); await refreshCore(); await renderTransactions(main);
      const message=bulkResultMessage(actionValue,result);
      if(actionValue==="delete"&&result.applied_ids.length){
        toast(message,false,{label:"Undo",run:async()=>{
          const restored=await invoke<BulkTransactionResult>("bulk_transactions",{req:{transaction_ids:result.applied_ids,action:"restore",category:null,tags:[]}});
          await refreshCore(); await renderTransactions(main); toast(bulkResultMessage("restore",restored),restored.applied_ids.length===0);
        }});
      }else toast(message,result.applied_ids.length===0);
    }catch(error:any){confirm.disabled=false;confirm.textContent="Confirm action";toast(String(error),true);}
  });
}
function openTxnModal(existing?:TransactionRecord, isDuplicate=false, readOnly=false, defaults?:{accountName?:string, toAccountName?:string, kind?:"income"|"expense"|"transfer"}){
  const root=document.getElementById("modal-root")!;
  const isEdit=!!existing && !isDuplicate;
  root.innerHTML=`
    <div class="modal-backdrop" id="bd">
      <div class="modal" style="max-width:680px">
        <div class="modal-head"><h3>${readOnly?`Transaction #${existing!.id}`:isEdit?"Edit transaction":"New transaction"}</h3><button class="btn btn-ghost" id="x">✕</button></div>
        <div class="modal-body">
          <div class="row">
            <div class="field"><label>Kind</label>
              <select id="tx-kind"><option value="expense">expense</option><option value="income">income</option><option value="transfer">transfer</option></select>
            </div>
            <div class="field"><label>Amount</label><input id="tx-amount" class="input" placeholder="12.50" value="${existing?(existing.amount_cents/100).toFixed(2):""}"/></div>
            <div class="field"><label>Date</label><input id="tx-date" class="input" type="date" value="${esc(existing?.txn_date ?? todayISO())}"/></div>
          </div>
          <div class="row">
            <div class="field"><label>Account</label><select id="tx-account">${accounts.map(a=>`<option value="${esc(a.name)}">${esc(a.name)} · ${esc(a.currency_code)}</option>`).join("")}</select></div>
            <div class="field" id="wrap-to"><label>To account (transfer only)</label><select id="tx-to"><option value="">—</option>${accounts.map(a=>`<option value="${esc(a.name)}">${esc(a.name)} · ${esc(a.currency_code)}</option>`).join("")}</select></div>
          </div>
          <section class="fx-transaction-card" id="fx-panel" hidden>
            <div class="fx-transaction-head"><div><strong>Exchange rate</strong><div class="small muted" id="fx-description"></div></div><span class="pill" id="fx-pair"></span></div>
            <div class="row"><div class="field"><label>Rate source</label><select id="fx-source"><option value="frankfurter" ${existing?.exchange_rate_source==="frankfurter"||(!existing?.exchange_rate_source&&fxDefaultSource==="frankfurter")?"selected":""}>Frankfurter (cached)</option><option value="manual" ${existing?.exchange_rate_source==="manual"||(!existing?.exchange_rate_source&&fxDefaultSource==="manual")?"selected":""}>Manual</option></select></div><div class="field"><label>Rate <span id="fx-rate-unit"></span></label><div style="display:flex;gap:7px"><input id="fx-rate" class="input" placeholder="e.g. 1.0842" value="${esc(existing?.exchange_rate??"")}"/><button class="btn btn-sm" type="button" id="fx-fetch">Get rate</button></div></div></div>
            <div class="row"><div class="field" id="fx-to-wrap"><label>Destination amount</label><input id="fx-to-amount" class="input" value="${existing?.to_amount_cents!==null&&existing?.to_amount_cents!==undefined?(existing.to_amount_cents/100).toFixed(2):""}"/></div><div class="field" id="fx-reporting-wrap"><label>Reporting amount (${esc(currency)})</label><input id="fx-reporting-amount" class="input" value="${existing?.reporting_amount_cents&&existing.reporting_amount_cents!==existing.amount_cents?(existing.reporting_amount_cents/100).toFixed(2):""}"/></div></div>
            <input id="fx-quoted-on" type="hidden" value="${esc(existing?.exchange_rate_date??"")}"/>
            <div class="small muted" id="fx-status">Rates are saved with this transaction. Frankfurter requests reuse the local SQLite cache for an hour.</div>
          </section>
          <div class="field" id="wrap-cat"><label>Category</label><select id="tx-cat"><option value="">—</option>${categories.map(c=>`<option value="${esc(c.name)}" data-kind="${c.kind}">${esc(c.name)} (${c.kind})</option>`).join("")}</select>
            <div class="small muted" style="margin-top:4px">Income needs income category, expense needs expense category, transfer forbids category.</div>
          </div>
          <div class="field" id="split-control"><label class="toggle-label"><input class="toggle-input" type="checkbox" id="tx-use-splits"/><span class="toggle-control" aria-hidden="true"></span><span>Split across categories</span></label>
            <div class="small muted" style="margin-top:4px">Split lines must add up exactly to the bank amount. Reporting-currency cents are allocated exactly by the backend.</div>
          </div>
          <section class="card" id="tx-split-editor" hidden><div class="card-title">Category split</div><div id="tx-split-rows"></div><button class="btn btn-sm" type="button" id="tx-add-split">+ Split line</button></section>
          <div class="field"><label>Payee / Merchant</label><input id="tx-payee" class="input" value="${esc(existing?.payee??"")}"/></div>
          <div class="field"><label>Notes / Memo</label><textarea id="tx-note">${esc(existing?.note??"")}</textarea></div>
          <div class="field"><label>Tags</label><input id="tx-tags" class="input" placeholder="e.g. work, reimbursable, tax"/><div class="small muted">Separate tags with commas. Tags are reusable across transactions.</div></div>
          <div class="field"><label>Receipt / invoice</label><div style="display:flex;gap:8px"><input id="tx-attachment" class="input" readonly placeholder="Optional local file…"/><button class="btn" id="pick-attachment">Attach file</button></div><div class="small muted" id="tx-existing-files"></div></div>
        </div>
        <div class="modal-foot"><button class="btn" id="cancel">${readOnly?"Close":"Cancel"}</button>${readOnly?"":`<button class="btn btn-primary" id="save">${isEdit?"Update":"Create"}</button>`}</div>
      </div>
    </div>`;
  const kindSel=root.querySelector("#tx-kind") as HTMLSelectElement;
  if(existing) kindSel.value=existing.kind;
  else if(defaults?.kind) kindSel.value=defaults.kind;

  if(existing) (root.querySelector("#tx-account") as HTMLSelectElement).value=existing.account_name;
  else if(defaults?.accountName) (root.querySelector("#tx-account") as HTMLSelectElement).value=defaults.accountName;

  if(existing?.to_account_name) (root.querySelector("#tx-to") as HTMLSelectElement).value=existing.to_account_name;
  else if(defaults?.toAccountName) (root.querySelector("#tx-to") as HTMLSelectElement).value=defaults.toAccountName;

  if(existing?.category_name) (root.querySelector("#tx-cat") as HTMLSelectElement).value=existing.category_name;
  type SplitDraft={category:string;amount:string;memo:string};
  let splitDrafts:SplitDraft[]=[];
  const useSplits=root.querySelector("#tx-use-splits") as HTMLInputElement;
  let splitsReadSucceeded=!existing;
  let splitsLoaded=Promise.resolve();
  const renderSplitRows=()=>{
    const kind=kindSel.value;
    const allowed=categories.filter(category=>category.kind===kind);
    splitDrafts.forEach(line=>{if(!allowed.some(category=>category.name===line.category))line.category=allowed[0]?.name??"";});
    const rows=root.querySelector("#tx-split-rows") as HTMLElement;
    rows.innerHTML=splitDrafts.map((line,index)=>`<div class="row" data-split-row="${index}"><div class="field"><label>Category</label><select data-split-category>${allowed.map(category=>`<option value="${esc(category.name)}" ${category.name===line.category?"selected":""}>${esc(category.name)}</option>`).join("")}</select></div><div class="field"><label>Amount</label><input class="input" data-split-amount inputmode="decimal" value="${esc(line.amount)}"/></div><div class="field"><label>Memo</label><input class="input" data-split-memo value="${esc(line.memo)}"/></div><button class="btn btn-sm" type="button" data-remove-split="${index}">Remove</button></div>`).join("");
    rows.querySelectorAll<HTMLElement>("[data-split-row]").forEach(row=>{
      const index=Number(row.dataset.splitRow);
      row.querySelector<HTMLSelectElement>("[data-split-category]")?.addEventListener("change",event=>splitDrafts[index].category=(event.target as HTMLSelectElement).value);
      row.querySelector<HTMLInputElement>("[data-split-amount]")?.addEventListener("input",event=>splitDrafts[index].amount=(event.target as HTMLInputElement).value);
      row.querySelector<HTMLInputElement>("[data-split-memo]")?.addEventListener("input",event=>splitDrafts[index].memo=(event.target as HTMLInputElement).value);
    });
    rows.querySelectorAll<HTMLElement>("[data-remove-split]").forEach(button=>button.addEventListener("click",()=>{splitDrafts.splice(Number(button.dataset.removeSplit),1);renderSplitRows();}));
    if(readOnly) rows.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>("input,select,button").forEach(control=>control.disabled=true);
  };
  root.querySelector("#tx-add-split")!.addEventListener("click",()=>{const allowed=categories.filter(category=>category.kind===kindSel.value);splitDrafts.push({category:allowed[0]?.name??"",amount:"",memo:""});renderSplitRows();});
  useSplits.addEventListener("change",()=>{if(useSplits.checked&&splitDrafts.length<2){const allowed=categories.filter(category=>category.kind===kindSel.value);splitDrafts=[{category:allowed[0]?.name??"",amount:"",memo:""},{category:allowed[1]?.name??allowed[0]?.name??"",amount:"",memo:""}];renderSplitRows();}sync();});
  if(existing){
    splitsLoaded=invoke<TransactionSplitRecord[]>("list_transaction_splits",{transactionId:existing.id}).then(rows=>{splitsReadSucceeded=true;if(!rows.length)return;splitDrafts=rows.map(row=>({category:row.category_name,amount:(row.amount_cents/100).toFixed(2),memo:row.memo??""}));useSplits.checked=true;renderSplitRows();sync();}).catch(error=>toast(String(error),true));
  }
  const sync=()=>{
    const k=kindSel.value;
    (root.querySelector("#wrap-to") as HTMLElement).style.display = k==="transfer"?"block":"none";
    if(k==="transfer") useSplits.checked=false;
    (root.querySelector("#split-control") as HTMLElement).style.display=k==="transfer"?"none":"block";
    (root.querySelector("#tx-split-editor") as HTMLElement).hidden=k==="transfer"||!useSplits.checked;
    (root.querySelector("#wrap-cat") as HTMLElement).style.display = k==="transfer"||useSplits.checked?"none":"block";
    // filter category options by kind
    const sel=root.querySelector("#tx-cat") as HTMLSelectElement;
    Array.from(sel.options).forEach(o=>{
      if(!o.value) return;
      const ck=o.dataset.kind;
      o.hidden = k==="transfer" ? true : (k==="income"? ck!=="income" : ck!=="expense");
    });
    if(sel.selectedOptions[0]?.hidden) sel.value="";
    const source=accounts.find(account=>account.name===(root.querySelector("#tx-account") as HTMLSelectElement).value);
    const target=accounts.find(account=>account.name===(root.querySelector("#tx-to") as HTMLSelectElement).value);
    const quote=k==="transfer"?target?.currency_code:currency;
    const needsFx=!!source && !!quote && (source.currency_code!==currency || (k==="transfer" && source.currency_code!==quote));
    const panel=root.querySelector("#fx-panel") as HTMLElement;
    panel.hidden=!needsFx;
    if(needsFx){
      (root.querySelector("#fx-pair") as HTMLElement).textContent=`${source!.currency_code} → ${quote}`;
      (root.querySelector("#fx-rate-unit") as HTMLElement).textContent=`(1 ${source!.currency_code} = ${quote})`;
      (root.querySelector("#fx-description") as HTMLElement).textContent=k==="transfer"?"Enter the destination amount or use the selected rate to calculate it.":`This transaction is valued in ${currency} for reports.`;
      (root.querySelector("#fx-to-wrap") as HTMLElement).style.display=k==="transfer"&&source!.currency_code!==quote?"block":"none";
      (root.querySelector("#fx-reporting-wrap") as HTMLElement).style.display=source!.currency_code!==currency&&quote!==currency?"block":"none";
    }
    if(useSplits.checked) renderSplitRows();
  };
  kindSel.addEventListener("change",sync);
  (root.querySelector("#tx-account") as HTMLSelectElement).addEventListener("change",sync);
  (root.querySelector("#tx-to") as HTMLSelectElement).addEventListener("change",sync);
  sync();
  root.querySelector("#fx-fetch")!.addEventListener("click",async()=>{
    const sourceAccount=accounts.find(account=>account.name===(root.querySelector("#tx-account") as HTMLSelectElement).value);
    const targetAccount=accounts.find(account=>account.name===(root.querySelector("#tx-to") as HTMLSelectElement).value);
    const kind=(root.querySelector("#tx-kind") as HTMLSelectElement).value;
    if(!sourceAccount) return;
    const quote=kind==="transfer"?targetAccount?.currency_code:currency;
    if(!quote) { toast("Choose a destination account first",true); return; }
    const source=(root.querySelector("#fx-source") as HTMLSelectElement).value;
    const date=(root.querySelector("#tx-date") as HTMLInputElement).value;
    const status=root.querySelector("#fx-status") as HTMLElement;
    status.textContent="Resolving exchange rate…";
    try{
      const result=await invoke<FxRateQuote>("resolve_exchange_rate",{baseCurrency:sourceAccount.currency_code,quoteCurrency:quote,date,source,forceRefresh:false});
      (root.querySelector("#fx-rate") as HTMLInputElement).value=result.rate;
      (root.querySelector("#fx-quoted-on") as HTMLInputElement).value=result.quoted_on;
      const amount=Number((root.querySelector("#tx-amount") as HTMLInputElement).value);
      if(Number.isFinite(amount)&&amount>0&&kind==="transfer"&&sourceAccount.currency_code!==quote) (root.querySelector("#fx-to-amount") as HTMLInputElement).value=(amount*Number(result.rate)).toFixed(2);
      if(sourceAccount.currency_code!==currency && quote!==currency){
        if(source==="frankfurter"){
          const reporting=await invoke<FxRateQuote>("resolve_exchange_rate",{baseCurrency:sourceAccount.currency_code,quoteCurrency:currency,date,source,forceRefresh:false});
          if(Number.isFinite(amount)&&amount>0) (root.querySelector("#fx-reporting-amount") as HTMLInputElement).value=(amount*Number(reporting.rate)).toFixed(2);
        }
      }
      status.textContent=`${result.cached?"Cached":"Fetched"} ${result.source} quote from ${result.quoted_on}: 1 ${result.base_currency} = ${result.rate} ${result.quote_currency}.`;
    }catch(error:any){status.textContent="No rate was applied.";toast(String(error),true);}
  });
  let attachmentPath="";
  let tagsReadSucceeded = false;
  let tagsLoaded=Promise.resolve();
  if(!readOnly) root.querySelector("#pick-attachment")!.addEventListener("click", async()=>{
      const selected=await open({multiple:false,filters:[{name:"Receipts & invoices",extensions:["pdf","png","jpg","jpeg","webp","heic"]}]});
      if(typeof selected==="string"){
        attachmentPath=selected;
        (root.querySelector("#tx-attachment") as HTMLInputElement).value=selected;
      }
    });
  if(existing){
    tagsLoaded=invoke<TagRecord[]>("list_transaction_tags",{transactionId:existing!.id}).then(tags=>{
      (root.querySelector("#tx-tags") as HTMLInputElement).value=tags.map(t=>t.name).join(", ");
      tagsReadSucceeded = true;
    }).catch(()=>{});
    invoke<TransactionAttachment[]>("list_transaction_attachments",{transactionId:existing!.id}).then(files=>{
      (root.querySelector("#tx-existing-files") as HTMLElement).textContent=files.length?`Attached: ${files.map(f=>f.label).join(", ")}`:"No file attached yet.";
    }).catch(()=>{});
  }
  if(readOnly){
    root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>("input, select, textarea").forEach(control=>control.disabled=true);
    (root.querySelector("#pick-attachment") as HTMLButtonElement).disabled=true;
    (root.querySelector("#fx-fetch") as HTMLButtonElement).disabled=true;
    (root.querySelector("#tx-add-split") as HTMLButtonElement).disabled=true;
  }
  const close=()=>root.innerHTML="";
  root.querySelector("#x")!.addEventListener("click",close);
  root.querySelector("#cancel")!.addEventListener("click",close);
  root.querySelector("#bd")!.addEventListener("click",(e)=>{ if(e.target===e.currentTarget) close();});
  if(readOnly) return;
  root.querySelector("#save")!.addEventListener("click", async()=>{
    const kind=(root.querySelector("#tx-kind") as HTMLSelectElement).value;
    const amount=(root.querySelector("#tx-amount") as HTMLInputElement).value.trim();
    const date=(root.querySelector("#tx-date") as HTMLInputElement).value;
    const account=(root.querySelector("#tx-account") as HTMLSelectElement).value;
    const to_account=(root.querySelector("#tx-to") as HTMLSelectElement).value || null;
    const splits=useSplits.checked?splitDrafts.map(line=>({category:line.category,amount:line.amount.trim(),reporting_amount:null,memo:line.memo.trim()||null})):[];
    const category=useSplits.checked?(splits[0]?.category||null):((root.querySelector("#tx-cat") as HTMLSelectElement).value || null);
    const payee=(root.querySelector("#tx-payee") as HTMLInputElement).value.trim() || null;
    const note=(root.querySelector("#tx-note") as HTMLTextAreaElement).value.trim() || null;
    const sourceAccount=accounts.find(item=>item.name===account);
    const targetAccount=accounts.find(item=>item.name===to_account);
    const needsFx=!!sourceAccount && (sourceAccount.currency_code!==currency || (kind==="transfer" && !!targetAccount && targetAccount.currency_code!==sourceAccount.currency_code));
    const to_amount=needsFx ? (root.querySelector("#fx-to-amount") as HTMLInputElement).value.trim() || null : null;
    let reporting_amount=needsFx ? (root.querySelector("#fx-reporting-amount") as HTMLInputElement).value.trim() || null : null;
    const exchange_rate=needsFx ? (root.querySelector("#fx-rate") as HTMLInputElement).value.trim() || null : null;
    const exchange_rate_source=needsFx ? (root.querySelector("#fx-source") as HTMLSelectElement).value : null;
    if(needsFx && sourceAccount?.currency_code===currency) reporting_amount=amount;
    if(needsFx && sourceAccount?.currency_code!==currency && targetAccount?.currency_code!==currency && kind==="transfer" && !reporting_amount){ toast(`Enter the reporting amount in ${currency}, or fetch a Frankfurter rate.`,true); return; }
    if(existing) await tagsLoaded;
    if(existing) await splitsLoaded;
    if(existing && !tagsReadSucceeded){ toast("Unable to load tags. Reopen the transaction before saving.", true); return; }
    if(existing && !splitsReadSucceeded){ toast("Unable to load category splits. Reopen the transaction before saving.", true); return; }
    const tags=Array.from(new Map((root.querySelector("#tx-tags") as HTMLInputElement).value.split(",").map(tag=>tag.trim()).filter(Boolean).map(tag=>[tag.toLocaleLowerCase(),tag])).values());
    if(!amount || !date || !account){ toast("Amount, date and account are required",true); return; }
    if(useSplits.checked&&(splits.length<2||splits.some(line=>!line.category||!line.amount))){toast("Enter at least two complete split lines",true);return;}
    try{
      if(isEdit){
        await invoke("edit_transaction",{req:{
          id:existing!.id, kind, amount, date, account,
          to_account, category, payee, note, to_amount, reporting_amount, exchange_rate, exchange_rate_source, exchange_rate_date:exchange_rate?((root.querySelector("#fx-quoted-on") as HTMLInputElement).value||date):null,
          clear_to_account: kind!=="transfer",
          clear_category: kind==="transfer",
          clear_payee: !payee, clear_note: !note,
          tags, attachment_path: attachmentPath || null, splits
        }});
        toast("Transaction updated");
      }else{
        await invoke<number>("add_transaction",{req:{kind, amount, date, account, to_account, category, payee, note, to_amount, reporting_amount, exchange_rate, exchange_rate_source, exchange_rate_date:exchange_rate?((root.querySelector("#fx-quoted-on") as HTMLInputElement).value||date):null,tags,attachment_path:attachmentPath||null,splits:useSplits.checked?splits:null}});
        toast("Transaction created");
      }
      root.innerHTML=""; await refreshCore();
      // re-render transactions if we're there
      if(view==="transactions") renderTransactions($("#main") as HTMLElement);
      else render();
    }catch(e:any){ toast(String(e),true); }
  });
}

// ---------- Import ----------
let importPreview:ImportResult|null=null;
function renderImport(main:HTMLElement){
  main.innerHTML=`
    <div class="page-head"><h2>Import</h2><p>CSV (25 bank presets + manual mapping), camt.053 XML, OFX and QIF · dry-run preview · duplicate detection · transactional</p></div>
    <div class="tabs">
      <button class="tab active" data-tab="csv">CSV</button>
      <button class="tab" data-tab="camt">camt.053 XML</button>
      <button class="tab" data-tab="ofx">OFX / QFX</button>
      <button class="tab" data-tab="qif">QIF</button>
    </div>
    <div id="import-body"></div>
  `;
  const body=main.querySelector("#import-body") as HTMLElement;
  const switchTab=(tab:string)=>{
    main.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active", (t as HTMLElement).dataset.tab===tab));
    if(tab==="csv") renderCsvImport(body);
    else if(tab==="camt") renderCamtImport(body);
    else renderTextImport(body, tab as "ofx"|"qif");
  };
  main.querySelectorAll("[data-tab]").forEach(b=>b.addEventListener("click",()=>switchTab((b as HTMLElement).dataset.tab!)));
  renderCsvImport(body);
}
function renderCsvImport(body:HTMLElement){
  const presetOpts=`<option value="">— manual / no preset —</option>`+presets.map(p=>`<option value="${esc(p.id)}">${esc(p.label)} [${p.verification}]</option>`).join("");
  const accOpts=accounts.map(a=>`<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("");
  const catOpts=`<option value="">— none —</option>`+categories.map(c=>`<option value="${esc(c.name)}">${esc(c.name)} (${c.kind})</option>`).join("");
  body.innerHTML=`
    <div class="card">
      <div class="grid2">
        <div>
          <div class="field"><label>CSV file</label><div style="display:flex;gap:8px"><input id="csv-path" class="input" readonly placeholder="Pick a file…"/><button class="btn" id="pick-csv">Browse</button></div></div>
          <div class="field"><label>Target account</label><select id="csv-account">${accOpts}</select></div>
          <div class="field"><label>Bank preset (25 formats)</label><select id="csv-preset">${presetOpts}</select></div>
          <div class="small muted" id="preset-info" style="margin-top:-8px;margin-bottom:12px"></div>
          <div class="row">
            <div class="field"><label>Date column</label><input id="csv-date-col" class="input" placeholder="Date"/></div>
            <div class="field"><label>Date format</label><input id="csv-date-fmt" class="input" placeholder="%Y-%m-%d"/></div>
          </div>
          <div class="field"><label>Description column</label><input id="csv-desc-col" class="input" placeholder="Description"/></div>
          <div class="row">
            <div class="field"><label>Amount column (signed)</label><input id="csv-amt-col" class="input" placeholder="Amount"/></div>
            <div class="field"><label>Delimiter</label><input id="csv-delim" class="input" value="," maxlength="1"/></div>
          </div>
          <div class="row">
            <div class="field"><label>Debit column (split)</label><input id="csv-debit" class="input" placeholder="Debit"/></div>
            <div class="field"><label>Credit column (split)</label><input id="csv-credit" class="input" placeholder="Credit"/></div>
          </div>
          <div class="small muted">Use either Amount OR Debit+Credit pair.</div>
          <div style="margin-top:10px" class="row">
            <div class="field"><label>Category column (optional)</label><input id="csv-cat-col" class="input" placeholder="Category"/></div>
            <div class="field"><label>Default category</label><select id="csv-cat-default"><option value="">—</option>${categories.map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("")}</select></div>
          </div>
          <div class="row">
            <div class="field"><label>Income category for uncategorized</label><select id="csv-inc-cat"><option value="">—</option>${categories.filter(c=>c.kind==="income").map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("")}</select></div>
            <div class="field"><label>Expense category for uncategorized</label><select id="csv-exp-cat"><option value="">—</option>${categories.filter(c=>c.kind==="expense").map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("")}</select></div>
          </div>
          <div class="row">
            <div class="field"><label>Payee column</label><input id="csv-payee-col" class="input"/></div>
            <div class="field"><label>Note column</label><input id="csv-note-col" class="input"/></div>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="csv-dry" checked/> Dry run (preview)</label>
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="csv-allow-dup"/> Allow duplicates</label>
          </div>
          <div style="margin-top:12px;display:flex;gap:8px">
            <button class="btn btn-primary" id="csv-run">Preview / Import</button>
            <button class="btn" id="csv-reset">Reset mapping</button>
          </div>
        </div>
        <div>
          <div class="card" style="background:var(--surface-2)">
            <div class="card-title">Preview</div>
            <div id="preview-area" class="small muted">Run a dry-run to see parsed rows. Duplicate detection is shown per row.</div>
          </div>
        </div>
      </div>
    </div>
  `;
  let csvPath="";
  body.querySelector("#pick-csv")!.addEventListener("click", async()=>{
    const sel=await open({filters:[{name:"CSV",extensions:["csv","txt"]}]});
    if(typeof sel==="string"){ csvPath=sel; (body.querySelector("#csv-path") as HTMLInputElement).value=sel; }
  });
  // preset -> load defaults
  body.querySelector("#csv-preset")!.addEventListener("change", async()=>{
    const preset=(body.querySelector("#csv-preset") as HTMLSelectElement).value || null;
    try{
      const d:any = await invoke("csv_mapping_defaults",{req:{preset_id:preset}});
      (body.querySelector("#csv-date-col") as HTMLInputElement).value=d.date_column||"";
      (body.querySelector("#csv-desc-col") as HTMLInputElement).value=d.description_column||"";
      (body.querySelector("#csv-amt-col") as HTMLInputElement).value=d.amount_column||"";
      (body.querySelector("#csv-debit") as HTMLInputElement).value=d.debit_column||"";
      (body.querySelector("#csv-credit") as HTMLInputElement).value=d.credit_column||"";
      (body.querySelector("#csv-date-fmt") as HTMLInputElement).value=d.date_format||"%Y-%m-%d";
      (body.querySelector("#csv-delim") as HTMLInputElement).value=d.delimiter||",";
      (body.querySelector("#preset-info") as HTMLElement).textContent = preset? `${d.preset_id} · delimiter '${d.delimiter}' · ${d.date_format}` : "";
      if(d.category_column) (body.querySelector("#csv-cat-col") as HTMLInputElement).value=d.category_column;
      if(d.payee_column) (body.querySelector("#csv-payee-col") as HTMLInputElement).value=d.payee_column;
      if(d.note_column) (body.querySelector("#csv-note-col") as HTMLInputElement).value=d.note_column;
    }catch(e:any){ toast(String(e),true); }
  });
  body.querySelector("#csv-reset")!.addEventListener("click",()=>{
    ["csv-date-col","csv-desc-col","csv-amt-col","csv-debit","csv-credit","csv-cat-col","csv-payee-col","csv-note-col"].forEach(id=>{
      (body.querySelector("#"+id) as HTMLInputElement).value="";
    });
    (body.querySelector("#csv-date-fmt") as HTMLInputElement).value="%Y-%m-%d";
    (body.querySelector("#csv-delim") as HTMLInputElement).value=",";
  });
  body.querySelector("#csv-run")!.addEventListener("click", async()=>{
    const account=(body.querySelector("#csv-account") as HTMLSelectElement).value;
    if(!csvPath){ toast("Pick a CSV file",true); return; }
    if(!account){ toast("Select target account",true); return; }
    const req:any={
      path: csvPath,
      account,
      preset_id: (body.querySelector("#csv-preset") as HTMLSelectElement).value || null,
      date_column: (body.querySelector("#csv-date-col") as HTMLInputElement).value.trim()||null,
      amount_column: (body.querySelector("#csv-amt-col") as HTMLInputElement).value.trim()||null,
      debit_column: (body.querySelector("#csv-debit") as HTMLInputElement).value.trim()||null,
      credit_column: (body.querySelector("#csv-credit") as HTMLInputElement).value.trim()||null,
      description_column: (body.querySelector("#csv-desc-col") as HTMLInputElement).value.trim()||null,
      category_column: (body.querySelector("#csv-cat-col") as HTMLInputElement).value.trim()||null,
      category: (body.querySelector("#csv-cat-default") as HTMLSelectElement).value||null,
      income_category: (body.querySelector("#csv-inc-cat") as HTMLSelectElement).value||null,
      expense_category: (body.querySelector("#csv-exp-cat") as HTMLSelectElement).value||null,
      payee_column: (body.querySelector("#csv-payee-col") as HTMLInputElement).value.trim()||null,
      note_column: (body.querySelector("#csv-note-col") as HTMLInputElement).value.trim()||null,
      type_column: null, default_kind: null,
      date_format: (body.querySelector("#csv-date-fmt") as HTMLInputElement).value.trim()||null,
      delimiter: (body.querySelector("#csv-delim") as HTMLInputElement).value||null,
      dry_run: (body.querySelector("#csv-dry") as HTMLInputElement).checked,
      allow_duplicates: (body.querySelector("#csv-allow-dup") as HTMLInputElement).checked,
    };
    try{
      const res = await invoke<ImportResult>("import_csv",{req});
      importPreview=res;
      const area=body.querySelector("#preview-area") as HTMLElement;
      area.innerHTML=`
        <div class="small" style="margin-bottom:8px">${res.dry_run?"Dry run":"Imported"} · ${res.imported_count} imported · ${res.duplicate_count} duplicates ${res.dry_run?`<button class="btn btn-sm" id="do-import">Import for real</button>`:""}</div>
        <div style="max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:8px">
          <table><thead><tr><th>#</th><th>Date</th><th>Type</th><th>Amount</th><th>Category</th><th>Payee</th><th>Dup?</th></tr></thead>
          <tbody>${res.preview.slice(0,100).map(r=>`<tr>
            <td class="small">${r.line_number}</td><td class="small">${esc(r.txn_date)}</td><td><span class="badge badge-${r.kind}">${r.kind}</span></td>
            <td class="small" style="font-weight:700">${centsFmt(r.amount_cents)}</td><td class="small">${esc(r.category_name??"")}</td><td class="small">${esc(r.payee??"")}</td><td class="small">${r.duplicate?"⚠ yes":"—"}</td>
          </tr>`).join("")}</tbody></table>
        </div>
        ${res.preview.length>100?`<div class="small muted" style="margin-top:6px">Showing 100 of ${res.preview.length} rows</div>`:""}`;
      if(res.dry_run){
        area.querySelector("#do-import")?.addEventListener("click", async()=>{
          (body.querySelector("#csv-dry") as HTMLInputElement).checked=false;
          (body.querySelector("#csv-run") as HTMLButtonElement).click();
        });
      } else {
        await refreshCore();
      }
    }catch(e:any){ toast(String(e),true); }
  });
}
function renderCamtImport(body:HTMLElement){
  const accOpts=accounts.map(a=>`<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("");
  const incomeOpts=`<option value="">—</option>`+categories.filter(c=>c.kind==="income").map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  const expenseOpts=`<option value="">—</option>`+categories.filter(c=>c.kind==="expense").map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  body.innerHTML=`
    <div class="card">
      <div class="field"><label>camt.053 XML file</label><div style="display:flex;gap:8px"><input id="camt-path" class="input" readonly/><button class="btn" id="pick-camt">Browse</button></div></div>
      <div class="row">
        <div class="field"><label>Target account</label><select id="camt-account">${accOpts}</select></div>
        <div class="field"><label>Income category</label><select id="camt-inc">${incomeOpts}</select></div>
        <div class="field"><label>Expense category</label><select id="camt-exp">${expenseOpts}</select></div>
      </div>
      <div style="display:flex;gap:10px;margin-top:8px">
        <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="camt-dry" checked/> Dry run</label>
        <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="camt-allow-dup"/> Allow duplicates</label>
      </div>
      <div style="margin-top:12px"><button class="btn btn-primary" id="camt-run">Preview / Import</button></div>
      <div id="camt-preview" class="small muted" style="margin-top:12px"></div>
    </div>
  `;
  let camtPath="";
  body.querySelector("#pick-camt")!.addEventListener("click", async()=>{
    const sel=await open({filters:[{name:"XML",extensions:["xml"]}]});
    if(typeof sel==="string"){ camtPath=sel; (body.querySelector("#camt-path") as HTMLInputElement).value=sel; }
  });
  body.querySelector("#camt-run")!.addEventListener("click", async()=>{
    const account=(body.querySelector("#camt-account") as HTMLSelectElement).value;
    if(!camtPath){ toast("Pick an XML file",true); return; }
    const req:any={
      path:camtPath, account,
      income_category:(body.querySelector("#camt-inc") as HTMLSelectElement).value||null,
      expense_category:(body.querySelector("#camt-exp") as HTMLSelectElement).value||null,
      dry_run:(body.querySelector("#camt-dry") as HTMLInputElement).checked,
      allow_duplicates:(body.querySelector("#camt-allow-dup") as HTMLInputElement).checked,
    };
    try{
      const res=await invoke<ImportResult>("import_camt053",{req});
      const area=body.querySelector("#camt-preview") as HTMLElement;
      area.innerHTML=`<div>${res.dry_run?"Dry run":"Imported"} · ${res.imported_count} imported · ${res.duplicate_count} duplicates ${res.dry_run?`<button class="btn btn-sm" id="camt-import-real">Import for real</button>`:""}</div>
        <div style="max-height:300px;overflow:auto;margin-top:8px;border:1px solid var(--border);border-radius:8px"><table><thead><tr><th>#</th><th>Date</th><th>Type</th><th>Amount</th><th>Payee</th></tr></thead><tbody>${res.preview.slice(0,100).map(r=>`<tr><td>${r.line_number}</td><td>${esc(r.txn_date)}</td><td><span class="badge badge-${r.kind}">${r.kind}</span></td><td>${centsFmt(r.amount_cents)}</td><td>${esc(r.payee??"")}</td></tr>`).join("")}</tbody></table></div>`;
      if(res.dry_run){
        area.querySelector("#camt-import-real")?.addEventListener("click", async()=>{
          (body.querySelector("#camt-dry") as HTMLInputElement).checked=false;
          (body.querySelector("#camt-run") as HTMLButtonElement).click();
        });
      } else await refreshCore();
    }catch(e:any){ toast(String(e),true); }
  });
}

function renderTextImport(body:HTMLElement, format:"ofx"|"qif"){
  const label=format==="ofx"?"OFX / QFX":"QIF";
  const extensions=format==="ofx"?["ofx","qfx"]:["qif"];
  const accountOptions=accounts.map(account=>`<option value="${esc(account.name)}">${esc(account.name)} (${esc(account.currency_code)})</option>`).join("");
  const categoryOptions=(kind:"income"|"expense")=>`<option value="">Automatic / uncategorized</option>`+categories.filter(category=>category.kind===kind).map(category=>`<option value="${esc(category.name)}">${esc(category.name)}</option>`).join("");
  body.innerHTML=`<div class="card">
    <div class="field"><label>${label} file</label><div style="display:flex;gap:8px"><input id="text-path" class="input" readonly placeholder="Pick a file…"/><button class="btn" id="text-browse">Browse</button></div></div>
    <div class="row">
      <div class="field"><label>Target account</label><select id="text-account">${accountOptions}</select></div>
      <div class="field"><label>Income category</label><select id="text-income">${categoryOptions("income")}</select></div>
      <div class="field"><label>Expense category</label><select id="text-expense">${categoryOptions("expense")}</select></div>
    </div>
    ${format==="qif"?`<div class="field"><label>QIF date format</label><select id="text-date-format"><option value="%m/%d/%Y">Month / day / year</option><option value="%d/%m/%Y">Day / month / year</option><option value="%d.%m.%Y">Day . month . year</option><option value="%Y-%m-%d">Year - month - day</option></select></div>`:""}
    ${format==="qif"?`<div class="small muted">QIF split transactions and account transfers cannot be imported; the preview reports them.</div>`:""}
    <div style="display:flex;gap:10px;margin-top:8px">
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="text-dry" checked/> Dry run</label>
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="text-allow-duplicates"/> Allow duplicates</label>
    </div>
    <div style="margin-top:12px"><button class="btn btn-primary" id="text-run">Preview / Import</button></div>
    <div id="text-preview" class="small muted" style="margin-top:12px">Preview the parsed transactions before importing.</div>
  </div>`;
  let path="";
  body.querySelector("#text-browse")!.addEventListener("click",async()=>{
    const selected=await open({filters:[{name:label,extensions}]});
    if(typeof selected==="string"){
      path=selected;
      (body.querySelector("#text-path") as HTMLInputElement).value=selected;
    }
  });
  body.querySelector("#text-run")!.addEventListener("click",async()=>{
    if(!path){toast(`Pick a ${label} file`,true);return;}
    const account=(body.querySelector("#text-account") as HTMLSelectElement).value;
    if(!account){toast("Select target account",true);return;}
    const req={
      path,account,
      income_category:(body.querySelector("#text-income") as HTMLSelectElement).value||null,
      expense_category:(body.querySelector("#text-expense") as HTMLSelectElement).value||null,
      date_format:format==="qif"?(body.querySelector("#text-date-format") as HTMLSelectElement).value:null,
      dry_run:(body.querySelector("#text-dry") as HTMLInputElement).checked,
      allow_duplicates:(body.querySelector("#text-allow-duplicates") as HTMLInputElement).checked,
    };
    try{
      const result=await invoke<ImportResult>(format==="ofx"?"import_ofx":"import_qif",{req});
      const area=body.querySelector("#text-preview") as HTMLElement;
      area.innerHTML=`<div>${result.dry_run?"Dry run":"Imported"} · ${result.imported_count} imported · ${result.duplicate_count} duplicates ${result.dry_run?`<button class="btn btn-sm" id="text-import-real">Import for real</button>`:""}</div>
        <div style="max-height:320px;overflow:auto;margin-top:8px;border:1px solid var(--border);border-radius:8px"><table><thead><tr><th>#</th><th>Date</th><th>Type</th><th>Amount</th><th>Category</th><th>Payee</th><th>Dup?</th></tr></thead><tbody>${result.preview.slice(0,100).map(row=>`<tr><td>${row.line_number}</td><td>${esc(row.txn_date)}</td><td><span class="badge badge-${row.kind}">${row.kind}</span></td><td>${centsFmt(row.amount_cents)}</td><td>${esc(row.category_name??"")}</td><td>${esc(row.payee??"")}</td><td>${row.duplicate?"⚠ yes":"—"}</td></tr>`).join("")}</tbody></table></div>
        ${result.preview.length>100?`<div class="small muted">Showing 100 of ${result.preview.length} rows</div>`:""}`;
      if(result.dry_run){
        area.querySelector("#text-import-real")?.addEventListener("click",()=>{
          (body.querySelector("#text-dry") as HTMLInputElement).checked=false;
          (body.querySelector("#text-run") as HTMLButtonElement).click();
        });
      }else await refreshCore();
    }catch(error:any){toast(String(error),true);}
  });
}

// ---------- Budgets ----------
async function renderBudgets(main:HTMLElement){
  const curMonth=monthKey();
  let month=curMonth, scenario="";
  let budgets:any[]=[], status:BudgetStatusRecord[]=[];
  let loadVersion=0;
  async function load(){
    const version=++loadVersion;
    try {
      const result=await Promise.all([invoke<any[]>("list_budgets",{month,scenario:scenario||null}),invoke<BudgetStatusRecord[]>("budget_status",{month,scenario:scenario||null})]);
      if(version!==loadVersion||!main.isConnected||view!=="budgets") return;
      [budgets,status]=result;
    } catch(error) { toast(String(error),true); return; }
    paint();
  }
  function paint(){
    main.innerHTML=`
      <div class="page-head"><h2>Budgets & spending guidance</h2><p>All budgets in ${esc(currency)} · carry balances forward and move money between categories</p></div>
      <div id="budget-safe-spend"></div>
      <div class="card" style="margin-bottom:14px">
        <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="margin:0"><label>Month (YYYY-MM)</label><input id="b-month" class="input" value="${esc(month)}" placeholder="2025-09"/></div>
          <div class="field" style="margin:0"><label>Scenario (override)</label><select id="b-scenario"><option value="">Base (no scenario)</option></select></div>
          <button class="btn" id="b-load">Load</button>
          <button class="btn btn-primary" id="b-add">Set / Update budget</button>
          <button class="btn" id="b-move" ${scenario?'disabled title="Money moves apply to base budgets"':''}>Move money</button>
        </div>
      </div>
      <div class="grid2">
        <div class="card"><div class="card-title">Budget status — ${esc(month)} ${scenario?`· ${esc(scenario)}`:""}</div>
          <div style="display:flex;flex-direction:column;gap:12px">
            ${status.map((s,index)=>{
              const pct = s.budget_cents>0? Math.min(100, Math.round(s.spent_cents/s.budget_cents*100)) : (s.spent_cents>0?100:0);
              const cls = s.over_budget?"over": pct>80?"warn":"ok";
              return `<div>
                <div style="display:flex;justify-content:space-between" class="small"><span><strong>${esc(s.category_name)}</strong> ${s.account_name?`· ${esc(s.account_name)}`:""} ${s.is_override?`<span class="pill">override</span>`:""}</span><span class="${s.over_budget?"amount-neg":""}">${centsFmt(s.spent_cents)} / ${centsFmt(s.budget_cents)}</span></div>
                <div class="budget-components"><span>Allocated ${centsFmt(s.allocated_cents)}</span><span>Carry-in ${centsFmt(s.rollover_cents)}</span><span>Moved ${centsFmt(s.moved_cents)}</span></div>
                <div class="progress"><div class="progress-fill ${cls}" style="width:${pct}%"></div></div>
                <div class="small muted" style="display:flex;justify-content:space-between"><span>${pct}% · ${s.over_budget?`Over by ${centsFmt(s.spent_cents - s.budget_cents)}`:`Remaining ${centsFmt(s.remaining_cents)}`}</span></div>
                <div class="budget-components"><span>${s.rollover_start_month?`Rollover from ${esc(s.rollover_start_month)}`:'Resets each month'}</span>${!scenario?`<button class="btn btn-sm" data-rollover="${index}">Configure rollover</button>`:''}</div>
              </div>`;
            }).join("") || `<div class="muted small">No budgets for this month — set one to see progress.</div>`}
          </div>
        </div>
        <div class="card"><div class="card-title">All budgets ${scenario?`(scenario: ${esc(scenario)})`:""}</div>
          <div class="table-wrap"><table><thead><tr><th>Month</th><th>Category</th><th>Account</th><th>Amount</th><th></th></tr></thead>
          <tbody>${budgets.map(b=>`<tr><td>${esc(b.month)}</td><td>${esc(b.category_name)} ${b.is_override?`<span class="pill">override</span>`:""}</td><td class="small">${esc(b.account_name??"—")}</td><td style="font-weight:700">${centsFmt(b.amount_cents)}</td><td><button class="btn btn-sm" data-del-b="${b.id}" data-cat="${esc(b.category_name)}" data-month="${esc(b.month)}" data-account="${esc(b.account_name??"")}" data-scenario="${b.is_override?esc(scenario):""}">Delete</button></td></tr>`).join("") || `<tr><td colspan="5" class="empty">No budgets</td></tr>`}</tbody></table></div>
        </div>
      </div>
    `;
    void mountSafeSpend(main.querySelector<HTMLElement>("#budget-safe-spend")!,{accounts,currency,format:centsFmt,escape:esc});
    main.querySelector("#b-move")!.addEventListener("click",()=>openBudgetMoveModal(month,status,load));
    main.querySelectorAll<HTMLElement>("[data-rollover]").forEach(button=>button.addEventListener("click",()=>openRolloverModal(status[Number(button.dataset.rollover)],load)));
    // populate scenario select after
    (async()=>{
      try{
        const scenarios=await invoke<PlanningScenarioRecord[]>("list_scenarios");
        (window as any).__scenariosCache=scenarios;
        const sel=main.querySelector("#b-scenario") as HTMLSelectElement;
        if(!sel) return;
        sel.innerHTML=`<option value="">Base (no scenario)</option>`+scenarios.map(s=>`<option value="${esc(s.name)}" ${scenario===s.name?"selected":""}>${esc(s.name)}</option>`).join("");
      }catch{}
    })();
    main.querySelector("#b-load")!.addEventListener("click",()=>{
      month=(main.querySelector("#b-month") as HTMLInputElement).value.trim()||curMonth;
      scenario=(main.querySelector("#b-scenario") as HTMLSelectElement).value;
      load();
    });
    main.querySelector("#b-add")!.addEventListener("click",()=>openBudgetModal(month, scenario));
    main.querySelectorAll("[data-del-b]").forEach(b=>b.addEventListener("click", async()=>{
      const el=b as HTMLElement;
      const cat=el.dataset.cat!, m=el.dataset.month!;
      const account=el.dataset.account||null, budgetScenario=el.dataset.scenario||null;
      if(!confirm(`Delete budget for ${cat} in ${m}?`)) return;
      try{ await invoke("delete_budget",{month:m, category:cat, account, scenario:budgetScenario}); toast("Budget deleted"); load(); }catch(e:any){ toast(String(e),true); }
    }));
  }
  await load();
}
function budgetActionModal(title:string,body:string,onSave:(root:HTMLElement)=>Promise<void>){
  const root=document.getElementById("modal-root")!;
  root.innerHTML=`<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h3>${esc(title)}</h3><button class="btn btn-ghost" data-close aria-label="Close">✕</button></div><div class="modal-body">${body}<p data-error class="amount-neg small" role="status"></p></div><div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>Save</button></div></div></div>`;
  const close=()=>{root.innerHTML="";};
  root.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",close));
  root.querySelector<HTMLButtonElement>("[data-save]")!.addEventListener("click",async event=>{
    const button=event.currentTarget as HTMLButtonElement;
    button.disabled=true;
    try{await onSave(root);close();}catch(error){root.querySelector<HTMLElement>("[data-error]")!.textContent=String(error);button.disabled=false;}
  });
  root.querySelector<HTMLElement>("input,select")?.focus();
  return root;
}

function openRolloverModal(row:BudgetStatusRecord,reload:()=>Promise<void>){
  budgetActionModal(`Rollover · ${row.category_name}`,`
    <p class="small muted">${esc(row.account_name??"All accounts")} · ${esc(currency)}. Both unspent money and overspending carry forward. Monthly allocations are entered separately; a missing month adds no new money.</p>
    <label class="field"><span>Rollover</span><select id="rollover-enabled"><option value="on">Carry balances forward</option><option value="off" ${!row.rollover_start_month?'selected':''}>Reset each month</option></select></label>
    <label class="field"><span>Start month</span><input class="input" type="month" id="rollover-start" value="${esc(row.rollover_start_month??row.month)}"/></label>
    <p class="small muted">Changing the start or turning rollover off recalculates this category’s history. Scenario views inherit this policy, but use their own budget overrides.</p>`,async root=>{
      const enabled=(root.querySelector("#rollover-enabled") as HTMLSelectElement).value==='on';
      const start=(root.querySelector("#rollover-start") as HTMLInputElement).value;
      if(enabled&&!start) throw new Error("Choose a start month.");
      await invoke("set_budget_rollover",{category:String(row.category_id),account:row.account_id===null?null:String(row.account_id),startMonth:enabled?start:null});
      await reload();toast("Rollover updated");
    });
}

function openBudgetMoveModal(month:string,status:BudgetStatusRecord[],reload:()=>Promise<void>){
  const sources=status.filter(s=>s.remaining_cents>0);
  if(!sources.length){toast("No category has money available to move.",true);return;}
  const root=budgetActionModal("Move budget money",`
    <p class="small muted">${esc(month)} · ${esc(currency)}. Moves change category allocations in the same account scope. Bank balances stay the same.</p>
    <label class="field"><span>From category</span><select id="move-from">${sources.map((s,i)=>`<option value="${i}">${esc(s.category_name)} · ${esc(s.account_name??'All accounts')} · ${centsFmt(s.remaining_cents)} available</option>`).join('')}</select></label>
    <label class="field"><span>To category</span><select id="move-to"></select></label>
    <label class="field"><span>Amount (${esc(currency)})</span><input class="input" id="move-amount" inputmode="decimal" placeholder="0.00"/></label>`,async root=>{
      const source=sources[Number((root.querySelector("#move-from") as HTMLSelectElement).value)];
      const to=(root.querySelector("#move-to") as HTMLSelectElement).value;
      if(!to) throw new Error("Set another category budget in the same account scope first.");
      await invoke("move_budget_money",{month,from:String(source.category_id),to,account:source.account_id===null?null:String(source.account_id),amount:(root.querySelector("#move-amount") as HTMLInputElement).value});
      await reload();toast("Budget money moved");
    });
  const fill=()=>{
    const source=sources[Number((root.querySelector("#move-from") as HTMLSelectElement).value)];
    root.querySelector<HTMLSelectElement>("#move-to")!.innerHTML=status.filter(s=>s.category_id!==source.category_id&&s.account_id===source.account_id).map(s=>`<option value="${s.category_id}">${esc(s.category_name)} · ${centsFmt(s.remaining_cents)} remaining</option>`).join('');
  };
  root.querySelector("#move-from")!.addEventListener("change",fill);fill();
}

function openBudgetModal(month:string, scenario:string){
  const root=document.getElementById("modal-root")!;
  const expenseCats=categories.filter(c=>c.kind==="expense");
  root.innerHTML=`
    <div class="modal-backdrop" id="bd">
      <div class="modal">
        <div class="modal-head"><h3>Set budget</h3><button class="btn btn-ghost" id="x">✕</button></div>
        <div class="modal-body">
          <div class="field"><label>Month (YYYY-MM)</label><input id="bm" class="input" value="${esc(month)}"/></div>
          <div class="field"><label>Category (expense)</label><select id="bc">${expenseCats.map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("")}</select></div>
          <div class="field"><label>Monthly allocation (${esc(currency)})</label><input id="ba" class="input" placeholder="25000.00"/></div>
          <div class="field"><label>Account (optional)</label><select id="bacc"><option value="">— all accounts —</option>${accounts.map(a=>`<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("")}</select></div>
          <div class="field"><label>Scenario (optional override)</label><input id="bsc" class="input" value="${esc(scenario)}" placeholder="leave empty for base budget"/></div>
        </div>
        <div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn btn-primary" id="save">Save</button></div>
      </div>
    </div>`;
  const close=()=>root.innerHTML="";
  root.querySelector("#x")!.addEventListener("click",close);
  root.querySelector("#cancel")!.addEventListener("click",close);
  root.querySelector("#bd")!.addEventListener("click",(e)=>{ if(e.target===e.currentTarget) close();});
  root.querySelector("#save")!.addEventListener("click", async()=>{
    const m=(root.querySelector("#bm") as HTMLInputElement).value.trim();
    const cat=(root.querySelector("#bc") as HTMLSelectElement).value;
    const amount=(root.querySelector("#ba") as HTMLInputElement).value.trim();
    const acc=(root.querySelector("#bacc") as HTMLSelectElement).value || null;
    const scen=(root.querySelector("#bsc") as HTMLInputElement).value.trim() || null;
    if(!m||!cat||!amount){ toast("Month, category and amount required",true); return; }
    try{ await invoke("set_budget",{month:m, category:cat, amount, account:acc, scenario:scen}); toast("Budget saved"); root.innerHTML=""; await refreshCore(); if(view==="budgets") renderBudgets($("#main") as HTMLElement); }catch(e:any){ toast(String(e),true); }
  });
}

function highlightSelectedRecurringRow(main:HTMLElement, id:number){
  main.querySelectorAll<HTMLElement>("[data-recurring-id]").forEach(r=>{
    const isThis = Number(r.dataset.recurringId) === id;
    r.classList.toggle("is-selected", isThis);
    const badge = r.querySelector(".recurring-active-badge");
    const btn = r.querySelector(".recurring-name-btn");
    btn?.classList.toggle("is-active", isThis);
    if(isThis && !badge){
      btn?.insertAdjacentHTML("beforeend", `<span class="recurring-active-badge">Selected</span>`);
    } else if(!isThis && badge){
      badge.remove();
    }
  });
}

function computeProjectedOccurrences(rule: RecurringRuleRecord, count: number): string[] {
  const result: string[] = [];
  const start = new Date(rule.next_due_on + "T12:00:00");
  if(isNaN(start.getTime())) return result;

  let current = new Date(start);
  const endLimit = rule.end_on ? new Date(rule.end_on + "T23:59:59") : null;
  const interval = Math.max(1, rule.interval);

  for(let i = 0; i < count; i++){
    if(endLimit && current > endLimit) break;
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, "0");
    const d = String(current.getDate()).padStart(2, "0");
    result.push(`${y}-${m}-${d}`);

    if(rule.cadence === "weekly"){
      current.setDate(current.getDate() + 7 * interval);
    } else {
      const targetDay = rule.day_of_month ?? current.getDate();
      current.setMonth(current.getMonth() + interval);
      const daysInTargetMonth = new Date(current.getFullYear(), current.getMonth() + 1, 0).getDate();
      current.setDate(Math.min(targetDay, daysInTargetMonth));
    }
  }
  return result;
}

async function renderRecurringDetails(container:HTMLElement, ruleId:number, allRules:RecurringRuleRecord[]){
  const renderVersion = ++recurringDetailRenderVersion;
  const rule = allRules.find(r => r.id === ruleId);
  if(!rule){
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
    <div class="recurring-detail-loading">
      <div class="small muted">Loading analytics and execution history for <strong>${esc(rule.name)}</strong>…</div>
    </div>
  `;

  const acc = accounts.find(a => a.id === rule.account_id || a.name === rule.account_name);
  const accCur = acc?.currency_code ?? currency;

  let historyTxns: TransactionRecord[] = [];
  let forecast: ForecastSnapshot | null = null;
  try {
    const [txAll, fc] = await Promise.all([
      invoke<TransactionRecord[]>("list_transactions", {
        req: { limit: 500, include_deleted: false, sort_by: "date", sort_dir: "desc" }
      }).catch(() => []),
      invoke<ForecastSnapshot>("get_forecast", { account: rule.account_name, days: 90, scenario: null }).catch(() => null)
    ]);
    historyTxns = (txAll || []).filter(t => {
      if(t.recurring_rule_id === rule.id) return true;
      if(t.kind !== rule.kind) return false;
      const tAcc = t.account_name === rule.account_name;
      if(!tAcc) return false;
      if(rule.payee && t.payee && t.payee.toLowerCase().trim() === rule.payee.toLowerCase().trim()) return true;
      if(rule.category_name && t.category_name === rule.category_name && t.amount_cents === rule.amount_cents) return true;
      return false;
    });
    forecast = fc;
  } catch {}

  if(renderVersion !== recurringDetailRenderVersion || selectedRecurringRuleId !== ruleId) return;

  const totalExecCount = historyTxns.length;
  const totalExecCents = historyTxns.reduce((sum, t) => sum + (rule.kind === "transfer" && t.to_account_id === rule.account_id ? (t.to_amount_cents ?? t.amount_cents) : t.amount_cents), 0);
  const lastExecuted = historyTxns.length > 0 ? historyTxns[0] : null;

  const today = todayISO();
  let annualMultiplier = 12;
  if(rule.cadence === "weekly"){
    annualMultiplier = 52 / Math.max(1, rule.interval);
  } else {
    annualMultiplier = 12 / Math.max(1, rule.interval);
  }
  const estAnnualCents = Math.round(rule.amount_cents * annualMultiplier);
  const estMonthlyCents = Math.round(estAnnualCents / 12);

  const isOverdue = !rule.paused && rule.next_due_on < today;
  const isDueToday = !rule.paused && rule.next_due_on === today;

  let dueBadge = "";
  if(rule.paused){
    dueBadge = `<span class="pill">Paused</span>`;
  } else if(isOverdue){
    dueBadge = `<span class="badge badge-expense">Overdue (${esc(rule.next_due_on)})</span>`;
  } else if(isDueToday){
    dueBadge = `<span class="badge badge-warn" style="background:var(--warn);color:#fff">Due Today</span>`;
  } else {
    dueBadge = `<span class="badge badge-income">Due ${esc(rule.next_due_on)}</span>`;
  }

  const scheduleSummary = rule.cadence === "monthly"
    ? (rule.interval === 1 ? `Every month on day ${rule.day_of_month ?? 1}` : `Every ${rule.interval} months on day ${rule.day_of_month ?? 1}`)
    : (rule.interval === 1 ? `Weekly on ${esc(rule.weekday ?? "Mon")}` : `Every ${rule.interval} weeks on ${esc(rule.weekday ?? "Mon")}`);

  const upcomingOccurrences = computeProjectedOccurrences(rule, 6);

  const matchedUpcomingBills = (forecast?.bill_calendar ?? []).filter(b => {
    const titleMatch = b.title.toLowerCase().includes(rule.name.toLowerCase()) || (rule.payee && b.title.toLowerCase().includes(rule.payee.toLowerCase()));
    return titleMatch || (b.amount_cents === rule.amount_cents && b.account_name === rule.account_name);
  }).slice(0, 5);

  container.innerHTML = `
    <div class="recurring-detail-section">
      <div class="recurring-detail-head">
        <div>
          <div class="recurring-detail-title-wrap">
            <h3 class="recurring-detail-title">${esc(rule.name)}</h3>
            <span class="badge badge-${rule.kind}">${rule.kind}</span>
            <span class="pill">${esc(accCur)}</span>
            ${dueBadge}
            <span class="muted small">Rule #${rule.id}</span>
          </div>
          <div class="small muted" style="margin-top:4px">
            ${scheduleSummary} · Active since ${esc(rule.start_on)}${rule.end_on ? ` until ${esc(rule.end_on)}` : " (no end date)"}
            ${rule.payee ? ` · Payee: <strong>${esc(rule.payee)}</strong>` : ""}
          </div>
        </div>
        <div class="recurring-detail-actions">
          <button class="btn btn-primary btn-sm" id="rec-act-post-now">⚡ Post Transaction Now</button>
          ${rule.paused
            ? `<button class="btn btn-sm" id="rec-act-resume">▶ Resume</button>`
            : `<button class="btn btn-sm" id="rec-act-pause">⏸ Pause</button>`}
          <button class="btn btn-sm" id="rec-act-edit">✏️ Edit Rule</button>
          <button class="btn btn-sm" id="rec-act-view-ledger">📜 Ledger Activity (${totalExecCount})</button>
          <button class="btn btn-sm" id="rec-act-delete" style="color:var(--danger)">Delete</button>
        </div>
      </div>

      ${isOverdue ? `
        <div class="recurring-detail-alert">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div>
            <strong>Payment Past Due:</strong> This recurring rule was scheduled for <strong>${esc(rule.next_due_on)}</strong>. Click <strong>"Post Transaction Now"</strong> or use the top <strong>"Run due…"</strong> button to log it into your ledger.
          </div>
        </div>
      ` : ""}

      <div class="stat-grid">
        <div class="card stat">
          <div class="label">Amount per Occurrence</div>
          <div class="value ${rule.kind === 'income' ? 'text-positive' : (rule.kind === 'expense' ? 'text-negative' : 'text-info')}">
            ${rule.kind === 'income' ? '+' : (rule.kind === 'expense' ? '-' : '')}${centsFmt(rule.amount_cents, accCur)}
          </div>
          <div class="sub">${rule.kind} via ${esc(rule.account_name)}${rule.to_account_name ? ` → ${esc(rule.to_account_name)}` : ""}</div>
        </div>

        <div class="card stat">
          <div class="label">Estimated Monthly Impact</div>
          <div class="value ${rule.kind === 'income' ? 'text-positive' : (rule.kind === 'expense' ? 'text-negative' : 'text-info')}">
            ~${centsFmt(estMonthlyCents, accCur)}/mo
          </div>
          <div class="sub">Normalized for monthly budgeting</div>
        </div>

        <div class="card stat">
          <div class="label">Estimated Annual Impact</div>
          <div class="value ${rule.kind === 'income' ? 'text-positive' : (rule.kind === 'expense' ? 'text-negative' : 'text-info')}">
            ~${centsFmt(estAnnualCents, accCur)}/yr
          </div>
          <div class="sub">Projected over next 12 months</div>
        </div>

        <div class="card stat">
          <div class="label">Next Scheduled Date</div>
          <div class="value" style="font-size:16px">${esc(rule.next_due_on)}</div>
          <div class="sub">${rule.paused ? 'Paused (will not auto-run)' : (isOverdue ? 'Needs attention (overdue)' : 'On schedule')}</div>
        </div>

        <div class="card stat">
          <div class="label">Total Historical Executions</div>
          <div class="value">${totalExecCount}</div>
          <div class="sub">Transactions logged to date</div>
        </div>

        <div class="card stat">
          <div class="label">Total Amount Logged</div>
          <div class="value ${rule.kind === 'income' ? 'text-positive' : (rule.kind === 'expense' ? 'text-negative' : 'text-info')}">
            ${centsFmt(totalExecCents, accCur)}
          </div>
          <div class="sub">Cumulative ledger lifetime total</div>
        </div>

        <div class="card stat">
          <div class="label">Last Executed Date</div>
          <div class="value" style="font-size:16px">${lastExecuted ? esc(lastExecuted.txn_date) : "None yet"}</div>
          <div class="sub">${lastExecuted ? centsFmt(lastExecuted.amount_cents, accCur) : "Awaiting first run"}</div>
        </div>

        <div class="card stat">
          <div class="label">Cadence & Cycle</div>
          <div class="value" style="font-size:15px;text-transform:capitalize">${rule.cadence} ×${rule.interval}</div>
          <div class="sub">${rule.cadence === 'weekly' ? `Every ${esc(rule.weekday ?? 'Mon')}` : `Day ${rule.day_of_month ?? 1} of month`}</div>
        </div>
      </div>

      <div class="grid2">
        <div class="card">
          <div class="card-head-row">
            <div>
              <div class="card-title">Schedule & Rule Specifications</div>
              <div class="small muted">Full configuration and metadata for this recurring schedule</div>
            </div>
            <span class="pill ${rule.paused ? '' : 'pill-success'}">${rule.paused ? 'Paused' : 'Active'}</span>
          </div>
          <div class="account-item-list">
            <div class="account-item-row">
              <div><strong>Account</strong><div class="small muted">Source account for transactions</div></div>
              <div style="text-align:right"><span class="pill">${esc(rule.account_name)}</span> <span class="small muted">(${esc(accCur)})</span></div>
            </div>
            ${rule.to_account_name ? `
              <div class="account-item-row">
                <div><strong>Destination Account</strong><div class="small muted">Target account for transfers</div></div>
                <div style="text-align:right"><span class="pill">${esc(rule.to_account_name)}</span></div>
              </div>
            ` : ""}
            <div class="account-item-row">
              <div><strong>Category</strong><div class="small muted">Classification for budgeting & reports</div></div>
              <div>${rule.category_name ? `<span class="badge badge-cash">${esc(rule.category_name)}</span>` : '<span class="muted small">— None —</span>'}</div>
            </div>
            <div class="account-item-row">
              <div><strong>Payee / Merchant</strong><div class="small muted">Recipient or payer name</div></div>
              <div><strong>${rule.payee ? esc(rule.payee) : '<span class="muted small">— Not specified —</span>'}</strong></div>
            </div>
            <div class="account-item-row">
              <div><strong>Start Date</strong><div class="small muted">Initial schedule starting anchor</div></div>
              <div>${esc(rule.start_on)}</div>
            </div>
            <div class="account-item-row">
              <div><strong>End Date</strong><div class="small muted">Automatic expiration date</div></div>
              <div>${rule.end_on ? esc(rule.end_on) : '<span class="pill">No expiration (ongoing)</span>'}</div>
            </div>
            ${rule.note ? `
              <div class="account-item-row" style="flex-direction:column;align-items:flex-start">
                <div><strong>Note / Memo</strong></div>
                <div class="small muted" style="margin-top:2px">${esc(rule.note)}</div>
              </div>
            ` : ""}
          </div>
        </div>

        <div class="card">
          <div class="card-head-row">
            <div>
              <div class="card-title">Upcoming Forecast Projection</div>
              <div class="small muted">Projected next occurrences and cash flow schedule</div>
            </div>
            <span class="pill">${upcomingOccurrences.length} projected</span>
          </div>
          <div class="account-item-list">
            ${upcomingOccurrences.length ? upcomingOccurrences.map((dateStr, idx) => {
              const isFirst = idx === 0;
              return `
                <div class="account-item-row">
                  <div>
                    <div style="display:flex;gap:6px;align-items:center">
                      <strong>${esc(dateStr)}</strong>
                      ${isFirst ? `<span class="badge badge-cash">Next Due</span>` : ""}
                    </div>
                    <div class="small muted">${rule.name} · ${rule.kind}</div>
                  </div>
                  <div style="font-weight:700" class="${rule.kind === 'income' ? 'text-positive' : (rule.kind === 'expense' ? 'text-negative' : 'text-info')}">
                    ${rule.kind === 'income' ? '+' : (rule.kind === 'expense' ? '-' : '')}${centsFmt(rule.amount_cents, accCur)}
                  </div>
                </div>
              `;
            }).join("") : `<div class="muted small" style="padding:16px 0">No future occurrences projected (rule may have ended).</div>`}

            ${matchedUpcomingBills.length ? `
              <div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-top:8px">From 90-Day Cash Flow Forecast</div>
              ${matchedUpcomingBills.map(b => `
                <div class="account-item-row">
                  <div>
                    <strong>${esc(b.title)}</strong>
                    <div class="small muted">${esc(b.date)} · ${esc(b.account_name)}</div>
                  </div>
                  <div style="font-weight:700">${centsFmt(b.amount_cents, accCur)}</div>
                </div>
              `).join("")}
            ` : ""}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head-row">
          <div>
            <div class="card-title">Matched Historical Ledger Activity</div>
            <div class="small muted">Transactions in your ledger posted from or matching this recurring rule (${totalExecCount})</div>
          </div>
          <button class="btn btn-sm" id="rec-view-all-txns">Filter in full Ledger →</button>
        </div>
        <div class="table-wrap">
          <table class="account-tx-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Account</th>
                <th>Payee / Description</th>
                <th>Category</th>
                <th>Reconciliation</th>
                <th style="text-align:right">Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${historyTxns.length ? historyTxns.slice(0, 10).map(t => {
                const isTransferIn = t.kind === "transfer" && t.to_account_id === rule.account_id;
                const isInflow = t.kind === "income" || isTransferIn;
                const amountCents = isTransferIn ? (t.to_amount_cents ?? t.amount_cents) : t.amount_cents;
                const desc = t.kind === "transfer"
                  ? (isTransferIn ? `Transfer from ${esc(t.account_name)}` : `Transfer to ${esc(t.to_account_name ?? "")}`)
                  : esc(t.payee || t.category_name || "—");
                const reconPill = t.reconciliation_id
                  ? `<span class="pill pill-success" title="Reconciled in #${t.reconciliation_id}">✓ Cleared</span>`
                  : `<span class="pill pill-muted">Pending</span>`;
                return `<tr>
                  <td class="small">${esc(t.txn_date)}</td>
                  <td><span class="badge badge-${t.kind}">${t.kind}</span></td>
                  <td><span class="pill">${esc(t.account_name)}</span></td>
                  <td>
                    <strong>${desc}</strong>
                    ${t.note ? `<div class="muted small">${esc(t.note)}</div>` : ''}
                  </td>
                  <td class="small muted">${t.kind === "transfer" ? "—" : esc(t.category_name ?? "—")}</td>
                  <td>${reconPill}</td>
                  <td style="text-align:right;font-weight:700">
                    ${isInflow ? `<span class="text-positive">+${centsFmt(amountCents, accCur)}</span>` : `<span class="text-negative">-${centsFmt(amountCents, accCur)}</span>`}
                  </td>
                  <td style="text-align:right">
                    <button class="btn btn-sm" data-rec-tx-id="${t.id}">View</button>
                  </td>
                </tr>`;
              }).join("") : `
                <tr>
                  <td colspan="8" class="empty">No past transactions found for this recurring rule yet. Click "Post Transaction Now" or use "Run due…" to execute.</td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
        ${historyTxns.length > 10 ? `
          <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center">
            <span class="small muted">Showing 10 of ${totalExecCount} matched transactions</span>
            <button class="btn btn-sm" id="rec-view-more-txns">View all in Ledger →</button>
          </div>
        ` : ""}
      </div>
    </div>
  `;

  // Action listeners
  container.querySelector("#rec-act-post-now")?.addEventListener("click", async () => {
    try {
      const n = await invoke<number>("run_recurring", { through: today });
      if(n > 0) {
        toast(`Posted transaction for ${rule.name}`);
      } else {
        // If next_due_on is in the future, run through the next_due_on date
        const nFuture = await invoke<number>("run_recurring", { through: rule.next_due_on });
        toast(`Posted ${nFuture} transaction(s) through ${rule.next_due_on}`);
      }
      await refreshCore();
      renderRecurring($("#main") as HTMLElement);
    } catch(e:any) {
      toast(String(e), true);
    }
  });

  container.querySelector("#rec-act-pause")?.addEventListener("click", async () => {
    try {
      await invoke("pause_recurring", { id: rule.id });
      toast("Rule paused");
      renderRecurring($("#main") as HTMLElement);
    } catch(e:any) {
      toast(String(e), true);
    }
  });

  container.querySelector("#rec-act-resume")?.addEventListener("click", async () => {
    try {
      await invoke("resume_recurring", { id: rule.id });
      toast("Rule resumed");
      renderRecurring($("#main") as HTMLElement);
    } catch(e:any) {
      toast(String(e), true);
    }
  });

  container.querySelector("#rec-act-edit")?.addEventListener("click", () => {
    openRecurringModal(rule);
  });

  container.querySelector("#rec-act-delete")?.addEventListener("click", async () => {
    if(!confirm(`Delete recurring rule "${rule.name}"?`)) return;
    try {
      await invoke("delete_recurring", { id: rule.id });
      toast("Rule deleted");
      if(selectedRecurringRuleId === rule.id) selectedRecurringRuleId = null;
      renderRecurring($("#main") as HTMLElement);
    } catch(e:any) {
      toast(String(e), true);
    }
  });

  const openLedgerForRecurring = () => {
    navigateTo(()=>{
      txFilters = {
        from: "",
        to: "",
        accounts: [rule.account_name],
        categories: rule.category_name ? [rule.category_name] : [],
        kinds: [rule.kind],
        search: rule.payee || rule.name,
        include_deleted: false,
        limit: 100,
        sort_by: "date",
        sort_dir: "desc"
      };
      view = "transactions";
    });
  };

  container.querySelector("#rec-act-view-ledger")?.addEventListener("click", openLedgerForRecurring);
  container.querySelector("#rec-view-all-txns")?.addEventListener("click", openLedgerForRecurring);
  container.querySelector("#rec-view-more-txns")?.addEventListener("click", openLedgerForRecurring);

  container.querySelectorAll<HTMLElement>("[data-rec-tx-id]").forEach(b => {
    b.addEventListener("click", () => {
      const id = Number(b.dataset.recTxId);
      const tx = historyTxns.find(x => x.id === id);
      if(tx) openTxnModal(tx, false, true);
    });
  });
}

// ---------- Recurring ----------
async function renderRecurring(main:HTMLElement){
  let rules:RecurringRuleRecord[]=[];
  try{ rules=await invoke<RecurringRuleRecord[]>("list_recurring"); }catch{}

  if(selectedRecurringRuleId === null && rules.length > 0){
    selectedRecurringRuleId = rules[0].id;
  }
  if(selectedRecurringRuleId !== null && !rules.some(r => r.id === selectedRecurringRuleId)){
    selectedRecurringRuleId = rules.length > 0 ? rules[0].id : null;
  }

  main.innerHTML=`
    <div class="page-head" style="display:flex;justify-content:space-between;align-items:flex-end">
      <div><h2>Recurring transactions</h2><p>Click any recurring rule name to view detailed insights, future projections, and historical executions</p></div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="run-due">Run due…</button>
        <button class="btn btn-primary" id="add-rec">+ Rule</button>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Type</th><th>Amount</th><th>Account</th><th>Cadence</th><th>Next due</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rules.map(r=>{
          const isSelected = r.id === selectedRecurringRuleId;
          return `<tr class="recurring-row ${isSelected ? 'is-selected' : ''}" data-recurring-id="${r.id}">
            <td>
              <button type="button" class="recurring-name-btn ${isSelected ? 'is-active' : ''}" data-select-rec="${r.id}" title="Click to view details for ${esc(r.name)}">
                <span class="recurring-name-text">${esc(r.name)}</span>
                <span class="muted small">#${r.id}</span>
                ${isSelected ? '<span class="recurring-active-badge">Selected</span>' : ''}
              </button>
              <div class="small muted">${esc(r.category_name??"")}${r.payee?` · ${esc(r.payee)}`:""}</div>
            </td>
            <td><span class="badge badge-${r.kind}">${r.kind}</span></td>
            <td style="font-weight:700">${centsFmt(r.amount_cents)}</td>
            <td class="small">${esc(r.account_name)}${r.to_account_name?` → ${esc(r.to_account_name)}`:""}</td>
            <td class="small">${r.cadence} ×${r.interval} ${r.cadence==="weekly"?`(${esc(r.weekday??"")})`:`(day ${r.day_of_month})`}</td>
            <td class="small">${esc(r.next_due_on)}<div class="small muted">${r.start_on} ${r.end_on?`→ ${r.end_on}`:""}</div></td>
            <td>${r.paused?`<span class="pill">paused</span>`:`<span class="badge badge-income">active</span>`}</td>
            <td><div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn btn-sm" data-edit-rec="${r.id}">Edit</button>
              ${r.paused?`<button class="btn btn-sm" data-resume="${r.id}">Resume</button>`:`<button class="btn btn-sm" data-pause="${r.id}">Pause</button>`}
              <button class="btn btn-sm" data-del-rec="${r.id}">Delete</button>
            </div></td>
          </tr>`;
        }).join("") || `<tr><td colspan="8" class="empty">No recurring rules</td></tr>`}
      </tbody>
    </table></div>
    <div id="recurring-detail-root" class="recurring-detail-root"></div>
  `;

  const detailRoot = main.querySelector("#recurring-detail-root") as HTMLElement;
  const selectRule = (id:number) => {
    if(selectedRecurringRuleId === id) return;
    pushNavigationState();
    selectedRecurringRuleId = id;
    highlightSelectedRecurringRow(main, id);
    if(detailRoot) renderRecurringDetails(detailRoot, id, rules);
    updateTopbarBackButton();
  };

  main.querySelectorAll<HTMLElement>("[data-select-rec]").forEach(btn=>{
    btn.addEventListener("click",(e)=>{
      e.stopPropagation();
      selectRule(Number(btn.dataset.selectRec));
    });
  });

  main.querySelectorAll<HTMLElement>("[data-recurring-id]").forEach(row=>{
    row.addEventListener("click",(e)=>{
      if((e.target as HTMLElement).closest("button")) return;
      selectRule(Number(row.dataset.recurringId));
    });
  });

  main.querySelector("#add-rec")!.addEventListener("click",()=>openRecurringModal());
  main.querySelector("#run-due")!.addEventListener("click", async()=>{
    const through=prompt("Run recurring through date (YYYY-MM-DD)", todayISO());
    if(!through) return;
    try{ const n=await invoke<number>("run_recurring",{through}); toast(`Posted ${n} transactions through ${through}`); renderRecurring(main); }catch(e:any){ toast(String(e),true); }
  });
  main.querySelectorAll("[data-edit-rec]").forEach(b=>b.addEventListener("click",(e)=>{
    e.stopPropagation();
    const id=Number((b as HTMLElement).dataset.editRec);
    openRecurringModal(rules.find(x=>x.id===id)!);
  }));
  main.querySelectorAll("[data-pause]").forEach(b=>b.addEventListener("click", async(e)=>{
    e.stopPropagation();
    const id=Number((b as HTMLElement).dataset.pause);
    try{ await invoke("pause_recurring",{id}); toast("Paused"); renderRecurring(main); }catch(e:any){ toast(String(e),true); }
  }));
  main.querySelectorAll("[data-resume]").forEach(b=>b.addEventListener("click", async(e)=>{
    e.stopPropagation();
    const id=Number((b as HTMLElement).dataset.resume);
    try{ await invoke("resume_recurring",{id}); toast("Resumed"); renderRecurring(main); }catch(e:any){ toast(String(e),true); }
  }));
  main.querySelectorAll("[data-del-rec]").forEach(b=>b.addEventListener("click", async(e)=>{
    e.stopPropagation();
    const id=Number((b as HTMLElement).dataset.delRec);
    if(!confirm("Delete this recurring rule?")) return;
    try{
      await invoke("delete_recurring",{id});
      toast("Deleted");
      if(selectedRecurringRuleId === id) selectedRecurringRuleId = null;
      renderRecurring(main);
    }catch(e:any){ toast(String(e),true); }
  }));

  if(selectedRecurringRuleId !== null && detailRoot){
    renderRecurringDetails(detailRoot, selectedRecurringRuleId, rules);
  }
}
function openRecurringModal(existing?:RecurringRuleRecord){
  const root=document.getElementById("modal-root")!;
  root.innerHTML=`
    <div class="modal-backdrop" id="bd">
      <div class="modal" style="max-width:640px">
        <div class="modal-head"><h3>${existing?"Edit rule":"New recurring rule"}</h3><button class="btn btn-ghost" id="x">✕</button></div>
        <div class="modal-body">
          <div class="field"><label>Name</label><input id="r-name" class="input" value="${esc(existing?.name??"")}"/></div>
          <div class="row">
            <div class="field"><label>Kind</label><select id="r-kind"><option value="expense">expense</option><option value="income">income</option><option value="transfer">transfer</option></select></div>
            <div class="field"><label>Amount</label><input id="r-amount" class="input" value="${existing?(existing.amount_cents/100).toFixed(2):""}"/></div>
            <div class="field"><label>Cadence</label><select id="r-cad"><option value="monthly">monthly</option><option value="weekly">weekly</option></select></div>
          </div>
          <div class="row">
            <div class="field"><label>Account</label><select id="r-acc">${accounts.map(a=>`<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("")}</select></div>
            <div class="field"><label>To account (transfer)</label><select id="r-to"><option value="">—</option>${accounts.map(a=>`<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("")}</select></div>
          </div>
          <div class="field"><label>Category</label><select id="r-cat"><option value="">—</option>${categories.map(c=>`<option value="${esc(c.name)}" data-kind="${c.kind}">${esc(c.name)} (${c.kind})</option>`).join("")}</select></div>
          <div class="row">
            <div class="field"><label>Interval</label><input id="r-interval" class="input" type="number" min="1" value="${existing?.interval??1}"/></div>
            <div class="field" id="wrap-dom"><label>Day of month (1-28, monthly)</label><input id="r-dom" class="input" type="number" min="1" max="28" value="${existing?.day_of_month??10}"/></div>
            <div class="field" id="wrap-wd" style="display:none"><label>Weekday (weekly)</label><select id="r-wd"><option value="mon">Mon</option><option value="tue">Tue</option><option value="wed">Wed</option><option value="thu">Thu</option><option value="fri">Fri</option><option value="sat">Sat</option><option value="sun">Sun</option></select></div>
          </div>
          <div class="row">
            <div class="field"><label>Start on</label><input id="r-start" class="input" type="date" value="${esc(existing?.start_on?? todayISO())}"/></div>
            <div class="field"><label>Next due on (optional)</label><input id="r-next" class="input" type="date" value="${esc(existing?.next_due_on??"")}"/></div>
            <div class="field"><label>End on (optional)</label><input id="r-end" class="input" type="date" value="${esc(existing?.end_on??"")}"/></div>
          </div>
          <div class="row">
            <div class="field"><label>Payee</label><input id="r-payee" class="input" value="${esc(existing?.payee??"")}"/></div>
            <div class="field"><label>Note</label><input id="r-note" class="input" value="${esc(existing?.note??"")}"/></div>
          </div>
        </div>
        <div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn btn-primary" id="save">${existing?"Update":"Create"}</button></div>
      </div>
    </div>`;
  const cadSel=root.querySelector("#r-cad") as HTMLSelectElement;
  if(existing) cadSel.value=existing.cadence;
  if(existing) (root.querySelector("#r-kind") as HTMLSelectElement).value=existing.kind;
  if(existing) (root.querySelector("#r-acc") as HTMLSelectElement).value=existing.account_name;
  if(existing?.to_account_name) (root.querySelector("#r-to") as HTMLSelectElement).value=existing.to_account_name;
  if(existing?.category_name) (root.querySelector("#r-cat") as HTMLSelectElement).value=existing.category_name;
  if(existing?.weekday) (root.querySelector("#r-wd") as HTMLSelectElement).value=existing.weekday;
  const sync=()=>{
    const c=cadSel.value;
    (root.querySelector("#wrap-dom") as HTMLElement).style.display = c==="monthly"?"block":"none";
    (root.querySelector("#wrap-wd") as HTMLElement).style.display = c==="weekly"?"block":"none";
  };
  cadSel.addEventListener("change",sync); sync();
  const close=()=>root.innerHTML="";
  root.querySelector("#x")!.addEventListener("click",close);
  root.querySelector("#cancel")!.addEventListener("click",close);
  root.querySelector("#bd")!.addEventListener("click",(e)=>{ if(e.target===e.currentTarget) close();});
  root.querySelector("#save")!.addEventListener("click", async()=>{
    const name=(root.querySelector("#r-name") as HTMLInputElement).value.trim();
    const kind=(root.querySelector("#r-kind") as HTMLSelectElement).value;
    const amount=(root.querySelector("#r-amount") as HTMLInputElement).value.trim();
    const account=(root.querySelector("#r-acc") as HTMLSelectElement).value;
    const to_account=(root.querySelector("#r-to") as HTMLSelectElement).value||null;
    const category=(root.querySelector("#r-cat") as HTMLSelectElement).value||null;
    const cadence=cadSel.value;
    const interval=Number((root.querySelector("#r-interval") as HTMLInputElement).value)||1;
    const day_of_month= cadence==="monthly"? Number((root.querySelector("#r-dom") as HTMLInputElement).value)||null : null;
    const weekday= cadence==="weekly"? (root.querySelector("#r-wd") as HTMLSelectElement).value : null;
    const start_on=(root.querySelector("#r-start") as HTMLInputElement).value;
    let next_due_on=(root.querySelector("#r-next") as HTMLInputElement).value||null;
    if(next_due_on==="") next_due_on=null;
    let end_on=(root.querySelector("#r-end") as HTMLInputElement).value||null;
    if(end_on==="") end_on=null;
    const payee=(root.querySelector("#r-payee") as HTMLInputElement).value.trim()||null;
    const note=(root.querySelector("#r-note") as HTMLInputElement).value.trim()||null;
    if(!name||!amount||!account||!start_on){ toast("Name, amount, account and start date required",true); return; }
    try{
      if(existing){
        await invoke("edit_recurring",{req:{
          id:existing.id, name, kind, amount, account, to_account, category, payee, note,
          cadence, interval, day_of_month, weekday, start_on, next_due_on, end_on,
          clear_to_account:!to_account, clear_category:!category, clear_payee:!payee, clear_note:!note,
          clear_day_of_month: cadence!=="monthly", clear_weekday: cadence!=="weekly",
          clear_next_due_on: !next_due_on, clear_end_on: !end_on
        }});
        toast("Rule updated");
      }else{
        await invoke("add_recurring",{req:{name, kind, amount, account, to_account, category, payee, note, cadence, interval, day_of_month, weekday, start_on, next_due_on, end_on}});
        toast("Rule created");
      }
      root.innerHTML=""; renderRecurring($("#main") as HTMLElement);
    }catch(e:any){ toast(String(e),true); }
  });
}

// ---------- Planning ----------
async function renderPlanning(main:HTMLElement){
  let scenarios:PlanningScenarioRecord[]=[], items:PlanningItemRecord[]=[], goals:PlanningGoalRecord[]=[];
  try{ scenarios=await invoke<PlanningScenarioRecord[]>("list_scenarios"); }catch{}
  try{ items=await invoke<PlanningItemRecord[]>("list_planning_items",{scenario:null, from:null, to:null}); }catch{}
  try{ goals=await invoke<PlanningGoalRecord[]>("list_goals"); }catch{}
  // tabs inside planning
  const ptab=planningTab;

  main.innerHTML=`
    <div class="page-head"><h2>Planning</h2><p>Scenarios & what-if · future planned transactions · goals (sinking fund / balance target)</p></div>
    <div class="tabs">
      <button class="tab ${ptab==="scenarios"?"active":""}" data-ptab="scenarios">Scenarios</button>
      <button class="tab ${ptab==="items"?"active":""}" data-ptab="items">Planned items</button>
      <button class="tab ${ptab==="goals"?"active":""}" data-ptab="goals">Goals</button>
    </div>
    <div id="ptab-body"></div>
  `;
  main.querySelectorAll("[data-ptab]").forEach(b=>b.addEventListener("click",()=>{
    const targetTab = (b as HTMLElement).dataset.ptab as typeof planningTab;
    if(planningTab === targetTab) return;
    pushNavigationState();
    planningTab = targetTab;
    renderPlanning(main);
    updateTopbarBackButton();
  }));
  const body=main.querySelector("#ptab-body") as HTMLElement;
  if(ptab==="scenarios"){
    body.innerHTML=`
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn btn-primary" id="add-scen">+ Scenario</button></div>
      <div class="grid2">
        ${scenarios.map(s=>`
          <div class="card">
            <div style="display:flex;justify-content:space-between"><strong>${esc(s.name)}</strong><span class="pill">#${s.id}</span></div>
            <div class="small muted" style="margin-top:4px">${esc(s.note??"No note")}</div>
            <div style="display:flex;gap:6px;margin-top:10px">
              <button class="btn btn-sm" data-edit-scen="${s.id}">Edit</button>
              <button class="btn btn-sm" data-del-scen="${s.id}">Archive</button>
            </div>
          </div>
        `).join("") || `<div class="card empty">No scenarios — create Baseline, Lose job, New house…</div>`}
      </div>`;
    body.querySelector("#add-scen")!.addEventListener("click",()=>openScenarioModal());
    body.querySelectorAll("[data-edit-scen]").forEach(b=>b.addEventListener("click",()=>{
      const id=Number((b as HTMLElement).dataset.editScen);
      openScenarioModal(scenarios.find(x=>x.id===id)!);
    }));
    body.querySelectorAll("[data-del-scen]").forEach(b=>b.addEventListener("click", async()=>{
      const id=Number((b as HTMLElement).dataset.delScen);
      if(!confirm("Archive this scenario?")) return;
      try{ await invoke("delete_scenario",{id}); toast("Archived"); renderPlanning(main); }catch(e:any){ toast(String(e),true); }
    }));
  } else if(ptab==="items"){
    body.innerHTML=`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="display:flex;gap:8px;align-items:center">
          <select id="filter-scen"><option value="">All scenarios + baseline</option>${scenarios.map(s=>`<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("")}</select>
          <button class="btn btn-sm" id="filter-btn">Filter</button>
        </div>
        <button class="btn btn-primary" id="add-item">+ Planned item</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Due</th><th>Title</th><th>Type</th><th>Amount</th><th>Account</th><th>Scenario</th><th></th></tr></thead>
        <tbody>
          ${items.map(it=>`
            <tr>
              <td class="small">${esc(it.due_on)}</td>
              <td><strong>${esc(it.title)}</strong><div class="small muted">${esc(it.category_name??"")}${it.payee?` · ${esc(it.payee)}`:""}</div></td>
              <td><span class="badge badge-${it.kind}">${it.kind}</span></td>
              <td style="font-weight:700">${centsFmt(it.amount_cents)}</td>
              <td class="small">${esc(it.account_name)}${it.to_account_name?` → ${esc(it.to_account_name)}`:""}</td>
              <td class="small">${esc(it.scenario_name??"baseline")}</td>
              <td><div style="display:flex;gap:6px">
                <button class="btn btn-sm" data-edit-item="${it.id}">Edit</button>
                <button class="btn btn-sm" data-post-item="${it.id}">Post → Tx</button>
                <button class="btn btn-sm" data-del-item="${it.id}">Archive</button>
              </div></td>
            </tr>
          `).join("") || `<tr><td colspan="7" class="empty">No planned items</td></tr>`}
        </tbody>
      </table></div>`;
    body.querySelector("#add-item")!.addEventListener("click",()=>openPlanningItemModal());
    body.querySelector("#filter-btn")!.addEventListener("click", async()=>{
      const scen=(body.querySelector("#filter-scen") as HTMLSelectElement).value||null;
      try{ items=await invoke<PlanningItemRecord[]>("list_planning_items",{scenario:scen, from:null, to:null}); }catch{}
      // re-render items table only
      renderPlanning(main); // simple
      // keep filter
      setTimeout(()=>{ (body.querySelector("#filter-scen") as HTMLSelectElement).value=scen??""; },0);
    });
    body.querySelectorAll("[data-edit-item]").forEach(b=>b.addEventListener("click",()=>{
      const id=Number((b as HTMLElement).dataset.editItem);
      openPlanningItemModal(items.find(x=>x.id===id)!);
    }));
    body.querySelectorAll("[data-post-item]").forEach(b=>b.addEventListener("click", async()=>{
      const id=Number((b as HTMLElement).dataset.postItem);
      try{ const txId=await invoke<number>("post_planning_item",{id}); toast(`Posted as transaction #${txId}`); renderPlanning(main); }catch(e:any){ toast(String(e),true); }
    }));
    body.querySelectorAll("[data-del-item]").forEach(b=>b.addEventListener("click", async()=>{
      const id=Number((b as HTMLElement).dataset.delItem);
      if(!confirm("Archive this planned item?")) return;
      try{ await invoke("delete_planning_item",{id}); toast("Archived"); renderPlanning(main); }catch(e:any){ toast(String(e),true); }
    }));
  } else {
    body.innerHTML=`
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn btn-primary" id="add-goal">+ Goal</button></div>
      <div class="grid2">
        ${goals.map(g=>`
          <div class="card">
            <div style="display:flex;justify-content:space-between"><strong>${esc(g.name)}</strong><span class="badge ${g.kind==="sinking_fund"?"badge-income":"badge-transfer"}">${esc(g.kind)}</span></div>
            <div class="small muted" style="margin-top:6px">Account: ${esc(g.account_name)} ${g.due_on?`· Due ${esc(g.due_on)}`:""} </div>
            <div class="small" style="margin-top:6px">
              ${g.kind==="sinking_fund"?`Target ${centsFmt(g.target_amount_cents??0)}`:`Minimum ${centsFmt(g.minimum_balance_cents??0)}`}
            </div>
            <div style="display:flex;gap:6px;margin-top:10px">
              <button class="btn btn-sm" data-edit-goal="${g.id}">Edit</button>
              <button class="btn btn-sm" data-del-goal="${g.id}">Archive</button>
            </div>
          </div>
        `).join("") || `<div class="card empty">No goals — save for Europe trip or set minimum balance.</div>`}
      </div>`;
    body.querySelector("#add-goal")!.addEventListener("click",()=>openGoalModal());
    body.querySelectorAll("[data-edit-goal]").forEach(b=>b.addEventListener("click",()=>{
      const id=Number((b as HTMLElement).dataset.editGoal);
      openGoalModal(goals.find(x=>x.id===id)!);
    }));
    body.querySelectorAll("[data-del-goal]").forEach(b=>b.addEventListener("click", async()=>{
      const id=Number((b as HTMLElement).dataset.delGoal);
      if(!confirm("Archive this goal?")) return;
      try{ await invoke("delete_goal",{id}); toast("Archived"); renderPlanning(main); }catch(e:any){ toast(String(e),true); }
    }));
  }
}
function openScenarioModal(existing?:PlanningScenarioRecord){
  const root=document.getElementById("modal-root")!;
  root.innerHTML=`
    <div class="modal-backdrop" id="bd"><div class="modal">
      <div class="modal-head"><h3>${existing?"Edit scenario":"New scenario"}</h3><button class="btn btn-ghost" id="x">✕</button></div>
      <div class="modal-body">
        <div class="field"><label>Name</label><input id="s-name" class="input" value="${esc(existing?.name??"")}"/></div>
        <div class="field"><label>Note</label><textarea id="s-note">${esc(existing?.note??"")}</textarea></div>
      </div>
      <div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn btn-primary" id="save">${existing?"Update":"Create"}</button></div>
    </div></div>`;
  const close=()=>root.innerHTML="";
  root.querySelector("#x")!.addEventListener("click",close);
  root.querySelector("#cancel")!.addEventListener("click",close);
  root.querySelector("#bd")!.addEventListener("click",(e)=>{ if(e.target===e.currentTarget) close();});
  root.querySelector("#save")!.addEventListener("click", async()=>{
    const name=(root.querySelector("#s-name") as HTMLInputElement).value.trim();
    const note=(root.querySelector("#s-note") as HTMLTextAreaElement).value.trim()||null;
    if(!name){ toast("Name required",true); return; }
    try{
      if(existing) await invoke("edit_scenario",{id:existing.id, name, note, clearNote: !note});
      else await invoke("add_scenario",{name, note});
      toast(existing?"Scenario updated":"Scenario created"); root.innerHTML=""; renderPlanning($("#main") as HTMLElement);
    }catch(e:any){ toast(String(e),true); }
  });
}
function openPlanningItemModal(existing?:PlanningItemRecord){
  const root=document.getElementById("modal-root")!;
  // need scenarios for dropdown
  invoke<PlanningScenarioRecord[]>("list_scenarios").then(scenarios=>{
    root.innerHTML=`
      <div class="modal-backdrop" id="bd"><div class="modal" style="max-width:600px">
        <div class="modal-head"><h3>${existing?"Edit planned item":"New planned item"}</h3><button class="btn btn-ghost" id="x">✕</button></div>
        <div class="modal-body">
          <div class="field"><label>Title</label><input id="p-title" class="input" value="${esc(existing?.title??"")}"/></div>
          <div class="row">
            <div class="field"><label>Kind</label><select id="p-kind"><option value="expense">expense</option><option value="income">income</option><option value="transfer">transfer</option></select></div>
            <div class="field"><label>Amount</label><input id="p-amount" class="input" value="${existing?(existing.amount_cents/100).toFixed(2):""}"/></div>
            <div class="field"><label>Due on</label><input id="p-due" class="input" type="date" value="${esc(existing?.due_on?? todayISO())}"/></div>
          </div>
          <div class="row">
            <div class="field"><label>Account</label><select id="p-acc">${accounts.map(a=>`<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("")}</select></div>
            <div class="field"><label>To account (transfer)</label><select id="p-to"><option value="">—</option>${accounts.map(a=>`<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("")}</select></div>
          </div>
          <div class="field"><label>Category</label><select id="p-cat"><option value="">—</option>${categories.map(c=>`<option value="${esc(c.name)}">${esc(c.name)} (${c.kind})</option>`).join("")}</select></div>
          <div class="field"><label>Scenario</label><select id="p-scen"><option value="">baseline (no scenario)</option>${scenarios.map(s=>`<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("")}</select></div>
          <div class="row">
            <div class="field"><label>Payee</label><input id="p-payee" class="input" value="${esc(existing?.payee??"")}"/></div>
            <div class="field"><label>Note</label><input id="p-note" class="input" value="${esc(existing?.note??"")}"/></div>
          </div>
        </div>
        <div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn btn-primary" id="save">${existing?"Update":"Create"}</button></div>
      </div></div>`;
    if(existing){
      (root.querySelector("#p-kind") as HTMLSelectElement).value=existing.kind;
      (root.querySelector("#p-acc") as HTMLSelectElement).value=existing.account_name;
      if(existing.to_account_name) (root.querySelector("#p-to") as HTMLSelectElement).value=existing.to_account_name;
      if(existing.category_name) (root.querySelector("#p-cat") as HTMLSelectElement).value=existing.category_name;
      if(existing.scenario_name) (root.querySelector("#p-scen") as HTMLSelectElement).value=existing.scenario_name;
    }
    const close=()=>root.innerHTML="";
    root.querySelector("#x")!.addEventListener("click",close);
    root.querySelector("#cancel")!.addEventListener("click",close);
    root.querySelector("#bd")!.addEventListener("click",(e)=>{ if(e.target===e.currentTarget) close();});
    root.querySelector("#save")!.addEventListener("click", async()=>{
      const title=(root.querySelector("#p-title") as HTMLInputElement).value.trim();
      const kind=(root.querySelector("#p-kind") as HTMLSelectElement).value;
      const amount=(root.querySelector("#p-amount") as HTMLInputElement).value.trim();
      const account=(root.querySelector("#p-acc") as HTMLSelectElement).value;
      const to_account=(root.querySelector("#p-to") as HTMLSelectElement).value||null;
      const category=(root.querySelector("#p-cat") as HTMLSelectElement).value||null;
      const scenario=(root.querySelector("#p-scen") as HTMLSelectElement).value||null;
      const due_on=(root.querySelector("#p-due") as HTMLInputElement).value;
      const payee=(root.querySelector("#p-payee") as HTMLInputElement).value.trim()||null;
      const note=(root.querySelector("#p-note") as HTMLInputElement).value.trim()||null;
      if(!title||!amount||!due_on||!account){ toast("Title, amount, due date and account required",true); return; }
      try{
        if(existing){
          await invoke("edit_planning_item",{req:{id:existing.id, scenario, title, kind, amount, account, to_account, category, due_on, payee, note, clear_scenario: !scenario, clear_to_account: !to_account, clear_category: !category, clear_payee: !payee, clear_note: !note}});
          toast("Planned item updated");
        }else{
          await invoke("add_planning_item",{req:{scenario, title, kind, amount, account, to_account, category, due_on, payee, note}});
          toast("Planned item created");
        }
        root.innerHTML=""; renderPlanning($("#main") as HTMLElement);
      }catch(e:any){ toast(String(e),true); }
    });
  });
}
function openGoalModal(existing?:PlanningGoalRecord){
  const root=document.getElementById("modal-root")!;
  root.innerHTML=`
    <div class="modal-backdrop" id="bd"><div class="modal">
      <div class="modal-head"><h3>${existing?"Edit goal":"New goal"}</h3><button class="btn btn-ghost" id="x">✕</button></div>
      <div class="modal-body">
        <div class="field"><label>Name</label><input id="g-name" class="input" value="${esc(existing?.name??"")}"/></div>
        <div class="field"><label>Kind</label><select id="g-kind"><option value="sinking_fund">sinking_fund — save X by date</option><option value="balance_target">balance_target — never below X</option></select></div>
        <div class="field"><label>Account</label><select id="g-acc">${accounts.map(a=>`<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("")}</select></div>
        <div id="g-sinking">
          <div class="field"><label>Target amount</label><input id="g-target" class="input" value="${existing?.target_amount_cents? (existing.target_amount_cents/100).toFixed(2):""}"/></div>
          <div class="field"><label>Due on</label><input id="g-due" class="input" type="date" value="${esc(existing?.due_on??"")}"/></div>
        </div>
        <div id="g-balance" style="display:none">
          <div class="field"><label>Minimum balance</label><input id="g-min" class="input" value="${existing?.minimum_balance_cents? (existing.minimum_balance_cents/100).toFixed(2):""}"/></div>
        </div>
      </div>
      <div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn btn-primary" id="save">${existing?"Update":"Create"}</button></div>
    </div></div>`;
  const kindSel=root.querySelector("#g-kind") as HTMLSelectElement;
  if(existing) kindSel.value=existing.kind;
  if(existing) (root.querySelector("#g-acc") as HTMLSelectElement).value=existing.account_name;
  const sync=()=>{
    const k=kindSel.value;
    (root.querySelector("#g-sinking") as HTMLElement).style.display = k==="sinking_fund"?"block":"none";
    (root.querySelector("#g-balance") as HTMLElement).style.display = k==="balance_target"?"block":"none";
  };
  kindSel.addEventListener("change",sync); sync();
  const close=()=>root.innerHTML="";
  root.querySelector("#x")!.addEventListener("click",close);
  root.querySelector("#cancel")!.addEventListener("click",close);
  root.querySelector("#bd")!.addEventListener("click",(e)=>{ if(e.target===e.currentTarget) close();});
  root.querySelector("#save")!.addEventListener("click", async()=>{
    const name=(root.querySelector("#g-name") as HTMLInputElement).value.trim();
    const kind=(root.querySelector("#g-kind") as HTMLSelectElement).value;
    const account=(root.querySelector("#g-acc") as HTMLSelectElement).value;
    const target_amount=(root.querySelector("#g-target") as HTMLInputElement).value.trim()||null;
    const due_on=(root.querySelector("#g-due") as HTMLInputElement).value||null;
    const minimum_balance=(root.querySelector("#g-min") as HTMLInputElement).value.trim()||null;
    if(!name||!account){ toast("Name and account required",true); return; }
    try{
      if(existing){
        await invoke("edit_goal",{req:{
          id:existing.id, name, kind, account,
          target_amount: kind==="sinking_fund"? target_amount : null,
          minimum_balance: kind==="balance_target"? minimum_balance : null,
          due_on: kind==="sinking_fund"? due_on : null,
          clear_target_amount: kind!=="sinking_fund" || !target_amount,
          clear_minimum_balance: kind!=="balance_target" || !minimum_balance,
          clear_due_on: kind!=="sinking_fund" || !due_on
        }});
        toast("Goal updated");
      }else{
        await invoke("add_goal",{req:{name, kind, account, target_amount: kind==="sinking_fund"? target_amount:null, minimum_balance: kind==="balance_target"? minimum_balance:null, due_on: kind==="sinking_fund"? due_on:null}});
        toast("Goal created");
      }
      root.innerHTML=""; renderPlanning($("#main") as HTMLElement);
    }catch(e:any){ toast(String(e),true); }
  });
}

// ---------- Forecast ----------
async function renderForecast(main:HTMLElement){
  let scenarios:PlanningScenarioRecord[]=[];
  try{ scenarios=await invoke<PlanningScenarioRecord[]>("list_scenarios"); }catch{}
  let forecast:ForecastSnapshot|null=null;
  let selScenario="", selAccount="", days=90;
  async function load(){
    try{ forecast=await invoke<ForecastSnapshot>("get_forecast",{scenario: selScenario||null, account: selAccount||null, days}); }catch(e:any){ toast(String(e),true); forecast=null; }
    paint();
  }
  function paint(){
    const forecastCurrency = accounts.find(a=>a.id===forecast?.account.id)?.currency_code ?? currency;
    const accountCurrency = (id:number)=>accounts.find(a=>a.id===id)?.currency_code ?? currency;
    const scenOpts=`<option value="">Baseline</option>`+scenarios.map(s=>`<option value="${esc(s.name)}" ${selScenario===s.name?"selected":""}>${esc(s.name)}</option>`).join("");
    const accOpts=`<option value="">All accounts</option>`+accounts.map(a=>`<option value="${esc(a.name)}" ${selAccount===a.name?"selected":""}>${esc(a.name)}</option>`).join("");
    main.innerHTML=`
      <div class="page-head"><h2>Cash-flow forecasting</h2><p>Read-only projection from current balance + recurring + future plans + budgets · 90-day default</p></div>
      <div class="card" style="margin-bottom:14px">
        <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="margin:0"><label>Scenario</label><select id="f-scen">${scenOpts}</select></div>
          <div class="field" style="margin:0"><label>Account</label><select id="f-acc">${accOpts}</select></div>
          <div class="field" style="margin:0"><label>Horizon (days)</label><select id="f-days"><option value="30">30</option><option value="60">60</option><option value="90">90</option><option value="180">180</option><option value="365">365</option></select></div>
          <button class="btn btn-primary" id="f-load">Project</button>
        </div>
        ${forecast?`<div class="small muted" style="margin-top:8px">As of ${esc(forecast.as_of)} · ${esc(forecast.scenario.name??"Baseline")} ${forecast.account.name?`· ${esc(forecast.account.name)}`:""} ${forecast.warnings.length?`· ⚠ ${esc(forecast.warnings.join(" · "))}`:""}</div>`:""}
        ${forecast?.alerts.length?`<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">${forecast.alerts.map(a=>`<div style="padding:8px 12px;background:var(--warn-soft);border:1px solid var(--warn);border-radius:8px" class="small">⚠ ${esc(a)}</div>`).join("")}</div>`:""}
      </div>
      ${!forecast?`<div class="card empty">Select horizon and project to see forecast</div>` : `
        <div class="card" style="margin-bottom:14px">
          <div class="card-title">Projected balance — next ${days} days</div>
          <div style="height:200px;display:flex;align-items:flex-end;gap:1px;padding:10px 0">
            ${forecast.daily.map(d=>{
              const vals=forecast!.daily.map(x=>x.closing_balance_cents);
              const min=Math.min(...vals), max=Math.max(...vals);
              const range=max-min||1;
              const h= 16 + Math.round((d.closing_balance_cents - min)/range*160);
              const isNeg=d.closing_balance_cents<0;
              return `<div title="${d.date}: ${centsFmt(d.closing_balance_cents, forecastCurrency)}" style="flex:1;background:${isNeg?"var(--danger)":"var(--accent)"};height:${h}px;border-radius:3px 3px 0 0;opacity:.85"></div>`;
            }).join("")}
          </div>
          <div class="small muted" style="display:flex;justify-content:space-between"><span>${forecast.daily[0]?.date}</span><span>${forecast.daily[forecast.daily.length-1]?.date}</span></div>
        </div>
        <div class="grid2">
          <div class="card">
            <div class="card-title">Monthly roll-up (12 months)</div>
            <table><thead><tr><th>Month</th><th>Inflow</th><th>Outflow</th><th>Net</th><th>Ending</th></tr></thead>
            <tbody>${forecast.monthly.map(m=>`<tr><td class="small">${esc(m.month)}</td><td class="small amount-pos">${centsFmt(m.inflow_cents, forecastCurrency)}</td><td class="small amount-neg">${centsFmt(m.outflow_cents, forecastCurrency)}</td><td class="small" style="font-weight:700;color:${m.net_cents>=0?'var(--accent)':'var(--danger)'}">${centsFmt(m.net_cents, forecastCurrency)}</td><td class="small" style="font-weight:700">${centsFmt(m.ending_balance_cents, forecastCurrency)}</td></tr>`).join("")}</tbody></table>
          </div>
          <div>
            <div class="card" style="margin-bottom:14px">
              <div class="card-title">Upcoming bills (next 30 days preview)</div>
              ${forecast.bill_calendar.slice(0,30).map(b=>`
                <button type="button" class="forecast-action-row" data-forecast-bill-source="${esc(b.source)}" data-forecast-bill-id="${b.source_id??""}" aria-label="Manage ${esc(b.title)}">
                  <span><span class="forecast-action-title">${esc(b.title)} <span class="badge badge-${b.kind}">${b.kind}</span></span><span class="small muted forecast-action-detail">${b.date} · ${esc(b.account_name)}${b.category_name?` · ${esc(b.category_name)}`:""}</span></span>
                  <span style="font-weight:700" class="${b.kind==="expense"?"amount-neg":"amount-pos"}">${centsFmt(b.amount_cents, accountCurrency(b.account_id))}</span>
                </button>
              `).join("") || `<div class="small muted">No upcoming bills in horizon</div>`}
            </div>
            <div class="card">
              <div class="card-title">Goal status</div>
              ${forecast.goal_status.map(g=>`
                <button type="button" class="forecast-goal-card" data-open-goal="${g.id}" aria-label="Manage goal ${esc(g.name)}">
                  <span class="forecast-goal-head"><strong>${esc(g.name)}</strong><span class="badge ${g.on_track?"badge-income":"badge-expense"}">${g.on_track?"on track":"at risk"}</span></span>
                  <span class="small muted forecast-goal-line">${esc(g.account_name)} · ${g.kind} ${g.due_on?`· due ${esc(g.due_on)}`:""}</span>
                  <span class="small forecast-goal-line" style="margin-top:4px">Current ${centsFmt(g.current_balance_cents, accountCurrency(g.account_id))} → Projected ${centsFmt(g.projected_balance_cents, accountCurrency(g.account_id))} · Remaining ${centsFmt(g.remaining_cents, accountCurrency(g.account_id))} ${g.suggested_monthly_contribution_cents?`· Suggested/mo ${centsFmt(g.suggested_monthly_contribution_cents, accountCurrency(g.account_id))}`:""}</span>
                  ${g.breach_date?`<span class="small amount-neg forecast-goal-line">Breach: ${esc(g.breach_date)}</span>`:""}
                </button>
              `).join("") || `<div class="small muted">No goals</div>`}
            </div>
          </div>
        </div>
      `}
    `;
    (main.querySelector("#f-days") as HTMLSelectElement).value=String(days);
    main.querySelector("#f-load")!.addEventListener("click",()=>{
      selScenario=(main.querySelector("#f-scen") as HTMLSelectElement).value;
      selAccount=(main.querySelector("#f-acc") as HTMLSelectElement).value;
      days=Number((main.querySelector("#f-days") as HTMLSelectElement).value)||90;
      load();
    });
    main.querySelectorAll<HTMLElement>("[data-forecast-bill-source]").forEach(button=>button.addEventListener("click",()=>openForecastBill(button.dataset.forecastBillSource!,Number(button.dataset.forecastBillId)||null)));
    main.querySelectorAll<HTMLElement>("[data-open-goal]").forEach(button=>button.addEventListener("click",()=>void openGoal(Number(button.dataset.openGoal))));
  }
  await load();
}

// ---------- FIRE & Wealth Milestones ----------
function fireProjectionChart(points:WealthProjectionPoint[]){
  if(points.length<2) return chartEmpty("Add expense history and positive savings to build a trajectory.");
  const width=800,height=230,padX=48,padY=24;
  const maximum=Math.max(...points.flatMap(point=>[point.portfolio_cents,point.fire_target_cents]),1);
  const x=(index:number)=>padX+(width-padX*2)*(index/Math.max(points.length-1,1));
  const y=(value:number)=>height-padY-(height-padY*2)*(Math.max(0,value)/maximum);
  const line=points.map((point,index)=>`${x(index).toFixed(1)},${y(point.portfolio_cents).toFixed(1)}`).join(" ");
  const targetY=y(points[0].fire_target_cents);
  const ticks=[0,Math.floor((points.length-1)/2),points.length-1].filter((value,index,array)=>array.indexOf(value)===index);
  return `<div class="fire-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Projected investable assets compared with FIRE target"><line x1="${padX}" x2="${width-padX}" y1="${targetY}" y2="${targetY}" class="fire-target-line"/><text x="${width-padX}" y="${Math.max(14,targetY-7)}" text-anchor="end" class="fire-target-label">FIRE target</text><polyline points="${line}" class="fire-projection-line"/>${points.map((point,index)=>`<circle cx="${x(index)}" cy="${y(point.portfolio_cents)}" r="${index===points.length-1?4:2}" class="fire-projection-dot"><title>Age ${point.age}: ${centsFmt(point.portfolio_cents)}</title></circle>`).join("")}</svg><div class="fire-chart-axis">${ticks.map(index=>`<span style="left:${x(index)/width*100}%">Age ${points[index].age}</span>`).join("")}</div></div>`;
}

function futureDateLabel(date:string|null){
  if(!date) return "No date on current trajectory";
  const parsed=new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.valueOf())?date:parsed.toLocaleDateString(undefined,{month:"short",year:"numeric"});
}

async function renderFire(main:HTMLElement){
  main.innerHTML=`<div class="page-head"><h2>FIRE & wealth milestones</h2><p>Long-term independence planning from your local ledger, balance sheet, investments, and debt schedules.</p></div><div class="card empty">Building your long-term plan…</div>`;
  let snapshot:FireSnapshot|null=null;

  async function load(){
    try{
      snapshot=await invoke<FireSnapshot>("get_fire_snapshot",{...fireInputs});
      paint();
    }catch(error:any){
      toast(String(error),true);
    }
  }

  function assumptionInput(id:string,label:string,value:number,min:number,max:number,step:number,suffix:string){
    return `<label class="fire-assumption"><span>${esc(label)}</span><span class="fire-input-wrap"><input id="${id}" class="input" type="number" min="${min}" max="${max}" step="${step}" value="${value}" required/><small>${esc(suffix)}</small></span></label>`;
  }

  function paint(){
    if(!snapshot) return;
    const s=snapshot;
    const mc=s.monte_carlo;
    const runway=s.annual_spending_cents>0?s.investable_assets_cents/s.annual_spending_cents:null;
    const contributionClass=s.monthly_savings_cents>=0?"amount-pos":"amount-neg";
    main.innerHTML=`
      <div class="page-head fire-page-head"><div><h2>FIRE & wealth milestones</h2><p>Long-term independence planning from your local ledger, balance sheet, investments, and debt schedules.</p></div><span class="privacy-pill">On-device analysis</span></div>
      <form class="card fire-assumptions" id="fire-form">
        <div class="fire-assumptions-head"><div><div class="card-title">Plan assumptions</div><p>Saved on this device · values are modeled in today’s money</p></div><button class="btn btn-primary" type="submit">Recalculate</button></div>
        <div class="fire-assumption-grid">
          ${assumptionInput("fire-swr","Safe withdrawal rate",fireInputs.safeWithdrawalRatePercent,2,6,.05,"%")}
          ${assumptionInput("fire-stocks","Stock allocation",fireInputs.stockAllocationPercent,0,100,1,"%")}
          ${assumptionInput("fire-return","Expected annual return",fireInputs.expectedReturnPercent,-5,20,.1,"%")}
          ${assumptionInput("fire-inflation","Inflation",fireInputs.inflationPercent,0,15,.1,"%")}
          ${assumptionInput("fire-age","Current age",fireInputs.currentAge,18,100,1,"years")}
          ${assumptionInput("fire-retire-age","Target retirement age",fireInputs.retirementAge,fireInputs.currentAge,110,1,"years")}
        </div>
        <div class="small muted">Real return: ${s.assumptions.real_return_percent.toFixed(1)}% · ${s.history_months} months analyzed (${esc(s.history_from)} to ${esc(s.history_to)}) · ${mc.trials.toLocaleString()} simulations</div>
      </form>
      ${s.warnings.map(warning=>`<div class="fire-warning">${esc(warning)}</div>`).join("")}
      <section class="fire-hero card">
        <div class="fire-hero-copy"><span class="eyebrow">Your FIRE number</span><strong>${centsFmt(s.fire_number_cents)}</strong><p>${s.projected_fire_date?`Projected for ${futureDateLabel(s.projected_fire_date)}${s.years_to_fire!==null?` · ${s.years_to_fire.toFixed(1)} years`:""}`:"A target date needs positive savings or sufficient invested assets."}</p></div>
        <div class="fire-progress-ring" style="--progress:${Math.min(100,s.progress_percent)}"><div><strong>${s.progress_percent.toFixed(1)}%</strong><span>funded</span></div></div>
        <div class="fire-hero-stats"><div><span>Investable assets</span><strong>${centsFmt(s.investable_assets_cents)}</strong></div><div><span>Annual spending</span><strong>${centsFmt(s.annual_spending_cents)}</strong></div><div><span>Current runway</span><strong>${runway===null?"—":`${runway.toFixed(1)} years`}</strong></div><div><span>Monthly savings</span><strong class="${contributionClass}">${centsFmt(s.monthly_savings_cents)}</strong></div></div>
      </section>
      <div class="grid2 fire-primary-grid">
        <div class="card"><div class="card-title">Real wealth trajectory</div><p class="small muted">Current investable assets plus the recent savings pace. Scheduled loan payments become contributions after payoff.</p>${fireProjectionChart(s.projection)}</div>
        <div class="card"><div class="card-title">30-year portfolio survivability</div><div class="fire-survival"><strong>${mc.success_rate_percent.toFixed(1)}%</strong><span>of ${mc.trials.toLocaleString()} paths funded all withdrawals</span></div><div class="fire-simulation-stats"><div><span>10th percentile ending</span><strong>${centsFmt(mc.percentile_10_ending_balance_cents)}</strong></div><div><span>Median ending</span><strong>${centsFmt(mc.median_ending_balance_cents)}</strong></div><div><span>Worst modeled ending</span><strong>${centsFmt(mc.worst_ending_balance_cents)}</strong></div></div><p class="small muted">Annual real withdrawals equal historical annual spending. Returns use the selected stock/bond mix with deterministic sampling.</p></div>
      </div>
      <div class="card fire-section">
        <div class="card-title">Milestone radar</div>
        <div class="milestone-grid">${s.milestones.map(milestone=>`<article class="milestone-card ${milestone.achieved?"achieved":""}"><div class="milestone-head"><span>${esc(milestone.name)}</span><span class="badge ${milestone.achieved?"badge-income":""}">${milestone.achieved?"Achieved":futureDateLabel(milestone.estimated_date)}</span></div><strong>${milestone.progress_percent.toFixed(1)}%</strong><div class="progress"><div class="progress-fill ${milestone.achieved?"ok":""}" style="width:${Math.min(100,milestone.progress_percent)}%"></div></div><p>${esc(milestone.detail)}</p><small>${centsFmt(milestone.current_cents)} of ${centsFmt(milestone.target_cents)}</small></article>`).join("")}</div>
      </div>
      <div class="card fire-section">
        <div class="card-title">Historical stress tests</div>
        <div class="stress-grid">${s.stress_tests.map(stress=>`<article class="stress-card ${stress.survived?"survived":"failed"}"><div><span class="badge ${stress.survived?"badge-income":"badge-expense"}">${stress.survived?"Survived":"Depleted"}</span><h3>${esc(stress.name)}</h3><p>${esc(stress.description)}</p></div><dl><div><dt>Lowest balance</dt><dd>${centsFmt(stress.minimum_balance_cents)}</dd></div><div><dt>Ending balance</dt><dd>${centsFmt(stress.ending_balance_cents)}</dd></div></dl></article>`).join("")}</div>
        <p class="small muted">These scenarios replay representative annual US stock and bond returns from the named periods against the selected allocation, then use long-run assumptions for the remaining years.</p>
      </div>`;
    main.querySelector<HTMLFormElement>("#fire-form")!.addEventListener("submit",event=>{
      event.preventDefault();
      const value=(selector:string)=>Number((main.querySelector(selector) as HTMLInputElement).value);
      fireInputs={
        safeWithdrawalRatePercent:value("#fire-swr"),stockAllocationPercent:value("#fire-stocks"),
        expectedReturnPercent:value("#fire-return"),inflationPercent:value("#fire-inflation"),
        currentAge:value("#fire-age"),retirementAge:value("#fire-retire-age"),simulations:fireInputs.simulations,
      };
      localStorage.setItem("finance-tracker-fire-inputs",JSON.stringify(fireInputs));
      void load();
    });
  }
  await load();
}

// ---------- Financial Audit ----------
function auditFindingIcon(finding:AuditFinding){
  if(finding.kind==="duplicate_charge") return "⧉";
  if(finding.kind==="payee_creep") return "↗";
  return "⌁";
}

async function renderFinancialAudit(main:HTMLElement){
  main.innerHTML=`<div class="page-head"><h2>Financial health audit</h2><p>Scanning local ledger patterns and financial guardrails…</p></div><div class="card empty">Running the audit…</div>`;
  let audit:FinancialAuditSnapshot;
  try{
    audit=await invoke<FinancialAuditSnapshot>("get_financial_audit");
  }catch(error:any){
    toast(String(error),true);
    main.innerHTML=`<div class="page-head"><h2>Financial health audit</h2><p>Local, private analysis of financial risks and anomalies.</p></div><div class="card empty"><strong>Audit unavailable</strong><p>${esc(String(error))}</p></div>`;
    return;
  }
  const duplicates=audit.findings.filter(finding=>finding.kind==="duplicate_charge");
  const leaks=audit.findings.filter(finding=>finding.kind!=="duplicate_charge");
  const scoreTone=audit.score>=75?"healthy":audit.score>=50?"watch":"risk";
  main.innerHTML=`
    <div class="page-head audit-page-head"><div><h2>Financial health audit</h2><p>${esc(audit.quarter_label)} check-up · SQLite analysis of ${audit.transaction_count.toLocaleString()} local transactions since ${esc(audit.history_from)}</p></div><span class="privacy-pill">Private · offline · read-only</span></div>
    ${audit.warnings.map(warning=>`<div class="fire-warning">${esc(warning)}</div>`).join("")}
    <div class="audit-overview">
      <section class="card audit-score-card ${scoreTone}"><div class="audit-score-ring" style="--score:${audit.score}"><div><strong>${audit.score}</strong><span>/ 100</span></div></div><div><span class="eyebrow">Quarterly scorecard</span><h3>${esc(audit.grade)}</h3><p>Weighted from savings, liquidity, debt load, and net worth velocity.</p></div></section>
      <section class="audit-metric-grid">${audit.metrics.map(metric=>`<article class="card audit-metric ${metric.status}"><div class="audit-metric-head"><span>${esc(metric.label)}</span><small>${metric.score}/100</small></div><strong>${esc(metric.display_value)}</strong><div class="progress"><div class="progress-fill ${metric.status==="healthy"?"ok":metric.status==="watch"?"warn":"over"}" style="width:${metric.score}%"></div></div><p>${esc(metric.explanation)}</p></article>`).join("")}</section>
    </div>
    <div class="grid2 audit-findings-grid">
      <section class="card"><div class="audit-section-head"><div><div class="card-title">Spending leak radar</div><p>Year-over-year category and payee increases that also rose during the latest quarter.</p></div><span class="audit-count">${leaks.length}</span></div>${leaks.length?`<div class="audit-list">${leaks.map(finding=>`<article class="audit-finding ${finding.severity}"><span class="audit-finding-icon">${auditFindingIcon(finding)}</span><div><div class="audit-finding-title"><strong>${esc(finding.title)}</strong><span class="badge">${esc(finding.severity)}</span></div><p>${esc(finding.description)}</p><button type="button" class="dashboard-card-link" data-audit-review="${esc(finding.entity_name)}">Review transactions</button></div></article>`).join("")}</div>`:`<div class="audit-clear"><strong>No sustained spending leaks found</strong><span>Enough history is needed on both sides of the year-over-year comparison.</span></div>`}</section>
      <section class="card"><div class="audit-section-head"><div><div class="card-title">Duplicate / overcharge sentinel</div><p>Identical payee and amount on the same credit card within 48 hours.</p></div><span class="audit-count ${duplicates.length?"danger":""}">${duplicates.length}</span></div>${duplicates.length?`<div class="audit-list">${duplicates.map(finding=>`<article class="audit-finding high"><span class="audit-finding-icon">${auditFindingIcon(finding)}</span><div><div class="audit-finding-title"><strong>${esc(finding.title)}</strong><span class="badge badge-expense">Review</span></div><p>${esc(finding.description)}</p><small>Ledger IDs ${finding.transaction_ids.map(id=>`#${id}`).join(" and ")}</small><button type="button" class="dashboard-card-link" data-audit-review="${esc(finding.entity_name)}">Open matching charges</button></div></article>`).join("")}</div>`:`<div class="audit-clear"><strong>No duplicate card charges detected</strong><span>The sentinel reviewed the latest twelve months.</span></div>`}</section>
    </div>
    <section class="card audit-actions"><div><div class="card-title">Diagnostic suggestions</div><p>Prioritized from this quarter’s ratios and anomaly findings.</p></div><ol>${audit.suggestions.map(suggestion=>`<li>${esc(suggestion)}</li>`).join("")}</ol></section>
    <div class="small muted audit-method">Calculated ${esc(audit.as_of)}. Expense leak detection requires at least four charges in each 12-month window and a 10% annual increase plus continued recent growth. Findings never alter ledger data.</div>`;
  main.querySelectorAll<HTMLElement>("[data-audit-review]").forEach(button=>button.addEventListener("click",()=>{
    const search=button.dataset.auditReview??"";
    navigateTo(()=>{
      txFilters={...txFilters,search,kinds:["expense"],include_deleted:false,sort_by:"date",sort_dir:"desc"};
      view="transactions";
    });
  }));
}

// ---------- Reconciliation ----------
async function renderReconciliation(main:HTMLElement){
  let recs:ReconciliationRecord[]=[];
  try{ recs=await invoke<ReconciliationRecord[]>("list_reconciliations",{account:null}); }catch{}
  main.innerHTML=`
    <div class="page-head"><h2>Reconciliation</h2><p>Architecture ready — verify bank statement balance matches ledger. Reconciled transactions are locked from edit/delete.</p></div>
    <div class="tabs reconciliation-tabs" role="tablist" aria-label="Reconciliation sections">
      <button class="tab active" type="button" role="tab" aria-selected="true" data-reconciliation-tab="start">Start reconciliation</button>
      <button class="tab" type="button" role="tab" aria-selected="false" data-reconciliation-tab="history">History</button>
    </div>
    <div id="reconciliation-body" class="reconciliation-body"></div>
  `;
  const body=main.querySelector("#reconciliation-body") as HTMLElement;
  const renderStart=()=>{
    body.innerHTML=`<div class="card reconciliation-card">
      <div class="reconciliation-controls">
        <div class="field"><label>Account</label><select id="r-acc">${accounts.map(a=>`<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Statement ending on</label><input id="r-date" class="input" type="date" value="${todayISO()}"/></div>
        <div class="field"><label>Statement balance</label><input id="r-bal" class="input" placeholder="124320.00"/></div>
        <button class="btn btn-primary" id="r-start">Start reconciliation</button>
      </div>
      <div id="r-eligible" class="small muted reconciliation-eligible"></div>
    </div>`;
    const loadEligible=async()=>{
      const account=(body.querySelector("#r-acc") as HTMLSelectElement).value;
      const date=(body.querySelector("#r-date") as HTMLInputElement).value;
      if(!account||!date) return;
      try{
        const txs=await invoke<TransactionRecord[]>("eligible_reconciliation_txns",{account, endingOn:date});
        const el=body.querySelector("#r-eligible") as HTMLElement|null;
        if(!el) return;
        if(!txs.length){ el.textContent="No eligible unreconciled transactions up to that date."; return; }
        el.innerHTML=`<div class="reconciliation-transaction-list">
          <div class="small muted" style="margin-bottom:6px">Select transactions that belong to this statement — balance must match.</div>
          ${txs.map(t=>{const destination=t.kind==="transfer"&&t.to_account_name===account;const amount=destination?(t.to_amount_cents??t.amount_cents):t.amount_cents;const code=destination?(t.to_account_currency_code??t.account_currency_code):t.account_currency_code;return `<label class="reconciliation-transaction"><input type="checkbox" value="${t.id}" data-txcb/> <span class="small">${t.txn_date} · ${esc(destination?t.to_account_name??t.account_name:t.account_name)} · ${esc(t.payee??t.category_name??"")} · <strong>${centsFmt(amount,code)}</strong> <span class="badge badge-${t.kind}">${t.kind}</span></span></label>`;}).join("")}
          <div class="reconciliation-selection-actions"><button class="btn btn-sm" type="button" id="r-select-all">Select all</button><button class="btn btn-sm" type="button" id="r-clear-all">Clear</button></div>
        </div>`;
        el.querySelector("#r-select-all")!.addEventListener("click",()=>el.querySelectorAll("[data-txcb]").forEach((c:any)=>c.checked=true));
        el.querySelector("#r-clear-all")!.addEventListener("click",()=>el.querySelectorAll("[data-txcb]").forEach((c:any)=>c.checked=false));
      }catch(e:any){
        const el=body.querySelector("#r-eligible") as HTMLElement|null;
        if(el) el.textContent=String(e);
      }
    };
    body.querySelector("#r-acc")!.addEventListener("change",()=>{
      reconciliationSelectedAccount = (body.querySelector("#r-acc") as HTMLSelectElement).value;
      loadEligible();
    });
    body.querySelector("#r-date")!.addEventListener("change",loadEligible);
    if(reconciliationSelectedAccount){
      const accSelect = body.querySelector("#r-acc") as HTMLSelectElement | null;
      if(accSelect && accounts.some(a=>a.name===reconciliationSelectedAccount)){
        accSelect.value = reconciliationSelectedAccount;
      }
    }
    void loadEligible();
    body.querySelector("#r-start")!.addEventListener("click", async()=>{
      const account=(body.querySelector("#r-acc") as HTMLSelectElement).value;
      const endingOn=(body.querySelector("#r-date") as HTMLInputElement).value;
      const balance=(body.querySelector("#r-bal") as HTMLInputElement).value.trim();
      const ids=Array.from(body.querySelectorAll("[data-txcb]:checked") as NodeListOf<HTMLInputElement>).map(c=>Number(c.value));
      if(!account||!endingOn||!balance){ toast("Account, date and balance required",true); return; }
      if(!ids.length){ toast("Select at least one transaction",true); return; }
      try{ const rid=await invoke<number>("start_reconciliation",{account, endingOn, balance, txnIds:ids}); toast(`Reconciliation #${rid} created`); renderReconciliation(main); }catch(e:any){ toast(String(e),true); }
    });
  };
  const renderHistory=()=>{
    body.innerHTML=`<div class="card reconciliation-card">
      <div class="card-title">Reconciliation history</div>
      <div class="table-wrap"><table><thead><tr><th>Account</th><th>Ending on</th><th>Statement</th><th>Cleared</th><th>Txns</th><th></th></tr></thead>
      <tbody>${recs.map(r=>`<tr><td>${esc(r.account_name)}</td><td class="small">${esc(r.statement_ending_on)}</td><td style="font-weight:700">${centsFmt(r.statement_balance_cents)}</td><td>${centsFmt(r.cleared_balance_cents)}</td><td>${r.transaction_count}</td><td><button class="btn btn-sm" data-del-rec="${r.id}">Remove</button></td></tr>`).join("") || `<tr><td colspan="6" class="empty">No reconciliations yet</td></tr>`}</tbody></table></div>
    </div>`;
    body.querySelectorAll("[data-del-rec]").forEach(b=>b.addEventListener("click", async()=>{
      const id=Number((b as HTMLElement).dataset.delRec);
      if(!confirm("Remove this reconciliation? This unlocks its transactions.")) return;
      try{ await invoke("delete_reconciliation",{id}); toast("Reconciliation removed"); renderReconciliation(main); }catch(e:any){ toast(String(e),true); }
    }));
  };
  const switchTab=(tab:"start"|"history")=>{
    main.querySelectorAll<HTMLElement>("[data-reconciliation-tab]").forEach(button=>{
      const active=button.dataset.reconciliationTab===tab;
      button.classList.toggle("active",active);
      button.setAttribute("aria-selected",String(active));
    });
    if(tab==="start") renderStart(); else renderHistory();
  };
  main.querySelectorAll<HTMLElement>("[data-reconciliation-tab]").forEach(button=>button.addEventListener("click",()=>switchTab(button.dataset.reconciliationTab as "start"|"history")));
  switchTab("start");
}

function highlightSelectedLoanRow(main:HTMLElement, id:number){
  main.querySelectorAll<HTMLElement>("[data-loan-id]").forEach(r=>{
    const isThis = Number(r.dataset.loanId) === id;
    r.classList.toggle("is-selected", isThis);
    const badge = r.querySelector(".loan-active-badge");
    const btn = r.querySelector(".loan-name-btn");
    btn?.classList.toggle("is-active", isThis);
    if(isThis && !badge){
      btn?.insertAdjacentHTML("beforeend", `<span class="loan-active-badge">Selected</span>`);
    } else if(!isThis && badge){
      badge.remove();
    }
  });
}

function renderLoanAmortizationSchedule(loan:LoanRecord):string{
  const balanceCents = loan.outstanding_cents;
  const emiCents = loan.emi_cents;
  const rateBps = loan.annual_rate_bps;

  if(balanceCents <= 0){
    return `<div class="small muted" style="padding:16px 0">This loan is fully paid off! No outstanding balance.</div>`;
  }
  if(emiCents <= 0){
    return `<div class="small muted" style="padding:16px 0">Set a monthly EMI to view the projected schedule.</div>`;
  }

  const monthlyRate = rateBps !== null ? (rateBps / 10000) / 12 : 0;
  const firstMonthInterest = Math.round(balanceCents * monthlyRate);
  if(monthlyRate > 0 && emiCents <= firstMonthInterest){
    return `<div class="small muted" style="padding:16px 0;color:var(--danger)">
      The current monthly EMI (${centsFmt(emiCents)}) does not cover monthly interest (${centsFmt(firstMonthInterest)}). Outstanding balance would grow rather than reduce.
    </div>`;
  }

  // Generate up to 12 scheduled installments
  let rem = balanceCents;
  const rows: Array<{monthIdx:number; dateStr:string; payment:number; principal:number; interest:number; balance:number}> = [];
  
  let baseDate = loan.next_due_on ? new Date(loan.next_due_on + "T12:00:00") : new Date();
  if(isNaN(baseDate.getTime())) baseDate = new Date();

  for(let i = 1; i <= 12 && rem > 0; i++){
    const interest = Math.round(rem * monthlyRate);
    const totalDue = rem + interest;
    const payment = Math.min(emiCents, totalDue);
    const principalPaid = payment - interest;
    rem = Math.max(0, rem - principalPaid);
    
    // Calculate projected date for this installment
    const instDate = new Date(baseDate);
    instDate.setMonth(baseDate.getMonth() + (i - 1));
    const dateFormatted = instDate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

    rows.push({
      monthIdx: i,
      dateStr: dateFormatted,
      payment,
      principal: principalPaid,
      interest,
      balance: rem
    });
  }

  return `
    <div class="table-wrap">
      <table class="account-tx-table" style="font-size:12px">
        <thead>
          <tr>
            <th>#</th>
            <th>Due Period</th>
            <th style="text-align:right">Installment</th>
            <th style="text-align:right">Principal</th>
            <th style="text-align:right">Interest</th>
            <th style="text-align:right">Ending Balance</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="muted">${r.monthIdx}</td>
              <td><strong>${esc(r.dateStr)}</strong></td>
              <td style="text-align:right;font-weight:700">${centsFmt(r.payment)}</td>
              <td style="text-align:right;color:var(--accent)">${centsFmt(r.principal)}</td>
              <td style="text-align:right;color:var(--danger)">${centsFmt(r.interest)}</td>
              <td style="text-align:right;font-weight:700">${centsFmt(r.balance)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function renderLoanDetails(container:HTMLElement, loanId:number, allLoans:LoanRecord[]){
  const renderVersion = ++loanDetailRenderVersion;
  const loan = allLoans.find(l=>l.id===loanId);
  if(!loan){
    container.innerHTML="";
    return;
  }

  container.innerHTML=`
    <div class="loan-detail-loading">
      <div class="small muted">Loading analytics and payment history for <strong>${esc(loan.name)}</strong>…</div>
    </div>
  `;

  // Fetch linked ledger transactions matching loan name or lender
  let matchedTxns: TransactionRecord[] = [];
  let recurringRules: RecurringRuleRecord[] = [];
  try {
    const [txRes, recRes] = await Promise.all([
      invoke<TransactionRecord[]>("list_transactions", {
        req: { search: loan.name, limit: 30, include_deleted: false, sort_by: "date", sort_dir: "desc" }
      }).catch(()=>[]),
      invoke<RecurringRuleRecord[]>("list_recurring").catch(()=>[])
    ]);
    matchedTxns = txRes;
    recurringRules = recRes;
  } catch {}

  // Also check if lender exists and find any more
  if(loan.lender && loan.lender.trim()){
    try {
      const lenderTx = await invoke<TransactionRecord[]>("list_transactions", {
        req: { search: loan.lender.trim(), limit: 20, include_deleted: false, sort_by: "date", sort_dir: "desc" }
      }).catch(()=>[]);
      for(const t of lenderTx){
        if(!matchedTxns.some(m=>m.id === t.id)){
          matchedTxns.push(t);
        }
      }
      matchedTxns.sort((a,b)=>b.txn_date.localeCompare(a.txn_date));
    } catch {}
  }

  if(renderVersion !== loanDetailRenderVersion || selectedLoanId !== loanId) return;

  // Repayment math & metrics
  const principal = loan.principal_cents;
  const outstanding = loan.outstanding_cents;
  const emi = loan.emi_cents;
  const paidCents = Math.max(0, principal - outstanding);
  const paidPct = principal > 0 ? Math.min(100, Math.max(0, Math.round((paidCents / principal) * 100))) : 0;
  const remainingPct = 100 - paidPct;

  const rateBps = loan.annual_rate_bps;
  const annualRatePct = rateBps !== null ? (rateBps / 100).toFixed(2) + "%" : null;
  const monthlyRate = rateBps !== null ? (rateBps / 10000) / 12 : 0;

  // Estimate months remaining and interest
  let estMonthsRemaining: number | null = null;
  let totalInterestRemainingCents: number | null = null;

  if(emi > 0 && outstanding > 0){
    if(monthlyRate === 0){
      estMonthsRemaining = Math.ceil(outstanding / emi);
      totalInterestRemainingCents = 0;
    } else {
      const firstInterest = Math.round(outstanding * monthlyRate);
      if(emi > firstInterest){
        // Amortization formula: n = -log(1 - (r * P)/EMI) / log(1 + r)
        const n = -Math.log(1 - (monthlyRate * outstanding) / emi) / Math.log(1 + monthlyRate);
        estMonthsRemaining = Math.ceil(n);
        const totalPayments = estMonthsRemaining * emi;
        totalInterestRemainingCents = Math.max(0, totalPayments - outstanding);
      }
    }
  }

  // Estimated payoff date
  let estPayoffDateStr: string = "—";
  if(estMonthsRemaining !== null && estMonthsRemaining > 0){
    const d = loan.next_due_on ? new Date(loan.next_due_on + "T12:00:00") : new Date();
    if(!isNaN(d.getTime())){
      d.setMonth(d.getMonth() + estMonthsRemaining);
      estPayoffDateStr = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
  } else if(outstanding === 0){
    estPayoffDateStr = "Fully Paid Off";
  }

  // Linked recurring rules (matching loan name or lender)
  const linkedRecurring = (recurringRules || []).filter(r => {
    const searchTarget = (r.name + " " + (r.payee ?? "") + " " + (r.note ?? "")).toLowerCase();
    const loanKey = loan.name.toLowerCase();
    const lenderKey = (loan.lender ?? "").toLowerCase();
    return searchTarget.includes(loanKey) || (lenderKey && searchTarget.includes(lenderKey));
  });

  // Calculate total paid via matched ledger transactions
  const matchedLedgerSpent = matchedTxns.filter(t=>t.kind==="expense").reduce((sum,t)=>sum+t.amount_cents, 0);

  // Status helper
  const isPaidOff = outstanding === 0;
  let dueStatusHtml = `<span class="badge badge-cash">No due date</span>`;
  if(loan.next_due_on){
    const today = todayISO();
    if(loan.next_due_on < today){
      dueStatusHtml = `<span class="badge badge-expense">Overdue (${esc(loan.next_due_on)})</span>`;
    } else if(loan.next_due_on === today){
      dueStatusHtml = `<span class="badge badge-warn" style="background:var(--warn);color:#fff">Due Today</span>`;
    } else {
      dueStatusHtml = `<span class="badge badge-income">Due ${esc(loan.next_due_on)}</span>`;
    }
  }

  container.innerHTML=`
    <div class="loan-detail-section">
      <div class="loan-detail-head">
        <div>
          <div class="loan-detail-title-wrap">
            <h3 class="loan-detail-title">${esc(loan.name)}</h3>
            ${loan.lender ? `<span class="badge badge-cash">${esc(loan.lender)}</span>` : ''}
            ${annualRatePct ? `<span class="pill">${annualRatePct} APR</span>` : '<span class="pill">0% / Unspecified</span>'}
            ${isPaidOff ? '<span class="pill pill-success">Paid Off</span>' : dueStatusHtml}
            <span class="muted small">Loan #${loan.id}</span>
          </div>
          <div class="small muted" style="margin-top:4px">
            Principal ${centsFmt(principal)} · EMI ${centsFmt(emi)}/mo · Recorded ${esc(loan.created_at.slice(0,10))}
          </div>
        </div>
        <div class="loan-detail-actions">
          <button class="btn btn-primary btn-sm" id="loan-act-payment">💳 Record Payment</button>
          <button class="btn btn-sm" id="loan-act-edit">✏️ Edit Loan</button>
          <button class="btn btn-sm" id="loan-act-ledger">📜 Search Ledger</button>
          <button class="btn btn-sm" id="loan-act-delete" style="color:var(--danger)">Remove</button>
        </div>
      </div>

      <!-- Progress bar of payoff -->
      <div class="card" style="padding:16px 20px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div>
            <strong style="font-size:14px">Payoff Progress</strong>
            <span class="muted small" style="margin-left:8px">${paidPct}% principal cleared (${centsFmt(paidCents)} paid)</span>
          </div>
          <div style="text-align:right">
            <span class="amount-neg" style="font-weight:800;font-size:15px">${centsFmt(outstanding)}</span>
            <span class="muted small"> remaining (${remainingPct}%)</span>
          </div>
        </div>
        <div class="progress" style="height:12px;border-radius:6px;background:var(--surface-2);border:1px solid var(--border)">
          <div class="progress-fill ok" style="width:${Math.max(2, paidPct)}%;height:100%;border-radius:5px;transition:width 0.4s ease"></div>
        </div>
      </div>

      <!-- Stat grid -->
      <div class="stat-grid">
        <div class="card stat">
          <div class="label">Original Principal</div>
          <div class="value">${centsFmt(principal)}</div>
          <div class="sub">Total borrowed amount</div>
        </div>
        <div class="card stat">
          <div class="label">Current Outstanding</div>
          <div class="value amount-neg">${centsFmt(outstanding)}</div>
          <div class="sub">${paidPct}% paid off to date</div>
        </div>
        <div class="card stat">
          <div class="label">Monthly Installment (EMI)</div>
          <div class="value">${centsFmt(emi)}</div>
          <div class="sub">Regular monthly commitment</div>
        </div>
        <div class="card stat">
          <div class="label">Interest Rate (APR)</div>
          <div class="value">${annualRatePct ?? "—"}</div>
          <div class="sub">${rateBps !== null ? `${(rateBps / 1200).toFixed(3)}% per month` : "No rate configured"}</div>
        </div>
        <div class="card stat">
          <div class="label">Est. Time Remaining</div>
          <div class="value ${isPaidOff ? 'text-positive' : ''}">
            ${isPaidOff ? "0 months" : (estMonthsRemaining !== null ? `${estMonthsRemaining} mo${estMonthsRemaining === 1 ? '' : 's'}` : "—")}
          </div>
          <div class="sub">${estMonthsRemaining !== null && estMonthsRemaining >= 12 ? `${(estMonthsRemaining / 12).toFixed(1)} years` : "Based on current EMI"}</div>
        </div>
        <div class="card stat">
          <div class="label">Est. Payoff Date</div>
          <div class="value" style="font-size:16px">${estPayoffDateStr}</div>
          <div class="sub">${loan.next_due_on ? `Next due: ${esc(loan.next_due_on)}` : "No due date set"}</div>
        </div>
        <div class="card stat">
          <div class="label">Est. Remaining Interest</div>
          <div class="value" style="color:var(--danger)">
            ${totalInterestRemainingCents !== null ? centsFmt(totalInterestRemainingCents) : "—"}
          </div>
          <div class="sub">${totalInterestRemainingCents !== null && emi > 0 ? `Total payable: ${centsFmt(outstanding + totalInterestRemainingCents)}` : "At constant rate"}</div>
        </div>
        <div class="card stat">
          <div class="label">Ledger Matched Payments</div>
          <div class="value text-positive">${centsFmt(matchedLedgerSpent)}</div>
          <div class="sub">${matchedTxns.length} payment transaction${matchedTxns.length === 1 ? '' : 's'}</div>
        </div>
      </div>

      <!-- 2 column: 12-Month Projected Amortization Schedule & Linked Recurring / Subscriptions -->
      <div class="grid2">
        <div class="card">
          <div class="card-head-row">
            <div>
              <div class="card-title">12-Month Amortization Projection</div>
              <div class="small muted">Projected breakdown of upcoming principal vs interest installments</div>
            </div>
          </div>
          ${renderLoanAmortizationSchedule(loan)}
        </div>

        <div class="card">
          <div class="card-head-row">
            <div>
              <div class="card-title">Automated Recurring Bills & Rules</div>
              <div class="small muted">Scheduled auto-debits matching this loan</div>
            </div>
            <span class="pill">${linkedRecurring.length} linked</span>
          </div>
          <div class="account-item-list">
            ${linkedRecurring.length ? linkedRecurring.map(r => `
              <div class="account-item-row">
                <div>
                  <div style="display:flex;gap:6px;align-items:center">
                    <strong>${esc(r.name)}</strong>
                    <span class="badge badge-${r.kind}">${r.kind}</span>
                    ${r.paused ? '<span class="pill">Paused</span>' : '<span class="pill pill-success">Active</span>'}
                  </div>
                  <div class="small muted" style="margin-top:2px">
                    ${r.cadence === "monthly" ? `Monthly on day ${r.day_of_month ?? 1}` : `Weekly on ${r.weekday ?? 'Mon'}`}
                    · Next due: ${esc(r.next_due_on)}
                    ${r.payee ? ` · Payee: ${esc(r.payee)}` : ''}
                  </div>
                </div>
                <div style="font-weight:700">${centsFmt(r.amount_cents)}</div>
              </div>
            `).join("") : `
              <div class="muted small" style="padding:16px 0">
                No recurring automation linked with name "${esc(loan.name)}"${loan.lender ? ` or "${esc(loan.lender)}"` : ""}.
                <div style="margin-top:8px">
                  <button class="btn btn-sm" id="loan-create-recurring">+ Set up recurring EMI bill</button>
                </div>
              </div>
            `}
          </div>
        </div>
      </div>

      <!-- Recent Ledger Activity matching this loan -->
      <div class="card">
        <div class="card-head-row">
          <div>
            <div class="card-title">Recent Ledger Payments</div>
            <div class="small muted">Transactions in your ledger referencing <strong>${esc(loan.name)}</strong>${loan.lender ? ` or <strong>${esc(loan.lender)}</strong>` : ""}</div>
          </div>
          <button class="btn btn-sm" id="loan-view-all-txns">Search all transactions (${matchedTxns.length}) →</button>
        </div>
        <div class="table-wrap">
          <table class="account-tx-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Account</th>
                <th>Payee / Description</th>
                <th>Category</th>
                <th style="text-align:right">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${matchedTxns.length ? matchedTxns.slice(0, 8).map(t => {
                const acc = accounts.find(a=>a.name===t.account_name || a.id===t.account_id);
                const accCur = acc?.currency_code ?? t.account_currency_code ?? currency;
                return `<tr>
                  <td class="small muted">${esc(t.txn_date)}</td>
                  <td><span class="badge badge-${t.kind}">${t.kind}</span></td>
                  <td><span class="pill">${esc(t.account_name)}</span></td>
                  <td>
                    <strong>${esc(t.payee || t.note || "Payment")}</strong>
                    ${t.note && t.payee ? `<div class="small muted">${esc(t.note)}</div>` : ''}
                  </td>
                  <td><span class="badge badge-cash">${esc(t.category_name ?? "Uncategorized")}</span></td>
                  <td style="text-align:right;font-weight:700" class="${t.kind === 'income' ? 'text-positive' : 'text-negative'}">
                    ${t.kind === 'income' ? '+' : '-'}${centsFmt(t.amount_cents, accCur)}
                  </td>
                </tr>`;
              }).join("") : `
                <tr>
                  <td colspan="6" class="empty">No ledger transactions found matching this loan. Click "Record Payment" to log an EMI payment.</td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Action listeners
  container.querySelector("#loan-act-edit")?.addEventListener("click", () => {
    openLoanModal(loan);
  });

  container.querySelector("#loan-act-delete")?.addEventListener("click", async () => {
    if(!confirm(`Remove loan "${loan.name}"?`)) return;
    try {
      await invoke("delete_loan", { id: loan.id });
      toast("Loan removed");
      selectedLoanId = null;
      renderLoans($("#main"));
    } catch(e:any) {
      toast(String(e), true);
    }
  });

  const openLedgerWithLoanFilter = () => {
    navigateTo(()=>{
      txFilters = {
        from: "",
        to: "",
        accounts: [],
        categories: [],
        kinds: [],
        search: loan.name,
        include_deleted: false,
        limit: 100,
        sort_by: "date",
        sort_dir: "desc"
      };
      view = "transactions";
    });
  };

  container.querySelector("#loan-act-ledger")?.addEventListener("click", openLedgerWithLoanFilter);
  container.querySelector("#loan-view-all-txns")?.addEventListener("click", openLedgerWithLoanFilter);

  container.querySelector("#loan-create-recurring")?.addEventListener("click", () => {
    openRecurringModal({
      id: 0,
      name: `${loan.name} EMI`,
      kind: "expense",
      cadence: "monthly",
      interval: 1,
      day_of_month: loan.next_due_on ? Number(loan.next_due_on.slice(8,10)) || 1 : 1,
      weekday: null,
      account_id: accounts[0]?.id ?? 0,
      account_name: accounts[0]?.name ?? "",
      to_account_id: null,
      to_account_name: null,
      category_id: null,
      category_name: null,
      amount_cents: loan.emi_cents,
      payee: loan.lender || loan.name,
      note: `Monthly EMI for ${loan.name}`,
      start_on: loan.next_due_on || todayISO(),
      end_on: null,
      next_due_on: loan.next_due_on || todayISO(),
      paused: false,
      created_at: "",
      updated_at: ""
    });
  });

  container.querySelector("#loan-act-payment")?.addEventListener("click", () => {
    openLoanPaymentModal(loan);
  });
}

function openLoanPaymentModal(loan:LoanRecord){
  const root = document.getElementById("modal-root")!;
  const defaultAccount = accounts[0]?.name ?? "";
  const defaultEmi = (loan.emi_cents / 100).toFixed(2);
  const nextMonthDate = loan.next_due_on ? comparisonShiftMonths(loan.next_due_on, 1) : "";

  root.innerHTML = `
    <div class="modal-backdrop" id="loan-pay-bd">
      <div class="modal">
        <div class="modal-head">
          <h3>Record payment for ${esc(loan.name)}</h3>
          <button class="btn btn-ghost" id="loan-pay-x">✕</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>Payment amount</label>
            <input id="loan-pay-amount" class="input" value="${defaultEmi}" placeholder="e.g. 25000.00"/>
            <div class="small muted" style="margin-top:4px">The full payment is recorded as a cash expense; only principal reduces outstanding debt.</div>
          </div>
          <div class="field">
            <label>Interest included in payment</label>
            <input id="loan-pay-interest" class="input" placeholder="Enter statement interest, or 0 for principal only"/>
            <div class="small muted" style="margin-top:4px">Use the actual interest from your statement. Principal equals payment minus interest.</div>
          </div>
          <div class="field">
            <label>Payment date</label>
            <input id="loan-pay-date" class="input" type="date" value="${loan.next_due_on ?? todayISO()}"/>
          </div>
          <div class="field">
            <label>Next due date after this payment</label>
            <input id="loan-pay-next-due" class="input" type="date" value="${nextMonthDate}"/>
            <div class="small muted" style="margin-top:4px">Automatically advances 1 month by default.</div>
          </div>
          <div style="border-top:1px solid var(--border);margin:12px 0;padding-top:12px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600">
              <input type="checkbox" id="loan-pay-record-tx" checked/>
              Also record expense transaction in ledger
            </label>
          </div>
          <div id="loan-pay-tx-fields">
            <div class="field">
              <label>Pay from account</label>
              <select id="loan-pay-account" class="input">
                ${accounts.filter(a=>a.currency_code===currency).map(a=>`<option value="${esc(a.name)}" ${a.name===defaultAccount?"selected":""}>${esc(a.name)} (${esc(a.currency_code)})</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>Expense category</label>
              <select id="loan-pay-cat" class="input">
                <option value="">Select a category</option>
                ${categories.filter(c=>c.kind==="expense").map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>Note / reference (optional)</label>
              <input id="loan-pay-note" class="input" value="EMI payment - ${esc(loan.name)}"/>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="loan-pay-cancel">Cancel</button>
          <button class="btn btn-primary" id="loan-pay-save">Confirm payment</button>
        </div>
      </div>
    </div>
  `;

  const close = () => { root.innerHTML = ""; };
  root.querySelector("#loan-pay-x")!.addEventListener("click", close);
  root.querySelector("#loan-pay-cancel")!.addEventListener("click", close);
  root.querySelector("#loan-pay-bd")!.addEventListener("click", (e) => {
    if(e.target === e.currentTarget) close();
  });

  const chkTx = root.querySelector("#loan-pay-record-tx") as HTMLInputElement;
  const txFields = root.querySelector("#loan-pay-tx-fields") as HTMLElement;
  chkTx.addEventListener("change", () => {
    txFields.style.display = chkTx.checked ? "block" : "none";
  });

  root.querySelector("#loan-pay-save")!.addEventListener("click", async () => {
    const saveButton = root.querySelector<HTMLButtonElement>("#loan-pay-save")!;
    if(saveButton.disabled) return;
    const amtStr = (root.querySelector("#loan-pay-amount") as HTMLInputElement).value.trim();
    const interest = (root.querySelector("#loan-pay-interest") as HTMLInputElement).value.trim();
    const payDate = (root.querySelector("#loan-pay-date") as HTMLInputElement).value.trim();
    const nextDue = (root.querySelector("#loan-pay-next-due") as HTMLInputElement).value.trim() || null;
    const shouldRecordTx = chkTx.checked;
    const accName = (root.querySelector("#loan-pay-account") as HTMLSelectElement)?.value || null;
    const catName = (root.querySelector("#loan-pay-cat") as HTMLSelectElement)?.value || null;
    const note = (root.querySelector("#loan-pay-note") as HTMLInputElement)?.value.trim() || null;

    if(!amtStr){
      toast("Please enter a payment amount", true);
      return;
    }
    if(!interest){
      toast("Enter the interest included in this payment (0 for principal only)", true);
      return;
    }
    const amtNum = parseFloat(amtStr);
    if(isNaN(amtNum) || amtNum <= 0){
      toast("Payment amount must be positive", true);
      return;
    }
    saveButton.disabled = true;
    try {
      if(shouldRecordTx && (!accName || !catName)) {
        toast("Choose an account and expense category", true);
        return;
      }
      await invoke("record_loan_payment", {
        id: loan.id, amount: amtStr, interest, date: payDate || todayISO(), nextDueOn: nextDue,
        account: shouldRecordTx ? accName : null, category: shouldRecordTx ? catName : null, note
      });
      toast("Payment recorded successfully!");
      close();
      await refreshCore();
      renderLoans($("#main"));
    } catch(e:any) {
      toast(String(e), true);
    } finally {
      saveButton.disabled = false;
    }
  });
}

async function renderLoans(main:HTMLElement){
  let loans:LoanRecord[]=[]; try{ loans=await invoke<LoanRecord[]>("list_loans"); }catch(e:any){toast(String(e),true)}
  const outstanding=loans.reduce((sum,l)=>sum+l.outstanding_cents,0), emi=loans.reduce((sum,l)=>sum+l.emi_cents,0);

  if(selectedLoanId === null && loans.length > 0){
    selectedLoanId = loans[0].id;
  }
  if(selectedLoanId !== null && !loans.some(l=>l.id===selectedLoanId)){
    selectedLoanId = loans.length > 0 ? loans[0].id : null;
  }

  main.innerHTML=`<div class="page-head" style="display:flex;justify-content:space-between;align-items:flex-end">
      <div>
        <h2>Loans & EMIs</h2>
        <p>Click any loan name to view amortization schedule, payment calculator, and linked transactions.</p>
      </div>
      <button class="btn btn-primary" id="add-loan">+ Loan / EMI</button>
    </div>
    <div class="stat-grid">
      <div class="card stat">
        <div class="label">Total outstanding</div>
        <div class="value amount-neg">${centsFmt(outstanding)}</div>
      </div>
      <div class="card stat">
        <div class="label">Monthly EMIs</div>
        <div class="value">${centsFmt(emi)}</div>
        <div class="sub">Across ${loans.length} loan${loans.length===1?"":"s"}</div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Loan</th>
            <th>Principal</th>
            <th>Outstanding</th>
            <th>EMI</th>
            <th>Rate</th>
            <th>Next due</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${loans.map(l=>{
            const isSelected = l.id === selectedLoanId;
            return `<tr class="loan-row ${isSelected ? 'is-selected' : ''}" data-loan-id="${l.id}">
              <td>
                <button type="button" class="loan-name-btn ${isSelected ? 'is-active' : ''}" data-select-loan="${l.id}" title="Click to view details for ${esc(l.name)}">
                  <span class="loan-name-text">${esc(l.name)}</span>
                  <span class="muted small">#${l.id}</span>
                  ${isSelected ? '<span class="loan-active-badge">Selected</span>' : ''}
                </button>
                <div class="small muted">${esc(l.lender??"")}</div>
              </td>
              <td>${centsFmt(l.principal_cents)}</td>
              <td class="amount-neg" style="font-weight:700">${centsFmt(l.outstanding_cents)}</td>
              <td>${centsFmt(l.emi_cents)}</td>
              <td>${l.annual_rate_bps===null?"—":`${(l.annual_rate_bps/100).toFixed(2)}%`}</td>
              <td>${esc(l.next_due_on??"—")}</td>
              <td>
                <div style="display:flex;gap:6px">
                  <button class="btn btn-sm" data-pay-loan="${l.id}">Pay</button>
                  <button class="btn btn-sm" data-edit-loan="${l.id}">Edit</button>
                  <button class="btn btn-sm" data-delete-loan="${l.id}">Remove</button>
                </div>
              </td>
            </tr>`;
          }).join("")||`<tr><td colspan="7" class="empty">No loans tracked yet. Click "+ Loan / EMI" to add one.</td></tr>`}
        </tbody>
      </table>
    </div>
    <div id="loan-detail-root" class="loan-detail-root"></div>
  `;

  const detailRoot = main.querySelector("#loan-detail-root") as HTMLElement;
  const selectLoan = (id:number) => {
    if(selectedLoanId === id) return;
    pushNavigationState();
    selectedLoanId = id;
    highlightSelectedLoanRow(main, id);
    if(detailRoot) renderLoanDetails(detailRoot, id, loans);
    updateTopbarBackButton();
  };

  main.querySelectorAll<HTMLElement>("[data-select-loan]").forEach(btn=>{
    btn.addEventListener("click",(e)=>{
      e.stopPropagation();
      selectLoan(Number(btn.dataset.selectLoan));
    });
  });

  main.querySelectorAll<HTMLElement>("[data-loan-id]").forEach(row=>{
    row.addEventListener("click",(e)=>{
      if((e.target as HTMLElement).closest("button")) return;
      selectLoan(Number(row.dataset.loanId));
    });
  });

  main.querySelector("#add-loan")!.addEventListener("click",()=>openLoanModal());
  
  main.querySelectorAll("[data-pay-loan]").forEach(button=>button.addEventListener("click",(e)=>{
    e.stopPropagation();
    const id = Number((button as HTMLElement).dataset.payLoan);
    const loan = loans.find(l=>l.id===id);
    if(loan) openLoanPaymentModal(loan);
  }));

  main.querySelectorAll("[data-edit-loan]").forEach(button=>button.addEventListener("click",(e)=>{
    e.stopPropagation();
    const id = Number((button as HTMLElement).dataset.editLoan);
    const loan = loans.find(l=>l.id===id);
    if(loan) openLoanModal(loan);
  }));

  main.querySelectorAll("[data-delete-loan]").forEach(button=>button.addEventListener("click",async(e)=>{
    e.stopPropagation();
    if(!confirm("Remove this loan record?")) return;
    try {
      await invoke("delete_loan",{id:Number((button as HTMLElement).dataset.deleteLoan)});
      if(selectedLoanId === Number((button as HTMLElement).dataset.deleteLoan)) selectedLoanId = null;
      renderLoans(main);
    } catch(e:any) {
      toast(String(e),true);
    }
  }));

  if(selectedLoanId !== null && detailRoot){
    renderLoanDetails(detailRoot, selectedLoanId, loans);
  }
}
function openLoanModal(existing?:LoanRecord){
  const root=document.getElementById("modal-root")!;
  root.innerHTML=`<div class="modal-backdrop" id="bd">
    <div class="modal">
      <div class="modal-head">
        <h3>${existing ? "Edit loan / EMI" : "Add loan / EMI"}</h3>
        <button class="btn btn-ghost" id="x">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>Loan name</label>
          <input id="loan-name" class="input" placeholder="Home loan" value="${esc(existing?.name ?? "")}"/>
        </div>
        <div class="field">
          <label>Lender (optional)</label>
          <input id="loan-lender" class="input" placeholder="Bank name" value="${esc(existing?.lender ?? "")}"/>
        </div>
        <div class="row">
          <div class="field">
            <label>Original principal</label>
            <input id="loan-principal" class="input" placeholder="2500000" value="${existing ? (existing.principal_cents/100).toFixed(2) : ""}"/>
          </div>
          <div class="field">
            <label>Outstanding now</label>
            <input id="loan-outstanding" class="input" placeholder="1800000" value="${existing ? (existing.outstanding_cents/100).toFixed(2) : ""}"/>
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label>Monthly EMI</label>
            <input id="loan-emi" class="input" placeholder="25000" value="${existing ? (existing.emi_cents/100).toFixed(2) : ""}"/>
          </div>
          <div class="field">
            <label>Annual rate % (optional)</label>
            <input id="loan-rate" class="input" placeholder="8.50" value="${existing && existing.annual_rate_bps !== null ? (existing.annual_rate_bps/100).toFixed(2) : ""}"/>
          </div>
        </div>
        <div class="field">
          <label>Next due date (optional)</label>
          <input id="loan-due" class="input" type="date" value="${esc(existing?.next_due_on ?? "")}"/>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" id="cancel">Cancel</button>
        <button class="btn btn-primary" id="save">${existing ? "Update" : "Save"}</button>
      </div>
    </div>
  </div>`;

  const close=()=>root.innerHTML="";
  root.querySelector("#x")!.addEventListener("click",close);
  root.querySelector("#cancel")!.addEventListener("click",close);
  root.querySelector("#bd")!.addEventListener("click",e=>{if(e.target===e.currentTarget)close()});
  
  root.querySelector("#save")!.addEventListener("click",async()=>{
    const name = (root.querySelector("#loan-name") as HTMLInputElement).value;
    const lender = (root.querySelector("#loan-lender") as HTMLInputElement).value || null;
    const principal = (root.querySelector("#loan-principal") as HTMLInputElement).value;
    const outstanding = (root.querySelector("#loan-outstanding") as HTMLInputElement).value;
    const emi = (root.querySelector("#loan-emi") as HTMLInputElement).value;
    const annual_rate = (root.querySelector("#loan-rate") as HTMLInputElement).value || null;
    const next_due_on = (root.querySelector("#loan-due") as HTMLInputElement).value || null;

    try{
      if(existing){
        await invoke("edit_loan", {
          req: { id: existing.id, name, lender, principal, outstanding, emi, annual_rate, next_due_on }
        });
        toast("Loan updated");
      } else {
        await invoke("add_loan", {
          req: { name, lender, principal, outstanding, emi, annual_rate, next_due_on }
        });
        toast("Loan added");
      }
      close();
      renderLoans($("#main"));
    }catch(e:any){
      toast(String(e),true);
    }
  });
}

let netWorthActiveTab: "all" | "assets" | "liabilities" | "offledger" = "all";
let netWorthSearchQuery = "";
let netWorthRenderVersion = 0;

function inferNetWorthCategory(item: NetWorthItemRecord): { label: string; cls: string; icon: string } {
  const text = `${item.name} ${item.note ?? ""}`.toLowerCase();
  if (item.kind === "asset") {
    if (text.match(/house|home|condo|property|apartment|land|flat|villa|real estate|realty|residence/)) {
      return { label: "Real Estate", cls: "pill-realestate", icon: "🏡" };
    }
    if (text.match(/car|truck|vehicle|bike|motorcycle|boat|auto|tesla|honda|bmw|ford|toyota/)) {
      return { label: "Vehicle", cls: "pill-vehicle", icon: "🚗" };
    }
    if (text.match(/gold|silver|jewelry|watch|art|collectible|antique|precious/)) {
      return { label: "Valuables", cls: "pill-valuables", icon: "🪙" };
    }
    if (text.match(/equity|startup|angel|safe|stock|shares|crypto|fund|private/)) {
      return { label: "Private Equity", cls: "pill-equity", icon: "📈" };
    }
    return { label: "Off-Ledger Asset", cls: "pill-other-asset", icon: "📦" };
  } else {
    if (text.match(/tax|irs|revenue|hmrc|vat/)) {
      return { label: "Tax Due", cls: "pill-tax", icon: "🏛️" };
    }
    if (text.match(/personal|family|friend|borrow|brother|sister|parent|relative/)) {
      return { label: "Personal Debt", cls: "pill-personal-debt", icon: "🤝" };
    }
    if (text.match(/promissory|note|contract|business|vendor|payable/)) {
      return { label: "Contract / Note", cls: "pill-contract", icon: "📄" };
    }
    return { label: "Off-Ledger Debt", cls: "pill-other-liability", icon: "💳" };
  }
}

function netWorthEvolutionChart(points: BalanceTrendPoint[]): string {
  if (!points || !points.length) {
    return `<div class="chart-empty">12-month net worth history will appear here as your balance evolves.</div>`;
  }
  const width = 760, height = 180, padL = 75, padR = 25, padT = 20, padB = 35;
  const chartW = width - padL - padR, chartH = height - padT - padB;
  const values = points.map(p => p.balance_cents);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const span = Math.max(maxVal - minVal, 100);

  const xFor = (i: number) => points.length <= 1 ? padL + chartW / 2 : padL + i * (chartW / (points.length - 1));
  const yFor = (val: number) => padT + chartH - ((val - minVal) / span) * chartH;

  const yMax = yFor(maxVal);
  const yMid = yFor(minVal + span / 2);
  const yMin = yFor(minVal);

  const zeroLine = (minVal <= 0 && maxVal >= 0)
    ? `<line class="networth-chart-zero-line" x1="${padL}" x2="${width - padR}" y1="${yFor(0)}" y2="${yFor(0)}" />`
    : "";

  const areaPoints = [
    `M ${xFor(0).toFixed(1)} ${(padT + chartH).toFixed(1)}`,
    ...points.map((p, i) => `L ${xFor(i).toFixed(1)} ${yFor(p.balance_cents).toFixed(1)}`),
    `L ${xFor(points.length - 1).toFixed(1)} ${(padT + chartH).toFixed(1)}`,
    "Z",
  ].join(" ");

  const linePoints = points.map((p, i) => `${xFor(i).toFixed(1)},${yFor(p.balance_cents).toFixed(1)}`).join(" ");

  const dots = points.map((p, i) => {
    const prev = i > 0 ? points[i - 1].balance_cents : null;
    const diff = prev !== null ? p.balance_cents - prev : null;
    const diffText = diff !== null ? ` (${diff >= 0 ? "+" : ""}${centsFmt(diff)} MoM)` : "";
    const tooltip = `${p.month} · Net Worth: ${centsFmt(p.balance_cents)}${diffText}`;
    return `<circle class="networth-chart-dot" cx="${xFor(i).toFixed(1)}" cy="${yFor(p.balance_cents).toFixed(1)}" r="3.5" data-dashboard-tooltip="${esc(tooltip)}" tabindex="0"/>`;
  }).join("");

  const xLabels = points.map((p, i) => {
    const show = points.length <= 6 || i % 2 === 0 || i === points.length - 1;
    if (!show) return "";
    return `<text class="networth-chart-axis-text" x="${xFor(i).toFixed(1)}" y="${height - 10}" text-anchor="middle">${esc(p.month.slice(5))}</text>`;
  }).join("");

  return `
    <div class="networth-chart-wrap">
      <svg class="networth-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="12-Month Net Worth Trend">
        <defs>
          <linearGradient id="nw-chart-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#2563eb" stop-opacity="0.22" />
            <stop offset="100%" stop-color="#2563eb" stop-opacity="0.01" />
          </linearGradient>
        </defs>
        <line class="networth-chart-grid-line" x1="${padL}" x2="${width - padR}" y1="${yMax}" y2="${yMax}" />
        <text class="networth-chart-axis-text" x="${padL - 8}" y="${yMax + 4}" text-anchor="end">${centsFmt(maxVal)}</text>

        <line class="networth-chart-grid-line" x1="${padL}" x2="${width - padR}" y1="${yMid}" y2="${yMid}" />
        <text class="networth-chart-axis-text" x="${padL - 8}" y="${yMid + 4}" text-anchor="end">${centsFmt(Math.round(minVal + span / 2))}</text>

        <line class="networth-chart-grid-line" x1="${padL}" x2="${width - padR}" y1="${yMin}" y2="${yMin}" />
        <text class="networth-chart-axis-text" x="${padL - 8}" y="${yMin + 4}" text-anchor="end">${centsFmt(minVal)}</text>

        ${zeroLine}
        <path class="networth-chart-area" d="${areaPoints}" fill="url(#nw-chart-grad)" />
        <polyline class="networth-chart-line" points="${linePoints}" />
        ${dots}
        ${xLabels}
      </svg>
    </div>
  `;
}

async function renderNetWorth(main:HTMLElement){
  const renderVersion = ++netWorthRenderVersion;
  let snapshot: NetWorthSnapshot | null = null;
  let items: NetWorthItemRecord[] = [];
  let invAccounts: InvestmentAccountRecord[] = [];
  let loansList: LoanRecord[] = [];
  let accBalances: BalanceRecord[] = [];

  try {
    const [s, it, ia, l, b] = await Promise.all([
      invoke<NetWorthSnapshot>("get_net_worth_snapshot"),
      invoke<NetWorthItemRecord[]>("list_net_worth_items"),
      invoke<InvestmentAccountRecord[]>("list_investment_accounts"),
      invoke<LoanRecord[]>("list_loans"),
      invoke<BalanceRecord[]>("get_reporting_balances"),
    ]);
    snapshot = s;
    items = it;
    invAccounts = ia;
    loansList = l;
    accBalances = b;
  } catch(e: any) {
    if (renderVersion === netWorthRenderVersion && view === "networth") {
      main.innerHTML = `<div class="card"><h2>Net worth unavailable</h2><p>${esc(String(e))}</p></div>`;
    }
    return;
  }

  if (renderVersion !== netWorthRenderVersion || view !== "networth") return;

  // Separate assets
  const cashAccounts = accBalances.filter(b => b.current_balance_cents > 0);
  const cashAssetsCents = cashAccounts.reduce((sum, b) => sum + b.current_balance_cents, 0);

  const invAssetsCents = invAccounts.reduce((sum, ia) => sum + ia.value_cents, 0);
  const manualAssets = items.filter(i => i.kind === "asset");
  const manualAssetsCents = manualAssets.reduce((sum, i) => sum + i.value_cents, 0);

  // Separate liabilities
  const loansLiabCents = loansList.reduce((sum, l) => sum + l.outstanding_cents, 0);
  const creditAccounts = accBalances.filter(b => b.account_kind === "credit" && b.current_balance_cents < 0);
  const creditLiabCents = creditAccounts.reduce((sum, b) => sum + (-b.current_balance_cents), 0);
  const overdrawnAccounts = accBalances.filter(b => b.account_kind !== "credit" && b.current_balance_cents < 0);
  const overdrawnLiabCents = overdrawnAccounts.reduce((sum, b) => sum + (-b.current_balance_cents), 0);

  const manualLiabilities = items.filter(i => i.kind === "liability");
  const manualLiabCents = manualLiabilities.reduce((sum, i) => sum + i.value_cents, 0);

  // Totals
  const totalAssetsCents = snapshot ? snapshot.assets_cents : (cashAssetsCents + invAssetsCents + manualAssetsCents);
  const totalLiabCents = snapshot ? snapshot.liabilities_cents : (loansLiabCents + creditLiabCents + overdrawnLiabCents + manualLiabCents);
  const netWorthCents = snapshot ? snapshot.net_worth_cents : (totalAssetsCents - totalLiabCents);
  const momDeltaCents = snapshot ? snapshot.month_over_month_cents : 0;

  // Categorize manual assets for allocation bar
  let realEstateCents = 0, vehicleCents = 0, otherManualAssetsCents = 0;
  for (const a of manualAssets) {
    const cat = inferNetWorthCategory(a).label;
    if (cat === "Real Estate") realEstateCents += a.value_cents;
    else if (cat === "Vehicle") vehicleCents += a.value_cents;
    else otherManualAssetsCents += a.value_cents;
  }

  // Financial ratios
  const debtToAssetPct = totalAssetsCents > 0 ? (totalLiabCents / totalAssetsCents) * 100 : 0;
  const solvencyPct = totalAssetsCents > 0 ? (netWorthCents / totalAssetsCents) * 100 : 0;
  const liquidPct = totalAssetsCents > 0 ? (cashAssetsCents / totalAssetsCents) * 100 : 0;

  // Search query filter
  const q = netWorthSearchQuery.trim().toLowerCase();
  const filterText = (str: string | null | undefined) => !q || (str ?? "").toLowerCase().includes(q);

  const filteredCash = cashAccounts.filter(a => filterText(a.account_name) || filterText(a.account_kind));
  const filteredInv = invAccounts.filter(a => filterText(a.name) || filterText(a.institution));
  const filteredManualAssets = manualAssets.filter(a => filterText(a.name) || filterText(a.note) || filterText(inferNetWorthCategory(a).label));

  const filteredLoans = loansList.filter(l => filterText(l.name) || filterText(l.lender));
  const filteredCredit = creditAccounts.filter(a => filterText(a.account_name));
  const filteredOverdrawn = overdrawnAccounts.filter(a => filterText(a.account_name));
  const filteredManualLiab = manualLiabilities.filter(a => filterText(a.name) || filterText(a.note) || filterText(inferNetWorthCategory(a).label));

  // Asset allocation segments
  const assetSegments = [
    { label: "Cash & Liquid", amount: cashAssetsCents, color: "var(--asset-cash)" },
    { label: "Investments", amount: invAssetsCents, color: "var(--asset-invest)" },
    { label: "Real Estate", amount: realEstateCents, color: "var(--asset-home)" },
    { label: "Vehicles", amount: vehicleCents, color: "var(--asset-auto)" },
    { label: "Other Assets", amount: otherManualAssetsCents, color: "var(--asset-other)" },
  ].filter(s => s.amount > 0).map(s => ({ ...s, pct: totalAssetsCents > 0 ? (s.amount / totalAssetsCents) * 100 : 0 }));

  // Liability composition segments
  const liabSegments = [
    { label: "Loans & Mortgages", amount: loansLiabCents, color: "var(--liability-loan)" },
    { label: "Credit & Overdraft", amount: creditLiabCents + overdrawnLiabCents, color: "var(--liability-credit)" },
    { label: "Other Debts", amount: manualLiabCents, color: "var(--muted)" },
  ].filter(s => s.amount > 0).map(s => ({ ...s, pct: totalLiabCents > 0 ? (s.amount / totalLiabCents) * 100 : 0 }));

  // High / Low stats from 12-month trend
  const trendPoints: BalanceTrendPoint[] = snapshot?.trend ?? [];
  const trendValues = trendPoints.map((p: BalanceTrendPoint) => p.balance_cents);
  const peakVal = trendValues.length ? Math.max(...trendValues) : netWorthCents;
  const lowVal = trendValues.length ? Math.min(...trendValues) : netWorthCents;

  main.innerHTML = `
    <div class="page-head" style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px">
      <div>
        <h2>Assets & liabilities</h2>
        <p>Comprehensive balance sheet across liquid cash, investment portfolios, loans, and off-ledger holdings.</p>
      </div>
      <button class="btn btn-primary" id="add-nw">+ Off-Ledger Item</button>
    </div>

    <!-- Executive Stat Cards -->
    <div class="stat-grid">
      <div class="card stat accent">
        <div class="label">Total Net Worth</div>
        <div class="value">${centsFmt(netWorthCents)}</div>
        <div class="sub">
          ${momDeltaCents === 0 ? "Same as last month" : `${momDeltaCents > 0 ? "▲ +" : "▼ -"}${centsFmt(Math.abs(momDeltaCents))} vs last month`}
        </div>
      </div>
      <div class="card stat">
        <div class="label">Total Assets</div>
        <div class="value amount-pos">${centsFmt(totalAssetsCents)}</div>
        <div class="sub">Liquid ${centsFmt(cashAssetsCents)} · Inv ${centsFmt(invAssetsCents)} · Fixed ${centsFmt(manualAssetsCents)}</div>
      </div>
      <div class="card stat">
        <div class="label">Total Liabilities</div>
        <div class="value amount-neg">${centsFmt(totalLiabCents)}</div>
        <div class="sub">Loans ${centsFmt(loansLiabCents)} · Credit ${centsFmt(creditLiabCents + overdrawnLiabCents)} · Debts ${centsFmt(manualLiabCents)}</div>
      </div>
      <div class="card stat">
        <div class="label">Solvency & Leverage</div>
        <div class="value">${solvencyPct.toFixed(1)}% equity</div>
        <div class="sub">Debt-to-Asset: ${debtToAssetPct.toFixed(1)}% · Liquid Cushion: ${liquidPct.toFixed(1)}%</div>
      </div>
    </div>

    <!-- 12-Month Net Worth History Chart -->
    <div class="networth-chart-card">
      <div class="networth-chart-header">
        <div class="networth-chart-title-wrap">
          <div class="networth-chart-title">12-Month Net Worth History</div>
          <span class="small muted">Monthly trajectory across all ledger balances & non-ledger valuations</span>
        </div>
        <div class="networth-chart-stats">
          <span>Peak: <strong>${centsFmt(peakVal)}</strong></span>
          <span>Low: <strong>${centsFmt(lowVal)}</strong></span>
          <span>Current: <strong>${centsFmt(netWorthCents)}</strong></span>
        </div>
      </div>
      ${netWorthEvolutionChart(trendPoints)}
    </div>

    <!-- Asset Allocation & Debt Composition Card -->
    <div class="allocation-card">
      <div class="allocation-grid">
        <!-- Asset Composition -->
        <div>
          <div class="allocation-col-head">
            <span class="allocation-col-title">Asset Allocation</span>
            <span class="small muted">${centsFmt(totalAssetsCents)} total</span>
          </div>
          <div class="allocation-bar" role="img" aria-label="Asset Allocation Bar">
            ${assetSegments.map(s => `<div class="allocation-segment" style="width:${s.pct}%;background:${s.color}" title="${esc(s.label)}: ${centsFmt(s.amount)} (${s.pct.toFixed(1)}%)"></div>`).join("")}
          </div>
          <div class="allocation-legend">
            ${assetSegments.map(s => `
              <div class="allocation-legend-row">
                <span class="allocation-legend-label">
                  <span class="allocation-dot" style="background:${s.color}"></span>
                  <span>${esc(s.label)}</span>
                </span>
                <span class="allocation-legend-val">${centsFmt(s.amount)} <span class="small muted">(${s.pct.toFixed(1)}%)</span></span>
              </div>
            `).join("")}
          </div>
        </div>

        <!-- Liability Structure -->
        <div>
          <div class="allocation-col-head">
            <span class="allocation-col-title">Debt Structure</span>
            <span class="small muted">${centsFmt(totalLiabCents)} total</span>
          </div>
          <div class="allocation-bar" role="img" aria-label="Debt Structure Bar">
            ${liabSegments.map(s => `<div class="allocation-segment" style="width:${s.pct}%;background:${s.color}" title="${esc(s.label)}: ${centsFmt(s.amount)} (${s.pct.toFixed(1)}%)"></div>`).join("")}
          </div>
          <div class="allocation-legend">
            ${liabSegments.length ? liabSegments.map(s => `
              <div class="allocation-legend-row">
                <span class="allocation-legend-label">
                  <span class="allocation-dot" style="background:${s.color}"></span>
                  <span>${esc(s.label)}</span>
                </span>
                <span class="allocation-legend-val">${centsFmt(s.amount)} <span class="small muted">(${s.pct.toFixed(1)}%)</span></span>
              </div>
            `).join("") : `<div class="small muted" style="padding-top:10px">No liabilities or debts recorded. You are 100% debt-free!</div>`}
          </div>
        </div>
      </div>
    </div>

    <!-- Navigation Tabs & Search Toolbar -->
    <div class="networth-toolbar">
      <div class="networth-tabs">
        <button class="networth-tab-btn ${netWorthActiveTab === 'all' ? 'is-active' : ''}" data-nw-tab="all">Overview & Balance Sheet</button>
        <button class="networth-tab-btn ${netWorthActiveTab === 'assets' ? 'is-active' : ''}" data-nw-tab="assets">Assets (${centsFmt(totalAssetsCents)})</button>
        <button class="networth-tab-btn ${netWorthActiveTab === 'liabilities' ? 'is-active' : ''}" data-nw-tab="liabilities">Liabilities (${centsFmt(totalLiabCents)})</button>
        <button class="networth-tab-btn ${netWorthActiveTab === 'offledger' ? 'is-active' : ''}" data-nw-tab="offledger">Off-Ledger Records (${items.length})</button>
      </div>
      <div class="networth-controls">
        <input id="nw-search" class="networth-search-input" placeholder="Search balance sheet..." value="${esc(netWorthSearchQuery)}"/>
      </div>
    </div>

    <!-- Tab View Contents -->
    <div id="nw-view-content">
      ${renderNetWorthTabContent(
        netWorthActiveTab,
        filteredCash,
        filteredInv,
        filteredManualAssets,
        filteredLoans,
        filteredCredit,
        filteredOverdrawn,
        filteredManualLiab,
        items,
        totalAssetsCents,
        totalLiabCents,
        cashAssetsCents,
        invAssetsCents,
        manualAssetsCents,
        loansLiabCents,
        creditLiabCents + overdrawnLiabCents,
        manualLiabCents
      )}
    </div>
    <div id="dashboard-tooltip" class="dashboard-tooltip" role="status" hidden></div>
  `;

  // Wire Tab Buttons
  main.querySelectorAll<HTMLElement>("[data-nw-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      netWorthActiveTab = btn.dataset.nwTab as any;
      void renderNetWorth(main);
    });
  });

  // Wire Search Input
  const searchInput = main.querySelector("#nw-search") as HTMLInputElement;
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      netWorthSearchQuery = searchInput.value;
      const contentRoot = main.querySelector("#nw-view-content");
      if (contentRoot) {
        // re-filter
        const q2 = netWorthSearchQuery.trim().toLowerCase();
        const fText = (str: string | null | undefined) => !q2 || (str ?? "").toLowerCase().includes(q2);
        contentRoot.innerHTML = renderNetWorthTabContent(
          netWorthActiveTab,
          cashAccounts.filter(a => fText(a.account_name) || fText(a.account_kind)),
          invAccounts.filter(a => fText(a.name) || fText(a.institution)),
          manualAssets.filter(a => fText(a.name) || fText(a.note) || fText(inferNetWorthCategory(a).label)),
          loansList.filter(l => fText(l.name) || fText(l.lender)),
          creditAccounts.filter(a => fText(a.account_name)),
          overdrawnAccounts.filter(a => fText(a.account_name)),
          manualLiabilities.filter(a => fText(a.name) || fText(a.note) || fText(inferNetWorthCategory(a).label)),
          items,
          totalAssetsCents,
          totalLiabCents,
          cashAssetsCents,
          invAssetsCents,
          manualAssetsCents,
          loansLiabCents,
          creditLiabCents + overdrawnLiabCents,
          manualLiabCents
        );
        bindNetWorthActions(main, items);
      }
    });
  }

  // Primary Add Button
  main.querySelector("#add-nw")!.addEventListener("click", () => openNetWorthModal());

  // Bind item actions
  bindNetWorthActions(main, items);

  // Bind chart tooltips
  bindDashboardChartTooltips(main);
}

function renderNetWorthTabContent(
  tab: "all" | "assets" | "liabilities" | "offledger",
  cash: BalanceRecord[],
  inv: InvestmentAccountRecord[],
  manualAssets: NetWorthItemRecord[],
  loans: LoanRecord[],
  credit: BalanceRecord[],
  overdrawn: BalanceRecord[],
  manualLiab: NetWorthItemRecord[],
  allItems: NetWorthItemRecord[],
  totalAssets: number,
  totalLiab: number,
  cashTotal: number,
  invTotal: number,
  manualAssetsTotal: number,
  loansTotal: number,
  creditTotal: number,
  manualLiabTotal: number
): string {
  if (tab === "offledger") {
    return renderOffLedgerManagementTable(allItems);
  }

  const renderAssetsColumn = () => `
    <div class="balance-sheet-col">
      <!-- Cash & Liquid Accounts -->
      <div class="bs-group">
        <div class="bs-group-head">
          <span class="bs-group-title">💵 Bank & Liquid Accounts (${cash.length})</span>
          <span class="bs-group-total amount-pos">${centsFmt(cashTotal)}</span>
        </div>
        ${cash.length ? cash.map(a => `
          <div class="bs-item">
            <div class="bs-item-left">
              <div class="bs-item-name-row">
                <span class="bs-item-name">${esc(a.account_name)}</span>
                <span class="badge badge-${a.account_kind}">${esc(a.account_kind)}</span>
              </div>
              <div class="bs-item-meta">${esc(a.currency_code)} ledger balance</div>
            </div>
            <div class="bs-item-right">
              <span class="bs-item-value">${centsFmt(a.current_balance_cents, a.currency_code)}</span>
              <button class="btn btn-sm" data-nav-account="${a.account_id}">View Account</button>
            </div>
          </div>
        `).join("") : `<div class="bs-item"><span class="small muted">No liquid bank accounts match.</span></div>`}
      </div>

      <!-- Investment Portfolios -->
      <div class="bs-group">
        <div class="bs-group-head">
          <span class="bs-group-title">📈 Investment Portfolios (${inv.length})</span>
          <span class="bs-group-total amount-pos">${centsFmt(invTotal)}</span>
        </div>
        ${inv.length ? inv.map(ia => {
          const gain = ia.value_cents - ia.contributed_cents;
          const returnPct = ia.contributed_cents > 0 ? (gain / ia.contributed_cents) * 100 : null;
          return `
            <div class="bs-item">
              <div class="bs-item-left">
                <div class="bs-item-name-row">
                  <span class="bs-item-name">${esc(ia.name)}</span>
                  ${returnPct !== null ? `<span class="nw-pill ${gain >= 0 ? 'pill-realestate' : 'pill-tax'}">${gain >= 0 ? '+' : ''}${returnPct.toFixed(1)}%</span>` : ''}
                </div>
                <div class="bs-item-meta">${esc(ia.institution ?? "Brokerage")} · Contributed ${centsFmt(ia.contributed_cents)}</div>
              </div>
              <div class="bs-item-right">
                <span class="bs-item-value">${centsFmt(ia.value_cents)}</span>
                <button class="btn btn-sm" data-nav-investments="${ia.id}">Investments</button>
              </div>
            </div>
          `;
        }).join("") : `<div class="bs-item"><span class="small muted">No investment accounts match.</span></div>`}
      </div>

      <!-- Physical & Off-Ledger Assets -->
      <div class="bs-group">
        <div class="bs-group-head">
          <span class="bs-group-title">🏛️ Physical & Off-Ledger Assets (${manualAssets.length})</span>
          <span class="bs-group-total amount-pos">${centsFmt(manualAssetsTotal)}</span>
        </div>
        ${manualAssets.length ? manualAssets.map(a => {
          const cat = inferNetWorthCategory(a);
          return `
            <div class="bs-item">
              <div class="bs-item-left">
                <div class="bs-item-name-row">
                  <span class="bs-item-name">${esc(a.name)}</span>
                  <span class="nw-pill ${cat.cls}">${cat.icon} ${esc(cat.label)}</span>
                </div>
                <div class="bs-item-meta">Valued as of ${esc(a.as_of)}${a.note ? ` · ${esc(a.note)}` : ''}</div>
              </div>
              <div class="bs-item-right">
                <span class="bs-item-value">${centsFmt(a.value_cents)}</span>
                <div class="bs-item-actions">
                  <button class="btn btn-sm" data-revalue-nw="${a.id}">Update Value</button>
                  <button class="btn btn-sm" data-edit-nw="${a.id}">Edit</button>
                  <button class="btn btn-sm" data-delete-nw="${a.id}">Remove</button>
                </div>
              </div>
            </div>
          `;
        }).join("") : `<div class="bs-item"><span class="small muted">No off-ledger assets match. Click "+ Off-Ledger Item" to record property or vehicles.</span></div>`}
      </div>
    </div>
  `;

  const renderLiabilitiesColumn = () => `
    <div class="balance-sheet-col">
      <!-- Loans & Mortgages -->
      <div class="bs-group">
        <div class="bs-group-head">
          <span class="bs-group-title">🏠 Mortgages & Term Loans (${loans.length})</span>
          <span class="bs-group-total amount-neg">${centsFmt(loansTotal)}</span>
        </div>
        ${loans.length ? loans.map(l => `
          <div class="bs-item">
            <div class="bs-item-left">
              <div class="bs-item-name-row">
                <span class="bs-item-name">${esc(l.name)}</span>
                ${l.annual_rate_bps !== null ? `<span class="nw-pill pill-personal-debt">${(l.annual_rate_bps / 100).toFixed(2)}% APR</span>` : ''}
              </div>
              <div class="bs-item-meta">${esc(l.lender ?? "Term Loan")} · EMI ${centsFmt(l.emi_cents)}/mo</div>
            </div>
            <div class="bs-item-right">
              <span class="bs-item-value amount-neg">${centsFmt(l.outstanding_cents)}</span>
              <button class="btn btn-sm" data-nav-loans="${l.id}">Loans</button>
            </div>
          </div>
        `).join("") : `<div class="bs-item"><span class="small muted">No active loans or mortgages recorded.</span></div>`}
      </div>

      <!-- Credit Cards & Overdrafts -->
      <div class="bs-group">
        <div class="bs-group-head">
          <span class="bs-group-title">💳 Revolving Credit & Overdrafts (${credit.length + overdrawn.length})</span>
          <span class="bs-group-total amount-neg">${centsFmt(creditTotal)}</span>
        </div>
        ${(credit.length || overdrawn.length) ? [...credit, ...overdrawn].map(c => `
          <div class="bs-item">
            <div class="bs-item-left">
              <div class="bs-item-name-row">
                <span class="bs-item-name">${esc(c.account_name)}</span>
                <span class="badge badge-${c.account_kind}">${esc(c.account_kind)}</span>
              </div>
              <div class="bs-item-meta">${c.account_kind === "credit" ? "Credit Card balance owed" : "Overdrawn account"}</div>
            </div>
            <div class="bs-item-right">
              <span class="bs-item-value amount-neg">${centsFmt(Math.abs(c.current_balance_cents), c.currency_code)}</span>
              <button class="btn btn-sm" data-nav-account="${c.account_id}">View Account</button>
            </div>
          </div>
        `).join("") : `<div class="bs-item"><span class="small muted">Zero credit card debt and no overdrawn accounts.</span></div>`}
      </div>

      <!-- Off-Ledger Debts -->
      <div class="bs-group">
        <div class="bs-group-head">
          <span class="bs-group-title">📄 Other / Off-Ledger Debts (${manualLiab.length})</span>
          <span class="bs-group-total amount-neg">${centsFmt(manualLiabTotal)}</span>
        </div>
        ${manualLiab.length ? manualLiab.map(l => {
          const cat = inferNetWorthCategory(l);
          return `
            <div class="bs-item">
              <div class="bs-item-left">
                <div class="bs-item-name-row">
                  <span class="bs-item-name">${esc(l.name)}</span>
                  <span class="nw-pill ${cat.cls}">${cat.icon} ${esc(cat.label)}</span>
                </div>
                <div class="bs-item-meta">As of ${esc(l.as_of)}${l.note ? ` · ${esc(l.note)}` : ''}</div>
              </div>
              <div class="bs-item-right">
                <span class="bs-item-value amount-neg">${centsFmt(l.value_cents)}</span>
                <div class="bs-item-actions">
                  <button class="btn btn-sm" data-revalue-nw="${l.id}">Update Value</button>
                  <button class="btn btn-sm" data-edit-nw="${l.id}">Edit</button>
                  <button class="btn btn-sm" data-delete-nw="${l.id}">Remove</button>
                </div>
              </div>
            </div>
          `;
        }).join("") : `<div class="bs-item"><span class="small muted">No off-ledger debts recorded.</span></div>`}
      </div>
    </div>
  `;

  if (tab === "assets") {
    return `
      <div style="display:flex;flex-direction:column;gap:18px">
        <div class="card" style="padding:14px 18px;display:flex;justify-content:space-between;align-items:center;background:var(--surface-2)">
          <span><strong>Total Assets:</strong> Liquid cash (${centsFmt(cashTotal)}) + Investments (${centsFmt(invTotal)}) + Off-Ledger (${centsFmt(manualAssetsTotal)})</span>
          <strong class="amount-pos" style="font-size:18px">${centsFmt(totalAssets)}</strong>
        </div>
        ${renderAssetsColumn()}
      </div>
    `;
  }

  if (tab === "liabilities") {
    const totalMonthlyEmi = loans.reduce((sum, l) => sum + l.emi_cents, 0);
    return `
      <div style="display:flex;flex-direction:column;gap:18px">
        <div class="card" style="padding:14px 18px;display:flex;justify-content:space-between;align-items:center;background:var(--surface-2)">
          <span><strong>Total Liabilities:</strong> Loans (${centsFmt(loansTotal)}) + Credit/Overdraft (${centsFmt(creditTotal)}) + Other debts (${centsFmt(manualLiabTotal)}) · Monthly debt service: <strong>${centsFmt(totalMonthlyEmi)}/mo</strong></span>
          <strong class="amount-neg" style="font-size:18px">${centsFmt(totalLiab)}</strong>
        </div>
        ${renderLiabilitiesColumn()}
      </div>
    `;
  }

  // tab === "all"
  return `
    <div class="balance-sheet-grid">
      ${renderAssetsColumn()}
      ${renderLiabilitiesColumn()}
    </div>
  `;
}

function renderOffLedgerManagementTable(items: NetWorthItemRecord[]): string {
  if (!items.length) {
    return `
      <div class="card" style="padding:32px;text-align:center">
        <h3 style="margin-bottom:8px">No Off-Ledger Records Tracked</h3>
        <p class="muted small" style="margin-bottom:16px">Track manual valuations for properties, vehicles, collectibles, personal debts, or tax liabilities.</p>
        <button class="btn btn-primary" onclick="openNetWorthModal()">+ Add First Off-Ledger Item</button>
      </div>
    `;
  }

  const q = netWorthSearchQuery.trim().toLowerCase();
  const filtered = items.filter(i => !q || i.name.toLowerCase().includes(q) || (i.note ?? "").toLowerCase().includes(q) || i.kind.includes(q));

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Name & Classification</th>
            <th>Valuation Date</th>
            <th>Notes</th>
            <th style="text-align:right">Current Valuation</th>
            <th style="text-align:right">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(i => {
            const cat = inferNetWorthCategory(i);
            const isAsset = i.kind === "asset";
            return `
              <tr>
                <td>
                  <span class="badge badge-${isAsset ? 'income' : 'expense'}">${esc(i.kind)}</span>
                </td>
                <td>
                  <strong>${esc(i.name)}</strong>
                  <span class="nw-pill ${cat.cls}" style="margin-left:6px">${cat.icon} ${esc(cat.label)}</span>
                </td>
                <td class="muted">${esc(i.as_of)}</td>
                <td class="small muted">${esc(i.note ?? "—")}</td>
                <td style="text-align:right;font-weight:700" class="${isAsset ? 'amount-pos' : 'amount-neg'}">
                  ${centsFmt(i.value_cents)}
                </td>
                <td style="text-align:right">
                  <div style="display:inline-flex;gap:6px">
                    <button class="btn btn-sm" data-revalue-nw="${i.id}">Update Value</button>
                    <button class="btn btn-sm" data-edit-nw="${i.id}">Edit</button>
                    <button class="btn btn-sm" data-delete-nw="${i.id}">Remove</button>
                  </div>
                </td>
              </tr>
            `;
          }).join("") || `<tr><td colspan="6" class="empty">No records match your search query.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function bindNetWorthActions(main: HTMLElement, items: NetWorthItemRecord[]) {
  // Account navigation
  main.querySelectorAll<HTMLElement>("[data-nav-account]").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = Number(btn.dataset.navAccount);
      navigateTo(()=>{
        selectedAccountId = targetId;
        view = "accounts";
      });
    });
  });

  // Investment navigation
  main.querySelectorAll<HTMLElement>("[data-nav-investments]").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = Number(btn.dataset.navInvestments);
      navigateTo(()=>{
        selectedInvestmentAccountId = targetId;
        view = "investments";
      });
    });
  });

  // Loans navigation
  main.querySelectorAll<HTMLElement>("[data-nav-loans]").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = Number(btn.dataset.navLoans);
      navigateTo(()=>{
        selectedLoanId = targetId;
        view = "loans";
      });
    });
  });

  // Edit Off-Ledger item
  main.querySelectorAll<HTMLElement>("[data-edit-nw]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.editNw);
      const item = items.find(i => i.id === id);
      if (item) openNetWorthModal(item);
    });
  });

  // Quick Revalue
  main.querySelectorAll<HTMLElement>("[data-revalue-nw]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.revalueNw);
      const item = items.find(i => i.id === id);
      if (item) openQuickRevalueModal(item);
    });
  });

  // Delete Off-Ledger item
  main.querySelectorAll<HTMLElement>("[data-delete-nw]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.deleteNw);
      const item = items.find(i => i.id === id);
      if (!confirm(`Remove "${item?.name ?? 'this item'}" from off-ledger tracking?`)) return;
      try {
        await invoke("delete_net_worth_item", { id });
        toast("Record removed");
        void renderNetWorth(main);
      } catch (e: any) {
        toast(String(e), true);
      }
    });
  });
}

function openNetWorthModal(existing?: NetWorthItemRecord){
  const root = document.getElementById("modal-root")!;
  const isEditing = Boolean(existing);
  const formattedVal = existing ? (existing.value_cents / 100).toFixed(2) : "";

  root.innerHTML = `
    <div class="modal-backdrop" id="bd">
      <div class="modal">
        <div class="modal-head">
          <h3>${isEditing ? `Edit ${existing!.kind}` : "Add Asset or Liability"}</h3>
          <button class="btn btn-ghost" id="x">✕</button>
        </div>
        <div class="modal-body">
          ${!isEditing ? `
            <div class="field" style="margin-bottom:12px">
              <label>Quick preset classification</label>
              <div class="modal-chips-row">
                <button type="button" class="chip-btn" data-chip="asset:Real Estate:Home / Residence">🏡 Real Estate</button>
                <button type="button" class="chip-btn" data-chip="asset:Vehicle:Car / Automobile">🚗 Vehicle</button>
                <button type="button" class="chip-btn" data-chip="asset:Valuables:Gold / Jewelry">🪙 Valuables</button>
                <button type="button" class="chip-btn" data-chip="asset:Private Equity:Angel / Startup Equity">📈 Equity / Startup</button>
                <button type="button" class="chip-btn" data-chip="liability:Personal Debt:Personal Loan from Family">🤝 Personal Debt</button>
                <button type="button" class="chip-btn" data-chip="liability:Tax Due:Estimated Tax Owed">🏛️ Tax Due</button>
              </div>
            </div>
          ` : ""}
          <div class="row">
            <div class="field" style="flex:1">
              <label>Type</label>
              <select id="nw-kind">
                <option value="asset" ${existing?.kind === 'asset' ? 'selected' : ''}>Asset (Adds to wealth)</option>
                <option value="liability" ${existing?.kind === 'liability' ? 'selected' : ''}>Liability (Debt owed)</option>
              </select>
            </div>
            <div class="field" style="flex:2">
              <label>Name</label>
              <input id="nw-name" class="input" placeholder="Primary Residence / Tesla Model Y / Tax Debt" value="${esc(existing?.name ?? "")}"/>
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label>Current Valuation (${esc(currency)})</label>
              <input id="nw-value" class="input" placeholder="450000.00" value="${esc(formattedVal)}"/>
            </div>
            <div class="field">
              <label>As of Date</label>
              <input id="nw-date" class="input" type="date" value="${existing?.as_of ?? todayISO()}"/>
            </div>
          </div>
          <div class="field">
            <label>Notes & Context (optional)</label>
            <input id="nw-note" class="input" placeholder="Appraised value, address, terms, or counterparty" value="${esc(existing?.note ?? "")}"/>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="cancel">Cancel</button>
          <button class="btn btn-primary" id="save">${isEditing ? "Save Changes" : "Create Item"}</button>
        </div>
      </div>
    </div>
  `;

  const close = () => { root.innerHTML = ""; };
  root.querySelector("#x")!.addEventListener("click", close);
  root.querySelector("#cancel")!.addEventListener("click", close);
  root.querySelector("#bd")!.addEventListener("click", e => { if (e.target === e.currentTarget) close(); });

  // Suggestion chips
  root.querySelectorAll<HTMLElement>("[data-chip]").forEach(chip => {
    chip.addEventListener("click", () => {
      const [k, , defaultName] = chip.dataset.chip!.split(":");
      (root.querySelector("#nw-kind") as HTMLSelectElement).value = k;
      const nameInput = root.querySelector("#nw-name") as HTMLInputElement;
      if (!nameInput.value) nameInput.value = defaultName;
    });
  });

  // Save handler
  root.querySelector("#save")!.addEventListener("click", async () => {
    const name = (root.querySelector("#nw-name") as HTMLInputElement).value.trim();
    const kind = (root.querySelector("#nw-kind") as HTMLSelectElement).value;
    const value = (root.querySelector("#nw-value") as HTMLInputElement).value.trim();
    const as_of = (root.querySelector("#nw-date") as HTMLInputElement).value;
    const note = (root.querySelector("#nw-note") as HTMLInputElement).value.trim() || null;

    if (!name) { toast("Name is required", true); return; }
    if (!value) { toast("Valuation amount is required", true); return; }

    try {
      if (existing) {
        await invoke("edit_net_worth_item", {
          req: { id: existing.id, name, kind, value, as_of, note }
        });
        toast("Record updated");
      } else {
        await invoke("add_net_worth_item", {
          req: { name, kind, value, as_of, note }
        });
        toast("Record added");
      }
      close();
      const main = $("#main");
      if (main) void renderNetWorth(main);
    } catch(e: any) {
      toast(String(e), true);
    }
  });
}

function openQuickRevalueModal(item: NetWorthItemRecord){
  const root = document.getElementById("modal-root")!;
  const currentValFormatted = (item.value_cents / 100).toFixed(2);

  root.innerHTML = `
    <div class="modal-backdrop" id="bd">
      <div class="modal" style="max-width:440px">
        <div class="modal-head">
          <h3>Update Valuation</h3>
          <button class="btn btn-ghost" id="x">✕</button>
        </div>
        <div class="modal-body">
          <div style="margin-bottom:14px;padding:10px 14px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--border)">
            <div style="font-weight:700;font-size:14px;margin-bottom:2px">${esc(item.name)}</div>
            <div class="small muted">Previous valuation: <strong>${centsFmt(item.value_cents)}</strong> as of ${esc(item.as_of)}</div>
          </div>
          <div class="field">
            <label>New Valuation (${esc(currency)})</label>
            <input id="quick-value" class="input" placeholder="475000.00" value="${esc(currentValFormatted)}"/>
          </div>
          <div class="field">
            <label>Valuation Date</label>
            <input id="quick-date" class="input" type="date" value="${todayISO()}"/>
          </div>
          <div class="field">
            <label>Note / Appraisal context (optional)</label>
            <input id="quick-note" class="input" placeholder="e.g. Zillow update / Annual appraisal" value="${esc(item.note ?? "")}"/>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="cancel">Cancel</button>
          <button class="btn btn-primary" id="save">Save Valuation</button>
        </div>
      </div>
    </div>
  `;

  const close = () => { root.innerHTML = ""; };
  root.querySelector("#x")!.addEventListener("click", close);
  root.querySelector("#cancel")!.addEventListener("click", close);
  root.querySelector("#bd")!.addEventListener("click", e => { if (e.target === e.currentTarget) close(); });

  const inputVal = root.querySelector("#quick-value") as HTMLInputElement;
  inputVal.focus();
  inputVal.select();

  root.querySelector("#save")!.addEventListener("click", async () => {
    const value = inputVal.value.trim();
    const as_of = (root.querySelector("#quick-date") as HTMLInputElement).value;
    const note = (root.querySelector("#quick-note") as HTMLInputElement).value.trim() || null;

    if (!value) { toast("Valuation amount is required", true); return; }

    try {
      await invoke("edit_net_worth_item", {
        req: { id: item.id, name: item.name, kind: item.kind, value, as_of, note }
      });
      toast(`Valuation updated for ${item.name}`);
      close();
      const main = $("#main");
      if (main) void renderNetWorth(main);
    } catch(e: any) {
      toast(String(e), true);
    }
  });
}

function quantityFmt(quantityMicros:number){
  return (quantityMicros/1_000_000).toLocaleString(undefined,{maximumFractionDigits:6});
}
function percentFmt(value:number|null){ return value===null?"—":`${value>=0?"+":""}${value.toFixed(2)}%`; }
function investmentPerformanceChart(performance:InvestmentPerformanceRecord){
  if(!performance.points.length) return `<div class="investment-chart-empty">Return unavailable. Record trades and same-day manual prices for other open holdings on each trade or dividend date.</div>`;
  const values=performance.points.map(point=>point.cumulative_return_percent);
  const min=Math.min(...values,0), max=Math.max(...values,0), span=Math.max(max-min,0.01);
  const width=460, height=136, pad=14;
  const points=performance.points.map((point,index)=>{
    const x=pad+(width-pad*2)*(performance.points.length===1?.5:index/(performance.points.length-1));
    const y=height-pad-(height-pad*2)*((point.cumulative_return_percent-min)/span);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last=performance.points.at(-1)!;
  return `<div class="investment-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Time-weighted return chart"><line x1="${pad}" x2="${width-pad}" y1="${height-pad-(height-pad*2)*((0-min)/span)}" y2="${height-pad-(height-pad*2)*((0-min)/span)}" class="investment-chart-zero"/><polyline points="${points}" class="investment-chart-line"/><circle cx="${points.split(" ").at(-1)!.split(",")[0]}" cy="${points.split(" ").at(-1)!.split(",")[1]}" r="3.5" class="investment-chart-dot"/></svg><div><span>${esc(performance.points[0].date)}</span><strong>${percentFmt(last.cumulative_return_percent)}</strong><span>${esc(last.date)}</span></div></div>`;
}
type InvestmentPosition = {
  security: SecurityRecord;
  quantity_micros: number;
  latest_price_snapshot: HoldingEventRecord|null;
};

function investmentPositions(events:HoldingEventRecord[], securities:SecurityRecord[]):InvestmentPosition[]{
  const quantityBySecurity = new Map<number, number>();
  const latestPriceBySecurity = new Map<number, HoldingEventRecord>();
  const securityById = new Map(securities.map(security=>[security.id, security]));

  for(const event of events){
    if(event.event_type === "buy"){
      quantityBySecurity.set(event.security_id, (quantityBySecurity.get(event.security_id) ?? 0) + (event.quantity_micros ?? 0));
    }else if(event.event_type === "sell"){
      quantityBySecurity.set(event.security_id, (quantityBySecurity.get(event.security_id) ?? 0) - (event.quantity_micros ?? 0));
    }
    if(event.event_type === "price_snapshot" && !latestPriceBySecurity.has(event.security_id)){
      latestPriceBySecurity.set(event.security_id, event);
    }
  }

  return Array.from(quantityBySecurity.entries())
    .filter(([, quantity])=>quantity > 0)
    .map(([securityId, quantity])=>{
      const security = securityById.get(securityId);
      return security ? {security, quantity_micros:quantity, latest_price_snapshot:latestPriceBySecurity.get(securityId) ?? null} : null;
    })
    .filter((position):position is InvestmentPosition=>position !== null)
    .sort((a,b)=>a.security.symbol.localeCompare(b.security.symbol));
}

function investmentEventSummary(event:HoldingEventRecord, securities:SecurityRecord[]):string{
  const securityCurrency = securities.find(security=>security.id === event.security_id)?.currency_code ?? currency;
  if(event.event_type === "dividend"){
    const amount = event.reporting_amount_cents ?? event.amount_cents;
    return amount === null ? "Dividend recorded" : `Dividend ${centsFmt(amount, event.reporting_amount_cents === null ? securityCurrency : currency)}`;
  }
  if(event.event_type === "price_snapshot"){
    return event.price_cents === null ? "Price snapshot recorded" : `${centsFmt(event.price_cents, securityCurrency)} per unit`;
  }
  const units = event.quantity_micros === null ? "" : `${quantityFmt(event.quantity_micros)} units`;
  const price = event.price_cents === null ? "" : `${units ? " @ " : ""}${centsFmt(event.price_cents, securityCurrency)}`;
  return `${units}${price}` || "Trade recorded";
}

async function renderInvestmentAccountDetails(
  container:HTMLElement,
  accountId:number,
  allAccounts:InvestmentAccountRecord[],
  securities:SecurityRecord[],
  main:HTMLElement,
){
  const renderVersion = ++investmentDetailRenderVersion;
  const account = allAccounts.find(item=>item.id === accountId);
  if(!account){
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `<div class="investment-detail-loading"><div class="small muted">Loading holdings, pricing, and performance for <strong>${esc(account.name)}</strong>…</div></div>`;

  let performance:InvestmentPerformanceRecord;
  let lots:HoldingLotRecord[];
  let events:HoldingEventRecord[];
  try{
    [performance, lots, events] = await Promise.all([
      invoke<InvestmentPerformanceRecord>("investment_account_performance", {investmentAccountId:account.id}),
      invoke<HoldingLotRecord[]>("list_holding_lots", {investmentAccountId:account.id}),
      invoke<HoldingEventRecord[]>("list_holding_events", {investmentAccountId:account.id}),
    ]);
  }catch(error:any){
    if(renderVersion === investmentDetailRenderVersion && selectedInvestmentAccountId === accountId){
      container.innerHTML = `<div class="investment-detail-loading">Unable to load the portfolio details. Please try again.</div>`;
      toast(String(error), true);
    }
    return;
  }

  if(renderVersion !== investmentDetailRenderVersion || selectedInvestmentAccountId !== accountId) return;

  const positions = investmentPositions(events, securities);
  const pricedPositions = positions.filter(position=>position.latest_price_snapshot !== null);
  const hasCompletePricing = positions.length > 0 && pricedPositions.length === positions.length;
  const canCalculateMarkedGains = hasCompletePricing;
  const totalGain = performance.unrealized_gain_cents + performance.realized_gain_cents;
  const latestEvent = events[0] ?? null;
  const valuationNote = hasCompletePricing
    ? `Valuation is calculated from manual price snapshots for all ${positions.length} open position${positions.length === 1 ? "" : "s"}.`
    : positions.length
      ? `${pricedPositions.length} of ${positions.length} open positions have a manual price snapshot. The account value falls back to the manual valuation dated ${esc(account.as_of)} until every open position is priced.`
      : `No open positions yet. Current value is the manual valuation dated ${esc(account.as_of)}.`;

  container.innerHTML = `
    <div class="investment-detail-section">
      <div class="investment-detail-head">
        <div>
          <div class="investment-detail-title-wrap">
            <h3 class="investment-detail-title">${esc(account.name)}</h3>
            <span class="pill">${esc(currency)}</span>
            <span class="muted small">Account #${account.id}</span>
          </div>
          <div class="small muted" style="margin-top:4px">
            ${account.institution ? `${esc(account.institution)} · ` : ""}Manual account valuation as of ${esc(account.as_of)} · Created ${esc(account.created_at)}
          </div>
        </div>
        <div class="investment-detail-actions">
          <button class="btn btn-primary btn-sm" id="inv-act-record-event">+ Record event</button>
          <button class="btn btn-sm" id="inv-act-add-security">+ Security</button>
          <button class="btn btn-sm" id="inv-act-remove" style="color:var(--danger)">Remove account</button>
        </div>
      </div>

      <div class="investment-detail-alert">
        <div><strong>Valuation status:</strong> ${valuationNote}</div>
      </div>

      <div class="stat-grid">
        <div class="card stat accent"><div class="label">Current value</div><div class="value">${centsFmt(performance.value_cents)}</div><div class="sub">${hasCompletePricing ? "Calculated from manual prices" : `Manual valuation as of ${esc(account.as_of)}`}</div></div>
        <div class="card stat"><div class="label">Contributed capital</div><div class="value">${centsFmt(account.contributed_cents)}</div><div class="sub">Account contribution record</div></div>
        <div class="card stat"><div class="label">Open FIFO cost basis</div><div class="value">${centsFmt(performance.cost_basis_cents)}</div><div class="sub">Cost of remaining lots</div></div>
        <div class="card stat"><div class="label">Unrealized gain / loss</div><div class="value ${performance.unrealized_gain_cents >= 0 ? "text-positive" : "text-negative"}">${canCalculateMarkedGains ? `${performance.unrealized_gain_cents >= 0 ? "+" : ""}${centsFmt(performance.unrealized_gain_cents)}` : "—"}</div><div class="sub">${canCalculateMarkedGains ? "Current value less open cost basis" : "Price every open position to calculate"}</div></div>
        <div class="card stat"><div class="label">Realized gain / loss</div><div class="value ${performance.realized_gain_cents >= 0 ? "text-positive" : "text-negative"}">${performance.realized_gain_cents >= 0 ? "+" : ""}${centsFmt(performance.realized_gain_cents)}</div><div class="sub">Closed lots and dividends</div></div>
        <div class="card stat"><div class="label">Total gain / loss</div><div class="value ${totalGain >= 0 ? "text-positive" : "text-negative"}">${canCalculateMarkedGains ? `${totalGain >= 0 ? "+" : ""}${centsFmt(totalGain)}` : "—"}</div><div class="sub">${canCalculateMarkedGains ? "Realized plus marked-to-price gain" : "Price every open position to calculate"}</div></div>
        <div class="card stat"><div class="label">Time-weighted return</div><div class="value ${performance.time_weighted_return_percent !== null && performance.time_weighted_return_percent < 0 ? "text-negative" : "text-positive"}">${percentFmt(performance.time_weighted_return_percent)}</div><div class="sub">Linked at each cash flow using execution prices and same-day quotes for other holdings</div></div>
        <div class="card stat"><div class="label">Open positions</div><div class="value">${positions.length}</div><div class="sub">${pricedPositions.length}/${positions.length} with current manual prices</div></div>
      </div>

      <div class="grid2">
        <div class="card">
          <div class="card-head-row"><div><div class="card-title">Performance history</div><div class="small muted">Time-weighted return from manual price snapshots</div></div></div>
          ${investmentPerformanceChart(performance)}
        </div>
        <div class="card">
          <div class="card-head-row"><div><div class="card-title">Portfolio activity</div><div class="small muted">Latest buys, sells, dividends, and price updates</div></div><span class="pill">${events.length} event${events.length === 1 ? "" : "s"}</span></div>
          ${events.length ? `<div class="investment-event-list">${events.slice(0, 8).map(event=>`<div><span><strong>${esc(event.event_type.replace("_", " "))}</strong> · ${esc(event.security_symbol)}${event.note ? `<br/><small>${esc(event.note)}</small>` : ""}</span><small>${esc(event.event_on)} · ${investmentEventSummary(event, securities)}</small></div>`).join("")}</div>` : `<p class="small muted">No activity yet. Add a buy, sell, dividend, or manual price snapshot.</p>`}
          ${latestEvent ? `<div class="small muted" style="margin-top:10px">Latest activity: ${esc(latestEvent.event_on)}</div>` : ""}
        </div>
      </div>

      <div class="grid2">
        <div class="card">
          <div class="card-head-row"><div><div class="card-title">Current positions</div><div class="small muted">Net units after recorded buys and sells</div></div><span class="pill">${positions.length} held</span></div>
          ${positions.length ? `<div class="table-wrap"><table><thead><tr><th>Security</th><th>Units held</th><th>Latest manual price</th><th>Price as of</th></tr></thead><tbody>${positions.map(position=>`<tr><td><strong>${esc(position.security.symbol)}</strong><br/><span class="small muted">${esc(position.security.name)} · ${esc(position.security.currency_code)}</span></td><td>${quantityFmt(position.quantity_micros)}</td><td>${position.latest_price_snapshot?.price_cents === null || !position.latest_price_snapshot ? `<span class="text-negative">Needs update</span>` : centsFmt(position.latest_price_snapshot.price_cents, position.security.currency_code)}</td><td>${position.latest_price_snapshot ? esc(position.latest_price_snapshot.event_on) : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<p class="small muted">No open positions. Record a buy to start tracking holdings.</p>`}
        </div>
        <div class="card">
          <div class="card-head-row"><div><div class="card-title">Valuation checklist</div><div class="small muted">Keep every open position priced for an accurate portfolio value</div></div></div>
          <div class="account-item-list">
            ${positions.length ? positions.map(position=>`<div class="account-item-row"><div><strong>${esc(position.security.symbol)}</strong><div class="small muted">${esc(position.security.name)} · ${quantityFmt(position.quantity_micros)} units</div></div><div>${position.latest_price_snapshot ? `<span class="pill pill-success">Priced ${esc(position.latest_price_snapshot.event_on)}</span>` : '<span class="pill pill-muted">Price needed</span>'}</div></div>`).join("") : `<div class="muted small" style="padding:16px 0">Add a holding, then record manual price snapshots to calculate current value and returns.</div>`}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head-row"><div><div class="card-title">Purchase lots</div><div class="small muted">Historical buy lots; the FIFO cost basis above reflects any recorded sales</div></div><span class="pill">${lots.length} lot${lots.length === 1 ? "" : "s"}</span></div>
        ${lots.length ? `<div class="table-wrap"><table><thead><tr><th>Security</th><th>Units bought</th><th>Buy price</th><th>Reporting cost</th><th>Bought on</th></tr></thead><tbody>${lots.map(lot=>`<tr><td><strong>${esc(lot.security_symbol)}</strong><br/><span class="small muted">${esc(lot.security_name)}</span></td><td>${quantityFmt(lot.quantity_micros)}</td><td>${centsFmt(lot.buy_price_cents, lot.security_currency_code)}</td><td>${centsFmt(lot.reporting_buy_price_cents, currency)}</td><td>${esc(lot.bought_on)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="muted small">No purchase lots yet. Record a buy to open a FIFO lot.</div>`}
      </div>
    </div>
  `;

  container.querySelector("#inv-act-record-event")?.addEventListener("click",()=>{
    if(!securities.length){
      toast("Add a security before recording a holding event", true);
      openSecurityModal(main);
      return;
    }
    openHoldingEventModal(main, account.id, securities);
  });
  container.querySelector("#inv-act-add-security")?.addEventListener("click",()=>openSecurityModal(main));
  container.querySelector("#inv-act-remove")?.addEventListener("click",async()=>{
    if(!confirm(`Remove investment account "${account.name}" and its holdings?`)) return;
    try{
      await invoke("delete_investment_account", {id:account.id});
      if(selectedInvestmentAccountId === account.id) selectedInvestmentAccountId = null;
      await renderInvestmentPortfolios(main);
      toast("Investment account removed");
    }catch(error:any){
      toast(String(error), true);
    }
  });
}

function highlightSelectedInvestmentRow(main:HTMLElement, id:number){
  main.querySelectorAll<HTMLElement>("[data-investment-id]").forEach(row=>{
    const isSelected = Number(row.dataset.investmentId) === id;
    row.classList.toggle("is-selected", isSelected);
    const button = row.querySelector(".investment-name-btn");
    button?.classList.toggle("is-active", isSelected);
    const badge = row.querySelector(".investment-active-badge");
    if(isSelected && !badge){
      button?.insertAdjacentHTML("beforeend", '<span class="investment-active-badge">Selected</span>');
    }else if(!isSelected){
      badge?.remove();
    }
  });
}

async function renderInvestmentPortfolios(main:HTMLElement){
  let investments:InvestmentAccountRecord[] = [];
  let securities:SecurityRecord[] = [];
  let xirr:PortfolioXirrRecord = {annualized_return_percent:null, as_of:null, cash_flow_count:0};
  try{
    [investments, securities, xirr] = await Promise.all([
      invoke<InvestmentAccountRecord[]>("list_investment_accounts"),
      invoke<SecurityRecord[]>("list_securities"),
      invoke<PortfolioXirrRecord>("portfolio_xirr"),
    ]);
  }catch(error:any){
    toast(String(error), true);
  }

  if(selectedInvestmentAccountId === null && investments.length > 0){
    selectedInvestmentAccountId = investments[0].id;
  }
  if(selectedInvestmentAccountId !== null && !investments.some(account=>account.id === selectedInvestmentAccountId)){
    selectedInvestmentAccountId = investments.length > 0 ? investments[0].id : null;
  }

  const total = investments.reduce((sum, account)=>sum + account.value_cents, 0);
  const contributed = investments.reduce((sum, account)=>sum + account.contributed_cents, 0);
  main.innerHTML = `
    <div class="page-head investments-head">
      <div><h2>Investment accounts</h2><p>Click an account name to view holdings, manual price coverage, lots, performance, and recent activity.</p></div>
      <div class="inline-actions"><button class="btn" id="add-security">+ Security</button><button class="btn btn-primary" id="add-investment-account">+ Investment account</button></div>
    </div>
    <div class="stat-grid">
      <div class="card stat accent"><div class="label">Portfolio value</div><div class="value">${centsFmt(total)}</div><div class="sub">Across ${investments.length} account${investments.length === 1 ? "" : "s"}</div></div>
      <div class="card stat"><div class="label">Contributed capital</div><div class="value">${centsFmt(contributed)}</div><div class="sub">Recorded account contributions</div></div>
      <div class="card stat"><div class="label">Portfolio XIRR</div><div class="value">${percentFmt(xirr.annualized_return_percent)}</div><div class="sub">${xirr.as_of ? `As of ${esc(xirr.as_of)}` : "Record cash flows and prices to calculate"}</div></div>
      <div class="card stat"><div class="label">Securities</div><div class="value">${securities.length}</div><div class="sub">${securities.length ? securities.map(security=>esc(security.symbol)).join(" · ") : "Add a security to begin"}</div></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Account</th><th>Institution</th><th>Current value</th><th>Contributed</th><th>Value change</th><th>Manual value as of</th><th></th></tr></thead>
      <tbody>
        ${investments.map(account=>{
          const isSelected = account.id === selectedInvestmentAccountId;
          const valueChange = account.value_cents - account.contributed_cents;
          return `<tr class="investment-row ${isSelected ? "is-selected" : ""}" data-investment-id="${account.id}">
            <td><button type="button" class="investment-name-btn ${isSelected ? "is-active" : ""}" data-select-investment="${account.id}" title="Click to view holdings and performance for ${esc(account.name)}"><span class="investment-name-text">${esc(account.name)}</span><span class="muted small">#${account.id}</span>${isSelected ? '<span class="investment-active-badge">Selected</span>' : ""}</button></td>
            <td>${esc(account.institution ?? "—")}</td>
            <td style="font-weight:800">${centsFmt(account.value_cents)}</td>
            <td>${centsFmt(account.contributed_cents)}</td>
            <td class="${valueChange >= 0 ? "text-positive" : "text-negative"}">${valueChange >= 0 ? "+" : ""}${centsFmt(valueChange)}</td>
            <td class="small muted">${esc(account.as_of)}</td>
            <td><button class="btn btn-sm" data-edit-investment="${account.id}">Edit</button> <button class="btn btn-sm" data-remove-investment="${account.id}">Remove</button></td>
          </tr>`;
        }).join("") || `<tr><td colspan="7" class="empty">No investment accounts yet. Add an account, then add a security and record its first buy.</td></tr>`}
      </tbody>
    </table></div>
    <div id="investment-detail-root" class="investment-detail-root"></div>
  `;

  const detailRoot = main.querySelector("#investment-detail-root") as HTMLElement;
  const selectAccount = (id:number) => {
    if(selectedInvestmentAccountId === id) return;
    pushNavigationState();
    selectedInvestmentAccountId = id;
    highlightSelectedInvestmentRow(main, id);
    void renderInvestmentAccountDetails(detailRoot, id, investments, securities, main);
    updateTopbarBackButton();
  };

  main.querySelectorAll<HTMLElement>("[data-select-investment]").forEach(button=>{
    button.addEventListener("click", event=>{
      event.stopPropagation();
      selectAccount(Number(button.dataset.selectInvestment));
    });
  });
  main.querySelectorAll<HTMLElement>("[data-investment-id]").forEach(row=>{
    row.addEventListener("click", event=>{
      if((event.target as HTMLElement).closest("button")) return;
      selectAccount(Number(row.dataset.investmentId));
    });
  });

  main.querySelector("#add-security")!.addEventListener("click",()=>openSecurityModal(main));
  main.querySelector("#add-investment-account")!.addEventListener("click",()=>openInvestmentAccountModal(main));
  main.querySelectorAll<HTMLElement>("[data-edit-investment]").forEach(button=>button.addEventListener("click", async event=>{
    event.stopPropagation();
    try {
      const account = await invoke<InvestmentAccountRecord>("get_investment_account", {id:Number(button.dataset.editInvestment)});
      openInvestmentAccountModal(main, account);
    } catch(error:any) { toast(String(error), true); }
  }));
  main.querySelectorAll<HTMLElement>("[data-remove-investment]").forEach(button=>button.addEventListener("click", async event=>{
    event.stopPropagation();
    const id = Number(button.dataset.removeInvestment);
    const account = investments.find(item=>item.id === id);
    if(!account || !confirm(`Remove investment account "${account.name}" and its holdings?`)) return;
    try{
      await invoke("delete_investment_account", {id});
      if(selectedInvestmentAccountId === id) selectedInvestmentAccountId = null;
      await renderInvestmentPortfolios(main);
      toast("Investment account removed");
    }catch(error:any){
      toast(String(error), true);
    }
  }));

  if(selectedInvestmentAccountId !== null){
    void renderInvestmentAccountDetails(detailRoot, selectedInvestmentAccountId, investments, securities, main);
  }
}
function openInvestmentAccountModal(main:HTMLElement, existing?:InvestmentAccountRecord){
  const root=document.getElementById("modal-root")!;
  root.innerHTML=`<div class="modal-backdrop" id="bd"><div class="modal"><div class="modal-head"><h3>Investment account</h3><button class="btn btn-ghost" id="x">✕</button></div><div class="modal-body"><div class="field"><label>Name</label><input id="inv-name" class="input" placeholder="Index funds"/></div><div class="field"><label>Institution (optional)</label><input id="inv-institution" class="input" placeholder="Broker / fund house"/></div><div class="row"><div class="field"><label>Legacy current value</label><input id="inv-value" class="input" value="0.00"/></div><div class="field"><label>Legacy contributed</label><input id="inv-contributed" class="input" value="0.00"/></div></div><div class="small muted">A complete set of manual price snapshots will supersede this legacy value in net worth and portfolio cards.</div><div class="field"><label>As of</label><input id="inv-date" class="input" type="date" value="${todayISO()}"/></div></div><div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn btn-primary" id="save">Save</button></div></div></div>`;
  const close=()=>root.innerHTML="";root.querySelector("#x")!.addEventListener("click",close);root.querySelector("#cancel")!.addEventListener("click",close);root.querySelector("#bd")!.addEventListener("click",event=>{if(event.target===event.currentTarget)close();});
  if(existing){
    (root.querySelector("#inv-name") as HTMLInputElement).value=existing.name;
    (root.querySelector("#inv-institution") as HTMLInputElement).value=existing.institution||"";
    (root.querySelector("#inv-value") as HTMLInputElement).value=(existing.value_cents/100).toFixed(2);
    (root.querySelector("#inv-contributed") as HTMLInputElement).value=(existing.contributed_cents/100).toFixed(2);
    (root.querySelector("#inv-date") as HTMLInputElement).value=existing.as_of;
  }
  root.querySelector("#save")!.addEventListener("click",async()=>{try{await invoke(existing?"edit_investment_account":"add_investment_account",{id:existing?.id,req:{name:(root.querySelector("#inv-name") as HTMLInputElement).value,institution:(root.querySelector("#inv-institution") as HTMLInputElement).value||null,value:(root.querySelector("#inv-value") as HTMLInputElement).value,contributed:(root.querySelector("#inv-contributed") as HTMLInputElement).value,as_of:(root.querySelector("#inv-date") as HTMLInputElement).value}});close();await renderInvestmentPortfolios(main);toast(existing?"Investment account updated":"Investment account added");}catch(error:any){toast(String(error),true);}});
}
function openSecurityModal(main:HTMLElement){
  const root=document.getElementById("modal-root")!;
  root.innerHTML=`<div class="modal-backdrop" id="bd"><div class="modal"><div class="modal-head"><h3>Security</h3><button class="btn btn-ghost" id="x">✕</button></div><div class="modal-body"><div class="row"><div class="field"><label>Symbol</label><input id="security-symbol" class="input" placeholder="VTI"/></div><div class="field"><label>Currency</label><select id="security-currency">${currencyOptions(currency)}</select></div></div><div class="field"><label>Name</label><input id="security-name" class="input" placeholder="Vanguard Total Stock Market ETF"/></div></div><div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn btn-primary" id="save">Add security</button></div></div></div>`;
  const close=()=>root.innerHTML="";root.querySelector("#x")!.addEventListener("click",close);root.querySelector("#cancel")!.addEventListener("click",close);root.querySelector("#bd")!.addEventListener("click",event=>{if(event.target===event.currentTarget)close();});
  root.querySelector("#save")!.addEventListener("click",async()=>{try{await invoke("add_security",{req:{symbol:(root.querySelector("#security-symbol") as HTMLInputElement).value,name:(root.querySelector("#security-name") as HTMLInputElement).value,currency_code:(root.querySelector("#security-currency") as HTMLSelectElement).value}});close();await renderInvestmentPortfolios(main);toast("Security added");}catch(error:any){toast(String(error),true);}});
}
function openHoldingEventModal(main:HTMLElement,investmentAccountId:number,securities:SecurityRecord[]){
  const root=document.getElementById("modal-root")!, options=securities.map(security=>`<option value="${security.id}">${esc(security.symbol)} · ${esc(security.name)} · ${esc(security.currency_code)}</option>`).join("");
  root.innerHTML=`<div class="modal-backdrop" id="bd"><div class="modal"><div class="modal-head"><h3>Record holding event</h3><button class="btn btn-ghost" id="x">✕</button></div><div class="modal-body"><div class="row"><div class="field"><label>Type</label><select id="holding-event-type"><option value="buy">Buy</option><option value="sell">Sell</option><option value="dividend">Dividend</option><option value="price_snapshot">Price snapshot</option></select></div><div class="field"><label>Security</label><select id="holding-security">${options}</select></div></div><div class="field"><label>Date</label><input id="holding-date" class="input" type="date" value="${todayISO()}"/></div><div class="row" id="holding-trade-fields"><div class="field" id="holding-quantity-field"><label>Quantity</label><input id="holding-quantity" class="input" inputmode="decimal" placeholder="e.g. 12.5"/></div><div class="field"><label>Price per unit</label><input id="holding-price" class="input" inputmode="decimal" placeholder="e.g. 245.32"/></div></div><div class="field" id="holding-amount-field" hidden><label>Dividend amount</label><input id="holding-amount" class="input" inputmode="decimal" placeholder="e.g. 18.44"/></div><div class="field" id="holding-reporting-field" hidden><label id="holding-reporting-label">Reporting price</label><input id="holding-reporting" class="input" inputmode="decimal" placeholder="Amount in reporting currency"/><div class="small muted">Required for foreign-currency securities; saved as an offline reporting-currency snapshot.</div></div><div class="field"><label>Note (optional)</label><input id="holding-note" class="input"/></div></div><div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn btn-primary" id="save">Record event</button></div></div></div>`;
  const close=()=>root.innerHTML="", eventType=root.querySelector<HTMLSelectElement>("#holding-event-type")!, securitySelect=root.querySelector<HTMLSelectElement>("#holding-security")!;
  const sync=()=>{const type=eventType.value, security=securities.find(item=>item.id===Number(securitySelect.value))!;const tradeOrSnapshot=type!=="dividend", dividend=type==="dividend"; (root.querySelector("#holding-trade-fields") as HTMLElement).hidden=!tradeOrSnapshot;(root.querySelector("#holding-quantity-field") as HTMLElement).hidden=type==="price_snapshot";(root.querySelector("#holding-amount-field") as HTMLElement).hidden=!dividend;const foreign=security.currency_code!==currency;(root.querySelector("#holding-reporting-field") as HTMLElement).hidden=!foreign;(root.querySelector("#holding-reporting-label") as HTMLElement).textContent=dividend?`Reporting amount (${currency})`:`Reporting price per unit (${currency})`;};sync();eventType.addEventListener("change",sync);securitySelect.addEventListener("change",sync);
  root.querySelector("#x")!.addEventListener("click",close);root.querySelector("#cancel")!.addEventListener("click",close);root.querySelector("#bd")!.addEventListener("click",event=>{if(event.target===event.currentTarget)close();});
  root.querySelector("#save")!.addEventListener("click",async()=>{const type=eventType.value,foreign=securities.find(item=>item.id===Number(securitySelect.value))!.currency_code!==currency,reporting=(root.querySelector("#holding-reporting") as HTMLInputElement).value.trim()||null;try{await invoke("add_holding_event",{req:{investment_account_id:investmentAccountId,security_id:Number(securitySelect.value),event_type:type,event_on:(root.querySelector("#holding-date") as HTMLInputElement).value,quantity:(root.querySelector("#holding-quantity") as HTMLInputElement).value.trim()||null,price:(root.querySelector("#holding-price") as HTMLInputElement).value.trim()||null,reporting_price:foreign&&type!=="dividend"?reporting:null,amount:(root.querySelector("#holding-amount") as HTMLInputElement).value.trim()||null,reporting_amount:foreign&&type==="dividend"?reporting:null,note:(root.querySelector("#holding-note") as HTMLInputElement).value.trim()||null}});close();await renderInvestmentPortfolios(main);toast("Holding event recorded");}catch(error:any){toast(String(error),true);}});
}

type ComparisonPeriodKind = "month"|"quarter"|"year"|"custom"|"all";
type ComparisonBaselineMode = "period"|"avg3"|"avg6"|"avg12";
interface ComparisonRange { from:string; to:string; label:string; kind:ComparisonPeriodKind; }
interface ComparisonPeriodConfig { kind:ComparisonPeriodKind; month:string; quarterYear:string; quarter:string; year:string; from:string; to:string; }
interface ComparisonFavorite { name:string; a:ComparisonPeriodConfig; b:ComparisonPeriodConfig; account:string; baseline:ComparisonBaselineMode; outlier:string; }
interface ComparisonSpendPoint { label:string; spent_cents:number; transaction_count:number; }
interface ComparisonDiffRow { label:string; a:number; b:number; delta:number; }

function comparisonDate(year:number, month:number, day:number){
  return new Date(year, month-1, day, 12);
}
function comparisonDateISO(date:Date){
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
function comparisonValidDate(value:string){
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if(!match) return false;
  const [year,month,day]=match.slice(1).map(Number);
  const date=comparisonDate(year,month,day);
  return date.getFullYear()===year && date.getMonth()===month-1 && date.getDate()===day;
}
function comparisonMonthRange(key:string):ComparisonRange|null{
  const match=/^(\d{4})-(\d{2})$/.exec(key);
  if(!match) return null;
  const [year,month]=match.slice(1).map(Number);
  if(month<1||month>12) return null;
  const end=new Date(year,month,0).getDate();
  const label=new Intl.DateTimeFormat(undefined,{month:"long",year:"numeric"}).format(comparisonDate(year,month,1));
  return {from:`${year}-${String(month).padStart(2,"0")}-01`,to:`${year}-${String(month).padStart(2,"0")}-${String(end).padStart(2,"0")}`,label,kind:"month"};
}
function comparisonShiftMonths(value:string, months:number){
  const [year,month,day]=value.split("-").map(Number);
  const targetMonth=month-1+months;
  const targetYear=year+Math.floor(targetMonth/12);
  const normalizedMonth=((targetMonth%12)+12)%12+1;
  const maxDay=new Date(targetYear,normalizedMonth,0).getDate();
  return comparisonDateISO(comparisonDate(targetYear,normalizedMonth,Math.min(day,maxDay)));
}
function comparisonShiftDays(value:string, days:number){
  const [year,month,day]=value.split("-").map(Number);
  const date=comparisonDate(year,month,day);
  date.setDate(date.getDate()+days);
  return comparisonDateISO(date);
}
function comparisonDaysInclusive(range:ComparisonRange){
  const [fy,fm,fd]=range.from.split("-").map(Number);
  const [ty,tm,td]=range.to.split("-").map(Number);
  return Math.round((comparisonDate(ty,tm,td).getTime()-comparisonDate(fy,fm,fd).getTime())/86_400_000)+1;
}
function comparisonPreviousRange(range:ComparisonRange, count:number):ComparisonRange|null{
  if(range.kind==="all") return null;
  if(range.kind==="month"){
    const previous=comparisonMonthRange(comparisonShiftMonths(range.from,-count).slice(0,7));
    return previous?{...previous,label:"Previous period"}:null;
  }
  if(range.kind==="quarter"){
    const from=comparisonShiftMonths(range.from,-3*count);
    const endMonth=comparisonShiftMonths(from,2).slice(0,7);
    const end=comparisonMonthRange(endMonth);
    return end?{from,to:end.to,label:"Previous period",kind:"quarter"}:null;
  }
  if(range.kind==="year"){
    const year=Number(range.from.slice(0,4))-count;
    return {from:`${year}-01-01`,to:`${year}-12-31`,label:"Previous period",kind:"year"};
  }
  const days=comparisonDaysInclusive(range);
  const to=comparisonShiftDays(range.from,-days*(count-1)-1);
  const from=comparisonShiftDays(to,-days+1);
  return {from,to,label:"Previous period",kind:"custom"};
}
function comparisonScaleSummary(summary:SummaryRecord, divisor:number):SummaryRecord{
  if(divisor===1) return summary;
  return {
    ...summary,
    transaction_count:summary.transaction_count/divisor,
    income_cents:summary.income_cents/divisor,
    expense_cents:summary.expense_cents/divisor,
    net_cents:summary.net_cents/divisor,
    transfer_in_cents:summary.transfer_in_cents/divisor,
    transfer_out_cents:summary.transfer_out_cents/divisor,
  };
}
function comparisonScaleSpending(points:ComparisonSpendPoint[], divisor:number){
  return divisor===1 ? points : points.map(point=>({...point,spent_cents:point.spent_cents/divisor,transaction_count:point.transaction_count/divisor}));
}
function comparisonDiffRows(a:ComparisonSpendPoint[], b:ComparisonSpendPoint[]):ComparisonDiffRow[]{
  const values=new Map<string,{a:number;b:number}>();
  for(const point of a) values.set(point.label,{a:point.spent_cents,b:values.get(point.label)?.b??0});
  for(const point of b) values.set(point.label,{a:values.get(point.label)?.a??0,b:point.spent_cents});
  return [...values.entries()].map(([label,value])=>({label,a:value.a,b:value.b,delta:value.a-value.b})).sort((left,right)=>Math.abs(right.delta)-Math.abs(left.delta)||left.label.localeCompare(right.label));
}
function comparisonPercent(value:number, baseline:number){
  if(baseline===0) return value===0 ? "0.0%" : "New";
  const pct=(value-baseline)/Math.abs(baseline)*100;
  return `${pct>=0?"+":""}${pct.toFixed(1)}%`;
}
function comparisonSigned(value:number, format:(input:number)=>string){
  if(value===0) return "—";
  return `${value>0?"↑ +":"↓ −"}${format(Math.abs(value))}`;
}
function comparisonMetricRow(label:string, a:number, b:number, format:(input:number)=>string, goodWhenHigher:boolean|null){
  const delta=a-b;
  const quality=goodWhenHigher===null||delta===0 ? "neutral" : (delta>0)===goodWhenHigher ? "good" : "bad";
  return `<tr><td>${esc(label)}</td><td>${format(a)}</td><td>${format(b)}</td><td><span class="comparison-delta ${quality}">${comparisonSigned(delta,format)} <span class="comparison-change-pill">${comparisonPercent(a,b)}</span></span></td></tr>`;
}
function comparisonRatioRow(label:string, a:number|null, b:number|null, goodWhenHigher:boolean){
  if(a===null||b===null) return `<tr><td>${esc(label)}</td><td>—</td><td>—</td><td class="muted">Needs income</td></tr>`;
  const delta=a-b;
  const quality=delta===0 ? "neutral" : (delta>0)===goodWhenHigher ? "good" : "bad";
  return `<tr><td>${esc(label)}</td><td>${a.toFixed(1)}%</td><td>${b.toFixed(1)}%</td><td><span class="comparison-delta ${quality}">${delta===0?"—":`${delta>0?"↑ +":"↓ −"}${Math.abs(delta).toFixed(1)} pp`} <span class="comparison-change-pill">${comparisonPercent(a,b)}</span></span></td></tr>`;
}
function comparisonHeadlineChart(a:SummaryRecord, b:SummaryRecord, aLabel:string, bLabel:string, moneyFmt:(value:number)=>string=centsFmt){
  const rows=[{label:"Income",a:a.income_cents,b:b.income_cents},{label:"Expenses",a:a.expense_cents,b:b.expense_cents},{label:"Net",a:a.net_cents,b:b.net_cents}];
  const width=640, height=222, left=48, right=18, top=18, bottom=174, zero=top+(bottom-top)/2;
  const max=Math.max(...rows.flatMap(row=>[Math.abs(row.a),Math.abs(row.b)]),1);
  const group=(width-left-right)/rows.length;
  const barWidth=Math.min(54,group*.28);
  const bar=(value:number,x:number,cls:string,label:string)=>{
    const size=Math.max(value===0?0:2,Math.abs(value)/max*(bottom-top)/2-4);
    const y=value>=0?zero-size:zero;
    return `<g class="comparison-chart-bar ${cls}"><title>${esc(`${label}: ${moneyFmt(value)}`)}</title><rect x="${Math.round(x)}" y="${Math.round(y)}" width="${Math.round(barWidth)}" height="${Math.round(size)}" rx="4"/></g>`;
  };
  const bars=rows.map((row,index)=>{
    const x=left+index*group+(group-barWidth*2-8)/2;
    return `${bar(row.a,x,"period-a",`${row.label} · ${aLabel}`)}${bar(row.b,x+barWidth+8,"period-b",`${row.label} · ${bLabel}`)}<text x="${Math.round(left+index*group+group/2)}" y="${bottom+27}" text-anchor="middle">${row.label}</text>`;
  }).join("");
  return `<div class="comparison-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Income, expenses, and net cashflow comparison"><line class="comparison-chart-grid" x1="${left}" x2="${width-right}" y1="${top}" y2="${top}"/><line class="comparison-chart-zero" x1="${left}" x2="${width-right}" y1="${zero}" y2="${zero}"/><line class="comparison-chart-grid" x1="${left}" x2="${width-right}" y1="${bottom}" y2="${bottom}"/>${bars}</svg><div class="chart-legend"><span><i class="period-a"></i>${esc(aLabel)}</span><span><i class="period-b"></i>${esc(bLabel)}</span></div></div>`;
}
function comparisonCategoryChart(rows:ComparisonDiffRow[], aLabel:string, bLabel:string, moneyFmt:(value:number)=>string=centsFmt){
  const top=rows.slice(0,6);
  if(!top.length) return `<div class="chart-empty">No categorized spending in either period.</div>`;
  const max=Math.max(...top.flatMap(row=>[row.a,row.b]),1);
  return `<div class="comparison-category-bars">${top.map(row=>`<div class="comparison-category-bar"><div class="comparison-category-label" title="${esc(row.label)}">${esc(row.label)}</div><div class="comparison-category-track"><span class="period-a" style="width:${Math.max(row.a?3:0,row.a/max*100)}%" title="${esc(`${aLabel}: ${moneyFmt(row.a)}`)}"></span><span class="period-b" style="width:${Math.max(row.b?3:0,row.b/max*100)}%" title="${esc(`${bLabel}: ${moneyFmt(row.b)}`)}"></span></div><div class="small muted">${moneyFmt(row.a)} / ${moneyFmt(row.b)}</div></div>`).join("")}</div><div class="chart-legend"><span><i class="period-a"></i>${esc(aLabel)}</span><span><i class="period-b"></i>${esc(bLabel)}</span></div>`;
}
function comparisonWaterfall(a:SummaryRecord, b:SummaryRecord, moneyFmt:(value:number)=>string=centsFmt){
  const incomeDelta=a.income_cents-b.income_cents;
  const expenseImpact=-(a.expense_cents-b.expense_cents);
  const transferImpact=(a.transfer_in_cents-a.transfer_out_cents)-(b.transfer_in_cents-b.transfer_out_cents);
  const steps:[string,number,boolean][]=[["Prior net",b.net_cents,true],["Income Δ",incomeDelta,false],["Expense Δ",expenseImpact,false]];
  if(transferImpact!==0) steps.push(["Transfers Δ",transferImpact,false]);
  const bars:{label:string;from:number;to:number;final:boolean}[]=[];
  let running=b.net_cents;
  bars.push({label:"Prior net",from:0,to:running,final:true});
  for(const [label,value] of steps.slice(1)){
    bars.push({label,from:running,to:running+value,final:false});
    running+=value;
  }
  bars.push({label:"Current net",from:0,to:a.net_cents,final:true});
  const values=bars.flatMap(bar=>[bar.from,bar.to]);
  const min=Math.min(...values,0), max=Math.max(...values,0), padding=Math.max((max-min)*.12,100);
  const lower=min-padding, upper=max+padding, width=640, height=224, left=30, right=18, top=18, bottom=170;
  const y=(value:number)=>bottom-(value-lower)/(upper-lower)*(bottom-top);
  const step=(width-left-right)/bars.length, barWidth=Math.min(70,step*.65);
  const rendered=bars.map((bar,index)=>{
    const x=left+index*step+(step-barWidth)/2, y1=y(bar.from), y2=y(bar.to), positive=bar.to-bar.from>=0;
    return `<g class="comparison-waterfall-bar ${bar.final?"total":positive?"positive":"negative"}"><title>${esc(`${bar.label}: ${moneyFmt(bar.to-bar.from)}`)}</title><rect x="${Math.round(x)}" y="${Math.round(Math.min(y1,y2))}" width="${Math.round(barWidth)}" height="${Math.max(2,Math.round(Math.abs(y2-y1)))}" rx="4"/><text x="${Math.round(x+barWidth/2)}" y="${bottom+26}" text-anchor="middle">${bar.label}</text></g>`;
  }).join("");
  return `<div class="comparison-chart comparison-waterfall"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Net cashflow waterfall"><line class="comparison-chart-zero" x1="${left}" x2="${width-right}" y1="${y(0)}" y2="${y(0)}"/>${rendered}</svg></div>`;
}
function comparisonDiffTable(rows:ComparisonDiffRow[], aLabel:string, bLabel:string, empty:string, moneyFmt:(value:number)=>string=centsFmt){
  if(!rows.length) return `<div class="small muted">${esc(empty)}</div>`;
  return `<div class="table-wrap comparison-table"><table><thead><tr><th>Category</th><th>${esc(aLabel)}</th><th>${esc(bLabel)}</th><th>Δ</th><th>Δ %</th></tr></thead><tbody>${rows.slice(0,20).map(row=>`<tr><td><strong>${esc(row.label)}</strong></td><td>${moneyFmt(row.a)}</td><td>${moneyFmt(row.b)}</td><td><span class="comparison-delta ${row.delta>0?"bad":row.delta<0?"good":"neutral"}">${comparisonSigned(row.delta,moneyFmt)}</span></td><td>${comparisonPercent(row.a,row.b)}</td></tr>`).join("")}</tbody></table></div>${rows.length>20?`<div class="small muted" style="margin-top:8px">Showing the 20 largest movers of ${rows.length} categories.</div>`:""}`;
}
function comparisonCompactDiff(rows:ComparisonDiffRow[], aLabel:string, bLabel:string, empty:string, moneyFmt:(value:number)=>string=centsFmt){
  if(!rows.length) return `<div class="small muted">${esc(empty)}</div>`;
  return `<div class="table-wrap comparison-table"><table><thead><tr><th>Group</th><th>${esc(aLabel)}</th><th>${esc(bLabel)}</th><th>Δ</th></tr></thead><tbody>${rows.slice(0,8).map(row=>`<tr><td><strong>${esc(row.label)}</strong></td><td>${moneyFmt(row.a)}</td><td>${moneyFmt(row.b)}</td><td><span class="comparison-delta ${row.delta>0?"bad":row.delta<0?"good":"neutral"}">${comparisonSigned(row.delta,moneyFmt)}</span></td></tr>`).join("")}</tbody></table></div>`;
}
function comparisonNetWorthAt(items:NetWorthItemRecord[], asOf:string){
  const latest=new Map<string,NetWorthItemRecord>();
  for(const item of items){
    const key=`${item.kind}:${item.name.trim().toLocaleLowerCase()}`;
    const current=latest.get(key);
    if(item.as_of<=asOf && (!current || item.as_of>current.as_of || (item.as_of===current.as_of && item.id>current.id))) latest.set(key,item);
  }
  const values=[...latest.values()];
  return {value:values.reduce((sum,item)=>sum+(item.kind==="asset"?item.value_cents:-item.value_cents),0),count:values.length};
}
function comparisonWholeMonths(range:ComparisonRange){
  if(range.from.slice(8)!=="01") return [];
  const last=comparisonMonthRange(range.to.slice(0,7));
  if(!last||last.to!==range.to) return [];
  const months:string[]=[];
  let current=range.from.slice(0,7);
  while(current<=range.to.slice(0,7)){
    months.push(current);
    current=comparisonShiftMonths(`${current}-01`,1).slice(0,7);
  }
  return months;
}

async function renderComparisons(main:HTMLElement){
  const now=new Date(), currentMonth=monthKey(now), currentYear=String(now.getFullYear());
  const localToday=comparisonDateISO(now);
  const lastMonth=comparisonShiftMonths(`${currentMonth}-01`,-1).slice(0,7);
  const favoriteKey="finance-tracker-comparison-favorites";
  let requestId=0, lastCsv="", lastText="";
  const readFavorites=():ComparisonFavorite[]=>{try{const parsed=JSON.parse(localStorage.getItem(favoriteKey)??"[]");return Array.isArray(parsed)?parsed:[]}catch{return[]}};
  const favoriteOptions=()=>`<option value="">Saved comparisons…</option>${readFavorites().map((favorite,index)=>`<option value="${index}">${esc(favorite.name)}</option>`).join("")}`;
  const periodEditor=(id:"a"|"b", title:string, defaults:{month:string;year:string;from:string;to:string})=>`<div class="comparison-period"><div class="comparison-period-head"><span>${title}</span><select id="compare-${id}-kind"><option value="month">Month</option><option value="quarter">Quarter</option><option value="year">Year</option><option value="custom">Custom range</option><option value="all">All time</option></select></div><div class="comparison-period-input" data-period-kind="month"><input class="input" id="compare-${id}-month" type="month" value="${defaults.month}"/></div><div class="comparison-period-input" data-period-kind="quarter" hidden><div class="row"><input class="input" id="compare-${id}-quarter-year" type="number" min="1900" max="9999" value="${defaults.year}"/><select id="compare-${id}-quarter"><option value="1">Q1</option><option value="2">Q2</option><option value="3">Q3</option><option value="4">Q4</option></select></div></div><div class="comparison-period-input" data-period-kind="year" hidden><input class="input" id="compare-${id}-year" type="number" min="1900" max="9999" value="${defaults.year}"/></div><div class="comparison-period-input" data-period-kind="custom" hidden><div class="row"><input class="input" id="compare-${id}-from" type="date" value="${defaults.from}"/><input class="input" id="compare-${id}-to" type="date" value="${defaults.to}"/></div></div><div class="comparison-period-input small muted" data-period-kind="all" hidden>All recorded transactions through today.</div></div>`;
  const currentStart=`${currentMonth}-01`, currentEnd=comparisonMonthRange(currentMonth)!.to;
  const priorStart=`${lastMonth}-01`, priorEnd=comparisonMonthRange(lastMonth)!.to;
  main.innerHTML=`<div class="page-head"><h2>Comparisons</h2><p>Put any two periods side by side, then drill into the movements that explain the change.</p></div><div class="card comparison-controls"><div class="comparison-control-row"><select id="compare-preset"><option value="custom">Custom A vs B</option><option value="this-vs-last">This month vs last month</option><option value="year-vs-last">This year vs last year</option><option value="yoy">Same month last year</option><option value="ytd">YTD vs prior YTD</option><option value="avg3">This month vs last 3-month average</option></select><select id="compare-account"><option value="">All accounts</option>${accounts.map(account=>`<option value="${account.id}">${esc(account.name)}</option>`).join("")}</select><select id="compare-baseline"><option value="period">Compare against selected B</option><option value="avg3">Average of prior 3 equivalent periods</option><option value="avg6">Average of prior 6 equivalent periods</option><option value="avg12">Average of prior 12 equivalent periods</option></select><label class="comparison-threshold">Flag expense jumps over <input class="input" id="compare-outlier" type="number" min="0" step="1" value="20"/>%</label></div><div class="comparison-period-grid">${periodEditor("a","Period A",{month:currentMonth,year:currentYear,from:currentStart,to:currentEnd})}${periodEditor("b","Period B",{month:lastMonth,year:String(now.getFullYear()-1),from:priorStart,to:priorEnd})}</div><div class="comparison-actions"><button class="btn btn-primary" id="compare-load">Compare</button><button class="btn" id="comparison-export" disabled>Export CSV</button><button class="btn" id="comparison-copy" disabled>Copy summary</button><button class="btn" id="comparison-save">Save favorite</button><select id="comparison-favorites">${favoriteOptions()}</select></div></div><div id="comparison-result" class="card empty">Loading comparison…</div>`;
  const byId=<T extends HTMLElement>(id:string)=>main.querySelector(`#${id}`) as T;
  const togglePeriod=(id:"a"|"b")=>{
    const kind=byId<HTMLSelectElement>(`compare-${id}-kind`).value;
    main.querySelectorAll(`[data-period-kind]`).forEach(element=>{const item=element as HTMLElement;if(item.closest(".comparison-period")?.querySelector(`#compare-${id}-kind`)) item.hidden=item.dataset.periodKind!==kind;});
  };
  const periodConfig=(id:"a"|"b"):ComparisonPeriodConfig=>({kind:byId<HTMLSelectElement>(`compare-${id}-kind`).value as ComparisonPeriodKind,month:byId<HTMLInputElement>(`compare-${id}-month`).value,quarterYear:byId<HTMLInputElement>(`compare-${id}-quarter-year`).value,quarter:byId<HTMLSelectElement>(`compare-${id}-quarter`).value,year:byId<HTMLInputElement>(`compare-${id}-year`).value,from:byId<HTMLInputElement>(`compare-${id}-from`).value,to:byId<HTMLInputElement>(`compare-${id}-to`).value});
  const applyPeriod=(id:"a"|"b", config:ComparisonPeriodConfig)=>{
    byId<HTMLSelectElement>(`compare-${id}-kind`).value=config.kind;byId<HTMLInputElement>(`compare-${id}-month`).value=config.month;byId<HTMLInputElement>(`compare-${id}-quarter-year`).value=config.quarterYear;byId<HTMLSelectElement>(`compare-${id}-quarter`).value=config.quarter;byId<HTMLInputElement>(`compare-${id}-year`).value=config.year;byId<HTMLInputElement>(`compare-${id}-from`).value=config.from;byId<HTMLInputElement>(`compare-${id}-to`).value=config.to;togglePeriod(id);
  };
  const rangeFrom=(id:"a"|"b"):ComparisonRange=>{
    const config=periodConfig(id);
    if(config.kind==="month"){const range=comparisonMonthRange(config.month);if(!range) throw new Error(`Choose a valid month for period ${id.toUpperCase()}.`);return range;}
    if(config.kind==="quarter"){
      const year=Number(config.quarterYear), quarter=Number(config.quarter);if(!Number.isInteger(year)||year<1900||year>9999) throw new Error(`Choose a valid quarter year for period ${id.toUpperCase()}.`);
      const startMonth=(quarter-1)*3+1, endMonth=startMonth+2;
      return {from:`${year}-${String(startMonth).padStart(2,"0")}-01`,to:`${year}-${String(endMonth).padStart(2,"0")}-${String(new Date(year,endMonth,0).getDate()).padStart(2,"0")}`,label:`Q${quarter} ${year}`,kind:"quarter"};
    }
    if(config.kind==="year"){
      const year=Number(config.year);if(!Number.isInteger(year)||year<1900||year>9999) throw new Error(`Choose a valid year for period ${id.toUpperCase()}.`);
      return {from:`${year}-01-01`,to:`${year}-12-31`,label:String(year),kind:"year"};
    }
    if(config.kind==="custom"){
      if(!comparisonValidDate(config.from)||!comparisonValidDate(config.to)||config.from>config.to) throw new Error(`Choose a valid start and end date for period ${id.toUpperCase()}.`);
      return {from:config.from,to:config.to,label:`${config.from} to ${config.to}`,kind:"custom"};
    }
    return {from:"1900-01-01",to:localToday,label:"All time",kind:"all"};
  };
  const updateFavorites=()=>{byId<HTMLSelectElement>("comparison-favorites").innerHTML=favoriteOptions();};
  const setPreset=(preset:string)=>{
    const thisYear=String(now.getFullYear()), thisMonth=currentMonth;
    const set=(id:"a"|"b", patch:Partial<ComparisonPeriodConfig>)=>applyPeriod(id,{...periodConfig(id),...patch});
    byId<HTMLSelectElement>("compare-baseline").value="period";
    if(preset==="this-vs-last"){set("a",{kind:"month",month:thisMonth});set("b",{kind:"month",month:lastMonth});}
    if(preset==="year-vs-last"){set("a",{kind:"year",year:thisYear});set("b",{kind:"year",year:String(now.getFullYear()-1)});}
    if(preset==="yoy"){set("a",{kind:"month",month:thisMonth});set("b",{kind:"month",month:`${now.getFullYear()-1}-${thisMonth.slice(5)}`});}
    if(preset==="ytd"){const ytdStart=`${thisYear}-01-01`, ytdPriorStart=`${now.getFullYear()-1}-01-01`;set("a",{kind:"custom",from:ytdStart,to:localToday});set("b",{kind:"custom",from:ytdPriorStart,to:comparisonShiftMonths(localToday,-12)});}
    if(preset==="avg3"){set("a",{kind:"month",month:thisMonth});byId<HTMLSelectElement>("compare-baseline").value="avg3";}
  };
  const getBudgetContext=async(aRange:ComparisonRange,bRange:ComparisonRange,baselineDivisor:number,accountRef:string|null)=>{
    if(accountRef) return null;
    const aMonths=comparisonWholeMonths(aRange), bMonths=comparisonWholeMonths(bRange);
    if(!aMonths.length||!bMonths.length) return null;
    const fetch=async(months:string[])=>{
      const statuses=(await Promise.all(months.map(month=>invoke<BudgetStatusRecord[]>("budget_status",{month,scenario:null})))).flat();
      return statuses.reduce((total,row)=>({budget:total.budget+row.budget_cents,spent:total.spent+row.spent_cents}),{budget:0,spent:0});
    };
    try{const [a,bRaw]=await Promise.all([fetch(aMonths),fetch(bMonths)]);return {a,b:{budget:bRaw.budget/baselineDivisor,spent:bRaw.spent/baselineDivisor}};}catch{return null;}
  };
  const exportComparison=async()=>{
    if(!lastCsv) return;
    try{const path=await save({filters:[{name:"CSV",extensions:["csv"]}],defaultPath:"comparison.csv"});if(!path) return;await writeTextFile(path,lastCsv);toast("Comparison exported");}catch(error:any){toast(String(error),true);}
  };
  const copyComparison=async()=>{
    if(!lastText) return;
    try{await navigator.clipboard.writeText(lastText);toast("Comparison copied");}catch{const area=document.createElement("textarea");area.value=lastText;area.style.position="fixed";area.style.opacity="0";document.body.appendChild(area);area.select();const copied=document.execCommand("copy");area.remove();toast(copied?"Comparison copied":"Copy is unavailable",!copied);}
  };
  const load=async()=>{
    const id=++requestId, result=byId<HTMLElement>("comparison-result");
    result.className="card comparison-loading";result.textContent="Comparing periods…";
    byId<HTMLButtonElement>("comparison-export").disabled=true;byId<HTMLButtonElement>("comparison-copy").disabled=true;
    try{
      const aRange=rangeFrom("a"), selectedB=rangeFrom("b"), baselineMode=byId<HTMLSelectElement>("compare-baseline").value as ComparisonBaselineMode;
      if(aRange.kind==="all"&&baselineMode!=="period") throw new Error("All-time comparisons need an explicit period B, not an average baseline.");
      const count=baselineMode==="period"?1:Number(baselineMode.slice(3));
      const oldest=baselineMode==="period"?selectedB:comparisonPreviousRange(aRange,count);
      const newest=baselineMode==="period"?selectedB:comparisonPreviousRange(aRange,1);
      if(!oldest||!newest) throw new Error("This period cannot be compared with an average baseline.");
      const bRange:ComparisonRange=baselineMode==="period"?selectedB:{from:oldest.from,to:newest.to,label:`Average of prior ${count} equivalent periods`,kind:oldest.kind};
      const accountRef=byId<HTMLSelectElement>("compare-account").value||null;
      Object.assign(result.dataset,{currentFrom:aRange.from,currentTo:aRange.to,baselineFrom:bRange.from,baselineTo:bRange.to,baselineDivisor:String(count),account:accountRef??""});
      const comparisonCurrency=accountRef?accounts.find(account=>String(account.id)===accountRef)?.currency_code??currency:currency;
      const moneyFmt=(value:number)=>centsFmt(value,comparisonCurrency);
      const listLargest=(range:ComparisonRange)=>invoke<TransactionRecord[]>("list_transactions",{req:{from:range.from,to:range.to,account:accountRef,category:null,kind:"expense",accounts:[],categories:[],kinds:[],search:null,limit:1,include_deleted:false,sort_by:"amount",sort_dir:"desc"}});
      const accountPromise=accountRef ? Promise.resolve([] as {name:string;a:SummaryRecord;b:SummaryRecord}[]) : Promise.all(accounts.map(async account=>{const [a,bRaw]=await Promise.all([invoke<SummaryRecord>("get_summary",{from:aRange.from,to:aRange.to,account:String(account.id)}),invoke<SummaryRecord>("get_summary",{from:bRange.from,to:bRange.to,account:String(account.id)})]);return {name:account.name,a,b:comparisonScaleSummary(bRaw,count)};}));
      const budgetPromise=getBudgetContext(aRange,bRange,count,accountRef);
      const [aSummary,bRaw,categoryA,categoryB,payeeA,payeeB,tagA,tagB,trend,items,largestA,largestB,accountRows,budget,analytics]=await Promise.all([
        invoke<SummaryRecord>("get_summary",{from:aRange.from,to:aRange.to,account:accountRef}),
        invoke<SummaryRecord>("get_summary",{from:bRange.from,to:bRange.to,account:accountRef}),
        invoke<CategorySpendingPoint[]>("category_spending",{from:aRange.from,to:aRange.to,limit:1000,account:accountRef}),
        invoke<CategorySpendingPoint[]>("category_spending",{from:bRange.from,to:bRange.to,limit:1000,account:accountRef}),
        invoke<SpendingBreakdownPoint[]>("spending_by_payee",{from:aRange.from,to:aRange.to,limit:1000,account:accountRef}),
        invoke<SpendingBreakdownPoint[]>("spending_by_payee",{from:bRange.from,to:bRange.to,limit:1000,account:accountRef}),
        invoke<SpendingBreakdownPoint[]>("spending_by_tag",{from:aRange.from,to:aRange.to,limit:1000,account:accountRef}),
        invoke<SpendingBreakdownPoint[]>("spending_by_tag",{from:bRange.from,to:bRange.to,limit:1000,account:accountRef}),
        invoke<BalanceTrendPoint[]>("balance_trend",{months:12,account:accountRef}).catch(()=>[]),
        invoke<NetWorthItemRecord[]>("list_net_worth_items").catch(()=>[]),
        listLargest(aRange).catch(()=>[]), listLargest(bRange).catch(()=>[]), accountPromise, budgetPromise,
        invoke<ComparativeAnalyticsSnapshot>("get_comparative_analytics",{currentFrom:aRange.from,currentTo:aRange.to,baselineFrom:bRange.from,baselineTo:bRange.to,account:accountRef}),
      ]);
      if(id!==requestId) return;
      const bSummary=comparisonScaleSummary(bRaw,count), aLabel=aRange.label, bLabel=bRange.label;
      const categoryRows=comparisonDiffRows(categoryA.map(row=>({label:row.category_name,spent_cents:row.spent_cents,transaction_count:0})),comparisonScaleSpending(categoryB.map(row=>({label:row.category_name,spent_cents:row.spent_cents,transaction_count:0})),count));
      const payeeRows=comparisonDiffRows(payeeA,comparisonScaleSpending(payeeB,count));
      const tagRows=comparisonDiffRows(tagA,comparisonScaleSpending(tagB,count));
      const increased=categoryRows.filter(row=>row.delta>0).sort((left,right)=>right.delta-left.delta).slice(0,3), decreased=categoryRows.filter(row=>row.delta<0).sort((left,right)=>left.delta-right.delta).slice(0,3);
      const expenseDelta=aSummary.expense_cents-bSummary.expense_cents, top=increased[0];
      const narrative=expenseDelta>0?`You spent ${moneyFmt(expenseDelta)} more than ${bLabel}${top?`, driven by ${top.label} (+${moneyFmt(top.delta)})`:""}.`:expenseDelta<0?`You spent ${moneyFmt(Math.abs(expenseDelta))} less than ${bLabel}${decreased[0]?`, led by ${decreased[0].label} (${moneyFmt(decreased[0].delta)})`:""}.`:`Spending was unchanged versus ${bLabel}.`;
      const cashVolume=(summary:SummaryRecord)=>summary.income_cents+summary.expense_cents+(accountRef?summary.transfer_in_cents+summary.transfer_out_cents:summary.transfer_out_cents);
      const savingRate=(summary:SummaryRecord)=>summary.income_cents===0?null:(summary.income_cents-summary.expense_cents)/summary.income_cents*100;
      const expenseRatio=(summary:SummaryRecord)=>summary.income_cents===0?null:summary.expense_cents/summary.income_cents*100;
      const dailyBurn=(summary:SummaryRecord,days:number)=>summary.expense_cents/days;
      const bDays=comparisonDaysInclusive(bRange)/count;
      const outlierThreshold=Number(byId<HTMLInputElement>("compare-outlier").value)||0;
      const expenseIncrease=bSummary.expense_cents===0?null:(expenseDelta/bSummary.expense_cents*100);
      const netWorthA=comparisonNetWorthAt(items,aRange.to), netWorthB=comparisonNetWorthAt(items,bRange.to);
      const hasNetWorth=!accountRef&&(netWorthA.count>0||netWorthB.count>0);
      const biggestA=largestA[0], biggestB=largestB[0], largestDelta=(biggestA?.amount_cents??0)-(biggestB?.amount_cents??0);
      const accountTable=accountRows.length?`<div class="table-wrap comparison-table"><table><thead><tr><th>Account</th><th>${esc(aLabel)} expenses</th><th>${esc(bLabel)} expenses</th><th>Spend Δ</th><th>Net Δ</th></tr></thead><tbody>${accountRows.sort((left,right)=>Math.abs(right.a.expense_cents-right.b.expense_cents)-Math.abs(left.a.expense_cents-left.b.expense_cents)).map(row=>`<tr><td><strong>${esc(row.name)}</strong></td><td>${moneyFmt(row.a.expense_cents)}</td><td>${moneyFmt(row.b.expense_cents)}</td><td>${comparisonSigned(row.a.expense_cents-row.b.expense_cents,moneyFmt)}</td><td>${comparisonSigned(row.a.net_cents-row.b.net_cents,moneyFmt)}</td></tr>`).join("")}</tbody></table></div>`:"<div class=\"small muted\">Choose All accounts to see every account’s cash-flow delta.</div>";
      const seasonalityCard=analytics.seasonality.length?`<div class="card"><div class="card-title">Seasonality index</div><p class="small muted">Average monthly spending across complete ledger history. 1.00 is a typical month.</p><div class="comparison-mover-list">${analytics.seasonality.map(point=>`<div><span>${point.month_name} · ${point.observation_count} month${point.observation_count===1?"":"s"}</span><strong>${point.index.toFixed(2)} · ${moneyFmt(point.average_expense_cents)}</strong></div>`).join("")}</div></div>`:"";
      const movers=(rows:ComparisonDiffRow[],empty:string)=>rows.length?`<div class="comparison-mover-list">${rows.map(row=>`<div><span>${esc(row.label)}</span><strong>${comparisonSigned(row.delta,moneyFmt)}</strong></div>`).join("")}</div>`:`<div class="small muted">${esc(empty)}</div>`;
      const budgetCard=budget?`<div class="card"><div class="card-title">Budget vs actual</div><div class="comparison-context-grid"><div><span>${esc(aLabel)}</span><strong>${moneyFmt(budget.a.spent)} / ${moneyFmt(budget.a.budget)}</strong><small class="${budget.a.spent>budget.a.budget?"comparison-context-bad":""}">${budget.a.spent>budget.a.budget?"Over":"Under"} ${moneyFmt(Math.abs(budget.a.budget-budget.a.spent))}</small></div><div><span>${esc(bLabel)}</span><strong>${moneyFmt(budget.b.spent)} / ${moneyFmt(budget.b.budget)}</strong><small class="${budget.b.spent>budget.b.budget?"comparison-context-bad":""}">${budget.b.spent>budget.b.budget?"Over":"Under"} ${moneyFmt(Math.abs(budget.b.budget-budget.b.spent))}</small></div></div></div>`:"";
      result.className="comparison-results";
      result.innerHTML=`<div class="comparison-result-head"><div><div class="comparison-eyebrow">${esc(accountRef?accounts.find(account=>String(account.id)===accountRef)?.name??"Selected account":"All accounts")}</div><h3>${esc(aLabel)} <span>vs</span> ${esc(bLabel)}</h3><p>${esc(`${aRange.from} to ${aRange.to}`)} · ${esc(baselineMode==="period"?`${bRange.from} to ${bRange.to}`:`Average calculated from ${bRange.from} to ${bRange.to}`)}</p></div></div><div class="comparison-narrative">${esc(narrative)}</div>${expenseIncrease!==null&&expenseIncrease>=outlierThreshold&&expenseDelta>0?`<div class="comparison-alert">Expense outlier: spending is ${expenseIncrease.toFixed(1)}% above ${esc(bLabel)}, exceeding your ${outlierThreshold}% threshold.</div>`:""}<div class="grid2 comparison-visual-grid"><div class="card"><div class="card-title">Cashflow at a glance</div>${comparisonHeadlineChart(aSummary,bSummary,aLabel,bLabel,moneyFmt)}</div><div class="card"><div class="card-title">Net cashflow bridge</div>${comparisonWaterfall(aSummary,bSummary,moneyFmt)}</div></div><div class="card comparison-metrics"><div class="card-title">Headline metrics</div><div class="table-wrap"><table><thead><tr><th>Metric</th><th>${esc(aLabel)}</th><th>${esc(bLabel)}</th><th>Change</th></tr></thead><tbody>${comparisonMetricRow("Income",aSummary.income_cents,bSummary.income_cents,moneyFmt,true)}${comparisonMetricRow("Expenses",aSummary.expense_cents,bSummary.expense_cents,moneyFmt,false)}${comparisonMetricRow("Net cashflow",aSummary.net_cents,bSummary.net_cents,moneyFmt,true)}${comparisonMetricRow("Transfers in",aSummary.transfer_in_cents,bSummary.transfer_in_cents,moneyFmt,null)}${comparisonMetricRow("Transfers out",aSummary.transfer_out_cents,bSummary.transfer_out_cents,moneyFmt,null)}${comparisonMetricRow("Transactions",aSummary.transaction_count,bSummary.transaction_count,input=>Number.isInteger(input)?String(input):input.toFixed(1),null)}${comparisonMetricRow("Average transaction value",cashVolume(aSummary)/Math.max(aSummary.transaction_count,1),cashVolume(bSummary)/Math.max(bSummary.transaction_count,1),moneyFmt,null)}${comparisonRatioRow("Saving rate",savingRate(aSummary),savingRate(bSummary),true)}${comparisonRatioRow("Expense / income",expenseRatio(aSummary),expenseRatio(bSummary),false)}${comparisonMetricRow("Daily burn rate",dailyBurn(aSummary,comparisonDaysInclusive(aRange)),dailyBurn(bSummary,bDays),moneyFmt,false)}</tbody></table></div></div><div class="grid2"><div class="card"><div class="card-title">Top category movers</div><div class="comparison-movers"><div><h4>More spent</h4>${movers(increased,"No category increased.")}</div><div><h4>Less spent</h4>${movers(decreased,"No category decreased.")}</div></div></div><div class="card"><div class="card-title">Largest individual expense</div>${biggestA||biggestB?`<div class="comparison-largest"><div><span>${esc(aLabel)}</span><strong>${biggestA?moneyFmt(biggestA.amount_cents):"—"}</strong><small>${biggestA?esc(`${biggestA.payee??biggestA.category_name??"Uncategorized"} · ${biggestA.txn_date}`):"No expense"}</small></div><div><span>${esc(bLabel)}</span><strong>${biggestB?moneyFmt(biggestB.amount_cents):"—"}</strong><small>${biggestB?esc(`${biggestB.payee??biggestB.category_name??"Uncategorized"} · ${biggestB.txn_date}`):"No expense"}</small></div></div><div class="small muted" style="margin-top:10px">Largest-expense change: ${comparisonSigned(largestDelta,moneyFmt)}</div>${baselineMode!=="period"?`<div class="small muted" style="margin-top:5px">Baseline amount is the largest transaction across its source periods.</div>`:""}`:"<div class=\"small muted\">No expenses in either period.</div>"}</div></div><div class="card"><div class="card-title">Category spending — why it changed</div>${comparisonCategoryChart(categoryRows,aLabel,bLabel,moneyFmt)}${comparisonDiffTable(categoryRows,aLabel,bLabel,"No categorized expenses in either period.",moneyFmt)}</div><div class="grid2"><div class="card"><div class="card-title">Account delta</div>${accountTable}</div><div class="card"><div class="card-title">Payee & tag deltas</div><h4 class="comparison-subhead">Payees</h4>${comparisonCompactDiff(payeeRows,aLabel,bLabel,"No payee spending to compare.",moneyFmt)}<h4 class="comparison-subhead">Tags</h4>${comparisonCompactDiff(tagRows,aLabel,bLabel,"No tagged spending to compare.",moneyFmt)}<div class="small muted" style="margin-top:8px">A transaction with multiple tags is counted in each matching tag.</div></div></div><div class="grid2 comparison-context">${budgetCard}${hasNetWorth?`<div class="card"><div class="card-title">Manual net worth snapshots</div><div class="comparison-context-grid"><div><span>${esc(aRange.to)}</span><strong>${moneyFmt(netWorthA.value)}</strong><small>${netWorthA.count} latest item${netWorthA.count===1?"":"s"}</small></div><div><span>${esc(bRange.to)}</span><strong>${moneyFmt(netWorthB.value)}</strong><small>${comparisonSigned(netWorthA.value-netWorthB.value,moneyFmt)} vs baseline</small></div></div>${baselineMode!=="period"?`<div class="small muted" style="margin-top:8px">Average baselines use the latest baseline-end snapshot for net-worth context.</div>`:""}</div>`:""}${trend.length?`<div class="card"><div class="card-title">Balance trend context</div>${balanceTrendChart(trend,"Balance",moneyFmt)}</div>`:""}</div>${seasonalityCard}`;
      const csv=(cell:string|number)=>`"${String(cell).replaceAll('"','""')}"`;
      const csvMoney=(value:number)=>(value/100).toFixed(2);
      const csvRows:[[string,string,string,string,string],...string[][]]=[["Metric",`${aLabel} (${comparisonCurrency})`,`${bLabel} (${comparisonCurrency})`,`Delta (${comparisonCurrency})`,"Delta percent"],["Income",csvMoney(aSummary.income_cents),csvMoney(bSummary.income_cents),csvMoney(aSummary.income_cents-bSummary.income_cents),comparisonPercent(aSummary.income_cents,bSummary.income_cents)],["Expenses",csvMoney(aSummary.expense_cents),csvMoney(bSummary.expense_cents),csvMoney(expenseDelta),comparisonPercent(aSummary.expense_cents,bSummary.expense_cents)],["Net cashflow",csvMoney(aSummary.net_cents),csvMoney(bSummary.net_cents),csvMoney(aSummary.net_cents-bSummary.net_cents),comparisonPercent(aSummary.net_cents,bSummary.net_cents)],...categoryRows.map(row=>[`Category: ${row.label}`,csvMoney(row.a),csvMoney(row.b),csvMoney(row.delta),comparisonPercent(row.a,row.b)])];
      lastCsv=csvRows.map(row=>row.map(csv).join(",")).join("\n");
      lastText=`${aLabel} vs ${bLabel}\nIncome: ${moneyFmt(aSummary.income_cents)} vs ${moneyFmt(bSummary.income_cents)} (${comparisonPercent(aSummary.income_cents,bSummary.income_cents)})\nExpenses: ${moneyFmt(aSummary.expense_cents)} vs ${moneyFmt(bSummary.expense_cents)} (${comparisonPercent(aSummary.expense_cents,bSummary.expense_cents)})\nNet cashflow: ${moneyFmt(aSummary.net_cents)} vs ${moneyFmt(bSummary.net_cents)}\n${narrative}`;
      byId<HTMLButtonElement>("comparison-export").disabled=false;byId<HTMLButtonElement>("comparison-copy").disabled=false;
    }catch(error:any){if(id!==requestId) return;result.className="card empty";result.textContent="Unable to load this comparison.";toast(String(error),true);}
  };
  (["a","b"] as const).forEach(id=>{togglePeriod(id);byId<HTMLSelectElement>(`compare-${id}-kind`).addEventListener("change",()=>{togglePeriod(id);byId<HTMLSelectElement>("compare-preset").value="custom";});main.querySelectorAll(`#compare-${id}-month,#compare-${id}-quarter-year,#compare-${id}-quarter,#compare-${id}-year,#compare-${id}-from,#compare-${id}-to`).forEach(input=>input.addEventListener("change",()=>byId<HTMLSelectElement>("compare-preset").value="custom"));});
  byId<HTMLSelectElement>("compare-preset").addEventListener("change",event=>{const preset=(event.target as HTMLSelectElement).value;if(preset!=="custom"){setPreset(preset);void load();}});
  byId<HTMLButtonElement>("compare-load").addEventListener("click",()=>void load());
  byId<HTMLButtonElement>("comparison-export").addEventListener("click",()=>void exportComparison());
  byId<HTMLButtonElement>("comparison-copy").addEventListener("click",()=>void copyComparison());
  byId<HTMLButtonElement>("comparison-save").addEventListener("click",()=>{const name=prompt("Name this comparison");if(!name?.trim()) return;const favorites=readFavorites();favorites.push({name:name.trim(),a:periodConfig("a"),b:periodConfig("b"),account:byId<HTMLSelectElement>("compare-account").value,baseline:byId<HTMLSelectElement>("compare-baseline").value as ComparisonBaselineMode,outlier:byId<HTMLInputElement>("compare-outlier").value});localStorage.setItem(favoriteKey,JSON.stringify(favorites));updateFavorites();toast("Comparison saved on this device");});
  byId<HTMLSelectElement>("comparison-favorites").addEventListener("change",event=>{const index=Number((event.target as HTMLSelectElement).value), favorite=readFavorites()[index];if(!Number.isInteger(index)||!favorite) return;applyPeriod("a",favorite.a);applyPeriod("b",favorite.b);byId<HTMLSelectElement>("compare-account").value=favorite.account;byId<HTMLSelectElement>("compare-baseline").value=favorite.baseline;byId<HTMLInputElement>("compare-outlier").value=favorite.outlier;byId<HTMLSelectElement>("compare-preset").value="custom";void load();});
  await load();
}

// ---------- Rules, debt payoff, and tax planning ----------
async function renderRules(main:HTMLElement){
  let rules:TransactionRuleRecord[]=[];
  try{rules=await invoke<TransactionRuleRecord[]>("list_transaction_rules");}catch(error:any){toast(String(error),true);}
  if(view!=="rules")return;
  main.innerHTML=`<div class="page-head" style="display:flex;justify-content:space-between;align-items:flex-end"><div><h2>Transaction rules</h2><p>Ordered local rules clean imported descriptions and assign categories, notes, and tags.</p></div><button class="btn btn-primary" id="add-rule">+ Rule</button></div>
    <div class="card"><div class="card-title">Rules run from lowest priority number to highest</div><div class="table-wrap"><table><thead><tr><th>Priority</th><th>Rule</th><th>Condition</th><th>Actions</th><th>Status</th><th></th></tr></thead><tbody>${rules.map(rule=>`<tr><td>${rule.priority}</td><td><strong>${esc(rule.name)}</strong></td><td>${esc(rule.match_field)} ${esc(rule.match_operator.replaceAll("_"," "))} “${esc(rule.match_value)}”${rule.account_name?` · ${esc(rule.account_name)}`:""}${rule.kind?` · ${rule.kind}`:""}</td><td>${[rule.set_payee&&`payee → ${rule.set_payee}`,rule.set_category_name&&`category → ${rule.set_category_name}`,rule.append_note&&"append note",rule.tags.length&&`tags: ${rule.tags.join(", ")}`].filter(Boolean).map(esc).join(" · ")}</td><td><span class="pill">${rule.enabled?"enabled":"disabled"}</span></td><td><div style="display:flex;gap:6px"><button class="btn btn-sm" data-edit-rule="${rule.id}">Edit</button><button class="btn btn-sm" data-delete-rule="${rule.id}">Delete</button></div></td></tr>`).join("")||`<tr><td colspan="6" class="empty">No rules yet.</td></tr>`}</tbody></table></div></div>
    <div class="card" style="margin-top:14px"><div class="card-title">Review existing transactions</div><p class="small muted">Preview shows only rows that would change. Reconciled rows remain locked.</p><div style="display:flex;gap:8px"><button class="btn" id="preview-rules">Preview changes</button><button class="btn btn-primary" id="apply-rules" disabled>Apply preview</button></div><div id="rule-preview" style="margin-top:12px"></div></div>`;
  const openRuleModal=(existing?:TransactionRuleRecord)=>{
    const root=document.getElementById("modal-root")!;
    const kind=existing?.kind??"";
    root.innerHTML=`<div class="modal-backdrop" id="rule-bd"><div class="modal" style="max-width:680px"><div class="modal-head"><h3>${existing?"Edit":"New"} transaction rule</h3><button class="btn btn-ghost" id="rule-x">✕</button></div><div class="modal-body"><div class="row"><div class="field"><label>Name</label><input class="input" id="rule-name" value="${esc(existing?.name??"")}"/></div><div class="field"><label>Priority</label><input class="input" id="rule-priority" type="number" min="0" value="${existing?.priority??rules.length*10}"/></div></div><div class="row"><div class="field"><label>Field</label><select id="rule-field"><option value="payee">Payee / imported description</option><option value="note">Note</option></select></div><div class="field"><label>Match</label><select id="rule-operator"><option value="contains">contains</option><option value="exact">equals</option><option value="starts_with">starts with</option><option value="ends_with">ends with</option></select></div><div class="field"><label>Text</label><input class="input" id="rule-value" value="${esc(existing?.match_value??"")}"/></div></div><div class="row"><div class="field"><label>Account (optional)</label><select id="rule-account"><option value="">Any account</option>${accounts.map(a=>`<option value="${esc(a.name)}" ${a.id===existing?.account_id?"selected":""}>${esc(a.name)}</option>`).join("")}</select></div><div class="field"><label>Kind</label><select id="rule-kind"><option value="">Any income/expense</option><option value="expense" ${kind==="expense"?"selected":""}>expense</option><option value="income" ${kind==="income"?"selected":""}>income</option></select></div><div class="field"><label>Amount range (account currency)</label><div class="row"><input class="input" id="rule-min" placeholder="Min" value="${existing?.min_amount_cents!=null?(existing.min_amount_cents/100).toFixed(2):""}"/><input class="input" id="rule-max" placeholder="Max" value="${existing?.max_amount_cents!=null?(existing.max_amount_cents/100).toFixed(2):""}"/></div></div></div><div class="row"><div class="field"><label>Rename payee</label><input class="input" id="rule-payee" value="${esc(existing?.set_payee??"")}"/></div><div class="field"><label>Set category</label><select id="rule-category"><option value="">No change</option>${categories.map(c=>`<option value="${esc(c.name)}" data-kind="${c.kind}" ${c.id===existing?.set_category_id?"selected":""}>${esc(c.name)}</option>`).join("")}</select></div></div><div class="field"><label>Append note</label><input class="input" id="rule-note" value="${esc(existing?.append_note??"")}"/></div><div class="field"><label>Add tags</label><input class="input" id="rule-tags" value="${esc(existing?.tags.join(", ")??"")}" placeholder="comma separated"/></div><div class="row"><label class="toggle-label"><input class="toggle-input" id="rule-enabled" type="checkbox" ${existing?.enabled===false?"":"checked"}/><span class="toggle-control"></span><span>Enabled</span></label><label class="toggle-label"><input class="toggle-input" id="rule-stop" type="checkbox" ${existing?.stop_processing===false?"":"checked"}/><span class="toggle-control"></span><span>Stop after match</span></label></div></div><div class="modal-foot"><button class="btn" id="rule-cancel">Cancel</button><button class="btn btn-primary" id="rule-save">Save rule</button></div></div></div>`;
    (root.querySelector("#rule-field") as HTMLSelectElement).value=existing?.match_field??"payee";(root.querySelector("#rule-operator") as HTMLSelectElement).value=existing?.match_operator??"contains";
    const close=()=>root.innerHTML="";root.querySelector("#rule-x")!.addEventListener("click",close);root.querySelector("#rule-cancel")!.addEventListener("click",close);root.querySelector("#rule-bd")!.addEventListener("click",event=>{if(event.target===event.currentTarget)close();});
    const syncCategories=()=>{const selected=(root.querySelector("#rule-kind") as HTMLSelectElement).value;root.querySelectorAll<HTMLOptionElement>("#rule-category option[data-kind]").forEach(option=>option.hidden=!selected||option.dataset.kind!==selected);if(!selected)(root.querySelector("#rule-category") as HTMLSelectElement).value="";};(root.querySelector("#rule-kind") as HTMLSelectElement).addEventListener("change",syncCategories);syncCategories();
    root.querySelector("#rule-save")!.addEventListener("click",async()=>{const value=(id:string)=>(root.querySelector(`#${id}`) as HTMLInputElement).value.trim();try{await invoke("save_transaction_rule",{id:existing?.id??null,req:{name:value("rule-name"),priority:Number(value("rule-priority")),enabled:(root.querySelector("#rule-enabled") as HTMLInputElement).checked,match_field:(root.querySelector("#rule-field") as HTMLSelectElement).value,match_operator:(root.querySelector("#rule-operator") as HTMLSelectElement).value,match_value:value("rule-value"),account:(root.querySelector("#rule-account") as HTMLSelectElement).value||null,kind:(root.querySelector("#rule-kind") as HTMLSelectElement).value||null,min_amount:value("rule-min")||null,max_amount:value("rule-max")||null,set_payee:value("rule-payee")||null,set_category:(root.querySelector("#rule-category") as HTMLSelectElement).value||null,append_note:value("rule-note")||null,tags:value("rule-tags").split(",").map(v=>v.trim()).filter(Boolean),stop_processing:(root.querySelector("#rule-stop") as HTMLInputElement).checked}});close();toast("Rule saved");renderRules(main);}catch(error:any){toast(String(error),true);}});
  };
  main.querySelector("#add-rule")!.addEventListener("click",()=>openRuleModal());main.querySelectorAll<HTMLElement>("[data-edit-rule]").forEach(button=>button.addEventListener("click",()=>openRuleModal(rules.find(rule=>rule.id===Number(button.dataset.editRule)))));main.querySelectorAll<HTMLElement>("[data-delete-rule]").forEach(button=>button.addEventListener("click",async()=>{if(!confirm("Delete this transaction rule?"))return;try{await invoke("delete_transaction_rule",{id:Number(button.dataset.deleteRule)});renderRules(main);}catch(error:any){toast(String(error),true);}}));
  let preview:RuleApplyResult|null=null;const previewRoot=main.querySelector("#rule-preview") as HTMLElement;const renderPreview=()=>{const skipped=preview?.skipped_reconciled_count?`<div class="small muted" style="margin-top:8px">${preview.skipped_reconciled_count} reconciled transaction(s) were skipped.</div>`:"";previewRoot.innerHTML=(preview?.preview.length?`<div class="table-wrap"><table><thead><tr><th>Transaction</th><th>Payee</th><th>Category</th><th>Note</th><th>Tags added</th></tr></thead><tbody>${preview.preview.map(row=>`<tr><td>#${row.transaction_id} · ${row.txn_date}</td><td>${esc(row.before_payee??"—")} → <strong>${esc(row.after_payee??"—")}</strong></td><td>${esc(row.before_category??"—")} → <strong>${esc(row.after_category??row.before_category??"—")}</strong></td><td>${esc(row.before_note??"—")} → <strong>${esc(row.after_note??"—")}</strong></td><td>${esc(row.added_tags.join(", ")||"—")}</td></tr>`).join("")}</tbody></table></div>`:`<div class="small muted">No transactions would change.</div>`)+skipped;};
  main.querySelector("#preview-rules")!.addEventListener("click",async()=>{try{preview=await invoke<RuleApplyResult>("apply_transaction_rules",{transactionIds:null,dryRun:true});renderPreview();(main.querySelector("#apply-rules") as HTMLButtonElement).disabled=!preview.changed_count;}catch(error:any){toast(String(error),true);}});main.querySelector("#apply-rules")!.addEventListener("click",async()=>{try{const result=await invoke<RuleApplyResult>("apply_transaction_rules",{transactionIds:preview?.preview.map(v=>v.transaction_id)??null,dryRun:false});toast(`Applied rules to ${result.changed_count} transactions`,false,result.run_id?{label:"Undo",run:async()=>{await invoke("undo_rule_application",{runId:result.run_id});toast("Rule changes undone");}}:undefined);renderRules(main);}catch(error:any){toast(String(error),true);}});
}

async function renderDebtOptimizer(main:HTMLElement){
  const stored=localStorage.getItem("finance-tracker-debt-extra")??"0.00";
  let settings:DebtAccountSettingRecord[]=[];
  try{settings=await invoke<DebtAccountSettingRecord[]>("list_credit_debt_settings");}
  catch(error:any){toast(String(error),true);}
  if(view!=="debt") return;
  const savedByAccount=new Map(settings.map(setting=>[setting.account_id,setting]));
  const creditRows=accounts.filter(account=>account.kind==="credit").map(account=>{
    const saved=savedByAccount.get(account.id);
    return `<div class="row" data-credit-debt="${account.id}"><strong style="min-width:160px">${esc(account.name)}</strong><div class="field"><label>APR %</label><input class="input" data-debt-apr type="number" min="0" step="0.01" value="${saved?(saved.annual_rate_bps/100).toFixed(2):""}"/></div><div class="field"><label>Minimum payment (${esc(currency)})</label><input class="input" data-debt-min value="${saved?(saved.minimum_payment_cents/100).toFixed(2):""}"/></div><button class="btn btn-sm" data-save-credit="${account.id}">Save</button>${saved?`<button class="btn btn-sm" data-remove-credit="${account.id}">Remove</button>`:""}</div>`;
  }).join("");
  main.innerHTML=`<div class="page-head"><h2>Debt payoff optimizer</h2><p>Compare avalanche and snowball using one fixed monthly payment pool.</p></div><div class="card"><div class="row"><div class="field"><label>Extra monthly payment</label><input class="input" id="debt-extra" value="${esc(stored)}"/></div><button class="btn btn-primary" id="calculate-debt">Calculate</button></div><div id="debt-result" class="small muted">Loading projection…</div></div><div class="card" style="margin-top:14px"><div class="card-title">Credit-card assumptions</div><p class="small muted">Loans use their saved APR and EMI. Configure APR and minimum payment for each credit account with a debt balance. Foreign balances use the latest available reporting-currency rate.</p>${creditRows||`<div class="small muted">No credit accounts.</div>`}</div>`;
  const renderResult=(snapshot:DebtOptimizerSnapshot)=>{
    const card=(strategy:DebtOptimizerSnapshot["avalanche"])=>`<div class="card"><div class="card-title">${strategy.strategy==="avalanche"?"Avalanche · highest APR first":"Snowball · smallest balance first"}</div><div class="kpi-grid"><div class="kpi"><span>Debt-free</span><strong>${strategy.debt_free_month??"Not projected"}</strong></div><div class="kpi"><span>Total interest</span><strong>${centsFmt(strategy.total_interest_cents)}</strong></div><div class="kpi"><span>Total paid</span><strong>${centsFmt(strategy.total_paid_cents)}</strong></div></div>${strategy.warnings.map(w=>`<div class="comparison-alert">${esc(w)}</div>`).join("")}<div class="table-wrap"><table><thead><tr><th>Debt</th><th>Balance</th><th>APR</th><th>Minimum</th><th>Payoff</th><th>Interest</th></tr></thead><tbody>${strategy.items.map(item=>`<tr><td>${esc(item.name)}</td><td>${centsFmt(item.starting_balance_cents)}</td><td>${(item.annual_rate_bps/100).toFixed(2)}%</td><td>${centsFmt(item.minimum_payment_cents)}</td><td>${item.payoff_month??"—"}</td><td>${centsFmt(item.total_interest_cents)}</td></tr>`).join("")||`<tr><td colspan="6" class="empty">No configured active debts.</td></tr>`}</tbody></table></div></div>`;
    (main.querySelector("#debt-result") as HTMLElement).innerHTML=`<div class="grid2" style="margin-top:14px">${card(snapshot.avalanche)}${card(snapshot.snowball)}</div>`;
  };
  const calculate=async()=>{
    const extra=(main.querySelector("#debt-extra") as HTMLInputElement).value.trim()||"0.00";
    localStorage.setItem("finance-tracker-debt-extra",extra);
    try{renderResult(await invoke<DebtOptimizerSnapshot>("get_debt_optimizer",{extraPayment:extra}));}
    catch(error:any){toast(String(error),true);}
  };
  main.querySelector("#calculate-debt")!.addEventListener("click",calculate);
  main.querySelectorAll<HTMLElement>("[data-save-credit]").forEach(button=>button.addEventListener("click",async()=>{
    const row=button.closest<HTMLElement>("[data-credit-debt]")!;
    const account=accounts.find(item=>item.id===Number(button.dataset.saveCredit))!;
    const apr=Number(row.querySelector<HTMLInputElement>("[data-debt-apr]")!.value);
    const minimum=row.querySelector<HTMLInputElement>("[data-debt-min]")!.value;
    try{
      await invoke("save_credit_debt_settings",{account:account.name,annualRateBps:Math.round(apr*100),minimumPayment:minimum});
      toast("Credit debt assumptions saved");
      await renderDebtOptimizer(main);
    }catch(error:any){toast(String(error),true);}
  }));
  main.querySelectorAll<HTMLElement>("[data-remove-credit]").forEach(button=>button.addEventListener("click",async()=>{
    const account=accounts.find(item=>item.id===Number(button.dataset.removeCredit))!;
    try{
      await invoke("delete_credit_debt_settings",{account:account.name});
      toast("Credit debt assumptions removed");
      await renderDebtOptimizer(main);
    }catch(error:any){toast(String(error),true);}
  }));
  await calculate();
}

async function renderTaxCenter(main:HTMLElement){
  const year=new Date().getFullYear();let tax:TaxCenterSnapshot,investments:InvestmentAccountRecord[]=[],investmentSettings:InvestmentTaxSettingRecord[]=[],categorySettings:TaxCategorySettingRecord[]=[];
  try{[tax,investments,investmentSettings,categorySettings]=await Promise.all([invoke<TaxCenterSnapshot>("get_tax_center",{taxYear:year}),invoke<InvestmentAccountRecord[]>("list_investment_accounts"),invoke<InvestmentTaxSettingRecord[]>("list_investment_tax_settings"),invoke<TaxCategorySettingRecord[]>("list_tax_category_settings")]);}catch(error:any){main.innerHTML=`<div class="card empty">Tax center unavailable: ${esc(String(error))}</div>`;return;}if(view!=="tax")return;
  const renderTax=(snapshot:TaxCenterSnapshot)=>{const content=main.querySelector("#tax-results") as HTMLElement;content.innerHTML=`<div class="kpi-grid"><div class="kpi"><span>Sale proceeds · all treatments</span><strong>${centsFmt(snapshot.realized_proceeds_cents)}</strong></div><div class="kpi"><span>Cost basis</span><strong>${centsFmt(snapshot.realized_cost_basis_cents)}</strong></div><div class="kpi"><span>Short-term gain</span><strong>${centsFmt(snapshot.short_term_gain_cents)}</strong></div><div class="kpi"><span>Long-term gain</span><strong>${centsFmt(snapshot.long_term_gain_cents)}</strong></div></div>${snapshot.warnings.map(w=>`<div class="settings-inline-note">${esc(w)}</div>`).join("")}<div class="grid2" style="margin-top:14px"><div class="card"><div class="card-title">Dividend income</div>${snapshot.dividends.map(v=>`<div class="comparison-mover-list"><div><span>${esc(v.treatment.replaceAll("_"," "))}</span><strong>${centsFmt(v.amount_cents)}</strong></div></div>`).join("")||`<div class="small muted">No dividends in this year.</div>`}</div><div class="card"><div class="card-title">Deduction buckets</div>${snapshot.deductions.map(v=>`<div class="comparison-mover-list"><div><span>${esc(v.group)} · ${v.transaction_count} transactions</span><strong>${centsFmt(v.amount_cents)}</strong></div></div>`).join("")||`<div class="small muted">No mapped deductible categories.</div>`}</div></div><div class="card" style="margin-top:14px"><div class="card-title">FIFO realized gains</div><div class="table-wrap"><table><thead><tr><th>Sold</th><th>Investment</th><th>Treatment</th><th>Security</th><th>Acquired</th><th>Term</th><th>Proceeds</th><th>Basis</th><th>Gain</th></tr></thead><tbody>${snapshot.gains.map(g=>`<tr><td>${g.sold_on}</td><td>${esc(g.investment_account_name)}</td><td>${esc(g.treatment.replaceAll("_"," "))}</td><td>${esc(g.security_symbol)}</td><td>${g.bought_on}</td><td>${g.term==="long_term"?"Long-term":"Short-term"}</td><td>${centsFmt(g.proceeds_cents)}</td><td>${centsFmt(g.cost_basis_cents)}</td><td>${centsFmt(g.gain_cents)}</td></tr>`).join("")||`<tr><td colspan="9" class="empty">No realized sales in this year.</td></tr>`}</tbody></table></div></div>`;};
  main.innerHTML=`<div class="page-head" style="display:flex;justify-content:space-between;align-items:flex-end"><div><h2>Tax center</h2><p>FIFO realized gains, dividends, and user-mapped deduction buckets from local records.</p></div><div style="display:flex;gap:8px"><input class="input" id="tax-year" type="number" min="1900" max="9999" value="${year}"/><button class="btn btn-primary" id="load-tax">Load</button><button class="btn" id="export-tax">Export CSV</button></div></div><div id="tax-results"></div><div class="grid2" style="margin-top:14px"><div class="card"><div class="card-title">Investment account tax treatment</div>${investments.map(account=>{const selected=investmentSettings.find(v=>v.investment_account_id===account.id)?.treatment??"unknown";return`<div class="row"><strong>${esc(account.name)}</strong><select data-tax-investment="${account.id}"><option value="unknown" ${selected==="unknown"?"selected":""}>Unknown</option><option value="taxable" ${selected==="taxable"?"selected":""}>Taxable</option><option value="tax_advantaged" ${selected==="tax_advantaged"?"selected":""}>Tax-advantaged</option></select></div>`;}).join("")||`<div class="small muted">No investment accounts.</div>`}</div><div class="card"><div class="card-title">Deductible expense categories</div>${categories.filter(c=>c.kind==="expense").map(category=>`<div class="row"><strong>${esc(category.name)}</strong><input class="input" data-tax-category="${category.id}" placeholder="Not deductible; enter bucket to map" value="${esc(categorySettings.find(v=>v.category_id===category.id)?.deduction_group??"")}"/></div>`).join("")}</div></div>`;
  renderTax(tax);const loadTax=async()=>{try{tax=await invoke<TaxCenterSnapshot>("get_tax_center",{taxYear:Number((main.querySelector("#tax-year") as HTMLInputElement).value)});renderTax(tax);}catch(error:any){toast(String(error),true);}};main.querySelector("#load-tax")!.addEventListener("click",loadTax);main.querySelectorAll<HTMLSelectElement>("[data-tax-investment]").forEach(select=>select.addEventListener("change",async()=>{try{await invoke("set_investment_tax_treatment",{accountId:Number(select.dataset.taxInvestment),treatment:select.value});toast("Tax treatment saved");await loadTax();}catch(error:any){toast(String(error),true);}}));main.querySelectorAll<HTMLInputElement>("[data-tax-category]").forEach(input=>input.addEventListener("change",async()=>{const category=categories.find(c=>c.id===Number(input.dataset.taxCategory))!;try{await invoke("set_tax_category",{category:category.name,deductionGroup:input.value.trim()||null});toast("Deduction mapping saved");await loadTax();}catch(error:any){toast(String(error),true);}}));main.querySelector("#export-tax")!.addEventListener("click",async()=>{const rows=[["type","currency","date","account","tax_treatment_or_group","security","term","proceeds","basis","gain_or_amount"],...tax.gains.map(g=>["capital_gain",currency,g.sold_on,g.investment_account_name,g.treatment,g.security_symbol,g.term,(g.proceeds_cents/100).toFixed(2),(g.cost_basis_cents/100).toFixed(2),(g.gain_cents/100).toFixed(2)]),...tax.dividends.map(v=>["dividend",currency,"","",v.treatment,"","","","",(v.amount_cents/100).toFixed(2)]),...tax.deductions.map(v=>["deduction",currency,"","",v.group,"","","","",(v.amount_cents/100).toFixed(2)])];const csv=rows.map(row=>row.map(value=>`"${String(value).replaceAll('"','""')}"`).join(",")).join("\n");try{const path=await save({filters:[{name:"CSV",extensions:["csv"]}],defaultPath:`tax-summary-${tax.tax_year}.csv`});if(path){await writeTextFile(path,csv);toast("Tax summary exported");}}catch(error:any){toast(String(error),true);}});
}

async function renderSettings(main:HTMLElement){
  let settings:FxSettings={reporting_currency:currency,default_source:fxDefaultSource};
  let manualRates:ManualFxRate[]=[];
  try{ [settings,manualRates]=await Promise.all([invoke<FxSettings>("get_fx_settings"),invoke<ManualFxRate[]>("list_manual_fx_rates")]); }catch(error:any){ toast(String(error),true); }
  if(view!=="settings") return;
  main.innerHTML=`
    <div class="page-head settings-head"><div><span class="eyebrow">Preferences</span><h2>Settings</h2><p>Control interface scale, reporting currency, rate policy, and your completely local data file.</p></div></div>
    <section class="settings-hero card"><div><span class="eyebrow">Reporting currency</span><h3>${esc(settings.reporting_currency)}</h3><p>Reports and converted transaction snapshots are expressed in this currency. Account balances remain in their native currencies.</p></div><div class="settings-hero-meta"><span>Default rate source</span><strong>${settings.default_source==="frankfurter"?"Frankfurter cache":"Manual rates"}</strong></div></section>
    <div class="settings-layout">
      <section class="card settings-card settings-currency-card"><div class="settings-card-head"><div><span class="settings-icon">◎</span><div><h3>Currency & reporting</h3><p>Choose the app-wide currency used for reports and conversions.</p></div></div></div><div class="field"><label>Reporting currency</label><select id="settings-currency">${currencyOptions(settings.reporting_currency)}</select></div><div class="settings-inline-note">Reporting currency can change only before financial data is recorded. To use another reporting currency afterwards, create a new database.</div><button class="btn btn-primary" id="save-currency">Save reporting currency</button></section>
      <section class="card settings-card"><div class="settings-card-head"><div><span class="settings-icon">↔</span><div><h3>Rate policy</h3><p>Choose the default shown on every conversion form.</p></div></div></div><div class="field"><label>Default rate source</label><select id="settings-rate-source"><option value="frankfurter" ${settings.default_source==="frankfurter"?"selected":""}>Frankfurter — fetch and cache</option><option value="manual" ${settings.default_source==="manual"?"selected":""}>Manual — use your saved rates</option></select></div><div class="settings-inline-note">Frankfurter is contacted only when you request a quote. Latest quotes stay in the SQLite cache for one hour; historical quotes are retained.</div><button class="btn btn-primary" id="save-rate-source">Save rate policy</button></section>
      <section class="card settings-card settings-scale-card settings-db-card"><div class="settings-card-head"><div><span class="settings-icon">Aa</span><div><h3>Interface scale</h3><p>Make the entire interface easier to read on HiDPI displays.</p></div></div></div><div class="interface-scale-row"><div><strong>Scale</strong><span>Ctrl/Cmd +/− to adjust · Ctrl/Cmd 0 to reset</span></div><div class="interface-scale-control" role="group" aria-label="Interface scale"><button class="btn btn-scale" id="interface-scale-decrease" aria-label="Decrease interface scale" title="Decrease interface scale">−</button><output id="interface-scale-value" aria-live="polite">${Math.round(interfaceScale*100)}%</output><button class="btn btn-scale" id="interface-scale-increase" aria-label="Increase interface scale" title="Increase interface scale">+</button><button class="btn" id="interface-scale-reset">Reset</button></div></div><div class="settings-inline-note">Saved on this device and restored whenever Finance Tracker starts.</div></section>
      <section class="card settings-card settings-db-card"><div class="settings-card-head"><div><span class="settings-icon">▣</span><div><h3>Database location</h3><p>Your entire ledger and FX cache live in one local SQLite file.</p></div></div></div><div class="field"><label>Database path</label><div class="settings-path-row"><input id="db-path" class="input" value="${esc(dbPath)}"/><button class="btn" id="browse-db">Browse</button></div></div><div class="settings-actions"><button class="btn btn-primary" id="save-db">Save location</button><button class="btn" id="reveal-db">Reveal file</button></div></section>
    </div>
    <section class="card settings-rates-card"><div class="settings-card-head"><div><span class="settings-icon">⌁</span><div><h3>Manual exchange rates</h3><p>Manual rates take precedence for the matching pair and effective date.</p></div></div><span class="pill">${manualRates.length} saved</span></div><div class="manual-rate-form"><div class="field"><label>From</label><select id="manual-base">${currencyOptions(settings.reporting_currency)}</select></div><div class="field"><label>To</label><select id="manual-quote">${currencyOptions("USD")}</select></div><div class="field"><label>Effective on</label><input id="manual-date" class="input" type="date" value="${todayISO()}"/></div><div class="field"><label>1 from =</label><input id="manual-rate" class="input" inputmode="decimal" placeholder="e.g. 1.0842"/></div><button class="btn btn-primary" id="save-manual-rate">Save rate</button></div><div class="settings-rate-result small muted" id="rate-lookup-result">Use a saved rate offline, or look up a Frankfurter rate directly from a transaction.</div><div class="table-wrap settings-rate-table"><table><thead><tr><th>Pair</th><th>Effective date</th><th>Rate</th><th>Updated</th><th></th></tr></thead><tbody>${manualRates.map(rate=>`<tr><td><strong>${esc(rate.base_currency)} → ${esc(rate.quote_currency)}</strong></td><td>${esc(rate.effective_on)}</td><td>1 ${esc(rate.base_currency)} = <strong>${esc(rate.rate)} ${esc(rate.quote_currency)}</strong></td><td class="small muted">${esc(rate.updated_at)}</td><td><button class="btn btn-sm" data-delete-rate="${esc(`${rate.base_currency}|${rate.quote_currency}|${rate.effective_on}`)}">Remove</button></td></tr>`).join("")||`<tr><td colspan="5" class="empty">No manual rates yet. Add one for a fully offline conversion workflow.</td></tr>`}</tbody></table></div></section>
  `;
  syncInterfaceScaleControls();
  main.querySelector("#interface-scale-decrease")!.addEventListener("click",()=>void stepInterfaceScale(-1));
  main.querySelector("#interface-scale-increase")!.addEventListener("click",()=>void stepInterfaceScale(1));
  main.querySelector("#interface-scale-reset")!.addEventListener("click",()=>void setInterfaceScale(DEFAULT_INTERFACE_SCALE));
  main.querySelector("#browse-db")!.addEventListener("click", async()=>{ const sel=await open({filters:[{name:"SQLite",extensions:["db","sqlite","sqlite3"]}]}); if(typeof sel==="string") (main.querySelector("#db-path") as HTMLInputElement).value=sel; });
  main.querySelector("#save-db")!.addEventListener("click", async()=>{ const path=(main.querySelector("#db-path") as HTMLInputElement).value.trim(); if(!path){toast("Path cannot be empty",true);return;} try{await invoke("set_db_path",{path});toast("Database location saved");await refreshCore();}catch(error:any){toast(String(error),true);} });
  main.querySelector("#reveal-db")!.addEventListener("click", async()=>{try{const {revealItemInDir}=await import("@tauri-apps/plugin-opener");await revealItemInDir(dbPath);}catch(error:any){toast(String(error),true);}});
  main.querySelector("#save-currency")!.addEventListener("click",async()=>{try{currency=await invoke<string>("set_currency",{currency:(main.querySelector("#settings-currency") as HTMLSelectElement).value});toast("Reporting currency updated");await refreshCore();}catch(error:any){toast(String(error),true);}});
  main.querySelector("#save-rate-source")!.addEventListener("click",async()=>{try{fxDefaultSource=await invoke<"frankfurter"|"manual">("set_fx_default_source",{source:(main.querySelector("#settings-rate-source") as HTMLSelectElement).value});toast("Rate policy saved");await renderSettings(main);}catch(error:any){toast(String(error),true);}});
  main.querySelector("#save-manual-rate")!.addEventListener("click",async()=>{const baseCurrency=(main.querySelector("#manual-base") as HTMLSelectElement).value,quoteCurrency=(main.querySelector("#manual-quote") as HTMLSelectElement).value,effectiveOn=(main.querySelector("#manual-date") as HTMLInputElement).value,rate=(main.querySelector("#manual-rate") as HTMLInputElement).value.trim();if(!rate){toast("Enter a positive exchange rate",true);return;}try{await invoke("save_manual_fx_rate",{baseCurrency,quoteCurrency,effectiveOn,rate});toast("Manual rate saved");await renderSettings(main);}catch(error:any){toast(String(error),true);}});
  main.querySelectorAll("[data-delete-rate]").forEach(button=>button.addEventListener("click",async()=>{const [baseCurrency,quoteCurrency,effectiveOn]=(button as HTMLElement).dataset.deleteRate!.split("|");try{await invoke("delete_manual_fx_rate",{baseCurrency,quoteCurrency,effectiveOn});toast("Manual rate removed");await renderSettings(main);}catch(error:any){toast(String(error),true);}}));
}

// ---------- Backup & Restore ----------
const BACKUP_CANCELLED_ERROR = "BACKUP_CANCELLED";

function setDataOperationInteractionLock(locked:boolean){
  dataOperationInteractionLocked=locked;
  const shell = document.getElementById("shell");
  if(locked) shell?.setAttribute("inert", "");
  else shell?.removeAttribute("inert");
}

function createDataOperationId(){
  return globalThis.crypto?.randomUUID?.()
    ?? `data-operation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatFileSize(bytes:number){
  if(bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for(let index=1; index<units.length && value>=1024; index++){
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value>=10?1:2)} ${unit}`;
}

function openBackupRestoreModal(){
  if(activeDataOperationId !== null || restoreReloadRequired) return;
  const root = document.getElementById("modal-root");
  if(!root) return;
  root.innerHTML = `
    <div class="modal-backdrop" id="backup-restore-backdrop">
      <div class="modal card backup-modal" role="dialog" aria-modal="true" aria-labelledby="backup-restore-title">
        <div class="modal-head">
          <h3 id="backup-restore-title">Backup &amp; Restore</h3>
          <button class="btn btn-ghost" id="close-backup-restore" type="button" aria-label="Close">✕</button>
        </div>
        <div class="modal-body backup-restore-options">
          <button class="backup-restore-option" id="start-backup" type="button">
            <span class="backup-restore-option-icon">${navIcon("backup")}</span>
            <span><strong>Back up data</strong><small>Create a safe snapshot of the database, receipts, attachments, and settings.</small></span>
          </button>
          <button class="backup-restore-option restore-option" id="start-restore" type="button">
            <span class="backup-restore-option-icon">↺</span>
            <span><strong>Restore from backup</strong><small>Validate a backup folder, then replace existing data after confirmation.</small></span>
          </button>
        </div>
      </div>
    </div>`;
  const close = ()=>{ root.innerHTML=""; };
  root.querySelector("#close-backup-restore")?.addEventListener("click", close);
  root.querySelector("#backup-restore-backdrop")?.addEventListener("click", event=>{
    if(event.target===event.currentTarget) close();
  });
  root.querySelector("#start-backup")?.addEventListener("click", ()=>{
    close();
    void triggerBackupData();
  });
  root.querySelector("#start-restore")?.addEventListener("click", ()=>{
    close();
    void triggerRestoreData();
  });
}

function showRestoreInspectionModal(backupDir:string){
  const root = document.getElementById("modal-root");
  if(!root) return;
  setDataOperationInteractionLock(true);
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal card backup-modal backup-progress-modal" role="dialog" aria-modal="true" aria-labelledby="restore-inspection-title">
        <div class="backup-progress-content">
          <div class="backup-spinner" style="margin-bottom:16px"></div>
          <h3 id="restore-inspection-title">Checking Backup…</h3>
          <p class="muted small">Verifying the SQLite database and inspecting the selected files before showing the restore confirmation.</p>
          <div class="backup-path-preview">${esc(backupDir)}</div>
        </div>
      </div>
    </div>`;
}

function showRestoreConfirmationModal(preview:BackupPreview):Promise<boolean>{
  const root = document.getElementById("modal-root");
  if(!root) return Promise.resolve(false);
  const created = preview.created_at
    ? new Date(preview.created_at).toLocaleString()
    : "Legacy backup (creation time unavailable)";
  root.innerHTML = `
    <div class="modal-backdrop" id="restore-confirm-backdrop">
      <div class="modal card backup-modal" role="alertdialog" aria-modal="true" aria-labelledby="restore-confirm-title" aria-describedby="restore-warning">
        <div class="modal-head">
          <h3 id="restore-confirm-title">Restore This Backup?</h3>
          <button class="btn btn-ghost" id="close-restore-confirm" type="button" aria-label="Close">✕</button>
        </div>
        <div class="modal-body restore-confirm-body">
          <div class="restore-warning" id="restore-warning">
            <strong>Existing data will be overwritten.</strong>
            <span>Your current database and any matching data files will be replaced with the versions from this backup. Do not close the app during restore.</span>
          </div>
          <div class="backup-summary-box">
            <div><strong>Backup:</strong> ${esc(preview.folder_name)}</div>
            <div><strong>Created:</strong> ${esc(created)}</div>
            <div><strong>Reporting currency:</strong> ${esc(preview.reporting_currency)}</div>
            <div><strong>Database schema:</strong> ${preview.schema_version}</div>
            <div><strong>Contents:</strong> ${preview.file_count} files · ${esc(formatFileSize(preview.total_bytes))}</div>
            <div class="backup-path-preview">${esc(preview.backup_dir)}</div>
          </div>
          <label class="restore-acknowledgement">
            <input id="restore-acknowledge" type="checkbox"/>
            <span>I understand that my existing Finance Tracker data will be overwritten.</span>
          </label>
        </div>
        <div class="modal-foot">
          <button class="btn" id="cancel-restore-confirm" type="button">Cancel</button>
          <button class="btn btn-danger" id="confirm-restore" type="button" disabled>Restore and Overwrite</button>
        </div>
      </div>
    </div>`;
  return new Promise(resolve=>{
    let settled=false;
    const finish=(confirmed:boolean)=>{
      if(settled) return;
      settled=true;
      if(!confirmed){
        root.innerHTML="";
        setDataOperationInteractionLock(false);
      }
      resolve(confirmed);
    };
    const checkbox = root.querySelector<HTMLInputElement>("#restore-acknowledge")!;
    const confirm = root.querySelector<HTMLButtonElement>("#confirm-restore")!;
    checkbox.addEventListener("change", ()=>{ confirm.disabled=!checkbox.checked; });
    confirm.addEventListener("click", ()=>finish(true));
    root.querySelector("#close-restore-confirm")?.addEventListener("click", ()=>finish(false));
    root.querySelector("#cancel-restore-confirm")?.addEventListener("click", ()=>finish(false));
    root.querySelector("#restore-confirm-backdrop")?.addEventListener("click", event=>{
      if(event.target===event.currentTarget) finish(false);
    });
    checkbox.focus();
  });
}

function showBackupProgressModal(targetDir: string, operationId:string) {
  const root = document.getElementById("modal-root");
  if (!root) return;

  setDataOperationInteractionLock(true);
  root.innerHTML = `
    <div class="modal-backdrop" id="backdrop-backup-progress">
      <div class="modal card backup-modal backup-progress-modal" role="dialog" aria-modal="true" aria-labelledby="backup-progress-title" aria-describedby="backup-progress-message">
        <div class="backup-progress-content">
        <div class="backup-spinner" style="margin-bottom:16px"></div>
          <h3 id="backup-progress-title">Backing Up Data…</h3>
          <p class="muted small" id="backup-progress-message">
          Flushing database changes and copying entire application data folder (database, receipts & attachments).<br/>
            You can cancel safely if you need to leave.
        </p>
        <div class="backup-path-preview">${esc(targetDir)}</div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="btn-cancel-backup" type="button">Cancel Backup</button>
        </div>
      </div>
    </div>
  `;

  const cancelButton = root.querySelector<HTMLButtonElement>("#btn-cancel-backup");
  cancelButton?.focus();
  cancelButton?.addEventListener("click", async()=>{
    if(dataOperationCancellationPending || activeDataOperationId !== operationId) return;
    dataOperationCancellationPending = true;
    cancelButton.disabled = true;
    cancelButton.textContent = "Cancelling…";
    const title = root.querySelector<HTMLElement>("#backup-progress-title");
    const message = root.querySelector<HTMLElement>("#backup-progress-message");
    if(title) title.textContent = "Cancelling Backup…";
    if(message) message.textContent = "Removing the incomplete staging copy. Your live data remains unchanged.";
    try{
      const accepted = await invoke<boolean>("cancel_data_operation", { operationId });
      if(!accepted && activeDataOperationId === operationId){
        cancelButton.textContent = "Finishing…";
        if(message) message.textContent = "The backup has already reached its final step. Please wait a moment.";
      }
    }catch(error:any){
      dataOperationCancellationPending = false;
      cancelButton.disabled = false;
      cancelButton.textContent = "Cancel Backup";
      toast(`Unable to request cancellation: ${String(error)}`, true);
    }
  });
}

async function triggerBackupData(){
  if(activeDataOperationId !== null) return;
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Destination Directory for Data Backup",
    });

    if(!selected || typeof selected !== "string"){
      return;
    }

    const operationId = createDataOperationId();
    activeDataOperationId = operationId;
    dataOperationCancellationPending = false;
    showBackupProgressModal(selected, operationId);
    const result = await invoke<BackupResult>("backup_data", {
      destinationDir: selected,
      operationId,
    });
    toast(`Backup created successfully: ${result.folder_name}`);
    showBackupSuccessModal(result);
  } catch (error: any) {
    const root = document.getElementById("modal-root");
    if (root) root.innerHTML = "";
    setDataOperationInteractionLock(false);
    const message = String(error);
    if(message.startsWith(BACKUP_CANCELLED_ERROR)){
      toast("Backup cancelled safely. No incomplete backup was kept.");
    }else{
      toast(`Backup failed: ${message}`, true);
    }
  } finally {
    activeDataOperationId = null;
    dataOperationCancellationPending = false;
  }
}

function showRestoreProgressModal(backupDir:string, operationId:string){
  const root = document.getElementById("modal-root");
  if(!root) return;
  setDataOperationInteractionLock(true);
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal card backup-modal backup-progress-modal" role="dialog" aria-modal="true" aria-labelledby="restore-progress-title" aria-describedby="restore-progress-message">
        <div class="backup-progress-content">
          <div class="backup-spinner" style="margin-bottom:16px"></div>
          <h3 id="restore-progress-title">Preparing Restore…</h3>
          <p class="muted small" id="restore-progress-message">Copying and validating the backup in a staging area. Your current data has not been changed yet.</p>
          <div class="backup-path-preview">${esc(backupDir)}</div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="cancel-restore" type="button">Cancel Restore</button>
        </div>
      </div>
    </div>`;

  const cancelButton = root.querySelector<HTMLButtonElement>("#cancel-restore");
  cancelButton?.focus();
  cancelButton?.addEventListener("click", async()=>{
    if(dataOperationCancellationPending || activeDataOperationId!==operationId) return;
    dataOperationCancellationPending=true;
    cancelButton.disabled=true;
    cancelButton.textContent="Cancelling…";
    const title=root.querySelector<HTMLElement>("#restore-progress-title");
    const message=root.querySelector<HTMLElement>("#restore-progress-message");
    if(title) title.textContent="Cancelling Restore…";
    if(message) message.textContent="Removing staged files. Your existing data remains unchanged.";
    try{
      const accepted=await invoke<boolean>("cancel_data_operation",{operationId});
      if(!accepted && activeDataOperationId===operationId){
        cancelButton.textContent="Applying…";
        if(title) title.textContent="Applying Restored Data…";
        if(message) message.textContent="The final replacement has begun and cannot be interrupted safely. If anything fails, the original files will be rolled back automatically.";
      }
    }catch(error:any){
      dataOperationCancellationPending=false;
      cancelButton.disabled=false;
      cancelButton.textContent="Cancel Restore";
      toast(`Unable to request cancellation: ${String(error)}`,true);
    }
  });
}

async function triggerRestoreData(){
  if(activeDataOperationId!==null || restoreReloadRequired) return;
  let operationStarted=false;
  try{
    const selected=await open({
      directory:true,
      multiple:false,
      title:"Select a Finance Tracker Backup Folder",
    });
    if(!selected || typeof selected!=="string") return;

    showRestoreInspectionModal(selected);
    const preview=await invoke<BackupPreview>("inspect_backup",{backupDir:selected});
    const confirmed=await showRestoreConfirmationModal(preview);
    if(!confirmed) return;

    const operationId=createDataOperationId();
    activeDataOperationId=operationId;
    dataOperationCancellationPending=false;
    operationStarted=true;
    showRestoreProgressModal(preview.backup_dir,operationId);
    const result=await invoke<RestoreResult>("restore_data",{
      backupDir:preview.backup_dir,
      operationId,
      confirmOverwrite:true,
    });
    restoreReloadRequired=true;
    showRestoreSuccessModal(result);
  }catch(error:any){
    const root=document.getElementById("modal-root");
    if(root) root.innerHTML="";
    setDataOperationInteractionLock(false);
    const message=String(error);
    if(message.startsWith(BACKUP_CANCELLED_ERROR)){
      toast("Restore cancelled safely. Your existing data was not changed.");
    }else{
      toast(`Restore failed: ${message}`,true);
    }
  }finally{
    if(operationStarted){
      activeDataOperationId=null;
      dataOperationCancellationPending=false;
    }
  }
}

function showRestoreSuccessModal(result:RestoreResult){
  const root=document.getElementById("modal-root");
  if(!root) return;
  setDataOperationInteractionLock(true);
  const warningHtml=result.warnings.length
    ? `<div class="restore-cleanup-warning"><strong>Restore completed with cleanup warnings:</strong>${result.warnings.map(warning=>`<span>${esc(warning)}</span>`).join("")}</div>`
    : "";
  root.innerHTML=`
    <div class="modal-backdrop">
      <div class="modal card backup-modal" role="dialog" aria-modal="true" aria-labelledby="restore-success-title">
        <div class="modal-head">
          <h3 id="restore-success-title" style="color:var(--success)">Data Restored Successfully</h3>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
          <p>${result.restored_files_count} backed-up files were restored. Reload Finance Tracker now to display the restored data.</p>
          <div class="backup-path-preview">${esc(result.backup_dir)}</div>
          ${warningHtml}
        </div>
        <div class="modal-foot">
          <button class="btn btn-primary" id="reload-after-restore" type="button">Reload Finance Tracker</button>
        </div>
      </div>
    </div>`;
  root.querySelector<HTMLButtonElement>("#reload-after-restore")?.addEventListener("click",()=>{
    window.location.reload();
  });
  root.querySelector<HTMLButtonElement>("#reload-after-restore")?.focus();
}

function showBackupSuccessModal(result: BackupResult) {
  const root = document.getElementById("modal-root");
  if (!root) return;

  const fileListHtml = result.copied_files.length
    ? result.copied_files.map(f => `<div>📄 ${esc(f)}</div>`).join("")
    : `<div class="muted">No individual files found to display.</div>`;

  root.innerHTML = `
    <div class="modal-backdrop" id="backdrop-backup">
      <div class="modal card backup-modal">
        <div class="modal-head">
          <h3 style="display:flex;align-items:center;gap:8px;color:var(--success)">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
            Data Backup Successful
          </h3>
          <button class="btn btn-ghost" id="close-backup-modal">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
          <p>All application data, including your SQLite database and attachments/receipts, has been safely backed up.</p>
          <div class="backup-summary-box">
            <div style="font-size:12px;color:var(--text-2);margin-bottom:4px"><strong>Backup Folder:</strong> ${esc(result.folder_name)}</div>
            <div style="font-size:12px;color:var(--text-2);margin-bottom:4px"><strong>Total Files Saved:</strong> ${result.copied_files_count}</div>
            <div style="font-size:12px;color:var(--text-2);margin-bottom:4px"><strong>Destination:</strong></div>
            <div class="backup-path-preview">${esc(result.target_dir)}</div>
          </div>
          <div>
            <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text)">Backed Up Contents:</div>
            <div class="backup-file-list">
              ${fileListHtml}
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="btn-reveal-backup">Show in Folder</button>
          <button class="btn btn-primary" id="btn-done-backup">Done</button>
        </div>
      </div>
    </div>
  `;

  const close = () => {
    root.innerHTML = "";
    setDataOperationInteractionLock(false);
  };
  root.querySelector("#close-backup-modal")?.addEventListener("click", close);
  root.querySelector("#btn-done-backup")?.addEventListener("click", close);
  root.querySelector("#backdrop-backup")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) close();
  });
  root.querySelector("#btn-reveal-backup")?.addEventListener("click", async () => {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(result.target_dir);
    } catch (e: any) {
      toast(String(e), true);
    }
  });
}

// ---------- Boot ----------
document.addEventListener("keydown",event=>{
  if(!(event.metaKey||event.ctrlKey)||event.altKey) return;
  if(event.key==="+"||event.key==="="){
    event.preventDefault();
    void stepInterfaceScale(1);
  }else if(event.key==="-"){
    event.preventDefault();
    void stepInterfaceScale(-1);
  }else if(event.key==="0"){
    event.preventDefault();
    void setInterfaceScale(DEFAULT_INTERFACE_SCALE);
  }
},{capture:true});

void (async()=>{
  initNavigationShortcuts();
  await setInterfaceScale(interfaceScale,false);
  await refreshCore();
})();
