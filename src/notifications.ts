import { invoke, isTauri } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { BudgetStatusRecord, ForecastSnapshot, LoanRecord, PlanningItemRecord, RecurringRuleRecord, SafeSpendSettings, SafeSpendSnapshot } from "./types";

type Rule = "recurring" | "budget" | "forecast" | "planned" | "payday" | "safe_spend";
type NotificationEntry = { key:string; rule:Rule; title:string; body:string; sentAt:string };
type RuleOptions = { enabled:boolean; snoozedUntil:string|null };
type NotificationState = {
  enabled:boolean;
  recurringLeadDays:number;
  plannedLeadDays:number;
  forecastLeadDays:number;
  rules:Record<Rule,RuleOptions>;
  log:NotificationEntry[];
  seen:string[];
};
type Candidate = { key:string; rule:Rule; title:string; body:string };

const ruleLabels:Record<Rule,string> = {
  recurring:"Recurring payments & EMIs", budget:"Budget overspending", forecast:"Forecast breaches",
  planned:"Planned transactions", payday:"Passed payday", safe_spend:"Safe-to-spend exhausted",
};
const ruleDescriptions:Record<Rule,string> = {
  recurring:"Upcoming or overdue recurring expenses and loan payments.",
  budget:"A current-month category exceeds its available budget.",
  forecast:"Projected cash balance or a goal floor is breached soon.",
  planned:"A baseline planned transaction is approaching or overdue.",
  payday:"Your manually set payday has passed and spending guidance needs an update.",
  safe_spend:"Your additional safe-to-spend amount reaches zero.",
};
const rules = Object.keys(ruleLabels) as Rule[];
const intervalMs = 15 * 60 * 1000;
let databasePath = "";
let timer:number|undefined;
let running = false;
let checkSoonTimer:number|undefined;

function defaults():NotificationState {
  return {
    enabled:true, recurringLeadDays:3, plannedLeadDays:3, forecastLeadDays:14,
    rules:Object.fromEntries(rules.map(rule=>[rule,{enabled:true,snoozedUntil:null}])) as Record<Rule,RuleOptions>,
    log:[], seen:[],
  };
}

