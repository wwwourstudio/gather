// gather UI primitives — the behaviour half of ui.css: Icon, loading state, Popover anchoring, Tooltip.

/** An icon from gather's sprite (scripts/icons.js). size: 'md' (20px) or 'sm' (16px). */
export function icon(name, { size = 'md', cls = '' } = {}) {
  return `<svg class="i${size === 'sm' ? ' sm' : ''}${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="/icons.svg#i-${name}"/></svg>`;
}

/** Loading state for a Button / IconButton / Toggle: keeps its size, hides the label, shows a spinner. */
export function busy(el, on = true) {
  if (!el) return;
  if (on) { el.setAttribute('aria-busy', 'true'); el.dataset.wasDisabled = el.disabled ? '1' : ''; el.disabled = true; }
  else { el.removeAttribute('aria-busy'); el.disabled = el.dataset.wasDisabled === '1'; delete el.dataset.wasDisabled; }
}
/** Run an async action with the control in its loading state. */
export async function withBusy(el, fn) {
  busy(el, true);
  try { return await fn(); } finally { busy(el, false); }
}

// ------------------------------------------------------------------ Popover
// Popovers use the native [popover] attribute: top layer (never clipped by a scrolling parent),
// light dismiss and Escape for free. This places them next to their anchor and keeps them on screen.
const GAP = 8, EDGE = 8;
export function placePopover(pop, anchor, prefer = 'top') {
  const a = anchor.getBoundingClientRect(), p = pop.getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight;
  let side = prefer;
  if (side === 'top' && a.top - p.height - GAP < EDGE) side = 'bottom';
  else if (side === 'bottom' && a.bottom + p.height + GAP > vh - EDGE) side = 'top';
  const top = side === 'top' ? a.top - p.height - GAP : a.bottom + GAP;
  const left = Math.min(Math.max(EDGE, a.left + a.width / 2 - p.width / 2), vw - p.width - EDGE);
  pop.style.top = `${Math.round(Math.max(EDGE, top))}px`;
  pop.style.left = `${Math.round(left)}px`;
  pop.dataset.side = side;
}
/** Open a popover anchored to an element, closing it if it is already open. */
export function togglePopover(pop, anchor, prefer = 'top') {
  if (pop.matches(':popover-open')) { pop.hidePopover(); return false; }
  pop.showPopover();
  placePopover(pop, anchor, prefer);
  anchor.setAttribute('aria-expanded', 'true');
  pop.addEventListener('toggle', function closed(e) { if (e.newState === 'closed') { anchor.setAttribute('aria-expanded', 'false'); pop.removeEventListener('toggle', closed); } });
  pop.querySelector('button:not(:disabled), [href]')?.focus({ preventScroll: true });
  return true;
}
addEventListener('resize', () => { for (const p of document.querySelectorAll('.popover:popover-open')) p.hidePopover(); });

// ------------------------------------------------------------------ Tooltip
// [data-tip] on any element shows a tooltip: after 450ms on hover, immediately on keyboard focus.
// Icon-only controls get theirs from aria-label, so their name and their tooltip never disagree.
// Plain title attributes on buttons are converted on first hover so the browser's own tooltip
// doesn't appear twice.
let tip = null, tipFor = null, tipTimer = 0;
function tipEl() {
  if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip'; tip.setAttribute('role', 'tooltip'); tip.id = 'ui-tooltip'; document.body.append(tip); }
  return tip;
}
function tipText(el) { return el.dataset.tip || (el.matches('.icon-btn, [data-tip-label]') ? el.getAttribute('aria-label') : '') || ''; }
function showTip(el) {
  const text = tipText(el);
  if (!text || el.disabled && !el.matches('[data-tip]')) return;
  const t = tipEl();
  t.textContent = text;
  if (el.dataset.key) { const k = document.createElement('kbd'); k.textContent = el.dataset.key; t.append(k); }
  t.classList.add('show');
  const a = el.getBoundingClientRect(), r = t.getBoundingClientRect();
  let top = a.top - r.height - 8;
  if (top < 8) top = a.bottom + 8;
  t.style.top = `${Math.round(top)}px`;
  t.style.left = `${Math.round(Math.min(Math.max(8, a.left + a.width / 2 - r.width / 2), innerWidth - r.width - 8))}px`;
  el.setAttribute('aria-describedby', t.id);
  tipFor = el;
}
function hideTip() {
  clearTimeout(tipTimer);
  if (tipFor) tipFor.removeAttribute('aria-describedby');
  tipFor = null;
  tip?.classList.remove('show');
}
function target(e) {
  const el = e.target instanceof Element ? e.target.closest('[data-tip], .icon-btn[aria-label], button[title], [data-tip-label]') : null;
  if (el?.hasAttribute('title')) { if (!el.dataset.tip && !el.matches('.icon-btn[aria-label]')) el.dataset.tip = el.title; el.removeAttribute('title'); }
  return el && tipText(el) ? el : null;
}
document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const el = target(e);
  if (el === tipFor) return;
  hideTip();
  if (el) tipTimer = setTimeout(() => showTip(el), 450);
});
document.addEventListener('pointerout', (e) => { if (tipFor && !tipFor.contains(e.relatedTarget)) hideTip(); else if (!tipFor) clearTimeout(tipTimer); });
document.addEventListener('focusin', (e) => { const el = target(e); hideTip(); if (el && el.matches(':focus-visible')) showTip(el); });
document.addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', hideTip, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
addEventListener('scroll', hideTip, true);
