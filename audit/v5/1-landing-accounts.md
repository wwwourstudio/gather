# V5 audit 1: landing, accounts, green room, public pages

Auditor 1 of 4. Scope: everything before and around entering a studio.
Tested locally against the same code (`node server.js`, in-memory store) on three servers:
- 8101: default, sign-in required to start a studio
- 8105: `ALLOW_ANON_STUDIOS=1`
- 8106: a fake `GOOGLE_CLIENT_ID`, so the Google button renders

The browser was Playwright Chromium with a fake camera and microphone; second and third browser contexts acted as guests.
- Scripts: `/tmp/claude-0/-home-user-gather/0c2621ff-ea6b-5d46-b42f-d9d837e41814/scratchpad/a1/` (`landing.js`, `acct.js`, `guest2.js`, `misc.js`, `mobile.js`, `chips*.js`, `reset.js`)
- Screenshots: `audit/v5/shots/landing/`

Counts: **10 broken items (2 P0, 3 P1, 5 P2)** plus **14 P3 polish items**, all reproduced; 12 improvements; 10 V5 ideas.

---

## 1. Working (verified)

- **Landing page (1440 / 1024 / 390)**
  - No horizontal scroll at any width.
  - The rail, panel, deck and dock are hidden before entering, as V4 intended.
  - Title, H1 and copy render.
  - Screenshots: `landing-1440.png`, `landing-1024.png`, `landing-390-full.png`.
- **Landing controls**
  - **Create a studio:** when signed out it opens the account dialog with "Sign in or create a free account to start a studio". After sign-up it continues straight into the green room, with the name prefilled from the account (`a-acct-signin-from-create.png`, `a-after-signup-greenroom.png`).
  - **Join box:**
    - An empty box shows a toast: "Paste the invite link or code you were sent."
    - A full `/s/` link is parsed to its code, and upper-case codes are lower-cased.
    - Both open the green room in Join mode.
  - **Schedule a show for later:** opens the wizard. Signed out, step 2 refuses with "Sign in to schedule…" (but see B8).
  - **Privacy and Terms links:** both 200.
- **Public pages**
  - `/privacy`, `/terms`, `/privacy.html`, `/terms.html`, `/ui-kit.html`, `/watch.html` and `/w/<code>` all return 200 with sensible titles.
  - Every internal link on the legal pages resolves: `/`, `/terms.html`, `/privacy.html`.
  - External links point at real Google and YouTube policy URLs.
  - `/nope` returns 404.
  - `/s/`, `/c/` and `/s/x/extra` fall back to the app.
  - Path traversal (`/..%2f..%2fpackage.json`) gives 403.
  - No console errors on the landing page, the legal pages or ui-kit.
  - Every `icons.svg#i-*` reference in HTML and JS exists in the sprite.
- **Sign-up**
  - Name, photo and email work.
  - The strength meter counts down "5 more characters", then shows Okay, Good or Strong.
  - The browser enforces `minlength=8`.
  - Without the terms box ticked: "Tick the box to agree to the Terms and Privacy policy."
  - The photo shows in the round avatar.
  - The account chip in the header updates.
- **Sign-in, sign-out and account management**
  - A wrong password and an unknown email give the same message (no account enumeration).
  - A duplicate email gives 409 "already exists. Sign in instead." Case and trailing spaces are normalised.
  - Change password works: a wrong current password is rejected, a short new one is rejected, and on success the page shows "Other devices were signed out" and keeps this device signed in.
  - Sign out works.
  - Delete account rejects a wrong password, then deletes. After that, logging in fails and the same email can sign up again.
  - Screenshots: `a-acct-*.png`.
- **Google button** (fake client ID)
  - It renders on both tabs ("Continue with Google" / "Sign up with Google").
  - On the Create tab it refuses without the terms box ticked.
  - When Google can't complete, it shows "Google sign-in was closed before it finished." The button doesn't stay busy (`google-after-click.png`).
- **Account API with bad input:** every case returns a clean JSON error with the right status.
  - Bad email, short or 201-character password, `agree:false`, a non-JSON body, `null` and `[]` bodies: 400.
  - Unknown action: 404.
  - Missing or forged bearer token: 401.
  - Reset with a bogus token: 400.
  - Forgot password without mail set up: 503.
  - Google when not configured: 400.
  - Signed-in-only stream calls when signed out: 401.
