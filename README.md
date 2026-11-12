# gather — the conversation studio

A browser studio for up to six people: live video over WebRTC, a composited 16:9 stage,
host-controlled layouts, banners, a scrolling ticker, branding, studio chat and one-click recording.

## Deploy to Vercel

1. Import this repository in Vercel (**Add New → Project**). No build settings are needed;
   `vercel.json` serves `public/` and the `api/` function.
2. In the project, open **Storage → Create Database → Upstash (Redis)**, create a free database and
   **connect it to the project**. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. **Redeploy** (Deployments → ⋯ → Redeploy) so the function picks up the new variables.

Open the deployment URL, create a studio, and send the invite link to a second device.
Until Redis is connected, joining shows "Studio storage is not set up" instead of failing silently.

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

Shortcuts: M mute · V camera · S share · R record · 1/2/3 layouts · F full screen · / chat.
