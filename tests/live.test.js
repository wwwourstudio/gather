// Going live, end to end: a host's browser streams the program to the gather relay (relay/server.js), which
// sends it to two RTMP servers at once (local FFmpeg listeners standing in for YouTube and Twitch). Both must
// receive real H.264 video and AAC audio. Also: the relay refuses missing or forged tokens, guests can't get a
// token, and stream keys never reach gather's server.
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SECRET = crypto.randomBytes(24).toString('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-live-'));
const GATHER = 8099, RELAY = 8098, RTMP = [19351, 19352];
const procs = [];
const start = (cmd, args, env = {}) => { const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] }); p.log = ''; p.stderr.on('data', (d) => { p.log += d; }); procs.push(p); return p; };
const up = (url) => new Promise((res, rej) => { const until = Date.now() + 15000; const t = () => fetch(url).then(res).catch(() => (Date.now() > until ? rej(new Error('not up: ' + url)) : setTimeout(t, 200))); t(); });
const exited = (p, ms) => new Promise((res) => { if (p.exitCode != null) return res(true); const t = setTimeout(() => res(false), ms); p.on('exit', () => { clearTimeout(t); res(true); }); });
let ok = true;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) ok = false; };

(async () => {
  const sinks = RTMP.map((port, i) => ({ port, key: `key-${i ? 'twitch' : 'youtube'}-${crypto.randomBytes(4).toString('hex')}`, file: path.join(TMP, `out${i}.flv`) }));
  for (const s of sinks) s.proc = start('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-listen', '1', '-i', `rtmp://127.0.0.1:${s.port}/live/${s.key}`, '-c', 'copy', s.file]);
  const relay = start(process.execPath, ['relay/server.js'], { PORT: String(RELAY), RELAY_SECRET: SECRET });
  const env = { PORT: String(GATHER), ALLOW_ANON_STUDIOS: '1', RELAY_URL: `http://127.0.0.1:${RELAY}`, RELAY_SECRET: SECRET };
  for (const k of ['REDIS_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) env[k] = '';
  const gather = start(process.execPath, ['server.js'], env);
  await up(`http://127.0.0.1:${RELAY}/health`); await up(`http://127.0.0.1:${GATHER}/`);

  // the relay only opens for gather-signed tokens
  const tryWs = (q) => new Promise((res) => { const ws = new WebSocket(`ws://127.0.0.1:${RELAY}/live${q}`); ws.onopen = () => { ws.close(); res('open'); }; ws.onerror = () => res('refused'); });
  const forged = Buffer.from(JSON.stringify({ s: 'x', e: Date.now() + 60000 })).toString('base64url') + '.' + crypto.createHmac('sha256', 'not-the-secret-xxxxxxxxxxxx').update('x').digest('base64url');
  check('relay refuses no token and a forged token', (await tryWs('')) === 'refused' && (await tryWs('?t=' + forged)) === 'refused');

  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p = await c.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); return p; };
  const a = await mk(), b = await mk();
  const toGather = [];
  a.on('request', (r) => { if (r.url().includes(`:${GATHER}/api/`)) toGather.push(r.postData() || ''); });
  const B = `http://127.0.0.1:${GATHER}`;
  await a.goto(B + '/'); await a.click('#enterStage'); await a.fill('#enterName', 'Host'); await a.click('#enterGo');
  await a.waitForSelector('#inviteDlg[open]'); const code = await a.textContent('#inviteCode'); await a.keyboard.press('Escape');
  await b.goto(B + '/s/' + code); await b.waitForSelector('#enterDlg[open]'); await b.fill('#enterName', 'Guest'); await b.click('#enterGo');
  await b.waitForFunction(() => !!window.__gather.studio, null, { timeout: 12000 });
  const guestTry = await b.evaluate(async () => { const g = window.__gather; const r = await fetch('/api/studio?action=relay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studio: g.studio, id: g.id, tok: g.tok }) }); return r.status; });
  check('a guest cannot get a relay token', guestTry === 403, String(guestTry));
  check('guests don’t see the Go live button', await b.isHidden('#liveTop'));

  // two destinations: YouTube (server URL edited to the local stand-in) and a custom RTMP server
  await a.click('#liveTop');
  await a.selectOption('#destAdd', 'youtube');
  await a.fill('#destList li:nth-child(1) [data-k="url"]', `rtmp://127.0.0.1:${sinks[0].port}/live`); await a.press('#destList li:nth-child(1) [data-k="url"]', 'Tab');
  await a.fill('#destList li:nth-child(1) [data-k="key"]', sinks[0].key); await a.press('#destList li:nth-child(1) [data-k="key"]', 'Tab');
  await a.selectOption('#destAdd', 'custom');
  await a.fill('#destList li:nth-child(2) [data-k="url"]', `rtmp://127.0.0.1:${sinks[1].port}/live`); await a.press('#destList li:nth-child(2) [data-k="url"]', 'Tab');
  await a.fill('#destList li:nth-child(2) [data-k="key"]', sinks[1].key); await a.press('#destList li:nth-child(2) [data-k="key"]', 'Tab');
  await a.fill('#destList li:nth-child(1) [data-k="watch"]', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'); await a.press('#destList li:nth-child(1) [data-k="watch"]', 'Tab');
  await a.fill('#destList li:nth-child(2) [data-k="watch"]', 'https://www.twitch.tv/gathershow'); await a.press('#destList li:nth-child(2) [data-k="watch"]', 'Tab');
  const w = await mk();
  // The watch page shows the studio directly (WebRTC from the host) even before going live on any platform.
  await w.goto(B + '/w/' + code);
  const directBefore = await w.waitForFunction(() => document.querySelector('#wDirect')?.videoWidth > 0 && document.getElementById('wLiveText').textContent === 'On air', null, { timeout: 30000 }).then(() => true).catch(() => false);
  check('watch page before the show: plays the studio directly, "On air", not "Live"', directBefore);
  console.log('  button reads:', await a.textContent('#liveBtn'));
  await a.click('#liveBtn');
  await a.waitForFunction(() => window.__gather.live?.phase === 'live', null, { timeout: 20000 });
  const codecPath = await a.evaluate(() => (MediaRecorder.isTypeSupported('video/webm;codecs=h264,opus') ? 'H.264 passed through' : 'VP8 re-encoded by the relay'));
  console.log('  live; video path:', codecPath);
  await a.waitForTimeout(7000);
  console.log('  stats:', await a.textContent('#liveStats'), '| header:', await a.textContent('#liveTop'));
  await a.screenshot({ path: path.join(process.argv[2] || TMP, 'live-on-air.png') });
  await w.waitForFunction(() => /^Live · /.test(document.getElementById('wLiveText').textContent), null, { timeout: 8000 }).catch(() => {});
  const tabs = await w.evaluate(() => [...document.querySelectorAll('#wTabs button')].map((b) => b.textContent));
  await w.click('#wTabs button:has-text("YouTube")'); await w.waitForSelector('#wPlayer iframe', { timeout: 8000 });
  const src = await w.getAttribute('#wPlayer iframe', 'src');
  check('watch page offers direct plus both platforms, and plays YouTube when picked', src.startsWith('https://www.youtube.com/embed/dQw4w9WgXcQ') && tabs.length === 3 && /Direct/.test(tabs[0]) && await w.isVisible('#wLive'), `${src} | ${tabs.join(', ')}`);
  await w.screenshot({ path: path.join(process.argv[2] || TMP, 'live-watch-page.png') });
  const keyOnWatch = await w.evaluate(async (c) => JSON.stringify(await (await fetch('/api/studio?action=watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studio: c }) })).json()), code);
  const feedOnWatch = await w.evaluate(async (c) => JSON.stringify(await (await fetch('/api/studio?action=wfeed&studio=' + c)).json()), code);
  check('the public watch info and feed have no stream keys', !sinks.some((x) => keyOnWatch.includes(x.key) || feedOnWatch.includes(x.key)));
  await a.click('#liveBtn');
  await a.waitForFunction(() => !window.__gather.live, null, { timeout: 10000 });
  for (const s of sinks) await exited(s.proc, 10000);
  const notLive = await w.waitForFunction(() => !/^Live · /.test(document.getElementById('wLiveText').textContent), null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('watch page after the show: no longer "Live" on the platforms', notLive);
  for (const [i, s] of sinks.entries()) {
    let info = {};
    try { info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', s.file]).toString()); } catch (e) { info = { error: e.message.slice(0, 120) }; }
    const v = info.streams?.find((x) => x.codec_type === 'video'), au = info.streams?.find((x) => x.codec_type === 'audio'), dur = Number(info.format?.duration || 0);
    check(`destination ${i + 1} received H.264 video and AAC audio (${dur.toFixed(1)} s)`, v?.codec_name === 'h264' && au?.codec_name === 'aac' && dur > 4, JSON.stringify(info).slice(0, 200));
  }
  const leaked = toGather.some((body) => sinks.some((s) => body.includes(s.key)));
  check('stream keys never reach gather’s server', !leaked);
  check('relay log never shows a stream key', !sinks.some((s) => relay.log.includes(s.key)));
  console.log('errors A', a.errs, 'B', b.errs, 'W', w.errs);
  await browser.close();
  console.log(ok ? 'all live checks passed' : 'FAIL a live check did not hold');
})().catch((e) => { console.log('FAIL', e.message.split('\n').slice(0, 4).join(' | ')); console.log('relay log:', procs[2]?.log.slice(-1500)); console.log('sink log:', procs[0]?.log.slice(-600)); ok = false; })
  .finally(() => { for (const p of procs) try { p.kill(); } catch {} fs.rmSync(TMP, { recursive: true, force: true }); setTimeout(() => process.exit(ok ? 0 : 1), 300); });
