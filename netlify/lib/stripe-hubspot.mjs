import crypto from 'node:crypto';

/* Stripe -> HubSpot billing sync for TaxRock Pro.
 *
 * One direction only: Stripe is the source of truth, HubSpot shows a copy.
 * This file only ever READS from Stripe (GET requests, with a restricted read-only key), so it
 * cannot charge, email or change anything for a customer. It WRITES to HubSpot company records:
 * the "Stripe billing" fields, plus a timeline note for the few billing events a rep should see.
 *
 * How a Stripe customer is matched to a HubSpot company: the company field tr_stripe_customer_id
 * holds the Stripe customer id (cus_...). No match, no write.
 *
 * TaxRock billing rules this encodes (agreed Nov 2026):
 *   - A customer has ONE flat-fee subscription. That is the Monthly amount (recurring only).
 *   - Implementation fees are one-time lines, billed separately, and never count toward Monthly amount.
 *   - The old per-taxpayer subscription is a $0 metered placeholder. It is ignored. A customer with only
 *     that placeholder is on legacy pricing, billed by a manual monthly invoice.
 *
 * Netlify environment variables:
 *   STRIPE_SYNC_KEY        restricted Stripe key, read-only (rk_live_... or rk_test_...). A full secret key is refused.
 *   STRIPE_WEBHOOK_SECRET  signing secret of the Stripe webhook endpoint (whsec_...)
 *   HUBSPOT_TOKEN          HubSpot private app token (companies read/write, notes write)
 *   SYNC_SECRET            any long random string; lets the nightly job start the full recheck
 */

const STRIPE = 'https://api.stripe.com/v1/';
const HUBSPOT = 'https://api.hubapi.com';
const DAY = 86400;

/* ---------- Stripe (read only) ---------- */

export function stripeKey() {
  const k = String(process.env.STRIPE_SYNC_KEY || '').trim();
  if (!k) throw new Error('STRIPE_SYNC_KEY is not set in Netlify.');
  if (!/^rk_(live|test)_/.test(k)) throw new Error('STRIPE_SYNC_KEY must be a restricted, read-only Stripe key (rk_live_ or rk_test_). A full secret key is refused on purpose.');
  return k;
}
export const stripeMode = () => (/^rk_test_/.test(stripeKey()) ? 'test' : 'live');

function query(params) {
  const u = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) v.forEach(x => u.append(k + '[]', String(x)));
    else u.append(k, String(v));
  });
  const s = u.toString();
  return s ? '?' + s : '';
}

