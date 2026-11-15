# Flow & IA audit: gather

Method: I walked every flow as a first-time host and as a guest (two Playwright contexts on :8111), using the screenshots in `audit/screens/design-before/` (prefix `1440-` etc.) and my own in `audit/design-team/shots/flow/` (`f01`–`f10`).

**Verdict:** the core loop (create, invite, talk, record) works in about 3 clicks. The IA around it is a feature dump. There are 8 rail tabs, 4 ways into the AI, scenes in two places, a Go live button that no first-time user ever sees, and a Leave button that silently destroys a recording and hands the studio to a guest.

## (a) Top 10 findings

| # | Sev | Where | What's wrong | Evidence |
|---|-----|-------|--------------|----------|
| 1 | P0 | `#leaveBtn` | One click with no confirmation. It stops the recording (you get the "Recording ready / discarded unless you download" dialog with no warning) and ends any stream. The guest is silently promoted to host and gets the full host UI, the setup guide and the API-key form. There is no "End for everyone". | f09, f10 |
| 2 | P0 | Stream panel `#liveSec`, `#liveDock` | Going live is impossible without a relay. The dock button is `hidden` (app.js:3123), and the panel shows developer copy ("see relay/README.md"). The headline feature of a StreamYard alternative is a dead end with no way out. | 1440-07, f01 |
| 3 | P0 | Header `#statusText` + people cards | "Live in studio" (green dot) and red **LIVE** badges show while nothing is being broadcast. "Live" means two things, so the most important state in the product cannot be trusted. | 1440-05, f03 |
| 4 | P1 | Rail `.rail` | There are 8 peer tabs with no hierarchy. Layouts, Banners and Brand are all "how the stage looks". Help and Settings are utilities sitting next to production tools. On 390px the rail scrolls and Settings/Help fall off-screen. | 1440-05, 390-05 |
| 5 | P1 | Layouts panel vs `#sceneStrip` | The "Start from a template" grid repeats the scene strip (Full-screen slides, Screen + AI, Cinematic solo, Interview…). Users can't tell a scene from a layout from a template. | 1440-10 vs 1440-05 |
| 6 | P1 | AI: `[data-tab=ai]`, `#aiDock`, `/` → `#cmdBar`, Present › "AI answer" | There are four entry points. The cmd bar says "Ready" when no key is set, and the key form only lives in the AI tab behind the `#aiSetupBtn` sliders icon. Guests get an AI tab that is an empty log. | f07, 1440-08, f04 |
| 7 | P1 | Guide `#guide` | Step 1 "Name your show" sends you to the **Brand** tab (`#titleInput`), while the title is visible in the header and can't be edited there. Step 5 "Record or go live" sends you to Stream, which is the dead end from finding 2. | 1440-05, app.js:3436 |
| 8 | P1 | Studio chrome before entry | The landing page *is* the studio, disabled: an inert scene strip with a red-bordered selection, a disabled dock, 8 clickable tabs that open forms you can't use (f01), and two CTAs that do the same thing (`#enterTop`, `#enterStage`). | 1440-01, f01 |
| 9 | P2 | Invite `#inviteDlg` | The primary button is "Copy room code". The code path costs the guest 4 steps (open gather → Join → paste → go); the link drops them straight into the green room. The guest also hits "Click the stage to enable participant audio" right after joining. | 1440-04, f03 |
| 10 | P2 | Stream panel | One scroll holds go live, Plan a stream, Upcoming (sign-in upsell), Call-in line, destinations and Google. That is about 6 jobs in one panel, and red is used both for "selected scene" and for Record/Leave. | 1440-07 |

## (b) Proposed IA

**Rail: 8 → 4 tabs, plus 2 utilities moved to the header**

| Now | Proposed |
|-----|----------|
| Chat | **Chat** |
| Stream | **Go live**: destinations, live status, watch link. Plan/Upcoming/Call-in collapse into a "More" disclosure. |
| AI | **Producer**: one AI home. The `/` bar becomes its quick input, not a second product. |
| Layouts + Banners + Brand | **Design**: segmented `Scene · Banners · Brand`. "Edit on stage" moves onto the scene card's ⋯ menu. |
| Settings, Help | Header icon buttons (gear, ?). Settings becomes a modal, the same device UI as the green room. |

