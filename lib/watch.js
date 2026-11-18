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
    return { chat: w.chat !== false, supers: !!w.supers && METHODS.some((m) => w.pay?.[m]), join: !!w.join, voice: w.voice !== false, min: w.min || 2, slow: w.slow || 0, pay: w.pay || {}, about: w.about || '', links: w.links || [], pin: w.pin || '', goal: w.goal?.target > 0 ? { label: w.goal.label || '', target: w.goal.target } : null };
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
      const [st0] = await store.pipe([['GET', K(code).state]]);
      const pollId = parse(st0)?.poll?.id || 'none';
      const [st, chat, viewers, scs, caps, likes, reps, votes, queue, ...rc] = await store.pipe([
        ['GET', K(code).state], ['LRANGE', k.chat, -80, -1], ['HGETALL', k.viewers], ['HGETALL', k.sc], ['LRANGE', `g:${code}:wcap`, -3, -1],
        ['HGETALL', `g:${code}:wlikes`], ['HGETALL', `g:${code}:wrep`], ['HGETALL', `g:${code}:wpoll:${pollId}`], ['HGETALL', `g:${code}:wq`],
        ...REACTS.flatMap((_, i) => [['GET', k.react(b, i)], ['GET', k.react(b - 1, i)]]),
      ]);
      const s = parse(st);
      if (!s) return { found: false, at: Date.now() };
      const now = Date.now();
      let count = 0; const here = [];
      for (let i = 1; i < (viewers || []).length; i += 2) { const v = parse(viewers[i]); if (v && now - v.seen < 45_000) { count++; if (v.named && here.length < 12) here.push(v.name); } }
      const status = {}; let raised = 0;
      for (let i = 0; i < (scs || []).length; i += 2) { const x = parse(scs[i + 1]); if (x) { status[scs[i]] = x.status; if (x.status === 'confirmed' || x.status === 'answered') raised += Number(x.amount) || 0; } }
      const hidden = new Set(s.mod?.hidden || []);
      const pairs = (flat) => { const o = {}; for (let i = 0; i < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1]; return o; };
      const likeN = pairs(likes), repN = pairs(reps);
      // Three spam reports hide a message for everyone until the host restores it.
      const items = (chat || []).map((x) => parse(x)).filter((x) => x && !hidden.has(x.id) && !muted(s, x.name) && !(Number(repN[x.id] || 0) >= 3 && !x.paid))
        .map((x) => ({ ...(x.sc ? { ...x, status: status[x.sc] || x.status } : x), likes: Number(likeN[x.id] || 0) }));
      const pv = pairs(votes), poll = s.poll ? { ...s.poll, counts: s.poll.opts.map((_, i) => Number(pv[i] || 0)) } : null;
      const q = Object.values(pairs(queue)).map((x) => parse(x)).filter(Boolean).sort((a, b) => a.ts - b.ts);
      const reacts = Object.fromEntries(REACTS.map((e, i) => [e, Number(rc[i * 2] || 0) + Number(rc[i * 2 + 1] || 0)]));
      const f = s.featured;
      return {
        found: true, at: now, title: clean(s.title, 100), color: /^#[0-9a-f]{6}$/i.test(s.brand?.color || '') ? s.brand.color : null,
        live: s.live || null, rec: !!s.rec?.on, watch: publicWatch(s), chat: items, viewers: count, here, reacts, raised: Math.round(raised * 100) / 100,
        caps: (caps || []).map((x) => parse(x)).filter((x) => x && now - x.ts < 15_000), capsOnStage: !!s.captions?.on, aspect: s.aspect || '16:9',
        shop: s.shop || null, poll, emotes: s.emotes || [], focus: s.focus ?? 0.5,
        queue: { open: !!s.watch?.queue, size: q.filter((x) => x.status !== 'called').length, up: q.filter((x) => x.status !== 'called').slice(0, 5).map((x) => x.name) },
        featured: f ? { id: f.id, name: f.name, text: f.text, src: f.src, paid: f.paid || '' } : null,
      };
    },

    /** A viewer picks a name for the chat. Returns a private token for their later messages. */
    async whello(body) {
      const code = cleanCode(body.studio);
      // A signed-in viewer chats under their account name, with a small avatar the page made from their photo.
      let acct = null;
      if (body.acct) { try { acct = await require('./accounts').authUser(String(body.acct)); } catch { throw new HttpError(401, 'Your sign-in ended. Sign in again to chat.'); } }
      const name = acct ? clean(acct.name, 24) : clean(body.name, 24);
      const av = typeof body.av === 'string' && body.av.length <= 9000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(body.av) ? body.av : '';
      const extra = acct ? { uid: acct.id, ...(av ? { av } : {}) } : {};
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
        if (v) { await store.pipe([['HSET', WK(code).viewers, v.vid, JSON.stringify({ name, tok: v.tok, seen: Date.now(), named: true, ...extra })]]); return { vid: v.vid, vtok: v.tok, name, signed: !!acct }; }
      }
      const vid = rid(8), tok = rid(12);
      await store.pipe([['HSET', WK(code).viewers, vid, JSON.stringify({ name, tok, seen: Date.now(), ...(acct ? { named: true } : {}), ...extra })], ['EXPIRE', WK(code).viewers, TTL]]);
      return { vid, vtok: tok, name, signed: !!acct };
    },

    /** Presence: keeps the viewer counted. Also tells a queued player when the host calls them. */
    async wping(body) {
      const code = cleanCode(body.studio); const v = await viewer(code, body);
      const [raw] = await store.pipe([['HGET', `g:${code}:wq`, v.vid]]);
      const qe = parse(raw);
      return { ok: true, queue: qe ? { status: qe.status || 'waiting' } : null };
    },
    /** Public: a custom emote's image, only for emotes the host has published. */
    async wemote(body) {
      const code = cleanCode(body.studio), id = String(body.asset || '').replace(/[^a-z0-9]/g, '').slice(0, 40);
      const st = await stateOf(code);
      if (!st || !(st.emotes || []).some((e) => e.asset === id)) throw new HttpError(404, 'No such emote.');
      const [data] = await store.pipe([['GET', `g:${code}:asset:${id}`]]);
      if (!data) throw new HttpError(404, 'No such emote.');
      return { data };
    },

    /** A viewer's chat message, reaction or super chat claim. */
    async wsend(body) {
      const code = cleanCode(body.studio), k = WK(code);
      const v = await viewer(code, body);
      const st = await stateOf(code);
      if (!st) throw new HttpError(404, 'This show isn’t on right now.');
      const w = publicWatch(st);
      const members = await loadMembers(code);
      // One-tap actions that never use the slow-mode slot.
      if (['like', 'report', 'vote', 'queue', 'unqueue'].includes(body.type)) return tapAction(code, st, v, body, members);
      if (body.type === 'voice') return voiceQuestion(code, st, v, body, members);
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
      const item = { id: 'w-' + rid(5), src: 'watch', name: v.name, text, ts: Date.now(), ...(v.av ? { av: v.av } : {}), ...(v.uid ? { signed: true } : {}), ...(body.type === 'question' ? { q: true } : {}) };
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
    /** Host: call the next player (or a chosen one) from the queue, or clear it. */
    async hostQueue(code, op) {
      const key = `g:${code}:wq`;
      if (op.type === 'qclear') { await store.pipe([['DEL', key]]); return []; }
      const [flat] = await store.pipe([['HGETALL', key]]);
      const list = []; for (let i = 0; i < (flat || []).length; i += 2) { const x = parse(flat[i + 1]); if (x) list.push({ vid: flat[i], ...x }); }
      list.sort((a, b) => a.ts - b.ts);
      const pick = op.vid ? list.find((x) => x.vid === op.vid) : list.find((x) => x.status !== 'called');
      if (pick) { pick.status = 'called'; await store.pipe([['HSET', key, pick.vid, JSON.stringify({ name: pick.name, tag: pick.tag, ts: pick.ts, status: 'called' })]]); }
      return list.map(({ vid, ...x }) => ({ ...x, vid }));
    },
    /** Host: voice questions (list, fetch audio, set status, delete). */
    async hostVoice(code, op) {
      const id = String(op.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 24);
      if (op.type === 'vmDel') { await store.pipe([['DEL', `g:${code}:vm:${id}`], ['HDEL', `g:${code}:vms`, id]]); return null; }
      const [raw] = await store.pipe([['HGET', `g:${code}:vms`, id]]); const it = parse(raw); if (!it) return null;
      it.status = op.status === 'aired' ? 'aired' : 'heard';
      await store.pipe([['HSET', `g:${code}:vms`, id, JSON.stringify(it)]]);
      return it;
    },
    async hostVoiceList(code) {
      const [flat] = await store.pipe([['HGETALL', `g:${code}:vms`]]); const out = [];
      for (let i = 1; i < (flat || []).length; i += 2) { const x = parse(flat[i]); if (x) out.push(x); }
      return out.sort((a, b) => b.ts - a.ts);
    },
    async hostVoiceAudio(code, id) { const [d] = await store.pipe([['GET', `g:${code}:vm:${String(id || '').replace(/[^a-z0-9-]/gi, '')}`]]); return d; },
    REACTS, METHODS,
  };

  /** A recorded voice question ("raise your hand"): stored for the host with the viewer's own speech-to-text. Only the
      host can fetch the audio; it's played on air only if they choose to, and deleted when they say so (or after 6 h). */
  async function voiceQuestion(code, st, v, body, members) {
    if (st.watch?.voice === false) throw new HttpError(400, 'Voice questions are off for this show.');
    const why = muted(st, v.name); if (why) throw new HttpError(403, why);
    const data = String(body.data || '');
    if (!/^data:audio\/(webm|ogg|mp4|mpeg|wav)[^;,]*(;[a-z0-9=.-]+)*;base64,[A-Za-z0-9+/=]+$/i.test(data)) throw new HttpError(400, 'That recording didn’t come through. Try again.');
    if (data.length > 450_000) throw new HttpError(413, 'Keep it under 45 seconds.');
    const [fresh] = await store.pipe([['SET', `g:${code}:vmrl:${v.vid}`, '1', 'NX', 'EX', 60]]);
    if (!fresh) throw new HttpError(429, 'One voice question a minute, please.');
    const item = { id: 'vm-' + rid(5), name: v.name, transcript: clean(body.transcript, 600), dur: Math.round(num(body.dur, 0, 60, 0)), ts: Date.now(), status: 'new' };
    await store.pipe([['SET', `g:${code}:vm:${item.id}`, data, 'EX', TTL], ['HSET', `g:${code}:vms`, item.id, JSON.stringify(item)], ['EXPIRE', `g:${code}:vms`, TTL]]);
    const [host] = await store.pipe([['GET', K(code).host]]); const h = members.get(host);
    if (h) await deliver(code, new Map([[h.id, h]]), { type: 'voicemail', item });
    return { id: item.id };
  }

  /** Likes, spam reports, poll votes and the play-with-me queue: one per viewer, no rate limit. */
  async function tapAction(code, st, v, body, members) {
    const once = async (key) => (await store.pipe([['SET', key, '1', 'NX', 'EX', TTL]]))[0];
    const msg = String(body.msg || '').replace(/[^a-z0-9-]/gi, '').slice(0, 24);
    if (body.type === 'like') {
      if (!msg) throw new HttpError(400, 'Which message?');
      if (await once(`g:${code}:wl:${msg}:${v.vid}`)) await store.pipe([['HINCRBY', `g:${code}:wlikes`, msg, 1], ['EXPIRE', `g:${code}:wlikes`, TTL]]);
      return { ok: true };
    }
    if (body.type === 'report') {
      if (!msg) throw new HttpError(400, 'Which message?');
      if (await once(`g:${code}:wr:${msg}:${v.vid}`)) {
        const [n] = await store.pipe([['HINCRBY', `g:${code}:wrep`, msg, 1], ['EXPIRE', `g:${code}:wrep`, TTL]]);
        const [host] = await store.pipe([['GET', K(code).host]]); const h = members.get(host);
        if (h) await deliver(code, new Map([[h.id, h]]), { type: 'wreport', msg, count: n, by: v.name });
      }
      return { ok: true };
    }
    if (body.type === 'vote') {
      const p = st.poll, opt = Number(body.opt);
      if (!p || p.id !== body.poll || Date.now() > p.until || !Number.isInteger(opt) || opt < 0 || opt >= p.opts.length) throw new HttpError(400, 'That poll has closed.');
      if (!(await once(`g:${code}:wv:${p.id}:${v.vid}`))) throw new HttpError(409, 'You already voted.');
      await store.pipe([['HINCRBY', `g:${code}:wpoll:${p.id}`, String(opt), 1], ['EXPIRE', `g:${code}:wpoll:${p.id}`, TTL]]);
      return { ok: true };
    }
    const key = `g:${code}:wq`;
    if (body.type === 'unqueue') { await store.pipe([['HDEL', key, v.vid]]); return { ok: true }; }
    if (!st.watch?.queue) throw new HttpError(400, 'The host isn’t taking players right now.');
    const [n] = await store.pipe([['HGETALL', key]]);
    if ((n || []).length / 2 >= 100) throw new HttpError(429, 'The queue is full.');
    const tag = clean(body.tag, 32);
    await store.pipe([['HSET', key, v.vid, JSON.stringify({ name: v.name, tag, ts: Date.now(), status: 'waiting' })], ['EXPIRE', key, TTL]]);
    const [host] = await store.pipe([['GET', K(code).host]]); const h = members.get(host);
    if (h) await deliver(code, new Map([[h.id, h]]), { type: 'wqueue', name: v.name, tag });
    return { ok: true };
  }
};
