# vRevamp — what's left

Open work as of **2026-08-18**. Ordered by what unblocks the most.
Historical record of what was *done* lives in [changes.md](changes.md).

The Cloud project is **`verammp`** (number `256000685922`, display name
"VErammp"), owned by **ruthvikmrao@gmail.com** — *not* the account the browser
is usually signed in as, which is why every Console link needs `&authuser=…`.

---

## 1. SETTLED 2026-08-16: OAuth works. Do not re-diagnose it.

Driven by hand against Google, not inferred:

- client `256000685922-…` is **alive** — account chooser reads "to continue to
  VEramp"
- the `chromiumapp.org` redirect is **registered** (no `redirect_uri_mismatch`)
- **`calendar.events` is already on the consent screen** — the consent card says
  "View and edit events on all your calendars"
- the flow returns a real `access_token` with `expires_in=3599`
- the app is in **Testing** with the student address as a test user (Google's
  "currently being tested" interstitial appears; Continue works)

The "this build's OAuth client id is dead" message was leftover from upstream's
client and is gone, along with the legacy `getAuthToken` route that produced it.
See changes.md, 2026-08-16.

### Nothing is left to configure — verified live the same day

On a logged-in session, against Fall 2026-27's newly published CAT1 schedule
(6 exams, 17–24 Aug 2026):

| button | reported |
|---|---|
| 🔔 | `✓ 11 Chrome notification(s) scheduled (1 day & 2 h before each exam)` |
| ✉️ | `✓ 6 reminder(s) set — email 24 h before each exam` |
| 📧 | `✓ emailed 6 exam(s) to ruthvik.24mic7198@vitapstudent.ac.in` |

So the **Calendar API is enabled** (six events written through it) and
**`gmail.send` is on the consent screen** (Gmail returned 200 on
`users.messages.send`). Both former checkbox items are done.

Each Google flow asks for one interactive consent the first time, because three
accounts are signed into the profile and `prompt=none` cannot choose between
them. Once per scope, not once per click.

### 2026-08-17: the screen was still coming back. Two more causes, now fixed

"Settled" above referred to the *client and project configuration*, which is
still true — nothing in Cloud Console needs touching. The **client-side** flow
had two more faults, both in `webAuthToken`, both fixed:

- a button click went **straight to a visible window** on any cache miss; it
  never tried `prompt=none` first. Now it does.
- the silent flow was aborted by Chrome at the first completed navigation
  (`abortOnLoadForNonInteractive` defaults to **true**), one hop before
  Google's `prompt=none` redirect lands. Both non-interactive knobs are passed
  now.

Expected behaviour from here: **one screen on first use, then silence** — apart
from Google's 7-day Testing expiry (§3), which no client code can shorten. If a
window appears more often than that, the grant is genuinely being lost;
re-diagnose from `chrome://extensions` → service worker console, not from the
Console.

### 2026-08-19: it came back — for the OTP scan, which is a different question

Reported with a screenshot: the account chooser over the VTOP OTP page. The
fix above covers the flow that carries `userinfo.email`; the OTP scanner
carries `gmail.readonly` alone, so it could never learn which account answered
and its silent pre-flight had nothing to name. Every scan opened a window.

Inheriting the app flow's account would be worse — it points at the personal
account and VTOP mails the OTP to the student address, so the scan would read
the wrong inbox and say "no OTP found" forever. (The old-code test run proves
this was live: it sent `login_hint=personal@gmail.com` on the mailbox flow.)

Accounts are now remembered **per flow**, the mailbox flow inherits nothing and
reads its own address from `users/me/profile`, and an app grant no longer
suppresses the chooser there while the mailbox is unknown. **Expect one more
chooser on the next "Fill OTP from mail" — that pick names the inbox — then
silence.** Not yet seen live; see changes.md, 2026-08-19.

**What this unlocks beyond the exam page:** the timetable import should now stop
opening one editor per class and write everything through the API in one click,
with a re-import *replacing* the previous one (`deleteOldImports` runs first).
**Not yet retested on the timetable page** — do that next, and it should also
clear the duplicate-events problem in §2.

## 1b. ONE STEP LEFT: deploy the mail relay

Code is done and tested; it is dormant until `MAIL_RELAY_URL` in
`service_worker/background.js` is filled in. Blank = mail still sends from the
student's own Gmail, exactly as today.

