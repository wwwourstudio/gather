const { chromium } = require('playwright');
const SP = process.argv[2];
const fakeTwitch = () => {
  const Real = window.WebSocket;
  window.WebSocket = class extends EventTarget {
    constructor(url) { super(); if (!url.includes('twitch')) return new Real(url); setTimeout(() => this.onopen && this.onopen(), 20); }
    send(line) {
      const emit = (d, ms = 10) => setTimeout(() => this.onmessage && this.onmessage({ data: d }), ms);
      if (!line.startsWith('JOIN')) return;
      emit(':tmi.twitch.tv 366 justinfan :End\r\n');
      const msg = (id, name, color, text) => `@color=${color};display-name=${name};id=${id};tmi-sent-ts=${Date.now()} :${name.toLowerCase()}!x@x.tmi.twitch.tv PRIVMSG #somechannel :${text}\r\n`;
      emit(msg('t1', 'PixelPete', '#FF4500', 'This studio looks clean. What mic is that?'), 30);
      emit(msg('t2', 'SpamBot', '#00FF00', 'FREE FOLLOWERS at spam dot site'), 60);
      emit(msg('t3', 'NightOwl', '#1E90FF', 'Greetings from Lisbon'), 90);
      emit(msg('t4', 'SpamBot', '#00FF00', 'second spam message'), 2500);
    }
    close() {}
  };
};
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); await c.addInitScript(fakeTwitch); const p = await c.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message)); return p; };
  const a = await mk(), b = await mk();
  await a.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/'); await a.click('#enterStage'); await a.fill('#enterName', 'Alex Morgan'); await a.click('#enterGo');
  await a.waitForSelector('#inviteDlg[open]'); const code = await a.textContent('#inviteCode'); await a.click('#inviteDlg .modal-close');
  await b.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/s/' + code); await b.waitForSelector('#enterDlg[open]'); await b.fill('#enterName', 'Jordan Lee'); await b.click('#enterGo');
  await b.waitForFunction(() => window.__gather.studio, null, { timeout: 10000 });
  await a.click('#settingsTop'); await a.fill('#twitchInput', 'somechannel'); await a.click('#twitchGo'); await a.keyboard.press('Escape'); await a.click('[data-tab="show"]');
  await b.waitForFunction(() => window.__gather.feed.length >= 3, null, { timeout: 8000 });
  console.log('guest feed:', await b.evaluate(() => window.__gather.feed.map(m => m.name).join(', ')));
  // overlay switch
  await a.click('.toggle-row:has(#overlaySwitch)'); await a.click('[data-tab="chat"]'); await b.waitForFunction(() => window.__gather.state.elements.some(e => e.type === 'chat'), null, { timeout: 5000 });
  console.log('overlay on for guest:', true, '| hint:', await a.textContent('#overlayHint'));
  // guest can't see actions
  console.log('guest sees mod buttons:', await b.evaluate(() => document.getElementById('msgs').classList.contains('is-host')));
  // block SpamBot, timeout PixelPete 5 min
  const row = (name) => `#msgs li[data-user="${name}"] >> nth=0`;
  await a.hover(row('spambot')); await a.click(row('spambot') + ' >> .mod-block');
  await a.hover(row('pixelpete')); await a.click(row('pixelpete') + ' >> button:has-text("Time out")'); await a.click('.popover:popover-open >> text=5 minutes');
  await b.waitForFunction(() => window.__gather.state.mod.blocked.length === 1 && window.__gather.state.mod.timeouts.length === 1, null, { timeout: 5000 });
  await b.waitForTimeout(2600); // SpamBot posts again after being blocked
  const vis = async (p) => p.evaluate(() => [...document.querySelectorAll('#msgs li[data-fid]')].filter(li => getComputedStyle(li).display !== 'none').map(li => li.dataset.user));
  console.log('guest sees (visible):', await vis(b));
  console.log('host sees (dimmed+reason):', await a.evaluate(() => [...document.querySelectorAll('#msgs li.modded')].map(li => li.dataset.user + ':' + li.dataset.why)));
  console.log('overlay draws only:', await b.evaluate(() => window.__gather.feed.filter(m => { const s = window.__gather.state.mod, u = m.name.toLowerCase(); return !s.blocked.some(x => x.user === u) && !s.timeouts.some(x => x.user === u && x.until > Date.now()) && !s.hidden.includes(m.id); }).map(m => m.name)));
  // hide a guest studio message, then restore PixelPete
  await b.fill('#chatInput', 'off-topic message from the guest'); await b.press('#chatInput', 'Enter');
  await a.waitForSelector('#msgs li[data-src="studio"]'); await a.hover('#msgs li[data-src="studio"]'); await a.click('#msgs li[data-src="studio"] >> .mod-hide');
  await a.hover(row('pixelpete')); await a.click(row('pixelpete') + ' >> .mod-restore');
  await b.waitForFunction(() => window.__gather.state.mod.timeouts.length === 0 && window.__gather.state.mod.hidden.length === 1, null, { timeout: 5000 });
  console.log('after hide-guest-msg + restore PixelPete, guest sees:', await vis(b));
  await a.waitForTimeout(600);
  await a.screenshot({ path: SP + '/mod-host.png' });
  await b.screenshot({ path: SP + '/mod-guest.png' });
  console.log('errors', a.errs, b.errs);
  await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
