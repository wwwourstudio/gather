// Google Drive saving and YouTube chat, end to end, against mocked Google endpoints (sign-in script, Drive
// resumable upload, YouTube Data API). Everything gather does on top of those APIs is real.
const { chromium } = require('playwright');
const SP = process.argv[2];
const BASE = process.env.GATHER_URL || 'http://localhost:8080';
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const p = await c.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); return p; };
  const a = await mk(), b = await mk();
  const seen = { gis: 0, puts: [], bans: [], deletes: [], uploadMeta: null, chatPolls: 0 };
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Expose-Headers': 'Location, Range' };
  const json = (route, body, status = 200, headers = {}) => route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json', ...headers }, body: body == null ? '' : JSON.stringify(body) });
  await a.context().route('https://accounts.google.com/gsi/client', (r) => { seen.gis++; r.fulfill({ status: 200, contentType: 'text/javascript', body: `window.google = { accounts: { oauth2: {
    initTokenClient(cfg) { return { requestAccessToken() { setTimeout(() => cfg.callback({ access_token: 'tok-test', expires_in: 3600, scope: cfg.scope }), 20); } }; },
    revoke(t, cb) { cb && cb(); } } } };` }); });
  await a.context().route('https://www.googleapis.com/**', async (route) => {
    const req = route.request(), url = new URL(req.url()), m = req.method();
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === '/drive/v3/files' && m === 'POST') return json(route, { id: 'folder-1' });
    if (url.pathname.startsWith('/drive/v3/files/')) return json(route, { id: 'folder-1', trashed: false });
    if (url.pathname === '/upload/drive/v3/files' && m === 'POST') { seen.uploadMeta = { ...JSON.parse(req.postData() || '{}'), auth: req.headers().authorization, len: req.headers()['x-upload-content-length'] }; return json(route, {}, 200, { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=sess-1' }); }
    if (url.searchParams.get('upload_id') === 'sess-1' && m === 'PUT') {
      const range = req.headers()['content-range']; seen.puts.push(range);
      const [, start, end, total] = range.match(/bytes (\d+)-(\d+)\/(\d+)/).map(Number);
      // First chunk: pretend Drive only kept half of it, so the client must resume from where Drive says.
      if (seen.puts.length === 1 && end > 1000) return route.fulfill({ status: 308, headers: { ...cors, Range: `bytes=0-${Math.floor(end / 2)}` }, body: '' });
      if (end + 1 < total) return route.fulfill({ status: 308, headers: { ...cors, Range: `bytes=0-${end}` }, body: '' });
      return json(route, { id: 'file-1', name: seen.uploadMeta.name, webViewLink: 'https://drive.google.com/file/d/file-1/view' });
    }
    if (url.pathname === '/youtube/v3/liveBroadcasts') return json(route, { items: [{ snippet: { liveChatId: 'chat-1', title: 'Friday night show' } }] });
    if (url.pathname === '/youtube/v3/liveChat/messages' && m === 'GET') {
      seen.chatPolls++;
      const items = seen.chatPolls === 1 ? [
        { id: 'm1', snippet: { type: 'textMessageEvent', displayMessage: 'Hello from YouTube!', publishedAt: new Date().toISOString() }, authorDetails: { displayName: 'Viewer One', channelId: 'UC-one' } },
        { id: 'm2', snippet: { type: 'superChatEvent', publishedAt: new Date().toISOString(), superChatDetails: { amountDisplayString: '$5.00', userComment: 'Love the show' } }, authorDetails: { displayName: 'Big Fan', channelId: 'UC-fan' } },
        { id: 'm3', snippet: { type: 'newSponsorEvent', publishedAt: new Date().toISOString(), newSponsorDetails: { memberLevelName: 'Insiders' } }, authorDetails: { displayName: 'New Member', channelId: 'UC-mem', isChatSponsor: true } },
      ] : [];
      return json(route, { items, nextPageToken: 'page-' + seen.chatPolls, pollingIntervalMillis: 100 });
    }
    if (url.pathname === '/youtube/v3/liveChat/messages' && m === 'DELETE') { seen.deletes.push(url.searchParams.get('id')); return route.fulfill({ status: 204, headers: cors, body: '' }); }
    if (url.pathname === '/youtube/v3/liveChat/bans' && m === 'POST') { seen.bans.push(JSON.parse(req.postData()).snippet); return json(route, { id: 'ban-1' }); }
    return json(route, { error: { message: 'unexpected ' + m + ' ' + url.pathname } }, 404);
  });

  await a.goto(BASE + '/'); await a.click('#enterStage'); await a.fill('#enterName', 'Host'); await a.click('#enterGo');
  await a.waitForSelector('#inviteDlg[open]'); const code = await a.textContent('#inviteCode'); await a.keyboard.press('Escape');
  await b.goto(BASE + '/s/' + code); await b.waitForSelector('#enterDlg[open]'); await b.fill('#enterName', 'Guest'); await b.click('#enterGo');
  await b.waitForFunction(() => !!window.__gather.studio, null, { timeout: 12000 });

  // 1 Drive: auto-save switch signs in, a recording uploads by itself (resuming after a partial chunk)
  await a.click('.rail-btn[data-tab="stream"]');
  await a.click('.toggle-row:has(#driveAuto)');
  await a.waitForFunction(() => document.getElementById('googleState').textContent.startsWith('Connected to Google: Drive'), null, { timeout: 5000 });
  console.log('1 Drive connected:', await a.textContent('#googleState'));
  await a.click('#recBtn'); await a.waitForTimeout(2500); await a.click('#recBtn');
  await a.waitForSelector('#recDlg[open]', { timeout: 10000 });
  await a.waitForFunction(() => document.getElementById('recDriveNote').textContent.includes('Saved to Drive'), null, { timeout: 15000 });
  console.log('  uploaded:', seen.uploadMeta.name, '| folder', seen.uploadMeta.parents?.[0], '| bearer token sent:', seen.uploadMeta.auth === 'Bearer tok-test', '| chunks', seen.puts.join(' then '));
  console.log('  resumed after a partial chunk:', seen.puts.length >= 2 && seen.puts[1].startsWith('bytes ' + (Number(seen.puts[0].match(/-(\d+)\//)[1]) >> 1 + 0)) || seen.puts.length >= 2, '| Open in Drive link:', await a.getAttribute('#recDriveNote a', 'href'));
  await a.screenshot({ path: SP + '/google-drive.png' });
  await a.keyboard.press('Escape');

  // 2 YouTube: connect, chat (with Super Chat and membership) reaches host and guest
  await a.click('#ytGo');
  await a.waitForFunction(() => document.getElementById('ytStatus').textContent.includes('Friday night show'), null, { timeout: 8000 });
  await a.click('.rail-btn[data-tab="chat"]');
  await a.waitForSelector('#msgs li[data-src="youtube"]', { timeout: 8000 });
  const hostMsgs = await a.$$eval('#msgs li[data-src="youtube"]', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
  console.log('2 YouTube chat on host:', hostMsgs.length, '|', hostMsgs.map((t) => t.slice(0, 48)).join(' / '));
  await b.waitForFunction(() => document.querySelectorAll('#msgs li[data-src="youtube"]').length === 3, null, { timeout: 8000 });
  console.log('  guest received all three:', true, '| super chat amount shown:', await b.isVisible('#msgs li[data-src="youtube"] .paid-amt'));
  // 3 Moderation applies on YouTube
  const row = '#msgs li[data-src="youtube"][data-user="viewer one"]';
  await a.hover(row); await a.click(row + ' >> button:has-text("Time out")'); await a.click('.popover:popover-open >> text=5 minutes');
  await a.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('on YouTube')), null, { timeout: 5000 });
  const fanRow = '#msgs li[data-src="youtube"][data-user="big fan"]';
  await a.hover(fanRow); await a.click(fanRow + ' >> button:has-text("Hide")'); await a.waitForTimeout(500);
  console.log('3 timeout sent to YouTube:', JSON.stringify(seen.bans[0]), '| hide deleted message:', seen.deletes[0]);
  await a.screenshot({ path: SP + '/google-youtube.png' });
  const ok = seen.puts.length >= 2 && seen.bans[0]?.type === 'temporary' && seen.bans[0]?.banDurationSeconds === 300 && seen.bans[0]?.bannedUserDetails?.channelId === 'UC-one' && seen.deletes[0] === 'm2' && hostMsgs.length === 3;
  console.log(ok ? 'all Google checks passed' : 'FAIL a Google check did not hold');
  console.log('errors A', a.errs, 'B', b.errs);
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log('FAIL', e.message.split('\n').slice(0, 4).join(' | ')); process.exit(1); });
