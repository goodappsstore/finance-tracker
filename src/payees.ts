import { invoke } from "@tauri-apps/api/core";
import type { PayeeBreakdown, PayeeSnapshot, PayeeSummary } from "./types";

type Context = {
  selected:string|null;
  currency:string;
  format:(cents:number,currency?:string)=>string;
  escape:(value:unknown)=>string;
  select:(name:string)=>void;
  openLedger:(name:string)=>void;
};

function breakdown(rows:PayeeBreakdown[], format:Context["format"], escape:Context["escape"]){
  const max=Math.max(1,...rows.map(row=>row.spent_cents));
  return rows.length?rows.map(row=>`<div class="payee-breakdown-row"><div><strong>${escape(row.label)}</strong><span>${format(row.spent_cents)} · ${row.transaction_count} transaction${row.transaction_count===1?"":"s"}</span></div><div class="progress"><div class="progress-fill ok" style="width:${Math.max(3,Math.round(row.spent_cents/max*100))}%"></div></div></div>`).join(""):
    `<p class="small muted">No expenses in the past year.</p>`;
}

function detail(snapshot:PayeeSnapshot, context:Context){
  const {format,escape:esc}=context;
  const max=Math.max(1,...snapshot.monthly.map(month=>month.spent_cents));
  const change=snapshot.previous_spend_cents>0
    ?(snapshot.recent_spend_cents/snapshot.previous_spend_cents-1)*100:null;
  const price=snapshot.price_creep_percent;
  const priceLabel=price===null?"Not enough data":`${price>=0?"+":""}${price.toFixed(1)}%`;
  return `<div class="payee-detail">
    <div class="payee-detail-head"><div><span class="eyebrow">Payee deep-dive</span><h2>${esc(snapshot.name)}</h2><p class="small muted">${snapshot.transaction_count} recorded transactions · ${esc(snapshot.first_transaction_on)} to ${esc(snapshot.last_transaction_on)} · ${esc(context.currency)} reporting amounts</p></div><button class="btn btn-primary btn-sm" data-payee-ledger="${esc(snapshot.name)}">Search ledger →</button></div>
    <div class="stat-grid payee-stats">
      <div class="card stat stat-negative"><div class="label">Lifetime spending</div><div class="value text-negative">${format(snapshot.lifetime_spend_cents)}</div><div class="sub">${snapshot.expense_count} expenses</div></div>
      ${snapshot.income_count?`<div class="card stat stat-positive"><div class="label">Lifetime income</div><div class="value text-positive">${format(snapshot.lifetime_income_cents)}</div><div class="sub">${snapshot.income_count} income transactions</div></div>`:""}
      <div class="card stat stat-neutral"><div class="label">Past 90 days</div><div class="value">${format(snapshot.recent_spend_cents)}</div><div class="sub">${snapshot.recent_count} expenses</div></div>
      <div class="card stat stat-neutral"><div class="label">Previous 90 days</div><div class="value">${format(snapshot.previous_spend_cents)}</div><div class="sub">${snapshot.previous_count} expenses</div></div>
      <div class="card stat ${change!==null&&change>0?"stat-warning":"stat-positive"}"><div class="label">Spending change</div><div class="value">${change===null?"—":`${change>=0?"+":""}${change.toFixed(1)}%`}</div><div class="sub">Last 90 days vs previous 90</div></div>
    </div>
    <div class="grid2"><section class="card"><div class="card-title">Monthly spend trend</div><p class="small muted">Past 12 calendar months, including this month</p><div class="payee-chart">${snapshot.monthly.map(month=>`<div class="payee-chart-column" title="${esc(month.month)}: ${format(month.spent_cents)} across ${month.transaction_count} expenses"><span class="payee-chart-value">${month.spent_cents?format(month.spent_cents):""}</span><div class="payee-chart-track"><div style="height:${month.spent_cents?Math.max(3,Math.round(month.spent_cents/max*100)):0}%"></div></div><span>${esc(month.month.slice(5))}</span></div>`).join("")}</div><div class="small muted">Amounts use the reporting-currency snapshot saved with each transaction.</div></section>
    <section class="card"><div class="card-title">Price creep watch</div><p class="small muted">Median expense transaction, last 90 days vs previous 90 days</p><div class="payee-creep-value ${price!==null&&price>0?"amount-neg":""}">${priceLabel}</div><div class="payee-creep-comparison"><div><span>Recent typical charge</span><strong>${snapshot.recent_median_cents===null?"—":format(snapshot.recent_median_cents)}</strong></div><div><span>Previous typical charge</span><strong>${snapshot.previous_median_cents===null?"—":format(snapshot.previous_median_cents)}</strong></div></div><p class="small muted">Shown only with at least 3 expenses in each window. Transaction size can change with basket size or quantity, so this is a price-creep signal rather than a measured unit-price change.</p></section></div>
    <div class="grid2"><section class="card"><div class="card-title">Top categories</div><p class="small muted">Past 365 days · split allocations included</p>${breakdown(snapshot.categories,format,esc)}</section><section class="card"><div class="card-title">Accounts used</div><p class="small muted">Past 365 days</p>${breakdown(snapshot.accounts,format,esc)}</section></div>
    <section class="card payee-activity"><div class="card-head-row"><div><div class="card-title">Recent activity</div><p class="small muted">Latest 12 income and expense transactions</p></div><button class="btn btn-sm" data-payee-ledger="${esc(snapshot.name)}">Search ledger →</button></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Account</th><th>Category</th><th>Amount</th></tr></thead><tbody>${snapshot.recent_activity.map(row=>`<tr><td>${esc(row.txn_date)}</td><td><span class="badge badge-${row.kind}">${row.kind}</span></td><td>${esc(row.account_name)}</td><td>${esc(row.category_name??"—")}</td><td class="${row.kind==="expense"?"amount-neg":"amount-pos"}">${row.kind==="expense"?"−":"+"}${format(row.amount_cents)}</td></tr>`).join("")}</tbody></table></div></section>
  </div>`;
}

