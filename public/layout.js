// gather layout engine — layers, snapping, collision avoidance and scene presets.
// Pure functions over stage elements: { id, type, x, y, w, h (fractions of the stage), hidden, locked, stack, pip, home }.
//
// Layers (tiers) are fixed; inside a tier, array order decides who is on top.
//   stage    cameras and colour blocks          media    presentation, images
//   overlay  lower thirds, logos, QR/call-in, text, timers, AI window, sponsors
//   chat     chat box and featured (super) chat  ticker   the crawl
//   system   captions (always readable, always on top)
// Host-only editing UI lives above all of these, on its own canvas/DOM and never reaches the program.
//
// Overlap rule: two visible elements may not overlap unless one of them is stacked (`stack: true`),
// which the host sets deliberately (Alt-drag, the "Allow overlap" switch, or a preset that designs it).

export const TIERS = [
  { id: 'stage', z: 100, label: 'Stage' },
  { id: 'media', z: 200, label: 'Media' },
  { id: 'overlay', z: 300, label: 'Overlays' },
  { id: 'chat', z: 400, label: 'Chat & super chat' },
  { id: 'ticker', z: 500, label: 'Ticker' },
  { id: 'system', z: 600, label: 'System' },
];
const TIER_Z = Object.fromEntries(TIERS.map((t) => [t.id, t.z]));
const TYPE_TIER = {
  slot: 'stage', shape: 'stage', media: 'media', image: 'media',
  banner: 'overlay', logo: 'overlay', tip: 'overlay', callin: 'overlay', text: 'overlay', timer: 'overlay', ai: 'overlay', ads: 'overlay',
  chat: 'chat', featured: 'chat', ticker: 'ticker', captions: 'system',
};
/** A picture-in-picture camera is drawn as an overlay so it sits above the presentation it covers. */
export const tierOf = (e) => (e.type === 'slot' && e.pip ? 'overlay' : TYPE_TIER[e.type] || 'overlay');
/** Elements in paint order: tier first, then their order in the array. */
export function drawOrder(elements) {
  return (elements || []).map((e, i) => ({ e, i })).sort((a, b) => TIER_Z[tierOf(a.e)] - TIER_Z[tierOf(b.e)] || a.i - b.i).map((x) => x.e);
}

// ------------------------------------------------------------------ system elements
// Banners, the ticker, the logo, sponsor ads, the featured chat card and captions used to be drawn at fixed
// spots. They are now elements like any other, so they can be moved, hidden, locked and saved per scene.
export const SYSTEM_TYPES = ['banner', 'ticker', 'logo', 'ads', 'featured', 'captions'];
export const isSystem = (e) => SYSTEM_TYPES.includes(e.type);
const R = (x, y, w, h, W = 1280, H = 720) => ({ x: x / W, y: y / H, w: w / W, h: h / H });
const SYSTEM_DEFAULTS = {
  landscape: {
    banner: R(48, 528, 640, 112), ticker: R(0, 672, 1280, 48), logo: R(1104, 24, 144, 48),
    ads: R(976, 512, 256, 136), featured: R(712, 456, 520, 176), captions: R(160, 576, 960, 80),
  },
  vertical: {
    banner: R(32, 920, 656, 144, 720, 1280), ticker: R(0, 1232, 720, 48, 720, 1280), logo: R(536, 32, 152, 56, 720, 1280),
    ads: R(472, 776, 216, 120, 720, 1280), featured: R(32, 744, 656, 160, 720, 1280), captions: R(48, 1080, 624, 112, 720, 1280),
  },
};

export const overlaps = (a, b, eps = 0.0005) => a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps;
const canCollide = (a, b) => a !== b && a.id !== b.id && !a.hidden && !b.hidden && !a.stack && !b.stack;
/** The first visible, unstacked element a rect would overlap (excluding `self`). */
export function blockerFor(rect, self, elements) {
  if (self?.stack || self?.hidden) return null;
  return (elements || []).find((o) => canCollide(self || {}, o) && overlaps(rect, o)) || null;
}

