// The public watch page: direct WebRTC viewing, live chat, reactions, super chats paid straight to the host
// (a claim until the host confirms), and the rules around them. API checks first, then one full browser run.
const { chromium } = require('playwright');
const B = process.env.GATHER_URL || 'http://localhost:8080';
// Chatting on the watch page needs an account: sign up from the "Sign in to chat" box (email + password).
const signUp = async (page, name) => {
  if (!(await page.isVisible('#wSignDlg'))) await page.click('#wMe');
  await page.waitForSelector('#wSignDlg[open]');
  if (!(await page.isVisible('#wSignNameRow'))) await page.click('#wSignMode');
  await page.fill('#wSignName', name); await page.fill('#wSignEmail', `${name.toLowerCase()}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.fill('#wSignPass', 'correct horse battery'); await page.check('#wSignAgree'); await page.click('#wSignGo');
  await page.waitForFunction(() => !document.querySelector('#wSignDlg').open, null, { timeout: 10000 });
};

const post = (a, b) => fetch(`${B}/api/studio?action=${a}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const feed = (code) => fetch(`${B}/api/studio?action=wfeed&studio=${code}`).then(async (r) => ({ cache: r.headers.get('cache-control') || '', ...(await r.json()) }));
let ok = true;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) ok = false; };

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errs = [];
  const mk = async (vp) => { const p = await (await browser.newContext({ viewport: vp || { width: 1440, height: 900 } })).newPage(); p.on('pageerror', (e) => errs.push(e.message)); return p; };
  try {
    // ---- API rules, against a studio opened over the API
    const code = 'gather-watchtest01', dev = 'e'.repeat(24);
    const h = await post('join', { studio: code, dev, name: 'Host', intent: 'create' });
    const setW = (watch) => post('send', { studio: code, id: h.id, tok: h.tok, ops: [{ type: 'state', state: { watch } }] });
    await setW({ chat: true, supers: true, min: 5, pay: { venmo: 'host-name', paypal: 'bad handle!', stripe: 'https://evil.example/pay' } });
    const f0 = await feed(code);
    check('the feed is one cached GET for every viewer', /s-maxage=2/.test(f0.cache) || !process.env.VERCEL, f0.cache);
    check('payment handles are checked: bad PayPal and non-Stripe links are dropped', f0.watch.pay.venmo === 'host-name' && !f0.watch.pay.paypal && !f0.watch.pay.stripe, JSON.stringify(f0.watch.pay));
    check('reserved names are refused', (await post('whello', { studio: code, name: 'Host' })).status === 400);
    const v = await post('whello', { studio: code, name: 'Viewer 1' });
    const v2 = await post('whello', { studio: code, vid: v.vid, vtok: v.vtok, name: 'Jordan' });
    check('renaming keeps the same viewer session (the video stays connected)', v2.vid === v.vid && v2.name === 'Jordan');
    const c1 = await post('wsend', { studio: code, vid: v.vid, vtok: v.vtok, type: 'chat', text: 'hello <b>there</b>' });
    const c2 = await post('wsend', { studio: code, vid: v.vid, vtok: v.vtok, type: 'chat', text: 'again' });
    check('chat works and is rate limited', !!c1.id && c2.status === 429, `${c2.status}`);
    const forged = await post('wsend', { studio: code, vid: v.vid, vtok: 'nope', type: 'chat', text: 'x' });
    check('a forged viewer token is refused', forged.status === 401);
    await new Promise((r) => setTimeout(r, 1100));
    const low = await post('wsend', { studio: code, vid: v.vid, vtok: v.vtok, type: 'super', amount: 2, method: 'venmo', text: 'hi' });
    check('super chats below the host’s minimum are refused', low.status === 400 && /\$5/.test(low.error || ''), low.error);
    await new Promise((r) => setTimeout(r, 1100));
    const noMethod = await post('wsend', { studio: code, vid: v.vid, vtok: v.vtok, type: 'super', amount: 10, method: 'paypal', text: 'hi' });
    check('a payment method the host didn’t set up is refused', noMethod.status === 400);
    await new Promise((r) => setTimeout(r, 1100));
    const sc = await post('wsend', { studio: code, vid: v.vid, vtok: v.vtok, type: 'super', amount: 10, method: 'venmo', text: 'Great show' });
    const f1 = await feed(code);
    check('an unconfirmed super chat is not public', !!sc.id && !f1.chat.some((m) => m.paid), JSON.stringify(sc) + ' ' + JSON.stringify(f1.chat.map((m) => m.text)));
    const guest = await post('join', { studio: code, dev: 'f'.repeat(24), name: 'Guest', intent: 'join' });
    await post('send', { studio: code, id: guest.id, tok: guest.tok, ops: [{ type: 'superchat', id: sc.id, do: 'confirm' }] });
    check('a guest can’t confirm a super chat', !(await feed(code)).chat.some((m) => m.paid));
    await post('send', { studio: code, id: h.id, tok: h.tok, ops: [{ type: 'superchat', id: sc.id, do: 'confirm' }] });
    const f2 = await feed(code);
    const paid = f2.chat.find((m) => m.paid);
    check('once the host confirms, everyone sees it as paid', paid?.paid === '$10' && paid.name === 'Jordan', JSON.stringify(paid));
    await post('wsend', { studio: code, vid: v.vid, vtok: v.vtok, type: 'react', emoji: '🔥' });
    check('reactions are counted for everyone', (await feed(code)).reacts['🔥'] >= 1);
    await setW({ cap: 0, direct: false, chat: true });
    check('with direct video off, viewers are told it is off (they fall back to platforms)', (await post('wrtcJoin', { studio: code, vid: v.vid, vtok: v.vtok })).reason === 'off');
    await post('leave', { studio: code, id: guest.id, tok: guest.tok, why: 'left' });
    await post('leave', { studio: code, id: h.id, tok: h.tok, why: 'left' });

    // ---- the real thing in browsers: host + a viewer on the page, chat, a super chat confirmed from the studio chat
    const a = await mk();
    await a.goto(B + '/'); await a.click('#enterStage'); await a.fill('#enterName', 'Maya Host'); await a.click('#enterGo');
    await a.waitForSelector('#inviteDlg[open]'); const sc2 = (await a.textContent('#inviteCode')).trim(); await a.keyboard.press('Escape');
    await a.click('[data-tab="show"]'); await a.check('#wpSupers'); await a.fill('#wpPay-venmo', 'maya-host'); await a.press('#wpPay-venmo', 'Tab');
    await a.click('[data-tab="chat"]');
    const w = await mk();
    await w.goto(B + '/w/' + sc2);
    const plays = await w.waitForFunction(() => document.querySelector('#wDirect')?.videoWidth > 0, null, { timeout: 30000 }).then(() => true).catch(() => false);
    check('the watch page plays the studio directly over WebRTC', plays);
    check('…and says "On air" with a viewer count', (await w.textContent('#wLiveText')) === 'On air' && /watching/.test(await w.textContent('#wViewers')));
    check('the page glows with the live picture (blurred copy behind it)', await w.evaluate(() => document.querySelector('#wv').classList.contains('glow') && !!document.querySelector('#wAmbientVid').srcObject));
    await w.click('#wChatCollapse');
    check('chat collapses from its header, and a Chat tab appears', await w.evaluate(() => document.querySelector('#wv').classList.contains('no-chat')) && await w.isVisible('#wChatReopen'));
    await w.click('#wChatReopen');
    check('…and the Chat tab brings it back', await w.evaluate(() => !document.querySelector('#wv').classList.contains('no-chat')) && await w.isVisible('#wText'));
    await w.fill('#wText', 'Hello from the watch page'); await w.click('#wSend');
    check('a signed-out viewer who sends a message is asked to sign in', await w.waitForSelector('#wSignDlg[open]', { timeout: 5000 }).then(() => true).catch(() => false));
    await signUp(w, 'Jordan'); // the message waiting in the box goes out once they're signed in
    const inStudio = await a.waitForFunction(() => [...document.querySelectorAll('#msgs .msg.ext')].some((li) => /Hello from the watch page/.test(li.textContent)), null, { timeout: 10000 }).then(() => true).catch(() => false);
    check('viewer chat reaches the studio chat', inStudio);
    await w.click('#wSuperBtn'); await w.click('#wAmounts button:has-text("$10")'); await w.fill('#wScName', 'Jordan'); await w.fill('#wScText', 'Shout-out!');
    await w.evaluate(() => { window.open = () => null; }); // the payment app opens in a new tab; not reachable from the test sandbox
    await w.click('#wPayGo'); await w.click('#wPaid');
    const pending = await a.waitForSelector('#msgs .sc-pending', { timeout: 10000 }).then(() => true).catch(() => false);
    check('a new super chat shows in the studio chat with its confirm buttons', pending);
    await a.click('#msgs .sc-pending .btn.primary');
    const onStage = await a.waitForFunction(() => window.__gather.state.featured?.paid === '$10', null, { timeout: 5000 }).then(() => true).catch(() => false);
    const public_ = await w.waitForFunction(() => [...document.querySelectorAll('#wMsgs li.paid')].some((li) => !li.classList.contains('pending') && /Shout-out/.test(li.textContent)), null, { timeout: 10000 }).then(() => true).catch(() => false);
    check('confirming puts it on stage with its amount and in everyone’s chat', onStage && public_);
    check('the page fits one screen (no page scroll)', await w.evaluate(() => document.documentElement.scrollHeight <= innerHeight));
    const p = await mk({ width: 390, height: 844 }); await p.goto(B + '/w/' + sc2); await p.waitForTimeout(2500);
    check('on a phone the page fits one screen and the chat box is visible', await p.evaluate(() => { const r = document.querySelector('#wText').getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth && r.bottom <= innerHeight; }));
  } catch (e) { check('suite ran', false, e.stack); }
  console.log('errors A', errs, 'B', []);
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
