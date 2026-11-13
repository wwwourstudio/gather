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
  return { layout: 'split', stage: ['me'], banner: null, ticker: '', brand: { color: store.get('accent', '#1f6feb'), bg: store.get('bg', 'dusk'), watermark: true, names: true, logo: '' }, title: store.get('title', ''), elements: [], featured: null, feeds: { twitch: '' } };
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
  let res;
  try { res = await fetch('/api/studio?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }
  catch { const e = new Error('Could not reach the studio server. Check your connection and try again.'); e.status = 0; throw e; }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const hint = res.status === 404 ? 'The studio API was not found (404). In Vercel, check that the deployment includes the api folder, then redeploy.'
      : `The studio server answered ${res.status}. Check the function logs in Vercel.`;
    const e = new Error(data.error || hint); e.status = res.status; throw e;
  }
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
    // The host's own state is authoritative locally; applying the echo could undo edits made since.
    for (const m of r.results || []) if (m.type !== 'state') onServer(m);
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
        setStage({ brand: pre.brand, title: pre.title, layout: pre.layout, banner: pre.banner, ticker: pre.ticker, stage: [S.id], feeds: pre.feeds, elements: (pre.elements || []).filter((e) => !(e.type === 'image' && e.asset?.startsWith('local-'))) });
        uploadLocalAssets(pre.elements).then((elements) => { if (S.host === S.id) setStage({ elements }); });
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
  const R = rect.r ?? 10;
  rr(x, y, w, h, R); g.clip();
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
  if (now - (speaking.get(p.id) || -1e9) < 450) { g.strokeStyle = brand.color; g.lineWidth = 4; rr(x + 2, y + 2, w - 4, h - 4, Math.max(0, R - 1)); g.stroke(); }

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
  const slots = (S.state.elements || []).filter((e) => e.type === 'slot');
  if (S.state.layout === 'custom' && slots.length) {
    // Custom layout: each camera slot shows whoever holds that stage position.
    for (const e of slots) {
      const p = onStage[e.index], r = { ...px(e), r: e.radius };
      if (p) drawTile(p, r, t);
      else if (isHost()) {
        g.save(); g.strokeStyle = 'rgba(255,255,255,.28)'; g.setLineDash([8, 8]); g.lineWidth = 2; rr(r.x, r.y, r.w, r.h, r.r ?? 10); g.stroke();
        g.fillStyle = 'rgba(255,255,255,.45)'; g.font = '500 15px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(`Stage position ${e.index + 1}`, r.x + r.w / 2, r.y + r.h / 2); g.restore();
      }
    }
  } else {
    const rects = layoutRects(onStage.length, S.state.layout === 'custom' ? 'split' : S.state.layout, area);
    onStage.forEach((p, i) => rects[i] && drawTile(p, rects[i], t));
  }
  drawOverlays(t);
  if (S.state.ticker) drawTicker(t); // keep ticker above tiles
  drawBanner(t, H - (tickH || 0) - 10);
  drawFeatured(t, H - (tickH || 0) - 10);
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

// ---------------------------------------------------------------- chat feed (studio + Twitch) for overlays
const FEED_MAX = 200;
const SRC_COLOR = { studio: null, twitch: '#9146ff', youtube: '#ff0033' };
S.feed = [];
function pushFeed(m) { S.feed.push(m); if (S.feed.length > FEED_MAX) S.feed.splice(0, S.feed.length - FEED_MAX); }

// Twitch chat is readable anonymously over its public IRC WebSocket: no key, no server, no cost.
const twitch = { ws: null, channel: '', want: '', retry: 0, status: 'off' };
function syncTwitch() {
  const want = S.state.feeds?.twitch || '';
  if (want === twitch.want) return;
  twitch.want = want;
  twitch.retry = 0;
  try { twitch.ws?.close(); } catch {}
  twitch.ws = null;
  if (want) connectTwitch(); else setTwitchStatus('off');
}
function connectTwitch() {
  const ch = twitch.want;
  if (!ch) return;
  setTwitchStatus('connecting');
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  twitch.ws = ws;
  ws.onopen = () => {
    ws.send('CAP REQ :twitch.tv/tags');
    ws.send('PASS SCHMOOPIIE');
    ws.send('NICK justinfan' + Math.floor(10000 + Math.random() * 80000));
    ws.send('JOIN #' + ch);
  };
  ws.onmessage = (e) => {
    for (const line of String(e.data).split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
      if (/ ROOMSTATE #/.test(line) || / 366 /.test(line)) { twitch.retry = 0; setTwitchStatus('live'); continue; }
      const m = line.match(/^@(\S+) :([^!]+)!\S+ PRIVMSG #\S+ :(.*)$/);
      if (!m) continue;
      const tags = Object.fromEntries(m[1].split(';').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
      let text = m[3];
      if (text.startsWith('\u0001ACTION ')) text = text.slice(8, -1);
      addExternal({ id: tags.id || Math.random().toString(36).slice(2), src: 'twitch', name: (tags['display-name'] || m[2]).replace(/\\s/g, ' '), color: /^#[0-9a-f]{6}$/i.test(tags.color) ? tags.color : '', text: text.slice(0, 500), ts: Number(tags['tmi-sent-ts']) || Date.now() });
    }
  };
  ws.onclose = () => {
    if (twitch.ws !== ws || !twitch.want) return;
    setTwitchStatus('reconnecting');
    setTimeout(() => { if (twitch.ws === ws && twitch.want) connectTwitch(); }, Math.min(15000, 1000 * 2 ** twitch.retry++));
  };
}
function setTwitchStatus(st) {
  twitch.status = st;
  const el = $('#twitchStatus');
  if (!el) return;
  el.dataset.state = st;
  el.textContent = { off: 'Not connected', connecting: 'Connecting…', live: `Reading #${twitch.want}`, reconnecting: 'Reconnecting…' }[st];
}
function addExternal(m) {
  pushFeed(m);
  const li = document.createElement('li');
  li.className = 'msg ext';
  li.dataset.fid = m.id;
  const who = document.createElement('div'); who.className = 'who';
  const badge = document.createElement('span'); badge.className = 'src src-' + m.src; badge.textContent = m.src === 'twitch' ? 'Twitch' : 'YouTube';
  const b = document.createElement('b'); b.textContent = m.name; if (m.color) b.style.color = m.color;
  who.append(badge, b);
  const txt = document.createElement('div'); txt.className = 'txt'; txt.textContent = m.text;
  li.append(who, txt, featureBtn(m));
  appendLog(li);
  const log = $('#msgs'); while (log.children.length > 300) log.firstChild.remove();
}
function featureBtn(m) {
  const btn = document.createElement('button');
  btn.className = 'feat'; btn.type = 'button'; btn.textContent = 'Show on stage';
  btn.hidden = !isHost();
  btn.onclick = () => {
    const on = S.state.featured?.id === m.id;
    setStage({ featured: on ? null : { id: m.id, src: m.src, name: m.name, text: m.text, color: m.color || '' } });
  };
  return btn;
}

// ---------------------------------------------------------------- stage elements: custom layouts + overlays
// Every element is a rectangle in stage units (0..1), drawn on the canvas, so it shows for every
// participant and lands in recordings and streams exactly as placed.
const uid = () => Math.random().toString(36).slice(2, 8);
const ELEMENT_DEFAULTS = {
  slot: () => ({ type: 'slot', x: .3, y: .25, w: .4, h: .5, index: 0, radius: 10 }),
  chat: () => ({ type: 'chat', x: .7, y: .1, w: .27, h: .78, max: 8, size: 18, bg: true, fade: false }),
  text: () => ({ type: 'text', x: .05, y: .82, w: .5, h: .1, text: 'Your headline here', size: 40, color: '#ffffff', bold: true, align: 'left', bg: '' }),
  image: () => ({ type: 'image', x: .82, y: .06, w: .14, h: .14, asset: '', fit: 'contain', opacity: 1, radius: 0 }),
  timer: () => ({ type: 'timer', x: .42, y: .025, w: .16, h: .08, mode: 'clock', target: 0, size: 40, color: '#ffffff', bg: '' }),
};
const TEMPLATES = [
  { id: 'duo-chat', name: 'Two + chat', els: [
    { type: 'slot', index: 0, x: .025, y: .08, w: .335, h: .74 }, { type: 'slot', index: 1, x: .375, y: .08, w: .335, h: .74 },
    { type: 'chat', x: .73, y: .08, w: .245, h: .74, max: 8, size: 17, bg: true }] },
  { id: 'screen-pip', name: 'Screen + camera', els: [
    { type: 'slot', index: 0, x: .025, y: .07, w: .95, h: .86, radius: 10 }, { type: 'slot', index: 1, x: .755, y: .62, w: .2, h: .28, radius: 14 }] },
  { id: 'solo-chat', name: 'Solo + chat', els: [
    { type: 'slot', index: 0, x: .025, y: .08, w: .66, h: .84 }, { type: 'chat', x: .705, y: .08, w: .27, h: .84, max: 10, size: 18, bg: true }] },
  { id: 'panel-3', name: 'Panel of three', els: [
    { type: 'slot', index: 0, x: .025, y: .1, w: .3, h: .6 }, { type: 'slot', index: 1, x: .35, y: .1, w: .3, h: .6 }, { type: 'slot', index: 2, x: .675, y: .1, w: .3, h: .6 },
    { type: 'chat', x: .025, y: .73, w: .95, h: .22, max: 3, size: 17, bg: true }] },
];
function withDefaults(e) { return { ...ELEMENT_DEFAULTS[e.type](), ...e, id: e.id || uid() }; }
function applyTemplate(tpl) {
  // Keep the host's own text, images and timers; replace cameras and chat with the template's.
  const keep = (S.state.elements || []).filter((e) => !['slot', 'chat'].includes(e.type));
  setStage({ layout: 'custom', elements: [...tpl.els.map(withDefaults), ...keep] });
}

// Images: uploaded once per studio, cached as decoded <img> for drawing.
S.assets = new Map(); // id -> { img, data, loading }
function assetImg(id) {
  if (!id) return null;
  let a = S.assets.get(id);
  if (!a) {
    a = { img: null, data: null, loading: true };
    S.assets.set(id, a);
    if (S.studio && !id.startsWith('local-')) api('assetGet', { ...creds(), asset: id }).then((r) => setAssetData(id, r.data)).catch(() => { a.loading = false; });
  }
  return a.img;
}
function setAssetData(id, data) {
  const a = S.assets.get(id) || {};
  const img = new Image();
  img.onload = () => { a.img = img; a.loading = false; renderEditor(); };
  img.src = data;
  a.data = data;
  S.assets.set(id, a);
}
async function storeAsset(data) {
  if (S.studio) { const { id } = await api('assetPut', { ...creds(), data }); setAssetData(id, data); return id; }
  const id = 'local-' + uid(); setAssetData(id, data); return id;
}
// Downscale big uploads so they fit the studio store and draw fast.
function compressImage(file) {
  return new Promise((res, rej) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return rej(new Error('Use a PNG, JPEG, WebP or GIF image.'));
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      const max = 1280, k = Math.min(1, max / Math.max(w, h));
      w = Math.round(w * k); h = Math.round(h * k);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      let q = .9, out = c.toDataURL('image/webp', q);
      while (out.length > 850_000 && q > .4) { q -= .15; out = c.toDataURL('image/webp', q); }
      URL.revokeObjectURL(img.src);
      out.length > 900_000 ? rej(new Error('That image is too large. Try a smaller one.')) : res(out);
    };
    img.onerror = () => rej(new Error('Could not read that image.'));
    img.src = URL.createObjectURL(file);
  });
}
// When the host creates a studio, images added beforehand are uploaded and re-pointed.
async function uploadLocalAssets(elements) {
  const out = [];
  for (const e of elements || []) {
    if (e.type === 'image' && e.asset?.startsWith('local-')) {
      const data = S.assets.get(e.asset)?.data;
      out.push(data ? { ...e, asset: await storeAsset(data).catch(() => '') } : e);
    } else out.push(e);
  }
  return out;
}

function wrapLines(text, maxW, maxLines = 99) {
  const words = String(text).split(/\s+/).filter(Boolean), lines = [];
  let cur = '';
  for (let w of words) {
    while (g.measureText(w).width > maxW && w.length > 1) { // hard-break very long words
      let i = w.length; while (i > 1 && g.measureText(w.slice(0, i)).width > maxW) i--;
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, i)); w = w.slice(i);
    }
    const test = cur ? cur + ' ' + w : w;
    if (g.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,2}$/, '…'); }
  return lines;
}
const px = (e) => ({ x: e.x * W, y: e.y * H, w: e.w * W, h: e.h * H });

function drawChatEl(e, t) {
  const r = px(e), pad = 14, fs = e.size, lh = fs * 1.35;
  const now = Date.now();
  const msgs = S.feed.filter((m) => !e.fade || now - m.ts < 90_000).slice(-e.max);
  g.save();
  rr(r.x, r.y, r.w, r.h, 12); g.clip();
  if (e.bg) { g.fillStyle = 'rgba(10,14,22,.55)'; g.fillRect(r.x, r.y, r.w, r.h); }
  let y = r.y + r.h - pad;
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  for (let i = msgs.length - 1; i >= 0 && y > r.y + pad; i--) {
    const m = msgs[i];
    g.font = `700 ${fs}px Inter, sans-serif`;
    const nameW = g.measureText(m.name + '  ').width;
    g.font = `500 ${fs}px Inter, sans-serif`;
    const lines = wrapLines(m.text, r.w - pad * 2 - 6, 4);
    // First line shares its row with the name.
    const first = wrapLines(m.text, Math.max(40, r.w - pad * 2 - nameW - 14))[0] || '';
    const rest = wrapLines(m.text.slice(m.text.indexOf(first) + first.length).trim(), r.w - pad * 2 - 14, 3);
    const rows = [first, ...rest.filter(Boolean)];
    const blockH = rows.length * lh + 8;
    const top = y - blockH;
    if (top < r.y + pad - lh) break;
    const age = (now - m.ts) / 1000, alpha = e.fade ? Math.max(0, Math.min(1, (90 - age) / 10)) : 1;
    const enter = Math.min(1, (now - m.ts) / 250);
    g.globalAlpha = alpha * enter;
    const dot = SRC_COLOR[m.src] || S.state.brand.color;
    g.fillStyle = dot; g.beginPath(); g.arc(r.x + pad + 4, top + lh * .62, 4, 0, Math.PI * 2); g.fill();
    g.font = `700 ${fs}px Inter, sans-serif`; g.fillStyle = m.color || '#9ec5ff';
    g.fillText(m.name, r.x + pad + 14, top + lh * .85);
    g.font = `500 ${fs}px Inter, sans-serif`; g.fillStyle = '#ffffff';
    rows.forEach((line, j) => g.fillText(line, j === 0 ? r.x + pad + 14 + nameW : r.x + pad + 14, top + lh * (.85 + j)));
    y = top - 6;
    g.globalAlpha = 1;
    void lines;
  }
  if (!msgs.length) {
    g.fillStyle = 'rgba(255,255,255,.55)'; g.font = `500 ${Math.max(13, fs * .8)}px Inter, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(S.state.feeds?.twitch ? 'Waiting for chat…' : 'Chat will appear here', r.x + r.w / 2, r.y + r.h / 2);
  }
  g.restore();
}
function drawTextEl(e) {
  const r = px(e);
  g.save();
  g.font = `${e.bold ? 800 : 500} ${e.size}px "Plus Jakarta Sans", Inter, sans-serif`;
  const lines = wrapLines(e.text, r.w - (e.bg ? 32 : 0));
  const lh = e.size * 1.15, total = lines.length * lh;
  if (e.bg) { g.fillStyle = e.bg; rr(r.x, r.y, r.w, Math.max(r.h, total + 20), 10); g.fill(); }
  g.fillStyle = e.color; g.textBaseline = 'middle'; g.textAlign = e.align;
  const ax = e.align === 'center' ? r.x + r.w / 2 : e.align === 'right' ? r.x + r.w - (e.bg ? 16 : 0) : r.x + (e.bg ? 16 : 0);
  const top = r.y + Math.max(0, (Math.max(r.h, total + (e.bg ? 20 : 0)) - total) / 2);
  if (!e.bg) { g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 12; g.shadowOffsetY = 2; }
  lines.forEach((l, i) => g.fillText(l, ax, top + lh * (i + .5)));
  g.restore();
}
function drawImageEl(e) {
  const r = px(e), img = assetImg(e.asset);
  g.save();
  if (!img) {
    if (isHost()) { g.strokeStyle = 'rgba(255,255,255,.35)'; g.setLineDash([6, 6]); g.lineWidth = 2; rr(r.x, r.y, r.w, r.h, 8); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.6)'; g.font = '500 14px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(e.asset ? 'Loading image…' : 'Choose an image', r.x + r.w / 2, r.y + r.h / 2); }
    g.restore(); return;
  }
  g.globalAlpha = e.opacity;
  if (e.radius) { rr(r.x, r.y, r.w, r.h, e.radius); g.clip(); }
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const s = e.fit === 'cover' ? Math.max(r.w / iw, r.h / ih) : Math.min(r.w / iw, r.h / ih);
  const dw = iw * s, dh = ih * s;
  g.drawImage(img, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
  g.restore();
}
function drawTimerEl(e) {
  const r = px(e);
  let label;
  if (e.mode === 'countdown') { const left = Math.max(0, e.target - Date.now()); label = e.target ? fmtTime(left + 999) : '00:00'; }
  else label = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  g.save();
  if (e.bg) { g.fillStyle = e.bg; rr(r.x, r.y, r.w, r.h, 10); g.fill(); }
  g.font = `800 ${e.size}px "JetBrains Mono", ui-monospace, monospace`; g.fillStyle = e.color; g.textAlign = 'center'; g.textBaseline = 'middle';
  if (!e.bg) { g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 10; }
  g.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 2);
  g.restore();
}
function drawOverlays(t) {
  for (const e of S.state.elements || []) {
    if (e.type === 'chat') drawChatEl(e, t);
    else if (e.type === 'text') drawTextEl(e);
    else if (e.type === 'image') drawImageEl(e);
    else if (e.type === 'timer') drawTimerEl(e);
  }
}
const featAnim = { key: '', t0: 0 };
function drawFeatured(t, bottom) {
  const f = S.state.featured;
  if (!f) return;
  if (featAnim.key !== f.id) { featAnim.key = f.id; featAnim.t0 = t; }
  const k = Math.min(1, (t - featAnim.t0) / 380), e = 1 - Math.pow(1 - k, 3);
  const brand = S.state.brand, cw = 560, pad = 22;
  g.save();
  g.font = '500 24px Inter, sans-serif';
  const lines = wrapLines(f.text, cw - pad * 2 - 64, 3);
  const ch = 64 + lines.length * 32 + 10;
  // Sit opposite the chat overlay, and above the banner when both share the left side.
  const chatEl = (S.state.elements || []).find((el) => el.type === 'chat');
  const left = chatEl && chatEl.x + chatEl.w / 2 > 0.5;
  if (left && S.state.banner) bottom -= S.state.banner.sub ? 140 : 100;
  const x = left ? 44 - (1 - e) * 60 : W - cw - 44 + (1 - e) * 60, y = bottom - ch - 20;
  g.globalAlpha = e;
  g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 28; g.shadowOffsetY = 10;
  g.fillStyle = '#ffffff'; rr(x, y, cw, ch, 14); g.fill();
  g.shadowColor = 'transparent';
  g.fillStyle = SRC_COLOR[f.src] || brand.color; rr(x, y, 8, ch, [14, 0, 0, 14]); g.fill();
  void lines;
  g.beginPath(); g.arc(x + pad + 22, y + pad + 20, 20, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff'; g.font = '700 18px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(initials(f.name), x + pad + 22, y + pad + 21);
  g.textAlign = 'left'; g.fillStyle = '#111827'; g.font = '700 20px Inter, sans-serif';
  g.fillText(f.name, x + pad + 54, y + pad + 12);
  g.fillStyle = '#6b7280'; g.font = '500 14px Inter, sans-serif';
  g.fillText(f.src === 'twitch' ? 'on Twitch' : f.src === 'youtube' ? 'on YouTube' : 'in the studio', x + pad + 54, y + pad + 33);
  g.fillStyle = '#111827'; g.font = '500 24px Inter, sans-serif'; g.textBaseline = 'alphabetic';
  lines.forEach((l, i) => g.fillText(l, x + pad + 6, y + 64 + 26 + i * 32));
  g.restore();
}

// ---------------------------------------------------------------- layout editor (host)
const editor = { on: false, sel: null, drag: null, commitT: null };
function elementsCopy() { return (S.state.elements || []).map((e) => ({ ...e })); }
function selEl() { return (S.state.elements || []).find((e) => e.id === editor.sel) || null; }
function commitElements(delay = 0) {
  clearTimeout(editor.commitT);
  editor.commitT = setTimeout(() => setStage({ elements: S.state.elements }), delay);
}
function addElement(type) {
  const e = withDefaults({ type });
  if (type === 'slot') {
    const used = new Set((S.state.elements || []).filter((x) => x.type === 'slot').map((x) => x.index));
    e.index = [0, 1, 2, 3, 4, 5].find((i) => !used.has(i)) ?? 0;
  }
  const patch = { elements: [...elementsCopy(), e] };
  if (type === 'slot' && S.state.layout !== 'custom') patch.layout = 'custom';
  setStage(patch);
  editor.sel = e.id;
  setEditing(true);
  return e;
}
function setEditing(on) {
  editor.on = on && isHost();
  $('#editLayer').hidden = !editor.on;
  $('#editToggle').setAttribute('aria-pressed', String(editor.on));
  $('#editToggle').textContent = editor.on ? 'Done editing' : 'Edit on stage';
  renderEditor();
}
const ELABEL = { slot: 'Camera', chat: 'Chat box', text: 'Text', image: 'Image', timer: 'Timer' };
function elName(e) {
  if (e.type === 'slot') return `Camera ${e.index + 1}`;
  if (e.type === 'text') return e.text ? `“${e.text.slice(0, 22)}”` : 'Text';
  if (e.type === 'timer') return e.mode === 'countdown' ? 'Countdown' : 'Clock';
  return ELABEL[e.type];
}
function renderEditor() {
  const els = S.state.elements || [];
  if (editor.sel && !els.some((e) => e.id === editor.sel)) editor.sel = null;
  // Boxes on the stage
  const layer = $('#editLayer');
  if (editor.on) {
    const custom = S.state.layout === 'custom';
    layer.replaceChildren(...els.filter((e) => custom || e.type !== 'slot').map((e) => {
      const d = document.createElement('div');
      d.className = 'ebox' + (e.id === editor.sel ? ' sel' : '');
      d.dataset.id = e.id;
      Object.assign(d.style, { left: e.x * 100 + '%', top: e.y * 100 + '%', width: e.w * 100 + '%', height: e.h * 100 + '%' });
      const lab = document.createElement('span'); lab.className = 'elab'; lab.textContent = elName(e);
      const hd = document.createElement('i'); hd.className = 'ehandle'; hd.dataset.h = '1';
      d.append(lab, hd);
      return d;
    }));
  }
  // Element list
  const list = $('#elList');
  if (!list) return;
  list.replaceChildren(...els.map((e, i) => {
    const li = document.createElement('li');
    li.className = 'el-row' + (e.id === editor.sel ? ' sel' : '') + (e.type === 'slot' && S.state.layout !== 'custom' ? ' dim' : '');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'el-pick'; b.textContent = elName(e);
    b.onclick = () => { editor.sel = e.id; setEditing(true); };
    const up = mkBtn('↑', 'Bring forward', () => moveEl(i, 1)), dn = mkBtn('↓', 'Send backward', () => moveEl(i, -1)), del = mkBtn('✕', 'Delete', () => deleteEl(e.id));
    li.append(b, up, dn, del);
    return li;
  }));
  $('#elEmpty').hidden = !!els.length;
  renderProps();
}
function mkBtn(txt, title, fn) { const b = document.createElement('button'); b.type = 'button'; b.className = 'el-mini'; b.textContent = txt; b.title = title; b.setAttribute('aria-label', title); b.onclick = fn; b.disabled = !isHost(); return b; }
function moveEl(i, dir) {
  const els = elementsCopy(), j = i + dir;
  if (j < 0 || j >= els.length) return;
  [els[i], els[j]] = [els[j], els[i]];
  setStage({ elements: els });
}
function deleteEl(id) { setStage({ elements: elementsCopy().filter((e) => e.id !== id) }); }

// Property form for the selected element
function renderProps() {
  const box = $('#elProps');
  const e = selEl();
  box.hidden = !e;
  if (!e) return;
  const f = [];
  const field = (label, html) => f.push(`<label class="fld"><span>${label}</span>${html}</label>`);
  const val = (k) => String(e[k] ?? '').replace(/"/g, '&quot;');
  f.push(`<h3>${elName(e).replace(/</g, '&lt;')}</h3>`);
  if (e.type === 'slot') field('Shows', `<select data-k="index" data-num>${[0, 1, 2, 3, 4, 5].map((i) => `<option value="${i}" ${e.index === i ? 'selected' : ''}>Stage position ${i + 1}</option>`).join('')}</select>`);
  if (e.type === 'text') {
    field('Text', `<textarea data-k="text" rows="2" maxlength="200">${val('text').replace(/</g, '&lt;')}</textarea>`);
    field('Size', `<input type="range" min="14" max="140" data-k="size" data-num value="${e.size}">`);
    f.push(`<div class="row2"><label class="fld"><span>Colour</span><input type="color" data-k="color" value="${e.color}"></label><label class="fld"><span>Align</span><select data-k="align">${['left', 'center', 'right'].map((a) => `<option ${e.align === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label></div>`);
    f.push(`<label class="check"><input type="checkbox" data-k="bold" ${e.bold ? 'checked' : ''}> Bold</label>`);
    f.push(`<label class="check"><input type="checkbox" data-bg ${e.bg ? 'checked' : ''}> Background box</label>`);
    if (e.bg) field('Box colour', `<input type="color" data-k="bg" value="${e.bg}">`);
  }
  if (e.type === 'chat') {
    field('Messages shown', `<input type="range" min="2" max="15" data-k="max" data-num value="${e.max}">`);
    field('Text size', `<input type="range" min="12" max="36" data-k="size" data-num value="${e.size}">`);
    f.push(`<label class="check"><input type="checkbox" data-k="bg" ${e.bg ? 'checked' : ''}> Dark backing</label>`);
    f.push(`<label class="check"><input type="checkbox" data-k="fade" ${e.fade ? 'checked' : ''}> Fade out old messages</label>`);
    f.push(`<p class="hint">Shows studio chat${S.state.feeds?.twitch ? ` and Twitch #${S.state.feeds.twitch}` : '. Connect Twitch in the Chat panel to show viewer chat'}.</p>`);
  }
  if (e.type === 'image') {
    f.push(`<label class="btn outline upload-btn"><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-upload hidden>${e.asset ? 'Replace image' : 'Choose image'}</label>`);
    field('Fit', `<select data-k="fit"><option value="contain" ${e.fit === 'contain' ? 'selected' : ''}>Fit inside</option><option value="cover" ${e.fit === 'cover' ? 'selected' : ''}>Fill box</option></select>`);
    field('Opacity', `<input type="range" min="0.1" max="1" step="0.05" data-k="opacity" data-num value="${e.opacity}">`);
    field('Corner rounding', `<input type="range" min="0" max="120" data-k="radius" data-num value="${e.radius}">`);
  }
  if (e.type === 'timer') {
    field('Shows', `<select data-k="mode"><option value="clock" ${e.mode === 'clock' ? 'selected' : ''}>Current time</option><option value="countdown" ${e.mode === 'countdown' ? 'selected' : ''}>Countdown</option></select>`);
    if (e.mode === 'countdown') f.push(`<div class="row">${[1, 3, 5, 10, 15].map((m) => `<button type="button" class="btn outline sm" data-count="${m}">${m} min</button>`).join('')}</div>`);
    field('Size', `<input type="range" min="16" max="140" data-k="size" data-num value="${e.size}">`);
    f.push(`<div class="row2"><label class="fld"><span>Colour</span><input type="color" data-k="color" value="${e.color}"></label></div>`);
    f.push(`<label class="check"><input type="checkbox" data-bg ${e.bg ? 'checked' : ''}> Background box</label>`);
    if (e.bg) field('Box colour', `<input type="color" data-k="bg" value="${e.bg}">`);
  }
  f.push(`<button type="button" class="btn ghost danger-text" data-del>Delete ${ELABEL[e.type].toLowerCase()}</button>`);
  box.innerHTML = f.join('');
  box.querySelectorAll('input, select, textarea').forEach((inp) => { inp.disabled = !isHost() && !inp.dataset.upload; });
}
$('#elProps').addEventListener('input', (ev) => {
  const e = selEl(), t = ev.target;
  if (!e || !isHost()) return;
  if (t.dataset.k) {
    e[t.dataset.k] = t.type === 'checkbox' ? t.checked : t.dataset.num !== undefined ? Number(t.value) : t.value;
    if (t.dataset.k === 'mode') { renderProps(); }
    commitElements(t.type === 'range' || t.tagName === 'TEXTAREA' ? 250 : 0);
  }
  if (t.dataset.bg !== undefined) { e.bg = t.checked ? (e.type === 'text' ? '#1f6feb' : '#111827') : ''; renderProps(); commitElements(); }
});
$('#elProps').addEventListener('change', async (ev) => {
  const t = ev.target, e = selEl();
  if (!e || t.dataset.upload === undefined || !t.files?.[0]) return;
  const id = e.id;
  try {
    const data = await compressImage(t.files[0]);
    const asset = await storeAsset(data);
    const cur = (S.state.elements || []).find((x) => x.id === id);
    if (cur) { cur.asset = asset; commitElements(); renderProps(); toast('Image added.'); }
  }
  catch (err) { toast(err.message, { err: true }); }
});
$('#elProps').addEventListener('click', (ev) => {
  const e = selEl(); if (!e) return;
  if (ev.target.dataset.del !== undefined) deleteEl(e.id);
  if (ev.target.dataset.count) { e.target = Date.now() + Number(ev.target.dataset.count) * 60_000; commitElements(); toast(`Countdown set to ${ev.target.dataset.count} min.`); }
});

// Drag and resize on the stage
$('#editLayer').addEventListener('pointerdown', (ev) => {
  const box = ev.target.closest('.ebox');
  if (!box || !isHost()) { editor.sel = null; renderEditor(); return; }
  const e = (S.state.elements || []).find((x) => x.id === box.dataset.id);
  if (!e) return;
  editor.sel = e.id;
  const rect = $('#stage').getBoundingClientRect();
  editor.drag = { e, mode: ev.target.dataset.h ? 'size' : 'move', sx: ev.clientX, sy: ev.clientY, o: { x: e.x, y: e.y, w: e.w, h: e.h }, rw: rect.width, rh: rect.height };
  box.setPointerCapture(ev.pointerId);
  renderEditor();
  ev.preventDefault();
});
const snap = (v) => { for (const s of [0, .5, 1]) if (Math.abs(v - s) < .012) return s; return Math.round(v * 200) / 200; };
$('#editLayer').addEventListener('pointermove', (ev) => {
  const d = editor.drag; if (!d) return;
  const dx = (ev.clientX - d.sx) / d.rw, dy = (ev.clientY - d.sy) / d.rh;
  if (d.mode === 'move') {
    const nx = snap(d.o.x + dx), ny = snap(d.o.y + dy);
    // also snap the right/bottom edges and the centre
    d.e.x = Math.abs(nx + d.o.w - snap(nx + d.o.w)) < 1e-9 ? nx : snap(nx + d.o.w) - d.o.w;
    d.e.y = Math.abs(ny + d.o.h - snap(ny + d.o.h)) < 1e-9 ? ny : snap(ny + d.o.h) - d.o.h;
    d.e.x = Math.min(1 - .02, Math.max(-d.o.w + .02, d.e.x)); d.e.y = Math.min(1 - .02, Math.max(-d.o.h + .02, d.e.y));
  } else {
    d.e.w = Math.max(.03, Math.min(1.2, snap(d.o.x + d.o.w + dx) - d.o.x));
    d.e.h = Math.max(.03, Math.min(1.2, snap(d.o.y + d.o.h + dy) - d.o.y));
  }
  const box = $(`.ebox[data-id="${d.e.id}"]`);
  if (box) Object.assign(box.style, { left: d.e.x * 100 + '%', top: d.e.y * 100 + '%', width: d.e.w * 100 + '%', height: d.e.h * 100 + '%' });
});
$('#editLayer').addEventListener('pointerup', () => { if (editor.drag) { editor.drag = null; commitElements(); } });
$('#editLayer').addEventListener('pointercancel', () => { editor.drag = null; });

// Panel wiring
$('#editToggle').onclick = () => setEditing(!editor.on);
$$('[data-add]').forEach((b) => b.addEventListener('click', () => { if (!isHost()) return toast('Only the host can change the stage.', { err: true }); addElement(b.dataset.add); }));
function renderTemplates() {
  const wrap = $('#tplList');
  wrap.replaceChildren(...TEMPLATES.map((tpl) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tpl'; b.disabled = !isHost();
    const pv = document.createElement('span'); pv.className = 'tpl-pv';
    for (const e of tpl.els) { const i = document.createElement('i'); i.className = 'tpl-' + e.type; Object.assign(i.style, { left: e.x * 100 + '%', top: e.y * 100 + '%', width: e.w * 100 + '%', height: e.h * 100 + '%' }); pv.append(i); }
    const nm = document.createElement('span'); nm.textContent = tpl.name;
    b.append(pv, nm);
    b.onclick = () => applyTemplate(tpl);
    return b;
  }));
}
// Saved layouts live in this browser (images included, so they work in any new studio).
function savedLayouts() { return store.get('layouts', []); }
function renderSaved() {
  const ul = $('#savedList'), list = savedLayouts();
  ul.replaceChildren(...list.map((l, i) => {
    const li = document.createElement('li'); li.className = 'el-row';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'el-pick'; b.textContent = l.name; b.disabled = !isHost();
    b.onclick = () => loadLayout(l);
    li.append(b, mkBtn('✕', 'Delete saved layout', () => { const all = savedLayouts(); all.splice(i, 1); store.set('layouts', all); renderSaved(); }));
    return li;
  }));
  $('#savedEmpty').hidden = !!list.length;
}
$('#saveLayout').onclick = () => {
  const name = $('#layoutName').value.trim() || `Layout ${savedLayouts().length + 1}`;
  const els = elementsCopy().map((e) => (e.type === 'image' && S.assets.get(e.asset)?.data ? { ...e, _data: S.assets.get(e.asset).data } : e));
  const all = savedLayouts().filter((l) => l.name !== name);
  all.unshift({ name, layout: S.state.layout, elements: els });
  try { store.set('layouts', all.slice(0, 20)); localStorage.getItem('gather:layouts') || 0; } catch {}
  if (!savedLayouts().some((l) => l.name === name)) return toast('Could not save. The images may be too large for this browser.', { err: true });
  $('#layoutName').value = '';
  renderSaved(); toast(`Saved “${name}”.`);
};
async function loadLayout(l) {
  const els = [];
  for (const e of l.elements) {
    if (e.type === 'image' && e._data) { const { _data, ...rest } = e; els.push({ ...rest, asset: await storeAsset(_data).catch(() => '') }); }
    else els.push(e);
  }
  setStage({ layout: l.layout || 'custom', elements: els });
  toast(`Loaded “${l.name}”.`);
}
// Twitch + chat overlay controls (Chat panel)
$('#twitchForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (!isHost()) return toast('Only the host can connect platform chat.', { err: true });
  const v = $('#twitchInput').value.trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (twitch.want && (!v || v === twitch.want)) { setStage({ feeds: { twitch: '' } }); toast('Twitch chat disconnected.'); return; }
  if (!v) return toast('Enter a Twitch channel name.');
  setStage({ feeds: { twitch: v } });
});
$('#chatOverlayBtn').onclick = () => {
  if (!isHost()) return toast('Only the host can change the stage.', { err: true });
  const existing = (S.state.elements || []).find((e) => e.type === 'chat');
  if (existing) { setStage({ elements: elementsCopy().filter((e) => e.id !== existing.id) }); toast('Chat overlay removed.'); }
  else { addElement('chat'); setEditing(false); toast('Chat overlay added. Drag it in Layouts → Edit on stage.'); }
};
$('#featHide').onclick = () => setStage({ featured: null });
function renderFeedUI() {
  const host = isHost();
  $('#twitchInput').disabled = !host;
  $('#twitchGo').disabled = !host;
  $('#twitchGo').textContent = S.state.feeds?.twitch ? 'Disconnect' : 'Connect';
  if (document.activeElement !== $('#twitchInput')) $('#twitchInput').value = S.state.feeds?.twitch || '';
  const hasChat = (S.state.elements || []).some((e) => e.type === 'chat');
  $('#chatOverlayBtn').textContent = hasChat ? 'Remove chat from stage' : 'Show chat on stage';
  $('#chatOverlayBtn').disabled = !host;
  $('#featBar').hidden = !S.state.featured;
  if (S.state.featured) $('#featText').textContent = `${S.state.featured.name}: ${S.state.featured.text}`;
  $('#featHide').disabled = !host;
  $$('#msgs .feat').forEach((b) => { b.hidden = !host; b.textContent = S.state.featured?.id === b.closest('li')?.dataset.fid ? 'On stage' : 'Show on stage'; });
  setTwitchStatus(twitch.status);
}
function renderLayoutsPanel() {
  renderTemplates(); renderSaved(); renderEditor();
  $$('[data-add]').forEach((b) => (b.disabled = !isHost()));
  $('#editToggle').disabled = !isHost();
  $('#saveLayout').disabled = !isHost();
  $('#layoutsHint').textContent = isHost() ? 'Drag and resize on the stage. Changes show for everyone and in recordings.' : 'Only the host can change layouts. You see them on your stage.';
  if (!isHost() && editor.on) setEditing(false);
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
  const fm = { id: msg.id, src: 'studio', name: msg.name, color: '', text: msg.text, ts: msg.ts };
  pushFeed(fm);
  li.dataset.fid = msg.id;
  li.append(who, txt, featureBtn(fm));
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
function renderAll() { renderHeader(); renderStageUI(); renderCrew(); renderDock(); renderPanels(); renderFeedUI(); renderLayoutsPanel(); syncTwitch(); }
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
  if (tab !== 'layouts' && editor.on) setEditing(false);
}
$$('.rail-btn').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('#settingsDock').onclick = () => { setTab('settings'); if (innerWidth <= 900) $('#side').scrollIntoView({ behavior: 'smooth' }); };

$$('.lay').forEach((b) => b.addEventListener('click', () => chooseLayout(b.dataset.layout)));
function chooseLayout(l) {
  if (l === 'custom' && !(S.state.elements || []).some((e) => e.type === 'slot')) return applyTemplate(TEMPLATES[0]);
  setStage({ layout: l });
}

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

// Appearance: dark by default; light or follow the OS on request.
function applyTheme(t) {
  store.set('theme', t);
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name="theme-color"]').setAttribute('content', dark ? '#0d1117' : '#ffffff');
  $$('#themeSeg button').forEach((b) => { const on = b.dataset.themeOpt === t; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
}
$$('#themeSeg button').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.themeOpt)));
applyTheme(store.get('theme', 'dark'));

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
  S.feed = []; editor.sel = null; if (editor.on) setEditing(false);
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
  checkServer();
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
function showEnterErr(msg) { const e = $('#enterErr'); e.textContent = msg; e.hidden = false; }
// Check the server and its storage as soon as the green room opens, so setup problems show up before you click.
async function checkServer() {
  try {
    const c = await api('config');
    if (!c.ok) showEnterErr(c.problem || 'The studio server is not ready.');
  } catch (e) { showEnterErr(e.message); }
}
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
  catch (err) { setEnterMode(enterMode); showEnterErr(err.message); $('#enterGo').disabled = false; setPhase('offline'); }
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
    4: () => isHost() && chooseLayout('custom'),
    delete: () => { if (editor.on && editor.sel) deleteEl(editor.sel); },
    backspace: () => { if (editor.on && editor.sel) deleteEl(editor.sel); },
    escape: () => editor.on && setEditing(false),
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
