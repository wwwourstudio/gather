/**
 * Verifies the design system: screenshots every primitive in every state from /ui-kit.html
 * (default, hover, active, focus-visible, plus the disabled / loading / pressed specimens on the page)
 * in dark and light, and checks the token contract in the live page:
 *   control heights 28/34/42 · radii 6/8/12 · icons 16/20 at stroke 1.75 · Inter for UI ·
 *   tabular numbers · 150ms ease-out UI motion · ~0ms under prefers-reduced-motion ·
 *   docked regions are frosted glass: translucent fill, backdrop blur, a faint light edge.
 *
 *   node scripts/ui-kit.ts            # → audit/screens/ui-kit/, exits 1 if a check fails
 */
type Page = import('playwright').Page;
const { chromium } = require('playwright') as typeof import('playwright');
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');

const BASE = (process.env.GATHER_URL || 'http://localhost:8080').replace(/\/$/, '');
const OUT = path.resolve(__dirname, '..', 'audit', 'screens', 'ui-kit');
const failures: string[] = [];
const check = (ok: boolean, what: string): void => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

async function clipShot(p: Page, sel: string, file: string): Promise<void> {
  const box = await p.locator(sel).boundingBox();
  if (!box) return;
  const pad = 14;
  await p.screenshot({ path: path.join(OUT, file), clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 } });
}

async function states(p: Page, theme: string): Promise<void> {
  const kits = await p.locator('[data-kit]').evaluateAll((els: Element[]) => els.map((e) => (e as HTMLElement).dataset.kit ?? ''));
  for (const kit of kits) {
    const sel = `[data-kit="${kit}"]`, el = p.locator(sel);
    await el.scrollIntoViewIfNeeded();
    await p.mouse.move(0, 0); await p.waitForTimeout(220);
    await clipShot(p, sel, `${theme}-${kit}-1-default.png`);
    const interactive = await el.evaluate((n: Element) => n.matches('button:not(:disabled):not([aria-busy="true"]), input:not(:disabled):not([aria-busy="true"]), select, label'));
    if (!interactive) continue;
    await el.hover(); await p.waitForTimeout(220);
    await clipShot(p, sel, `${theme}-${kit}-2-hover.png`);
    const b = await el.boundingBox();
    if (b) { await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down(); await p.waitForTimeout(140); await clipShot(p, sel, `${theme}-${kit}-3-active.png`); await p.mouse.up(); }
    await p.mouse.move(0, 0);
    // keyboard focus → :focus-visible
    await p.keyboard.press('Shift');
    await el.evaluate((n: Element) => (n as HTMLElement).focus());
    await p.waitForTimeout(220);
    await clipShot(p, sel, `${theme}-${kit}-4-focus-visible.png`);
    await el.evaluate((n: Element) => (n as HTMLElement).blur());
    await p.keyboard.press('Escape');
  }
}