// GET is the only verb this file uses against Stripe
export async function stripeGet(path, params) {
  const r = await fetch(STRIPE + path + query(params), { method: 'GET', headers: { Authorization: 'Bearer ' + stripeKey() } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Stripe ' + path + ': ' + ((body.error && body.error.message) || r.status));
  return body;
}

async function stripeList(path, params, maxPages = 5) {
  const out = [];
  let after;
  for (let i = 0; i < maxPages; i++) {
    const page = await stripeGet(path, { ...params, limit: 100, starting_after: after });
    out.push(...(page.data || []));
    if (!page.has_more || !page.data.length) break;
    after = page.data[page.data.length - 1].id;
  }
  return out;
}

const PRODUCTS = new Map();
async function product(id) {
  if (!id) return null;
  if (PRODUCTS.has(id)) return PRODUCTS.get(id);
  const p = await stripeGet('products/' + id).catch(() => null);
  PRODUCTS.set(id, p);
  return p;
}

/* ---------- HubSpot ---------- */

async function hs(path, init = {}) {
  const token = String(process.env.HUBSPOT_TOKEN || '').trim();
  if (!token) throw new Error('HUBSPOT_TOKEN is not set in Netlify.');
  const r = await fetch(HUBSPOT + path, { ...init, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('HubSpot ' + path + ': ' + (body.message || r.status));
  return body;
}

// every field the sync may write. Fields that do not exist in HubSpot yet are skipped, not failed on.
export const FIELDS = [
  'tr_stripe_billing_status', 'tr_stripe_monthly_amount', 'tr_stripe_plan', 'tr_stripe_pricing_model',
  'tr_stripe_next_bill_date', 'tr_stripe_last_payment_amount', 'tr_stripe_last_payment_date',
  'tr_stripe_payment_method', 'tr_stripe_customer_since', 'tr_stripe_customer_link',
  'tr_stripe_implementation_billed', 'tr_stripe_total_billed', 'tr_stripe_amount_past_due'
];

let EXISTING = null;
async function existingFields() {
  if (EXISTING) return EXISTING;
  const all = await hs('/crm/v3/properties/companies');
  EXISTING = new Set((all.results || []).map(p => p.name));
  return EXISTING;
}

export async function findCompany(customerId) {
  const have = await existingFields();
  const r = await hs('/crm/v3/objects/companies/search', { method: 'POST', body: JSON.stringify({
    filterGroups: [{ filters: [{ propertyName: 'tr_stripe_customer_id', operator: 'EQ', value: customerId }] }],
    properties: ['name', 'tr_stripe_customer_id', ...FIELDS.filter(f => have.has(f))], limit: 2 }) });
  if (!r.results || !r.results.length) return null;
  if (r.results.length > 1) throw new Error('More than one HubSpot company has Stripe customer ' + customerId + '. Fix the duplicate before syncing.');
  return r.results[0];
}

export async function linkedCompanies() {
  const out = [];
  let after;
  do {
    const r = await hs('/crm/v3/objects/companies/search', { method: 'POST', body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'tr_stripe_customer_id', operator: 'HAS_PROPERTY' }] }],
      properties: ['name', 'tr_stripe_customer_id'], limit: 100, after }) });
    out.push(...(r.results || []));
    after = r.paging && r.paging.next && r.paging.next.after;
  } while (after);
  return out;
}

/* ---------- what the Stripe billing box should say ---------- */

const date = sec => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '');
const money = cents => (Math.round(Number(cents) || 0) / 100).toFixed(2);
const LIVE = ['active', 'trialing', 'past_due', 'unpaid'];

const priceOf = it => it.price || it.plan || {};
const isFlat = it => { const p = priceOf(it), r = p.recurring || {}; return (p.type === 'recurring' || !!r.interval || !!p.interval) && (r.usage_type || p.usage_type) !== 'metered' && Number(p.unit_amount ?? p.amount ?? 0) > 0; };
function monthly(it) {
  const p = priceOf(it), r = p.recurring || {};
  const cents = Number(p.unit_amount ?? p.amount ?? 0) * Number(it.quantity || 1);
  const every = Number(r.interval_count || p.interval_count || 1);
  const per = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 }[r.interval || p.interval || 'month'] || 1;
  return (cents * per) / every;
}
const isImplementation = p => !!p && ((p.metadata && p.metadata.tr_type === 'implementation') || /implement/i.test(p.name || ''));

function methodLabel(pm) {
  if (!pm || typeof pm !== 'object') return '';
  if (pm.card) return (pm.card.brand ? pm.card.brand[0].toUpperCase() + pm.card.brand.slice(1) : 'Card') + ' ending ' + pm.card.last4;
  if (pm.us_bank_account) return (pm.us_bank_account.bank_name || 'Bank account') + ' ending ' + pm.us_bank_account.last4;
  return pm.type || '';
}

