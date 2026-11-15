# gather: progress

The stack is plain ES modules in the browser plus Node serverless functions on Vercel (`api/`, `lib/`). There is no TypeScript, no bundler and no lint config, so verification is `node --check` on every file plus Playwright end-to-end suites.

## Round 5 (this round)

### Presenting
- You can drop a PDF, video or image anywhere on the stage, or click an empty presentation area to pick one. Images are also in the Present menu.
- The "Full-screen slides" scene puts the slides edge to edge, with cameras as small blocks on the right. Presenting switches to this scene automatically.
- The slide and video controls sit on the stage as glass. Only the presenter sees them; they are DOM elements, not drawn into the program.

### QR cards
- Support-link and call-in cards draw the QR on whole-pixel cells, sized larger, from a normalised `https://` link.

### Host controls
- From each person card the host can put them on or off stage, ask them to mute, or remove them (two clicks to confirm). The server blocks a removed person's session.
- **Lock** sends new guests to a waiting room. The host gets a chime, and the deck jumps to **Waiting**, where the host can let them in or decline.

### Call-in line
- `/c/<code>` is a WebRTC call-in link. Callers always queue for the host to admit them.
- The call-in QR card can go on stage. It has a headline and an optional phone or note line.

### Studio layout
- The studio column no longer scrolls. The stage sizes to the space left (container query).
- The deck below it swaps Scenes, In the studio and Waiting. Mouse wheel and swipe animate between them.
- People cards are compact, sized like scene cards.

### Camera-off tile
- The tile shows the person's own uploaded background (Settings → Camera-off background), or a blur of their photo.
- Voice rings and a level meter are smoothed with attack and release.

### Brand
- **Panels:** Glass or Solid colour, applied to the AI window, chat overlay and camera-off tiles.
- **Logo:** has its own section.
- **Sponsors & ads:** up to 8 rotating images, with a position and duration. A sponsor ad avoids the call-in card's corner.

### Background images
- Pictures (avatar, camera background, camera-off background, brand images) moved from localStorage to IndexedDB. The ~5 MB quota had been silently dropping new pictures, which is why background images couldn't be changed.

### AI producer
- You name it (default "Sam").
- You can type to it from the stage orb, push-to-talk, or say "Hey Sam …" (Chrome/Edge).
- **What it can do:** switch scenes by name, present items from the media library, show and hide banners, start countdowns, and find YouTube videos or sites.
- **Opening a site or video:** browsers can't silently capture a page, so the host clicks "Open", then shares that window.
- **Voice:** "Me" (browser speech, only the host hears it), "Stream" (OpenAI TTS mixed into the stream and recording), or "Off".
- **Media library:** stored in this browser (IndexedDB). Saved scenes can open with a library item.

### Step into the studio
- New layout with background chips and camera/mic pickers, plus a "Waiting for the host" screen for locked studios and callers.

### Editor-only enforcement
- Host-only hints draw through `editorOnly()` onto `#editorCanvas`. That canvas sits over the stage and is never passed to `captureStream`. Hints covered: empty stage, empty camera slots, empty image and media placeholders.
- "You are presenting" was being recorded into the program. It is now the presenter's name.

## Verified
- Playwright suites e2e, feat, mod, twitch, round, round4 and the new round5 all pass. The only console errors are the sandbox blocking Twitch's websocket.
- round5 covers:
  - green-room chips
  - camera-off background sync, stored in IndexedDB
  - PDF drag and drop, full-bleed on the guest's screen, presenter-only controls
  - wheel deck swap with no page scroll
  - mute
  - lock, call-in knock and admit
  - removing a caller
  - call-in card, sponsor ad and solid panels syncing
  - AI producer switching scene and banner on the guest's screen (provider response mocked)
- editorOnly check: the empty-stage hint has 0 pixels on the program canvas and 3,190 on the editor canvas.
- Screenshots in `audit/screens`: `before-*` (previous commit) and `after-*` at 1440, 1024 and 390 for home, green room and studio, plus `r5-*` feature shots.

## Not done / known limits
- Platform restreaming (RTMP to YouTube, Twitch, etc.) still needs a relay; browsers can't send RTMP.
- The AI can't capture a website without the host's click and screen-share pick (a browser security rule).
- Phone-number dial-in (PSTN) isn't built. The call-in line is WebRTC links only; a phone field on the card can carry a number from an outside service.
- Removing someone ends their session, but they can come back through the link. Lock the studio to keep people out.
- Scheduled-stream email needs `RESEND_API_KEY`, `MAIL_FROM` and `APP_URL` set in Vercel.

