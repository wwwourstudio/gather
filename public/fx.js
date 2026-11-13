// gather — camera and microphone processing, all in the browser.
// Video: light correction, background blur / replacement (AI person segmentation) and chroma-key green screen,
//        composited in WebGL2 and sent as an ordinary video track.
// Audio: AI noise removal (RNNoise) and input gain, sent as an ordinary audio track.

// ------------------------------------------------------------------ audio
let rnMod = null, rnWasm = null;
const rnReady = new WeakSet();
async function rnnoiseNode(ctx) {
  if (ctx.sampleRate !== 48000) throw new Error('AI noise removal needs 48 kHz audio.');
  rnMod ||= import('/vendor/noise/index.js');
  const m = await rnMod;
  rnWasm ||= m.loadRnnoise({ url: '/vendor/noise/rnnoise.wasm', simdUrl: '/vendor/noise/rnnoise_simd.wasm' });
  const wasmBinary = await rnWasm;
  if (!rnReady.has(ctx)) { await ctx.audioWorklet.addModule('/vendor/noise/rnnoise/workletProcessor.js'); rnReady.add(ctx); }
  return new m.RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
}

/** mic track → [RNNoise] → gain → new track. The raw track's `enabled` still mutes everything. */
export async function createAudioChain(ctx, rawTrack, { aiNoise = false, gain = 1 } = {}) {
  const src = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
  const g = ctx.createGain(); g.gain.value = gain;
  const dest = ctx.createMediaStreamDestination();
  let rn = null, note = '';
  if (aiNoise) {
    try { rn = await rnnoiseNode(ctx); src.connect(rn); rn.connect(g); }
    catch (e) { note = e.message; src.connect(g); }
  } else src.connect(g);
  g.connect(dest);
  return {
    track: dest.stream.getAudioTracks()[0], note, ai: !!rn,
    setGain(v) { g.gain.value = v; },
    dispose() { try { src.disconnect(); rn?.disconnect(); g.disconnect(); } catch {} try { rn?.destroy(); } catch {} },
  };
}

