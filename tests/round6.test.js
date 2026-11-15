const { chromium } = require('playwright');
const SP = process.argv[2];
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const p = await c.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); return p; };
  const a = await mk(), b = await mk();
  const G = (p, fn, arg) => p.evaluate(fn, arg);
  await a.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/'); await a.click('#enterStage'); await a.fill('#enterName', 'Host'); await a.click('#enterGo');
  await a.waitForSelector('#inviteDlg[open]'); const code = await a.textContent('#inviteCode'); await a.keyboard.press('Escape');
  await b.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/s/' + code); await b.waitForSelector('#enterDlg[open]'); await b.fill('#enterName', 'Guest'); await b.click('#enterGo');
  await b.waitForFunction(() => !!window.__gather.studio, null, { timeout: 12000 });
  // presets: no unintended overlaps, on the grid, inside action-safe
  const audit = await G(a, async () => { const L = await import('/layout.js'); return L.PRESETS.map((p) => ({ n: p.name, c: L.collisions(L.materialize(p.els, () => Math.random().toString(36).slice(2))).length })); });
  console.log('1 presets', audit.map((x) => `${x.n}:${x.c}`).join(' '));
  await a.click('#sceneStrip .scene:has-text("Interview panel")');
  await b.waitForFunction(() => window.__gather.state.scene === 'p-interview', null, { timeout: 5000 });
  console.log('  guest sees layers:', await G(b, () => window.__gather.state.elements.map((e) => e.type).sort().join(',')));
  // edit mode
  await a.click('[data-tab="look"]'); await a.click('.look-seg:visible [data-look="layouts"]'); await a.click('#editToggle');
  const box = async (type, n = 0) => a.locator(`.ebox[data-id="${await G(a, ([t, i]) => window.__gather.state.elements.filter((e) => e.type === t)[i].id, [type, n])}"]`);
  const el = (type, n = 0) => G(a, ([t, i]) => { const e = window.__gather.state.elements.filter((x) => x.type === t)[i]; return { ...e }; }, [type, n]);
  const st = await a.locator('#stage').boundingBox();
  // 2 drag camera 1 into camera 2: blocked
  const before = await el('slot', 0), cam2 = await el('slot', 1);
  const b0 = await (await box('slot', 0)).boundingBox();
  await a.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2); await a.mouse.down();
  await a.mouse.move(b0.x + b0.width / 2 + st.width * 0.3, b0.y + b0.height / 2, { steps: 12 });
  const blockedShown = await a.locator('.ebox.blocking').count();
  await a.mouse.up(); await a.waitForTimeout(300);
  const after = await el('slot', 0);
  const overl = (r, o) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h;
  console.log('2 drag into camera 2 blocked:', !overl(after, cam2), '| red highlight on the blocker:', blockedShown > 0, '| moved from', before.x.toFixed(3), 'to', after.x.toFixed(3));
  // 3 snapping: every coordinate on the 8px grid or a guide
  const onGrid = (v, n) => Math.abs(v * n / 8 - Math.round(v * n / 8)) < 1e-6;
  console.log('3 position on 8px grid:', onGrid(after.x, 1280) && onGrid(after.y, 720));
  // 4 Alt-drag stacks deliberately
  // layers that paint nothing yet (no logo set, no banner shown) appear on the stage once picked in Layers
  const pick = async (type) => { await a.click(`#elList .el-row[data-id="${(await el(type)).id}"] .el-pick`); await a.waitForTimeout(150); };
  await pick('logo');
  const logoBox = await (await box('logo')).boundingBox();
  const cam = await (await box('slot', 1)).boundingBox();
  await a.mouse.move(logoBox.x + logoBox.width / 2, logoBox.y + logoBox.height / 2); await a.mouse.down(); await a.keyboard.down("Alt");
  await a.mouse.move(cam.x + 60, cam.y + 60, { steps: 10 }); await a.mouse.up(); await a.keyboard.up('Alt'); await a.waitForTimeout(300);
  const logo = await el('logo');
  console.log('4 Alt-drag logo onto camera → stacked:', !!logo.stack, '| overlaps:', overl(logo, await el('slot', 1)));
  // 5 lock: dragging does nothing
  await a.click(`#elList .el-row[data-id="${(await el('banner')).id}"] .layer-toggle[aria-label^="Lock"]`); await a.waitForTimeout(200);
  await pick('banner');
  const ban = await el('banner'), bb = await (await box('banner')).boundingBox();
  await a.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await a.mouse.down(); await a.mouse.move(bb.x + 300, bb.y - 200, { steps: 6 }); await a.mouse.up();
  const ban2 = await el('banner');
  console.log('5 locked lower third did not move:', ban.x === ban2.x && ban.y === ban2.y && !!ban2.locked);
  // 6 eye hides; guest stops seeing it; reset brings logo home
  await a.click(`#elList .el-row[data-id="${(await el('featured')).id}"] .layer-toggle[aria-label^="Hide"]`);
  await b.waitForFunction(() => window.__gather.state.elements.find((e) => e.type === 'featured').hidden, null, { timeout: 5000 });
  console.log('6 hide synced to guest:', true);
  await a.click(`#elList .el-row[data-id="${logo.id}"] button[aria-label^="Reset"]`); await a.waitForTimeout(200);
  const lr = await el('logo');
  console.log('  reset logo home:', Math.abs(lr.x - lr.home[0]) < 1e-9 && Math.abs(lr.y - lr.home[1]) < 1e-9);
  // 7 keyboard nudge moves 8px
  await a.click(`#elList .el-row[data-id="${lr.id}"] .el-pick`); await a.locator('#stage').hover();
  await a.keyboard.press('ArrowLeft'); await a.waitForTimeout(150);
  const ln = await el('logo');
  console.log('7 ArrowLeft nudge = 8px:', Math.round((lr.x - ln.x) * 1280));
  await a.screenshot({ path: SP + '/r6-editor.png' });
  // 8 per-scene memory: switch away and back, then reload
  const remembered = (await el('slot', 0)).x;
  await a.click('#editToggle');
  await a.click('#sceneStrip .scene:has-text("Newsroom")'); await a.waitForTimeout(300);
  await a.click('#sceneStrip .scene:has-text("Interview panel")'); await a.waitForTimeout(400);
  console.log('8 arrangement restored after switching scenes:', Math.abs((await el('slot', 0)).x - remembered) < 1e-9);
  await a.waitForTimeout(600);
  const ctxA = a.context(); const a2 = await ctxA.newPage();
  await a2.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/'); await a2.waitForTimeout(1200);
  const re = await a2.evaluate(() => ({ scene: window.__gather.state.scene, x: window.__gather.state.elements.find((e) => e.type === 'slot').x }));
  console.log('  after reload: scene', re.scene, '| camera 1 where it was left:', Math.abs(re.x - remembered) < 1e-9);
  // 9 no unintended overlaps in the live layout
  const left = await G(a, async () => { const L = await import('/layout.js'); return L.collisions(window.__gather.state.elements).map(([x, y]) => x.type + '×' + y.type); });
  console.log('9 overlaps in the edited scene:', left.length ? left.join(',') : 'none');
  console.log('errors A', a.errs, 'B', b.errs, 'A2', a2.errs);
  await browser.close();
})().catch((e) => { console.log('FAIL', e.message.split('\n').slice(0, 4).join(' | ')); process.exit(1); });
