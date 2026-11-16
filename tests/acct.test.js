// Accounts and starting studios: a new studio needs a signed-in host, guests join without an account, and
// Google sign-in (checked against a local stand-in for Google's token check) creates or links an account.
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const CID = 'test-client.apps.googleusercontent.com';
const people = { good: { sub: '1001', email: 'gee@example.com', given_name: 'Gee' }, link: { sub: '1002', email: 'pat@example.com', given_name: 'Pat' } };
// a stand-in for Google's tokeninfo (checks an access token) and userinfo (the profile behind it)
const google = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const t = u.pathname === '/userinfo' ? String(req.headers.authorization || '').replace(/^Bearer /, '') : u.searchParams.get('access_token');
  const p = people[t];
  if (!p && t !== 'wrong-aud') { res.writeHead(400); return res.end('{}'); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (u.pathname === '/userinfo') return p ? res.end(JSON.stringify({ sub: p.sub, name: p.given_name + ' Example', given_name: p.given_name, email: p.email })) : res.end('{}');
  res.end(JSON.stringify({ aud: t === 'wrong-aud' ? 'someone-else' : CID, azp: t === 'wrong-aud' ? 'someone-else' : CID, scope: 'openid email profile', exp: String(Math.floor(Date.now() / 1000) + 3600), email_verified: 'true', sub: (p || { sub: '9' }).sub, email: (p || { email: 'x@example.com' }).email }));
});
const post = (port, api, action, body, token) => fetch(`http://127.0.0.1:${port}/api/${api}?action=${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const wait = (port) => new Promise((res, rej) => { const until = Date.now() + 10000; const t = () => fetch(`http://127.0.0.1:${port}/`).then(res).catch(() => (Date.now() > until ? rej(new Error('server did not start')) : setTimeout(t, 200))); t(); });

google.listen(0, async () => {
  const port = 8096;
  const env = { ...process.env, PORT: String(port), GOOGLE_CLIENT_ID: CID, GOOGLE_TOKENINFO_URL: `http://127.0.0.1:${google.address().port}/tokeninfo`, GOOGLE_USERINFO_URL: `http://127.0.0.1:${google.address().port}/userinfo` };
  for (const k of ['REDIS_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'ALLOW_ANON_STUDIOS']) delete env[k];
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'ignore' });
  let ok = true;
  const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) ok = false; };
  try {
    await wait(port);
    const cfg = await post(port, 'studio', 'config', {});
    check('config says starting a studio needs an account', cfg.requireAccount === true);
    const anon = await post(port, 'studio', 'join', { studio: 'gather-accttest01', name: 'Nobody' });
    check('a new studio without an account is refused', anon.status === 401 && /Sign in/.test(anon.error), `${anon.status} ${anon.error}`);
    const noAgree = await post(port, 'account', 'signup', { email: 'host@example.com', password: 'correct horse', name: 'Host' });
    check('signing up without agreeing to the terms is refused', noAgree.status === 400 && /Terms/.test(noAgree.error), noAgree.error);
    const up = await post(port, 'account', 'signup', { email: 'host@example.com', password: 'correct horse', name: 'Host', agree: true });
    const host = await post(port, 'studio', 'join', { studio: 'gather-accttest01', name: 'Host', acct: up.token });
    check('a signed-in host can start it', host.type === 'joined', JSON.stringify(host).slice(0, 80));
    const guest = await post(port, 'studio', 'join', { studio: 'gather-accttest01', name: 'Guest' });
    check('a guest joins without an account', guest.type === 'joined');
    const g0 = await post(port, 'account', 'google', { accessToken: 'good' });
    check('a new Google account also needs the terms agreed', g0.status === 400 && /Terms/.test(g0.error), g0.error);
    const g1 = await post(port, 'account', 'google', { accessToken: 'good', agree: true });
    check('Google sign-in creates an account', g1.status === 200 && g1.created === true && g1.user?.email === 'gee@example.com' && g1.user?.name === 'Gee' && !!g1.token, JSON.stringify(g1).slice(0, 120));
    const g2 = await post(port, 'account', 'google', { accessToken: 'good' });
    check('signing in again finds the same account', g2.created === false && g2.user?.id === g1.user?.id);
    const pat = await post(port, 'account', 'signup', { email: 'pat@example.com', password: 'correct horse', name: 'Pat', agree: true });
    const g3 = await post(port, 'account', 'google', { accessToken: 'link' });
    check('Google links to an existing account with the same email', g3.user?.id === pat.user?.id && g3.created === false);
    // Sign-up doesn't verify email, so whoever registered it first may not own it: once Google proves the real
    // owner, the earlier password and its sessions stop working (no pre-account takeover).
    const oldPass = await post(port, 'account', 'login', { email: 'pat@example.com', password: 'correct horse' });
    const oldSess = await post(port, 'account', 'me', {}, pat.token);
    check('linking Google retires the unverified password and its sessions', oldPass.status === 401 && oldSess.status === 401, `${oldPass.status} ${oldSess.status}`);
    const bad = await post(port, 'account', 'google', { accessToken: 'wrong-aud', agree: true });
    check('a token issued for another site is refused', bad.status === 401, `${bad.status} ${bad.error}`);
    const junk = await post(port, 'account', 'google', { accessToken: 'nope', agree: true });
    check('an invalid token is refused', junk.status === 401);
    const me = await post(port, 'account', 'me', {}, g1.token);
    check('the Google session works like any other', me.user?.email === 'gee@example.com');
    const del = await post(port, 'account', 'delete', { password: 'gee@example.com' }, g1.token);
    check('a Google-only account deletes by confirming its email', del.ok === true, JSON.stringify(del));
    check('a Google account reports it has no password', me.user?.hasPassword === false);
  } catch (e) { check('test ran', false, e.message); }
  srv.kill(); google.close();
  console.log(ok ? 'all account checks passed' : 'FAIL an account check did not hold');
  console.log('errors A', [], 'B', []);
  process.exit(ok ? 0 : 1);
});
