/**
 * Monte Carlo over the studio's header and side panel: which arrangement costs a host the least time and attention
 * during a show, and leaves the most room for the stage?
 *
 *   node scripts/layout-mc.js [samples]     # prints the ranking and writes audit/layout-mc.json
 *
 * Each sample is one simulated show hour by one host:
 *   - The host is a novice or an expert (Hick's-law slope and how often they hunt for a control differ).
 *   - Their screen is 1280–1920 px wide.
 *   - Tasks arrive by frequency (triangular ranges per hour: chat, featuring a message, switching scenes, answering
 *     voice questions and super chats, polls/shop/queue, sharing the link, inviting, going live, layout, AI,
 *     settings/help/account). The panel the host is on carries over from task to task, so a layout that splits
 *     related work across tabs pays switching costs, and one that keeps frequent work together doesn't.
 *   - Each step costs a decision (Hick: a + b·log2(n+1) over the controls visible where the eye lands), a pointer
 *     move (Fitts: a + b·log2(D/W + 1)), a scroll when the target sits below the fold of a long panel, and a tab
 *     switch when the task lives on another panel.
 * Score = seconds spent operating the UI per show hour (lower is better). Also reported: controls always in view
 * (busyness) and stage width left on a 1440 px screen. Parameters are textbook ranges, drawn per sample; the point
 * is the ranking and how often each variant wins, not the absolute seconds.
 */
const fs = require('node:fs');
const path = require('node:path');

const N = Number(process.argv[2]) || 20000;
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const tri = ([lo, mode, hi]) => { const u = rnd(), c = (mode - lo) / (hi - lo || 1); return u < c ? lo + Math.sqrt(u * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode)); };
const poisson = (l) => { let k = 0, p = Math.exp(-l), s = p; const u = rnd(); while (u > s && k < 500) { k++; p *= l / k; s += p; } return k; };

// Tasks per show hour (low, likely, high). "where" names the home of the task in each layout below.
const TASKS = {
  chat: [15, 30, 60], feature: [3, 8, 16], scene: [4, 10, 24], inbox: [1, 4, 12], engage: [1, 3, 8],
  share: [0.5, 1.5, 4], invite: [0.3, 1, 3], live: [0.5, 1, 2], layout: [0, 1, 4], ai: [0, 2, 8], pageSet: [0.1, 0.5, 2], meta: [0.1, 0.3, 1],
};

// A step: n = controls in view where the eye lands, d = pointer travel (px, at 1440 wide), w = target size (px),
// tab = panel the step needs ('' = none), deep = 0..1 how far down a long panel it sits (0 = always in view).
const S = (n, d, w, tab = '', deep = 0) => ({ n, d, w, tab, deep });

const HEADERS = {
  'H1 current': { always: 9, note: 'logo, title, status, account, help, settings, watch link, invite, go live',
    share: [S(9, 700, 34)], invite: [S(9, 650, 34), S(6, 300, 40)], live: [S(9, 760, 34), S(14, 400, 40)], meta: [S(9, 600, 34), S(12, 300, 34)] },
  'H2 share + menu': { always: 5, note: 'logo + title, Share (guests and viewers in one), Go live, account menu (help, settings, sign in)',
    share: [S(5, 700, 36), S(4, 160, 40)], invite: [S(5, 700, 36), S(4, 200, 40)], live: [S(5, 760, 36), S(14, 400, 40)], meta: [S(5, 790, 34), S(5, 120, 36)] },
  'H3 share + menu, live in dock': { always: 4, note: 'as H2, with Go live moved to the bottom bar next to Record',
    share: [S(4, 700, 36), S(4, 160, 40)], invite: [S(4, 700, 36), S(4, 200, 40)], live: [S(9, 520, 40), S(14, 400, 40)], meta: [S(4, 790, 34), S(5, 120, 36)] },
};

