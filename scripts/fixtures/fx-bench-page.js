// Runs inside the browser (loaded by scripts/fx-bench.ts). Builds ground-truth scenes, runs the previous
// algorithm (reimplemented exactly from public/fx.js at commit 349f8aa) and the current public/fx.js renderer on
// the same frames, and measures the errors. Deterministic: every random number comes from a seeded generator.
window.runFxBench = async function runFxBench() {
  const { createFxRenderer } = await import('/fx.js');
  const W = 1280, H = 720, N = W * H;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const cv = (w = W, h = H) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const pixels = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

  // ---- ground truth: a person with fine hair, as an anti-aliased alpha matte
  const sil = cv(), sg = sil.getContext('2d');
  sg.fillStyle = '#000'; sg.fillRect(0, 0, W, H); sg.fillStyle = '#fff'; sg.strokeStyle = '#fff';
  sg.beginPath(); sg.ellipse(640, 250, 104, 130, 0, 0, Math.PI * 2); sg.fill();
  sg.beginPath(); sg.ellipse(532, 262, 16, 30, 0, 0, Math.PI * 2); sg.ellipse(748, 262, 16, 30, 0, 0, Math.PI * 2); sg.fill();
  sg.fillRect(598, 340, 84, 90);
  sg.beginPath(); sg.moveTo(372, 720); sg.bezierCurveTo(384, 520, 468, 432, 600, 412); sg.lineTo(680, 412); sg.bezierCurveTo(812, 432, 896, 520, 908, 720); sg.closePath(); sg.fill();
  for (let i = 0; i < 26; i++) { // flyaway hair: 1–3px strands, the hard part of any matte
    const a0 = Math.PI * (1.05 + 0.9 * (i / 25)), x0 = 640 + Math.cos(a0) * 100, y0 = 250 + Math.sin(a0) * 124;
    sg.lineWidth = 1 + (i % 3); sg.beginPath(); sg.moveTo(x0, y0);
    sg.quadraticCurveTo(x0 + Math.cos(a0) * 26 + (rnd() - 0.5) * 30, y0 + Math.sin(a0) * 26, x0 + Math.cos(a0) * (40 + rnd() * 30), y0 + Math.sin(a0) * (40 + rnd() * 30)); sg.stroke();
  }
  const silD = pixels(sil), gt = new Float32Array(N);
  for (let i = 0; i < N; i++) gt[i] = silD[i * 4] / 255;
  // distance-ish fields from blurred copies of the matte
  const blurred = (radius) => { const c = cv(); const g2 = c.getContext('2d'); g2.filter = `blur(${radius}px)`; g2.drawImage(sil, 0, 0); const d = pixels(c), f = new Float32Array(N); for (let i = 0; i < N; i++) f[i] = d[i * 4] / 255; return f; };
  const b4 = blurred(4), b8 = blurred(8), b24 = blurred(24);
  const band = new Uint8Array(N), ring = new Uint8Array(N), core = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    band[i] = b4[i] > 0.02 && b4[i] < 0.98 ? 1 : 0;              // the edge
    ring[i] = gt[i] === 0 && b4[i] < 0.02 && b24[i] > 0.02 ? 1 : 0; // background just outside the person (halo zone)
    core[i] = gt[i] > 0.99 && b8[i] > 0.99 ? 1 : 0;                // inside the person, away from the edge
  }

  // ---- the person's true colours
  const fgC = cv(), fgg = fgC.getContext('2d');
  const shirt = fgg.createLinearGradient(0, 400, 0, 720); shirt.addColorStop(0, '#34507f'); shirt.addColorStop(1, '#22365a');
  fgg.fillStyle = shirt; fgg.fillRect(0, 0, W, H);
  const skin = fgg.createRadialGradient(610, 220, 20, 640, 260, 170); skin.addColorStop(0, '#e2ad8a'); skin.addColorStop(1, '#a8714f');
  fgg.fillStyle = skin; fgg.fillRect(380, 100, 520, 330);
  fgg.fillStyle = '#3b2a1d'; fgg.beginPath(); fgg.ellipse(640, 190, 112, 82, 0, Math.PI, Math.PI * 2); fgg.fill(); fgg.fillRect(0, 0, W, 150);
  const fgD = pixels(fgC), fgTrue = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) fgTrue[i * 3 + k] = Math.min(255, Math.max(0, fgD[i * 4 + k] + gauss() * 4));

  // ---- backdrops: an unevenly lit green screen with the subject's shadow, and a real room
  const greenC = cv(), gg = greenC.getContext('2d');
  const lit = gg.createRadialGradient(640, 300, 80, 640, 360, 820); lit.addColorStop(0, '#38c25a'); lit.addColorStop(1, '#15722f');
  gg.fillStyle = lit; gg.fillRect(0, 0, W, H);
  gg.globalAlpha = 0.35; gg.filter = 'blur(26px)'; gg.drawImage(sil, 34, 22); gg.filter = 'none'; gg.globalAlpha = 1;
  gg.globalCompositeOperation = 'multiply'; gg.fillStyle = '#9fb59f'; gg.globalAlpha = 0.25; gg.drawImage(sil, 34, 22); gg.globalAlpha = 1; gg.globalCompositeOperation = 'source-over';
  const roomC = cv(), rg = roomC.getContext('2d');
  const wall = rg.createLinearGradient(0, 0, W, 0); wall.addColorStop(0, '#c2ae96'); wall.addColorStop(1, '#8b8f99');
  rg.fillStyle = wall; rg.fillRect(0, 0, W, H);
  rg.fillStyle = '#2b2622'; rg.fillRect(860, 120, 360, 520);
  for (let i = 0; i < 14; i++) { rg.fillStyle = ['#7a2f2f', '#2f5a7a', '#c99a2e', '#3f6b3a', '#e6e1d8'][i % 5]; rg.fillRect(880 + i * 24, 150 + (i % 3) * 8, 18, 140 - (i % 3) * 8); rg.fillRect(880 + i * 24, 330, 18, 120); }
  rg.fillStyle = '#f4e3b5'; rg.beginPath(); rg.ellipse(220, 260, 70, 90, 0, 0, Math.PI * 2); rg.fill();
  const plate = (c) => { const d = pixels(c), f = new Float32Array(N * 3); for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) f[i * 3 + k] = d[i * 4 + k]; return f; };
  const greenP = plate(greenC), roomP = plate(roomC);

  // ---- camera frames: green spill on the subject near its edge, sensor noise everywhere
  const frameFrom = (bgP, spillColor) => {
    const img = new ImageData(W, H), d = img.data;
    for (let i = 0; i < N; i++) {
      const a = gt[i], prox = spillColor ? Math.min(1, (1 - b8[i]) * 2.2) : 0, s = spillColor ? 0.06 + 0.34 * prox : 0;
      for (let k = 0; k < 3; k++) {
        const f = fgTrue[i * 3 + k] * (1 - s) + (spillColor ? spillColor[k] * s : 0);
        d[i * 4 + k] = Math.min(255, Math.max(0, f * a + bgP[i * 3 + k] * (1 - a) + gauss() * 3));
      }
      d[i * 4 + 3] = 255;
    }
    const c = cv(); c.getContext('2d').putImageData(img, 0, 0); return c;
  };
  let gr = 0, gg2 = 0, gb = 0;
  for (let i = 0; i < N; i++) if (b24[i] < 0.01) { gr += greenP[i * 3]; gg2 += greenP[i * 3 + 1]; gb += greenP[i * 3 + 2]; }
  const nBg = [...b24].filter((v) => v < 0.01).length, keyRGB = [gr / nBg, gg2 / nBg, gb / nBg];
  const keyHex = '#' + keyRGB.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const greenFrame = frameFrom(greenP, keyRGB), roomFrame = frameFrom(roomP, null);

  // ---- metrics
  const mean = (f, mask) => { let s = 0, n = 0; for (let i = 0; i < N; i++) if (!mask || mask[i]) { s += f(i); n++; } return n ? s / n : 0; };
  const alphaErr = (a, mask) => mean((i) => Math.abs(a[i] - gt[i]), mask);

  // ---- the previous algorithm, exactly as it was
  const oldCbCr = (r, g, b) => [-0.1687 * r - 0.3313 * g + 0.5 * b, 0.5 * r - 0.4187 * g - 0.0813 * b];
  function oldKey(frame, tol, soft) {
    const d = pixels(frame), k = oldCbCr(keyRGB[0] / 255, keyRGB[1] / 255, keyRGB[2] / 255), a = new Float32Array(N), col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      let r = d[i * 4] / 255, g = d[i * 4 + 1] / 255; const b = d[i * 4 + 2] / 255;
      const v = oldCbCr(r, g, b), al = smooth(tol, tol + soft, Math.hypot(v[0] - k[0], v[1] - k[1]));
      const m = Math.max(r, b); g = g + (Math.min(g, m) - g) * (1 - al); // c.g = mix(min(c.g, m), c.g, a)
      a[i] = al; col[i * 3] = r * 255; col[i * 3 + 1] = g * 255; col[i * 3 + 2] = b * 255;
    }
    return { a, col };
  }
  function oldUpsample(mask) { // bilinear (as WebGL LINEAR) then smoothstep(0.3, 0.7)
    const c = cv(); const g2 = c.getContext('2d'); g2.imageSmoothingQuality = 'low'; g2.drawImage(mask, 0, 0, W, H);
    const d = pixels(c), a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = smooth(0.3, 0.7, d[i * 4] / 255); return a;
  }
  function oldBlurBg(frame) { // 320-wide canvas, blur(8px), drawn 16px oversize, then scaled up
    const bw = 320, bh = 180, c = cv(bw, bh), g2 = c.getContext('2d'); g2.filter = 'blur(8px)'; g2.drawImage(frame, -16, -16, bw + 32, bh + 32);
    const up = cv(); up.getContext('2d').drawImage(c, 0, 0, W, H); return plate(up);
  }

  // ---- the current pipeline
  const readback = (r) => { const c = cv(); c.getContext('2d').drawImage(r.canvas, 0, 0); return pixels(c); };
  const solid = (hex) => { const c = cv(); const g2 = c.getContext('2d'); g2.fillStyle = hex; g2.fillRect(0, 0, W, H); return c; };
  const black = solid('#000000'), white = solid('#ffffff');
  function alphaOf(r, frame) { // composite over black and white: alpha = 1 − (white − black)
    r.set({ bgImage: black }); r.render(frame); const k = readback(r);
    r.set({ bgImage: white }); r.render(frame); const w = readback(r);
    const a = new Float32Array(N), col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { const diff = (w[i * 4] - k[i * 4] + w[i * 4 + 1] - k[i * 4 + 1] + w[i * 4 + 2] - k[i * 4 + 2]) / 765; a[i] = Math.min(1, Math.max(0, 1 - diff)); for (let c = 0; c < 3; c++) col[i * 3 + c] = a[i] > 0.01 ? k[i * 4 + c] / a[i] : 0; }
    return { a, col };
  }
  // simulated person-segmentation output: model resolution 256×144, soft, with per-frame noise and jitter
  const maskFrames = (n, noise) => {
    const out = [];
    for (let f = 0; f < n; f++) {
      const c = cv(256, 144), g2 = c.getContext('2d');
      g2.fillStyle = '#000'; g2.fillRect(0, 0, 256, 144);
      g2.filter = noise ? 'blur(2.2px)' : 'blur(1px)'; g2.drawImage(sil, noise ? (rnd() - 0.5) * 1.6 : 0, noise ? (rnd() - 0.5) * 1.6 : 0, 256, 144); g2.filter = 'none';
      if (noise) { // false positives: faint blobs on the shelf and the lamp
        g2.globalAlpha = 0.45 + rnd() * 0.2; g2.fillStyle = '#fff';
        g2.beginPath(); g2.ellipse(205 + rnd() * 2, 60, 9, 13, 0, 0, Math.PI * 2); g2.fill();
        g2.beginPath(); g2.ellipse(44, 52 + rnd() * 2, 6, 8, 0, 0, Math.PI * 2); g2.fill(); g2.globalAlpha = 1;
      }
      if (noise) { const im = g2.getImageData(0, 0, 256, 144); for (let i = 0; i < im.data.length; i += 4) { const v = Math.min(255, Math.max(0, im.data[i] + gauss() * noise * 255)); im.data[i] = im.data[i + 1] = im.data[i + 2] = v; } g2.putImageData(im, 0, 0); }
      out.push(c);
    }
    return out;
  };

  const results = {}, shots = {};
  // 1. green screen
  {
    const old = oldKey(greenFrame, 0.1, 0.08);
    const r = createFxRenderer(W, H, { effect: 'green', key: keyHex, tol: 0.1, soft: 0.08, wrap: 0 });
    const neu = alphaOf(r, greenFrame);
    const colErr = (col) => mean((i) => (Math.abs(col[i * 3] - fgTrue[i * 3]) + Math.abs(col[i * 3 + 1] - fgTrue[i * 3 + 1]) + Math.abs(col[i * 3 + 2] - fgTrue[i * 3 + 2])) / 3, core);
    // green cast relative to the true colour, as a signed mean (sensor noise cancels out), in the band just inside
    // the edge (fully opaque, within ~6px) where light bouncing off the screen lands on skin and clothes
    const rim = new Uint8Array(N); for (let i = 0; i < N; i++) rim[i] = gt[i] > 0.99 && b8[i] < 0.9 ? 1 : 0;
    const cast = (r, g, b) => g - (r + b) / 2;
    const excess = (col) => Math.max(0, mean((i) => cast(col[i * 3], col[i * 3 + 1], col[i * 3 + 2]) - cast(fgTrue[i * 3], fgTrue[i * 3 + 1], fgTrue[i * 3 + 2]), rim));
    results.green = {
      'matte error, whole frame': [alphaErr(old.a), alphaErr(neu.a)],
      'matte error, edges and hair': [alphaErr(old.a, band), alphaErr(neu.a, band)],
      'colour error on the subject (0–255)': [colErr(old.col), colErr(neu.col)],
      'green cast left near the subject’s edge (0–255)': [excess(old.col), excess(neu.col)],
    };
  }
  // 2. AI person mask: edge accuracy and flicker over 12 noisy frames of a still person
  {
    const masks = maskFrames(12, 0.07);
    const r = createFxRenderer(W, H, { effect: 'image', wrap: 0 });
    let oldPrev = null, newPrev = null, oldFlick = 0, newFlick = 0, n = 0, oldLast, newLast;
    for (let f = 0; f < masks.length; f++) {
      const oa = oldUpsample(masks[f]);
      r.setMask(masks[f], 0); const na = alphaOf(r, roomFrame).a;
      if (f >= 4) { oldFlick += mean((i) => Math.abs(oa[i] - oldPrev[i]), band); newFlick += mean((i) => Math.abs(na[i] - newPrev[i]), band); n++; }
      oldPrev = oa; newPrev = na; oldLast = oa; newLast = na;
    }
    const crop = (alpha) => { // composite over a bright backdrop so edge defects are easy to see
      const c = cv(360, 240), g2 = c.getContext('2d'), im = g2.createImageData(360, 240), fr = pixels(roomFrame);
      for (let y = 0; y < 240; y++) for (let x = 0; x < 360; x++) {
        const i = (y + 60) * W + (x + 420), o = (y * 360 + x) * 4;
        for (let k = 0; k < 3; k++) im.data[o + k] = fr[i * 4 + k] * alpha[i] + [70, 200, 120][k] * (1 - alpha[i]);
        im.data[o + 3] = 255;
      }
      g2.putImageData(im, 0, 0); return c.toDataURL('image/png');
    };
    shots.maskBefore = crop(oldLast); shots.maskAfter = crop(newLast); shots.maskTruth = crop(gt);
    results.mask = {
      'mask error, whole frame': [alphaErr(oldLast), alphaErr(newLast)],
      'mask error, edges and hair': [alphaErr(oldLast, band), alphaErr(newLast, band)],
      'edge flicker between frames': [oldFlick / n, newFlick / n],
    };
  }
  // 3. background blur: how much of the person bleeds into the blurred background around them (halo)
  {
    const mask = maskFrames(1, 0)[0];
    const oldBg = oldBlurBg(roomFrame), oldIdeal = oldBlurBg(roomC), oldA = oldUpsample(mask);
    const r = createFxRenderer(W, H, { effect: 'blur', wrap: 0 });
    r.setMask(mask, 0); r.render(roomFrame); const neuOut = readback(r);
    const empty = cv(256, 144); empty.getContext('2d').fillStyle = '#000'; empty.getContext('2d').fillRect(0, 0, 256, 144);
    const r2 = createFxRenderer(W, H, { effect: 'blur', wrap: 0 }); r2.setMask(empty, 0); r2.render(roomC); const neuIdeal = readback(r2);
    const fr = plate(roomFrame);
    const oldHalo = mean((i) => { let s = 0; for (let k = 0; k < 3; k++) { const out = fr[i * 3 + k] * oldA[i] + oldBg[i * 3 + k] * (1 - oldA[i]); s += Math.abs(out - oldIdeal[i * 3 + k]); } return s / 3; }, ring);
    const newHalo = mean((i) => (Math.abs(neuOut[i * 4] - neuIdeal[i * 4]) + Math.abs(neuOut[i * 4 + 1] - neuIdeal[i * 4 + 1]) + Math.abs(neuOut[i * 4 + 2] - neuIdeal[i * 4 + 2])) / 3, ring);
    results.blur = { 'person colour bleeding into the background (0–255)': [oldHalo, newHalo] };
    // close-ups with a realistic (soft, noisy, blobby) mask: old blur vs new, plus the whole frame for stray blobs
    const real = maskFrames(1, 0.07)[0], realA = oldUpsample(real);
    r.setMask(real, 0); r.render(roomFrame); const realOut = readback(r);
    const pic = (get, x0, y0, w, h, scale = 1) => {
      const c = cv(w / scale, h / scale), g2 = c.getContext('2d'), im = g2.createImageData(w / scale, h / scale);
      for (let y = 0; y < h / scale; y++) for (let x = 0; x < w / scale; x++) {
        const i = (y0 + y * scale) * W + (x0 + x * scale), o = (y * w / scale + x) * 4;
        for (let k = 0; k < 3; k++) im.data[o + k] = get(i, k);
        im.data[o + 3] = 255;
      }
      g2.putImageData(im, 0, 0); return c.toDataURL('image/png');
    };
    shots.blurBefore = pic((i, k) => fr[i * 3 + k] * realA[i] + oldBg[i * 3 + k] * (1 - realA[i]), 420, 60, 360, 240);
    shots.blurAfter = pic((i, k) => realOut[i * 4 + k], 420, 60, 360, 240);
    shots.blurFullAfter = pic((i, k) => realOut[i * 4 + k], 0, 0, W, H, 2);
    shots.blurFullBefore = pic((i, k) => fr[i * 3 + k] * realA[i] + oldBg[i * 3 + k] * (1 - realA[i]), 0, 0, W, H, 2);
  }
  return { key: keyHex, results, shots };
};
