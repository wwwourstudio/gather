# V3 audit: chrome, AI and composers

Screens for this audit are in `audit/screens/v3-before` (1440 / 1024 / 390), taken with `node scripts/ui-shots.ts v3-before`.

## Header and chrome
| # | Finding | Severity |
|---|---|---|
| H1 | The header title shows a saved studio title (for example "ourstudio") on the home screen, even when signed out and outside any studio. The title is restored from local storage and rendered unconditionally. | P1 |
| H2 | Filler copy everywhere: the header subtitle "Your next great conversation starts here", the dock note "Your studio. Your conversation.", panel subtitles ("A conversation behind the conversation.") and the chat welcome card "Your crew, connected." | P2 |
| H3 | The header buttons come in four different shapes. "Studio offline" is a pill that looks like a button but isn't one, "Sign in" is fully round, "Invite" is a rounded rectangle and the primary button has a glow. They have different heights, radii and weights. | P1 |
| H4 | "Studio offline" is shown on the home screen, where there is no studio to be offline from. | P2 |
| H5 | Duplicates. Invite appears 3 times (header, deck, dock) and Settings twice (rail, dock). | P2 |

## AI
| # | Finding | Severity |
|---|---|---|
| A1 | There are two assistants with two inputs: the "On-air AI" panel (research, streamed) and "Sam" (the producer, a command bar on the stage). They share one log but behave differently, and the panel can't take actions. | P1 |
| A2 | The "Sam" chip sits permanently over the bottom-right of the program video for the host, at every size, even when the AI isn't set up. | P1 |
| A3 | The producer reply isn't streamed: nothing shows until the whole JSON comes back, and with web search that can take 10–20 s. | P1 |
| A4 | Producer actions are parsed out of free text (`{…}` extraction). That's fragile: a stray brace or a sentence before the JSON loses the actions. | P2 |
| A5 | Showing answers on stage means "AI window on stage", a switch that replaces the whole scene with a template. There's no way to put one answer on stage without changing the layout. | P2 |
| A6 | The setup (provider, key, model, name, voice, wake word) fills the panel above the conversation every time, even after setup is done. The conversation gets about 40% of the height. | P2 |
| A7 | The composers (chat, AI and the stage command bar) are three different designs: a caps label above the field, a large square send button and no hints. Chat is a single line, so longer messages can't be written. | P1 |

## Plan
1. **Chrome:**
   - Show the studio title only inside a studio, and drop the subtitle, dock note and filler copy.
   - Give the header one button family (same height, radius and weight; secondary actions in a quiet style), and show the status only inside a studio.
   - Remove the dock duplicates of Invite and Settings.
2. **One assistant:**
   - The AI panel becomes a conversation with your assistant (default name Sam). One composer handles both questions and commands.
   - Setup folds into a one-line summary once a key is saved.
   - Each answer gets **Show on stage** / **Take off stage**, which adds or removes the AI window without changing the scene.
3. **Streaming agent:**
   - `/api/ai` in `mode: 'agent'` streams newline-delimited JSON events (`text`, `action`, `done`, `error`).
   - Claude uses real tool definitions (open a page, switch scene, present, stop, banner, hide banner, countdown) plus web search. ChatGPT, Gemini and Grok keep the JSON reply, mapped to the same events.
4. **No permanent stage chip:**
   - The assistant opens from a dock button or with the `/` key, in a floating command bar that closes with Esc.
   - While the AI is thinking or speaking, the dock button shows it.
5. **One composer component** for chat, AI and the command bar: auto-growing, an inline send icon, Enter to send and Shift+Enter for a new line.
6. **Verify** at 1440 / 1024 / 390 into `audit/screens/v3-after`, and update the tests that relied on the old markup.

## Outcome
Everything in the plan has shipped; PROGRESS.md ("V3") lists what changed and how it was verified. H1–H5 and A1–A7 are fixed.
