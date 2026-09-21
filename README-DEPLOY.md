# TaxRock Document Builder — setup guide

The builder generates a customer's Pricing Proposal and Master Subscription
Agreement from one set of inputs, and exports either one as a PDF. It also
carries an internal pricing matrix that customers must never see.

It is protected the same way the factor pricing tool is: **per-person login
through Netlify Identity, invite only.** There is no shared password to pass
around, you can see who signs in, and you can revoke anyone instantly.

You do not need to write code. Everything below happens in GitHub and Netlify.

---

## What is in this folder

- `public/index.html` — the whole application. The builder, both documents, and
  the internal pricing matrix.
- `public/netlify-identity.js` — the login widget, bundled locally so the page
  works even if a CDN is blocked.
- `netlify/functions/quotes.mjs` — the only server code. It saves and loads the
  team's saved quotes, and refuses anyone who is not signed in.
- `netlify.toml` — tells Netlify to publish `/public`, where the function lives,
  and adds `noindex` so the page never turns up in a search engine.
- `package.json` — the one dependency the function needs.
- `local-preview.js` — previewing on a developer's computer only. Not used online.

---

## Part 1 — Put it online

**Step 1. Push this folder to your GitHub repository**

Upload the contents of this folder to the repo you created. The folder structure
matters: `public/` must stay a folder.

**Step 2. Create a new Netlify site**

1. In Netlify, choose **Add new site → Import an existing project**.
2. Pick GitHub and select the repository.
3. Leave the build command empty. Publish directory is `public`.
4. Click **Deploy**.

Keep this as its own Netlify site, separate from taxrock.com.

**Step 3. Turn on Identity**

You do not need a database, and you do not need to connect any other service.
Netlify Identity stores the user accounts itself, per site. Enabling it is the
whole setup.

1. In the site, go to **Site configuration → Identity** and click
   **Enable Identity**. Some accounts show this under **Integrations → Identity**
   or as a top-level **Identity** tab; Netlify moves it around, but it is the
   same feature.
2. Open **Identity → Settings and usage**.
3. Under **Registration**, choose **Invite only**. This is the important one. If
   you leave it open, anyone can create an account.
4. Under **External providers**, leave everything off unless you want Google
   login for staff.

Until this step is done the sign-in button has nothing to talk to and the gate
will not let anyone through. That is expected, not a fault in the page.

> **A note on Identity's status.** Netlify announced in 2025 that Identity would
> be deprecated in favour of an Auth0 extension. That decision was **reversed on
> 19 February 2026**; Identity is a supported option again, is included on all
> credit-based plans at no extra cost, and existing implementations keep working.
> If you find the older deprecation notices while searching, they are out of date.

**Step 4. Invite your people**

1. **Identity → Invite users**.
2. Enter each person's work email. They get an email, set a password, and are in.
3. To remove someone later, delete them from the same list. They lose access on
   their next page load.

**Step 5. Saved quotes — nothing to do**

The left column of the builder keeps every quote the team has saved, newest
first. Those records live in **Netlify Blobs**, a store that is part of Netlify
itself. There is no database to sign up for, no keys to paste, and no monthly
bill. Deploying the repository is the whole setup: Netlify sees
`netlify/functions/quotes.mjs`, installs its one dependency, and the store
appears the first time someone presses Save.

Two things to know:

- **Everyone signed in shares one list.** Any rep can open, re-export, edit or
  delete any customer's quote. That is deliberate, so nobody is stuck when the
  rep who built a quote is out. Deleting is two clicks and cannot be undone.
- **If two people edit the same quote at once, the last save wins.** With a
  handful of reps this is unlikely to bite; if it ever does, say so and the
  function can warn instead of overwriting.

If the left column ever says it could not load saved quotes, press **Check
storage** at the bottom of that column. It asks the server what is wrong and
answers in words: storage connected, storage not connected, or the function is
not deployed at all.

Two failures have real fixes:

- *"The environment has not been configured to use Netlify Blobs",* or *"failed
  to perform a read using strong consistency ... uncachedEdgeURL".* Both mean the
  function has been written with the old `export const handler` signature, which
  Netlify runs in Lambda compatibility mode. In that mode Blobs is not configured
  at all, and even once it is, strongly consistent reads are impossible. The
  function uses the modern `export default async (req, context)` form instead,
  and gets its signed-in user by checking the request's token against Identity.
  Converting it back to a classic handler brings both errors with it.