/**
 * Adds any missing system element to a scene. A default spot that would overlap something the scene already
 * has is marked stacked, so old scenes keep working exactly as they looked.
 */
export function ensureSystem(elements, vertical = false, uid = () => Math.random().toString(36).slice(2, 8)) {
  const els = [...(elements || [])];
  const defs = SYSTEM_DEFAULTS[vertical ? 'vertical' : 'landscape'];
  for (const type of SYSTEM_TYPES) {
    if (els.some((e) => e.type === type)) continue;
    const r = defs[type];
    const e = { id: uid(), type, ...r, home: [r.x, r.y, r.w, r.h] };
    if (els.some((o) => !o.hidden && overlaps(r, o))) e.stack = true;
    els.push(e);
  }
  return els;
}

// ------------------------------------------------------------------ snapping
export const GRID = 8; // stage pixels
export const SAFE = { action: 0.035, title: 0.05 }; // per side, as a fraction of the stage (EBU / SMPTE style)
const SNAP_PX = 6;

/** Candidate guide lines (fractions) on one axis: stage edges and centre, safe areas, and other elements' edges/centres. */
function guideLines(axis, self, elements) {
  const s = axis === 'x' ? 'x' : 'y', z = axis === 'x' ? 'w' : 'h';
  const lines = [
    { at: 0, kind: 'edge' }, { at: 1, kind: 'edge' }, { at: 0.5, kind: 'center' },
    { at: SAFE.action, kind: 'safe' }, { at: 1 - SAFE.action, kind: 'safe' }, { at: SAFE.title, kind: 'title' }, { at: 1 - SAFE.title, kind: 'title' },
  ];
  for (const o of elements || []) {
    if (o === self || o.id === self?.id || o.hidden) continue;
    lines.push({ at: o[s], kind: 'element' }, { at: o[s] + o[z], kind: 'element' }, { at: o[s] + o[z] / 2, kind: 'element' });
  }
  return lines;
}
const toGrid = (v, size) => Math.round((v * size) / GRID) * GRID / size;

/**
 * Snap a moving rect: its start, centre or end locks to the nearest guide within 6px; otherwise its position
 * lands on the 8px grid. Returns the snapped rect and the guides that caught it (for drawing).
 */
export function snapMove(rect, self, elements, W, H) {
  const out = { ...rect }, guides = [];
  for (const [axis, size] of [['x', W], ['y', H]]) {
    const z = axis === 'x' ? 'w' : 'h';
    const lines = guideLines(axis, self, elements);
    let best = null;
    for (const [k, anchor] of [[0, rect[axis]], [0.5, rect[axis] + rect[z] / 2], [1, rect[axis] + rect[z]]]) {
      for (const l of lines) {
        const d = Math.abs(anchor - l.at) * size;
        if (d <= SNAP_PX && (!best || d < best.d)) best = { d, pos: l.at - k * rect[z], line: l };
      }
    }
    if (best) { out[axis] = best.pos; guides.push({ axis, at: best.line.at, kind: best.line.kind }); }
    else out[axis] = toGrid(rect[axis], size);
  }
  return { rect: out, guides };
}
/** Snap a resize: the moving edges lock to guides or to the 8px grid; sizes stay at least 32px. */
export function snapResize(rect, handle, self, elements, W, H) {
  const out = { ...rect }, guides = [];
  const edge = (axis, size, end) => {
    const z = axis === 'x' ? 'w' : 'h';
    const pos = end ? out[axis] + out[z] : out[axis];
    let best = null;
    for (const l of guideLines(axis, self, elements)) { const d = Math.abs(pos - l.at) * size; if (d <= SNAP_PX && (!best || d < best.d)) best = { d, l }; }
    const at = best ? best.l.at : toGrid(pos, size);
    if (best) guides.push({ axis, at, kind: best.l.kind });
    const min = 32 / size;
    if (end) out[z] = Math.max(min, at - out[axis]);
    else { const right = out[axis] + out[z]; out[axis] = Math.min(at, right - min); out[z] = right - out[axis]; }
  };
  if (handle.includes('w')) edge('x', W, false);
  if (handle.includes('e')) edge('x', W, true);
  if (handle.includes('n')) edge('y', H, false);
  if (handle.includes('s')) edge('y', H, true);
  return { rect: out, guides };
}

