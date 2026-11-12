// gather — client. Full-mesh WebRTC studio with a canvas-composited stage.
// The stage canvas is the single source of truth for what you see AND what gets recorded.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = mkStore(() => localStorage);
const sess = mkStore(() => sessionStorage);
function mkStore(get) {
  return {
    get(k, d) { try { const v = get().getItem('gather:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { get().setItem('gather:' + k, JSON.stringify(v)); } catch {} },
  };
}

const MAX = 6;
const W = 1280, H = 720;
const DEFAULT_TITLE = 'The conversation studio';
const DEFAULT_PRESETS = ['Have a question? Drop it in the chat.', 'Thanks for joining us today.'];
const BGS = {
  dusk: ['#1d3f47', '#2a3566', '#3c3f74', 'rgba(255,255,255,.05)', false],
  ember: ['#3a1d24', '#6d2f2a', '#a0533a', 'rgba(255,220,200,.06)', false],
  forest: ['#10291f', '#1d4a3a', '#3b6b4b', 'rgba(220,255,230,.05)', false],
  graphite: ['#15181d', '#262b33', '#3a404b', 'rgba(255,255,255,.04)', false],
  paper: ['#f1efe9', '#e3e0d6', '#d4d0c4', 'rgba(0,0,0,.04)', true],
};

// ---------------------------------------------------------------- state
const S = {
  id: null, tok: null, studio: null, host: null, phase: 'offline', // offline | connecting | online | reconnecting
  name: store.get('name', ''),
  prefs: { startMic: store.get('startMic', true), startCam: store.get('startCam', true), camId: store.get('camId', ''), micId: store.get('micId', ''), quality: store.get('quality', '720'), noise: store.get('noise', true) },
  local: { audio: null, cam: null, screen: null, micOn: store.get('startMic', true), camOn: store.get('startCam', true), camError: '', joinedAt: 0 },
  peers: new Map(),
  state: localState(),
  iceServers: [],
  unread: 0, tab: 'chat',
  rec: null,
  banner: { key: '', t0: 0 },
  audioBlocked: false,
};
function localState() {
  return { layout: 'split', stage: ['me'], banner: null, ticker: '', brand: { color: store.get('accent', '#1f6feb'), bg: store.get('bg', 'dusk'), watermark: true, names: true, logo: '' }, title: store.get('title', '') };
}
const isHost = () => !S.studio || S.host === S.id;
const myId = () => S.id || 'me';

// ---------------------------------------------------------------- utils
function toast(msg, opts = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (opts.err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), opts.ms || 3200);
}
const initials = (n) => (n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const fmtTime = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const newCode = () => 'gather-' + [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
function parseCode(v) {
  v = String(v || '').trim();
  const m = v.match(/\/s\/([a-z0-9-]+)/i);
  return (m ? m[1] : v).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
}
async function copy(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch { toast('Copy blocked by the browser. Select the text and copy it manually.', { err: true }); }
}
const inviteLink = () => `${location.origin}/s/${S.studio}`;

// ---------------------------------------------------------------- audio graph
let actx = null, mixBus = null, recDest = null;
function audioCtx() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    mixBus = actx.createGain();
    recDest = actx.createMediaStreamDestination();
    mixBus.connect(recDest);
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}
/** Attach a level meter to an audio track. Returns {level(), dispose()} */
function meter(track) {
  const ctx = audioCtx();
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const an = ctx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = .3;
  src.connect(an); src.connect(mixBus);
  const buf = new Float32Array(an.fftSize);
  let smooth = 0;
  return {
    level() { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; const rms = Math.sqrt(s / buf.length); smooth = Math.max(rms, smooth * .85); return smooth; },
    dispose() { try { src.disconnect(); } catch {} },
  };
}

// ---------------------------------------------------------------- local media
const media = navigator.mediaDevices;
function camConstraints() {
  const h = Number(S.prefs.quality) || 720;
  return { width: { ideal: Math.round(h * 16 / 9) }, height: { ideal: h }, frameRate: { ideal: 30 }, ...(S.prefs.camId ? { deviceId: { exact: S.prefs.camId } } : {}) };
}
function micConstraints() {
  const n = S.prefs.noise;
  return { echoCancellation: n, noiseSuppression: n, autoGainControl: true, ...(S.prefs.micId ? { deviceId: { exact: S.prefs.micId } } : {}) };
}
function mediaErr(e) {
  if (!window.isSecureContext) return 'Camera needs HTTPS or localhost.';
  if (e?.name === 'NotAllowedError') return 'Permission was blocked. Allow it from the address bar.';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'No device found.';
  if (e?.name === 'NotReadableError') return 'The device is busy in another app.';
  return e?.message || 'Unavailable';
}
async function startCam() {
  if (S.local.cam) return S.local.cam;
  if (!media?.getUserMedia) { S.local.camError = 'Camera needs HTTPS or localhost.'; return null; }
  try {
    const s = await media.getUserMedia({ video: camConstraints() }).catch((e) => {
      if (S.prefs.camId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) { S.prefs.camId = ''; return media.getUserMedia({ video: camConstraints() }); }
      throw e;
    });
    S.local.cam = s.getVideoTracks()[0];
    S.local.cam.contentHint = 'motion';
    S.local.camError = '';
    S.local.cam.onended = () => { S.local.cam = null; if (S.local.camOn) { S.local.camOn = false; syncMedia(); toast('Your camera disconnected.', { err: true }); } };
    listDevices();
    return S.local.cam;
  } catch (e) { S.local.camError = mediaErr(e); return null; }
}
function stopCam() { S.local.cam?.stop(); S.local.cam = null; }
let localMeter = null;
async function startMic() {
  if (S.local.audio) return S.local.audio;
  if (!media?.getUserMedia) return null;
  try {
    const s = await media.getUserMedia({ audio: micConstraints() }).catch((e) => {
      if (S.prefs.micId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) { S.prefs.micId = ''; return media.getUserMedia({ audio: micConstraints() }); }
      throw e;
    });
    S.local.audio = s.getAudioTracks()[0];
    S.local.audio.enabled = S.local.micOn;
    localMeter?.dispose(); localMeter = meter(S.local.audio);
    listDevices();
    return S.local.audio;
  } catch (e) { toast('Microphone: ' + mediaErr(e), { err: true }); return null; }
}
function stopMic() { S.local.audio?.stop(); S.local.audio = null; localMeter?.dispose(); localMeter = null; }
const outVideo = () => S.local.screen || (S.local.camOn ? S.local.cam : null);

async function setMic(on) {
  S.local.micOn = on;
  if (on && !S.local.audio) await startMic();
  if (S.local.audio) S.local.audio.enabled = on;
  if (on && !S.local.audio) S.local.micOn = false;
  syncMedia();
}
async function setCam(on) {
  if (on) { await startCam(); if (!S.local.cam) { toast('Camera: ' + S.local.camError, { err: true }); on = false; } }
  else stopCam(); // turn the hardware light off
  S.local.camOn = on;
  syncMedia();
}
/** Push current local tracks to every peer and refresh UI. No renegotiation needed. */
function syncMedia() {
  const v = outVideo();
  for (const p of S.peers.values()) {
    p.aT?.sender.replaceTrack(S.local.audio || null).catch(() => {});
    p.vT?.sender.replaceTrack(v || null).catch(() => {});
  }
  const me = $('#card-' + cssId(myId()));
  const el = me && $('video', me);
  if (el) { const cur = el.srcObject?.getVideoTracks()[0]; if (cur !== v) el.srcObject = v ? new MediaStream([v]) : null; el.classList.toggle('mirror', !S.local.screen); }
  sendMeta({ mic: S.local.micOn, cam: S.local.camOn, sharing: !!S.local.screen });
  renderDock(); renderCrew(); renderPreview();
}

async function toggleShare() {
  if (S.local.screen) return stopShare();
  if (!media?.getDisplayMedia) return toast('Screen sharing is not supported in this browser.', { err: true });
  try {
    const s = await media.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
    S.local.screen = s.getVideoTracks()[0];
    S.local.screen.contentHint = 'detail';
    S.local.screen.onended = stopShare;
    if (isHost()) promote(myId());
    syncMedia();
    toast('You are sharing your screen.');
  } catch (e) { if (e?.name !== 'NotAllowedError') toast('Screen share: ' + mediaErr(e), { err: true }); }
}
function stopShare() { S.local.screen?.stop(); S.local.screen = null; syncMedia(); }

async function listDevices() {
  if (!media?.enumerateDevices) return;
  const devs = await media.enumerateDevices();
  fill($('#camSelect'), devs.filter((d) => d.kind === 'videoinput'), S.local.cam?.getSettings().deviceId || S.prefs.camId, 'camera');
  fill($('#micSelect'), devs.filter((d) => d.kind === 'audioinput'), S.local.audio?.getSettings().deviceId || S.prefs.micId, 'microphone');
  function fill(sel, list, cur, kind) {
    sel.replaceChildren(new Option(`Default ${kind}`, ''), ...list.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => new Option(d.label || `${kind[0].toUpperCase() + kind.slice(1)} ${i + 1}`, d.deviceId)));
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  }
}
media?.addEventListener?.('devicechange', listDevices);

// ---------------------------------------------------------------- signaling (HTTP + adaptive polling; runs on Vercel)
async function api(action, body) {
  const res = await fetch('/api/studio?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data.error || `The studio server answered ${res.status}.`); e.status = res.status; throw e; }
  return data;
}
const creds = () => ({ studio: S.studio, id: S.id, tok: S.tok });
// Outgoing messages are batched: a burst of ICE candidates becomes one request.
let outbox = [], flushT = null, flushing = false;
function wsSend(m) {
  if (!S.studio) return;
  outbox.push(m);
  if (!flushT && !flushing) flushT = setTimeout(flush, m.type === 'signal' ? 40 : 0);
}
async function flush() {
  flushT = null;
  if (!S.studio) { outbox = []; return; }
  if (!outbox.length) return;
  flushing = true;
  const ops = outbox.splice(0, 100);
  try {
    const r = await api('send', { ...creds(), ops });
    for (const m of r.results || []) onServer(m);
  } catch (e) {
    flushing = false;
    if (e.status === 410) return lostStudio();
    outbox.unshift(...ops); flushT = setTimeout(flush, 1000); return;
  }
  flushing = false;
  if (outbox.length && !flushT) flushT = setTimeout(flush, 0);
}
const sig = (to, data) => wsSend({ type: 'signal', to, data });
function sendMeta(m) { if (S.studio) wsSend({ type: 'meta', ...m }); }

let pollGen = 0;
async function pollLoop(gen) {
  let lastBeat = Date.now(), fails = 0;
  while (gen === pollGen && S.studio) {
    const beat = Date.now() - lastBeat > 4000;
    let n = 0;
    try {
      const r = await api('poll', { ...creds(), beat });
      if (gen !== pollGen) return;
      if (beat) lastBeat = Date.now();
      n = r.msgs.length;
      for (const m of r.msgs) await onServer(m);
      if (fails) { fails = 0; setPhase('online'); }
    } catch (e) {
      if (gen !== pollGen) return;
      if (e.status === 410) return lostStudio();
      if (++fails === 2) setPhase('reconnecting');
    }
    const negotiating = [...S.peers.values()].some((p) => p.conn !== 'connected');
    const wait = fails ? Math.min(8000, 500 * 2 ** fails) : n ? 120 : negotiating ? 300 : document.hidden ? 2500 : 1000;
    await new Promise((r) => setTimeout(r, wait));
  }
}
function lostStudio() {
  // Our membership expired (a sleeping laptop, a long network drop). Rejoin the same studio.
  const code = S.studio;
  pollGen++; outbox = [];
  teardownPeers();
  S.studio = null; S.id = null; S.tok = null;
  setPhase('reconnecting');
  setTimeout(() => join(code).catch((e) => { toast(e.message, { err: true }); setPhase('offline'); }), 800);
}
function beaconLeave() {
  if (!S.studio) return;
  const body = JSON.stringify(creds());
  pollGen++;
  if (!(navigator.sendBeacon && navigator.sendBeacon('/api/studio?action=leave', new Blob([body], { type: 'application/json' })))) api('leave', JSON.parse(body)).catch(() => {});
}
addEventListener('pagehide', beaconLeave);

async function iceConfig(serverIce) {
  const ice = [...(serverIce || [])];
  const url = sess.get('turnUrl', ''), user = sess.get('turnUser', ''), pass = sess.get('turnPass', '');
  if (url) ice.push({ urls: url.split(',').map((s) => s.trim()).filter(Boolean), username: user || undefined, credential: pass || undefined });
  return ice;
}

async function join(code) {
  setPhase(S.phase === 'reconnecting' ? 'reconnecting' : 'connecting');
  audioCtx();
  const r = await api('join', { studio: code, name: S.name || 'Guest', mic: S.local.micOn, cam: S.local.camOn });
  await onServer(r);
}

async function onServer(m) {
  switch (m.type) {
    case 'joined': {
      const wasHosting = isHost() && !S.studio;
      S.id = m.id; S.tok = m.tok; S.studio = m.studio; S.host = m.host;
      S.local.joinedAt = Date.now();
      S.iceServers = await iceConfig(m.iceServers);
      const pre = S.state;
      S.state = m.state;
      setPhase('online');
      history.replaceState(null, '', '/s/' + S.studio);
      $('#enterDlg').open && $('#enterDlg').close();
      stopPreviewLoop();
      $$('#msgs > *').forEach((n) => n.remove());
      for (const msg of m.history) addMsg(msg);
      for (const p of m.peers) createPeer(p, true); // newcomer makes the offers
      pollLoop(++pollGen);
      if (S.host === S.id && wasHosting) {
        // Bring the look you set up before creating the studio.
        setStage({ brand: pre.brand, title: pre.title, layout: pre.layout, banner: pre.banner, ticker: pre.ticker, stage: [S.id] });
      }
      sendMeta({ mic: S.local.micOn, cam: S.local.camOn, sharing: !!S.local.screen });
      renderAll();
      if (!m.peers.length && S.host === S.id) setTimeout(() => openInvite(), 350);
      else toast(S.host === S.id ? 'Studio ready.' : `You joined ${m.peers.length ? 'the studio' : 'an empty studio'}.`);
      tryPlayAll();
      break;
    }
    case 'peer-joined': {
      const p = addPeer(m.peer);
      sysMsg(`${p.name} joined the studio`);
      toast(`${p.name} joined`);
      chime();
      if (isHost() && !S.state.stage.includes(p.id) && S.state.stage.length < MAX) setStage({ stage: [...S.state.stage, p.id] });
      renderAll();
      break;
    }
    case 'signal': onSignal(m.from, m.data); break;
    case 'peer-left': {
      const p = S.peers.get(m.id);
      if (p) { sysMsg(`${p.name} left`); closePeer(p); }
      const wasHost = S.host === S.id;
      S.host = m.host; S.state = m.state;
      if (!wasHost && S.host === S.id) toast('You are now the host.');
      renderAll();
      break;
    }
    case 'peer-meta': {
      const p = S.peers.get(m.peer.id);
      if (!p) break;
      const startedSharing = m.peer.sharing && !p.sharing;
      Object.assign(p, { name: m.peer.name, mic: m.peer.mic, cam: m.peer.cam, sharing: m.peer.sharing });
      if (startedSharing && isHost()) promote(p.id);
      renderCrew();
      break;
    }
    case 'state': S.state = m.state; renderAll(); break;
    case 'chat': addMsg(m.msg); break;
    case 'recording': toast(m.on ? `${m.by} started recording` : `${m.by} stopped recording`); break;
    case 'error':
      if ($('#enterDlg').open) { $('#enterErr').textContent = m.message; $('#enterErr').hidden = false; setPhase(S.studio ? 'online' : 'offline'); $('#enterGo').disabled = false; }
      else toast(m.message, { err: true });
      break;
  }
}

// ---------------------------------------------------------------- peers
const cssId = (id) => String(id).replace(/[^a-z0-9_-]/gi, '');
function addPeer(info) {
  let p = S.peers.get(info.id);
  if (!p) { p = { id: info.id, pc: null, stream: new MediaStream(), pending: [], meters: [], rtt: null, conn: 'new' }; S.peers.set(info.id, p); }
  Object.assign(p, { name: info.name, mic: info.mic, cam: info.cam, sharing: info.sharing, joinedAt: info.joinedAt });
  return p;
}
function createPeer(info, offerer) {
  const p = addPeer(info);
  if (p.pc) return p;
  const pc = new RTCPeerConnection({ iceServers: S.iceServers, bundlePolicy: 'max-bundle' });
  p.pc = pc; p.offerer = offerer;
  if (offerer) {
    p.aT = pc.addTransceiver('audio', { direction: 'sendrecv' });
    p.vT = pc.addTransceiver('video', { direction: 'sendrecv' });
    p.aT.sender.replaceTrack(S.local.audio || null);
    p.vT.sender.replaceTrack(outVideo() || null);
    pc.onnegotiationneeded = async () => {
      try { await pc.setLocalDescription(); sig(p.id, { sdp: pc.localDescription }); } catch (e) { console.warn('offer failed', e); }
    };
  }
  pc.onicecandidate = (e) => { if (e.candidate) sig(p.id, { candidate: e.candidate }); };
  pc.ontrack = (e) => {
    for (const t of p.stream.getTracks()) if (t.kind === e.track.kind && t !== e.track) p.stream.removeTrack(t);
    p.stream.addTrack(e.track);
    if (e.track.kind === 'audio') { p.meters.forEach((x) => x.dispose()); p.meters = [meter(e.track)]; }
    const el = cardVideo(p.id);
    if (el) { el.srcObject = p.stream; playEl(el); }
  };
  pc.onconnectionstatechange = () => {
    p.conn = pc.connectionState;
    if (pc.connectionState === 'failed' && p.offerer) pc.restartIce();
    if (pc.connectionState === 'connected') tryPlayAll();
    renderCrew(); renderDock();
  };
  return p;
}
async function onSignal(from, data) {
  const p = S.peers.get(from) || addPeer({ id: from, name: 'Guest' });
  try {
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        if (!p.pc) createPeer(p, false);
        const pc = p.pc;
        await pc.setRemoteDescription(data.sdp);
        if (!p.aT) {
          for (const t of pc.getTransceivers()) {
            t.direction = 'sendrecv';
            if (t.receiver.track.kind === 'audio') p.aT = t; else p.vT = t;
          }
          await p.aT?.sender.replaceTrack(S.local.audio || null);
          await p.vT?.sender.replaceTrack(outVideo() || null);
        }
        await pc.setLocalDescription();
        sig(from, { sdp: pc.localDescription });
      } else if (p.pc) {
        await p.pc.setRemoteDescription(data.sdp);
      }
      for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
    } else if (data.candidate) {
      if (p.pc?.remoteDescription) await p.pc.addIceCandidate(data.candidate).catch(() => {});
      else p.pending.push(data.candidate);
    }
  } catch (e) { console.warn('signal error', e); }
}
function closePeer(p) {
  try { p.pc?.close(); } catch {}
  p.meters.forEach((x) => x.dispose());
  S.peers.delete(p.id);
  $('#card-' + cssId(p.id))?.remove();
}
function teardownPeers() { for (const p of [...S.peers.values()]) closePeer(p); }

// Autoplay: remote audio may be blocked until the viewer interacts.
function playEl(el) {
  const pr = el.play();
  pr?.catch(() => {
    if (!el.muted) { el.muted = true; el.dataset.blocked = '1'; el.play().catch(() => {}); if (!S.audioBlocked) { S.audioBlocked = true; toast('Click the stage to enable participant audio.', { ms: 6000 }); } }
  });
}
function tryPlayAll() { for (const p of S.peers.values()) { const el = cardVideo(p.id); if (el && el.srcObject) playEl(el); } }
document.addEventListener('pointerdown', () => {
  audioCtx();
  if (!S.audioBlocked) return;
  S.audioBlocked = false;
  for (const el of $$('video[data-blocked]')) { el.muted = false; delete el.dataset.blocked; el.play().catch(() => {}); }
}, { capture: true });

// Connection stats for the crew cards + dock.
setInterval(async () => {
  for (const p of S.peers.values()) {
    if (!p.pc || p.pc.connectionState !== 'connected') { p.rtt = null; continue; }
    try {
      const st = await p.pc.getStats();
      st.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null) p.rtt = Math.round(r.currentRoundTripTime * 1000); });
    } catch {}
  }
  if (S.studio) { renderCrewSubs(); renderDockNote(); }
}, 2000);

