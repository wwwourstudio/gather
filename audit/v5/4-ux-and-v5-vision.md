# Audit 4 of 4: UX, design quality and the V5 vision

**Method.** I ran the app locally (`ALLOW_ANON_STUDIOS=1`, plus one server with accounts required and one with a relay) and drove it with Playwright Chromium using a fake camera and mic. I walked the full host journey and a second guest browser at **1440×900, 1024×768 and 390×844**:

> land → create → green room → invite → guest joins → put guest on stage → switch scene → brand → banner → Go live → record → stop → leave

I also did:
- a keyboard-only pass
- an ARIA snapshot of the header, deck and dock
- a computed-contrast scan
- reduced-motion emulation
- stage-area and layout-shift measurement

Screenshots are in `audit/v5/shots/ux/`, named `<width>-<step>.png`; the guest's are `<width>-g*.png`. The scripts are in the session scratchpad (`a4/journey.js`, `a11y.js`, `acct.js`, `golive.js`).

I read the V4 design-team reports and PROGRESS.md first. I do not repeat issues they already fixed: the Leave confirm, "Live" meaning only broadcasting, the 4-tab rail, focus rings and AA contrast.

---

## 1. What works well

- **The core loop is fast.** With anonymous studios, a host is in a studio with an invite link after **2 clicks and about 0.7 s** from pressing Create. The invite dialog opens itself and its primary button copies the link.
- **The guest path is short.** The `/s/<code>` link opens the green room with the code pre-filled and "Join studio" pre-selected. Guests never need an account, and they get a reduced UI (Chat only, "The host switches scenes").
- **The green room is good.** It has a live preview, mic meter, Real/Blur/Picture/Green screen backgrounds, and device pickers. "Nobody sees you until you go in" is exactly the right reassurance.
- **Backstage by default.** When a guest arrives, the host gets "Gina Guest is backstage · Put on stage", and one click puts them on. This beats StreamYard's default for a first-time host.
- **The scene thumbnails look like the layouts they apply**, are numbered for 1–9 hotkeys, and switch instantly. Selection uses the accent colour, not red.
- **The Leave confirm is clear:** "Leaving will hand the studio to your guest." The recording dialog shows a preview, size and format, with Download and Save to Drive side by side.
- **Visual system.** It uses tokens, one icon family (Lucide), a quiet blue-graphite palette and one primary action per surface. The landing page is calm and reads as a product, not a template. Typography (Plus Jakarta for display, Inter for the UI) is consistent.
- **Accessibility basics hold:**
  - My scan found no text below AA contrast outside the stage.
  - Every visible control has an accessible name.
  - The scene buttons expose `aria-pressed`, and the deck is a real tablist.
  - Toasts, chat and the AI log are live regions.
  - No animations run under `prefers-reduced-motion`.
  - The landing tab order is logical.
- **Perceived performance is good.** The landing page reaches first paint at about 0.5 s with 475 KB transferred. Layout shift across a whole host session is 0.002 at 1440, 0.007 at 1024 and 0.019 at 390, all far under the 0.1 threshold. There were no console errors in any run.

---

## 2. UX problems

Severity: **P0** blocks or harms users · **P1** major confusion or breakage · **P2** friction · **P3** polish.

