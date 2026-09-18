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
- `netlify.toml` — tells Netlify to publish `/public`, and adds `noindex` so the
  page never turns up in a search engine.
- `package.json` — a marker file so Netlify treats this as a project.
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

1. In the site, go to **Integrations → Identity** (older accounts show a
   top-level **Identity** tab) and click **Enable Identity**.
2. Open **Identity → Settings and usage**.
3. Under **Registration**, choose **Invite only**. This is the important one. If
   you leave it open, anyone can create an account.
4. Under **External providers**, leave everything off unless you want Google
   login for staff.

**Step 4. Invite your people**

1. **Identity → Invite users**.
2. Enter each person's work email. They get an email, set a password, and are in.
3. To remove someone later, delete them from the same list. They lose access on
   their next page load.

---

## Part 2 — Day to day

**Changing pricing.** Open `public/index.html` and find the block near the top of
the script marked `PRICING BY VERTICAL`:

```js
const TAXPRO_BANDS=[[50,99],[150,159],[300,199],[500,349],[1000,499],[2500,799]];

const VERTICALS={
  taxpro:{label:'Tax Pro', code:'TP', bands:TAXPRO_BANDS, inherits:null},
  factor:{label:'Factor', code:'FA', bands:TAXPRO_BANDS, inherits:'Tax Pro'},
  lender:{label:'Lender', code:'LN', bands:TAXPRO_BANDS, inherits:'Tax Pro'}
};
```

Each pair is `[included capacity, monthly price]`, lowest first. To give Factor
its own pricing, replace `TAXPRO_BANDS` on that line with its own list and set
`inherits:null`. Quotes, the fee box, the rate table and the internal matrix all
follow automatically.

Commit the change and Netlify redeploys in about a minute.

**Changing contract wording.** Both documents are plain HTML inside
`public/index.html`. The MSA is the block beginning `<h2 class="sec">1. Agreement
Overview</h2>`; the proposal is the block beginning `<div class="kicker">Pricing
Proposal</div>`. Edit the words, commit, done. Page breaks re-flow on their own.

**Previewing changes locally.** With Node installed:

```
npm run preview
```

then open http://localhost:8788. The login is skipped in preview only.

---

## Part 3 — What is and is not protected

**Protected.** Only invited accounts can load the page. Nobody outside can reach
the builder or the pricing matrix, and the site is marked `noindex` so it will
not appear in search results.

**Not protected.** Once a person is signed in, everything in the page is on their
computer, including the pricing matrix. Anyone signed in can view source. That is
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
- Both documents carry version codes by vertical: `TR-PP-TP-11`,
  `TR-MSA-TP-11`, and the `FA` and `LN` equivalents. If you revise the contract
  language, bump `11` so you can tell versions apart later.