1. Make the sender account, e.g. `veramp.mailer@gmail.com`. **Do the rest signed
   in as that account** — it is the From line students will see.
2. script.google.com → New project → paste `tools/mail-relay.gs`.
3. Deploy → New deployment → Web app. **Execute as: Me. Who has access:
   Anyone.** (Anyone = unauthenticated callers, i.e. the extension. It grants
   nobody access to the mailbox.)
4. Authorise it — you will get the "hasn't verified this app" screen; it is your
   own script, so Advanced → Go to is correct.
5. Paste the `/exec` URL into `MAIL_RELAY_URL`, reload the extension.

Check it is alive by opening the `/exec` URL in a browser — a GET returns
`{"ok":true,"service":"vRevamp mail relay","quotaLeft":N}`.

**Later edits: Deploy → Manage deployments → edit the EXISTING deployment.** A
new deployment issues a new URL and breaks every installed copy.

Once live, **📧 needs no Google sign-in at all** — not one scope. The relay owns
the sending identity, so the only unknown is where to write, and the page asks
for that in a text field. A student with no Google account can use it.

`calendar.events` is still required for ✉️ reminders and the timetable import.
Writing into someone's Google Calendar requires that person's consent and no
relay changes that; the sign-in-free substitute is the 📅 one-tap links, where
the student presses Save.

Quota is 100 recipients/day on consumer Gmail (1500 on Workspace); the script
self-limits to 60/day and 12 per recipient.

### The trade-off, stated plainly

The `/exec` URL ships in the extension, so it is public and anyone who extracts
it can POST to it. The caps above are mitigation, not prevention. Proportionate
for personal or single-campus use; a public Web Store release needs per-user
tokens from something stateful.

## 1c. Superseded: the paid-hosting options

Today 📧 sends through the student's own Gmail, so it arrives **from them, to
them**. ✉️ reminders already arrive from *Google Calendar*, not from the student,
so this only affects the instant summary.

Sending as `vrevamp@…` **cannot be done from the extension alone** — anything
shipped inside it is readable by every user, so a sender credential there would
let anyone send as vRevamp. It needs a server holding the secret:

| piece | free options | catch |
|---|---|---|
| host | Cloudflare Workers (100k req/day), Deno Deploy, Vercel/Netlify functions, Cloud Run | a service that can go down and take everyone's mail with it |
| sending | Resend (3k/mo), Brevo (300/day), MailerSend | need an owned domain (~₹700–1000/yr) + DNS verification, or you send from the provider's sandbox address, which looks worse than a personal Gmail |

A no-server middle ground exists: create the Calendar event with the destination
as an **attendee** and `sendUpdates=all`, and Google mails it immediately from
Google Calendar, using only `calendar.events`. Google does **not** invite the
organizer, so this works only when the destination differs from the account
Calendar runs under.

**Not needed** — §1b does the same job free, with no host and no domain, because
a plain @gmail sender was acceptable. Kept only so the reasoning is not
re-derived from scratch if vRevamp ever outgrows an Apps Script's quota.

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

### ~~Exam 🔔 end-to-end~~ — DONE 2026-08-16

Fall 2026-27 published its CAT1 schedule and all three exam buttons were run
against it on a real session. See §1. **A large part of the historical
"reminders don't work" complaint really was an empty schedule.**

### Login OTP autofill

Code-complete (`js/vtop_otp.js`, `js/otp/mail_scan.js`). **2026-08-19: VTOP
demanded one at last** — `/vtop/login/error` with "An OTP has been sent to your
email", the Fill-OTP-from-mail button on screen. What that first real run
exposed was the account handling, not the scan (see §1). The scan itself still
has not been watched end-to-end: it needs the mailbox picked once, and then a
second OTP login to prove the silent path.

### DA reminders

The column renders correctly and every course currently reads "✅ all submitted"
or "No DAs posted", so the 🔔/✉ buttons have never been shown a real upcoming
due. Retest when something is actually pending.

---

## Known decisions to make

### ~~The captcha solver is obsolete on VIT-AP~~ — WRONG, retracted 2026-08-16

