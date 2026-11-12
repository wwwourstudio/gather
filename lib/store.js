// Tiny Redis client: Upstash REST when configured, in-memory otherwise.
// Only the handful of commands the studio needs. Every call is a pipeline: pipe([[cmd, ...args], ...]).

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function upstash() {
  return {
    kind: 'redis',
    async pipe(cmds) {
      if (!cmds.length) return [];
      const res = await fetch(URL_.replace(/\/$/, '') + '/pipeline', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmds.map((c) => c.map(String))),
      });
      if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
      const out = await res.json();
      return out.map((r) => { if (r.error) throw new Error(r.error); return r.result; });
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
    DEL: (...ks) => ks.reduce((n, k) => n + (data.delete(k) ? 1 : 0), 0),
    EXPIRE: (k, s) => { const e = live(k); if (!e) return 0; e.exp = Date.now() + Number(s) * 1000; return 1; },
    HSET: (k, ...fv) => { const e = live(k) || { v: new Map(), exp: 0 }; data.set(k, e); let n = 0; for (let i = 0; i < fv.length; i += 2) { if (!e.v.has(fv[i])) n++; e.v.set(fv[i], fv[i + 1]); } return n; },
    HGET: (k, f) => live(k)?.v.get(f) ?? null,
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

const store = URL_ && TOKEN ? upstash() : memory();
module.exports = { store };