| # | Sev | Problem | Evidence | Where in code |
|---|---|---|---|---|
| 1 | **P0** | **Pressing Enter in the green-room name field closes the green room and turns off the camera.** The dialog's `returnValue` is `"cancel"`, and no studio is created or joined. This hits every guest who types their name and presses Enter, which is the most natural action in the flow. The cause: the close button is the form's first submit button, so implicit submission uses it, and the submit handler returns early unless `submitter.value === 'go'`. | `1440-a11y-enter-key.png` (the dialog has gone, back on the landing page) | `index.html:639` (the close `<button>` has no `type="button"`); `app.js:4650-4651`. The same pattern is in `#inviteDlg` (`index.html:843`) and `#recDlg`. |
| 2 | **P0** | **Go live is still a dead end on any deployment without the relay**, and the copy shown to hosts is written for developers: "Site owner: deploy the relay in `relay/`… set RELAY_URL and RELAY_SECRET". Meanwhile the header's only primary button is a blue **Go live** that leads there. Even with the relay on, a first-timer has to leave the app for YouTube Studio, find the RTMP key and paste it. When the key is missing, the in-dialog Go live button is just dimmed, with no message. | `1440-13-golive-dialog.png`, `1440-22-golive-youtube-added.png`, `1440-23-golive-no-key.png` | `index.html:465-482` (`#liveOff`), `#destList`; `app.js` `renderLive` |
| 3 | **P1** | **Guests get no lasting sign that they are being recorded.** They see a 3-second toast ("X started recording") and nothing after it. The host has a red header pill and a red dock button. This is a consent and trust problem; Riverside and StreamYard both show a persistent REC badge to everyone. | `1440-g05-guest-while-recording.png` (no indicator; the body text has no "record") | `app.js:650` (toast only); `#recPill` is set only from the host's own `S.rec` (`app.js:3530`) |
| 4 | **P1** | **The video gets too little of the screen.** The stage canvas covers **43 %** of the viewport at 1440×900, **35 %** at 1280×720, **26 %** at 1024×768 and **24 %** at 390. Hiding the panel only reaches 51 %. Meanwhile the panel's empty chat, the 4-icon rail, a 120 px scene deck and an 80 px dock with a setup-guide banner all compete with it. StreamYard gives the canvas about 55–60 % at 1440. | `1024-05-studio-empty.png`, `1440-05-studio-empty.png`, `1440-panel-hidden.png` | `style.css:57`, `:612` (`.main` grid: `1fr 320px 60px`), deck in `.deck` |
| 5 | **P1** | **Phone header overflows while recording.** The recording pill wraps onto two lines and pushes **Go live** off-screen (its right edge is at 436 px on a 390 px screen). | `390-rec-header.png`, `390-14-recording.png` | `style.css:642-649` (`.top-actions`); `#recPill` is not collapsed to a dot on narrow screens |
| 6 | **P1** | **A banner covers a guest's camera.** In "Spotlight", "Welcome to the conversation" lands on top of the guest thumbnail, both live and in the recorded file, even though the layout engine's headline feature is collision avoidance. | `1440-12-banner-on.png`, `1440-15-recording-ready.png`, `1440-g05-guest-while-recording.png` | `layout.js` (the banner and lower-third system layers are not checked against camera slots in preset scenes) |
| 7 | **P1** | **When the host leaves, a guest is silently promoted.** The guest gets the full host UI: Record, Go live, Sam, Look, a setup guide at "1 of 5", and Lock. The notice is one transient toast ("You are now the host"), and at 1440 it had already expired before I could read it. There is no "End for everyone" and no "The host left: stay / leave" choice. | `1440-g06-guest-after-host-left.png` (8 host-only controls visible) | `app.js:627`, `:646` |
| 8 | **P1** | **Participant audio can start muted.** The host and guest both get "Click the stage to enable participant audio." A first-time host who doesn't read the toast hears nothing from their guest, and can't tell whether the guest is muted or the app is broken. (This was seen in headless Chromium; on real Chrome it happens whenever autoplay has no gesture, e.g. after a reload in the studio.) | `1440-06-host-guest-knock.png`, `1440-g03-guest-studio.png` | `app.js:747` |
| 9 | **P1** | **Creating a studio with accounts on takes 5 clicks and 4 fields, and greets a newcomer with "Welcome back".** The flow is Create a studio → "Welcome back / Sign in" (the default tab for a first-time user) → Create account → name, email, password, and a required terms checkbox, even though the footer already says "By continuing you agree…". It errors if the box is unticked. | `1440-18-create-needs-account.png`, `1440-19-create-account.png` | `index.html:700`, `app.js:2551`, `api/account` |
| 10 | **P2** | **The AI ("Sam") is a dead end without a key.** Opening AI, or the dock orb, shows a provider and API-key form ("Add a Claude key to start"). Sam sits in the dock and the landing page sells "An AI producer", but most hosts don't have an API key. | `1440-ai-panel.png`, `1440-cmdbar.png` | `index.html:173-219`; the house allowance needs `HOUSE_AI_*` |
| 11 | **P2** | **The setup guide gets stuck on "Name your show"** even at "4 of 5 done", because the default title "The conversation studio" counts as not done. That placeholder title also sits in the header and in the browser tab as though it were the show's real name. | `1440-14-recording.png` (guide reads "4 of 5 done · Name your show") | `app.js:57` (`DEFAULT_TITLE`), `:3543` (guide steps) |
| 12 | **P2** | **The scene strip scrolls sideways with no sign that it does.** 12 tiles sit in a 1000 px strip, the last visible tile is cut mid-word ("Slides + sp"), and at 1024 and 390 most tiles are off-screen. Keyboard users have 12 tab stops just to get past it, because there is no roving tabindex. | `1440-05-studio-empty.png`, `1024-05`, `390-05` | `#sceneStrip` (`index.html:133`) |
| 13 | **P2** | **The Go live dialog mixes three jobs:** destinations, then Format (after the Go live button, so the order is wrong), then "Plan a stream" and "Upcoming / sign in". It also names the same thing three ways ("Plan a stream" here, "Schedule a show for later" on the landing page, and "Go live → Schedule" in Help), even though V4 decided on one name. | `1440-21-golive-relay-on.png`, `1440-a11y-help.png` | `index.html:465-520` |
| 14 | **P2** | **Keyboard focus and screen-reader structure:** <ul><li>After the auto-opened invite dialog is closed, focus drops to `<body>`.</li><li>There is no skip link.</li><li>The studio has no `h1` (the only heading is "Chat").</li><li>Reaching **Record** takes about 34 Tabs: header → deck → 12 scenes → chat → rail → dock. The dock comes last in the DOM even though it holds the most-used controls.</li><li>`#recBtn` exposes no state; the label just changes from "Record" to "00:04".</li><li>The stage canvas has no description of what is on it, such as who is on stage or which scene is active.</li></ul> | a11y run (`a11y.json`), `1440-a11y-landing-focus.png` | `index.html:442` (`#recBtn` has no `aria-pressed`), `:84` |
| 15 | **P2** | **Settings is one long scrolling sheet**, about 60 controls in an 860 px modal. It covers Appearance, name, mic (6 switches), camera (brightness, contrast, colour), background, TURN, platform chat and Drive. V4 planned sections (You · Audio · Video · Connections) but they were not built. | `1440-settings.png` | `index.html` Settings dialog |
| 16 | **P2** | **The dock shows guests "Copy link" and the raw studio code**, which invites guests to share the studio. On phones the guide banner and dock together take about 110 px of an 844 px screen, and the chat sits below the fold (the document is 1157 px tall). | `1440-g03-guest-studio.png`, `390-05-studio-empty.png` | `#noteInvite` in the dock; `style.css:700+` |
| 17 | **P3** | **Text is too small.** The studio uses 9, 10 and 11 px text in 25 places: deck counts, people-card meta, rail captions and kbd hints. On the phone stage, name tags draw at about 6 px. | `390-07-host-guest-on-stage.png` | tokens `--fs-*`; name-tag size in the stage renderer is fixed relative to 1280 px |
| 18 | **P3** | **Green-room nits:** <ul><li>"Green screen" is clipped at 390.</li><li>The background segments are 26 px tall on touch.</li><li>"Add a photo · shown when your camera is off Remove" reads as one run-on sentence.</li><li>"Step into the studio." is filler copy that V4 itself said to cut.</li></ul> | `390-02-green-room.png` | `index.html:640-680` |
| 19 | **P3** | **Toasts carry actions and sit in the middle of the deck.** The "Put on stage" toast covers the scene strip and disappears, and two toasts stack over the scene tiles. Actions that matter, like admitting a guest, belong in a persistent spot such as the people tray. | `1440-06-host-guest-knock.png` | `#toasts` |

