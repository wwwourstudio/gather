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
// A multi-pass WebGL2 pipeline:
//   1. mask    MediaPipe's low-res person mask, smoothed over time (motion-adaptive, so still edges stop
//              shimmering and moving edges still follow at once)
//   2. pre     the camera frame with the person weighted out, at quarter resolution (premultiplied)
//   3. blur    separable Gaussian, three widening rounds; dividing by the blurred weight gives a background
//              blur that never smears the person's colours into a halo
//   4. final   per pixel: joint-bilateral upsampling of the mask guided by the full-res frame (edges follow
//              hair and shoulders instead of a 256×144 staircase), or a refined chroma key with a 3×3 matte,
//              hue-aware spill removal across the whole subject and light wrap; then light correction.
const VS = `#version 300 es
in vec2 p; out vec2 uv; out vec2 st;
// uv samples uploaded images (row 0 at the top); st samples textures this pipeline rendered itself.
void main() { st = (p + 1.0) * 0.5; uv = vec2(st.x, 1.0 - st.y); gl_Position = vec4(p, 0.0, 1.0); }`;
const HEAD = `#version 300 es
precision highp float;
in vec2 uv; in vec2 st; out vec4 o;
`;
const MASK_FS = HEAD + `
uniform sampler2D uRaw, uPrev; uniform int uCh; uniform float uFirst;
void main() {
  vec4 r = texture(uRaw, uv);
  float raw = uCh == 3 ? r.a : r.r;
  float prev = texture(uPrev, st).r;
  float k = uFirst > 0.5 ? 1.0 : clamp(0.22 + abs(raw - prev) * 2.6, 0.22, 1.0);
  float m = mix(prev, raw, k);
  o = vec4(m, m, m, 1.0);
}`;
// Guided filter (He, Sun & Tang): rebuilds a full-resolution, edge-following matte from the model's 256-px mask,
// using the camera image as the guide. Locally, alpha = a·I + b, fitted per window, so edges land where the
// picture's edges are (hair, glasses, shoulders) and come out smooth instead of a staircase.
const GF_PACK_FS = HEAD + `
uniform sampler2D uFrame, uMask;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  float I = luma(texture(uFrame, uv).rgb);
  // confidence curve: weak, speckly detections (the stray blobs) drop out before refinement
  float p = smoothstep(0.3, 0.7, texture(uMask, st).r);
  o = vec4(I, p, I * I, I * p);
}`;
const BOX_FS = HEAD + `
uniform sampler2D uSrc; uniform vec2 uStep; uniform int uR;
void main() {
  vec4 s = vec4(0.0);
  for (int i = -16; i <= 16; i++) { if (i < -uR || i > uR) continue; s += texture(uSrc, st + uStep * float(i)); }
  o = s / float(2 * uR + 1);
}`;
const GF_COEF_FS = HEAD + `
uniform sampler2D uSrc; uniform float uEps;
void main() {
  vec4 m = texture(uSrc, st);                   // mean I, mean p, mean I², mean I·p
  float varI = max(m.b - m.r * m.r, 0.0), cov = m.a - m.r * m.g;
  float a = cov / (varI + uEps);
  o = vec4(a, m.g - a * m.r, 0.0, 1.0);
}`;
const PRE_FS = HEAD + `
uniform sampler2D uFrame, uMask, uCoef; uniform int uUseMask, uGuided;
void main() {
  vec3 f = texture(uFrame, uv).rgb;
  float m = uUseMask == 0 ? 0.0 : uGuided == 1 ? dot(texture(uCoef, st).rg, vec2(dot(f, vec3(0.299, 0.587, 0.114)), 1.0)) : texture(uMask, st).r;
  float w = 1.0 - smoothstep(0.15, 0.55, m);   // generous: anything that might be the person stays out of the blur
  o = vec4(f * w, w);
}`;
const BLUR_FS = HEAD + `
uniform sampler2D uSrc; uniform vec2 uDir;
void main() {
  vec4 c = texture(uSrc, st) * 0.2270270270;
  c += (texture(uSrc, st + uDir * 1.3846153846) + texture(uSrc, st - uDir * 1.3846153846)) * 0.3162162162;
  c += (texture(uSrc, st + uDir * 3.2307692308) + texture(uSrc, st - uDir * 3.2307692308)) * 0.0702702703;
  o = c;
}`;
const FINAL_FS = HEAD + `
uniform sampler2D uFrame, uBg, uMask, uBlur, uCoef;
uniform int uGuided;   // 1: matte from the guided filter
uniform int uMode;      // 0 none, 1 chroma key, 2 AI mask
uniform int uBgKind;    // 0 blurred camera, 1 picture
uniform vec2 uKey, uKeyC, uTex, uMaskTex; uniform vec3 uKeyRGB;
uniform float uTol, uSoft, uSpill, uFeather, uWrap, uBright, uContrast, uSat;
vec2 cbcr(vec3 c) { return vec2(-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b, 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
// How much a colour looks like the screen, independent of how brightly that part of the screen is lit:
// chroma divided by brightness (chromaticity), projected on the key's direction, minus off-hue drift.
// ~1 for the screen in light or shadow, ~0 for neutral colours, below 0 for other hues.
float keyScore(vec3 c) {
  vec2 v = cbcr(c) / max(luma(c), 0.05);
  float kk = max(dot(uKeyC, uKeyC), 1e-4);
  float q = dot(v, uKeyC) / kk;
  return q - 0.9 * length(v - uKeyC * q) / sqrt(kk);
}
float keyA(vec2 t) { float lo = 0.18 + uTol * 2.0; return 1.0 - smoothstep(lo, lo + 0.12 + uSoft * 3.0, keyScore(texture(uFrame, t).rgb)); }
// Spill: the key's dominant channel may not exceed what the other two support (green bounce on skin, hair and
// clothes goes; natural colours, which never have that excess, are untouched).
// The limit slides from the larger of the other two channels (gentle) to their average (thorough) with the
// spill amount, so skin and clothes lose the green bounce near their edges; neutrals are never touched.
float limitTo(float x, float y, float amount) { return mix(max(x, y), (x + y) * 0.5, amount); }
vec3 rgbOf(float y, vec2 v) { return vec3(y + 1.402 * v.y, y - 0.344136 * v.x - 0.714136 * v.y, y + 1.772 * v.x); }
vec3 despill(vec3 c, float amount) {
  // 1) chromaticity pointing towards the key is bounce from the screen: take it out, keep the brightness
  float y = luma(c);
  vec2 v = cbcr(c) / max(y, 0.05);
  float q = dot(v, uKeyC) / max(dot(uKeyC, uKeyC), 1e-4);
  float align = dot(normalize(v + vec2(1e-5)), normalize(uKeyC + vec2(1e-5)));   // 1: same hue as the screen
  float w = smoothstep(-0.1, 0.7, align);   // other hues that merely share a component (blue vs green) are spared
  if (q > 0.0) c = clamp(rgbOf(y, (v - uKeyC * q * amount * w) * max(y, 0.05)), 0.0, 1.0);
  // 2) whatever still exceeds the other channels is limited
  if (uKeyRGB.g >= uKeyRGB.r && uKeyRGB.g >= uKeyRGB.b) c.g = min(c.g, mix(c.g, limitTo(c.r, c.b, amount), min(1.0, amount * 1.5)));
  else if (uKeyRGB.b >= uKeyRGB.r) c.b = min(c.b, mix(c.b, limitTo(c.r, c.g, amount), min(1.0, amount * 1.5)));
  else c.r = min(c.r, mix(c.r, limitTo(c.g, c.b, amount), min(1.0, amount * 1.5)));
  return c;
}
// Joint bilateral upsampling: low-res mask, full-res colour guide.
float personMask() {
  vec3 cc = texture(uFrame, uv).rgb;
  float s = 0.0, ws = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 off = vec2(float(i), float(j));
    vec2 t = st + off * uMaskTex;
    vec3 d = texture(uFrame, vec2(t.x, 1.0 - t.y)).rgb - cc;
    float w = exp(-dot(off, off) * 0.22 - dot(d, d) * 45.0);
    s += texture(uMask, t).r * w; ws += w;
  }
  return s / max(ws, 1e-5);
}
void main() {
  vec3 raw = texture(uFrame, uv).rgb;
  vec3 c = raw;
  float a = 1.0;
  if (uMode == 1) {
    // 3×3 matte: averaging the key over neighbours removes sensor noise and pulls a soft, stable edge
    float ctr = keyA(uv), sum = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) sum += keyA(uv + vec2(float(i), float(j)) * uTex);
    a = smoothstep(0.08, 0.92, mix(ctr, sum / 9.0, 0.6));
    c = despill(c, mix(1.0, uSpill, a));          // full strength at the edge, the chosen amount inside
  } else if (uMode == 2) {
    float m = uGuided == 1 ? dot(texture(uCoef, st).rg, vec2(luma(raw), 1.0)) : personMask();
    a = smoothstep(0.5 - uFeather, 0.5 + uFeather, m);
  }
  vec3 bg;
  if (uBgKind == 1) bg = texture(uBg, uv).rgb;
  else { vec4 b = texture(uBlur, st); bg = b.a > 0.004 ? b.rgb / b.a : raw; }
  if (uMode != 0) {
    vec3 wrapSrc = uBgKind == 1 ? textureLod(uBg, uv, 4.0).rgb : bg;
    float edge = clamp(4.0 * a * (1.0 - a), 0.0, 1.0);
    c = mix(c, wrapSrc, uWrap * edge * 0.5);
  }
  vec3 outc = mix(bg, c, a);
  outc = (outc - 0.5) * uContrast + 0.5 + uBright;
  float l = luma(outc);
  o = vec4(clamp(mix(vec3(l), outc, uSat), 0.0, 1.0), 1.0);
}`;

