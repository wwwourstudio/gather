// Built-in TURN: with CF_TURN_KEY_ID + CF_TURN_API_TOKEN set, joining a studio returns short-lived TURN
// credentials minted from Cloudflare (a local stand-in here), the API token never reaches the browser, port-53
// URLs are dropped, and a Cloudflare outage falls back to STUN instead of breaking joins.
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

let down = false, calls = 0, sawAuth = '';
const cf = http.createServer((req, res) => {
  calls++; sawAuth = req.headers.authorization || '';
  if (down) { res.writeHead(503); return res.end(); }
  if (!/\/turn\/keys\/key-123\/credentials\/generate-ice-servers$/.test(req.url) || req.method !== 'POST') { res.writeHead(404); return res.end(); }
  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u-abc', credential: 'c-xyz' }] }));
});

const post = (port, action, body) => fetch(`http://127.0.0.1:${port}/api/studio?action=${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const wait = (port) => new Promise((res, rej) => { const until = Date.now() + 10000; const t = () => fetch(`http://127.0.0.1:${port}/`).then(res).catch(() => (Date.now() > until ? rej(new Error('server did not start')) : setTimeout(t, 200))); t(); });

cf.listen(0, async () => {
  const port = 8097;
  const env = { ...process.env, PORT: String(port), ALLOW_ANON_STUDIOS: '1', CF_TURN_KEY_ID: 'key-123', CF_TURN_API_TOKEN: 'secret-token-456', CF_TURN_API: `http://127.0.0.1:${cf.address().port}` };
  for (const k of ['REDIS_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete env[k];
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'ignore' });
  let ok = true;
  const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) ok = false; };
  try {
    await wait(port);
    const cfg = await post(port, 'config', {});
    check('config reports built-in TURN without exposing secrets', cfg.builtInTurn === true && !JSON.stringify(cfg).includes('secret-token'));
    const a = await post(port, 'join', { name: 'Host', studio: 'gather-turntest01' });
    const turn = (a.iceServers || []).find((x) => x.username);
    check('join returns TURN credentials', !!turn && turn.username === 'u-abc' && turn.credential === 'c-xyz', JSON.stringify(a.iceServers));
    check('STUN is still offered', (a.iceServers || []).some((x) => [].concat(x.urls).some((u) => u.startsWith('stun:stun.l.google.com'))));
    check('port-53 TURN URLs are dropped', turn && !turn.urls.some((u) => /:53\?/.test(u)) && turn.urls.length === 2, JSON.stringify(turn?.urls));
    check('the API token goes only to Cloudflare, as a bearer token', sawAuth === 'Bearer secret-token-456' && !JSON.stringify(a).includes('secret-token'));
    await post(port, 'join', { name: 'Guest', studio: a.studio });
    check('credentials are cached (one Cloudflare call for two joins)', calls === 1, String(calls));
  } catch (e) { check('test ran', false, e.message); }
  srv.kill();
  // Cloudflare down: a fresh server falls back to STUN and joins still work
  down = true;
  const srv2 = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...env, PORT: String(port + 1) }, stdio: 'ignore' });
  try {
    await wait(port + 1);
    const b = await post(port + 1, 'join', { name: 'Host', studio: 'gather-turntest02' });
    check('a Cloudflare outage falls back to STUN, join still works', b.type === 'joined' && !(b.iceServers || []).some((x) => x.username));
  } catch (e) { check('fallback test ran', false, e.message); }
  srv2.kill(); cf.close();
  console.log(ok ? 'all TURN checks passed' : 'FAIL a TURN check did not hold');
  console.log('errors A', [], 'B', []);
  process.exit(ok ? 0 : 1);
});