## Audit (part A): no app changes
- `scripts/audit.ts` is a strict TypeScript Playwright audit. Node 22.18+ runs it directly, and it typechecks with `tsc -p scripts` (needs `playwright` and `typescript` installed).
- **What it covers, at 1440, 1024 and 390:**
  - It signs up a host, opens every panel, dialog, menu, dock tool and deck layer, and clicks every control.
  - File pickers are answered with `scripts/fixtures`.
  - It records errors and failed requests, flags dead controls, and checks overlap, overflow, off-screen controls, clipped text, tap targets and focusable hidden layers.
  - It also runs functional checks on the AI image maker, AI chat, AI voice, the AI producer, video upload, PDF presenting, QR hide, banner editing, the editor-only layer and the guest view.
- **Output:** `AUDIT.md`, `audit/findings.json`, and about 600 screenshots in `audit/screens/auto/` (gitignored, about 35 MB).
- **How the findings were triaged:**
  - Earlier runs produced false positives: hidden deck layers, the sticky phone dock, a light stage background mistaken for hint text, and the wizard's first step. The script now handles each of these correctly.
  - The editor-only check compares the host's and a guest's program frames pixel by pixel.
  - Confirmed root causes carry specific fixes in `KNOWN`.
- **Intermittent:** the pdf.js "same canvas during multiple render()" error showed up in 2 of 4 runs, when slide changes come in fast.

## Design tokens and primitives (part B)
- **`public/tokens.css`:** the single source of truth for every value, with a dark default and a light override. It covers:
  - colour
  - glass: `rgba(255,255,255,.06)`, `blur(20px) saturate(140%)`, 1px `rgba(255,255,255,.10)` border, inset top highlight, `0 8px 32px rgba(0,0,0,.35)` shadow, 2% SVG noise, and a solid fallback when `backdrop-filter` is unsupported
  - space on a 4px grid
  - radii 8/12/16
  - control heights 28/36/44
  - type: Plus Jakarta Sans for display, Inter for the UI
  - icons 16/20 at stroke 1.75
  - motion: 180ms ease-out, a `linear()` spring, and ~0ms under `prefers-reduced-motion`
  - layers
- **`public/ui.css` + `public/ui.js`:** the primitives.
  - Button (primary, secondary, ghost, danger, live, link, on-media), IconButton (plus stacked, mutes, light, primary, filled), SegmentedControl, Toggle (with row and inline forms), Pill, GlassPanel (plus raised and on-media), Popover (native `[popover]`, anchored, with MenuItem), Modal, Tooltip (from `data-tip` or the aria-label of icon-only buttons), Input, Tile and Spinner.
  - Every primitive has hover, active, focus-visible, disabled and loading (`aria-busy` via `busy()`), plus pressed or selected where it applies.
  - Primitives placed on video surfaces (`.stage`, `.on-media`) re-scope the tokens, so they read correctly in both themes.
- **`public/style.css`:** rewritten to only arrange primitives using tokens. Every interactive control in `index.html` and `app.js` now uses a primitive class. The audit checks this ("Control not built from a primitive").
- **Icons:** Lucide only (46 icons). `scripts/build-icons.ts` builds them into the `public/icons.svg` sprite. All 34 hand-drawn SVGs and the `✕ ↑ ↓` glyphs were replaced.
- **Fonts:** the UI loads only Inter and Plus Jakarta Sans. The stage's brand fonts (Onest, JetBrains Mono, Playfair, Bebas, DM Serif) load separately without blocking, and only the program canvas uses them.
- **Motion:**
  - Dragged layout boxes lift while dragging and settle back with a spring when released.
  - Deck layers and the Toggle knob move on the spring curve.
  - JS smooth scrolling also respects reduced motion.
- **Fixed by the primitives:** the phone Present menu (audit P0) is now a top-layer Popover, so the dock can no longer clip it. Chat time-outs use one shared Popover instead of `<details>`.
- **Verification:**
  - `/ui-kit.html` shows every primitive in every state.
  - `node scripts/ui-kit.ts` screenshots each state in both themes (`audit/screens/ui-kit/`, 214 images) and checks the token contract in the browser: heights, radii, icon size and stroke, fonts, tabular numbers, glass values, motion and reduced motion, Popover, Tooltip, loading state, no hand-drawn SVGs, and only two UI fonts.
  - `node scripts/ui-shots.ts before|after` captures 14 states × 3 widths (`audit/screens/before`, `audit/screens/after`).
  - All seven Playwright suites pass.

