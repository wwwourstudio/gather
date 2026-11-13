/**
 * Screenshots of the main UI states at 1440 / 1024 / 390 for before/after comparisons.
 *
 *   node scripts/ui-shots.ts before            # → audit/screens/before/<width>-<state>.png
 *   GATHER_URL=https://… node scripts/ui-shots.ts after
 */
type Page = import('playwright').Page;
const { chromium } = require('playwright') as typeof import('playwright');
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');

const label = (process.argv[2] || 'after').replace(/[^a-z0-9-]/gi, '');
const BASE = (process.env.GATHER_URL || 'http://localhost:8080').replace(/\/$/, '');
const OUT = path.resolve(__dirname, '..', 'audit', 'screens', label);
const WIDTHS: Array<[number, number]> = [[1440, 900], [1024, 768], [390, 844]];

async function snap(p: Page, w: number, name: string): Promise<void> {
  await p.waitForTimeout(350);
  await p.screenshot({ path: path.join(OUT, `${w}-${name}.png`) });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  for (const [w, h] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.goto(BASE + '/'); await p.waitForTimeout(800);
    await snap(p, w, '01-home');
    await p.click('#userBtn'); await snap(p, w, '02-account'); await p.keyboard.press('Escape');
    await p.click('#enterStage'); await p.fill('#enterName', 'Alex Morgan'); await p.waitForTimeout(700);
    await snap(p, w, '03-green-room');
    await p.click('#enterGo'); await p.waitForSelector('#inviteDlg[open]', { timeout: 12000 });
    await snap(p, w, '04-invite');
    await p.keyboard.press('Escape');
    await snap(p, w, '05-studio');
    await p.click('#shareBtn'); await snap(p, w, '06-present-menu'); await p.keyboard.press('Escape'); await p.mouse.click(5, 5);
    for (const [i, tab] of ['stream', 'ai', 'banners', 'layouts', 'brand', 'settings', 'help'].entries()) {
      await p.click(`.rail-btn[data-tab="${tab}"]`);
      if (w < 900) await p.locator(`.panel[data-panel="${tab}"]`).scrollIntoViewIfNeeded();
      await snap(p, w, `${String(7 + i).padStart(2, '0')}-panel-${tab}`);
    }
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.click('[data-deck="people"]').catch(() => undefined);
    await snap(p, w, '14-people');
    await ctx.close();
  }
  await browser.close();
  console.log(`screens → ${path.relative(process.cwd(), OUT)}`);
}
void main();
