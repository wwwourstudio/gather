// Vercel serverless entry: POST /api/account?action=…  (accounts + scheduled streams)
const { handleAccount, authUser } = require('../lib/accounts');
const { streamActions, STREAM_PUBLIC } = require('../lib/streams');

function originOf(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (String(host).startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

async function route(action, body, ctx) {
  if (streamActions[action]) {
    const user = STREAM_PUBLIC.has(action) ? null : await authUser(ctx.token);
    return streamActions[action](body, user, ctx);
  }
  return handleAccount(action, body, ctx);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = String(req.query?.action || new URL(req.url, 'http://x').searchParams.get('action') || '');
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
  const auth = String(req.headers.authorization || '');
  const ctx = { token: auth.startsWith('Bearer ') ? auth.slice(7) : '', origin: originOf(req) };
  try {
    const out = await route(action, body || {}, ctx);
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(out));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[gather account]', action, e);
    res.statusCode = status; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: status === 500 ? `Something went wrong: ${e.message}` : e.message }));
  }
}
module.exports = handler;
module.exports.route = route;
module.exports.originOf = originOf;
