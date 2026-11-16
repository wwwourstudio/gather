// Vercel serverless entry: POST /api/account?action=…  (accounts + scheduled streams)
const { handleAccount, authUser, mailOrigin } = require('../lib/accounts');
const { streamActions, STREAM_PUBLIC } = require('../lib/streams');

function originOf(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (String(host).startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** The caller's address. On Vercel the platform sets these headers itself; elsewhere it's the socket's address. */
function ipOf(req) {
  const h = req.headers || {};
  return String(h['x-vercel-forwarded-for'] || h['x-real-ip'] || (process.env.VERCEL ? String(h['x-forwarded-for'] || '').split(',')[0] : '') || req.socket?.remoteAddress || '').trim().slice(0, 64);
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
  const origin = originOf(req);
  // Links in emails only ever use the configured address; a local dev server may use its own localhost address.
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && !process.env.VERCEL;
  const ctx = { token: auth.startsWith('Bearer ') ? auth.slice(7) : '', origin, mailOrigin: mailOrigin() || (local ? origin : ''), ip: ipOf(req) };
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
module.exports.ipOf = ipOf;
