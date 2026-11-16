# V5 audit 3: side panels, dialogs, going live, integrations, server API

Auditor 3 of 4. Tested locally (production unreachable):

- gather on :8103 with `ALLOW_ANON_STUDIOS=1`, `RELAY_URL` and `RELAY_SECRET` set.
- The relay from `relay/` on :8126 with real FFmpeg, feeding local FFmpeg RTMP listeners.
- **Relay dependency:** `relay/node_modules` is not installed in this sandbox, so `require('ws')` fails. I ran the relay through a test-only `NODE_PATH` shim that re-exports Playwright's bundled `ws`. No app code was changed.
- Browsers: Playwright Chromium with fake media.
- Screenshots: `audit/v5/shots/panels/`.
- Scripts: `/tmp/claude-0/-home-user-gather/0c2621ff-ea6b-5d46-b42f-d9d837e41814/scratchpad/a3/`. The main ones are `api.js`, `p1.js`–`p6.js`, `relaytest*.js` and `dbg*.js`.

## Test-suite baseline (`npm test`, run once)

| Suite | First run (4 auditors running in parallel) | Rerun alone |
|---|---|---|
| ai, acct, turn, e2e, feat, mod, twitch, round6, google | ✓ | – |
| live | ✗ `Cannot find module 'ws'`: relay deps aren't installed in the sandbox | **✓ all 11 checks pass** with the `ws` shim |
| round | ✗ waitForFunction timeout (step 4) | ✓ |
| round4 | ✗ screenshot timeout (step 8) | ✓ |
| round5 | ✗ click timeout `#grFx` | ✓ |

**Result:** 9 of 13 suites passed on the first run. The 4 failures were caused by the environment or by timing under CPU load, not by the code. Two follow-ups:

- **The suites are fragile under load.** The round, round4 and round5 failures were timeouts.
- **`tests/out` is shared.** `npm test` deletes `tests/out` at startup, so parallel runs clobber each other's logs.

---

## 1. Working (verified)

**Rail panels and dialogs**
- Rail tabs Chat, Show, Look (Layout ⇄ Brand) and AI render at 1440 px and 390 px. There is no horizontal overflow on phones.
  - Shots: `host-tab-*.png`, `mobile-*.png`.
- Guests see only Chat, with no rail. The host-only tabs and the Go live button are hidden from them.
  - Shot: `guest-view.png`.

**Chat**
- A message containing `<img onerror>`, `javascript:` and a quote-breaking URL rendered inert.
  - The server strips `<>`, and the client builds the message with text nodes and `<a rel="noopener noreferrer">` links.
  - No alert fired in either browser.

**Show**
- These all sync to the guest and toggle back off:
  - banner show/hide;
  - the "Live · edited" pill;
  - banner presets;
  - ticker run/stop;
  - captions, including language and style;
  - the chat overlay;
  - the call-in card (QR, headline, phone);
  - "Guests go straight on stage".

**Look → Layout**
- 8 templates are listed.
- All 8 "Add to stage" elements were added, and the layer list, props panel, Delete, edit mode and Reset scene all work.
- Saving a scene adds it to the scene strip.
- Media library:
  - rejects `javascript:` links;
  - accepts a YouTube link;
  - accepts a PDF.

**Look → Brand**
- These all reached the guest: colour, background, font, name tags, banner style, animation, title, solid panels, frame, names off, logo upload and position, and sponsor image upload.
  - Shots: `look-brand-applied.png`, `guest-sees-brand.png`.
- Support-link cards force an `https://` URL.

**AI panel without keys (degrades gracefully)**
- With no key, asking a question shows "Add your Claude key so Sam can help." and opens the setup panel.
- A bad key gives "Claude rejected the API key. Check it in the AI panel."
- The Stream voice test without an OpenAI key gives a clear note.
- The wake-word toggle works.
- `/api/ai` returns clear 400s for:
  - a missing key;
  - a house allowance that isn't configured;
  - Claude asked for images;
  - an unknown mode.

