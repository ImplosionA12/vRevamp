# vRevamp — what's left

Open work as of **2026-08-10**. Ordered by what unblocks the most.
Historical record of what was *done* lives in [changes.md](changes.md).

---

## 1. Two checkboxes in Google Cloud Console — biggest payoff, no code

`CALENDAR_CLIENT_ID` is wired (`service_worker/background.js`) and points at the
same OAuth client the Gmail OTP feature already uses. What's missing is project
configuration, in that same project:

1. **APIs & Services → Library → Google Calendar API → Enable**
2. **Google Auth Platform → Data Access → Add scope**
   `https://www.googleapis.com/auth/calendar.events` → Update → Save

Until both are done, consent returns a token that 403s on the first write. If
that happens the button says so — the hint text recognises `invalid_scope` and
names the fix rather than blaming the user.

**What it unlocks the moment it's set:** the timetable import stops opening one
editor per class and writes everything through the API in one click, and a
re-import *replaces* the previous one instead of adding a copy
(`deleteOldImports` runs first). The exam ✉️ and DA ✉ buttons start working too —
same token, no change of their own.

Verify with: `console.cloud.google.com/auth/clients` → client should be
`256000685922-…` with redirect `https://jfmlhhjlkbliphgkmeingeacbijcilcl.chromiumapp.org/`
(trailing slash matters).

## 2. Clean up the duplicate calendar events — manual, not code

Verified live 2026-08-09: the calendar holds **three copies of every class**
(35 distinct classes in one week, most present 3×) from three TEMPLATE-route
imports before the duplicate guard existed.

In Google Calendar, search `vRevamp timetable import` and delete two of each.
Nothing in the extension will do this — the TEMPLATE route has no token and no
extended property to find them by. Once §1 is done, `deleteOldImports` handles
future runs.

## 3. Decide the audience — this one is a fork in the road

`calendar.events` is a **sensitive** scope. Consequences:

| Publishing status | Who can sign in | Cost |
|---|---|---|
| Testing (now) | hand-added emails, max 100 | free, instant — consent **expires every 7 days** |
| Published + verified | anyone | brand review + scope justification + demo video, ~2–6 weeks |
| Published, unverified | scary warning screen, still capped | not worth shipping |

For personal use, Testing is fine forever apart from the weekly re-consent. For
the campus, verification is the only route. **Not** the paid security assessment
— that's restricted scopes only (which is why the Gmail OTP feature is
documented as "leave it in Testing").

Whichever way this goes, the no-sign-in paths stay: TEMPLATE links, guided
import, `.ics` export, and local Chrome notification reminders all work with no
Google account at all.

---

## Unverified, waiting on the world

### Exam 🔔 end-to-end

Fixed and structurally verified (the buttons are `type="button"` inside
`<form id="examSchedule">` — that form was the original killer), but never once
run against a *future* exam, because there isn't one:

- **Fall 2026-27 publishes no exam schedule at all** — VTOP returns an empty
  content area, not even a "not found" message
- Winter 2025-26's 21 exam dates run 02-Feb-2026 → 18-May-2026, all past

So the bell correctly reports "no upcoming exams". Retest when Fall 2026-27
publishes. **A large part of the historical "reminders don't work" complaint was
this and nothing else.**

### Login OTP autofill

Code-complete (`js/vtop_otp.js`, `js/otp/mail_scan.js`), never exercised —
VTOP has not demanded an OTP on any session we've watched. Not broken; never
ran.

### DA reminders

The column renders correctly and every course currently reads "✅ all submitted"
or "No DAs posted", so the 🔔/✉ buttons have never been shown a real upcoming
due. Retest when something is actually pending.

---

## Known decisions to make

### The captcha solver is obsolete on VIT-AP — is it on VIT Vellore?

`vtop.vitap.ac.in/vtop/login` now serves invisible **Google reCAPTCHA** (hidden
`gResponse`, no `img.form-control`, no `#stdForm`). `js/captcha/` is dead weight
there and `refreshTillCaptcha.js` explicitly recognises the new shape and does
nothing.

