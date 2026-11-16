# V5 audit 2 of 4: studio core (host and guests)

**Setup:** local server (`ALLOW_ANON_STUDIOS=1 PORT=8102 node server.js`, in-memory store) and Playwright 1.63 Chromium with a fake camera and mic. Each participant ran in its own browser: when several pages shared one browser, Chromium throttled the unfocused pages to about one poll every 6 s, and that skewed the timings.

**Where things are:**
- Scripts: `/tmp/claude-0/-home-user-gather/0c2621ff-ea6b-5d46-b42f-d9d837e41814/scratchpad/a2/` (`s1.js` to `s8.js`, helpers in `h.js`).
- Screenshots: `audit/v5/shots/studio/`.

**Caveats:**
- **Timings:** while scenarios 1–6 ran, the sandbox's load average was about 42 on 4 cores, because other auditors were running at the same time. Treat the latency and connect times from those runs as upper bounds.
- **Effects numbers:** scenarios 7 and 8 ran at low load. Headless Chromium has no GPU, so WebGL runs in software (SwiftShader). The effects figures show the worst case: a machine whose GPU is blocklisted, a VM or a low-end Chromebook.

---

## 1. Working (verified)

- **Joining and connections**
  - Host creates a studio; the invite dialog opens; guests join from `/s/<code>`.
  - Mesh WebRTC connects with 3 people. Every peer is `connected` with ICE `connected`.
  - Every remote `<video>` decodes frames: 1280×720 / 640×360, 6–27 new frames per second.
  - The presentation track (third m-line) reaches the guests: 1440×810, about 20 fps.
- **Backstage and stage**
  - A new guest arrives backstage. The host gets "X is backstage · Put on stage" and a chime.
  - Clicking the picture or the stage button on the card puts the guest on or off stage; it syncs to everyone.
  - Show → "Guests go straight on stage" works.
- **Host controls on people cards**
  - Ask to mute works: the guest's mic is released (`S.local.audio` = null), and the host's card shows the muted icon.
  - When the guest unmutes, the icon clears and audio packets flow again (160 packets in 2 s).
  - Remove needs two clicks. The removed guest is ejected, and a rejoin from the same browser is refused with "The host removed you from this studio" (device ban; PROGRESS.md "Not done" is stale on this point).
- **Leaving**
  - A guest who leaves or reloads disappears from everyone's view at once, through the pagehide beacon.
  - The host's Leave opens a confirm dialog listing what will happen ("stop the recording…, hand the studio to your guest"). Esc cancels.
  - Confirming hands the host role to the guest, who then gets Go live, scenes, Record and Show.
- **Scenes:** all 11 landscape scenes and 8 vertical (9:16) scenes apply and sync to guests. Exactly one scene shows as selected.
  - Landscape: Solo, Side by side, Spotlight, Full-screen slides, Screen + AI, Cinematic solo, Interview panel, Slides + speaker, AI arena, Chat-led show, Newsroom.
  - Vertical: Solo, Side by side, Spotlight, Vertical solo, Stacked duo, Vertical presentation, Vertical AI, Vertical + chat.
  - Keys 1–9 switch scenes (when the focus is not in a text field; see B1).
  - Screenshots: `s5-scene-*-host.png` / `-guest.png`, `s5-v-*.png`.
- **Presenting:** the host's or a guest's screen share switches the scene to "Full-screen slides". Stopping the share returns to the previous scene.
- **Mic and camera:** mute releases the mic; camera off stops the track, and guests see the avatar tile with a muted badge; camera on resumes video to the guests.
- **Effects and mirror**
  - Blur is ready in about 380 ms (the model is self-hosted).
  - Replace prompts for a picture.
  - Mirror affects only the self-view (CSS `scaleX(-1)` on the card and preview), never the program. That is correct.
- **Recording**
  - The `r` key or the Record button starts it. The dock label and the header pill count up (00:06 after about 5 s).
  - Guests get "Alex Host started recording".
  - Stopping opens a dialog: "00:09 long · 0.7 MB · WEBM", 1280×720. The download works (695 KB file).
- **Invite**
  - The invite dialog's primary button copies `http://…/s/<code>`.
  - Footer Copy link and code copy for guests. For a host, the getting-started guide takes that footer slot.
