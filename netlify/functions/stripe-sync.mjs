import { syncCustomer, whoIsCalling, json } from '../lib/stripe-hubspot.mjs';

/* For signed-in staff (same Netlify Identity sign-in as the builder).
 *
 * GET  /.netlify/functions/stripe-sync?customer=cus_123         preview: what the box would say, nothing written
 * POST /.netlify/functions/stripe-sync?customer=cus_123         sync that one customer now
 * POST /.netlify/functions/stripe-sync?all=1                    start the full recheck in the background */
export default async (req, context) => {
  const email = await whoIsCalling(req, context);
  if (!email) return json(401, { error: 'Sign in first.' });
  const url = new URL(req.url);
  const customer = url.searchParams.get('customer');
  try {
    if (req.method === 'GET' && customer) return json(200, await syncCustomer(customer, { dryRun: true }));
    if (req.method === 'POST' && customer) return json(200, await syncCustomer(customer));
    if (req.method === 'POST' && url.searchParams.get('all')) {
      const site = (process.env.URL || url.origin).replace(/\/+$/, '');
      const r = await fetch(site + '/.netlify/functions/stripe-sync-all-background', { method: 'POST', headers: { 'x-sync-secret': String(process.env.SYNC_SECRET || '') } });
      return json(202, { started: r.status === 202 || r.ok, by: email });
    }
    return json(400, { error: 'Pass ?customer=cus_... or ?all=1' });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