- **Studio API with bad input**
  - Missing or invalid studio code: 400 with plain copy.
  - Call-in or knock to a studio that isn't live: 404 "isn't live right now".
  - Stale credentials: 410.
  - Unknown action: 404.
  - `watch` with no code: 400. For an unknown studio it returns `{found:false}`.
- **Green room**
  - The camera preview, mic level meter, mute buttons, camera-off placeholder ("Camera is off") and camera picker (lists `fake_device_0` once the camera starts) all work.
  - The name is required (native validation bubble).
  - Join with an empty code: "Paste the studio code your host sent you."
- **Guest via invite link** (second browser context)
  - It opens in Join mode with the code filled, and no account is asked for.
  - The guest joins and is not host.
- **Locked studio:** a third person's knock shows "Waiting for the host" (`knock-waiting.png`).
- **Removed guest:** see the guest flow results below (B-section notes).
- **Pages at 390**
  - The account dialog hides its side panel and fits the screen (`acct-signup-390.png`).
  - The green room fits at 390×844 without scrolling the page (`greenroom-join-390.png`).
- **Keyboard on the landing page:** tab order is logo → Sign in → Create → code → Join → Schedule → Privacy → Terms. Nothing invisible gets focus.

---

## 2. Broken

### B1. P0: In the green room, clicking any background chip (Real/Blur/Picture/Green screen) silently switches an invited guest from "Join" to "Create"
- **Repro:**
  1. The host is in studio X.
  2. A guest opens `/s/X` and types a name. The button reads "Join studio" and the code is filled in.
  3. The guest clicks **Blur**, or even **Real**.
- **Expected:** only the background changes, and "Join studio" still joins X.
- **Actual:**
  - The code field disappears and the button changes to **"Create studio"**. Both Create and Join tabs show as unselected, and all four background chips show as selected.
  - When the guest presses the button:
    - **With sign-in required (production default):** the guest gets the sign-in dialog ("Sign in to start a studio"), although guests never need an account.
    - **With `ALLOW_ANON_STUDIOS=1`:** the guest is put into a new, empty studio with a random code (`gather-9e61485c547c`) and is told to invite people. The host never sees them.
  - Verified on both servers (`chips3.js` / `chips4.js`).
- **Cause:**
  - `public/app.js:4649` attaches the Create/Join handler to `$$('#enterForm .seg button')`. That selector also matches the `#grFx` background chips, which are a `.seg` inside `#enterForm`.
  - Each chip click therefore calls `setEnterMode(undefined)`.
  - `setEnterMode` (`app.js:4644`) uses the same selector, so it marks every chip "on" and clears both tabs.
  - The submit handler (`app.js:4655`) then treats `enterMode !== 'join'` as Create.
  - Fix: scope the selector to `#enterFields .seg[role=tablist] button`, or `[data-mode]`.
- **Screenshots:** `guest-real-then-button-8101.png` (button now says "Create studio", code field gone), `guest-blur-then-button-8101.png`, `gr-after-blur-chips.png`.

### B2. P0 (self-hosted / local server): a single malformed URL crashes the whole server
- **Repro:** `curl localhost:8101/%E0%A4%A`, or open `/w/%E0%A4` in a browser. The process exits with `URIError: URI malformed`, and every studio on that server drops.
- **Expected:** 400 or 404.
- **Actual:** the Node process dies. I reproduced this twice, and it also took down my own test run.
- **Cause:** `server.js:44` calls `decodeURIComponent(u.pathname)` with no try/catch.
- **Scope:**
  - On Vercel, static files are served by the platform, so production is likely unaffected.
  - The Render and Fly blueprints and anyone running `npm start` are affected.
  - `public/watch.js:4` has the same unguarded `decodeURIComponent`. A malformed `/w/` link would throw, and the page would stay on "Checking the show…".

### B3. P1: Whoever reaches an empty studio first becomes its host, including a signed-in guest
- **Repro (API, `misc.js` + inline script):**
  1. The host creates studio X, then reloads or drops; the studio empties after 20 s.
  2. A guest with any gather account opens the invite link `/s/X`.
  3. The guest becomes **host**.
  4. When the real host comes back, they are a guest with no host controls (`host? false`).
