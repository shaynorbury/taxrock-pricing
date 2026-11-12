// Run: node netlify/lib/stripe-hubspot.test.mjs
// Uses made-up customers and a fake fetch. Nothing here talks to Stripe or HubSpot.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.STRIPE_SYNC_KEY = 'rk_test_madeup';
process.env.HUBSPOT_TOKEN = 'test-token';
const NOW = Math.floor(Date.now() / 1000), DAY = 86400;

const products = {
  prod_flat: { id: 'prod_flat', name: 'Tax 300', metadata: {} },
  prod_old: { id: 'prod_old', name: 'TaxRock - Tax Pro Taxpayer', metadata: {} },
  prod_impl: { id: 'prod_impl', name: 'Implementation', metadata: { tr_type: 'implementation' } }
};
const flatItem = (amount, interval = 'month') => ({ quantity: 1, current_period_end: NOW + 20 * DAY, price: { type: 'recurring', unit_amount: amount, product: 'prod_flat', recurring: { interval, interval_count: 1, usage_type: 'licensed' } } });
const oldItem = () => ({ quantity: 1, current_period_end: NOW + 20 * DAY, price: { type: 'recurring', unit_amount: 0, product: 'prod_old', recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } } });
const sub = (status, items, created = NOW - 30 * DAY) => ({ id: 'sub_' + Math.random(), status, created, items: { data: items }, default_payment_method: { type: 'card', card: { brand: 'visa', last4: '4242' } } });
const inv = (paid, daysAgo, lines = [], extra = {}) => ({ id: 'in_' + Math.random(), amount_paid: paid, created: NOW - daysAgo * DAY, status_transitions: { paid_at: NOW - daysAgo * DAY }, lines: { data: lines }, ...extra });

const stripe = {
  // flat-fee customer who still has the old $0 placeholder, and paid an implementation fee
  cus_flat: { subs: [sub('active', [oldItem()], NOW - 60 * DAY), sub('active', [flatItem(19900)])], paid: [inv(19900, 10), inv(150000, 12, [{ amount: 150000, pricing: { price_details: { product: 'prod_impl' } } }])], open: [] },
  // legacy customer billed by a manual invoice 9 days ago
  cus_legacy: { subs: [sub('active', [oldItem()])], paid: [inv(15750, 9), inv(13300, 40)], open: [] },
  // flat-fee customer whose payment failed
  cus_late: { subs: [sub('past_due', [flatItem(39900)])], paid: [], open: [{ amount_remaining: 39900 }] },
  // annual flat-fee plan
  cus_year: { subs: [sub('active', [flatItem(478800, 'year')])], paid: [inv(478800, 3)], open: [] },
  // everything cancelled
  cus_gone: { subs: [sub('canceled', [flatItem(9900)])], paid: [inv(9900, 90)], open: [] }
};
const companies = { cus_flat: { id: '101', properties: { name: 'Larkfield Tax Group', tr_stripe_customer_id: 'cus_flat' } } };
const writes = [], stripeCalls = [];

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), method = init.method || 'GET';
  const reply = body => ({ ok: true, status: 200, json: async () => body });
  if (u.host === 'api.stripe.com') {
    stripeCalls.push(method);
    const path = u.pathname.replace('/v1/', ''), cus = u.searchParams.get('customer');
    if (path.startsWith('customers/')) return reply({ id: path.split('/')[1], livemode: false, invoice_settings: {} });
    if (path.startsWith('products/')) return reply(products[path.split('/')[1]] || {});
    if (path === 'subscriptions') return reply({ data: stripe[cus].subs, has_more: false });
    if (path === 'invoices') return reply({ data: stripe[cus][u.searchParams.get('status')] || [], has_more: false });
  }
  if (u.host === 'api.hubapi.com') {
    if (u.pathname === '/crm/v3/properties/companies') return reply({ results: ['tr_stripe_customer_id', 'tr_stripe_billing_status', 'tr_stripe_monthly_amount', 'tr_stripe_plan', 'tr_stripe_pricing_model', 'tr_stripe_next_bill_date', 'tr_stripe_last_payment_amount', 'tr_stripe_last_payment_date', 'tr_stripe_payment_method', 'tr_stripe_customer_since', 'tr_stripe_customer_link'].map(name => ({ name })) });
    if (u.pathname.endsWith('/search')) { const id = JSON.parse(init.body).filterGroups[0].filters[0].value; return reply({ results: companies[id] ? [companies[id]] : [] }); }
    if (method === 'PATCH') { const body = JSON.parse(init.body); writes.push(body.properties); Object.assign(companies.cus_flat.properties, body.properties); return reply({}); }
  }
  throw new Error('unexpected request ' + method + ' ' + url);
};