export async function billingState(customerId, now = Math.floor(Date.now() / 1000)) {
  const [customer, subs, paid, open] = await Promise.all([
    stripeGet('customers/' + customerId, { expand: ['invoice_settings.default_payment_method'] }),
    stripeList('subscriptions', { customer: customerId, status: 'all', expand: ['data.default_payment_method'] }),
    stripeList('invoices', { customer: customerId, status: 'paid' }),
    stripeList('invoices', { customer: customerId, status: 'open' })
  ]);
  if (customer.deleted) return null;

  const items = s => (s.items && s.items.data) || [];
  const flatSubs = subs.filter(s => LIVE.includes(s.status) && items(s).some(isFlat)).sort((a, b) => b.created - a.created);
  const flat = flatSubs[0] || null;                                    // rule: one flat-fee subscription per customer
  const placeholder = subs.find(s => LIVE.includes(s.status) && !items(s).some(isFlat)) || null;
  const realPaid = paid.filter(i => Number(i.amount_paid) > 0).sort((a, b) => (b.status_transitions?.paid_at || b.created) - (a.status_transitions?.paid_at || a.created));
  const last = realPaid[0] || null;
  const lastAt = last ? (last.status_transitions?.paid_at || last.created) : 0;

  const p = {};
  if (flat) {
    const flatItems = items(flat).filter(isFlat);
    const names = [];
    for (const it of flatItems) { const pr = await product(priceOf(it).product); names.push((pr && pr.name) || 'Subscription'); }
    const interval = (priceOf(flatItems[0]).recurring || priceOf(flatItems[0])).interval || 'month';
    p.tr_stripe_pricing_model = 'Flat fee';
    p.tr_stripe_plan = names.join(' + ') + (interval === 'year' ? ', annual' : ', monthly');
    p.tr_stripe_monthly_amount = money(flatItems.reduce((a, it) => a + monthly(it), 0));
    p.tr_stripe_billing_status = ['past_due', 'unpaid'].includes(flat.status) ? 'Past due' : 'Active';
    const end = Math.max(0, ...flatItems.map(it => it.current_period_end || 0), flat.current_period_end || 0);
    p.tr_stripe_next_bill_date = flat.cancel_at_period_end ? '' : date(end);
  } else if (placeholder) {
    // legacy per-taxpayer pricing: billed by a manual invoice each month, so the latest paid invoice is the best "monthly amount"
    const recent = last && now - lastAt <= 45 * DAY;
    p.tr_stripe_pricing_model = 'Legacy per taxpayer';
    p.tr_stripe_plan = 'Per taxpayer (legacy)';
    p.tr_stripe_monthly_amount = recent ? money(last.amount_paid) : '';
    p.tr_stripe_billing_status = recent ? 'Active' : 'Not billed yet';
    p.tr_stripe_next_bill_date = '';
  } else {
    p.tr_stripe_pricing_model = '';
    p.tr_stripe_plan = '';
    p.tr_stripe_monthly_amount = '';
    p.tr_stripe_billing_status = subs.length ? 'Cancelled' : 'Not billed yet';
    p.tr_stripe_next_bill_date = '';
  }

  let implementation = 0;
  for (const inv of realPaid) for (const line of (inv.lines && inv.lines.data) || []) {
    const pid = line.pricing?.price_details?.product || line.price?.product;
    if (isImplementation(await product(pid))) implementation += Number(line.amount) || 0;
  }

  const pm = (flat && flat.default_payment_method) || customer.invoice_settings?.default_payment_method || (placeholder && placeholder.default_payment_method);
  p.tr_stripe_last_payment_amount = last ? money(last.amount_paid) : '';
  p.tr_stripe_last_payment_date = date(lastAt);
  p.tr_stripe_payment_method = methodLabel(pm);
  p.tr_stripe_customer_since = date(realPaid.length ? Math.min(...realPaid.map(i => i.status_transitions?.paid_at || i.created)) : 0);
  p.tr_stripe_customer_link = 'https://dashboard.stripe.com/' + (customer.livemode ? '' : 'test/') + 'customers/' + customerId;
  p.tr_stripe_implementation_billed = money(implementation);
  p.tr_stripe_total_billed = money(realPaid.reduce((a, i) => a + Number(i.amount_paid || 0), 0));
  p.tr_stripe_amount_past_due = money(open.reduce((a, i) => a + Number(i.amount_remaining || 0), 0));
  return p;
}

/* ---------- sync one customer ---------- */

const same = (a, b) => { const x = a == null ? '' : String(a), y = b == null ? '' : String(b); return x === y || (x !== '' && y !== '' && !isNaN(x) && !isNaN(y) && Number(x) === Number(y)); };

