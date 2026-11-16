// gather studio logic — stateless request handler over a Redis-like store.
// Runs identically in `node server.js` (in-memory store) and on Vercel (Upstash Redis).
//
// Each member polls their own inbox list. The inbox key embeds a secret token, so only that
// member can read it; every other action is authenticated against the stored token.
const crypto = require('crypto');
const { store, detected } = require('./store');
const { authUser } = require('./accounts');

const MAX = 6;
const STALE_MS = 20_000; // a member who hasn't heartbeated in this long is removed
const TTL = 6 * 3600; // idle studios disappear after 6 hours
const OWNER_TTL = 24 * 3600; // the creator keeps the studio's host seat for a day after it empties

const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URL) ICE.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER, credential: process.env.TURN_PASS });

// Built-in TURN through Cloudflare Realtime: guests on strict corporate and mobile networks can only connect
// through a relay. With CF_TURN_KEY_ID + CF_TURN_API_TOKEN set, every join gets short-lived TURN credentials
// (24 h), minted here so the API token never reaches a browser. Cached for an hour per server instance.
const CF_TURN = { id: process.env.CF_TURN_KEY_ID, token: process.env.CF_TURN_API_TOKEN, api: (process.env.CF_TURN_API || 'https://rtc.live.cloudflare.com/v1').replace(/\/$/, '') };
let turnCache = { at: 0, ice: null };
// The go-live relay (relay/ in this repo, deployed on Fly.io or any Docker host). gather signs a two-minute token
// for the studio's host; the relay checks it with the same RELAY_SECRET. The secret never reaches a browser.
const RELAY = { url: String(process.env.RELAY_URL || '').trim().replace(/\/+$/, ''), secret: process.env.RELAY_SECRET || '' };
const requireAccount = () => !/^(1|true|yes)$/i.test(String(process.env.ALLOW_ANON_STUDIOS || ''));
const relayOn = () => !!(RELAY.url && RELAY.secret.length >= 24);
function relayToken(studio) {
  // n: a one-time nonce; the relay accepts each token once.
  const body = Buffer.from(JSON.stringify({ s: studio, e: Date.now() + 120_000, n: crypto.randomBytes(9).toString('base64url') })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', RELAY.secret).update(body).digest('base64url');
}
async function iceServers() {
  if (!CF_TURN.id || !CF_TURN.token) return ICE;
  if (turnCache.ice && Date.now() - turnCache.at < 3600_000) return turnCache.ice;
  try {
    const res = await fetch(`${CF_TURN.api}/turn/keys/${encodeURIComponent(CF_TURN.id)}/credentials/generate-ice-servers`, {
      method: 'POST', headers: { Authorization: `Bearer ${CF_TURN.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const list = Array.isArray(j.iceServers) ? j.iceServers : j.iceServers ? [j.iceServers] : [];
    // Browsers can't use port 53 for TURN (it stalls ICE), so drop those URLs.
    const ice = list.map((x) => ({ ...x, urls: [].concat(x.urls || []).filter((u) => !/:53(\?|$)/.test(u)) })).filter((x) => x.urls.length);
    if (!ice.some((x) => x.username)) throw new Error('no TURN credentials in the response');
    turnCache = { at: Date.now(), ice: [...ICE, ...ice] };
    return turnCache.ice;
  } catch (e) {
    console.warn('[gather] Cloudflare TURN unavailable, using STUN only:', e.message);
    return ICE;
  }
}

const K = (code) => ({
  members: `g:${code}:m`, host: `g:${code}:host`, state: `g:${code}:state`, chat: `g:${code}:chat`,
  // Who opened an ad-hoc studio: {u: account id} or, for anonymous studios, {d: device id}. They keep the host seat.
  owner: `g:${code}:owner`,
  inbox: (id, tok) => `g:${code}:in:${id}:${tok}`,
});
const rid = (n) => crypto.randomBytes(n).toString('hex');
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const cleanCode = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
const pub = (m) => ({ id: m.id, name: m.name, mic: m.mic, cam: m.cam, sharing: m.sharing, avatar: m.avatar || '', offbg: m.offbg || '', joinedAt: m.joinedAt });
// A removed person stays out: their browser's device id (a random value it keeps, never shown to others) is
// barred from the studio for 12 hours, so the same link no longer lets them back in.
const cleanDev = (v) => String(v || '').toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 32);
async function barred(code, dev) { if (!dev) return false; const [b] = await store.pipe([['GET', `g:${code}:ban:${dev}`]]); return !!b; }
const parse = (s, d = null) => { if (s == null) return d; if (typeof s === 'object') return s; try { return JSON.parse(s); } catch { return d; } };

const NO_STORAGE = 'Studio storage is not connected. In Vercel, open your project → Storage → create or connect a Redis database (Upstash), then redeploy.';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function defaultState(hostId) {
  return { layout: 'split', stage: [hostId], banner: null, ticker: '', brand: { color: '#3b82f6', bg: 'dusk', logo: '', watermark: false, names: true, font: 'jakarta', tag: 'solid', bannerStyle: 'classic', anim: 'slide', frame: 'none', bgImage: '', dim: 0.25, overlay: '', logoPos: 'tr', logoSize: 0.12, panel: 'glass', panelColor: '#0f172a' }, title: '', presenter: '', scene: '', aspect: '16:9', locked: false, ads: { on: false, items: [], every: 12, pos: 'br' }, captions: { on: false, style: 'bar', size: 26, lang: 'en-US' }, elements: [], featured: null, feeds: { twitch: '' }, mod: { hidden: [], blocked: [], timeouts: [] } };
}

// ---- stage elements (custom layouts + overlays) -------------------------------------------
const ELEMENT_TYPES = new Set(['slot', 'chat', 'text', 'image', 'timer', 'media', 'ai', 'tip', 'callin', 'shape', 'banner', 'ticker', 'logo', 'ads', 'featured', 'captions']);
const TIP_PROVIDERS = new Set(['paypal', 'venmo', 'cashapp', 'stripe', 'kofi', 'patreon', 'bmc', 'link']);
const AI_PROVIDERS = new Set(['claude', 'openai', 'gemini', 'grok']);
const SOURCES = new Set(['studio', 'twitch', 'youtube', 'rumble', 'x', 'kick', 'watch']);
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(v) ? v : d);
function sanitizeElement(e) {
  if (!e || !ELEMENT_TYPES.has(e.type)) return null;
  const w = num(e.w, 0.02, 1, 0.3), h = num(e.h, 0.02, 1, 0.3);
  const out = { id: clean(e.id, 24) || rid(4), type: e.type, x: num(e.x, -0.5, 1, 0), y: num(e.y, -0.5, 1, 0), w, h };
  // layer controls: hidden, locked, deliberately stacked (may overlap), picture-in-picture, and the reset position
  for (const k of ['hidden', 'locked', 'stack', 'pip']) if (e[k]) out[k] = true;
  if (Array.isArray(e.home) && e.home.length === 4) out.home = e.home.map((v, i) => num(v, i < 2 ? -0.5 : 0.02, 1, 0));
  switch (e.type) {
    case 'slot': out.index = Math.round(num(e.index, 0, 5, 0)); out.radius = num(e.radius, 0, 60, 10); break;
    case 'chat': out.max = Math.round(num(e.max, 2, 15, 8)); out.size = num(e.size, 12, 40, 18); out.bg = e.bg !== false; out.fade = !!e.fade; break;
    case 'text': out.text = clean(e.text, 200); out.size = num(e.size, 10, 200, 40); out.color = hex(e.color, '#ffffff'); out.bold = e.bold !== false;
      out.align = ['left', 'center', 'right'].includes(e.align) ? e.align : 'left'; out.bg = e.bg ? hex(e.bg, '') : ''; break;
    case 'image': out.asset = clean(e.asset, 40); out.fit = e.fit === 'cover' ? 'cover' : 'contain'; out.opacity = num(e.opacity, 0.05, 1, 1); out.radius = num(e.radius, 0, 200, 0); break;
    case 'media': out.radius = num(e.radius, 0, 60, 12); break;
    case 'shape': out.color = hex(e.color, '#000000'); out.opacity = num(e.opacity, 0.05, 1, 1); out.radius = num(e.radius, 0, 200, 0); out.label = clean(e.label, 40); break;
    case 'ai': out.size = num(e.size, 12, 40, 22); break;
    case 'tip': {
      out.provider = TIP_PROVIDERS.has(e.provider) ? e.provider : 'link';
      const url = String(e.url || '').slice(0, 300);
      out.url = /^(https:\/\/|http:\/\/localhost[:/])[^\s<>"']+$/.test(url) ? url : '';
      out.label = clean(e.label, 60) || 'Support the show';
      break;
    }
    case 'callin': {
      const url = String(e.url || '').slice(0, 300);
      out.url = /^(https:\/\/|http:\/\/localhost[:/])[^\s<>"']+$/.test(url) ? url : '';
      out.label = clean(e.label, 60) || 'Call in live';
      out.phone = clean(e.phone, 40);
      break;
    }
    case 'timer': out.mode = e.mode === 'countdown' ? 'countdown' : 'clock'; out.target = Math.round(num(e.target, 0, 9e15, 0)); out.size = num(e.size, 10, 200, 44);
      out.color = hex(e.color, '#ffffff'); out.bg = e.bg ? hex(e.bg, '') : ''; break;
  }
  return out;
}
// Only accept known fields from the host so one client can't corrupt the room.
function sanitizeState(prev, next, memberIds) {
  const s = { locked: false, ads: { on: false, items: [], every: 12, pos: 'br' }, elements: [], featured: null, feeds: { twitch: '' }, mod: { hidden: [], blocked: [], timeouts: [] }, aspect: '16:9', captions: { on: false, style: 'bar', size: 26, lang: 'en-US' }, ...structuredClone(prev) };
  if (['solo', 'split', 'spotlight', 'custom'].includes(next.layout)) s.layout = next.layout;
  if ('presenter' in next) s.presenter = clean(next.presenter, 24);
  if ('aspect' in next && ['16:9', '9:16'].includes(next.aspect)) s.aspect = next.aspect;
  if ('locked' in next) s.locked = !!next.locked;
  if ('live' in next) { // the host is live on platforms; public watch links for the watch page (never stream keys)
    const l = next.live;
    s.live = l && typeof l === 'object' && l.on ? {
      on: true, since: num(l.since, 0, 9e15, Date.now()),
      links: (Array.isArray(l.links) ? l.links : []).slice(0, 7).map((x) => ({ kind: ['youtube', 'twitch', 'kick', 'facebook', 'x', 'rumble', 'custom'].includes(x?.kind) ? x.kind : 'custom', url: /^https:\/\/[^\s<>"]+$/i.test(String(x?.url || '')) ? String(x.url).slice(0, 300) : '' })).filter((x) => x.url),
    } : null;
  }
  if (next.watch && typeof next.watch === 'object') { // the public watch page: chat, super chats, direct viewing
    const w = next.watch, p = w.pay || {};
    s.watch = {
      chat: w.chat !== false, supers: !!w.supers, join: !!w.join, direct: w.direct !== false, queue: !!w.queue,
      cap: Math.round(num(w.cap, 0, 30, 6)), slow: Math.round(num(w.slow, 0, 120, 0)), min: num(w.min, 1, 500, 2),
      about: String(w.about ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 600), // shown as text, never HTML
      links: (Array.isArray(w.links) ? w.links : []).slice(0, 6).map((l) => ({ label: clean(l?.label, 40), url: /^https:\/\/[^\s<>"']{3,300}$/.test(String(l?.url || '')) ? String(l.url) : '' })).filter((l) => l.url),
      pay: {
        paypal: /^[A-Za-z0-9]{1,20}$/.test(p.paypal || '') ? p.paypal : '',
        venmo: /^[A-Za-z0-9_-]{2,30}$/.test(p.venmo || '') ? p.venmo : '',
        cashapp: /^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(String(p.cashapp || '').replace(/^\$/, '')) ? String(p.cashapp).replace(/^\$/, '') : '',
        stripe: /^https:\/\/(buy|donate)\.stripe\.com\/[A-Za-z0-9_]{4,80}$/.test(p.stripe || '') ? p.stripe : '',
      },
    };
  }
  if (next.shop && typeof next.shop === 'object') { // products the host sells live; checkout happens on the store's own site
    const sh = next.shop, httpsUrl = (u) => (/^https:\/\/[^\s<>"']{3,400}$/.test(String(u || '')) ? String(u) : '');
    const items = (Array.isArray(sh.items) ? sh.items : []).slice(0, 24).map((x) => ({ id: clean(x?.id, 24) || rid(4), title: clean(x?.title, 80), price: clean(x?.price, 16), img: httpsUrl(x?.img), url: httpsUrl(x?.url), src: ['shopify', 'etsy', 'link'].includes(x?.src) ? x.src : 'link' })).filter((x) => x.title && x.url);
    const ids = new Set(items.map((x) => x.id));
    const sale = sh.sale && typeof sh.sale === 'object' && ids.has(sh.sale.id) ? { id: sh.sale.id, code: clean(sh.sale.code, 24), pct: Math.round(num(sh.sale.pct, 0, 95, 0)), until: Math.round(num(sh.sale.until, 0, Date.now() + 6 * 3600e3, 0)) } : null;
    s.shop = { items, pinned: ids.has(sh.pinned) ? sh.pinned : '', sale: sale && sale.until > Date.now() ? sale : null, store: clean(sh.store, 80) };
  }
  if ('poll' in next) { // a live poll, or a prediction the host settles afterwards
    const p = next.poll;
    s.poll = p && typeof p === 'object' && p.q ? { id: clean(p.id, 16) || rid(4), kind: p.kind === 'predict' ? 'predict' : 'poll', q: clean(p.q, 120), opts: (Array.isArray(p.opts) ? p.opts : []).slice(0, 4).map((o) => clean(o, 40)).filter(Boolean), until: Math.round(num(p.until, 0, Date.now() + 3600e3, 0)), answer: Number.isInteger(p.answer) ? p.answer : -1 } : null;
    if (s.poll && s.poll.opts.length < 2) s.poll = null;
  }
  if (Array.isArray(next.emotes)) s.emotes = next.emotes.slice(0, 30).map((e) => ({ name: String(e?.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20), asset: String(e?.asset || '').replace(/[^a-z0-9]/g, '').slice(0, 40) })).filter((e) => e.name.length >= 2 && e.asset);
  if ('focus' in next) s.focus = num(next.focus, 0, 1, 0.5); // where the speaker is, for the watch page's vertical crop
  if ('rec' in next) s.rec = next.rec && typeof next.rec === 'object' && next.rec.on ? { on: true, since: num(next.rec.since, 0, 9e15, Date.now()) } : null;
  if (next.ads && typeof next.ads === 'object') {
    const a = next.ads;
    s.ads = { on: !!a.on, items: (Array.isArray(a.items) ? a.items : []).map((x) => String(x || '').replace(/[^a-z0-9-]/g, '').slice(0, 40)).filter(Boolean).slice(0, 8),
      every: num(a.every, 4, 120, 12), pos: ['br', 'bl', 'tr', 'bottom'].includes(a.pos) ? a.pos : 'br' };
  }
  if (next.captions && typeof next.captions === 'object') {
    const c = next.captions;
    s.captions = { on: !!c.on, style: ['bar', 'plain', 'box'].includes(c.style) ? c.style : 'bar', size: num(c.size, 16, 48, 26), lang: String(c.lang || 'en-US').replace(/[^A-Za-z-]/g, '').slice(0, 12) || 'en-US' };
  }
  if ('scene' in next) s.scene = clean(next.scene, 60);
  if (Array.isArray(next.elements)) s.elements = next.elements.slice(0, 40).map(sanitizeElement).filter(Boolean);
  if ('featured' in next) s.featured = next.featured && next.featured.text ? { id: clean(next.featured.id, 40), src: SOURCES.has(next.featured.src) ? next.featured.src : 'studio', name: clean(next.featured.name, 40), text: clean(next.featured.text, 300), color: hex(next.featured.color, ''), paid: clean(next.featured.paid, 16) } : null;
  if (next.mod && typeof next.mod === 'object') {
    const who = (x) => ({ src: SOURCES.has(x?.src) ? x.src : 'studio', user: clean(x?.user, 40).toLowerCase() });
    const now = Date.now();
    s.mod = {
      hidden: (Array.isArray(next.mod.hidden) ? next.mod.hidden : []).map((x) => clean(x, 64)).filter(Boolean).slice(-300),
      blocked: (Array.isArray(next.mod.blocked) ? next.mod.blocked : []).map(who).filter((x) => x.user).slice(-300),
      timeouts: (Array.isArray(next.mod.timeouts) ? next.mod.timeouts : []).map((x) => ({ ...who(x), until: Math.round(num(x?.until, 0, now + 7 * 864e5, 0)) })).filter((x) => x.user && x.until > now).slice(-300),
    };
  }
  if (next.feeds && typeof next.feeds === 'object') s.feeds = { twitch: String(next.feeds.twitch || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25) };
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
    const pick = (k, list) => { if (k in b && list.includes(b[k])) s.brand[k] = b[k]; };
    pick('font', ['jakarta', 'onest', 'playfair', 'bebas', 'mono', 'serif']);
    pick('tag', ['solid', 'glass', 'minimal', 'outline']);
    pick('bannerStyle', ['classic', 'glass', 'bold', 'minimal']);
    pick('anim', ['slide', 'fade', 'pop', 'wipe', 'type']);
    pick('frame', ['none', 'corners', 'border', 'vignette']);
    pick('logoPos', ['tl', 'tr', 'bl', 'br']);
    pick('panel', ['glass', 'solid']);
    if ('panelColor' in b) s.brand.panelColor = hex(b.panelColor, '#0f172a');
    const asset = (k) => { if (k in b) s.brand[k] = String(b[k] || '').replace(/[^a-z0-9-]/g, '').slice(0, 40); };
    asset('bgImage'); asset('overlay'); asset('logo');
    if ('dim' in b) s.brand.dim = num(b.dim, 0, 0.85, 0.25);
    if ('logoSize' in b) s.brand.logoSize = num(b.logoSize, 0.04, 0.35, 0.12);
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
  return [['EXPIRE', k.members, TTL], ['EXPIRE', k.host, TTL], ['EXPIRE', k.state, TTL], ['EXPIRE', k.chat, TTL], ['EXPIRE', k.owner, OWNER_TTL]];
}

async function lobbyOf(code) {
  const [flat] = await store.pipe([['HGETALL', `g:${code}:lobby`]]);
  const out = [], now = Date.now();
  for (let i = 0; i < (flat || []).length; i += 2) {
    const e = parse(flat[i + 1]);
    if (e && e.status === 'waiting' && now - e.seen < 30_000) out.push({ id: e.id, name: e.name, note: e.note, callin: e.callin, ts: e.ts });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Remove a member, hand off hosting if needed, and tell everyone. `why`: 'left' | 'dropped' | 'removed'. */
async function removeMember(code, id, members, why = 'left') {
  const k = K(code);
  const gone = members.get(id);
  const [deleted] = await store.pipe([['HDEL', k.members, id]]);
  if (!deleted) return; // someone else already removed them
  members.delete(id);
  if (gone) await store.pipe([['DEL', k.inbox(id, gone.tok)]]);
  if (!members.size) { await store.pipe([['DEL', k.members, k.host, k.state, k.chat]]); return; }
  let [host, state] = await store.pipe([['GET', k.host], ['GET', k.state]]);
  state = parse(state) || defaultState(host);
  const hostLeft = !members.has(host);
  if (hostLeft) {
    host = [...members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0].id;
    // A host who leaves on purpose hands the studio over for good; one whose connection dropped gets it back on return.
    if (why === 'left' && gone) {
      const n = members.get(host);
      await store.pipe([['SET', k.owner, JSON.stringify(n.u ? { u: n.u } : { d: n.dev }), 'EX', OWNER_TTL]]);
    }
    // Nobody is streaming once the host is gone, so the watch page must stop saying "Live".
    if (state.live) state.live = null;
    if (state.rec) state.rec = null; // the recording ran in the host's browser
  }
  state.stage = state.stage.filter((x) => members.has(x));
  if (!state.stage.length) state.stage = [host];
  await store.pipe([['SET', k.host, host, 'EX', TTL], ['SET', k.state, JSON.stringify(state), 'EX', TTL]]);
  await deliver(code, members, { type: 'peer-left', id, host, state, why, hostLeft });
}
async function sweep(code, members) {
  const now = Date.now();
  for (const m of [...members.values()]) if (now - m.seen > STALE_MS) await removeMember(code, m.id, members, 'dropped');
}
async function auth(body) {
  const code = cleanCode(body.studio);
  if (!code || !body.id || !body.tok) throw new HttpError(400, 'Missing studio credentials.');
  const members = await loadMembers(code);
  const me = members.get(String(body.id));
  if (!me || me.tok !== body.tok) {
    const [kicked] = await store.pipe([['GET', `g:${code}:kick:${String(body.id).replace(/[^a-z0-9]/g, '')}`]]);
    if (kicked) throw new HttpError(403, 'The host removed you from this studio.');
    throw new HttpError(410, 'You are no longer in this studio.');
  }
  return { code, members, me };
}

// ------------------------------------------------------------------ actions
const actions = {
  /** Health check. Open /api/studio?action=config in a browser to see it. Never returns secret values. */
  async config() {
    const out = { ok: true, storage: store.kind, envDetected: detected, vercel: !!process.env.VERCEL, iceServers: ICE.length, turn: !!process.env.TURN_URL, builtInTurn: !!(CF_TURN.id && CF_TURN.token), relay: relayOn(), requireAccount: requireAccount() };
    // A Google OAuth client ID is public by design (it is sent to every browser that signs in); never a secret.
    out.googleClientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
    out.houseAI = require('./ai').houseInfo(); // provider + daily allowance only, never the key
    if (process.env.VERCEL && store.kind === 'memory') {
      out.ok = false;
      out.problem = NO_STORAGE;
      return out;
    }
    try {
      const t0 = Date.now();
      const [pong] = await store.pipe([['SET', 'g:health', String(t0), 'EX', 60], ['GET', 'g:health']]).then((r) => [r[1]]);
      out.redisRoundTripMs = Date.now() - t0;
      if (pong !== String(t0)) throw new Error('read-back mismatch');
    } catch (e) {
      out.ok = false;
      out.problem = 'Redis is configured but not answering: ' + e.message;
    }
    return out;
  },

  async join(body) {
    if (process.env.VERCEL && store.kind === 'memory') {
      throw new HttpError(503, NO_STORAGE);
    }
    const code = cleanCode(body.studio);
    if (!code) throw new HttpError(400, 'Studio codes use letters, numbers and dashes.');
    const k = K(code);
    const members = await loadMembers(code);
    await sweep(code, members);
    if (members.size >= MAX) throw new HttpError(409, `This studio is full (${MAX} people).`);

    if (await barred(code, cleanDev(body.dev))) throw new HttpError(403, 'The host removed you from this studio.');
    const dev = cleanDev(body.dev);
    let uid = '';
    if (body.acct) { try { uid = (await authUser(body.acct)).id; } catch {} }
    const me = { id: rid(4), tok: rid(12), dev, u: uid, name: clean(body.name, 24) || 'Guest', mic: body.mic !== false, cam: body.cam !== false, sharing: false, avatar: '', offbg: '', joinedAt: Date.now(), seen: Date.now() };
    const [reserved, ownerRaw] = await store.pipe([['GET', `g:${code}:reserved`], ['GET', k.owner]]);
    const owner = parse(ownerRaw);
    // The host seat belongs to whoever scheduled the show, or whoever opened this studio (their account, or for an
    // anonymous studio their device). A reload or a dropped connection gives it straight back to them.
    const isOwner = reserved ? !!uid && uid === reserved : !!owner && (owner.u ? uid === owner.u : !!dev && dev === owner.d);
    // A locked studio, or anyone calling in, waits in the lobby until the host admits them.
    if (body.callin && !members.size) throw new HttpError(404, 'This studio isn’t live right now. Try again when the show starts.');
    // Guests (invite links, the Join box) never open a studio: they wait for the host instead of becoming one.
    if (!members.size && !reserved && !isOwner && body.intent === 'join') {
      throw new HttpError(404, 'The host hasn’t opened this studio yet. We’ll bring you in as soon as they do.');
    }
    // Starting a new studio needs an account (set ALLOW_ANON_STUDIOS=1 to allow anyone). Guests never do.
    if (!members.size && !reserved && !isOwner && requireAccount() && !uid) {
      throw new HttpError(401, 'Sign in to start a studio. Guests joining one don’t need an account.');
    }
    // The person who opens a fresh studio owns it.
    if (!members.size && !reserved && !owner) await store.pipe([['SET', k.owner, JSON.stringify(uid ? { u: uid } : { d: dev }), 'EX', OWNER_TTL]]);
    if (members.size && !isOwner) {
      const [st] = await store.pipe([['GET', k.state]]);
      const locked = !!parse(st)?.locked;
      if (locked || body.callin) {
        const pass = String(body.pass || '');
        const [entry] = pass ? await store.pipe([['HGET', `g:${code}:lobby`, pass.split('.')[0]]]) : [null];
        const e = parse(entry);
        if (!e || !['admitted', 'joined'].includes(e.status) || e.pass !== pass) throw new HttpError(423, locked ? 'This studio is locked. Ask the host to let you in.' : 'Waiting for the host to let you in.');
        // Keep the admission for a while so a dropped connection can come back without knocking again.
        e.status = 'joined';
        await store.pipe([['HSET', `g:${code}:lobby`, e.id, JSON.stringify(e)]]);
      }
    }
    let claimed;
    if (reserved && !isOwner) claimed = null; // a scheduled studio waits for its owner to take the host seat
    else if (isOwner) { await store.pipe([['SET', k.host, me.id, 'EX', TTL]]); claimed = 'OK'; }
    else [claimed] = await store.pipe([['SET', k.host, me.id, 'NX', 'EX', TTL]]);
    let host = me.id, state;
    if (reserved && !isOwner) {
      const [h, st] = await store.pipe([['GET', k.host], ['GET', k.state]]);
      host = members.has(h) ? h : '';
      state = parse(st) || defaultState(host);
    } else if (isOwner) {
      const [st] = await store.pipe([['GET', k.state]]);
      state = parse(st) || defaultState(me.id);
      state.stage = [me.id, ...state.stage.filter((x) => members.has(x) && x !== me.id)];
    } else if (claimed) {
      state = defaultState(me.id);
    } else {
      let [h, st] = await store.pipe([['GET', k.host], ['GET', k.state]]);
      host = members.has(h) ? h : me.id;
      state = parse(st) || defaultState(host);
    }
    if (isOwner && members.size) await deliver(code, members, { type: 'host', host: me.id });
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
      iceServers: await iceServers(),
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
          if ('avatar' in op) me.avatar = String(op.avatar || '').replace(/[^a-z0-9]/g, '').slice(0, 40);
          if ('offbg' in op) me.offbg = String(op.offbg || '').replace(/[^a-z0-9]/g, '').slice(0, 40);
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
        case 'ai': {
          const [host] = await store.pipe([['GET', k.host]]);
          if (host !== me.id) break;
          const it = op.item || {};
          const item = { id: clean(it.id, 24), role: ['user', 'assistant', 'system'].includes(it.role) ? it.role : 'assistant',
            text: String(it.text ?? '').replace(/\u0000/g, '').slice(0, 8000), provider: AI_PROVIDERS.has(it.provider) ? it.provider : 'claude', done: !!it.done, error: !!it.error };
          if (item.id) await deliver(code, members, { type: 'ai', item }, me.id);
          break;
        }
        case 'mute': case 'kick': case 'admit': {
          const [host] = await store.pipe([['GET', k.host]]);
          if (host !== me.id) { results.push({ type: 'error', message: 'Only the host can do that.' }); break; }
          if (op.type === 'mute') {
            const t = members.get(String(op.id));
            if (t) await deliver(code, new Map([[t.id, t]]), { type: 'mute', by: me.name });
          } else if (op.type === 'kick') {
            const id = String(op.id || '').replace(/[^a-z0-9]/g, '');
            if (members.has(id) && id !== me.id) {
              const dev = members.get(id).dev;
              await store.pipe([['SET', `g:${code}:kick:${id}`, '1', 'EX', 3600], ...(dev ? [['SET', `g:${code}:ban:${dev}`, '1', 'EX', 43200]] : [])]);
              await removeMember(code, id, members, 'removed');
            }
          } else {
            const key = `g:${code}:lobby`;
            const [raw] = await store.pipe([['HGET', key, String(op.id || '')]]);
            const e = parse(raw);
            if (e) {
              e.status = op.accept ? 'admitted' : 'declined';
              if (op.accept) e.pass = `${e.id}.${rid(8)}`;
              await store.pipe([['HSET', key, e.id, JSON.stringify(e)], ['EXPIRE', key, 1800]]);
              await deliver(code, new Map([[me.id, me]]), { type: 'lobby', lobby: await lobbyOf(code) });
            }
          }
          break;
        }
        case 'wcap': { // a finished caption line, for watch-page viewers who turn CC on
          const [host] = await store.pipe([['GET', k.host]]);
          if (host !== me.id) break;
          const line = JSON.stringify({ name: clean(op.name, 24), text: clean(op.text, 300), ts: Date.now() });
          await store.pipe([['RPUSH', `g:${code}:wcap`, line], ['LTRIM', `g:${code}:wcap`, -4, -1], ['EXPIRE', `g:${code}:wcap`, 600]]);
          break;
        }
        case 'qpick': case 'qclear': { // the "Play with me" queue
          const [host] = await store.pipe([['GET', k.host]]);
          if (host !== me.id) break;
          results.push({ type: 'queue', items: await watch.hostQueue(code, op) });
          break;
        }
        case 'superchat': case 'vsignal': {
          const [host] = await store.pipe([['GET', k.host]]);
          if (host !== me.id) break;
          if (op.type === 'vsignal') { await watch.hostVsignal(code, op); break; }
          const sc = await watch.hostSuperchat(code, op, members);
          if (sc) results.push({ type: 'superchat', item: sc });
          break;
        }
        case 'caption': {
          const text = clean(op.text, 300);
          if (text) await deliver(code, members, { type: 'caption', from: me.id, name: me.name, text, final: !!op.final }, me.id);
          break;
        }
        case 'feed': {
          const [host] = await store.pipe([['GET', k.host]]);
          if (host !== me.id) break;
          const items = (Array.isArray(op.items) ? op.items : []).slice(0, 30).map((m) => ({
            id: clean(m.id, 64), src: SOURCES.has(m.src) ? m.src : 'rumble', name: clean(m.name, 40) || 'viewer', color: hex(m.color, ''),
            text: clean(m.text, 500), ts: Math.round(num(m.ts, 0, 9e15, Date.now())), paid: clean(m.paid, 16),
          })).filter((m) => m.id && m.text);
          if (items.length) await deliver(code, members, { type: 'feed', items }, me.id);
          break;
        }
      }
    }
    return { results };
  },

  /** Store an uploaded image (logo, overlay) for this studio. Returns an id that stage elements reference. */
  async assetPut(body) {
    const { code } = await auth(body);
    const data = String(body.data || '');
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(data)) throw new HttpError(400, 'Images must be PNG, JPEG, WebP or GIF.');
    if (data.length > 900_000) throw new HttpError(413, 'That image is too large. Try one under about 600 KB.');
    const id = rid(6);
    await store.pipe([['SET', `g:${code}:asset:${id}`, data, 'EX', TTL]]);
    return { id };
  },
  async assetGet(body) {
    const { code } = await auth(body);
    const id = String(body.asset || '').replace(/[^a-z0-9]/g, '').slice(0, 40);
    const [data] = await store.pipe([['GET', `g:${code}:asset:${id}`]]);
    if (!data) throw new HttpError(404, 'Image not found.');
    return { data };
  },

  /** Read recent chat from the host's Rumble Live Stream API URL. */
  async rumble(body) {
    await auth(body);
    let u;
    try { u = new URL(String(body.url || '')); } catch { throw new HttpError(400, 'Paste the full Live Stream API URL from your Rumble account settings.'); }
    if (u.protocol !== 'https:' || !['rumble.com', 'www.rumble.com'].includes(u.hostname) || !u.pathname.startsWith('/-livestream-api/')) {
      throw new HttpError(400, 'That is not a Rumble Live Stream API URL. Copy it from Rumble → Account → Live Stream API.');
    }
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    let data;
    try {
      const r = await fetch(u, { signal: ctl.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new HttpError(502, `Rumble answered ${r.status}. Check that the API URL is still valid.`);
      data = await r.json();
    } catch (e) { if (e.status) throw e; throw new HttpError(502, 'Could not reach Rumble. Try again in a moment.'); }
    finally { clearTimeout(t); }
    const live = (Array.isArray(data?.livestreams) ? data.livestreams : []).find((l) => l?.is_live) || (data?.livestreams || [])[0];
    const chat = live?.chat || {};
    const norm = (m, paid) => ({
      id: 'r-' + crypto.createHash('sha1').update(`${m.username}|${m.created_on}|${m.text}`).digest('hex').slice(0, 16),
      src: 'rumble', name: clean(m.username, 40) || 'viewer', text: clean(m.text, 500), ts: Date.parse(m.created_on) || Date.now(),
      paid: paid && m.amount_dollars ? `$${Number(m.amount_dollars).toFixed(2)}` : '',
    });
    const msgs = [...(chat.recent_messages || []).map((m) => norm(m, false)), ...(chat.recent_rants || []).map((m) => norm(m, true))]
      .filter((m) => m.text).sort((a, b) => a.ts - b.ts);
    return { live: !!live?.is_live, title: clean(live?.title, 120), msgs };
  },

  /** Someone asks to come in (call-in line, or a locked studio). */
  async knock(body) {
    const code = cleanCode(body.studio);
    if (!code) throw new HttpError(400, 'Missing studio code.');
    const members = await loadMembers(code);
    if (!members.size) throw new HttpError(404, 'This studio isn’t live right now. Try again when the show starts.');
    if (members.size >= MAX) throw new HttpError(409, `This studio is full (${MAX} people).`);
    if (await barred(code, cleanDev(body.dev))) throw new HttpError(403, 'The host removed you from this studio.');
    const key = `g:${code}:lobby`;
    // Knocking needs only the public code, so cap it: one knock per device every 10 s, and at most 20 waiting.
    const dev = cleanDev(body.dev);
    if (dev) { const [fresh] = await store.pipe([['SET', `g:${code}:knk:${dev}`, '1', 'NX', 'EX', 10]]); if (!fresh) throw new HttpError(429, 'You just knocked. Give the host a moment.'); }
    if ((await lobbyOf(code)).length >= 20) throw new HttpError(429, 'The waiting room is full. Try again in a few minutes.');
    const e = { id: rid(4), tok: rid(12), name: clean(body.name, 24) || 'Caller', note: clean(body.note, 80), ts: Date.now(), seen: Date.now(), status: 'waiting', callin: !!body.callin };
    await store.pipe([['HSET', key, e.id, JSON.stringify(e)], ['EXPIRE', key, 1800]]);
    const [host] = await store.pipe([['GET', K(code).host]]);
    const h = members.get(host);
    if (h) await deliver(code, new Map([[h.id, h]]), { type: 'knock', who: { id: e.id, name: e.name, note: e.note, callin: e.callin }, lobby: await lobbyOf(code) });
    return { id: e.id, tok: e.tok };
  },
  async knockPoll(body) {
    const code = cleanCode(body.studio), key = `g:${code}:lobby`;
    const [raw] = await store.pipe([['HGET', key, String(body.id || '')]]);
    const e = parse(raw);
    if (!e || e.tok !== body.tok) throw new HttpError(404, 'Your place in the waiting room expired. Knock again.');
    e.seen = Date.now();
    await store.pipe([['HSET', key, e.id, JSON.stringify(e)]]);
    return { status: e.status, pass: e.status === 'admitted' ? e.pass : undefined };
  },
  async knockCancel(body) {
    const code = cleanCode(body.studio), key = `g:${code}:lobby`;
    const [raw] = await store.pipe([['HGET', key, String(body.id || '')]]);
    const e = parse(raw);
    if (e && e.tok === body.tok) await store.pipe([['HDEL', key, e.id]]);
    return { ok: true };
  },
  /** Public: what the watch page needs while a studio exists (title, live state, watch links). No credentials. */
  async watch(body) {
    const code = cleanCode(body.studio);
    if (!code) throw new HttpError(400, 'That watch link is missing its studio code.');
    const [raw] = await store.pipe([['GET', K(code).state]]);
    if (!raw) return { found: false };
    let st = {}; try { st = JSON.parse(raw); } catch {}
    return { found: true, title: clean(st.title, 100), live: st.live || null, color: /^#[0-9a-f]{6}$/i.test(st.brand?.color || '') ? st.brand.color : null };
  },

  /** A signed address for the go-live relay. Host only. */
  async relay(body) {
    const { code, me } = await auth(body);
    const [host] = await store.pipe([['GET', K(code).host]]);
    if (host !== me.id) throw new HttpError(403, 'Only the host can go live.');
    if (!relayOn()) throw new HttpError(501, 'Going live isn’t set up on this server yet (RELAY_URL and RELAY_SECRET).');
    return { url: RELAY.url.replace(/^http/i, 'ws') + '/live?t=' + relayToken(code) };
  },
  /** Host only: nudge the relay awake when the Go live dialog opens (a free Render service sleeps after 15 min). */
  async relayWake(body) {
    const { code, me } = await auth(body);
    const [host] = await store.pipe([['GET', K(code).host]]);
    if (host !== me.id || !relayOn()) return { ok: false };
    try { const r = await fetch(RELAY.url + '/health', { signal: AbortSignal.timeout(8000) }); return { ok: r.ok, awake: r.ok }; }
    catch { return { ok: true, awake: false }; } // still waking: the request itself starts it
  },

  async lobbyList(body) {
    const { code, members, me } = await auth(body);
    const [host] = await store.pipe([['GET', K(code).host]]);
    if (host !== me.id) throw new HttpError(403, 'Only the host sees the waiting room.');
    void members;
    return { lobby: await lobbyOf(code) };
  },

  async leave(body) {
    const { code, members, me } = await auth(body);
    // Only the Leave button means "hand the studio over"; a closed or reloading tab (the pagehide beacon) keeps it.
    await removeMember(code, me.id, members, body.why === 'left' ? 'left' : 'dropped');
    return { ok: true };
  },
};

/** Entry point shared by server.js and api/studio.js. */
// The watch page's actions (lib/watch.js). wrtcJoin also hands out ICE servers so viewers behind NAT connect.
const watch = require('./watch')({ store, K, clean, parse, deliver, loadMembers, HttpError, cleanCode, rid, num });
Object.assign(actions, {
  wfeed: watch.wfeed, whello: watch.whello, wping: watch.wping, wsend: watch.wsend, wemote: watch.wemote,
  wrtcJoin: (b) => watch.wrtcJoin(b, iceServers), wrtcSignal: watch.wrtcSignal, wrtcPoll: watch.wrtcPoll, wrtcLeave: watch.wrtcLeave,
  async scList(body) {
    const { code, me } = await auth(body);
    const [host] = await store.pipe([['GET', K(code).host]]);
    if (host !== me.id) throw new HttpError(403, 'Only the host sees super chats.');
    return { items: await watch.hostSuperchats(code) };
  },
});

async function handle(action, body) {
  const fn = actions[action];
  if (!fn) throw new HttpError(404, 'Unknown action.');
  return fn(body || {});
}
module.exports = { handle, HttpError };
