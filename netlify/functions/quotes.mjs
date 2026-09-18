import { connectLambda, getStore } from '@netlify/blobs';

/* Saved quotes for the TaxRock document builder.
 *
 * GET    /.netlify/functions/quotes          list every saved quote (summary only)
 * GET    /.netlify/functions/quotes?id=q_123 one full quote
 * POST   /.netlify/functions/quotes          create or update, body is the record
 * DELETE /.netlify/functions/quotes?id=q_123 remove one
 *
 * Every request must carry a valid Netlify Identity session. Anyone signed in can
 * read, write and delete any quote: the team shares one list on purpose.
 */

const json = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

/* Identity puts the signed-in user on clientContext. Some runtimes do not, so the
   bearer token is checked against Identity itself as a fallback rather than trusted. */
async function whoIsCalling(event, context) {
  const fromContext = context?.clientContext?.user;
  if (fromContext?.email) return fromContext.email;

  const auth = event.headers?.authorization || event.headers?.Authorization;
  if (!auth || !/^Bearer /i.test(auth)) return null;

  const site = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!site) return null;
  try {
    const r = await fetch(site + '/.netlify/identity/user', { headers: { Authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.email || null;
  } catch {
    return null;
  }
}

const STORE = 'taxrock-quotes';

/* This function uses the classic handler signature, because that is what gives it
 * the signed-in Identity user. Netlify calls that Lambda compatibility mode, and in
 * that mode it does NOT hand Blobs its credentials automatically — getStore then
 * fails with MissingBlobsEnvironmentError. connectLambda passes the request through
 * and sets them up. It must run before getStore, on every invocation. */
function openStore(event) {
  try {
    // event.blobs is the config Netlify attaches to the request in this mode
    if (event && event.blobs) connectLambda(event);
    return getStore(STORE);
  } catch (err) {
    // last resort: explicit credentials, if the site has been given them
    const siteID = process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) return getStore({ name: STORE, siteID, token });
    throw err;
  }
}

export const handler = async (event, context) => {
  const email = await whoIsCalling(event, context);
  if (!email) return json(401, { error: 'Sign in to use saved quotes.' });

  let store = null, storeError = null;
  try { store = openStore(event); } catch (err) { storeError = err; }

  if (event.queryStringParameters?.diag) return diagnose(email, store, storeError);

  if (!store) {
    return json(503, {
      error: 'Saved quotes storage is not available: ' + String(storeError?.message || storeError),
      code: 'blobs-unavailable'
    });
  }
  try {
    return await route(event, email, store);
  } catch (err) {
    return json(500, { error: String(err?.message || err) });
  }
};

/* /.netlify/functions/quotes?diag=1 — says in plain terms which half is broken */
async function diagnose(email, store, storeError) {
  const out = {
    signedInAs: email,
    node: process.version,
    site: process.env.SITE_NAME || null,
    url: process.env.URL || null,
    storage: { ok: false }
  };
  if (!store) {
    out.storage = {
      ok: false,
      error: String(storeError?.message || storeError),
      meaning: /has not been configured/i.test(String(storeError?.message))
        ? 'The function reached Netlify Blobs but was not given credentials for it.'
        : 'The function could not open the blob store.'
    };
    return json(200, out);
  }
  try {
    const { blobs } = await store.list();
    out.storage = { ok: true, store: STORE, savedQuotes: blobs.length };
  } catch (err) {
    out.storage = { ok: false, error: String(err?.message || err), meaning: 'The store exists but could not be read.' };
  }
  return json(200, out);
}

// separated from the handler so it can be exercised against a stub store
export async function route(event, email, store) {
  const id = event.queryStringParameters?.id;

  try {
    if (event.httpMethod === 'GET' && id) {
      const rec = await store.get(id, { type: 'json' });
      return rec ? json(200, rec) : json(404, { error: 'Not found' });
    }

    if (event.httpMethod === 'GET') {
      // metadata carries everything the list needs, so the bodies stay unread
      const { blobs } = await store.list();
      const rows = await Promise.all(blobs.map(async b => {
        try {
          const { metadata } = await store.getMetadata(b.key);
          return { id: b.key, ...(metadata || {}) };
        } catch {
          return { id: b.key };
        }
      }));
      return json(200, rows.filter(r => r.name));
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const name = (body.name || '').trim();
      if (!name) return json(400, { error: 'A legal entity name is required.' });

      const key = body.id && /^q_[A-Za-z0-9_]+$/.test(body.id)
        ? body.id
        : 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

      const existing = body.id ? await store.get(key, { type: 'json' }).catch(() => null) : null;
      const rec = {
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
      await store.setJSON(key, rec, {
        metadata: {
          name: rec.name, vertical: rec.vertical, price: rec.price,
          updatedAt: rec.updatedAt, updatedBy: rec.updatedBy
        }
      });
      return json(200, rec);
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return json(400, { error: 'No id given.' });
      await store.delete(id);
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    return json(500, { error: String(err?.message || err) });
  }
}
