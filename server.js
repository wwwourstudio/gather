// gather — local / self-hosted server. Serves public/ and the same /api/studio handler
// that runs on Vercel. Uses Upstash Redis if KV_REST_API_URL/TOKEN are set, else in-memory.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle } = require('./lib/studio');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
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
  let p = decodeURIComponent(u.pathname);
  if (p === '/' || p.startsWith('/s/')) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`gather studio → http://localhost:${PORT}`));