Guests see Chat (plus Producer only when the host has AI on). The deck keeps **Scenes / People**. Scenes stays the *only* place to pick a layout, and Layouts templates become "New scene from template" at the end of the strip.

**Dock = the primary path, left → right:** Mic · Cam · Present · | · **Record** · **Go live** (always visible) · | · Leave/End. Drop the separate `#aiDock` Sam button: `/` and the Producer tab already cover it.

**Click counts (first-time host)**

| Task | Before | After |
|------|-------:|------:|
| Create studio + send link | 3 (create, create, copy *code*, then guest needs 4 more) | 3 (link is primary, guest needs 1) |
| Name the show | 3 (guide → Brand → find field) | 1 (click title in header) |
| Go live (relay configured) | 4–6 (Stream tab, scroll, add dest, key, Go live) | 3 (dock Go live → pick saved dest → Start) |
| Go live (no relay) | ∞ dead end | 1 → honest "Not available on this server" + "Record instead" |
| Show a banner | 2 + typing | 2 + typing (unchanged) |
| Ask AI first time | 4+ (find tab, ⋯ setup, key, back, ask) | 2 (`/` → inline "Add key" in the bar) |
| Leave safely while recording | 1 (destroys work) | 2 (confirm: "Stop & save / End for everyone / Leave, keep studio running") |

## (c) Engineering changes

1. **Leave/End** (`#leaveBtn`, `leave()` app.js:3754): when `S.rec || S.live || S.peers.size`, open a confirm dialog. Hosts get **End for everyone** (broadcast close) and **Leave**. Never stop `S.rec` without the dialog first, and toast guests when host passes to them.
2. **Go live always visible** (app.js:3123): remove the `!S.relayOn` term from `#liveDock.hidden`. When the relay is off, the click opens a sheet saying "Live streaming isn't set up on this server. Record now and upload later." Rewrite `#liveOff` copy for end users and move the README pointer to an HTML comment.
3. **One meaning of "live"**: change `#statusText` online label from "Live in studio" to "Connected". Show `.live` badges on crew cards only when `S.live?.phase === 'live'` and rename them "On stage". `#livePill` is the only "Live" indicator.
4. **Rail**: delete `[data-tab=layouts]`, `[data-tab=banners]` and `[data-tab=brand]`, and add `[data-tab=design]` wrapping the three existing `<section data-panel>` bodies under a `.seg`. Move `[data-tab=settings]`/`[data-tab=help]` into `.top-actions` as `.icon-btn`. Rename `[data-tab=stream]` caption to "Go live" and `[data-tab=ai]` to the AI's name (`#cmdName`).
5. **Scenes**: remove the template grid from the Layouts panel and append a `+ New scene` tile to `#sceneStrip`. Change the selected-scene outline from red to accent, since red is reserved for Record/Live/Leave.
6. **AI**: hide `#aiDock`. In `#cmdBar`, if no key, replace `#cmdState` "Ready" with an inline "Add a key" button that opens `#aiSetup`. Hide `[data-tab=ai]` for guests unless the host has AI enabled. Remove Present › `data-present="ai"` (it duplicates `/`).
7. **Title**: make `#studioTitle` `contenteditable` (host only), bound to the same state as `#titleInput`. Point GUIDE step `name` at it.
8. **Pre-entry**: before `S.studio`, hide `.rail`, `#deck` and `.dock`. `#stageEmpty` becomes the whole landing page. Drop `#enterTop` while offline (keep `#userBtn`).
9. **Invite**: swap `#copyLink` to `.primary` and `#copyCode` to secondary. Fold `#inviteFine` seat count into the heading ("1 of 6 seats").
10. **Guest audio**: on `#enterGo` click (a user gesture), resume the AudioContext so the "Click the stage to enable participant audio" toast never appears.