**Settings**
- Theme, devices and the camera and background sections render.
- Rumble:
  - a bad URL is refused client-side;
  - a valid-looking URL that can't be reached shows "Could not reach Rumble. Try again in a moment.";
  - after connecting, the URL is masked;
  - Disconnect works.
- When Google isn't configured on the server, YouTube Connect and "Save to Drive" are disabled and say why.

**Help**
- Search works: "echo" and "twitch" return results, and "zzzz" shows the empty state.
- Clicking a result opens the right dialog:
  - the TURN result opens Settings, expands the `<details>` and focuses `#turnUrl`;
  - the thumbnail result opens Go live and then the wizard.
- The tour starts.

**Going live, end to end, with real FFmpeg**
- The host typed a destination and went live in about 3.8 s.
- The local RTMP listener received H.264 and AAC (`ffprobe`: h264 + aac, 42 s).
- The header pill shows "Live 00:06" and counts up. Stats show the platform names and kbps.
- "End the stream" stops it, and the watch page returns to "Not live".
- `live.test.js` passes, including two destinations at once (both received 59 s of H.264/AAC).

**Relay and stream-key protection**
- The relay refuses connections with no token, a forged token or an expired token.
- It refuses non-rtmp destinations with a clear error (close code 4001).
- Stream keys never reach gather's server, and the relay log redacts them as `/•••`. This held for single and tee outputs and for failed destinations.
- The public `watch` action never returns keys.

**Auth checks on host-only actions**
- A guest is refused (403, or an error result) for: `state`, `relay`, `kick`, `mute`, `admit` and `lobbyList`.
- `feed` and `ai` ops from a guest are silently dropped.
- Someone squatting a reserved (scheduled) studio is not made host and can't get a relay token.

**Input validation**
- The stage state is cleaned on the server: the `live.links` `javascript:` value, the tip `javascript:` URL and unknown element types were all removed.
- Login is rate-limited: the 11th attempt gets a 429.
- Signup refuses a missing terms agreement and short passwords.
- Stream create refuses more than 20 invites.

**Leave**
- The Leave dialog lists what will be lost: "end the live stream, hand the studio to your guest".

**Moderation**
- `mod.test.js` passes: block, timeout, hide and restore, synced to guests.
- In my own run, a host block of a studio user hid their messages for other guests.

---

## 2. Broken (all reproduced)

### B1 — P1: Stream-key field loses what you typed when anyone joins or leaves
- **Repro:**
  1. Open Go live and add YouTube.
  2. Click into "Stream key" and type `partial-key`.
  3. A guest joins.
- **Expected:** what you typed and the focus stay.
- **Actual:** the field is emptied (`""`) and focus goes to `BODY`.
- **Cause:** every `renderAll()` call (on peer-joined, peer-left, state or host messages) runs `renderLive()` → `renderDests()`. That rebuilds the whole list with `innerHTML`, and values are only saved on `change`.
- **Code:** `public/app.js:3176-3196` (`renderDests`), `3221`, `3429`.
- **Shot:** `golive-dest.png` (taken after re-entry).

### B2 — P1: Every error shown while a dialog is open is invisible
- **What:** toasts render in the fixed `#toasts` div, which sits under the modal `<dialog>` top layer.
- **Errors affected include:**
  - "The stream stopped: lost the connection to the relay";
  - relay warnings such as a failed destination;
  - "Stream ended";
  - "Add a destination…";
  - Rumble, Twitch and TURN messages in Settings.
- **Repro:**
  1. Go live with the Go live dialog open.
  2. Kill the relay.
- **Expected:** a visible error.
- **Actual:** the toast is in the DOM but hidden behind the dialog. It expires after 3.2 s.
- **Code:** `public/app.js:95-103` (`toast`), `public/style.css:509`.
- **Shot:** `golive-relay-died.png` (the dialog shows no error although the toast fired).