export async function syncCustomer(customerId, { dryRun = false } = {}) {
  const company = await findCompany(customerId);
  if (!company) return { customerId, skipped: 'No HubSpot company has this Stripe customer id.' };
  const state = await billingState(customerId);
  if (!state) return { customerId, skipped: 'Stripe customer was deleted.' };
  const have = await existingFields();
  const changes = {};
  for (const f of FIELDS) if (have.has(f) && !same(company.properties[f], state[f])) changes[f] = state[f];
  if (!dryRun && Object.keys(changes).length) await hs('/crm/v3/objects/companies/' + company.id, { method: 'PATCH', body: JSON.stringify({ properties: changes }) });
  return { customerId, companyId: company.id, company: company.properties.name, changed: Object.keys(changes), values: dryRun ? state : undefined };
}

export async function syncAll({ dryRun = false, concurrency = 4 } = {}) {
  const companies = await linkedCompanies();
  const results = [];
  let i = 0;
  const worker = async () => { while (i < companies.length) { const c = companies[i++]; try { results.push(await syncCustomer(c.properties.tr_stripe_customer_id, { dryRun })); } catch (e) { results.push({ customerId: c.properties.tr_stripe_customer_id, company: c.properties.name, error: String(e.message || e) }); } } };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { total: companies.length, updated: results.filter(r => r.changed && r.changed.length).length, unchanged: results.filter(r => r.changed && !r.changed.length).length, skipped: results.filter(r => r.skipped).length, errors: results.filter(r => r.error), results };
}

/* ---------- timeline notes: only the events a rep should see ---------- */

export async function addNote(companyId, html, when = Date.now()) {
  return hs('/crm/v3/objects/notes', { method: 'POST', body: JSON.stringify({
    properties: { hs_timestamp: new Date(when).toISOString(), hs_note_body: html },
    associations: [{ to: { id: companyId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 190 }] }] }) });
}

// returns the note text for an invoice event, or null when the event should stay quiet (routine renewals)
export async function noteFor(event) {
  const inv = event.data && event.data.object;
  if (!inv || inv.object !== 'invoice') return null;
  const link = inv.hosted_invoice_url ? ` <a href="${inv.hosted_invoice_url}">View invoice</a>` : '';
  if (event.type === 'invoice.payment_failed') return `<b>Stripe: payment failed</b><br>${'$' + money(inv.amount_due)} was declined.${link}`;
  if (event.type !== 'invoice.paid' || !(Number(inv.amount_paid) > 0)) return null;
  let impl = 0;
  for (const line of (inv.lines && inv.lines.data) || []) { const pid = line.pricing?.price_details?.product || line.price?.product; if (isImplementation(await product(pid))) impl += Number(line.amount) || 0; }
  if (impl > 0) return `<b>Stripe: implementation invoice paid</b><br>${'$' + money(impl)} implementation, ${'$' + money(inv.amount_paid)} total.${link}`;
  if (inv.billing_reason === 'subscription_create') return `<b>Stripe: first subscription payment</b><br>${'$' + money(inv.amount_paid)} paid.${link}`;
  return null;
}

/* ---------- Stripe webhook signature ---------- */

export function verifyStripeSignature(payload, header, secret, toleranceSec = 300, now = Math.floor(Date.now() / 1000)) {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set in Netlify.');
  const parts = Object.fromEntries(String(header || '').split(',').map(x => x.split('=')).filter(x => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header || '').split(',').map(x => x.trim()).filter(x => x.startsWith('v1=')).map(x => x.slice(3));
  if (!parts.t || !sigs.length) return false;
  if (Math.abs(now - Number(parts.t)) > toleranceSec) return false;
  const want = crypto.createHmac('sha256', secret).update(parts.t + '.' + payload).digest('hex');
  return sigs.some(s => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}

/* ---------- who is calling (same check as quotes.mjs) ---------- */

export async function whoIsCalling(req, context) {
  const fromContext = context?.clientContext?.user?.email;
  if (fromContext) return fromContext;
  const auth = req.headers.get('authorization');
  if (!auth || !/^Bearer /i.test(auth)) return null;
  const site = process.env.URL || process.env.DEPLOY_URL || new URL(req.url).origin;
  try {
    const r = await fetch(site + '/.netlify/identity/user', { headers: { Authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.email || null;
  } catch { return null; }
}

export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