`vtop.vitap.ac.in/vtop/login` is serving the **old image captcha again**, and
`js/captcha/` solved it unaided on a live login (`YUF4M9`, filled before the
page settled). The earlier "moved to invisible reCAPTCHA" reading was a snapshot
of one moment, not a permanent change.

**Do not delete `weights.json`** (~600 KB of the 791 KB package) on the strength
of that note. VIT-AP flips between the two; the solver has to survive both, and
`refreshTillCaptcha.js` already recognises the reCAPTCHA shape and stands down.

Not up for discussion: no attempt to solve or bypass reCAPTCHA.

#### 2026-08-17, walked signed out — it has flipped back to reCAPTCHA

Read off the live login form the same day, not inferred:

| checked | found |
|---|---|
| `#captchaBlock` | **absent** |
| `input[name=gResponse]` | present (hidden) |
| `.grecaptcha-badge`, `g-recaptcha-response` | present |
| `document.images.length` | 1 (the VIT-AP logo) |
| `sessionStorage.vrevamp_login_reloads` | **null** — never set |
| `performance…navigation[0].type` | `"navigate"`, not `"reload"` |

So: the flip is real and goes both ways, the stand-down check
(`input[name='gResponse']`) matches the live markup exactly, and **the reload
loop is dead on the page shape that used to loop** — the last two rows are the
proof, on the real portal.

**Then it flipped BACK inside the hour.** Same tab, same day, checked again:
`#captchaBlock` present, `gResponse` gone, an `<img class="form-control
img-fluid bg-light border-0">` carrying a `data:image/` src — and
**`#captchaStr` already held `96QVLW`, which is exactly what the image reads**.

Two conclusions, both now dated and first-hand:

1. **Stop trying to settle which captcha VIT-AP uses.** It changed twice in one
   hour. Any note claiming one or the other is permanent is a snapshot. Check
   `input[name=gResponse]` at the time and branch; both paths must work.
2. **The solver works, live, unaided** — six characters, correct, filled before
   the page settled, with no reload and the counter never set.

#### 2026-08-19: a login form with NO captcha of either kind — STILL OPEN

A capped reload was added for this shape and **reverted the same day**. Measured:
unauthenticated `GET /vtop/login` returns the **role picker** (`#stdForm`, no
captcha), and the username/password form is what `POST /vtop/prelogin/setup`
(`_csrf` + `flag=VTOP`) answers with at that same URL — so reloading from the
login form lands back on the role picker, the original complaint.

**What is needed to fix it:** one reading of that document while it is on
screen, checking for a hidden `gResponse`. If present it is invisible reCAPTCHA
and nothing is wrong; if absent it is a failed render of the image variant and
the block must be rebuilt, not reloaded. It cannot be fetched — the POST needs
a `_csrf` bound to a session cookie, and replaying that on a live session is
rule 4.

#### The path that broke both captcha scripts — fixed the same day

`/vtop/login` serves **two different documents depending on state**. Signed out
with a stale cookie it can be the four-role landing page (Student / Employee /
Parent / Alumni); pressing **Student swaps the login form in at the same URL**.

Both `refreshTillCaptcha.js` and `captchaparser.js` attached their
MutationObserver to `#captchaBlock` **once**, and returned quietly when it was
not there yet. On that path it never is — so on the image-captcha variant the
healing and the solver were **both dead on arrival**, which is invisible from
the outside and looks exactly like "the solver doesn't work".

Each now waits for the block with a **capped poll** (20 × 400 ms, and it stops
early the moment it sees the reCAPTCHA shape). Deliberately not an observer on
`body`: the 2026-08-07 "Page Unresponsive" freeze was an observer storm, and a
wedged main thread on the login page means nobody can sign in at all.

Both fixes are covered by tests that were **checked to fail against the old
code** before being kept.

**Correction to an earlier note:** "the role picker means you have a session" is
**wrong**. Pressing Student on it leads to the login form, i.e. no session. The
landing page is pre-login; a live session gets the dashboard from
`/vtop/content` directly.

### ~~Can automation click our buttons after all?~~ — ANSWERED 2026-08-16: YES

A **CDP-level mouse click reaches the isolated-world handler.** Confirmed on the
live exam page: `[vRevamp click] running exam-bell` and `running exam-mail` both
appear in the console and both handlers complete.

