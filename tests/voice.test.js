// Voice questions (which replaced the call-in line) and finding the watch page: a viewer raises a hand and records a
// question; the host gets it in the studio chat and the Show panel, previews it privately, plays it on air or deletes
// it. The watch link is in the header, the Invite dialog, and on the stream itself.
const { chromium } = require('playwright');
const B = process.env.GATHER_URL || 'http://localhost:8080';
const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
let ok = true;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) ok = false; };
const wait = (p, fn, arg, ms = 10000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 100 }).then(() => true).catch(() => false);

(async () => {
  const bh = await chromium.launch({ args: ARGS }), bv = await chromium.launch({ args: ARGS });
  const errs = [];
  const mk = async (br) => { const p = await (await br.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); p.on('pageerror', (e) => errs.push(e.message)); return p; };
  try {
    const a = await mk(bh);
    await a.goto(B + '/'); await a.click('#enterStage'); await a.fill('#enterName', 'Maya Host'); await a.click('#enterGo');
    await a.waitForSelector('#inviteDlg[open]'); const code = (await a.textContent('#inviteCode')).trim();
    const short = await a.evaluate(() => window.__gather.short);
    check('the studio has a short watch link', /^[a-z2-9]{5}$/.test(short || ''), short);
    check('invite dialog shows the short watch link', (await a.textContent('#inviteWatch')).endsWith('/w/' + short));
    await a.keyboard.press('Escape');
    check('the header has a Watch page button', await a.isVisible('#watchTop'));
    check('the call-in section is gone', !(await a.$('#callinCard')) && !(await a.$('#callinUrl')));
    check('the stream shows a “Watch & chat live” badge', await a.evaluate(() => { const c = document.querySelector('#stageCanvas'), g = c.getContext('2d'); const d = g.getImageData(c.width - 120, c.height - 60, 40, 20).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 40 && d[i + 1] < 40 && d[i + 2] < 60) dark++; return dark > 100; }));

    const v = await mk(bv);
    await v.goto(B + '/w/' + short); // the short link, as a viewer would type it
    check('watch page: voice questions from the chat box, no call-in “Ask to join”', await wait(v, () => !document.querySelector('#wMic').hidden) && !(await v.$('#wJoin')));
    await v.click('#wMic'); await v.fill('#wVoiceName', 'Jordan');
    await v.click('#wRecBtn'); await v.waitForTimeout(3200); await v.click('#wRecBtn');
    check('a recording is ready to listen back', await wait(v, () => !document.querySelector('#wRecPlay').hidden && !document.querySelector('#wRecSend').disabled));
    await v.click('#wRecSend');
    check('sent: the dialog closes with a confirmation', await wait(v, () => !document.querySelector('#wVoiceDlg').open && /voice question went to the host/.test(document.querySelector('#wMsgs').textContent)));

    check('host: the voice question lands in the studio chat', await wait(a, () => document.querySelector('#msgs [data-vm]')));
    await a.click('[data-tab="show"]');
    check('host: and in the Show panel’s Voice questions list', await wait(a, () => document.querySelectorAll('#vmList li').length === 1));
    await a.click('#vmList li button:has-text("Preview")');
    check('host: preview plays (only for the host)', await wait(a, () => /Stop/.test(document.querySelector('#vmList li').textContent)));
    await a.click('#vmList li button:has-text("Play on air")');
    check('host: play on air puts the question on stage', await wait(a, () => window.__gather.state.featured?.paid === '🎙' && window.__gather.state.featured.name === 'Jordan'));
    await a.click('#vmList li button:has-text("Delete")');
    check('host: delete removes it everywhere', await wait(a, () => !document.querySelector('#vmList li') && !document.querySelector('#msgs [data-vm]') && !window.__gather.state.featured));
  } catch (e) { check('suite ran', false, e.stack); }
  console.log('errors A', errs, 'B', []);
  await bh.close(); await bv.close();
  process.exit(ok ? 0 : 1);
})();