// Side panel variants. width = px taken from the stage (panel + rail). Steps for each panel task.
const PANELS = {
  'P1 current': { width: 436, note: 'icon rail (Chat, Show, Look, AI); Show is one long page of ~25 controls with folds',
    chat: [S(6, 120, 40, 'chat')], feature: [S(6, 160, 28, 'chat')],
    inbox: [S(25, 260, 32, 'show', 0.5), S(4, 80, 30, 'show')], engage: [S(25, 240, 32, 'show', 0.8), S(8, 120, 32, 'show')],
    pageSet: [S(25, 220, 32, 'show', 0.3)], layout: [S(14, 200, 60, 'look')], ai: [S(8, 160, 40, 'ai')], scene: [S(10, 300, 90)] },
  'P2 rail + Show subtabs': { width: 436, note: 'same rail; Show split into Inbox / Engage / Page subtabs',
    chat: [S(6, 120, 40, 'chat')], feature: [S(6, 160, 28, 'chat')],
    inbox: [S(4, 220, 30, 'show'), S(8, 120, 32, 'show:inbox')], engage: [S(4, 220, 30, 'show'), S(9, 140, 32, 'show:engage')],
    pageSet: [S(4, 220, 30, 'show'), S(10, 160, 32, 'show:page', 0.2)], layout: [S(14, 200, 60, 'look')], ai: [S(8, 160, 40, 'ai')], scene: [S(10, 300, 90)] },
  'P3 top tabs, no rail': { width: 360, note: 'tabs across the top of the panel (Chat, Show, Look, AI) instead of a rail; Show subtabs as P2',
    chat: [S(6, 120, 40, 'chat')], feature: [S(6, 160, 28, 'chat')],
    inbox: [S(4, 200, 30, 'show'), S(8, 120, 32, 'show:inbox')], engage: [S(4, 200, 30, 'show'), S(9, 140, 32, 'show:engage')],
    pageSet: [S(4, 200, 30, 'show'), S(10, 160, 32, 'show:page', 0.2)], layout: [S(14, 200, 60, 'look')], ai: [S(8, 160, 40, 'ai')], scene: [S(10, 300, 90)] },
  'P4 top tabs, inbox in chat': { width: 360, note: 'as P3, but voice questions and super chats wait in a strip at the top of Chat (where hosts already are); Show = Engage + Page',
    chat: [S(7, 120, 40, 'chat')], feature: [S(7, 160, 28, 'chat')],
    inbox: [S(7, 140, 32, 'chat'), S(4, 80, 30, 'chat')], engage: [S(3, 200, 30, 'show'), S(9, 140, 32, 'show:engage')],
    pageSet: [S(3, 200, 30, 'show'), S(10, 160, 32, 'show:page', 0.2)], layout: [S(14, 200, 60, 'look')], ai: [S(8, 160, 40, 'ai')], scene: [S(10, 300, 90)] },
};

function simulate(H, P) {
  const expert = rnd() < 0.45;
  const hickA = tri([0.15, 0.2, 0.3]), hickB = expert ? tri([0.08, 0.12, 0.16]) : tri([0.15, 0.2, 0.28]);
  const fittsA = tri([0.05, 0.1, 0.15]), fittsB = tri([0.1, 0.15, 0.2]);
  const tabCost = tri([0.6, 0.9, 1.5]), scrollCost = tri([0.8, 1.5, 3]), hunt = expert ? 0.05 : 0.2;
  const scale = tri([1280, 1440, 1920]) / 1440; // distances scale with the screen
  const seq = [];
  for (const [t, r] of Object.entries(TASKS)) for (let i = poisson(tri(r)); i > 0; i--) seq.push(t);
  for (let i = seq.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [seq[i], seq[j]] = [seq[j], seq[i]]; }
  let tab = 'chat', sub = { show: P.chat ? 'inbox' : '' }, total = 0;
  for (const t of seq) {
    const steps = H[t] || P[t] || [];
    for (const s of steps) {
      const [main, subtab] = s.tab.split(':');
      if (main && main !== tab) { total += tabCost; tab = main; }
      if (subtab && sub[main] !== subtab) { total += tabCost * 0.7; sub[main] = subtab; }
      total += hickA + hickB * Math.log2(s.n + 1) * (1 + (rnd() < hunt ? 1 : 0));
      total += fittsA + fittsB * Math.log2((s.d * scale) / s.w + 1);
      if (s.deep && rnd() < s.deep) total += scrollCost;
    }
    if (t === 'chat' || t === 'feature') { if (tab !== 'chat') { total += tabCost; tab = 'chat'; } } // chat pulls the host back
  }
  return total;
}

const combos = [];
for (const [hn, H] of Object.entries(HEADERS)) for (const [pn, P] of Object.entries(PANELS)) combos.push({ name: `${hn} × ${pn}`, H, P, hn, pn, xs: [] });
const wins = new Map(combos.map((c) => [c.name, 0]));
for (let i = 0; i < N; i++) {
  const s0 = seed; let best = null;
  for (const c of combos) { seed = s0; const v = simulate(c.H, c.P); c.xs.push(v); if (!best || v < best.v) best = { v, c }; } // common random numbers
  wins.set(best.c.name, wins.get(best.c.name) + 1);
}
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
const rows = combos.map((c) => ({ layout: c.name, mean: c.xs.reduce((a, b) => a + b, 0) / N, p10: q(c.xs, 0.1), p90: q(c.xs, 0.9), win: wins.get(c.name) / N, inView: c.H.always + 4, stage: 1440 - c.P.width - 48 }))
  .sort((a, b) => a.mean - b.mean);
console.log(`Monte Carlo layout study, ${N} simulated show hours per layout (lower seconds = less time operating the UI)\n`);
console.log('layout'.padEnd(58), 'mean s/h  p10–p90     wins   header items  stage px @1440');
for (const r of rows) console.log(r.layout.padEnd(58), r.mean.toFixed(0).padStart(6), `  ${r.p10.toFixed(0)}–${r.p90.toFixed(0)}`.padEnd(13), `${(r.win * 100).toFixed(1)}%`.padStart(6), String(r.inView).padStart(9), String(r.stage).padStart(12));
fs.mkdirSync(path.join(__dirname, '..', 'audit'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'audit', 'layout-mc.json'), JSON.stringify({ samples: N, headers: Object.fromEntries(Object.entries(HEADERS).map(([k, v]) => [k, v.note])), panels: Object.fromEntries(Object.entries(PANELS).map(([k, v]) => [k, v.note])), rows }, null, 2));