// ------------------------------------------------------------------ video
const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = vec2((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision mediump float;
in vec2 uv; out vec4 o;
uniform sampler2D uFrame, uBg, uMask;
uniform int uMode;            // 0 none, 1 chroma key, 2 AI mask
uniform vec2 uKey;            // key colour in CbCr
uniform float uTol, uSoft, uBright, uContrast, uSat;
vec2 cbcr(vec3 c) { return vec2(-0.1687 * c.r - 0.3313 * c.g + 0.5 * c.b, 0.5 * c.r - 0.4187 * c.g - 0.0813 * c.b); }
void main() {
  vec3 raw = texture(uFrame, uv).rgb;
  vec3 c = (raw - 0.5) * uContrast + 0.5 + uBright;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = clamp(mix(vec3(l), c, uSat), 0.0, 1.0);
  float a = 1.0;
  if (uMode == 1) {
    float d = distance(cbcr(raw), uKey);
    a = smoothstep(uTol, uTol + uSoft, d);
    // spill suppression: pull the key colour out of edges
    float m = max(c.r, c.b);
    c.g = mix(min(c.g, m), c.g, a);
  } else if (uMode == 2) {
    a = smoothstep(0.3, 0.7, texture(uMask, uv).r);
  }
  vec3 bg = texture(uBg, uv).rgb;
  o = vec4(mix(bg, c, a), 1.0);
}`;

function hexToCbCr(hex) {
  const n = parseInt(String(hex || '#00ff00').slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  return [-0.1687 * r - 0.3313 * g + 0.5 * b, 0.5 * r - 0.4187 * g - 0.0813 * b];
}

let segLoad = null;
function loadSegmenter() {
  segLoad ||= new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = '/vendor/selfie/selfie_segmentation.js';
    sc.onload = () => {
      try {
        const seg = new window.SelfieSegmentation({ locateFile: (f) => '/vendor/selfie/' + f });
        seg.setOptions({ modelSelection: 1, selfieMode: false });
        res(seg);
      } catch (e) { rej(e); }
    };
    sc.onerror = () => { segLoad = null; rej(new Error('Could not load the background model.')); };
    document.head.append(sc);
  });
  return segLoad;
}

/**
 * opts: { effect: 'none'|'blur'|'image'|'green', bgImage: HTMLImageElement|null, key: '#00ff00', tol: .1, soft: .08,
 *         bright: 0, contrast: 1, sat: 1 }
 * Returns { track, set(opts), stop(), active } — when nothing needs processing, `track` is the original camera track.
 */
export function needsProcessing(o) {
  return (o.effect && o.effect !== 'none') || Math.abs(o.bright || 0) > 0.001 || Math.abs((o.contrast ?? 1) - 1) > 0.001 || Math.abs((o.sat ?? 1) - 1) > 0.001;
}

export async function createVideoFx(srcTrack, opts) {
  const s = srcTrack.getSettings();
  const W = s.width || 1280, H = s.height || 720;
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.srcObject = new MediaStream([srcTrack]);
  await video.play().catch(() => {});
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false });
  if (!gl) throw new Error('This browser cannot run video effects (WebGL2 is unavailable).');

  const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = (unit) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
  const tFrame = tex(0), tBg = tex(1), tMask = tex(2);
  const U = (n) => gl.getUniformLocation(prog, n);
  gl.uniform1i(U('uFrame'), 0); gl.uniform1i(U('uBg'), 1); gl.uniform1i(U('uMask'), 2);
  const upload = (unit, t, src) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); };

  // Background sources
  const blurC = document.createElement('canvas'); blurC.width = 320; blurC.height = Math.round(320 * H / W);
  const blurG = blurC.getContext('2d');
  const imgC = document.createElement('canvas'); imgC.width = W; imgC.height = H;
  const imgG = imgC.getContext('2d');
  const maskIn = document.createElement('canvas'); maskIn.width = 256; maskIn.height = 144;
  const maskInG = maskIn.getContext('2d', { willReadFrequently: true });
  const maskOut = maskInG.createImageData(256, 144);
  let maskChannel = -1; // 0 = red, 3 = alpha; detected from the first mask

  let o = { effect: 'none', key: '#00ff00', tol: 0.1, soft: 0.08, bright: 0, contrast: 1, sat: 1, bgImage: null, ...opts };
  let seg = null, segBusy = false, haveMask = false, stopped = false, note = '';

  function paintImageBg() {
    imgG.fillStyle = '#0b1530'; imgG.fillRect(0, 0, W, H);
    const im = o.bgImage;
    if (im && im.naturalWidth) {
      const k = Math.max(W / im.naturalWidth, H / im.naturalHeight), dw = im.naturalWidth * k, dh = im.naturalHeight * k;
      imgG.drawImage(im, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
      const g = imgG.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#12264f'); g.addColorStop(1, '#2d2f70');
      imgG.fillStyle = g; imgG.fillRect(0, 0, W, H);
    }
    upload(1, tBg, imgC);
  }
  async function ensureSeg() {
    if (seg || !['blur', 'image'].includes(o.effect)) return;
    try {
      seg = await loadSegmenter();
      seg.onResults((r) => {
        maskInG.clearRect(0, 0, 256, 144);
        maskInG.drawImage(r.segmentationMask, 0, 0, 256, 144);
        const d = maskInG.getImageData(0, 0, 256, 144).data;
        if (maskChannel < 0) { let minA = 255; for (let i = 3; i < d.length; i += 4) minA = Math.min(minA, d[i]); maskChannel = minA < 250 ? 3 : 0; }
        const out = maskOut.data;
        for (let i = 0; i < d.length; i += 4) { const v = d[i + maskChannel]; out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255; }
        upload(2, tMask, maskOut);
        haveMask = true;
      });
    } catch (e) { note = e.message; }
  }
  function apply(next) {
    o = { ...o, ...next };
    gl.uniform2f(U('uKey'), ...hexToCbCr(o.key));
    gl.uniform1f(U('uTol'), o.tol); gl.uniform1f(U('uSoft'), o.soft);
    gl.uniform1f(U('uBright'), o.bright); gl.uniform1f(U('uContrast'), o.contrast); gl.uniform1f(U('uSat'), o.sat);
    if (o.effect === 'image' || (o.effect === 'green' && o.bgImage)) paintImageBg();
    ensureSeg();
  }
  apply({});
  upload(2, tMask, maskOut); // empty mask until the model answers

  function frame() {
    if (stopped) return;
    if (video.readyState >= 2) {
      upload(0, tFrame, video);
      const blurBg = o.effect === 'blur' || (o.effect === 'green' && !o.bgImage);
      if (blurBg) { blurG.filter = 'blur(8px)'; blurG.drawImage(video, -16, -16, blurC.width + 32, blurC.height + 32); upload(1, tBg, blurC); }
      const mode = o.effect === 'green' ? 1 : (o.effect === 'blur' || o.effect === 'image') && haveMask ? 2 : 0;
      gl.uniform1i(U('uMode'), mode);
      gl.viewport(0, 0, W, H);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (seg && !segBusy && (o.effect === 'blur' || o.effect === 'image')) {
        segBusy = true;
        seg.send({ image: video }).catch(() => {}).finally(() => { segBusy = false; });
      }
    }
  }
  // Keep processing when the tab is in the background (rAF pauses there).
  const timer = setInterval(frame, 1000 / 30);
  const track = canvas.captureStream(30).getVideoTracks()[0];
  track.contentHint = 'motion';
  return {
    track, canvas,
    get note() { return note; },
    set: apply,
    stop() { stopped = true; clearInterval(timer); track.stop(); video.srcObject = null; },
  };
}