const { billingState, syncCustomer, verifyStripeSignature, stripeKey, noteFor } = await import('./stripe-hubspot.mjs');

const flat = await billingState('cus_flat');
assert.equal(flat.tr_stripe_pricing_model, 'Flat fee');
assert.equal(flat.tr_stripe_monthly_amount, '199.00', 'the $0 placeholder and the implementation fee are not counted');
assert.equal(flat.tr_stripe_plan, 'Tax 300, monthly');
assert.equal(flat.tr_stripe_billing_status, 'Active');
assert.equal(flat.tr_stripe_implementation_billed, '1500.00');
assert.equal(flat.tr_stripe_total_billed, '1699.00');
assert.equal(flat.tr_stripe_payment_method, 'Visa ending 4242');
assert.ok(flat.tr_stripe_next_bill_date);

const legacy = await billingState('cus_legacy');
assert.equal(legacy.tr_stripe_pricing_model, 'Legacy per taxpayer');
assert.equal(legacy.tr_stripe_monthly_amount, '157.50', 'legacy shows the latest manual invoice');
assert.equal(legacy.tr_stripe_billing_status, 'Active');

const late = await billingState('cus_late');
assert.equal(late.tr_stripe_billing_status, 'Past due');
assert.equal(late.tr_stripe_amount_past_due, '399.00');

const year = await billingState('cus_year');
assert.equal(year.tr_stripe_monthly_amount, '399.00', 'annual plans are shown per month');
assert.equal(year.tr_stripe_plan, 'Tax 300, annual');

assert.equal((await billingState('cus_gone')).tr_stripe_billing_status, 'Cancelled');

// sync writes once, then finds nothing to change; fields missing in HubSpot are skipped
const first = await syncCustomer('cus_flat');
assert.ok(first.changed.includes('tr_stripe_monthly_amount'));
assert.ok(!first.changed.includes('tr_stripe_total_billed'), 'a field that does not exist in HubSpot yet is skipped');
assert.equal(writes.length, 1);
const second = await syncCustomer('cus_flat');
assert.deepEqual(second.changed, []);
assert.equal(writes.length, 1, 'no write when nothing changed');
assert.ok((await syncCustomer('cus_legacy')).skipped, 'no HubSpot company linked means no write');

// Stripe is only ever read
assert.ok(stripeCalls.length > 0 && stripeCalls.every(m => m === 'GET'));

// only a restricted key is accepted
process.env.STRIPE_SYNC_KEY = 'sk_live_full_access';
assert.throws(() => stripeKey(), /restricted/);
process.env.STRIPE_SYNC_KEY = 'rk_test_madeup';

// webhook signature
const payload = '{"id":"evt_1"}', t = NOW, secret = 'whsec_madeup';
const good = 't=' + t + ',v1=' + crypto.createHmac('sha256', secret).update(t + '.' + payload).digest('hex');
assert.equal(verifyStripeSignature(payload, good, secret), true);
assert.equal(verifyStripeSignature(payload + 'x', good, secret), false);
assert.equal(verifyStripeSignature(payload, good, secret, 300, NOW + 3600), false, 'old signatures are refused');

// timeline notes: routine renewals stay quiet
assert.equal(await noteFor({ type: 'invoice.paid', data: { object: { object: 'invoice', amount_paid: 19900, billing_reason: 'subscription_cycle', lines: { data: [] } } } }), null);
assert.match(await noteFor({ type: 'invoice.paid', data: { object: { object: 'invoice', amount_paid: 19900, billing_reason: 'subscription_create', lines: { data: [] } } } }), /first subscription payment/);
assert.match(await noteFor({ type: 'invoice.payment_failed', data: { object: { object: 'invoice', amount_due: 19900 } } }), /payment failed/);
assert.match(await noteFor({ type: 'invoice.paid', data: { object: { object: 'invoice', amount_paid: 150000, lines: { data: [{ amount: 150000, pricing: { price_details: { product: 'prod_impl' } } }] } } } }), /implementation invoice paid/);

console.log('All checks passed');
