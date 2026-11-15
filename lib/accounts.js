// gather accounts: email + password or Google sign-in, profile (nickname, photo), synced settings.
// Passwords: scrypt with a per-user salt. Sessions: random tokens; only their SHA-256 is stored.
// Changing or resetting a password bumps the user's session version, which signs out every device.
const crypto = require('crypto');
const { store } = require('./store');
const { sendMail, mailReady, layout, esc } = require('./mail');

const SESSION_TTL = 30 * 864e2; // 30 days, seconds
const RESET_TTL = 3600;
const MAX_SETTINGS = 400_000;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const K = {
  user: (id) => `acct:u:${id}`, email: (e) => `acct:e:${e}`, sess: (t) => `acct:s:${sha(t)}`,
  reset: (t) => `acct:r:${sha(t)}`, rl: (e) => `acct:rl:${e}`, google: (sub) => `acct:g:${sub}`,
};
// Google sign-in: the browser gets an ID token from Google; we check it with Google and that it was issued for
// this site's client ID, then sign in the account with that Google ID (or link the one with the same email).
const TOKENINFO = process.env.GOOGLE_TOKENINFO_URL || 'https://oauth2.googleapis.com/tokeninfo';
const USERINFO = process.env.GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo';
const normEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 200);
const validEmail = (e) => /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i.test(e);
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
const parse = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };

function scrypt(password, salt) {
  return new Promise((res, rej) => crypto.scrypt(String(password), salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k.toString('hex')))));
}
async function setPassword(user, password) {
  if (String(password || '').length < 8) throw new HttpError(400, 'Use at least 8 characters for your password.');
  if (String(password).length > 200) throw new HttpError(400, 'That password is too long.');
  const salt = crypto.randomBytes(16).toString('hex');
  user.pass = { salt, hash: await scrypt(password, salt) };
  user.sv = (user.sv || 0) + 1; // signs out every existing session
}
async function checkPassword(user, password) {
  if (!user?.pass) return false;
  const h = Buffer.from(await scrypt(password, user.pass.salt), 'hex');
  const want = Buffer.from(user.pass.hash, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
const pub = (u) => ({ id: u.id, email: u.email, name: u.name, hasPassword: !!u.pass, avatar: u.avatar || '', settings: u.settings || {}, createdAt: u.createdAt, mail: mailReady });

async function loadUser(id) { const [raw] = await store.pipe([['GET', K.user(id)]]); return parse(raw); }
async function saveUser(u) { await store.pipe([['SET', K.user(u.id), JSON.stringify(u)]]); }
async function issueToken(u) {
  const token = crypto.randomBytes(32).toString('base64url');
  await store.pipe([['SET', K.sess(token), `${u.id}:${u.sv || 0}`, 'EX', SESSION_TTL]]);
  return token;
}

/** Resolve the signed-in user from a bearer token; throws 401 when absent or stale. */
async function authUser(token) {
  if (!token || String(token).length < 20) throw new HttpError(401, 'Please sign in.');
  const [val] = await store.pipe([['GET', K.sess(String(token))]]);
  if (!val) throw new HttpError(401, 'Your session ended. Please sign in again.');
  const [id, sv] = String(val).split(':');
  const u = await loadUser(id);
  if (!u || String(u.sv || 0) !== sv) throw new HttpError(401, 'Your session ended. Please sign in again.');
  return u;
}

const actions = {
  async signup({ email, password, name, agree }) {
    email = normEmail(email);
    if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (agree !== true) throw new HttpError(400, 'Agree to the Terms and Privacy policy to create your account.');
    const u = { id: crypto.randomBytes(8).toString('hex'), termsAt: Date.now(), email, name: cleanName(name) || email.split('@')[0].slice(0, 24), avatar: '', settings: {}, createdAt: Date.now(), sv: 0 };
    await setPassword(u, password);
    const [claimed] = await store.pipe([['SET', K.email(email), u.id, 'NX']]);
    if (!claimed) throw new HttpError(409, 'An account with that email already exists. Sign in instead.');
    await saveUser(u);
    return { token: await issueToken(u), user: pub(u) };
  },

  async login({ email, password }) {
    email = normEmail(email);
    const [tries] = await store.pipe([['INCR', K.rl(email)], ['EXPIRE', K.rl(email), 900]]);
    if (Number(tries) > 10) throw new HttpError(429, 'Too many attempts. Wait 15 minutes, or reset your password.');
    const [id] = await store.pipe([['GET', K.email(email)]]);
    const u = id ? await loadUser(id) : null;
    if (!u || !(await checkPassword(u, password))) throw new HttpError(401, 'That email and password don’t match.');
    await store.pipe([['DEL', K.rl(email)]]);
    return { token: await issueToken(u), user: pub(u) };
  },

  async google({ accessToken, agree }) {
    const cid = String(process.env.GOOGLE_CLIENT_ID || '').trim();
    if (!cid) throw new HttpError(400, 'Google sign-in isn’t set up on this server.');
    if (!accessToken || String(accessToken).length > 4096) throw new HttpError(400, 'Google didn’t send a sign-in token. Try again.');
    // Check the token with Google: issued for this site, still valid, carrying a verified email. Then read the name.
    let info, prof = {};
    try {
      const res = await fetch(`${TOKENINFO}?access_token=${encodeURIComponent(accessToken)}`, { signal: AbortSignal.timeout(6000) });
      info = res.ok ? await res.json() : null;
      if (info) { const r2 = await fetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(6000) }); if (r2.ok) prof = await r2.json(); }
    } catch { throw new HttpError(502, 'Couldn’t reach Google to check your sign-in. Try again.'); }
    if (!info || (info.aud !== cid && info.azp !== cid) || Number(info.exp) * 1000 < Date.now()) throw new HttpError(401, 'Google sign-in didn’t check out. Try again.');
    if (String(info.email_verified) !== 'true') throw new HttpError(401, 'Verify your email with Google first.');
    if (prof.sub && prof.sub !== info.sub) throw new HttpError(401, 'Google sign-in didn’t check out. Try again.');
    info = { ...info, given_name: prof.given_name, name: prof.name };
    const sub = String(info.sub || '').replace(/[^0-9a-z]/gi, '').slice(0, 64), email = normEmail(info.email);
    if (!sub || !validEmail(email)) throw new HttpError(401, 'Google sign-in didn’t include an email.');
    let [id] = await store.pipe([['GET', K.google(sub)]]);
    if (!id) [id] = await store.pipe([['GET', K.email(email)]]); // an existing email account: link it
    let u = id ? await loadUser(id) : null, created = false;
    if (!u) {
      if (agree !== true) throw new HttpError(400, 'Agree to the Terms and Privacy policy to create your account.');
      u = { id: crypto.randomBytes(8).toString('hex'), termsAt: Date.now(), email, name: cleanName(info.given_name || info.name) || email.split('@')[0].slice(0, 24), avatar: '', settings: {}, createdAt: Date.now(), sv: 0 };
      const [claimed] = await store.pipe([['SET', K.email(email), u.id, 'NX']]);
      if (!claimed) { const [other] = await store.pipe([['GET', K.email(email)]]); u = await loadUser(other); }
      else created = true;
    }
    u.google = sub;
    await saveUser(u);
    await store.pipe([['SET', K.google(sub), u.id]]);
    return { token: await issueToken(u), user: pub(u), created };
  },

  async me(_, u) { return { user: pub(u) }; },

  async update({ name, avatar, settings }, u) {
    if (name !== undefined) u.name = cleanName(name) || u.name;
    if (avatar !== undefined) {
      const a = String(avatar || '');
      if (a && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(a)) throw new HttpError(400, 'Use a PNG, JPEG or WebP photo.');
      if (a.length > 200_000) throw new HttpError(413, 'That photo is too large.');
      u.avatar = a;
    }
    if (settings !== undefined) {
      if (typeof settings !== 'object' || Array.isArray(settings)) throw new HttpError(400, 'Settings must be an object.');
      const json = JSON.stringify(settings);
      if (json.length > MAX_SETTINGS) throw new HttpError(413, 'Saved settings are too large. Remove some saved scenes with images.');
      u.settings = settings;
    }
    await saveUser(u);
    return { user: pub(u) };
  },

  async password({ current, next }, u) {
    if (!(await checkPassword(u, current))) throw new HttpError(401, 'Your current password is not right.');
    await setPassword(u, next);
    await saveUser(u);
    return { token: await issueToken(u), user: pub(u) }; // this device stays signed in; others are signed out
  },

  async logout(_, u, token) { await store.pipe([['DEL', K.sess(token)]]); return { ok: true, id: u.id }; },

  async forgot({ email }, _u, _t, ctx) {
    email = normEmail(email);
    if (!mailReady) throw new HttpError(503, 'Password reset by email is not set up on this gather yet.');
    const [id] = await store.pipe([['GET', K.email(email)]]);
    if (id) {
      const token = crypto.randomBytes(32).toString('base64url');
      await store.pipe([['SET', K.reset(token), id, 'EX', RESET_TTL]]);
      const link = `${ctx.origin}/?reset=${token}`;
      await sendMail({
        to: email, subject: 'Reset your gather password',
        html: layout({ heading: 'Reset your password', lines: ['Someone asked to reset the password for this gather account. If that was you, use the button below. The link works for one hour.'], button: { href: link, label: 'Choose a new password' }, foot: 'If you didn’t ask for this, ignore this email. Your password stays the same.' }),
        text: `Reset your gather password (link valid for one hour): ${link}`,
      });
    }
    return { ok: true }; // same answer either way, so addresses can't be probed
  },

  async reset({ token, password }) {
    const [id] = await store.pipe([['GET', K.reset(String(token || ''))]]);
    if (!id) throw new HttpError(400, 'That reset link has expired. Ask for a new one.');
    const u = await loadUser(id);
    if (!u) throw new HttpError(400, 'That account no longer exists.');
    await setPassword(u, password);
    await saveUser(u);
    await store.pipe([['DEL', K.reset(String(token))]]);
    return { token: await issueToken(u), user: pub(u) };
  },

  async delete({ password }, u, token) {
    // Google-only accounts have no password: they confirm by typing their email instead.
    const ok = u.pass ? await checkPassword(u, password) : normEmail(password) === u.email;
    if (!ok) throw new HttpError(401, u.pass ? 'Your password is not right.' : 'Type your account email to confirm.');
    await store.pipe([['DEL', K.user(u.id), K.email(u.email), K.sess(token), ...(u.google ? [K.google(u.google)] : [])]]);
    return { ok: true };
  },
};
const PUBLIC = new Set(['signup', 'login', 'google', 'forgot', 'reset']);

async function handleAccount(action, body, ctx) {
  const fn = actions[action];
  if (!fn) throw new HttpError(404, 'Unknown account action.');
  if (PUBLIC.has(action)) return fn(body || {}, null, null, ctx);
  const u = await authUser(ctx.token);
  return fn(body || {}, u, ctx.token, ctx);
}

module.exports = { handleAccount, authUser, HttpError, esc };
