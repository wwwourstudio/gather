# gather — the conversation studio

A browser studio for up to six people: live video over WebRTC, a composited 16:9 stage,
host-controlled layouts, banners, a scrolling ticker, branding, studio chat and one-click recording.

## What's inside

- **Scenes:** one-click scene strip (number keys 1–9) with presets for interviews, panels, presentations, AI research and chat. Build your own on the stage by dragging and resizing elements, and save them as scenes.
- **Presenting:** share a screen (with its sound), play a video file, or present PDF slides with ← / →. Cameras stay live on a second track, and the stage switches to a presentation scene by itself.
- **On-air AI:** research live with your own Claude, ChatGPT, Gemini or Grok API key, and put the answer on screen as it streams. Claude and Gemini can search the web.
- **Platform chat:** Twitch and Rumble chat in studio chat and in the on-stage overlay, with host moderation (hide, time out, block).
- **Support links:** PayPal, Venmo, Cash App, Stripe, Ko-fi, Patreon and Buy Me a Coffee as scannable QR cards on stage.
- **Accounts:** email + password (scrypt), nickname and photo, password change and reset, and settings that follow you between devices.
- **Start a stream:** go live now or schedule up to 29 days ahead, with emailed invites, a calendar file, and reminders a day and 15 minutes before. Scheduled studios keep the host seat for their owner.
- **Thumbnails:** design one from your camera and headline, generate an AI background with your own ChatGPT, Gemini or Grok key, or upload your own.
- **Camera and mic:** AI noise removal (RNNoise), echo cancellation, gain, light correction, background blur or replacement (MediaPipe), and a chroma-key green screen.
- **Live captions** in 14 languages, **vertical 9:16** scenes for TikTok, Reels and Shorts, a guest view without host controls, and searchable help that jumps to the exact setting.
- **Profile photos** for guests whose camera is off, banners, a ticker, brand colours and stage backgrounds, and recording to a local video file.

## Deploy to Vercel

1. Import this repository in Vercel (**Add New → Project**). No build settings are needed;
   `vercel.json` serves `public/` and the `api/` function.
2. In the project, open **Storage**, create a Redis database (Upstash, free plan is fine) and
   **connect it to the project**. Any of these variables works, whichever Vercel adds:
   `KV_REST_API_URL` + `KV_REST_API_TOKEN`, `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or `REDIS_URL`.
3. **Redeploy** (Deployments → ⋯ → Redeploy) so the function picks up the new variables.
4. Check it: open `https://<your-app>.vercel.app/api/studio?action=config`. You want `"ok": true`.
   If not, `problem` says what's wrong and `envDetected` lists which variable names the function can see.

Open the deployment URL, create a studio, and send the invite link to a second device.
Any setup problem also appears in red in the "Step into the studio" dialog.

### Email (invites, reminders, password reset)

gather sends email through [Resend](https://resend.com) and schedules reminders with Resend's `scheduled_at`, so no cron job is needed.

| Variable | Example | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | `re_…` | From resend.com → API Keys |
| `MAIL_FROM` | `gather <studio@yourdomain.com>` | Optional for testing (Resend's test sender only reaches your own Resend email); to email viewers, verify a domain in Resend and set this |
| `APP_URL` | `https://gather-gold-nine.vercel.app` | Optional on Vercel (production uses its domain, previews their branch address). Used in email links; it never uses the request's Host header, so set it on any other host or emails are switched off |
| `INVITES_PER_DAY` | `60` | Optional. How many invite emails one account can send per day (anti-spam) |

Without these, accounts, scheduling and everything else still work; the app says plainly that emails were not sent.

Optional environment variables, for guests on strict corporate or mobile networks:

| Variable | Example |
| --- | --- |
| `TURN_URL` | `turn:turn.example.com:3478` (comma-separate several) |
| `TURN_USER` | short-lived username |
| `TURN_PASS` | short-lived credential |

Guests can also enter their own TURN details under Settings (kept for that browser session only).

## Run locally

    npm start            # http://localhost:8080 — no install needed, no database needed

Open two tabs, create a studio in one, and join with the code or invite link in the other.
Locally the studio state lives in memory. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN` to use Redis instead.
Camera and screen capture need **HTTPS or localhost**.

## How it works

- **Signaling over HTTP.** Vercel functions can't hold WebSockets open, so `lib/studio.js` is a
  stateless handler over Redis. Each participant has a private inbox list. The browser polls it every
  300 ms while connections are being set up and about once a second after that, and every 2.5 s when the tab is hidden.
  Outgoing messages (ICE candidates, chat, stage changes) are batched into single requests.
  `server.js` runs the same handler for local use.
- **Presence.** Every fourth second a poll doubles as a heartbeat. Anyone silent for 20 s is removed,
  and hosting passes to the longest-standing guest. Closing the tab sends a leave beacon right away.
  If a laptop sleeps and its seat expires, the page rejoins the studio by itself.
- **Media is peer-to-peer.** Full mesh: the newest participant offers to everyone already present, so
  offers never collide. Mic, camera, device and screen-share changes use `replaceTrack`, so there is no renegotiation.
  A failed connection triggers an ICE restart.
- **The stage is a `<canvas>`** drawn every frame from everyone's video. That same canvas plus a Web Audio
  mix of all participants feeds `MediaRecorder`, so a recording matches the stage exactly.

### Redis usage

An idle participant costs about one Redis command per second. A one-hour session with six people
uses roughly 25–30k commands. Studios expire after six hours without activity.

### On-air AI keys

Each host pastes their own provider key in the AI panel. It is kept in that browser's local storage and sent with each question through `/api/ai` to the provider; gather never stores or logs it. Claude requests use the official Anthropic SDK with web search and server-side refusal fallback.

### Third-party code

pdf.js and qrcode-generator are served from `public/vendor/` (licences in `public/vendor/LICENSES.md`).

Shortcuts: M mute · V camera · S share screen · ← → slides · 1–9 scenes · R record · F full screen · / chat.
