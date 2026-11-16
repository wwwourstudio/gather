// gather relay: takes the finished program from a host's browser over a WebSocket and sends it to YouTube,
// Twitch, Kick, Facebook or any RTMP(S) server, to several at once. Platforms only accept RTMP(S), which a
// browser can't send, so this small FFmpeg service sits in between.
//
//   RELAY_SECRET=… node server.js           # same secret as in Vercel; see README.md
//
// Only gather can start a stream: the browser presents a short-lived token signed with RELAY_SECRET, issued by
// gather's server to the studio's host. Stream keys pass through to FFmpeg and are never logged.
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');

const SECRET = process.env.RELAY_SECRET || '';
const PORT = Number(process.env.PORT) || 8080;
const MAX = Number(process.env.RELAY_MAX_STREAMS) || 3;
const TRANSCODE = process.env.RELAY_TRANSCODE || 'auto'; // auto: copy H.264 from the browser; always: re-encode
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
if (!SECRET || SECRET.length < 24) { console.error('Set RELAY_SECRET (24+ characters, the same value as in gather’s Vercel settings).'); process.exit(1); }

const b64u = (b) => Buffer.from(b).toString('base64url');
/** Token: base64url(JSON {s: studio, e: expiry ms}) + '.' + HMAC-SHA256. Returns the payload or null. */
function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p && p.e > Date.now() && typeof p.s === 'string' ? p : null; } catch { return null; }
}

/** One destination: rtmp(s)://host[:port]/app + stream key. Characters that would break FFmpeg's tee syntax are refused. */
function target(d) {
  const url = String(d?.url || '').trim().replace(/\/+$/, ''), key = String(d?.key || '').trim();
  if (!/^rtmps?:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s|[\]]*)?$/i.test(url) || /[\s|[\]]/.test(key) || key.length > 400) return null;
  return key ? `${url}/${key}` : url;
}
// Hide everything after the app path: a key containing '/' must not leak its first part (rtmp://host/app/•••).
const redact = (s) => String(s).replace(/rtmps?:\/\/[^\s'"]+/gi, (u) => { const m = u.match(/^(rtmps?:\/\/[^/]+(?:\/[^/]+)?)/i); return (m ? m[1] : u) + '/•••'; });
/** FFmpeg's error line, in words a host understands. */
function plain(line) {
  if (/refused/i.test(line)) return 'the connection was refused';
  if (/timed out|timeout/i.test(line)) return 'the server didn’t answer';
  if (/40[13]|denied|unauthori[sz]ed|forbidden/i.test(line)) return 'the platform rejected the stream key';
  if (/resolve|not known|no such host/i.test(line)) return 'that server address doesn’t exist';
  return 'the connection failed';
}

let live = 0;
const used = new Map(); // token nonce → expiry: tokens are single-use
const studios = new Map(); // studio → its open socket: one stream per studio
const releaseStudio = (s, ws) => { if (studios.get(s) === ws) studios.delete(s); };
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, live, max: MAX })); }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://relay');
  const claim = u.pathname === '/live' ? verify(u.searchParams.get('t')) : null;
  if (!claim) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
  if (live >= MAX) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
  // Each token works once, and each studio streams once at a time, so a leaked token can't fill the relay.
  if (used.has(claim.n || u.searchParams.get('t'))) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
  if (studios.has(claim.s)) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
  used.set(claim.n || u.searchParams.get('t'), claim.e);
  for (const [k, e] of used) if (e < Date.now()) used.delete(k);
  wss.handleUpgrade(req, socket, head, (ws) => { studios.set(claim.s, ws); run(ws, claim); });
});

