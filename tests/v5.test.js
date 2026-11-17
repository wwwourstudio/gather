// V5 audit regressions in a real browser: Enter in the green room joins, typing the show title never fires
// shortcuts, a background chip keeps a guest in Join mode, the stream-key field survives a guest joining,
// errors show above open dialogs, and guests see that the show is being recorded.
const { chromium } = require('playwright');
const URL0 = process.env.GATHER_URL || 'http://localhost:8080';
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p = await c.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/twitch|favicon|404|423|403/.test(m.text()) && p.errs.push(m.text())); return p; };
  let ok = true;
  const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) ok = false; };
  const a = await mk(), b = await mk(), c = await mk();
  try {
    // Host opens a studio.
    await a.goto(URL0 + '/'); await a.click('#enterStage'); await a.fill('#enterName', 'Alex Host'); await a.click('#enterGo');
    await a.waitForSelector('#inviteDlg[open]'); const code = (await a.textContent('#inviteCode')).trim();
    // Enter inside the invite dialog must not count as "close" either; Escape closes it.
    await a.keyboard.press('Escape');

    // Guest: touch a background chip, then press Enter in the name field.
    await b.goto(URL0 + '/s/' + code); await b.waitForSelector('#enterDlg[open]');
    await b.click('#grFx [data-fx="none"]');
    check('a background chip keeps the guest in Join mode', (await b.textContent('#enterGo')).trim() === 'Join studio');
    await b.fill('#enterName', 'Jordan Guest'); await b.focus('#enterName'); await b.keyboard.press('Enter');
    await b.waitForFunction(() => window.__gather.studio, null, { timeout: 15000 }).catch(() => {});
    check('Enter in the green room joins the studio', await b.evaluate((c) => window.__gather.studio === c && window.__gather.host !== window.__gather.id, code));

    // Host renames the show by typing; none of the letters may act as shortcuts.
    await a.waitForFunction(() => window.__gather.peers.size === 1, null, { timeout: 10000 });
    const micBefore = await a.evaluate(() => window.__gather.local.micOn);
    await a.click('#studioTitle');
    await a.keyboard.press('Control+A'); await a.keyboard.type('Mars Rover Vlog 3'); await a.keyboard.press('Enter');
    await a.waitForTimeout(600);
    const st = await a.evaluate(() => ({ title: window.__gather.state.title, mic: window.__gather.local.micOn, rec: !!window.__gather.rec, pres: !!window.__gather.local.pres }));
    check('typing the show title saves it exactly', st.title === 'Mars Rover Vlog 3', JSON.stringify(st.title));
    check('…and fires no shortcuts (mic, record, share)', st.mic === micBefore && !st.rec && !st.pres, JSON.stringify(st));

    // Stream-key field: the host is typing when someone joins.
    await a.evaluate(() => { window.__gather.relayOn = true; });
    await a.click('#liveTop'); await a.waitForSelector('#liveDlg[open]');
    await a.click('.plat-tile[data-plat="youtube"]');
    await a.click('#destList li:last-child [data-k="key"]'); await a.keyboard.type('partial-key');
    await c.goto(URL0 + '/s/' + code); await c.waitForSelector('#enterDlg[open]'); await c.fill('#enterName', 'Sam Third'); await c.click('#enterGo');
    await a.waitForFunction(() => window.__gather.peers.size === 2, null, { timeout: 15000 });
    const key = await a.evaluate(() => ({ v: document.querySelector('#destList li:last-child [data-k="key"]').value, focused: document.activeElement?.dataset?.k }));
    check('the stream-key field keeps what you typed when someone joins', key.v === 'partial-key' && key.focused === 'key', JSON.stringify(key));
    check('the Go live button says why it can’t go yet', !(await a.isVisible('#liveWhy')) || /key|destination|Send|host/i.test(await a.textContent('#liveWhy')));

    // A toast that fires while the dialog is open is on top of it, not hidden behind.
    await c.evaluate(() => document.querySelector('#leaveBtn').click());
    await c.goto(URL0 + '/s/' + code); await c.waitForSelector('#enterDlg[open]'); await c.fill('#enterName', 'Riley Fourth'); await c.click('#enterGo');
    const onTop = await a.waitForFunction(() => {
      const t = [...document.querySelectorAll('#toasts .toast')].find((x) => /Riley Fourth joined/.test(x.textContent));
      if (!t) return false;
      // In the top layer (a popover re-shown after the dialog), and on screen. elementFromPoint can't be used:
      // browsers skip everything outside a modal dialog when hit-testing, even what's painted above it.
      const r = t.getBoundingClientRect();
      return document.querySelector('#toasts').matches(':popover-open') && r.x >= 0 && r.y > innerHeight / 2 && r.bottom <= innerHeight;
    }, null, { timeout: 30000 }).then(() => true).catch(() => false);
    check('toasts show above an open dialog', onTop);
    await a.keyboard.press('Escape');

    // Recording: the guest sees a lasting REC badge, not just a 3-second toast.
    await a.evaluate(() => document.querySelector('#recBtn').click());
    await b.waitForFunction(() => !document.querySelector('#recPill').hidden, null, { timeout: 10000 }).catch(() => {});
    await b.waitForTimeout(4000);
    check('guests see a REC badge for as long as it records', await b.isVisible('#recPill') && /Rec/.test(await b.textContent('#recPill')));
    await a.evaluate(() => document.querySelector('#recBtn').click());
    await b.waitForFunction(() => document.querySelector('#recPill').hidden, null, { timeout: 10000 }).catch(() => {});
    check('…and it goes away when recording stops', !(await b.isVisible('#recPill')));
  } catch (e) { check('suite ran', false, e.stack); }
  console.log('errors A', a.errs, 'B', b.errs);
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
