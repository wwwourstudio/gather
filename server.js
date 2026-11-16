// gather — local / self-hosted server. Serves public/ and the same /api/studio handler
// that runs on Vercel. Uses Upstash Redis if KV_REST_API_URL/TOKEN are set, else in-memory.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle } = require('./lib/studio');
const { handleAI } = require('./lib/ai');
const accountHandler = require('./api/account');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm', '.webp': 'image/webp' };

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/ai' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 512 * 1024) req.destroy(); });
    req.on('end', () => { let body = {}; try { body = JSON.parse(raw || '{}'); } catch {} handleAI(req, res, body); });
    return;
  }
  if (u.pathname === '/api/account' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { req.body = JSON.parse(raw || '{}'); } catch { req.body = {}; } req.query = Object.fromEntries(u.searchParams); accountHandler(req, res); });
    return;
  }
  if (u.pathname === '/api/studio') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 256 * 1024) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {}
      try { json(res, 200, await handle(u.searchParams.get('action'), body)); }
      catch (e) { if (!e.status) console.error(e); json(res, e.status || 500, { error: e.status ? e.message : `The studio server hit an error: ${e.message}` }); }
    });
    return;
  }
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  if (p === '/' || p.startsWith('/s/') || p.startsWith('/c/')) p = '/index.html';
  else if (p.startsWith('/w/')) p = '/watch.html';
  else if (p === '/privacy' || p === '/terms') p += '.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`gather studio → http://localhost:${PORT}`));
// One bad request must never drop every studio on a self-hosted server: log and keep serving.
process.on('uncaughtException', (e) => console.error('Uncaught error (server kept running):', e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection (server kept running):', e));