**Clicks and time to first "live" (first-time host):**

| Path | Clicks | Typed fields | Leaves the app? | Time |
|---|---|---|---|---|
| Local, anonymous studios, relay off | 2 to studio, then a **dead end** | 1 | – | ~3 s to studio |
| Production (account required), relay on | ≈ 10 (Create → Create account tab → consent box → Create account → Create studio → close invite → Go live → add destination → Go live) | 5 (name, email, password, stream key, and optionally the watch link) | **yes**: YouTube Studio for the key | ~3–5 min for a newcomer |
| StreamYard (for reference) | ≈ 6 the first time (sign in with Google → connect YouTube by OAuth → Create → Go live), 2 after that | 0–1 | no (OAuth popup) | ~1 min |

---

## 3. Competitive gap analysis

Sources for the 2026 state of competitors: StreamYard's changelog (new.streamyard.com), Riverside 2.0 (riverside.com/blog/riverside-2-0), and Restream reviews (learningrevolution.net/restream-review). Ecamm and OBS are from domain knowledge.

| Feature / experience | StreamYard | Riverside | Restream Studio | **gather today** |
|---|---|---|---|---|
| Connecting a destination | OAuth one click (YouTube, FB, LinkedIn, X, Twitch…) | OAuth, live is secondary | OAuth to 30+ platforms | **paste an RTMP key**; needs a self-hosted relay |
| Clicks to live (returning host) | 2 | 3 | 2–3 | 3–4 if the relay exists, otherwise impossible |
| Guest join | link → name → join | link → device check → join | link | link → name → Join (**Enter key breaks it**) |
| Backstage / green room | yes, plus private chat with guests | yes | yes | yes, default on; **no private backstage chat** |
| Recording quality | cloud recording plus local multitrack (paid) | **local 4K per-track, uploaded progressively** | cloud | browser MediaRecorder of the composite canvas, **host-only, single track, lost if the tab closes** |
| Guest-visible REC indicator | yes | yes | yes | **no (toast only)** |
| Editing after the show | basic clips | text-based editor, AI clips, captions, Agents (Oct 2026) | AI clips (paid add-on) | **none**: download a WebM |
| Brand presets | brand kits, one click | templates | brand kits | 20+ separate knobs; no one-click themes |
| Layout engine | about 8 fixed layouts | fixed | fixed | **best in class**: free layers, snapping, collision avoidance, per-scene memory |
| Background effects | blur/replace | blur | blur/replace | **best in class**: guided-filter matte, real chroma key with spill removal |
| AI producer | none on air (AI for clips/titles) | AI co-producer/agents in post | AI clips | **unique**: switches scenes, presents, banners and search by voice; **needs the host's own API key** |
| Audience chat on screen | yes, multi-platform | limited | yes | yes (Twitch, YouTube, Rumble); YouTube needs Google set up on the server |
| Phone hosting | app plus mobile web | app | limited | works but cramped (stage 24 % of screen, header overflow) |
| Price to start | free with watermark | free tier | free with watermark | free, no watermark, **no install** |

