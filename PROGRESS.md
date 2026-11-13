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
