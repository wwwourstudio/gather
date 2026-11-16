// The public watch page (/w/<studio>): viewers watch, chat, react, send super chats paid straight to the host
// (PayPal, Venmo, Cash App or a Stripe payment link), and ask to join the stage. No accounts.
//
// Cost model: the feed every viewer reads (`wfeed`) is identical for everyone and served as a GET with a 2-second
// CDN cache, so a thousand viewers cost about one function call every 2 seconds. Only writes (chat, reactions,
// super chats) and a 30-second presence ping are per viewer.
//
// Payments never touch gather. A super chat is a *claim* until the host checks their own PayPal/Venmo/Cash App and
// taps Confirm; only then does it appear as paid in the public chat or go on stage.
module.exports = function makeWatch({ store, K, clean, parse, deliver, loadMembers, HttpError, cleanCode, rid, num }) {
  const TTL = 6 * 3600;
  const REACTS = ['❤️', '🔥', '😂', '👏', '🎉', '😮'];
  const METHODS = ['paypal', 'venmo', 'cashapp', 'stripe'];
  const WK = (code) => ({ chat: `g:${code}:wchat`, viewers: `g:${code}:viewers`, sc: `g:${code}:sc`, rl: (v) => `g:${code}:wrl:${v}`, react: (b, i) => `g:${code}:wr:${b}:${i}` });
  const bucket = (t = Date.now()) => Math.floor(t / 10_000);

  async function stateOf(code) { const [st] = await store.pipe([['GET', K(code).state]]); return parse(st); }
  /** What a viewer may see of the host's watch settings (payment handles are public by nature). */
  function publicWatch(st) {
    const w = st?.watch || {};
    return { chat: w.chat !== false, supers: !!w.supers && METHODS.some((m) => w.pay?.[m]), join: !!w.join, min: w.min || 2, slow: w.slow || 0, pay: w.pay || {}, about: w.about || '', links: w.links || [] };
  }
  async function viewer(code, body) {
    const vid = String(body.vid || '').replace(/[^a-f0-9]/g, '').slice(0, 16);
    const [raw] = vid ? await store.pipe([['HGET', WK(code).viewers, vid]]) : [null];
    const v = parse(raw);
    if (!v || v.tok !== body.vtok) throw new HttpError(401, 'Your chat session ended. Reload the page to rejoin the chat.');
    v.seen = Date.now();
    await store.pipe([['HSET', WK(code).viewers, vid, JSON.stringify(v)], ['EXPIRE', WK(code).viewers, TTL]]);
    return { vid, ...v };
  }
  function muted(st, name) {
    const mod = st?.mod || {}, user = String(name).toLowerCase(), now = Date.now();
    if ((mod.blocked || []).some((b) => b.user === user && (b.src === 'watch' || b.src === 'studio'))) return 'The host has blocked you from chatting.';
    const t = (mod.timeouts || []).find((x) => x.user === user && x.until > now);
    return t ? `You’re timed out for ${Math.ceil((t.until - now) / 60000)} more minute(s).` : '';
  }

  return {
    /** Public and cacheable: everything a viewer's page needs, identical for every viewer. */
    async wfeed(body) {
      const code = cleanCode(body.studio);
      if (!code) throw new HttpError(400, 'That watch link is missing its studio code.');
      const k = WK(code), b = bucket();
      const [st, chat, viewers, scs, caps, ...rc] = await store.pipe([
        ['GET', K(code).state], ['LRANGE', k.chat, -80, -1], ['HGETALL', k.viewers], ['HGETALL', k.sc], ['LRANGE', `g:${code}:wcap`, -3, -1],
        ...REACTS.flatMap((_, i) => [['GET', k.react(b, i)], ['GET', k.react(b - 1, i)]]),
      ]);
      const s = parse(st);
      if (!s) return { found: false, at: Date.now() };
      const now = Date.now();
      let count = 0;
      for (let i = 1; i < (viewers || []).length; i += 2) { const v = parse(viewers[i]); if (v && now - v.seen < 45_000) count++; }
      const status = {};
      for (let i = 0; i < (scs || []).length; i += 2) { const x = parse(scs[i + 1]); if (x) status[scs[i]] = x.status; }
      const hidden = new Set(s.mod?.hidden || []);
      const items = (chat || []).map((x) => parse(x)).filter((x) => x && !hidden.has(x.id) && !muted(s, x.name)).map((x) => (x.sc ? { ...x, status: status[x.sc] || x.status } : x));
      const reacts = Object.fromEntries(REACTS.map((e, i) => [e, Number(rc[i * 2] || 0) + Number(rc[i * 2 + 1] || 0)]));
      const f = s.featured;
      return {
        found: true, at: now, title: clean(s.title, 100), color: /^#[0-9a-f]{6}$/i.test(s.brand?.color || '') ? s.brand.color : null,
        live: s.live || null, rec: !!s.rec?.on, watch: publicWatch(s), chat: items, viewers: count, reacts,
        caps: (caps || []).map((x) => parse(x)).filter((x) => x && now - x.ts < 15_000), capsOnStage: !!s.captions?.on, aspect: s.aspect || '16:9',
        featured: f ? { id: f.id, name: f.name, text: f.text, src: f.src, paid: f.paid || '' } : null,
      };
    },

    /** A viewer picks a name for the chat. Returns a private token for their later messages. */
    async whello(body) {
      const code = cleanCode(body.studio);
      const name = clean(body.name, 24);
      if (!code) throw new HttpError(400, 'Missing studio code.');
      if (!name) throw new HttpError(400, 'Pick a name for the chat.');
      if (/^(host|admin|mod|moderator|gather)$/i.test(name)) throw new HttpError(400, 'Pick another name: that one is reserved.');
      const st = await stateOf(code);
      if (!st) throw new HttpError(404, 'This show isn’t on right now.');
      const why = muted(st, name);
      if (why) throw new HttpError(403, why);
      // Renaming an existing session keeps its id, so the viewer's video connection survives choosing a chat name.
      if (body.vid && body.vtok) {
        const v = await viewer(code, body).catch(() => null);
        if (v) { await store.pipe([['HSET', WK(code).viewers, v.vid, JSON.stringify({ name, tok: v.tok, seen: Date.now(), named: true })]]); return { vid: v.vid, vtok: v.tok, name }; }
      }
      const vid = rid(8), tok = rid(12);
      await store.pipe([['HSET', WK(code).viewers, vid, JSON.stringify({ name, tok, seen: Date.now() })], ['EXPIRE', WK(code).viewers, TTL]]);
      return { vid, vtok: tok, name };
    },

    /** Presence: keeps the viewer counted. */
    async wping(body) { const code = cleanCode(body.studio); await viewer(code, body); return { ok: true }; },

    /** A viewer's chat message, reaction or super chat claim. */
    async wsend(body) {
      const code = cleanCode(body.studio), k = WK(code);
      const v = await viewer(code, body);
      const st = await stateOf(code);
      if (!st) throw new HttpError(404, 'This show isn’t on right now.');
      const w = publicWatch(st);
      const members = await loadMembers(code);
      if (body.type === 'react') {
        const i = REACTS.indexOf(body.emoji);
        if (i < 0) throw new HttpError(400, 'Unknown reaction.');
        const key = k.react(bucket(), i);
        await store.pipe([['INCR', key], ['EXPIRE', key, 40]]);
        if (members.size) await deliver(code, members, { type: 'react', emoji: body.emoji });
        return { ok: true };
      }
      const why = muted(st, v.name);
      if (why) throw new HttpError(403, why);
      // Check the request first, so a refused one (wrong amount, chat off) doesn't use up the viewer's slow-mode slot.
      let method = '', amount = 0, text = '';
      if (body.type === 'super') {
        if (!w.supers) throw new HttpError(400, 'Super chats are off for this show.');
        method = METHODS.includes(body.method) && w.pay[body.method] ? body.method : '';
        if (!method) throw new HttpError(400, 'Pick how you paid.');
        amount = Math.round(num(body.amount, 0, 10000, 0) * 100) / 100;
        if (amount < w.min) throw new HttpError(400, `Super chats start at $${w.min}.`);
      } else {
        if (!w.chat) throw new HttpError(400, 'Chat is off for this show.');
        text = clean(body.text, 300);
        if (!text) throw new HttpError(400, 'Type a message first.');
      }
      const [fresh] = await store.pipe([['SET', k.rl(v.vid), '1', 'NX', 'EX', Math.max(1, w.slow)]]);
      if (!fresh) throw new HttpError(429, w.slow ? `Slow mode: one message every ${w.slow} s.` : 'Slow down a little.');
      if (body.type === 'super') {
        const sc = { id: 'sc-' + rid(5), vid: v.vid, name: v.name, text: clean(body.text, 200), amount, method, ts: Date.now(), status: 'pending' };
        await store.pipe([['HSET', k.sc, sc.id, JSON.stringify(sc)], ['EXPIRE', k.sc, TTL]]);
        const [host] = await store.pipe([['GET', K(code).host]]);
        const h = members.get(host);
        if (h) await deliver(code, new Map([[h.id, h]]), { type: 'superchat', item: sc });
        return { id: sc.id, status: 'pending' };
      }
      const item = { id: 'w-' + rid(5), src: 'watch', name: v.name, text, ts: Date.now() };
      await store.pipe([['RPUSH', k.chat, JSON.stringify(item)], ['LTRIM', k.chat, -200, -1], ['EXPIRE', k.chat, TTL]]);
      if (members.size) await deliver(code, members, { type: 'feed', items: [item] });
      return { id: item.id };
    },

    /** Host only (called from studio.send): confirm, dismiss or mark a super chat answered. */
    async hostSuperchat(code, op, members) {
      const k = WK(code);
      const [raw] = await store.pipe([['HGET', k.sc, String(op.id || '')]]);
      const sc = parse(raw);
      if (!sc) return null;
      const next = { confirm: 'confirmed', dismiss: 'dismissed', answered: 'answered' }[op.do];
      if (!next) return null;
      const wasPublic = sc.status === 'confirmed' || sc.status === 'answered';
      sc.status = next;
      await store.pipe([['HSET', k.sc, sc.id, JSON.stringify(sc)]]);
      if (next === 'confirmed' && !wasPublic) {
        const paid = '$' + (Number.isInteger(sc.amount) ? sc.amount : sc.amount.toFixed(2));
        const item = { id: 'w-' + sc.id, sc: sc.id, src: 'watch', name: sc.name, text: sc.text || 'Sent a super chat', paid, ts: Date.now(), status: 'confirmed' };
        await store.pipe([['RPUSH', k.chat, JSON.stringify(item)], ['LTRIM', k.chat, -200, -1], ['EXPIRE', k.chat, TTL]]);
        await deliver(code, members, { type: 'feed', items: [item] });
      }
      return sc;
    },
    async hostSuperchats(code) {
      const [flat] = await store.pipe([['HGETALL', WK(code).sc]]);
      const out = [];
      for (let i = 1; i < (flat || []).length; i += 2) { const x = parse(flat[i]); if (x) out.push(x); }
      return out.sort((a, b) => a.ts - b.ts);
    },
    // ---- direct WebRTC viewing: the host's browser sends the program to each viewer, no platform in between ----
    // Signalling only goes through gather (offers, answers, ICE); the video flows browser to browser (or via TURN).
    // A laptop can encode and upload the program for a handful of viewers, so the host sets a cap (default 6).

    /** A viewer asks for the live picture. */
    async wrtcJoin(body, iceServers) {
      const code = cleanCode(body.studio), k = WK(code);
      const v = await viewer(code, body);
      const st = await stateOf(code);
      const members = await loadMembers(code);
      const [host] = await store.pipe([['GET', K(code).host]]);
      const h = members.get(host);
      if (!st || !h) throw new HttpError(404, 'The host isn’t in the studio right now.');
      const cap = st.watch?.direct === false ? 0 : num(st.watch?.cap, 0, 30, 6);
      if (!cap) return { full: true, reason: 'off' };
      const [flat] = await store.pipe([['HGETALL', `g:${code}:wv`]]);
      const now = Date.now(); let active = 0;
      for (let i = 0; i < (flat || []).length; i += 2) if (flat[i] !== v.vid && now - Number(flat[i + 1]) < 30_000) active++;
      if (active >= cap) return { full: true, reason: 'cap', cap };
      await store.pipe([['HSET', `g:${code}:wv`, v.vid, String(now)], ['EXPIRE', `g:${code}:wv`, TTL], ['DEL', `g:${code}:vin:${v.vid}:${v.tok}`]]);
      await deliver(code, new Map([[h.id, h]]), { type: 'viewer-want', vid: v.vid });
      return { ok: true, iceServers: await iceServers() };
    },
    /** Viewer → host: an answer or ICE candidate. */
    async wrtcSignal(body) {
      const code = cleanCode(body.studio);
      const v = await viewer(code, body);
      const members = await loadMembers(code);
      const [host] = await store.pipe([['GET', K(code).host]]);
      const h = members.get(host);
      if (h) await deliver(code, new Map([[h.id, h]]), { type: 'vsignal', from: v.vid, data: body.data });
      await store.pipe([['HSET', `g:${code}:wv`, v.vid, String(Date.now())]]);
      return { ok: true };
    },
    /** The viewer's private inbox of host signals. Also keeps their viewing slot. */
    async wrtcPoll(body) {
      const code = cleanCode(body.studio);
      const v = await viewer(code, body);
      const key = `g:${code}:vin:${v.vid}:${v.tok}`;
      const [msgs] = await store.pipe([['LPOP', key, 100], ['HSET', `g:${code}:wv`, v.vid, String(Date.now())]]);
      return { msgs: (Array.isArray(msgs) ? msgs : msgs ? [msgs] : []).map((m) => parse(m)).filter(Boolean) };
    },
    async wrtcLeave(body) {
      const code = cleanCode(body.studio);
      const v = await viewer(code, body).catch(() => null);
      if (!v) return { ok: true };
      await store.pipe([['HDEL', `g:${code}:wv`, v.vid]]);
      const members = await loadMembers(code);
      const [host] = await store.pipe([['GET', K(code).host]]);
      const h = members.get(host);
      if (h) await deliver(code, new Map([[h.id, h]]), { type: 'viewer-left', vid: v.vid });
      return { ok: true };
    },
    /** Host → viewer signal (called from studio.send). */
    async hostVsignal(code, op) {
      const vid = String(op.to || '').replace(/[^a-f0-9]/g, '').slice(0, 16);
      const [raw] = await store.pipe([['HGET', WK(code).viewers, vid]]);
      const v = parse(raw);
      if (!v) return;
      const key = `g:${code}:vin:${vid}:${v.tok}`;
      await store.pipe([['RPUSH', key, JSON.stringify({ type: 'signal', data: op.data })], ['EXPIRE', key, 600]]);
    },
    REACTS, METHODS,
  };
};
