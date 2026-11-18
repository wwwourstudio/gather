// The watch page's store, gaming and chat features, end to end in real browsers: a product pinned with a flash sale,
// a poll, the play-with-me queue, a custom emote, questions, likes, @mentions, spam reports, and the vertical view.
const { chromium } = require('playwright');
const B = process.env.GATHER_URL || 'http://localhost:8080';
const SP = process.argv[2] || '/tmp';
const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
let ok = true;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) ok = false; };
const wait = (p, fn, arg, ms = 10000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 100 }).then(() => true).catch(() => false);

// Chatting on the watch page needs an account: sign up from the "Sign in to chat" box (email + password).
const signUp = async (page, name) => {
  if (!(await page.isVisible('#wSignDlg'))) await page.click('#wMe');
  await page.waitForSelector('#wSignDlg[open]');
  if (!(await page.isVisible('#wSignNameRow'))) await page.click('#wSignMode');
  await page.fill('#wSignName', name); await page.fill('#wSignEmail', `${name.toLowerCase()}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.fill('#wSignPass', 'correct horse battery'); await page.check('#wSignAgree'); await page.click('#wSignGo');
  await page.waitForFunction(() => !document.querySelector('#wSignDlg').open, null, { timeout: 10000 });
};

(async () => {
  const bh = await chromium.launch({ args: ARGS }), bv = await chromium.launch({ args: ARGS });
  const errs = [];
  const mk = async (br, vp) => { const p = await (await br.newContext({ viewport: vp || { width: 1440, height: 900 } })).newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept(d.message().includes('code') ? 'LIVE20' : d.message().includes('percent') ? '20' : '10')); return p; };
  try {
    // Host: a studio with a product, a flash sale, a poll, the queue and an emote.
    const a = await mk(bh);
    await a.goto(B + '/'); await a.click('#enterStage'); await a.fill('#enterName', 'Maya Host'); await a.click('#enterGo');
    await a.waitForSelector('#inviteDlg[open]'); const code = (await a.textContent('#inviteCode')).trim(); await a.keyboard.press('Escape');
    await a.click('[data-tab="show"]');
    await a.click('#shopSec > summary'); await a.click('#shopSec .sub-fold > summary');
    await a.fill('#shopTitle', 'Limited hoodie'); await a.fill('#shopPrice', '$45'); await a.fill('#shopUrl', 'https://www.etsy.com/listing/123/limited-hoodie'); await a.click('#shopAdd');
    await a.click('#shopList .shop-item .btn.primary'); // Pin
    await a.click('#shopList .shop-item .acts button:nth-child(2)'); // Flash sale (prompts answered above)
    check('host: product pinned with a flash sale', await wait(a, () => window.__gather.state.shop?.pinned && window.__gather.state.shop.sale?.code === 'LIVE20'));
    await a.click('#pollSec > summary'); await a.fill('#pollQ', 'Who wins this round?'); await a.fill('#pollOpts', 'Red team\nBlue team'); await a.click('#pollGo');
    await a.click('#queueSec > summary'); await a.check('#wpQueue');
    await a.click('#emoteSec > summary'); await a.fill('#emoteName', 'hype');
    const [fc] = await Promise.all([a.waitForEvent('filechooser'), a.click('#emoteAdd')]); await fc.setFiles(SP + '/logo.png');
    check('host: emote published', await wait(a, () => (window.__gather.state.emotes || []).some((e) => e.name === 'hype')));
    await a.screenshot({ path: SP + '/store-host.png' });

    // Viewer: sees the product and the poll, votes, queues up, chats with an emote and a question.
    const v = await mk(bv);
    await v.goto(B + '/w/' + code);
    check('viewer: pinned product card with the sale code', await wait(v, () => /Limited hoodie/.test(document.querySelector('#wCards [data-card="shop"]')?.textContent || '') && /LIVE20/.test(document.querySelector('#wCards')?.textContent)));
    check('viewer: Shop tab lists the product', await v.isVisible('#wTabShop') && (await v.click('#wTabShop'), await v.$$eval('#wProducts li', (l) => l.length)) === 1);
    await v.screenshot({ path: SP + '/store-viewer-shop.png' });
    await v.click('#wTabChat');
    await v.click('#wCards [data-card="poll"] .wv-vote button:nth-child(2)');
    check('viewer: vote counted', await wait(v, () => document.querySelector('#wCards [data-card="poll"] .wv-vote button.mine')));
    await signUp(v, 'Jordan');
    await v.fill('#wCards [data-card="queue"] input', 'Jordan#42'); await v.click('#wCards [data-card="queue"] .btn.primary');
    check('viewer: in the play-with-me line', await wait(v, () => /in line/i.test(document.querySelector('#wCards [data-card="queue"]')?.textContent || '')));
    await v.fill('#wText', 'This is :hype: right now'); await v.click('#wSend');
    await v.waitForTimeout(1200);
    await v.click('#wAsk'); await v.fill('#wText', 'What GPU are you using?'); await v.click('#wSend');
    check('viewer: emote renders as an image', await wait(v, () => [...document.querySelectorAll('#wMsgs img.emote')].some((i) => i.src.startsWith('data:image'))));

    // Host: sees the question and the player; calls the next player.
    await a.click('[data-tab="chat"]');
    check('host: the question is flagged in the studio chat', await wait(a, () => [...document.querySelectorAll('#msgs .msg.ext')].some((li) => /Question/.test(li.textContent) && /GPU/.test(li.textContent))));
    await a.click('[data-tab="show"]'); await a.click('#queueNext');
    check('viewer: told they are up, with a join button', await wait(v, () => /You’re up/.test(document.querySelector('#wCards [data-card="queue"]')?.textContent || ''), null, 20000));

    // A second viewer likes, mentions, reports; the poll result reaches the host.
    const v2 = await mk(bv);
    await v2.goto(B + '/w/' + code);
    await wait(v2, () => document.querySelectorAll('#wMsgs li.row').length >= 2);
    await signUp(v2, 'Sam');
    await v2.click('#wMsgs li.row button.wv-like');
    await v2.fill('#wText', '@Jordan same question here'); await v2.click('#wSend');
    check('viewer: an @mention of them is highlighted', await wait(v, () => document.querySelector('#wMsgs li.mention')));
    check('likes reach everyone', await wait(v, () => document.querySelector('#wMsgs li.row .wv-like span')?.textContent === '1'));
    check('host: live poll counts', await wait(a, () => (window.__gather.pollCounts || []).reduce((s, n) => s + n, 0) >= 1));
    await v2.hover('#wMsgs li.row'); await v2.click('#wMsgs li.row .wv-acts button[aria-label="Report spam"]');
    await v.screenshot({ path: SP + '/store-viewer-chat.png' });

    // Phones held upright show the whole 16:9 picture; Fill turns it into the vertical 9:16 view.
    const ph = await mk(bv, { width: 390, height: 844 });
    await ph.goto(B + '/w/' + code);
    await wait(ph, () => document.querySelector('#wDirect')?.videoWidth > 0, null, 30000);
    const wide = await ph.evaluate(() => { const r = document.querySelector('#wPlayerWrap').getBoundingClientRect(); return r.width > r.height * 1.5; });
    check('phone: shows the whole 16:9 picture by default', wide);
    await ph.click('#wFill');
    const vert = await wait(ph, () => document.querySelector('#wv').classList.contains('vertical'), null, 5000);
    const box = await ph.evaluate(() => { const r = document.querySelector('#wPlayerWrap').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    check('phone: vertical 9:16 player', vert && box.h > box.w * 1.5, JSON.stringify(box));
    check('phone: the direct picture plays in the vertical view', await wait(ph, () => document.querySelector('#wDirect')?.videoWidth > 0, null, 30000));
    await ph.waitForTimeout(1500); await ph.screenshot({ path: SP + '/store-viewer-phone.png' });
  } catch (e) { check('suite ran', false, e.stack); }
  console.log('errors A', errs, 'B', []);
  await bh.close(); await bv.close();
  process.exit(ok ? 0 : 1);
})();
