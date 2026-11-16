// The public watch page (/w/<studio>): the show straight from the studio over WebRTC (no platform in between),
// with the host's YouTube/Twitch/Kick players as a fallback, a live chat, reactions, super chats paid directly to
// the host, and "Ask to join the stage". Viewers never need an account.
const $ = (s) => document.querySelector(s);
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return ''; } };
const code = safeDecode(location.pathname.split('/')[2] || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
const NAMES = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick', facebook: 'Facebook', x: 'X', rumble: 'Rumble', custom: 'Watch' };
const HOSTS = { 'youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'twitch.tv': 'Twitch', 'kick.com': 'Kick', 'facebook.com': 'Facebook', 'x.com': 'X', 'twitter.com': 'X', 'rumble.com': 'Rumble' };
const PAY = {
  paypal: { label: 'PayPal', link: (h, a) => `https://paypal.me/${encodeURIComponent(h)}/${a}USD` },
  venmo: { label: 'Venmo', link: (h, a, note) => `https://venmo.com/?txn=pay&audience=private&recipients=${encodeURIComponent(h)}&amount=${a}&note=${encodeURIComponent(note)}` },
  cashapp: { label: 'Cash App', link: (h, a) => `https://cash.app/$${encodeURIComponent(h)}/${a}` },
  stripe: { label: 'Card · Apple Pay · Google Pay', link: (h) => h },
};
const REACTS = ['❤️', '🔥', '😂', '👏', '🎉', '😮'];
function nameOf(l) { try { const h = new URL(l.url).hostname.replace(/^www\.|^m\./, ''); return HOSTS[h] || NAMES[l.kind] || h; } catch { return NAMES[l.kind] || 'Watch'; } }

/** An embeddable player address for a public watch link, or '' when the platform has no embed we can build. */
export function embedFor(kind, raw, host = location.hostname) {
  let u; try { u = new URL(raw); } catch { return ''; }
  const h = u.hostname.replace(/^www\.|^m\./, '');
  if (h === 'twitch.tv') { const ch = u.pathname.split('/')[1]; return /^[a-z0-9_]{2,25}$/i.test(ch || '') ? `https://player.twitch.tv/?channel=${ch}&parent=${host}&muted=true` : ''; }
  if (h === 'kick.com') { const ch = u.pathname.split('/')[1]; return /^[a-z0-9_-]{2,30}$/i.test(ch || '') ? `https://player.kick.com/${ch}?muted=true` : ''; }
  if (h === 'youtu.be') { const id = u.pathname.slice(1); return /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/embed/${id}?autoplay=1&mute=1` : ''; }
  if (h === 'youtube.com') {
    const v = u.searchParams.get('v') || (u.pathname.match(/^\/(?:live|embed|shorts)\/([\w-]{11})/) || [])[1];
    if (v && /^[\w-]{11}$/.test(v)) return `https://www.youtube.com/embed/${v}?autoplay=1&mute=1`;
    const ch = (u.pathname.match(/^\/channel\/(UC[\w-]{22})/) || [])[1];
    if (ch) return `https://www.youtube.com/embed/live_stream?channel=${ch}&autoplay=1&mute=1`;
  }
  return '';
}

// ---------------------------------------------------------------- state
const W = { info: null, shown: new Set(), source: 'direct', iframe: '', direct: { state: 'idle', pc: null, gen: 0 }, lastReacts: null };
const store = {
  get(k, d) { try { const v = localStorage.getItem('gather:w:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gather:w:' + k, JSON.stringify(v)); } catch {} },
};
let sess = store.get('sess:' + code, null); // { vid, vtok, name, named }

async function api(action, body) {
  const r = await fetch(`/api/studio?action=${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studio: code, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong. Try again.'); e.status = r.status; throw e; }
  return j;
}
const creds = () => ({ vid: sess?.vid, vtok: sess?.vtok });
function toast(msg, err) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; t.setAttribute('role', err ? 'alert' : 'status');
  $('#toasts').append(t); setTimeout(() => t.remove(), 3500);
}
/** A viewer session exists from the first visit (so the video and the viewer count work); a chat name comes later. */
async function ensureSession() {
  if (sess) return sess;
  const r = await api('whello', { name: 'Viewer ' + Math.floor(1000 + Math.random() * 9000) });
  sess = { ...r, named: false }; store.set(skey(), sess);
  return sess;
}
async function renew() { sess = null; store.set(skey(), null); return ensureSession(); }
// On a named page (/w/maya) the studio behind it changes from show to show; a chat session belongs to one studio.
const skey = () => 'sess:' + (W.code || code);

// ---------------------------------------------------------------- feed (one cached GET shared by every viewer)
async function poll() {
  try {
    const r = await fetch(`/api/studio?action=wfeed&studio=${encodeURIComponent(code)}`);
    render(r.ok ? await r.json() : { found: false });
  } catch { $('#wEmptyH').textContent = 'Can’t reach gather right now. Retrying…'; }
  setTimeout(poll, document.hidden ? 8000 : 2000);
}

function clockText(since) {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n, i) => (i ? String(n).padStart(2, '0') : n)).join(':').replace(/^0:/, '');
}
function render(info) {
  W.info = info;
  if (info.code && info.code !== W.code) { W.code = info.code; sess = store.get(skey(), null); }
  const title = info.found ? info.title || 'Live show' : info.offline ? `${info.name} · offline` : info.unclaimed ? 'Nobody here yet' : 'Show not found';
  $('#wTitle').textContent = title; document.title = `${title} · Watch live`;
  if (info.color) document.documentElement.style.setProperty('--accent', info.color);
  const live = !!(info.found && info.live?.on);
  const onAir = live || W.direct.state === 'live';
  $('#wLive').hidden = !onAir;
  $('#wv').classList.toggle('on-air', onAir);
  $('#wAddr').textContent = location.host.replace(/^www\./, '') + location.pathname;
  $('#wLiveText').textContent = live ? 'Live · ' + clockText(info.live.since) : 'On air';
  $('#wViewers').hidden = !info.found;
  $('#wViewers').textContent = info.viewers ? `${info.viewers} watching` : '';
  const w = info.watch || {};
  $('#wSuperBtn').hidden = !w.supers || w.chat === false;
  // Voice questions replace the old call-in: raise a hand, record, the host decides.
  $('#wHand').hidden = $('#wMic').hidden = w.voice === false || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder;
  $('#wChatState').textContent = !info.found ? '' : w.chat === false ? 'Chat is off' : w.slow ? `Slow mode · ${w.slow}s` : '';
  $('#wCompose').hidden = !info.found || w.chat === false;
  renderChat(info.chat || []);
  $('#wChat').classList.toggle('quiet', !$('#wMsgs li.row, #wMsgs li.paid'));
  renderTops(info.chat || []);
  renderAbout(info);
  renderShopUI(info); renderPollCard(info); renderQueueCard(info); renderHype(info); renderVertical(info);
  renderCaps(info);
  renderSources(info);
  floatReacts(info.reacts);
}

function renderChat(items) {
  const log = $('#wMsgs'), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  for (const m of items) {
    if (W.muted.has(String(m.name).toLowerCase())) continue;
    const old = log.querySelector(`[data-id="${CSS.escape(m.id)}"] .wv-like`); if (old) old.textContent = m.likes ? `♥ ${m.likes}` : '';
    const key = m.id + ':' + (m.status || '');
    if (W.shown.has(key)) continue;
    if (W.booted && sess?.named && m.name !== sess.name && new RegExp('@' + sess.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(m.text)) toast(`${m.name} mentioned you.`);
    W.shown.add(key);
    log.querySelector(`[data-id="${CSS.escape(m.id)}"]`)?.remove();
    log.querySelector(`[data-sc="${CSS.escape(m.sc || '')}"]`)?.remove(); // my own pending claim, now confirmed
    log.append(msgEl(m));
  }
  while (log.children.length > 200) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight; else if (items.length) $('#wNewer').hidden = false;
  W.booted = true;
}
$('#wMsgs').addEventListener('scroll', () => { const l = $('#wMsgs'); if (l.scrollHeight - l.scrollTop - l.clientHeight < 40) $('#wNewer').hidden = true; });
$('#wNewer').onclick = () => { const l = $('#wMsgs'); l.scrollTop = l.scrollHeight; $('#wNewer').hidden = true; };
const NAME_COLORS = ['#7fa8ff', '#f472b6', '#fbbf24', '#34d399', '#a78bfa', '#38bdf8', '#fb923c', '#f87171'];
const nameColor = (n) => NAME_COLORS[[...String(n)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % NAME_COLORS.length];
function msgEl(m) {
  const li = document.createElement('li');
  li.dataset.id = m.id; li.dataset.name = m.name; if (m.sc) li.dataset.sc = m.sc;
  if (m.paid) li.className = 'paid' + (m.status === 'answered' ? ' answered' : '') + (m.status === 'pending' ? ' pending' : '');
  else li.className = 'row' + (m.q ? ' q' : '');
  const mine = sess?.named && m.name === sess.name;
  if (mine) li.classList.add('me');
  if (!mine && sess?.named && new RegExp('@' + sess.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(m.text)) li.classList.add('mention');
  if (m.paid) { const a = document.createElement('span'); a.className = 'amt'; a.textContent = m.paid; li.append(a); const b = document.createElement('b'); b.textContent = m.name; li.append(b, richText(m.text)); return li; }
  // avatar · name · time · text, then like / reply / more on hover
  const av = document.createElement('span'); av.className = 'wv-av'; av.style.background = nameColor(m.name); av.textContent = (m.name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); av.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div');
  const head = document.createElement('div'); head.className = 'wv-mh';
  const b = document.createElement('b'); b.textContent = m.name; if (!mine) b.style.color = nameColor(m.name);
  const t = document.createElement('time'); const d = new Date(m.ts || Date.now()); t.dateTime = d.toISOString(); t.textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  head.append(b, t);
  if (m.q) { const q = document.createElement('span'); q.className = 'wv-qb'; q.innerHTML = '<svg class="i" aria-hidden="true"><use href="/icons.svg#i-hand"/></svg>Question'; head.append(q); }
  const lk = document.createElement('span'); lk.className = 'wv-like'; lk.textContent = m.likes ? `♥ ${m.likes}` : ''; head.append(lk);
  body.append(head, richText(m.text));
  const acts = document.createElement('div'); acts.className = 'wv-acts';
  const mk = (txt, label, fn) => { const k = document.createElement('button'); k.type = 'button'; k.textContent = txt; k.setAttribute('aria-label', label); k.title = label; k.onclick = fn; return k; };
  if (!String(m.id).startsWith('mine-')) {
    const like = mk('♥', 'Like', () => likeMsg(m.id, like)); like.setAttribute('aria-pressed', String(W.liked.has(m.id)));
    acts.append(like, mk('↩', 'Reply', () => { const x = $('#wText'); x.value = `@${m.name} ` + x.value.replace(/^@\S+\s/, ''); x.focus(); }));
    if (!mine) acts.append(mk('⚑', 'Report spam', () => reportMsg(m.id, li)), mk('🔇', `Mute ${m.name} for me`, () => muteName(m.name)));
  }
  li.append(av, body, acts);
  return li;
}
/** Message text with :emotes: as the host's images and @names highlighted. Built from text nodes, never HTML. */
function richText(text) {
  const span = document.createElement('span'); span.className = 'wv-mt';
  const emotes = new Map((W.info?.emotes || []).map((e) => [e.name, e.asset]));
  for (const part of String(text).split(/(:[a-z0-9_]{2,20}:|@[^\s@]{1,24})/i)) {
    if (!part) continue;
    const em = part.match(/^:([a-z0-9_]{2,20}):$/i);
    if (em && emotes.has(em[1].toLowerCase())) { const im = document.createElement('img'); im.className = 'emote'; im.alt = part; im.title = part; im.src = emoteSrc(emotes.get(em[1].toLowerCase())); span.append(im); continue; }
    if (/^@/.test(part)) { const a = document.createElement('span'); a.className = 'at'; a.textContent = part; span.append(a); continue; }
    span.append(document.createTextNode(part));
  }
  return span;
}
/** Top supporters: confirmed super chats this show, biggest first, pinned above the chat. */
function renderTops(items) {
  const by = new Map();
  for (const m of items) if (m.paid && m.status !== 'pending') by.set(m.name, (by.get(m.name) || 0) + Number(String(m.paid).replace(/[^0-9.]/g, '')));
  const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 5);
  $('#wTops').hidden = !top.length;
  $('#wTops').replaceChildren(...top.map(([n, a], i) => { const s = document.createElement('span'); const amt = document.createElement('i'); amt.textContent = '$' + (Number.isInteger(a) ? a : a.toFixed(2)); s.append(amt, (i === 0 ? '👑 ' : '') + n); return s; }));
}

// ---------------------------------------------------------------- sources: direct WebRTC first, platforms as fallback
function renderSources(info) {
  const links = info.found && info.live?.on ? info.live.links || [] : [];
  const embeds = links.map((l) => ({ ...l, embed: embedFor(l.kind, l.url) })).filter((l) => l.embed);
  const tabs = [];
  if (W.direct.state !== 'off') tabs.push({ id: 'direct', label: 'Direct · lowest delay' });
  for (const l of embeds) tabs.push({ id: l.embed, label: nameOf(l) });
  // Fall back to a platform only when the direct picture isn't available.
  if (W.source === 'direct' && W.direct.state === 'off' && embeds.length) W.source = embeds[0].embed;
  if (W.source !== 'direct' && !embeds.some((l) => l.embed === W.source)) W.source = 'direct';
  $('#wTabs').hidden = tabs.length < 2;
  $('#wTabs').replaceChildren(...tabs.map((t) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm' + (t.id === W.source ? ' on' : ''); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(t.id === W.source));
    b.textContent = t.label; b.onclick = () => { W.source = t.id; renderSources(W.info); };
    return b;
  }));
  $('#wLinks').replaceChildren(...links.map((l) => { const a = document.createElement('a'); a.className = 'btn sm ghost'; a.href = l.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = `Open on ${nameOf(l)}`; return a; }));
  showPlayer(info);
}
function showPlayer(info) {
  const box = $('#wPlayer');
  if (W.source === 'direct') {
    const v = W.direct.video;
    const playing = W.direct.state === 'live' && v;
    if (playing && v.parentElement !== box) box.replaceChildren(v);
    box.hidden = !playing; W.iframe = '';
    $('#wCtrls').hidden = !playing; $('#wUnmute').hidden = !playing || !v.muted;
    $('#wEmpty').hidden = !!playing;
    $('#wEmptyH').textContent = info.offline ? `${info.name} isn’t live right now.` : info.unclaimed ? `${location.host}/w/${info.handle} isn’t anyone’s page yet.` : !info.found ? 'This show isn’t on right now.' : W.direct.state === 'connecting' ? 'Connecting to the studio…' : W.direct.state === 'full' ? 'The direct stream is full right now.' : 'Waiting for the show to start.';
    $('#wEmptyP').textContent = info.offline ? 'Keep this page open — it starts playing by itself the moment they go on.' : info.unclaimed ? 'Claim it for free in the gather studio: Show → Your watch page.' : !info.found ? 'Check the link with the host.' : W.direct.state === 'full' ? 'Watch on one of the platforms below, or try again in a minute.' : 'This page starts playing by itself.';
  } else if (W.iframe !== W.source) {
    W.iframe = W.source;
    const f = document.createElement('iframe');
    f.src = W.source; f.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media'; f.allowFullscreen = true; f.title = 'Live player';
    box.replaceChildren(f); box.hidden = false; $('#wEmpty').hidden = true; $('#wUnmute').hidden = true; $('#wCtrls').hidden = true;
  }
}

// Direct viewing: the host's browser sends the program to this page over WebRTC. gather only relays the setup messages.
async function startDirect() {
  const D = W.direct, gen = ++D.gen;
  if (!W.info?.found) return setTimeout(startDirect, 4000);
  D.state = 'connecting'; render(W.info);
  let r;
  try { await ensureSession(); r = await api('wrtcJoin', creds()); }
  catch (e) {
    if (e.status === 401) { await renew().catch(() => {}); }
    D.state = 'idle'; render(W.info); return setTimeout(() => gen === D.gen && startDirect(), e.status === 404 ? 8000 : 4000);
  }
  if (r.full) { D.state = r.reason === 'off' ? 'off' : 'full'; render(W.info); return setTimeout(() => gen === D.gen && startDirect(), 30000); }
  const pc = new RTCPeerConnection({ iceServers: r.iceServers || [] });
  D.pc = pc;
  const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true; video.id = 'wDirect';
  const stream = new MediaStream(); video.srcObject = stream;
  pc.ontrack = (e) => { stream.addTrack(e.track); video.play().catch(() => {}); };
  // Switch from "Connecting…" to the picture only when a real frame has arrived, so viewers never see a black box.
  video.addEventListener('loadeddata', () => { if (gen !== D.gen) return; D.state = 'live'; D.video = video; render(W.info); setMuted(video.muted); if (W.q !== 'auto') setQuality(W.q); }, { once: true });
  pc.onicecandidate = (e) => { if (e.candidate) api('wrtcSignal', { ...creds(), data: { candidate: e.candidate } }).catch(() => {}); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected' && D.state !== 'live') D.state = 'connecting'; // "live" once a frame shows
    if (['failed', 'closed'].includes(pc.connectionState) && gen === D.gen) { stopDirect(); setTimeout(startDirect, 3000); }
  };
  // Read the host's offer and ICE from my inbox: quickly while connecting, slowly once playing.
  for (;;) {
    if (gen !== D.gen) return;
    let msgs = [];
    try { ({ msgs } = await api('wrtcPoll', creds())); } catch (e) { if (e.status === 401) { stopDirect(); await renew().catch(() => {}); return setTimeout(startDirect, 2000); } }
    for (const m of msgs) {
      const d = m.data || {};
      try {
        if (d.sdp) {
          await pc.setRemoteDescription(d.sdp);
          if (d.sdp.type === 'offer') { await pc.setLocalDescription(); await api('wrtcSignal', { ...creds(), data: { sdp: pc.localDescription } }); }
        } else if (d.candidate) await pc.addIceCandidate(d.candidate).catch(() => {});
        else if (d.bye) { stopDirect(); D.state = 'idle'; render(W.info); return setTimeout(startDirect, 5000); }
      } catch (err) { console.warn('direct signal', err); }
    }
    await new Promise((res) => setTimeout(res, D.state === 'live' ? 5000 : 400));
  }
}
function stopDirect() {
  const D = W.direct; D.gen++;
  try { D.pc?.close(); } catch {}
  D.pc = null; D.video = null; if (D.state !== 'off' && D.state !== 'full') D.state = 'idle';
}
function setMuted(m) {
  const v = W.direct.video; if (!v) return;
  v.muted = m; if (!m) v.play().catch(() => {});
  $('#wUnmute').hidden = !m || W.source !== 'direct';
  $('#wMute use').setAttribute('href', '/icons.svg#i-volume-' + (m ? 'x' : '2'));
  $('#wMute').setAttribute('aria-label', m ? 'Unmute (M)' : 'Mute (M)');
}
$('#wUnmute').onclick = () => setMuted(false);
$('#wMute').onclick = () => setMuted(!W.direct.video?.muted);
$('#wVol').oninput = (e) => { const v = W.direct.video; if (!v) return; v.volume = Number(e.target.value); setMuted(v.volume === 0); };
$('#wPip').hidden = !document.pictureInPictureEnabled;
$('#wPip').onclick = async () => { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await W.direct.video?.requestPictureInPicture(); } catch {} };
// Full-screen watch: the whole page goes full screen, the video fills it and the chat floats over it (C hides it).
$('#wFull').onclick = () => {
  if (document.fullscreenElement) return document.exitFullscreen();
  $('#wv').classList.add('theater');
  const go = $('#wv').requestFullscreen?.(); if (!go) return; // iPhone Safari has no page fullscreen: keep the overlay layout anyway
  go.catch(() => {});
};
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) $('#wv').classList.remove('theater'); if (document.fullscreenElement && innerHeight > innerWidth) setFill(true); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#wv').classList.contains('theater') && !document.fullscreenElement) $('#wv').classList.remove('theater'); });
function toggleChat() { const off = $('#wv').classList.toggle('no-chat'); $('#wChatToggle').setAttribute('aria-pressed', String(off)); $('#wChatToggle').setAttribute('aria-label', off ? 'Show chat (C)' : 'Hide chat (C)'); store.set('noChat', off); }
$('#wChatToggle').onclick = toggleChat;
if (store.get('noChat', false) && innerWidth > 900) toggleChat();
// Touch: tap the video to show the controls for a few seconds.
$('#wPlayerWrap').addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') { $('#wPlayerWrap').classList.add('show-ctrls'); clearTimeout(W.ctrlT); W.ctrlT = setTimeout(() => $('#wPlayerWrap').classList.remove('show-ctrls'), 3500); } });
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') { e.preventDefault(); $('#wFull').click(); } else if (k === 'm') { e.preventDefault(); setMuted(!W.direct.video?.muted); } else if (k === 'c') { e.preventDefault(); toggleChat(); }
});
// How far behind live the picture is (network round trip + the browser's jitter buffer), shown on the player.
setInterval(async () => {
  const pc = W.direct.pc;
  if (!pc || W.direct.state !== 'live') return ($('#wDelay').hidden = true);
  try {
    let rtt = 0, buf = 0;
    (await pc.getStats()).forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime;
      if (r.type === 'inbound-rtp' && r.kind === 'video' && r.jitterBufferEmittedCount) buf = r.jitterBufferDelay / r.jitterBufferEmittedCount;
    });
    const d = rtt / 2 + buf + 0.05;
    $('#wDelay').hidden = false; $('#wDelay').textContent = `Direct · ${d.toFixed(1)} s`; $('#wDelay').classList.toggle('slow', d > 1.5);
  } catch {}
}, 2000);
addEventListener('pagehide', () => { if (sess && W.direct.pc) navigator.sendBeacon?.('/api/studio?action=wrtcLeave', new Blob([JSON.stringify({ studio: code, ...creds() })], { type: 'application/json' })); });

// ---------------------------------------------------------------- reactions
function floatOne(e) {
  const s = document.createElement('span'); s.textContent = e; s.style.left = 8 + Math.random() * 84 + '%';
  $('#wFloats').append(s); setTimeout(() => s.remove(), 2600);
}
function floatReacts(r) {
  if (!r) return;
  const prev = W.lastReacts; W.lastReacts = r;
  if (!prev) return;
  for (const e of REACTS) { const n = Math.min(4, Math.max(0, (r[e] || 0) - (prev[e] || 0) - (W.mine[e] || 0))); for (let i = 0; i < n; i++) setTimeout(() => floatOne(e), i * 220); }
  W.mine = {};
}
W.mine = {};
$('#wReacts').replaceChildren(...REACTS.map((e) => {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = e; b.setAttribute('aria-label', 'React ' + e);
  b.onclick = async () => {
    floatOne(e); W.mine[e] = (W.mine[e] || 0) + 1;
    // Rapid taps build a combo on screen, and are sent as one burst every 600 ms rather than one call per tap.
    W.combo = W.comboE === e && Date.now() - W.comboT < 1200 ? W.combo + 1 : 1; W.comboE = e; W.comboT = Date.now();
    const c = $('#wCombo'); if (W.combo > 1) { c.hidden = false; c.textContent = `${e} ×${W.combo}`; c.style.animation = 'none'; void c.offsetWidth; c.style.animation = ''; }
    clearTimeout(W.comboHide); W.comboHide = setTimeout(() => { c.hidden = true; }, 1300);
    W.pendingReacts = (W.pendingReacts || 0) + 1;
    if (W.reactT) return;
    W.reactT = setTimeout(async () => { W.reactT = null; const n = Math.min(5, W.pendingReacts); W.pendingReacts = 0; try { await ensureSession(); for (let i = 0; i < n; i++) await api('wsend', { ...creds(), type: 'react', emoji: e }); } catch {} }, 600);
  };
  return b;
}));

// ---------------------------------------------------------------- chat
function showErr(sel, msg) { const e = $(sel); e.textContent = msg || ''; e.hidden = !msg; }
function renderMe() { $('#wMe').textContent = sess?.name || 'Name'; }
$('#wMe').onclick = () => { $('#wName').value = sess?.named ? sess.name : store.get('name', ''); showErr('#wNameErr', ''); $('#wNameDlg').showModal(); $('#wName').select(); };
let naming = null;
async function setName(name) {
  naming = (async () => { await ensureSession();
  sess = { ...(await api('whello', { ...creds(), name })), named: true }; store.set('sess:' + code, sess); store.set('name', name);
  renderMe(); })();
  try { await naming; } finally { naming = null; }
}
$('#wNameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#wName').value.trim();
  if (!name) return showErr('#wNameErr', 'Type a name.');
  // Close at once (feels instant) and save in the background; reopen only if the name is refused.
  $('#wNameDlg').close(); $('#wMe').textContent = name; $('#wText').focus();
  try { await setName(name); } catch (err) { renderMe(); showErr('#wNameErr', err.message); $('#wNameDlg').showModal(); }
});
$('#wCompose').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#wText').value.trim();
  if (!text) return;
  showErr('#wErr', '');
  try {
    if (naming) await naming.catch(() => {});
    await ensureSession(); renderMe();
    const asking = $('#wAsk').getAttribute('aria-pressed') === 'true';
    const r = await api('wsend', { ...creds(), type: asking ? 'question' : 'chat', text });
    if (asking) { setAsk(false); toast('Question sent. The host sees it highlighted.'); }
    $('#wText').value = '';
    W.shown.add(r.id + ':');
    $('#wMsgs').append(msgEl({ id: r.id, name: sess.name, text, ts: Date.now(), q: asking })); $('#wMsgs').scrollTop = $('#wMsgs').scrollHeight;
  } catch (err) {
    if (err.status === 401) { await renew().catch(() => {}); return showErr('#wErr', 'Your chat session ended. Send again.'); }
    showErr('#wErr', err.message);
  }
});

// ---------------------------------------------------------------- super chats (paid straight to the host)
const SC = { amount: 5, method: '', opened: false };
function openSuper() {
  const w = W.info?.watch || {};
  const methods = Object.keys(PAY).filter((m) => w.pay?.[m]);
  SC.method = methods.includes(SC.method) ? SC.method : methods[0] || '';
  SC.amount = Math.max(SC.amount, w.min || 2); SC.opened = false;
  const amounts = [...new Set([w.min || 2, 5, 10, 20, 50].filter((a) => a >= (w.min || 2)))].slice(0, 5);
  $('#wAmounts').replaceChildren(...amounts.map((a) => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = '$' + a;
    b.setAttribute('aria-checked', String(a === SC.amount)); b.onclick = () => { SC.amount = a; $('#wCustom').value = ''; openSuperRefresh(); };
    return b;
  }), Object.assign(document.createElement('input'), { className: 'input', id: 'wCustom', type: 'number', min: String(w.min || 2), max: '10000', step: '1', placeholder: 'Other amount ($)', inputMode: 'decimal' }));
  $('#wCustom').oninput = (e) => { const v = Number(e.target.value); if (v) SC.amount = v; openSuperRefresh(); };
  $('#wMethods').replaceChildren(...methods.map((m) => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.m = m; b.textContent = PAY[m].label;
    b.onclick = () => { SC.method = m; SC.opened = false; openSuperRefresh(); };
    return b;
  }));
  showErr('#wScErr', '');
  $('#wScName').value = sess?.named ? sess.name : store.get('name', '');
  openSuperRefresh();
  $('#wSuperDlg').showModal();
}
function openSuperRefresh() {
  $$('#wAmounts button').forEach((b) => b.setAttribute('aria-checked', String(b.textContent === '$' + SC.amount)));
  $$('#wMethods button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.m === SC.method)));
  const label = PAY[SC.method]?.label || '';
  $('#wPayGo').textContent = SC.method === 'stripe' ? `Pay $${SC.amount} by card, Apple Pay or Google Pay` : `Pay $${SC.amount} with ${label}`;
  $('#wPayNote').textContent = `Your payment goes straight to the host${SC.method === 'stripe' ? ' through Stripe' : ` on ${label}`}. gather never touches it. Enter $${SC.amount} if the app asks.`;
  $('#wPaid').disabled = !SC.opened;
}
const $$ = (s) => document.querySelectorAll(s);
$('#wSuperBtn').onclick = () => openSuper();
$('#wPayGo').onclick = async () => {
  const w = W.info?.watch || {}, handle = w.pay?.[SC.method];
  if (!handle) return;
  try { await ensureSession(); } catch {}
  window.open(PAY[SC.method].link(handle, SC.amount, `Super chat on gather: ${($('#wScText').value || '').slice(0, 60)}`), '_blank', 'noopener');
  SC.opened = true; openSuperRefresh();
};
$('#wPaid').onclick = async () => {
  showErr('#wScErr', '');
  try {
    await ensureSession();
    const nm = $('#wScName').value.trim();
    if (!nm) { $('#wScName').focus(); return showErr('#wScErr', 'Add your name so the host can thank you.'); }
    if (nm !== sess.name) await setName(nm);
    const r = await api('wsend', { ...creds(), type: 'super', amount: SC.amount, method: SC.method, text: $('#wScText').value.trim() });
    $('#wSuperDlg').close(); $('#wScText').value = '';
    $('#wMsgs').append(msgEl({ id: 'mine-' + r.id, sc: r.id, name: sess.name, text: 'Waiting for the host to confirm your super chat…', paid: '$' + SC.amount, status: 'pending' }));
    $('#wMsgs').scrollTop = $('#wMsgs').scrollHeight;
    toast('Sent. It shows up once the host sees your payment.');
  } catch (err) { showErr('#wScErr', err.message); }
};
$$('button[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog')?.close()));

// ---------------------------------------------------------------- share
$('#wShare').onclick = async () => {
  const url = location.origin + '/w/' + code;
  try { if (navigator.share) await navigator.share({ title: document.title, url }); else { await navigator.clipboard.writeText(url); toast('Link copied.'); } }
  catch {}
};

renderMe();
if (code) { poll(); startDirect(); setInterval(() => { if (W.info?.live?.on) $('#wLiveText').textContent = 'Live · ' + clockText(W.info.live.since); }, 1000); setInterval(() => { if (sess) api('wping', creds()).catch(() => {}); if ($('#wLive').hidden === false && W.info?.live?.since) $('#wLiveText').textContent = 'Live · ' + clockText(W.info.live.since); }, 30000); }
else render({ found: false });


// ---------------------------------------------------------------- revision 3: About, captions, quality, fill
function renderAbout(info) {
  const w = info.watch || {};
  $('#wAboutTitle').textContent = info.title || 'Live show';
  const bits = [info.live?.on ? `Live for ${clockText(info.live.since)}` : W.direct.state === 'live' ? 'On air now' : 'Not on air', info.viewers ? `${info.viewers} watching` : ''].filter(Boolean);
  $('#wAboutMeta').textContent = bits.join(' · ');
  $('#wAboutText').textContent = w.about || 'The host hasn’t written a description yet.';
  const links = [...(w.links || []), ...((info.live?.on && info.live.links) || []).map((l) => ({ label: 'Also live on ' + nameOf(l), url: l.url }))];
  const key = JSON.stringify(links);
  if (W.aboutKey === key) return;
  W.aboutKey = key;
  $('#wAboutLinks').replaceChildren(...links.map((l) => {
    const li = document.createElement('li'), a = document.createElement('a');
    a.href = l.url; a.target = '_blank'; a.rel = 'noopener nofollow'; a.textContent = l.label;
    const host = document.createElement('span'); try { host.textContent = new URL(l.url).hostname.replace(/^www\./, ''); } catch {}
    a.append(host); li.append(a); return li;
  }));
}
function setTab(tab) {
  tab = tab === true ? 'about' : tab === false ? 'chat' : tab;
  $('#wChat').classList.toggle('about', tab === 'about'); $('#wChat').classList.toggle('shop', tab === 'shop');
  $('#wAbout').hidden = tab !== 'about'; $('#wShop').hidden = tab !== 'shop';
  for (const [id, t] of [['#wTabChat', 'chat'], ['#wTabShop', 'shop'], ['#wTabAbout', 'about']]) $(id).setAttribute('aria-selected', String(tab === t));
}
$('#wTabChat').onclick = () => setTab('chat');
$('#wTabShop').onclick = () => setTab('shop');
$('#wTabAbout').onclick = () => setTab('about');
$('#wAboutShare').onclick = () => $('#wShare').click();

// Captions: lines from the studio's live captions. If the host already shows captions on screen, CC is redundant.
W.cc = store.get('cc', false);
function renderCaps(info) {
  const onStage = !!info.capsOnStage, b = $('#wCC');
  b.disabled = onStage; b.setAttribute('aria-pressed', String(W.cc && !onStage));
  b.dataset.tip = onStage ? 'Captions are already on screen' : 'Captions';
  const line = (info.caps || []).slice(-1)[0];
  const show = W.cc && !onStage && line && Date.now() - line.ts < 9000;
  $('#wCaps').hidden = !show;
  if (show) { $('#wCaps').replaceChildren(Object.assign(document.createElement('b'), { textContent: line.name }), document.createTextNode(line.text)); }
}
$('#wCC').onclick = () => { W.cc = !W.cc; store.set('cc', W.cc); if (W.info) renderCaps(W.info); if (W.cc && !(W.info?.caps || []).length) toast('Captions show here when the host turns on live captions.'); };

// Quality: Auto lets WebRTC adapt; picking one asks the host to send this viewer a smaller stream (saves data).
const QUALS = ['auto', '720', '480', '360'];
W.q = store.get('quality', 'auto');
function setQuality(q) {
  W.q = q; store.set('quality', q);
  $('#wQual').textContent = q === 'auto' ? 'Auto' : q + 'p';
  if (sess && W.direct.state === 'live') api('wrtcSignal', { ...creds(), data: { quality: q === 'auto' ? '720' : q } }).catch(() => {});
}
$('#wQual').onclick = () => setQuality(QUALS[(QUALS.indexOf(W.q) + 1) % QUALS.length]);
setQuality(W.q);

// Fill: crop the 16:9 picture to fill a tall screen (phones held upright, full screen).
function setFill(on) { $('#wPlayerWrap').classList.toggle('fill', on); $('#wFill').setAttribute('aria-pressed', String(on)); }
$('#wFill').onclick = () => setFill(!$('#wPlayerWrap').classList.contains('fill'));

// ---------------------------------------------------------------- chat: likes, reports, muting, questions, emoji, @mentions
W.liked = new Set(store.get('liked:' + code, []));
W.muted = new Set(store.get('muted', []));
async function likeMsg(id, btn) {
  if (W.liked.has(id)) return;
  W.liked.add(id); store.set('liked:' + code, [...W.liked].slice(-300)); btn?.setAttribute('aria-pressed', 'true');
  const lk = $(`[data-id="${CSS.escape(id)}"] .wv-like`); if (lk) { const n = (Number(lk.textContent.replace(/\D/g, '')) || 0) + 1; lk.textContent = `♥ ${n}`; }
  try { await ensureSession(); await api('wsend', { ...creds(), type: 'like', msg: id }); } catch {}
}
async function reportMsg(id, li) {
  li.remove(); toast('Reported. Messages reported by several viewers are hidden for everyone.');
  try { await ensureSession(); await api('wsend', { ...creds(), type: 'report', msg: id }); } catch {}
}
function muteName(name) {
  W.muted.add(String(name).toLowerCase()); store.set('muted', [...W.muted]);
  for (const li of document.querySelectorAll('#wMsgs li')) if (String(li.dataset.name).toLowerCase() === String(name).toLowerCase()) li.remove();
  toast(`You won’t see ${name}’s messages any more. Only you.`);
}
function setAsk(on) { $('#wAsk').setAttribute('aria-pressed', String(on)); $('#wText').placeholder = on ? 'Ask the host a question…' : 'Say something…'; }
$('#wAsk').onclick = () => { setAsk($('#wAsk').getAttribute('aria-pressed') !== 'true'); $('#wText').focus(); };
const emoteSrc = (asset) => `/api/studio?action=wemote&studio=${encodeURIComponent(code)}&asset=${encodeURIComponent(asset)}`;
// Emote images come back as JSON {data}; swap each <img> to its data URL once loaded.
const emoteData = new Map();
new MutationObserver(() => {
  for (const im of document.querySelectorAll('img.emote:not([data-ok]), .wv-picker img:not([data-ok])')) {
    im.dataset.ok = '1';
    const u = im.getAttribute('src'); if (!u || u.startsWith('data:')) continue;
    if (!emoteData.has(u)) emoteData.set(u, fetch(u).then((r) => r.json()).then((j) => j.data).catch(() => ''));
    emoteData.get(u).then((d) => { if (d) im.src = d; });
  }
}).observe(document.body, { childList: true, subtree: true });
const EMOJI = ['😂', '🤣', '😍', '😮', '😢', '😡', '👍', '👎', '🙏', '👏', '🔥', '💯', '🎉', '❤️', '💀', '😎', '🤯', '🥶', '😱', '🤔', '👀', '✅', '❌', '⚡', '🏆', '🎮', '🕹️', '🎯', '💎', '🚀', '🍿', 'GG', 'W', 'L', 'POG', '🤝'];
function openPicker() {
  const box = $('#wPicker'), emotes = W.info?.emotes || [];
  const btn = (label, insert, img) => { const b = document.createElement('button'); b.type = 'button'; if (img) { const i = document.createElement('img'); i.src = img; i.alt = label; b.append(i); } else b.textContent = label; b.title = label; b.onclick = () => { insertText(insert); }; return b; };
  const parts = [];
  if (emotes.length) { const h = document.createElement('h3'); h.textContent = 'This show'; parts.push(h, ...emotes.map((e) => btn(`:${e.name}:`, `:${e.name}: `, emoteSrc(e.asset)))); const h2 = document.createElement('h3'); h2.textContent = 'Emoji'; parts.push(h2); }
  parts.push(...EMOJI.map((e) => btn(e, e.length > 2 ? e + ' ' : e)));
  box.replaceChildren(...parts); box.hidden = false; $('#wEmoji').setAttribute('aria-expanded', 'true');
}
function closePicker() { $('#wPicker').hidden = true; $('#wEmoji').setAttribute('aria-expanded', 'false'); }
function insertText(t) { const x = $('#wText'), at = x.selectionStart ?? x.value.length; x.value = x.value.slice(0, at) + t + x.value.slice(x.selectionEnd ?? at); x.focus(); x.selectionStart = x.selectionEnd = at + t.length; }
$('#wEmoji').onclick = (e) => { e.stopPropagation(); if ($('#wPicker').hidden) openPicker(); else closePicker(); };
document.addEventListener('click', (e) => { if (!e.target.closest('#wPicker, #wEmoji')) closePicker(); if (!e.target.closest('#wMentions, #wText')) $('#wMentions').hidden = true; });
// @mentions: typing @ suggests people who chatted recently.
$('#wText').addEventListener('input', () => {
  const x = $('#wText'), m = x.value.slice(0, x.selectionStart).match(/@([^\s@]{0,24})$/);
  const box = $('#wMentions');
  if (!m) { box.hidden = true; return; }
  const names = [...new Set([...document.querySelectorAll('#wMsgs li[data-name]')].map((li) => li.dataset.name).reverse())].filter((n) => n !== sess?.name && n.toLowerCase().startsWith(m[1].toLowerCase())).slice(0, 6);
  if (!names.length) { box.hidden = true; return; }
  box.replaceChildren(...names.map((n) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = '@' + n; b.onclick = () => { const at = x.selectionStart; x.value = x.value.slice(0, at - m[0].length) + '@' + n + ' ' + x.value.slice(at); box.hidden = true; x.focus(); }; return b; }));
  box.hidden = false;
});

// ---------------------------------------------------------------- shop: pinned product, flash sale, Shop tab
function money(p) { return p || ''; }
function productCard(p, sale) {
  const card = document.createElement('div'); card.className = 'wv-card' + (sale ? ' sale' : '');
  const k = document.createElement('div'); k.className = 'k'; const l = document.createElement('span'); l.textContent = sale ? `⚡ Flash sale${sale.pct ? ' · ' + sale.pct + '% off' : ''}` : '🛍 Featured now';
  const r = document.createElement('span'); r.className = 'wv-cd'; if (sale) r.dataset.until = sale.until; k.append(l, r);
  const row = document.createElement('div'); row.className = 'wv-prod';
  const im = document.createElement(p.img ? 'img' : 'div'); if (p.img) { im.src = p.img; im.alt = ''; im.loading = 'lazy'; } else { im.className = 'ph'; im.textContent = '🛍'; }
  const txt = document.createElement('div'); const b = document.createElement('b'); b.textContent = p.title; const sm = document.createElement('small'); sm.textContent = money(p.price); txt.append(b, sm);
  const buy = document.createElement('a'); buy.className = 'btn wv-buy'; buy.href = p.url; buy.target = '_blank'; buy.rel = 'noopener'; buy.textContent = 'Buy';
  buy.onclick = () => { if (sale?.code) navigator.clipboard?.writeText(sale.code).then(() => toast(`Code ${sale.code} copied. Paste it at checkout.`)).catch(() => {}); };
  row.append(im, txt, buy); card.append(k, row);
  if (sale?.code) { const c = document.createElement('div'); c.className = 'wv-code'; c.append('Use code ', Object.assign(document.createElement('code'), { textContent: sale.code }), ' at checkout'); card.append(c); }
  return card;
}
function renderShopUI(info) {
  const sh = info.shop, items = sh?.items || [];
  $('#wTabShop').hidden = !items.length;
  if (!items.length && $('#wChat').classList.contains('shop')) setTab('chat');
  const sale = sh?.sale && sh.sale.until > Date.now() ? sh.sale : null;
  const key = JSON.stringify([sh?.pinned, sale, items.map((x) => x.id)]);
  if (W.shopKey !== key) {
    W.shopKey = key;
    $('#wShopNote').textContent = items.length ? `Checkout happens on ${sh.store || 'the seller’s store'}.` : '';
    $('#wProducts').replaceChildren(...items.map((p) => { const li = document.createElement('li'); const a = document.createElement('a'); a.href = p.url; a.target = '_blank'; a.rel = 'noopener'; if (sale?.id === p.id) li.className = 'on-sale';
      const im = document.createElement(p.img ? 'img' : 'div'); if (p.img) { im.src = p.img; im.alt = ''; im.loading = 'lazy'; } else { im.className = 'ph'; im.textContent = '🛍'; }
      const b = document.createElement('b'); b.textContent = p.title; const sm = document.createElement('small'); sm.textContent = sale?.id === p.id ? `${p.price} · ${sale.pct ? sale.pct + '% off with ' : 'code '}${sale.code}` : p.price; a.append(im, b, sm); li.append(a); return li; }));
    $('#wCards').querySelector('[data-card="shop"]')?.remove();
    const p = items.find((x) => x.id === sh?.pinned);
    if (p) { const c = productCard(p, sale?.id === p.id ? sale : null); c.dataset.card = 'shop'; $('#wCards').prepend(c); if (W.booted && sale?.id === p.id) toast(`⚡ Flash sale: ${p.title}`); }
  }
}
// countdowns tick every second
setInterval(() => { for (const el of document.querySelectorAll('[data-until]')) { const ms = Number(el.dataset.until) - Date.now(); el.textContent = ms > 0 ? `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')} left` : 'ended'; } }, 1000);

// ---------------------------------------------------------------- polls and predictions
W.votes = store.get('votes:' + code, {});
function renderPollCard(info) {
  const p = info.poll; let card = $('#wCards [data-card="poll"]');
  if (!p) { card?.remove(); return; }
  const open = p.until > Date.now(), mine = W.votes[p.id], total = p.counts.reduce((a, b) => a + b, 0), show = !open || mine != null;
  const key = JSON.stringify([p.id, p.counts, open, mine, p.answer]);
  if (card?.dataset.key === key) return;
  const fresh = document.createElement('div'); fresh.className = 'wv-card'; fresh.dataset.card = 'poll'; fresh.dataset.key = key;
  const k = document.createElement('div'); k.className = 'k'; const l = document.createElement('span'); l.textContent = p.kind === 'predict' ? '🔮 Prediction' : '📊 Poll'; const r = document.createElement('span'); if (open) r.dataset.until = p.until; else r.textContent = `${total} votes`; k.append(l, r);
  const q = document.createElement('b'); q.textContent = p.q;
  const list = document.createElement('div'); list.className = 'wv-vote';
  p.opts.forEach((o, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.disabled = !open || mine != null;
    if (mine === i) b.classList.add('mine'); if (p.answer === i) b.classList.add('right');
    const pct = total ? Math.round(p.counts[i] / total * 100) : 0;
    const bar = document.createElement('i'); bar.style.width = show ? pct + '%' : '0';
    const a = document.createElement('span'); a.textContent = (p.answer === i ? '✓ ' : mine === i ? '• ' : '') + o; const c = document.createElement('b'); c.textContent = show ? pct + '%' : '';
    b.append(bar, a, c);
    b.onclick = async () => { try { await ensureSession(); await api('wsend', { ...creds(), type: 'vote', poll: p.id, opt: i }); W.votes[p.id] = i; store.set('votes:' + code, W.votes); renderPollCard(W.info); } catch (e) { toast(e.message, true); } };
    list.append(b);
  });
  fresh.append(k, q, list);
  if (p.kind === 'predict' && p.answer >= 0 && mine != null) { const res = document.createElement('small'); res.textContent = mine === p.answer ? '🎉 You called it!' : 'Not this time.'; fresh.append(res); }
  if (card) card.replaceWith(fresh); else $('#wCards').append(fresh);
}

// ---------------------------------------------------------------- play with me: queue up with a gamertag
W.queued = store.get('queued:' + code, false);
function renderQueueCard(info) {
  const qi = info.queue, card = $('#wCards [data-card="queue"]');
  if (!qi?.open && !W.called) { card?.remove(); if (!qi?.open) W.queued = false; return; }
  const ahead = W.queued && sess ? Math.max(0, (qi.up || []).indexOf(sess.name)) : 0;
  const key = JSON.stringify([qi.size, W.queued, W.called, ahead]);
  if (card?.dataset.key === key) return;
  const c = document.createElement('div'); c.className = 'wv-card' + (W.called ? ' up' : ''); c.dataset.card = 'queue'; c.dataset.key = key;
  const k = document.createElement('div'); k.className = 'k'; k.append(Object.assign(document.createElement('span'), { textContent: '🎮 Play with the streamer' }), Object.assign(document.createElement('span'), { textContent: `${qi.size} in line` }));
  c.append(k);
  if (W.called) {
    const b = document.createElement('b'); b.textContent = 'You’re up! The streamer called you.';
    const go = document.createElement('a'); go.className = 'btn wv-buy'; go.href = '/c/' + code; go.target = '_blank'; go.rel = 'noopener'; go.textContent = 'Join the stage';
    c.append(b, go);
  } else if (W.queued) {
    const b = document.createElement('span'); b.textContent = ahead ? `You’re in line · ${ahead} ahead of you` : 'You’re in line. We’ll ping you when you’re up.';
    const leave = document.createElement('button'); leave.type = 'button'; leave.className = 'btn sm ghost'; leave.textContent = 'Leave the line';
    leave.onclick = async () => { W.queued = false; store.set('queued:' + code, false); try { await api('wsend', { ...creds(), type: 'unqueue' }); } catch {} renderQueueCard(W.info); };
    c.append(b, leave);
  } else {
    const f = document.createElement('div'); f.className = 'wv-q';
    const inp = document.createElement('input'); inp.className = 'input'; inp.placeholder = 'Your gamertag'; inp.maxLength = 32; inp.value = store.get('gamertag', '');
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn primary'; go.textContent = 'Join the line';
    go.onclick = async () => { try { await ensureSession(); store.set('gamertag', inp.value.trim()); await api('wsend', { ...creds(), type: 'queue', tag: inp.value.trim() }); W.queued = true; store.set('queued:' + code, true); renderQueueCard(W.info); } catch (e) { toast(e.message, true); } };
    f.append(inp, go); c.append(f);
  }
  if (card) card.replaceWith(c); else $('#wCards').append(c);
}
// While in line, check every 8 s whether the host called me.
setInterval(async () => {
  if (!W.queued || W.called || !sess) return;
  try { const r = await api('wping', creds()); if (r.queue?.status === 'called') { W.called = true; toast('🎮 You’re up! Tap “Join the stage”.'); try { new AudioContext().resume(); } catch {} renderQueueCard(W.info); } } catch {}
}, 8000);

// ---------------------------------------------------------------- hype meter: how much the room is reacting
function renderHype(info) {
  const total = Object.values(info.reacts || {}).reduce((a, b) => a + b, 0);
  const lv = Math.min(100, Math.round(total * 4));
  $('#wHypeBar').style.width = lv + '%';
  $('#wHypeLvl').textContent = lv >= 100 ? 'MAX' : lv >= 60 ? 'Hot' : lv >= 25 ? 'Warm' : 'Chill';
  $('#wHype').classList.toggle('max', lv >= 100);
}

// ---------------------------------------------------------------- vertical: 9:16 on upright phones, framed on the speaker
function renderVertical(info) {
  const native = info.aspect === '9:16', upright = innerHeight > innerWidth && innerWidth <= 900;
  $('#wv').classList.toggle('native916', native);
  $('#wv').classList.toggle('vertical', !native && upright && W.vertical !== false);
  const v = $('#wDirect'); if (v) v.style.objectPosition = `${Math.round((info.focus ?? 0.5) * 100)}% 50%`;
  $('#wFill').setAttribute('aria-pressed', String($('#wv').classList.contains('vertical')));
}
addEventListener('resize', () => { if (W.info) renderVertical(W.info); });
// On phones, Fill switches between the vertical crop and the full 16:9 picture.
$('#wFill').onclick = () => { W.vertical = !$('#wv').classList.contains('vertical'); if (innerHeight > innerWidth && innerWidth <= 900) renderVertical(W.info || {}); else setFill(!$('#wPlayerWrap').classList.contains('fill')); };

// ---------------------------------------------------------------- clips: save the last ~30 s from this browser
// Two overlapping recorders restart every 30 s, so one of them always holds 30-60 s of the show. Nothing is
// uploaded: the clip is made and saved on this device.
const CLIP = { recs: [], timer: null, on: false };
function clipStart() {
  const v = W.direct.video; if (!v?.srcObject || !window.MediaRecorder || CLIP.on) return;
  CLIP.on = true;
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const spawn = () => {
    if (!W.direct.video?.srcObject) return clipStop();
    try {
      const rec = new MediaRecorder(W.direct.video.srcObject, { mimeType: mime, videoBitsPerSecond: 2_000_000 }), chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.start(1000); CLIP.recs.push({ rec, chunks, t0: Date.now(), mime: rec.mimeType || mime });
      while (CLIP.recs.length > 2) { const old = CLIP.recs.shift(); try { old.rec.stop(); } catch {} }
    } catch (e) { console.warn('clip recorder', e); }
  };
  spawn(); CLIP.timer = setInterval(spawn, 30000);
}
function clipStop() { clearInterval(CLIP.timer); for (const r of CLIP.recs) { try { r.rec.stop(); } catch {} } CLIP.recs = []; CLIP.on = false; }
$('#wClip').onclick = async () => {
  if (!CLIP.on) { clipStart(); return toast('Clipping is on. Tap Clip again any time to save the last 30 seconds.'); }
  const r = CLIP.recs[0]; if (!r || Date.now() - r.t0 < 3000) return toast('Give it a few seconds, then tap Clip again.');
  try { r.rec.requestData(); } catch {}
  await new Promise((res) => setTimeout(res, 300));
  const blob = new Blob(r.chunks, { type: r.mime.split(';')[0] });
  const name = `${(W.info?.title || 'gather').replace(/[^\w-]+/g, '-').slice(0, 40)}-clip-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${/mp4/.test(r.mime) ? 'mp4' : 'webm'}`;
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Clip from ' + (W.info?.title || 'the show') }); return; } catch {} }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`Clip saved (${Math.round((Date.now() - r.t0) / 1000)} s).`);
};
// The Clip button appears once the direct picture plays; desktops keep the buffer ready from the start.
setInterval(() => {
  const ready = W.direct.state === 'live' && !!window.MediaRecorder;
  $('#wClip').hidden = !ready;
  if (ready && !CLIP.on && (navigator.hardwareConcurrency || 2) >= 6 && !/Mobi/i.test(navigator.userAgent)) clipStart();
  if (!ready && CLIP.on) clipStop();
}, 2000);

// ---------------------------------------------------------------- voice questions: raise a hand and record
// Up to 45 s of audio, recorded in this browser. Where the browser can (Chrome, Edge, Safari), it also writes down
// what was said as you speak, so the host can read the question before deciding to play it.
const VQ = { rec: null, chunks: [], stream: null, t0: 0, timer: null, sr: null, text: '', blob: null, meter: null };
const MAX_S = 45;
function voiceOpen() {
  $('#wVoiceName').value = sess?.named ? sess.name : store.get('name', '');
  voiceReset(); showErr('#wVoiceErr', ''); $('#wVoiceDlg').showModal();
}
function voiceReset() {
  VQ.blob = null; VQ.text = ''; $('#wRecPlay').hidden = true; $('#wRecPlay').removeAttribute('src');
  $('#wRecText').hidden = true; $('#wRecSend').disabled = true; $('#wRecAgain').hidden = true;
  $('#wRecTime').textContent = `0:00 / 0:${MAX_S}`; $('#wRecHint').textContent = 'Tap the red button and speak.'; $('#wRecBtn').classList.remove('on');
}
async function voiceStart() {
  try {
    VQ.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch { return showErr('#wVoiceErr', 'Allow the microphone to record a question (the lock icon in the address bar).'); }
  // Stop the show's sound while recording, so it isn't picked up.
  const v = W.direct.video; VQ.wasMuted = v?.muted; if (v) v.muted = true;
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  VQ.chunks = []; VQ.rec = new MediaRecorder(VQ.stream, { mimeType: mime, audioBitsPerSecond: 32000 });
  VQ.rec.ondataavailable = (e) => { if (e.data.size) VQ.chunks.push(e.data); };
  VQ.rec.onstop = voiceStopped;
  VQ.rec.start(500); VQ.t0 = Date.now();
  $('#wRecBtn').classList.add('on'); $('#wRecBtn').setAttribute('aria-label', 'Stop recording'); $('#wRecHint').textContent = 'Recording… tap to stop.';
  VQ.timer = setInterval(() => { const s = Math.floor((Date.now() - VQ.t0) / 1000); $('#wRecTime').textContent = `0:${String(s).padStart(2, '0')} / 0:${MAX_S}`; if (s >= MAX_S) voiceStop(); }, 250);
  // A level meter, so people can see the mic hears them.
  try { const ac = new AudioContext(), an = ac.createAnalyser(); ac.createMediaStreamSource(VQ.stream).connect(an); const buf = new Uint8Array(an.fftSize); VQ.meter = { ac, id: setInterval(() => { an.getByteTimeDomainData(buf); let p = 0; for (const x of buf) p = Math.max(p, Math.abs(x - 128)); $('#wRecLevel').style.width = Math.min(100, p * 1.6) + '%'; }, 80) }; } catch {}
  // Live transcript where the browser offers speech recognition.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    try {
      const sr = new SR(); sr.continuous = true; sr.interimResults = true; sr.lang = navigator.language || 'en-US';
      let finals = '';
      sr.onresult = (e) => { let interim = ''; for (let i = e.resultIndex; i < e.results.length; i++) { if (e.results[i].isFinal) finals += e.results[i][0].transcript + ' '; else interim += e.results[i][0].transcript; } VQ.text = (finals + interim).trim(); $('#wRecText').hidden = !VQ.text; $('#wRecText').textContent = VQ.text; };
      sr.onerror = () => {}; sr.start(); VQ.sr = sr;
    } catch {}
  }
}
function voiceStop() { if (VQ.rec?.state === 'recording') VQ.rec.stop(); }
function voiceStopped() {
  clearInterval(VQ.timer); try { VQ.sr?.stop(); } catch {} VQ.sr = null;
  if (VQ.meter) { clearInterval(VQ.meter.id); VQ.meter.ac.close().catch(() => {}); VQ.meter = null; } $('#wRecLevel').style.width = '0';
  VQ.stream?.getTracks().forEach((t) => t.stop()); VQ.stream = null;
  const v = W.direct.video; if (v && VQ.wasMuted === false) v.muted = false;
  VQ.dur = Math.round((Date.now() - VQ.t0) / 1000);
  VQ.blob = new Blob(VQ.chunks, { type: (VQ.rec.mimeType || 'audio/webm').split(';')[0] });
  $('#wRecBtn').classList.remove('on'); $('#wRecBtn').setAttribute('aria-label', 'Start recording');
  if (VQ.dur < 2) { showErr('#wVoiceErr', 'That was very short. Try again and say your question.'); return voiceReset(); }
  $('#wRecPlay').src = URL.createObjectURL(VQ.blob); $('#wRecPlay').hidden = false;
  $('#wRecHint').textContent = 'Listen back, then send it.'; $('#wRecSend').disabled = false; $('#wRecAgain').hidden = false;
}
$('#wRecBtn').onclick = () => (VQ.rec?.state === 'recording' ? voiceStop() : voiceStart());
$('#wRecAgain').onclick = () => voiceReset();
$('#wRecSend').onclick = async () => {
  showErr('#wVoiceErr', '');
  const name = $('#wVoiceName').value.trim();
  if (!name) { $('#wVoiceName').focus(); return showErr('#wVoiceErr', 'Add your name so the host can greet you.'); }
  $('#wRecSend').disabled = true;
  try {
    await ensureSession(); if (name !== sess.name) await setName(name);
    const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(VQ.blob); });
    await api('wsend', { ...creds(), type: 'voice', data, transcript: VQ.text, dur: VQ.dur });
    $('#wVoiceDlg').close();
    $('#wMsgs').append(Object.assign(document.createElement('li'), { className: 'hello', textContent: '✋ Your voice question went to the host. They’ll play it if they pick it.' }));
    $('#wMsgs').scrollTop = $('#wMsgs').scrollHeight;
  } catch (e) { showErr('#wVoiceErr', e.message); $('#wRecSend').disabled = false; }
};
$('#wVoiceDlg').addEventListener('close', () => { if (VQ.rec?.state === 'recording') voiceStop(); });
$('#wHand').onclick = voiceOpen;
$('#wMic').onclick = voiceOpen;
