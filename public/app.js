import { createAudioChain, createVideoFx, needsProcessing } from './fx.js';
import { icon, busy, togglePopover } from './ui.js';
import { configureGoogle, googleConfigured, googleSignedIn, googleToken, googleSignOut, saveToDrive, findLiveChat, pollLiveChat, ytModerate, googleSignInToken } from './google.js';
import { TIERS, tierOf, drawOrder, isSystem, ensureSystem, blockerFor, overlaps, snapMove, snapResize, resolve, SAFE, GRID, PRESETS, materialize } from './layout.js';
// gather — client. Full-mesh WebRTC studio with a canvas-composited stage.
// The stage canvas is the single source of truth for what you see AND what gets recorded.

const $ = (s, r = document) => r.querySelector(s);
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const smooth = () => (reduceMotion() ? 'auto' : 'smooth');
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// Pictures (avatar, camera and camera-off backgrounds, brand images) are too big for localStorage's
// ~5 MB quota, so they live in IndexedDB behind the same synchronous store API.
const BIG_KEYS = new Set(['avatar', 'fxBg', 'offBg', 'brandImgs', 'arrangements']);
const bigMem = new Map();
function bigDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('gather-images', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
let bigDbP = null;
function bigPut(k, v) {
  (bigDbP ||= bigDb()).then((db) => { const tx = db.transaction('kv', 'readwrite'); v === undefined ? tx.objectStore('kv').delete(k) : tx.objectStore('kv').put(v, k); }).catch(() => {});
}
try {
  const db = await Promise.race([(bigDbP = bigDb()), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 1500))]);
  await new Promise((res) => {
    const tx = db.transaction('kv', 'readonly'), st = tx.objectStore('kv');
    const keys = st.getAllKeys(), vals = st.getAll();
    tx.oncomplete = () => { keys.result.forEach((k, i) => bigMem.set(k, vals.result[i])); res(); };
    tx.onerror = () => res();
  });
} catch {}
for (const k of BIG_KEYS) {
  // One-time move out of localStorage.
  try { const raw = localStorage.getItem('gather:' + k); if (raw != null) { if (!bigMem.has(k)) { bigMem.set(k, JSON.parse(raw)); bigPut(k, JSON.parse(raw)); } localStorage.removeItem('gather:' + k); } } catch {}
}
const store = mkStore(() => localStorage, true);
const sess = mkStore(() => sessionStorage);
function mkStore(get, big) {
  return {
    get(k, d) {
      if (big && BIG_KEYS.has(k)) return bigMem.has(k) ? bigMem.get(k) : d;
      try { const v = get().getItem('gather:' + k); return v == null ? d : JSON.parse(v); } catch { return d; }
    },
    set(k, v) {
      if (big && BIG_KEYS.has(k)) { bigMem.set(k, v); bigPut(k, v); return; }
      try { get().setItem('gather:' + k, JSON.stringify(v)); } catch {}
    },
  };
}

const MAX = 6;
let W = 1280, H = 720; // swapped to 720x1280 for the vertical stage
const DEFAULT_TITLE = 'The conversation studio';
/** A new show is named after its host ("Maya's show") instead of a placeholder that reads like a real title. */
const autoTitle = () => { const first = String(S.name || '').trim().split(/\s+/)[0]; return first ? `${first}’s show`.slice(0, 60) : ''; };
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
  const imgs = store.get('brandImgs', {});
  return {
    layout: 'split', stage: ['me'], banner: null, ticker: '',
    brand: { color: store.get('accent', '#3b82f6'), bg: store.get('bg', 'dusk'), watermark: false, names: true, font: 'jakarta', tag: 'solid', bannerStyle: 'classic', anim: 'slide', frame: 'none', dim: 0.25, logoPos: 'tr', logoSize: 0.12,
      ...store.get('brandPrefs', {}), bgImage: imgs.bgImage ? 'local-brand-bgImage' : '', overlay: imgs.overlay ? 'local-brand-overlay' : '', logo: imgs.logo ? 'local-brand-logo' : '' },
    title: store.get('title', ''), elements: [], featured: null, feeds: { twitch: '' },
    aspect: store.get('streamPrefs', {}).aspect || '16:9', captions: { on: false, style: 'bar', size: 26, lang: 'en-US', ...(store.get('streamPrefs', {}).captions || {}) },
  };
}
const isHost = () => !S.studio || S.host === S.id;
const myId = () => S.id || 'me';

// ---------------------------------------------------------------- utils
function toast(msg, opts = {}) {
  const t = document.createElement('div');
  t.className = 'toast glass on-media' + (opts.err ? ' err' : '');
  t.setAttribute('role', opts.err ? 'alert' : 'status');
  t.textContent = msg;
  if (opts.action) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm link'; b.textContent = opts.action[0]; b.onclick = () => { opts.action[1](); t.remove(); }; t.append(b); }
  const box = $('#toasts');
  box.append(t);
  // Re-show the popover each time, so it is the newest thing in the top layer and never hides behind a dialog.
  if (box.showPopover) { try { if (box.matches(':popover-open')) box.hidePopover(); box.showPopover(); } catch {} }
  setTimeout(() => { t.remove(); if (!box.children.length && box.hidePopover) { try { box.hidePopover(); } catch {} } }, opts.ms || 3200);
}
// A dialog opened after a toast would cover it; bring the toasts back on top.
for (const d of document.querySelectorAll('dialog')) new MutationObserver(() => { const box = $('#toasts'); if (d.open && box.children.length && box.showPopover) { try { box.hidePopover(); box.showPopover(); } catch {} } }).observe(d, { attributes: true, attributeFilter: ['open'] });
const initials = (n) => (n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const fmtTime = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const newCode = () => 'gather-' + [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
/** The kind of gather link pasted: 's' (invite), 'c' (call-in), 'w' (watch), or '' for a bare code. */
const linkKind = (v) => (String(v || '').match(/\/([scw])\/[a-z0-9-]+/i) || [])[1]?.toLowerCase() || '';
function parseCode(v) {
  v = String(v || '').trim();
  const m = v.match(/\/[scw]\/([a-z0-9-]+)/i);
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
S.audioFx = { echo: true, ns: true, agc: true, ai: false, gain: 1, ...store.get('audioFx', {}) };
S.videoFx = { effect: 'none', bright: 0, contrast: 1, sat: 1, key: '#00ff00', tol: 0.1, spill: 0.85, edge: 0.1, blur: 1, fps: 30, mirror: true, ...store.get('videoFx', {}) };
function camConstraints() {
  const h = Number(S.prefs.quality) || 720;
  return { width: { ideal: Math.round(h * 16 / 9) }, height: { ideal: h }, frameRate: { ideal: Number(S.videoFx.fps) || 30 }, ...(S.prefs.camId ? { deviceId: { exact: S.prefs.camId } } : {}) };
}
function micConstraints() {
  const a = S.audioFx;
  return { echoCancellation: a.echo, noiseSuppression: a.ns, autoGainControl: a.agc, channelCount: 1, ...(S.prefs.micId ? { deviceId: { exact: S.prefs.micId } } : {}) };
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
    const raw = s.getVideoTracks()[0];
    raw.contentHint = 'motion';
    S.local.camRaw = raw;
    S.local.camError = '';
    raw.onended = () => { if (S.local.camRaw !== raw) return; stopCam(); if (S.local.camOn) { S.local.camOn = false; syncMedia(); toast('Your camera disconnected.', { err: true }); } };
    await applyVideoFx();
    listDevices();
    return S.local.cam;
  } catch (e) { S.local.camError = mediaErr(e); return null; }
}
function stopCam() { vfx?.stop(); vfx = null; S.local.camRaw?.stop(); S.local.camRaw = null; S.local.cam = null; }
// Background effects and light correction run in fx.js; with nothing to do, the camera track goes out untouched.
let vfx = null, fxBgImg = null;
function fxBgImage() {
  const d = store.get('fxBg', '');
  if (!d) return null;
  if (!fxBgImg || fxBgImg.dataset.src !== d) {
    fxBgImg = new Image(); fxBgImg.dataset.src = d;
    fxBgImg.onload = () => vfx?.set({ bgImage: fxBgImg });
    fxBgImg.src = d;
  }
  return fxBgImg;
}
async function applyVideoFx() {
  const raw = S.local.camRaw;
  if (!raw) { vfx?.stop(); vfx = null; S.local.cam = null; return; }
  const opts = { ...S.videoFx, bgImage: fxBgImage() };
  if (!needsProcessing(opts)) { vfx?.stop(); vfx = null; S.local.cam = raw; return; }
  if (vfx && vfx.src === raw) { vfx.set(opts); S.local.cam = vfx.track; return; }
  vfx?.stop();
  try { vfx = await createVideoFx(raw, opts); vfx.src = raw; S.local.cam = vfx.track; }
  catch (e) { vfx = null; S.local.cam = raw; toast('Video effects: ' + e.message, { err: true }); }
}
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
    await applyAudioFx();
    listDevices();
    return S.local.audio;
  } catch (e) { toast('Microphone: ' + mediaErr(e), { err: true }); return null; }
}
function stopMic() { afx?.dispose(); afx = null; S.local.audioOut = null; S.local.audio?.stop(); S.local.audio = null; localMeter?.dispose(); localMeter = null; }
let afx = null, fxCtx = null;
function fxAudioCtx() {
  if (!fxCtx) { try { fxCtx = new AudioContext({ sampleRate: 48000 }); } catch { fxCtx = null; } }
  fxCtx?.resume?.().catch(() => {});
  return fxCtx;
}
const micOut = () => S.local.audioOut || S.local.audio || null;
async function applyAudioFx() {
  afx?.dispose(); afx = null; S.local.audioOut = null;
  if (S.local.audio && (S.audioFx.ai || Math.abs(S.audioFx.gain - 1) > 0.01)) {
    const ctx = S.audioFx.ai ? fxAudioCtx() : audioCtx();
    if (ctx) {
      afx = await createAudioChain(ctx, S.local.audio, { aiNoise: S.audioFx.ai, gain: S.audioFx.gain });
      S.local.audioOut = afx.track;
      if (S.audioFx.ai && !afx.ai) toast('AI noise removal is unavailable here: ' + afx.note, { err: true });
    }
  }
  localMeter?.dispose(); localMeter = S.local.audio ? meter(micOut()) : null;
}
const outVideo = () => (S.local.camOn ? S.local.cam : null);

async function setMic(on) {
  S.local.micOn = on;
  if (on && !S.local.audio) await startMic();
  if (!on && S.local.audio) stopMic(); // muting releases the microphone, so the browser's mic indicator goes off
  if (on && !S.local.audio) S.local.micOn = false;
  syncMedia();
  syncCaptions();
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
    p.aT?.sender.replaceTrack(outAudio()).catch(() => {});
    p.vT?.sender.replaceTrack(v || null).catch(() => {});
    p.pT?.sender.replaceTrack(presTrack()).catch(() => {});
  }
  const me = $('#card-' + cssId(myId()));
  const el = me && $('video', me);
  if (el) { const cur = el.srcObject?.getVideoTracks()[0]; if (cur !== v) el.srcObject = v ? new MediaStream([v]) : null; el.classList.toggle('mirror', !!S.videoFx.mirror); }
  sendMeta({ mic: S.local.micOn, cam: S.local.camOn, sharing: !!S.local.pres });
  renderDock(); renderCrew(); renderPreview(); renderPresBar();
}

async function listDevices() {
  if (!media?.enumerateDevices) return;
  const devs = await media.enumerateDevices();
  fill($('#camSelect'), devs.filter((d) => d.kind === 'videoinput'), S.local.camRaw?.getSettings().deviceId || S.prefs.camId, 'camera');
  fill($('#micSelect'), devs.filter((d) => d.kind === 'audioinput'), S.local.audio?.getSettings().deviceId || S.prefs.micId, 'microphone');
  function fill(sel, list, cur, kind) {
    sel.replaceChildren(new Option(`Default ${kind}`, ''), ...list.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => new Option(d.label || `${kind[0].toUpperCase() + kind.slice(1)} ${i + 1}`, d.deviceId)));
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  }
}
media?.addEventListener?.('devicechange', listDevices);

// ---------------------------------------------------------------- presentation: screen, video file, PDF
// Each connection carries a second video track for whatever is being presented,
// so cameras stay visible while a screen, video or slide deck is on stage.
const PRES_W = 1920, PRES_H = 1080;
const presTrack = () => S.local.pres?.track || null;

// Outgoing audio: the raw mic, or mic + media audio (a video's sound, a tab's sound) while one plays.
let sendMix = null;
function outAudio() {
  if (!S.local.mediaAudio) return micOut();
  const ctx = audioCtx();
  if (!sendMix) sendMix = { dest: ctx.createMediaStreamDestination(), micSrc: null, micTrack: null };
  if (sendMix.micTrack !== micOut()) {
    try { sendMix.micSrc?.disconnect(); } catch {}
    sendMix.micSrc = micOut() ? ctx.createMediaStreamSource(new MediaStream([micOut()])) : null;
    sendMix.micSrc?.connect(sendMix.dest);
    sendMix.micTrack = micOut();
  }
  return sendMix.dest.stream.getAudioTracks()[0];
}
function mixInMedia(node) {
  S.local.mediaAudio = (S.local.mediaAudio || 0) + 1;
  outAudio();
  node.connect(mixBus); node.connect(sendMix.dest);
  return { dispose() { try { node.disconnect(); } catch {} S.local.mediaAudio = Math.max(0, S.local.mediaAudio - 1); } };
}

function startPresentation(pres) {
  if (S.local.pres) S.local.pres.stop();
  S.local.pres = pres;
  syncMedia();
  autoPresentScene(myId());
}
function stopPresentation() {
  const pres = S.local.pres;
  if (!pres) return;
  S.local.pres = null;
  pres.stop();
  syncMedia();
  autoEndPresentScene();
}
/** Share a screen, or (game) a game window: 60 fps, up to 1080p, encoded for motion rather than sharp text. */
async function presentScreen(game = false) {
  if (!media?.getDisplayMedia) return toast('Screen sharing is not supported in this browser.', { err: true });
  try {
    const s = await media.getDisplayMedia({ video: game ? { frameRate: { ideal: 60, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } } : { frameRate: { ideal: 30 } }, audio: true, systemAudio: 'include' });
    const track = s.getVideoTracks()[0];
    track.contentHint = game ? 'motion' : 'detail';
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = new MediaStream([track]);
    $('#mediaSink').append(v); v.play().catch(() => {});
    const at = s.getAudioTracks()[0];
    const audio = at ? mixInMedia(audioCtx().createMediaStreamSource(new MediaStream([at]))) : null;
    track.onended = stopPresentation;
    startPresentation({ kind: 'screen', game, name: track.label || (game ? 'Game' : 'Screen'), track, source: v, stop() { s.getTracks().forEach((t) => t.stop()); v.remove(); audio?.dispose(); } });
    toast(game ? `Game mode: 60 fps${at ? ' with game sound' : ''}. Pick “Game + facecam” for your camera in the corner.` : at ? 'Sharing your screen with its sound.' : 'Sharing your screen.');
  } catch (e) { if (e?.name !== 'NotAllowedError') toast('Screen share: ' + mediaErr(e), { err: true }); }
}
function presCanvas() { const c = document.createElement('canvas'); c.width = PRES_W; c.height = PRES_H; return c; }
function fitDraw(cg, src, sw, sh, bg = '#05070d') {
  cg.fillStyle = bg; cg.fillRect(0, 0, PRES_W, PRES_H);
  if (!sw || !sh) return;
  const k = Math.min(PRES_W / sw, PRES_H / sh), dw = sw * k, dh = sh * k;
  cg.drawImage(src, (PRES_W - dw) / 2, (PRES_H - dh) / 2, dw, dh);
}
async function presentVideo(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.src = url; v.playsInline = true; v.preload = 'auto';
  const ctx = audioCtx();
  const src = ctx.createMediaElementSource(v);
  src.connect(ctx.destination); // the host hears it too
  const audio = mixInMedia(src);
  const c = presCanvas(), cg = c.getContext('2d');
  const track = c.captureStream(30).getVideoTracks()[0];
  track.contentHint = 'motion';
  try { await v.play(); } catch {}
  startPresentation({
    kind: 'video', name: file.name, track, source: c, video: v,
    draw() { fitDraw(cg, v, v.videoWidth, v.videoHeight); },
    stop() { v.pause(); audio.dispose(); try { src.disconnect(); } catch {} URL.revokeObjectURL(url); track.stop(); },
  });
  v.onended = () => renderPresBar();
}
let pdfLib = null;
function loadPdfJs() {
  if (pdfLib) return pdfLib;
  pdfLib = new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = '/vendor/pdf.min.js';
    sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js'; res(window.pdfjsLib); };
    sc.onerror = () => { pdfLib = null; rej(new Error('Could not load the PDF reader. Check your connection.')); };
    document.head.append(sc);
  });
  return pdfLib;
}
async function presentPDF(file) {
  if (!file) return;
  toast('Opening ' + file.name + '…');
  try {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const c = presCanvas(), cg = c.getContext('2d');
    const page = document.createElement('canvas'); // the rendered slide, repainted onto c every frame
    const track = c.captureStream(15).getVideoTracks()[0];
    track.contentHint = 'detail';
    const pres = {
      kind: 'pdf', name: file.name, page: 1, pages: doc.numPages, track, source: c,
      draw() { fitDraw(cg, page, page.width, page.height, '#0b0f1a'); },
      // Fast next/previous presses: each request renders into its own canvas and cancels the one before,
      // and only the newest finished page is shown (pdf.js can't render twice into one canvas at once).
      async go(n) {
        n = Math.max(1, Math.min(doc.numPages, n));
        pres.page = n; renderPresBar();
        const ticket = ++pres.ticket;
        try { pres.task?.cancel(); } catch {}
        const pg = await doc.getPage(n);
        if (ticket !== pres.ticket) return;
        const base = pg.getViewport({ scale: 1 });
        const vp = pg.getViewport({ scale: Math.min(PRES_W / base.width, PRES_H / base.height) * 1.5 });
        const off = document.createElement('canvas'); off.width = Math.round(vp.width); off.height = Math.round(vp.height);
        pres.task = pg.render({ canvasContext: off.getContext('2d'), viewport: vp });
        try { await pres.task.promise; } catch (e) { if (e?.name === 'RenderingCancelledException') return; throw e; }
        if (ticket !== pres.ticket) return;
        page.width = off.width; page.height = off.height; page.getContext('2d').drawImage(off, 0, 0);
        renderPresBar();
      },
      ticket: 0, task: null,
      stop() { track.stop(); doc.destroy(); },
    };
    await pres.go(1);
    startPresentation(pres);
  } catch (e) { toast('PDF: ' + (e.message || 'could not open that file'), { err: true }); }
}

// Present menu + presenter controls
$('#shareBtn').onclick = (ev) => {
  if (S.local.pres) return stopPresentation();
  togglePopover($('#presentMenu'), ev.currentTarget, 'top');
};
$('#presentMenu').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-present]'); if (!b) return;
  $('#presentMenu').hidePopover();
  const kind = b.dataset.present;
  if (kind === 'screen') presentScreen();
  if (kind === 'game') presentScreen(true);
  if (kind === 'video') $('#videoFile').click();
  if (kind === 'pdf') $('#pdfFile').click();
  if (kind === 'image') $('#imageFile').click();
  if (kind === 'ai') { setTab('ai'); $('#aiInput').focus(); }
});
$('#videoFile').onchange = (e) => { presentVideo(e.target.files[0]); e.target.value = ''; };
$('#pdfFile').onchange = (e) => { presentPDF(e.target.files[0]); e.target.value = ''; };
function renderPresBar() {
  const bar = $('#presBar'), pres = S.local.pres;
  bar.hidden = !pres;
  if (!pres) return;
  bar.dataset.kind = pres.kind;
  $('#presKind').textContent = { screen: 'Screen', video: 'Video', pdf: 'Slides' }[pres.kind];
  $('#presName').textContent = pres.name;
  $('#presPdf').hidden = pres.kind !== 'pdf';
  $('#presVid').hidden = pres.kind !== 'video';
  if (pres.kind === 'pdf') $('#presPage').textContent = `${pres.page} / ${pres.pages}`;
  if (pres.kind === 'video') {
    const v = pres.video;
    $('#presPlay').textContent = v.paused ? 'Play' : 'Pause';
    $('#presTime').textContent = `${fmtTime(v.currentTime * 1000)} / ${fmtTime((v.duration || 0) * 1000)}`;
    if (document.activeElement !== $('#presSeek')) $('#presSeek').value = v.duration ? String(v.currentTime / v.duration) : '0';
    $('#presLoop').setAttribute('aria-pressed', String(v.loop));
  }
}
$('#presPrev').onclick = () => S.local.pres?.go?.(S.local.pres.page - 1);
$('#presNext').onclick = () => S.local.pres?.go?.(S.local.pres.page + 1);
$('#presPlay').onclick = () => { const v = S.local.pres?.video; if (!v) return; v.paused ? v.play() : v.pause(); renderPresBar(); };
$('#presSeek').oninput = (e) => { const v = S.local.pres?.video; if (v?.duration) v.currentTime = Number(e.target.value) * v.duration; };
$('#presLoop').onclick = () => { const v = S.local.pres?.video; if (v) { v.loop = !v.loop; renderPresBar(); } };
$('#presStop').onclick = stopPresentation;
setInterval(() => { if (S.local.pres?.kind === 'video') renderPresBar(); }, 250);

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
/** A random id this browser keeps (local only, never synced or shown), so a removed guest can't walk back in. */
function deviceId() {
  let d = store.get('dev', '');
  if (!/^[a-f0-9]{24}$/.test(d)) { d = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join(''); store.set('dev', d); }
  return d;
}
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
    if (e.status === 403) return kickedOut(e.message);
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
      if (e.status === 403) return kickedOut(e.message);
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
  S.studio = null; S.id = null; S.tok = null; S.short = "";
  setPhase('reconnecting');
  setTimeout(() => join(code).catch((e) => { if (e.status === 403) return kickedOut(e.message); toast(e.message, { err: true }); setPhase('offline'); }), 800);
}
function beaconLeave(why) {
  if (!S.studio) return;
  const body = JSON.stringify({ ...creds(), why }); // why 'left' (the Leave button) hands the host seat over for good
  pollGen++;
  if (!(navigator.sendBeacon && navigator.sendBeacon('/api/studio?action=leave', new Blob([body], { type: 'application/json' })))) api('leave', JSON.parse(body)).catch(() => {});
}
addEventListener('pagehide', () => beaconLeave());

async function iceConfig(serverIce) {
  const ice = [...(serverIce || [])];
  const url = sess.get('turnUrl', ''), user = sess.get('turnUser', ''), pass = sess.get('turnPass', '');
  if (url) {
    // A bad entry makes the browser refuse to connect at all, so check it and fall back to the built-in servers.
    const urls = url.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = urls.find((u) => !/^(stun|turns?):[^\s]+$/i.test(u));
    const needsLogin = urls.some((u) => /^turns?:/i.test(u)) && (!user || !pass);
    if (bad || needsLogin) toast(bad ? `Your TURN server “${bad}” isn’t a valid address (it should start with turn:, turns: or stun:), so it was skipped. Fix it in Settings.` : 'Your TURN server needs a username and password, so it was skipped. Add them in Settings.', { err: true, ms: 9000 });
    else ice.push({ urls, username: user || undefined, credential: pass || undefined });
  }
  S.serverIce = serverIce || [];
  return ice;
}

async function join(code, opts = {}) {
  setPhase(S.phase === 'reconnecting' ? 'reconnecting' : 'connecting');
  audioCtx();
  const pass = opts.pass || S.joinPass?.[code];
  let r;
  // Only "Create studio" may open a studio; every other path (invite links, the Join box, reconnects) joins one.
  const intent = opts.create ? 'create' : 'join';
  try { r = await api('join', { studio: code, dev: deviceId(), name: S.name || 'Guest', mic: S.local.micOn, cam: S.local.camOn, acct: acct.token || undefined, pass, callin: opts.callin || undefined, intent }); }
  catch (e) {
    if (e.status === 423 && $('#enterDlg').open) { setPhase('offline'); startKnock(code, opts.callin); return; }
    if (e.status === 404 && intent === 'join' && !opts.callin && !opts.noWait && $('#enterDlg').open) { setPhase('offline'); waitForHost(code, e.message); return; }
    if (e.status === 403) { setPhase('offline'); }
    throw e;
  }
  if (pass) (S.joinPass ||= {})[code] = pass; // a reconnect after a network drop keeps our admission
  await onServer(r);
}

async function onServer(m) {
  switch (m.type) {
    case 'joined': {
      const wasHosting = isHost() && !S.studio;
      S.id = m.id; S.tok = m.tok; S.studio = m.studio; S.host = m.host; S.short = m.short || "";
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
        setStage({ aspect: pre.aspect, captions: pre.captions, brand: { ...pre.brand, bgImage: '', overlay: '', logo: '' }, title: pre.title || autoTitle(), watch: { ...WATCH_DEFAULTS, ...store.get('watchPrefs', {}) }, shop: { items: store.get('shopItems', []), pinned: '', sale: null }, layout: pre.layout, banner: pre.banner, ticker: pre.ticker, stage: [S.id], feeds: pre.feeds, scene: pre.scene || '', elements: (pre.elements || []).filter((e) => !(e.type === 'image' && e.asset?.startsWith('local-'))) });
        uploadLocalAssets(pre.elements).then((elements) => { if (S.host === S.id) setStage({ elements }); });
        uploadBrandAssets(pre.brand);
        if (S.pendingStream?.id) acctApi('streamStart', { id: S.pendingStream.id }).catch(() => {});
        S.pendingStream = null;
      }
      sendMeta({ mic: S.local.micOn, cam: S.local.camOn, sharing: !!S.local.pres });
      uploadAvatar(); S.local.offbgId = ''; uploadOffBg();
      $('#knockWait').hidden = true; $('#enterFields').hidden = false;
      if (S.host === S.id) { refreshLobby(); refreshSupers(); refreshVoice(); }
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
      if (isHost() && !S.state.stage.includes(p.id) && S.state.stage.length < MAX) {
        // Guests wait backstage until the host brings them on (or straight on, if the host chose that).
        if (store.get('autoStage', false)) setStage({ stage: [...S.state.stage, p.id] });
        else { toast(`${p.name} is backstage`, { action: ['Put on stage', () => toggleStage(p.id)], ms: 10000 }); }
      }
      renderAll();
      break;
    }
    case 'signal': onSignal(m.from, m.data); break;
    case 'peer-left': {
      const p = S.peers.get(m.id);
      if (p) { sysMsg(`${p.name} left`); closePeer(p); if (p.sharing) setTimeout(autoEndPresentScene, 0); }
      const wasHost = S.host === S.id;
      S.host = m.host; S.state = m.state;
      if (!wasHost && S.host === S.id) {
        // Say plainly why the host controls just appeared, and keep it up long enough to read.
        const who = p?.name || 'The host';
        toast(m.why === 'dropped' ? `${who}’s connection dropped. You’re hosting until they’re back.` : `${who} left and handed the studio to you. You’re the host now.`, { ms: 20000, action: ['Got it', () => {}] });
        refreshLobby();
      }
      renderAll();
      break;
    }
    case 'peer-meta': {
      const p = S.peers.get(m.peer.id);
      if (!p) break;
      const startedSharing = m.peer.sharing && !p.sharing, stoppedSharing = !m.peer.sharing && p.sharing;
      Object.assign(p, { name: m.peer.name, mic: m.peer.mic, cam: m.peer.cam, sharing: m.peer.sharing, avatar: m.peer.avatar || '', offbg: m.peer.offbg || '' });
      if (startedSharing) autoPresentScene(p.id);
      if (stoppedSharing) autoEndPresentScene();
      renderCrew();
      break;
    }
    case 'state': S.state = m.state; renderAll(); break;
    case 'chat': addMsg(m.msg); break;
    case 'feed': for (const it of m.items || []) addExternal(it); break;
    case 'viewer-want': viewerWant(m.vid); break;
    case 'vsignal': viewerSignal(m.from, m.data); break;
    case 'viewer-left': closeViewer(m.vid); break;
    case 'superchat': gotSuperchat(m.item, true); break;
    case 'react': reactFloat(m.emoji); break;
    case 'wqueue': gotQueue(m); break;
    case 'voicemail': gotVoice(m.item, true); break;
    case 'voicemail-update': if (!m.item) dropVoice(m.id); else gotVoice(m.item, false); break;
    case 'queue': renderQueue(m.items); break;
    case 'wreport': if (m.count >= 3) toast(`A watch-page message was hidden after ${m.count} spam reports.`, { ms: 6000 }); break;
    case 'ai': upsertAI(m.item, false); break;
    case 'caption': showCaption(m.from, m.name, m.text, m.final); break;
    case 'host': {
      const wasHost = S.host === S.id;
      S.host = m.host;
      if (S.host === S.id) { toast('You are now the host.'); refreshLobby(); }
      else if (wasHost) toast(`${S.peers.get(m.host)?.name || 'The host'} is back and hosting again.`, { ms: 8000 });
      renderAll();
      break;
    }
    case 'mute': if (S.local.micOn) { setMic(false); toast(`${m.by || 'The host'} muted you. Unmute when you’re ready to talk.`); } break;
    case 'knock': S.lobby = m.lobby || []; renderLobby(); setDeck('lobby'); chime(); toast(`${m.who?.name || 'Someone'} ${m.who?.callin ? 'is calling in' : 'is waiting to join'}.`, { action: ['Open', () => setDeck('lobby')] }); break;
    case 'lobby': S.lobby = m.lobby || []; renderLobby(); break;
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
  Object.assign(p, { name: info.name, mic: info.mic, cam: info.cam, sharing: info.sharing, avatar: info.avatar || '', offbg: info.offbg || '', joinedAt: info.joinedAt });
  return p;
}
function createPeer(info, offerer) {
  const p = addPeer(info);
  if (p.pc) return p;
  let pc;
  try { pc = new RTCPeerConnection({ iceServers: S.iceServers, bundlePolicy: 'max-bundle' }); }
  catch {
    // The browser rejected a TURN entry: connect with the server's own list instead of not at all.
    S.iceServers = S.serverIce || [];
    pc = new RTCPeerConnection({ iceServers: S.iceServers, bundlePolicy: 'max-bundle' });
    toast('Your TURN settings didn’t work, so gather is using its own servers. Check them in Settings.', { err: true, ms: 9000 });
  }
  p.pc = pc; p.offerer = offerer;
  if (offerer) {
    p.aT = pc.addTransceiver('audio', { direction: 'sendrecv' });
    p.vT = pc.addTransceiver('video', { direction: 'sendrecv' });
    p.pT = pc.addTransceiver('video', { direction: 'sendrecv' }); // presentation
    p.aT.sender.replaceTrack(outAudio());
    p.vT.sender.replaceTrack(outVideo() || null);
    p.pT.sender.replaceTrack(presTrack());
    pc.onnegotiationneeded = async () => {
      try { await pc.setLocalDescription(); sig(p.id, { sdp: pc.localDescription }); } catch (e) { console.warn('offer failed', e); }
    };
  }
  pc.onicecandidate = (e) => { if (e.candidate) sig(p.id, { candidate: e.candidate }); };
  pc.ontrack = (e) => {
    // The third m-line (mid "2") is the presentation track.
    if (e.track.kind === 'video' && (e.transceiver === p.pT || e.transceiver.mid === '2')) {
      let el = $('#pres-' + cssId(p.id));
      if (!el) { el = document.createElement('video'); el.id = 'pres-' + cssId(p.id); el.muted = true; el.autoplay = true; el.playsInline = true; $('#mediaSink').append(el); }
      el.srcObject = new MediaStream([e.track]); el.play().catch(() => {});
      return;
    }
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
            if (t.receiver.track.kind === 'audio') p.aT = t; else if (!p.vT) p.vT = t; else p.pT = t;
          }
          await p.aT?.sender.replaceTrack(outAudio());
          await p.vT?.sender.replaceTrack(outVideo() || null);
          await p.pT?.sender.replaceTrack(presTrack());
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
  $('#pres-' + cssId(p.id))?.remove();
}
function teardownPeers() { for (const p of [...S.peers.values()]) closePeer(p); }

// Autoplay: remote audio may be blocked until the viewer interacts.
function playEl(el) {
  const pr = el.play();
  pr?.catch(() => {
    if (!el.muted) { el.muted = true; el.dataset.blocked = '1'; el.play().catch(() => {}); if (!S.audioBlocked) { S.audioBlocked = true; $('#audioUnblock').hidden = false; } }
  });
}
function tryPlayAll() { for (const p of S.peers.values()) { const el = cardVideo(p.id); if (el && el.srcObject) playEl(el); } }
document.addEventListener('pointerdown', () => {
  audioCtx();
  if (!S.audioBlocked) return;
  S.audioBlocked = false; $('#audioUnblock').hidden = true;
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
  if (patch.elements) patch = { ...patch, elements: ensureSystem(patch.elements, (patch.aspect || S.state.aspect) === '9:16', uid) };
  S.state = { ...S.state, ...patch, brand: { ...S.state.brand, ...(patch.brand || {}) } };
  if ('scene' in patch) store.set('lastScene', S.state.scene || '');
  else if (patch.elements) rememberArrangement();
  if (S.studio) wsSend({ type: 'state', state: S.state });
  else { store.set('accent', S.state.brand.color); store.set('bg', S.state.brand.bg); store.set('title', S.state.title); }
  renderAll();
}
function toggleStage(id) {
  const on = S.state.stage.includes(id);
  setStage({ stage: on ? S.state.stage.filter((x) => x !== id) : [...S.state.stage, id] });
}

// ---------------------------------------------------------------- participants model
function participants() {
  const me = { id: myId(), me: true, name: S.name || 'You', mic: S.local.micOn && !!S.local.audio, cam: !!outVideo(), sharing: !!S.local.pres, avatar: S.local.avatarId || '', offbg: S.local.offbgId || '', joinedAt: S.local.joinedAt, level: localMeter?.level() || 0 };
  const list = [me];
  for (const p of S.peers.values()) list.push({ id: p.id, name: p.name, mic: p.mic, cam: p.cam, sharing: p.sharing, avatar: p.avatar || '', offbg: p.offbg || '', joinedAt: p.joinedAt, peer: p, level: p.meters[0]?.level() || 0 });
  return list.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}
function cardVideo(id) { return $(`#card-${cssId(id)} video`); }

// ---------------------------------------------------------------- canvas stage
const canvas = $('#stageCanvas');
const g = canvas.getContext('2d');
const speaking = new Map(); // id -> last time above threshold

function rr(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
const edCanvas = $('#editorCanvas'), ed = edCanvas.getContext('2d');
const editorLayers = [];
/** Queue a host-only hint. Layers flagged editorOnly draw on the editor canvas, never on the program canvas. */
function editorOnly(paint) { editorLayers.push({ editorOnly: true, paint }); }
function flushEditorLayers() {
  if (edCanvas.width !== W || edCanvas.height !== H) { edCanvas.width = W; edCanvas.height = H; }
  ed.clearRect(0, 0, W, H);
  for (const l of editorLayers.splice(0)) if (l.editorOnly && isHost()) { ed.save(); l.paint(ed); ed.restore(); }
}
function layoutRects(n, layout, area) {
  const { x, y, w, h } = area, gap = 16;
  if (!n) return [];
  if (layout === 'solo' || n === 1) return [{ x, y, w, h }];
  if (layout === 'spotlight') {
    const sh = Math.round(h * (h > w ? 0.16 : 0.22)), mh = h - sh - gap, k = n - 1;
    const tw = Math.min((w - gap * (k - 1)) / k, sh * 16 / 9);
    const total = tw * k + gap * (k - 1), sx = x + (w - total) / 2;
    return [{ x, y, w, h: mh }, ...Array.from({ length: k }, (_, i) => ({ x: sx + i * (tw + gap), y: y + mh + gap, w: tw, h: sh }))];
  }
  const portrait = h > w;
  const cols = portrait ? (n <= 3 ? 1 : 2) : n <= 3 ? n : n === 4 ? 2 : 3, rows = Math.ceil(n / cols);
  const tw = (w - gap * (cols - 1)) / cols, th = (h - gap * (rows - 1)) / rows;
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols), inRow = r === rows - 1 ? n - r * cols : cols;
    const off = (w - (inRow * tw + (inRow - 1) * gap)) / 2;
    return { x: x + off + (i % cols) * (tw + gap), y: y + r * (th + gap), w: tw, h: th };
  });
}
const FONTS = { jakarta: '"Plus Jakarta Sans"', onest: 'Onest', playfair: '"Playfair Display"', bebas: '"Bebas Neue"', mono: '"JetBrains Mono"', serif: '"DM Serif Display"' };
const stageFont = () => (FONTS[S.state.brand.font] || FONTS.jakarta) + ', Inter, sans-serif';
function drawBackground(t) {
  const bgImg = assetImg(S.state.brand.bgImage);
  if (bgImg) {
    const k = Math.max(W / bgImg.naturalWidth, H / bgImg.naturalHeight), dw = bgImg.naturalWidth * k, dh = bgImg.naturalHeight * k;
    g.drawImage(bgImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
    g.fillStyle = `rgba(4,8,20,${S.state.brand.dim ?? 0.25})`; g.fillRect(0, 0, W, H);
    return;
  }
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
    const s = Math.max(w / vw, h / vh), sw = w / s, sh = h / s;
    g.drawImage(el, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
  } else drawAudioTile(p, x, y, w, h, t);
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
    const label = p.name; // the program is recorded and streamed, so never "(you)" here
    g.font = `700 ${fs}px ${stageFont()}`; g.textAlign = 'left'; g.textBaseline = 'middle';
    const tw = Math.min(g.measureText(label).width, w - 80), bw = tw + fs * 1.4, bh = fs * 1.9;
    const style = brand.tag || 'solid';
    let ink = '#ffffff';
    if (style === 'solid') { g.fillStyle = brand.color; rr(tx, ty, bw, bh, 6); g.fill(); ink = contrastInk(brand.color); }
    else if (style === 'glass') { g.fillStyle = 'rgba(8,14,30,.62)'; rr(tx, ty, bw, bh, 8); g.fill(); g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 1; g.stroke(); g.fillStyle = brand.color; rr(tx, ty + 6, 3, bh - 12, 2); g.fill(); }
    else if (style === 'outline') { g.strokeStyle = brand.color; g.lineWidth = 2; rr(tx + 1, ty + 1, bw - 2, bh - 2, 6); g.stroke(); g.fillStyle = 'rgba(0,0,0,.25)'; g.fill(); }
    else { g.fillStyle = brand.color; g.fillRect(tx + fs * .7, ty + bh - 3, tw, 3); }
    g.fillStyle = ink;
    if (style === 'minimal') { g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 8; }
    g.save(); g.beginPath(); g.rect(tx, ty, bw, bh); g.clip();
    g.fillText(label, tx + fs * .7, ty + fs * .97); g.restore();
    g.shadowColor = 'transparent';
    tx += bw + 6;
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
// Entrance animations shared by banners and featured messages: returns {alpha, dx, scale, clip, chars}.
function entrance(t0, t, len) {
  const kind = S.state.brand.anim || 'slide';
  const k = Math.min(1, (t - t0) / (kind === 'type' ? 900 : 450)), e = 1 - Math.pow(1 - k, 3);
  if (kind === 'fade') return { alpha: e, dx: 0, scale: 1, clip: 1, chars: len };
  if (kind === 'pop') { const o = k < 1 ? 1 + Math.sin(k * Math.PI) * .06 : 1; return { alpha: Math.min(1, k * 2.5), dx: 0, scale: (.85 + .15 * e) * o, clip: 1, chars: len }; }
  if (kind === 'wipe') return { alpha: 1, dx: 0, scale: 1, clip: e, chars: len };
  if (kind === 'type') return { alpha: 1, dx: 0, scale: 1, clip: 1, chars: Math.ceil(len * k) };
  return { alpha: e, dx: -(1 - e) * 40, scale: 1, clip: 1, chars: len };
}
function drawBanner(t, r) {
  const b = S.state.banner;
  if (!b) return;
  const key = b.id + b.text + b.sub;
  if (S.banner.key !== key) S.banner = { key, t0: t };
  const brand = S.state.brand, style = brand.bannerStyle || 'classic', F = stageFont();
  const an = entrance(S.banner.t0, t, b.text.length);
  const text = b.text.slice(0, an.chars);
  const k = Math.max(.5, r.h / ((style === 'bold' ? 78 : 64) + 40));
  const big = (style === 'bold' ? 40 : 30) * k, subF = 19 * k, padX = 28 * k;
  g.save();
  g.globalAlpha = an.alpha;
  g.font = `800 ${big}px ${F}`;
  const tw = Math.min(g.measureText(style === 'bold' ? b.text.toUpperCase() : b.text).width, r.w - padX * 2);
  let subW = 0;
  if (b.sub) { g.font = `500 ${subF}px ${F}`; subW = Math.min(g.measureText(b.sub).width, r.w - padX * 2); }
  const bw = Math.min(r.w, Math.max(tw, subW) + padX * 2);
  const mainH = (style === 'bold' ? 78 : 64) * k, subH = b.sub ? 40 * k : 0;
  const x = r.x + an.dx, y = r.y + r.h - mainH - subH;
  // scale around the banner's left edge, clip for the wipe
  g.translate(x, y + (mainH + subH) / 2); g.scale(an.scale, an.scale); g.translate(-x, -(y + (mainH + subH) / 2));
  g.beginPath(); g.rect(x - 4, y - 30, (bw + 8) * an.clip, mainH + subH + 60); g.clip();
  const shadow = () => { g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 24; g.shadowOffsetY = 8; };
  let ink = contrastInk(brand.color), subInk = '#1f2937';
  if (style === 'classic') {
    shadow(); g.fillStyle = brand.color; rr(x, y, bw, mainH, b.sub ? [10, 10, 0, 0] : 10); g.fill(); g.shadowColor = 'transparent';
    if (b.sub) { g.fillStyle = '#ffffff'; rr(x, y + mainH, bw, subH, [0, 0, 10, 10]); g.fill(); }
  } else if (style === 'glass') {
    shadow(); g.fillStyle = 'rgba(8,14,30,.72)'; rr(x, y, bw, mainH + subH, 14); g.fill(); g.shadowColor = 'transparent';
    g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 1; g.stroke();
    g.fillStyle = brand.color; rr(x, y + 12, 5, mainH + subH - 24, 3); g.fill();
    ink = '#ffffff'; subInk = 'rgba(230,238,255,.85)';
  } else if (style === 'bold') {
    shadow(); g.fillStyle = brand.color; g.fillRect(x, y, bw, mainH); g.shadowColor = 'transparent';
    if (b.sub) { g.fillStyle = '#0b1020'; g.fillRect(x, y + mainH, bw, subH); subInk = '#ffffff'; }
  } else {
    ink = '#ffffff'; subInk = 'rgba(230,238,255,.9)';
    g.fillStyle = brand.color; g.fillRect(x + padX, y + mainH - 8 * k, Math.min(tw, 220 * k), 4 * k);
  }
  g.textBaseline = 'middle'; g.textAlign = 'left';
  if (style === 'minimal') { g.shadowColor = 'rgba(0,0,0,.7)'; g.shadowBlur = 12; }
  g.fillStyle = ink; g.font = `800 ${big}px ${F}`;
  g.fillText(style === 'bold' ? text.toUpperCase() : text, x + padX, y + mainH / 2 + 1);
  if (b.sub && an.chars >= b.text.length) { g.fillStyle = subInk; g.font = `500 ${subF}px ${F}`; g.fillText(b.sub, x + padX, y + mainH + subH / 2 + 1); }
  g.restore();
}
function drawTicker(t, r) {
  const text = S.state.ticker;
  if (!text) return;
  const brand = S.state.brand, fs = Math.max(12, Math.round(r.h * .43));
  g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
  g.fillStyle = brand.color; g.fillRect(r.x, r.y, r.w, r.h);
  g.font = `600 ${fs}px Inter, sans-serif`; g.textBaseline = 'middle'; g.textAlign = 'left';
  const unit = text + '     •     ', uw = g.measureText(unit).width, off = (t / 1000 * 90) % uw;
  g.fillStyle = contrastInk(brand.color);
  for (let x = r.x - off; x < r.x + r.w; x += uw) g.fillText(unit, x, r.y + r.h / 2 + 1);
  g.restore();
}
function drawFrame() {
  const brand = S.state.brand, f = brand.frame;
  if (f === 'vignette') { const r = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .35, W / 2, H / 2, Math.max(W, H) * .75); r.addColorStop(0, 'rgba(0,0,0,0)'); r.addColorStop(1, 'rgba(0,0,0,.55)'); g.fillStyle = r; g.fillRect(0, 0, W, H); }
  if (f === 'border') { g.strokeStyle = brand.color; g.lineWidth = 8; g.strokeRect(4, 4, W - 8, H - 8); }
  if (f === 'corners') {
    g.strokeStyle = brand.color; g.lineWidth = 6; g.lineCap = 'round'; const L = Math.min(W, H) * .08, m = 18;
    for (const [cx, cy, sx, sy] of [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]) { g.beginPath(); g.moveTo(cx, cy + sy * L); g.lineTo(cx, cy); g.lineTo(cx + sx * L, cy); g.stroke(); }
  }
  const ov = assetImg(brand.overlay);
  if (ov) g.drawImage(ov, 0, 0, W, H);
}
function drawLogo(r) {
  const logo = assetImg(S.state.brand.logo);
  if (!logo) return;
  const k = Math.min(r.w / logo.naturalWidth, r.h / logo.naturalHeight), w = logo.naturalWidth * k, h = logo.naturalHeight * k;
  const right = r.x + r.w / 2 > W / 2;
  g.drawImage(logo, right ? r.x + r.w - w : r.x, r.y + (r.h - h) / 2, w, h);
}
function drawShapeEl(e) {
  const r = px(e);
  g.save(); g.globalAlpha = e.opacity ?? 1; g.fillStyle = e.color || '#000000'; rr(r.x, r.y, r.w, r.h, e.radius || 0); g.fill(); g.restore();
}
function drawChrome() {
  g.textBaseline = 'middle';
  // The show title is no longer drawn on the stage: it lives in the header and on the watch page.
  if (window.__shopReady) { drawProduct(); drawPoll(); drawWatchBadge(); }
}
// The program is painted tier by tier: stage → media → (brand frame) → overlays → chat → ticker → system.
const TIER_Z = Object.fromEntries(TIERS.map((x) => [x.id, x.z]));
/** The scene's elements, with any missing system element (lower third, ticker, logo…) at its default spot. */
function stageElements() { return ensureSystem(S.state.elements || [], isVertical(), () => 'sys'); }
function draw() {
  const t = performance.now();
  syncAspect();
  drawBackground(t);
  const inStudio = !!S.studio;
  const els = drawOrder(stageElements()).filter((e) => !e.hidden);
  if (!inStudio && !previewActive()) {
    drawFrame();
    const lg = els.find((e) => e.type === 'logo'); if (lg) drawLogo(px(lg));
    drawChrome(); return;
  }
  const people = participants();
  const byId = new Map(people.map((p) => [p.id, p]));
  const stageIds = inStudio ? S.state.stage : [myId()];
  const onStage = stageIds.map((id) => byId.get(id)).filter(Boolean);
  const custom = S.state.layout === 'custom';
  if (!onStage.length) {
    editorOnly((c) => { c.fillStyle = 'rgba(255,255,255,.7)'; c.font = '600 22px Inter, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('Add someone to the stage from “In the studio”.', W / 2, H / 2); });
  }
  // Built-in layouts place cameras automatically, above the ticker when it runs along the bottom.
  if (!custom || !els.some((e) => e.type === 'slot')) {
    const tick = els.find((e) => e.type === 'ticker');
    const bottom = tick && S.state.ticker && tick.y > .7 ? tick.y * H - 12 : H - 32;
    const rects = layoutRects(onStage.length, custom ? 'split' : S.state.layout, { x: 32, y: 44, w: W - 64, h: bottom - 44 });
    onStage.forEach((p, i) => rects[i] && drawTile(p, rects[i], t));
    camRects = rects.slice(0, onStage.length);
  } else camRects = [];
  let framed = false;
  for (const e of els) {
    if (!framed && TIER_Z[tierOf(e)] >= 300) { drawFrame(); framed = true; }
    drawElement(e, t, onStage, custom);
  }
  if (!framed) drawFrame();
  drawChrome();
}
let camRects = []; // where the built-in layout put cameras this frame
/** Lift a banner off any small camera tile (Spotlight's thumbnails) so it never covers a guest's face. */
function clearOfCams(r) {
  const small = camRects.filter((c) => c.w * c.h < W * H * 0.25 && r.x < c.x + c.w && c.x < r.x + r.w && r.y < c.y + c.h && c.y < r.y + r.h);
  if (!small.length) return r;
  const top = Math.min(...small.map((c) => c.y));
  return { ...r, y: Math.max(44, top - r.h - 12) };
}
function drawElement(e, t, onStage, custom) {
  switch (e.type) {
    case 'slot': {
      if (!custom) return;
      const p = onStage[e.index], r = { ...px(e), r: e.radius };
      if (p) drawTile(p, r, t);
      else editorOnly((c) => {
        c.strokeStyle = 'rgba(255,255,255,.28)'; c.setLineDash([8, 8]); c.lineWidth = 2; c.beginPath(); c.roundRect(r.x, r.y, r.w, r.h, r.r ?? 10); c.stroke();
        c.fillStyle = 'rgba(255,255,255,.45)'; c.font = '500 15px Inter, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(`Stage position ${e.index + 1}`, r.x + r.w / 2, r.y + r.h / 2);
      });
      return;
    }
    case 'media': if (custom) drawMediaEl(e); return;
    case 'shape': drawShapeEl(e); return;
    case 'ai': drawAiEl(e); return;
    case 'tip': drawTipEl(e); return;
    case 'callin': drawCallinEl(e); return;
    case 'chat': drawChatEl(e, t); return;
    case 'text': drawTextEl(e); return;
    case 'image': drawImageEl(e); return;
    case 'timer': drawTimerEl(e); return;
    case 'banner': drawBanner(t, clearOfCams(px(e))); return;
    case 'ticker': drawTicker(t, px(e)); return;
    case 'logo': drawLogo(px(e)); return;
    case 'ads': drawAds(px(e)); return;
    case 'featured': drawFeatured(t, px(e)); return;
    case 'captions': drawCaptions(clearOfCams(px(e))); return;
  }
}
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
function contrastInk(hex) { const n = parseInt(hex.slice(1), 16); const [r, gg, b] = [n >> 16, (n >> 8) & 255, n & 255]; return (0.299 * r + 0.587 * gg + 0.114 * b) > 170 ? '#111827' : '#ffffff'; }

// Render loop: rAF while visible; a worker clock keeps recordings smooth in background tabs.
// Frame budget: the program is captured at 30 fps, so drawing faster only burns CPU. On a slow machine (no GPU,
// one core) a frame can cost 50–100 ms; back off so drawing never takes more than about half the main thread
// (80 % while recording or live), leaving time for signalling, chat and clicks.
let lastFrame = 0, nextFrame = 0, frameGap = 1000 / 30;
function drawProgram() {
  const t0 = performance.now();
  lastFrame = t0; S.local.pres?.draw?.(); draw(); flushEditorLayers();
  const cost = performance.now() - t0, onAir = !!(S.rec || S.live || S.viewers?.size); // direct watch-page viewers count as on air
  // Game mode draws at 60 fps; everything else at 30 (what recordings and streams capture).
  frameGap = Math.max(editor.on || S.local.pres?.game ? 0 : 1000 / 30 - 2, cost * (onAir ? 1.25 : 2));
  nextFrame = t0 + frameGap;
}
function frame(now) {
  requestAnimationFrame(frame);
  if (now >= nextFrame - 1) drawProgram();
  meters(); speakingCards();
}
requestAnimationFrame(frame);
// rAF stops in background tabs; a worker clock keeps the program (and so recordings) drawing there.
const clock = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),33)'], { type: 'text/javascript' })));
clock.onmessage = () => { const now = performance.now(); if (now - lastFrame > Math.max(120, frameGap + 60) && now >= nextFrame) drawProgram(); };

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
const SRC_COLOR = { studio: null, twitch: '#9146ff', youtube: '#ff0033', rumble: '#85c742', x: '#e7e9ea', kick: '#53fc18', watch: '#16a34a' };
const SRC_NAME = { studio: 'Studio', twitch: 'Twitch', youtube: 'YouTube', rumble: 'Rumble', x: 'X', kick: 'Kick', watch: 'Watch page' };
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
const seenFeed = new Set();
function addExternal(m) {
  if (seenFeed.has(m.id)) return;
  seenFeed.add(m.id);
  pushFeed(m);
  const li = document.createElement('li');
  li.className = 'msg ext' + (m.paid ? ' paid' : '');
  setMsgData(li, m);
  const who = document.createElement('div'); who.className = 'who';
  const badge = document.createElement('span'); badge.className = 'pill caps src-' + m.src; badge.textContent = SRC_NAME[m.src] || m.src;
  const b = document.createElement('b'); b.textContent = m.name; if (m.color) b.style.color = m.color;
  who.append(badge, b);
  if (m.q) { const q = document.createElement('span'); q.className = 'q-badge'; q.textContent = '✋ Question'; who.append(q); }
  if (m.paid) { const amt = document.createElement('span'); amt.className = 'paid-amt'; amt.textContent = m.paid; who.append(amt); }
  const txt = document.createElement('div'); txt.className = 'txt'; txt.textContent = m.text;
  li.append(who, txt, msgActions(m));
  appendLog(li);
  applyModeration(li);
  const log = $('#msgs'); while (log.children.length > 300) log.firstChild.remove();
}
function setMsgData(li, m) { li.dataset.fid = m.id; li.dataset.src = m.src; li.dataset.user = String(m.name || '').toLowerCase(); }

// Moderation is enforced by gather for every platform: hidden, timed-out and blocked viewers
// disappear from the overlay and from everyone's studio chat. Lists live in the shared stage state.
const modState = () => S.state.mod || { hidden: [], blocked: [], timeouts: [] };
function isModerated(m) {
  const mod = modState(), user = String(m.name || m.user || '').toLowerCase(), src = m.src || 'studio', now = Date.now();
  if (mod.hidden.includes(m.id)) return 'by host';
  if (mod.blocked.some((x) => x.src === src && x.user === user)) return 'blocked';
  if (mod.timeouts.some((x) => x.src === src && x.user === user && x.until > now)) return 'timed out';
  return '';
}
function moderate(kind, m, secs) {
  if (!isHost()) return;
  const mod = structuredClone(modState()), user = String(m.name).toLowerCase(), src = m.src || 'studio';
  if (kind === 'hide') mod.hidden.push(m.id);
  if (kind === 'unhide') { mod.hidden = mod.hidden.filter((x) => x !== m.id); mod.blocked = mod.blocked.filter((x) => !(x.src === src && x.user === user)); mod.timeouts = mod.timeouts.filter((x) => !(x.src === src && x.user === user)); }
  if (kind === 'block') mod.blocked.push({ src, user });
  if (kind === 'timeout') mod.timeouts.push({ src, user, until: Date.now() + secs * 1000 });
  const patch = { mod };
  const f = S.state.featured;
  if (kind !== 'unhide' && f && (f.id === m.id || (kind !== 'hide' && f.src === src && String(f.name).toLowerCase() === user))) patch.featured = null;
  setStage(patch);
  const label = { hide: 'Message hidden', block: `${m.name} blocked`, timeout: `${m.name} timed out for ${secs >= 3600 ? secs / 3600 + ' h' : secs / 60 + ' min'}`, unhide: `${m.name} restored` }[kind];
  if (src === 'youtube' && kind !== 'unhide') {
    if (!yt.liveChatId) return toast(`${label} in gather. Connect YouTube in the Stream tab to also apply it on YouTube.`);
    ytModerate(kind, yt.liveChatId, m, secs)
      .then(() => toast(`${label}, in gather and on YouTube.`))
      .catch((e) => toast(`${label} in gather. YouTube didn’t take it: ${e.message}`, { err: true, ms: 6000 }));
    return;
  }
  const platformSide = { twitch: 'Twitch', x: 'X' }[src];
  toast(label + (kind !== 'unhide' && platformSide ? ` in gather. ${platformSide} has no moderation access from gather yet, so it stays visible there.` : '.'));
}
let timeoutFor = null, timeoutPop = null;
function timeoutMenu() {
  if (timeoutPop) return timeoutPop;
  timeoutPop = document.createElement('div');
  timeoutPop.className = 'popover glass raised'; timeoutPop.popover = 'auto'; timeoutPop.setAttribute('role', 'menu'); timeoutPop.setAttribute('aria-label', 'Time out for');
  const menu = document.createElement('div'); menu.className = 'menu';
  for (const [sec, l] of [[300, '5 minutes'], [3600, '1 hour'], [86400, '24 hours']]) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'menu-item compact'; b.setAttribute('role', 'menuitem'); b.textContent = l;
    b.onclick = () => { timeoutPop.hidePopover(); if (timeoutFor) moderate('timeout', timeoutFor, sec); };
    menu.append(b);
  }
  timeoutPop.append(menu);
  document.body.append(timeoutPop);
  return timeoutPop;
}
function msgActions(m) {
  const bar = document.createElement('div'); bar.className = 'mact';
  const mk = (txt, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = txt; b.onclick = fn; return b; };
  bar.append(mk('Show on stage', 'pill accent feat', () => {
    const on = S.state.featured?.id === m.id;
    setStage({ featured: on ? null : { id: m.id, src: m.src, name: m.name, text: m.text, color: m.color || '' } });
  }));
  bar.append(mk('Hide', 'pill mod-hide', () => moderate('hide', m)));
  const tm = mk('Time out', 'pill', (ev) => { timeoutFor = m; togglePopover(timeoutMenu(), ev.currentTarget, 'bottom'); });
  tm.setAttribute('aria-haspopup', 'menu');
  bar.append(tm, mk('Block', 'pill danger mod-block', () => moderate('block', m)), mk('Restore', 'pill mod-restore', () => moderate('unhide', m)));
  return bar;
}
function applyModeration(li) {
  const m = { id: li.dataset.fid, src: li.dataset.src, name: li.dataset.user };
  const why = isModerated(m);
  li.classList.toggle('modded', !!why);
  li.dataset.why = why;
}
function applyModerationAll() { $$('#msgs li[data-fid]').forEach(applyModeration); }

// YouTube: the host signs in with Google (in this browser only), gather reads the broadcast's live chat,
// relays new messages to the studio, and Hide / Time out / Block act on YouTube too.
const yt = { liveChatId: '', title: '', stop: null };
function setYtStatus(state, detail = '') {
  const el = $('#ytStatus');
  el.dataset.state = state === 'live' ? 'live' : state === 'error' || state === 'ended' ? 'error' : 'off';
  el.textContent = { live: `Reading “${yt.title}”`, connecting: 'Connecting…', error: detail || 'Something went wrong', ended: detail || 'The live chat has ended', off: googleConfigured() ? 'Not connected' : 'Needs Google sign-in set up on the server' }[state] || detail;
  $('#ytGo').textContent = yt.liveChatId ? 'Disconnect' : 'Connect';
}
function stopYouTube() { yt.stop?.(); Object.assign(yt, { liveChatId: '', title: '', stop: null }); setYtStatus('off'); }
$('#ytForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!isHost()) return toast('Only the host can connect platform chat.', { err: true });
  if (yt.liveChatId) { stopYouTube(); return toast('YouTube chat disconnected.'); }
  if (!S.studio) return toast('Enter your studio first, then connect YouTube chat.', { err: true });
  busy($('#ytGo')); setYtStatus('connecting');
  try {
    const chat = await findLiveChat($('#ytInput').value);
    Object.assign(yt, chat);
    yt.stop = pollLiveChat(chat.liveChatId, (items) => {
      const fresh = items.filter((m) => !seenFeed.has(m.id));
      fresh.forEach(addExternal);
      if (fresh.length) wsSend({ type: 'feed', items: fresh.map(({ id, src, name, color, text, ts, paid }) => ({ id, src, name, color, text, ts, paid })) });
    }, (state, detail) => { if (state !== 'live') { yt.stop?.(); yt.liveChatId = ''; } setYtStatus(state, detail); });
    setYtStatus('live');
    toast(`Connected to “${chat.title}”. Its chat now flows into gather.`);
  } catch (e) { setYtStatus('error', e.message); toast(e.message, { err: true }); }
  finally { busy($('#ytGo'), false); renderGoogle(); }
});
$('#driveAuto').onchange = async (e) => {
  if (!e.target.checked) { store.set('driveAuto', false); return renderGoogle(); }
  try { await googleToken(['drive']); store.set('driveAuto', true); toast('New recordings will be saved to Google Drive.'); }
  catch (err) { e.target.checked = false; toast(err.message, { err: true }); }
  renderGoogle();
};
$('#googleOut').onclick = async () => { stopYouTube(); await googleSignOut(); store.set('driveAuto', false); renderGoogle(); toast('Disconnected from Google.'); };
function renderGoogle() {
  const ok = googleConfigured(), host = isHost();
  $('#ytGo').disabled = !ok || !host; $('#ytInput').disabled = !ok || !host;
  $('#driveAuto').disabled = !ok; $('#driveAuto').checked = ok && !!store.get('driveAuto', false);
  $('#driveNote').textContent = ok ? 'Each recording goes into a “gather recordings” folder in your Drive.' : 'Needs Google sign-in set up on this server (GOOGLE_CLIENT_ID in Vercel).';
  const parts = [googleSignedIn('drive') && 'Drive', googleSignedIn('youtube') && 'YouTube'].filter(Boolean);
  $('#googleState').textContent = !ok ? 'Google sign-in isn’t set up on this server yet.' : parts.length ? `Connected to Google: ${parts.join(' and ')}. Sign-in lasts an hour, then Google asks again.` : 'Not connected. You’ll be asked to sign in the first time you use Drive or YouTube.';
  $('#googleOut').hidden = !parts.length;
  if (!yt.liveChatId) setYtStatus('off');
  renderDriveButton();
}
api('config').then((c) => {
  configureGoogle(c.googleClientId); renderGoogle();
  S.houseAI = c.houseAI || null; renderAIPanel();
  S.relayOn = !!c.relay; renderLive();
  S.requireAccount = !!c.requireAccount;
  if (c.builtInTurn) $('#turnHint').textContent = 'gather’s built-in relay already connects guests on strict corporate and mobile networks. Add your own only if you need to.';
}).catch(() => renderGoogle());

// Rumble: the host's personal Live Stream API URL (contains a key) stays in the host's browser.
// The host polls it through our proxy and relays new messages to the studio.
const rumble = { timer: null, url: '', status: 'off', fails: 0 };
function syncRumble() {
  const want = isHost() && S.studio ? store.get('rumbleUrl', '') : '';
  if (want === rumble.url) return;
  rumble.url = want; rumble.fails = 0;
  clearTimeout(rumble.timer);
  if (want) pollRumble(); else setRumbleStatus(store.get('rumbleUrl', '') ? 'saved' : 'off');
}
async function pollRumble() {
  if (!rumble.url || !S.studio) return;
  try {
    const r = await api('rumble', { ...creds(), url: rumble.url });
    rumble.fails = 0;
    setRumbleStatus(r.live ? 'live' : 'idle', r.title);
    const fresh = r.msgs.filter((m) => !seenFeed.has(m.id));
    fresh.forEach(addExternal);
    if (fresh.length) wsSend({ type: 'feed', items: fresh });
  } catch (e) {
    rumble.fails++;
    setRumbleStatus('error', e.message);
  }
  rumble.timer = setTimeout(pollRumble, rumble.fails ? Math.min(60000, 5000 * 2 ** rumble.fails) : 5000);
}
function setRumbleStatus(st, detail = '') {
  rumble.status = st;
  const el = $('#rumbleStatus'); if (!el) return;
  el.dataset.state = st === 'live' ? 'live' : st === 'error' ? 'error' : 'off';
  el.textContent = { off: 'Not connected', saved: 'Connects when you enter a studio', idle: 'Connected · not live right now', live: `Reading ${detail ? '“' + detail + '”' : 'your live chat'}`, error: detail || 'Could not read Rumble chat' }[st];
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
  media: () => ({ type: 'media', x: .025, y: .07, w: .7, h: .86, radius: 12 }),
  ai: () => ({ type: 'ai', x: .62, y: .07, w: .355, h: .62, size: 22 }),
  tip: () => ({ type: 'tip', x: .025, y: .64, w: .34, h: .31, provider: 'paypal', url: '', label: 'Support the show' }),
  callin: () => ({ type: 'callin', x: .66, y: .66, w: .31, h: .28, url: S.studio ? watchLinkUrl() : '', label: 'Watch & chat live', phone: '' }), // the watch-link card (QR + address)
  shape: () => ({ type: 'shape', x: .4, y: .4, w: .2, h: .2, color: '#0b1020', opacity: 1, radius: 0, label: '' }),
};
const px720 = (x, y, w, h) => ({ x: x / 1280, y: y / 720, w: w / 1280, h: h / 720 });
const TEMPLATES = [
  // Used automatically when someone presents: the slides fill the frame, cameras float on top.
  { id: 'present-full', name: 'Full-screen slides', els: [
    { type: 'media', x: 0, y: 0, w: 1, h: 1, radius: 0, stack: true },
    { type: 'slot', index: 0, ...px720(1064, 32, 184, 136), radius: 12, pip: true, stack: true },
    { type: 'slot', index: 1, ...px720(1064, 184, 184, 136), radius: 12, pip: true, stack: true },
    { type: 'slot', index: 2, ...px720(1064, 336, 184, 136), radius: 12, pip: true, stack: true }] },
  // Used by "AI window on stage" while someone presents.
  { id: 'screen-ai', name: 'Screen + AI', els: [
    { type: 'media', ...px720(48, 48, 752, 520) }, { type: 'ai', ...px720(832, 48, 400, 352) },
    { type: 'slot', index: 0, ...px720(832, 424, 400, 144) },
    { type: 'banner', ...px720(48, 584, 752, 104) }, { type: 'logo', ...px720(832, 592, 400, 88) },
    { type: 'captions', ...px720(160, 488, 960, 64), stack: true }] },
  ...PRESETS,
];
const V_TEMPLATES = [
  { id: 'v-solo', name: 'Vertical solo', els: [{ type: 'slot', index: 0, x: .04, y: .06, w: .92, h: .8, radius: 18 }] },
  { id: 'v-stack', name: 'Stacked duo', els: [{ type: 'slot', index: 0, x: .04, y: .06, w: .92, h: .42, radius: 16 }, { type: 'slot', index: 1, x: .04, y: .5, w: .92, h: .42, radius: 16 }] },
  { id: 'v-present', name: 'Vertical presentation', els: [{ type: 'media', x: .04, y: .08, w: .92, h: .3 }, { type: 'slot', index: 0, x: .04, y: .41, w: .92, h: .5, radius: 16 }] },
  { id: 'v-ai', name: 'Vertical AI', els: [{ type: 'ai', x: .04, y: .06, w: .92, h: .44, size: 26 }, { type: 'slot', index: 0, x: .04, y: .53, w: .92, h: .4, radius: 16 }] },
  { id: 'v-chat', name: 'Vertical + chat', els: [{ type: 'slot', index: 0, x: .04, y: .06, w: .92, h: .56, radius: 16 }, { type: 'chat', x: .04, y: .65, w: .92, h: .28, max: 6, size: 24, bg: true }] },
];
const TPL = Object.fromEntries([...TEMPLATES, ...V_TEMPLATES].map((t) => [t.id, t]));
const isVertical = () => S.state.aspect === '9:16';
const BUILTINS = [
  { id: 'b-solo', name: 'Solo', layout: 'solo' },
  { id: 'b-split', name: 'Side by side', layout: 'split' },
  { id: 'b-spotlight', name: 'Spotlight', layout: 'spotlight' },
];
function withDefaults(e) { return { ...(ELEMENT_DEFAULTS[e.type]?.() || {}), ...e, id: e.id || uid() }; }
// Cards the host added (QR / support, call-in, images) follow them from scene to scene; if one would overlap the
// new scene it is hidden rather than allowed to collide, and the Layers list shows it.
const CARRIED = ['tip', 'callin', 'image'];
function carryInto(base) {
  const placed = [], hidden = [];
  for (const e of (S.state.elements || []).filter((x) => CARRIED.includes(x.type))) {
    const c = { ...e };
    if (!c.hidden && !c.stack && blockerFor(c, c, [...base, ...placed])) { c.hidden = true; hidden.push(elName(c)); }
    placed.push(c);
  }
  if (hidden.length) setTimeout(() => toast(`${hidden.join(', ')} hidden in this scene so nothing overlaps. Show it from Layouts → Layers.`, { ms: 5200 }), 50);
  return placed;
}
/** Elements for a scene: what the host arranged there last time, or the scene's design plus carried cards. */
function sceneElements(id, design) {
  const saved = arrangement(id);
  if (saved) return saved;
  const base = materialize(design.map(withDefaults), uid);
  return ensureSystem([...base, ...carryInto(base)], isVertical(), uid);
}
function templatePatch(tpl) { return { layout: 'custom', scene: tpl.id, elements: sceneElements(tpl.id, tpl.els) }; }
function applyTemplate(tpl) { setStage(templatePatch(tpl)); }

// ---- per-scene arrangements: saved on every edit, restored when the scene comes back (and after a reload)
let arrT = 0;
function rememberArrangement() {
  if (!isHost() || !S.state.scene) return;
  clearTimeout(arrT);
  const id = S.state.scene, els = S.state.elements;
  arrT = setTimeout(() => {
    const all = store.get('arrangements', {});
    all[id] = { layout: S.state.layout, elements: els.map((e) => (e.type === 'image' && S.assets.get(e.asset)?.data ? { ...e, _data: S.assets.get(e.asset).data } : e)), t: Date.now() };
    store.set('arrangements', all);
  }, 300);
}
function arrangement(id) {
  const a = store.get('arrangements', {})[id];
  if (!a?.elements?.length) return null;
  const els = a.elements.map(({ _data, ...e }) => e);
  const missing = a.elements.filter((e) => e._data && !assetImg(e.asset));
  if (missing.length) rehydrate(missing);
  return els;
}
// Images saved with a scene come back into a new studio by uploading their pixels again.
async function rehydrate(list) {
  for (const m of list) {
    try {
      const asset = await storeAsset(m._data);
      const els = elementsCopy(), e = els.find((x) => x.id === m.id);
      if (e) { e.asset = asset; setStage({ elements: els }); }
    } catch {}
  }
}
function resetScene() {
  const id = S.state.scene;
  if (!id) return toast('Pick a scene first.');
  const all = store.get('arrangements', {}); delete all[id]; store.set('arrangements', all);
  const sc = sceneList().find((x) => x.id === id);
  if (sc) applyScene(sc);
  toast('Scene reset to its original layout.');
}

// When anyone starts presenting, the host's stage flips to a presentation scene, and back afterwards.
const hasMediaScene = () => S.state.layout === 'custom' && (S.state.elements || []).some((e) => e.type === 'media');
function autoPresentScene(id) {
  if (!isHost()) return;
  const patch = { presenter: id };
  if (!hasMediaScene()) {
    S.prePres = { layout: S.state.layout, elements: elementsCopy(), scene: S.state.scene || '' };
    Object.assign(patch, templatePatch(isVertical() ? TPL['v-present'] : TPL['present-full']));
  }
  setStage(patch);
}
function autoEndPresentScene() {
  if (!isHost()) return;
  const still = participants().find((p) => p.sharing);
  if (still) return setStage({ presenter: still.id });
  if (S.prePres) { const pre = S.prePres; S.prePres = null; setStage({ ...pre, presenter: '' }); }
  else setStage({ presenter: '' });
}

// Images: uploaded once per studio, cached as decoded <img> for drawing.
S.assets = new Map(); // id -> { img, data, loading }
function assetImg(id) {
  if (!id) return null;
  let a = S.assets.get(id);
  if (!a && id.startsWith('local-brand-')) {
    const data = store.get('brandImgs', {})[id.slice(12)];
    if (data) { setAssetData(id, data); a = S.assets.get(id); }
  }
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
  const msgs = S.feed.filter((m) => !isModerated(m) && (!e.fade || now - m.ts < 90_000)).slice(-e.max);
  g.save();
  rr(r.x, r.y, r.w, r.h, 12); g.clip();
  if (e.bg) drawPanel(r.x, r.y, r.w, r.h, 12);
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
    editorOnly((c) => { c.strokeStyle = 'rgba(255,255,255,.35)'; c.setLineDash([6, 6]); c.lineWidth = 2; c.beginPath(); c.roundRect(r.x, r.y, r.w, r.h, 8); c.stroke();
      c.fillStyle = 'rgba(255,255,255,.6)'; c.font = '500 14px Inter, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(e.asset ? 'Loading image…' : 'Choose an image', r.x + r.w / 2, r.y + r.h / 2); });
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
function presenterOf() {
  const people = participants();
  return people.find((p) => p.id === S.state.presenter && p.sharing) || people.find((p) => p.sharing) || null;
}
function drawMediaEl(e) {
  const r = px(e), R = e.radius ?? 12, who = presenterOf();
  const src = who ? (who.me ? S.local.pres?.source : $('#pres-' + cssId(who.id))) : null;
  const sw = src ? (src.videoWidth || src.width) : 0, sh = src ? (src.videoHeight || src.height) : 0;
  g.save();
  rr(r.x, r.y, r.w, r.h, R); g.clip();
  g.fillStyle = '#05070d'; g.fillRect(r.x, r.y, r.w, r.h);
  if (src && sw && sh && (src.readyState === undefined || src.readyState >= 2)) {
    const k = Math.min(r.w / sw, r.h / sh), dw = sw * k, dh = sh * k;
    g.drawImage(src, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
  } else {
    const hint = who ? `Waiting for ${who.name}'s screen…` : 'Click or drop a PDF, video or image here';
    editorOnly((c) => { c.fillStyle = 'rgba(255,255,255,.5)'; c.font = '500 17px Inter, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(hint, r.x + r.w / 2, r.y + r.h / 2); });
  }
  g.restore();
  if (who && S.state.brand.names) {
    const label = `${who.name} is presenting`; // the program is shared, so never "you"
    g.font = '600 14px Inter, sans-serif';
    const tw = g.measureText(label).width;
    g.fillStyle = 'rgba(5,8,16,.72)'; rr(r.x + 12, r.y + 12, tw + 24, 28, 8); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(label, r.x + 24, r.y + 26.5);
  }
}
const AI_COLOR = { claude: '#d97757', openai: '#10a37f', gemini: '#4f8ff7', grok: '#e7e9ea' };
const AI_NAME = { claude: 'Claude', openai: 'ChatGPT', gemini: 'Gemini', grok: 'Grok' };
function plainMd(t) {
  return String(t).replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1').replace(/\*\*|__|`/g, '').replace(/^#{1,6}\s*/gm, '').replace(/^\s*[-*]\s+/gm, '• ');
}
function drawAiEl(e) {
  const r = px(e), fs = e.size || 22, pad = 22, lh = fs * 1.38;
  const items = S.ai.items, a = stageAnswer();
  const q = a ? items[items.indexOf(a) - 1] : [...items].reverse().find((i) => i.role === 'user');
  if (a && a.say && !a.text) a.text = a.say;
  g.save();
  rr(r.x, r.y, r.w, r.h, 16); g.clip();
  drawPanel(r.x, r.y, r.w, r.h, 16);
  const prov = (a || q)?.provider || S.aiProv || 'claude';
  drawOrb(r.x + pad + 10, r.y + pad + 10, 10, performance.now());
  g.fillStyle = 'rgba(255,255,255,.95)'; g.font = `800 17px ${stageFont()}`; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText(S.aiName, r.x + pad + 30, r.y + pad + 10);
  const nw = g.measureText(S.aiName).width;
  g.fillStyle = 'rgba(220,230,255,.6)'; g.font = '600 13px Inter, sans-serif';
  g.fillText(`${AI_NAME[prov]} · ${{ thinking: 'thinking…', speaking: 'speaking', listening: 'listening' }[S.aiStatus] || 'producer'}`, r.x + pad + 40 + nw, r.y + pad + 11);
  let y = r.y + pad + 40;
  const maxW = r.w - pad * 2;
  if (!q) {
    g.fillStyle = 'rgba(255,255,255,.5)'; g.font = `500 ${fs}px Inter, sans-serif`; g.textBaseline = 'alphabetic';
    g.fillText('Ready for questions.', r.x + pad, y + fs); // viewers see this: no editor instructions
    g.restore(); return;
  }
  g.font = `700 ${fs}px "Plus Jakarta Sans", Inter, sans-serif`; g.fillStyle = '#ffffff'; g.textBaseline = 'alphabetic';
  for (const l of wrapLines(q.text, maxW, 2)) { g.fillText(l, r.x + pad, y + fs); y += lh; }
  y += 10;
  g.strokeStyle = 'rgba(255,255,255,.1)'; g.beginPath(); g.moveTo(r.x + pad, y); g.lineTo(r.x + r.w - pad, y); g.stroke();
  y += 14;
  if (a) {
    g.font = `500 ${fs}px Inter, sans-serif`;
    const lines = [];
    for (const para of plainMd(a.text).split(/\n+/)) { if (!para.trim()) continue; lines.push(...wrapLines(para, maxW)); lines.push(''); }
    if (!a.done) { if (!lines.length) lines.push(''); lines[lines.length - (lines[lines.length - 1] === '' ? 2 : 1)] += Date.now() % 900 < 450 ? ' ▍' : ''; }
    const room = Math.max(1, Math.floor((r.y + r.h - pad - y) / lh));
    const shown = lines.length > room ? lines.slice(lines.length - room) : lines; // keep the newest text in view
    g.fillStyle = a.error ? '#ff9b9b' : 'rgba(235,242,255,.95)';
    for (const l of shown) { g.fillText(l, r.x + pad, y + fs); y += l ? lh : lh * .45; }
  }
  g.restore();
}
const TIP_INFO = {
  paypal: { name: 'PayPal', color: '#0070e0' }, venmo: { name: 'Venmo', color: '#008cff' }, cashapp: { name: 'Cash App', color: '#00d64f' },
  stripe: { name: 'Stripe', color: '#635bff' }, kofi: { name: 'Ko-fi', color: '#ff5e5b' }, patreon: { name: 'Patreon', color: '#f96854' },
  bmc: { name: 'Buy Me a Coffee', color: '#ffdd00' }, link: { name: 'Website', color: '#4c8dff' },
};
const qrCache = new Map();
let qrLib = null;
function qrFor(url) {
  if (qrCache.has(url)) return qrCache.get(url);
  qrCache.set(url, null);
  (qrLib ||= new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = '/vendor/qrcode.js'; sc.onload = () => res(window.qrcode); sc.onerror = rej; document.head.append(sc); }))
    .then((qrcode) => { const q = qrcode(0, 'M'); q.addData(url); q.make(); qrCache.set(url, q); }).catch(() => { qrLib = null; });
  return null;
}
function drawTipEl(e) {
  const r = px(e), info = TIP_INFO[e.provider] || TIP_INFO.link, pad = 16;
  g.save();
  g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 24; g.shadowOffsetY = 8;
  g.fillStyle = '#ffffff'; rr(r.x, r.y, r.w, r.h, 16); g.fill();
  g.shadowColor = 'transparent';
  const qs = r.h - pad * 2;
  drawQr(tipUrl(e.provider, e.url) || e.url, r.x + pad, r.y + pad, qs);
  const tx = r.x + pad * 2 + qs, tw = r.w - (tx - r.x) - pad;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillStyle = info.color; rr(tx, r.y + pad, Math.min(tw, 14 + g.measureText(info.name).width + 30), 24, 6); g.fill();
  g.fillStyle = e.provider === 'bmc' ? '#111' : '#fff'; g.font = '700 13px Inter, sans-serif'; g.fillText(info.name, tx + 10, r.y + pad + 16.5);
  g.fillStyle = '#0b1020'; g.font = '800 22px "Plus Jakarta Sans", Inter, sans-serif';
  wrapLines(e.label || 'Support the show', tw, 2).forEach((l, i) => g.fillText(l, tx, r.y + pad + 58 + i * 26));
  g.fillStyle = '#4b5563'; g.font = '500 14px Inter, sans-serif';
  const handle = (e.url || '').replace(/^https?:\/\/(www\.)?/, '');
  g.fillText(wrapLines(handle, tw, 1)[0] || '', tx, r.y + r.h - pad - 4);
  g.restore();
}
const featAnim = { key: '', t0: 0 };
function drawFeatured(t, r) {
  const f = S.state.featured;
  if (!f) return;
  if (featAnim.key !== f.id) { featAnim.key = f.id; featAnim.t0 = t; }
  const an = entrance(featAnim.t0, t, f.text.length), e = an.alpha;
  const brand = S.state.brand, cw = 560, pad = 22, k = r.w / cw;
  g.save();
  g.font = '500 24px Inter, sans-serif';
  const lines = wrapLines(f.text, cw - pad * 2 - 64, Math.max(1, Math.min(3, Math.floor((r.h / k - 74) / 32))));
  const ch = Math.min(r.h / k, 64 + lines.length * 32 + 10);
  g.translate(r.x, r.y + r.h - ch * k); g.scale(k, k);
  const x = an.dx * (r.x + r.w / 2 > W / 2 ? -1 : 1), y = 0;
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
  g.fillText(f.src === 'studio' ? 'in the studio' : f.src === 'watch' ? (f.paid ? 'super chat' : 'on the watch page') : 'on ' + (SRC_NAME[f.src] || f.src), x + pad + 54, y + pad + 33);
  if (f.paid) { // super chat amount, top right of the card
    g.font = '800 20px Inter, sans-serif'; const aw = g.measureText(f.paid).width + 24;
    g.fillStyle = '#16a34a'; rr(x + cw - pad - aw, y + pad + 2, aw, 32, 16); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(f.paid, x + cw - pad - aw / 2, y + pad + 19); g.textAlign = 'left';
  }
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
  const els = stageElements();
  const spot = freeSpot(e, els);
  if (spot) Object.assign(e, spot);
  else { e.stack = true; toast(`No free space for the ${ELABEL[type].toLowerCase()}, so it’s stacked on top. Drag it where you want it.`, { ms: 4200 }); }
  e.home = [e.x, e.y, e.w, e.h];
  const patch = { elements: [...els, e] };
  if (type === 'slot' && S.state.layout !== 'custom') patch.layout = 'custom';
  setStage(patch);
  editor.sel = e.id;
  setEditing(true);
  return e;
}
/** First position on the 8px grid (scanning in 32px steps, inside action-safe) where a rect overlaps nothing. */
function freeSpot(e, els) {
  if (!blockerFor(e, e, els)) return null;
  const step = 32;
  for (let y = Math.round(SAFE.action * H / GRID) * GRID; y + e.h * H <= H * (1 - SAFE.action); y += step) {
    for (let x = Math.round(SAFE.action * W / GRID) * GRID; x + e.w * W <= W * (1 - SAFE.action); x += step) {
      const r = { x: x / W, y: y / H, w: e.w, h: e.h };
      if (!blockerFor(r, e, els)) return { x: r.x, y: r.y };
    }
  }
  return false;
}
function setEditing(on) {
  editor.on = on && isHost();
  $('#editLayer').hidden = !editor.on;
  $('#editToggle').setAttribute('aria-pressed', String(editor.on));
  $('#editToggle').textContent = editor.on ? 'Done editing' : 'Edit on stage';
  renderEditor();
}
const ELABEL = { slot: 'Camera', chat: 'Chat box', text: 'Text', image: 'Image', timer: 'Timer', media: 'Presentation', ai: 'AI window', tip: 'Support card', callin: 'Watch link card', shape: 'Colour block', banner: 'Lower third', ticker: 'Ticker', logo: 'Logo', ads: 'Sponsor ads', featured: 'Featured chat', captions: 'Captions' };
function elName(e) {
  if (e.type === 'slot') return `Camera ${e.index + 1}`;
  if (e.type === 'text') return e.text ? `“${e.text.slice(0, 22)}”` : 'Text';
  if (e.type === 'timer') return e.mode === 'countdown' ? 'Countdown' : 'Clock';
  if (e.type === 'tip') return `${(TIP_INFO[e.provider] || TIP_INFO.link).name} card`;
  if (e.type === 'shape' && e.label) return e.label;
  if (e.type === 'slot' && e.pip) return `Camera ${e.index + 1} (PiP)`;
  return ELABEL[e.type];
}
/** Whether a layer currently paints something on the program. */
function inUse(e) {
  switch (e.type) {
    case 'banner': return !!S.state.banner;
    case 'ticker': return !!S.state.ticker;
    case 'logo': return !!S.state.brand?.logo;
    case 'ads': return !!(S.state.ads?.on && S.state.ads.items?.length);
    case 'featured': return !!S.state.featured;
    case 'captions': return !!S.state.captions?.on;
    default: return true;
  }
}
function editableEls() {
  const custom = S.state.layout === 'custom';
  return (S.state.elements || []).filter((e) => custom || !['slot', 'media'].includes(e.type));
}
function renderEditor() {
  const els = S.state.elements || [];
  if (editor.sel && !els.some((e) => e.id === editor.sel)) editor.sel = null;
  if (editor.on && isHost() && els.length && ensureSystem(els, isVertical(), uid).length !== els.length) { setStage({ elements: els }); return; }
  // Boxes on the stage, painted in the same order as the program
  const layer = $('#editLayer');
  if (editor.on) {
    // Only what's on the picture: empty reserved spots (no banner, captions off, no sponsor…) stay out of the way
    // unless you pick them in the Layers list. Hidden layers show only when selected.
    const boxes = drawOrder(editableEls().filter((e) => e.id === editor.sel || (inUse(e) && !e.hidden))).map((e) => {
      const d = document.createElement('div');
      d.className = 'ebox' + (e.id === editor.sel ? ' sel' : '') + (e.locked ? ' locked' : '') + (e.hidden ? ' ghost' : '') + (e.stack ? ' stacked' : '');
      d.dataset.id = e.id; d.dataset.tier = tierOf(e);
      Object.assign(d.style, { left: e.x * 100 + '%', top: e.y * 100 + '%', width: e.w * 100 + '%', height: e.h * 100 + '%' });
      const lab = document.createElement('span'); lab.className = 'pill on-media elab';
      lab.innerHTML = (e.locked ? icon('lock', { size: 'sm' }) : '') + (e.hidden ? icon('eye-off', { size: 'sm' }) : '');
      lab.append(document.createTextNode(elName(e)));
      d.append(lab);
      if (!e.locked && !e.hidden) for (const h of ['nw', 'ne', 'sw', 'se']) { const k = document.createElement('i'); k.className = 'ehandle h-' + h; k.dataset.h = h; d.append(k); }
      return d;
    });
    const safe = document.createElement('div'); safe.className = 'safe-guides'; safe.setAttribute('aria-hidden', 'true');
    safe.innerHTML = `<i class="safe action" style="inset:${SAFE.action * 100}%"></i><i class="safe title" style="inset:${SAFE.title * 100}%"></i>`;
    const guides = document.createElement('div'); guides.className = 'snap-guides'; guides.id = 'snapGuides';
    layer.replaceChildren(safe, ...boxes, guides);
    layer.style.setProperty('--grid-x', (GRID / W * 100) + '%'); layer.style.setProperty('--grid-y', (GRID / H * 100) + '%');
  }
  renderLayers();
  renderProps();
}
// Layers: top of the list is on top of the picture, grouped by tier. Eye hides, lock freezes, reset sends home.
function renderLayers() {
  const list = $('#elList');
  if (!list) return;
  const els = editableEls(), host = isHost();
  const rows = [];
  for (const tier of [...TIERS].reverse()) {
    const inTier = els.filter((e) => tierOf(e) === tier.id).reverse();
    if (!inTier.length) continue;
    const head = document.createElement('li'); head.className = 'layer-head caps'; head.textContent = tier.label;
    rows.push(head);
    for (const e of inTier) {
      const li = document.createElement('li');
      li.className = 'el-row' + (e.id === editor.sel ? ' sel' : '') + (e.hidden || !inUse(e) ? ' dim' : '');
      li.dataset.id = e.id;
      const eye = toggleBtn(e.hidden ? 'eye-off' : 'eye', e.hidden ? `Show ${elName(e)}` : `Hide ${elName(e)}`, !e.hidden, () => patchEl(e.id, { hidden: !e.hidden }, e.hidden ? 'show' : 'hide'));
      const b = document.createElement('button'); b.type = 'button'; b.className = 'menu-item compact el-pick'; b.textContent = elName(e);
      b.onclick = () => { editor.sel = e.id; setEditing(true); };
      const lock = toggleBtn(e.locked ? 'lock' : 'lock-open', e.locked ? `Unlock ${elName(e)}` : `Lock ${elName(e)}`, !!e.locked, () => patchEl(e.id, { locked: !e.locked }));
      const reset = mkBtn('rotate-ccw', `Reset ${elName(e)}`, () => resetEl(e.id));
      reset.disabled = !host || !e.home;
      const tags = [];
      // system layers (banner, ticker, captions…) are meant to sit over the picture, so they carry no tag
      if (e.stack && tierOf(e) !== 'system' && !['banner', 'ticker', 'logo', 'ads', 'featured', 'captions'].includes(e.type)) { const t = document.createElement('span'); t.className = 'pill caps'; t.textContent = 'Overlaps'; t.dataset.tip = 'Allowed to overlap other layers'; tags.push(t); }
      else if (!inUse(e)) { const t = document.createElement('span'); t.className = 'el-idle'; t.textContent = 'not in use'; tags.push(t); }
      li.append(eye, b, ...tags, lock, reset);
      rows.push(li);
    }
  }
  list.replaceChildren(...rows);
  $('#elEmpty').hidden = !!els.length;
}
function toggleBtn(name, label, pressed, fn) {
  const b = mkBtn(name, label, fn);
  b.setAttribute('aria-pressed', String(pressed));
  b.classList.add('layer-toggle');
  return b;
}
function patchEl(id, patch, verb) {
  const els = elementsCopy(), e = els.find((x) => x.id === id);
  if (!e) return;
  // Showing a layer must not create an overlap: if its spot is taken, it comes back stacked and says so.
  if (verb === 'show' && !e.stack) {
    const blocker = blockerFor({ ...e }, e, els.filter((o) => o.id !== id));
    if (blocker) { patch = { ...patch, stack: true }; toast(`${elName(e)} overlaps ${elName(blocker)}, so it’s shown stacked. Move it, or turn off “Allow overlap” in its settings.`, { ms: 5000 }); }
  }
  Object.assign(e, patch);
  setStage({ elements: els });
}
function resetEl(id) {
  const els = elementsCopy(), e = els.find((x) => x.id === id);
  if (!e?.home) return;
  const [x, y, w, h] = e.home;
  Object.assign(e, { x, y, w, h, hidden: false, locked: false });
  const blocker = !e.stack && blockerFor(e, e, els);
  if (blocker) { e.stack = true; toast(`${elName(e)} is back home, stacked over ${elName(blocker)}.`); }
  setStage({ elements: els });
}
function mkBtn(name, title, fn) { const b = document.createElement('button'); b.type = 'button'; b.className = 'icon-btn sm'; b.innerHTML = icon(name, { size: 'sm' }); b.setAttribute('aria-label', title); b.onclick = fn; b.disabled = !isHost(); return b; }
function moveEl(id, dir) {
  const els = elementsCopy(), i = els.findIndex((e) => e.id === id);
  if (i < 0) return;
  const tier = tierOf(els[i]);
  let j = i + dir;
  while (j >= 0 && j < els.length && tierOf(els[j]) !== tier) j += dir;
  if (j < 0 || j >= els.length) return toast(dir > 0 ? 'Already the top of its layer.' : 'Already the bottom of its layer.');
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
    f.push(`<label class="toggle-inline"><input type="checkbox" class="toggle sm" data-k="bold" ${e.bold ? 'checked' : ''}><span>Bold</span></label>`);
    f.push(`<label class="toggle-inline"><input type="checkbox" class="toggle sm" data-bg ${e.bg ? 'checked' : ''}><span>Background box</span></label>`);
    if (e.bg) field('Box colour', `<input type="color" data-k="bg" value="${e.bg}">`);
  }
  if (e.type === 'chat') {
    field('Messages shown', `<input type="range" min="2" max="15" data-k="max" data-num value="${e.max}">`);
    field('Text size', `<input type="range" min="12" max="36" data-k="size" data-num value="${e.size}">`);
    f.push(`<label class="toggle-inline"><input type="checkbox" class="toggle sm" data-k="bg" ${e.bg ? 'checked' : ''}><span>Dark backing</span></label>`);
    f.push(`<label class="toggle-inline"><input type="checkbox" class="toggle sm" data-k="fade" ${e.fade ? 'checked' : ''}><span>Fade out old messages</span></label>`);
    f.push(`<p class="hint">Shows studio chat${S.state.feeds?.twitch ? ` and Twitch #${S.state.feeds.twitch}` : '. Connect Twitch in the Chat panel to show viewer chat'}.</p>`);
  }
  if (e.type === 'image') {
    f.push(`<label class="btn sm"><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-upload hidden>${e.asset ? 'Replace image' : 'Choose image'}</label>`);
    field('Fit', `<select data-k="fit"><option value="contain" ${e.fit === 'contain' ? 'selected' : ''}>Fit inside</option><option value="cover" ${e.fit === 'cover' ? 'selected' : ''}>Fill box</option></select>`);
    field('Opacity', `<input type="range" min="0.1" max="1" step="0.05" data-k="opacity" data-num value="${e.opacity}">`);
    field('Corner rounding', `<input type="range" min="0" max="120" data-k="radius" data-num value="${e.radius}">`);
  }
  if (e.type === 'timer') {
    field('Shows', `<select data-k="mode"><option value="clock" ${e.mode === 'clock' ? 'selected' : ''}>Current time</option><option value="countdown" ${e.mode === 'countdown' ? 'selected' : ''}>Countdown</option></select>`);
    if (e.mode === 'countdown') f.push(`<div class="row">${[1, 3, 5, 10, 15].map((m) => `<button type="button" class="btn sm" data-count="${m}">${m} min</button>`).join('')}</div>`);
    field('Size', `<input type="range" min="16" max="140" data-k="size" data-num value="${e.size}">`);
    f.push(`<div class="row2"><label class="fld"><span>Colour</span><input type="color" data-k="color" value="${e.color}"></label></div>`);
    f.push(`<label class="toggle-inline"><input type="checkbox" class="toggle sm" data-bg ${e.bg ? 'checked' : ''}><span>Background box</span></label>`);
    if (e.bg) field('Box colour', `<input type="color" data-k="bg" value="${e.bg}">`);
  }
  if (e.type === 'ai') f.push(`<label class="fld"><span>Text size</span><input type="range" min="14" max="34" data-k="size" data-num value="${e.size}"></label><p class="hint">Shows the latest question and answer from the AI panel. Long answers keep the newest lines in view.</p>`);
  if (e.type === 'media') f.push(`<label class="fld"><span>Corner rounding</span><input type="range" min="0" max="40" data-k="radius" data-num value="${e.radius}"></label><p class="hint">Shows whoever is presenting: a screen, a video or PDF slides.</p>`);
  if (e.type === 'tip') f.push(`<label class="fld"><span>Card text</span><input data-k="label" maxlength="60" value="${val('label')}"></label><p class="hint">Edit the link in Brand → Support links.</p>`);
  if (e.type === 'shape') {
    field('Name', `<input data-k="label" maxlength="40" value="${val('label')}" placeholder="Colour block">`);
    f.push(`<div class="row2"><label class="fld"><span>Colour</span><input type="color" data-k="color" value="${e.color}"></label><label class="fld"><span>Opacity</span><input type="range" min="0.05" max="1" step="0.05" data-k="opacity" data-num value="${e.opacity ?? 1}"></label></div>`);
    field('Corner rounding', `<input type="range" min="0" max="120" data-k="radius" data-num value="${e.radius || 0}">`);
  }
  if (isSystem(e)) f.push(`<p class="hint">${{ banner: 'Shows the banner from the Banners panel.', ticker: 'Shows the ticker text from the Banners panel.', logo: 'Shows your logo from Brand.', ads: 'Rotates your sponsor images from Brand.', featured: 'Shows a chat message you put on stage.', captions: 'Shows live captions when they’re on (Stream tab).' }[e.type]}</p>`);
  const pxs = (v, n) => Math.round(v * n);
  f.push(`<p class="hint num">${pxs(e.w, W)} × ${pxs(e.h, H)} px at ${pxs(e.x, W)}, ${pxs(e.y, H)} · ${TIERS.find((t) => t.id === tierOf(e)).label} layer</p>`);
  f.push(`<label class="toggle-inline"><input type="checkbox" class="toggle sm" data-k="stack" ${e.stack ? 'checked' : ''}><span>Allow overlap <em class="dim">— stack it over other layers on purpose</em></span></label>`);
  if (e.type === 'slot') f.push(`<label class="toggle-inline"><input type="checkbox" class="toggle sm" data-k="pip" ${e.pip ? 'checked' : ''}><span>Picture-in-picture <em class="dim">— draw above the presentation</em></span></label>`);
  f.push(`<label class="toggle-inline"><input type="checkbox" class="toggle sm" data-k="hidden" ${e.hidden ? 'checked' : ''}><span>Hidden</span></label>`);
  f.push(`<label class="toggle-inline"><input type="checkbox" class="toggle sm" data-k="locked" ${e.locked ? 'checked' : ''}><span>Locked</span></label>`);
  f.push(`<div class="row"><button type="button" class="btn sm" data-order="1">${icon('arrow-up', { size: 'sm' })}Bring forward</button><button type="button" class="btn sm" data-order="-1">${icon('arrow-down', { size: 'sm' })}Send back</button><button type="button" class="btn sm" data-reset ${e.home ? '' : 'disabled'}>${icon('rotate-ccw', { size: 'sm' })}Reset</button></div>`);
  if (!isSystem(e)) f.push(`<button type="button" class="btn sm danger" data-del>${icon('trash-2', { size: 'sm' })}Delete ${ELABEL[e.type].toLowerCase()}</button>`);
  box.innerHTML = f.join('');
  box.querySelectorAll('input, select, textarea').forEach((inp) => { inp.disabled = !isHost() && !inp.dataset.upload; });
}
$('#elProps').addEventListener('input', (ev) => {
  const e = selEl(), t = ev.target;
  if (!e || !isHost()) return;
  if (t.dataset.k) {
    const k = t.dataset.k, v = t.type === 'checkbox' ? t.checked : t.dataset.num !== undefined ? Number(t.value) : t.value;
    if (['hidden', 'locked', 'stack', 'pip'].includes(k)) {
      // Turning stacking off (or showing a layer) must not leave an overlap behind.
      if ((k === 'stack' && !v) || (k === 'hidden' && !v)) {
        const blocker = blockerFor(e, { ...e, stack: k === 'stack' ? false : e.stack, hidden: false }, (S.state.elements || []).filter((o) => o.id !== e.id));
        if (blocker) { t.checked = !v; return toast(`${elName(e)} overlaps ${elName(blocker)}. Move one of them first.`, { err: true }); }
      }
      return patchEl(e.id, { [k]: v });
    }
    e[k] = v;
    if (k === 'mode') { renderProps(); }
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
  const btn = ev.target.closest('button');
  if (!btn) return;
  if (btn.dataset.del !== undefined) deleteEl(e.id);
  if (btn.dataset.order) moveEl(e.id, Number(btn.dataset.order));
  if (btn.dataset.reset !== undefined) resetEl(e.id);
  if (btn.dataset.count) { e.target = Date.now() + Number(btn.dataset.count) * 60_000; commitElements(); toast(`Countdown set to ${btn.dataset.count} min.`); }
});

// Drag and resize on the stage: snaps to the 8px grid, safe areas and other layers' edges; refuses to overlap
// another layer unless it's stacked. Hold Alt (Option) while dragging to stack on purpose.
function showGuides(guides, blocked) {
  const box = $('#snapGuides');
  if (!box) return;
  box.replaceChildren(...guides.map((gd) => { const i = document.createElement('i'); i.className = `guide ${gd.axis} ${gd.kind}`; i.style[gd.axis === 'x' ? 'left' : 'top'] = gd.at * 100 + '%'; return i; }));
  $$('.ebox.blocking').forEach((b) => b.classList.remove('blocking'));
  if (blocked) $(`.ebox[data-id="${blocked.id}"]`)?.classList.add('blocking');
}
$('#editLayer').addEventListener('pointerdown', (ev) => {
  const box = ev.target.closest('.ebox');
  if (!box || !isHost()) { editor.sel = null; renderEditor(); return; }
  const e = (S.state.elements || []).find((x) => x.id === box.dataset.id);
  if (!e) return;
  editor.sel = e.id;
  if (e.locked || e.hidden) { renderEditor(); toast(`${elName(e)} is ${e.locked ? 'locked' : 'hidden'}. Change that in Layers.`); return; }
  const rect = $('#stage').getBoundingClientRect();
  box.classList.add('dragging');
  $('#editLayer').classList.add('dragging');
  editor.drag = { e, handle: ev.target.dataset.h || '', sx: ev.clientX, sy: ev.clientY, o: { x: e.x, y: e.y, w: e.w, h: e.h }, last: { x: e.x, y: e.y, w: e.w, h: e.h }, rw: rect.width, rh: rect.height, blocked: null, moved: false };
  box.setPointerCapture(ev.pointerId);
  renderProps(); renderLayers();
  $$('.ebox.sel').forEach((b) => b.classList.toggle('sel', b === box)); box.classList.add('sel');
  ev.preventDefault();
});
const clampRect = (r) => ({ ...r, x: Math.min(1 - r.w, Math.max(0, r.x)), y: Math.min(1 - r.h, Math.max(0, r.y)) });
$('#editLayer').addEventListener('pointermove', (ev) => {
  const d = editor.drag; if (!d) return;
  const dx = (ev.clientX - d.sx) / d.rw, dy = (ev.clientY - d.sy) / d.rh, o = d.o;
  const others = (S.state.elements || []).filter((x) => x !== d.e);
  let snapped;
  if (!d.handle) snapped = snapMove(clampRect({ ...o, x: o.x + dx, y: o.y + dy }), d.e, others, W, H);
  else {
    const c = { ...o };
    if (d.handle.includes('e')) c.w = o.w + dx;
    if (d.handle.includes('s')) c.h = o.h + dy;
    if (d.handle.includes('w')) { c.x = o.x + dx; c.w = o.w - dx; }
    if (d.handle.includes('n')) { c.y = o.y + dy; c.h = o.h - dy; }
    snapped = snapResize(c, d.handle, d.e, others, W, H);
    snapped.rect = { ...snapped.rect, x: Math.max(0, snapped.rect.x), y: Math.max(0, snapped.rect.y) };
    snapped.rect.w = Math.min(snapped.rect.w, 1 - snapped.rect.x); snapped.rect.h = Math.min(snapped.rect.h, 1 - snapped.rect.y);
  }
  let rect = snapped.rect, blocked = null;
  d.alt = ev.altKey;
  if (!ev.altKey && !d.e.stack) ({ rect, blocked } = resolve(d.last, rect, d.e, others));
  d.last = rect; d.blocked = blocked; d.moved = true;
  Object.assign(d.e, rect);
  const box = $(`.ebox[data-id="${d.e.id}"]`);
  if (box) {
    Object.assign(box.style, { left: rect.x * 100 + '%', top: rect.y * 100 + '%', width: rect.w * 100 + '%', height: rect.h * 100 + '%' });
    box.classList.toggle('blocked', !!blocked);
  }
  showGuides(snapped.guides, blocked);
});
// Released boxes settle back with a spring (transition on .ebox, see style.css).
function endDrag() {
  const d = editor.drag;
  $$('.ebox.dragging, .ebox.blocked').forEach((b) => b.classList.remove('dragging', 'blocked'));
  $('#editLayer').classList.remove('dragging');
  showGuides([], null);
  editor.drag = null;
  if (!d?.moved) return;
  if (d.blocked) toast(`Kept clear of ${elName(d.blocked)}. Hold Alt while dragging to stack on top of it.`);
  if (d.alt && !d.e.stack) {
    const over = blockerFor(d.e, { ...d.e, stack: false }, (S.state.elements || []).filter((x) => x !== d.e));
    if (over) { d.e.stack = true; toast(`${elName(d.e)} is now stacked over ${elName(over)}.`); }
  }
  commitElements();
  renderLayers(); renderProps();
}
$('#editLayer').addEventListener('pointerup', endDrag);
$('#editLayer').addEventListener('pointercancel', endDrag);
// Keyboard: arrows nudge the selected layer 8px (Shift: 40px), with the same snapping rules; Esc deselects.
document.addEventListener('keydown', (ev) => {
  if (!editor.on || !editor.sel || !isHost() || ev.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const e = (S.state.elements || []).find((x) => x.id === editor.sel);
  if (!e) return;
  if (ev.key === 'Escape') { editor.sel = null; renderEditor(); return; }
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
  if (!dir || e.locked || e.hidden) return;
  ev.preventDefault();
  const step = GRID * (ev.shiftKey ? 5 : 1);
  const cand = clampRect({ ...e, x: e.x + dir[0] * step / W, y: e.y + dir[1] * step / H });
  const others = (S.state.elements || []).filter((x) => x !== e);
  const { rect, blocked } = e.stack ? { rect: cand, blocked: null } : resolve(e, cand, e, others);
  if (blocked && rect.x === e.x && rect.y === e.y) return toast(`${elName(e)} would overlap ${elName(blocked)}.`);
  Object.assign(e, { x: rect.x, y: rect.y });
  renderEditor(); commitElements(250);
});

// Panel wiring
$('#editToggle').onclick = () => setEditing(!editor.on);
$('#resetScene').onclick = () => { if (isHost()) resetScene(); };
$$('[data-add]').forEach((b) => b.addEventListener('click', () => { if (!isHost()) return toast('Only the host can change the stage.', { err: true }); addElement(b.dataset.add); }));
function renderTemplates() {
  const wrap = $('#tplList');
  wrap.replaceChildren(...TEMPLATES.map((tpl) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tile tpl'; b.disabled = !isHost();
    const pv = scenePreview(tpl);
    const nm = document.createElement('span'); nm.textContent = tpl.name;
    if (tpl.desc) b.dataset.tip = tpl.desc;
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
    const b = document.createElement('button'); b.type = 'button'; b.className = 'menu-item compact el-pick'; b.textContent = l.name; b.disabled = !isHost();
    b.onclick = () => loadLayout(l);
    li.append(b, mkBtn('trash-2', 'Delete saved scene', () => { const all = savedLayouts(); all.splice(i, 1); store.set('layouts', all); renderSaved(); }));
    return li;
  }));
  $('#savedEmpty').hidden = !!list.length;
}
$('#saveLayout').onclick = () => {
  const name = $('#layoutName').value.trim() || `Layout ${savedLayouts().length + 1}`;
  const els = elementsCopy().map((e) => (e.type === 'image' && S.assets.get(e.asset)?.data ? { ...e, _data: S.assets.get(e.asset).data } : e));
  const all = savedLayouts().filter((l) => l.name !== name);
  all.unshift({ name, layout: S.state.layout, elements: els, media: $('#sceneMedia').value || '' });
  try { store.set('layouts', all.slice(0, 20)); localStorage.getItem('gather:layouts') || 0; } catch {}
  if (!savedLayouts().some((l) => l.name === name)) return toast('Could not save. The images may be too large for this browser.', { err: true });
  $('#layoutName').value = '';
  renderSaved(); renderScenes(); toast(`Saved scene “${name}”. It's in the scene strip.`);
};
async function loadLayout(l) {
  const els = [];
  for (const e of l.elements) {
    if (e.type === 'image' && e._data) { const { _data, ...rest } = e; els.push({ ...rest, asset: await storeAsset(_data).catch(() => '') }); }
    else els.push(e);
  }
  setStage({ layout: l.layout || 'custom', elements: els, scene: 'saved:' + l.name });
  const it = l.media && S.library.find((x) => x.id === l.media);
  if (it) { if (S.local.pres) stopPresentation(); await presentLibrary(it); }
  toast(`Scene “${l.name}”.`);
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
// One switch shows or hides the chat overlay; it carries every connected platform's chat.
$('#overlaySwitch').addEventListener('change', (ev) => {
  if (!isHost()) { ev.target.checked = !ev.target.checked; return toast('Only the host can change the stage.', { err: true }); }
  const existing = (S.state.elements || []).find((e) => e.type === 'chat');
  if (!ev.target.checked && existing) setStage({ elements: elementsCopy().filter((e) => e.type !== 'chat') });
  if (ev.target.checked && !existing) { addElement('chat'); setEditing(false); toast('Chat overlay on. Move it in Layouts → Edit on stage.'); }
});
$('#rumbleForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (!isHost()) return toast('Only the host can connect platform chat.', { err: true });
  if (store.get('rumbleUrl', '')) { store.set('rumbleUrl', ''); $('#rumbleInput').value = ''; syncRumble(); renderFeedUI(); return toast('Rumble chat disconnected.'); }
  const v = $('#rumbleInput').value.trim();
  if (!/^https:\/\/(www\.)?rumble\.com\/-livestream-api\//.test(v)) return toast('Paste the Live Stream API URL from Rumble → Account → Live Stream API.', { err: true });
  store.set('rumbleUrl', v);
  syncRumble(); renderFeedUI();
  toast(S.studio ? 'Rumble connected.' : 'Saved. Rumble chat connects when you enter a studio.');
});
$('#featHide').onclick = () => setStage({ featured: null });
function renderFeedUI() {
  const host = isHost();
  $('#twitchInput').disabled = !host;
  $('#twitchGo').disabled = !host;
  $('#twitchGo').textContent = S.state.feeds?.twitch ? 'Disconnect' : 'Connect';
  if (document.activeElement !== $('#twitchInput')) $('#twitchInput').value = S.state.feeds?.twitch || '';
  const rumbleSaved = !!store.get('rumbleUrl', '');
  $('#rumbleInput').disabled = !host || rumbleSaved;
  $('#rumbleGo').disabled = !host;
  $('#rumbleGo').textContent = rumbleSaved ? 'Disconnect' : 'Connect';
  if (rumbleSaved && document.activeElement !== $('#rumbleInput')) $('#rumbleInput').value = '••••••••••••';
  const hasChat = (S.state.elements || []).some((e) => e.type === 'chat');
  $('#overlaySwitch').checked = hasChat;
  $('#overlaySwitch').disabled = !host;
  const n = 1 + (S.state.feeds?.twitch ? 1 : 0) + (rumbleSaved && host ? 1 : 0);
  $('#overlayHint').textContent = `${n} chat source${n === 1 ? '' : 's'}: studio${S.state.feeds?.twitch ? ', Twitch' : ''}${rumbleSaved && host ? ', Rumble' : ''}`;
  $('#featBar').hidden = !S.state.featured;
  if (S.state.featured) $('#featText').textContent = `${S.state.featured.name}: ${S.state.featured.text}`;
  $('#featHide').disabled = !host;
  $('#msgs').classList.toggle('is-host', host);
  $$('#msgs .feat').forEach((b) => { b.textContent = S.state.featured?.id === b.closest('li')?.dataset.fid ? 'On stage' : 'Show on stage'; });
  applyModerationAll();
  setTwitchStatus(twitch.status);
  syncRumble();
  if (rumble.status === 'off' && rumbleSaved) setRumbleStatus('saved');
}
function renderLayoutsPanel() {
  renderTemplates(); renderSaved(); renderEditor();
  $$('[data-add]').forEach((b) => (b.disabled = !isHost()));
  $('#editToggle').disabled = !isHost();
  $('#saveLayout').disabled = !isHost();
  $('#layoutsHint').textContent = isHost() ? 'Drag and resize on the stage. Changes show for everyone and in recordings.' : 'Only the host can change layouts. You see them on your stage.';
  if (!isHost() && editor.on) setEditing(false);
}

// ---------------------------------------------------------------- AI: one assistant that answers and runs the studio
// The host's own Claude, ChatGPT, Gemini or Grok key. Answers stream into the AI panel; any answer can be put on
// stage (the AI window shows the pinned answer, or the latest one). Guests receive the conversation read-only.
S.ai = { items: [], busy: false };
S.aiProv = store.get('aiProv', 'claude');
const AI_DEFAULT_MODEL = { claude: 'claude-opus-5-5', openai: 'gpt-5.5', gemini: 'gemini-2.5-flash', grok: 'grok-4.7' };
const aiSync = new Map(); // id -> timer, so streaming answers reach guests a few times a second, not per token
function upsertAI(item, local = true) {
  if (!item?.id) return;
  if (item.id === 'clear') { S.ai.items = []; renderAILog(); return; }
  const i = S.ai.items.findIndex((x) => x.id === item.id);
  if (i >= 0) S.ai.items[i] = { ...S.ai.items[i], ...item }; else S.ai.items.push({ ...item });
  if (S.ai.items.length > 40) S.ai.items.splice(0, S.ai.items.length - 40);
  renderAILog();
  if (!local || !S.studio || !isHost()) return;
  const send = () => { aiSync.delete(item.id); const cur = S.ai.items.find((x) => x.id === item.id); if (cur) wsSend({ type: 'ai', item: cur }); };
  if (item.done) { clearTimeout(aiSync.get(item.id)); send(); }
  else if (!aiSync.has(item.id)) aiSync.set(item.id, setTimeout(send, 450));
}
const aiOnStage = () => (S.state.elements || []).some((e) => e.type === 'ai' && !e.hidden);
/** The answer the AI window shows: the pinned one, else the newest. */
function stageAnswer() {
  const answers = S.ai.items.filter((i) => i.role === 'assistant');
  return answers.find((i) => i.pinned) || answers[answers.length - 1] || null;
}
function actLabel(a) {
  return { open: `Found “${a.label || a.url}”`, scene: `Switched to ${a.name}`, present: `Presenting ${a.name}`, stop: 'Stopped presenting', banner: `Banner: ${a.text}`, hide_banner: 'Banner hidden', countdown: `${a.minutes}-minute countdown` }[a.type] || a.type;
}
function actChip(a, withOpen = true) {
  const li = document.createElement('li'); li.className = 'act-chip';
  li.textContent = actLabel(a);
  if (a.type === 'open' && withOpen && isHost()) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn link'; b.textContent = 'Open';
    b.onclick = () => offerOpen(a.url, a.label);
    li.append(b);
  }
  return li;
}
function renderAILog() {
  const log = $('#aiLog');
  if (!log) return;
  const host = isHost(), shown = aiOnStage() ? stageAnswer() : null;
  log.replaceChildren(...S.ai.items.map((it) => {
    const li = document.createElement('li'); li.className = 'ai-msg ' + it.role + (it.error ? ' error' : '');
    li.dataset.id = it.id;
    if (it.role === 'user') { const t = document.createElement('div'); t.className = 'bubble'; t.textContent = it.text; li.append(t); return li; }
    const who = document.createElement('div'); who.className = 'who';
    const nm = document.createElement('b'); nm.textContent = S.aiName;
    const via = document.createElement('span'); via.textContent = AI_NAME[it.provider] || '';
    who.append(nm, via);
    const txt = document.createElement('div'); txt.className = 'txt'; txt.textContent = plainMd(it.text || '') || (it.done ? '' : ' ');
    if (!it.done) txt.classList.add('streaming');
    li.append(who, txt);
    if (it.actions?.length) { const ul = document.createElement('ul'); ul.className = 'act-chips'; ul.append(...it.actions.map(actChip)); li.append(ul); }
    if (host && it.done && !it.error && it.text) {
      const row = document.createElement('div'); row.className = 'msg-tools';
      const on = shown?.id === it.id;
      const st = document.createElement('button'); st.type = 'button'; st.className = 'btn sm' + (on ? ' on' : ''); st.dataset.stage = it.id;
      st.textContent = on ? 'On stage' : 'Show on stage'; st.setAttribute('aria-pressed', on);
      st.onclick = () => (on ? takeAnswerOff() : showAnswer(it.id));
      const cp = document.createElement('button'); cp.type = 'button'; cp.className = 'btn sm ghost'; cp.textContent = 'Copy';
      cp.onclick = () => navigator.clipboard?.writeText(plainMd(it.text)).then(() => toast('Copied.'), () => toast('Couldn’t copy.', { err: true }));
      row.append(st, cp); li.append(row);
    }
    return li;
  }));
  $('#aiEmpty').hidden = !!S.ai.items.length;
  const body = log.closest('.panel-body'); if (body) body.scrollTop = body.scrollHeight;
}
/** Put one answer in the AI window, adding the window to the stage (without changing the scene) if needed. */
function showAnswer(id) {
  if (!isHost()) return;
  for (const it of S.ai.items) if (it.role === 'assistant' && !!it.pinned !== (it.id === id)) upsertAI({ id: it.id, pinned: it.id === id });
  const els = stageElements(), cur = els.find((e) => e.type === 'ai');
  if (cur) { if (cur.hidden) patchEl(cur.id, { hidden: false }, 'show'); else renderAILog(); return; }
  const e = withDefaults({ type: 'ai' });
  const spot = freeSpot(e, els);
  if (spot) Object.assign(e, spot); else if (spot === false) e.stack = true;
  e.home = [e.x, e.y, e.w, e.h];
  setStage({ elements: [...els, e] });
  toast(spot === false ? 'The answer is on stage, stacked: there was no free spot. Move it in Layouts.' : 'The answer is on stage.');
}
function takeAnswerOff() {
  if (!isHost()) return;
  setStage({ elements: elementsCopy().filter((x) => x.type !== 'ai') });
}
function renderAIPanel() {
  const host = isHost();
  $$('#aiProv button').forEach((b) => { const on = b.dataset.prov === S.aiProv; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  const key = store.get('aiKey:' + S.aiProv, '');
  if (document.activeElement !== $('#aiKey')) $('#aiKey').value = key;
  $('#aiModel').placeholder = AI_DEFAULT_MODEL[S.aiProv];
  if (document.activeElement !== $('#aiModel')) $('#aiModel').value = store.get('aiModel:' + S.aiProv, '');
  $('#aiKeyLabel').textContent = `${AI_NAME[S.aiProv]} API key`;
  $('#aiKeyHelp').innerHTML = { claude: 'Get one at <b>console.anthropic.com</b>. Includes live web search.', openai: 'Get one at <b>platform.openai.com</b>.', gemini: 'Get one at <b>aistudio.google.com</b>. Includes Google Search.', grok: 'Get one at <b>console.x.ai</b>.' }[S.aiProv];
  // Setup opens by itself until there's a key (or a free allowance); after that it folds into the settings button.
  const house = !key && S.houseAI;
  if (host && !key && !house && !S.aiSetupSeen) { S.aiSetupSeen = true; setAiSetup(true, false); }
  const state = { idle: 'ready', listening: 'listening…', thinking: 'thinking…', speaking: 'speaking' }[S.aiStatus];
  $('#aiSub').textContent = !host ? 'The host’s producer and researcher' : key ? `${AI_NAME[S.aiProv]} · ${state}` : house ? `Free allowance · ${S.houseLeft ?? S.houseAI.daily} left today · ${state}` : `Add a ${AI_NAME[S.aiProv]} key to start`;
  $('#aiHouseNote').hidden = !S.houseAI;
  if (S.houseAI) $('#aiHouseNote').textContent = `No key? You get ${S.houseAI.daily} free requests a day per studio. Your own key has no limit.`;
  $('#aiInput').disabled = !host; $('#aiAsk').disabled = !host || S.ai.busy;
  if (S.ai.busy) $('#aiAsk').setAttribute('aria-busy', 'true'); else $('#aiAsk').removeAttribute('aria-busy');
  $('#aiHostNote').hidden = host;
  renderAILog();
}
function setAiSetup(open, focus = true) {
  $('#aiSetup').hidden = !open; $('#aiSetupBtn').setAttribute('aria-expanded', open); $('#aiSetupBtn').classList.toggle('on', open);
  if (open && focus) (store.get('aiKey:' + S.aiProv, '') ? $('#aiName') : $('#aiKey')).focus();
}
$('#aiSetupBtn').onclick = () => setAiSetup($('#aiSetup').hidden);
$('#aiSetupDone').onclick = () => { setAiSetup(false); $('#aiInput').focus(); };
$$('#aiProv button').forEach((b) => b.addEventListener('click', () => { S.aiProv = b.dataset.prov; store.set('aiProv', S.aiProv); renderAIPanel(); }));
$('#aiKey').addEventListener('change', (e) => { store.set('aiKey:' + S.aiProv, e.target.value.trim()); toast(e.target.value.trim() ? `${AI_NAME[S.aiProv]} key saved in this browser.` : 'Key removed.'); renderAIPanel(); });
$('#aiModel').addEventListener('change', (e) => store.set('aiModel:' + S.aiProv, e.target.value.trim()));
$('#aiClear').onclick = () => { S.ai.items = []; renderAILog(); if (S.studio && isHost()) wsSend({ type: 'ai', item: { id: 'clear', role: 'system', text: '', done: true } }); };
$$('#aiSugg .chip').forEach((b) => b.addEventListener('click', () => { const t = $('#aiInput'); t.value = b.dataset.q; autoGrow(t); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }));
$('#aiForm').addEventListener('submit', (ev) => { ev.preventDefault(); const t = $('#aiInput'); const v = t.value; t.value = ''; autoGrow(t); askProducer(v); });

// ---------------------------------------------------------------- composers: auto-growing, Enter sends, Shift+Enter breaks
function autoGrow(t) { if (t.tagName !== 'TEXTAREA') return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }
for (const [input, form] of [['#chatInput', '#chatForm'], ['#aiInput', '#aiForm']]) {
  const t = $(input);
  t.addEventListener('input', () => autoGrow(t));
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $(form).requestSubmit(); } });
}

// ---------------------------------------------------------------- support links (PayPal, Venmo, Cash App, Stripe…)
const TIP_FIELDS = [
  ['paypal', 'PayPal', 'paypal.me/yourname'], ['venmo', 'Venmo', '@yourname'], ['cashapp', 'Cash App', '$yourtag'],
  ['stripe', 'Stripe', 'buy.stripe.com/…'], ['kofi', 'Ko-fi', 'ko-fi.com/yourname'], ['patreon', 'Patreon', 'patreon.com/yourname'],
  ['bmc', 'Buy Me a Coffee', 'buymeacoffee.com/you'], ['link', 'Website', 'yoursite.com/support'],
];
function tipUrl(provider, raw) {
  let v = String(raw || '').trim();
  if (!v) return '';
  if (provider === 'venmo' && !/\//.test(v)) return 'https://venmo.com/u/' + v.replace(/^@/, '');
  if (provider === 'cashapp' && !/\//.test(v)) return 'https://cash.app/$' + v.replace(/^\$/, '');
  if (provider === 'paypal' && !/[./]/.test(v)) return 'https://paypal.me/' + v;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  return /^https:\/\/[^\s]+\.[^\s]+/.test(v.replace(/^http:/i, 'https:')) ? v.replace(/^http:/i, 'https:') : '';
}
// Support links: one row per provider. The button shows what the card is doing right now —
// "On stage" adds it (in a free spot), then "Hide" / "Show" toggle it without losing where it sits.
function renderTips() {
  const box = $('#tipList');
  if (!box) return;
  if (!box.children.length) {
    const saved = store.get('tips', {});
    box.replaceChildren(...TIP_FIELDS.map(([id, name, ph]) => {
      const row = document.createElement('div'); row.className = 'tip-row'; row.dataset.provider = id;
      const tag = document.createElement('span'); tag.className = 'tip-tag'; tag.textContent = name; tag.style.setProperty('--c', TIP_INFO[id].color);
      const inp = document.createElement('input'); inp.className = 'input sm'; inp.placeholder = ph; inp.value = saved[id] || ''; inp.spellcheck = false; inp.setAttribute('aria-label', name + ' link');
      inp.onchange = () => {
        const all = store.get('tips', {}); all[id] = inp.value.trim(); store.set('tips', all);
        const card = (S.state.elements || []).find((e) => e.type === 'tip' && e.provider === id), url = tipUrl(id, inp.value);
        if (card && url && card.url !== url && isHost()) patchEl(card.id, { url });
      };
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn sm tip-toggle';
      btn.onclick = () => toggleTip(id, name, inp.value);
      row.append(tag, inp, btn);
      return row;
    }));
  }
  for (const row of $$('.tip-row', box)) {
    const card = (S.state.elements || []).find((e) => e.type === 'tip' && e.provider === row.dataset.provider);
    const btn = $('.tip-toggle', row);
    btn.textContent = !card ? 'On stage' : card.hidden ? 'Show' : 'Hide';
    btn.setAttribute('aria-pressed', String(!!card && !card.hidden));
    btn.disabled = !isHost();
  }
}
function toggleTip(id, name, raw) {
  const card = (S.state.elements || []).find((e) => e.type === 'tip' && e.provider === id);
  if (card) {
    patchEl(card.id, { hidden: !card.hidden }, card.hidden ? 'show' : 'hide');
    if (!card.hidden) toast(`${name} card hidden. It keeps its spot for next time.`);
    return;
  }
  const url = tipUrl(id, raw);
  if (!url) return toast(`Add your ${name} link first.`, { err: true });
  const all = store.get('tips', {}); all[id] = raw.trim(); store.set('tips', all);
  const e = withDefaults({ type: 'tip', provider: id, url, label: 'Support the show' });
  const els = stageElements(), spot = freeSpot(e, els);
  if (spot) Object.assign(e, spot); else if (spot === false) e.stack = true;
  e.home = [e.x, e.y, e.w, e.h];
  setStage({ elements: [...els, e] });
  toast(spot === false ? `${name} card is on stage, stacked: there was no free spot. Move it in Layouts.` : `${name} card is on stage. Hide it here any time.`)
}

// ---------------------------------------------------------------- profile photo (shown when the camera is off)
$('#avatarBtn').onclick = () => $('#avatarFile').click();
$('#avatarHint').onclick = () => $('#avatarFile').click();
$('#avatarFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const data = await squareThumb(f);
    store.set('avatar', data);
    if (acct.user) acctApi('update', { avatar: data }).then((r) => setUser(r.user)).catch(() => {});
    renderPreview();
    if (S.studio) uploadAvatar(true);
  } catch (err) { toast(err.message, { err: true }); }
};
$('#avatarClear').onclick = () => { store.set('avatar', ''); S.local.avatarId = ''; renderPreview(); if (S.studio) sendMeta({ avatar: '' }); };
function squareThumb(file) {
  return new Promise((res, rej) => {
    if (!/^image\//.test(file.type)) return rej(new Error('Choose an image for your photo.'));
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.width, img.height), c = document.createElement('canvas'); c.width = c.height = 320;
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 320, 320);
      URL.revokeObjectURL(img.src); res(c.toDataURL('image/webp', .85));
    };
    img.onerror = () => rej(new Error('Could not read that image.'));
    img.src = URL.createObjectURL(file);
  });
}
async function uploadAvatar(force) {
  const data = store.get('avatar', '');
  if (!data || !S.studio || (S.local.avatarId && !force)) return;
  try { S.local.avatarId = await storeAsset(data); sendMeta({ avatar: S.local.avatarId }); renderCrew(); } catch {}
}

// ---------------------------------------------------------------- account (sign in, profile, synced settings)
const acct = { token: store.get('acctToken', ''), user: null };
async function acctApi(action, body = {}) {
  let res;
  try {
    res = await fetch('/api/account?action=' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(acct.token ? { Authorization: 'Bearer ' + acct.token } : {}) },
      body: JSON.stringify(body),
    });
  } catch { throw Object.assign(new Error('Could not reach gather. Check your connection.'), { status: 0 }); }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401 && acct.token && !['login', 'signup', 'reset', 'forgot', 'password', 'delete'].includes(action)) signedOut();
    throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status });
  }
  return data;
}
// Settings that follow you between devices once you're signed in. API keys and stream keys never sync.
const SYNC_KEYS = ['tips', 'layouts', 'presets', 'accent', 'bg', 'title', 'theme', 'aiProv', 'startMic', 'startCam', 'quality', 'audioFx', 'videoFx', 'brandPrefs', 'streamPrefs'];
let syncT = null, applyingSync = false;
const rawSet = store.set;
store.set = (k, v) => {
  rawSet(k, v);
  if (!applyingSync && acct.user && SYNC_KEYS.includes(k)) { clearTimeout(syncT); syncT = setTimeout(pushSettings, 1500); renderSyncNote('Saving…'); }
};
function collectSettings() { const o = {}; for (const k of SYNC_KEYS) { const v = store.get(k, undefined); if (v !== undefined) o[k] = v; } return o; }
async function pushSettings() {
  if (!acct.user) return;
  try { const r = await acctApi('update', { settings: collectSettings() }); acct.user = r.user; renderSyncNote('Saved to your account'); }
  catch (e) { renderSyncNote(e.message); }
}
function applySettings(settings) {
  applyingSync = true;
  for (const k of SYNC_KEYS) if (settings && k in settings) rawSet(k, settings[k]);
  applyingSync = false;
  S.audioFx = { echo: true, ns: true, agc: true, ai: false, gain: 1, ...store.get('audioFx', {}) };
  S.videoFx = { effect: 'none', bright: 0, contrast: 1, sat: 1, key: '#00ff00', tol: 0.1, spill: 0.85, edge: 0.1, blur: 1, fps: 30, mirror: true, ...store.get('videoFx', {}) };
  S.aiProv = store.get('aiProv', 'claude');
  applyTheme(store.get('theme', 'dark'));
  if (!S.studio) S.state = localState();
  renderAll(); renderPresets(); renderBgFx();
}
let profT = null;
function profileSoon(patch) {
  if (!acct.user) return;
  clearTimeout(profT);
  profT = setTimeout(() => acctApi('update', patch).then((r) => setUser(r.user)).catch(() => {}), 700);
}
function setUser(u, token) {
  acct.user = u;
  store.set('hadAccount', true); // this browser has signed in before: greet with "Welcome back" next time
  if (token) { acct.token = token; rawSet('acctToken', token); }
  if (u) {
    if (u.name) { S.name = u.name; rawSet('name', u.name); if (document.activeElement !== $('#nameInput')) $('#nameInput').value = u.name; if (document.activeElement !== $('#enterName')) $('#enterName').value = u.name; }
    if (u.avatar) rawSet('avatar', u.avatar);
  }
  renderUser(); renderPreview(); renderStreamPanel(); renderWatchSec();
}
function signedOut(msg) {
  acct.user = null; acct.token = ''; rawSet('acctToken', '');
  renderUser(); renderStreamPanel();
  if (msg) toast(msg);
}
function renderUser() {
  const b = $('#userBtn'), u = acct.user;
  b.classList.toggle('signed', !!u);
  b.title = u ? `Signed in as ${u.email}` : 'Sign in';
  const av = $('#userAv');
  av.style.backgroundImage = u?.avatar ? `url("${u.avatar}")` : '';
  av.textContent = u ? (u.avatar ? '' : initials(u.name)) : '';
  $('#userIcon').toggleAttribute('hidden', !!u);
  $('#userLabel').textContent = u ? u.name : 'Sign in';
  if ($('#acctDlg').open) renderAcctDlg();
}
function renderSyncNote(t) { const n = $('#acSync'); if (n) n.textContent = t; }
let acView = 'in'; // in | up | forgot | reset
function renderAcctDlg() {
  const u = acct.user;
  $('#acOut').hidden = !!u || acView === 'forgot' || acView === 'reset';
  $('#acForgotView').hidden = acView !== 'forgot';
  $('#acResetView').hidden = acView !== 'reset';
  $('#acIn').hidden = !u;
  $$('#acTabs button').forEach((b) => { const on = b.dataset.ac === acView; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  $('#acNameRow').hidden = acView !== 'up';
  $('#acGo').textContent = acView === 'up' ? 'Create account' : 'Sign in';
  $('#acPass').autocomplete = acView === 'up' ? 'new-password' : 'current-password';
  $('#acWhy').hidden = !!u || !S.afterSignIn;
  const outView = !u && acView !== 'forgot' && acView !== 'reset', up = acView === 'up';
  $('#acGoogleBtn').hidden = $('#acOr').hidden = !outView || !googleConfigured();
  $('#acGoogleText').textContent = up ? 'Sign up with Google' : 'Continue with Google';
  $('#acAgreeRow').hidden = !up; $('#acMeter').hidden = !up; $('#acForgot').hidden = up;
  $('#acFine').hidden = !outView || up;
  $('#acPass').placeholder = up ? 'At least 8 characters' : 'Your password';
  const av = store.get('avatar', '');
  $('#acUpAvatarImg').hidden = !av; if (av) $('#acUpAvatarImg').src = av;
  $('#acUpAvatar').classList.toggle('has', !!av);
  $('#acUpAvatar').setAttribute('aria-label', av ? 'Change your profile photo' : 'Add a profile photo');
  document.querySelector('#acctDlg .ac-card').classList.toggle('signed', !!u);
  $('#acH').textContent = u ? 'Your account' : acView === 'forgot' ? 'Reset your password' : acView === 'reset' ? 'Choose a new password' : acView === 'up' ? 'Create your account' : 'Welcome back';
  if (u) {
    // accounts made with Google have no password: no change-password form, and deleting asks for the email
    $('#acPwDetails').hidden = !u.hasPassword;
    $('#acDelLabel').textContent = u.hasPassword ? 'Password' : 'Type your email to confirm';
    $('#acDelPass').type = u.hasPassword ? 'password' : 'email';
  }
  if (u) {
    if (document.activeElement !== $('#acNick')) $('#acNick').value = u.name;
    $('#acEmailShow').textContent = u.email;
    $('#acAvatarImg').hidden = !u.avatar; if (u.avatar) $('#acAvatarImg').src = u.avatar;
    $('#acAvatarIni').textContent = u.avatar ? '' : initials(u.name);
    renderSyncNote('Brand, scenes, support links and device preferences follow you.');
  }
}
async function finishSignIn(r, isNew, local = collectSettings()) {
  setUser(r.user, r.token);
  // Bring this browser's setup into a new account; an existing account's settings win on a new device.
  if (isNew || !Object.keys(r.user.settings || {}).length) { const av = store.get('avatar', ''); await acctApi('update', { settings: local, ...(av && !r.user.avatar ? { avatar: av } : {}) }).then((x) => setUser(x.user)).catch(() => {}); }
  else applySettings(r.user.settings);
  acView = 'in'; renderAcctDlg();
  toast(`Signed in as ${r.user.name}.`);
  const next = S.afterSignIn; S.afterSignIn = null;
  if (next) { $('#acctDlg').close(); next(); }
}
async function googleSignIn() {
  acErr('#acErr', '');
  if (acView === 'up' && !$('#acAgree').checked) { acErr('#acErr', 'Tick the box to agree to the Terms and Privacy policy first.'); return $('#acAgree').focus(); }
  busy($('#acGoogleBtn'));
  try {
    const accessToken = await googleSignInToken();
    // Signing in from the "Sign in" tab is covered by the notice under the form, so agreeing goes with it.
    const r = await acctApi('google', { accessToken, agree: true });
    await finishSignIn(r, !!r.created);
  } catch (err) { acErr('#acErr', err.message); }
  finally { busy($('#acGoogleBtn'), false); }
}
$('#acGoogleBtn').onclick = googleSignIn;
// sign-up extras: a profile photo, show/hide password, a strength hint
$('#acUpAvatar').onclick = () => $('#acUpAvatarFile').click();
$('#acUpAvatarFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { store.set('avatar', await squareThumb(f)); renderAcctDlg(); renderPreview(); } catch (err) { acErr('#acErr', err.message); }
};
$('#acPassEye').onclick = () => {
  const show = $('#acPass').type === 'password';
  $('#acPass').type = show ? 'text' : 'password';
  $('#acPassEye').setAttribute('aria-pressed', String(show));
  $('#acPassEye').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  $('#acPassEye use').setAttribute('href', show ? '/icons.svg#i-eye-off' : '/icons.svg#i-eye');
};
function passScore(p) {
  if (p.length < 8) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((r) => r.test(p)).length;
  return p.length >= 14 || (p.length >= 10 && kinds >= 3) ? 3 : kinds >= 2 || p.length >= 10 ? 2 : 1;
}
$('#acPass').addEventListener('input', () => {
  if (acView !== 'up') return;
  const p = $('#acPass').value, sc = passScore(p);
  $('#acMeter').dataset.score = p ? sc : '';
  $('#acMeterText').textContent = !p ? '' : sc === 0 ? `${8 - p.length} more character${8 - p.length === 1 ? '' : 's'}` : ['', 'Okay', 'Good', 'Strong'][sc];
});
/** Starting a studio needs an account (guests don't): sign in first, then carry on to the green room. */
function needAccountThen(fn) {
  if (!S.requireAccount || acct.user) return fn();
  S.afterSignIn = fn;
  openAccount();
}
function openAccount(view) {
  // First-timers start on Create account; anyone who has signed in on this browser before starts on Sign in.
  acView = view || (acct.user || store.get('hadAccount', false) ? 'in' : 'up');
  $$('#acctDlg .err').forEach((e) => (e.hidden = true));
  renderAcctDlg();
  $('#acctDlg').showModal();
}
const acErr = (id, msg) => { const e = $(id); e.textContent = msg; e.hidden = !msg; };
$('#userBtn').onclick = () => openAccount();
$$('#acTabs button').forEach((b) => b.addEventListener('click', () => { acView = b.dataset.ac; acErr('#acErr', ''); renderAcctDlg(); }));
$('#acForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  acErr('#acErr', '');
  busy($('#acGo'));
  try {
    const body = { email: $('#acEmail').value, password: $('#acPass').value };
    const local = collectSettings();
    let r;
    if (acView === 'up' && !$('#acAgree').checked) { acErr('#acErr', 'Tick the box to agree to the Terms and Privacy policy.'); $('#acAgree').focus(); return; }
    if (acView === 'up') r = await acctApi('signup', { ...body, agree: true, name: $('#acName').value || S.name });
    else r = await acctApi('login', body);
    $('#acPass').value = '';
    await finishSignIn(r, acView === 'up', local);
  } catch (err) { acErr('#acErr', err.message); }
  finally { busy($('#acGo'), false); }
});
$('#acForgot').onclick = () => { acView = 'forgot'; $('#acFEmail').value = $('#acEmail').value; renderAcctDlg(); };
$('#acFBack').onclick = () => { acView = 'in'; renderAcctDlg(); };
$('#acFGo').onclick = async () => {
  acErr('#acFErr', ''); $('#acFMsg').hidden = true;
  try { await acctApi('forgot', { email: $('#acFEmail').value }); $('#acFMsg').hidden = false; }
  catch (err) { acErr('#acFErr', err.message); }
};
$('#acRGo').onclick = async () => {
  acErr('#acRErr', '');
  try {
    const r = await acctApi('reset', { token: S.resetToken, password: $('#acRPass').value });
    setUser(r.user, r.token); applySettings(r.user.settings);
    history.replaceState(null, '', '/'); acView = 'in'; renderAcctDlg(); toast('Password changed. You’re signed in.');
  } catch (err) { acErr('#acRErr', err.message); }
};
$('#acSaveProfile').onclick = async () => {
  try { const r = await acctApi('update', { name: $('#acNick').value }); setUser(r.user); toast('Profile saved.'); }
  catch (err) { toast(err.message, { err: true }); }
};
$('#acAvatarBtn').onclick = () => $('#acAvatarFile').click();
$('#acAvatarFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const data = await squareThumb(f);
    rawSet('avatar', data);
    const r = await acctApi('update', { avatar: data }); setUser(r.user);
    if (S.studio) uploadAvatar(true);
    toast('Photo updated.');
  } catch (err) { toast(err.message, { err: true }); }
};
$('#acPwGo').onclick = async () => {
  acErr('#acPwErr', ''); $('#acPwMsg').hidden = true;
  try {
    const r = await acctApi('password', { current: $('#acCur').value, next: $('#acNew').value });
    setUser(r.user, r.token); $('#acCur').value = ''; $('#acNew').value = '';
    $('#acPwMsg').hidden = false;
  } catch (err) { acErr('#acPwErr', err.message); }
};
$('#acSignOut').onclick = async () => { await acctApi('logout').catch(() => {}); signedOut('Signed out.'); $('#acctDlg').close(); };
$('#acDelGo').onclick = async () => {
  acErr('#acDelErr', '');
  try { await acctApi('delete', { password: $('#acDelPass').value }); signedOut('Your account was deleted.'); $('#acctDlg').close(); }
  catch (err) { acErr('#acDelErr', err.message); }
};
async function acctBoot() {
  const reset = new URLSearchParams(location.search).get('reset');
  if (reset) { S.resetToken = reset; openAccount('reset'); }
  if (!acct.token) return renderUser();
  try { const r = await acctApi('me'); setUser(r.user); if (Object.keys(r.user.settings || {}).length) applySettings(r.user.settings); }
  catch (e) { if (e.status !== 401) renderUser(); }
}

// ---------------------------------------------------------------- brand panel
function savedBrandImgs() { return store.get('brandImgs', {}); }
async function uploadBrandAssets(brand) {
  if (!brand || S.host !== S.id) return;
  const patch = {};
  for (const k of ['bgImage', 'overlay', 'logo']) {
    const id = brand[k];
    if (id?.startsWith('local-')) { const data = S.assets.get(id)?.data || savedBrandImgs()[k]; if (data) patch[k] = await storeAsset(data).catch(() => ''); }
  }
  if (Object.keys(patch).length) setStage({ brand: patch });
}
function brandPref(patch) {
  // Keep the look for the next studio too (images live in this browser).
  const keep = ['font', 'tag', 'bannerStyle', 'anim', 'frame', 'dim', 'logoPos', 'logoSize'];
  const prefs = store.get('brandPrefs', {});
  for (const k of keep) if (k in patch) prefs[k] = patch[k];
  store.set('brandPrefs', prefs);
  setStage({ brand: patch });
}
async function brandImage(kind, file) {
  try {
    const data = await compressImage(file);
    const imgs = savedBrandImgs(); imgs[kind] = data;
    try { rawSet('brandImgs', imgs); } catch {}
    const id = S.studio ? await storeAsset(data) : (setAssetData('local-brand-' + kind, data), 'local-brand-' + kind);
    setStage({ brand: { [kind]: id } });
    toast({ bgImage: 'Background image set.', overlay: 'Overlay added.', logo: 'Logo added.' }[kind]);
  } catch (err) { toast(err.message, { err: true }); }
}
function clearBrandImage(kind) {
  const imgs = savedBrandImgs(); delete imgs[kind]; rawSet('brandImgs', imgs);
  setStage({ brand: { [kind]: '' } });
}
for (const [kind, pick, file, clear] of [['bgImage', '#bgImgPick', '#bgImgFile', '#bgImgClear'], ['overlay', '#overlayPick', '#overlayFile', '#overlayClear'], ['logo', '#logoPick', '#logoFile', '#logoClear']]) {
  $(pick).onclick = () => { if (!isHost()) return toast('Only the host can change the brand.', { err: true }); $(file).click(); };
  $(file).onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) brandImage(kind, f); };
  $(clear).onclick = () => clearBrandImage(kind);
}
function segWire(sel, attr, key) {
  $$(sel + ' button').forEach((b) => b.addEventListener('click', () => { if (!isHost()) return; brandPref({ [key]: b.dataset[attr] }); }));
}
segWire('#tagSeg', 'tag', 'tag'); segWire('#bannerStyleSeg', 'bs', 'bannerStyle'); segWire('#frameSeg', 'frame', 'frame');
$$('#logoPosSeg button').forEach((b) => b.addEventListener('click', () => { if (!isHost()) return; brandPref({ logoPos: b.dataset.lp }); placeLayer('logo', b.dataset.lp, S.state.brand.logoSize || .12); }));
$('#fontSel').onchange = (e) => brandPref({ font: e.target.value });
$('#animSel').onchange = (e) => { brandPref({ anim: e.target.value }); previewAnimation(); };
$('#bgDim').oninput = (e) => brandPref({ dim: Number(e.target.value) });
$('#logoSize').oninput = (e) => { brandPref({ logoSize: Number(e.target.value) }); placeLayer('logo', S.state.brand.logoPos || 'tr', Number(e.target.value)); };
/** Put the logo or sponsor layer in a corner (inside action-safe, on the grid). If the corner is taken it goes stacked and says so. */
function placeLayer(type, pos, size) {
  const els = elementsCopy(), e = els.find((x) => x.type === type);
  if (!e) return;
  const g8 = (v, n) => Math.round(v * n / GRID) * GRID / n;
  const bottomBand = pos === 'bottom';
  const w = bottomBand ? .5 : type === 'logo' ? size : .2, h = bottomBand ? .13 : type === 'logo' ? (size * W / 3) / H : .2;
  const mx = SAFE.action + GRID / W, my = SAFE.action + GRID / H;
  const x = bottomBand ? (1 - w) / 2 : pos.includes('l') ? mx : 1 - mx - w;
  const y = bottomBand ? 1 - my - h : pos.startsWith('b') ? 1 - my - h : my;
  Object.assign(e, { x: g8(x, W), y: g8(y, H), w: g8(w, W), h: g8(h, H), hidden: false });
  const blocker = !e.stack && blockerFor(e, e, els);
  if (blocker) { e.stack = true; toast(`${elName(e)} overlaps ${elName(blocker)} there, so it’s stacked on top. Fine-tune it in Layouts.`, { ms: 4200 }); }
  setStage({ elements: els });
}
function previewAnimation() {
  S.banner.key = ''; featAnim.key = '';
  if (!S.state.banner && !S.state.featured) toast('Show a banner to see the animation on stage.');
}
$('#animPreview').onclick = previewAnimation;
function renderBrandPanel() {
  const b = S.state.brand, host = isHost();
  const segOn = (sel, attr, val) => $$(sel + ' button').forEach((x) => { x.classList.toggle('on', x.dataset[attr] === val); x.disabled = !host; });
  segOn('#tagSeg', 'tag', b.tag || 'solid'); segOn('#bannerStyleSeg', 'bs', b.bannerStyle || 'classic'); segOn('#frameSeg', 'frame', b.frame || 'none'); segOn('#logoPosSeg', 'lp', b.logoPos || 'tr');
  $('#fontSel').value = b.font || 'jakarta'; $('#fontSel').disabled = !host;
  $('#animSel').value = b.anim || 'slide'; $('#animSel').disabled = !host;
  $('#bgDim').value = b.dim ?? 0.25; $('#bgDim').disabled = !host;
  $('#logoSize').value = b.logoSize ?? 0.12; $('#logoSize').disabled = !host;
  $('#bgImgClear').hidden = !b.bgImage; $('#overlayClear').hidden = !b.overlay; $('#logoClear').hidden = !b.logo;
  $('#bgDimRow').hidden = !b.bgImage;
  $('#logoRow').hidden = !b.logo;
  for (const id of ['#bgImgPick', '#overlayPick', '#logoPick']) $(id).disabled = !host;
}

// ---------------------------------------------------------------- stream tab: format, captions, upcoming
S.streams = [];
const streamPrefs = () => store.get('streamPrefs', {});
function setStreamPref(patch) { store.set('streamPrefs', { ...streamPrefs(), ...patch }); }
$$('#aspectSeg button').forEach((b) => b.addEventListener('click', () => {
  if (!isHost()) return;
  if (S.rec) return toast('Stop recording before changing the format.', { err: true });
  const aspect = b.dataset.aspect;
  setStreamPref({ aspect });
  const patch = { aspect };
  if (S.state.layout === 'custom') { const t = aspect === '9:16' ? TPL['v-solo'] : TPL['p-interview']; Object.assign(patch, templatePatch(t)); patch.aspect = aspect; }
  setStage(patch);
  toast(aspect === '9:16' ? 'Vertical 9:16 — ready for TikTok, Reels and Shorts.' : 'Landscape 16:9.');
}));
function syncAspect() {
  const v = S.state.aspect === '9:16';
  const w = v ? 720 : 1280, h = v ? 1280 : 720;
  if (W === w && H === h) return;
  W = w; H = h; canvas.width = w; canvas.height = h;
  $('#stage').classList.toggle('vertical', v);
  renderScenes();
}
$('#capSwitch').onchange = (e) => { if (!isHost()) return; const c = { ...S.state.captions, on: e.target.checked }; setStreamPref({ captions: c }); setStage({ captions: c }); };
$('#capLang').onchange = (e) => { const c = { ...S.state.captions, lang: e.target.value }; setStreamPref({ captions: c }); setStage({ captions: c }); };
$$('#capStyle button').forEach((b) => b.addEventListener('click', () => { const c = { ...S.state.captions, style: b.dataset.cs }; setStreamPref({ captions: c }); setStage({ captions: c }); }));
$('#capSize').oninput = (e) => { const c = { ...S.state.captions, size: Number(e.target.value) }; setStreamPref({ captions: c }); setStage({ captions: c }); };
function renderStreamPanel() {
  const host = isHost(), c = S.state.captions || {};
  $$('#aspectSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.aspect === (S.state.aspect || '16:9')); b.disabled = !host; });
  $('#capSwitch').checked = !!c.on; $('#capSwitch').disabled = !host;
  $('#capLang').value = c.lang || 'en-US'; $('#capLang').disabled = !host;
  $$('#capStyle button').forEach((b) => { b.classList.toggle('on', b.dataset.cs === (c.style || 'bar')); b.disabled = !host; });
  $('#capSize').value = c.size || 26; $('#capSize').disabled = !host;
  $('#capOpts').hidden = !c.on;
  $('#capNote').textContent = (window.SpeechRecognition || window.webkitSpeechRecognition) ? 'Each person’s browser transcribes their own mic. Works best in Chrome and Edge.' : 'This browser can’t transcribe speech. Guests on Chrome or Edge will still be captioned.';
  // upcoming
  $('#upSignin').hidden = !!acct.user;
  $('#upWrap').hidden = !acct.user;
  if (acct.user && !S.streamsLoaded) loadStreams();
}
async function loadStreams() {
  S.streamsLoaded = true;
  try { const r = await acctApi('streamList'); S.streams = r.streams; S.mailReady = r.mailReady; renderUpcoming(); }
  catch { S.streamsLoaded = false; }
}
const fmtLocal = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function renderUpcoming() {
  const ul = $('#upList');
  const rows = S.streams.filter((x) => x.status === 'scheduled' || (x.status === 'live' && Date.now() - x.when < 6 * 3600e3));
  $('#upEmpty').hidden = !!rows.length;
  ul.replaceChildren(...rows.map((st) => {
    const li = document.createElement('li'); li.className = 'up-item';
    const top = document.createElement('div'); top.className = 'up-top';
    const t = document.createElement('b'); t.textContent = st.title;
    const badge = document.createElement('span'); badge.className = 'pill caps up-badge' + (st.status === 'live' ? ' live' : ''); badge.textContent = st.status === 'live' ? 'Live' : fmtLocal(st.when);
    top.append(t, badge);
    const meta = document.createElement('p'); meta.className = 'up-meta';
    meta.textContent = `${st.invites.length ? st.invites.length + ' invited' : 'No invites'}${st.mail?.scheduled ? ` · ${st.mail.scheduled} reminders scheduled` : ''}`;
    const row = document.createElement('div'); row.className = 'row';
    const btn = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm ' + cls; b.textContent = label; b.onclick = fn; return b; };
    row.append(
      btn('Start', 'primary', () => startScheduled(st)),
      btn('Copy link', '', () => copy(`${location.origin}/s/${st.studio}`, 'Invite link copied.')),
      btn('Calendar', '', () => downloadIcs(st)),
      btn('Cancel', 'danger', (ev) => {
        const b = ev.currentTarget;
        if (b.dataset.confirm) { cancelStream(st); return; }
        b.dataset.confirm = '1'; b.textContent = 'Confirm cancel'; setTimeout(() => { delete b.dataset.confirm; b.textContent = 'Cancel'; }, 4000);
      }),
    );
    li.append(top, meta, row);
    return li;
  }));
}
async function cancelStream(st) {
  try { await acctApi('streamCancel', { id: st.id, notify: true }); toast('Stream cancelled. Invitees were told and reminders stopped.'); S.streamsLoaded = false; loadStreams(); }
  catch (err) { toast(err.message, { err: true }); }
}
function startScheduled(st) {
  if (S.studio) return toast('Leave this studio first, then start the stream.', { err: true });
  S.pendingStream = { code: st.studio, id: st.id, title: st.title };
  S.state.title = st.title;
  openEnter('create');
}
function downloadIcs(st) {
  const d = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const e = (t) => String(t || '').replace(/[\\,;]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const link = `${location.origin}/s/${st.studio}`;
  const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//gather//studio//EN', 'BEGIN:VEVENT', `UID:${st.id}@gather`, `DTSTAMP:${d(Date.now())}`, `DTSTART:${d(st.when)}`, `DTEND:${d(st.when + (st.duration || 60) * 60000)}`,
    `SUMMARY:${e(st.title)}`, `DESCRIPTION:${e((st.description ? st.description + '\n\n' : '') + 'Studio: ' + link)}`, `URL:${link}`, 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Starting soon', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
  a.download = (st.title || 'gather-stream').replace(/[^\w -]+/g, '').slice(0, 40) + '.ics';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('#upSigninBtn').onclick = () => openAccount('up');

// ---------------------------------------------------------------- start / schedule wizard + thumbnails
const wiz = { step: 1, mode: 'now', thumb: null, photo: null, aiBg: null, upload: null, tab: 'design', style: 'bold' };
const tc = $('#wThumb'), tg = tc.getContext('2d');
function openWizard() {
  if (S.studio && !isHost()) return;
  Object.assign(wiz, { step: 1, mode: 'now' });
  $('#wTitle').value = $('#wTitle').value || S.state.title || '';
  const d = new Date(Date.now() + 864e5); d.setMinutes(0, 0, 0);
  if (!$('#wDate').value) { $('#wDate').value = d.toISOString().slice(0, 10); $('#wTime').value = d.toTimeString().slice(0, 5); }
  $('#wDone').hidden = true; $('#wSteps').hidden = false;
  renderWizard(); drawThumb();
  $('#wizDlg').showModal();
}
$('#wizOpen').onclick = openWizard;
$$('[data-wmode]').forEach((b) => b.addEventListener('click', () => { wiz.mode = b.dataset.wmode; wiz.step = 2; renderWizard(); setTimeout(() => $('#wTitle').focus(), 50); }));
$('#wBack').onclick = () => { wiz.step = Math.max(1, wiz.step - 1); renderWizard(); };
$('#wNext').onclick = () => {
  if (wiz.step === 2) {
    if (!$('#wTitle').value.trim()) return wErr('Give your stream a title.');
    if (wiz.mode === 'later') {
      if (!acct.user) return wErr('Sign in to schedule streams and send reminders.');
      const when = wWhen();
      if (!when || when < Date.now() + 60e3) return wErr('Pick a start time in the future.');
      if (when > Date.now() + 29 * 864e5) return wErr('You can schedule up to 29 days ahead.');
    }
  }
  wErr(''); wiz.step = Math.min(4, wiz.step + 1); renderWizard(); if (wiz.step === 3) drawThumb();
};
const wErr = (m) => { $('#wErr').textContent = m; $('#wErr').hidden = !m; };
const wWhen = () => { const v = $('#wDate').value && $('#wTime').value ? new Date(`${$('#wDate').value}T${$('#wTime').value}`) : null; return v ? v.getTime() : 0; };
function renderWizard() {
  $$('#wSteps [data-step]').forEach((el) => (el.hidden = Number(el.dataset.step) !== wiz.step));
  $$('#wDots i').forEach((d, i) => d.classList.toggle('on', i < wiz.step));
  $('#wBack').hidden = wiz.step === 1;
  $('#wNext').hidden = wiz.step === 1 || wiz.step === 4;
  $('#wGo').hidden = wiz.step !== 4;
  $('#wGo').textContent = wiz.mode === 'later' ? 'Schedule stream' : 'Go to the green room';
  $$('.w-later').forEach((el) => (el.hidden = wiz.mode !== 'later'));
  $('#wMailNote').textContent = !acct.user ? 'Sign in to email invites and reminders.' : S.mailReady === false ? 'Email isn’t set up on this gather yet, so invites won’t be emailed. You can still copy the link.' : 'Invitees get the invite now, then reminders a day and 15 minutes before. You get the reminders too.';
  $$('#wThumbTabs button').forEach((b) => b.classList.toggle('on', b.dataset.wt === wiz.tab));
  $$('[data-wpane]').forEach((p) => (p.hidden = p.dataset.wpane !== wiz.tab));
  $$('#wStyle button').forEach((b) => b.classList.toggle('on', b.dataset.ws === wiz.style));
  if (wiz.step === 4) {
    $('#wSumTitle').textContent = $('#wTitle').value.trim();
    $('#wSumWhen').textContent = wiz.mode === 'later' ? fmtLocal(wWhen()) : 'Now';
    const inv = $('#wInvites').value.split(/[\s,;]+/).filter(Boolean);
    $('#wSumInv').textContent = inv.length ? `${inv.length} ${inv.length === 1 ? 'person' : 'people'}` : 'Nobody yet';
    $('#wSumThumb').src = tc.toDataURL('image/webp', .8);
  }
}
$$('#wThumbTabs button').forEach((b) => b.addEventListener('click', () => { wiz.tab = b.dataset.wt; renderWizard(); drawThumb(); }));
$$('#wStyle button').forEach((b) => b.addEventListener('click', () => { wiz.style = b.dataset.ws; renderWizard(); drawThumb(); }));
$('#wHeadline').oninput = drawThumb;
$('#wTitle').addEventListener('input', () => { if (!$('#wHeadline').dataset.touched) $('#wHeadline').value = $('#wTitle').value; drawThumb(); });
$('#wHeadline').addEventListener('input', () => { $('#wHeadline').dataset.touched = '1'; });
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
$('#wSnap').onclick = async () => {
  const v = $(`#card-${cssId(myId())} video`) || $('#previewVideo');
  if (!v?.videoWidth) return toast('Turn your camera on first, or upload a photo.', { err: true });
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0); wiz.photo = await loadImg(c.toDataURL('image/jpeg', .9)); drawThumb();
};
$('#wPhotoPick').onclick = () => $('#wPhotoFile').click();
$('#wPhotoFile').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { wiz.photo = await loadImg(await compressImage(f)); drawThumb(); } };
$('#wUploadPick').onclick = () => $('#wUploadFile').click();
$('#wUploadFile').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { wiz.upload = await loadImg(await compressImage(f)); drawThumb(); } };
$('#wGen').onclick = async () => {
  const prompt = $('#wPrompt').value.trim();
  if (!prompt) return toast('Describe the background you want.', { err: true });
  const prov = S.aiProv, key = store.get('aiKey:' + prov, '');
  busy($('#wGen')); $('#wGenNote').textContent = '';
  try {
    const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'image', provider: prov, apiKey: key, prompt }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'The image request failed.');
    wiz.aiBg = await loadImg(j.data); wiz.tab = 'design'; renderWizard(); drawThumb();
    toast('AI background added. Adjust the headline and style.');
  } catch (err) { $('#wGenNote').textContent = err.message; }
  finally { busy($('#wGen'), false); }
};
function cover(gx, img, x, y, w, h) {
  const k = Math.max(w / img.naturalWidth, h / img.naturalHeight), dw = img.naturalWidth * k, dh = img.naturalHeight * k;
  gx.save(); gx.beginPath(); gx.rect(x, y, w, h); gx.clip(); gx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); gx.restore();
}
function drawThumb() {
  const Wt = 1280, Ht = 720, accent = S.state.brand.color, F = stageFont();
  tg.clearRect(0, 0, Wt, Ht);
  if (wiz.tab === 'upload') {
    if (wiz.upload) cover(tg, wiz.upload, 0, 0, Wt, Ht);
    else { tg.fillStyle = '#101b3a'; tg.fillRect(0, 0, Wt, Ht); tg.fillStyle = 'rgba(255,255,255,.6)'; tg.font = '600 30px Onest, sans-serif'; tg.textAlign = 'center'; tg.fillText('Choose an image (1280 × 720 works best)', Wt / 2, Ht / 2); }
    return;
  }
  // background: AI image, else the brand gradient
  if (wiz.aiBg) cover(tg, wiz.aiBg, 0, 0, Wt, Ht);
  else { const gr = tg.createLinearGradient(0, 0, Wt, Ht); gr.addColorStop(0, '#0b1636'); gr.addColorStop(.55, '#1a2a6b'); gr.addColorStop(1, accent); tg.fillStyle = gr; tg.fillRect(0, 0, Wt, Ht); }
  const head = ($('#wHeadline').value || $('#wTitle').value || 'Your stream title').trim();
  const st = wiz.style;
  if (wiz.photo) {
    if (st === 'split') cover(tg, wiz.photo, Wt * .5, 0, Wt * .5, Ht);
    else if (st === 'center') { tg.save(); tg.globalAlpha = .35; cover(tg, wiz.photo, 0, 0, Wt, Ht); tg.restore(); }
    else { cover(tg, wiz.photo, Wt * .48, 0, Wt * .52, Ht); const fade = tg.createLinearGradient(Wt * .48, 0, Wt * .62, 0); fade.addColorStop(0, 'rgba(8,14,32,1)'); fade.addColorStop(1, 'rgba(8,14,32,0)'); tg.fillStyle = fade; tg.fillRect(Wt * .48, 0, Wt * .14, Ht); }
  }
  if (st !== 'center') { const sh = tg.createLinearGradient(0, 0, Wt * .6, 0); sh.addColorStop(0, 'rgba(6,10,24,.75)'); sh.addColorStop(1, 'rgba(6,10,24,0)'); tg.fillStyle = sh; tg.fillRect(0, 0, Wt * .6, Ht); }
  // headline
  const maxW = st === 'center' ? Wt - 160 : Wt * .46;
  let size = 108;
  tg.font = `900 ${size}px ${F}`;
  let lines = [];
  for (;;) {
    tg.font = `900 ${size}px ${F}`;
    const words = head.toUpperCase().split(/\s+/); lines = []; let cur = '';
    for (const w of words) { const test = cur ? cur + ' ' + w : w; if (tg.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test; }
    if (cur) lines.push(cur);
    if (lines.length <= 4 || size <= 48) break;
    size -= 8;
  }
  const lh = size * 1.02, total = lines.length * lh;
  tg.textAlign = st === 'center' ? 'center' : 'left'; tg.textBaseline = 'alphabetic';
  const x0 = st === 'center' ? Wt / 2 : 70, y0 = (Ht - total) / 2 + size * .85;
  lines.forEach((l, i) => {
    tg.lineWidth = size * .12; tg.strokeStyle = 'rgba(0,0,0,.55)'; tg.lineJoin = 'round'; tg.strokeText(l, x0, y0 + i * lh);
    tg.fillStyle = i === lines.length - 1 ? accent : '#ffffff'; tg.fillText(l, x0, y0 + i * lh);
  });
  tg.fillStyle = accent; tg.fillRect(st === 'center' ? Wt / 2 - 60 : 72, y0 + (lines.length - 1) * lh + 26, 120, 10);
}
$('#wGo').onclick = async () => {
  wErr('');
  const title = $('#wTitle').value.trim();
  const thumb = (wiz.tab === 'upload' && !wiz.upload) ? '' : tc.toDataURL('image/jpeg', .86);
  const body = { title, description: $('#wDesc').value.trim(), invites: $('#wInvites').value, destinations: $$('#wDest input:checked').map((i) => i.value), thumb, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, duration: Number($('#wDur').value) };
  busy($('#wGo'));
  try {
    if (wiz.mode === 'later') {
      const r = await acctApi('streamCreate', { ...body, when: wWhen(), notify: true });
      S.streams.push(r.stream); renderUpcoming();
      $('#wSteps').hidden = true; $('#wDone').hidden = false;
      $('#wDoneWhen').textContent = fmtLocal(r.stream.when);
      $('#wDoneMail').textContent = r.stream.mail?.skipped || (r.stream.mail ? `${r.stream.mail.sent} invites sent, ${r.stream.mail.scheduled} reminders scheduled${r.stream.mail.failed ? `, ${r.stream.mail.failed} failed: ${r.stream.mail.error}` : ''}.` : 'No emails were sent.');
      wiz.done = r.stream;
    } else {
      // Live now: a reserved studio when signed in (so you keep the host seat), else a fresh one.
      let code = newCode(), id = null;
      if (acct.user) { const r = await acctApi('streamCreate', body); code = r.stream.studio; id = r.stream.id; }
      S.pendingStream = { code, id, title };
      setStage({ title });
      $('#wizDlg').close();
      openEnter('create');
    }
  } catch (err) { wErr(err.message); }
  finally { busy($('#wGo'), false); }
};
$('#wDoneCopy').onclick = () => wiz.done && copy(`${location.origin}/s/${wiz.done.studio}`, 'Invite link copied.');
$('#wDoneCal').onclick = () => wiz.done && downloadIcs(wiz.done);
$('#wDoneClose').onclick = () => $('#wizDlg').close();

// ---------------------------------------------------------------- live captions (Web Speech API, each person's own mic)
const cap = { rec: null, want: false, lang: '', lines: new Map(), warned: false };
let capLast = 0, capTimer = null;
function sendCaption(text, final) {
  clearTimeout(capTimer);
  const go = () => { capLast = Date.now(); wsSend({ type: 'caption', text, final }); };
  if (final || Date.now() - capLast > 400) go(); else capTimer = setTimeout(go, 400);
}
function showCaption(id, name, text, final) {
  cap.lines.set(id, { name, text, final, t: Date.now() });
  // Watch-page viewers can turn CC on: the host passes each finished line along (one small write per line).
  if (final && isHost() && S.studio && text) wsSend({ type: 'wcap', name, text });
}
function drawCaptions(r) {
  const c = S.state.captions;
  if (!c?.on) return;
  const now = Date.now();
  const live = [...cap.lines.values()].filter((l) => now - l.t < (l.final ? 4000 : 6000)).sort((a, b) => a.t - b.t).slice(-2);
  if (!live.length) return;
  const fs = c.size || 26, F = stageFont(), maxW = Math.max(120, r.w - 48), cx = r.x + r.w / 2, lh = fs * 1.3, many = cap.lines.size > 1;
  const rows = [];
  for (const l of live) {
    g.font = `600 ${fs}px ${F}`;
    const words = wrapLines(l.text, maxW - (many ? 0 : 0));
    const tail = words.slice(-2); // newest words stay visible
    tail.forEach((t, i) => rows.push({ name: i === 0 && many ? l.name : '', text: t }));
  }
  const shown = rows.slice(-3);
  const blockH = shown.length * lh + 18;
  const y0 = r.y + r.h - blockH;
  g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
  if (c.style === 'bar') { g.fillStyle = 'rgba(0,0,0,.72)'; rr(cx - maxW / 2 - 24, y0, maxW + 48, blockH, 10); g.fill(); }
  shown.forEach((r, i) => {
    const y = y0 + 9 + lh * (i + .5);
    const label = r.name ? r.name + ': ' : '';
    g.font = `600 ${fs}px ${F}`;
    const full = g.measureText(label + r.text).width;
    if (c.style === 'box') { g.fillStyle = 'rgba(0,0,0,.78)'; rr(cx - full / 2 - 12, y - lh / 2 + 2, full + 24, lh - 4, 6); g.fill(); }
    if (c.style === 'plain') { g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 8; }
    let x = cx - full / 2;
    g.textAlign = 'left';
    if (label) { g.fillStyle = S.state.brand.color; g.fillText(label, x, y); x += g.measureText(label).width; }
    g.fillStyle = '#ffffff'; g.fillText(r.text, x, y);
    g.shadowColor = 'transparent';
  });
  g.restore();
}

// ---------------------------------------------------------------- guest view: invitees see only their own controls
function renderGuestView() {
  const guest = !!S.studio && !isHost();
  document.body.classList.toggle('is-guest', guest);
  const active = $(`.rail-btn[data-tab="${S.tab}"]`);
  if (guest && active?.classList.contains('host-only')) setTab('chat');
}

// ---------------------------------------------------------------- help: search every setting, jump straight to it
const HELP = [
  ['Change my camera', 'camera webcam device switch', 'settings', '#camSelect', 'Settings → Camera'],
  ['Change my microphone', 'mic microphone audio input device', 'settings', '#micSelect', 'Settings → Microphone'],
  ['Others hear an echo', 'echo feedback hear myself loop', 'settings', '#echoChk', 'Settings → Microphone → Echo cancellation'],
  ['Remove background noise', 'noise background fan keyboard dog ai rnnoise', 'settings', '#aiNoiseChk', 'Settings → Microphone → AI noise removal'],
  ['My mic is too quiet or too loud', 'volume gain loud quiet level', 'settings', '#micGain', 'Settings → Microphone → Input gain'],
  ['Blur my background', 'blur background bokeh', 'settings', '#bgFxSeg', 'Settings → Background'],
  ['Replace my background / green screen', 'virtual background green screen chroma replace image', 'settings', '#bgFxSeg', 'Settings → Background'],
  ['Video looks dark or washed out', 'brightness contrast light dark saturation colour', 'settings', '#fxBright', 'Settings → Camera → Light'],
  ['Video is choppy', 'choppy laggy fps frame rate quality bandwidth', 'settings', '#qualitySelect', 'Settings → Camera → Quality'],
  ['Mirror my camera', 'mirror flip reversed', 'settings', '#mirrorChk', 'Settings → Camera'],
  ['Go live or schedule a stream', 'go live schedule stream start upcoming', 'stream', '#wizOpen', 'Go live → Schedule'],
  ['Send reminders to guests', 'email reminder invite calendar', 'stream', '#wizOpen', 'Go live → Schedule'],
  ['Make a thumbnail', 'thumbnail cover image ai', 'stream', '#wizOpen', 'Go live → Schedule → Thumbnail'],
  ['Vertical video for TikTok, Reels, Shorts', 'vertical portrait 9:16 tiktok reels shorts mobile', 'stream', '#aspectSeg', 'Go live → Format'],
  ['Turn on live captions', 'captions subtitles transcript accessibility', 'show', '#capSwitch', 'Show → Live captions'],
  ['Show Twitch or Rumble chat on stage', 'chat overlay twitch rumble comments', 'show', '#overlaySwitch', 'Show → Chat overlay'],
  ['Switch scenes / layouts', 'scene layout switch arrange', 'layouts', '#editToggle', 'Look → Layout'],
  ['Present slides, a screen or a video', 'present pdf slides screen share video', null, '#shareBtn', 'Present button in the dock'],
  ['Ask your AI', 'ai claude chatgpt gemini grok research', 'ai', '#aiInput', 'AI'],
  ['Add a banner or ticker', 'banner lower third ticker headline', 'banners', '#bannerText', 'Show → Banner'],
  ['Change stage colours, fonts and animations', 'brand colour color font animation style', 'brand', '#fontSel', 'Look → Brand'],
  ['Add my logo or an overlay', 'logo overlay watermark frame', 'brand', '#logoPick', 'Look → Brand → Logo'],
  ['Show my PayPal, Venmo or Cash App', 'tip donate paypal venmo cash app stripe support', 'brand', '#tipList', 'Look → Brand → Support links'],
  ['Change my name or photo', 'name nickname photo avatar profile', null, '#userBtn', 'Your account (top right)'],
  ['Change my password', 'password reset account security', null, '#userBtn', 'Your account → Change password'],
  ['Record the show', 'record recording save download', null, '#recBtn', 'Record button in the dock'],
  ['A guest can’t connect', 'connect firewall turn network corporate', 'settings', '#turnUrl', 'Settings → Your own relay server'],
  ['Switch to light mode', 'light dark theme appearance', 'settings', '#themeSeg', 'Settings → Appearance'],
];
const POPULAR = [3, 2, 5, 10, 14, 17];
function helpGo(row) {
  const [, , tab, sel] = row;
  const hits = store.get('helpHits', {}); hits[row[0]] = (hits[row[0]] || 0) + 1; rawSet('helpHits', hits);
  if ($('#helpDlg').open) $('#helpDlg').close();
  if (tab) setTab(tab);
  if (sel === '#userBtn') return openAccount();
  if (sel === '#wizOpen') { setTab('stream'); return openWizard(); }
  const el = $(sel);
  if (!el) return;
  setTimeout(() => {
    el.scrollIntoView({ behavior: smooth(), block: 'center' });
    const box = el.closest('.fld, .toggle-row, .toggle-inline, .icon-btn, .btn, .seg') || el;
    box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
    if (el.focus) el.focus({ preventScroll: true });
  }, 120);
}
function helpRow(row) {
  const li = document.createElement('li');
  const b = document.createElement('button'); b.type = 'button'; b.className = 'menu-item help-item';
  const t = document.createElement('b'); t.textContent = row[0];
  const w = document.createElement('span'); w.textContent = row[4];
  b.append(t, w); b.onclick = () => helpGo(row);
  li.append(b); return li;
}
function renderHelp() {
  const q = $('#helpSearch').value.trim().toLowerCase();
  const hits = store.get('helpHits', {});
  const popular = [...POPULAR.map((i) => HELP[i]), ...HELP].filter((r, i, a) => a.indexOf(r) === i)
    .sort((a, b) => (hits[b[0]] || 0) - (hits[a[0]] || 0)).slice(0, 6);
  $('#helpPopular').replaceChildren(...popular.map(helpRow));
  $('#helpPopWrap').hidden = !!q;
  const words = q.split(/\s+/).filter(Boolean);
  const res = q ? HELP.filter((r) => words.every((w) => (r[0] + ' ' + r[1] + ' ' + r[4]).toLowerCase().includes(w))) : [];
  $('#helpResults').replaceChildren(...res.map(helpRow));
  $('#helpNone').hidden = !q || !!res.length;
}
$('#helpSearch').addEventListener('input', renderHelp);
$('#helpSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = $('#helpResults .help-item'); first?.click(); } });

// ---------------------------------------------------------------- recording
// ---------------------------------------------------------------- go live: program → relay → YouTube, Twitch, …
// The finished program (the same canvas and mix as a recording) goes over a WebSocket to the gather relay, which
// hands it to FFmpeg and on to every destination at once. H.264 from the browser is passed through untouched.
const PLATFORMS = {
  youtube: { name: 'YouTube', url: 'rtmp://a.rtmp.youtube.com/live2', hint: 'YouTube Studio → Go live → Stream key' },
  twitch: { name: 'Twitch', url: 'rtmp://live.twitch.tv/app', hint: 'Twitch → Creator Dashboard → Settings → Stream → Primary stream key' },
  kick: { name: 'Kick', url: '', hint: 'Kick → Settings → Stream URL and Stream key' },
  facebook: { name: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp', hint: 'Facebook → Live Producer → Streaming software → Stream key' },
  x: { name: 'X', url: '', hint: 'X Media Studio → Producer → RTMP URL and Stream key' },
  rumble: { name: 'Rumble', url: '', hint: 'Rumble → Go Live → Stream URL and Stream key' },
  custom: { name: 'Other', url: '', hint: 'Any RTMP or RTMPS server URL and key' },
};
S.relayOn = false;
S.live = null;
let L_STATUS = {}; // per destination (index in liveDests) while live: {state: 'live'|'failed', reason}
const CONNECT_TIMEOUT = 60_000; // a free relay can take ~30–50 s to wake
const liveDests = () => store.get('liveDests', []); // local only: never synced, never sent to gather's server
function saveDests(list) { store.set('liveDests', list); renderLive(); }
function pickLiveMime() {
  const opts = [['video/webm;codecs=h264,opus', 'h264'], ['video/webm;codecs=avc1,opus', 'h264'], ['video/mp4;codecs=avc1,opus', 'h264'], ['video/webm;codecs=vp8,opus', 'vp8'], ['video/webm;codecs=vp9,opus', 'vp9']];
  const hit = opts.find(([m]) => window.MediaRecorder?.isTypeSupported?.(m));
  return hit ? { mimeType: hit[0], video: hit[1] } : null;
}
function renderDests(force) {
  const list = liveDests(), live = !!S.live, box = $('#destList');
  // Someone joining or leaving re-renders the studio; never rebuild the list under a host who is typing a key.
  if (!force && box.contains(document.activeElement) && box.children.length === list.length) {
    box.querySelectorAll('input, [data-del]').forEach((el) => { el.disabled = live; });
    return;
  }
  box.replaceChildren(...list.map((d, i) => {
    const p = PLATFORMS[d.kind] || PLATFORMS.custom;
    const li = document.createElement('li'); li.className = 'dest' + (d.on ? '' : ' off');
    li.innerHTML = `<div class="dest-top"><span class="pill caps src-${d.kind}"></span><label class="toggle-inline"><input type="checkbox" class="toggle sm" data-k="on"><span>Send</span></label><button type="button" class="icon-btn sm" data-del aria-label="Remove"><svg class="i sm" aria-hidden="true"><use href="/icons.svg#i-trash-2"/></svg></button></div>
      <input data-k="url" spellcheck="false" aria-label="Server URL" placeholder="rtmps://…">
      <input data-k="key" type="password" autocomplete="off" spellcheck="false" aria-label="Stream key" placeholder="Stream key">
      <input data-k="watch" spellcheck="false" aria-label="Public watch link" placeholder="Watch link for viewers (optional)">
      <p class="hint"></p>`;
    li.querySelector('.pill').textContent = p.name;
    li.querySelector('.hint').textContent = p.hint;
    li.querySelector('[data-k="on"]').checked = !!d.on;
    li.querySelector('[data-k="url"]').value = d.url || '';
    li.querySelector('[data-k="key"]').value = d.key || '';
    li.querySelector('[data-k="watch"]').value = d.watch || '';
    const put = (inp) => { const all = liveDests(); all[i] = { ...all[i], [inp.dataset.k]: inp.type === 'checkbox' ? inp.checked : inp.value.trim() }; return all; };
    li.querySelectorAll('input').forEach((inp) => {
      inp.disabled = live;
      // Save every keystroke (so a re-render can't lose it), and refresh the Go live button on change.
      if (inp.type !== 'checkbox') inp.addEventListener('input', () => store.set('liveDests', put(inp)));
      inp.addEventListener('change', () => saveDests(put(inp)));
    });
    if (L_STATUS[i]) { const s = document.createElement('p'); s.className = 'dest-state ' + L_STATUS[i].state; s.textContent = L_STATUS[i].state === 'failed' ? `✗ Not reaching ${p.name}: ${L_STATUS[i].reason}` : `✓ Live on ${p.name}`; li.append(s); }
    li.querySelector('[data-del]').disabled = live;
    li.querySelector('[data-del]').onclick = () => { const all = liveDests(); all.splice(i, 1); saveDests(all); };
    return li;
  }));
}
$('#destAdd').onchange = (e) => {
  const kind = e.target.value; e.target.value = '';
  if (!kind) return;
  saveDests([...liveDests(), { kind, url: PLATFORMS[kind].url, key: '', on: true }]);
  $('#destList li:last-child [data-k="' + (PLATFORMS[kind].url ? 'key' : 'url') + '"]')?.focus();
};
const readyDests = () => liveDests().filter((d) => d.on && /^rtmps?:\/\//i.test(d.url || '') && (d.key || d.kind === 'custom'));
/** The public page viewers can watch a destination on, as the host typed it (optional). */
function watchUrl(d) {
  let w = String(d.watch || '').trim();
  if (w && !/^https?:\/\//i.test(w)) w = 'https://' + w;
  return /^https:\/\//i.test(w) ? w : '';
}
const watchLink = () => watchLinkUrl();
$('#watchCopy').onclick = () => copy(watchLink(), 'Watch page link copied.');
function fmtClock(ms) { const s = Math.floor(ms / 1000); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n, i) => (i ? String(n).padStart(2, '0') : n)).join(':').replace(/^0:/, ''); }
function renderLive() {
  const host = isHost(), L = S.live, on = L?.phase === 'live';
  $('#liveOff').hidden = S.relayOn;
  for (const id of ['#destList', '#destAdd', '#liveNote', '#liveBtn']) $(id).hidden = !S.relayOn;
  $('#destAdd').parentElement.hidden = !S.relayOn;
  renderDests();
  const n = readyDests().length;
  const waking = L?.phase === 'connecting' && Date.now() - L.t1 > 6000;
  const label = !L ? (n ? `Go live on ${n} platform${n === 1 ? '' : 's'}` : 'Go live') : L.phase === 'live' ? 'End the stream' : L.phase === 'stopping' ? 'Ending…' : waking ? 'Waking the live relay… (Cancel)' : 'Connecting… (Cancel)';
  // Say why the button is dimmed instead of leaving the host to guess.
  const all = liveDests();
  $('#liveWhy').hidden = !!L || !!n || !S.relayOn;
  $('#liveWhy').textContent = !host ? 'Only the host can go live.' : !S.studio ? 'Enter your studio first.' : !all.length ? 'Add where to stream: pick a platform above.' : !all.some((d) => d.on) ? 'Turn on Send for at least one destination.' : `${(PLATFORMS[all.find((d) => d.on)?.kind] || PLATFORMS.custom).name} needs ${all.find((d) => d.on && !/^rtmps?:\/\//i.test(d.url || '')) ? 'a server URL starting with rtmp:// or rtmps://' : 'a stream key'}. ${(PLATFORMS[all.find((d) => d.on)?.kind] || PLATFORMS.custom).hint}.`;
  $('#liveBtn').textContent = label;
  $('#liveBtn').disabled = !host || !S.studio || (!L && !n) || L?.phase === 'stopping';
  $('#liveBtn').classList.toggle('ending', on);
  $('#liveTop').classList.toggle('on-air', !!L);
  $('#livePillText').textContent = on ? 'Live ' + fmtClock(Date.now() - L.t0) : L ? 'Starting…' : 'Go live';
  $('#liveStats').hidden = !L;
  $('#watchRow').hidden = !S.relayOn || !S.studio;
  if (L) $('#liveStats').textContent = waking ? 'The live relay is starting up. This can take up to a minute the first time.' : on && L.stats ? [`Live on ${L.names.filter((x) => !(L.failed || []).includes(x)).join(', ') || 'nothing yet'}`, L.failed?.length && `${L.failed.join(', ')} failed`, L.stats.kbps != null && `${Math.round(L.stats.kbps).toLocaleString()} kbps`, L.stats.fps && `${Math.round(L.stats.fps)} fps`, L.slow && 'your upload is struggling'].filter(Boolean).join(' · ') : L.phase === 'connecting' ? 'Connecting to the relay…' : L.phase === 'live' ? `Live on ${L.names.join(', ')}` : '';
}
async function goLive() {
  if (S.live) return stopLive();
  if (!isHost() || !S.studio) return;
  const all = liveDests(), ready = readyDests(), dests = ready;
  const idx = all.map((d, i) => [d, i]).filter(([d]) => d.on && /^rtmps?:\/\//i.test(d.url || '') && (d.key || d.kind === 'custom')).map(([, i]) => i);
  if (!dests.length) { setTab('stream'); return toast('Add a destination and its stream key first.', { err: true }); }
  L_STATUS = {};
  const mime = pickLiveMime();
  if (!mime || !canvas.captureStream) return toast('This browser can’t stream. Use Chrome or Edge.', { err: true });
  S.live = { phase: 'connecting', names: dests.map((d) => (PLATFORMS[d.kind] || PLATFORMS.custom).name), warned: new Set(), t1: Date.now() };
  renderLive();
  const Lc = S.live;
  // Never hang on "Connecting…": say we're waking the relay, then give up with a clear message.
  Lc.wakeTimer = setInterval(() => { if (S.live !== Lc || Lc.phase !== 'connecting') return clearInterval(Lc.wakeTimer); renderLive(); }, 1000);
  Lc.giveUp = setTimeout(() => {
    if (S.live !== Lc || Lc.phase !== 'connecting') return;
    try { Lc.ws?.close(4100); } catch {}
    endLive(Lc);
    toast('The live relay didn’t answer, so nothing went out. Try Go live again in a moment.', { err: true, ms: 10000, action: ['Try again', goLive] });
  }, CONNECT_TIMEOUT);
  let url;
  try { ({ url } = await api('relay', creds())); }
  catch (e) { S.live = null; renderLive(); return toast(e.message, { err: true }); }
  audioCtx();
  const L = S.live;
  const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; L.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'start', video: mime.video, dests: dests.map((d) => ({ url: d.url, key: d.key })) }));
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'ready') startFeed(L, mime);
    else if (m.t === 'dest') {
      const at = idx[m.i]; if (at == null) return;
      L_STATUS[at] = { state: m.state, reason: m.reason || '' };
      const nm = (PLATFORMS[all[at]?.kind] || PLATFORMS.custom).name;
      if (m.state === 'failed') { L.failed = [...(L.failed || []), nm]; toast(`Not reaching ${nm}: ${m.reason}. The other destinations keep going.`, { err: true, ms: 10000 }); }
      renderDests(true); renderLive();
    }
    else if (m.t === 'live' && L.phase === 'connecting') {
      clearTimeout(L.giveUp);
      L.phase = 'live'; L.t0 = Date.now(); L.timer = setInterval(renderLive, 1000); renderDock();
      setTimeout(() => { if (S.live !== L) return; const ok = L.names.filter((n) => !(L.failed || []).includes(n)); toast(ok.length ? `You’re live on ${ok.join(' and ')}.${L.failed?.length ? ` ${L.failed.join(' and ')} failed.` : ''}` : 'The relay is running, but no destination accepted the stream.', { err: !ok.length || !!L.failed?.length }); }, 1500);
      setStage({ live: { on: true, since: L.t0, links: dests.map((d) => ({ kind: d.kind, url: watchUrl(d) })).filter((x) => x.url) } });
    }
    else if (m.t === 'stats') { L.stats = m; renderLive(); }
    else if (m.t === 'warn' && !L.warned.has(m.message)) { L.warned.add(m.message); toast('Streaming problem: ' + m.message, { err: true }); }
    else if (m.t === 'error') toast(m.message, { err: true });
  };
  ws.onclose = (ev) => {
    if (S.live !== L) return;
    const expected = L.phase === 'stopping';
    endLive(L);
    if (!expected) toast(ev.code === 1006 ? 'The stream stopped: lost the connection to the relay.' : 'The stream stopped.', { err: true });
    else toast('Stream ended.');
  };
}
function startFeed(L, mime) {
  const vs = canvas.captureStream(30);
  const stream = new MediaStream([...vs.getVideoTracks(), ...recDest.stream.getAudioTracks()]);
  let rec;
  try { rec = new MediaRecorder(stream, { mimeType: mime.mimeType, videoBitsPerSecond: 4_500_000, audioBitsPerSecond: 160_000, videoKeyFrameIntervalDuration: 2000 }); }
  catch (e) { toast('Could not start the stream: ' + e.message, { err: true }); L.ws.close(1000); return; }
  rec.ondataavailable = async (e) => {
    if (!e.data.size || L.ws.readyState !== 1) return;
    L.ws.send(await e.data.arrayBuffer());
    const behind = L.ws.bufferedAmount;
    L.slow = behind > 4_000_000;
    if (behind > 40_000_000) { toast('Your upload can’t keep up, so the stream was stopped. Try a wired connection.', { err: true }); stopLive(); }
  };
  rec.start(250);
  Object.assign(L, { rec, vs });
}
function stopLive() {
  const L = S.live;
  if (!L || L.phase === 'stopping') return;
  L.phase = 'stopping'; renderLive();
  try { L.rec?.state !== 'inactive' && L.rec?.stop(); } catch {}
  setTimeout(() => { try { L.ws?.close(1000); } catch {} }, 600);
  setTimeout(() => { if (S.live === L) endLive(L); }, 4000);
}
function endLive(L) {
  clearInterval(L.timer); clearTimeout(L.giveUp); clearInterval(L.wakeTimer); L_STATUS = {};
  if (L.phase === 'live' || L.t0) setStage({ live: null });
  try { L.rec?.state !== 'inactive' && L.rec?.stop(); } catch {}
  L.vs?.getTracks().forEach((t) => t.stop());
  S.live = null; renderLive(); renderDock();
}
$('#liveBtn').onclick = goLive;
let wokeAt = 0;
/** Opening Go live wakes a sleeping relay, so it's ready by the time the host clicks. */
function wakeRelay() {
  if (!S.relayOn || !isHost() || !S.studio || Date.now() - wokeAt < 5 * 60_000) return;
  wokeAt = Date.now();
  api('relayWake', creds()).catch(() => {});
}

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
    if (isHost()) setStage({ rec: null });
    renderDock();
    showRecording(blob, dur);
  };
  recorder.start(1000);
  S.rec = { recorder, t0, timer: setInterval(renderDock, 500) };
  wsSend({ type: 'recording', on: true });
  if (isHost()) setStage({ rec: { on: true, since: t0 } }); // everyone sees the REC badge for as long as it runs
  toast('Recording the stage. Everything you see is captured.');
  renderDock();
}
let lastRecUrl = null, lastRec = null, driveBusy = false;
function renderDriveButton() {
  const b = $('#recDrive');
  b.disabled = !googleConfigured() || driveBusy || !!lastRec?.saved;
  b.lastChild.textContent = lastRec?.saved ? 'Saved to Drive' : driveBusy ? 'Uploading…' : 'Save to Google Drive';
  if (!googleConfigured()) b.dataset.tip = 'Google sign-in isn’t set up on this server yet';
}
async function uploadRecording() {
  if (!lastRec || driveBusy) return;
  const rec = lastRec;
  driveBusy = true; renderDriveButton();
  const bar = $('#recDriveBar'), note = $('#recDriveNote');
  bar.hidden = false; note.hidden = false; note.textContent = 'Connecting to Google Drive…'; bar.firstElementChild.style.width = '0%';
  try {
    const file = await saveToDrive(rec.blob, rec.name, (f) => {
      bar.firstElementChild.style.width = Math.round(f * 100) + '%';
      note.textContent = `Uploading to Drive · ${Math.round(f * 100)}% of ${(rec.blob.size / 1048576).toFixed(1)} MB`;
    });
    rec.saved = file;
    note.replaceChildren(document.createTextNode('Saved to Drive → gather recordings. '));
    if (file.webViewLink) { const a = document.createElement('a'); a.href = file.webViewLink; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open in Drive'; note.append(a); }
    if (!$('#recDlg').open) toast('Recording saved to Google Drive.');
  } catch (e) {
    note.textContent = e.message;
    bar.hidden = true;
  } finally { driveBusy = false; renderDriveButton(); renderGoogle(); }
}
$('#recDrive').onclick = uploadRecording;
function showRecording(blob, dur) {
  if (lastRecUrl) URL.revokeObjectURL(lastRecUrl);
  lastRecUrl = URL.createObjectURL(blob);
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  $('#recVideo').src = lastRecUrl;
  $('#recDownload').href = lastRecUrl;
  $('#recDownload').download = `gather-${S.studio || 'studio'}-${stamp}.${ext}`;
  $('#recInfo').textContent = `${fmtTime(dur)} long · ${(blob.size / 1048576).toFixed(1)} MB · ${ext.toUpperCase()}`;
  lastRec = { blob, name: $('#recDownload').download, saved: null };
  $('#recDriveBar').hidden = true; $('#recDriveNote').hidden = true;
  renderDriveButton();
  $('#recDlg').showModal();
  if (store.get('driveAuto', false)) {
    if (googleSignedIn('drive')) uploadRecording();
    else { $('#recDriveNote').hidden = false; $('#recDriveNote').textContent = 'Your Google sign-in has expired. Click Save to Google Drive to sign in again and upload.'; }
  }
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
  setMsgData(li, fm);
  li.append(who, txt, msgActions(fm));
  appendLog(li);
  applyModeration(li);
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
  $('#chatInput').value = ''; autoGrow($('#chatInput'));
});

// ---------------------------------------------------------------- rendering
function setPhase(p) {
  S.phase = p;
  const pill = $('#statusPill');
  pill.dataset.state = p === 'online' ? 'online' : p === 'offline' ? 'offline' : 'connecting';
  $('#statusText').textContent = { offline: 'Offline', connecting: 'Connecting…', online: '', reconnecting: 'Reconnecting…' }[p];
  pill.hidden = p === 'online';
  renderAll();
}
function renderAll() { renderHeader(); renderStageUI(); renderCrew(); renderDock(); renderPanels(); renderFeedUI(); renderLayoutsPanel(); renderAIPanel(); renderTips(); renderBrandPanel(); renderStreamPanel(); renderGuestView(); syncTwitch(); syncCaptions(); renderDeck(); renderAds(); renderProducerUI(); renderGreenRoom(); renderLive(); renderWatchSec(); }
function renderHeader() {
  // The studio name belongs to the studio you're in; outside one the header is just the wordmark.
  const inside = !!S.studio || S.phase === 'reconnecting';
  $('#topTitle').hidden = !inside;
  if (document.activeElement !== $('#studioTitle')) $('#studioTitle').textContent = S.state.title || DEFAULT_TITLE;
  $('#studioTitle').classList.toggle('editable', isHost());
  $('#studioTitle').title = isHost() ? 'Click to rename the show' : '';
  $('#enterTop').hidden = !S.studio;
  if ($('#watchTop')) $('#watchTop').hidden = !S.studio || !isHost();
  $('#liveTop').hidden = !S.studio || !isHost();
  document.body.classList.toggle('pre', !S.studio && S.phase !== 'reconnecting'); // landing: just the stage hero
  // Scheduled shows: on the landing page they sit under the hero (that's where you start one); inside a studio, in Go live.
  const upHome = document.body.classList.contains('pre') ? $('#landing .land-copy') : $('#liveDlg .live-body');
  if ($('#upBlock').parentElement !== upHome) upHome.append($('#upBlock'));
}
function renderStageUI() {
  renderScenes();
  $('#hostNote').hidden = isHost();
}
const ICON = { stage: icon('monitor', { size: 'sm' }), mute: icon('mic-off', { size: 'sm' }), kick: icon('log-out', { size: 'sm' }) };
function renderCrew() {
  const list = $('#crewList'), add = $('.crew-add');
  const people = S.studio ? participants() : [];
  $('#crewCount').textContent = `${people.length} / ${MAX}`;
  $('#peopleTabCount').textContent = people.length || '';
  const keep = new Set(people.map((p) => 'card-' + cssId(p.id)));
  for (const li of $$('.crew-card', list)) if (!keep.has(li.id)) li.remove();
  const host = isHost();
  for (const p of people) {
    let li = $('#card-' + cssId(p.id));
    if (!li) {
      li = document.createElement('li'); li.className = 'crew-card'; li.id = 'card-' + cssId(p.id); li.dataset.id = p.id;
      li.innerHTML = `<div class="crew-thumb"><video autoplay playsinline></video><div class="ini" hidden><span></span></div><div class="tagrow"></div>`
        + `<div class="crew-tools"><button type="button" class="icon-btn sm on-media ct-stage" aria-pressed="false">${ICON.stage}</button><button type="button" class="icon-btn sm on-media ct-mute" aria-label="Ask to mute">${ICON.mute}</button><button type="button" class="icon-btn sm on-media danger ct-kick" aria-label="Remove from studio">${ICON.kick}</button></div></div>`
        + `<div class="crew-info"><div class="crew-name"><span class="nm"></span></div><div class="crew-sub"></div></div>`;
      const v = $('video', li);
      if (p.me) { v.muted = true; const ov = outVideo(); if (ov) v.srcObject = new MediaStream([ov]); v.classList.toggle('mirror', !!S.videoFx.mirror); }
      else if (p.peer.stream.getTracks().length) { v.srcObject = p.peer.stream; playEl(v); }
      $('.ct-stage', li).addEventListener('click', () => toggleStage(p.id));
      // the host clicks someone's picture to bring them on stage or send them backstage
      $('.crew-thumb', li).addEventListener('click', (ev) => { if (isHost() && !ev.target.closest('.crew-tools')) toggleStage(p.id); });
      $('.ct-mute', li).addEventListener('click', () => { wsSend({ type: 'mute', id: p.id }); toast(`Muted ${p.name}.`); });
      $('.ct-kick', li).addEventListener('click', () => {
        const btn = $('.ct-kick', li);
        if (!btn.classList.contains('confirm')) { btn.classList.add('confirm'); btn.setAttribute('aria-label', 'Click again to remove'); setTimeout(() => { btn.classList.remove('confirm'); btn.setAttribute('aria-label', 'Remove from studio'); }, 3000); return; }
        wsSend({ type: 'kick', id: p.id }); toast(`${p.name} was removed. Lock the studio to keep them out.`);
      });
      list.insertBefore(li, add);
    }
    list.insertBefore(li, add); // keep join order
    $('.nm', li).textContent = p.me ? `${p.name} (you)` : p.name;
    const nameRow = $('.crew-name', li);
    nameRow.querySelector('.muted-ic')?.remove();
    if (!p.mic) nameRow.insertAdjacentHTML('beforeend', `<span class="muted-ic" role="img" aria-label="Muted">${icon('mic-off', { size: 'sm' })}</span>`);
    const ini = $('.ini', li); ini.hidden = !!p.cam;
    const bg = assetImg(p.offbg);
    ini.style.backgroundImage = bg ? `url("${bg.src}")` : '';
    const avImg = assetImg(p.avatar), span = $('span', ini);
    if (avImg) { span.textContent = ''; span.style.backgroundImage = `url("${avImg.src}")`; span.classList.add('has-av'); }
    else { span.textContent = initials(p.name); span.style.backgroundImage = ''; span.classList.remove('has-av'); }
    const tags = $('.tagrow', li); tags.replaceChildren();
    const on = S.state.stage.includes(p.id);
    if (p.id === S.host) tags.insertAdjacentHTML('beforeend', '<span class="pill caps on-media">Host</span>');
    tags.insertAdjacentHTML('beforeend', on ? '<span class="pill caps accent">On stage</span>' : '<span class="pill caps on-media">Backstage</span>'); // "Live" only ever means broadcasting
    $('.crew-thumb', li).classList.toggle('pickable', host);
    $('.crew-thumb', li).title = host ? (on ? `Click to send ${p.me ? 'yourself' : p.name} backstage` : `Click to put ${p.me ? 'yourself' : p.name} on stage`) : '';
    if (p.sharing) tags.insertAdjacentHTML('beforeend', '<span class="pill caps on-media">Presenting</span>');
    li.classList.toggle('on-stage', on);
    $('.crew-tools', li).hidden = !host;
    const st = $('.ct-stage', li); st.setAttribute('aria-label', on ? 'Take off stage' : 'Put on stage'); st.setAttribute('aria-pressed', String(on));
    $('.ct-mute', li).hidden = !!p.me || !p.mic;
    $('.ct-kick', li).hidden = !!p.me;
  }
  renderCrewSubs();
  add.hidden = people.length >= MAX;
}
function renderCrewSubs() {
  for (const p of participants()) {
    const sub = $(`#card-${cssId(p.id)} .crew-sub`);
    if (!sub) continue;
    if (p.me) sub.textContent = S.local.pres ? `Presenting ${{ screen: 'a screen', video: 'a video', pdf: 'slides' }[S.local.pres.kind]}` : S.local.camOn ? (S.local.micOn ? 'Camera and mic on' : 'Camera on · muted') : 'Camera off';
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
  share.classList.toggle('active', !!S.local.pres);
  $('#shareLabel').textContent = S.local.pres ? 'Stop presenting' : 'Present';
  share.disabled = !S.studio;
  rec.classList.toggle('recording', !!S.rec);
  rec.setAttribute('aria-pressed', String(!!S.rec));
  $('#skipDock').hidden = !S.studio;
  rec.setAttribute('aria-label', S.rec ? `Stop recording (${fmtTime(Date.now() - S.rec.t0)})` : 'Record');
  $('#recLabel').textContent = S.rec ? fmtTime(Date.now() - S.rec.t0) : 'Record';
  rec.disabled = !S.studio;
  // Everyone in the studio sees when the show is recorded or live, not just the host (consent).
  const shared = S.studio ? S.state : null, onAir = !!(S.live?.phase === 'live' || shared?.live?.on), recSince = S.rec?.t0 || (shared?.rec?.on && shared.rec.since);
  $('#recPill').hidden = !recSince && !(onAir && !isHost());
  $('#recPill').classList.toggle('compact', !!recSince && onAir);
  $('#recPillText').textContent = recSince ? 'Rec ' + fmtTime(Date.now() - recSince) : 'Live';
  $('#recPill').title = recSince ? 'This show is being recorded' : 'This show is live';
  $('#leaveBtn').disabled = !S.studio;
  renderDockNote();
}
// ---------------------------------------------------------------- first-run guide: one next step at a time, in the dock
// Four steps for a new host (the show is named automatically). Each ticks itself off from what actually happened (camera and mic on,
// a guest invited, a scene picked, recording or live), so it never asks you to confirm anything. Shown once.
const GUIDE = [
  { id: 'av', label: 'Turn on camera and mic', done: () => !!(S.local.camOn && S.local.micOn && S.local.audio), go: () => openDlg('settingsDlg') },
  { id: 'invite', label: 'Invite a guest', done: () => S.guide.invited || S.peers.size > 0, go: () => openInvite() },
  { id: 'scene', label: 'Pick a scene', done: () => S.guide.scened, go: () => { $('#deck')?.scrollIntoView({ behavior: smooth(), block: 'center' }); $('#sceneStrip .scene:not(.on)')?.focus(); } },
  { id: 'show', label: 'Record or go live', done: () => !!(S.rec || S.live?.phase === 'live'), go: () => openDlg('liveDlg') },
];
S.guide = { ...{ dismissed: false, finished: false, invited: false, scened: false }, ...store.get('guide', {}) };
function saveGuide() { store.set('guide', { dismissed: S.guide.dismissed, finished: S.guide.finished, invited: S.guide.invited, scened: S.guide.scened }); }
function revealSide() { if (innerWidth <= 900) $('#side')?.scrollIntoView({ behavior: smooth() }); }
function renderGuide() {
  const el = $('#guide');
  const active = isHost() && !!S.studio && !S.guide.dismissed && !S.guide.finished;
  if (!active) { el.hidden = true; return false; }
  const states = GUIDE.map((g) => !!g.done());
  const next = GUIDE.findIndex((g, i) => !states[i]);
  if (next < 0) { S.guide.finished = true; saveGuide(); el.hidden = true; toast('Your studio is ready. Have a great show.'); return false; }
  el.hidden = false;
  $('#guideProg').textContent = `Getting started · ${states.filter(Boolean).length} of ${GUIDE.length} done`;
  $('#guideStep').textContent = GUIDE[next].label;
  $('#guideGo').dataset.step = GUIDE[next].id;
  $('#guideDots').replaceChildren(...GUIDE.map((g, i) => { const d = document.createElement('i'); d.className = states[i] ? 'done' : i === next ? 'now' : ''; return d; }));
  return true;
}
$('#guideGo').onclick = () => GUIDE.find((g) => g.id === $('#guideGo').dataset.step)?.go();
$('#guideSkip').onclick = () => { S.guide.dismissed = true; saveGuide(); renderDock(); toast('Guide hidden. Help has everything it covered.'); };
function guideMark(k) { if (S.guide[k] || S.guide.finished) return; S.guide[k] = true; saveGuide(); renderDock(); }

function renderDockNote() {
  const el = $('#dockNoteText');
  $('#dockNote').hidden = (!S.studio && S.phase !== 'reconnecting') || renderGuide();
  $('#noteInvite').hidden = !S.studio;
  if (!S.studio) { el.textContent = S.phase === 'reconnecting' ? 'Reconnecting to your studio…' : ''; return; }
  const peers = [...S.peers.values()];
  $('#noteInvite').hidden = false; $('#noteCodeText').textContent = S.studio;
  if (!peers.length) { el.textContent = 'Waiting for guests'; return; }
  const up = peers.filter((p) => p.conn === 'connected');
  const rtts = up.map((p) => p.rtt).filter((x) => x != null);
  const avg = rtts.length ? ` · ${Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)} ms avg` : '';
  el.textContent = `${up.length} peer connection${up.length === 1 ? '' : 's'}${up.length < peers.length ? ` (${peers.length - up.length} connecting)` : ''}${avg}`;
}
function renderPanels() {
  const host = isHost();
  for (const id of ['bannerShow', 'bannerHide', 'tickerShow', 'tickerHide', 'colorPick', 'namesChk']) $('#' + id).disabled = !host;
  $$('#swatches button, #bgs button, #bannerPresets .use').forEach((b) => (b.disabled = !host));
  $('#bannerHint').textContent = host ? 'Banners appear on every participant’s stage and in recordings.' : 'Only the host can show banners. You’ll see them on your stage.';
  $('#brandHint').textContent = host ? 'Brand changes apply to everyone in the studio.' : 'Only the host can change the brand.';
  const b = S.state.brand;
  $$('#swatches button').forEach((x) => x.classList.toggle('on', x.dataset.color.toLowerCase() === b.color.toLowerCase()));
  $$('#bgs button').forEach((x) => x.classList.toggle('on', x.dataset.bg === b.bg));
  $('#colorPick').value = b.color;
  $('#namesChk').checked = b.names;
  if (document.activeElement !== $('#titleInput')) $('#titleInput').value = S.state.title || '';
  renderPresets();
  $('#chatInput').disabled = !S.studio;
  $('#chatInput').placeholder = S.studio ? 'Message the studio…' : 'Enter a studio to chat';
  $('#chatEmptyText').innerHTML = S.studio ? 'No messages yet.<br>Everyone in the studio sees what you send.' : 'No messages yet.<br>Enter a studio to chat.';
  $('#chatEmpty').hidden = !!$('#msgs').children.length;
}
function renderBannerState() {
  const live = S.state.banner, text = $('#bannerText').value.trim(), sub = $('#bannerSub').value.trim();
  const edited = !!live && (text !== live.text || sub !== (live.sub || ''));
  $('#bannerEdited').hidden = !edited;
  $('#bannerShow').textContent = edited ? 'Update banner' : 'Show on stage';
}
$('#bannerText').addEventListener('input', renderBannerState);
$('#bannerSub').addEventListener('input', renderBannerState);
function renderPresets() {
  renderBannerState();
  const presets = store.get('presets', DEFAULT_PRESETS);
  const ul = $('#bannerPresets');
  const live = S.state.banner?.text;
  ul.replaceChildren(...presets.map((text, i) => {
    const li = document.createElement('li'); li.className = 'preset' + (live === text ? ' live' : '');
    const p = document.createElement('p'); p.textContent = text;
    const row = document.createElement('div'); row.className = 'row';
    const use = document.createElement('button'); use.className = 'btn sm use'; use.textContent = live === text ? 'On stage' : 'Use banner'; use.disabled = !isHost();
    use.onclick = () => { $('#bannerText').value = text; $('#bannerSub').value = ''; showBanner(); };
    const del = document.createElement('button'); del.type = 'button'; del.className = 'icon-btn sm del'; del.innerHTML = icon('trash-2', { size: 'sm' }); del.setAttribute('aria-label', 'Delete preset');
    del.onclick = () => { const list = store.get('presets', DEFAULT_PRESETS); list.splice(i, 1); store.set('presets', list); renderPresets(); };
    row.append(use, del); li.append(p, row); return li;
  }));
}

// ---------------------------------------------------------------- panels & controls
// Four tabs in the rail (Chat, Show, Look, AI). Go live, Settings and Help are dialogs; older names still work.
const TAB_ALIAS = { banners: 'show', stream: 'dlg:liveDlg', settings: 'dlg:settingsDlg', help: 'dlg:helpDlg', layouts: 'look:layouts', brand: 'look:brand', look: 'look:' };
function openDlg(id) {
  for (const other of ['liveDlg', 'settingsDlg', 'helpDlg']) if (other !== id && $('#' + other).open) $('#' + other).close();
  const d = $('#' + id);
  if (!d.open) d.showModal();
  if (id === 'settingsDlg') listDevices();
  if (id === 'liveDlg') { renderLive(); wakeRelay(); }
  if (id === 'helpDlg') { $('#helpSearch').value = ''; renderHelp(''); $('#helpSearch').focus(); }
}
function setTab(tab) {
  const a = TAB_ALIAS[tab] || tab;
  if (a.startsWith('dlg:')) return openDlg(a.slice(4));
  let panel = a, rail = a;
  if (a.startsWith('look:')) { S.lookSub = a.slice(5) || S.lookSub || 'layouts'; panel = S.lookSub; rail = 'look'; }
  S.tab = rail;
  document.body.classList.remove('panel-closed'); $('#panelToggle').setAttribute('aria-expanded', 'true');
  $$('.rail-btn').forEach((b) => { const on = b.dataset.tab === rail; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $$('.panel').forEach((p) => (p.hidden = p.dataset.panel !== panel));
  $$('.look-seg [data-look]').forEach((b) => { const on = b.dataset.look === panel; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  if (rail === 'chat') { S.unread = 0; $('#chatBadge').hidden = true; }
  if (panel !== 'layouts' && editor.on) setEditing(false);
}
$$('.rail-btn').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
// Hide the panel to give the stage the room; any tab brings it back.
$('#panelToggle').onclick = () => {
  const closed = document.body.classList.toggle('panel-closed');
  $('#panelToggle').setAttribute('aria-expanded', !closed);
  $('#panelToggle').dataset.tip = closed ? 'Show the panel' : 'Hide the panel';
  if (closed) $$('.rail-btn').forEach((x) => { x.classList.remove('on'); x.removeAttribute('aria-current'); }); else setTab(S.tab);
};
$$('.look-seg [data-look]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.look)));
$('#helpTop').onclick = () => openDlg('helpDlg');
$('#settingsTop').onclick = () => openDlg('settingsDlg');
$('#liveTop').onclick = () => openDlg('liveDlg');

function sceneList() {
  return [...BUILTINS.map((b) => ({ ...b, kind: 'builtin' })), ...(isVertical() ? V_TEMPLATES : TEMPLATES).map((t) => ({ ...t, kind: 'template' })), ...savedLayouts().map((l) => ({ id: 'saved:' + l.name, name: l.name, kind: 'saved', saved: l }))];
}
function activeSceneId() {
  if (S.state.layout !== 'custom') return 'b-' + S.state.layout;
  return S.state.scene || '';
}
function applyScene(sc) {
  if (isHost()) guideMark('scened');
  if (sc.kind === 'builtin') return setStage({ layout: sc.layout, scene: sc.id, elements: sceneElements(sc.id, []) });
  if (sc.kind === 'template') return applyTemplate(sc);
  return loadLayout(sc.saved);
}
function scenePreview(sc) {
  const pv = document.createElement('span'); pv.className = 'sc-pv';
  let els = sc.els || sc.saved?.elements;
  if (sc.kind === 'builtin') {
    const area = { x: 32, y: 44, w: W - 64, h: H - 76 }; // same geometry the stage uses, then scaled to 0..1 (current orientation)
    const n = sc.layout === 'solo' ? 1 : 3;
    els = layoutRects(n, sc.layout, area).map((r) => ({ type: 'slot', x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H }));
  }
  for (const e of drawOrder(els || [])) {
    if (e.hidden || ['captions', 'featured', 'ads'].includes(e.type)) continue;
    const i = document.createElement('i'); i.className = 'pv-' + e.type;
    if (e.type === 'shape') i.style.background = e.color;
    Object.assign(i.style, { left: e.x * 100 + '%', top: e.y * 100 + '%', width: e.w * 100 + '%', height: e.h * 100 + '%' });
    pv.append(i);
  }
  return pv;
}
function renderScenes() {
  const strip = $('#sceneStrip');
  if (!strip) return;
  const active = activeSceneId(), host = isHost();
  const chips = sceneList().map((sc, i) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'tile scene' + (sc.id === active ? ' on' : '') + (sc.kind === 'saved' ? ' saved' : '');
    b.disabled = !host; b.title = `${sc.name}${i < 9 ? ` (${i + 1})` : ''}`;
    b.setAttribute('aria-pressed', String(sc.id === active));
    b.tabIndex = -1; // one tab stop for the whole strip; arrow keys move within it (see sceneKeys)
    const nm = document.createElement('span'); nm.className = 'sc-name'; nm.textContent = sc.name;
    if (i < 9) { const k = document.createElement('kbd'); k.textContent = i + 1; nm.append(k); }
    b.append(scenePreview(sc), nm);
    b.onclick = () => applyScene(sc);
    return b;
  });
  const save = document.createElement('button'); save.type = 'button'; save.className = 'tile scene add'; save.disabled = !host;
  save.innerHTML = `<span class="sc-pv add-pv">${icon('plus')}</span><span class="sc-name">Save scene</span>`;
  save.onclick = () => { setTab('layouts'); $('#layoutName').focus(); };
  save.tabIndex = -1;
  const keep = strip.contains(document.activeElement) ? [...strip.children].indexOf(document.activeElement) : -1;
  strip.replaceChildren(...chips, save);
  const all = [...strip.children];
  const stop = all[keep] || all.find((b) => b.classList.contains('on')) || all[0];
  if (stop) stop.tabIndex = 0;
  if (keep >= 0) stop?.focus();
}
/** Roving tabindex: Tab enters and leaves the scene strip in one step; arrows, Home and End move inside it. */
function sceneKeys(e) {
  const all = [...$('#sceneStrip').children];
  const i = all.indexOf(document.activeElement);
  if (i < 0) return;
  const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 }[e.key];
  if (to == null) return;
  e.preventDefault();
  const next = all[Math.max(0, Math.min(all.length - 1, to))];
  all.forEach((b) => { b.tabIndex = b === next ? 0 : -1; });
  next.focus(); next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
$('#sceneStrip').addEventListener('keydown', sceneKeys);
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
$('#titleInput').addEventListener('change', (e) => setStage({ title: e.target.value.trim().slice(0, 60) }));
// The show title in the header is editable in place by the host: click, type, Enter.
function editTitle() {
  if (!isHost() || !S.studio) return;
  const t = $('#studioTitle');
  t.contentEditable = 'plaintext-only'; t.focus();
  getSelection()?.selectAllChildren(t);
}
$('#studioTitle').addEventListener('click', editTitle);
$('#studioTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } if (e.key === 'Escape') { e.target.textContent = S.state.title || DEFAULT_TITLE; e.target.blur(); } });
$('#studioTitle').addEventListener('blur', (e) => {
  e.target.contentEditable = 'false';
  const v = e.target.textContent.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (isHost() && S.studio && v && v !== (S.state.title || DEFAULT_TITLE)) setStage({ title: v });
  else e.target.textContent = S.state.title || DEFAULT_TITLE;
});
$('#keysChk').checked = store.get('keys', true);
// the phone layout keeps the composer above the fixed dock, whatever the dock's height (the guide adds a row)
new ResizeObserver(() => document.documentElement.style.setProperty('--dock-h', $('.dock').offsetHeight + 'px')).observe($('.dock'));
$('#keysChk').onchange = (e) => store.set('keys', e.target.checked);

// Appearance: dark by default; light or follow the OS on request.
function applyTheme(t) {
  store.set('theme', t);
  if (t !== 'light') t = 'dark';
  document.documentElement.setAttribute('data-theme', t);
  const dark = t === 'dark';
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
  profileSoon({ name: S.name });
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
// Microphone
function saveAudioFx() { store.set('audioFx', S.audioFx); }
for (const [id, key] of [['echoChk', 'echo'], ['nsChk', 'ns'], ['agcChk', 'agc']]) {
  $('#' + id).checked = !!S.audioFx[key];
  $('#' + id).onchange = async (e) => { S.audioFx[key] = e.target.checked; saveAudioFx(); if (S.local.audio) { stopMic(); await startMic(); syncMedia(); } };
}
$('#aiNoiseChk').checked = !!S.audioFx.ai;
$('#aiNoiseChk').onchange = async (e) => {
  S.audioFx.ai = e.target.checked; saveAudioFx();
  if (S.local.audio) { await applyAudioFx(); syncMedia(); }
  toast(e.target.checked ? 'AI noise removal on. Keyboards, fans and traffic fade out.' : 'AI noise removal off.');
};
const gainLabel = () => { $('#micGainVal').textContent = Math.round(S.audioFx.gain * 100) + '%'; };
$('#micGain').value = S.audioFx.gain; gainLabel();
$('#micGain').oninput = async (e) => {
  S.audioFx.gain = Number(e.target.value); gainLabel(); saveAudioFx();
  if (afx) afx.setGain(S.audioFx.gain);
  else if (S.local.audio && Math.abs(S.audioFx.gain - 1) > 0.01) { await applyAudioFx(); syncMedia(); }
};
// Camera
function saveVideoFx() { store.set('videoFx', S.videoFx); }
$('#fpsSelect').value = String(S.videoFx.fps);
$('#fpsSelect').onchange = async (e) => { S.videoFx.fps = Number(e.target.value); saveVideoFx(); if (S.local.camRaw) await S.local.camRaw.applyConstraints(camConstraints()).catch(() => {}); };
$('#mirrorChk').checked = !!S.videoFx.mirror;
$('#mirrorChk').onchange = (e) => { S.videoFx.mirror = e.target.checked; saveVideoFx(); syncMedia(); renderPreview(); };
for (const [id, key] of [['fxBright', 'bright'], ['fxContrast', 'contrast'], ['fxSat', 'sat']]) {
  $('#' + id).value = S.videoFx[key];
  $('#' + id).oninput = async (e) => { S.videoFx[key] = Number(e.target.value); saveVideoFx(); await applyVideoFx(); syncMedia(); };
}
$('#fxReset').onclick = async () => {
  Object.assign(S.videoFx, { bright: 0, contrast: 1, sat: 1 }); saveVideoFx();
  $('#fxBright').value = 0; $('#fxContrast').value = 1; $('#fxSat').value = 1;
  await applyVideoFx(); syncMedia();
};
// Background
function renderBgFx() {
  $$('#bgFxSeg button').forEach((b) => { const on = b.dataset.fx === S.videoFx.effect; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  const hasImg = !!store.get('fxBg', '');
  $('#bgFxImgRow').hidden = !['image', 'green'].includes(S.videoFx.effect);
  $('#bgFxKeyRow').hidden = S.videoFx.effect !== 'green';
  $('#bgFxEdgeRow').hidden = !['blur', 'image'].includes(S.videoFx.effect);
  $('#bgFxBlurRow').hidden = !(S.videoFx.effect === 'blur' || (S.videoFx.effect === 'green' && !hasImg));
  $('#bgFxClear').hidden = !hasImg;
  $('#bgFxThumb').hidden = !hasImg; if (hasImg) $('#bgFxThumb').src = store.get('fxBg', '');
  $('#bgFxNote').textContent = {
    none: 'Your real background.',
    blur: 'Softens everything behind you. Runs on this device; the first use downloads a small model.',
    image: hasImg ? 'Replaces your background with the picture, no green screen needed.' : 'Choose a picture to put behind you.',
    green: 'For a physical green or blue screen. Pick the screen colour and adjust until the edges look clean.',
  }[S.videoFx.effect];
}
// Green screen with no screen behind the person does nothing; notice and say so instead of looking broken.
let screenTimer = 0;
function watchScreen() {
  clearInterval(screenTimer); $('#bgFxNoScreen').hidden = true;
  if (S.videoFx.effect !== 'green') return;
  let tries = 0, autoTried = false;
  screenTimer = setInterval(async () => {
    if (S.videoFx.effect !== 'green' || !vfx?.coverage) { if (++tries > 20) clearInterval(screenTimer); return; }
    let cov = vfx.coverage(S.videoFx.key);
    if (cov < 0) return;
    if (cov < 0.3 && !autoTried) { // maybe the colour is just off: try the one at the edges of the picture
      autoTried = true;
      const hex = vfx.autoKey();
      if (hex && vfx.coverage(hex) >= 0.3) { S.videoFx.key = hex; $('#keyColor').value = hex; saveVideoFx(); await applyVideoFx(); cov = vfx.coverage(hex); }
    }
    $('#bgFxNoScreen').hidden = cov >= 0.3;
    if (++tries > 3) clearInterval(screenTimer);
  }, 700);
}
$$('#bgFxNoScreen [data-fx-switch]').forEach((b) => b.addEventListener('click', () => $(`#bgFxSeg button[data-fx="${b.dataset.fxSwitch}"]`).click()));
$$('#bgFxSeg button').forEach((b) => b.addEventListener('click', async () => {
  S.videoFx.effect = b.dataset.fx; saveVideoFx(); renderBgFx();
  if (S.local.camRaw) { await applyVideoFx(); syncMedia(); }
  else if (b.dataset.fx !== 'none') toast('Turn your camera on to see the effect.');
  watchScreen();
}));
$('#bgFxPick').onclick = () => $('#bgFxFile').click();
$('#bgFxFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { store.set('fxBg', await compressImage(f)); renderBgFx(); await applyVideoFx(); syncMedia(); }
  catch (err) { toast(err.message, { err: true }); }
};
$('#bgFxClear').onclick = async () => { store.set('fxBg', ''); renderBgFx(); await applyVideoFx(); syncMedia(); };
$('#keyColor').value = S.videoFx.key;
$('#keyColor').oninput = async (e) => { S.videoFx.key = e.target.value; saveVideoFx(); await applyVideoFx(); };
$('#keyTol').value = S.videoFx.tol;
$('#keyTol').oninput = async (e) => { S.videoFx.tol = Number(e.target.value); saveVideoFx(); await applyVideoFx(); };
for (const [id, k] of [['#keySpill', 'spill'], ['#fxEdge', 'edge'], ['#fxBlur', 'blur']]) {
  $(id).value = S.videoFx[k];
  $(id).oninput = async (e) => { S.videoFx[k] = Number(e.target.value); saveVideoFx(); await applyVideoFx(); };
}
$('#keyAuto').onclick = async () => {
  if (!vfx?.autoKey) return toast('Turn your camera on with Green screen selected first.', { err: true });
  const hex = vfx.autoKey();
  if (!hex) return toast('Couldn’t find a screen colour at the edges of the picture. Pick it by hand.', { err: true });
  S.videoFx.key = hex; $('#keyColor').value = hex; saveVideoFx(); await applyVideoFx();
  toast(`Screen colour set to ${hex}.`);
};
renderBgFx();
for (const k of ['turnUrl', 'turnUser', 'turnPass']) {
  $('#' + k).value = sess.get(k, '');
  $('#' + k).addEventListener('change', (e) => { sess.set(k, e.target.value.trim()); if (S.studio) toast('TURN settings apply the next time you enter a studio.'); });
}

// Dock
$('#micBtn').onclick = () => setMic(!(S.local.micOn && S.local.audio));
$('#camBtn').onclick = () => setCam(!S.local.camOn);
$('#recBtn').onclick = toggleRecord;
$('#leaveBtn').onclick = () => {
  const lose = [S.live && 'end the live stream', S.rec && 'stop the recording (you can still save it)', isHost() && S.peers.size && `hand the studio to ${S.peers.size === 1 ? 'your guest' : 'a guest'}`].filter(Boolean);
  if (!lose.length) return leave('left');
  $('#leaveWhat').textContent = 'Leaving will ' + lose.join(', ') + '.';
  $('#leaveDlg').showModal();
};
$('#leaveGo').onclick = () => { $('#leaveDlg').close(); leave('left'); };

function leave(why) {
  if (!S.studio) return;
  if (S.rec) S.rec.recorder.stop();
  if (S.live) stopLive();
  beaconLeave(why);
  closeAllViewers(); S.supers.clear();
  outbox = [];
  teardownPeers();
  stopPresentation(); stopCam(); stopMic();
  S.studio = null; S.id = null; S.tok = null; S.host = null;
  S.state = localState();
  S.local.camOn = S.prefs.startCam; S.local.micOn = S.prefs.startMic;
  $$('#msgs > *').forEach((n) => n.remove());
  $$('.crew-card').forEach((n) => n.remove());
  S.feed = []; seenFeed.clear(); editor.sel = null; if (editor.on) setEditing(false);
  rumble.url = ''; clearTimeout(rumble.timer); stopYouTube();
  S.local.avatarId = ''; S.local.offbgId = ''; S.prePres = null; cap.lines.clear(); S.lobby = []; speechHub.ptt = false;
  history.replaceState(null, '', '/');
  setPhase('offline');
  toast('You left the studio.');
}
addEventListener('beforeunload', (e) => { if (S.studio && (S.rec || S.live || S.peers.size)) { e.preventDefault(); e.returnValue = ''; } });

// Fullscreen stage

// ---------------------------------------------------------------- present any file: drop it on the stage or click the empty space
async function presentImage(file) {
  const img = await loadImg(URL.createObjectURL(file));
  const c = presCanvas(), cg = c.getContext('2d');
  const track = c.captureStream(10).getVideoTracks()[0];
  track.contentHint = 'detail';
  startPresentation({ kind: 'image', name: file.name, track, source: c, draw() { fitDraw(cg, img, img.naturalWidth, img.naturalHeight, '#05070d'); }, stop() { track.stop(); URL.revokeObjectURL(img.src); } });
}
function presentFile(file) {
  if (!file) return;
  if (!S.studio) return toast('Enter a studio first, then drop your file on the stage.');
  const t = file.type || '', n = (file.name || '').toLowerCase();
  if (t === 'application/pdf' || n.endsWith('.pdf')) return presentPDF(file);
  if (t.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/.test(n)) return presentVideo(file);
  if (t.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/.test(n)) return presentImage(file).catch((e) => toast('Image: ' + e.message, { err: true }));
  toast('Drop a PDF, a video (MP4, WebM, MOV) or an image.', { err: true });
}
$('#imageFile').onchange = (e) => { presentFile(e.target.files[0]); e.target.value = ''; };
$('#anyFile').onchange = (e) => { presentFile(e.target.files[0]); e.target.value = ''; };
(() => {
  const st = $('#stage');
  let depth = 0;
  st.addEventListener('dragenter', (e) => { if (![...(e.dataTransfer?.types || [])].includes('Files')) return; e.preventDefault(); depth++; st.classList.add('dropping'); });
  st.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  st.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; st.classList.remove('dropping'); } });
  st.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; st.classList.remove('dropping');
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (e.shiftKey && isHost()) return libAddFiles(e.dataTransfer.files);
    presentFile(f);
  });
  // Click the empty presentation space to choose a file.
  const mediaAt = (ev) => {
    if (editor.on || !S.studio) return null;
    const r = st.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
    if (S.state.layout !== 'custom') return null;
    return (S.state.elements || []).find((e) => e.type === 'media' && x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h) || null;
  };
  st.addEventListener('mousemove', (ev) => { st.classList.toggle('can-drop', !!mediaAt(ev) && !presenterOf()); });
  st.addEventListener('click', (ev) => { if (ev.target.closest('.pres-bar, .cmd-bar, .cmd-toggle')) return; if (mediaAt(ev) && !presenterOf()) $('#anyFile').click(); });
})();

// ---------------------------------------------------------------- glass / solid panels drawn on the stage
function drawPanel(x, y, w, h, r = 16) {
  const b = S.state.brand;
  g.save(); rr(x, y, w, h, r); g.clip();
  if (b.panel === 'solid') { g.fillStyle = b.panelColor || '#0f172a'; g.fillRect(x, y, w, h); }
  else {
    if ('filter' in g) { g.filter = 'blur(18px) saturate(140%)'; g.drawImage(canvas, x, y, w, h, x, y, w, h); g.filter = 'none'; }
    g.fillStyle = 'rgba(12,20,44,.5)'; g.fillRect(x, y, w, h);
    const hl = g.createLinearGradient(x, y, x, y + Math.min(h, 140)); hl.addColorStop(0, 'rgba(255,255,255,.12)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hl; g.fillRect(x, y, w, h);
  }
  g.restore();
  g.save(); g.strokeStyle = b.panel === 'solid' ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.2)'; g.lineWidth = 1; rr(x + .5, y + .5, w - 1, h - 1, r); g.stroke(); g.restore();
}

// ---------------------------------------------------------------- audio-only tile: custom background, smooth voice rings
const lvlSmooth = new Map();
const blurCache = new WeakMap();
function blurredOf(img) {
  let c = blurCache.get(img);
  if (c) return c;
  c = document.createElement('canvas'); c.width = 320; c.height = 180;
  const cg = c.getContext('2d'); cg.filter = 'blur(12px)';
  const k = Math.max(340 / img.naturalWidth, 200 / img.naturalHeight);
  cg.drawImage(img, (320 - img.naturalWidth * k) / 2, (180 - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
  blurCache.set(img, c);
  return c;
}
function drawAudioTile(p, x, y, w, h, t) {
  const brand = S.state.brand;
  const prev = lvlSmooth.get(p.id) || 0, target = p.mic ? Math.min(1, p.level * 7) : 0;
  const lv = prev + (target - prev) * (target > prev ? .3 : .06);
  lvlSmooth.set(p.id, lv);
  const bgImg = assetImg(p.offbg), av = assetImg(p.avatar);
  if (bgImg) cover(g, bgImg, x, y, w, h);
  else if (av) g.drawImage(blurredOf(av), x, y, w, h);
  else {
    const gr = g.createRadialGradient(x + w * .3, y + h * .2, 10, x + w / 2, y + h / 2, Math.max(w, h) * .8);
    gr.addColorStop(0, hexA(brand.color, .55)); gr.addColorStop(.55, '#152042'); gr.addColorStop(1, '#0a1022');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
  }
  g.fillStyle = brand.panel === 'solid' ? hexA(brand.panelColor || '#0f172a', .55) : 'rgba(8,14,30,.32)'; g.fillRect(x, y, w, h);
  const cx = x + w / 2, cy = y + h / 2, rad = Math.min(w, h) * .17;
  // soft glow that breathes with the voice
  const glowR = rad * (1.7 + lv * 1.1);
  const glow = g.createRadialGradient(cx, cy, rad * .7, cx, cy, glowR);
  glow.addColorStop(0, hexA(brand.color, .22 + lv * .4)); glow.addColorStop(1, hexA(brand.color, 0));
  g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, glowR, 0, Math.PI * 2); g.fill();
  // three rings that travel outward; louder voice = wider, brighter rings
  for (let i = 0; i < 3; i++) {
    const ph = ((t / 2200) + i / 3) % 1;
    const rr2 = rad * (1.08 + ph * (0.45 + lv * 1.25));
    g.strokeStyle = hexA('#ffffff', (1 - ph) * (0.06 + lv * .35)); g.lineWidth = 1.5 + lv * 3;
    g.beginPath(); g.arc(cx, cy, rr2, 0, Math.PI * 2); g.stroke();
  }
  const r2 = rad * (1 + lv * .07);
  g.save(); g.beginPath(); g.arc(cx, cy, r2, 0, Math.PI * 2); g.clip();
  if (av) cover(g, av, cx - r2, cy - r2, r2 * 2, r2 * 2);
  else {
    const dg = g.createLinearGradient(cx - r2, cy - r2, cx + r2, cy + r2); dg.addColorStop(0, brand.color); dg.addColorStop(1, hexA(brand.color, .65));
    g.fillStyle = dg; g.fillRect(cx - r2, cy - r2, r2 * 2, r2 * 2);
    g.fillStyle = '#fff'; g.font = `700 ${Math.round(r2 * .78)}px ${stageFont()}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(initials(p.name), cx, cy + 2);
  }
  g.restore();
  g.strokeStyle = 'rgba(255,255,255,.4)'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, r2, 0, Math.PI * 2); g.stroke();
  // a small live voice meter under the photo
  const bars = 5, bw = Math.max(3, rad * .07), gap = bw * .9, total = bars * bw + (bars - 1) * gap;
  for (let i = 0; i < bars; i++) {
    const wob = .35 + .65 * Math.abs(Math.sin(t / 180 + i * 1.3));
    const bh = Math.max(bw, rad * .55 * (p.mic ? (.15 + lv * wob) : .1));
    g.fillStyle = p.mic ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.3)';
    rr(cx - total / 2 + i * (bw + gap), cy + r2 + rad * .55 - bh / 2, bw, bh, bw / 2); g.fill();
  }
}

// ---------------------------------------------------------------- sponsor ads and the call-in card
function drawAds(r) {
  const a = S.state.ads;
  if (!a?.on || !a.items?.length) return;
  const per = (a.every || 12) * 1000, now = Date.now();
  const idx = Math.floor(now / per) % a.items.length, into = now % per;
  const img = assetImg(a.items[idx]);
  if (!img) return;
  const alpha = Math.min(1, into / 450, (per - into) / 450);
  const k = Math.min(r.w / img.naturalWidth, r.h / img.naturalHeight), w = img.naturalWidth * k, h = img.naturalHeight * k;
  const cx = r.x + r.w / 2, x = cx > W * .6 ? r.x + r.w - w : cx < W * .4 ? r.x : cx - w / 2, y = r.y + r.h - h;
  g.save(); g.globalAlpha = alpha;
  g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 20; g.shadowOffsetY = 6;
  rr(x, y, w, h, 10); g.clip(); g.shadowColor = 'transparent';
  g.drawImage(img, x, y, w, h);
  g.restore();
}
function drawQr(url, x, y, size) {
  const q = url ? qrFor(url) : null;
  if (!q) { g.fillStyle = '#e8edf6'; rr(x, y, size, size, 8); g.fill(); return; }
  const n = q.getModuleCount(), cell = Math.max(1, Math.floor(size / n)), real = cell * n, ox = x + Math.floor((size - real) / 2), oy = y + Math.floor((size - real) / 2);
  g.fillStyle = '#0b1020';
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (q.isDark(i, j)) g.fillRect(ox + j * cell, oy + i * cell, cell, cell);
}
function drawCallinEl(e) {
  const r = px(e), pad = 16;
  drawPanel(r.x, r.y, r.w, r.h, 16);
  const qs = r.h - pad * 2;
  g.fillStyle = '#ffffff'; rr(r.x + pad, r.y + pad, qs, qs, 10); g.fill();
  drawQr(e.url, r.x + pad + 8, r.y + pad + 8, qs - 16);
  const tx = r.x + pad * 2 + qs, tw = r.w - (tx - r.x) - pad;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#f43f5e'; g.beginPath(); g.arc(tx + 6, r.y + pad + 10, 5, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,.8)'; g.font = '700 13px Inter, sans-serif'; g.fillText('LIVE CALL-IN', tx + 18, r.y + pad + 15);
  g.fillStyle = '#ffffff'; g.font = `800 24px ${stageFont()}`;
  wrapLines(e.label || 'Call in live', tw, 2).forEach((l, i) => g.fillText(l, tx, r.y + pad + 50 + i * 28));
  g.fillStyle = 'rgba(230,238,255,.85)'; g.font = '600 15px Inter, sans-serif';
  if (e.phone) g.fillText(wrapLines(e.phone, tw, 1)[0], tx, r.y + r.h - pad - 26);
  g.fillText(wrapLines((e.url || '').replace(/^https?:\/\//, ''), tw, 1)[0] || '', tx, r.y + r.h - pad - 4);
}

// ---------------------------------------------------------------- deck: scenes and people swap under a fixed stage
S.deck = 'scenes';
function deckLayers() { return isHost() ? ['scenes', 'people', ...(S.lobby?.length ? ['lobby'] : [])] : ['people']; }
function setDeck(name) {
  const layers = deckLayers();
  if (!layers.includes(name)) name = layers[0];
  const i = layers.indexOf(name);
  S.deck = name;
  $$('.deck-layer').forEach((el) => {
    const j = layers.indexOf(el.dataset.layer);
    el.classList.toggle('on', j === i);
    el.classList.toggle('above', j >= 0 && j < i);
    el.classList.toggle('below', j < 0 || j > i);
    el.setAttribute('aria-hidden', String(j !== i));
    el.inert = j !== i;
  });
  $$('.deck-tabs button').forEach((b) => { const on = b.dataset.deck === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
}
$$('.deck-tabs button').forEach((b) => b.addEventListener('click', () => { setDeck(b.dataset.deck); openDeck(); }));
function setDeckClosed(closed) {
  document.body.classList.toggle('deck-closed', closed);
  $('#deckToggle').setAttribute('aria-expanded', String(!closed));
  $('#deckToggle').setAttribute('aria-label', closed ? 'Show scenes and people' : 'Hide scenes and people');
  $('#deckToggle').dataset.tip = closed ? 'Show' : 'Hide';
  store.set('deckClosed', closed);
}
function openDeck() { if (document.body.classList.contains('deck-closed')) setDeckClosed(false); }
$('#deckToggle').onclick = () => setDeckClosed(!document.body.classList.contains('deck-closed'));
setDeckClosed(store.get('deckClosed', false));
(() => {
  let lock = 0;
  const onWheel = (e) => {
    if (innerWidth <= 900) return;
    if (e.target.closest('.side, .rail, dialog, .pres-bar, .cmd-bar')) return;
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX) || Math.abs(e.deltaY) < 8) return;
    e.preventDefault();
    if (Date.now() < lock) return;
    const layers = deckLayers(), i = layers.indexOf(S.deck);
    const next = layers[Math.max(0, Math.min(layers.length - 1, i + (e.deltaY > 0 ? 1 : -1)))];
    if (next !== S.deck) { setDeck(next); lock = Date.now() + 520; }
  };
  $('.studio').addEventListener('wheel', onWheel, { passive: false });
  let ty = null;
  $('#deck').addEventListener('touchstart', (e) => { ty = e.touches[0].clientY; }, { passive: true });
  $('#deck').addEventListener('touchend', (e) => {
    if (ty == null) return;
    const dy = e.changedTouches[0].clientY - ty; ty = null;
    if (Math.abs(dy) < 40) return;
    const layers = deckLayers(), i = layers.indexOf(S.deck);
    setDeck(layers[Math.max(0, Math.min(layers.length - 1, i + (dy < 0 ? 1 : -1)))]);
  }, { passive: true });
})();
$('#lockSwitch').onchange = (e) => { if (!isHost()) return; setStage({ locked: e.target.checked }); toast(e.target.checked ? 'Studio locked. New guests knock and wait for you.' : 'Studio unlocked.'); };
function renderDeck() {
  const host = isHost();
  $('#lockSwitch').checked = !!S.state.locked; $('#lockSwitch').disabled = !host || !S.studio;
  $('#lockWrap').hidden = !host || !S.studio;
  const n = S.lobby?.length || 0;
  $('#lobbyTab').hidden = !host || !n;
  $('#lobbyCount').textContent = n;
  if (!deckLayers().includes(S.deck)) setDeck(deckLayers()[0]); else setDeck(S.deck);
}

// ---------------------------------------------------------------- waiting room + call-in line
S.lobby = [];
function renderLobby() {
  const ul = $('#lobbyList');
  ul.replaceChildren(...(S.lobby || []).map((w) => {
    const li = document.createElement('li'); li.className = 'lobby-card';
    const av = document.createElement('span'); av.className = 'lobby-av'; av.textContent = initials(w.name);
    const info = document.createElement('div'); info.className = 'lobby-info';
    const b = document.createElement('b'); b.textContent = w.name;
    const s2 = document.createElement('span'); s2.textContent = (w.callin ? 'Calling in' : 'Wants to join') + (w.note ? ` · ${w.note}` : '');
    info.append(b, s2);
    const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'btn primary sm'; ok.textContent = 'Let in';
    ok.onclick = () => wsSend({ type: 'admit', id: w.id, accept: true });
    const no = document.createElement('button'); no.type = 'button'; no.className = 'btn ghost sm'; no.textContent = 'Decline';
    no.onclick = () => wsSend({ type: 'admit', id: w.id, accept: false });
    li.append(av, info, ok, no);
    return li;
  }));
  renderDeck();
}
async function refreshLobby() { if (!S.studio || !isHost()) return; try { S.lobby = (await api('lobbyList', creds())).lobby; renderLobby(); } catch {} }
setInterval(() => { if (S.studio && isHost() && S.lobby?.length) refreshLobby(); }, 10000);
const callinLink = () => `${location.origin}/c/${S.studio}`;
// The public call-in line is gone: viewers raise a hand on the watch page and record a voice question instead.
// The /c/ link stays only as the private way in for a "Play with me" player the host calls up.
// Callers: knock and wait
async function startKnock(code, callin) {
  S.knockCode = code;
  $('#enterFields').hidden = true; $('#knockWait').hidden = false;
  $('#knockWaitH').textContent = 'Waiting for the host';
  $('#knockMsg').textContent = callin ? 'You’re in the call-in queue. The host will bring you in shortly.' : 'This studio is locked. The host has been told you’re here.';
  try {
    const r = await api('knock', { studio: code, dev: deviceId(), name: S.name || 'Caller', callin: !!callin, note: $('#knockNote')?.value || '' });
    S.knock = { code, ...r };
    for (;;) {
      await new Promise((res) => setTimeout(res, 2000));
      if (!S.knock || S.knock.code !== code) return;
      const st = await api('knockPoll', { studio: code, id: r.id, tok: r.tok });
      if (st.status === 'admitted') { S.knock = null; $('#knockMsg').textContent = 'You’re in. Connecting…'; await join(code, { pass: st.pass, callin: !!callin }); return; }
      if (st.status === 'declined') { S.knock = null; $('#knockWaitH').textContent = 'Not this time'; $('#knockMsg').textContent = 'The host couldn’t take you right now.'; return; }
    }
  } catch (e) { $('#knockMsg').textContent = e.message; S.knock = null; }
}
// A guest who arrives before the host: wait in the green room and come in as soon as the studio opens.
async function waitForHost(code, msg) {
  const gen = (S.waitHost = (S.waitHost || 0) + 1);
  $('#enterFields').hidden = true; $('#knockWait').hidden = false;
  $('#knockWaitH').textContent = 'Waiting for the host';
  $('#knockMsg').textContent = msg || 'The host hasn’t opened this studio yet. We’ll bring you in as soon as they do.';
  for (;;) {
    await new Promise((res) => setTimeout(res, 4000));
    if (S.waitHost !== gen || !$('#enterDlg').open || S.studio) return;
    try { await join(code, { noWait: true }); if (S.studio) return; }
    catch (e) { if (e.status !== 404) { $('#knockMsg').textContent = e.message; return; } }
  }
}
$('#knockCancel').onclick = () => {
  if (S.knock) api('knockCancel', { studio: S.knock.code, id: S.knock.id, tok: S.knock.tok }).catch(() => {});
  S.knock = null; S.waitHost = (S.waitHost || 0) + 1; $('#knockWait').hidden = true; $('#enterFields').hidden = false;
};
function kickedOut(msg) { leave(); toast(msg || 'The host removed you from this studio.', { err: true, ms: 6000 }); }

// ---------------------------------------------------------------- camera-off background (per person)
function renderOffBg() {
  const d = store.get('offBg', '');
  $('#offBgThumb').hidden = !d; if (d) $('#offBgThumb').src = d;
  $('#offBgClear').hidden = !d;
}
$('#offBgPick').onclick = () => $('#offBgFile').click();
$('#offBgFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { store.set('offBg', await compressImage(f)); renderOffBg(); if (S.studio) uploadOffBg(true); toast('Shown behind your photo when your camera is off.'); }
  catch (err) { toast(err.message, { err: true }); }
};
$('#offBgClear').onclick = () => { store.set('offBg', ''); S.local.offbgId = ''; renderOffBg(); if (S.studio) sendMeta({ offbg: '' }); };
async function uploadOffBg(force) {
  const d = store.get('offBg', '');
  if (!d || !S.studio || (S.local.offbgId && !force)) return;
  try { S.local.offbgId = await storeAsset(d); sendMeta({ offbg: S.local.offbgId }); } catch {}
}

// ---------------------------------------------------------------- brand: panels, logo, sponsor ads
$$('#panelSeg button').forEach((b) => b.addEventListener('click', () => { if (isHost()) brandPref({ panel: b.dataset.panel }); }));
$('#panelColor').oninput = (e) => { if (isHost()) brandPref({ panelColor: e.target.value }); };
$('#adsSwitch').onchange = (e) => { if (!isHost()) return; setStage({ ads: { ...S.state.ads, on: e.target.checked } }); };
$('#adEvery').onchange = (e) => setStage({ ads: { ...S.state.ads, every: Number(e.target.value) } });
$$('#adPosSeg button').forEach((b) => b.addEventListener('click', () => { setStage({ ads: { ...S.state.ads, pos: b.dataset.ap } }); placeLayer('ads', b.dataset.ap); }));
$('#adPick').onclick = () => { if (!isHost()) return; $('#adFile').click(); };
$('#adFile').onchange = async (e) => {
  const files = [...e.target.files].slice(0, 8); e.target.value = '';
  const items = [...(S.state.ads?.items || [])];
  for (const f of files) {
    if (items.length >= 8) break;
    try { const data = await compressImage(f); items.push(await storeAsset(data)); } catch (err) { toast(err.message, { err: true }); }
  }
  setStage({ ads: { ...S.state.ads, on: true, items } });
  toast(`${files.length} sponsor image${files.length === 1 ? '' : 's'} added.`);
};
function renderAds() {
  const a = S.state.ads || { items: [] }, host = isHost();
  $('#adsSwitch').checked = !!a.on; $('#adsSwitch').disabled = !host;
  $('#adEvery').value = String(a.every || 12);
  $$('#adPosSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.ap === (a.pos || 'br')); b.disabled = !host; });
  $('#adList').replaceChildren(...(a.items || []).map((id, i) => {
    const d = document.createElement('div'); d.className = 'ad-thumb';
    const im = assetImg(id); if (im) { const x = document.createElement('img'); x.src = im.src; x.alt = ''; d.append(x); }
    const del = document.createElement('button'); del.type = 'button'; del.className = 'icon-btn sm on-media'; del.innerHTML = icon('x', { size: 'sm' }); del.setAttribute('aria-label', 'Remove sponsor image'); del.disabled = !host;
    del.onclick = () => { const items = [...a.items]; items.splice(i, 1); setStage({ ads: { ...a, items } }); };
    d.append(del); return d;
  }));
  $('#adOpts').hidden = !(a.items || []).length;
  $$('#panelSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.panel === (S.state.brand.panel || 'glass')); b.disabled = !host; });
  $('#panelColor').value = S.state.brand.panelColor || '#0f172a'; $('#panelColorRow').hidden = S.state.brand.panel !== 'solid';
}

// ---------------------------------------------------------------- green room quick controls
$$('#grFx button').forEach((b) => b.addEventListener('click', () => { $(`#bgFxSeg [data-fx="${b.dataset.fx}"]`)?.click(); renderGreenRoom(); }));
$('#grCam').onchange = (e) => { $('#camSelect').value = e.target.value; $('#camSelect').dispatchEvent(new Event('change')); };
$('#grMic').onchange = (e) => { $('#micSelect').value = e.target.value; $('#micSelect').dispatchEvent(new Event('change')); };
function renderGreenRoom() {
  $$('#grFx button').forEach((b) => b.classList.toggle('on', b.dataset.fx === S.videoFx.effect));
  for (const [from, to] of [['#camSelect', '#grCam'], ['#micSelect', '#grMic']]) {
    const src = $(from), dst = $(to);
    if (dst.options.length !== src.options.length) dst.replaceChildren(...[...src.options].map((o) => new Option(o.text, o.value)));
    dst.value = src.value;
  }
}

// ---------------------------------------------------------------- media library (this browser) + scenes with media
S.library = [];
function libDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('gather-library', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function libTx(mode, fn) { const db = await libDb(); return new Promise((res, rej) => { const tx = db.transaction('items', mode); const out = fn(tx.objectStore('items')); tx.oncomplete = () => res(out?.result ?? out); tx.onerror = () => rej(tx.error); }); }
async function libLoad() { try { S.library = (await libTx('readonly', (s) => s.getAll())) || []; } catch { S.library = []; } renderLibrary(); }
const libKind = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ? 'pdf' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('image/') ? 'image' : '';
async function libAddFiles(files) {
  for (const f of [...files]) {
    const kind = libKind(f);
    if (!kind) { toast(`${f.name}: use a PDF, video or image.`, { err: true }); continue; }
    if (f.size > 500 * 1048576) { toast(`${f.name} is over 500 MB.`, { err: true }); continue; }
    await libTx('readwrite', (s) => s.put({ id: uid() + uid(), name: f.name.replace(/\.[^.]+$/, ''), kind, blob: f, type: f.type, size: f.size, added: Date.now() }));
  }
  await libLoad(); toast('Added to your media library.');
}
$('#libPick').onclick = () => $('#libFile').click();
$('#libFile').onchange = (e) => { libAddFiles(e.target.files); e.target.value = ''; };
$('#libUrlAdd').onclick = async () => {
  let u = $('#libUrl').value.trim();
  if (!u) return;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { new URL(u); } catch { return toast('That doesn’t look like a web address.', { err: true }); }
  const name = $('#libUrlName').value.trim() || new URL(u).hostname.replace(/^www\./, '');
  await libTx('readwrite', (s) => s.put({ id: uid() + uid(), name, kind: /youtu\.?be/.test(u) ? 'youtube' : 'link', url: u, added: Date.now() }));
  $('#libUrl').value = ''; $('#libUrlName').value = ''; libLoad();
};
async function presentLibrary(it) {
  if (!it) return;
  if (it.kind === 'link' || it.kind === 'youtube') return offerOpen(it.url, it.name);
  presentFile(new File([it.blob], it.name + ({ pdf: '.pdf', video: '', image: '' }[it.kind] || ''), { type: it.type }));
}
const KIND_LABEL = { pdf: 'PDF', video: 'Video', image: 'Image', link: 'Web', youtube: 'YouTube' };
function renderLibrary() {
  const ul = $('#libList');
  ul.replaceChildren(...S.library.map((it) => {
    const li = document.createElement('li'); li.className = 'el-row lib-row';
    const k = document.createElement('span'); k.className = 'pill caps lib-kind k-' + it.kind; k.textContent = KIND_LABEL[it.kind];
    const nm = document.createElement('span'); nm.className = 'menu-item compact el-pick'; nm.textContent = it.name;
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn sm'; go.textContent = 'Present'; go.onclick = () => presentLibrary(it);
    const del = mkBtn('trash-2', 'Remove from library', async () => { await libTx('readwrite', (s) => s.delete(it.id)); libLoad(); });
    li.append(k, nm, go, del); return li;
  }));
  $('#libEmpty').hidden = !!S.library.length;
  const sel = $('#sceneMedia'); const cur = sel.value;
  sel.replaceChildren(new Option('No media', ''), ...S.library.map((it) => new Option(`${KIND_LABEL[it.kind]} · ${it.name}`, it.id)));
  sel.value = cur;
}

// ---------------------------------------------------------------- AI producer: name it, talk to it, it runs the show
S.aiName = store.get('aiName', 'Sam');
S.aiWake = store.get('aiWake', false);
S.aiStatus = 'idle';
const AI_STATE = { idle: 'Ready', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking' };
function setAiStatus(st) {
  S.aiStatus = st;
  for (const id of ['#cmdBar', '#aiDock', '#aiHead']) $(id).dataset.status = st;
  $('#cmdState').textContent = AI_STATE[st];
  $('#aiMic').setAttribute('aria-pressed', st === 'listening'); $('#cmdMic').setAttribute('aria-pressed', st === 'listening');
  renderAIPanel();
}
function renderProducerUI() {
  const host = isHost();
  $('#cmdInput').placeholder = `Ask ${S.aiName}…`;
  $('#aiInput').placeholder = `Message ${S.aiName}…`;
  $('#aiWakeHint').textContent = `Say “Hey ${S.aiName}, …” and it acts. Chrome or Edge.`;
  for (const id of ['#cmdName', '#aiTitle', '#aiDockName']) $(id).textContent = S.aiName;
  $('#aiDock').hidden = !host || !S.studio;
  if (!host || !S.studio) setCmd(false);
  if (document.activeElement !== $('#aiName')) $('#aiName').value = S.aiName;
  $('#aiWake').checked = !!S.aiWake;
  const v = store.get('aiVoice', 'browser');
  $$('#aiVoiceSeg button').forEach((b) => b.classList.toggle('on', b.dataset.voice === v));
  $('#aiVoiceNameRow').hidden = v !== 'openai';
  $('#aiVoiceTest').hidden = v === 'off';
  $('#aiVoiceName').value = store.get('aiVoiceName', 'alloy');
  $('#aiVoiceNote').textContent = v === 'openai' ? (store.get('aiKey:openai', '') ? 'Everyone in the stream and the recording hears it.' : 'Needs a ChatGPT (OpenAI) key, saved under ChatGPT above.') : v === 'browser' ? 'Only you hear this voice.' : `${S.aiName} replies without speaking.`;
}
$('#aiName').addEventListener('input', (e) => { S.aiName = e.target.value.trim().slice(0, 20) || 'Sam'; store.set('aiName', S.aiName); renderProducerUI(); renderAILog(); });
$('#aiWake').onchange = (e) => { S.aiWake = e.target.checked; store.set('aiWake', S.aiWake); syncCaptions(); toast(S.aiWake ? `Say “Hey ${S.aiName}” and then what you need.` : 'Wake word off.'); };
$$('#aiVoiceSeg button').forEach((b) => b.addEventListener('click', () => { store.set('aiVoice', b.dataset.voice); renderProducerUI(); }));
$('#aiVoiceName').onchange = (e) => store.set('aiVoiceName', e.target.value);
$('#aiVoiceTest').onclick = () => speak(`Hi, I'm ${S.aiName}. Ready when you are.`);
// The command bar floats over the stage only while you're using it: open it from the dock or with "/".
function setCmd(open) {
  const bar = $('#cmdBar');
  if (bar.hidden === !open) return;
  bar.hidden = !open; $('#aiDock').setAttribute('aria-expanded', open);
  if (open) { $('#cmdInput').focus(); } else if (bar.contains(document.activeElement)) $('#aiDock').focus();
}
$('#aiDock').onclick = () => setCmd($('#cmdBar').hidden);
$('#cmdClose').onclick = () => setCmd(false);
$('#cmdBar').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); setCmd(false); } });
$('#cmdForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#cmdInput').value; $('#cmdInput').value = ''; askProducer(v); });
function pushToTalk(target) {
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) return toast('Talking to your AI needs Chrome or Edge. You can type instead.', { err: true });
  speechHub.ptt = !speechHub.ptt; speechHub.target = target;
  setAiStatus(speechHub.ptt ? 'listening' : 'idle');
  syncCaptions();
}
$('#cmdMic').onclick = () => pushToTalk('#cmdInput');
$('#aiMic').onclick = () => pushToTalk('#aiInput');
$('#cmdShow').onclick = () => {
  const p = S.pendingOpen;
  if (!p) return;
  if (p.step === 'open') {
    window.open(p.url, 'gather-share', 'popup,width=1280,height=760');
    p.step = 'share';
    $('#cmdShow').textContent = 'Now share that window';
  } else {
    S.pendingOpen = null; $('#cmdShow').hidden = true;
    presentScreen();
  }
};
function offerOpen(url, label) {
  S.pendingOpen = { url, label: label || url, step: 'open' };
  setCmd(true);
  $('#cmdShow').hidden = false;
  $('#cmdShow').textContent = `Open “${String(label || new URL(url).hostname).slice(0, 40)}”`;
  $('#cmdShow').dataset.tip = url;
}
function findScene(name) {
  const n = String(name || '').toLowerCase().trim();
  const list = sceneList();
  return list.find((s) => s.name.toLowerCase() === n) || list.find((s) => s.name.toLowerCase().includes(n) || n.includes(s.name.toLowerCase()));
}
function findLib(name) {
  const n = String(name || '').toLowerCase().trim();
  return S.library.find((i) => i.name.toLowerCase() === n) || S.library.find((i) => i.name.toLowerCase().includes(n) || n.includes(i.name.toLowerCase()));
}
function producerCtx() {
  const sc = sceneList().find((x) => x.id === activeSceneId());
  return {
    name: S.aiName,
    scenes: sceneList().map((s) => s.name),
    library: S.library.map((i) => ({ name: i.name, kind: i.kind })),
    now: `scene: ${sc?.name || 'custom'}; presenting: ${S.local.pres ? S.local.pres.kind + ' ' + S.local.pres.name : 'nothing'}; banner: ${S.state.banner?.text || 'none'}; people: ${participants().map((p) => p.name).join(', ')}`,
  };
}
async function runActions(actions) {
  for (const a of actions || []) {
    try {
      if (a.type === 'scene') { const sc = findScene(a.name); if (sc) applyScene(sc); else toast(`No scene called “${a.name}”.`); }
      else if (a.type === 'present') { const it = findLib(a.name); if (it) await presentLibrary(it); else toast(`“${a.name}” isn’t in your media library.`); }
      else if (a.type === 'stop') stopPresentation();
      else if (a.type === 'banner') setStage({ banner: { id: uid(), text: String(a.text || '').slice(0, 120), sub: String(a.sub || '').slice(0, 120) } });
      else if (a.type === 'hide_banner') setStage({ banner: null });
      else if (a.type === 'countdown') {
        const m = Math.max(1, Math.min(120, Number(a.minutes) || 5));
        const els = elementsCopy().filter((e) => !(e.type === 'timer' && e.mode === 'countdown'));
        els.push(withDefaults({ type: 'timer', mode: 'countdown', target: Date.now() + m * 60000 }));
        setStage({ elements: els });
      } else if (a.type === 'open' && /^https?:\/\//i.test(String(a.url || ''))) offerOpen(String(a.url), a.label);
    } catch (e) { toast(e.message, { err: true }); }
  }
}
/** The first sentence or two: what gets read aloud from a longer on-screen answer. */
function spokenPart(text) {
  const t = plainMd(text).replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,260}?[.!?])(\s|$)/);
  return m ? m[1] : t.slice(0, 260);
}
async function askProducer(text) {
  text = String(text || '').trim();
  if (!text || S.ai.busy) return;
  if (!isHost()) return toast('Only the host can direct the AI.', { err: true });
  const own = store.get('aiKey:' + S.aiProv, ''), house = !own && !!S.houseAI && !!S.studio;
  const prov = house ? S.houseAI.provider : S.aiProv, key = own;
  if (!key && !house) { setTab('ai'); setAiSetup(true); return toast(`Add your ${AI_NAME[prov]} key so ${S.aiName} can help.`, { err: true }); }
  const history = S.ai.items.filter((i) => i.done && !i.error && (i.role === 'user' || i.role === 'assistant')).slice(-10).map((i) => ({ role: i.role, text: i.text }));
  // a fresh answer takes over the AI window, unless the host pins an older one again
  for (const it of S.ai.items) if (it.pinned) upsertAI({ id: it.id, pinned: false });
  const ans = { id: uid(), role: 'assistant', text: '', provider: prov, done: false, actions: [] };
  upsertAI({ id: uid(), role: 'user', text, provider: prov, done: true });
  upsertAI(ans);
  S.ai.busy = true; setAiStatus('thinking');
  $('#cmdReply').textContent = ''; $('#cmdReply').classList.remove('err'); $('#cmdActs').replaceChildren(); $('#cmdShow').hidden = true;
  let reply = '';
  const fail = (msg) => { upsertAI({ ...ans, text: msg, error: true, done: true }); $('#cmdReply').textContent = msg; $('#cmdReply').classList.add('err'); };
  try {
    const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(house ? { mode: 'agent', house: true, ...creds(), messages: [...history, { role: 'user', text }], ctx: producerCtx() } : { mode: 'agent', provider: prov, apiKey: key, model: store.get('aiModel:' + prov, ''), messages: [...history, { role: 'user', text }], ctx: producerCtx() }) });
    if (res.headers.get('X-AI-Left') != null) { S.houseLeft = Number(res.headers.get('X-AI-Left')); renderAIPanel(); }
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `The AI request failed (${res.status}).`); }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', failed = '';
    const onEvent = async (ev) => {
      if (ev.t === 'text') { reply += ev.d; ans.text = reply; upsertAI({ id: ans.id, text: reply }); $('#cmdReply').textContent = plainMd(reply); }
      else if (ev.t === 'action' && ev.a) { ans.actions = [...ans.actions, ev.a]; upsertAI({ id: ans.id, actions: ans.actions }); $('#cmdActs').append(actChip(ev.a, false)); await runActions([ev.a]); }
      else if (ev.t === 'error') failed = ev.message || 'The AI request failed.';
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let n;
      while ((n = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, n).trim(); buf = buf.slice(n + 1); if (line) { try { await onEvent(JSON.parse(line)); } catch (e) { if (!(e instanceof SyntaxError)) throw e; } } }
      if (done) break;
    }
    if (failed) throw new Error(failed);
    if (!reply.trim()) reply = ans.actions.length ? 'Done.' : '(No answer came back.)';
    upsertAI({ id: ans.id, text: reply, done: true });
    $('#cmdReply').textContent = plainMd(reply);
    S.ai.busy = false;
    await speak(spokenPart(reply));
  } catch (e) {
    fail(e.message === 'Failed to fetch' ? 'Could not reach the AI. Check your connection and try again.' : e.message);
    toast(e.message, { err: true });
  } finally { S.ai.busy = false; if (S.aiStatus === 'thinking') setAiStatus('idle'); else renderAIPanel(); }
}
// Voice out: OpenAI voice goes into the stream mix; the browser voice is heard only by the host.
async function speak(text) {
  const mode = store.get('aiVoice', 'browser');
  if (mode === 'off' || !text) return;
  setAiStatus('speaking');
  try {
    if (mode === 'openai') {
      const key = store.get('aiKey:openai', '');
      if (!key) throw new Error('Add a ChatGPT (OpenAI) key in the AI panel for the stream voice.');
      const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'tts', apiKey: key, text, voice: store.get('aiVoiceName', 'alloy') }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'The voice request failed.'); }
      const ctx = audioCtx();
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      const src = ctx.createBufferSource(); src.buffer = buf;
      const gn = ctx.createGain(); src.connect(gn); gn.connect(ctx.destination);
      const an = ctx.createAnalyser(); an.fftSize = 512; gn.connect(an); S.aiAnalyser = an;
      const mix = mixInMedia(gn); syncMedia();
      await new Promise((r) => { src.onended = r; src.start(); });
      mix.dispose(); syncMedia(); S.aiAnalyser = null;
    } else if ('speechSynthesis' in window) {
      await new Promise((r) => {
        const u = new SpeechSynthesisUtterance(text);
        const v = speechSynthesis.getVoices().find((x) => /^en/i.test(x.lang) && /natural|google|samantha|aria|jenny/i.test(x.name));
        if (v) u.voice = v;
        u.onend = r; u.onerror = r; speechSynthesis.speak(u);
        setTimeout(r, 30000);
      });
    }
  } catch (e) { toast(e.message, { err: true }); }
  finally { if (S.aiStatus === 'speaking') setAiStatus('idle'); }
}
function aiVoiceLevel() {
  const an = S.aiAnalyser;
  if (!an) return S.aiStatus === 'speaking' ? .4 + .3 * Math.abs(Math.sin(performance.now() / 160)) : 0;
  const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b);
  let s = 0; for (const v of b) s += v * v; return Math.min(1, Math.sqrt(s / b.length) * 6);
}
function drawOrb(cx, cy, r, t) {
  const lv = aiVoiceLevel(), st = S.aiStatus;
  const pulse = st === 'thinking' ? .08 * Math.sin(t / 140) : st === 'listening' ? .06 * Math.sin(t / 260) : lv * .25;
  const rr2 = r * (1 + pulse);
  const glow = g.createRadialGradient(cx, cy, rr2 * .4, cx, cy, rr2 * 2.2);
  glow.addColorStop(0, hexA(S.state.brand.color, .45)); glow.addColorStop(1, hexA(S.state.brand.color, 0));
  g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, rr2 * 2.2, 0, Math.PI * 2); g.fill();
  const a = t / 900;
  const og = g.createLinearGradient(cx + Math.cos(a) * rr2, cy + Math.sin(a) * rr2, cx - Math.cos(a) * rr2, cy - Math.sin(a) * rr2);
  og.addColorStop(0, '#7dd3fc'); og.addColorStop(.5, S.state.brand.color); og.addColorStop(1, '#a78bfa');
  g.fillStyle = og; g.beginPath(); g.arc(cx, cy, rr2, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1.5; g.beginPath(); g.arc(cx, cy, rr2, 0, Math.PI * 2); g.stroke();
}

// ---------------------------------------------------------------- one speech recogniser for captions and the AI
const speechHub = { rec: null, lang: '', ptt: false, armed: 0, target: '#cmdInput' };
function speechWanted() {
  const c = S.state.captions || {};
  const caps = !!(S.studio && c.on && S.local.micOn && S.local.audio);
  const ai = !!S.studio && isHost() && (S.aiWake || speechHub.ptt); // never listen outside a studio
  return { caps, ai, any: caps || ai, lang: c.on ? (c.lang || 'en-US') : 'en-US' };
}
function syncCaptions() {
  const w = speechWanted();
  cap.want = w.caps;
  if (!w.any) { stopSpeech(); return; }
  if (speechHub.rec && speechHub.lang === w.lang) return;
  stopSpeech(); startSpeech(w.lang);
}
function startSpeech(lang) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { if (!cap.warned && cap.want) { cap.warned = true; toast('Your browser can’t transcribe speech, so your captions won’t show. Chrome and Edge can.'); } return; }
  const r = new SR();
  r.continuous = true; r.interimResults = true; r.lang = lang; speechHub.lang = lang;
  r.onresult = (e) => {
    let interim = '', fin = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) fin += t; else interim += t; }
    const text = (fin || interim).trim();
    if (!text) return;
    if (cap.want) { showCaption(S.id, S.name || 'You', text, !!fin); sendCaption(text, !!fin); }
    if (speechHub.ptt) {
      const box = $(speechHub.target || '#cmdInput');
      box.value = text;
      if (fin) { speechHub.ptt = false; box.value = ''; autoGrow(box); syncCaptions(); setAiStatus('idle'); askProducer(fin.trim()); }
      return;
    }
    if (S.aiWake && fin) {
      const name = S.aiName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = fin.trim().match(new RegExp(`^(?:hey|ok|okay|yo)?[\\s,]*${name}[\\s,.!?]*(.*)$`, 'i'));
      if (m) { if (m[1].trim()) askProducer(m[1].trim()); else { speechHub.armed = Date.now() + 7000; setAiStatus('listening'); } }
      else if (speechHub.armed > Date.now()) { speechHub.armed = 0; askProducer(fin.trim()); }
    }
  };
  r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { cap.want = false; speechHub.ptt = false; toast('Speech recognition needs microphone permission.', { err: true }); } };
  r.onend = () => { if (speechHub.rec === r && speechWanted().any) setTimeout(() => { try { r.start(); } catch {} }, 250); };
  speechHub.rec = r;
  try { r.start(); } catch {}
}
function stopSpeech() { const r = speechHub.rec; speechHub.rec = null; try { r?.stop(); } catch {} }

libLoad();
renderOffBg();

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
  const av = store.get('avatar', '');
  $('#previewInitials').textContent = av ? '' : initials($('#enterName').value || S.name);
  $('#previewInitials').style.backgroundImage = av ? `url("${av}")` : '';
  $('#previewInitials').classList.toggle('has-av', !!av);
  $('#avatarImg').hidden = !av; if (av) $('#avatarImg').src = av;
  $('#avatarHint').textContent = av ? 'Change photo' : 'Add a photo';
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
  $$('#enterForm .seg button[data-mode]').forEach((b) => { const on = b.dataset.mode === m; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  $('#codeFld').hidden = m !== 'join';
  $('#enterGo').textContent = m === 'join' ? 'Join studio' : 'Create studio';
  $('#enterErr').hidden = true;
}
$$('#enterForm .seg button[data-mode]').forEach((b) => b.addEventListener('click', () => setEnterMode(b.dataset.mode)));
$('#enterForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'go') return; // close button
  e.preventDefault();
  const name = $('#enterName').value.trim();
  if (!name) { $('#enterErr').textContent = 'Add your name so people know who you are.'; $('#enterErr').hidden = false; return $('#enterName').focus(); }
  if (enterMode !== 'join' && !S.pendingStream && S.requireAccount && !acct.user) { $('#enterDlg').close(); return needAccountThen(() => openEnter('create')); }
  let code = enterMode === 'join' ? parseCode($('#enterCode').value) : (S.pendingStream?.code || newCode());
  if (!code) { $('#enterErr').textContent = 'Paste the studio code your host sent you.'; $('#enterErr').hidden = false; return $('#enterCode').focus(); }
  S.name = name; store.set('name', name); $('#nameInput').value = name;
  busy($('#enterGo'));
  try { await join(code, { callin: S.callin && enterMode === 'join', create: enterMode !== 'join' }); }
  catch (err) { setEnterMode(enterMode); showEnterErr(err.message); setPhase('offline'); }
  finally { busy($('#enterGo'), false); }
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
  inviteOpener = document.activeElement !== document.body ? document.activeElement : null;
  $('#inviteDlg').showModal();
}
let inviteOpener = null;
// When the studio opened the invite dialog by itself, focus would fall to <body>: land on Invite instead.
$('#inviteDlg').addEventListener('close', () => {
  const back = inviteOpener?.isConnected && !inviteOpener.closest('[hidden]') ? inviteOpener : [$('#enterTop'), $('#micBtn')].find((b) => b && !b.hidden && b.offsetParent);
  inviteOpener = null;
  setTimeout(() => back?.focus(), 0);
});
$('#autoStage').checked = store.get('autoStage', false);
$('#autoStage').onchange = (e) => store.set('autoStage', e.target.checked);
$('#noteLink').onclick = () => { copy(inviteLink(), 'Invite link copied.'); guideMark('invited'); };
$('#noteCode').onclick = () => { copy(S.studio, 'Studio code copied.'); guideMark('invited'); };
$('#copyCode').onclick = () => { copy(S.studio, 'Room code copied.'); guideMark('invited'); };
$('#copyLink').onclick = () => { copy(inviteLink(), 'Invite link copied.'); guideMark('invited'); };
$('#addSlot').onclick = openInvite;
$('#enterTop').onclick = openInvite;
$('#heroSchedule').onclick = () => openWizard();
$('#enterStage').onclick = () => needAccountThen(() => openEnter('create'));
$('#landJoin').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $('#landCode').value, code = parseCode(raw), kind = linkKind(raw);
  if (!code) { $('#landCode').focus(); return toast('Paste the invite link or code you were sent.', { err: true }); }
  if (kind === 'w') return toast('That’s a watch link, for viewers.', { action: ['Open it', () => { location.href = '/w/' + code; }], ms: 8000 });
  if (kind === 'c') S.callin = true;
  openEnter('join', code);
});
$('#recDlg').addEventListener('close', () => { $('#recVideo').pause(); });
// Close buttons inside forms are type="button", so Enter submits the form instead of closing the dialog.
$$('button[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog')?.close('cancel')));

// ---------------------------------------------------------------- keyboard
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const ae = document.activeElement, tag = ae?.tagName;
  // Typing is never a shortcut: inputs, and any contenteditable (the show title is "plaintext-only").
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || ae?.isContentEditable || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { if (editor.on) { e.preventDefault(); setEditing(false); } return; } // never swallow Esc for menus
  if (!store.get('keys', true) || ae?.closest?.('button, a, [role="tab"], [role="radio"], [contenteditable]:not([contenteditable="false"]), .popover')) return;
  const act = {
    m: () => setMic(!(S.local.micOn && S.local.audio)),
    v: () => setCam(!S.local.camOn),
    s: () => S.studio && (S.local.pres ? stopPresentation() : presentScreen()),
    r: () => S.studio && toggleRecord(),
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [n, () => isHost() && sceneList()[n - 1] && applyScene(sceneList()[n - 1])])),
    arrowright: () => S.local.pres?.kind === 'pdf' && S.local.pres.go(S.local.pres.page + 1),
    arrowleft: () => S.local.pres?.kind === 'pdf' && S.local.pres.go(S.local.pres.page - 1),
    pagedown: () => S.local.pres?.kind === 'pdf' && S.local.pres.go(S.local.pres.page + 1),
    pageup: () => S.local.pres?.kind === 'pdf' && S.local.pres.go(S.local.pres.page - 1),
    delete: () => { if (editor.on && editor.sel) deleteEl(editor.sel); },
    backspace: () => { if (editor.on && editor.sel) deleteEl(editor.sel); },
    '/': () => { if (isHost() && S.studio) setCmd(true); else { setTab('chat'); $('#chatInput').focus(); } },
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

// ---------------------------------------------------------------- host walk-through
// A short tour for hosts: each step lights up one part of the studio and says what it's for. It runs once,
// the first time you host, and any time from Help → "Take the studio tour". Steps whose part isn't on screen
// (say, a panel that's folded away) are skipped.
// One sweep around the screen, never doubling back: the stage and what's under it, the bottom bar left to right,
// the panel rail top to bottom, then the header left to right, ending on Go live.
const TOUR = [
  ['#stage', 'Your show', 'What you see here is exactly what viewers see and what gets recorded.'],
  ['#sceneStrip', 'Scenes', 'Switch layouts in one click, or press 1–9. Save your own from Look → Layout.'],
  ['.deck-tabs [data-deck="people"]', 'Guests and backstage', 'New guests wait backstage. Click someone’s picture to put them on stage, or back off it.'],
  ['#shareBtn', 'Present', 'Share your screen, slides, a video, an image or a game.'],
  ['#recBtn', 'Record', 'Record the show in this browser, then download it or save it to Google Drive.'],
  ['#aiDock', 'Your AI producer', 'Ask it anything on air, or tell it to switch scenes, show a banner or find a video. Press / any time.'],
  ['.rail-btn[data-tab="show"]', 'Show', 'Your watch page, super chats, voice questions, the shop and polls, banners and the ticker.'],
  ['.rail-btn[data-tab="look"]', 'Look', 'Arrange the stage and set your brand: colours, logo, backgrounds and fonts.'],
  ['#enterTop', 'Invite', 'Send guests the link. They don’t need an account.'],
  ['#watchTop', 'Watch page', 'Your own page for viewers: the show, live chat and super chats. Share this link anywhere.'],
  ['#liveTop', 'Go live', 'Stream to YouTube, Twitch and more at once. Your watch page works without it.'],
];
const tour = { i: 0, steps: [] };
const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
function startTour() {
  if ($('#helpDlg').open) $('#helpDlg').close();
  tour.steps = TOUR.filter(([sel]) => visible($(sel)));
  if (!tour.steps.length) return;
  tour.i = 0; $('#tour').hidden = false; showTourStep();
  $('#tourNext').focus();
}
function endTour() { $('#tour').hidden = true; store.set('tourDone', true); }
function showTourStep() {
  const [sel, title, text] = tour.steps[tour.i], el = $(sel);
  if (!visible(el)) return tour.i < tour.steps.length - 1 ? (tour.i++, showTourStep()) : endTour();
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('#tourStep').textContent = `${tour.i + 1} of ${tour.steps.length}`;
  $('#tourH').textContent = title; $('#tourText').textContent = text;
  $('#tourBack').disabled = tour.i === 0;
  $('#tourNext').textContent = tour.i === tour.steps.length - 1 ? 'Done' : 'Next';
  placeTour();
}
function placeTour() {
  if ($('#tour').hidden) return;
  const el = $(tour.steps[tour.i][0]), r = el.getBoundingClientRect(), pad = 6;
  Object.assign($('#tourSpot').style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
  const card = $('#tourCard'), cw = card.offsetWidth, ch = card.offsetHeight, gap = 14, vw = innerWidth, vh = innerHeight;
  let top = r.bottom + gap;
  if (top + ch > vh - 8) top = r.top - gap - ch;          // no room below: above
  if (top < 8) top = Math.min(vh - ch - 8, Math.max(8, r.top + r.height / 2 - ch / 2)); // tall targets: beside
  let left = r.left + r.width / 2 - cw / 2;
  if (r.height > vh * 0.5 && r.right + gap + cw < vw) left = r.right + gap; // a big area (the stage): put the card next to it
  if (r.left > vw - 140 && r.height < vh * 0.5) { left = r.left - gap - cw; top = Math.max(8, Math.min(vh - ch - 8, r.top + r.height / 2 - ch / 2)); } // the panel rail: beside it, not over it
  left = Math.max(8, Math.min(vw - cw - 8, left));
  Object.assign(card.style, { left: left + 'px', top: top + 'px' });
}
$('#tourNext').onclick = () => { if (tour.i >= tour.steps.length - 1) return endTour(); tour.i++; showTourStep(); };
$('#tourBack').onclick = () => { if (tour.i > 0) { tour.i--; showTourStep(); } };
$('#tourSkip').onclick = endTour;
$('#tourStart').onclick = () => startTour();
$('#tour').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); endTour(); } else if (e.key === 'ArrowRight') $('#tourNext').click(); else if (e.key === 'ArrowLeft') $('#tourBack').click(); });
addEventListener('resize', placeTour);
// First time you host: once the invite dialog closes. Not under browser automation, where it would sit over the
// controls a script is driving (the tour itself is tested by opening it from Help).
$('#inviteDlg').addEventListener('close', () => { if (isHost() && S.studio && !store.get('tourDone', false) && !navigator.webdriver) setTimeout(startTour, 300); });

// ---------------------------------------------------------------- selection state for assistive tech, in one place
// Segmented controls, look tabs and the rail mark the chosen option with .on. Mirror that into aria-checked /
// aria-selected, and let arrow keys move along radio groups and tab lists.
function syncAria(b) {
  const r = b.getAttribute('role'), on = b.classList.contains('on');
  if (r === 'radio') b.setAttribute('aria-checked', on); else if (r === 'tab') b.setAttribute('aria-selected', on);
}
for (const g of $$('.seg')) {
  if (!g.getAttribute('role')) g.setAttribute('role', 'radiogroup');
  for (const b of g.querySelectorAll(':scope > button')) { if (!b.getAttribute('role')) b.setAttribute('role', g.getAttribute('role') === 'tablist' ? 'tab' : 'radio'); syncAria(b); }
}
new MutationObserver((ms) => { for (const m of ms) if (m.target.matches?.('.seg > button')) syncAria(m.target); })
  .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
document.addEventListener('keydown', (e) => {
  const g = e.target.closest?.('[role="radiogroup"], [role="tablist"]');
  if (!g || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const items = [...g.querySelectorAll(':scope > button:not([disabled])')], i = items.indexOf(e.target);
  if (i < 0) return;
  e.preventDefault(); e.stopPropagation();
  const next = items[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length];
  next.focus(); next.click();
});

// ---------------------------------------------------------------- boot
document.fonts?.ready.then(() => S.banner.key = '');
setTab('chat');
setPhase('offline');
renderHelp();
acctBoot();
// Bring back the last scene (and how it was arranged) before anyone joins.
(function restoreLastScene() {
  const id = store.get('lastScene', '');
  const sc = id && sceneList().find((x) => x.id === id);
  if (!sc || sc.kind === 'saved') { S.state.elements = ensureSystem(S.state.elements || [], isVertical(), uid); return; }
  S.state = { ...S.state, layout: sc.kind === 'builtin' ? sc.layout : 'custom', scene: sc.id, elements: sceneElements(sc.id, sc.els || []) };
})();
const linkCode = /^\/[sc]\//.test(location.pathname) ? parseCode(location.pathname.replace(/^\/c\//, '/s/')) : '';
S.callin = location.pathname.startsWith('/c/');
if (linkCode) openEnter('join', linkCode);
window.__gather = S; // handy for debugging in the console
window.__acct = acct;
window.__cap = cap;
$('#liveOffRec').onclick = () => { $('#liveDlg').close(); if (!S.rec) toggleRecord(); };
$('#audioUnblock').onclick = () => tryPlayAll(); // the pointerdown handler above does the unmuting
setInterval(() => { if (S.studio && !S.rec && S.state?.rec?.on) renderDock(); }, 1000); // guests' REC timer

// ---------------------------------------------------------------- the public watch page (/w/<studio>)
// Viewers watch the program straight from this browser over WebRTC (no platform in between), chat, react, send
// super chats paid directly to the host, and ask to join the stage. A laptop can encode and upload the program
// for a handful of viewers, so the host sets a cap; past it, viewers fall back to the platform players.
const WATCH_DEFAULTS = { chat: true, supers: false, join: false, queue: false, voice: true, badge: true, direct: true, cap: 6, slow: 0, min: 2, about: '', links: [], pay: { paypal: '', venmo: '', cashapp: '', stripe: '' } };
const watchCfg = () => ({ ...WATCH_DEFAULTS, ...(S.state.watch || {}), pay: { ...WATCH_DEFAULTS.pay, ...(S.state.watch?.pay || {}) } });
// Signed-in hosts with a watch-page name share gather…/w/<name>, which follows them from show to show.
const myHandle = () => (isHost() && acct.user?.handle) || '';
// Your claimed name, else this studio's short link (/w/k7m2x); the long studio code is only a fallback.
const watchSlug = () => myHandle() || S.short || S.studio;
const watchLinkUrl = () => `${location.origin}/w/${watchSlug()}`;
const watchLinkText = () => watchLinkUrl().replace(/^https?:\/\/(www\.)?/, '');
const VIEW = new Map(); // viewer id -> { pc }
S.viewers = VIEW; // for the console and tests
let programStream = null;
let hwH264Cache = null;
/** Does this machine encode H.264 in hardware? The browser reports that as "power efficient". */
function hwH264() {
  hwH264Cache ||= (navigator.mediaCapabilities?.encodingInfo?.({ type: 'webrtc', video: { contentType: 'video/H264; profile-level-id=42e01f', width: 1280, height: 720, bitrate: 2_500_000, framerate: 30 } })
    .then((r) => !!(r.supported && r.powerEfficient)).catch(() => false)) || Promise.resolve(false);
  return hwH264Cache;
}
function programTracks() {
  audioCtx();
  const fps = S.local.pres?.game ? 60 : 30;
  if (!programStream || programStream.fps !== fps || programStream.getVideoTracks()[0]?.readyState !== 'live') { programStream = canvas.captureStream(fps); programStream.fps = fps; }
  // The program is text, slides and faces: tell the encoder sharpness matters more than smoothness (games: motion).
  const vt = programStream.getVideoTracks()[0]; if (vt) vt.contentHint = S.local.pres?.game ? 'motion' : 'detail';
  return [programStream.getVideoTracks()[0], recDest?.stream.getAudioTracks()[0]].filter(Boolean);
}
async function viewerWant(vid) {
  if (!isHost() || !S.studio) return;
  closeViewer(vid);
  const cfg = watchCfg();
  if (!cfg.direct || VIEW.size >= cfg.cap) return wsSend({ type: 'vsignal', to: vid, data: { bye: true } });
  const pc = new RTCPeerConnection({ iceServers: S.iceServers, bundlePolicy: 'max-bundle' });
  VIEW.set(vid, { pc });
  const ms = new MediaStream(programTracks());
  for (const t of ms.getTracks()) {
    const sender = pc.addTrack(t, ms);
    if (t.kind === 'video') {
      // H.264 first only where this machine encodes it in hardware (cheap per viewer, sharp); otherwise VP8,
      // which Chrome's software encoder handles much better than software H.264.
      try {
        if (await hwH264()) {
          const tr = pc.getTransceivers().find((x) => x.sender === sender), caps = RTCRtpSender.getCapabilities?.('video')?.codecs || [];
          const h264 = caps.filter((c) => /h264/i.test(c.mimeType)), rest = caps.filter((c) => !/h264/i.test(c.mimeType));
          if (h264.length) tr?.setCodecPreferences([...h264, ...rest]);
        }
      } catch {}
      tuneViewerSender(sender);
    }
  }
  pc.onicecandidate = (e) => { if (e.candidate) wsSend({ type: 'vsignal', to: vid, data: { candidate: e.candidate } }); };
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) closeViewer(vid); renderWatchSec(); };
  try { await pc.setLocalDescription(); wsSend({ type: 'vsignal', to: vid, data: { sdp: pc.localDescription } }); }
  catch (e) { console.warn('viewer offer failed', e); closeViewer(vid); }
  renderWatchSec();
}
// WebRTC starts every connection at a few hundred kbps and ramps up over ~10 s, so viewers first saw a 320x180
// picture. Start video at 2 Mbps (never below 800 kbps) so the first frames are already sharp. Chrome reads these
// hints from the codec parameters of the answer; other browsers ignore them.
function fastStart(sdp) {
  return String(sdp || '').replace(/^(a=fmtp:\d+ [^\r\n]*)/gm, (line) => (/x-google-start-bitrate/.test(line) || /apt=|opus|telephone/i.test(line) ? line : line + ';x-google-start-bitrate=2000;x-google-min-bitrate=800'))
    .replace(/^(a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\/90000)\r?$/gm, (m, line, pt) => (new RegExp(`^a=fmtp:${pt} `, 'm').test(sdp) ? line : `${line}\r\na=fmtp:${pt} x-google-start-bitrate=2000;x-google-min-bitrate=800`));
}
async function viewerSignal(vid, d) {
  const v = VIEW.get(vid);
  if (!v || !d) return;
  // A viewer picked a quality on their player: scale only their stream.
  if (d.quality) { v.q = d.quality; for (const s of v.pc.getSenders()) if (s.track?.kind === 'video') tuneViewerSender(s, v.q); return; }
  try { if (d.sdp) await v.pc.setRemoteDescription(d.sdp.type === 'answer' ? { type: 'answer', sdp: fastStart(d.sdp.sdp) } : d.sdp); else if (d.candidate) await v.pc.addIceCandidate(d.candidate).catch(() => {}); }
  catch (e) { console.warn('viewer signal', e); }
}
/** Viewer encoding: 2.5 Mbps at 30 fps; in game mode 60 fps (4 Mbps), keeping motion smooth over sharpness. */
function tuneViewerSender(sender, q) {
  const game = !!S.local.pres?.game;
  try {
    const p = sender.getParameters();
    const scale = { 720: 1, 480: 1.5, 360: 2 }[q] || 1;
    p.encodings = [{ ...(p.encodings?.[0] || {}), maxBitrate: Math.round((game ? 4_000_000 : 2_500_000) / scale / scale), maxFramerate: game ? 60 : 30, scaleResolutionDownBy: scale }];
    p.degradationPreference = game ? 'maintain-framerate' : 'maintain-resolution'; // short of bandwidth: drop frames, never blur
    sender.setParameters(p).catch(() => {});
  } catch {}
}
// Game mode on or off: hand every direct viewer the program at the new frame rate.
setInterval(() => {
  if (!VIEW.size || !programStream) return;
  const want = S.local.pres?.game ? 60 : 30;
  if (programStream.fps === want) return;
  const [video] = programTracks();
  for (const v of VIEW.values()) for (const s of v.pc.getSenders()) if (s.track?.kind === 'video') { s.replaceTrack(video).catch(() => {}); tuneViewerSender(s, v.q); }
}, 1000);
function closeViewer(vid) { const v = VIEW.get(vid); if (!v) return; VIEW.delete(vid); try { v.pc.close(); } catch {} renderWatchSec(); }
function closeAllViewers() { for (const vid of [...VIEW.keys()]) closeViewer(vid); }

// Super chats: a claim until the host sees the money arrive in their own PayPal/Venmo/Cash App/Stripe.
S.supers = new Map();
const PAY_NAME = { paypal: 'PayPal', venmo: 'Venmo', cashapp: 'Cash App', stripe: 'Stripe' };
const money = (a) => '$' + (Number.isInteger(a) ? a : Number(a).toFixed(2));
function gotSuperchat(item, fresh) {
  if (!item?.id) return;
  const had = S.supers.has(item.id);
  S.supers.set(item.id, item);
  if (fresh && !had && item.status === 'pending') {
    chime();
    toast(`${money(item.amount)} super chat from ${item.name} on ${PAY_NAME[item.method]}. Check it arrived, then confirm.`, { ms: 12000, action: ['Review', () => { setTab('show'); $('#watchSec')?.scrollIntoView({ block: 'start', behavior: smooth() }); }] });
  }
  renderSupers();
  superInChat(item);
}
/** Pending super chats also land in the studio chat, with the confirm buttons right there. Once confirmed, the paid
    message that every viewer sees replaces it (it arrives as a normal watch-page message with its amount). */
function superInChat(x) {
  const log = $('#msgs'); if (!log) return;
  let li = log.querySelector(`[data-sc="${CSS.escape(x.id)}"]`);
  if (x.status !== 'pending') { li?.remove(); return; }
  if (li) return;
  li = document.createElement('li'); li.className = 'msg ext paid sc-pending'; li.dataset.sc = x.id;
  const who = document.createElement('div'); who.className = 'who';
  const badge = document.createElement('span'); badge.className = 'pill caps src-watch'; badge.textContent = 'Super chat';
  const b = document.createElement('b'); b.textContent = x.name;
  const amt = document.createElement('span'); amt.className = 'paid-amt'; amt.textContent = money(x.amount);
  who.append(badge, b, amt);
  const txt = document.createElement('div'); txt.className = 'txt'; txt.textContent = x.text || '(no message)';
  const note = document.createElement('div'); note.className = 'sc-note'; note.textContent = `Check your ${PAY_NAME[x.method]} for ${money(x.amount)} from ${x.name}, then:`;
  const row = document.createElement('div'); row.className = 'row';
  const btn = (t, cls, act) => { const k = document.createElement('button'); k.type = 'button'; k.className = 'btn sm ' + cls; k.textContent = t; k.onclick = () => superAct(x, act); return k; };
  row.append(btn('Payment arrived · show it', 'primary', 'confirm'), btn('Not received', 'ghost', 'dismiss'));
  li.append(who, txt, note, row);
  appendLog(li);
}
function superAct(item, act) {
  wsSend({ type: 'superchat', id: item.id, do: act });
  item.status = { confirm: 'confirmed', dismiss: 'dismissed', answered: 'answered' }[act];
  if (act === 'confirm') setStage({ featured: { id: 'w-' + item.id, src: 'watch', name: item.name, text: item.text || 'Sent a super chat', paid: money(item.amount) } });
  if ((act === 'answered' || act === 'dismiss') && S.state.featured?.id === 'w-' + item.id) setStage({ featured: null });
  renderSupers(); superInChat(item);
}
function renderSupers() {
  const box = $('#scList'); if (!box) return;
  const items = [...S.supers.values()].filter((x) => x.status !== 'dismissed').sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || b.ts - a.ts);
  $('#scEmpty').hidden = !!items.length;
  const total = [...S.supers.values()].filter((x) => x.status === 'confirmed' || x.status === 'answered').reduce((s, x) => s + x.amount, 0);
  $('#scTotal').textContent = total ? `${money(total)} confirmed` : '';
  box.replaceChildren(...items.map((x) => {
    const li = document.createElement('li'); li.className = 'sc-item ' + x.status;
    const top = document.createElement('div'); top.className = 'sc-top';
    const amt = document.createElement('span'); amt.className = 'paid-amt'; amt.textContent = money(x.amount);
    const who = document.createElement('b'); who.textContent = x.name;
    const via = document.createElement('small'); via.textContent = `${PAY_NAME[x.method]} · ${x.status === 'pending' ? 'not confirmed yet' : x.status}`;
    top.append(amt, who, via);
    const txt = document.createElement('p'); txt.textContent = x.text || '(no message)';
    const row = document.createElement('div'); row.className = 'row';
    const btn = (t, cls, act) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm ' + cls; b.textContent = t; b.onclick = () => superAct(x, act); return b; };
    if (x.status === 'pending') row.append(btn('Payment arrived · show it', 'primary', 'confirm'), btn('Not received', 'ghost', 'dismiss'));
    else if (x.status === 'confirmed') row.append(btn('Answered', '', 'answered'));
    li.append(top, txt, row);
    return li;
  }));
}
async function refreshSupers() { if (!S.studio || !isHost()) return; try { for (const x of (await api('scList', creds())).items) gotSuperchat(x, false); } catch {} }

// Reactions from the watch page float over the host's stage view (never into the program).
function reactFloat(e) {
  const s = document.createElement('span'); s.className = 'react-float'; s.textContent = e; s.style.left = 10 + Math.random() * 80 + '%';
  $('#stage')?.append(s); setTimeout(() => s.remove(), 2600);
}

// The Show panel's watch page section.
function setWatch(patch) {
  const cfg = { ...watchCfg(), ...patch, pay: { ...watchCfg().pay, ...(patch.pay || {}) } };
  store.set('watchPrefs', cfg); // keep the handles for the next show
  if (isHost() && S.studio) setStage({ watch: cfg });
  renderWatchSec();
}
function renderWatchSec() {
  if (!window.__watchReady || !$('#watchSec')) return; // renderAll can run before this part of the module loads
  const cfg = watchCfg(), on = !!S.studio;
  $('#wpUrl').textContent = on ? watchLinkText() : 'Enter your studio to get its watch link';
  for (const id of ['#wpCopy', '#wpCard', '#wpOpen']) $(id).disabled = !on;
  $('#wpCount').textContent = on && cfg.direct ? `${VIEW.size} of ${cfg.cap} watching directly` : '';
  for (const [id, k] of [['#wpChat', 'chat'], ['#wpSupers', 'supers'], ['#wpJoin', 'join'], ['#wpDirect', 'direct'], ['#wpVoice', 'voice'], ['#wpBadge', 'badge']]) if ($(id) && document.activeElement !== $(id)) $(id).checked = cfg[k] !== false && !!(cfg[k] ?? true);
  for (const k of Object.keys(PAY_NAME)) { const el = $('#wpPay-' + k); if (document.activeElement !== el) el.value = cfg.pay[k] || ''; }
  if (document.activeElement !== $('#wpCap')) $('#wpCap').value = String(cfg.cap);
  if (document.activeElement !== $('#wpAbout')) $('#wpAbout').value = cfg.about || '';
  if (document.activeElement !== $('#wpLinks')) $('#wpLinks').value = (cfg.links || []).map((l) => `${l.label} | ${l.url}`).join('\n');
  if (document.activeElement !== $('#wpMin')) $('#wpMin').value = String(cfg.min);
  // Super chats: the payment fields are always shown, with one line saying what's left to do.
  const payOn = Object.values(cfg.pay).some(Boolean);
  $('#wpSupersState').textContent = cfg.supers && payOn ? 'On' : cfg.supers ? 'Needs a way to pay' : 'Off';
  $('#wpPayStatus').textContent = !payOn ? 'Add at least one way to get paid. Viewers pay you directly; gather never touches the money.'
    : cfg.supers ? 'Viewers see a Tip button in the chat on your watch page.' : 'Payments are set. Turn on super chats above to show the Tip button.';
  if (document.activeElement !== $('#wpQueue')) $('#wpQueue').checked = !!cfg.queue;
  if (window.__shopReady) { renderShop(); renderPoll(); renderEmotes(); }
  $('#wpNoPay').hidden = true; // replaced by #wpPayStatus
  renderHandle();
}
function renderHandle() {
  const u = acct.user, h = u?.handle || '';
  $('#wpHost').textContent = '/w/'; // the full address is spelled out in the note under the field
  if (document.activeElement !== $('#wpHandle')) $('#wpHandle').value = h;
  $('#wpHandle').disabled = $('#wpHandleSave').disabled = !u;
  $('#wpHandleSave').textContent = h ? 'Change' : 'Claim';
  $('#wpHandleNote').textContent = !u ? 'Sign in to claim a name. It always points at your current show.'
    : h ? `Same link every show: ${location.host.replace(/^www\./, '')}/w/${h}`
    : 'Pick a name once and share one link forever.';
}
$('#wpHandleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!acct.user) return openAccount('in');
  const h = $('#wpHandle').value.trim().toLowerCase();
  if (h === acct.user.handle) return;
  $('#wpHandleSave').disabled = true;
  try {
    const r = await acctApi('handle', { handle: h, studio: S.studio });
    setUser(r.user); toast(`Your watch page is now ${location.host}/w/${h}`);
    renderWatchSec();
  } catch (err) { $('#wpHandleNote').textContent = err.message; }
  finally { $('#wpHandleSave').disabled = false; }
});
$('#wpCopy').onclick = () => copy(watchLinkUrl(), 'Watch link copied. Share it anywhere.');
$('#wpOpen').onclick = () => window.open(watchLinkUrl(), '_blank', 'noopener');
$('#wpCard').onclick = () => {
  const els = elementsCopy().filter((e) => !(e.type === 'callin' && e.url === watchLinkUrl()));
  els.push(withDefaults({ type: 'callin', x: .66, y: .66, w: .31, h: .28, url: watchLinkUrl(), label: 'Watch, chat & join live', phone: '' }));
  setStage({ elements: els });
  toast('The watch link and its QR code are on stage.');
};
for (const [id, k] of [['#wpChat', 'chat'], ['#wpSupers', 'supers'], ['#wpJoin', 'join'], ['#wpDirect', 'direct'], ['#wpVoice', 'voice'], ['#wpBadge', 'badge']]) if ($(id)) $(id).onchange = (e) => setWatch({ [k]: e.target.checked });
$('#wpCap').onchange = (e) => setWatch({ cap: Number(e.target.value) });
$('#wpAbout').onchange = (e) => setWatch({ about: e.target.value.trim() });
$('#wpLinks').onchange = (e) => {
  const links = e.target.value.split('\n').map((line) => { const [a, b] = line.includes('|') ? line.split('|') : ['', line]; let url = (b || '').trim(); if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url; return { label: a.trim() || url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0], url }; }).filter((l) => /^https:\/\//.test(l.url)).slice(0, 6);
  setWatch({ links });
};
$('#wpMin').onchange = (e) => setWatch({ min: Math.max(1, Number(e.target.value) || 2) });
for (const k of Object.keys(PAY_NAME)) $('#wpPay-' + k).addEventListener('change', (e) => setWatch({ pay: { [k]: e.target.value.trim().replace(/^@|^\$/, '').replace(/^https?:\/\/(www\.)?paypal\.me\//i, '') } }));
setInterval(() => { if ($('#watchSec') && !$('#watchSec').closest('[hidden]')) renderWatchSec(); }, 3000);
window.__watchReady = true;
renderWatchSec();

// ---------------------------------------------------------------- shop: sell products live (checkout on the store's own site)
const shopCfg = () => ({ items: [], pinned: '', sale: null, store: '', ...(S.state.shop || {}) });
function setShop(patch) {
  const next = { ...shopCfg(), ...patch };
  store.set('shopItems', next.items); // the catalogue follows the host to their next show
  if (isHost() && S.studio) setStage({ shop: next }); else S.state.shop = next;
  renderShop();
}
const imgCache = new Map();
/** An image for the program canvas, only if its host allows cross-origin use: anything else would taint the canvas and break recording. */
function corsImg(url) {
  if (!url) return null;
  let e = imgCache.get(url);
  if (!e) { e = { img: new Image(), ok: false }; e.img.crossOrigin = 'anonymous'; e.img.onload = () => { e.ok = true; }; e.img.src = url; imgCache.set(url, e); }
  return e.ok ? e.img : null;
}
function renderShop() {
  if (!$('#shopList')) return;
  const sh = shopCfg();
  $('#shopCount').textContent = sh.items.length ? `${sh.items.length} product${sh.items.length === 1 ? '' : 's'}${sh.pinned ? ' · 1 pinned' : ''}` : '';
  $('#shopList').replaceChildren(...sh.items.map((p) => {
    const li = document.createElement('li'); li.className = 'shop-item' + (sh.pinned === p.id ? ' pinned' : '');
    const im = document.createElement(p.img ? 'img' : 'div'); if (p.img) { im.src = p.img; im.alt = ''; im.loading = 'lazy'; } else im.className = 'ph';
    const txt = document.createElement('div'); const t = document.createElement('b'); t.textContent = p.title; const sm = document.createElement('small');
    const onSale = sh.sale?.id === p.id && sh.sale.until > Date.now();
    sm.textContent = [p.price, p.src === 'shopify' ? 'Shopify' : p.src === 'etsy' ? 'Etsy' : 'Link', onSale ? `Flash sale ${sh.sale.pct ? sh.sale.pct + '% off' : ''} · ${sh.sale.code} · ${fmtTime(sh.sale.until - Date.now())} left` : ''].filter(Boolean).join(' · ');
    txt.append(t, sm);
    const acts = document.createElement('div'); acts.className = 'acts';
    const btn = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm ' + cls; b.textContent = label; b.onclick = fn; return b; };
    acts.append(
      btn(sh.pinned === p.id ? 'Unpin' : 'Pin', sh.pinned === p.id ? '' : 'primary', () => setShop({ pinned: sh.pinned === p.id ? '' : p.id })),
      btn(onSale ? 'End sale' : 'Flash sale', '', () => {
        if (onSale) return setShop({ sale: null });
        const code = prompt('Discount code buyers enter at checkout (create it in your store first):', 'LIVE20'); if (!code) return;
        const pct = Number(prompt('How much off, in percent? (shown on screen)', '20')) || 0;
        const mins = Number(prompt('How many minutes should it last?', '10')) || 10;
        setShop({ pinned: p.id, sale: { id: p.id, code: code.trim().slice(0, 24), pct: Math.min(95, Math.max(0, pct)), until: Date.now() + mins * 60e3 } });
        toast(`Flash sale on: ${code} for ${mins} min.`);
      }),
      btn('Remove', 'ghost', () => setShop({ items: sh.items.filter((x) => x.id !== p.id), pinned: sh.pinned === p.id ? '' : sh.pinned, sale: sh.sale?.id === p.id ? null : sh.sale })),
    );
    li.append(im, txt, acts);
    return li;
  }));
}
$('#shopAdd').onclick = () => {
  let url = $('#shopUrl').value.trim(); if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  const title = $('#shopTitle').value.trim(), img = $('#shopImg').value.trim();
  if (!title || !/^https:\/\//.test(url)) return toast('Add a name and an https:// product link.', { err: true });
  const src = /etsy\.com/i.test(url) ? 'etsy' : /myshopify\.com|shopify/i.test(url) ? 'shopify' : 'link';
  setShop({ items: [...shopCfg().items, { id: uid(), title, price: $('#shopPrice').value.trim(), url, img: /^https:\/\//.test(img) ? img : '', src }].slice(0, 24) });
  for (const id of ['#shopTitle', '#shopPrice', '#shopUrl', '#shopImg']) $(id).value = '';
};
// Shopify's Storefront API is made for browsers (public token, CORS allowed), so products load straight from the store.
$('#shopDomain').value = store.get('shopDomain', ''); $('#shopToken').value = store.get('shopToken', '');
$('#shopLoad').onclick = async () => {
  const domain = $('#shopDomain').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''), token = $('#shopToken').value.trim();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain) || !token) return toast('Add your store address and its Storefront token.', { err: true });
  store.set('shopDomain', domain); store.set('shopToken', token);
  $('#shopMsg').textContent = 'Loading…';
  try {
    const r = await fetch(`https://${domain}/api/2025-01/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': token },
      body: JSON.stringify({ query: '{ products(first: 24, sortKey: BEST_SELLING) { nodes { id title handle onlineStoreUrl featuredImage { url(transform: { maxWidth: 480 }) } priceRange { minVariantPrice { amount currencyCode } } } } }' }) });
    const j = await r.json();
    if (!r.ok || j.errors) throw new Error(j.errors?.[0]?.message || `Shopify answered ${r.status}`);
    const fmt = (p) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currencyCode }).format(p.amount); } catch { return p.amount; } };
    const items = j.data.products.nodes.map((n) => ({ id: n.id.split('/').pop().slice(-12), title: n.title, price: fmt(n.priceRange.minVariantPrice), img: n.featuredImage?.url || '', url: n.onlineStoreUrl || `https://${domain}/products/${n.handle}`, src: 'shopify' }));
    const keep = shopCfg().items.filter((x) => x.src !== 'shopify');
    setShop({ items: [...items, ...keep].slice(0, 24), store: domain });
    $('#shopMsg').textContent = `${items.length} products loaded.`;
  } catch (e) { $('#shopMsg').textContent = ''; toast('Couldn’t load your Shopify products: ' + e.message, { err: true, ms: 8000 }); }
};
/** The pinned product on stage, with a flash-sale countdown. Bottom-left, or top-left when a chat card is showing. */
function drawProduct() {
  const sh = S.state.shop, p = sh?.items?.find((x) => x.id === sh.pinned);
  if (!p) return;
  const sale = sh.sale?.id === p.id && sh.sale.until > Date.now() ? sh.sale : null;
  const w = 420, h = sale ? 132 : 104, x = 28, y = S.state.featured ? 28 : H - h - 28;
  g.save();
  g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 24; g.shadowOffsetY = 8;
  g.fillStyle = '#ffffff'; rr(x, y, w, h, 16); g.fill(); g.shadowColor = 'transparent';
  const im = corsImg(p.img), pad = 14, is = h - pad * 2;
  if (im) { g.save(); rr(x + pad, y + pad, is, is, 10); g.clip(); const k = Math.max(is / im.naturalWidth, is / im.naturalHeight); g.drawImage(im, x + pad + (is - im.naturalWidth * k) / 2, y + pad + (is - im.naturalHeight * k) / 2, im.naturalWidth * k, im.naturalHeight * k); g.restore(); }
  else { g.fillStyle = S.state.brand.color; rr(x + pad, y + pad, is, is, 10); g.fill(); g.fillStyle = '#fff'; g.font = '800 30px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('🛍', x + pad + is / 2, y + pad + is / 2); }
  const tx = x + pad * 2 + is;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillStyle = sale ? '#dc2626' : '#16a34a'; g.font = '800 12px Inter, sans-serif';
  g.fillText(sale ? `FLASH SALE${sale.pct ? ' · ' + sale.pct + '% OFF' : ''}` : 'SHOP THE SHOW', tx, y + 30);
  g.fillStyle = '#111827'; g.font = '700 20px Inter, sans-serif';
  g.fillText(wrapLines(p.title, w - (tx - x) - pad, 1)[0] || p.title, tx, y + 56);
  g.fillStyle = '#374151'; g.font = '600 16px Inter, sans-serif'; g.fillText(p.price || '', tx, y + 80);
  if (sale) { g.fillStyle = '#111827'; g.font = '700 15px Inter, sans-serif'; g.fillText(`Code ${sale.code} · ends in ${fmtTime(sale.until - Date.now())}`, tx, y + 110); }
  g.restore();
}

// ---------------------------------------------------------------- polls and predictions
let pollKind = 'poll';
S.pollCounts = [];
$$('#pollKind button').forEach((b) => b.addEventListener('click', () => { pollKind = b.dataset.kind; $$('#pollKind button').forEach((x) => x.setAttribute('aria-checked', String(x === b))); }));
$('#pollGo').onclick = () => {
  const q = $('#pollQ').value.trim(), opts = $('#pollOpts').value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 4);
  if (!q || opts.length < 2) return toast('Add a question and at least two choices.', { err: true });
  setStage({ poll: { id: uid().slice(0, 8), kind: pollKind, q, opts, until: Date.now() + Number($('#pollMins').value) * 60e3, answer: -1 } });
  S.pollCounts = opts.map(() => 0); renderPoll();
};
$('#pollEnd').onclick = () => { if (S.state.poll) setStage({ poll: { ...S.state.poll, until: Math.min(S.state.poll.until, Date.now()) } }); renderPoll(); };
function renderPoll() {
  const p = S.state.poll, box = $('#pollLive'); if (!box) return;
  if (!p) { box.replaceChildren(); $('#pollState').textContent = ''; return; }
  const open = p.until > Date.now(), total = S.pollCounts.reduce((a, b) => a + b, 0);
  $('#pollState').textContent = open ? `Live · ${fmtTime(p.until - Date.now())} left · ${total} vote${total === 1 ? '' : 's'}` : `Closed · ${total} votes`;
  const rows = p.opts.map((o, i) => {
    const n = S.pollCounts[i] || 0, pct = total ? Math.round(n / total * 100) : 0;
    const d = document.createElement('div'); d.className = 'poll-bar';
    const bar = document.createElement('i'); bar.style.width = pct + '%';
    const l = document.createElement('span'); l.textContent = (p.answer === i ? '✓ ' : '') + o; const r = document.createElement('b'); r.textContent = `${pct}% · ${n}`;
    d.append(bar, l, r);
    if (p.kind === 'predict' && !open && p.answer < 0) { d.style.cursor = 'pointer'; d.title = 'Settle the prediction with this answer'; d.onclick = () => setStage({ poll: { ...p, answer: i } }); }
    return d;
  });
  const title = document.createElement('p'); title.className = 'hint'; title.style.margin = '0';
  title.textContent = p.kind === 'predict' && !open && p.answer < 0 ? 'Voting closed. Click the right answer to settle the prediction.' : p.q;
  const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'btn sm ghost'; clear.textContent = 'Remove from screen'; clear.onclick = () => setStage({ poll: null });
  box.replaceChildren(title, ...rows, clear);
}
/** The host reads live counts from the same cached feed viewers use (one GET every 2 s, only while a poll exists). */
setInterval(async () => {
  if (!isHost() || !S.studio || !S.state.poll) return;
  try { const f = await (await fetch(`/api/studio?action=wfeed&studio=${encodeURIComponent(S.studio)}`)).json(); if (f.poll?.id === S.state.poll.id) S.pollCounts = f.poll.counts; } catch {}
  renderPoll();
}, 2000);
function drawPoll() {
  const p = S.state.poll; if (!p) return;
  const open = p.until > Date.now(), total = (S.pollCounts || []).reduce((a, b) => a + b, 0);
  const w = 360, rowH = 34, h = 70 + p.opts.length * (rowH + 8), x = W - w - 28, y = 28;
  g.save();
  g.fillStyle = 'rgba(10,14,26,.86)'; rr(x, y, w, h, 16); g.fill();
  g.fillStyle = '#9ca3af'; g.font = '800 12px Inter, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillText((p.kind === 'predict' ? 'PREDICTION' : 'POLL') + (open ? ` · ${fmtTime(p.until - Date.now())} · vote on the watch page` : ` · ${total} votes`), x + 18, y + 26);
  g.fillStyle = '#fff'; g.font = '700 18px Inter, sans-serif'; g.fillText(wrapLines(p.q, w - 36, 1)[0] || p.q, x + 18, y + 52);
  p.opts.forEach((o, i) => {
    const n = (S.pollCounts || [])[i] || 0, pct = total ? n / total : 0, ry = y + 66 + i * (rowH + 8);
    g.fillStyle = 'rgba(255,255,255,.08)'; rr(x + 18, ry, w - 36, rowH, 8); g.fill();
    g.fillStyle = p.answer === i ? '#16a34a' : S.state.brand.color; if (pct) { rr(x + 18, ry, Math.max(12, (w - 36) * pct), rowH, 8); g.fill(); }
    g.fillStyle = '#fff'; g.font = '600 15px Inter, sans-serif'; g.fillText((p.answer === i ? '✓ ' : '') + o, x + 30, ry + 22);
    g.textAlign = 'right'; g.fillText(total ? Math.round(pct * 100) + '%' : '', x + w - 30, ry + 22); g.textAlign = 'left';
  });
  g.restore();
}

// ---------------------------------------------------------------- play with me: the viewer queue
S.queue = [];
function gotQueue(m) { chime(); toast(`${m.name}${m.tag ? ' (' + m.tag + ')' : ''} wants to play.`, { action: ['Open', () => { setTab('show'); $('#queueSec').open = true; }] }); S.queue.push({ name: m.name, tag: m.tag, status: 'waiting', ts: Date.now() }); renderQueue(S.queue); }
function renderQueue(items) {
  if (items) S.queue = items;
  if (!$('#queueList')) return;
  const waiting = S.queue.filter((x) => x.status !== 'called');
  $('#queueCount').textContent = waiting.length ? `${waiting.length} waiting` : '';
  $('#queueList').replaceChildren(...S.queue.map((x) => { const li = document.createElement('li'); li.className = x.status; const a = document.createElement('span'); a.textContent = x.name; const b = document.createElement('small'); b.textContent = x.status === 'called' ? 'called' : x.tag || ''; li.append(a, b); return li; }));
}
$('#queueNext').onclick = () => { wsSend({ type: 'qpick' }); toast('The next player sees “You’re up!” with a button to join the stage.'); };
$('#queueClear').onclick = () => { wsSend({ type: 'qclear' }); S.queue = []; renderQueue(); };
$('#wpQueue').onchange = (e) => setWatch({ queue: e.target.checked });

// ---------------------------------------------------------------- custom emotes
function renderEmotes() {
  if (!$('#emoteList')) return;
  const list = S.state.emotes || [];
  $('#emoteCount').textContent = list.length ? `${list.length}` : '';
  $('#emoteList').replaceChildren(...list.map((e) => {
    const f = document.createElement('figure'); const src = assetImg(e.asset)?.src; const im = document.createElement(src ? 'img' : 'span'); if (src) { im.alt = e.name; im.src = src; } else { im.className = 'ph'; im.textContent = '…'; } const c = document.createElement('figcaption'); c.textContent = `:${e.name}:`;
    f.title = 'Click to remove'; f.style.cursor = 'pointer'; f.onclick = () => setStage({ emotes: list.filter((x) => x !== e) });
    f.append(im, c); return f;
  }));
}
$('#emoteAdd').onclick = () => { if (!/^[a-z0-9_]{2,20}$/i.test($('#emoteName').value.trim())) return toast('Name the emote first: 2–20 letters or numbers.', { err: true }); $('#emoteFile').click(); };
$('#emoteFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !S.studio) return;
  if (f.size > 400_000) return toast('That image is too big. Use one under 200 KB.', { err: true });
  try {
    const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
    const asset = await storeAsset(data);
    setStage({ emotes: [...(S.state.emotes || []).filter((x) => x.name !== $('#emoteName').value.trim().toLowerCase()), { name: $('#emoteName').value.trim().toLowerCase(), asset }] });
    $('#emoteName').value = ''; toast('Emote added.');
  } catch (err) { toast(err.message, { err: true }); }
};

// ---------------------------------------------------------------- vertical: tell the watch page where the speaker is
let lastFocus = 0.5;
setInterval(() => {
  if (!isHost() || !S.studio || !camRects.length) return;
  const now = performance.now(), ids = S.state.stage || [];
  let best = -1, bestT = -1;
  ids.forEach((id, i) => { const t = speaking.get(id) || -1; if (camRects[i] && t > bestT && now - t < 1500) { bestT = t; best = i; } });
  const r = camRects[best >= 0 ? best : 0];
  const focus = Math.round(((r.x + r.w / 2) / W) * 100) / 100;
  if (Math.abs(focus - lastFocus) >= 0.08) { lastFocus = focus; setStage({ focus }); }
}, 2000);

window.__shopReady = true;
setInterval(() => { if (isHost() && $('#shopSec')?.open) renderShop(); }, 1000);

// ---------------------------------------------------------------- voice questions: raised hands from the watch page
// A viewer records up to 45 s; their browser transcribes it. The host reads the transcript first, then previews it
// privately, plays it on air (into the program, so the stream, the recording and the guests hear it), or deletes it.
S.vms = new Map();
const vmAudio = new Map(); // id -> data URL, fetched on first use
function gotVoice(item, fresh) {
  if (!item?.id) return;
  const had = S.vms.has(item.id);
  S.vms.set(item.id, { ...(S.vms.get(item.id) || {}), ...item });
  if (fresh && !had) { chime(); toast(`🎙 ${item.name} raised a hand with a voice question.`, { ms: 9000, action: ['Review', () => { setTab('show'); $('#vmList')?.scrollIntoView({ block: 'center', behavior: smooth() }); }] }); }
  renderVoice();
}
function dropVoice(id) { S.vms.delete(id); vmAudio.delete(id); renderVoice(); }
async function refreshVoice() { if (!S.studio || !isHost()) return; try { for (const x of (await api('vmList', creds())).items) gotVoice(x, false); } catch {} }
async function voiceData(id) {
  if (!vmAudio.has(id)) vmAudio.set(id, (await api('vmGet', { ...creds(), vm: id })).data);
  return vmAudio.get(id);
}
let vmPlaying = null;
async function playVoice(x, onAir) {
  try {
    vmPlaying?.stop();
    const a = new Audio(await voiceData(x.id));
    let mix = null;
    if (onAir) {
      // Into the program mix (stream, recording, guests) and to the host's own speakers.
      const node = audioCtx().createMediaElementSource(a);
      mix = mixInMedia(node); node.connect(audioCtx().destination);
      setStage({ featured: { id: 'vm-' + x.id, src: 'watch', name: x.name, text: x.transcript || 'Voice question', paid: '🎙' } });
      wsSend({ type: 'vmMark', id: x.id, status: 'aired' });
    } else wsSend({ type: 'vmMark', id: x.id, status: 'heard' });
    const stop = () => { try { a.pause(); } catch {} mix?.dispose(); if (vmPlaying?.a === a) vmPlaying = null; renderVoice(); };
    a.onended = stop;
    vmPlaying = { a, id: x.id, onAir, stop };
    await a.play();
    renderVoice();
  } catch (e) { toast(e.message || 'Couldn’t play that voice question.', { err: true }); }
}
async function aiTranscribe(x) {
  const key = store.get('aiKey:openai', '');
  if (!key) { toast('Add a ChatGPT (OpenAI) key in the AI panel for AI transcripts.', { err: true }); return setTab('ai'); }
  try {
    const r = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'stt', apiKey: key, data: await voiceData(x.id) }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error);
    x.transcript = j.text; x.ai = true; renderVoice();
  } catch (e) { toast(e.message, { err: true }); }
}
function voiceRow(x, inChat) {
  const li = document.createElement('li'); li.className = (inChat ? 'msg ext vm-msg ' : 'sc-item ') + 'vm ' + (x.status || 'new'); li.dataset.vm = x.id;
  const top = document.createElement('div'); top.className = inChat ? 'who' : 'sc-top';
  const badge = document.createElement('span'); badge.className = 'pill caps src-watch'; badge.textContent = '🎙 Voice question';
  const who = document.createElement('b'); who.textContent = x.name;
  const meta = document.createElement('small'); meta.textContent = `${x.dur || '?'} s${x.status === 'aired' ? ' · played on air' : x.status === 'heard' ? ' · previewed' : ''}`;
  top.append(badge, who, meta);
  const txt = document.createElement('p'); txt.className = 'vm-text'; txt.textContent = x.transcript ? `“${x.transcript}”` : 'No transcript (their browser couldn’t transcribe). Preview it, or get an AI transcript.';
  if (x.ai) { const s = document.createElement('small'); s.textContent = ' · AI transcript'; txt.append(s); }
  const row = document.createElement('div'); row.className = 'row';
  const btn = (t, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm ' + cls; b.textContent = t; b.onclick = fn; return b; };
  const playing = vmPlaying?.id === x.id;
  row.append(
    playing ? btn('Stop', 'danger', () => vmPlaying.stop()) : btn('Preview (only you)', '', () => playVoice(x, false)),
    btn('Play on air', 'primary', () => playVoice(x, true)),
    btn('AI transcript', 'ghost', () => aiTranscribe(x)),
    btn('Delete', 'ghost', () => { if (vmPlaying?.id === x.id) vmPlaying.stop(); wsSend({ type: 'vmDel', id: x.id }); dropVoice(x.id); if (S.state.featured?.id === 'vm-' + x.id) setStage({ featured: null }); }),
  );
  li.append(top, txt, row);
  return li;
}
function renderVoice() {
  if (!$('#vmList')) return;
  const items = [...S.vms.values()].sort((a, b) => b.ts - a.ts);
  $('#vmEmpty').hidden = !!items.length;
  const fresh = items.filter((x) => x.status === 'new').length;
  $('#vmCount').textContent = items.length ? `${items.length}${fresh ? ` · ${fresh} new` : ''}` : '';
  $('#vmList').replaceChildren(...items.map((x) => voiceRow(x, false)));
  // In the studio chat too, so a raised hand is seen where the host is already looking.
  const log = $('#msgs');
  if (log) for (const x of items) { const old = log.querySelector(`[data-vm="${CSS.escape(x.id)}"]`); const el = voiceRow(x, true); if (old) old.replaceWith(el); else appendLog(el); }
  if (log) for (const el of log.querySelectorAll('[data-vm]')) if (!S.vms.has(el.dataset.vm)) el.remove();
}

// ---------------------------------------------------------------- where viewers find the watch page
$('#watchTop').onclick = (ev) => {
  if (!S.studio) return;
  const url = watchLinkUrl();
  copy(url, 'Watch link copied. Share it anywhere.');
  if (ev.shiftKey || ev.metaKey) window.open(url, '_blank', 'noopener');
};
$('#copyWatch').onclick = () => copy(watchLinkUrl(), 'Watch link copied.');
$('#openWatch').onclick = () => window.open(watchLinkUrl(), '_blank', 'noopener');
$('#inviteDlg').addEventListener('toggle', () => { if ($('#inviteDlg').open && S.studio) $('#inviteWatch').textContent = watchLinkText(); });
/** On stream: "Watch & chat live · host/w/code", bottom right, unless the host turned it off or placed the QR card. */
function drawWatchBadge() {
  if (!S.studio || watchCfg().badge === false) return;
  if ((S.state.elements || []).some((e) => e.type === 'callin' && !e.hidden)) return;
  const text = watchLinkText(), label = 'WATCH & CHAT LIVE';
  g.save();
  g.font = '700 15px Inter, sans-serif'; const tw = g.measureText(text).width;
  g.font = '800 11px Inter, sans-serif'; const lw = g.measureText(label).width;
  const w = Math.max(tw, lw) + 56, h = 50, tick = (stageElements().find((e) => e.type === 'ticker' && !e.hidden) && S.state.ticker) ? 56 : 0;
  const x = W - w - 24, y = H - h - 24 - tick;
  g.fillStyle = 'rgba(8,12,22,.82)'; rr(x, y, w, h, 12); g.fill();
  g.fillStyle = S.state.brand.color; rr(x + 12, y + 15, 20, 20, 6); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(x + 19, y + 20); g.lineTo(x + 27, y + 25); g.lineTo(x + 19, y + 30); g.closePath(); g.fill();
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#9ca3af'; g.font = '800 11px Inter, sans-serif'; g.fillText(label, x + 42, y + 20);
  g.fillStyle = '#fff'; g.font = '700 15px Inter, sans-serif'; g.fillText(text, x + 42, y + 38);
  g.restore();
}

// Panel sections remember being folded (per browser), so each host's panels open the way they left them.
{
  const folded = new Set(store.get('foldedSecs', []));
  for (const d of document.querySelectorAll('details.psec[data-sec]')) {
    if (folded.has(d.dataset.sec)) d.open = false;
    d.addEventListener('toggle', () => { if (d.open) folded.delete(d.dataset.sec); else folded.add(d.dataset.sec); store.set('foldedSecs', [...folded]); });
  }
}

// Keyboard users get focus rings everywhere; pointer users don't see a ring left on a header button after a click.
addEventListener('keydown', (e) => { if (e.key === 'Tab' || e.key.startsWith('Arrow')) document.body.classList.add('kbd'); }, true);
addEventListener('pointerdown', () => document.body.classList.remove('kbd'), true);

// The studio's light: a tiny copy of the stage, blurred huge behind the glass, so the room takes on the show's colours.
{
  const amb = document.createElement('canvas'); amb.className = 'amb'; amb.width = 48; amb.height = 27;
  document.querySelector('.backdrop')?.append(amb);
  const cx = amb.getContext('2d', { alpha: false });
  const quiet = matchMedia('(prefers-reduced-transparency: reduce)');
  setInterval(() => {
    if (document.hidden || quiet.matches || document.body.classList.contains('pre')) return;
    try { cx.drawImage(canvas, 0, 0, amb.width, amb.height); amb.classList.add('on'); } catch {}
  }, 400);
}