function run(ws, claim) {
  live++;
  const say = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  let ff = null, started = false, ended = false, queued = 0, bytesIn = 0, failed = new Set(), dests = [];
  // A session that starts and then sends nothing would hold a relay slot for ever: end it after 30 s of silence.
  let idle = null;
  const kick = () => { clearTimeout(idle); idle = setTimeout(() => { say({ t: 'error', message: 'The stream went quiet, so the relay stopped it.' }); ws.close(4003); }, 30000); };
  const finish = (why) => {
    if (ended) return; ended = true; live--;
    clearTimeout(firstMsg); clearTimeout(idle);
    releaseStudio(claim.s, ws);
    if (ff) { try { ff.stdin.end(); } catch {} setTimeout(() => ff && ff.kill('SIGKILL'), 5000).unref(); }
    console.log(`[relay] ${claim.s} ended: ${why}`);
  };
  const firstMsg = setTimeout(() => { say({ t: 'error', message: 'No stream arrived.' }); ws.close(4000); }, 15000);
  ws.on('message', (data, isBinary) => {
    if (!ff) {
      if (isBinary) return;
      let m; try { m = JSON.parse(String(data)); } catch { return; }
      if (m.type !== 'start') return;
      dests = (Array.isArray(m.dests) ? m.dests : []).slice(0, 6).map(target);
      if (!dests.length || dests.some((x) => !x)) { say({ t: 'error', message: 'Check the server URLs and stream keys: each needs an rtmp:// or rtmps:// address.' }); return ws.close(4001); }
      clearTimeout(firstMsg); kick();
      const copy = m.video === 'h264' && TRANSCODE !== 'always';
      const v = copy ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', '4500k', '-maxrate', '4500k', '-bufsize', '9000k', '-g', '60', '-pix_fmt', 'yuv420p'];
      const out = dests.length === 1 ? ['-f', 'flv', dests[0]] : ['-f', 'tee', dests.map((x) => `[f=flv:onfail=ignore]${x}`).join('|')];
      const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-fflags', '+genpts', '-probesize', '1000000', '-analyzeduration', '1000000', '-thread_queue_size', '1024', '-i', 'pipe:0',
        '-map', '0:v:0', '-map', '0:a:0?', ...v, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', ...out];
      ff = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      console.log(`[relay] ${claim.s} start → ${dests.length} destination(s), video ${copy ? 'copied' : 're-encoded'}`);
      let errBuf = '';
      ff.stderr.on('data', (d) => {
        errBuf += d;
        const parts = errBuf.split(/[\r\n]/); errBuf = parts.pop();
        for (const line of parts) {
          if (/\btime=\d/.test(line)) { // progress line; with several destinations size and bitrate read N/A
            const num = (k) => { const m = line.match(new RegExp(k + '=\\s*([\\d.]+)')); return m ? +m[1] : null; };
            if (!started) { started = true; say({ t: 'live' }); dests.forEach((_, i) => { if (!failed.has(i)) say({ t: 'dest', i, state: 'live' }); }); }
            const time = line.match(/time=(\S+)/)[1];
            const [hh, mm, ss] = time.split(':').map(Number), secs = hh * 3600 + mm * 60 + ss;
            say({ t: 'stats', frame: num('frame'), fps: num('fps'), time, kbps: num('bitrate') ?? (secs > 0 ? Math.round(bytesIn * 8 / 1000 / secs) : null), speed: num('speed') });
          }
          else if (line.trim()) {
            const msg = redact(line.trim()).slice(0, 300); console.warn(`[relay] ${claim.s}: ${msg}`);
            if (!/error|refused|failed|denied|timed out/i.test(msg)) continue;
            // Which destination failed? Match the (redacted) address in FFmpeg's line; with one destination it's that one.
            const hit = dests.length === 1 ? [0] : dests.map((d, i) => (msg.includes(redact(d)) ? i : -1)).filter((i) => i >= 0);
            if (hit.length) for (const i of hit) { if (!failed.has(i)) { failed.add(i); say({ t: 'dest', i, state: 'failed', reason: plain(msg) }); } }
            else say({ t: 'warn', message: plain(msg) });
          }
        }
      });
      ff.stdin.on('error', () => {});
      ff.stdin.on('drain', () => { queued = 0; });
      ff.on('exit', (code) => { say({ t: 'ended', code }); finish(`ffmpeg exited ${code}`); ws.close(1000); });
      say({ t: 'ready', copy });
      return;
    }
    if (!isBinary || ended) return;
    bytesIn += data.length; kick();
    if (!ff.stdin.write(data)) {
      queued += data.length;
      if (queued > 64 * 1024 * 1024) { say({ t: 'error', message: 'The relay can’t keep up with this stream.' }); ws.close(4002); }
    }
  });
  ws.on('close', () => finish('browser closed'));
  ws.on('error', () => finish('socket error'));
}

server.listen(PORT, () => console.log(`gather relay on :${PORT} (max ${MAX} streams, ${TRANSCODE === 'always' ? 're-encoding' : 'copying H.264 when possible'})`));
module.exports = { verify, target, b64u };
