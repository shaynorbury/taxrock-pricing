import { syncAll } from '../lib/stripe-hubspot.mjs';

/* Full recheck: refreshes the Stripe billing box on every HubSpot company that has a Stripe customer id.
 * A background function (up to 15 minutes), so it keeps working as the customer list grows.
 * Started by the nightly job and by the staff "sync everything" call; both must send SYNC_SECRET. */
export default async req => {
  const secret = String(process.env.SYNC_SECRET || '');
  if (!secret || req.headers.get('x-sync-secret') !== secret) { console.error('stripe-sync-all: wrong or missing secret'); return; }
  const done = await syncAll();
  console.log('stripe-sync-all', JSON.stringify({ total: done.total, updated: done.updated, unchanged: done.unchanged, skipped: done.skipped, errors: done.errors }));
};