/**
 * Collision avoidance. Move from `prev` towards `cand`; if `cand` would overlap a new element, slide along
 * whichever single axis still fits, else stay put. Overlaps that already existed never trap an element.
 */
export function resolve(prev, cand, self, elements) {
  const others = (elements || []).filter((o) => canCollide(self, o));
  const already = new Set(others.filter((o) => overlaps(prev, o)).map((o) => o.id));
  const hits = (r) => others.find((o) => !already.has(o.id) && overlaps(r, o)) || null;
  const blocker = hits(cand);
  if (!blocker) return { rect: cand, blocked: null };
  for (const r of [{ ...cand, y: prev.y, h: prev.h }, { ...cand, x: prev.x, w: prev.w }]) if (!hits(r)) return { rect: r, blocked: blocker };
  return { rect: { ...prev }, blocked: blocker };
}
/** Visible, unstacked overlapping pairs in a layout (should be empty). */
export function collisions(elements) {
  const out = [], els = (elements || []).filter((e) => !e.hidden && !e.stack);
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) if (overlaps(els[i], els[j])) out.push([els[i], els[j]]);
  return out;
}

// ------------------------------------------------------------------ presets
// Designed on a 1280×720 canvas in 8px steps, inside the title-safe area. Deliberate overlaps (a lower third
// over a camera, a PiP over slides, letterbox bars) are marked stacked; everything else is collision-free.
const P = (type, x, y, w, h, extra = {}) => ({ type, ...R(x, y, w, h), ...extra });
export const PRESETS = [
  {
    id: 'p-cinematic', name: 'Cinematic solo', desc: 'One camera in 2.39:1 letterbox, a lower third over the picture.',
    els: [
      P('shape', 0, 0, 1280, 88, { color: '#000000', stack: true, label: 'Letterbox top' }),
      P('shape', 0, 632, 1280, 88, { color: '#000000', stack: true, label: 'Letterbox bottom' }),
      P('slot', 0, 88, 1280, 544, { index: 0, radius: 0 }),
      P('banner', 64, 472, 576, 120, { stack: true }),
      P('logo', 1104, 24, 128, 48, { stack: true }),
      P('featured', 720, 440, 496, 152, { stack: true }),
      P('captions', 160, 640, 960, 64, { stack: true }),
      P('ticker', 0, 672, 1280, 48, { hidden: true }),
      P('ads', 976, 472, 240, 120, { hidden: true }),
    ],
  },
  {
    id: 'p-interview', name: 'Interview panel', desc: 'Two 4:3 seats, the lower third and a sponsor slot on their own row.',
    els: [
      P('slot', 48, 64, 576, 432, { index: 0, radius: 16 }),
      P('slot', 656, 64, 576, 432, { index: 1, radius: 16 }),
      P('logo', 1104, 8, 128, 48),
      P('banner', 48, 520, 736, 120),
      P('featured', 816, 520, 416, 120),
      P('ads', 816, 520, 416, 120, { hidden: true }),
      P('captions', 160, 648, 960, 56, { stack: true }),
      P('ticker', 0, 672, 1280, 48, { hidden: true }),
    ],
  },
  {
    // For gamers: the game edge to edge, the facecam in the corner, super chats and chat cards over the game.
    id: 'p-game', name: 'Game + facecam', desc: 'The game full screen, your camera in a corner, alerts on top.',
    els: [
      P('media', 0, 0, 1280, 720, { radius: 0, stack: true }),
      P('slot', 1000, 24, 256, 192, { index: 0, radius: 14, pip: true, stack: true }),
      P('slot', 1000, 232, 256, 192, { index: 1, radius: 14, pip: true, stack: true, hidden: true }),
      P('featured', 24, 528, 520, 160, { stack: true }),
      P('banner', 24, 24, 560, 96, { stack: true, hidden: true }),
      P('captions', 160, 640, 960, 56, { stack: true }),
      P('logo', 24, 24, 112, 40, { stack: true, hidden: true }),
      P('ticker', 0, 672, 1280, 48, { hidden: true }),
    ],
  },
  {
    id: 'p-pip', name: 'Slides + speaker', desc: 'Full presentation with the speaker in a picture-in-picture corner.',
    els: [
      P('media', 32, 32, 1216, 656, { radius: 12, stack: true }),
      P('slot', 952, 464, 272, 200, { index: 0, radius: 16, pip: true, stack: true }),
      P('logo', 1120, 48, 112, 40, { stack: true }),
      P('banner', 56, 560, 576, 104, { stack: true, hidden: true }),
      P('captions', 64, 608, 856, 56, { stack: true }),
      P('featured', 56, 480, 520, 160, { stack: true, hidden: true }),
      P('ticker', 0, 672, 1280, 48, { hidden: true }),
      P('ads', 952, 288, 272, 152, { hidden: true }),
    ],
  },
  {
    id: 'p-arena', name: 'AI arena', desc: 'Two debaters flank the AI judge, with a round clock on top.',
    els: [
      P('text', 48, 32, 352, 48, { text: 'THE DEBATE', size: 28, bold: true, color: '#ffffff', align: 'left', bg: '' }),
      P('timer', 560, 32, 160, 48, { mode: 'countdown', size: 34, color: '#ffffff', bg: '' }),
      P('logo', 1088, 32, 144, 48),
      P('slot', 48, 104, 336, 456, { index: 0, radius: 18 }),
      P('ai', 416, 104, 448, 456, { size: 22 }),
      P('slot', 896, 104, 336, 456, { index: 1, radius: 18 }),
      P('banner', 48, 584, 816, 104),
      P('ads', 896, 584, 336, 104),
      P('captions', 160, 488, 960, 64, { stack: true }),
      P('featured', 416, 400, 448, 152, { stack: true, hidden: true }),
      P('ticker', 0, 672, 1280, 48, { hidden: true }),
    ],
  },
  {
    id: 'p-chat', name: 'Chat-led show', desc: 'The audience drives it: a tall chat rail and a spotlight for super chats.',
    els: [
      P('slot', 48, 32, 720, 456, { index: 0, radius: 16 }),
      P('chat', 800, 32, 432, 656, { max: 10, size: 20, bg: true, fade: false }),
      P('featured', 48, 512, 720, 176),
      P('logo', 656, 48, 96, 40, { stack: true }),
      P('captions', 64, 408, 688, 64, { stack: true }),
      P('banner', 48, 512, 720, 176, { hidden: true }),
      P('ads', 48, 512, 720, 176, { hidden: true }),
      P('ticker', 0, 672, 1280, 48, { hidden: true }),
    ],
  },
  {
    id: 'p-newsroom', name: 'Newsroom', desc: 'Anchor plus remote guest, a station bug, sponsor box and a live ticker.',
    els: [
      P('slot', 48, 32, 784, 488, { index: 0, radius: 12 }),
      P('slot', 864, 32, 368, 224, { index: 1, radius: 12 }),
      P('ads', 864, 288, 368, 232),
      P('banner', 48, 536, 784, 112),
      P('logo', 864, 536, 368, 112),
      P('ticker', 0, 672, 1280, 48),
      P('captions', 160, 440, 960, 64, { stack: true }),
      P('featured', 864, 288, 368, 232, { stack: true, hidden: true }),
    ],
  },
];

/** Gives each preset element an id and remembers where it started (its home, used by Reset). */
export function materialize(els, uid) {
  return els.map((e) => ({ ...e, id: uid(), home: [e.x, e.y, e.w, e.h] }));
}