- **Related:** pasting a mistyped code into "Join" while signed in silently creates a new studio, with you as host and an "Invite guests" dialog. Screenshot: `join-typo-becomes-host.png`.
- **Expected:**
  - The person who created the code keeps the host seat.
  - Joining a code that doesn't exist says "This studio isn't open yet" and waits, instead of creating one.
- **Cause:**
  - `lib/studio.js:308`: `SET host NX` gives the seat to the first joiner.
  - Studios are only reserved (`g:<code>:reserved`) for scheduled streams. An ad-hoc studio has no owner record.
  - The client's join path (`app.js:4656`) never tells the server "join only, don't create".

### B4. P1: A guest who opens the link before the host gets the wrong message, and can't wait for the host
- **Repro:** signed out, open `/s/gather-notstarted01`, type a name, then click Join.
- **Expected:** "The host hasn't opened this studio yet. We'll bring you in when they do." The page then polls.
- **Actual:**
  - **Sign-in required (default):** the error reads "Sign in to start a studio. Guests joining one don't need an account." That tells a guest to sign in while saying guests don't need to.
  - **Anonymous mode:** the guest silently becomes host of an empty studio.
- **Cause:** `lib/studio.js:287` (the 401 branch) and the missing "join-only" intent described in B3.
- **Screenshot:** `early-guest-no-studio.png`.

### B5. P1: Deleting an account leaves its scheduled shows, thumbnails, emailed reminders and studio reservation in place
- **Repro (API):**
  1. Sign up and create a scheduled stream with a thumbnail and an invitee.
  2. `delete` the account.
- **Results:**
  - `streamThumb` still returns the thumbnail.
  - Another signed-in user joining the reserved studio is **not** made host (`host=""`). The studio has no host for 31 days, because `g:<studio>:reserved` still points at the deleted user.
  - With mail set up, the Resend reminders (`mailIds`) are never cancelled. Invitees would get "Starting in 15 minutes" emails for a show whose host no longer exists.
- **Expected:** `privacy.html:51` promises that deletion "removes your profile, settings **and scheduled shows**."
- **Cause:** `lib/accounts.js:178`, `delete()`, deletes only `acct:u`, `acct:e`, the current session and the Google key. It should:
  - walk `str:list:<uid>`
  - cancel the mails
  - delete `str:*`, `str:t:*` and `g:*:reserved`
  - delete the other sessions (those already fail, because the user record is gone)
- **Severity:** a privacy-policy mismatch.

### B6. P2: Anyone can lock any account out of signing in
- **Repro:** POST `login` with the victim's email and a wrong password 11 times. The victim's **correct** password then returns 429 "Too many attempts. Wait 15 minutes, or reset your password."
- **Expected:** throttle per IP+email, or add a captcha or backoff, without hard-locking the real owner.
- **Actual:** the lock is per email only. The suggested "reset your password" is unavailable when mail isn't set up, so the message points to a dead end.
- **Cause:** `lib/accounts.js:79`.

### B7. P2: The wizard's default date is two days ahead, not one, for anyone west of UTC in the evening (or east of UTC early in the morning)
- **Repro:**
  1. Set the time zone to `America/Los_Angeles` and the clock to Mon 16 Nov, 18:30.
  2. Open Schedule a show for later, then choose Schedule for later.
- **Expected:** 17 Nov at 18:00 (now + 24 h, rounded down).
- **Actual:** Date `2026-11-18`, time `18:00`, which is 48 h ahead.
- **Cause:** `app.js:2884` takes the date from `toISOString()` (UTC) and the time from `toTimeString()` (local).
- **Also:**
  - When it's just after midnight UTC, the default start time is 12:00 AM (`schedule-signed-out-err.png`), which is a poor default.
- **Screenshot:** `wizard-date-la.png`.

### B8. P2: "Schedule a show for later" makes a signed-out user fill in the form, then dead-ends
- **Repro:** signed out, click Schedule a show for later.
- **Actual:**
  - Step 1 asks "Go live now / Schedule for later" again, although the link already said which.
  - Step 2 lets you type a title, date and invitees, then shows "Sign in to schedule streams and send reminders." The dialog has no sign-in button.
  - The dialog is titled "Start a stream".
- **Expected:**
  - Use `needAccountThen(openWizard)` the way Create does.
  - Skip straight to the "later" step.
- **Cause:** `app.js:4684` and `app.js:2896`.
- **Screenshots:** `schedule-signed-out-step1.png`, `schedule-signed-out-err.png`.

