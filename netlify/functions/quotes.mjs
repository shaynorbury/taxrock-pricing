import { getStore } from '@netlify/blobs';

/* Saved quotes for the TaxRock document builder.
 *
 * GET    /.netlify/functions/quotes           list every saved quote (summary only)
 * GET    /.netlify/functions/quotes?id=q_123  one full quote
 * GET    /.netlify/functions/quotes?diag=1    is storage working, and who am I
 * POST   /.netlify/functions/quotes           create or update, body is the record
 * DELETE /.netlify/functions/quotes?id=q_123  remove one
 *
 * Every request must carry a valid Netlify Identity session. Anyone signed in can
 * read, write and delete any quote: the team shares one list on purpose.
 *
 * This is a modern Netlify function (export default, Request/Response). That
 * matters: the older `export const handler` signature runs in Lambda
 * compatibility mode, where Netlify does not configure Blobs at all without
 * connectLambda, and even then supplies no uncachedEdgeURL, so strongly
 * consistent reads fail. Both of those were live bugs. Do not convert this back.
 */

const STORE = 'taxrock-quotes';

/* Blobs defaults to eventual consistency, where a record written a moment ago is
 * not guaranteed to appear in list() for up to 60 seconds. A rep must see the
 * quote they just saved, so reads here are strong. If an environment cannot do
 * that, the code below drops back to eventual rather than failing. */
let CONSISTENCY = 'strong';
let storeFactory = null;   // tests substitute a stand-in store through __useStore
export function __useStore(factory) { storeFactory = factory; CONSISTENCY = 'strong'; }
const openStore = () => storeFactory
  ? storeFactory(CONSISTENCY)
  : getStore(CONSISTENCY === 'strong' ? { name: STORE, consistency: 'strong' } : STORE);
const isConsistencyError = e => /uncachedEdgeURL|strong consistency/i.test(String(e?.message || e));

// runs an operation, and permanently steps down to eventual consistency if the
// environment turns out not to support strong reads
async function withStore(fn) {
  try {
    return await fn(openStore());
  } catch (err) {
    if (CONSISTENCY === 'strong' && isConsistencyError(err)) {
      CONSISTENCY = 'eventual';
      return await fn(openStore());
    }
    throw err;
  }
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

/* --- who is calling ---------------------------------------------------------
 * The bearer token the Identity widget holds is checked against Identity itself.
 * Verified tokens are remembered briefly, so a burst of autosaves does not mean
 * a round trip each time. */
const SEEN = new Map();
const TOKEN_TTL = 5 * 60 * 1000;

async function whoIsCalling(req, context) {
  const fromContext = context?.clientContext?.user?.email;
  if (fromContext) return fromContext;

  const auth = req.headers.get('authorization');
  if (!auth || !/^Bearer /i.test(auth)) return null;

  const hit = SEEN.get(auth);
  if (hit && hit.until > Date.now()) return hit.email;

  const site = process.env.URL || process.env.DEPLOY_URL || new URL(req.url).origin;
  try {
    const r = await fetch(site + '/.netlify/identity/user', { headers: { Authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u?.email) return null;
    if (SEEN.size > 200) SEEN.clear();
    SEEN.set(auth, { email: u.email, until: Date.now() + TOKEN_TTL });
    return u.email;
  } catch {
    return null;
  }
}

export default async (req, context) => {
  const email = await whoIsCalling(req, context);
  if (!email) return json(401, { error: 'Sign in to use saved quotes.' });

  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (url.searchParams.get('diag')) return diagnose(email);

  try {
    if (req.method === 'GET' && id) {
      const rec = await withStore(s => s.get(id, { type: 'json' }));
      return rec ? json(200, rec) : json(404, { error: 'Not found' });
    }

    if (req.method === 'GET') {
      // metadata carries everything the list needs, so the bodies stay unread
      const rows = await withStore(async s => {
        const { blobs } = await s.list();
        return Promise.all(blobs.map(async b => {
          try {
            const { metadata } = await s.getMetadata(b.key);
            return { id: b.key, ...(metadata || {}) };
          } catch {
            return { id: b.key };
          }
        }));
      });
      return json(200, rows.filter(r => r.name));
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const name = (body.name || '').trim();
      if (!name) return json(400, { error: 'A legal entity name is required.' });

      const key = body.id && /^q_[A-Za-z0-9_]+$/.test(body.id)
        ? body.id
        : 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

      const rec = await withStore(async s => {
        const existing = body.id ? await s.get(key, { type: 'json' }).catch(() => null) : null;
        const r = {
          id: key,
          name,
          vertical: body.vertical || 'taxpro',
          price: body.price || '',
          fields: body.fields || {},
          createdAt: existing?.createdAt || Date.now(),
          createdBy: existing?.createdBy || email,
          updatedAt: Date.now(),
          updatedBy: email
        };
        await s.setJSON(key, r, {
          metadata: {
            name: r.name, vertical: r.vertical, price: r.price,
            updatedAt: r.updatedAt, updatedBy: r.updatedBy
          }
        });
        return r;
      });
      return json(200, rec);
    }

    if (req.method === 'DELETE') {
      if (!id) return json(400, { error: 'No id given.' });
      await withStore(s => s.delete(id));
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    return json(500, { error: String(err?.message || err) });
  }
};

/* says in plain terms which half is broken */
async function diagnose(email) {
  const out = {
    signedInAs: email,
    node: process.version,
    site: process.env.SITE_NAME || null,
    url: process.env.URL || null,
    storage: { ok: false }
  };
  try {
    const count = await withStore(async s => (await s.list()).blobs.length);
    out.storage = { ok: true, store: STORE, savedQuotes: count, consistency: CONSISTENCY };
  } catch (err) {
    const msg = String(err?.message || err);
    out.storage = {
      ok: false,
      error: msg,
      meaning: /has not been configured/i.test(msg)
        ? 'The function reached Netlify Blobs but was not given credentials for it.'
        : 'The store could not be read.'
    };
  }
  return json(200, out);
}