- **Show title:** click-to-rename works (max 60 characters, no header overflow) and syncs to guests. Esc reverts.
- **Side panel:** hiding it gives the stage more width (996 → 1124 px).
- **Folding deck:** it folds, and clicking a deck tab reopens it.
- **Tour:** Help → "Take the studio tour" runs 10 steps (Your show, Scenes, Guests and backstage, Present, Record, Show, Look, Your AI producer, Invite, Go live), then closes. Esc closes it.
- **Esc:** closes Settings and the Present menu, and leaves edit mode.
- **Chat:** works both ways, including the history replayed on join. Links are made clickable safely.
- **Phone guest (390 px):** no horizontal overflow; the chat input sits above the fixed dock.
- **Background tab:** a worker clock keeps the program canvas rendering, so recordings don't freeze.
- **Console:** no console errors or failed requests in normal flows. The only ones seen:
  - 403s from the removed guest's own poll, leave and join (expected).
  - One `ERR_REQUEST_RANGE_NOT_SATISFIABLE` on the recording blob (harmless).
  - The proxy blocking `irc-ws.chat.twitch.tv` (sandbox only).
- **Memory:** the JS heap stays at about 10 MB per participant through every scenario. No growth was seen.

## 2. Broken (reproduced)

### B1. Typing the show title fires the studio's single-key shortcuts. **P0**
**Repro:**
1. As host with a guest connected, click the show title.
2. Select all and type `Mars Rover Vlog 3`, then press Enter.

**Expected:** the title becomes "Mars Rover Vlog 3".

**Actual:**
- The title saved is **"a oe log"**: every shortcut key is swallowed.
- Along the way, `M` muted the host's mic and `s` started a **screen share**.
- `R` started a recording, `r` stopped it, and the save dialog opened.
- `3` switched the scene, then the share switched it to Full-screen slides.
- An earlier run typed "Temp", and its `m` silently muted the host.

Screenshot: `shots/studio/s7-01-title-shortcut-leak.png`.

**Cause:**
- `public/app.js:3739` makes the title `contentEditable = 'plaintext-only'`.
- The global shortcut guard at `public/app.js:4701` only skips `[contenteditable="true"]`, and line 4698 only skips INPUT, TEXTAREA and SELECT.
- **Fix:** test `document.activeElement.isContentEditable`, or use `[contenteditable]:not([contenteditable="false"])`.

### B2. "(you)" is burned into the recording and the live stream. **P1**
**Repro:**
1. As host, record a few seconds.
2. Look at the recorded file.

**Expected:** the name tag reads "Alex Host".

**Actual:**
- The recorded file's name tag reads **"Alex Host (you)"**.
- Each participant's program canvas labels its own tile "(you)", and the host's canvas is what gets recorded and streamed (`canvas.captureStream`).

Screenshots: `s8-03-recorded-frame.png`, `s6-02-footer.png`, `s5-host-full.png`.

**Cause:**
- `public/app.js:876`: `const label = p.me ? \`${p.name} (you)\` : p.name;`.
- The presenter label at line 1637 already notes "the program is shared, so never 'you'". The name tag needs the same rule.

### B3. Reloading or a network drop makes the host lose the host seat for good. **P1**
**Repro:**
1. The host has a guest in the studio.
2. The host reloads, or the laptop sleeps for more than 20 s, which goes through `lostStudio()`.
3. The host clicks Join again.

**Expected:** the creator gets the host seat back.

**Actual:**
- The guest is promoted to host ("You are now the host").
- The original host rejoins as an ordinary guest, with no scenes, Record or Go live.
- The host had to accept a fresh join dialog; there is no automatic rejoin.

Screenshots: `s3-04-host-after-reload.png`, `s3-05-host-rejoined.png`.

**Cause:**
- `lib/studio.js:306-321`: the host seat goes back to its owner only for scheduled studios, through `g:<code>:reserved` (`lib/streams.js:117`).
- Ad-hoc studios started by a signed-in account never reserve the seat.
- `removeMember` (`lib/studio.js:221`) hands off immediately.
- **Fix:**
  - Reserve the seat for `acct` when the first signed-in member creates the studio.
  - Give the host a grace period before handing off.
  - Keep `id`/`tok` in `sessionStorage` so a reload resumes the same membership.

### B4. A reload mid-session throws people back to the join dialog. **P2**
**Repro:**
1. A guest who is in the studio presses F5.

**Expected:** they return to the studio straight away, with the same seat and the same on-stage state.

**Actual:**
- The green-room dialog reopens and they must click Join.
- They come back under a new member id. An on-stage guest comes back **backstage**, because the stage list is keyed by member id.
- The host gets "joined" and "is backstage" toasts again.
- Reload to fully reconnected took about 7–12 s locally.

Screenshot: `s3-01-guest-after-reload.png`.

**Cause:** `app.js:589` (`join`) never reuses credentials, and nothing persists across a reload.

### B5. Chat removes `<` and `>`. **P3**
**Repro:**
1. A guest sends `hi from g2 <b>bold</b>` or `I <3 this`.

