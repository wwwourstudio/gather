# gather — the conversation studio

A browser studio for up to six people: live video over WebRTC, a composited 16:9 stage,
host-controlled layouts, banners, a scrolling ticker, branding, studio chat and one-click recording.

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
