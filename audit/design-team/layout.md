# Layout, density and overlap review

Measured with Playwright in the studio state (host, one camera, setup guide showing). Script output: `shots/layout/measurements.json`. Screenshots: `shots/layout/<WxH>-studio.png`, `-panel-stream.png`, and on mobile `-studio-full.png` and `-scrolled-side.png`.

## (a) Measured data

| Viewport | Controls in view | Real overlaps | H-overflow | Targets <44px | Video % of viewport | Glass surfaces | Page height |
|---|---|---|---|---|---|---|---|
| 1920×1080 | 38 | 0 | no | 14 (desktop) | **38.0** | 6 | 1 screen |
| 1440×900 | 35 | 0 | no | 14 | **32.4** | 6 | 1 screen |
| 1280×720 | 34 | 0 | no | 14 | **18.1** | 6 | 1 screen |
| 1024×768 | 32 | 0 | no | 14 | **21.3** | 6 | 1 screen |
| 768×1024 | 31 | 0 | no | 12 | 36.9 | 6 | 1.6 screens |
| 390×844 | 27 | 0 | no | 11 | **19.8** | 6 | 1.6 screens |
| 360×740 | 27 | 0 | no | 11 | 20.3 | 6 | 1.7 screens |

Notes. The script reported 1–2 overlaps per viewport. Both are scene tiles against `#addSlot` and `.crew-tools` buttons in the off-screen "people" deck layer, which uses `opacity:0; pointer-events:none`, so they don't overlap visually. Those buttons can still get keyboard focus, though (problem 9). Clipped text: `#studioTitle` is cut to 63px at 390 and 33px at 360, so "The conversation studio" shows as "The co…". No page-level horizontal overflow, but there are 3 sideways scrollers at 360: `#sceneStrip`, `.rail` (Settings and Help are off-screen) and `.dock-tools`. The mobile dock is 104–118px tall, which is **14–16 % of the screen**.

## (b) Top-10 layout problems

| # | Sev | Viewport | Selector | Evidence |
|---|---|---|---|---|
| 1 | High | ≤900 | `.dock` (sticky) over `.side` | `#chatInput` and `#chatSend` stay under the dock even when the side panel is scrolled fully into view (`behindDock`, all 3 mobile sizes). You can't send a chat message on a phone. |
| 2 | High | 1280×720, 1024×768 | `.studio` / `.deck` / `.stage-card` | The video gets only **18–21 %** of the screen. On 1280×720 it is 544×306 in a 787px column, because the header (60), deck (~190), dock (70) and gaps take the height. |
| 3 | High | ≤900 | `.side { height:72vh }` + `.panel-body {overflow:auto}` | Scroll trap: a 533–737px inner scroller inside a page that scrolls 1.6×. The panel takes over the swipe halfway down the page. |
| 4 | High | all | `.main` columns `1fr 360px 76px` | The side panel and rail take 436px (30 % at 1440) and are always open, even when chat is empty. Chat is the default panel, so the video loses that width permanently. |
| 5 | Med | all | 6 glass cards: `.top`, `.stage-card`, `#deck`, `#side`, `.rail`, `.dock` | Six bordered, blurred surfaces compete. The stage also sits in a card with an inner frame (card inside a card), which adds 32px of padding around the video. |
| 6 | Med | all | visible controls | 27–38 controls are on screen at once. Header has 2 CTAs plus status, rail has 8, deck has 4 plus 6–8 tiles, dock has 5 plus guide (2) plus Leave. "Invite" appears 3 times (`#enterTop`, `#inviteCrew`, `#addSlot`). |
| 7 | Med | ≤480 | `.rail` (row, `overflow-x:auto`) | At 390/360 the panel nav scrolls sideways and Settings and Help are hidden with no hint. |
| 8 | Med | ≤900 | `.dock` + `.guide` (`flex-basis:100%`) | The setup guide stacks a second row into the sticky dock, making it 104–118px. `.dock-tools` also scrolls sideways at 360. |
| 9 | Med | all | `.deck-layer.below/.above` | Hidden deck layers use opacity only, so their buttons (`#addSlot`, `.ct-mute`, `.ct-kick`) can still be reached with Tab while invisible. They should be `visibility:hidden` or `inert`. |
| 10 | Low | ≤900 | tap targets | `#lockSwitch` 28×16, `#lockWrap` 64×28, `#inviteCrew` 82×28, `#guideGo` 79×28, `#guideSkip` 28×28, `.crew-tools .icon-btn.sm` 24×24, `#userBtn` 36×36, `#leaveBtn` 64×36. `#studioTitle` is cut to "The co…". |

## (c) Proposed simpler layout

Principle: the video is the hero, and only one optional surface is open at a time. Target video share: **≥ 50 % at desktop** (≥ 40 % at 1280×720) and **≥ 28 % on mobile**, with nothing covering the input.