The old rule was true only of `element.click()` and dispatched events, which run
in the page's MAIN world. Those really never arrive. A trusted CDP click is a
different mechanism, and it works — so button checks no longer have to be handed
back to the user. Note the flows that open a Google consent window still do:
that popup is outside the automated tab group.

### ~~`session_repair` misses the state users actually hit~~ — BUILT 2026-08-18

Repeated 404s on the content POSTs are now detected and the student is prompted
to re-login. The detector had to live in the **service worker**: VTOP drives its
content area with jQuery AJAX in the page MAIN world, so no content script can
see those responses, while `chrome.webRequest` sees them regardless of world.
It counts *consecutive* 404s in a 2-minute window, excludes the login paths, and
resets on any success or on the tab's next `main_frame` request. It detects
only — it never retries and never replays an endpoint.

Recovery is a fresh sign-in, and the banner now does it: clear this site's
cookies, then go to `/vtop/login`. The clear is not optional, because VTOP
answers `/vtop/login` with a 404 whenever a session cookie is present — sending
someone there without clearing is the same dead end. User-initiated by a button,
never automatic.

Do **not** try to fix this by replaying VTOP endpoints — that is what caused it.

**Not yet seen live.** It fires on a state that takes heavy use to reach. The
failure mode to watch for is now the opposite one: a banner on a healthy
session. See changes.md, 2026-08-18.

### ~~"attendance data is N days old" should refresh itself~~ — SETTLED 2026-08-19

It now refreshes with one click, by clicking VTOP's own Class Attendance menu
entry (`a[data-url]`, the route `js/navbarap.js` has always used).

**True automatic was offered and declined.** The only way to refresh without the
page is to replay VTOP's attendance POST from the home page — rule 4, and the
state §"session_repair" exists for. A once-a-day replay of a captured real
request is a narrower bet than the one that caused the damage, but it is the
same bet, and losing it costs a working session mid-semester. If it is ever
revisited: capture the request from `chrome.webRequest` (the learner already
does this for the detail endpoint, but its filter needs `detail`/`display` in
the URL and the summary POST has neither), replay once, and stop permanently on
the first non-200.

### Live-read page shapes, 2026-08-19 (signed in — not from fixtures)

| page | data-url | loads via |
|---|---|---|
| Marks View | `examinations/StudentMarkView` | `doViewExamMark()` on change |
| Grades | `examinations/examGradeView/StudentGradeView` | `doViewExamGrade()` on change |
| Time Table | `academics/common/StudentTimeTable` | `processViewTimeTable()` on change |
| Exam Schedule | `examinations/StudExamSchedule` | **Search button — no onchange** |
| Class Attendance | (menu `a[data-url]`) | handled by `js/attendance.js`, do not touch |

`js/shared/auto_semester.js` now opens the first four on the ongoing semester.

**The dropdowns differ, and that is the whole story.** Attendance lists only the
student's own registered semesters (8, tagged `- AMR`), so its index 1 is right
by construction. Exam Schedule lists all 60+, including "Fall Semester 2026-27
Freshers", which `chooseCurrentSemester()` picks over "Fall Semester 2026-27"
because the names tie and document order wins. The shared chooser is NOT changed
(attendance depends on it); instead the pick starts from the semester name
already cached off the registration-scoped dropdown, and falls back to parsing
only when nothing is cached.

### CAT-1 venue state as of 2026-08-19

Exams 1–3 (17/18/19 Aug) have venues; **20, 21 and 24 Aug still show `-`**.
The venue watcher is correctly silent — there is nothing published to mail. Any
future "the venue mail is broken" report should start by checking this column.

---

## Cleanups (small, safe, unglamorous)

- ~~**`vrGoogleAuthHint` is copy-pasted in three files**~~ — done 2026-08-16,
  now `js/shared/google_auth.js`.
- ~~**Dead legacy DA sync button**~~ — removed 2026-08-16; `da_upload.js` says
  where and why at the site of the deletion.
- ~~**`.bak` files**~~ — gone; checked 2026-08-17, `git ls-files` finds none.
- **24 lint warnings, 0 errors** — all `no-use-before-define`, all on functions
  or consts referenced from inside a function body and therefore fine at
  runtime. Worth a pass only if a file is being restructured anyway; reordering
  them for the linter's sake risks a real TDZ error in exchange for nothing.

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