function storageKey(){ return `finance-tracker-notifications-v1:${encodeURIComponent(databasePath)}`; }
function state():NotificationState {
  const fallback=defaults();
  if(!databasePath) return fallback;
  try {
    const value=JSON.parse(localStorage.getItem(storageKey())??"null");
    if(!value || typeof value!=="object") return fallback;
    return {
      ...fallback,
      enabled:typeof value.enabled==="boolean"?value.enabled:fallback.enabled,
      recurringLeadDays:leadDays(value.recurringLeadDays,3),
      plannedLeadDays:leadDays(value.plannedLeadDays,3),
      forecastLeadDays:leadDays(value.forecastLeadDays,14),
      rules:Object.fromEntries(rules.map(rule=>[rule,{
        enabled:typeof value.rules?.[rule]?.enabled==="boolean"?value.rules[rule].enabled:true,
        snoozedUntil:typeof value.rules?.[rule]?.snoozedUntil==="string"?value.rules[rule].snoozedUntil:null,
      }])) as Record<Rule,RuleOptions>,
      log:Array.isArray(value.log)?value.log.filter((entry:NotificationEntry)=>entry && typeof entry.key==="string" && rules.includes(entry.rule)).slice(0,200):[],
      seen:Array.isArray(value.seen)?value.seen.filter((key:unknown)=>typeof key==="string").slice(0,2000):
        Array.isArray(value.log)?value.log.map((entry:NotificationEntry)=>entry.key).filter((key:unknown)=>typeof key==="string"):[],
    };
  } catch { return fallback; }
}
function leadDays(value:unknown, fallback:number){ return Number.isInteger(value) && Number(value)>=0 && Number(value)<=30?Number(value):fallback; }
function save(value:NotificationState){ localStorage.setItem(storageKey(),JSON.stringify(value)); }
function localDate(date=new Date()){
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
function dateAfter(days:number){ const date=new Date();date.setHours(12,0,0,0);date.setDate(date.getDate()+days);return localDate(date); }
function within(date:string, lead:number){ return date<=dateAfter(lead); }
function active(value:NotificationState, rule:Rule){ return value.rules[rule].enabled && (!value.rules[rule].snoozedUntil || value.rules[rule].snoozedUntil!>new Date().toISOString()); }
function candidate(rule:Rule,key:string,title:string,body:string):Candidate { return {rule,key:`${rule}:${key}`,title,body}; }

async function collect(value:NotificationState):Promise<Candidate[]> {
  const today=localDate();
  const requests = await Promise.allSettled([
    active(value,"recurring")?invoke<RecurringRuleRecord[]>("list_recurring"):Promise.resolve([]),
    active(value,"recurring")?invoke<LoanRecord[]>("list_loans"):Promise.resolve([]),
    active(value,"budget")?invoke<BudgetStatusRecord[]>("budget_status",{month:today.slice(0,7),scenario:null}):Promise.resolve([]),
    active(value,"forecast")?invoke<ForecastSnapshot>("get_forecast",{scenario:null,account:null,days:Math.max(value.forecastLeadDays+1,1)}):Promise.resolve(null),
    active(value,"planned")?invoke<PlanningItemRecord[]>("list_planning_items",{scenario:null,from:null,to:null}):Promise.resolve([]),
    active(value,"payday")?invoke<SafeSpendSettings>("get_safe_spend_settings"):Promise.resolve(null),
    active(value,"safe_spend")?invoke<SafeSpendSnapshot>("get_safe_to_spend"):Promise.resolve(null),
  ]);
  const read=<T>(index:number,fallback:T):T=>requests[index].status==="fulfilled"?requests[index].value as T:fallback;
  const recurring=read<RecurringRuleRecord[]>(0,[]);
  const loans=read<LoanRecord[]>(1,[]);
  const budgets=read<BudgetStatusRecord[]>(2,[]);
  const forecast=read<ForecastSnapshot|null>(3,null);
  const plans=read<PlanningItemRecord[]>(4,[]);
  const payday=read<SafeSpendSettings|null>(5,null);
  const safeSpend=read<SafeSpendSnapshot|null>(6,null);
  const out:Candidate[]=[];
  for(const rule of recurring){
    if(rule.paused || rule.kind!=="expense" || !within(rule.next_due_on,value.recurringLeadDays)) continue;
    out.push(candidate("recurring",`${rule.id}:${rule.next_due_on}`,`${rule.name} ${rule.next_due_on<today?"overdue":"due soon"}`,`Due ${rule.next_due_on} · ${rule.account_name}. Review or post this recurring payment.`));
  }
  for(const loan of loans){
    if(!loan.next_due_on || loan.outstanding_cents<=0 || !within(loan.next_due_on,value.recurringLeadDays)) continue;
    const alreadyRecurring=recurring.some(rule=>!rule.paused && rule.kind==="expense" && rule.next_due_on===loan.next_due_on && rule.name.toLowerCase().includes(loan.name.toLowerCase()));
    if(!alreadyRecurring) out.push(candidate("recurring",`loan:${loan.id}:${loan.next_due_on}`,`${loan.name} EMI ${loan.next_due_on<today?"overdue":"due soon"}`,`Loan payment due ${loan.next_due_on}. Review Loans & EMIs.`));
  }
  for(const budget of budgets){
    if(!budget.over_budget) continue;
    out.push(candidate("budget",`${budget.month}:${budget.category_id}:${budget.account_id??"all"}`,`${budget.category_name} budget exceeded`,`Spent beyond available budget this month${budget.account_name?` in ${budget.account_name}`:""}. Review Budgets.`));
  }
  if(forecast){
    const negative=forecast.daily.find(point=>point.closing_balance_cents<0 && within(point.date,value.forecastLeadDays));
    if(negative) out.push(candidate("forecast",`cash:${negative.date}`,"Projected cash balance below zero",`Forecast shows a negative balance on ${negative.date}. Review upcoming cash flow.`));
    for(const goal of forecast.goal_status){
      if(goal.breach_date && within(goal.breach_date,value.forecastLeadDays)) out.push(candidate("forecast",`goal:${goal.id}:${goal.breach_date}`,`${goal.name} target at risk`,`Forecast shows a goal balance breach on ${goal.breach_date}.`));
    }
  }
  for(const plan of plans){
    if(plan.archived || plan.scenario_id!==null || plan.linked_transaction_id!==null || !within(plan.due_on,value.plannedLeadDays)) continue;
    out.push(candidate("planned",`${plan.id}:${plan.due_on}`,`${plan.title} ${plan.due_on<today?"overdue":"coming up"}`,`Planned ${plan.kind} on ${plan.due_on} · ${plan.account_name}. Review or post the item.`));
  }
  if(payday?.payday && payday.payday<today) out.push(candidate("payday",payday.payday,"Payday passed — update safe-to-spend",`Your manual payday was ${payday.payday}. Set the next payday in spending settings.`));
  if(safeSpend && safeSpend.safe_cents<=0 && safeSpend.settings.configured && safeSpend.settings.account_ids.length>0){
    out.push(candidate("safe_spend",safeSpend.payday,"Safe-to-spend is exhausted",`No additional unbudgeted spending is available before ${safeSpend.payday}. Review your reserves.`));
  }
  return out;
}

export function startNotifications(path:string){
  databasePath=path;
  if(!timer){
    timer=window.setInterval(()=>void checkNotifications(),intervalMs);
    window.addEventListener("focus",()=>void checkNotifications());
    document.addEventListener("visibilitychange",()=>{ if(!document.hidden) void checkNotifications(); });
  }
  scheduleNotificationCheck();
}
export function scheduleNotificationCheck(){
  if(checkSoonTimer) window.clearTimeout(checkSoonTimer);
  checkSoonTimer=window.setTimeout(()=>{checkSoonTimer=undefined;void checkNotifications();},1500);
}
export async function checkNotifications(){
  if(!isTauri() || !databasePath || running) return;
  const current=state();
  if(!current.enabled || !rules.some(rule=>active(current,rule))) return;
  running=true;
  const path=databasePath;
  try{
    if(!await isPermissionGranted()) return;
    const candidates=await collect(current);
    if(path!==databasePath) return;
    const latest=state();
    if(!latest.enabled) return;
    const sent=new Set(latest.seen);
    for(const item of candidates.filter(item=>active(latest,item.rule) && !sent.has(item.key)).slice(0,5)){
      sendNotification({title:item.title,body:item.body});
      latest.log.unshift({...item,sentAt:new Date().toISOString()});
      latest.seen.unshift(item.key);
      sent.add(item.key);
    }
    latest.log=latest.log.slice(0,200);
    latest.seen=latest.seen.slice(0,2000);
    save(latest);
  }catch(error){ console.warn("Notification check failed",error); }
  finally{running=false;}
}

export async function renderNotifications(main:HTMLElement, escape:(value:unknown)=>string){
  const current=state();
  let permission=false;
  try{ permission=isTauri() && await isPermissionGranted(); }catch{}
  if(!main.isConnected || main.dataset.view!=="notifications") return;
  main.innerHTML=`
    <div class="page-head"><h2>Notifications</h2><p>Local alerts from your recorded finances. Checked when the app opens and every 15 minutes while it runs.</p></div>
    <section class="card notification-overview">
      <div><h3>Desktop alerts</h3><p class="small muted">${permission?"System permission is granted.":"System permission is needed before alerts can appear."}</p></div>
      <label class="notification-switch"><input type="checkbox" data-notifications-enabled ${current.enabled?"checked":""}/> Enable alerts</label>
      ${!permission?`<button class="btn btn-primary" data-notification-permission>Allow system notifications</button>`:""}
    </section>
    <section class="card notification-rules"><h3>Alert rules</h3><p class="small muted">Each rule can be turned off or snoozed for a day or a week.</p>
      ${rules.map(rule=>`<div class="notification-rule"><div><strong>${escape(ruleLabels[rule])}</strong><p class="small muted">${escape(ruleDescriptions[rule])}</p>${current.rules[rule].snoozedUntil && current.rules[rule].snoozedUntil!>new Date().toISOString()?`<span class="small">Snoozed until ${escape(new Date(current.rules[rule].snoozedUntil!).toLocaleString())}</span>`:""}</div><div class="notification-rule-actions"><label><input type="checkbox" data-rule-enabled="${rule}" ${current.rules[rule].enabled?"checked":""}/> On</label><select aria-label="Snooze ${escape(ruleLabels[rule])}" data-rule-snooze="${rule}"><option value="">Snooze…</option><option value="1">1 day</option><option value="7">1 week</option><option value="clear">Resume now</option></select></div></div>`).join("")}
    </section>
    <section class="card notification-leads"><h3>Advance warning</h3><div class="notification-lead-fields">
      <label>Recurring & EMI <input class="input" type="number" min="0" max="30" data-lead="recurringLeadDays" value="${current.recurringLeadDays}"/> days</label>
      <label>Planned items <input class="input" type="number" min="0" max="30" data-lead="plannedLeadDays" value="${current.plannedLeadDays}"/> days</label>
      <label>Forecast breach <input class="input" type="number" min="0" max="30" data-lead="forecastLeadDays" value="${current.forecastLeadDays}"/> days</label>
    </div><p class="small muted">Overdue items remain eligible until posted, paused, archived, or their due date changes.</p></section>
    <section class="card notification-log"><div class="notification-log-head"><div><h3>Notification log</h3><p class="small muted">Most recent 200 alerts sent on this device for this database.</p></div><div class="notification-log-actions"><button class="btn btn-sm" data-refresh-notification-log>Refresh</button><button class="btn btn-sm" data-clear-notification-log ${current.log.length?"":"disabled"}>Clear log</button></div></div>
      ${current.log.length?`<div class="notification-log-list">${current.log.map(entry=>`<div><span class="small muted">${escape(new Date(entry.sentAt).toLocaleString())} · ${escape(ruleLabels[entry.rule])}</span><strong>${escape(entry.title)}</strong><p class="small">${escape(entry.body)}</p></div>`).join("")}</div>`:`<p class="empty">No alerts sent yet.</p>`}
    </section>`;
  main.querySelector<HTMLInputElement>("[data-notifications-enabled]")?.addEventListener("change",event=>{
    const next=state();next.enabled=(event.target as HTMLInputElement).checked;save(next);if(next.enabled) scheduleNotificationCheck();
  });
  main.querySelector("[data-notification-permission]")?.addEventListener("click",async()=>{
    try{const result=await requestPermission();if(result!=="granted") throw new Error("System notification permission was not granted");scheduleNotificationCheck();await renderNotifications(main,escape);}catch(error){alert(String(error));}
  });
  main.querySelectorAll<HTMLInputElement>("[data-rule-enabled]").forEach(input=>input.addEventListener("change",()=>{
    const next=state();next.rules[input.dataset.ruleEnabled as Rule].enabled=input.checked;save(next);scheduleNotificationCheck();
  }));
  main.querySelectorAll<HTMLSelectElement>("[data-rule-snooze]").forEach(select=>select.addEventListener("change",()=>{
    const next=state();const rule=next.rules[select.dataset.ruleSnooze as Rule];
    rule.snoozedUntil=select.value==="clear"?null:new Date(Date.now()+Number(select.value)*86400000).toISOString();
    save(next);void renderNotifications(main,escape);scheduleNotificationCheck();
  }));
  main.querySelectorAll<HTMLInputElement>("[data-lead]").forEach(input=>input.addEventListener("change",()=>{
    const value=Number(input.value);if(!Number.isInteger(value)||value<0||value>30){input.value=String(state()[input.dataset.lead as "recurringLeadDays"]);return;}
    const next=state();next[input.dataset.lead as "recurringLeadDays"|"plannedLeadDays"|"forecastLeadDays"]=value;save(next);scheduleNotificationCheck();
  }));
  main.querySelector("[data-clear-notification-log]")?.addEventListener("click",()=>{const next=state();next.log=[];save(next);void renderNotifications(main,escape);});
  main.querySelector("[data-refresh-notification-log]")?.addEventListener("click",()=>void renderNotifications(main,escape));
}