Desktop (≥ 1025):
```
┌ gather. Show title ● Live in studio ─────────────── [Go live] [avatar] ┐  48px, 1 primary CTA
├────────────────────────────────────────────────────────────┬──┬────────┤
│                                                            │💬│ Panel  │  rail 56px icon-only;
│                     PROGRAM VIDEO (16:9)                   │📡│ 320px, │  panel is a drawer,
│                                                            │✨│ CLOSED │  closed by default
│                                                            │▦ │ by     │  (opens over/beside,
│                                                            │⚙ │ default│  badge on 💬)
├────────────────────────────────────────────────────────────┤? │        │
│ [Solo][Side][Spot][Slides][Scr+AI][Cine]  Scenes ▾ People ▾│  │        │  deck 88px, no card
├────────────────────────────────────────────────────────────┴──┴────────┤
│ 🎤 📷 ⬆Present │ ⏺Rec  ✨Sam        (guide chip: 1/5 Name your show ›)  Leave │  dock 60px
└────────────────────────────────────────────────────────────────────────┘
```
What collapses or moves:
- The side panel becomes a drawer that is closed by default.
- Banners and Brand merge into one "Look" panel; Help moves into ⚙ / `?`.
- The deck loses its card and shrinks to 88px thumbnails. "Lock", the count and "Invite" go into a People ▾ popover.
- Header keeps one CTA. Account goes into the avatar.
- The guide becomes a single chip.

Mobile (≤ 900):
```
┌ gather.  The conversation stu…  ●  [⋯] ┐ 48px, title gets the width
├────────────────────────────────────────┤
│        PROGRAM VIDEO (full-bleed)      │ no card padding, edge-to-edge
├────────────────────────────────────────┤
│ [Solo][Side][Spot][Slides]… →          │ scene strip 72px
│ (guide chip, dismissible)              │
│                                        │
├────────────────────────────────────────┤
│ 🎤   📷   ⬆   ⏺   ☰ More               │ fixed dock 64px, 5×56px targets
└────────────────────────────────────────┘
☰ More → bottom sheet (Chat, Stream, AI, Layouts, Look, Settings, Help);
the sheet owns its own scroll and pins the chat input above the keyboard/dock.
Leave → inside the sheet (or long-press), not a permanent red button.
```

## (d) Concrete CSS/HTML changes

1. **Drawer side panel.** Change `.main { grid-template-columns: minmax(0,1fr) 56px; }` and add `.main.panel-open { grid-template-columns: minmax(0,1fr) 320px 56px; }`. Clicking the active `.rail-btn` again closes the panel. The default state is closed, with `#chatBadge` showing unread messages.
2. **Free the stage.** Change `.stage-card { padding: 0; background: none; border: 0; }` and drop the inner frame shadow on `.stage`. Use `.deck-body { height: 88px }` and `.scene { width: 120px }`. Remove `.deck` from `.glass`, then use `.deck-hint, .crew-count { display:none }` and move `#lockWrap` and `#inviteCrew` into a People popover.
3. **Fewer surfaces.** Keep `.glass` only on `.top` and `.dock` (plus `#side` when it's open), and set `.rail` to `background: transparent; .rail-btn .caption { display:none }` (tooltips already exist via `data-tip`).
4. **Header.** Keep one primary button. Remove the duplicate `#enterTop` "Invite" label once you're in the studio, or make it "Go live". At ≤900 use `.top-title strong { max-width: none; flex:1 }` and hide `.logo-word` behind a 28px mark.
5. **Mobile scroll and dock** (`@media (max-width:900px)`):
   - `.app { height: 100dvh; }` and `.main { overflow: hidden }`.
   - `.side, .rail { display:none }`, replaced by a `<dialog class="sheet">` with `max-height: 85dvh; overflow:auto; padding-bottom: calc(var(--dock-h) + env(safe-area-inset-bottom))`.
   - `.dock { position: fixed; inset: auto 8px env(safe-area-inset-bottom) 8px; height: 64px; flex-wrap: nowrap }` and `.guide { position: static; order:0; flex-basis:auto }`, so the guide becomes a chip under the scene strip.
   - Add `body { padding-bottom: calc(64px + 16px) }`.
   - Remove `.side { height:72vh }`. This removes the scroll trap and the covered `#chatInput`.
6. **Hidden deck layers:** `.deck-layer:not(.on) { visibility: hidden; }` (or set `inert` in JS).
7. **Touch targets** at ≤900:
   - `.toggle-inline.lock, #inviteCrew, #guideGo, #guideSkip, .crew-tools .icon-btn.sm, #userBtn, #leaveBtn { min-height: 44px; min-width: 44px; }`
   - `.toggle.sm` hit area via `label` padding.
8. **Rail overflow:** at ≤480 show 5 tabs plus "More" instead of horizontal scroll. In HTML, add `<button class="rail-btn" data-tab="more">` and hide Banners, Brand and Help.
