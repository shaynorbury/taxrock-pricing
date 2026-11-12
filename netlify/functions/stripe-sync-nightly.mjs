/* Nightly safety net at 2:00 am Pacific (10:00 UTC; 3:00 am in summer): rechecks every linked customer,
 * so anything a webhook missed is corrected by morning. */
export default async () => {
  const site = (process.env.URL || '').replace(/\/+$/, '');
  const r = await fetch(site + '/.netlify/functions/stripe-sync-all-background', { method: 'POST', headers: { 'x-sync-secret': String(process.env.SYNC_SECRET || '') } });
  console.log('stripe-sync-nightly started full recheck', r.status);
};

export const config = { schedule: '0 10 * * *' };
