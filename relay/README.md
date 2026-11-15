# gather relay

YouTube, Twitch, Kick, Facebook and the rest only accept video over RTMP(S), and browsers can't send RTMP.
This small service sits in between: the host's browser sends the finished show to it over a secure WebSocket,
and FFmpeg forwards it to every destination at once. When the browser can encode H.264 (Chrome, Edge), the video
is passed through untouched, so the smallest machine is enough. Other browsers send VP8, which the relay re-encodes.

- Only gather can start a stream. The host's browser presents a two-minute token signed with `RELAY_SECRET`,
  which gather's server issues to the studio's host only.
- Stream keys go from the host's browser straight to this relay and on to the platform. They are never stored,
  never sent to gather's server and never logged (`[relay]` log lines redact them).

## Deploy on Render (free, one click)

`render.yaml` at the repo root describes the relay. In Render: **New → Blueprint**, pick this repository and paste the
`RELAY_SECRET` it asks for (the same value as `RELAY_SECRET` in Vercel), then **Apply**. When it's live, set
`RELAY_URL` in Vercel to the service's `https://….onrender.com` address and redeploy gather.

The free plan sleeps after 15 minutes without traffic and takes up to a minute to wake, so open the Go live dialog a
minute before you start. It has little CPU: fine for Chrome and Edge (video is passed through), too slow for re-encoding.

## Deploy on Fly.io (about $2–5 a month; the machine sleeps when nobody is live)

1. Install `flyctl` and sign in (`fly auth login`).
2. From this folder:

   ```bash
   fly launch --copy-config --no-deploy --name <your-relay-name>
   ```

3. Make a secret and give it to the relay. Keep the value for step 5:

   ```bash
   openssl rand -hex 24
   ```

   ```bash
   fly secrets set RELAY_SECRET=<that value>
   ```

4. Deploy, then check `https://<your-relay-name>.fly.dev/health` says `{"ok":true,…}`:

   ```bash
   fly deploy
   ```

5. In Vercel, under Project → Settings → Environment Variables, add:
   - `RELAY_URL` = `https://<your-relay-name>.fly.dev`
   - `RELAY_SECRET` = the same value as step 3

   Then redeploy gather. The Stream tab shows **Go live** once both are set.

Any Docker host works too (Railway, Render, a VPS). Build the `Dockerfile`, set `RELAY_SECRET`, expose port 8080 over HTTPS.

## Settings

| Variable | Default | |
|---|---|---|
| `RELAY_SECRET` | required | 24+ characters, the same value as gather's `RELAY_SECRET` |
| `RELAY_MAX_STREAMS` | 3 | Shows at once; each copy-through stream needs very little CPU |
| `RELAY_TRANSCODE` | `auto` | `always` re-encodes every stream to H.264 4.5 Mbit/s (needs `shared-cpu-2x` or larger) |
| `PORT` | 8080 | |

## Bandwidth

A 1-hour show at about 4.5 Mbit/s is roughly 2 GB in and 2 GB out for each destination. Two destinations make
roughly 6 GB in total.
