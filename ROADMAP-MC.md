# Roadmap Monte Carlo

20,000 simulated futures, seed 20261115, 10-day build budget. Re-run with `node scripts/roadmap-mc.ts`.

## Which service wins each job

| Job | Option | Wins its job | Mean value per build day |
|---|---|---|---|
| Connectivity (TURN relay) | Cloudflare Realtime TURN | 79% | 1.18 |
| Connectivity (TURN relay) | Metered.ca TURN | 19% | 0.54 |
| Connectivity (TURN relay) | Self-hosted coturn (VM) | 1% | 0.21 |
| Go live (RTMP relay) | gather relay: WebSocket + FFmpeg on Fly.io | 72% | 1.74 |
| Go live (RTMP relay) | MediaMTX (WHIP in, RTMP out) on Fly.io | 19% | 1.05 |
| Go live (RTMP relay) | Cloudflare Stream (WHIP in, simulcast out) | 4% | 0.20 |
| Go live (RTMP relay) | LiveKit Cloud (egress to RTMP) | 4% | 0.37 |
| Bigger studios (SFU) | Cloudflare Realtime SFU | 69% | 0.15 |
| Bigger studios (SFU) | LiveKit Cloud SFU | 31% | 0.06 |
| First run | In-app | 100% | 3.79 |
| AI without a key | House key on the server (Gemini or Claude), rate-limited | 100% | 2.00 |
| Recording | In-browser recording + Google Drive | 100% | 0.29 |
| Signaling | Cloudflare Durable Objects WebSockets | 100% | 0.41 |
| Audience | Embed of the YouTube/Twitch stream | 100% | 0.82 |

## What makes a 10-day plan

| Step | Service | In the plan | Usual order | Needs |
|---|---|---|---|---|
| First-run guide (name, camera check, invite, go live) | In-app | 98% | 1.4 | Nothing |
| AI works without your own key (daily allowance) | House key on the server (Gemini or Claude), rate-limited | 87% | 2.4 | A provider key in Vercel (owner pays or uses a free tier) |
| Public watch page | Embed of the YouTube/Twitch stream | 84% | 4.5 | Go live first |
| Built-in TURN | Cloudflare Realtime TURN | 78% | 3.7 | Free Cloudflare account; TURN key ID + API token in Vercel |
| Go live to platforms | gather relay: WebSocket + FFmpeg on Fly.io | 72% | 2.5 | Fly.io account (or any Docker host); RELAY_URL + RELAY_SECRET in Vercel |
| Built-in TURN | Metered.ca TURN | 19% | 3.8 | Metered account + API key |
| Go live to platforms | MediaMTX (WHIP in, RTMP out) on Fly.io | 19% | 2.8 | Fly.io account + dedicated IPv4 + UDP |
| Real-time signaling instead of polling | Cloudflare Durable Objects WebSockets | 13% | 4.4 | Cloudflare Workers paid plan ($5) |
| Separate high-quality track per guest (to Drive) | In-browser recording + Google Drive | 6% | 4.6 | GOOGLE_CLIENT_ID (already supported) |

## Assumptions