**The honest position:** gather's *compositor* already matches or beats the leaders: the layout engine, background effects and AI producer. The *pipes* around it are behind: going live, the recording's quality and safety, and what happens after the show. So is the *first five minutes*. Users judge on pipes and the first five minutes.

---

## 4. V5 proposal: "The show runs itself"

### 4.1 What "50× better" means, in numbers

"50×" cannot be one number, so V5 sets targets across the funnel. Each one is measured by an automated Playwright journey (the one in this audit) plus production telemetry.

| Metric | Today | V5 target | Factor |
|---|---|---|---|
| Clicks from landing to **on air** (new host, prod) | ≈ 10 + 5 fields + a trip off-site; ∞ without the relay | **3** (Continue with Google → Go live → confirm) | 3–∞× |
| Time to first live for a new host | 3–5 min | **< 45 s** | 5× |
| Time for a guest from link to on stage | ~8 s, with a 1-in-N Enter-key failure | **< 5 s, 0 dead ends** | 1.6×, ∞ for failures |
| Sessions where any participant can't be heard | unknown (audio-blocked toast) | **< 0.5 %** (measured from the receiver's audio level) | — |
| Recordings lost (tab closed, crash) | 100 % of those sessions | **0 %** (progressive save) | ∞ |
| Minutes from "end show" to a postable clip | ∞ (no editor) | **< 2 min** (auto highlights + captions) | ∞ |
| Stage share of the viewport at 1440 / 1024 / 390 | 43 / 26 / 24 % | **65 / 55 / 45 %** | 1.5–2× |
| Controls visible on the main screen | ~40 | **≤ 15** | 2.7× |
| axe serious/critical issues | ~0 static; P0 keyboard bug | 0, plus a full keyboard journey in CI | — |

