# Interaction & accessibility audit: gather studio

Method: Playwright with Chromium and a fake camera/mic at 1440, 390 and 320 px, run as the host. I ran axe-core 4.x (WCAG 2.2 AA plus best-practice) on each panel and dialog, walked the page with 90 Tab presses, and tested Escape, the arrow keys and the shortcut keys. I also checked the markup and code by hand. Raw data is in `shots/a11y/a11y-data.json` and screenshots are in `shots/a11y/`.

## (a) Element inventory

| Area | Visible controls | Failing | Main failure |
|---|---|---|---|
| Header | 3 | 2 | no focus ring; contrast |
| Deck (scenes/people) | 18 | 3 | tabs are 22 px tall; Invite has no ring |
| Dock | 8 | 2 | Leave has no ring; "Show me" contrast |
| Rail | 8 | 8 | active tab not exposed to screen readers |
| Chat | 2 | 0 | none |
| Stream | 22 | 9 | radios have no state; platform inputs have no ring |
| AI (setup open adds ~20) | 10 + 20 | 7 | provider and voice segments |
| Layouts | 49 | 4 | 3 inputs labelled only by placeholder |
| Banners | 12 | 1 | primary button contrast |
| Brand | 54 | 26 | 14 segment buttons and 12 swatch/background buttons have no state |
| Settings | 27 | 6 | radiogroups do not respond to arrow keys |
| Help | 7 | 1 | search field has no ring |
| Dialogs (enter, invite, wizard, account) | ~60 | 6 | contrast; ARIA misuse |
| **Total** | **~300** | **~76 (25%)** | |

Things that already work:
- Every button id is wired to a handler. I found no dead controls.
- Dialogs close on Escape and return focus to the button that opened them.
- The command bar closes on Escape.
- Reduced motion is honoured.
- Targets are at least 24 px everywhere except the deck tabs.
- No page errors.

## (b) Top 15 issues

| # | Sev | Selector | What happens | Expected |
|---|---|---|---|---|
| 1 | Critical | `#presentMenu` (global `keydown`, app.js:4530) | Escape does not close the Present menu. The global handler always matches `escape` and calls `preventDefault()`, which cancels the popover's own Escape. Focus is lost and `aria-expanded` stays "true". | Escape closes the menu and focus goes back to `#shareBtn`. |
| 2 | Critical | `.btn.primary`, e.g. `#enterGo #guideGo #bannerShow #acGo #editToggle #enterTop` | White text on #3b82f6 is 3.68:1 (axe: 7 hits). | At least 4.5:1. |
| 3 | Critical | `.btn.ghost`, `.btn.danger`, `.btn.hdr` (`#leaveBtn #inviteCrew #userBtn #enterTop`) | No focus ring. Their `box-shadow:none` overrides `.btn:focus-visible`. | A visible ring on every button. |
| 4 | Serious | `.rail-btn` | The active panel is shown only by the `.on` class. Screen readers hear 8 identical buttons. | `aria-current="page"` or the tab pattern, plus `aria-controls`. |
| 5 | Serious | `#aspectSeg`, `#capStyle`, `#aiVoiceSeg`, `#tagSeg`, `#bannerStyleSeg`, `#panelSeg`, `#frameSeg`, `#logoPosSeg`, `#adPosSeg`, `#wThumbTabs`, `#wStyle`, `#swatches`, `#bgs` | The selection is visual only. `#aspectSeg` has `role=radio` but no `aria-checked` (axe critical). | A state that assistive technology can read on every segment. |
| 6 | Serious | All `[role=radiogroup]` and `[role=tablist]`, plus `#presentMenu [role=menu]` | Arrow keys do nothing and every option is a separate Tab stop. | Roving tabindex with arrow-key navigation, as in the APG patterns. |
| 7 | Serious | Shortcut keys M, V, S, R, 1–9 and / | They fire while a button has focus. Example: pressing M on `#inviteCrew` muted the mic. You cannot turn them off (WCAG 2.1.4). | A setting to turn them off, or require a modifier key. |
| 8 | Serious | `.plat-body input`, `.composer-row > input` (`#twitchInput #rumbleInput #ytInput #libUrl #layoutName #helpSearch`) | Focus style is `box-shadow:none`. In `.plat` the parent has no `:focus-within` style, so there is no indicator at all. | A ring on the input or on its wrapper. |
| 9 | Serious | `#libUrl`, `#libUrlName`, `#layoutName` | The placeholder is the only label. | A visible label or an `aria-label`. |
| 10 | Serious | `.dock` at 320–390 px | The fixed dock covers the rail and panel content, so focus is hidden behind it (2.4.11). "Record" is cut off as "Recor". | Pad the panel by the dock's height; let dock captions wrap or shrink. |
| 11 | Moderate | `#micBtn`, `#camBtn` | The label names the action ("Mute", "Stop camera") while `aria-pressed` also changes. A screen reader announces "Unmute, pressed". | Fixed names "Microphone" and "Camera" with `aria-pressed`, or action labels without `aria-pressed`. |
| 12 | Moderate | `#toasts` | `role=status` is nested inside a `role=status` live region, so toasts may be announced twice. Toasts disappear after 3.2 s even when they carry an action button (2.2.1). | One live region. Action toasts stay until dismissed and pause on hover/focus. |
| 13 | Moderate | `.deck-tabs [role=tab]` | The tabs are 96×22 px, below the 24 px minimum (2.5.8). They have no `aria-controls` and no tabpanel. "Scroll to switch" is the only hint. | `.seg.sm` at least 28 px; complete the tab pattern. |
| 14 | Moderate | `#userBtn`, `#grFx` | `aria-label="Your account"` does not match the visible text "Sign in" (2.5.3). `#grFx` buttons use `aria-selected` inside `role=group` (not allowed). | The accessible name contains the visible text; use `aria-pressed`. |
| 15 | Minor | `#acDelGo` | The class `btn leave` is not defined, so "Delete my account" looks like a neutral button. | `btn danger`. |