### B3 — P1: A failed destination is still reported as live
- **Repro:** go live with two destinations, Twitch (reachable) and YouTube (nothing listening).
- **Expected:** "Live on Twitch; YouTube failed (connection refused)".
- **Actual:** the toast says "You're live on Twitch and YouTube." and the stats say "Live on Twitch, YouTube · 558 kbps".
  - The relay sends raw FFmpeg warnings, such as `[tee @ 0x55…] Slave '[f=flv:onfail=ignore]rtmp://…/•••' error opening`, and those are hidden by B2.
  - There is no per-destination status.
- **Code:**
  - relay: `relay/server.js:75`, `:92`;
  - client: `public/app.js:3249-3253`, `3229`.
- **Shot:** `golive-one-dest-dead.png`.

### B4 — P1: The watch page shows "Live" forever after the host leaves while live
- **Repro:**
  1. Host is live with a guest present.
  2. Host clicks Leave → Leave.
- **Expected:** `state.live` is cleared and the watch page shows "Not live".
- **Actual:** 6 s later, and indefinitely, `action=watch` still returns `live.on: true`.
  - The watch page shows "Live · 00:14" and keeps counting.
  - The new host (the old guest) has `state.live` set but no stream, and their Go live button shows "Go live".
- **Cause:** `leave()` clears `S.studio` and `S.host` before `endLive()` runs. `endLive()` then calls `setStage({live:null})`, which bails out because the user is no longer the host.
  - The same happens when the host's tab crashes or is closed.
  - The server never expires `live`.
- **Code:** `public/app.js:3291`, `3909-3926`; `lib/studio.js:124-130` (no server-side expiry).
- **Shot:** `watch-after-host-left.png`.

### B5 — P1: A bad TURN URL, or a TURN URL without credentials, silently breaks all video for that user
- **Repro:**
  1. In Settings → Your own relay server (TURN), enter `not a url`, or `turn:127.0.0.1:3478` with no username.
  2. Join a studio.
- **Expected:** a validation error, or the bad entry is ignored.
- **Actual:**
  - The user's peer connection is never created (`no pc`), and there is no error or toast.
  - The header says "Offline" while chat works.
  - The host's tile shows "Connecting…" forever.
  - With TURN empty, the same flow connects (`connected`).
- **Cause:** the `RTCPeerConnection` constructor throws on invalid `iceServers`. `iceConfig()` doesn't validate the URL or require credentials for `turn:`.
- **Code:** `public/app.js:551-555`, `669`, `3892-3895`.
- **Shots:** `turn-not_a_url.png`, `turn-turn_127_0_0_1_3478.png`, `turn-none.png`.

### B6 — P1: Go live hangs on "Connecting…" forever when the relay doesn't answer
- **Why it matters:** this is a Render free-plan cold start.
- **Repro:** set `RELAY_URL` to a TCP port that accepts connections but never responds, then click Go live.
- **Expected:** a "waking the relay…" state, then a timeout with a clear error and a retry.
- **Actual:**
  - At 5, 30 and 75 s the phase is still `connecting`.
  - The button says "Connecting…" and is still clickable (clicking it just calls `stopLive`).
  - The pill says "Starting…".
  - There is no timeout and no warm-up ping when the dialog opens. The README tells the owner to open the dialog a minute early, but the app never pings the relay.
- **Code:** `public/app.js:3231-3262` (no connect timeout).
- **Shot:** `golive-stuck-connecting.png`.

### B7 — P2: Closing the tab while live gives no warning
- **Repro:**
  1. Go live solo (no guests).
  2. Close the tab.
- **Result:** no `beforeunload` prompt. The control case, recording solo, does prompt.
- **Cause:** the condition is `S.rec || S.peers.size`. It is missing `S.live`.
- **Code:** `public/app.js:3929`.

### B8 — P2: Twitch connection failures are never surfaced
- **Repro:** connect Twitch where the WebSocket is blocked (as it is in this sandbox).
- **Actual:** the status stays "Reconnecting…" at 2, 8 and 20 s and forever. It retries with backoff indefinitely, spams the console, and never says "can't reach Twitch chat (blocked network?)".
- **Code:** `public/app.js:1113-1150`.
- **Shot:** `settings-twitch-blocked.png`.