The 50× comes from multiplying these: about 3× fewer steps × about 5× faster × 0 lost recordings × a post-show product that does not exist today. The north-star metric is **shows completed and published per new host in week 1**.

### 4.2 Information architecture

There are three modes, which V4 deferred:

1. **Prepare** (before the show): Run of show, Look, Guests, Destinations. The panel is open by default and the stage is a preview.
2. **On air** (live or recording): the stage takes the space. A thin **Producer bar** holds the cues, and everything else is one keypress away. The header turns red with a timer. Leave becomes **End show**.
3. **After** (post-show): Recording, Highlights, Captions, Publish.

These are top-level objects, not tabs:
- **Show**: title, run of show, destinations and schedule. It persists across sessions.
- **Studio**: the live room.
- **Library**: media, scenes, themes and recordings.

### 4.3 Main screens

**A. Landing → "Start a show"** (one screen, not landing + dialog + dialog)
- On the left, 40 % of the width: the H1, then one primary button, **Start a show**, then a "Join with a link" field.
- On the right, 60 %: **the user's own camera preview**, live as soon as permission is given. The hero *is* the green room. Background chips sit under it.
- Clicking Start a show:
  - If not signed in, it shows inline **Continue with Google** and **Continue with email (magic link)**. There are no passwords and no checkbox (consent goes in the button label).
  - Then straight into the studio. The name comes from Google, and the title defaults to "<Name>'s show", editable in place.
- The target is 1–2 clicks.

**B. Studio: Prepare mode (1440×900)**

- **Header (48 px):** wordmark · editable show title · mode switch `Prepare | On air` · (right) people avatars with a live count, then **Invite**, then the primary **Go live ▾** split button (its menu has: Record only, Go live, Go live + record).
- **Stage:** fills `min(100% − 360 px, (100vh − 48 − 56 − 96) × 16/9)`, centred, with no outer card or gutters (the program *is* the hero). That gives 1060×596 at 1440, which is **49 % of the viewport, 65 % of the work area**.
  - A safe-area ghost appears only on hover.
  - On the stage edge there is a **Scene rail**: a single vertical column of 56 px thumbnails, 6 visible, with a "More" popover holding templates. One tab stop with arrow-key roving.
- **Right panel (360 px, collapsible to 0):** sections, not tabs.
  - **Run of show**: an ordered list of segments. Each segment is a scene, optional media, banner text and a duration. This replaces separate scenes, banners and saved-scenes UIs.
  - **Guests**: backstage tiles with the camera live, Bring on, mute, and a private message.
  - **Chat**: merged studio and platform chat.
- **Bottom bar (56 px):** mic ▾ · cam ▾ · Present ▾ · on the left; **Sam** (the input itself, "Ask or tell Sam…", 320 px, always visible) in the centre; ⚙ and End on the right.
- The setup guide becomes a three-item checklist at the top of the Run of show (Invite, Add destination, Do a 10-second test recording), not a banner in the dock.

