// Fake Twitch IRC server inside the page: verifies login handshake, PING/PONG, and message parsing.
const { chromium } = require('playwright');
const SP = process.argv[2];
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const p = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(() => {
    window.__sent = [];
    const Real = window.WebSocket;
    window.WebSocket = class extends EventTarget {
      constructor(url) {
        super(); this.url = url; this.readyState = 0;
        if (!url.includes('twitch')) return new Real(url);
        setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 20);
      }
      send(line) {
        window.__sent.push(line);
        const emit = (data) => setTimeout(() => this.onmessage && this.onmessage({ data }), 10);
        if (line.startsWith('JOIN')) {
          emit(':tmi.twitch.tv 366 justinfan :End of /NAMES list\r\n@room-id=1 :tmi.twitch.tv ROOMSTATE #somechannel\r\n');
          emit('PING :tmi.twitch.tv\r\n');
          emit('@badge-info=;color=#FF4500;display-name=PixelPete;id=abc-1;tmi-sent-ts=' + Date.now() + ' :pixelpete!pixelpete@pixelpete.tmi.twitch.tv PRIVMSG #somechannel :This studio looks clean. What mic is that?\r\n');
          emit('@color=;display-name=night\\sowl;id=abc-2;tmi-sent-ts=' + Date.now() + ' :nightowl!nightowl@nightowl.tmi.twitch.tv PRIVMSG #somechannel :\u0001ACTION waves from Lisbon\u0001\r\n');
        }
      }
      close() { this.readyState = 3; }
    };
  });
  await p.goto((process.env.GATHER_URL || 'http://localhost:8080') + '/'); await p.click('#enterStage'); await p.fill('#enterName', 'Alex Morgan'); await p.click('#enterGo');
  await p.waitForSelector('#inviteDlg[open]'); await p.click('#inviteDlg .modal-close');
  await p.click('#settingsTop'); await p.fill('#twitchInput', 'SomeChannel'); await p.click('#twitchGo'); await p.keyboard.press('Escape'); await p.click('[data-tab="show"]');
  await p.waitForFunction(() => window.__gather.feed.length >= 2, null, { timeout: 5000 });
  console.log('handshake:', await p.evaluate(() => window.__sent.join(' | ')));
  console.log('feed:', JSON.stringify(await p.evaluate(() => window.__gather.feed.map(m => [m.src, m.name, m.color, m.text]))));
  console.log('status:', await p.textContent('#twitchStatus'));
  await p.click('.toggle-row:has(#overlaySwitch)'); await p.click('[data-tab="chat"]');
  await p.hover('#msgs .msg.ext >> nth=0'); await p.click('#msgs .msg.ext >> nth=0 >> .feat');
  await p.waitForTimeout(700);
  console.log('featured:', await p.evaluate(() => JSON.stringify(window.__gather.state.featured)));
  console.log('chat panel horizontal overflow:', await p.evaluate(() => { const b = document.querySelector('.chat-body'); return b.scrollWidth - b.clientWidth; }));
  await p.screenshot({ path: SP + '/twitch.png' });
  console.log('errors', errs);
  await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
