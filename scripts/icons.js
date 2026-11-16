// gather's own icon set, drawn for the app (not a stock library). Writes public/icons.svg.
//
// Style: 24px grid, 1.75 rounded strokes (set by .i in ui.css), and a duotone body. A shape with class "d" is a soft
// tinted fill under the outline; class "f" is a solid accent (a dot, a knob, a play triangle). Simple UI glyphs
// (chevrons, close, check, plus) stay as plain strokes so they read at 14px.
//
//   node scripts/icons.js
const fs = require('node:fs');
const path = require('node:path');

const both = (d) => `<path class="d" d="${d}"/><path d="${d}"/>`;
const ring = (cx, cy, r) => `<circle class="d" cx="${cx}" cy="${cy}" r="${r}"/><circle cx="${cx}" cy="${cy}" r="${r}"/>`;
const box = (x, y, w, h, rx) => `<rect class="d" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
const dot = (cx, cy, r) => `<circle class="f" cx="${cx}" cy="${cy}" r="${r}"/>`;

const BUBBLE = 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10.5L6 20.5V17h0.5A2.5 2.5 0 0 1 4 14.5Z';
const SPEAKER = 'M4 9.5h3l4.5-4v13l-4.5-4H4Z';
const DOOR = 'M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14';
const EYE = 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z';
const SHIELD = 'M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6Z';
const FILE = 'M6.5 3h7.5l5 5v10.5a2.5 2.5 0 0 1-2.5 2.5h-10A2.5 2.5 0 0 1 4 18.5v-13A2.5 2.5 0 0 1 6.5 3Z';
const PALETTE = 'M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-1.5-1.2-1.8-1.2-3s.9-2 2.2-2H17a4 4 0 0 0 4-4c0-4-4-7-9-7Z';
const SPARK = 'M11 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5Z';
const PHONE = 'M6 3.5h2.7l1.6 4.4-2.1 1.5a11 11 0 0 0 6.4 6.4l1.5-2.1 4.4 1.6v2.7a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4 5.7a2 2 0 0 1 2-2.2Z';
const TRASH = 'M6 7h12l-.9 12.1a2 2 0 0 1-2 1.9H8.9a2 2 0 0 1-2-1.9Z';
const TRAY = 'M4 15v2.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V15';

const I = {
  'arrow-down': '<path d="M12 5v13M6.5 12.5 12 18l5.5-5.5"/>',
  'arrow-up': '<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/>',
  'arrow-up-right': '<path d="M7.5 16.5 16.5 7.5M9 7.5h7.5V15"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  'chevron-down': '<path d="m7 10 5 5 5-5"/>',
  'chevron-left': '<path d="m14 7-5 5 5 5"/>',
  'chevron-right': '<path d="m10 7 5 5-5 5"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  'circle-dot': `<circle cx="12" cy="12" r="8"/>${dot(12, 12, 3.2)}`,
  'circle-help': `${ring(12, 12, 9)}<path d="M9.6 9.6a2.5 2.5 0 0 1 4.8.8c0 1.7-2.4 2-2.4 3.6"/>${dot(12, 17, 1.1)}`,
  clock: `${ring(12, 12, 9)}<path d="M12 7v5l3.5 2"/>`,
  copy: `${box(8, 8, 12.5, 12.5, 3)}<path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/>`,
  eye: `${both(EYE)}${dot(12, 12, 3)}`,
  'eye-off': '<path d="M2.5 12S6 5.5 12 5.5c1.6 0 3 .4 4.2 1M21.5 12s-3.5 6.5-9.5 6.5c-1.6 0-3-.4-4.2-1M4 20 20 4M9.9 14.1a3 3 0 0 1 4.2-4.2"/>',
  'file-text': `${both(FILE)}<path d="M14 3v5h5M8 13h8M8 16.5h5"/>`,
  flag: '<path class="d" d="M5 4h12l-2.2 4.2L17 12.5H5Z"/><path d="M5 21V4h12l-2.2 4.2L17 12.5H5"/>',
  image: `${box(3, 4, 18, 16, 3)}<path d="m3.5 17 5-5 4 4 2.5-2.5 5.5 5.5"/>${dot(16, 8.5, 1.7)}`,
  'layout-dashboard': `${box(3.5, 3.5, 8, 10, 2)}<rect x="12.5" y="3.5" width="8" height="6" rx="2"/><rect x="12.5" y="10.5" width="8" height="10" rx="2"/><rect x="3.5" y="14.5" width="8" height="6" rx="2"/>`,
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3.1-3.1a4 4 0 0 0-5.7-5.7l-1.2 1.2M14 10a4 4 0 0 0-5.7 0l-3.1 3.1a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  lock: `${box(4.5, 10.5, 15, 10, 3)}<path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>${dot(12, 15.5, 1.5)}`,
  'lock-open': `${box(4.5, 10.5, 15, 10, 3)}<path d="M8 10.5V8a4 4 0 0 1 7.7-1.5"/>${dot(12, 15.5, 1.5)}`,
  'log-out': `<path class="d" d="${DOOR}Z"/><path d="${DOOR}M3.5 12h10M7.5 8l-4 4 4 4"/>`,
  'log-in': `<path class="d" d="${DOOR}Z"/><path d="${DOOR}M3.5 12h10M10 8l4 4-4 4"/>`,
  'message-square': `${both(BUBBLE)}${dot(8.5, 10.5, 1.05)}${dot(12, 10.5, 1.05)}${dot(15.5, 10.5, 1.05)}`,
  mic: `${box(8.5, 3, 7, 11.5, 3.5)}<path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"/>`,
  'mic-off': '<path d="M15.5 10V6.5a3.5 3.5 0 0 0-6.3-2.1M8.5 9v2a3.5 3.5 0 0 0 5.6 2.8M5.5 11a6.5 6.5 0 0 0 10.6 5M18.5 11a6.5 6.5 0 0 1-.4 2.2M12 17.5V21M9 21h6M4 4l16 16"/>',
  monitor: `${box(3, 4, 18, 12.5, 2.5)}<path d="M9 20.5h6M12 16.5v4"/>`,
  'monitor-up': `${box(3, 4, 18, 12.5, 2.5)}<path d="M9 20.5h6M12 16.5v4M12 13V7.5M9.5 10 12 7.5l2.5 2.5"/>`,
  'monitor-x': `${box(3, 4, 18, 12.5, 2.5)}<path d="M9 20.5h6M12 16.5v4M9.7 7.9l4.6 4.6M14.3 7.9l-4.6 4.6"/>`,
  palette: `${both(PALETTE)}${dot(7.5, 11, 1.3)}${dot(9.8, 7, 1.3)}${dot(14.8, 7.3, 1.3)}`,
  pause: '<rect class="f" x="6.5" y="5" width="3.6" height="14" rx="1.3"/><rect class="f" x="13.9" y="5" width="3.6" height="14" rx="1.3"/>',
  phone: both(PHONE),
  play: '<path class="f" d="M8 5.6v12.8a1.1 1.1 0 0 0 1.7.9l9.9-6.4a1.1 1.1 0 0 0 0-1.8L9.7 4.7A1.1 1.1 0 0 0 8 5.6Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'qr-code': `<rect class="d" x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect class="f" x="6" y="6" width="2" height="2"/><rect class="f" x="16" y="6" width="2" height="2"/><rect class="f" x="6" y="16" width="2" height="2"/><path d="M14 14h2.5v2.5M20.5 14v6.5h-3M14 19v1.5"/>`,
  // Go live: a broadcast point with its signal rings.
  radio: `<circle class="d" cx="12" cy="12" r="5.4"/>${dot(12, 12, 2.3)}<path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.2 5.2a9.6 9.6 0 0 0 0 13.6M18.8 5.2a9.6 9.6 0 0 1 0 13.6"/>`,
  repeat: '<path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19M16 3l3 3-3 3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5M8 21l-3-3 3-3"/>',
  'rotate-ccw': '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9M4.5 4.5V9H9"/>',
  search: `${ring(11, 11, 6.5)}<path d="m16 16 4.5 4.5"/>`,
  send: '<path class="d" d="M20.5 3.5 3.5 10.5l7 3 3 7Z"/><path d="M20.5 3.5 3.5 10.5l7 3 3 7ZM10.5 13.5l4-4"/>',
  'shield-check': `${both(SHIELD)}<path d="m8.8 12 2.2 2.2 4.3-4.4"/>`,
  'sliders-horizontal': `<path d="M4 7h8.6M17.4 7H20M4 17h2.6M11.4 17H20"/>${dot(15, 7, 2.4)}${dot(9, 17, 2.4)}`,
  // AI: a four-point spark with a small companion.
  sparkles: `${both(SPARK)}<path d="M18.5 14.5c.2 1.3.9 2 2.2 2.2-1.3.2-2 .9-2.2 2.2-.2-1.3-.9-2-2.2-2.2 1.3-.2 2-.9 2.2-2.2Z"/>`,
  square: '<rect class="f" x="6" y="6" width="12" height="12" rx="2.5"/>',
  'trash-2': `<path class="d" d="${TRASH}"/><path d="${TRASH}M4 7h16M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M10 11v6M14 11v6"/>`,
  upload: `<path class="d" d="${TRAY}Z"/><path d="${TRAY}M12 15V4.5M7.5 9 12 4.5 16.5 9"/>`,
  user: `${ring(12, 8, 4)}<path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>`,
  users: `${ring(9, 8.5, 3.5)}<path d="M2.5 20a6.5 6.5 0 0 1 13 0M15.5 5.2a3.5 3.5 0 0 1 0 6.6M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>`,
  'user-plus': `${ring(10, 8, 4)}<path d="M2.5 20.5a7.5 7.5 0 0 1 14 0M19 8v6M16 11h6"/>`,
  video: `${box(3, 6, 13, 12, 3)}<path d="m16 10.5 5-3v9l-5-3"/>`,
  'video-off': '<path d="M16 13.5v1.5a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h1M11 6h2a3 3 0 0 1 3 3v1.5l5-3v9M3 3l18 18"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  activity: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  command: '<path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9h11A2.5 2.5 0 1 0 15 6.5v11a2.5 2.5 0 1 0 2.5-2.5h-11A2.5 2.5 0 1 0 9 17.5Z"/>',
  presentation: '<path class="d" d="M4 4h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M2.5 4h19M4 4v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4M12 16v3M8.5 21l3.5-2 3.5 2M8 12l2.5-3 2 2 3-3.5"/>',
  'volume-2': `${both(SPEAKER)}<path d="M15 9a4 4 0 0 1 0 6M17.8 6.5a7.5 7.5 0 0 1 0 11"/>`,
  'volume-x': `${both(SPEAKER)}<path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>`,
  maximize: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
  // A raised open hand: ask the host something.
  hand: '<path fill="currentColor" stroke="none" fill-opacity="0.22" d="M8 13V6a1.5 1.5 0 0 1 3 0v-1.5a1.5 1.5 0 0 1 3 0V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.6a6 6 0 0 1-4.9-2.6l-2.6-3.7a1.6 1.6 0 0 1 2.4-2.1Z"/><path d="M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.6a6 6 0 0 1-4.9-2.6l-2.6-3.7a1.6 1.6 0 0 1 2.4-2.1L8 15"/>',
  smile: `${ring(12, 12, 9)}<path d="M8.5 14.2a4.3 4.3 0 0 0 7 0"/>${dot(9, 10, 1.2)}${dot(15, 10, 1.2)}`,
  // Tip: a coin, for super chats paid straight to the host.
  tip: `${ring(12, 12, 9)}<path d="M14.6 9.3c-.4-.9-1.4-1.4-2.6-1.4-1.5 0-2.6.8-2.6 1.9 0 2.6 5.4 1.3 5.4 4.2 0 1.1-1.1 2-2.8 2-1.3 0-2.4-.6-2.8-1.5M12 6.5v1.4M12 16.5v1"/>`,
  scissors: `${ring(6.5, 7, 2.5)}${ring(6.5, 17, 2.5)}<path d="M8.6 8.4 20 17M8.6 15.6 20 7"/>`,
  heart: both('M12 20.5s-8-4.6-8-10.4A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 8 2.5c0 5.8-8 10.4-8 10.4Z'),
  pip: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect class="d" x="3" y="5" width="18" height="14" rx="2.5"/><rect class="f" x="12" y="11.5" width="7" height="5.5" rx="1.2"/>',
};

const out = ['<svg xmlns="http://www.w3.org/2000/svg"><!-- gather icons: drawn for gather. Generated by scripts/icons.js -->'];
// CSS can't reach inside <use> clones, so the two fills are written as attributes on the shapes themselves.
const paint = (body) => body.replaceAll('class="d"', 'fill="currentColor" stroke="none" fill-opacity="0.22"').replaceAll('class="f"', 'fill="currentColor" stroke="none"');
for (const [id, body] of Object.entries(I)) out.push(`<symbol id="i-${id}" viewBox="0 0 24 24">${paint(body)}</symbol>`);
out.push('</svg>', '');
fs.writeFileSync(path.join(__dirname, '..', 'public', 'icons.svg'), out.join('\n'));
console.log(`${Object.keys(I).length} icons written`);
