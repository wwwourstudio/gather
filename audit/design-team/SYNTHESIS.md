# Design team synthesis → V4 plan

Sources: `flow.md`, `visual.md`, `layout.md`, `simplify.md` and `interaction.md` (accessibility, folded in when it arrives).

## What the team agrees on
1. **Too much at once.** About 270 controls sit in 8 peer tabs, and 35 are visible on a 1440 screen. The video gets only 18–38 % of the screen on desktop and about 20 % on phones (layout).
2. **It looks generic.** Drifting blurred blobs, glass on every region, floating rounded cards with gutters, icon-and-caption buttons everywhere, and low-contrast grey text (visual).
3. **Broken or misleading flows:**
   - Leave silently ends a recording or stream.
   - "Live in studio" shows while nothing is live.
   - Go live is buried below the fold, and is a dead end without the relay.
   - The selected scene is ringed in red, the colour that means "on air".
   - The setup guide's first step sends you to the Brand tab (flow).
4. **Duplicates:** 3 Invite buttons, 4 ways into the AI, scenes in two places, and 3 title fields (flow and simplify).
5. **Phones:** the bottom bar covers the chat box, 11 tap targets are under 44 px, and the panel tabs scroll sideways (layout).

## Decisions (V4)
| Area | Decision |
|---|---|
| Navigation | The rail drops from 8 tabs to 4: **Chat · Show · Look · AI**. Show holds banners, ticker, captions, the chat overlay and the call-in card. Look holds Layout and Brand, switched by a toggle at the top. Settings and Help move to icon buttons in the header that open dialogs. Stream becomes a **Go live** dialog. |
| Header | Wordmark · show title (the host edits it in place) · status only while connecting · ? · ⚙ · account · Invite · **Go live**, the one primary action, which shows a red timer while live. |
| Before entering | The landing page is just the stage hero. The rail, panel, deck and dock are hidden. |
| Dock | Mic · Camera · Present · Record · Sam · … · Leave. Leave asks first when you're recording, live or hosting guests. |
| Visual | Flat, docked regions with 1 px hairlines and no floating cards or blobs. The surfaces are a deep blue-graphite, which keeps the owner's blues. Glass is used only for controls over video and for overlays. Red is reserved for live and recording; selection uses the accent. The accent is darkened to pass AA contrast; the light grey text and lines are raised to pass too; and radii and control heights are smaller. |
| Layout | The side panel can be collapsed: click the active tab again and the stage takes the width. The scene strip is compact. On phones the bottom bar is fixed and short and the panel no longer scrolls inside the page. |
| Copy | Panel subtitles, "Scroll to switch", the X/TikTok "soon" rows and the jargon in hints are gone. One name per thing: Schedule, link, Go live. The invite dialog's primary button copies the link. |
| Live state | "Live" means only broadcasting. People cards say "On stage". |

## Outcome
Implemented in V4; see PROGRESS.md ("V4"). Accessibility findings that shipped: Esc, focus rings, selected-state semantics plus arrow keys, shortcut safety, contrast. Deferred: a full mode model (set-up vs on air), one-click Themes replacing the style pickers, and moving the AI setup into Settings.