function keyColour(hex) {
  const n = parseInt(String(hex || '#00ff00').slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const cb = -0.168736 * r - 0.331264 * g + 0.5 * b, cr = 0.5 * r - 0.418688 * g - 0.081312 * b, y = Math.max(0.05, 0.299 * r + 0.587 * g + 0.114 * b);
  return { rgb: [r, g, b], cbcr: [cb, cr], chroma: [cb / y, cr / y] };
}

let segLoad = null;
function loadSegmenter() {
  segLoad ||= new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = '/vendor/selfie/selfie_segmentation.js';
    sc.onload = () => {
      try {
        const seg = new window.SelfieSegmentation({ locateFile: (f) => '/vendor/selfie/' + f });
        seg.setOptions({ modelSelection: 0, selfieMode: false }); // general model: better edges than the landscape one
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
 *         spill: .85, edge: .14, wrap: .35, blur: 1, bright: 0, contrast: 1, sat: 1 }
 */
export function needsProcessing(o) {
  return (o.effect && o.effect !== 'none') || Math.abs(o.bright || 0) > 0.001 || Math.abs((o.contrast ?? 1) - 1) > 0.001 || Math.abs((o.sat ?? 1) - 1) > 0.001;
}
const DEFAULTS = { effect: 'none', key: '#00ff00', tol: 0.1, soft: 0.08, spill: 0.85, edge: 0.1, wrap: 0.35, blur: 1, bright: 0, contrast: 1, sat: 1, bgImage: null };

/**
 * The compositor on its own: give it frames (and, for blur/picture, person masks); it draws the result on
 * `canvas`. createVideoFx wraps it around a camera; scripts/fx-bench.ts drives it with ground-truth scenes.
 */
export function createFxRenderer(W, H, opts = {}) {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('This browser cannot run video effects (WebGL2 is unavailable).');
  const floatOk = !!gl.getExtension('EXT_color_buffer_float');
  const compile = (fs) => {
    const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(prog, 0, 'p'); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const u = {};
    return { prog, u: (n) => (u[n] ??= gl.getUniformLocation(prog, n)) };
  };
  const P = { mask: compile(MASK_FS), pre: compile(PRE_FS), blur: compile(BLUR_FS), final: compile(FINAL_FS), pack: compile(GF_PACK_FS), box: compile(BOX_FS), coef: compile(GF_COEF_FS) };
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const texture = (w, h, { float = false, mip = false } = {}) => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w) gl.texImage2D(gl.TEXTURE_2D, 0, float && floatOk ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, float && floatOk ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    return t;
  };
  const target = (w, h, float) => { const tex = texture(w, h, { float }); const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0); return { tex, fb, w, h }; };
  const tFrame = texture(), tBg = texture(0, 0, { mip: true }), tMaskRaw = texture();
  const qw = Math.max(16, Math.round(W / 4)), qh = Math.max(16, Math.round(H / 4));
  const pre = target(qw, qh, true), blurA = target(qw, qh, true), blurB = target(qw, qh, true);
  // Guided filter at up to 640 px wide; needs float render targets (variances), else the bilateral path is used.
  const gw = Math.min(W, 640), gh = Math.max(16, Math.round(gw * H / W));
  const guided = floatOk;
  const gfA = guided ? target(gw, gh, true) : null, gfB = guided ? target(gw, gh, true) : null;
  let maskA = null, maskB = null, maskW = 0, maskH = 0, maskFirst = true, haveMask = false, maskCh = 0;
  const imgC = document.createElement('canvas'); imgC.width = W; imgC.height = H; const imgG = imgC.getContext('2d');
  let o = { ...DEFAULTS, ...opts };

  const bind = (unit, tex) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); };
  const upload = (tex, src) => { gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); };
  const pass = (p, tgt, w, h) => { gl.useProgram(p.prog); gl.bindFramebuffer(gl.FRAMEBUFFER, tgt ? tgt.fb : null); gl.viewport(0, 0, w, h); };
  const draw = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  function paintBg() {
    imgG.fillStyle = '#0b1530'; imgG.fillRect(0, 0, W, H);
    const im = o.bgImage;
    if (im && (im.naturalWidth || im.width)) {
      const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
      const k = Math.max(W / iw, H / ih);
      imgG.drawImage(im, (W - iw * k) / 2, (H - ih * k) / 2, iw * k, ih * k);
    } else { const g = imgG.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#12264f'); g.addColorStop(1, '#2d2f70'); imgG.fillStyle = g; imgG.fillRect(0, 0, W, H); }
    upload(tBg, imgC); gl.generateMipmap(gl.TEXTURE_2D);
  }
  function set(next) {
    o = { ...o, ...next };
    // Repaint whenever a picture is passed: the same Image object arrives again once it has finished loading.
    if ('bgImage' in next || ((o.effect === 'image' || o.effect === 'green') && !tBg.painted)) { paintBg(); tBg.painted = true; }
  }
  set({});

  /** A new person mask: an image/canvas whose red (or alpha) channel is 1 where the person is. */
  // Stray-detection cleanup: the model now and then lights up a lamp, a chair back or a poster. Those patches
  // are detached from the body and weak, so keep the big connected regions, confident ones (a hand waved clear of
  // the body) and anything touching the bottom edge, where a body enters the frame; drop the rest before refining.
  const cw = 256, ch = 144, cc = document.createElement('canvas'); cc.width = cw; cc.height = ch;
  const cg = cc.getContext('2d', { willReadFrequently: true });
  const label = new Int32Array(cw * ch), stack = new Int32Array(cw * ch);
  function cleanMask(src, channel) {
    cg.clearRect(0, 0, cw, ch); cg.drawImage(src, 0, 0, cw, ch);
    const im = cg.getImageData(0, 0, cw, ch), d = im.data, n = cw * ch;
    label.fill(0);
    const areas = [0], bottom = [false], sums = [0];
    for (let i = 0; i < n; i++) {
      if (label[i] || d[i * 4 + channel] < 100) continue;
      const id = areas.length; let top = 0, area = 0, low = false, sum = 0;
      stack[top++] = i; label[i] = id;
      while (top) {
        const j = stack[--top]; area++; sum += d[j * 4 + channel];
        const x = j % cw, y = (j - x) / cw;
        if (y === ch - 1) low = true;
        if (x > 0 && !label[j - 1] && d[(j - 1) * 4 + channel] >= 100) { label[j - 1] = id; stack[top++] = j - 1; }
        if (x < cw - 1 && !label[j + 1] && d[(j + 1) * 4 + channel] >= 100) { label[j + 1] = id; stack[top++] = j + 1; }
        if (y > 0 && !label[j - cw] && d[(j - cw) * 4 + channel] >= 100) { label[j - cw] = id; stack[top++] = j - cw; }
        if (y < ch - 1 && !label[j + cw] && d[(j + cw) * 4 + channel] >= 100) { label[j + cw] = id; stack[top++] = j + cw; }
      }
      areas.push(area); bottom.push(low); sums.push(sum);
    }
    const biggest = Math.max(0, ...areas);
    // a hand waved clear of the body is small but confident (mean ≥ 0.85); false positives are weak
    const keep = areas.map((a, id) => id > 0 && (a >= biggest * 0.2 || sums[id] / a >= 217 || (bottom[id] && a >= n * 0.004)));
    // islands go to zero along with their soft fringe (the weak pixels that touch them)
    for (let i = 0; i < n; i++) {
      const id = label[i];
      const v = id ? (keep[id] ? d[i * 4 + channel] : 0) : d[i * 4 + channel];
      d[i * 4] = v; d[i * 4 + 3] = 255;
    }
    for (let pass = 0; pass < 3; pass++) for (let i = 0; i < n; i++) {
      if (label[i] || d[i * 4] === 0) continue;
      const x = i % cw, near = (j) => (label[j] > 0 && !keep[label[j]]) || (label[j] < 0 && label[j] !== -2 - pass);
      if ((x > 0 && near(i - 1)) || (x < cw - 1 && near(i + 1)) || (i >= cw && near(i - cw)) || (i < n - cw && near(i + cw))) { d[i * 4] = 0; label[i] = -2 - pass; }
    }
    
    cg.putImageData(im, 0, 0);
    return cc;
  }
  function setMask(rawSrc, rawChannel) {
    const src = cleanMask(rawSrc, rawChannel), channel = 0;
    const w = src.width || src.videoWidth, h = src.height || src.videoHeight;
    if (!w || !h) return;
    if (w !== maskW || h !== maskH) { maskW = w; maskH = h; maskA = target(w, h, true); maskB = target(w, h, true); maskFirst = true; }
    maskCh = channel;
    upload(tMaskRaw, src);
    pass(P.mask, maskB, maskW, maskH);
    bind(0, tMaskRaw); bind(1, maskA.tex);
    gl.uniform1i(P.mask.u('uRaw'), 0); gl.uniform1i(P.mask.u('uPrev'), 1); gl.uniform1i(P.mask.u('uCh'), channel); gl.uniform1f(P.mask.u('uFirst'), maskFirst ? 1 : 0);
    draw();
    [maskA, maskB] = [maskB, maskA];
    maskFirst = false; haveMask = true;
  }

  /** Composite one frame from `src` (video, image or canvas) into `canvas`. */
  function render(src) {
    upload(tFrame, src);
    const ai = o.effect === 'blur' || o.effect === 'image';
    const mode = o.effect === 'green' ? 1 : ai && haveMask ? 2 : 0;
    const bgKind = o.effect === 'image' || (o.effect === 'green' && o.bgImage) ? 1 : 0;
    const useGuided = mode === 2 && guided && maskA;
    if (useGuided) {
      // pack → box → coefficients → box: mean a and b end up in gfB
      const r = Math.max(2, Math.round((o.radius ?? 8) * gw / 640));
      pass(P.pack, gfA, gw, gh); bind(0, tFrame); bind(1, maskA.tex);
      gl.uniform1i(P.pack.u('uFrame'), 0); gl.uniform1i(P.pack.u('uMask'), 1); draw();
      const box = (from, to, dx, dy) => { pass(P.box, to, gw, gh); bind(0, from.tex); gl.uniform1i(P.box.u('uSrc'), 0); gl.uniform2f(P.box.u('uStep'), dx / gw, dy / gh); gl.uniform1i(P.box.u('uR'), r); draw(); };
      box(gfA, gfB, 1, 0); box(gfB, gfA, 0, 1);
      pass(P.coef, gfB, gw, gh); bind(0, gfA.tex); gl.uniform1i(P.coef.u('uSrc'), 0); gl.uniform1f(P.coef.u('uEps'), o.eps ?? 0.0008); draw();
      box(gfB, gfA, 1, 0); box(gfA, gfB, 0, 1);
    }
    if (mode !== 0 && bgKind === 0) {
      pass(P.pre, pre, qw, qh);
      bind(0, tFrame); bind(1, maskA ? maskA.tex : tMaskRaw); bind(2, useGuided ? gfB.tex : tMaskRaw);
      gl.uniform1i(P.pre.u('uFrame'), 0); gl.uniform1i(P.pre.u('uMask'), 1); gl.uniform1i(P.pre.u('uCoef'), 2); gl.uniform1i(P.pre.u('uGuided'), useGuided ? 1 : 0); gl.uniform1i(P.pre.u('uUseMask'), mode === 2 ? 1 : 0);
      draw();
      let src2 = pre;
      const strength = Math.max(0.2, o.blur ?? 1);
      for (const s of [1, 2, 4]) {
        for (const [dst, dir] of [[blurA, [s * strength / qw, 0]], [blurB, [0, s * strength / qh]]]) {
          pass(P.blur, dst, qw, qh); bind(0, src2.tex);
          gl.uniform1i(P.blur.u('uSrc'), 0); gl.uniform2f(P.blur.u('uDir'), dir[0], dir[1]);
          draw(); src2 = dst;
        }
      }
    }
    const F = P.final;
    pass(F, null, W, H);
    bind(0, tFrame); bind(1, tBg); bind(2, maskA ? maskA.tex : tMaskRaw); bind(3, blurB.tex); bind(4, useGuided ? gfB.tex : tMaskRaw);
    gl.uniform1i(F.u('uFrame'), 0); gl.uniform1i(F.u('uBg'), 1); gl.uniform1i(F.u('uMask'), 2); gl.uniform1i(F.u('uBlur'), 3); gl.uniform1i(F.u('uCoef'), 4); gl.uniform1i(F.u('uGuided'), useGuided ? 1 : 0);
    gl.uniform1i(F.u('uMode'), mode); gl.uniform1i(F.u('uBgKind'), bgKind);
    const key = keyColour(o.key);
    gl.uniform2f(F.u('uKey'), ...key.cbcr); gl.uniform2f(F.u('uKeyC'), ...key.chroma); gl.uniform3f(F.u('uKeyRGB'), ...key.rgb); gl.uniform2f(F.u('uTex'), 1 / W, 1 / H); gl.uniform2f(F.u('uMaskTex'), 1 / (maskW || W), 1 / (maskH || H));
    gl.uniform1f(F.u('uTol'), o.tol); gl.uniform1f(F.u('uSoft'), o.soft); gl.uniform1f(F.u('uSpill'), o.spill); gl.uniform1f(F.u('uFeather'), o.edge);
    gl.uniform1f(F.u('uWrap'), o.wrap); gl.uniform1f(F.u('uBright'), o.bright); gl.uniform1f(F.u('uContrast'), o.contrast); gl.uniform1f(F.u('uSat'), o.sat);
    draw();
  }
  return { canvas, gl, set, setMask, render, guided, get haveMask() { return haveMask; }, get maskChannel() { return maskCh; } };
}