**Expected:** the text arrives as typed. It is already rendered with text nodes, so it is safe.

**Actual:** everyone sees `hi from g2 bbold/b`; `I <3 this` becomes `I 3 this`.

**Cause:** the `clean()` regex in `lib/studio.js:57`, applied to chat at `lib/studio.js:370`. The client never uses `innerHTML` for chat, so the stripping isn't needed. Banner and ticker text have the same problem.

### B6. The show title overlaps the "X is presenting" label in the program. **P2**
**Repro:**
1. Set a show title.
2. Share a screen, which auto-switches to "Full-screen slides".

**Expected:** the two labels don't collide.

**Actual:** the spaced-out uppercase title (drawn at 30,22) prints on top of the "Alex Host is presenting" pill (at media rect + 12). It is also visible in the guest's program and in the recording.

Screenshots: `s7-01-title-shortcut-leak.png`, `s7-03-guest-screenshare.png`.

**Cause:** `app.js:1004` (title) against `app.js:1637-1641` (presenter pill) when the media element is full-bleed (`present-full`, x = 0, y = 0).

### B7. Background blur and replace freeze the whole studio on a machine without GPU acceleration. **P2**
**Repro:** in headless Chromium (software WebGL), turn on Settings → Background → Blur.

**Expected:** the studio stays usable.

**Actual:**
- The page frame rate drops from **59 fps to 2.3 fps**, with the worst frame at 667–933 ms. That holds for Blur and for Replace.
- The UI stops responding: a Playwright click on "Green screen" timed out after 30 s.
- The program canvas, and so the recording, drops to the same rate.
- Nothing detects this or degrades gracefully.

Screenshots: `s7-04-blur-settings.png`, `s7-06-replace-settings.png`.

**Cause:**
- `public/fx.js:461`: `setInterval(frame, 1000/30)` runs the WebGL pipeline plus the MediaPipe segmenter on the main thread at full camera resolution.
- **Fix:**
  - Measure the time per frame. If the average is over about 25 ms, drop to the low-res mask and 15 fps, and if it stays slow, turn the effect off with a toast.
  - Better: move it to an `OffscreenCanvas` in a worker, or use `MediaStreamTrackProcessor`.
  - Also check `WEBGL_debug_renderer_info` for SwiftShader or llvmpipe, and warn before enabling.

### B8. The recorded WebM has no duration and can't be seeked. **P2**
**Repro:** record, stop, then read `recVideo.duration`, or open the downloaded file in a player.

**Expected:** a finite duration and a working seek bar.

**Actual:** the duration is `Infinity` (it serialises as `null`). Players show no length and seeking is broken or slow, which is a known MediaRecorder issue.

**Cause:** `app.js:3317-3326`. The chunks are concatenated with no duration or Cues fix-up. Patch the EBML duration (as `fix-webm-duration` does) or remux before offering the download.

### B9. The download file name doubles the prefix. **P3**
**Repro:** record, then Download.

**Expected:** `gather-3dd1b1956e83-2026-11-16-00-56.webm`.

**Actual:** `gather-gather-3dd1b1956e83-2026-11-16-00-56.webm`.

**Cause:** `app.js:3367`: studio codes already start with `gather-`. Better still, use the show title.

### B10. On-stage people cards have a red border. **P3**
**Repro:** put anyone on stage and look at the people deck, as host or guest.

**Expected:** the V4 rule says red is only for live or recording, and on-stage uses the accent.

**Actual:** `.crew-card.on-stage` has a red (`--live`) border.

Screenshots: `s5-guest-full.png`, `s6-05b-guest-sees-host-cam-off.png`.

**Cause:** `public/style.css:135`.

### B11. Hosts never see the quick-invite footer. **P3**
**Repro:** create a studio as host.

**Expected:** Copy link and the code in the footer (V4 feature).

**Actual:**
- For the host, the footer slot shows the getting-started guide instead (`#noteLink` and `#noteCode` are not visible). Only guests see Copy link and the code.
- Dismissing the guide brings it back, so this is low severity.

Screenshot: `s6-02-footer.png`.

**Cause:** `renderDockNote` gives the guide priority.

## 3. Improvements (ranked by impact)

1. **Fix B1 and B2 before anything else.** One cheap guard and one label change.
   - B1 can mute the host, record, share the screen and switch scenes mid-show, just from naming the show.
   - B2 puts "(you)" into every recording.
