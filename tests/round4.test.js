const { chromium } = require('playwright');
const SP = process.argv[2];
const fakeSR = () => {
  // Headless Chromium has no speech service; this stands in so the caption pipeline can be exercised.
  window.SpeechRecognition = class { constructor() { this.lang = 'en-US'; } start() { setTimeout(() => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'Welcome everyone to episode twelve' }], { isFinal: true })] }), 600); } stop() {} };
};
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'] });
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); await c.addInitScript(fakeSR); const p = await c.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/twitch|favicon/.test(m.text()) && p.errs.push(m.text())); return p; };
  const a = await mk();
  const email = `host${Date.now()}@example.com`;
  // 1 account: sign up, profile, settings sync
  await a.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/');
  await a.click('#userBtn'); await a.click('#acTabs [data-ac="up"]');
  await a.fill('#acName', 'Alex Morgan'); await a.fill('#acEmail', email); await a.fill('#acPass', 'correct horse'); await a.check('#acAgree'); await a.click('#acGo');
  await a.waitForFunction(() => window.__acct.user, null, { timeout: 8000 });
  console.log('1 signed up as', await a.evaluate(() => window.__acct.user.name), '| header shows:', await a.textContent('#userLabel'));
  await a.click('#acctDlg .modal-close');
  // settings live inside a studio: change them there (same browser, same account), then leave
  const a0 = await a.context().newPage();
  await a0.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/'); await a0.click('#enterStage'); await a0.fill('#enterName', 'Alex Morgan'); await a0.click('#enterGo');
  await a0.waitForSelector('#inviteDlg[open]'); await a0.keyboard.press('Escape');
  await a0.click('[data-tab="look"]'); await a0.click('.look-seg:visible [data-look="brand"]'); await a0.selectOption('#fontSel', 'playfair'); await a0.click('#bannerStyleSeg [data-bs="glass"]');
  await a0.click('#userBtn'); await a0.click('#settingsTop'); await a0.check('#aiNoiseChk').catch(() => {}); await a0.keyboard.press('Escape');
  await a0.waitForTimeout(2200); await a0.close();
  await a.waitForTimeout(2200);
  const a2 = await mk(); await a2.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/');
  await a2.click('#userBtn'); await a2.click('#acTabs [data-ac="in"]'); await a2.fill('#acEmail', email); await a2.fill('#acPass', 'correct horse'); await a2.click('#acGo');
  await a2.waitForFunction(() => window.__acct.user && JSON.parse(localStorage.getItem('gather:brandPrefs') || '{}').font === 'playfair', null, { timeout: 8000 });
  console.log('  settings followed to a second browser:', await a2.evaluate(() => JSON.stringify({ font: window.__gather.state.brand.font, banner: window.__gather.state.brand.bannerStyle, aiNoise: window.__gather.audioFx.ai })));
  await a2.close();
  // 2 wizard: schedule (email not configured locally -> clear note), thumbnail designed
  await a.click('#heroSchedule'); await a.click('[data-wmode="later"]');
  await a.fill('#wTitle', 'Episode 12: Building in public'); await a.fill('#wInvites', 'jordan@example.com, sam@example.com');
  await a.click('#wNext'); await a.waitForSelector('[data-step="3"]:not([hidden])');
  const ink = await a.evaluate(() => { const c = document.getElementById('wThumb'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4000) if (d[i] + d[i + 1] + d[i + 2] > 600) n++; return n; });
  console.log('2 thumbnail drawn (bright pixels sampled):', ink > 10);
  await a.locator('#wThumb').screenshot({ path: SP + '/r4-thumb.png' });
  await a.click('#wNext'); await a.click('#wDest input[value="youtube"]'); await a.click('#wGo');
  await a.waitForSelector('#wDone:not([hidden])', { timeout: 8000 });
  console.log('  scheduled:', await a.textContent('#wDoneWhen'), '|', await a.textContent('#wDoneMail'));
  await a.click('#wDoneClose');
  await a.waitForFunction(() => document.querySelectorAll('#upList .up-item').length === 1);
  console.log('  upcoming list:', await a.textContent('#upList .up-item b'));
  const code = await a.evaluate(() => window.__gather.streams[0].studio);
  // 3 a guest arrives first at a scheduled studio; the owner takes the host seat on arrival
  const b = await mk();
  await b.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/s/' + code); await b.waitForSelector('#enterDlg[open]'); await b.fill('#enterName', 'Jordan Lee'); await b.click('#enterGo');
  await b.waitForFunction(() => window.__gather.studio, null, { timeout: 8000 });
  console.log('3 early guest is host?', await b.evaluate(() => window.__gather.host === window.__gather.id), '| sees host-only tabs?', await b.isVisible('#liveTop'));
  await a.click('#upList .up-item .btn.primary'); await a.waitForSelector('#enterDlg[open]'); await a.click('#enterGo');
  await a.waitForFunction(() => window.__gather.studio && window.__gather.host === window.__gather.id, null, { timeout: 10000 });
  await b.waitForFunction((id) => window.__gather.host === id, await a.evaluate(() => window.__gather.id), { timeout: 8000 });
  console.log('  owner joined as host; guest sees new host; title:', await b.evaluate(() => window.__gather.state.title));
  await b.waitForFunction(() => [...window.__gather.peers.values()].some((p) => p.conn === 'connected'), null, { timeout: 15000 });
  // 4 brand options reach the guest
  await a.click('[data-tab="look"]'); await a.click('.look-seg:visible [data-look="brand"]');
  await a.selectOption('#fontSel', 'playfair'); await a.click('#frameSeg [data-frame="corners"]'); await a.click('#tagSeg [data-tag="glass"]');
  await a.setInputFiles('#logoFile', SP + '/logo.png');
  await b.waitForFunction(() => { const br = window.__gather.state.brand; return br.frame === 'corners' && br.tag === 'glass' && br.font === 'playfair' && br.logo && window.__gather.assets.get(br.logo)?.img; }, null, { timeout: 8000 });
  console.log('4 brand synced to guest (font, tag, frame, logo):', true);
  await a.click('[data-tab="show"]'); await a.click('[data-showsub="stage"]'); await a.click('#bannerShow');
  // 5 captions
  await a.click('[data-tab="show"]'); await a.click('[data-showsub="stage"]'); await a.click('.toggle-row:has(#capSwitch)');
  await b.waitForFunction(() => [...(window.__gather.state.captions?.on ? [1] : [])].length, null, { timeout: 5000 });
  await a.waitForFunction(() => window.__gather.state.captions.on);
  await a.waitForTimeout(1800);
  const hostId = await a.evaluate(() => window.__gather.id);
  await b.waitForFunction((id) => window.__cap.lines.get(id)?.text?.includes('episode twelve'), hostId, { timeout: 8000 });
  console.log('5 host caption reached the guest:', await b.evaluate((id) => JSON.stringify(window.__cap.lines.get(id)), hostId));
  await a.waitForTimeout(400);
  await a.screenshot({ path: SP + '/r4-host.png' });
  await b.screenshot({ path: SP + '/r4-guest.png' });
  // 6 vertical
  await a.click('#liveTop'); await a.click('#aspectSeg [data-aspect="9:16"]'); await a.keyboard.press('Escape');
  await b.waitForFunction(() => document.getElementById('stageCanvas').height === 1280, null, { timeout: 5000 });
  console.log('6 vertical stage on guest:', await b.evaluate(() => { const c = document.getElementById('stageCanvas'); return c.width + 'x' + c.height; }), '| host scenes:', await a.evaluate(() => [...document.querySelectorAll('#sceneStrip .sc-name')].slice(3, 6).map((n) => n.textContent.replace(/\d$/, '')).join(', ')));
  await a.waitForTimeout(500); await a.screenshot({ path: SP + '/r4-vertical.png' });
  await a.click('#liveTop'); await a.click('#aspectSeg [data-aspect="16:9"]'); await a.keyboard.press('Escape');
  // 7 help search jumps to the setting
  await a.click('#userBtn'); await a.click('#helpTop'); await a.fill('#helpSearch', 'echo');
  console.log('7 help results for "echo":', await a.textContent('#helpResults .help-item b'));
  await a.click('#helpResults .help-item'); await a.waitForTimeout(400);
  console.log('  opened tab:', await a.evaluate(() => window.__gather.tab), '| highlighted:', await a.evaluate(() => !!document.querySelector('.flash')));
  // 8 processing: AI noise removal + green screen + blur
  const fx = await a.evaluate(async () => {
    const out = {};
    out.aiNoise = window.__gather.audioFx.ai;
    return out;
  });
  if (!(await a.isVisible('#settingsDlg'))) { await a.click('#userBtn'); await a.click('#settingsTop'); }
  if (!fx.aiNoise) await a.click('.toggle-row:has(#aiNoiseChk)');
  await a.waitForTimeout(1500);
  console.log('8 AI noise removal running:', await a.evaluate(() => !!window.__gather.local.audioOut));
  await a.click('#bgFxSeg [data-fx="green"]'); await a.waitForTimeout(1200);
  console.log('  green screen track:', await a.evaluate(() => window.__gather.local.cam !== window.__gather.local.camRaw && window.__gather.local.cam?.readyState));
  await a.click('#bgFxSeg [data-fx="blur"]'); await a.waitForTimeout(5000);
  console.log('  blur (AI segmentation) track:', await a.evaluate(() => window.__gather.local.cam !== window.__gather.local.camRaw && window.__gather.local.cam?.readyState));
  await a.screenshot({ path: SP + '/r4-blur.png' });
  await a.click('#bgFxSeg [data-fx="none"]'); await a.waitForTimeout(300);
  console.log('  back to raw camera:', await a.evaluate(() => window.__gather.local.cam === window.__gather.local.camRaw));
  console.log('errors A', a.errs, 'B', b.errs);
  await browser.close();
})().catch((e) => { console.error('FAIL', e.message.split('\n').slice(0, 3).join(' | ')); process.exit(1); });
