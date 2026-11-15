# Visual / brand review — gather (V3 → V4)

Verdict: **yes, it reads as AI-generated.** Every 2024 template tell is present at once: three drifting blurred blobs, frosted glass on every region, 16px-rounded floating cards with 12px gutters, an icon+caption button on every tool, and grey-blue captions sitting on a gradient. Nothing is ugly. Nothing is *owned* either. Evidence: `audit/screens/design-before/*`, plus my own shots in `audit/design-team/shots/visual/` (`before-*`, and `v4-sketch-*` rendered with the override `v4-sketch-override.css`).

## (a) Top-10 visual problems

| # | Sev | Where | Evidence |
|---|---|---|---|
| 1 | High | `.backdrop .b1–.b3` (style.css) | Three `blur(80px)` blobs at 0.55/0.35/0.32 alpha, drifting for 38–54 s. Panel backgrounds sample at #123454 to #114a73, so the chrome is brighter and more saturated than the video. This is the strongest generic-AI tell. |
| 2 | High | `.glass` on header, stage-card, deck, side, rail, dock (15 uses in index.html) | Glass sits on opaque, static regions, where nothing moves behind it. Blur plus noise plus an inset highlight on six stacked cards gives no hierarchy, because everything is "raised". |
| 3 | High (AA) | `--ink-3 #7183a8` | 5.16:1 on --bg, but **2.45:1** on the lit rail (#114a73) and 3.16:1 on the chat panel. Rail labels, chat empty state, `.deck-hint`, `.hint` and `.crew-sub` all fail 1.4.3. In light theme `--ink-3 #6b7a9c` on --bg is **3.69:1**, which also fails. |
| 4 | High (AA) | `--accent #3b82f6` with white text | **3.68:1** (and 3.07:1 on hover) for the 13px/600 labels on Enter studio, Invite and Create. These fail 1.4.3. |
| 5 | High | `.tile.on` uses `--live` (red) | The selected scene is red-ringed with a glow, which reads as "on air". Red has to mean only live/recording. |
| 6 | Med | `.icon-btn.stacked` (14 uses: rail, dock) | Captions at 11px/600 on every tool make a mobile tab bar on a desktop pro tool. The rail is 76px wide for 7 icons. |
| 7 | Med | Radii and gutters | `--r-lg 16` cards, `--r-md 12` tiles, `--r-full` pills and chips, and a 12px gap around everything all have the same weight. The layout floats instead of docking, which wastes about 48px per axis at 1440. |
| 8 | Med | Type | Plus Jakarta 800 at −0.04/−0.055em ("Start a studio.", "Step into the studio.") is a marketing-hero voice inside a tool. Panel H2 is 16/700 with a 13px subtitle on *every* panel. The scale runs 11/12/13/14/16/20/24/32, which is 8 sizes, 5 of them under 16. The guest-template fonts load in the app shell (Onest, JetBrains Mono, Playfair, Bebas, DM Serif). |
| 9 | Med | Borders/elevation | `--line` at 10% white measures 1.25:1, so it is invisible. Separation is done by shadow (`--shadow-glass 0 8px 32px`) on cards that never overlap. Disabled "Leave studio" has text at **2.0:1**. |
| 10 | Low | Empty states and accents | The 80px glass cam-badge, the conic "orb" (`#7dd3fc→accent→#a78bfa`, always spinning), `--cyan` links next to `--accent` buttons, and the green `#85c742` paid-chat colour hard-coded outside the tokens. That makes four blues and a purple in one viewport. |

## (b) V4 direction

**"Control room, not landing page."** The chrome is a near-neutral, slightly blue-black graphite built from **flat, tonal surfaces** (Linear, Figma UI3, OBS 30). Regions dock edge to edge, separated by 1px hairlines, with no floating cards and no gutters. The video stage is the only lit, colourful object: the user's brand accent lives there, and the chrome steps back. Blue stays as the single interactive accent (a deeper, AA-safe cobalt) and red is reserved for live. **Glass is allowed only where something moves underneath it:** controls over video (`.on-media`, pres-bar, cmd-bar) and transient overlays (popover, modal, tooltip, toast). Everything else is opaque. That keeps the owner's "blues/glass" in the places it means something. Inter does all UI text. Plus Jakarta 700 is used only for the wordmark and modal titles, with no 800 and no −0.04em. Density follows the pro-tool rhythm: 32px controls, 12px panel padding, icon-only tools with tooltip and shortcut (Raycast/Arc), and labels kept only on Record and Go live.

### tokens.css before → after

| Token | Before | After |
|---|---|---|
| --bg | #060b18 | **#0b0e14** |
| --bg-2 | #0b1430 | **#0b0e14** (gradient removed) |
| --surface (L1 panels) | #0e1830 | **#11151d** |
| --surface-2 (L2 inputs/tiles) | #142142 | **#171c26** |
| --surface-3 (new: hover, selected) | — | **#1e2430** |
| --stage-well (new) | — | **#07090d** |
| --ink / -2 / -3 | #eaf1ff / #a8b7d6 / #7183a8 | **#e8ecf3 / #aab4c6 / #8a95a8** (ink-3 5.5–6.9:1 on all surfaces) |
| --line / --line-2 | 10% / 16% white | **#1f2530 / #2a3140** (solid hairlines) |
| --fill / hover / active | .06 / .10 / .14 | **.04 / .07 / .10** |
| --accent / hover | #3b82f6 / #5592f7 | **#2f6bf0 (4.69:1 white) / #2b66e8 (5.04:1)**, so hover goes *darker* |
| --accent-soft / -line | .16 / .45 | rgba(47,107,240,.16) / .50 |
| --cyan | #38bdf8 | **removed**: links use `--accent-text #7aa5ff` |
| --live | #e11d48 | #e11d48 (unchanged; selection never uses it) |
| --blob-1..3 | rgba blues | **deleted** |
| --glass-bg | rgba(255,255,255,.06) | **rgba(17,21,29,.72)**, overlays only |
| --glass-blur | blur(20px) saturate(140%) | **blur(16px) saturate(120%)** |
| --glass-noise | 2% fractal | **deleted** |
| --glass-highlight | inset 0 1px 0 .08 | `none` on surfaces; overlays keep .06 |
| --shadow-glass | 0 8px 32px .35 | **none** |
| --shadow-pop | 0 16px 48px .5 | 0 12px 32px rgba(0,0,0,.45), 0 0 0 1px #2a3140 |
| --r-sm / md / lg | 8 / 12 / 16 | **6 / 8 / 12** (lg for modals only) |
| --h-sm / md / lg | 28 / 36 / 44 | **24 / 32 / 40** (44px touch targets under the `pointer:coarse` query) |
| Type scale | 11,12,13,14,16,20,24,32 | **11, 12, 13 (body), 15, 20, 28**. Weights 400/500/600 only, plus 700 for the wordmark. |
| --tracking-caps | .08em | .04em, and caps are used only for section labels |
| --dur / spring | 180 / 520ms | 140 / 320ms. Remove the spring from the toggle knob and keep it for the deck swap only. |
| Light --ink-3 | #6b7a9c (3.69:1) | **#5b6883** (≥4.9:1) |

## (c) CSS changes by selector

**style.css**
- `.backdrop`: set `background: var(--bg)`, and delete `.backdrop i`, `.b1–.b3` and `@keyframes drift`.
- `.app`: `gap: 1px; padding: 0; background: var(--line)` to dock the regions with hairlines.
- `.top`: height 48, `background: var(--surface)`. `.logo-word`: `700 20px var(--font-display)`, −0.03em. `.logo-word i` uses `var(--ink-3)` (accent stays off the chrome).
- `.main`: columns `1fr 340px 48px`, `gap: 1px`.
- `.stage-card`: `background: var(--stage-well)`, padding 12. `.stage`: radius 8, shadow `0 0 0 1px var(--line)`.
- `.stage-empty h1`: `600 var(--fs-20) var(--font-ui)`, −0.01em. Delete `.cam-badge` glass and show a 24px icon in `--ink-3` instead.
- `.rail-btn.icon-btn.stacked`: 32×32, caption visually hidden, tooltip with kbd. `.rail-btn.on`: `background: var(--surface-3)` plus a 2px left inset bar in `--accent`. No cyan.
- `.dock`: flat `--surface`, height 52. `.dock .icon-btn.stacked` becomes icon-only 32px, except Record and Leave.
- `.panel-head`: padding `12px 16px`, `h2: 600 13px`, drop the `p` subtitle (move it into the empty state). `.panel-body`: padding `12px 16px`.
- `.scene`/`.crew-card`: radius 6, `background: var(--surface-2)`, border `var(--line)`.
- `.orb`/`.orb-i`: a single accent fill that animates only when status ≠ idle. Delete the purple stop.
- `.msg.paid`: replace #85c742 with an `--ok` token.
- `.deck-hint`, `.hint`, `.crew-sub`, `.status`: `color: var(--ink-3)` (now AA).

**ui.css**
- `.glass`: `background: var(--surface); backdrop-filter: none; box-shadow: none; border-color: var(--line)`. Glass styling moves to `.glass.raised`, `.glass.on-media`, `.popover`, `.modal-card` and `.toast`.
- `.tile.on, .tile[aria-pressed]`: `border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent)`, with no glow.
- `.btn`: drop `box-shadow: var(--glass-highlight)`. `.btn.primary`: drop the `0 6px 20px` accent glow. `.btn.link`: ink `var(--accent-text)`.
- `.btn:disabled`: opacity .55 on neutral ink, never on a coloured danger label.
- `.pill`: radius 4 (a status *tag*); keep `--r-full` only for the `.live` dot pill. `.chip`: radius 6.
- `.seg > .on`: `background: var(--surface-3)`, no shadow.
- `.toggle`: off track `#2a3140` (meets 3:1 for non-text), knob transition 140ms ease-out.
- `.modal-card h2`: `700 var(--fs-20)`, −0.02em. `.modal::backdrop`: `rgba(0,0,0,.6)`, no blur.
- `.composer-box`: radius 8. `.send-btn`: radius 6.
- `select` chevron: the stroke `%2393a4c7` becomes the ink-3 hex.
- index.html: load only Inter 400/500/600 and Jakarta 700. Lazy-load the template fonts only when the Brand panel opens.
