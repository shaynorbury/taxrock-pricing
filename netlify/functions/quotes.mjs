import { getStore } from '@netlify/blobs';

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

export const handler = async (event, context) => {
  const email = await whoIsCalling(event, context);
  if (!email) return json(401, { error: 'Sign in to use saved quotes.' });
  try {
    return await route(event, email, getStore('taxrock-quotes'));
  } catch (err) {
    return json(500, { error: String(err?.message || err) });
  }
};

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
