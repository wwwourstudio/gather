// Live alerts by email (lib/studio.js): subscribe on a streamer's page, confirm from the email, get one alert when
// they go live (not two in a row), unsubscribe in one click. Runs on the in-memory store with email captured.
for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'REDIS_URL', 'KV_URL']) delete process.env[k];
process.env.RESEND_API_KEY = 're_test_key';
process.env.APP_URL = 'https://gather.test';

const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    const body = JSON.parse(opts.body || '{}');
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ url: String(url), ...m });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: 'b' + i })) } : { id: 'm1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, opts);
};

const { store } = require('../lib/store');
const { handle, _liveAlerts } = require('../lib/studio');

let ok = true;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) ok = false; };
const fails = async (p) => { try { await p; return null; } catch (e) { return e; } };

(async () => {
  try {
    await store.pipe([
      ['SET', 'acct:u:U1', JSON.stringify({ id: 'U1', name: 'Maya Ortiz', handle: 'maya', email: 'maya@example.com' })],
      ['SET', 'acct:h:maya', 'U1'],
      ['SET', 'g:gather-abc:owner', JSON.stringify({ u: 'U1' })],
    ]);

    const bad = await fails(handle('wsub', { studio: 'maya', email: 'not-an-email' }));
    check('a made-up address is refused', bad?.status === 400, bad?.message);
    const nobody = await fails(handle('wsub', { studio: 'nobody-here', email: 'v@example.com' }));
    check('a page with no streamer takes no subscribers', nobody?.status === 404, nobody?.message);

    const r = await handle('wsub', { studio: 'maya', email: 'Viewer@Example.com' });
    check('subscribing sends one confirmation email', r.sent && sent.length === 1 && sent[0].to[0] === 'viewer@example.com', JSON.stringify(sent.map((m) => m.to)));
    const link = (sent[0]?.html || '').match(/https:\/\/gather\.test\/w\/maya\?subok=([a-f0-9]+)/);
    check('the email links back to the streamer’s page to confirm', !!link);
    await handle('wsub', { studio: 'maya', email: 'viewer@example.com' });
    check('asking twice in a row doesn’t send a second email', sent.length === 1, String(sent.length));

    let feed = await handle('wfeed', { studio: 'maya' });
    check('before confirming, nobody is counted', feed.host?.alerts === true && feed.host?.subs === 0, JSON.stringify(feed.host));

    const c = await handle('wsubok', { t: link?.[1] });
    check('the confirmation link subscribes them', c.ok && c.name === 'Maya Ortiz' && /^[a-f0-9]{32}$/.test(c.t), JSON.stringify(c));
    const again = await fails(handle('wsubok', { t: link?.[1] }));
    check('a confirmation link works once', again?.status === 410);
    feed = await handle('wfeed', { studio: 'maya' });
    check('the streamer card counts 1 subscriber', feed.host?.subs === 1, JSON.stringify(feed.host));
    const already = await handle('wsub', { studio: 'maya', email: 'viewer@example.com' });
    check('subscribing again says they already are', already.already === true);

    sent.length = 0;
    await _liveAlerts('gather-abc', { title: 'Building in public', live: { on: true, since: Date.now() } });
    const alert = sent[0];
    check('going live emails every subscriber (through the batch endpoint)', sent.length === 1 && alert.url.endsWith('/emails/batch') && alert.to[0] === 'viewer@example.com', JSON.stringify(sent.map((m) => m.url)));
    check('the alert names the streamer and the show', /Maya Ortiz is live/.test(alert?.subject || '') && /Building in public/.test(alert?.subject || ''), alert?.subject);
    check('the alert has a one-click unsubscribe link and header', /\?unsub=[a-f0-9]{32}/.test(alert?.html || '') && /unsub=/.test(alert?.headers?.['List-Unsubscribe'] || ''));
    await _liveAlerts('gather-abc', { title: 'Building in public', live: { on: true, since: Date.now() } });
    check('going live again right away doesn’t send a second alert', sent.length === 1, String(sent.length));

    const u = await handle('wunsub', { t: c.t });
    feed = await handle('wfeed', { studio: 'maya' });
    check('unsubscribing removes them', u.ok && u.name === 'Maya Ortiz' && feed.host?.subs === 0, JSON.stringify(feed.host));
  } catch (e) { check('suite ran', false, e.stack); }
  process.exit(ok ? 0 : 1);
})();
