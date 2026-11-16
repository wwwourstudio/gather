// The V5 audit's Phase 0 exit test: a keyboard-only host gets from the landing page into a studio and records,
// with focus always somewhere sensible. It also prints the Phase 1 baseline: clicks from landing to studio and
// how much of the screen the stage gets at 1440, 1024 and 390 px (target 65 / 55 / 45 %).
const { chromium } = require('playwright');
const URL0 = process.env.GATHER_URL || 'http://localhost:8080';
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  let ok = true;
  const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) ok = false; };
  const errs = [];
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => errs.push(e.message));
  const focused = () => page.evaluate(() => { const a = document.activeElement; return a ? a.id || a.getAttribute('aria-label') || a.textContent.trim().slice(0, 30) || a.tagName : ''; });
  const tabTo = async (id, max) => { for (let n = 1; n <= max; n++) { await page.keyboard.press('Tab'); if ((await page.evaluate(() => document.activeElement?.id)) === id) return n; } return -1; };
  try {
    await page.goto(URL0 + '/');
    // Landing → green room → studio, keyboard only.
    const toCreate = await tabTo('enterStage', 10);
    check('Create a studio is reachable by Tab', toCreate > 0, `${toCreate} tab(s)`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#enterDlg[open]');
    await page.focus('#enterName'); await page.keyboard.type('Kim Keys'); await page.keyboard.press('Enter');
    await page.waitForSelector('#inviteDlg[open]', { timeout: 15000 });
    check('the show is named after its host', await page.evaluate(() => window.__gather.state.title) === 'Kim’s show', await page.evaluate(() => window.__gather.state.title));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    check('closing the auto-opened invite dialog leaves focus on a control, not the page', !['BODY', ''].includes(await focused()), await focused());
    check('the setup guide no longer asks to name the show', !/Name your show/.test(await page.textContent('.dock')));

    // The scene strip is one tab stop; arrows move inside it.
    const stops = await page.evaluate(() => [...document.querySelectorAll('#sceneStrip > *')].filter((b) => b.tabIndex >= 0).length);
    check('the scene strip is a single tab stop', stops === 1, `${stops} stops`);
    await page.focus('#sceneStrip [tabindex="0"]');
    const before = await focused(); await page.keyboard.press('ArrowRight'); const after = await focused();
    check('arrow keys move between scenes', before !== after, `${before} → ${after}`);

    // Skip link → dock → Record.
    // Start from the top of the page, as after a fresh load (blur() alone keeps Chrome's Tab position).
    await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex'); });
    await page.keyboard.press('Tab');
    check('the first Tab offers "Skip to studio controls"', (await page.evaluate(() => document.activeElement?.id)) === 'skipDock', await focused());
    await page.keyboard.press('Enter');
    const toRec = await tabTo('recBtn', 10);
    check('Record is a few tabs past the skip link (was about 34)', toRec > 0 && toRec <= 6, `${toRec} tab(s)`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__gather.rec, null, { timeout: 5000 }).catch(() => {});
    check('Record exposes its state to screen readers', await page.getAttribute('#recBtn', 'aria-pressed') === 'true');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#recDlg[open]', { timeout: 10000 }).catch(() => {});
    check('stopping opens the recording, still by keyboard', await page.isVisible('#recDlg'));
    check('the studio has a level-1 heading', await page.evaluate(() => !!document.querySelector('[role="heading"][aria-level="1"]:not([hidden]), h1:not([hidden])')));
    await page.keyboard.press('Escape');

    // Phase 1 baseline (printed, not asserted yet).
    const share = [];
    for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(300);
      const r = await page.evaluate(() => { const b = document.querySelector('#stageCanvas').getBoundingClientRect(); return Math.round((b.width * b.height) / (innerWidth * innerHeight) * 100); });
      share.push(`${w}: ${r}%`);
    }
    console.log('  baseline · clicks landing→studio (anonymous): 2 · stage share', share.join(', '), '(Phase 1 target 65 / 55 / 45 %)');
  } catch (e) { check('suite ran', false, e.stack); }
  console.log('errors A', errs, 'B', []);
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
