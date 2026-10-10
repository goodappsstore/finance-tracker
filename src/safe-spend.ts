import { invoke } from '@tauri-apps/api/core';
import type { Account, SafeSpendSettings, SafeSpendSnapshot } from './types';

type Context = {
  accounts: Account[];
  currency: string;
  format: (amount:number)=>string;
  escape: (value:string)=>string;
};

const renderVersions=new WeakMap<HTMLElement,number>();

/** Independent panel shared by the dashboard and budgets, with no global view state. */
export async function mountSafeSpend(host:HTMLElement, context:Context) {
  const version=(renderVersions.get(host)??0)+1;
  renderVersions.set(host,version);
  const {accounts,currency,format,escape:esc}=context;
  let snapshot:SafeSpendSnapshot|null=null;
  let settings:SafeSpendSettings|null=null;
  let error='';
  try {
    settings=await invoke<SafeSpendSettings>('get_safe_spend_settings');
    snapshot=await invoke<SafeSpendSnapshot>('get_safe_to_spend');
  } catch(e) { error=String(e); }
  if(!host.isConnected||renderVersions.get(host)!==version) return;
  const s=snapshot;
  const breakdown=s ? [
    ['Spendable account balances',s.cash_cents],
    ['Upcoming and overdue payments',-s.scheduled_cents],
    ['Remaining category reserves',-s.budget_reserve_cents],
    ['Existing credit-card debt',-s.credit_reserve_cents],
    ['Protected goals and additional savings',-s.protected_cents],
    ['Emergency buffer',-s.buffer_cents],
  ] as const : [];
  host.innerHTML=`<section class="card safe-spend-panel" aria-label="Safe to spend">
    <div class="safe-spend-head"><div><div class="dashboard-eyebrow">Safe to spend · ${esc(currency)}</div>
      ${s?`<div class="safe-spend-amount ${s.shortfall_cents?'amount-neg':''}">${format(s.safe_cents)}</div>
      <p>Additional spending before ${esc(s.payday)} · ${s.days} days · ${esc(s.horizon_source)}</p>`:`<h3>Set up your spending guidance</h3>`}
    </div><button type="button" class="btn btn-sm" data-safe-refresh>Refresh</button></div>
    ${error?`<p class="safe-spend-warning" role="status">${esc(error)}</p>`:''}
    ${s?`<div class="safe-spend-summary">${s.shortfall_cents?`<strong class="amount-neg">${format(s.shortfall_cents)} funding shortfall</strong><span>Your recorded cash does not cover these reserves.</span>`:`<strong>${format(s.daily_cents)} per day</strong><span>Beyond the money reserved for bills, budgets and savings.</span>`}</div>
      <details class="safe-spend-details"><summary>How this is calculated</summary>
        <dl class="safe-spend-breakdown">${breakdown.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${format(value)}</dd></div>`).join('')}</dl>
        <p class="small muted">This is a conservative estimate of extra, unbudgeted spending. Full remaining category budgets for each month before payday are protected; scheduled expenses use that reserve first. Rollover is counted once. Income expected in the future is excluded.</p>
        <p class="small muted">All active credit-card debt is reserved, even if due after payday. Card repayments are not deducted again. Savings accounts are excluded unless selected. Goals protect selected-account savings; the additional savings amount and emergency buffer are extra reserves.</p>
        <p class="small muted">Only recorded bills and spending are known. Add your upcoming loan payments and other obligations to Recurring or Planning. Separate manual plans and recurring rules are treated as separate obligations.</p>
        <div class="small muted">Calculated ${esc(s.calculated_at)} · Latest ledger date ${esc(s.latest_transaction_on??'none')} · No live bank refresh</div>
        ${s.commitments.length?`<div class="table-wrap"><table><thead><tr><th>Due</th><th>Payment</th><th>Reserve</th></tr></thead><tbody>${s.commitments.map(c=>`<tr><td>${esc(c.date)}${c.date<s.as_of?' · overdue':''}</td><td>${esc(c.title)}</td><td>${format(c.amount_cents)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="small muted">No scheduled payments in this window.</p>'}
      </details>
      ${s.warnings.length?`<ul class="safe-spend-warnings">${s.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`:''}`:''}
    ${settings?`<details class="safe-spend-details" ${!s||!settings.configured?'open':''}><summary>Spending settings</summary>
      <form data-safe-form>
        <div class="safe-spend-fields">
          <label class="field">Next payday (optional)<input class="input" type="date" name="payday" value="${esc(settings.payday??'')}"/><span class="small muted">Leave empty to use your next recurring income, or a 30-day fallback.</span></label>
          <label class="field">Emergency buffer (${esc(currency)})<input class="input" name="buffer" inputmode="decimal" required value="${(settings.buffer_cents/100).toFixed(2)}"/></label>
          <label class="field">Additional protected savings (${esc(currency)})<input class="input" name="protected" inputmode="decimal" required value="${(settings.protected_cents/100).toFixed(2)}"/><span class="small muted">Extra money to keep aside beyond goals and category budgets.</span></label>
        </div>
        <fieldset class="safe-spend-accounts"><legend>Spendable accounts</legend>${accounts.filter(a=>a.kind!=='credit'&&!a.archived).map(a=>`<label><input type="checkbox" name="account" value="${a.id}" ${settings!.account_ids.includes(a.id)?'checked':''}/><span>${esc(a.name)} <small class="muted">${esc(a.currency_code)} · ${esc(a.kind)}</small></span></label>`).join('')}</fieldset>
        <p data-safe-error class="amount-neg small" role="status"></p>
        <button class="btn btn-primary" type="submit">Save and recalculate</button>
      </form>
    </details>`:''}
  </section>`;
  host.querySelector('[data-safe-refresh]')?.addEventListener('click',()=>{void mountSafeSpend(host,context);});
  host.querySelector<HTMLFormElement>('[data-safe-form]')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget as HTMLFormElement;
    const data=new FormData(form);
    const button=form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const error=form.querySelector<HTMLElement>('[data-safe-error]')!;
    button.disabled=true;
    error.textContent='';
    try {
      await invoke('save_safe_spend_settings',{req:{payday:String(data.get('payday')??'')||null,
        buffer:String(data.get('buffer')),protected:String(data.get('protected')),account_ids:data.getAll('account').map(Number)}});
      await mountSafeSpend(host,context);
    } catch(e) { error.textContent=String(e);button.disabled=false; }
  });
}