### B9. P2: Pasting a call-in link (`/c/…`) or a watch link (`/w/…`) into the landing Join box produces a garbage code
- **Repro:** paste `https://host/c/gather-abc123` and click Join.
- **Actual:** the code field shows `httplocalhost8101cgather-abc123`, and joining tries a studio by that name.
- **Expected:**
  - `/c/` links join as call-ins.
  - `/w/` links say "That's a watch link" and offer to open it.
- **Cause:** `parseCode`, `app.js:107-110`, only recognises `/s/`.
- **Screenshot:** `landing-join-callin-link.png`.

### B10. P2: Signing out or deleting an account leaves the person's data in the browser
- **Repro:** sign up with a name and photo, sign out, then open Create a studio.
- **Actual:**
  - The green room is still prefilled with the previous person's name (`gather:name` stays in localStorage).
  - Their photo, brand prefs and scenes stay in IndexedDB.
  - After delete, the password stays typed in the delete field (`#acDelPass`), and it is still there when the dialog reopens.
- **Expected:** on a shared machine, sign-out (and certainly delete) clears profile-derived local data, or asks "Keep this device's setup?"
- **Cause:** `signedOut()`, `app.js:2511`, only clears the token.

### P3 polish (all reproduced)

| # | Issue | Where |
|---|---|---|
| P3-1 | No background chip is selected when the green room opens ("Real" should be). `renderGreenRoom` doesn't run on open. | `app.js:4272`, `gr-open-chips.png` |
| P3-2 | "Remove" (photo) always shows next to "Add a photo", even with no photo. | `index.html` `#avatarClear`, `landing-join-callin-link.png` |
| P3-3 | Forgot your password is offered when mail isn't set up. It fails only after you click it (503). | `app.js:2645`, `a-acct-forgot.png` |
| P3-4 | On the reset page with an expired link, a too-short password reports "link has expired" first. There's no "send a new link" button, and closing leaves `?reset=` in the URL, so a reload reopens it. | `app.js:2652`, `lib/accounts.js` reset, `reset-bogus.png` |
| P3-5 | A password of 8 spaces is accepted and rated "Okay". | `lib/accounts.js:setPassword`, `passScore` |
| P3-6 | At 1024 px the Join placeholder is cut off: "Paste an invite link or coc". | `landing-1024.png` |
| P3-7 | Tap targets under 44 px on phones: header account button 34 px, Join and Create 42 px, Schedule link 28 px, Privacy/Terms 15 px. | `landing.js` output |
| P3-8 | At 390 the "Green screen" chip label touches the chip edge. | `greenroom-join-390.png` |
| P3-9 | The remove-guest toast says "Lock the studio to keep them out". The server now bars the device for 12 h. PROGRESS.md still says removed people "can come back through the link". | `app.js:3474`, `lib/studio.js:420` |
| P3-10 | `streamUpdate` stores any string as a thumbnail (no `data:image` check, unlike create). `streamUpdate`, `streamEnd` and `streamThumb` are never called by the client, so a "Live" scheduled stream never ends and shows as Live for 6 h. | `lib/streams.js` |
| P3-11 | `GET /api/account` returns a plain-text "Not found" 404 instead of JSON 405. | `server.js:27` |
| P3-12 | The watch page shows the H1 "Show not found" for a studio that just hasn't opened yet, including a scheduled show's own studio. | `watch.js:render`, `page_w_gather_nothere.png` |
| P3-13 | Privacy "Questions" points at "the support email shown on its Google sign-in screen", which no one can find. | `privacy.html` last section |
| P3-14 | On sign-up and sign-in pages the console shows `401/409/503 Failed to load resource` for expected validation answers. That's noise, not a fault, but every expected validation answer adds an error to the console. | all account calls |

---

## 3. Improvements (ranked by impact)

1. **Fix B1 now.** It breaks the most common guest path the moment a guest touches a background chip. Add a regression test in `round5`: guest via link → click Blur → still joins X.
2. **Give studios an owner and a join-only intent (B3 and B4).**
   - Store `g:<code>:owner` when a signed-in host creates a code.
   - Have the client send `intent:'join'` from links and the Join box.
   - The server answers "not open yet" instead of creating. The guest's green room then shows "Waiting for {host} to open the studio" and polls, like the knock screen does.