### B9 — P2: Moderation can be dodged by renaming, and a guest can post as "Host"
- **Repro:**
  1. The host blocks the studio guest "Troll".
  2. Troll renames to "Troll2" in Settings and posts again.
- **Actual:**
  - The new messages are not moderated (`troll2:false`).
  - Another guest renamed to "Host" posts "I am the host, send me your stream key", and it shows as **Host** with no badge.
- **Cause:** blocks are keyed on the display name, and the server allows any name, duplicates included.
- **Code:** `public/app.js:1171-1188`; `lib/studio.js:381`.
- **Shot:** `mod-rename-bypass.png`.

### B10 — P2: The local or self-hosted server crashes on a malformed URL
- **Repro:** `curl http://localhost:8103/%E0%A4%A`.
- **Actual:** the process exits with an uncaught `URIError` from `decodeURIComponent`, and every later request fails.
  - Vercel is not affected, but Docker, Render and other self-hosts are.
  - `watch.js:4` has the same unguarded `decodeURIComponent`, so `/w/%E0` breaks the watch page.
- **Code:** `server.js:45`, `public/watch.js:4`.

### B11 — P3: Angle brackets are silently deleted from chat, banners, titles and names
- **Example:** `Breaking <b>news</b>` → `Breaking bnews/b`, and "3 < 5" → "3  5".
- **Cause:** `clean()` strips `<>` instead of storing the text raw (the client already renders with textContent).
- **Code:** `lib/studio.js:58`, `lib/accounts.js:24`.

### B12 — P3: Stale copy from the V4 navigation change

| Says | Should say | Where (`public/app.js` unless noted) |
|---|---|---|
| "Connect YouTube in the **Stream tab**" | Settings → Connections | `1195` |
| "Connect Twitch in the **Chat panel**" | Settings → Connections | `1948` |
| "Shows the banner from the **Banners panel**" | Show | `1972` |
| "Shows live captions when they're on (**Stream tab**)" | Show | `1972` |
| "**Move it in Layouts.**" | Look → Layout | tip toast |
| Empty Upcoming list: "Use **Start a stream** to plan one" | The button is "Plan a stream" | `index.html:498` |

### B13 — P3: Help search finds nothing for "stream key"
- Searching "stream key" gives "Nothing matches". There's no help entry for destinations, stream keys or RTMP.
- The "Go live or schedule a stream" result opens the scheduling wizard, not the destinations list.
- **Code:** `public/app.js:3096-3121`.

### B14 — P3: Odd values are turned into odd links instead of being rejected
- A watch link of `javascript:alert(1)` is published as `https://javascript:alert(1)`.
- A PayPal tip of `javascript:alert(1)` becomes `https://paypal.me/javascript:alert(1)`.
- Both are harmless but junk. Validate and show an error instead.
- **Code:** `public/app.js:3204-3208` (`watchUrl`).

### B15 — P3: A non-numeric `when` in streamCreate starts the stream now
- `streamCreate` with `when:"abc"` silently creates a stream that is live now, when it should return a 400.
- **Code:** `lib/streams.js:296`.

---

## 3. Security findings