- *A quote saves but does not appear in the list.* Netlify Blobs is eventually
  consistent by default: a record written a moment ago can take up to a minute
  to show up in a listing. The store is opened with `consistency: 'strong'` to
  stop that, and the page also shows a just-saved quote straight away rather
  than waiting for the server to agree. Removing either would bring this back.
  If an environment ever refuses strong reads, the function drops back to
  eventual rather than failing, and Check storage says so.
- *A missing-module error in the deploy log.* The build did not install the
  dependency. Setting the build command to `npm install` fixes it, and the
  committed `netlify.toml` already does this.

---

## Part 2 — Day to day

**Changing pricing.** Open `public/index.html` and find the block near the top of
the script marked `PRICING BY VERTICAL`:

```js
const TAXPRO_BANDS=[[50,99],[150,159],[300,199],[500,349],[1000,499],[2500,799]];
const FACTOR_BANDS=[[10,99],[25,199],[50,399],[100,499]];

const VERTICALS={
  taxpro:{label:'Tax Pro', code:'TP', bands:TAXPRO_BANDS, implFee:null, inherits:null},
  factor:{label:'Factor', code:'FA', bands:FACTOR_BANDS, implFee:null, inherits:null},
  lender:{label:'Lender', code:'LN', bands:FACTOR_BANDS, implFee:null, inherits:'Factor'}
};
```

Each pair is `[included capacity, monthly price]`, lowest first. Anything above the
top band is quoted rather than priced. To give Lender its own ladder, replace
`FACTOR_BANDS` on that line with its own list and set `inherits:null`. Quotes, the
fee box, the rate table and the internal matrix all follow automatically.

`implFee` is the charge for an additional TaxRock-led implementation or training
engagement requested after the included Guided Implementation. It is unrelated to
capacity. Left at `null`, both documents say only that an additional fee may apply
depending on scope; set it to a number and the amount and its per-engagement wording
appear in both.

Commit the change and Netlify redeploys in about a minute.

**Changing what a client counts as.** Each vertical owns its own wording in the
`TERMS` block just below `VERTICALS`. Two entries there must always agree, because
one is the contract and the other explains it: `msaDefn` is the operative sentence
of **MSA Section 2.5**, which controls, and `defn` is the plain-English gloss
printed on the Pricing Proposal. Change one and change the other.

Neither document names the customer's own business anywhere — no "practice", no
"book", no "portfolio". That follows TR-MSA-LN-11, which says throughout that
clients are *provisioned within Customer's account*, wording that is equally true
of a tax practice, a factor's book and a lender's portfolio. `noun` and `metaLab`
are for the builder's own screens and the internal pricing matrix only. Keep
industry vocabulary out of the contract wording and this stays true for the next
vertical as well.

**Changing contract wording.** Both documents are plain HTML inside
`public/index.html`. The MSA is the block beginning `<h2 class="sec">1. Agreement
Overview</h2>`; the proposal is the block beginning `<div class="kicker">Pricing
Proposal</div>`. Edit the words, commit, done. Page breaks re-flow on their own.

**Previewing changes locally.** With Node installed:

```
npm run preview
```

then open http://localhost:8788. The login is skipped in preview only, and
because the Netlify function is not running there, saved quotes fall back to
your own browser's storage. The left column says so when it does. To exercise
the real store locally, use `npx netlify dev` instead.

---

## Part 3 — What is and is not protected

**Protected.** Only invited accounts can load the page. Nobody outside can reach
the builder or the pricing matrix, and the site is marked `noindex` so it will
not appear in search results.

**Not protected.** Once a person is signed in, everything in the page is on their
computer, including the pricing matrix and every saved quote. Anyone signed in
can view source, and the quotes function answers any signed-in account. That is
fine for staff, and it is a real improvement on emailing the HTML file around,
but it is not a barrier against someone who already has access.

If you ever need the matrix itself to be unreachable even by signed-in staff, it
would have to move server-side the way the factor tool's fee table did. Say the
word and that is a small change.

---

## Part 4 — Reminders

- The **Pricing matrix** tab is internal. It never prints and is excluded from
  every PDF export, so it cannot reach a customer by accident.
- The MSA's **For signature** mode carries Ron's countersignature. Treat those
  exports as executed documents. Use **Draft** for anything sent for review.
- **Saved quotes are a shared record, not a CRM.** They hold what was quoted and
  who quoted it. They do not sync to HubSpot, and nothing expires them.
- Both documents carry version codes by vertical: `TR-PP-TP-11`,
  `TR-MSA-TP-11`, and the `FA` and `LN` equivalents. If you revise the contract
  language, bump `11` so you can tell versions apart later.
