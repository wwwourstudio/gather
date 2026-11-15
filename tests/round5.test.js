const { chromium } = require('playwright');
const fs = require('fs');
const SP = process.argv[2];
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const p = await c.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message)); p.on('console', m => m.type() === 'error' && !/twitch|favicon|423|403/.test(m.text()) && p.errs.push(m.text())); return p; };
  const a = await mk(), b = await mk(), c = await mk();
  await a.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/'); await a.click('#enterStage'); await a.fill('#enterName', 'Alex Morgan');
  await a.click('#grFx [data-fx="blur"]');
  console.log('0 green room quick background chip:', await a.evaluate(() => window.__gather.videoFx.effect));
  await a.screenshot({ path: SP + '/r5-greenroom.png' });
  await a.click('#grFx [data-fx="none"]');
  await a.click('#enterGo'); await a.waitForSelector('#inviteDlg[open]'); const code = await a.textContent('#inviteCode'); await a.click('#inviteDlg .modal-close');
  // guest with a camera-off background
  await b.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/s/' + code); await b.waitForSelector('#enterDlg[open]'); await b.fill('#enterName', 'Jordan Lee'); await b.click('#enterGo');
  await b.waitForFunction(() => [...window.__gather.peers.values()].some(p => p.conn === 'connected'), null, { timeout: 15000 });
  await b.click('#settingsTop'); await b.setInputFiles('#offBgFile', SP + '/logo.png');
  await a.waitForFunction(() => { const p = [...window.__gather.peers.values()][0]; return p.offbg && window.__gather.assets.get(p.offbg)?.img; }, null, { timeout: 10000 });
  console.log('1 guest camera-off background reached host; stored in IndexedDB, not localStorage:', await b.evaluate(() => localStorage.getItem('gather:offBg') === null));
  // 2 drop a PDF on the stage
  const buf = fs.readFileSync(SP + '/deck.pdf');
  const dt = await a.evaluateHandle((bytes) => { const d = new DataTransfer(); d.items.add(new File([new Uint8Array(bytes)], 'deck.pdf', { type: 'application/pdf' })); return d; }, [...buf]);
  await a.dispatchEvent('#stage', 'dragenter', { dataTransfer: dt });
  console.log('2 drop hint shows:', await a.evaluate(() => document.getElementById('stage').classList.contains('dropping')));
  await a.dispatchEvent('#stage', 'drop', { dataTransfer: dt });
  await a.waitForFunction(() => window.__gather.local.pres?.kind === 'pdf', null, { timeout: 10000 });
  await b.waitForFunction(() => window.__gather.state.scene === 'present-full', null, { timeout: 6000 });
  const media = await b.evaluate(() => window.__gather.state.elements.find(e => e.type === 'media'));
  console.log('  full-bleed slides on guest:', media.x === 0 && media.w === 1 && media.h === 1, '| host sees on-stage controls:', await a.isVisible('#presBar'), '| guest does not:', !(await b.isVisible('#presBar')));
  await a.waitForTimeout(800); await a.screenshot({ path: SP + '/r5-present.png' });
  await a.click('#presStop');
  // 3 deck
  await a.mouse.move(600, 300);
  await a.mouse.wheel(0, 120); await a.waitForTimeout(600);
  console.log('3 wheel swaps deck to:', await a.evaluate(() => window.__gather.deck), '| page did not scroll:', await a.evaluate(() => document.querySelector('.studio').scrollTop === 0));
  await a.screenshot({ path: SP + '/r5-people.png' });
  // 4 mute + lock + knock + admit
  await a.hover('#crewList .crew-card:nth-child(2)'); await a.click('#crewList .crew-card:nth-child(2) .ct-mute');
  await b.waitForFunction(() => !window.__gather.local.micOn, null, { timeout: 6000 });
  console.log('4 host muted guest:', true);
  await a.click('#lockWrap'); await b.waitForFunction(() => window.__gather.state.locked, null, { timeout: 5000 });
  await c.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/c/' + code); await c.waitForSelector('#enterDlg[open]'); await c.fill('#enterName', 'Caller Casey'); await c.click('#enterGo');
  await c.waitForSelector('#knockWait:not([hidden])', { timeout: 6000 });
  await a.waitForFunction(() => window.__gather.lobby.length === 1, null, { timeout: 8000 });
  console.log('  caller waits; host sees waiting:', await a.textContent('#lobbyList .lobby-info b'), '| deck:', await a.evaluate(() => window.__gather.deck));
  await c.screenshot({ path: SP + '/r5-knock.png' });
  await a.click('#lobbyList .btn.primary');
  await c.waitForFunction(() => !!window.__gather?.studio, null, { timeout: 10000 });
  console.log('  admitted caller joined:', await c.evaluate(() => window.__gather.studio === location.pathname.split('/')[2]));
  // 5 remove the caller
  await a.waitForFunction(() => window.__gather.peers.size === 2, null, { timeout: 10000 });
  const cid = await c.evaluate(() => window.__gather.id);
  await a.evaluate((id) => { const btn = document.querySelector(`#card-${id} .ct-kick`); btn.click(); btn.click(); }, cid);
  await c.waitForFunction(() => !window.__gather.studio, null, { timeout: 10000 });
  console.log('5 removed caller is out:', true, '| host peers:', await a.evaluate(() => window.__gather.peers.size));
  // the same browser can't walk back in through the link
  const back = await c.evaluate(async (code) => { const r = await fetch('/api/studio?action=join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studio: code, name: 'Caller again', dev: JSON.parse(localStorage.getItem('gather:dev')) }) }); return r.status; }, await a.evaluate(() => window.__gather.studio));
  console.log('  removed caller rejoining with the link:', back);
  if (back !== 403) console.log('FAIL a removed person got back in');
  // 6 call-in card + sponsors + glass panel
  await a.click('[data-tab="show"]'); await a.click('#callinCard');
  await a.click('[data-tab="look"]'); await a.click('.look-seg:visible [data-look="brand"]'); await a.setInputFiles('#adFile', SP + '/logo.png');
  await b.waitForFunction(() => window.__gather.state.ads.on && window.__gather.state.ads.items.length === 1 && window.__gather.state.elements.some(e => e.type === 'callin' && e.url.includes('/c/')), null, { timeout: 8000 });
  await a.click('#panelSeg [data-panel="solid"]'); await b.waitForFunction(() => window.__gather.state.brand.panel === 'solid', null, { timeout: 5000 });
  console.log('6 call-in card, sponsor ad and solid panels synced');
  // 7 AI producer (provider mocked)
  await a.click('[data-tab="ai"]'); await a.fill('#aiKey', 'sk-test'); await a.fill('#aiName', 'Sam');
  const nd = (evs) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await a.route('**/api/ai', (r) => r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: nd([{ t: 'text', d: 'Switching to Solo and pulling up the dog video.' }, { t: 'action', a: { type: 'scene', name: 'Solo' } }, { t: 'action', a: { type: 'banner', text: 'Dogs running', sub: 'via YouTube' } }, { t: 'action', a: { type: 'open', url: 'https://www.youtube.com/results?search_query=dog+running', label: 'Dog running' } }, { t: 'done' }]) }));
  await a.evaluate(() => localStorage.setItem('gather:aiVoice', '"off"'));
  console.log('  AI hidden from the stage until asked for:', await a.isHidden('#cmdBar'));
  await a.click('#aiDock'); await a.fill('#cmdInput', 'switch to solo and pull up the dog running video'); await a.press('#cmdInput', 'Enter');
  await b.waitForFunction(() => window.__gather.state.layout === 'solo' && window.__gather.state.banner?.text === 'Dogs running', null, { timeout: 8000 });
  console.log('7 Sam switched scene + banner on guest; offers to open:', await a.textContent('#cmdShow'));
  await a.waitForTimeout(500); await a.screenshot({ path: SP + '/r5-sam.png' });
  console.log('errors A', a.errs, 'B', b.errs, 'C', c.errs);
  await browser.close();
})().catch(e => { console.log('FAIL', e.message.split('\n').slice(0, 4).join(' | ')); process.exit(1); });
