// gather studio logic — stateless request handler over a Redis-like store.
// Runs identically in `node server.js` (in-memory store) and on Vercel (Upstash Redis).
//
// Each member polls their own inbox list. The inbox key embeds a secret token, so only that
// member can read it; every other action is authenticated against the stored token.
const crypto = require('crypto');
const { store } = require('./store');

const MAX = 6;
const STALE_MS = 20_000; // a member who hasn't heartbeated in this long is removed
const TTL = 6 * 3600; // idle studios disappear after 6 hours

const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URL) ICE.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER, credential: process.env.TURN_PASS });

const K = (code) => ({
  members: `g:${code}:m`, host: `g:${code}:host`, state: `g:${code}:state`, chat: `g:${code}:chat`,
  inbox: (id, tok) => `g:${code}:in:${id}:${tok}`,
});
const rid = (n) => crypto.randomBytes(n).toString('hex');
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const cleanCode = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
const pub = (m) => ({ id: m.id, name: m.name, mic: m.mic, cam: m.cam, sharing: m.sharing, joinedAt: m.joinedAt });
const parse = (s, d = null) => { if (s == null) return d; if (typeof s === 'object') return s; try { return JSON.parse(s); } catch { return d; } };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function defaultState(hostId) {
  return { layout: 'split', stage: [hostId], banner: null, ticker: '', brand: { color: '#1f6feb', bg: 'dusk', logo: '', watermark: true, names: true }, title: '' };
}
// Only accept known fields from the host so one client can't corrupt the room.
function sanitizeState(prev, next, memberIds) {
  const s = structuredClone(prev);
  if (['solo', 'split', 'spotlight'].includes(next.layout)) s.layout = next.layout;
  if (Array.isArray(next.stage)) s.stage = [...new Set(next.stage.filter((id) => memberIds.has(id)))].slice(0, MAX);
  if ('banner' in next) s.banner = next.banner && next.banner.text ? { id: clean(next.banner.id, 40), text: clean(next.banner.text, 120), sub: clean(next.banner.sub, 120) } : null;
  if ('ticker' in next) s.ticker = clean(next.ticker, 200);
  if ('title' in next) s.title = clean(next.title, 60);
  if (next.brand && typeof next.brand === 'object') {
    const b = next.brand;
    if (/^#[0-9a-f]{6}$/i.test(b.color)) s.brand.color = b.color;
    if (['dusk', 'ember', 'forest', 'graphite', 'paper'].includes(b.bg)) s.brand.bg = b.bg;
    if ('logo' in b) s.brand.logo = clean(b.logo, 24);
    if ('watermark' in b) s.brand.watermark = !!b.watermark;
    if ('names' in b) s.brand.names = !!b.names;
  }
  return s;
}

async function loadMembers(code) {
  const [flat] = await store.pipe([['HGETALL', K(code).members]]);
  const map = new Map();
  for (let i = 0; i < (flat || []).length; i += 2) { const m = parse(flat[i + 1]); if (m) map.set(flat[i], m); }
  return map;
}
/** Push one message to many members' inboxes in a single round trip. */
async function deliver(code, members, msg, exceptId) {
  const k = K(code), body = JSON.stringify(msg), cmds = [];
  for (const m of members.values()) {
    if (m.id === exceptId) continue;
    cmds.push(['RPUSH', k.inbox(m.id, m.tok), body], ['EXPIRE', k.inbox(m.id, m.tok), TTL]);
  }
  await store.pipe(cmds);
}
function touch(code) {
  const k = K(code);
  return [['EXPIRE', k.members, TTL], ['EXPIRE', k.host, TTL], ['EXPIRE', k.state, TTL], ['EXPIRE', k.chat, TTL]];
}

/** Remove a member, hand off hosting if needed, and tell everyone. */
async function removeMember(code, id, members) {
  const k = K(code);
  const gone = members.get(id);
  const [deleted] = await store.pipe([['HDEL', k.members, id]]);
  if (!deleted) return; // someone else already removed them
  members.delete(id);
  if (gone) await store.pipe([['DEL', k.inbox(id, gone.tok)]]);
  if (!members.size) { await store.pipe([['DEL', k.members, k.host, k.state, k.chat]]); return; }
  let [host, state] = await store.pipe([['GET', k.host], ['GET', k.state]]);
  state = parse(state) || defaultState(host);
  if (!members.has(host)) host = [...members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0].id;
  state.stage = state.stage.filter((x) => members.has(x));
  if (!state.stage.length) state.stage = [host];
  await store.pipe([['SET', k.host, host, 'EX', TTL], ['SET', k.state, JSON.stringify(state), 'EX', TTL]]);
  await deliver(code, members, { type: 'peer-left', id, host, state });
}
async function sweep(code, members) {
  const now = Date.now();
  for (const m of [...members.values()]) if (now - m.seen > STALE_MS) await removeMember(code, m.id, members);
}
async function auth(body) {
  const code = cleanCode(body.studio);
  if (!code || !body.id || !body.tok) throw new HttpError(400, 'Missing studio credentials.');
  const members = await loadMembers(code);
  const me = members.get(String(body.id));
  if (!me || me.tok !== body.tok) throw new HttpError(410, 'You are no longer in this studio.');
  return { code, members, me };
}

// ------------------------------------------------------------------ actions
const actions = {
  config() {
    return { iceServers: ICE, max: MAX, storage: store.kind, ready: !(process.env.VERCEL && store.kind === 'memory') };
  },

  async join(body) {
    if (process.env.VERCEL && store.kind === 'memory') {
      throw new HttpError(503, 'Studio storage is not set up. In your Vercel project, open Storage, add Upstash Redis, connect it, then redeploy.');
    }
    const code = cleanCode(body.studio);
    if (!code) throw new HttpError(400, 'Studio codes use letters, numbers and dashes.');
    const k = K(code);
    const members = await loadMembers(code);
    await sweep(code, members);
    if (members.size >= MAX) throw new HttpError(409, `This studio is full (${MAX} people).`);

    const me = { id: rid(4), tok: rid(12), name: clean(body.name, 24) || 'Guest', mic: body.mic !== false, cam: body.cam !== false, sharing: false, joinedAt: Date.now(), seen: Date.now() };
    const [claimed] = await store.pipe([['SET', k.host, me.id, 'NX', 'EX', TTL]]);
    let host = me.id, state;
    if (claimed) {
      state = defaultState(me.id);
    } else {
      let [h, st] = await store.pipe([['GET', k.host], ['GET', k.state]]);
      host = members.has(h) ? h : me.id;
      state = parse(st) || defaultState(host);
    }
    if (host === me.id && !state.stage.includes(me.id)) state.stage = [me.id, ...state.stage.filter((x) => members.has(x))];
    const [, , , history] = await store.pipe([
      ['HSET', k.members, me.id, JSON.stringify(me)],
      ['SET', k.host, host, 'EX', TTL],
      ['SET', k.state, JSON.stringify(state), 'EX', TTL],
      ['LRANGE', k.chat, 0, -1],
      ...touch(code),
    ]);
    await deliver(code, members, { type: 'peer-joined', peer: pub(me) });
    return {
      type: 'joined', id: me.id, tok: me.tok, studio: code, host, state,
      peers: [...members.values()].map(pub),
      history: (history || []).map((h) => parse(h)).filter(Boolean),
      iceServers: ICE,
    };
  },

  /** Read (and clear) my inbox. `beat` also refreshes presence and sweeps out stale members. */
  async poll(body) {
    const code = cleanCode(body.studio);
    if (!code || !body.id || !body.tok) throw new HttpError(400, 'Missing studio credentials.');
    if (body.beat) {
      const { members, me } = await auth(body);
      me.seen = Date.now();
      await store.pipe([['HSET', K(code).members, me.id, JSON.stringify(me)], ...touch(code)]);
      await sweep(code, members);
    }
    const [msgs] = await store.pipe([['LPOP', K(code).inbox(String(body.id), String(body.tok)), 200]]);
    return { msgs: (Array.isArray(msgs) ? msgs : msgs ? [msgs] : []).map((m) => parse(m)).filter(Boolean) };
  },

  /** Apply a batch of outgoing messages: signal / chat / meta / state / recording. */
  async send(body) {
    const { code, members, me } = await auth(body);
    const k = K(code);
    const results = [];
    for (const op of (Array.isArray(body.ops) ? body.ops : []).slice(0, 100)) {
      switch (op.type) {
        case 'signal': {
          const to = members.get(String(op.to));
          if (to) await store.pipe([['RPUSH', k.inbox(to.id, to.tok), JSON.stringify({ type: 'signal', from: me.id, data: op.data })], ['EXPIRE', k.inbox(to.id, to.tok), TTL]]);
          break;
        }
        case 'chat': {
          const text = clean(op.text, 1000);
          if (!text) break;
          const msg = { id: rid(4), from: me.id, name: me.name, text, ts: Date.now() };
          await store.pipe([['RPUSH', k.chat, JSON.stringify(msg)], ['LTRIM', k.chat, -200, -1]]);
          await deliver(code, members, { type: 'chat', msg });
          break;
        }
        case 'meta': {
          if ('mic' in op) me.mic = !!op.mic;
          if ('cam' in op) me.cam = !!op.cam;
          if ('sharing' in op) me.sharing = !!op.sharing;
          if ('name' in op) me.name = clean(op.name, 24) || me.name;
          me.seen = Date.now();
          await store.pipe([['HSET', k.members, me.id, JSON.stringify(me)]]);
          await deliver(code, members, { type: 'peer-meta', peer: pub(me) }, me.id);
          break;
        }
        case 'state': {
          const [host, cur] = await store.pipe([['GET', k.host], ['GET', k.state]]);
          if (host !== me.id) { results.push({ type: 'error', message: 'Only the host can change the stage.' }); break; }
          const state = sanitizeState(parse(cur) || defaultState(host), op.state || {}, new Set(members.keys()));
          await store.pipe([['SET', k.state, JSON.stringify(state), 'EX', TTL]]);
          await deliver(code, members, { type: 'state', state }, me.id);
          results.push({ type: 'state', state });
          break;
        }
        case 'recording': await deliver(code, members, { type: 'recording', on: !!op.on, by: me.name }, me.id); break;
      }
    }
    return { results };
  },

  async leave(body) {
    const { code, members, me } = await auth(body);
    await removeMember(code, me.id, members);
    return { ok: true };
  },
};

/** Entry point shared by server.js and api/studio.js. */
async function handle(action, body) {
  const fn = actions[action];
  if (!fn) throw new HttpError(404, 'Unknown action.');
  return fn(body || {});
}
module.exports = { handle, HttpError };