**Unknown:** whether `vtopcc.vit.ac.in` (Vellore/Chennai) still uses the old
image captcha. The manifest still injects the solver for those hosts. Check
before deleting anything — the ML weights (`weights.json`, ~600 KB of the
791 KB package) are the single biggest thing in the build.

Not up for discussion: no attempt to solve or bypass reCAPTCHA.

### Can automation click our buttons after all?

The standing rule is "no" — but it was derived from `element.click()` and
dispatched events, which run in the page's main world and genuinely never reach
an isolated-world content-script handler. A **CDP-level mouse click** is a
trusted input event and *should* reach it.

Never tested. If it works, it overturns a rule that has been sending every
button check back to the user. The exam bell is the ideal probe: with zero
upcoming exams it only prints a status line. Watch for
`[vRevamp click] running exam-bell` in the console — that line is the whole
answer.

### `session_repair` misses the state users actually hit

It fires on a rendered Tomcat 404 and on the poisoned-cookie signature. It does
**not** fire on "shell healthy, content POSTs 404" — `/vtop/content` returns 200
with and without cookies, the top bar still shows the student, and every menu
click clears the content area. That's the state heavy use produces. Worth
detecting repeated 404s on the content POSTs and prompting a re-login.

Recovery today is a fresh sign-in. Do **not** try to fix it by replaying VTOP
endpoints — that is what caused it.

---

## Cleanups (small, safe, unglamorous)

- **`vrGoogleAuthHint` is copy-pasted in three files** — `da_upload.js`,
  `exam_schedule.js`, `timetable_ics.js`. Every fix has to be made three times;
  today's `invalid_scope` branch was. Move it to `js/shared/`.
- **Dead legacy DA sync button** (`da_upload.js`, ~line 546) — the old-layout
  "Sync assignments with Google Calendar" reads a token from
  `chrome.storage.sync` written by a popup sign-in button that no longer exists,
  against the dead upstream OAuth client. It cannot work. Delete it.
- **19 lint warnings, 0 errors** — all `no-use-before-define` in upstream code.
  Harmless; worth a pass if the file is being touched anyway.
- **`.bak` files** (`background.js.bak`, `chooseCurrentSem.js.bak`) — excluded
  from the package already, but still in the tree.

## Features previously discussed, not built

- **Marks-to-next-grade** on the grade view: VIT-AP grades relatively, and each
  course's "+" expander reveals its own S/A/B/C/D/E/F cutoffs (derived from the
  class mean & SD). "You need 4 more marks for an A in this subject" is
  computable from data already on the page.
- **Chrome Web Store listing.** The package builds clean (82 files, 792 KB, no
  dev files, spec-compliant paths). Note that `Compress-Archive` on Windows
  PowerShell 5.1 writes **backslash** separators and produces a zip the Store
  can mis-extract — use `tar -a -c -f out.zip *` instead.

---

## Rules worth not relearning

Written down because each one cost a session:

1. **Never diagnose from a screenshot.** Two confident root causes for the
   calendar import were derived from a truncated address bar, both wrong, both
   with passing tests — because the fixtures were written to match the belief.
   Check the live DOM first.
2. **A synthetic click never reaches an isolated-world handler.** Anything
   needing a real click goes to the user (until the CDP question above is
   settled). Anything that *renders or parses* can be verified from here by
   injecting the real functions and diffing against the live DOM.
3. **Injected buttons: four independent failure modes**, all identical from the
   outside. `type="button"`, delegate via `data-vr-action`, guards exactly as
   durable as the handler, and beware BlockUI overlays eating the click. See
   `js/shared/click.js`.
4. **Don't drive VTOP's internal endpoints** with a scraped `_csrf`. It returns
   404s and logs the user out. Drive the real controls (`#semesterSubId` +
   `change`) or read the rendered page. Navigating straight to `/vtop/content`
   also drops the session — go through the menu.
5. **Green tests prove nothing on their own here.** 299 passed with three live
   button bugs; 303 with a fourth; 322 while the calendar fixtures encoded a DOM
   that did not exist. Model fixtures on the real page.