Also noted:
- The Help panel says / means "Jump to chat". For the host, / opens the command bar.
- `#wizDlg` puts focus on the close button, not the first choice.
- The account dialog heading says "Welcome back." on the Sign in tab.
- Tab order reaches the side panel before the rail that controls it.
- Focus rings use only box-shadow under `outline:none`, so they disappear in Windows forced-colours (high contrast) mode.

## (c) Consistency spec

**Action names. Use one verb per action everywhere:**

| Action | Use | Replace |
|---|---|---|
| Broadcast now | **Go live** / **End stream** | — |
| Schedule a show | **Schedule a stream** | "Plan a stream" button; "Start a stream" (`#wH`); "Use Start a stream to plan one" (`#upEmpty`) |
| Enter a room | **Join studio** / **Create studio** | "Enter studio", "Step into the studio.", "Create or join a studio" |
| Leave a room | **Leave studio** | — |
| Show on stage | **Show on stage** / **Hide from stage** | "Run ticker"/"Stop", "Hide banner", "Hide" |
| Pick a file | **Upload …** | "Choose a picture", "Choose an image", "Use your own image", "+ Add sponsor images", "Upload a photo" |
| Delete an item | **Remove** | "Clear" (`#aiClear` becomes "Clear conversation") |
| Copy | **Copy invite link** / **Copy studio code** | "room code" vs "studio code" |
| Background effect | **None / Blur / Image / Green screen** in Settings and the green room | "Real", "Picture", "Replace" |
| Recording | **Record** / **Stop recording** | — |
| AI | Use the AI's name ("Sam") in the dock and the AI panel, and "AI" only on the rail | "Ask your AI", "AI answer", "AI window" |

Copy rules:
- Explain jargon the first time it appears or put it in Help: TURN, RTMP, WebRTC, "relay/README.md". "relay/README.md" is an operator note and should not be shown to hosts.
- Drop filler text: "Play it again" becomes "Preview animation". "Scroll to switch" goes.
- Do not end headings with a full stop ("Recording ready.").

**Button size and variant by context:**

| Context | Height | Variant rule |
|---|---|---|
| Dialog primary CTA | `lg` 44, `block` | 1 `primary` per dialog; secondary is default; dismiss is `ghost` |
| Panel actions | `md` 36 | 1 `primary` per panel section; destructive = `danger`; `link` only for inline text |
| Inline row (add/copy/upload) | `sm` 28 | default; "Remove" = `ghost` |
| Stage overlays | `sm` 28, `on-media` | — |
| Dock and rail | `icon-btn.stacked` 56 | toggles use `aria-pressed` and a fixed name |
| Live / record | `live` variant only | never `primary` |

`+` prefixes: either use the plus icon (`i-plus`) or none. Do not type a "+" character into the label.

## (d) Fixes

1. In app.js at about line 4530, change `escape: () => editor.on && setEditing(false)` so it only prevents the default when the editor is open:
   `if (k==='escape' && !editor.on) return;`
2. In tokens.css, set `--accent: #2563eb` (5.2:1 with white), or keep #3b82f6 as the brand colour and set `--accent-ink: #0b1220`.
3. In ui.css, add `.btn:is(.ghost,.danger,.hdr,.primary):focus-visible, .btn.hdr:focus-visible { box-shadow: var(--ring); }` and `:focus-visible { outline: 2px solid transparent; }` so the ring survives forced-colours mode.
4. In `setTab()`, add `b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false')`. Give each `.panel` the attribute `aria-labelledby` pointing to its `h2`.
5. Add one shared `segSelect(container, btn)` helper. It sets `aria-checked`, or `aria-pressed` for segments with no role, and a roving `tabIndex`, and handles ArrowLeft/Right/Home/End. Apply it to every `.seg`, `#swatches` and `#bgs`. Add `aria-checked` to `#aspectSeg`.
6. In `#presentMenu`, make ArrowUp/Down move between `.menu-item` elements.
7. Shortcuts: skip them when `document.activeElement.closest('button,[role]')`. Add a Settings toggle "Single-key shortcuts" that defaults to on.
8. In style.css, change `.plat-body input:focus` to `.plat:focus-within { box-shadow: 0 0 0 2px var(--focus); }`.
9. Smaller fixes, each with its selector and expected result in table (b): issues 9 and 11–15. Plus `.deck-tabs` height `var(--h-sm)`; `#libUrl`/`#libUrlName`/`#layoutName` get `aria-label`s; `#toasts` loses its role so each toast is its own live region, and action toasts stay until dismissed.
10. At max-width 900px, set `.side, .rail { scroll-padding-bottom: <dock height> }` and `main { padding-bottom: <dock height> }`. Let `.dock .caption` shrink instead of being cut off.