export async function renderPayees(main:HTMLElement, context:Context){
  main.innerHTML=`<div class="page-head"><h2>Payees</h2><p>Explore spending by merchant or income source.</p></div><div class="card empty">Loading payees…</div>`;
  const [listResult,snapshotResult]=await Promise.allSettled([
    invoke<PayeeSummary[]>("list_payees"),
    context.selected?invoke<PayeeSnapshot>("get_payee_snapshot",{payee:context.selected}):Promise.resolve(null),
  ]);
  if(!main.isConnected || main.dataset.view!=="payees") return;
  if(listResult.status!=="fulfilled"){
    main.innerHTML=`<div class="card empty">Could not load payees: ${context.escape(String(listResult.reason))}</div>`;
    return;
  }
  const payees=listResult.value;
  const snapshot=snapshotResult.status==="fulfilled"?snapshotResult.value:null;
  main.innerHTML=`<div class="page-head"><h2>Payees</h2><p>Explore spend trend, typical charge, categories, accounts, and recent activity.</p></div>
    <div class="payee-layout"><aside class="card payee-directory"><label class="field">Find a payee<input class="input" type="search" data-payee-search placeholder="Search names"/></label><div class="payee-directory-list">${payees.map(payee=>`<button type="button" class="payee-directory-item ${context.selected?.toLowerCase()===payee.name.toLowerCase()?"selected":""}" data-select-payee="${context.escape(payee.name)}"><strong>${context.escape(payee.name)}</strong><span>${context.format(payee.lifetime_spend_cents)} spent · ${payee.transaction_count} transactions</span></button>`).join("")||`<p class="small muted">No named payees yet.</p>`}</div></aside>
    <div class="payee-detail-root">${snapshot?detail(snapshot,context):context.selected?`<div class="card empty">Could not load ${context.escape(context.selected)}: ${context.escape(snapshotResult.status==="rejected"?String(snapshotResult.reason):"Payee not found")}</div>`:`<div class="card empty">Select a payee to view their financial history.</div>`}</div></div>`;
  main.querySelectorAll<HTMLElement>("[data-select-payee]").forEach(button=>button.addEventListener("click",()=>context.select(button.dataset.selectPayee!)));
  main.querySelectorAll<HTMLElement>("[data-payee-ledger]").forEach(button=>button.addEventListener("click",()=>context.openLedger(button.dataset.payeeLedger!)));
  main.querySelector<HTMLInputElement>("[data-payee-search]")?.addEventListener("input",event=>{
    const term=(event.target as HTMLInputElement).value.trim().toLocaleLowerCase();
    main.querySelectorAll<HTMLElement>("[data-select-payee]").forEach(button=>{button.hidden=!button.dataset.selectPayee?.toLocaleLowerCase().includes(term);});
  });
}