| # | Severity | Finding | Evidence / location |
|---|---|---|---|
| S1 | **P1 (abuse)** | **Invite email is an open spam relay.** Signup has no email verification and no rate limit. Then each `streamCreate` emails up to 20 arbitrary addresses, from the site's Resend domain, with an attacker-chosen title and description, and there is no limit on the number of streams. | `lib/accounts.js:65`, `lib/streams.js:293-315` |
| S2 | P2 | **Poisoned password-reset link.** When `APP_URL` is unset, the reset link is built from the `X-Forwarded-Host`/`Host` header, so an attacker can make the victim's reset email point to their own host and capture the token. **Fix:** require `APP_URL` for mail. Not exploited here (mail not configured), but it is plain in the code. | `api/account.js:5-10`, `lib/accounts.js:157` |
| S3 | P2 | **Pre-account takeover through Google linking.** An attacker signs up with the victim's email and a password (no verification). When the victim later uses "Sign in with Google", the Google identity is linked to the attacker-created account, and the attacker's password still works. | `lib/accounts.js:105-117` |
| S4 | P2 | **The house AI allowance can be drained without an account or studio.** `spendHouse` accepts any `studio` string and keys the per-IP limit on the client-supplied `X-Forwarded-For`. Test with `HOUSE_AI_DAILY=2`: rotating the studio code gave 6 requests per IP. Rotating the XFF header gave unlimited requests (8 of 8 accepted). Each request can run up to 6 turns, 16k max tokens and 4 web searches on the owner's key. Requests that fail are still charged. | `lib/ai.js:22-31`, `243-246` |
| S5 | P2 | **Anonymous knock flood.** `knock` needs only the studio code, which is public in `/c/<code>` call-in links. 300 knocks in a row were all accepted, and the host gets a chime and a toast for each. There is no rate limit, no lobby cap and no captcha. | `lib/studio.js:501-515` (`api.js` run) |
| S6 | P2 | **Relay tokens can be replayed.** One 2-minute token opened 3 concurrent relay sessions (all slots on `RELAY_MAX_STREAMS=3`; the 4th got a 503). Anyone holding the token (it sits in the WS URL and in proxy logs) can occupy the shared free relay or use it to push arbitrary media to any RTMP host. A session that sends `start` and then no data holds its slot forever: the first-message timer is cleared on `start`. **Fix:** make the token single-use with a nonce, enforce one stream per studio, and add an idle timeout. | `relay/server.js:23-30`, `46-72` |
| S7 | P3 | **Guest spam and spoofing.** A guest can flood chat (200 requests × 100 messages, all accepted), send fake "X started recording" notices to everyone, and upload unlimited 900 KB images (`assetPut`). | `lib/studio.js:362-398`, `455-463` |
| S8 | P3 | **Stream keys in plain localStorage.** Keys are stored in plain text in `localStorage` (`gather:liveDests`), and the Rumble API URL (also a secret) the same way. Any XSS, or a shared computer, exposes them. Consider sessionStorage, or encrypting at rest with an opt-in "remember keys". | `public/app.js:3169`, `2187` |
| S9 | P3 | **Partial key leak in logs.** Log redaction only masks the last path segment, so for a key containing `/` the first part is logged: `abc/KEY` → `/live/abc/•••`. | `relay/server.js:38` |
| S10 | P3 | **Unvalidated thumbnail.** `streamUpdate` stores `thumb` without the data-URL check that `streamCreate` applies, and the public `streamThumb` action returns it as-is. I stored `javascript:alert(1)`. It isn't rendered today, but it is a latent stored-XSS sink. | `lib/streams.js:330-331`, `372-377` |
| S11 | P3 | **Local DoS.** The malformed-URL crash in B10 lets any single request take down a self-hosted server. | `server.js:45` |

**Checked and fine:**
- No server secrets reach the browser. `config` returns only flags, the public Google client ID and house AI provider/allowance.
- The XSS payloads I tried in chat, guest names, banners, titles, `live.links` and tip/call-in URLs were all inert.
- Rumble fetches are limited to `https://rumble.com/-livestream-api/`.
- Guests can't get relay tokens or change the stage.
- Google access tokens stay in memory only.
- Passwords use scrypt with timing-safe compare.

---

## 4. Improvements (ranked)

1. **Show errors over dialogs.** Put toasts in a top-layer `popover="manual"`, and re-show it after each `showModal`. Also put an inline status line inside the Go live dialog (fixes B2).
2. **Per-destination live status.** The relay should parse tee slave failures, send `{t:'dest', i, state:'live'|'failed', reason}`, and show a ✓ or ✗ chip per destination. Translate FFmpeg errors into plain words, such as "YouTube refused the key" or "can't reach Facebook".
3. **Relay warm-up and timeouts.**
   - When the Go live dialog opens, call a gather `relayHealth` action that pings `/health` server-side and shows "Waking the relay… ~30 s".
   - Time out `connecting` after 20–60 s with a retry.
