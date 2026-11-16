// The host seat (V5 audit): the person who opens a studio keeps it. Guests who arrive early wait instead of
// becoming host, a host who reloads or drops gets the seat back, a host who presses Leave hands it over for good,
// and the watch page stops saying "Live" once the host is gone. Also: a malformed URL can't crash the server.
const { spawn } = require('node:child_process');
const path = require('node:path');

const port = 8097;
const post = (action, body) => fetch(`http://127.0.0.1:${port}/api/studio?action=${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const wait = () => new Promise((res, rej) => { const until = Date.now() + 10000; const t = () => fetch(`http://127.0.0.1:${port}/`).then(res).catch(() => (Date.now() > until ? rej(new Error('server did not start')) : setTimeout(t, 200))); t(); });

const env = { ...process.env, PORT: String(port), ALLOW_ANON_STUDIOS: '1' };
for (const k of ['REDIS_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete env[k];
const srv = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'ignore' });
let ok = true;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) ok = false; };
const HOST = 'a'.repeat(24), GUEST = 'b'.repeat(24), GUEST2 = 'c'.repeat(24);

(async () => {
  try {
    await wait();
    const code = 'gather-seattest001';
    const early = await post('join', { studio: code, dev: GUEST, name: 'Early', intent: 'join' });
    check('a guest who arrives first waits instead of opening the studio', early.status === 404 && /hasn’t opened/.test(early.error || ''), `${early.status} ${early.error}`);

    const h = await post('join', { studio: code, dev: HOST, name: 'Host', intent: 'create' });
    check('the creator opens the studio as host', h.host === h.id);
    const g = await post('join', { studio: code, dev: GUEST, name: 'Guest', intent: 'join' });
    check('a guest joins as a guest', g.host === h.id && g.host !== g.id);

    // The host's tab reloads: the pagehide beacon leaves without "why", then the host joins again.
    await post('leave', { studio: code, id: h.id, tok: h.tok });
    const h2 = await post('join', { studio: code, dev: HOST, name: 'Host', intent: 'join' });
    check('a host who reloads gets the host seat back', h2.host === h2.id, `host=${h2.host} me=${h2.id}`);

    // Live, then the host presses Leave: the guest takes over for good and the watch page stops saying Live.
    await post('send', { studio: code, id: h2.id, tok: h2.tok, ops: [{ type: 'state', state: { live: { on: true, since: Date.now(), links: [{ kind: 'youtube', url: 'https://youtube.com/watch?v=abcdefghijk' }] } } }] });
    check('watch shows live while the host streams', (await post('watch', { studio: code })).live?.on === true);
    await post('leave', { studio: code, id: h2.id, tok: h2.tok, why: 'left' });
    const w = await post('watch', { studio: code });
    check('watch stops saying Live once the host leaves', !w.live?.on, JSON.stringify(w.live));
    const h3 = await post('join', { studio: code, dev: HOST, name: 'Host', intent: 'join' });
    check('a host who pressed Leave comes back as a guest', h3.host === g.id, `host=${h3.host}`);

    // A different guest can't take an empty studio either.
    const code2 = 'gather-seattest002';
    const o = await post('join', { studio: code2, dev: HOST, name: 'Owner', intent: 'create' });
    await post('leave', { studio: code2, id: o.id, tok: o.tok });
    const squat = await post('join', { studio: code2, dev: GUEST2, name: 'Squatter', intent: 'join' });
    check('nobody else can open an emptied studio from its link', squat.status === 404, String(squat.status));

    // Knocks are throttled per device, so one script can't flood the host's waiting room.
    const k1 = await post('knock', { studio: code2.replace('002', '001'), dev: 'd'.repeat(24), name: 'K' });
    const k2 = await post('knock', { studio: code2.replace('002', '001'), dev: 'd'.repeat(24), name: 'K' });
    check('a second knock from the same device right away is refused', !!k1.id && k2.status === 429, `${k1.status} ${k2.status}`);

    const bad = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
    const still = await fetch(`http://127.0.0.1:${port}/`);
    check('a malformed URL gets 400 and the server keeps running', bad.status === 400 && still.ok, `${bad.status} ${still.status}`);
  } catch (e) { check('suite ran', false, e.stack); }
  srv.kill();
  process.exit(ok ? 0 : 1);
})();