**C. Studio: On-air mode**
- The panel collapses automatically. The stage grows to **≈ 65 % of the viewport**.
- A **Producer bar** sits under the stage (72 px). It shows the current segment, then **Next ▸** (Space), the segment timer, the queued banner, the guest backstage queue, and live health (bitrate, dropped frames, each destination's status dot).
- Everyone sees the **red REC/LIVE badge**, guests included.
- Chat opens as a 320 px overlay drawer (C key), with "Show on stage" on each message.

**D. Guest view**
- The green room is pre-filled from the link, and **Enter joins**.
- Inside: the program at full width, then a "You're backstage / You're on stage" status strip, a private host chat, and a REC/LIVE badge.
- There is no invite, no code and no host tools. If the host drops, the guest sees "Host disconnected — waiting (0:30)" and then a choice, instead of a silent promotion.

**E. Phone (390)**
- Portrait. The stage is full-bleed at 16:9 (390×219), or 9:16 for vertical shows (fills the screen).
- A bottom sheet with three detents: Peek (scene thumbnails), Half (Run of show / Chat), Full.
- The 64 px bottom bar has 44 px targets: mic, cam, Sam, ● Go live, ⋯.
- The header is 44 px: title plus a status dot only; everything else moves into ⋯.

**F. After the show**
- A full-page "Show recap" opens automatically.
- On the left, the playback with the transcript underneath (click a word to seek).
- On the right, **Highlights**: three auto-cut clips, each with a vertical 9:16 reframe and burned-in captions, plus a title and description drafted by Sam.
- Actions: Download (MP4), Save to Drive, Publish to YouTube (OAuth), Copy clip.

### 4.4 Interaction model
- **One verb per key:**
  - Space: next segment.
  - 1–9: scenes.
  - B: banner.
  - M / V: mic / camera.
  - R: record.
  - /: Sam.
  - G: guests.
  - Esc: back out of anything.
- Single-key shortcuts are off while a field has focus, and the user can turn them off (as today).
- **Direct manipulation on the stage.** Drag a guest from Guests onto a stage slot to bring them on. Drop a file to present. Double-click a layer to edit its text in place.
- **Undo for everything on air** (⌘Z returns the previous program state for 10 s), because live mistakes happen.
- **Sam as the command line, not a chat app.** For example: "next segment", "put Gina on", "show the pricing slide", "banner: Q&A time". Every action appears as a chip that can be undone, and Sam never asks for an API key in the studio. The house allowance is on by default; bring-your-own-key lives in Settings.
- **Live mistakes are previewed.** On air, a scene switch can optionally go through a 1-click "Preview → Take" (program/preview), with "Auto-take" on by default for beginners.

### 4.5 Visual language
- **The program is the hero.** The stage sits on pure #07090d with no frame card. Chrome sits at 60 % luminance below the stage.
- **One type scale:**
  - 12 px for meta (the minimum; nothing smaller)
  - 14 px for UI
  - 16 px for inputs
  - 20 and 28 px for headings
  - tabular numbers for timers
- **Colour:** keep the blue-graphite and the AA accent. **Red is only for REC/LIVE**, and so is the header tint while on air. Amber means "needs attention" (backstage knock, a destination warning).
- **Motion:** 120–180 ms. Scene changes use a 250 ms cross-dissolve in the program (a setting). Reduced motion turns this into a cut.
- **Themes:** 6 one-click themes, each a token pack covering font, name tag, banner, panel, frame and animation, plus "Customise" for the 20 current knobs. Adding a logo derives an accent colour from it automatically.
- **Empty states teach by doing.** For example, the empty stage says "You're the only one here — Invite (I) or Present (P)", and does this only on the editor canvas, as today.

### 4.6 Signature features (what makes gather clearly better)
1. **Zero-key Go live.** OAuth connections for YouTube (Live Streaming API: create the broadcast and get the stream), Twitch (`channel:read:stream_key`) and Facebook. One click per destination, once. Hosted relay by default, with WHIP ingest to a managed media server (Cloudflare Realtime / LiveKit egress), so no "site owner" copy ever reaches a host. A **10-second test stream** runs automatically before the first go-live, to an unlisted YouTube broadcast.
2. **Never-lose recording.** Each participant records locally at high quality (MediaRecorder on their raw camera and mic), chunks are uploaded every 5 s to R2/S3, and the composite is recorded in parallel. A crash or closed tab loses at most 5 s. This makes multitrack possible, which is Riverside's moat, in a browser-only stack.
3. **Run of show.** A segmented show plan that drives the scenes, media, banners, timers and Sam. Pressing Space moves to the next segment, and the producer bar shows what's next. No competitor makes the *plan* the primary object. It turns a nervous first-time host into a prepared one.
4. **Sam, the on-air producer that needs no setup**, built on the existing agent tools:
   - It listens to the conversation (captions are already there).
   - It proposes banners ("Gina Guest · CTO at Acme") and highlight markers.
   - It runs the run of show by voice.
   - After the show it cuts the highlights.
5. **Instant post-show:** transcript, three vertical highlight clips with captions, and a drafted title and description, ready within 2 minutes (using the uploaded chunks plus server-side FFmpeg and transcription).
6. **Production-grade compositing for free.** Lead the marketing with the existing layout engine and background matte quality. These are already better than StreamYard's.

### 4.7 Phased build order (a small team of 2–3 engineers and 1 designer)

| Phase | Scope | Effort | Exit metric |
|---|---|---|---|
| **0 — Fix the floor** (week 1) | <ul><li>Enter key in the green room (`type="button"` on the close buttons)</li><li>A REC/LIVE badge for guests</li><li>Phone header overflow</li><li>Banner collisions with camera slots</li><li>The host-left flow</li><li>An audio-unblock banner that stays until clicked</li><li>Hide the relay developer copy</li><li>Default the account dialog to "Create account" and drop the checkbox</li><li>Fix the setup guide getting stuck on the title</li><li>Restore focus after the invite dialog</li><li>`aria-pressed` on `#recBtn`</li><li>Roving tabindex on the scene strip</li></ul> | 4–6 days | Every P0/P1 in §2 closed; the keyboard journey passes in CI |
| **1 — First five minutes** | <ul><li>Landing page as the green room</li><li>Google and magic-link sign-in</li><li>Auto title</li><li>Stage-first layout (65 % target)</li><li>The new bottom bar with an inline Sam input</li><li>Settings split into sections</li><li>Six one-click themes</li></ul> | 3 weeks | ≤ 3 clicks to the studio; stage ≥ 60 % at 1440 |
| **2 — Zero-key Go live** | <ul><li>Managed relay / WHIP egress</li><li>OAuth for YouTube, Twitch and Facebook</li><li>Automatic test stream</li><li>Destination health in the producer bar</li></ul> | 4 weeks | Live in < 45 s for a new host; ≥ 98 % go-live success |
| **3 — Never-lose recording** | <ul><li>Per-participant local tracks</li><li>Chunked upload</li><li>Server stitch</li><li>Recovery after a crash</li></ul> | 4 weeks | 0 lost recordings in a chaos test (closing tabs mid-show) |
| **4 — Run of show + modes** | <ul><li>The segment model (built on scenes and banners)</li><li>Prepare and On-air modes</li><li>Producer bar, Space for next segment, undo</li><li>Phone bottom sheet</li></ul> | 3 weeks | First-show completion rate up 30 % in a cohort test |
| **5 — After the show** | <ul><li>Transcript</li><li>Automatic highlights with 9:16 reframe and captions</li><li>Sam's drafted copy</li><li>Publish to YouTube</li></ul> | 4–5 weeks | Median < 2 min from End show to a downloadable clip |

In total that is about 5 months. Phases 0–2 alone (about 2 months) close the gap with StreamYard. Phases 3 and 5 are where gather overtakes it.

---

## Appendix: measurements
- **Stage area:** 1440×900 → 996×560 (43.1 %); panel hidden 1124×586 (50.8 %); 1280×720 → 35.4 %; 1024×768 → 604×340 (26.1 %); 390×844 → 374×210 (23.9 %, document 1157 px tall).
- **Landing performance:** FCP ≈ 490 ms (220 ms on a second run), load ≈ 600 ms, 475 KB transferred.
- **Layout shift (whole session):** 0.002 at 1440, 0.007 at 1024, 0.019 at 390.
- **Tab stops** from the end of the header to the Record button: 34. The studio has no skip link and no h1.
- **Text under 12 px in the studio:** 9 px ×2, 10 px ×4, 11 px ×19.
- **Phone tap targets under 44 px** at 390 (the scan excluded the pointer-coarse overrides, since the test was not touch emulated): header 34 px icons, deck tabs 28 px, lock 28×16, guide buttons 28 px, Leave 64×34, green-room segments 26 px.