3. **One-click guest entry.**
   - From an invite link, the guest sees the host's name and show title ("Maya invited you to *Building in public*"). Today it's a generic "Step into the studio." with Create/Join tabs that a guest never needs.
   - Hide the Create/Join tabs entirely on `/s/` and `/c/` links.
4. **Make account deletion complete (B5),** and add "Download my data" next to it.
5. **Sign-in throttling per IP+email with backoff (B6).** Hide "reset your password" in the 429 message when mail is off.
6. **Schedule:** gate it with `needAccountThen`, open directly on the "later" step, default to the next whole hour in the user's local date (B7 and B8), and show the time zone next to the time.
7. **Make `parseCode` accept `/s/`, `/c/` and `/w/` links,** plus bare codes with spaces or `#` fragments, and route each correctly (B9).
8. **Shared-device hygiene on sign-out (B10):** clear name, photo and synced prefs, or offer "Remove my setup from this browser".
9. **Harden `server.js`:** wrap the decode, return 400, and add `process.on('uncaughtException')` logging so one request can't drop every studio (B2).
10. **Green room clarity:**
    - Select "Real" by default.
    - Hide "Remove" with no photo.
    - Show the mic name and a "Test speakers" button.
    - Remember the last background choice per device.
    - Show "Camera blocked: how to fix" with per-browser steps when permission is denied.
11. **Landing:**
    - 44 px tap targets on phones.
    - A Join placeholder that fits at 1024 ("Invite link or code").
    - A visible "Guests don't need an account" line under Join.
    - A footer with a support contact instead of the Google-screen reference.
12. **Forgot password:** expose `mailReady` in `config` and hide the link when mail is off, rather than failing after the click.

---

## 4. V5 ideas: onboarding that beats StreamYard, Riverside and Restream

1. **Zero-click guest join.**
   - The invite link carries a signed, short-lived guest token, and the green room opens with camera on, name remembered and the host's face and show title on screen.
   - "Join" is the only button.
   - StreamYard and Riverside still show device and permission screens first. gather can show them only on failure.
2. **"Try it in 10 seconds" with no account.**
   - Create a sandbox studio instantly, signed out, local only, with no guests and no live output. You can play with scenes, the AI producer and recording.
   - The first time you invite or go live, offer "Save this studio to an account", keeping everything you made.
   - StreamYard and Restream both require sign-up before you see the studio.
3. **A pre-flight check that actually diagnoses.**
   - A 5-second automated check of camera resolution and fps, mic level and clipping, echo, upload bandwidth, and TURN reachability (the built-in Cloudflare TURN already exists).
   - It ends with one plain verdict: "You're good", or "Your upload is 1.2 Mbps; we'll send 540p."
   - The host sees each guest's verdict in the lobby before letting them in.
4. **A host-side waiting room with previews.**
   - Knocking guests appear with a live muted thumbnail and their pre-flight verdict.
   - The host can talk to them backstage before admitting them.
   - Riverside has a lobby but no diagnostics.
5. **Persistent "home studio" URLs** (`gather.app/maya`) owned by the account. This fixes B3 by design, gives people something to brand, and doubles as the public watch page when live.
6. **Scheduled shows as first-class pages.**
   - `/w/<code>` before air shows a countdown, "Add to calendar" and "Remind me" (email capture).
   - It switches to the player automatically, so the watch link is shareable days ahead. Today it says "Show not found".
7. **Passkeys plus magic links instead of passwords.**
   - One field, the email. Sign-in is a passkey prompt or a 6-digit code.
   - This removes the strength meter, lockouts (B6) and reset links. Google stays as an option.
8. **Guest kit email.** Inviting by email sends each guest a personal link, a 30-second "how to look and sound good" checklist, and the `.ics` file. The green room then shows that the host saw them check in ("Jordan is ready").
9. **AI-assisted setup.**
   - "Describe your show" ("weekly 3-person founder interview, YouTube + LinkedIn") produces a title, a thumbnail, scenes, lower thirds and a schedule in one step, using the AI producer that already exists.
   - None of the competitors do this at onboarding.
10. **Mobile guest joins as a first-class path.**
    - The phone green room is a full-screen camera view with big mute and camera buttons and a "Use rear camera" switch.
    - "Add to Home Screen" makes it an app-like re-entry point for recurring guests.

---

### Guest, knock and remove flow results
(Filled in from `guest2.js`; see below.)
