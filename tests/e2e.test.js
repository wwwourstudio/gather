const { chromium } = require('playwright');
const SP = process.argv[2];
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['camera', 'microphone'] }); const p = await c.newPage(); const errs=[]; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type()==='error' && errs.push(m.text())); p.errs=errs; return p; };
  const a = await mk(), b = await mk();
  await a.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/');
  await a.waitForTimeout(800);
  await a.screenshot({ path: SP + '/01-offline.png' });
  await a.click('#enterStage');
  await a.fill('#enterName', 'Alex Morgan');
  await a.waitForTimeout(1200);
  await a.screenshot({ path: SP + '/02-greenroom.png' });
  await a.click('#enterGo');
  await a.waitForSelector('#inviteDlg[open]', { timeout: 5000 });
  const code = await a.textContent('#inviteCode');
  console.log('code', code);
  await a.screenshot({ path: SP + '/03-invite.png' });
  await a.click('#inviteDlg .modal-close');
  await b.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/s/' + code);
  await b.waitForSelector('#enterDlg[open]');
  await b.fill('#enterName', 'Jordan Lee');
  await b.click('#enterGo');
  await b.waitForFunction(() => [...window.__gather.peers.values()].some(p => p.conn === 'connected'), null, { timeout: 15000 });
  await a.waitForFunction(() => [...window.__gather.peers.values()].some(p => p.conn === 'connected'), null, { timeout: 15000 });
  console.log('peers connected');
  await a.fill('#chatInput', 'Hey Jordan, welcome in! https://example.com'); await a.press('#chatInput', 'Enter');
  await b.waitForSelector('.msg .txt >> text=welcome in');
  await b.fill('#chatInput', 'Great to be here.'); await b.press('#chatInput', 'Enter');
  await a.waitForSelector('.msg.me');
  console.log('chat ok');
  // banner from host
  await a.click('[data-tab="banners"]');
  await a.fill('#bannerSub', 'Episode 12 · Live from the studio');
  await a.click('#bannerShow');
  await b.waitForFunction(() => window.__gather.state.banner?.text === 'Welcome to the conversation');
  console.log('banner synced');
  // guest cannot change layout
  console.log('guest layout disabled', await b.isDisabled('#sceneStrip .scene >> nth=0'));
  await a.waitForTimeout(2500);
  await a.screenshot({ path: SP + '/04-host-live.png' });
  await b.screenshot({ path: SP + '/05-guest.png' });
  // record 3s
  await a.click('#recBtn'); await a.waitForTimeout(3000); await a.click('#recBtn');
  await a.waitForSelector('#recDlg[open]', { timeout: 8000 });
  console.log('rec', await a.textContent('#recInfo'));
  await a.screenshot({ path: SP + '/06-rec.png' });
  await a.click('#recDlg .modal-close');
  // spotlight + brand
  await a.click('#sceneStrip .scene:has-text("Spotlight")'); await a.click('[data-tab="brand"]'); await a.click('#swatches [data-color="#e8794a"]'); await a.click('#bgs [data-bg="ember"]');
  await a.click('[data-tab="banners"]'); await a.fill('#tickerText', 'Ask your questions in the chat · New episodes every Thursday'); await a.click('#tickerShow');
  await a.waitForTimeout(1500);
  await b.screenshot({ path: SP + '/07-guest-brand.png' });
  // mobile
  const m = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })).newPage();
  await m.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/'); await m.waitForTimeout(800);
  console.log('mobile overflow', await m.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  await m.screenshot({ path: SP + '/08-mobile.png', fullPage: true });
  // leave -> host transfer
  await a.click('#leaveBtn');
  await b.waitForFunction(() => window.__gather.host === window.__gather.id, null, { timeout: 5000 });
  console.log('host transferred');
  console.log('errors A', a.errs, 'B', b.errs);
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
