const { chromium } = require('playwright');
const SP = process.argv[2];
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const p = await c.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message)); p.on('console', m => m.type() === 'error' && p.errs.push(m.text())); return p; };
  const a = await mk(), b = await mk();
  await a.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/'); await a.click('#enterStage'); await a.fill('#enterName', 'Alex Morgan'); await a.click('#enterGo');
  await a.waitForSelector('#inviteDlg[open]'); const code = await a.textContent('#inviteCode'); await a.click('#inviteDlg .modal-close');
  await b.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/s/' + code); await b.waitForSelector('#enterDlg[open]'); await b.fill('#enterName', 'Jordan Lee'); await b.click('#enterGo');
  await b.waitForFunction(() => [...window.__gather.peers.values()].some(p => p.conn === 'connected'), null, { timeout: 15000 });
  // 1. template
  await a.click('[data-tab="layouts"]'); await a.click('.tpl:has-text("Chat-led show")');
  await b.waitForFunction(() => window.__gather.state.layout === 'custom' && window.__gather.state.scene === 'p-chat' && window.__gather.state.elements.some(e => e.type === 'chat'), null, { timeout: 5000 });
  console.log('template synced to guest:', await b.evaluate(() => window.__gather.state.elements.map(e => e.type).join(',')));
  // 2. text element + edit
  await a.click('[data-add="text"]'); await a.fill('#elProps textarea', 'Episode 12: Building in public');
  await b.waitForFunction(() => window.__gather.state.elements.some(e => e.type === 'text' && e.text === 'Episode 12: Building in public'), null, { timeout: 5000 });
  console.log('text edit synced');
  // 3. image upload
  await a.click('[data-add="image"]'); await a.setInputFiles('#elProps input[data-upload]', SP + '/logo.png');
  await a.waitForFunction(() => window.__gather.state.elements.some(e => e.type === 'image' && e.asset && !e.asset.startsWith('local-')), null, { timeout: 8000 });
  await b.waitForFunction(() => { const e = window.__gather.state.elements.find(e => e.type === 'image'); return e && window.__gather.assets.get(e.asset)?.img; }, null, { timeout: 8000 });
  console.log('image uploaded and loaded by guest');
  // 4. drag the image box
  const before = await b.evaluate(() => { const e = window.__gather.state.elements.find(e => e.type === 'image'); return [e.x, e.y]; });
  const box = await a.locator('.ebox.sel').boundingBox();
  await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await a.mouse.down(); await a.keyboard.down("Alt"); await a.mouse.move(box.x - 300, box.y + 120, { steps: 8 }); await a.mouse.up(); await a.keyboard.up("Alt");
  await b.waitForFunction(([x]) => { const e = window.__gather.state.elements.find(e => e.type === 'image'); return Math.abs(e.x - x) > 0.05; }, before, { timeout: 5000 });
  console.log('drag synced:', before, '->', await b.evaluate(() => { const e = window.__gather.state.elements.find(e => e.type === 'image'); return [+e.x.toFixed(3), +e.y.toFixed(3)]; }));
  // 5. countdown timer
  await a.click('[data-add="timer"]'); await a.selectOption('#elProps select[data-k="mode"]', 'countdown'); await a.click('#elProps [data-count="5"]');
  await b.waitForFunction(() => window.__gather.state.elements.some(e => e.type === 'timer' && e.mode === 'countdown' && e.target > Date.now()), null, { timeout: 5000 });
  console.log('countdown synced');
  // 6. chat -> feature on stage
  await a.click('[data-add]'); // no-op guard
  await a.click('#editToggle'); // done editing
  await b.fill('#chatInput', 'Can you explain how the relay keeps it free?'); await b.press('#chatInput', 'Enter');
  await a.click('[data-tab="chat"]');
  await a.waitForSelector('#msgs li[data-src="studio"]:not(.me) .feat', { state: 'attached' });
  await a.hover('#msgs li[data-src="studio"]:not(.me)'); await a.click('#msgs li[data-src="studio"]:not(.me) .feat');
  await b.waitForFunction(() => window.__gather.state.featured?.text?.includes('relay'), null, { timeout: 5000 });
  console.log('featured message synced; feed length on guest:', await b.evaluate(() => window.__gather.feed.length));
  // 7. twitch connect attempt (network may block)
  await a.click('[data-tab="stream"]'); await a.fill('#twitchInput', 'https://twitch.tv/SomeChannel'); await a.click('#twitchGo');
  await b.waitForFunction(() => window.__gather.state.feeds.twitch === 'somechannel', null, { timeout: 5000 });
  await a.waitForTimeout(2500);
  console.log('twitch channel synced; host status:', await a.textContent('#twitchStatus'));
  // guest permissions
  console.log('guest add buttons disabled:', await b.isDisabled('[data-add="text"]'), '| guest edit layer hidden:', await b.isHidden('#editLayer'));
  await a.waitForTimeout(800);
  await a.screenshot({ path: SP + '/f-host.png' });
  console.log('guest sees host-only controls:', JSON.stringify({ layouts: await b.isVisible('[data-tab="layouts"]'), stream: await b.isVisible('[data-tab="stream"]'), brand: await b.isVisible('[data-tab="brand"]'), scenes: await b.isVisible('#sceneStrip'), record: await b.isVisible('#recBtn'), chat: await b.isVisible('[data-tab="chat"]'), settings: await b.isVisible('[data-tab="settings"]') })); await b.screenshot({ path: SP + '/f-guest.png' });
  // edit mode screenshot
  await a.click('[data-tab="layouts"]'); await a.click('#editToggle'); await a.waitForTimeout(300); await a.screenshot({ path: SP + '/f-edit.png' });
  console.log('errors A', a.errs, 'B', b.errs);
  await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
