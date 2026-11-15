# Simplify gather: what to cut, merge, hide and reorder

**Diagnosis.** A host in the studio sees about **270 controls**: 8 rail tabs, 14 dock and deck controls, and 6 side panels, with no separation between *setting up* and *being on air*. The counts below come from `public/index.html` and include each option in a segmented control: Brand 53, Settings 38, Stream 26, AI 24, Layouts 17 plus 8 add buttons, Banners 8, Chat 3, and the plan-a-stream wizard 35. There are three ways to open Sam (`#aiDock`, the AI rail tab, Present → "AI answer") and three Invite buttons (`#inviteCrew` in the header and deck, `#addSlot`). "Go live" is buried below the fold of the Stream tab. The header says "Live in studio" when nothing is live. StreamYard looks simple because it has **one primary action (Go live), one stage, and about 4 side tabs**. We should match that.

## (a) Inventory and verdicts

Frequency key: **E** = every show, **S** = sometimes, **O** = set once, **R** = rarely.

| Feature / control (IDs) | Freq | Verdict |
|---|---|---|
| Mic, camera, leave (`#micBtn #camBtn #leaveBtn`) | E | **Keep** in the dock. Add a ⌄ caret to each for device pick (the Zoom/Meet pattern) |
| Present menu (`#presentMenu`) | E | **Keep.** Cut the "AI answer" item, which duplicates Sam. Move the media library (`#libPick #libUrl #libList`) here as "Your files" |
| Record (`#recBtn`) / Go live (`#liveDock`) | E | **Keep.** Go live becomes the one primary button, top right, replacing the header Invite as the blue button |
| Scenes strip (`#sceneStrip`) | E | **Keep** under the stage. Cut "Scroll to switch" (`.deck-hint`) |
| People / Waiting (`#crewList #lobbyList #lockSwitch`) | E | **Keep.** Move Lock (`#lockWrap`) into the People view. Keep one Invite, in the header |
| Studio chat + platform chat + moderation | E | **Keep** as the default side tab |
| Banners + ticker (`#bannerText #tickerText`, presets) | E | **Keep.** Merge into a "Show" tab |
| Sam: ask and act (`#aiForm #cmdBar #aiDock`) | S | **Keep** the dock orb and `/`. Drop AI as a rail tab: the panel opens from the orb |
| Captions on/off (`#capSwitch`) | S | **Move** to the "Show" tab. Language, style and size move to Settings |
| Call-in line (`#callinCopy #callinCard`) | S | **Move** to the "Show" tab as one card |
| Chat overlay (`#overlaySwitch`) | S | **Move** to the "Show" tab |
| Destinations (`#destList #destAdd`), format (`#aspectSeg`), watch link | O | **Move** into a "Go live" dialog. Fold the wizard's `#wDest` list into it, because the two lists disagree (LinkedIn, Instagram and TikTok appear in one only) |
| Schedule wizard (`#wizDlg`) | O | **Keep**, but for scheduling only. Cut step 1 (`[data-wmode=now]` duplicates entering the studio). Make the thumbnail step optional |
| Platform chat connect (`#twitchForm #ytForm #rumbleForm`) | O | **Move** to Settings → Connections |
| X / TikTok "soon" rows (`.plat.soon`) | – | **Cut.** They are noise and give the host nothing to do |
| Google Drive (`#driveAuto #googleOut`) | O | **Move** to Settings → Recording. `#recDrive` already handles one-off saves |
| Layer editor (`#editToggle #tplList .adds #elList #elProps`) | S | **Move** behind "Edit layout" in the "Look" tab, shown only in edit mode |
| Grid and snapping essay (second `.hint` in Layouts) | – | **Cut.** Show a 1-line tooltip in edit mode instead |
| Save scene (`#layoutName #sceneMedia #savedList`) | S | **Keep** in "Look" |
| Brand: colour, background, logo (`#swatches #bgs #logoPick`) | O | **Keep** in "Look" → Brand |
| Font, name tags, banner style, panels, frame, animation (`#fontSel #tagSeg #bannerStyleSeg #panelSeg #frameSeg #animSel`) | R | **Merge** into 4 one-click "Themes", with "Customise" collapsed |
| `#animPreview` ("Play it again"), `#titleApply` | – | **Cut.** Apply changes as the host types |
| Studio title (`#titleInput`, `#wTitle`, the guide's "Name your show") | O | **Merge** into one inline-editable `#studioTitle` in the header |
| Sponsor ads (`#adsSwitch #adPick #adOpts`), tip QR (`#tipList`) | R | **Move** to a collapsed "Look" → "Sponsors & tips" section |
| Display name, camera-off picture, theme (`#nameInput #offBgPick #themeSeg`) | O | **Move** to Settings → You |
| Mic, gain, AI noise removal (`#micSelect #micGain #aiNoiseChk`) | O | **Keep** in Settings → Audio |
| Echo cancellation, browser noise suppression, auto level (`#echoChk #nsChk #agcChk`) | R | **Hide** under "Advanced" |
| Camera, quality, mirror, start-on (`#camSelect #qualitySelect #mirrorChk`) | O | **Keep** in Settings → Video |
| Frame rate, brightness, contrast, colour (`#fpsSelect #fxBright #fxContrast #fxSat`) | R | **Hide** under "Advanced" |
| Background effect (`#bgFxSeg`, key controls) | O | **Keep.** It is already in the green room (`#grFx`). Show key and spill controls only for Green screen |
| TURN server (`#turnUrl #turnUser #turnPass`) | R | **Cut** from the UI. Make it server config, with an env-var fallback |
| AI provider, key, model, voice, wake word (`#aiSetup`) | O | **Move** to Settings → Sam |
| Help panel (`[data-panel=help]`) | R | **Move** to a `?` in the header that opens search plus shortcuts in a popover |
| Getting-started guide (`#guide`) | O | **Keep**, as a first-run checklist in the empty side panel, not the dock |
| Home `#enterTop` | – | **Cut.** It duplicates `#enterStage`. Header shows "Join with code" only |

## (b) New structure

**Header:** title (inline edit) · status (only "Live" or "Recording", nothing otherwise) · Invite · **Go live**.
**Stage**, then **scenes strip** (the People and Waiting toggle sits beside it).
**Dock:** Mic⌄ · Cam⌄ · Present · Record · Sam · Settings (gear) · Leave.

**Side panel, 4 tabs at most:**
1. **Chat**: studio and platform messages, moderation, "Show on stage".
2. **Show**: what you put up live. Banner, ticker, captions, chat overlay, call-in card, countdown.
3. **Look**: themes, brand, logo, background, Edit layout, saved scenes, sponsors and tips.
4. **People**: guests, waiting room, Lock, and per-person controls. Phone only, where the deck collapses.

**Settings (modal, not a tab):** You · Audio · Video & background · Recording & Drive · Connections (platform chat) · Sam · Advanced.
**Go live (dialog):** destinations, format, title, watch link, then Start.

## Mode model

- **Set up**: all tabs, the checklist and the layout editor.
- **On air**: the header turns red with a timer and the side panel defaults to Chat. Editing the layout asks to confirm first. Leave becomes **End show**.
- **First use**: the green room is the wizard: name, camera, background, **Create studio**. Platforms come later, at Go live.

## Benchmarks (2025–26)

- **StreamYard / Restream**: destinations are set before the studio. Inside, one big Go live. About 5 sidebar tabs. Device settings live in a modal.
- **Riverside**: one dominant Record button. The producer controls stay out of guests' view.
- **Streamlabs Talk Studio**: themes are one-click presets, not 20 knobs.
- **Zoom / Google Meet**: carets beside Mic and Video put device settings at the point of use. About 6 centred controls, everything else under "More" or "⋮". The pre-join screen has one CTA.

## Copy principles

- Use plain verbs: *Go live, Record, Invite, Show, Hide, End show*. Buttons say what happens.
- No filler or slogans in the UI: cut "Step into the studio.", "The conversation studio", "Welcome back." on *Create account*, and every panel's restating subtitle.
- Use one name per thing. Pick **link** over code/room code/studio code, **Schedule** over Plan/Start a stream (`#wizOpen` says "Plan", `#wH` says "Start", `#upEmpty` says "Start a stream"), and **Sam (AI)** on first mention.
- Avoid this jargon or explain it inline: *RTMP, relay, TURN, WebRTC, stream key, chroma, key tolerance, spill, tier, layer, PiP, safe area, program, 8px grid*.
- Hints run one line at most. Errors say what to do next.

## (c) Phased plan

**Phase 1: copy and deletions (1–2 days, biggest gain per hour)**
- Remove `#enterTop` (home), `.deck-hint`, `#inviteCrew`, `#addSlot`, `[data-present=ai]`, `.plat.soon`, `#animPreview`, `#titleApply`, the Layouts grid essay, and wizard step 1 (`[data-wmode=now]`).
- Replace "Live in studio" (`#statusText`) with nothing until live.
- Unify the Schedule and link wording. Delete all `.panel-head p` subtitles.

**Phase 2: re-home (3–5 days)**
- Promote `#liveDock` to a header primary button that opens a Go live dialog holding `#liveSec` and `#aspectSeg`.
- Turn `[data-panel=settings]` into a modal reached from a dock gear. Move into it `#aiSetup`, `.platforms` forms, `#driveAuto`, `#capOpts`, and Advanced (`#echoChk #nsChk #agcChk #fpsSelect #fxBright #fxContrast #fxSat`).
- Remove the TURN fields.
- Cut the rail from 8 to 4: drop `[data-tab=ai]`, `[data-tab=help]`, `[data-tab=settings]` and `[data-tab=stream]`. Merge `banners` into the new **Show** tab (plus `#capSwitch #overlaySwitch`, call-in). Merge `layouts` and `brand` into **Look**. Move the media library into `#presentMenu`.

**Phase 3: modes (1 week)**
- Add the On air state (`body[data-onair]`): it collapses Look and changes Leave to End show.
- Replace the 7 style pickers with Themes.
- Move `#guide` into the empty side panel. Add the Help popover in the header.
