// gather streams: go live now or schedule, with emailed invites and reminders.
// Reminders are scheduled with Resend's `scheduled_at` (up to 30 days ahead), so no cron job is needed.
const crypto = require('crypto');
const { store } = require('./store');
const { sendMail, cancelMail, mailReady, layout, esc } = require('./mail');
const { HttpError } = require('./accounts');

const MAX_AHEAD = 29 * 864e5; // Resend schedules at most 30 days ahead
const K = { s: (id) => `str:${id}`, list: (uid) => `str:list:${uid}`, thumb: (id) => `str:t:${id}` };
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f<>]/g, '').trim().slice(0, n);
const parse = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };
const rid = (n) => crypto.randomBytes(n).toString('hex');
const DESTS = new Set(['youtube', 'twitch', 'facebook', 'linkedin', 'x', 'instagram', 'tiktok', 'kick', 'rumble', 'custom']);

function fmtWhen(ms, tz) {
  try { return new Date(ms).toLocaleString('en-US', { timeZone: tz || 'UTC', dateStyle: 'full', timeStyle: 'short', timeZoneName: 'short' }); }
  catch { return new Date(ms).toUTCString(); }
}
function ics(s, link) {
  const d = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escI = (t) => String(t).replace(/[\\,;]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//gather//studio//EN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${s.id}@gather`, `DTSTAMP:${d(Date.now())}`, `DTSTART:${d(s.when)}`, `DTEND:${d(s.when + (s.duration || 60) * 60000)}`,
    `SUMMARY:${escI(s.title)}`, `DESCRIPTION:${escI((s.description ? s.description + '\n\n' : '') + 'Join the studio: ' + link)}`, `URL:${link}`,
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Starting soon', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
const pub = (s) => ({ id: s.id, title: s.title, description: s.description, when: s.when, tz: s.tz, duration: s.duration, studio: s.studio, invites: s.invites, destinations: s.destinations, status: s.status, hasThumb: !!s.hasThumb, createdAt: s.createdAt, mail: s.mail });

async function loadStream(id) { const [raw] = await store.pipe([['GET', K.s(id)]]); return parse(raw); }
async function saveStream(s) { await store.pipe([['SET', K.s(s.id), JSON.stringify(s), 'EX', 90 * 86400]]); }
async function own(id, user) {
  const s = await loadStream(String(id || ''));
  if (!s || s.owner !== user.id) throw new HttpError(404, 'That stream was not found.');
  return s;
}

/** Invite now + reminders 24 hours and 15 minutes before, for every invitee and the host. */
async function scheduleMails(s, user, origin) {
  const link = `${origin}/s/${s.studio}`;
  const when = fmtWhen(s.when, s.tz);
  const people = [...new Set([...s.invites, user.email])];
  const out = { sent: 0, scheduled: 0, failed: 0, ids: [] };
  const now = Date.now();
  const reminders = [[24 * 3600e3, 'tomorrow'], [15 * 60e3, 'in 15 minutes']].filter(([before]) => s.when - before > now + 5 * 60e3);
  for (const to of people) {
    const isHost = to === user.email;
    try {
      if (!isHost) {
        const html = layout({
          heading: `You're invited: ${esc(s.title)}`,
          lines: [`${esc(user.name)} invited you to join a live conversation on gather.`, `<b>${esc(when)}</b>`, s.description ? esc(s.description) : '', 'Open the link at the start time to check your camera and step into the studio. No account or download needed.'].filter(Boolean),
          button: { href: link, label: 'Open the studio' },
          foot: `Studio code: ${esc(s.studio)}`,
        });
        await sendMailWithIcs({ to, subject: `You're invited: ${s.title}`, html, text: `${user.name} invited you to "${s.title}" on ${when}. Join: ${link}`, s, link });
        out.sent++;
      }
      for (const [before, label] of reminders) {
        const id = await sendMail({
          to, scheduledAt: s.when - before,
          subject: `Starting ${label}: ${s.title}`,
          html: layout({ heading: `${esc(s.title)} starts ${label}`, lines: [`<b>${esc(when)}</b>`, isHost ? 'You’re hosting. Open your studio a few minutes early to set the scene.' : `${esc(user.name)} is looking forward to having you.`], button: { href: link, label: isHost ? 'Open your studio' : 'Join the studio' } }),
          text: `"${s.title}" starts ${label} (${when}). ${link}`,
        });
        out.ids.push(id); out.scheduled++;
      }
    } catch (e) { out.failed++; out.error = e.message; }
  }
  return out;
}
async function sendMailWithIcs({ to, subject, html, text, s, link }) {
  // Resend accepts attachments as base64 content.
  const KEY = process.env.RESEND_API_KEY;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM || 'gather <onboarding@resend.dev>', to: [to], subject, html, text,
      attachments: [{ filename: 'gather-stream.ics', content: Buffer.from(ics(s, link)).toString('base64') }] }),
  });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(`Email failed: ${d?.message || res.status}`); }
}

