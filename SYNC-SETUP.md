# Stripe to HubSpot billing sync: setup

Keeps the "Stripe billing" box on each HubSpot company up to date from Stripe. One direction only.
It reads from Stripe with a read-only key, so it cannot charge, email or change anything for a customer.

## What is in the repo

- `netlify/lib/stripe-hubspot.mjs`: the sync itself, and the billing rules
- `netlify/functions/stripe-webhook.mjs`: Stripe calls this when billing changes
- `netlify/functions/stripe-sync-nightly.mjs`: nightly recheck at 2:00 am Pacific
- `netlify/functions/stripe-sync-all-background.mjs`: the full recheck the nightly job starts
- `netlify/functions/stripe-sync.mjs`: preview or sync one customer, for signed-in staff
- `netlify/lib/stripe-hubspot.test.mjs`: checks, run with `node netlify/lib/stripe-hubspot.test.mjs`

## Turning it on (four values in Netlify, Site configuration > Environment variables)

1. `STRIPE_SYNC_KEY`: in Stripe, Developers > API keys > Create restricted key. Set Customers, Subscriptions,
   Invoices, Products and Prices to **Read**. Leave everything else at None. The key starts with `rk_live_`.
   A full secret key is refused by the code on purpose.
2. `HUBSPOT_TOKEN`: in HubSpot, create a private app with companies read and write, company properties read,
   and notes write. Copy its access token.
3. `SYNC_SECRET`: any long random string. It lets the nightly job start the full recheck.
4. `STRIPE_WEBHOOK_SECRET`: in Stripe, Developers > Webhooks > Add endpoint, URL
   `https://<this site>/.netlify/functions/stripe-webhook`, events: customer.subscription.created,
   customer.subscription.updated, customer.subscription.deleted, invoice.paid, invoice.payment_failed.
   Copy the endpoint's signing secret (starts with `whsec_`).

Mark all four as secret. Never paste them into chat, email or the repo.

## First run

Signed in to the builder, preview one customer first (nothing is written):
`GET /.netlify/functions/stripe-sync?customer=cus_...`

Then fill every linked company: `POST /.netlify/functions/stripe-sync?all=1`

## How a customer is matched

The HubSpot company field `tr_stripe_customer_id` holds the Stripe customer id. No id, no sync.
New customers get theirs automatically once the pricing app creates the Stripe customer.

## Billing rules it follows

- One flat-fee subscription per customer. That is Monthly amount, recurring only.
- Implementation fees are one-time lines and never count toward Monthly amount. They are recognized by a
  Stripe product named Implementation, or with metadata `tr_type = implementation`.
- The old per-taxpayer subscription is a $0 placeholder and is ignored. A customer with only that placeholder
  shows as Legacy per taxpayer, with their latest manual invoice as Monthly amount.