- **Cloudflare Realtime TURN** (Built-in TURN): reach 0.06–0.12–0.22, impact 8–9.5–10, works 0.88–0.95–0.99, 0.5–1–1.5 days, $0–0–2/month. $0.05/GB after 1,000 GB/month free (shared with the SFU).
- **Metered.ca TURN** (Built-in TURN): reach 0.06–0.12–0.22, impact 8–9.5–10, works 0.8–0.9–0.97, 0.5–1–1.5 days, $0–5–30/month. Small free allowance, then paid per GB; price not verified here.
- **Self-hosted coturn (VM)** (Built-in TURN): reach 0.06–0.12–0.22, impact 8–9.5–10, works 0.6–0.75–0.9, 1.5–2.5–4 days, $4–6–15/month. You run and patch a server.
- **gather relay: WebSocket + FFmpeg on Fly.io** (Go live to platforms): reach 0.55–0.75–0.92, impact 8–9–10, works 0.72–0.85–0.93, 2–3–4.5 days, $2–5–12/month. Browser sends the finished program (H.264 where the browser can) over WSS; FFmpeg copies video and pushes to every destination at once.
- **MediaMTX (WHIP in, RTMP out) on Fly.io** (Go live to platforms): reach 0.55–0.75–0.92, impact 8–9–10, works 0.5–0.68–0.82, 2.5–4–6 days, $4–7–14/month. Lower latency, but WebRTC on a PaaS needs UDP/ICE work; per-destination FFmpeg still needed for multistreaming.
- **LiveKit Cloud (egress to RTMP)** (Go live to platforms): reach 0.55–0.75–0.92, impact 8–9–10, works 0.65–0.78–0.88, 6–9–13 days, $0–25–90/month. Also brings an SFU and TURN, but means rewriting the call layer; egress beyond the free allowance is paid.
- **Cloudflare Stream (WHIP in, simulcast out)** (Go live to platforms): reach 0.55–0.75–0.92, impact 8–9–10, works 0.02–0.05–0.12, 1.5–2.5–4 days, $3–8–20/month. Cloudflare documents that WHIP (browser) inputs cannot be restreamed, so this fails without a relay anyway.
- **Cloudflare Realtime SFU** (Scale to 6–10 people): reach 0.15–0.3–0.45, impact 4–6–8, works 0.55–0.7–0.85, 6–8–12 days, $0–0–5/month. Free within the shared 1,000 GB; low-level sessions/tracks API, so a large client rewrite.
- **LiveKit Cloud SFU** (Scale to 6–10 people): reach 0.15–0.3–0.45, impact 4–6–8, works 0.65–0.78–0.9, 5–7–10 days, $0–10–50/month. Mature SDK; usage beyond the free plan is paid.
- **In-app** (First-run guide (name, camera check, invite, go live)): reach 0.7–0.9–1, impact 3–4.5–6, works 0.85–0.93–0.98, 0.5–1–1.5 days, $0–0–0/month. Cuts the dense first screen down to the next step.
- **House key on the server (Gemini or Claude), rate-limited** (AI works without your own key (daily allowance)): reach 0.5–0.7–0.85, impact 3–4.5–6, works 0.75–0.85–0.95, 0.5–1–1.5 days, $0–5–40/month. Costs whoever owns the key; capped per studio per day.
- **In-browser recording + Google Drive** (Separate high-quality track per guest (to Drive)): reach 0.15–0.3–0.45, impact 3–5–7, works 0.7–0.8–0.9, 3–4–6 days, $0–0–0/month. Paid on StreamYard.
- **Cloudflare Durable Objects WebSockets** (Real-time signaling instead of polling): reach 0.8–1–1, impact 1.5–2.5–4, works 0.6–0.75–0.88, 3–4–6 days, $0–5–5/month. Faster joins and fewer Vercel invocations.
- **Embed of the YouTube/Twitch stream** (Public watch page): reach 0.25–0.45–0.6, impact 2–3.5–5, works 0.75–0.88–0.95, 1–1.5–2.5 days, $0–0–0/month. Only useful once going live works.

## Sources

- Cloudflare TURN pricing and free allowance: https://developers.cloudflare.com/realtime/turn/faq/ and https://developers.cloudflare.com/realtime/sfu/pricing
- Cloudflare Stream WebRTC limits (no restreaming for WHIP inputs): https://developers.cloudflare.com/stream/webrtc/ and https://developers.cloudflare.com/changelog/post/2026-10-15-stream-live-webrtc-ga/
- Cloudflare Stream simulcasting: https://developers.cloudflare.com/stream/stream-live/simulcasting
- Cloudflare Stream pricing: https://developers.cloudflare.com/stream/pricing
- LiveKit Cloud pricing and quotas: https://livekit.io/pricing and https://docs.livekit.io/deploy/admin/quotas-and-limits/
- YouTube/Twitch ingest is RTMP(S)/HLS only, so a browser needs a relay: https://www.forasoft.com/blog/article/whip-whep-replace-rtmp-live-streaming-2026
- Fly.io, Metered and Durable Objects costs are estimates (not verified in this session); their ranges are wide.