function readInput(b) {
  const title = clean(b.title, 100);
  if (!title) throw new HttpError(400, 'Give your stream a title.');
  const invites = [...new Set(String(Array.isArray(b.invites) ? b.invites.join(',') : b.invites || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const bad = invites.find((e) => !/^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i.test(e));
  if (bad) throw new HttpError(400, `“${bad}” is not a valid email address.`);
  if (invites.length > 20) throw new HttpError(400, 'Invite up to 20 people per stream.');
  return {
    title, description: clean(b.description, 1000), invites,
    tz: clean(b.tz, 60) || 'UTC', duration: Math.min(600, Math.max(15, Number(b.duration) || 60)),
    destinations: (Array.isArray(b.destinations) ? b.destinations : []).filter((d) => DESTS.has(d)).slice(0, 10),
  };
}

const actions = {
  async streamCreate(b, user, ctx) {
    const input = readInput(b);
    const now = Date.now();
    const when = b.when ? Number(b.when) : 0;
    if (when) {
      if (!Number.isFinite(when) || when < now + 60e3) throw new HttpError(400, 'Pick a start time at least a minute from now, or go live now.');
      if (when > now + MAX_AHEAD) throw new HttpError(400, 'You can schedule up to 29 days ahead.');
    }
    const s = { id: rid(8), owner: user.id, ...input, when: when || now, status: when ? 'scheduled' : 'live', studio: 'gather-' + rid(6), createdAt: now, mail: null, mailIds: [] };
    if (b.thumb) {
      const t = String(b.thumb);
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(t) || t.length > 900_000) throw new HttpError(400, 'Thumbnails must be PNG, JPEG or WebP under about 600 KB.');
      await store.pipe([['SET', K.thumb(s.id), t, 'EX', 90 * 86400]]);
      s.hasThumb = true;
    }
    if (when && b.notify !== false) {
      if (!mailReady) s.mail = { skipped: 'Email is not set up yet, so no invites or reminders were sent.' };
      else { const r = await scheduleMails(s, user, ctx.origin); s.mailIds = r.ids; s.mail = { sent: r.sent, scheduled: r.scheduled, failed: r.failed, error: r.error }; }
    }
    await saveStream(s);
    await store.pipe([['RPUSH', K.list(user.id), s.id], ['LTRIM', K.list(user.id), -100, -1], ['SET', `g:${s.studio}:reserved`, user.id, 'EX', 31 * 86400]]);
    return { stream: pub(s) };
  },

  async streamList(_, user) {
    const [ids] = await store.pipe([['LRANGE', K.list(user.id), 0, -1]]);
    const rows = [];
    for (const id of (ids || []).slice(-50)) { const s = await loadStream(id); if (s) rows.push(pub(s)); }
    rows.sort((a, b) => a.when - b.when);
    return { streams: rows, mailReady };
  },

  async streamUpdate(b, user, ctx) {
    const s = await own(b.id, user);
    if (s.status === 'cancelled' || s.status === 'ended') throw new HttpError(400, 'That stream is over.');
    const input = readInput({ ...s, ...b });
    Object.assign(s, input);
    if (b.thumb !== undefined) {
      if (b.thumb) { await store.pipe([['SET', K.thumb(s.id), String(b.thumb).slice(0, 900_000), 'EX', 90 * 86400]]); s.hasThumb = true; }
      else { await store.pipe([['DEL', K.thumb(s.id)]]); s.hasThumb = false; }
    }
    if (b.when && Number(b.when) !== s.when && s.status === 'scheduled') {
      const when = Number(b.when);
      if (when < Date.now() + 60e3 || when > Date.now() + MAX_AHEAD) throw new HttpError(400, 'Pick a time between a minute and 29 days from now.');
      for (const id of s.mailIds || []) await cancelMail(id);
      s.when = when;
      if (mailReady) { const r = await scheduleMails(s, user, ctx.origin); s.mailIds = r.ids; s.mail = { sent: r.sent, scheduled: r.scheduled, failed: r.failed, error: r.error }; }
    }
    await saveStream(s);
    return { stream: pub(s) };
  },

  async streamCancel(b, user) {
    const s = await own(b.id, user);
    for (const id of s.mailIds || []) await cancelMail(id);
    s.mailIds = []; s.status = 'cancelled';
    if (b.notify && mailReady) {
      for (const to of s.invites) {
        await sendMail({ to, subject: `Cancelled: ${s.title}`, html: layout({ heading: `${esc(s.title)} is cancelled`, lines: [`${esc(user.name)} cancelled this stream. Any reminders you were due to get won’t arrive.`] }), text: `"${s.title}" was cancelled.` }).catch(() => {});
      }
    }
    await saveStream(s);
    return { stream: pub(s) };
  },

  async streamStart(b, user) {
    const s = await own(b.id, user);
    s.status = 'live';
    await saveStream(s);
    return { stream: pub(s) };
  },
  async streamEnd(b, user) {
    const s = await own(b.id, user);
    s.status = 'ended';
    await saveStream(s);
    return { stream: pub(s) };
  },

  /** Public: the thumbnail and title of a stream (used by invite links and the wizard preview). */
  async streamThumb(b) {
    const id = String(b.id || '').replace(/[^a-f0-9]/g, '');
    const [t] = await store.pipe([['GET', K.thumb(id)]]);
    if (!t) throw new HttpError(404, 'No thumbnail.');
    return { data: t };
  },
};
const PUBLIC = new Set(['streamThumb']);

module.exports = { streamActions: actions, STREAM_PUBLIC: PUBLIC };
