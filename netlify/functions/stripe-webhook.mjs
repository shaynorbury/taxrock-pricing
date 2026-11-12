import { getStore } from '@netlify/blobs';
import { verifyStripeSignature, syncCustomer, noteFor, addNote, stripeMode, json } from '../lib/stripe-hubspot.mjs';

/* Stripe calls this whenever billing changes. It refreshes that customer's "Stripe billing" box in HubSpot.
 *
 * Add it in Stripe as a webhook endpoint:  https://<this site>/.netlify/functions/stripe-webhook
 * Events to send: customer.subscription.created, customer.subscription.updated, customer.subscription.deleted,
 *                 invoice.paid, invoice.payment_failed
 *
 * Safe to receive the same event twice: each event id is remembered, and the sync itself only writes
 * fields whose value changed. If anything fails, this answers 500 so Stripe retries later. */

const HANDLED = ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'];
const seen = () => getStore({ name: 'taxrock-stripe-sync', consistency: 'strong' });

export default async req => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const payload = await req.text();
  let ok = false;
  try { ok = verifyStripeSignature(payload, req.headers.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET); }
  catch (e) { return json(500, { error: String(e.message || e) }); }
  if (!ok) return json(400, { error: 'Bad signature' });

  const event = JSON.parse(payload);
  if (!HANDLED.includes(event.type)) return json(200, { ignored: event.type });
  try {
    if ((event.livemode ? 'live' : 'test') !== stripeMode()) return json(200, { ignored: 'event mode does not match STRIPE_SYNC_KEY' });
    const obj = event.data.object;
    const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id;
    if (!customerId) return json(200, { ignored: 'no customer on event' });

    const store = seen();
    const first = !(await store.get('evt:' + event.id).catch(() => null));
    const result = await syncCustomer(customerId);
    if (first && result.companyId) {
      const note = await noteFor(event);
      if (note) await addNote(result.companyId, note, (event.created || Date.now() / 1000) * 1000);
    }
    await store.set('evt:' + event.id, String(Date.now())).catch(() => 0);
    return json(200, { ok: true, ...result });
  } catch (e) {
    console.error('stripe-webhook failed', event.id, e);
    return json(500, { error: String(e.message || e) });
  }
};