// ---------------------------------------------------------------- stage state (host-owned)
function setStage(patch) {
  if (!isHost()) return toast('Only the host can change the stage.', { err: true });
  S.state = { ...S.state, ...patch, brand: { ...S.state.brand, ...(patch.brand || {}) } };
  if (S.studio) wsSend({ type: 'state', state: S.state });
  else { store.set('accent', S.state.brand.color); store.set('bg', S.state.brand.bg); store.set('title', S.state.title); }
  renderAll();
}
function promote(id) {
  const stage = [id, ...S.state.stage.filter((x) => x !== id)];
  setStage({ stage, layout: 'spotlight' });
}
function toggleStage(id) {
  const on = S.state.stage.includes(id);
  setStage({ stage: on ? S.state.stage.filter((x) => x !== id) : [...S.state.stage, id] });
}

// ---------------------------------------------------------------- participants model
function participants() {
  const me = { id: myId(), me: true, name: S.name || 'You', mic: S.local.micOn && !!S.local.audio, cam: !!outVideo(), sharing: !!S.local.screen, joinedAt: S.local.joinedAt, level: localMeter?.level() || 0 };
  const list = [me];
  for (const p of S.peers.values()) list.push({ id: p.id, name: p.name, mic: p.mic, cam: p.cam || p.sharing, sharing: p.sharing, joinedAt: p.joinedAt, peer: p, level: p.meters[0]?.level() || 0 });
  return list.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}
