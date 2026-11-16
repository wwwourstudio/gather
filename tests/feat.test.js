const { chromium } = require('playwright');
const SP = process.argv[2];
let pages = []; // for the timing dump on failure
(async () => {
  // Two windows in one headless browser overlap, and Chrome then treats the one underneath as hidden: it slows its
  // timers and stops drawing frames. In CI that made the guest check in every 3-4 s instead of every second (the app's
  // background-tab rate) and stalled frame-based waits. Real users each have their own visible window.
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
  // Every studio request is timed in the page, so a slow step can show which side was late (see the template step).
  const NET = () => { const f = window.fetch; window.__net = []; window.fetch = function (u, o) { const a = (String(u).match(/action=(\w+)/) || [])[1]; if (!a) return f.apply(this, arguments); const t0 = performance.now(), row = { a, t0: Math.round(t0) }; window.__net.push(row); if (window.__net.length > 80) window.__net.shift(); return f.apply(this, arguments).then((r) => { row.ms = Math.round(performance.now() - t0); return r; }, (e) => { row.ms = -1; throw e; }); }; };
  // Host and guest each get their own browser process, as on two real devices: one shared headless browser has a
  // single software-graphics process, and the host's studio drawing starved the guest's page in CI.
  const browserB = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
  const mk = async (br = browser) => { const c = await br.newContext({ viewport: { width: 1600, height: 1000 } }); await c.addInitScript(NET); const p = await c.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message)); p.on('console', m => m.type() === 'error' && p.errs.push(m.text())); return p; };
  const a = await mk(), b = await mk(browserB);
  pages = [['host', a], ['guest', b]];
  await a.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/'); await a.click('#enterStage'); await a.fill('#enterName', 'Alex Morgan'); await a.click('#enterGo');
  await a.waitForSelector('#inviteDlg[open]'); const code = await a.textContent('#inviteCode'); await a.click('#inviteDlg .modal-close');
  await b.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/s/' + code); await b.waitForSelector('#enterDlg[open]');
  // Picking a background in the green room must not turn an invited guest's "Join studio" into "Create studio".
  await b.click('#grFx [data-fx="blur"]'); await b.click('#grFx [data-fx="none"]');
  const goLabel = (await b.textContent('#enterGo')).trim();
  console.log('guest still joins after picking a background:', goLabel === 'Join studio', `(${goLabel})`);
  if (goLabel !== 'Join studio') console.log('FAIL a background chip switched the guest to', goLabel);
  await b.fill('#enterName', 'Jordan Lee'); await b.click('#enterGo');
  await b.waitForFunction(() => [...window.__gather.peers.values()].some(p => p.conn === 'connected'), null, { timeout: 15000, polling: 100 });
  // 0. backstage: the guest waits off stage until the host clicks their picture; the deck folds away and back
  const bid = await b.evaluate(() => window.__gather.id);
  const offFirst = await a.evaluate((id) => !window.__gather.state.stage.includes(id), bid);
  await a.click('[data-deck="people"]'); await a.click(`#card-${bid} .crew-thumb`);
  await b.waitForFunction((id) => window.__gather.state.stage.includes(id), bid, { timeout: 5000, polling: 100 });
  console.log('0 guest arrived backstage:', offFirst, '| clicked onto stage:', true, '| quick invite in footer:', await a.isVisible('#noteLink') || await a.isVisible('#guide'));
  if (!offFirst) console.log('FAIL the guest went straight on stage');
  await a.click('#deckToggle'); const folded = await a.isHidden('#deckBody'); await a.click('#deckToggle');
  console.log('  deck folds away and back:', folded && await a.isVisible('#deckBody'));
  if (!folded) console.log('FAIL the deck did not fold');
  await a.click('[data-deck="scenes"]');
  // 1. template
  await a.click('[data-tab="look"]'); await a.click('.look-seg:visible [data-look="layouts"]');
  const tClick = await a.evaluate(() => Math.round(performance.now()));
  await a.click('.tpl:has-text("Chat-led show")');
  const tClickB = await b.evaluate(() => Math.round(performance.now()));
  await b.waitForFunction(() => window.__gather.state.layout === 'custom' && window.__gather.state.scene === 'p-chat' && window.__gather.state.elements.some(e => e.type === 'chat'), null, { timeout: 5000, polling: 100 }).catch(async (e) => {
    // This step fails now and then in CI. Show both sides so the next failure says why (slow sync, or the host never applied it).
    const view = (p) => p.evaluate(() => ({ layout: window.__gather.state.layout, scene: window.__gather.state.scene, els: window.__gather.state.elements.map((x) => x.type).join(','), host: window.__gather.host === window.__gather.id, phase: window.__gather.phase, visible: document.visibilityState }));
    console.log('  template step timed out · host:', JSON.stringify(await view(a)), '· guest:', JSON.stringify(await view(b)));
    // Requests since the click, relative to it (ms): host sends and polls, guest polls. A long gap shows the culprit.
    const since = (p, t) => p.evaluate((t) => window.__net.filter((r) => r.t0 >= t - 1500).map((r) => `${r.a}@${r.t0 - t}${r.ms == null ? '…' : '+' + r.ms}`).join(' '), t);
    console.log('  host requests:', await since(a, tClick));
    console.log('  guest requests:', await since(b, tClickB));
    throw e;
  });
  console.log('template synced to guest:', await b.evaluate(() => window.__gather.state.elements.map(e => e.type).join(',')));
  // 2. text element + edit
  await a.click('[data-add="text"]'); await a.fill('#elProps textarea', 'Episode 12: Building in public');
  await b.waitForFunction(() => window.__gather.state.elements.some(e => e.type === 'text' && e.text === 'Episode 12: Building in public'), null, { timeout: 5000, polling: 100 });
  console.log('text edit synced');
  // 3. image upload
  await a.click('[data-add="image"]'); await a.setInputFiles('#elProps input[data-upload]', SP + '/logo.png');
  await a.waitForFunction(() => window.__gather.state.elements.some(e => e.type === 'image' && e.asset && !e.asset.startsWith('local-')), null, { timeout: 8000, polling: 100 });
  await b.waitForFunction(() => { const e = window.__gather.state.elements.find(e => e.type === 'image'); return e && window.__gather.assets.get(e.asset)?.img; }, null, { timeout: 8000, polling: 100 });
  console.log('image uploaded and loaded by guest');
  // 4. drag the image box
  const before = await b.evaluate(() => { const e = window.__gather.state.elements.find(e => e.type === 'image'); return [e.x, e.y]; });
  const box = await a.locator('.ebox.sel').boundingBox();
  await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await a.mouse.down(); await a.keyboard.down("Alt"); await a.mouse.move(box.x - 300, box.y + 120, { steps: 8 }); await a.mouse.up(); await a.keyboard.up("Alt");
  await b.waitForFunction(([x]) => { const e = window.__gather.state.elements.find(e => e.type === 'image'); return Math.abs(e.x - x) > 0.05; }, before, { timeout: 5000, polling: 100 });
  console.log('drag synced:', before, '->', await b.evaluate(() => { const e = window.__gather.state.elements.find(e => e.type === 'image'); return [+e.x.toFixed(3), +e.y.toFixed(3)]; }));
  // 5. countdown timer
  await a.click('[data-add="timer"]'); await a.selectOption('#elProps select[data-k="mode"]', 'countdown'); await a.click('#elProps [data-count="5"]');
  await b.waitForFunction(() => window.__gather.state.elements.some(e => e.type === 'timer' && e.mode === 'countdown' && e.target > Date.now()), null, { timeout: 5000, polling: 100 });
  console.log('countdown synced');
  // 6. chat -> feature on stage
  await a.click('[data-add]'); // no-op guard
  await a.click('#editToggle'); // done editing
  await b.fill('#chatInput', 'Can you explain how the relay keeps it free?'); await b.press('#chatInput', 'Enter');
  await a.click('[data-tab="chat"]');
  await a.waitForSelector('#msgs li[data-src="studio"]:not(.me) .feat', { state: 'attached' });
  await a.hover('#msgs li[data-src="studio"]:not(.me)'); await a.click('#msgs li[data-src="studio"]:not(.me) .feat');
  await b.waitForFunction(() => window.__gather.state.featured?.text?.includes('relay'), null, { timeout: 5000, polling: 100 });
  console.log('featured message synced; feed length on guest:', await b.evaluate(() => window.__gather.feed.length));
  // 7. twitch connect attempt (network may block)
  await a.click('#settingsTop'); await a.fill('#twitchInput', 'https://twitch.tv/SomeChannel'); await a.click('#twitchGo'); await a.keyboard.press('Escape');
  await b.waitForFunction(() => window.__gather.state.feeds.twitch === 'somechannel', null, { timeout: 5000, polling: 100 });
  await a.waitForTimeout(2500);
  console.log('twitch channel synced; host status:', await a.textContent('#twitchStatus'));
  // guest permissions
  console.log('guest add buttons disabled:', await b.isDisabled('[data-add="text"]'), '| guest edit layer hidden:', await b.isHidden('#editLayer'));
  await a.waitForTimeout(800);
  await a.screenshot({ path: SP + '/f-host.png' });
  console.log('guest sees host-only controls:', JSON.stringify({ layouts: await b.isVisible('[data-tab="look"]'), stream: await b.isVisible('#liveTop'), brand: await b.isVisible('[data-tab="show"]'), scenes: await b.isVisible('#sceneStrip'), record: await b.isVisible('#recBtn'), chat: await b.isVisible('[data-tab="chat"]'), settings: await b.isVisible('[data-tab="settings"]') })); await b.screenshot({ path: SP + '/f-guest.png' });
  // edit mode screenshot
  await a.click('[data-tab="look"]'); await a.click('.look-seg:visible [data-look="layouts"]'); await a.click('#editToggle'); await a.waitForTimeout(300); await a.screenshot({ path: SP + '/f-edit.png' });
  // the host walk-through, from Help
  await a.keyboard.press('Escape').catch(() => {});
  await a.click('#helpTop'); await a.click('#tourStart');
  const steps = Number((await a.textContent('#tourStep')).split(' of ')[1]);
  for (let i = 0; i < steps; i++) await a.click('#tourNext');
  console.log('9 walk-through:', steps, 'steps, closed at the end:', await a.isHidden('#tour'));
  if (steps < 8 || !(await a.isHidden('#tour'))) console.log('FAIL the walk-through did not run through');
  console.log('errors A', a.errs, 'B', b.errs);
  await browser.close(); await browserB.close();
})().catch(async (e) => {
  console.error('FAIL', e.message);
  // Any step can be the slow one in CI: show every studio request from the last 12 s on both sides (time ago, + duration).
  for (const [who, p] of pages) {
    const rows = await p.evaluate(() => { const now = performance.now(); return (window.__net || []).filter((r) => now - r.t0 < 12000).map((r) => `${r.a}@-${Math.round(now - r.t0)}${r.ms == null ? '…' : '+' + r.ms}`).join(' '); }).catch(() => 'n/a');
    console.error(`  ${who} requests:`, rows);
  }
  process.exit(1);
});
