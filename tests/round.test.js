const { chromium } = require('playwright');
const SP = process.argv[2];
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const p = await c.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message)); p.on('console', m => m.type() === 'error' && !/twitch/.test(m.text()) && p.errs.push(m.text())); return p; };
  const a = await mk(), b = await mk();
  // host: profile photo in the green room
  await a.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/'); await a.click('#enterStage'); await a.fill('#enterName', 'Alex Morgan');
  await a.setInputFiles('#avatarFile', SP + '/logo.png');
  await a.waitForFunction(() => !document.getElementById('avatarImg').hidden);
  await a.screenshot({ path: SP + '/r-greenroom.png' });
  await a.click('#enterGo'); await a.waitForSelector('#inviteDlg[open]'); const code = await a.textContent('#inviteCode'); await a.click('#inviteDlg .modal-close');
  await b.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/s/' + code); await b.waitForSelector('#enterDlg[open]'); await b.fill('#enterName', 'Jordan Lee'); await b.click('#enterGo');
  await b.waitForFunction(() => [...window.__gather.peers.values()].some(p => p.conn === 'connected'), null, { timeout: 15000 });
  await b.waitForFunction(() => { const p = [...window.__gather.peers.values()][0]; return p.avatar && window.__gather.assets.get(p.avatar)?.img; }, null, { timeout: 8000 });
  console.log('1 guest received host profile photo');
  // PDF presentation over the third track
  await a.click('#shareBtn'); await a.click('[data-present="pdf"]');
  await a.setInputFiles('#pdfFile', SP + '/deck.pdf');
  await a.waitForFunction(() => window.__gather.local.pres?.kind === 'pdf', null, { timeout: 10000 });
  await b.waitForFunction(() => window.__gather.state.scene === 'present-full' && window.__gather.state.elements.some(e => e.type === 'media'), null, { timeout: 5000 });
  const hostId = await a.evaluate(() => window.__gather.id);
  await b.waitForFunction((id) => { const v = document.getElementById('pres-' + id); return v && v.videoWidth > 0; }, hostId, { timeout: 15000 });
  console.log('2 guest sees host slides over the presentation track:', await b.evaluate((id) => { const v = document.getElementById('pres-' + id); return v.videoWidth + 'x' + v.videoHeight; }, hostId));
  console.log('  host camera still sent:', await b.evaluate(() => { const p = [...window.__gather.peers.values()][0]; return p.stream.getVideoTracks().length === 1; }));
  await a.click('#presNext'); await a.waitForFunction(() => window.__gather.local.pres.page === 2);
  console.log('  slide controls:', await a.textContent('#presPage'));
  await a.waitForTimeout(800);
  await b.screenshot({ path: SP + '/r-guest-slides.png' });
  // AI window (provider call mocked)
  const nd = (evs) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await a.route('**/api/ai', (r) => r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: nd([{ t: 'text', d: 'The 1966 World Cup final ended **4–2** to England after extra time.' }, { t: 'text', d: '\n\n- Geoff Hurst scored a hat-trick\n- Played at Wembley' }, { t: 'done' }]) }));
  await a.evaluate(() => localStorage.setItem('gather:aiVoice', '"off"'));
  await a.click('[data-tab="ai"]');
  await a.fill('#aiKey', 'sk-ant-test-key-for-ui'); await a.press('#aiKey', 'Tab'); await a.click('#aiSetupDone');
  await a.fill('#aiInput', 'Who won the 1966 World Cup final and what was the score?'); await a.press('#aiInput', 'Enter');
  await b.waitForFunction(() => window.__gather.ai.items.some(i => i.role === 'assistant' && i.done && i.text.includes('Hurst')), null, { timeout: 8000 });
  const scene0 = await b.evaluate(() => window.__gather.state.scene);
  await a.click('.ai-msg.assistant [data-stage]');
  await b.waitForFunction(() => window.__gather.state.elements.some(e => e.type === 'ai'), null, { timeout: 5000 });
  const sceneKept = (await b.evaluate(() => window.__gather.state.scene)) === scene0;
  console.log('3 AI answer synced to guest and put on stage without changing the scene:', sceneKept, '| button now:', await a.textContent('.ai-msg.assistant [data-stage]'));
  if (!sceneKept) console.log('FAIL showing an answer changed the scene');
  await a.waitForTimeout(600);
  await a.screenshot({ path: SP + '/r-host-ai.png' });
  // support card
  await a.click('[data-tab="brand"]');
  await a.fill('.tip-row:has-text("PayPal") input', 'gathershow'); await a.click('.tip-row:has-text("PayPal") button');
  await b.waitForFunction(() => window.__gather.state.elements.some(e => e.type === 'tip' && e.url === 'https://paypal.me/gathershow'), null, { timeout: 5000 });
  console.log('4 PayPal QR card synced:', true);
  // scenes strip
  await a.click('#sceneStrip .scene:has-text("Interview panel")');
  await b.waitForFunction(() => window.__gather.state.scene === 'p-interview', null, { timeout: 5000 });
  console.log('5 scene switch synced; guest scene chips disabled:', await b.isDisabled('#sceneStrip .scene >> nth=0'));
  await a.keyboard.press('Escape'); await a.click('body', { position: { x: 5, y: 5 } }).catch(() => {});
  await a.evaluate(() => document.activeElement.blur()); await a.keyboard.press('1');
  await b.waitForFunction(() => window.__gather.state.layout === 'solo', null, { timeout: 5000 });
  console.log('  number key 1 -> Solo');
  // stop presenting -> previous scene restored
  await a.click('#sceneStrip .scene:has-text("Slides + speaker")');
  await a.click('#presStop');
  await b.waitForFunction(() => !window.__gather.state.presenter, null, { timeout: 5000 });
  console.log('6 stop presenting synced; guest presenter cleared');
  await a.click('[data-tab="chat"]');
  await a.waitForTimeout(500);
  await a.screenshot({ path: SP + '/r-host-dark.png' });
  await a.evaluate(() => document.querySelector('[data-theme-opt="light"]').click());
  await a.waitForTimeout(400);
  await a.screenshot({ path: SP + '/r-host-light.png' });
  await a.evaluate(() => document.querySelector('[data-theme-opt="dark"]').click());
  const m = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await m.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/'); await m.waitForTimeout(600);
  console.log('7 mobile overflow:', await m.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  await m.screenshot({ path: SP + '/r-mobile.png' });
  console.log('errors A', a.errs, 'B', b.errs);
  await browser.close();
})().catch(e => { console.error('FAIL', e.message.split('\n').slice(0, 4).join(' | ')); process.exit(1); });