async function main(): Promise<void> {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/ui-kit.html`); await p.waitForTimeout(600);

  // ---- token contract
  const m = await p.evaluate(() => {
    const q = (s: string): Element => document.querySelector(s) as Element;
    const cs = (s: string): CSSStyleDeclaration => getComputedStyle(q(s));
    const h = (s: string): number => q(s).getBoundingClientRect().height;
    const icon = document.querySelector('.btn.round .i') as SVGElement, iconSm = document.querySelector('.icon-btn.sm .i') as SVGElement;
    return {
      btn: [h('.btn.sm'), h('.btn:not(.sm):not(.lg):not(.link)'), h('.btn.lg')],
      ib: [h('.icon-btn.sm'), h('.icon-btn.filled:not(.sm):not(.lg)'), h('.icon-btn.lg')],
      seg: h('.seg:not(.sm)'),
      radii: [cs('.btn').borderRadius, cs('.glass:not(.raised):not(.on-media)').borderRadius, getComputedStyle(document.documentElement).getPropertyValue('--r-md').trim()],
      iconStroke: [getComputedStyle(icon).strokeWidth, getComputedStyle(iconSm).strokeWidth],
      iconSize: [icon.getBoundingClientRect().width, document.querySelector('.icon-btn.filled:not(.sm) .i')?.getBoundingClientRect().width ?? 0, iconSm.getBoundingClientRect().width],
      uiFont: cs('.btn').fontFamily, displayFont: cs('h1').fontFamily,
      tnum: cs('.num').fontVariantNumeric,
      motion: [cs('.btn').transitionDuration.split(',')[0], cs('.btn').transitionTimingFunction.split(/,(?![^(]*\))/)[0].trim()],
      glass: [cs('[data-kit="glass"]').backgroundColor, cs('[data-kit="glass"]').backdropFilter, cs('[data-kit="glass"]').borderTopColor, cs('[data-kit="glass"]').boxShadow],
    };
  });
  check(m.btn.join() === '28,34,42', `Button heights sm/md/lg = 28/34/42 (got ${m.btn.join('/')})`);
  check(m.ib.join() === '28,34,42', `IconButton sizes = 28/34/42 (got ${m.ib.join('/')})`);
  check(m.seg === 34, `SegmentedControl height 34 (got ${m.seg})`);
  check(m.radii[0] === '6px' && m.radii[1] === '12px' && m.radii[2] === '8px', `radii 6/8/12 (got ${m.radii.join(' ')})`);
  check(m.iconStroke.every((w) => w === '1.75px' || w === '1.75'), `icon stroke 1.75 (got ${m.iconStroke.join(', ')})`);
  check(m.iconSize.join() === '16,20,16', `icon sizes 16/20 (got ${m.iconSize.join('/')})`);
  check(/^"?Inter/.test(m.uiFont), `UI font is Inter (got ${m.uiFont})`);
  check(/Plus Jakarta Sans/.test(m.displayFont), `display font is Plus Jakarta Sans (got ${m.displayFont})`);
  check(m.tnum.includes('tabular-nums'), `.num uses tabular numbers (got ${m.tnum})`);
  check(m.motion[0] === '0.15s' && /cubic-bezier\(0\.22, 1, 0\.36, 1\)/.test(m.motion[1]), `UI motion 150ms ease-out (got ${m.motion.join(' ')})`);
  check(/rgba\(13, 19, 34, 0\.6\d*\)/.test(m.glass[0]) && /blur\(28px\)/.test(m.glass[1]) && /rgba\(255, 255, 255, 0\.08\)/.test(m.glass[2]), `docked panels are frosted glass: translucent, blurred, light edge (got ${m.glass.join(' | ')})`);

  // ---- every state, both themes
  await states(p, 'dark');
  await p.screenshot({ path: path.join(OUT, 'dark-page.png'), fullPage: true });
  await p.click('#popBtn'); await p.waitForTimeout(250); await p.screenshot({ path: path.join(OUT, 'dark-popover.png') });
  check(await p.locator('#demoPop').evaluate((e: Element) => e.matches(':popover-open')), 'Popover opens in the top layer');
  await p.keyboard.press('Escape');
  check(!(await p.locator('#demoPop').evaluate((e: Element) => e.matches(':popover-open'))), 'Popover closes on Escape');
  await p.click('#modalBtn'); await p.waitForTimeout(250); await p.screenshot({ path: path.join(OUT, 'dark-modal.png') });
  await p.keyboard.press('Escape');
  await p.locator('[data-kit="tooltip-trigger"]').hover(); await p.waitForTimeout(700);
  check(await p.locator('.tooltip.show').count() === 1 && (await p.locator('.tooltip').textContent())?.startsWith('Copy room code') === true, 'Tooltip shows the control’s name on hover');
  await clipShot(p, '[data-kit="tooltip-trigger"]', 'dark-tooltip-trigger.png');
  await p.screenshot({ path: path.join(OUT, 'dark-tooltip.png') });
  await p.mouse.move(0, 0);
  await p.click('[data-busy-demo]');
  check(await p.locator('[data-busy-demo]').getAttribute('aria-busy') === 'true', 'busy() puts a Button in its loading state');
  await p.click('#themeSeg [data-t="light"]'); await p.waitForTimeout(300);
  await states(p, 'light');
  await p.screenshot({ path: path.join(OUT, 'light-page.png'), fullPage: true });

  // ---- reduced motion
  await p.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await p.evaluate(() => [getComputedStyle(document.querySelector('.btn') as Element).transitionDuration.split(',')[0], getComputedStyle(document.querySelector('.toggle') as Element, '::after').transitionDuration.split(',')[0]]);
  check(reduced.every((d) => parseFloat(d) < 0.001), `prefers-reduced-motion collapses UI motion (got ${reduced.join(', ')})`);

  // ---- the app uses only primitives' icon set and fonts
  await p.goto(`${BASE}/`); await p.waitForTimeout(800);
  const app = await p.evaluate(() => ({
    rawSvgs: [...document.querySelectorAll('svg:not(.i):not(.g-logo)')].filter((s) => !s.closest('.media-sink')).length, // .g-logo: Google's required brand mark on the sign-in button
    sprite: document.querySelectorAll('svg.i use[href^="/icons.svg#i-"]').length,
    fonts: [...new Set([...document.querySelectorAll('body *')].filter((e) => (e as HTMLElement).checkVisibility?.()).map((e) => getComputedStyle(e).fontFamily.split(',')[0].replace(/"/g, '').trim()))],
  }));
  check(app.rawSvgs === 0, `app has no hand-drawn SVG icons (found ${app.rawSvgs})`);
  check(app.sprite > 20, `app icons come from the Lucide sprite (${app.sprite})`);
  check(app.fonts.every((f) => ['Inter', 'Plus Jakarta Sans', 'JetBrains Mono'].includes(f)), `app UI uses only Inter + Plus Jakarta Sans, with JetBrains Mono for links and codes (found ${app.fonts.join(', ')})`);
  check(errors.length === 0, `no page errors (${errors.join('; ')})`);

  await browser.close();
  console.log(`\n${fs.readdirSync(OUT).length} screenshots → ${path.relative(process.cwd(), OUT)}`);
  if (failures.length) { console.log(`${failures.length} check(s) failed`); process.exit(1); }
}
void main();