2. **Signalling and polling cost.** Every participant polls `/api/studio?action=poll` once a second while visible and every 2.5 s while hidden. Measured gaps were 1.0–1.5 s, or **about 45–60 requests per minute per person**.
   - A 4-person, 1-hour show makes about **12–14k Vercel invocations**.
   - Each poll that carries the heartbeat (every 4 s) also runs HGETALL, HSET, 4 EXPIREs and a sweep on Redis.
   - Signalling latency is bounded by the poll interval: scene changes took 1.9–7.9 s to reach guests on the loaded box, and about 1 s at best.
   - **Options:**
     - Long-poll with a 20–25 s hold, using Upstash `BLPOP`, or an edge function with a streaming response.
     - Or move signalling and state to a WebRTC DataChannel once peers connect, and keep HTTP only for join and recovery.
     - At minimum, back off to 3–5 s while idle, and use the DataChannel for state, chat and mute.
3. **Resumable sessions.** This fixes B3 and B4 together.
   - Store `{studio, id, tok}` in `sessionStorage`. On load, try `poll` with them before showing the green room.
   - Give the server a grace period (about 30 s) before removing someone or handing off the host.
   - Keep stage membership by stable device or account id, not by the per-join id.
4. **Faster connection setup.** It took 6–13 s from Join to `connected`. Offers and answers wait for the other side's next poll at the 1 s idle rate.
   - When a `peer-joined` arrives, switch to the 120–300 ms "negotiating" cadence before the offer comes.
   - Better: let the host, who is already polling, send the offer instead of the newcomer.
5. **Effects performance guard (B7).** Measure, then degrade or disable. Also show the effect's cost ("Blur is using 40 % of your CPU").
6. **Recording quality.** Fix the duration (B8) and name the file after the show title.
   - Each participant should also record their own camera locally (Riverside-style), uploading in chunks.
   - Make "save chunks to IndexedDB while recording" the default. Today a tab crash loses the whole recording, because the chunks are only in memory.
7. **Make backstage clear to the guest.** A backstage guest sees the program with themselves absent, and only a small "BACKSTAGE" pill on their own card.
   - Add a banner over the stage ("You're backstage. The host will bring you on.") and a "you're on in 3…" cue when they're added.
8. **Guests have no presence controls.** Add "raise hand / ready" and a private host↔guest chat (backstage notes), so the host can cue a guest without public chat.
9. **Unify the chat and title sanitising (B5).** Store raw text and escape on render, which the client already does.
10. **Small fixes:**
    - The on-stage card colour (B10).
    - Show the quick invite next to the guide (B11).
    - On phones, 8 controls are under 44 px tall: header icons at 34×34, the deck toggle at 28×28, chat send at 32×32, the deck tabs at 28 px tall, and Leave at 64×34.

## 4. V5 ideas: making the studio clearly better than StreamYard or Riverside

1. **A producer, not just a switcher.**
   - The AI producer ("Sam") already switches scenes.
   - Next step: auto-direct by speaker, using voice activity to cut to Spotlight on the active speaker with a minimum shot length and no ping-pong.
   - Also: auto-lower thirds the first time each guest speaks, and an automatic scene when someone shares.
   - The host stays in charge with a one-key "hold shot".
2. **Every participant records their own camera at full quality, plus the mixed program.**
   - Riverside's core feature, done in the browser: MediaRecorder per participant, chunked upload to R2 or S3.
   - It is time-aligned to the program, so a multitrack export (program + each camera + each mic WAV) comes out after the show.
3. **Instant clips and chapters.**
   - Keep the last 60 s of program in a ring buffer.
   - "Clip that" (key `c`, or by voice) makes a captioned 9:16 short, using the existing vertical scenes and captions.
   - Scene changes and banners become chapter markers in the export.
4. **Zero-friction rejoin and seat identity.**
   - A dropped guest comes back on stage in the same slot, with a "Reconnecting…" tile in place rather than a vanished seat.
   - The host seat is tied to the account.
   - This is the kind of failure that makes StreamYard feel fragile; make it invisible.
5. **Green room as a real backstage.**
   - Backstage guests see and hear the live program, delayed and mixed.
   - They get a private talkback channel with the host and a countdown cue.
   - The host can line up a queue of the next 3 guests and cut to "next guest" with one key.
6. **Cheaper, faster signalling:** a DataChannel mesh for state and chat, with an SFU switch-over above 4 people. That means near-instant scene sync, no polling bill, and room for 10+ guests.
7. **Studio rehearsal mode.**
   - A safe "set-up" state where nothing records or goes out.
   - Single-key shortcuts are disabled while editing.
   - A preview/program split (edit the next scene and take it live with a cut or fade), as in vMix or OBS studio mode, which StreamYard lacks.
8. **Health HUD for the host.** Per-guest bitrate, packet loss, CPU and effects cost, with suggestions ("Jordan's network is weak: drop to 360p?") and the option to apply them remotely.