## Phase 3: layout engine and video effects
### Layers (public/layout.js)
- **Fixed tiers**, painted in this order:
  - stage (cameras, colour blocks)
  - media (presentation, images)
  - overlays (lower thirds, logo, QR and call-in cards, text, timers, AI window, sponsor ads)
  - chat & super chat
  - ticker
  - system (captions)

  Inside a tier, list order decides what's on top. Host-only editing UI stays on its own canvas and DOM, so it never reaches the program.
- **System layers:** banners, the ticker, the logo, sponsor ads, the featured chat card and captions used to be drawn at fixed spots. They are now real layers that can be moved, resized, hidden, locked, reset and saved per scene.
- **Editor:**
  - Drag, plus resize from all four corners.
  - Snapping to the 8px grid, the title-safe and action-safe areas, the stage centre and other layers' edges and centres. Guides show while you drag.
  - Arrow keys nudge 8px (Shift: 40px). Esc deselects. The selected box always sits on top, so you can grab it.
- **Collision avoidance:** layers can't overlap unless one is stacked on purpose: Alt-drag, the "Allow overlap" switch, or a preset that designs it.
  - A blocked move slides along the free axis and highlights the blocker in red.
  - Adding a layer finds the first free spot, or adds it stacked and says so.
  - A carried card that would collide in a new scene is hidden, and a toast says so.
  - Showing a hidden layer, or turning stacking off, never creates an overlap.
- **Layers list:** grouped by tier, with show/hide, lock and reset. Each layer's settings add stacking, picture-in-picture (a camera drawn above slides), bring forward / send back, a pixel readout and delete.
- **Per-scene memory:** every edit saves the scene's arrangement (IndexedDB, images included). Switching away and back restores it, the last scene and its arrangement come back after a reload, and "Reset scene" restores the design.
- **Presets:** Cinematic solo (2.39:1 letterbox), Interview panel, Slides + speaker (PiP), AI arena, Chat-led show and Newsroom. They're designed on 8px steps inside action-safe, with no unintended overlaps; this is checked in the browser by round6 and the preset audit. "Full-screen slides" (auto-present) and "Screen + AI" remain. The six generic templates they replace are gone.
- **Brand controls:** the logo position/size and sponsor position controls now move those layers.

### Green screen and background blur (public/fx.js)
- **Multi-pass WebGL2 pipeline.**
- **AI mask:**
  - Motion-adaptive temporal smoothing of the AI mask.
  - Joint-bilateral upsampling guided by the full-resolution frame.
- **Background blur:**
  - Premultiplied, mask-weighted background blur (three Gaussian rounds at quarter resolution), so no person-coloured halo.
  - Light wrap.
- **Chroma key:**
  - Keying on chromaticity (shading-invariant) with an off-hue penalty.
  - A 3×3 matte.
  - Hue-aware spill removal (chromaticity projection weighted by hue alignment, plus a channel limiter).
- **New controls:** automatic screen-colour pick from the frame border, plus spill, edge-softness and blur-amount controls.
- **Fixed:** a picture chosen before it finished loading never painted.
- **Measured by `node scripts/fx-bench.ts`** against ground truth: the previous algorithm, reimplemented exactly from commit 349f8aa, vs the current `fx.js` on identical synthetic frames (green screen with spill and shadow, room with noisy model-resolution masks, perfect-mask blur). Results are in `audit/fx-bench.json`:

| Measure | Before | After | Better by |
|---|---|---|---|
| Green screen matte error, whole frame | 0.0821 | 0.0129 | 6.4× |
| Green screen matte error, edges and hair | 0.2437 | 0.1293 | 1.9× |
| Green cast near the subject's edge | 14.8 | 7.0 | 2.1× |
| Subject colour error (noise floor) | 3.80 | 3.51 | 1.1× |
| AI mask error, whole frame | 0.0058 | 0.0028 | 2.1× |
| AI mask error, edges and hair | 0.1252 | 0.0606 | 2.1× |
| AI mask edge flicker | 0.0909 | 0.0115 | 7.9× |
| Blur halo (person colour in background) | 16.7 | 2.5 | 6.7× |

Three of the eight measures beat the "250% better" target (3.5×): the overall green-screen matte, edge flicker and blur halo. Edge and hair accuracy is about 2×, capped by the segmentation model's 256×144 mask. The geometric mean across all eight measures is 2.98× (198% better).

