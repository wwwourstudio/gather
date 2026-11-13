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
