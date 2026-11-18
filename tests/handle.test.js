// Named watch pages: a signed-in host claims /w/<name> once, and that link shows whatever show they host now.
// Between shows it says they're offline, then starts playing by itself when they go on.
const { chromium } = require('playwright');
const B = process.env.GATHER_URL || 'http://localhost:8080';
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
const post = (api, action, body, token) => fetch(`${B}/api/${api}?action=${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ http: r.status, ...(await r.json().catch(() => ({}))) }));

(async () => {
  const bh = await chromium.launch({ args: ARGS }), bv = await chromium.launch({ args: ARGS });
  const errs = [];
  try {
    const n = Date.now().toString(36);
    const name = 'maya' + n.slice(-5);
    const up = await post('account', 'signup', { email: `maya-${n}@example.com`, password: 'correct horse', name: 'Maya Host', agree: true });
    const other = await post('account', 'signup', { email: `sam-${n}@example.com`, password: 'correct horse', name: 'Sam', agree: true });
    check('accounts created', !!up.token && !!other.token);

    // Rules for names, through the API.
    check('reserved names are refused', (await post('account', 'handle', { handle: 'admin' }, up.token)).http === 400);
    check('names that look like studio codes are refused', (await post('account', 'handle', { handle: 'gather-abc' }, up.token)).http === 400);
    check('bad characters are refused', (await post('account', 'handle', { handle: 'my name!' }, up.token)).http === 400);
    check('signed-out claims are refused', (await post('account', 'handle', { handle: name })).http === 401);

    // Before anyone claims it, the page says so.
    const v = await (await bv.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); v.on('pageerror', (e) => errs.push(e.message));
    await v.goto(`${B}/w/${name}`);
    check('unclaimed name: says it isn’t anyone’s page yet', await wait(v, () => /isn’t anyone’s page/.test(document.querySelector('#wEmptyH')?.textContent || '')));

    // The host claims it from the Show panel.
    const ctx = await bh.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { if (!localStorage.getItem('gather:acctToken')) localStorage.setItem('gather:acctToken', JSON.stringify(t)); }, up.token);
    const a = await ctx.newPage(); a.on('pageerror', (e) => errs.push(e.message));
    await a.goto(B + '/'); await a.click('#enterStage'); await a.click('#enterGo');
    await a.waitForSelector('#inviteDlg[open]'); const code = (await a.textContent('#inviteCode')).trim(); await a.keyboard.press('Escape');
    await a.click('[data-tab="show"]');
    check('Show panel offers to claim a name', await wait(a, () => !document.querySelector('#wpHandle').disabled && /Claim/.test(document.querySelector('#wpHandleSave').textContent)));
    await a.fill('#wpHandle', name.toUpperCase()); await a.click('#wpHandleSave');
    check('claimed: the watch link is now /w/<name>', await wait(a, () => document.querySelector('#wpUrl').textContent.endsWith('/w/' + document.querySelector('#wpHandle').value)));
    await a.evaluate(() => document.querySelector('#inviteDlg').showModal());
    check('the Invite dialog shares the named link', await wait(a, (nm) => document.querySelector('#inviteWatch').textContent.endsWith('/w/' + nm), name));
    await a.keyboard.press('Escape');
    check('someone else can’t take it', (await post('account', 'handle', { handle: name }, other.token)).http === 409);
    check('account shows the name', (await post('account', 'me', {}, up.token)).user?.handle === name);

    // The waiting viewer's page picks up the live show by itself.
    check('viewer on /w/<name>: the show appears by itself', await wait(v, () => !/anyone’s page/.test(document.querySelector('#wEmptyH')?.textContent || '') && document.querySelector('#wViewers') && !document.querySelector('#wViewers').hidden, null, 20000));
    check('viewer: direct video plays through the named link', await wait(v, () => document.querySelector('#wDirect')?.videoWidth > 0, null, 30000));
    await v.fill('#wText', 'hi from the named page'); await v.click('#wSend'); await signUp(v, 'Priya');
    await a.click('[data-tab="chat"]');
    check('host: chat from the named page arrives', await wait(a, () => /hi from the named page/.test(document.querySelector('#msgs').textContent)));

    // A name whose owner has no show open: the page says they're offline (by name), and waits.
    const sam = 'sam' + n.slice(-5);
    check('a second person claims their own name', (await post('account', 'handle', { handle: sam }, other.token)).user?.handle === sam);
    const f = await post('studio', 'wfeed', { studio: sam });
    check('offline: the feed names the person', f.offline === true && f.name === 'Sam', JSON.stringify(f));
    await v.goto(`${B}/w/${sam}`);
    check('offline: the page says Sam isn’t live right now', await wait(v, () => /Sam isn’t live/.test(document.querySelector('#wEmptyH')?.textContent || '')));
  } catch (e) { check('suite ran', false, e.stack); }
  console.log('errors A', errs, 'B', []);
  await bh.close(); await bv.close();
  process.exit(ok ? 0 : 1);
})();