### Verified
- All eight Playwright suites pass, including the new round6 (layout engine).
- `scripts/ui-kit.ts` contract checks pass.
- Live green screen with auto key and a picture background, and live MediaPipe blur, were checked in Chromium with the fake camera.
- Screenshots are in `audit/screens/after` at 1440, 1024 and 390.

## Cut-out edges, blur halo and green-screen detection
Feedback: the line around the person was pixelated, Blur left a halo, and Green screen did nothing.
- **Guided filter** (He, Sun & Tang) in `public/fx.js`, at up to 640 px on float textures. It rebuilds a full-resolution, edge-following matte from the model's 256×144 mask, using the camera picture as the guide, so the outline lands on the real edge and comes out smooth instead of stair-stepped. Without float render targets, it falls back to the joint-bilateral path.
- **The MediaPipe general model** (`modelSelection: 0`), whose edges are more accurate than the landscape model's. Weak detections go through a confidence curve before refinement.
- **Stray-patch cleanup:**
  - The mask is split into connected regions at model resolution.
  - Kept: large regions, confident ones (a hand waved clear of the body) and anything entering from the bottom edge.
  - Dropped, together with their soft fringe: weak islands such as lamps, chair backs and posters.
- **Green screen with no screen.** Green screen only removes a real coloured backdrop. The app now samples the top and sides of the picture.
  - If no green or blue backdrop fills them, it says so and offers **Use Blur** and **Use Replace**.
  - If a backdrop is there but the picked colour is off, it picks the right one automatically.
  - "Pick automatically" ignores the bottom edge and requires a clearly green or blue backdrop. It used to be able to take a blue shirt as the screen colour.
- **Benchmark** (`npm run bench`): the mask simulation is now realistic, with a 2–3 px soft band, noise, jitter and false-positive patches. It saves close-ups to `audit/fx-bench-*.png`.

| Measure | Before | After | Better by |
|---|---|---|---|
| AI mask error, whole frame (incl. stray patches) | 0.0174 | 0.0033 | 5.3× |
| AI mask error, edges and hair | 0.1590 | 0.0705 | 2.3× |
| AI mask edge flicker | 0.1073 | 0.0176 | 6.1× |
| Blur halo | 16.7 | 2.3 | 7.3× |
| Green screen matte error, whole frame | 0.0821 | 0.0129 | 6.4× |

The geometric mean across all eight measures is 3.31× (231% better).
- **Verified:**
  - `npm run fx:live`, now in CI, runs the real app twice. With Chromium's green fake camera, the screen is found and there's no warning. With a room camera that has no screen, the warning shows and "Use Blur" switches to Blur. Blur and Replace never warn.
  - Screenshots: `audit/screens/fx-green-*.png`.
- **Limit:** fine hair strands thinner than the model can see are still smoothed into the head outline rather than kept strand by strand.

## V3: chrome, one AI assistant, one composer
See `AUDIT-V3.md` for the findings and plan. Screens: `audit/screens/v3-before` → `audit/screens/v3-after` (1440 / 1024 / 390).
- **Header:**
  - Just the wordmark until you're in a studio, so a title saved in an earlier session no longer appears while you're logged out or outside a studio. Inside a studio it shows the title and a plain-text connection status.
  - One button family: same height, radius and weight. Secondary buttons are quiet outlines. One primary button, which reads "Enter studio" or "Invite"; "Room details" opened the same dialog, so it's gone.
  - "Studio offline" is no longer shown on the home screen.
