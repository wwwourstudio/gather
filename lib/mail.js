// Email through Resend (https://resend.com). Resend can hold an email and send it later
// (`scheduled_at`), so stream reminders need no cron job on Vercel.
// Needs RESEND_API_KEY. MAIL_FROM must use a domain verified in Resend, e.g. "gather <studio@yourdomain.com>".
const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM || 'gather <onboarding@resend.dev>';
const mailReady = !!KEY;

async function sendMail({ to, subject, html, text, scheduledAt }) {
  if (!KEY) throw Object.assign(new Error('Email is not set up yet. Add RESEND_API_KEY in Vercel.'), { status: 503 });
  const body = { from: FROM, to: [to], subject, html, text };
  if (scheduledAt) body.scheduled_at = new Date(scheduledAt).toISOString();
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Email failed: ${data?.message || res.status}`), { status: 502 });
  return data.id;
}

async function cancelMail(id) {
  if (!KEY || !id) return false;
  const res = await fetch(`https://api.resend.com/emails/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } });
  return res.ok;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A plain, readable email layout (inline styles, as mail clients require). */
function layout({ heading, lines = [], button, foot }) {
  const p = lines.map((l) => `<p style="margin:0 0 12px;font:15px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2a44">${l}</p>`).join('');
  const b = button ? `<p style="margin:22px 0"><a href="${esc(button.href)}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;font:600 15px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;padding:12px 20px;border-radius:10px">${esc(button.label)}</a></p>` : '';
  return `<div style="background:#eef3fb;padding:28px 12px"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:28px">
<p style="margin:0 0 18px;font:800 26px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0c1630;letter-spacing:-1px">gather<span style="color:#3b82f6">.</span></p>
<h1 style="margin:0 0 14px;font:700 20px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0c1630">${heading}</h1>${p}${b}
${foot ? `<p style="margin:18px 0 0;font:12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#7685a6">${foot}</p>` : ''}</div></div>`;
}

module.exports = { sendMail, cancelMail, mailReady, layout, esc };
