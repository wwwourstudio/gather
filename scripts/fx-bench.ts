/**
 * Green screen and background blur quality benchmark: previous algorithm vs the current public/fx.js,
 * measured against ground truth on synthetic scenes (see scripts/fixtures/fx-bench-page.js).
 *
 *   node server.js & node scripts/fx-bench.ts      # prints a table, writes audit/fx-bench.json
 */
const { chromium } = require('playwright') as typeof import('playwright');
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');

type Pair = [number, number];
interface Bench { key: string; results: Record<string, Record<string, Pair>> }

async function main(): Promise<void> {
  const BASE = (process.env.GATHER_URL || 'http://localhost:8080').replace(/\/$/, '');
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`${BASE}/ui-kit.html`);
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, 'fixtures', 'fx-bench-page.js'), 'utf8') });
  const out = await page.evaluate('window.runFxBench()') as Bench;
  await browser.close();
  const rows: string[] = ['| Test | Measure | Before | After | Better by |', '|---|---|---|---|---|'];
  const factors: number[] = [];
  const names: Record<string, string> = { green: 'Green screen', mask: 'AI background (mask)', blur: 'Background blur' };
  for (const [group, metrics] of Object.entries(out.results)) {
    for (const [name, [before, after]] of Object.entries(metrics)) {
      const factor = before / Math.max(after, 1e-6);
      factors.push(factor);
      rows.push(`| ${names[group] ?? group} | ${name} | ${before.toFixed(4)} | ${after.toFixed(4)} | ${factor.toFixed(1)}× (${Math.round((factor - 1) * 100)}% better) |`);
    }
  }
  const geo = Math.exp(factors.reduce((s, f) => s + Math.log(f), 0) / factors.length);
  rows.push('', `Geometric mean: ${geo.toFixed(2)}× less error (${Math.round((geo - 1) * 100)}% better). Key colour: ${out.key}.`);
  console.log(rows.join('\n'));
  fs.mkdirSync(path.resolve(__dirname, '..', 'audit'), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, '..', 'audit', 'fx-bench.json'), JSON.stringify({ ...out, geometricMean: geo }, null, 2));
}
void main();