- **Filler copy removed:**
  - the header tagline
  - "Your studio. Your conversation."
  - "Your crew, connected."
  - the marketing panel subtitles (they're now one functional line each)
  - The home stage text now says what the product does.
- **Dock:** the Invite and Settings duplicates are gone (the header and the rail have them). There's a new assistant button, and "Leave" shortens on phones so the dock fits at 390.
- **AI, one assistant:**
  - The AI panel is a conversation with your assistant (default name Sam) that both answers questions and runs the studio. It replaces the separate "On-air AI" research box and the stage-only producer.
  - Setup (provider, key, model, name, voice, wake word) folds behind a settings button. It opens by itself only until a key is saved.
- **AI streams and acts:** `/api/ai` `mode: 'agent'` streams NDJSON events.
  - Claude gets real tool definitions (open a page, switch scene, present, stop, banner, hide banner, countdown) plus web search, in a tool loop. Tool input is validated, and non-https links are refused.
  - ChatGPT, Gemini and Grok reply with a JSON object mapped onto the same events.
  - Actions run as they arrive and show as chips under the answer.
  - The old plain-text research endpoint is removed.
- **On stage only when wanted:**
  - The permanent "Sam" chip over the program video is gone.
  - The assistant opens from the dock button or the `/` key in a floating bar that closes with Esc.
  - Each answer has **Show on stage** / **On stage**, which adds or removes the AI window without changing the scene. Pinning an older answer keeps it there; a new question takes over.
  - The AI window's empty state no longer shows editor instructions to viewers.
- **One composer** for chat, the AI panel and the command bar:
  - a rounded field that grows with the text, with an inline send button
  - Enter sends and Shift+Enter adds a line (chat is now multi-line)
  - a mic button for talking to the AI.
- **Verified:**
  - `tests/ai.test.js` runs `lib/ai.js` against a local stand-in for the Claude API. It covers the streamed text, tool calls becoming actions, an invalid link refused, tool results sent back with errors flagged, the host key used, and the JSON path.
  - round and round5 now cover "Show on stage keeps the scene" and "AI hidden until asked for".
  - All 10 suites, `npm run check`, `npm run ui-kit` and `npm run fx:live` pass.

## Monte Carlo roadmap, executed
`node scripts/roadmap-mc.ts` simulates 20,000 futures for 14 options: uncertain reach, impact, chance of working, build days and monthly cost, with sources and ranges listed in `ROADMAP-MC.md`. Group winners:

| Job | Winner | Wins its job |
|---|---|---|
| Go live | gather relay (WebSocket + FFmpeg) on Fly.io | 72% |
| TURN | Cloudflare Realtime TURN | 79% |
| Bigger studios | Cloudflare Realtime SFU | 69% |

- Cloudflare Stream was ruled out: its docs say browser (WHIP) inputs can't be restreamed.
- The SFU won its group but is too large for a 10-day plan.
- The 10-day plan was: first-run guide → AI allowance → go live → built-in TURN → watch page. All five shipped:

- **Built-in TURN** (`lib/studio.js`):
  - Each join gets 24-hour Cloudflare TURN credentials, minted on the server (the API token never reaches a browser) and cached for an hour.
  - Port-53 URLs are dropped. A Cloudflare outage falls back to STUN.
  - Env: `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`.
  - `tests/turn.test.js`.
- **First-run guide:** one next step at a time in the dock (name your show, camera and mic, invite, pick a scene, record or go live). Each step ticks itself off from what actually happened. You can hide it, and it's shown once.
- **AI allowance:**
  - With `HOUSE_AI_PROVIDER` + `HOUSE_AI_KEY` set, hosts without a key get `HOUSE_AI_DAILY` (default 25) assistant requests per studio per day. Each network address gets three studios' worth.
  - The panel shows how many are left. Over the limit, a clear message suggests adding your own key.
  - Tests are in `tests/ai.test.js`.
- **Go live:**
  - `relay/` is a Node + FFmpeg service (Dockerfile, fly.toml, README). The host's browser streams the program over WSS with a two-minute HMAC token, which gather issues to the host only.
  - H.264 is passed through; VP8 from other browsers is re-encoded. Output goes to up to 6 RTMP(S) destinations at once.
  - The Stream tab has destinations (YouTube, Twitch, Kick, Facebook, X, Rumble, other). Stream keys stay in the browser and are never synced.
  - There's a **Go live** button in the dock, a Live timer in the header, and live stats.
  - Env: `RELAY_URL`, `RELAY_SECRET`.
- **Watch page** (`/w/<studio>`):
  - Shows the live YouTube, Twitch or Kick player with a tab for each platform, plus links out to the others.
  - Says "not live" before and after the show and checks again every 15 seconds.
  - Public data only (title, live state, the watch links the host chose).
- **Verified:**
  - `tests/live.test.js` runs a real browser → relay → two local RTMP servers. Both receive 1280×720 H.264 + AAC.
  - Forged and missing tokens are refused, and guests can't get a token.
  - Stream keys never reach gather's server or the relay log.
  - The watch page goes from not live → playing → not live.
  - The VP8 re-encode path was checked separately.
  - All 12 suites, check, ui-kit and fx:live pass.

### To switch these on (owner)
1. **TURN:** Cloudflare dashboard → Realtime → TURN → create a key. In Vercel, set `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN`.
2. **Go live:** deploy `relay/` (see `relay/README.md`, about $2–5/month on Fly.io). In Vercel, set `RELAY_URL` and `RELAY_SECRET`.
3. **AI allowance (optional):** in Vercel, set `HOUSE_AI_PROVIDER` (e.g. `gemini`), `HOUSE_AI_KEY` and, optionally, `HOUSE_AI_DAILY`.
