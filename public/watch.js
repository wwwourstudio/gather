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
  sess = { ...r, named: false }; store.set('sess:' + code, sess);
  return sess;
}
async function renew() { sess = null; store.set('sess:' + code, null); return ensureSession(); }

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
  const title = info.found ? info.title || 'Live show' : 'Show not found';
  $('#wTitle').textContent = title; document.title = `${title} · Watch live`;
  if (info.color) document.documentElement.style.setProperty('--accent', info.color);
  const live = !!(info.found && info.live?.on);
  const onAir = live || W.direct.state === 'live';
  $('#wLive').hidden = !onAir;
  $('#wLiveText').textContent = live ? 'Live · ' + clockText(info.live.since) : 'On air';
  $('#wViewers').hidden = !info.found;
  $('#wViewers').textContent = info.viewers ? `${info.viewers} watching` : '';
  const w = info.watch || {};
  $('#wSuperBtn').hidden = !w.supers;
  $('#wJoin').hidden = !w.join; $('#wJoin').href = '/c/' + code;
  $('#wChatState').textContent = !info.found ? '' : w.chat === false ? 'Chat is off' : w.slow ? `Slow mode · ${w.slow}s` : '';
  $('#wCompose').hidden = !info.found || w.chat === false;
  renderChat(info.chat || []);
  renderTops(info.chat || []);
  renderSources(info);
  floatReacts(info.reacts);
}

function renderChat(items) {
  const log = $('#wMsgs'), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  for (const m of items) {
    const key = m.id + ':' + (m.status || '');
    if (W.shown.has(key)) continue;
    W.shown.add(key);
    log.querySelector(`[data-id="${CSS.escape(m.id)}"]`)?.remove();
    log.querySelector(`[data-sc="${CSS.escape(m.sc || '')}"]`)?.remove(); // my own pending claim, now confirmed
    log.append(msgEl(m));
  }
  while (log.children.length > 200) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight; else if (items.length) $('#wNewer').hidden = false;
}
$('#wMsgs').addEventListener('scroll', () => { const l = $('#wMsgs'); if (l.scrollHeight - l.scrollTop - l.clientHeight < 40) $('#wNewer').hidden = true; });
$('#wNewer').onclick = () => { const l = $('#wMsgs'); l.scrollTop = l.scrollHeight; $('#wNewer').hidden = true; };
const NAME_COLORS = ['#7fa8ff', '#f472b6', '#fbbf24', '#34d399', '#a78bfa', '#38bdf8', '#fb923c', '#f87171'];
const nameColor = (n) => NAME_COLORS[[...String(n)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % NAME_COLORS.length];
function msgEl(m) {
  const li = document.createElement('li');
  li.dataset.id = m.id; if (m.sc) li.dataset.sc = m.sc;
  if (m.paid) li.className = 'paid' + (m.status === 'answered' ? ' answered' : '') + (m.status === 'pending' ? ' pending' : '');
  if (sess?.named && m.name === sess.name) li.classList.add('me');
  if (m.paid) { const a = document.createElement('span'); a.className = 'amt'; a.textContent = m.paid; li.append(a); }
  const b = document.createElement('b'); b.textContent = m.name; if (!li.classList.contains('me')) b.style.color = nameColor(m.name);
  li.append(b, document.createTextNode(m.text));
  return li;
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
    $('#wEmptyH').textContent = !info.found ? 'This show isn’t on right now.' : W.direct.state === 'connecting' ? 'Connecting to the studio…' : W.direct.state === 'full' ? 'The direct stream is full right now.' : 'Waiting for the show to start.';
    $('#wEmptyP').textContent = !info.found ? 'Check the link with the host.' : W.direct.state === 'full' ? 'Watch on one of the platforms below, or try again in a minute.' : 'This page starts playing by itself.';
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
  video.addEventListener('loadeddata', () => { if (gen !== D.gen) return; D.state = 'live'; D.video = video; render(W.info); setMuted(video.muted); }, { once: true });
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
$('#wFull').onclick = () => { const el = $('#wPlayerWrap'); if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen?.().catch(() => {}); };
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
    const r = await api('wsend', { ...creds(), type: 'chat', text });
    $('#wText').value = '';
    W.shown.add(r.id + ':');
    $('#wMsgs').append(msgEl({ id: r.id, name: sess.name, text })); $('#wMsgs').scrollTop = $('#wMsgs').scrollHeight;
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