function cardVideo(id) { return $(`#card-${cssId(id)} video`); }

// ---------------------------------------------------------------- canvas stage
const canvas = $('#stageCanvas');
const g = canvas.getContext('2d');
const speaking = new Map(); // id -> last time above threshold

function rr(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
function layoutRects(n, layout, area) {
  const { x, y, w, h } = area, gap = 16;
  if (!n) return [];
  if (layout === 'solo' || n === 1) return [{ x, y, w, h }];
  if (layout === 'spotlight') {
    const sh = Math.round(h * 0.22), mh = h - sh - gap, k = n - 1;
    const tw = Math.min((w - gap * (k - 1)) / k, sh * 16 / 9);
    const total = tw * k + gap * (k - 1), sx = x + (w - total) / 2;
    return [{ x, y, w, h: mh }, ...Array.from({ length: k }, (_, i) => ({ x: sx + i * (tw + gap), y: y + mh + gap, w: tw, h: sh }))];
  }
  const cols = n <= 3 ? n : n === 4 ? 2 : 3, rows = Math.ceil(n / cols);
  const tw = (w - gap * (cols - 1)) / cols, th = (h - gap * (rows - 1)) / rows;
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols), inRow = r === rows - 1 ? n - r * cols : cols;
    const off = (w - (inRow * tw + (inRow - 1) * gap)) / 2;
    return { x: x + off + (i % cols) * (tw + gap), y: y + r * (th + gap), w: tw, h: th };
  });
}
function drawBackground(t) {
  const [a, b, c, glow] = BGS[S.state.brand.bg] || BGS.dusk;
  const grd = g.createLinearGradient(0, 0, W, H);
  grd.addColorStop(0, a); grd.addColorStop(.6, b); grd.addColorStop(1, c);
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  // The big soft arc from the original stage, breathing very slowly.
  const r = 640 + Math.sin(t / 4000) * 12;
  g.strokeStyle = glow; g.lineWidth = 2;
  for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(-60, H * 0.62, r - i * 70, 0, Math.PI * 2); g.stroke(); }
  const rad = g.createRadialGradient(W * .85, H * .9, 10, W * .85, H * .9, 520);
  rad.addColorStop(0, glow); rad.addColorStop(1, 'transparent');
  g.fillStyle = rad; g.fillRect(0, 0, W, H);
}
function drawTile(p, rect, t) {
  const { x, y, w, h } = rect;
  const el = cardVideo(p.id);
  const brand = S.state.brand;
  g.save();
  rr(x, y, w, h, 10); g.clip();
  const hasVid = p.cam && el && el.readyState >= 2 && el.videoWidth > 0;
  if (hasVid) {
    const vw = el.videoWidth, vh = el.videoHeight;
    if (p.sharing) {
      g.fillStyle = '#0b0e13'; g.fillRect(x, y, w, h);
      const s = Math.min(w / vw, h / vh), dw = vw * s, dh = vh * s;
      g.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      const s = Math.max(w / vw, h / vh), sw = w / s, sh = h / s;
      g.drawImage(el, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
    }
  } else {
    const grd = g.createLinearGradient(x, y, x + w, y + h);
    grd.addColorStop(0, '#26303d'); grd.addColorStop(1, '#1b222c');
    g.fillStyle = grd; g.fillRect(x, y, w, h);
    const rad = Math.min(w, h) * 0.17;
    const lvl = Math.min(1, p.level * 8);
    if (lvl > .05) { g.fillStyle = hexA(brand.color, .25 * lvl); g.beginPath(); g.arc(x + w / 2, y + h / 2, rad * (1.15 + lvl * .3), 0, Math.PI * 2); g.fill(); }
    g.fillStyle = brand.color; g.beginPath(); g.arc(x + w / 2, y + h / 2, rad, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = `700 ${Math.round(rad * .8)}px "Plus Jakarta Sans", Inter, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(initials(p.name), x + w / 2, y + h / 2 + 2);
  }
  g.restore();

  // Active speaker ring.
  const now = performance.now();
  if (p.mic && p.level > 0.02) speaking.set(p.id, now);
  if (now - (speaking.get(p.id) || -1e9) < 450) { g.strokeStyle = brand.color; g.lineWidth = 4; rr(x + 2, y + 2, w - 4, h - 4, 9); g.stroke(); }

  // Name tag.
  const fs = Math.max(13, Math.min(18, h * 0.045));
  let tx = x + 16;
  const ty = y + h - 16 - fs * 1.9;
  if (brand.names) {
    const label = p.me ? `${p.name} (you)` : p.name;
    g.font = `600 ${fs}px Inter, sans-serif`; g.textAlign = 'left'; g.textBaseline = 'middle';
    const tw = Math.min(g.measureText(label).width, w - 80);
    g.fillStyle = brand.color; rr(tx, ty, tw + fs * 1.4, fs * 1.9, 6); g.fill();
    g.fillStyle = contrastInk(brand.color);
    g.save(); g.beginPath(); g.rect(tx, ty, tw + fs * 1.4, fs * 1.9); g.clip();
    g.fillText(label, tx + fs * .7, ty + fs * .97); g.restore();
    tx += tw + fs * 1.4 + 6;
  }
  if (!p.mic) {
    const s = fs * 1.9;
    g.fillStyle = 'rgba(17,24,39,.78)'; rr(tx, ty, s, s, 6); g.fill();
    drawMicOff(tx + s / 2, ty + s / 2, s * .32);
  }
}
function drawMicOff(cx, cy, r) {
  g.save(); g.strokeStyle = '#ff6b6b'; g.lineWidth = Math.max(1.6, r * .2); g.lineCap = 'round';
  g.beginPath(); g.roundRect(cx - r * .35, cy - r, r * .7, r * 1.25, r * .35); g.stroke();
  g.beginPath(); g.arc(cx, cy - r * .1, r * .75, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
  g.beginPath(); g.moveTo(cx, cy + r * .65); g.lineTo(cx, cy + r); g.stroke();
  g.beginPath(); g.moveTo(cx - r, cy - r); g.lineTo(cx + r, cy + r); g.stroke();
  g.restore();
}
function drawBanner(t, bottom) {
  const b = S.state.banner;
  if (!b) return;
  const key = b.id + b.text + b.sub;
  if (S.banner.key !== key) S.banner = { key, t0: t };
  const k = Math.min(1, (t - S.banner.t0) / 420), e = 1 - Math.pow(1 - k, 3);
  const brand = S.state.brand;
  g.save();
  g.globalAlpha = e;
  const x = 56 - (1 - e) * 40;
  g.font = '700 30px "Plus Jakarta Sans", Inter, sans-serif';
  const tw = Math.min(g.measureText(b.text).width, W - 200);
  let subW = 0;
  if (b.sub) { g.font = '500 19px Inter, sans-serif'; subW = Math.min(g.measureText(b.sub).width, W - 200); }
  const bw = Math.max(tw, subW) + 56;
  const mainH = 64, subH = b.sub ? 40 : 0;
  const y = bottom - mainH - subH - 22;
  g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 24; g.shadowOffsetY = 8;
  g.fillStyle = brand.color; rr(x, y, bw, mainH, b.sub ? [10, 10, 0, 0] : 10); g.fill();
  g.shadowColor = 'transparent';
  if (b.sub) { g.fillStyle = '#ffffff'; rr(x, y + mainH, bw, subH, [0, 0, 10, 10]); g.fill(); }
  g.save(); g.beginPath(); g.rect(x, y, bw - 20, mainH + subH); g.clip();
  g.fillStyle = contrastInk(brand.color); g.font = '700 30px "Plus Jakarta Sans", Inter, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
  g.fillText(b.text, x + 28, y + mainH / 2 + 1);
  if (b.sub) { g.fillStyle = '#1f2937'; g.font = '500 19px Inter, sans-serif'; g.fillText(b.sub, x + 28, y + mainH + subH / 2 + 1); }
  g.restore(); g.restore();
}
function drawTicker(t) {
  const text = S.state.ticker;
  if (!text) return 0;
  const h = 46, y = H - h, brand = S.state.brand;
  g.fillStyle = brand.color; g.fillRect(0, y, W, h);
  g.font = '600 20px Inter, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
  const unit = text + '     •     ';
  const uw = g.measureText(unit).width;
  const off = (t / 1000 * 90) % uw;
  g.fillStyle = contrastInk(brand.color);
  for (let x = -off; x < W; x += uw) g.fillText(unit, x, y + h / 2 + 1);
  return h;
}
function drawChrome() {
  const paper = BGS[S.state.brand.bg]?.[4];
  const ink = paper ? 'rgba(17,24,39,' : 'rgba(255,255,255,';
  g.textBaseline = 'middle';
  if (S.state.brand.watermark) {
    g.textAlign = 'right';
    g.font = '700 15px "Plus Jakarta Sans", Inter, sans-serif'; g.fillStyle = ink + '.95)';
    const bw = g.measureText('gather.').width;
    g.fillText('gather.', W - 30, 22);
    g.font = '400 13px Inter, sans-serif'; g.fillStyle = ink + '.75)';
    g.fillText('made with ', W - 30 - bw - 2, 22);
  }
  if (S.state.title) {
    g.textAlign = 'left'; g.font = '600 14px Inter, sans-serif'; g.fillStyle = ink + '.8)';
    g.fillText(S.state.title.toUpperCase().split('').join(String.fromCharCode(8202)), 30, 22);
  }
}
function drawOffline(t) {
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.font = '600 12px Inter, sans-serif';
  const paper = BGS[S.state.brand.bg]?.[4];
  g.fillStyle = paper ? 'rgba(17,24,39,.55)' : 'rgba(255,255,255,.55)';
  g.fillText('A LITTLE SPACE. BIG IDEAS.'.split('').join(String.fromCharCode(8202)), 26, H - 26);
}
function draw() {
  const t = performance.now();
  drawBackground(t);
  const inStudio = !!S.studio;
  if (!inStudio && !previewActive()) { drawOffline(t); drawChrome(); return; }
  const people = participants();
  const byId = new Map(people.map((p) => [p.id, p]));
  const stageIds = inStudio ? S.state.stage : [myId()];
  const onStage = stageIds.map((id) => byId.get(id)).filter(Boolean);
  const tickH = drawTicker(t);
  const area = { x: 32, y: 44, w: W - 64, h: H - 44 - 32 - (tickH ? tickH - 10 : 0) };
  if (!onStage.length) {
    g.fillStyle = 'rgba(255,255,255,.7)'; g.font = '600 22px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(isHost() ? 'Add someone to the stage from “In the studio”.' : 'The host will bring people on stage.', W / 2, H / 2);
  }
  const rects = layoutRects(onStage.length, S.state.layout, area);
  onStage.forEach((p, i) => rects[i] && drawTile(p, rects[i], t));
  if (S.state.ticker) drawTicker(t); // keep ticker above tiles
  drawBanner(t, H - (tickH || 0) - 10);
  drawChrome();
}
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
function contrastInk(hex) { const n = parseInt(hex.slice(1), 16); const [r, gg, b] = [n >> 16, (n >> 8) & 255, n & 255]; return (0.299 * r + 0.587 * gg + 0.114 * b) > 170 ? '#111827' : '#ffffff'; }

// Render loop: rAF while visible; a worker clock keeps recordings smooth in background tabs.
let lastFrame = 0;
function frame() { lastFrame = performance.now(); draw(); meters(); speakingCards(); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
const clock = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),33)'], { type: 'text/javascript' })));
clock.onmessage = () => { if (performance.now() - lastFrame > 120) draw(); };

function meters() {
  const lvl = Math.min(100, (localMeter?.level() || 0) * 400 * (S.local.micOn ? 1 : 0));
  $('#meterFill').style.width = lvl + '%';
  $('#pMeter').style.width = lvl + '%';
}
function speakingCards() {
  const now = performance.now();
  for (const li of $$('.crew-card')) li.classList.toggle('speaking', now - (speaking.get(li.dataset.id) || -1e9) < 450);
}

// ---------------------------------------------------------------- recording
function pickMime() {
  const opts = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
  return opts.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}
function toggleRecord() {
  if (S.rec) return S.rec.recorder.stop();
  if (!window.MediaRecorder || !canvas.captureStream) return toast('Recording is not supported in this browser.', { err: true });
  audioCtx();
  const vs = canvas.captureStream(30);
  const stream = new MediaStream([...vs.getVideoTracks(), ...recDest.stream.getAudioTracks()]);
  const mimeType = pickMime();
  let recorder;
  try { recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 160_000 }); }
  catch (e) { return toast('Could not start recording: ' + e.message, { err: true }); }
  const chunks = [];
  const t0 = Date.now();
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    clearInterval(S.rec.timer);
    vs.getTracks().forEach((t) => t.stop());
    const dur = Date.now() - t0;
    const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
    S.rec = null;
    wsSend({ type: 'recording', on: false });
    renderDock();
    showRecording(blob, dur);
  };
  recorder.start(1000);
  S.rec = { recorder, t0, timer: setInterval(renderDock, 500) };
  wsSend({ type: 'recording', on: true });
  toast('Recording the stage. Everything you see is captured.');
  renderDock();
}
let lastRecUrl = null;
function showRecording(blob, dur) {
  if (lastRecUrl) URL.revokeObjectURL(lastRecUrl);
  lastRecUrl = URL.createObjectURL(blob);
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  $('#recVideo').src = lastRecUrl;
  $('#recDownload').href = lastRecUrl;
  $('#recDownload').download = `gather-${S.studio || 'studio'}-${stamp}.${ext}`;
  $('#recInfo').textContent = `${fmtTime(dur)} long · ${(blob.size / 1048576).toFixed(1)} MB · ${ext.toUpperCase()}`;
  $('#recDlg').showModal();
}

// ---------------------------------------------------------------- chat
function addMsg(msg) {
  const li = document.createElement('li');
  const mine = msg.from === S.id;
  li.className = 'msg' + (mine ? ' me' : '');
  const who = document.createElement('div'); who.className = 'who';
  const b = document.createElement('b'); b.textContent = mine ? 'You' : msg.name;
  const time = document.createElement('span'); time.textContent = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  who.append(b, time);
  const txt = document.createElement('div'); txt.className = 'txt';
  // Linkify safely: text nodes + anchors only.
  const parts = msg.text.split(/(https?:\/\/[^\s<]+)/g);
  for (const part of parts) {
    if (/^https?:\/\//.test(part)) { const a = document.createElement('a'); a.href = part; a.textContent = part; a.target = '_blank'; a.rel = 'noopener noreferrer'; txt.append(a); }
    else if (part) txt.append(document.createTextNode(part));
  }
  li.append(who, txt);
  appendLog(li);
  if (!mine && S.tab !== 'chat') { S.unread++; $('#chatBadge').hidden = false; }
}
function sysMsg(text) { const li = document.createElement('li'); li.className = 'msg sys'; li.textContent = text; appendLog(li); }
function appendLog(li) {
  const log = $('#msgs'); const body = log.parentElement;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  log.append(li);
  $('#chatEmpty').hidden = true;
  if (atBottom || li.classList.contains('me')) body.scrollTop = body.scrollHeight;
}
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#chatInput').value.trim();
  if (!v) return;
  if (!S.studio) return toast('Enter a studio to chat.');
  wsSend({ type: 'chat', text: v });
  $('#chatInput').value = '';
});

// ---------------------------------------------------------------- rendering
function setPhase(p) {
  S.phase = p;
  const pill = $('#statusPill');
  pill.dataset.state = p === 'online' ? 'online' : p === 'offline' ? 'offline' : 'connecting';
  $('#statusText').textContent = { offline: 'Studio offline', connecting: 'Connecting…', online: 'Studio connected', reconnecting: 'Reconnecting…' }[p];
  renderAll();
}
function renderAll() { renderHeader(); renderStageUI(); renderCrew(); renderDock(); renderPanels(); }
function renderHeader() {
  $('#studioTitle').textContent = S.state.title || DEFAULT_TITLE;
  $('#enterTopText').textContent = S.studio ? 'Room details' : 'Enter studio';
  const c = S.state.brand.color;
  document.documentElement.style.setProperty('--accent', c);
  document.documentElement.style.setProperty('--accent-soft', `color-mix(in srgb, ${c} 12%, var(--surface))`);
  document.documentElement.style.setProperty('--accent-ink', contrastInk(c));
}
function renderStageUI() {
  $('#stageEmpty').hidden = !!S.studio || previewActive();
  $('#stageMeta').classList.toggle('live', !!S.studio);
  $('#stageMeta').lastChild.textContent = S.studio ? `${S.state.stage.length} on stage · 16:9` : 'Stage preview · 16:9';
  for (const b of $$('.lay')) { const on = b.dataset.layout === S.state.layout; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); b.disabled = !isHost(); }
  $('#hostNote').hidden = isHost();
}
function renderCrew() {
  const list = $('#crewList'), add = $('.crew-add');
  const people = S.studio ? participants() : [];
  $('#crewCount').textContent = `${people.length} / ${MAX}`;
  const keep = new Set(people.map((p) => 'card-' + cssId(p.id)));
  for (const li of $$('.crew-card', list)) if (!keep.has(li.id)) li.remove();
  for (const p of people) {
    let li = $('#card-' + cssId(p.id));
    if (!li) {
      li = document.createElement('li'); li.className = 'crew-card'; li.id = 'card-' + cssId(p.id); li.dataset.id = p.id;
      li.innerHTML = `<div class="crew-thumb"><video autoplay playsinline></video><div class="ini" hidden><span></span></div><div class="tagrow"></div></div><div class="crew-info"><div class="crew-name"><span class="nm"></span></div><div class="crew-sub"></div><button class="crew-act" hidden></button></div>`;
      const v = $('video', li);
      if (p.me) { v.muted = true; const ov = outVideo(); if (ov) v.srcObject = new MediaStream([ov]); v.classList.toggle('mirror', !S.local.screen); }
      else if (p.peer.stream.getTracks().length) { v.srcObject = p.peer.stream; playEl(v); }
      $('.crew-act', li).addEventListener('click', () => toggleStage(p.id));
      list.insertBefore(li, add);
    }
    list.insertBefore(li, add); // keep join order
    $('.nm', li).textContent = p.me ? `${p.name} (you)` : p.name;
    const nameRow = $('.crew-name', li);
    nameRow.querySelector('svg')?.remove();
    if (!p.mic) nameRow.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" aria-label="Muted"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16"/></svg>');
    const ini = $('.ini', li); ini.hidden = !!p.cam; $('span', ini).textContent = initials(p.name);
    const tags = $('.tagrow', li); tags.replaceChildren();
    if (p.id === S.host) tags.insertAdjacentHTML('beforeend', '<span class="mini">Host</span>');
    if (S.state.stage.includes(p.id)) tags.insertAdjacentHTML('beforeend', '<span class="mini live">On stage</span>');
    if (p.sharing) tags.insertAdjacentHTML('beforeend', '<span class="mini">Screen</span>');
    const act = $('.crew-act', li);
    act.hidden = !isHost();
    const on = S.state.stage.includes(p.id);
    act.textContent = on ? 'Remove from stage' : 'Add to stage';
    act.classList.toggle('on', on);
  }
  renderCrewSubs();
  add.hidden = people.length >= MAX;
}
function renderCrewSubs() {
  for (const p of participants()) {
    const sub = $(`#card-${cssId(p.id)} .crew-sub`);
    if (!sub) continue;
    if (p.me) sub.textContent = S.local.screen ? 'Sharing screen' : S.local.camOn ? (S.local.micOn ? 'Camera and mic on' : 'Camera on · muted') : 'Camera off';
    else {
      const c = p.peer.conn;
      sub.textContent = c === 'connected' ? `Connected${p.peer.rtt != null ? ` · ${p.peer.rtt} ms` : ''}` : c === 'failed' ? 'Connection failed · retrying' : c === 'disconnected' ? 'Reconnecting…' : 'Connecting…';
    }
  }
}
function renderDock() {
  const mic = $('#micBtn'), cam = $('#camBtn'), share = $('#shareBtn'), rec = $('#recBtn');
  const micOff = !S.local.micOn || !S.local.audio;
  mic.setAttribute('aria-pressed', micOff && S.phase !== 'offline' ? 'true' : String(micOff && !!S.local.audio));
  $('#micLabel').textContent = S.studio ? (micOff ? 'Unmute' : 'Mute') : 'Microphone';
  const camOff = !S.local.camOn;
  cam.setAttribute('aria-pressed', String(camOff && !!S.studio));
  $('#camLabel').textContent = S.studio ? (camOff ? 'Start camera' : 'Stop camera') : 'Camera';
  share.classList.toggle('active', !!S.local.screen);
  $('#shareLabel').textContent = S.local.screen ? 'Stop sharing' : 'Share screen';
  share.disabled = !S.studio;
  rec.classList.toggle('recording', !!S.rec);
  $('#recLabel').textContent = S.rec ? fmtTime(Date.now() - S.rec.t0) : 'Record';
  rec.disabled = !S.studio;
  $('#recPill').hidden = !S.rec;
  if (S.rec) $('#recPillText').textContent = 'Recording ' + fmtTime(Date.now() - S.rec.t0);
  $('#leaveBtn').disabled = !S.studio;
  renderDockNote();
}
function renderDockNote() {
  const el = $('#dockNoteText');
  if (!S.studio) { el.textContent = S.phase === 'reconnecting' ? 'Reconnecting to your studio…' : 'Your studio. Your conversation.'; return; }
  const peers = [...S.peers.values()];
  if (!peers.length) { el.textContent = 'Waiting for guests · share your room code'; return; }
  const up = peers.filter((p) => p.conn === 'connected');
  const rtts = up.map((p) => p.rtt).filter((x) => x != null);
  const avg = rtts.length ? ` · ${Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)} ms avg` : '';
  el.textContent = `${up.length} peer connection${up.length === 1 ? '' : 's'}${up.length < peers.length ? ` (${peers.length - up.length} connecting)` : ''}${avg}`;
}
function renderPanels() {
  const host = isHost();
  for (const id of ['bannerShow', 'bannerHide', 'tickerShow', 'tickerHide', 'titleApply', 'colorPick', 'namesChk', 'wmChk']) $('#' + id).disabled = !host;
  $$('#swatches button, #bgs button, #bannerPresets .use').forEach((b) => (b.disabled = !host));
  $('#bannerHint').textContent = host ? 'Banners appear on every participant’s stage and in recordings.' : 'Only the host can show banners. You’ll see them on your stage.';
  $('#brandHint').textContent = host ? 'Brand changes apply to everyone in the studio.' : 'Only the host can change the brand.';
  const b = S.state.brand;
  $$('#swatches button').forEach((x) => x.classList.toggle('on', x.dataset.color.toLowerCase() === b.color.toLowerCase()));
  $$('#bgs button').forEach((x) => x.classList.toggle('on', x.dataset.bg === b.bg));
  $('#colorPick').value = b.color;
  $('#namesChk').checked = b.names; $('#wmChk').checked = b.watermark;
  if (document.activeElement !== $('#titleInput')) $('#titleInput').value = S.state.title || '';
  renderPresets();
  $('#chatInput').disabled = !S.studio;
  $('#chatInput').placeholder = S.studio ? 'Send a message…' : 'Enter a studio to chat';
  $('#chatEmptyText').innerHTML = S.studio ? 'Say hello to the studio.<br>Everyone here will see it.' : 'This is where the ideas flow.<br>Enter a studio to say hello.';
  $('#chatEmpty').hidden = !!$('#msgs').children.length;
}
function renderPresets() {
  const presets = store.get('presets', DEFAULT_PRESETS);
  const ul = $('#bannerPresets');
  const live = S.state.banner?.text;
  ul.replaceChildren(...presets.map((text, i) => {
    const li = document.createElement('li'); li.className = 'preset' + (live === text ? ' live' : '');
    const p = document.createElement('p'); p.textContent = text;
    const row = document.createElement('div'); row.className = 'row';
    const use = document.createElement('button'); use.className = 'btn outline use'; use.textContent = live === text ? 'On stage' : 'Use banner'; use.disabled = !isHost();
    use.onclick = () => { $('#bannerText').value = text; $('#bannerSub').value = ''; showBanner(); };
    const del = document.createElement('button'); del.className = 'del'; del.textContent = 'Delete';
    del.onclick = () => { const list = store.get('presets', DEFAULT_PRESETS); list.splice(i, 1); store.set('presets', list); renderPresets(); };
    row.append(use, del); li.append(p, row); return li;
  }));
}

// ---------------------------------------------------------------- panels & controls
function setTab(tab) {
  S.tab = tab;
  $$('.rail-btn').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.panel').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  if (tab === 'chat') { S.unread = 0; $('#chatBadge').hidden = true; }
  if (tab === 'settings') listDevices();
}
$$('.rail-btn').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('#settingsDock').onclick = () => { setTab('settings'); if (innerWidth <= 900) $('#side').scrollIntoView({ behavior: 'smooth' }); };

$$('.lay').forEach((b) => b.addEventListener('click', () => setStage({ layout: b.dataset.layout })));

function showBanner() {
  const text = $('#bannerText').value.trim();
  if (!text) return toast('Write some banner text first.');
  setStage({ banner: { id: Math.random().toString(36).slice(2, 8), text, sub: $('#bannerSub').value.trim() } });
}
$('#bannerShow').onclick = showBanner;
$('#bannerHide').onclick = () => setStage({ banner: null });
$('#bannerSave').onclick = () => {
  const text = $('#bannerText').value.trim(); if (!text) return;
  const list = store.get('presets', DEFAULT_PRESETS);
  if (!list.includes(text)) { list.unshift(text); store.set('presets', list.slice(0, 12)); }
  renderPresets(); toast('Preset saved.');
};
$('#tickerShow').onclick = () => { const v = $('#tickerText').value.trim(); if (!v) return toast('Write some ticker text first.'); setStage({ ticker: v }); };
$('#tickerHide').onclick = () => setStage({ ticker: '' });

$$('#swatches button').forEach((b) => b.addEventListener('click', () => setStage({ brand: { color: b.dataset.color } })));
let colorT; $('#colorPick').addEventListener('input', (e) => { clearTimeout(colorT); colorT = setTimeout(() => setStage({ brand: { color: e.target.value } }), 120); });
$$('#bgs button').forEach((b) => b.addEventListener('click', () => setStage({ brand: { bg: b.dataset.bg } })));
$('#namesChk').onchange = (e) => setStage({ brand: { names: e.target.checked } });
$('#wmChk').onchange = (e) => setStage({ brand: { watermark: e.target.checked } });
$('#titleApply').onclick = () => { setStage({ title: $('#titleInput').value.trim() }); toast('Title applied.'); };

// Settings
$('#nameInput').value = S.name;
let nameT;
$('#nameInput').addEventListener('input', (e) => {
  S.name = e.target.value.trim(); store.set('name', S.name); $('#enterName').value = S.name;
  clearTimeout(nameT); nameT = setTimeout(() => { sendMeta({ name: S.name || 'Guest' }); renderCrew(); }, 400);
});
$('#startMic').checked = S.prefs.startMic; $('#startCam').checked = S.prefs.startCam;
$('#startMic').onchange = (e) => store.set('startMic', (S.prefs.startMic = e.target.checked));
$('#startCam').onchange = (e) => store.set('startCam', (S.prefs.startCam = e.target.checked));
$('#camSelect').onchange = async (e) => {
  store.set('camId', (S.prefs.camId = e.target.value));
  if (S.local.cam) { stopCam(); await startCam(); syncMedia(); }
};
$('#micSelect').onchange = async (e) => {
  store.set('micId', (S.prefs.micId = e.target.value));
  if (S.local.audio) { stopMic(); await startMic(); syncMedia(); }
};
$('#qualitySelect').value = S.prefs.quality;
$('#qualitySelect').onchange = async (e) => {
  store.set('quality', (S.prefs.quality = e.target.value));
  if (S.local.cam) await S.local.cam.applyConstraints(camConstraints()).catch(async () => { stopCam(); await startCam(); syncMedia(); });
};
$('#noiseChk').checked = S.prefs.noise;
$('#noiseChk').onchange = async (e) => {
  store.set('noise', (S.prefs.noise = e.target.checked));
  if (S.local.audio) { stopMic(); await startMic(); syncMedia(); }
};
for (const k of ['turnUrl', 'turnUser', 'turnPass']) {
  $('#' + k).value = sess.get(k, '');
  $('#' + k).addEventListener('change', (e) => { sess.set(k, e.target.value.trim()); if (S.studio) toast('TURN settings apply the next time you enter a studio.'); });
}

// Dock
$('#micBtn').onclick = () => setMic(!(S.local.micOn && S.local.audio));
$('#camBtn').onclick = () => setCam(!S.local.camOn);
$('#shareBtn').onclick = toggleShare;
$('#recBtn').onclick = toggleRecord;
$('#leaveBtn').onclick = leave;

function leave() {
  if (!S.studio) return;
  if (S.rec) S.rec.recorder.stop();
  beaconLeave();
  outbox = [];
  teardownPeers();
  stopShare(); stopCam(); stopMic();
  S.studio = null; S.id = null; S.tok = null; S.host = null;
  S.state = localState();
  S.local.camOn = S.prefs.startCam; S.local.micOn = S.prefs.startMic;
  $$('#msgs > *').forEach((n) => n.remove());
  $$('.crew-card').forEach((n) => n.remove());
  history.replaceState(null, '', '/');
  setPhase('offline');
  toast('You left the studio.');
}
addEventListener('beforeunload', (e) => { if (S.studio && (S.rec || S.peers.size)) { e.preventDefault(); e.returnValue = ''; } });

// Fullscreen stage
$('#fsBtn').onclick = () => { const st = $('#stage'); (document.fullscreenElement ? document.exitFullscreen() : st.requestFullscreen?.())?.catch?.(() => {}); };

// ---------------------------------------------------------------- enter studio (green room)
let enterMode = 'create', previewing = false;
const previewActive = () => previewing && !S.studio;
function stopPreviewLoop() { previewing = false; }
async function openEnter(mode, code) {
  if (S.studio) return openInvite();
  setEnterMode(mode || 'create');
  if (code) $('#enterCode').value = code;
  $('#enterName').value = S.name;
  $('#enterErr').hidden = true;
  $('#enterGo').disabled = false;
  $('#enterDlg').showModal();
  (S.name ? (mode === 'join' && !code ? $('#enterCode') : $('#enterGo')) : $('#enterName')).focus();
  previewing = true;
  audioCtx();
  S.local.micOn = S.prefs.startMic; S.local.camOn = S.prefs.startCam;
  if (S.local.camOn) await startCam(); else stopCam();
  if (S.local.camOn && !S.local.cam) S.local.camOn = false;
  if (S.local.micOn) await startMic();
  renderPreview(); renderStageUI();
}
function renderPreview() {
  const v = $('#previewVideo');
  const track = S.local.camOn ? S.local.cam : null;
  if ((v.srcObject?.getVideoTracks()[0] || null) !== track) v.srcObject = track ? new MediaStream([track]) : null;
  $('#previewOff').hidden = !!track;
  $('#previewInitials').textContent = initials($('#enterName').value || S.name);
  $('#previewMsg').textContent = S.local.camError && !track ? S.local.camError : 'Camera is off';
  $('#pMic').setAttribute('aria-pressed', String(!(S.local.micOn && S.local.audio)));
  $('#pCam').setAttribute('aria-pressed', String(!track));
}
$('#pMic').onclick = () => setMic(!(S.local.micOn && S.local.audio));
$('#pCam').onclick = () => setCam(!S.local.camOn);
$('#enterName').addEventListener('input', renderPreview);
function setEnterMode(m) {
  enterMode = m;
  $$('#enterForm .seg button').forEach((b) => { const on = b.dataset.mode === m; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  $('#codeFld').hidden = m !== 'join';
  $('#enterGo').textContent = m === 'join' ? 'Join studio' : 'Create studio';
  $('#enterErr').hidden = true;
}
$$('#enterForm .seg button').forEach((b) => b.addEventListener('click', () => setEnterMode(b.dataset.mode)));
$('#enterForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'go') return; // close button
  e.preventDefault();
  const name = $('#enterName').value.trim();
  if (!name) { $('#enterErr').textContent = 'Add your name so people know who you are.'; $('#enterErr').hidden = false; return $('#enterName').focus(); }
  let code = enterMode === 'join' ? parseCode($('#enterCode').value) : newCode();
  if (!code) { $('#enterErr').textContent = 'Paste the studio code your host sent you.'; $('#enterErr').hidden = false; return $('#enterCode').focus(); }
  S.name = name; store.set('name', name); $('#nameInput').value = name;
  $('#enterGo').disabled = true; $('#enterGo').textContent = 'Connecting…';
  try { await join(code); }
  catch (err) { $('#enterErr').textContent = err.message; $('#enterErr').hidden = false; $('#enterGo').disabled = false; setEnterMode(enterMode); setPhase('offline'); }
});
$('#enterDlg').addEventListener('close', () => {
  if (!S.studio) { previewing = false; stopCam(); stopMic(); renderStageUI(); renderDock(); }
});

// ---------------------------------------------------------------- invite
function openInvite() {
  if (!S.studio) return openEnter('create');
  $('#inviteCode').textContent = S.studio;
  const n = participants().length;
  $('#inviteFine').textContent = `Anyone with this code can join. ${n} of ${MAX} seats taken.${isHost() ? ' Keep this tab open while hosting.' : ''}`;
  $('#inviteDlg').showModal();
}
$('#copyCode').onclick = () => copy(S.studio, 'Room code copied.');
$('#copyLink').onclick = () => copy(inviteLink(), 'Invite link copied.');
$('#inviteTop').onclick = openInvite;
$('#inviteDock').onclick = openInvite;
$('#inviteCrew').onclick = openInvite;
$('#addSlot').onclick = openInvite;
$('#enterTop').onclick = () => (S.studio ? openInvite() : openEnter('create'));
$('#enterStage').onclick = () => openEnter('create');
$('#recDlg').addEventListener('close', () => { $('#recVideo').pause(); });

// ---------------------------------------------------------------- keyboard
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  const act = {
    m: () => setMic(!(S.local.micOn && S.local.audio)),
    v: () => setCam(!S.local.camOn),
    s: () => S.studio && toggleShare(),
    r: () => S.studio && toggleRecord(),
    f: () => $('#fsBtn').click(),
    1: () => isHost() && setStage({ layout: 'solo' }),
    2: () => isHost() && setStage({ layout: 'split' }),
    3: () => isHost() && setStage({ layout: 'spotlight' }),
    '/': () => { setTab('chat'); $('#chatInput').focus(); },
  }[k];
  if (act) { e.preventDefault(); act(); }
});

// ---------------------------------------------------------------- sound
function chime() {
  try {
    const ctx = audioCtx(), o = ctx.createOscillator(), gn = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(660, ctx.currentTime); o.frequency.setValueAtTime(880, ctx.currentTime + .09);
    gn.gain.setValueAtTime(.0001, ctx.currentTime); gn.gain.exponentialRampToValueAtTime(.06, ctx.currentTime + .02); gn.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + .35);
    o.connect(gn).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + .4);
  } catch {}
}

// ---------------------------------------------------------------- boot
document.fonts?.ready.then(() => S.banner.key = '');
setTab('chat');
setPhase('offline');
const linkCode = location.pathname.startsWith('/s/') ? parseCode(location.pathname) : '';
if (linkCode) openEnter('join', linkCode);
window.__gather = S; // handy for debugging in the console