// A green or blue screen sits behind the person, so it fills the top and sides of the picture; the bottom edge
// is mostly the person (a blue shirt there must never be taken for a screen).
const BORDER = (x, y) => (x < 8 || x > 87 || y < 7) && y < 44;
function sampleBorder(src) {
  const c = document.createElement('canvas'); c.width = 96; c.height = 54;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0, 96, 54);
  const d = g.getImageData(0, 0, 96, 54).data, px = [];
  for (let y = 0; y < 54; y++) for (let x = 0; x < 96; x++) if (BORDER(x, y)) { const i = (y * 96 + x) * 4; px.push([d[i], d[i + 1], d[i + 2]]); }
  return px;
}
const isScreenish = ([r, g, b]) => { // a keyable backdrop: clearly green or clearly blue, not a skin, wall or wood tone
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx > 40 && (mx - mn) / mx > 0.35 && (g === mx || b === mx) && Math.max(g, b) > r * 1.25;
};
const near = (p, k) => { const s = p[0] + p[1] + p[2] + 1, ks = k[0] + k[1] + k[2] + 1; return s >= 60 && Math.hypot(p[0] / s - k[0] / ks, p[1] / s - k[1] / ks) < 0.07; };

/** Estimate the screen colour from the top and sides of the frame, or null when no screen fills them. */
export function estimateKey(src) {
  const px = sampleBorder(src), picks = px.filter(isScreenish);
  if (picks.length < px.length * 0.3) return null;
  const med = (k) => picks.map((p) => p[k]).sort((a, b) => a - b)[picks.length >> 1];
  const key = [med(0), med(1), med(2)];
  if (px.filter((p) => near(p, key)).length < px.length * 0.3) return null; // scattered colours, not one backdrop
  return '#' + key.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Share of the top and sides of the picture that match the screen colour (0–1). Under 0.3: no screen in view. */
export function screenCoverage(src, keyHex) {
  const k = [1, 3, 5].map((i) => parseInt(keyHex.slice(i, i + 2), 16)), px = sampleBorder(src);
  return px.filter((p) => near(p, k)).length / px.length;
}

export async function createVideoFx(srcTrack, opts) {
  const s = srcTrack.getSettings();
  const W = s.width || 1280, H = s.height || 720;
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.srcObject = new MediaStream([srcTrack]);
  await video.play().catch(() => {});
  const r = createFxRenderer(W, H, opts);
  let o = { ...DEFAULTS, ...opts };
  let seg = null, segBusy = false, stopped = false, note = '', maskChannel = -1;
  const probe = document.createElement('canvas'); probe.width = 32; probe.height = 18;
  const probeG = probe.getContext('2d', { willReadFrequently: true });
  async function ensureSeg() {
    if (seg || !['blur', 'image'].includes(o.effect)) return;
    try {
      seg = await loadSegmenter();
      seg.onResults((res) => {
        const m = res.segmentationMask;
        if (maskChannel < 0) { // the model puts the mask in red or in alpha depending on the build; look once
          probeG.clearRect(0, 0, 32, 18); probeG.drawImage(m, 0, 0, 32, 18);
          const d = probeG.getImageData(0, 0, 32, 18).data; let minA = 255;
          for (let i = 3; i < d.length; i += 4) minA = Math.min(minA, d[i]);
          maskChannel = minA < 250 ? 3 : 0;
        }
        r.setMask(m, maskChannel);
      });
    } catch (e) { note = e.message; }
  }
  function apply(next) { o = { ...o, ...next }; r.set(next); ensureSeg(); }
  apply({});
  function frame() {
    if (stopped || video.readyState < 2) return;
    r.render(video);
    if (seg && !segBusy && (o.effect === 'blur' || o.effect === 'image')) {
      segBusy = true;
      seg.send({ image: video }).catch(() => {}).finally(() => { segBusy = false; });
    }
  }
  // Keep processing when the tab is in the background (rAF pauses there).
  const timer = setInterval(frame, 1000 / 30);
  const track = r.canvas.captureStream(30).getVideoTracks()[0];
  track.contentHint = 'motion';
  return {
    track, canvas: r.canvas,
    get note() { return note; },
    set: apply,
    /** Pick the green/blue screen colour from what the camera sees right now. */
    autoKey() { return video.readyState >= 2 ? estimateKey(video) : null; },
    /** How much of the frame is the screen colour right now, or -1 before the camera has a frame. */
    coverage(keyHex) { return video.readyState >= 2 ? screenCoverage(video, keyHex) : -1; },
    stop() { stopped = true; clearInterval(timer); track.stop(); video.srcObject = null; },
  };
}