4. **Server-side `live` expiry.** Store `live.heartbeat`, have the host refresh it with stats, and have `watch` treat `live` as off once the heartbeat goes stale. Also clear `live` when the host is removed (fixes B4).
5. **Don't rebuild the destination list on every render.** Diff the list, or skip `renderDests()` while focus is inside `#destList`, and save on `input` (fixes B1).
6. **Validate TURN entries**: require the `turn:`/`turns:`/`stun:` scheme, and a username and credential for TURN. Catch `RTCPeerConnection` construction errors and fall back to the server's ICE servers with a toast (fixes B5).
7. **Rate limits:**
   - `knock` and `join` per IP and per studio;
   - signup per IP;
   - streamCreate invites per day;
   - house AI only for an existing studio the caller belongs to (pass `studio`, `id` and `tok`), and use the platform-supplied client IP, not the raw XFF header.
8. **Stable moderation identities:**
   - block studio users by member or device ID, not by name;
   - refuse duplicate names in a studio;
   - show a Host badge in chat.
9. **Platform chat status:** show "Twitch chat unreachable" after N failures, and check that the channel exists, for example by waiting for ROOMSTATE.
10. **Copy:** fix the stale tab names in B12, add a "stream key / RTMP / destinations" help entry, and explain why the Go live button is disabled (for example "YouTube needs a stream key").
11. **Testing:** add `ws` to a root dev-dependency, or have `tests/run.js` install relay deps, so `live` runs in CI. Raise the Playwright timeouts in round, round4 and round5, or run them serially.

---

## 5. V5 ideas: going live dramatically better than StreamYard and Restream

1. **One-click platform connect (OAuth) instead of stream keys.** Create the YouTube broadcast with its title, thumbnail and schedule from the Plan-a-stream wizard. Do the same through the Twitch and Kick APIs. No key pasting, and the watch links are known automatically.
2. **Live health dashboard per destination**: bitrate, dropped frames, the platform's ingest health (YouTube `liveStreams.status.healthStatus`), viewer counts, and auto-reconnect per destination without dropping the others.
3. **Ingest from the browser by WebRTC (WHIP) instead of MediaRecorder-over-WS.** This gives lower latency, real congestion control and adaptive bitrate. The relay re-publishes to RTMP, or to WHIP endpoints where platforms support them.
4. **Dual-format live from one show.** Render 16:9 and 9:16 canvases at once, with the AI auto-framing speakers into the vertical layout, and send each to the platforms that want it (YouTube plus Shorts, TikTok, Reels).
5. **"Producer mode" AI that watches the show:**
   - auto-switches scenes to the active speaker;
   - suggests lower-thirds from what's being said;
   - surfaces the best audience question across Twitch, YouTube and Rumble, already moderated;
   - drops a chapter marker on each topic change.
   - Afterwards: highlights, a titled VOD and Shorts clips, ready to publish.
6. **Unified, identity-aware moderation across platforms.** Use shared blocklists synced to platform moderation APIs, AI toxicity triage with one-click actions, and a "slow mode everywhere" switch.
7. **Pre-flight check before going live:**
   - test-push to each destination for 5 s and validate the keys;
   - check upload bandwidth and suggest a bitrate;
   - check mic levels and the guests' connections;
   - then a 5-4-3-2-1 countdown, so the host never finds out mid-show that YouTube wasn't receiving.
8. **Resilience:**
   - keep the local recording as a backup, with an "upload the backup to YouTube as the VOD" option;
   - hand off the stream to a co-host if the host's browser dies (the relay keeps the RTMP sessions open and shows a "be right back" slate while it reconnects).
9. **Watch page as a destination.** A built-in low-latency player (relay → HLS/LL-HLS on a CDN), with chat, tips and call-in on the page, so a show works even without any platform accounts.
