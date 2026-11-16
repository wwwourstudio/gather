// Tiny Redis client covering every way Vercel can hand you a Redis database:
//   - Upstash REST:  KV_REST_API_URL + KV_REST_API_TOKEN  (or UPSTASH_REDIS_REST_URL/TOKEN)
//   - Redis URL:     REDIS_URL or KV_URL  (redis:// or rediss://, e.g. "Redis" from the Vercel Marketplace)
//   - In-memory:     nothing set (local dev / a single long-lived Node process)
// Every call is a pipeline: pipe([[cmd, ...args], ...]) -> results in order.

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TCP_URL = process.env.REDIS_URL || process.env.KV_URL;

// HGETALL comes back as a flat [k, v, ...] array from REST but as an object from ioredis.
const flatHash = (v) => (v && !Array.isArray(v) && typeof v === 'object' ? Object.entries(v).flat() : v);

function upstashRest() {
  return {
    kind: 'redis-rest',
    async pipe(cmds) {
      if (!cmds.length) return [];
      const res = await fetch(REST_URL.replace(/\/$/, '') + '/pipeline', {
        method: 'POST',
        headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmds.map((c) => c.map(String))),
      });
      if (!res.ok) throw new Error(`Redis REST request failed (HTTP ${res.status}). Check KV_REST_API_URL and KV_REST_API_TOKEN.`);
      const out = await res.json();
      return out.map((r) => { if (r.error) throw new Error('Redis: ' + r.error); return r.result; });
    },
  };
}

function redisTcp() {
  let client;
  const get = () => {
    if (!client) {
      const Redis = require('ioredis');
      // Reused across invocations on a warm serverless instance.
      client = new Redis(TCP_URL, { maxRetriesPerRequest: 2, connectTimeout: 5000, enableReadyCheck: false, lazyConnect: false });
      client.on('error', (e) => console.error('redis', e.message));
    }
    return client;
  };
  return {
    kind: 'redis-url',
    async pipe(cmds) {
      if (!cmds.length) return [];
      const p = get().pipeline();
      for (const [c, ...a] of cmds) p[c.toLowerCase()](...a.map(String));
      const out = await p.exec();
      return out.map(([err, res], i) => { if (err) throw new Error('Redis: ' + err.message); return cmds[i][0].toUpperCase() === 'HGETALL' ? flatHash(res) : res; });
    },
  };
}

// In-memory Redis subset. Fine for local dev or any single long-lived Node process.
function memory() {
  const data = new Map(); // key -> { v, exp }
  const live = (k) => { const e = data.get(k); if (e && e.exp && e.exp < Date.now()) { data.delete(k); return undefined; } return e; };
  const ops = {
    GET: (k) => live(k)?.v ?? null,
    SET: (k, v, ...opt) => {
      const o = opt.map((x) => String(x).toUpperCase());
      if (o.includes('NX') && live(k)) return null;
      const ex = o.indexOf('EX');
      data.set(k, { v, exp: ex >= 0 ? Date.now() + Number(opt[ex + 1]) * 1000 : 0 });
      return 'OK';
    },
    INCR: (k) => ops.INCRBY(k, 1),
    INCRBY: (k, n) => { const e = live(k) || { v: '0', exp: 0 }; data.set(k, e); e.v = String(Number(e.v) + Number(n)); return Number(e.v); },
    DECRBY: (k, n) => ops.INCRBY(k, -Number(n)),
    DEL: (...ks) => ks.reduce((n, k) => n + (data.delete(k) ? 1 : 0), 0),
    EXPIRE: (k, s) => { const e = live(k); if (!e) return 0; e.exp = Date.now() + Number(s) * 1000; return 1; },
    HSET: (k, ...fv) => { const e = live(k) || { v: new Map(), exp: 0 }; data.set(k, e); let n = 0; for (let i = 0; i < fv.length; i += 2) { if (!e.v.has(fv[i])) n++; e.v.set(fv[i], fv[i + 1]); } return n; },
    HGET: (k, f) => live(k)?.v.get(f) ?? null,
    HINCRBY: (k, f, n) => { const e = live(k) || { v: new Map(), exp: 0 }; data.set(k, e); const x = Number(e.v.get(f) || 0) + Number(n); e.v.set(f, String(x)); return x; },
    HDEL: (k, ...fs) => { const e = live(k); if (!e) return 0; return fs.reduce((n, f) => n + (e.v.delete(f) ? 1 : 0), 0); },
    HGETALL: (k) => { const e = live(k); return e ? [...e.v].flat() : []; },
    RPUSH: (k, ...vs) => { const e = live(k) || { v: [], exp: 0 }; data.set(k, e); e.v.push(...vs); return e.v.length; },
    LPOP: (k, n = 1) => { const e = live(k); if (!e || !e.v.length) return null; const out = e.v.splice(0, Number(n)); if (!e.v.length) data.delete(k); return out; },
    LRANGE: (k, a, b) => { const l = live(k)?.v || []; const s = Number(a) < 0 ? l.length + Number(a) : Number(a); const t = Number(b) < 0 ? l.length + Number(b) : Number(b); return l.slice(Math.max(0, s), t + 1); },
    LTRIM: (k, a, b) => { const e = live(k); if (!e) return 'OK'; e.v = ops.LRANGE(k, a, b); return 'OK'; },
  };
  return {
    kind: 'memory',
    async pipe(cmds) { return cmds.map(([c, ...a]) => ops[c.toUpperCase()](...a.map(String))); },
  };
}

const store = REST_URL && REST_TOKEN ? upstashRest() : TCP_URL ? redisTcp() : memory();
// Names only (never values) for the health check.
const detected = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'REDIS_URL', 'KV_URL'].filter((k) => process.env[k]);
module.exports = { store, detected };
