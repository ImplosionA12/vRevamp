These are the changes made to the project: 

## Timetable import now includes the CAT/FAT exams (2026-07-07)
- User follow-up: during exam weeks the class series is EXDATE'd out, so the
  calendar should show the exams instead. The Exam Schedule page now caches
  its parsed table to `chrome.storage.local` (`vrevamp_exam_schedule`,
  ISO date + 24h window per exam) whenever it's viewed, and the 📅 import
  adds one single event per **upcoming** exam at its own window — venue in
  location, slot/session/reporting time/seat in the description. Past exams
  and rows without a published time are skipped; exams land even after the
  last instructional day (FATs are). Same replace-tag as the class series.
- If the Exam Schedule page was never opened, the import still works and the
  confirmation says how to include exams. Note shows both counts:
  "✓ N event(s) — X weekly class(es) + Y exam(s), classes until <date>".
- Harness: cache-harvest checks on the exam fixture (4 rows normalized,
  no-time row null) + import checks (upcoming-only, window/venue/seat,
  counts in the note). 117 checks green.

## Timetable → Google Calendar import (2026-07-07)
- User request: import the weekly timetable into Google Calendar until the
  FAT exams, instructional days only, with subject name and venue. New
  "📅 import timetable to Google Calendar" button on the Time Table page
  (`js/timetable_ics.js`, next to the .ics export): one weekly recurring
  event per class block (labs merged), anchored on the next future
  occurrence, `RRULE … UNTIL` = last instructional day from the cached
  academic calendar (+1d buffer; ~17 weeks fallback), and every weekly
  occurrence the calendar does NOT list as instructional (holidays, exam
  days) is `EXDATE`'d out of the series.
- Event content: summary "CODE — Title (SLOT)" (title joined from the
  attendance snapshot; falls back to the code until the attendance page has
  been opened once), venue in location. Same click-time Google token flow
  as the 🔔 reminders (silent → one consent window → 401 retry), inline
  progress/status text, no alerts.
- Re-import replaces: events are tagged (`extendedProperties.private
  .vrevamp=timetable`); a click first deletes previously imported series,
  so re-running after a timetable change never duplicates.
- Harness: fixed-clock fixture with a holiday Monday — replace-then-insert
  order, anchor date, UNTIL, EXDATE, title/venue, fallback naming, inline
  note. 111 checks green.

## 🔔 no longer demands Google sign-in for all-past exam groups (2026-07-07, live)
- Live follow-up: user's "huge loading" was VTOP's own server stalling its
  static assets (jquery/app.js pending for ~30 s; extension not even
  injected yet — it has no blocking webRequest permission). Not ours.
- "Can't see reminder buttons": two causes seen live. (a) Pages opened
  before an extension reload keep orphaned content scripts that can't
  receive SW messages — a page refresh fixes it. (b) Summer II 2025-26 has
  NO published exam schedule yet ("Details Not Found"), so there is nothing
  to attach buttons to; Winter 2025-26 shows Download + 🔔 per group fine.
- Real flaw found while clicking: the 🔔 handler acquired a Google token
  (popping the one-time consent window) BEFORE checking whether the group
  has any upcoming exams — an all-past group demanded sign-in just to say
  "no upcoming exams". Order flipped in `js/exam_schedule.js`: the
  no-upcoming answer now comes first, sign-in only when there's something
  to schedule. 100 checks green.
- User report: 🔔 kept asking to sign in. Root cause: the popup's "login"
  stores a **one-time access token** in `chrome.storage.sync` — Google
  access tokens expire after ~1 h, so by click time it was always dead
  (the DA page even fetched it at page-build, guaranteeing staleness).
- Fix: new `get_google_token` message in `service_worker/background.js` —
  content scripts mint a **fresh token at click time** via
  `chrome.identity.getAuthToken` (silent once consent exists; `stale`
  param invalidates a token a 401 proved dead). Shared
  `window.vrGoogleToken` helper in `js/exam_schedule.js` + `js/da_upload.js`
  (guarded — both load on every page): silent first, one interactive
  consent window if never granted, storage fallback where messaging isn't
  available. Both 🔔 flows now retry once with a fresh token on 401
  instead of demanding a re-login.
- Reminder email content: the calendar event description now carries
  **course, slot, exam session, reporting time, exam window, venue and
  seat** (the .ics DESCRIPTION gained slot + reporting time too).
- Harness: description assertion (slot/session/reporting/seat) on the
  captured googleapis payload. 100 checks green.
- **Extension reload needed** (service-worker change).

## Exam schedule: 🔔 email-me-before-each-exam (2026-07-07)
- User request ("set reminder for exam options, like assignments"). Next to
  each per-group Download button on the exam schedule page there's now a
  **🔔 email me before each exam** button: one Google Calendar event per
  upcoming exam in that group, sitting on the exam's own date/time window
  with venue+seat in the description, and `reminders.overrides` email +
  popup **24 h before** — the same mechanism and popup Google sign-in as
  the DA page's 🔔 (`js/exam_schedule.js`). Past exams and rows without a
  published time are skipped; all-past groups say "no upcoming exams";
  no sign-in and expired-401 both point at the popup, inline (no alerts).
- Harness: fixed clock 1-Apr-2026 against the 2026 fixture — 1 event for
  the upcoming FAT (past + no-time rows skipped), correct window/reminders/
  location, sign-in hint path, all-past CAT1 path, button counts. 99 green.

## Bunk table on old semesters + insight-noise fixes (2026-07-07, live)
- User report: bunk calculator "doesn't work properly" on old semesters.
  Live probing (real session, 24MIC7198): Winter 2024-25 Freshers works
  fully; **Short Summer 2024-25 showed "--" for CAT-1/CAT-2** (its calendar
  genuinely has no CATs — the display just looked broken), and EVERY
  semester load logged ~10× "subject insight failed …
  getStudentAttendanceDetail (404)". Fixes in `js/attendance_insights.js`:
  - `fetchDetailHistory` no longer throws a dead legacy candidate's 404
    when a real endpoint already answered 200-with-no-rows (an empty
    register is a legitimate answer, not an error) — this was the console
    spam, and it also kept empty registers out of the history cache so
    every re-run refetched them.
  - 0/0 rows (just-opened semesters) are skipped before any fetch — no
    more probing the whole endpoint ladder for registers that can't have
    data. Rows detached mid-run (semester switched under us) are skipped
    too; the queued re-run handles the new table.
  - `bunkCell`: calendar parsed but no such exam day → **"none this sem"**
    (only calendar-read failures show "--" now). `classifyDay` accepts
    digit labels ("CAT - 1"/"CAT-2") alongside Roman ("CAT - I"/"CAT-II").
  - Finished semesters say so: remaining shows "semester over — final N%",
    safe-to-skip shows "semester over" instead of forward-looking text.
- Harness: new finished-semester fixture (digit-CAT calendar with no CAT-2,
  0/0 course never probed, 200-empty register produces no warn,
  retrospective could've-bunked for CAT-1/FAT, semester-over labels).

## Attendance page: crash on empty semesters silenced (2026-07-07)
- `view_attendance_page()` in `js/attendance.js` grabbed `.table-responsive`
  with no guard, so every visit to a semester with no attendance table threw
  a TypeError (caught, but dumped to the console each time — visible as the
  page error in the auto-semester test fixture). The auto-semester fallback
  even had a comment working *around* the throw instead of fixing it. Now
  guarded; the fallback-ordering comment updated to its real rationale.
- Same hole in both message listeners' `finally`: `.box-body` can be missing
  on those pages and `saveAttendancePage(...outerHTML)` would throw
  *uncaught*. Both now skip the save when the box isn't there.
- 87 checks green, no page error in the attendance fixture anymore.

## Exam schedule: 2026 rewrite of the .ics export (2026-07-06, live)
- The user's screenshot showed the Exam Schedule page working (Summer II
  simply has no published schedule — "Examination Schedule Details Not
  Found"). Searching **Winter 2025-26** live returned the real 2026 table:
  one `.customTable`, group rows (`panelHead-secondary`: FAT/CAT2/CAT1),
  13 header-named columns (S.No / Course Code / Title / Type / Class ID /
  Slot / Exam Date / Exam Session / Reporting Time / Exam Time / Venue /
  Seat Location / Seat No.). The old exporter's date/time/venue indices
  happened to still fit, but seat columns shifted (12/13 → 11/12) so every
  download died on `children[13]` and alerted "Refresh the page and try
  again".
- `js/exam_schedule.js` rewritten: columns resolved from the header row,
  rows without a published time skipped instead of alerting, per-group
  export bounded by the next `panelHead-secondary`, success/failure shown
  as inline text beside the button (the old blocking `alert()`s are gone),
  and a re-fired SPA message no longer duplicates buttons.
- Harness: 2026 fixture (3 groups incl. an unpublished-time row) — button
  per group, ICS event count, DTSTART/DTEND 20260504T1000/1300, venue +
  seat pulled by header, no dupes on re-fire. 87 checks green.
- Earlier "VTOP returns the DA fragment for exam schedule" was a probe
  artifact (function-name collision after eval'ing DA scripts into the
  page) — not a VTOP bug. The earlier renderer freeze has not reproduced
  since; if it returns, investigate fresh.

## Duplicate home card + duplicate navbar (2026-07-06, live)
- Fresh load after an extension reload showed the "heads up" card AND the
  custom navbar buttons rendered twice. Two independent guard holes:
  - `js/navbarap.js` registers `nav_bar_change` on window `load` (no
    guard) while the SW's `nav_bar_change` message can build the navbar
    just before `load` fires → both insert. `nav_bar_change` now exits if
    `#navbar` already exists (idempotent for every path).
  - `js/home_notices.js` checked for an existing card only *before* its
    storage/calendar awaits; two message-triggered renders interleave at
    the awaits and both insert. The guard is now re-checked at the moment
    of insertion (`next_class.js` already did this — that's why the
    next-class strip never duplicated).
- Harness: navbar fixture firing load + two nav messages must yield
  exactly one `#navbar`. 82 checks green.
- DA page verified live end-to-end after the user's reload: "⚠ 3 past due
  (not uploaded)" (MGT1029) and "✅ all submitted" (SWE2007) render in the
  Upcoming Dues column on the real portal.

## DA page: 2026 rewrite + per-assignment email reminder (2026-07-06, live-debugged)
- User request: schedule a mail per assignment. Endpoints and layout mapped
  live: class list (`.customTable`: Sl.No / Class Nbr / Course Code / Title /
  Type / Faculty / Dashboard) loads via the semester onchange;
  `examinations/processDigitalAssignment` (classId) still answers with the
  detail fragment (assignment list: Title / Max. Mark / Weightage % /
  **Due Date** / QP / Document Details + an Upload-Edit sub-header row).
- `js/da_upload.js`: old fixed-index `da_page()` is dead on this layout
  (wrong columns everywhere), so a new header-driven `da_page_2026()` runs
  when the new layout is detected (old page keeps the old path): adds an
  "Upcoming Dues" column (nearest un-submitted due + days left, red ≤ 3
  days) and a **🔔 email me** button per course — one Google Calendar event
  per upcoming due (`create_email_reminder`): due date 20:00–21:00 IST with
  `reminders.overrides` **email + popup 24 h before** (existing calendar
  OAuth token from the popup sign-in; 401 → re-login hint). Re-fired
  messages don't duplicate the column.
- Harness: routed DA fixture (past-due skipped, uploaded skipped, nearest
  picked), captured googleapis POST (email override 1440 min, correct
  date), button confirm, no-dupe. 80 checks green.
- Live follow-up ("it doesn't work"): the user's real Summer II courses
  simply have no upcoming dues (MGT1029: 3 past dues never uploaded;
  SWE2007: everything submitted, DA-2 submitted the same evening it was
  due) — so the flat "Nothing left." looked broken. The cell now reports
  the truth: **"✅ all submitted"**, **"⚠ N past due (not uploaded)"**
  (tinted red), or "No DAs posted", with a hover tooltip listing every DA
  and its status. 81 checks green.
- **Console-noise fixes** (`js/navbarap.js`, `js/captcha/captchaparser.js`):
  both crashed with TypeErrors on pages missing their elements (role-picker
  login, Tomcat 404). Now exit silently when the navbar / captcha inputs
  aren't there.
- **Exam schedule**: ~~"menu returns the DA fragment"~~ — WRONG, retracted
  below. That result came from my own probe: DA fragment scripts had been
  eval'd into the same page context earlier, and the exam page's onchange
  collided with them. The page works (see the rewrite entry above).

## Session repair v2: the 404 wall has TWO causes (2026-07-06, live)
- The 404 came back for the user while their session was healthy —
  live probing showed `/vtop/content` = 200 but `/vtop/login` = 404 with
  cookies: **VTOP 404s the login URL whenever a session cookie exists**
  instead of redirecting the logged-in visitor. So the wall appears any
  time you re-enter through the front door while logged in (the MacBook
  was "fine" only because it carried no session).
- This was also a false-positive hazard in v1 of the self-heal below: it
  would have cleared a *healthy* session's cookies on that page. v2 in
  `js/session_repair.js` probes `/vtop/content` first: **200 → bounce to
  the portal** (never touch cookies); otherwise fall through to the
  poisoned-signature check (404 with cookies / 200 without → clear +
  reload). Both paths share the 2-attempts-per-tab cap.
- Harness: new live-session fixture (content 200, login 404) must bounce
  once with no cookie-clear; poisoned/capped/healthy/site-down cases
  unchanged. 74 checks green.

## Poisoned-cookie self-heal (2026-07-06)
- Follow-up to the cookie-404 lockout below (user request: "clear it
  regularly / on a threshold"). Not on a timer — that would log the user
  out over and over. Instead the extension now recognises the exact
  poisoned signature and repairs it on the spot:
  - `js/session_repair.js` (new, all VTOP pages): on a raw Tomcat 404 it
    probes the same URL twice — `credentials:"include"` (must be 404) and
    `credentials:"omit"` (must be 200). Only that both-sides-confirmed
    signature triggers a repair: ask the worker to clear the site's
    cookies, then reload. Capped at 2 attempts per tab via
    `sessionStorage` (`vrevamp_session_repairs`), counter cleared on any
    healthy page. A genuinely down server (404 both ways) is left alone.
  - `service_worker/background.js`: new `clear_site_cookies` message —
    clears cookies for the *sender's* URL only, guarded to vit/vitap
    origins. `manifest.json`: added the `cookies` permission.
- Harness: routed fake origins with a poison cookie — repair fires once
  with one reload, caps at 2, healthy page resets the counter, site-down
  404 does nothing. 73 checks green.
- **Extension reload needed** (new file + new permission).

## Login page reload loop — the "flickering" (2026-07-06, live-debugged)
- User report: the VTOP login page "keeps flickering". Cause:
  `js/captcha/refreshTillCaptcha.js` reloaded the page whenever it saw
  neither the captcha `img.form-control` nor `#stdForm` — but the 2026
  login page is a **role picker** (Student/Employee/Parent/Alumni) with no
  captcha until a role is chosen, so the script reloaded on every load,
  forever (the tab renderer froze mid-check while I was watching it).
- Fix keeps the original intent (retry a login page that failed to render)
  without the loop: reload only when the body is effectively **empty**,
  cap at 2 attempts per tab via `sessionStorage`, clear the counter once a
  captcha/#stdForm shows up, and never reload at all if `sessionStorage`
  is denied (sandboxed document — can't count, so don't loop).
- Harness: new login-page section served from a routed origin (real
  navigations, working sessionStorage): role-picker page not reloaded,
  empty page retried at most twice, captcha page clears the counter.
  69 checks green.
- **Requires an extension reload (chrome://extensions) to take effect.**
- Follow-up on the same machine: the "HTTPS error" seen afterwards was a
  Tomcat 404 on `/vtop/login` served **only when Chrome's stored VTOP
  cookie is sent** (same URL = 200 from PowerShell and from `fetch` with
  `credentials:"omit"`; `/vtop/logout` and `/vtop/content` 404 too, only
  `/vtop/open/page` still answers). A poisoned/sticky session cookie —
  likely a leftover of the reload loop — pins the browser to a broken
  server path; other devices are unaffected. Remedy: delete site data for
  vtop.vitap.ac.in (address-bar icon → Cookies and site data → Delete).

## 2026-layout audit of remaining features (2026-07-06, live-debugged)
- **Next-class widget** (`js/next_class.js`): same dead `#main-section`
  anchor as the home card — it has been silently invisible on the 2026
  layout. Now falls back to the scrollable content wrapper
  (`#core-container .overflow-auto.showBlock` / `#b5wrapper`).
- **Marks page totals** (`js/marks_page.js`): live check showed the totals
  row rendering 10 cells into the new 8-column table with a NaN (the old
  fixed-index parser read the removed "Class Average" column — now
  "Remark"). Rewritten to find columns by header text (Max/Weightage %/
  Scored/Weightage Mark/Average-if-present), emit exactly the table's
  column count, put "Lost: X" in the trailing cell, and guard against
  duplicate rows on message re-fire. Harness: new marks-page fixture
  (8-col layout) checking totals, no-NaN, no-duplicate, and the
  attendance-risk badge. 66 checks green.
- **Exam schedule** (`js/exam_schedule.js`): could not be verified — both
  sidebar "Exam Schedule" entries are broken VTOP-side right now (blank
  fragment / "Access Denied"), likely unpublished for Summer II. The code
  is old-layout-brittle (fixed column indices, `panelHead-secondary`,
  `#main-section` save) — re-audit when the FAT schedule publishes.

## What-if simulator: cutoffs fetched automatically (2026-07-06, live-debugged)
- The "→ Next grade" column showed "expand course ↑" for every course until
  the user manually clicked each "+" button (the Range of Grades only exists
  inside that expansion). The simulator now does what the "+" does silently:
  each course row's `getGradeViewDetails('<courseId>')` onclick carries the
  id, and the endpoint (confirmed live:
  `examinations/examGradeView/getGradeViewDetails`, params semesterSubId +
  courseId + auth) returns the fragment with the Range of Grades. Missing
  cutoffs are fetched sequentially (200ms apart), cached per course id for
  the session, and the panel rebuilds when they land; cells show "fetching…"
  meanwhile, and fall back to the expand hint only if the fetch yields
  nothing. 61 checks green.

## Attendance insights: six quality-of-life additions (2026-07-06)
- **Debar forecast** — under each "Safe to skip now" value: "skip everything
  → <75% on <date>" (walks future instructional days on the subject's
  weekday pattern), "already below 75%", or "can't drop below 75% this sem".
- **Best-case projection** — under "Remaining till sem end": "attend all →
  X%", the optimistic bound next to the pessimistic ones.
- **Safe-skip line on the home card** — `js/home_notices.js` shows "🎯 Safe
  to skip now: MGT1029 7 · STS1007 4 · …" from the snapshot (labs marked).
- **Marks-page attendance badge** — `js/marks_page.js` flags course rows
  below 75% (or zero safe skips) with "⚠ attendance N%", worse of theory/
  lab when they share a code; reads the snapshot, no fetches.
- **Stale nudge on VTOP's own row** — the "not posted since <date>" warning
  now also appears under the Course Detail cell of VTOP's attendance table,
  where the outdated percentage is displayed.
- **Row what-if simulator** — click a bunk-table subject cell: [Skip +1]
  [Attend +1] [Reset] with live "a/t = pct% (safe now: n)" recompute, in
  the subject's own units.
- Snapshot (`vrevamp_attendance_summary`) now carries code/pct/safeNow per
  subject. Tests for debar note, projection, snapshot shape, VTOP-row flag,
  and the simulator. 59 checks green.
- Live-verify follow-up: the home card never rendered on the 2026 layout —
  its container query only knew `#main-section`/`.content-wrapper`; added
  the layout's `#core-container` as fallback. (VTOP's own top-nav "Marks
  View" quick link currently returns "Access Denied — Photo Upload Option";
  the marks badge attaches when the real marks page loads via the sidebar.)
- Card size feedback: the body is now capped at 96px with internal scroll,
  and the header is a collapse toggle ("▾ hide"/"▸ show") whose state
  persists in `vrevamp_notices_collapsed` — collapsed it's a single line.
- Card still pinned: `#core-container` is overflow:hidden — the page's real
  scroll region is `#b5wrapper` inside it, so a card outside it never
  scrolls away. Insertion now targets the scrollable wrapper
  (`#core-container .overflow-auto.showBlock` → `#b5wrapper` → fallback).

## Bunk calculator: "Safe to skip now" column (2026-07-05)
- User request after the 75% math walkthrough: the before-exam columns mean
  "≥75% ON exam day if you attend everything else", which allows a
  temporary dip below 75% while spending skips. New column between
  "Remaining" and the exam columns: **Safe to skip now (never <75%)** —
  largest b with attended/(total+b) ≥ 75%, order-independent, capped at the
  classes remaining, in the subject's own units (lab sessions for labs).
  Footnote explains the two semantics. 53 checks green.

## Attendance alert column: 80% → 75% (2026-07-05)
- User request: the in-table alert column (`js/attendance.js`) used a
  conservative 80% buffer, which contradicted the bunk calculator's 75%
  numbers on the same page ("Only 1 can be skipped" vs "4 bunkable").
  Both now use the real 75% debar limit: threshold, required-classes
  (`ceil(3T − 4A)`) and skippable (`floor((4A − 3T)/3)`) integer math,
  header, note, and legend all updated. Test expectation updated
  (48/58 → 6 skippable). 51 checks green.

## Bunk calculator: timetable theory/lab kind separation (2026-07-05, live-debugged)
- After caching the Summer II timetable, the SWE2007 Embedded Lab row showed
  "16 lab(s) remaining" — `scheduleFromTimetable` keyed the weekly pattern
  by course code alone, and an embedded course carries ONE code across its
  Theory and Lab rows, so the lab absorbed the theory's ~12 weekly cells.
  The map is now `{code: {theory: {...}, lab: {...}}}`, with each cell
  classified by its own slot text ("L31-…-ELA-…" = lab) since some layouts
  mix the arrays; each attendance row looks up its own kind.
- Unit fix in the same path: timetable lab cells are hours (2 per session)
  while the register's entries-per-session varies by deployment (old: 2,
  current: 1) — lab cells are now converted to sessions (÷2) and then into
  the subject's own history units (× sessionSize).
- Live end state for the user's lab: banner flags it red at 50% ("attend
  the next 2 lab(s)"), stale warning shows (register not posted since
  30 Jun), and with the Summer timetable cached remaining = 2 labs/week.
- Tests: fixture lab with a current cached timetable (theory on 3 days +
  lab pairs TUE/FRI) — remaining must be exactly the 2 lab sessions, no
  theory bleed, no partial-register warning. 51 checks green.

## Bunk calculator: partial lab register warning (2026-07-05)
- Follow-up to the lab-register fix: the user's lab meets twice a week
  (slots L31+L32+L43+L44) but the faculty only ever posted the Tuesday
  sessions — so the weekday inference legitimately showed "1 remaining" and
  the user (rightly) didn't believe it. The row's own slot string knows the
  real schedule: L-slots come in 2-hour pairs, so 4 slots = 2 weekly
  sessions. When the register shows fewer weekly days than the slots imply,
  the row now carries "⚠ register shows only 1 of ~2 weekly lab day(s) —
  remaining/bunkable may be low; open the Time Table page once for the
  exact schedule" instead of silently undercounting. 49 checks green.

## Bunk calculator: lab rows showed the THEORY register (2026-07-05, live-debugged)
- Live on Summer II, SWE2007 Embedded Lab showed 20 held / "all subjects ≥
  75%" — but VTOP's own row says the lab is at **2/4 = 50%**. The insights
  fetch resolves a working request off the FIRST subject (a Theory row) and
  saves it as a template; `paramsFromTemplate` only swapped class-id-shaped
  values, so `courseType: "TH"` leaked into every Lab row's request and VTOP
  silently returned the theory register for it. Affected every theory/lab
  pair (Winter's SWE2006/SWE3001 both showed identical 44/44 for the same
  reason). Template keys that the row's own onclick args provide
  (`semesterSubId`/`registerNumber`/`courseId`/`courseType`, or
  `classId`/`slotName`) now always take the row's own values.
- Test: fixture lab whose mock (like live VTOP) returns the lab register
  only for courseType=LO and the theory register otherwise — asserts the
  lab row shows its own held count. 48 checks green.

## Bunk calculator: cross-semester timetable + remaining-cap (2026-07-05, live-debugged)
- Live on Summer II: STS1007 showed "3 remaining till sem end" while
  MGT1029 showed 12, though both actually meet 2 hours/day 6 days/week
  (verified from their registers). Cause: STS1007 was also taken in Winter,
  and the **cached timetable from the Winter Timetable page** (matched by
  course code) overrode the correct history inference; MGT wasn't in it, so
  it fell back correctly. `js/attendance_insights.js` now trusts the cached
  timetable for a course only if the course's actual history doesn't
  contradict it (any weekday it met on 2+ distinct dates must exist in the
  timetable pattern) — a summer retake's daily schedule rejects the stale
  3x/week Winter pattern.
- Second bug the same row exposed: "4 bunkable before FAT" next to
  "3 remaining" — `bunkable()` never capped at the classes that physically
  remain. Now `min(remaining, …)`.
- Tests: stale Mondays-only cached timetable seeded against a Thu/Fri/Sat
  history (must be ignored), and an all-Present subject whose uncapped CAT-1
  bunkable (2) exceeds the 1 class left (must cap to 1). 47 checks green.

## Bunk calculator: stale-register warning (2026-07-05)
- User request: faculty often post attendance late, and the projections
  silently pretend the register is current. Now each subject's last posted
  date is taken from its own detail history; if **2 or more of that
  subject's expected class days** (instructional days matching its weekday
  pattern — or plain weekdays when no calendar) have passed since, the
  subject is flagged: the bunk-table row gets "⚠ not posted since <date> —
  unreliable, numbers are as of that date" under the name, and the forecast
  banner gets a matching warning line. Threshold 2 so a single unposted
  day / same-day lag doesn't cry wolf.
- Test: third fixture subject whose postings stop 29 Dec with two
  instructional class days since — flagged with the date; fresh subjects
  aren't. 45 checks green.

## Bunk calculator: summer theory mislabeled as labs (2026-07-05)
- Reported live on Summer II 2025-26: every subject — including "Theory
  Only" courses — showed "lab(s)" units with halved counts. The lab/theory
  split was *inferred* from the data (labs log 2 entries per date), but
  summer theory also meets twice a day, so the heuristic fired for
  everything. `js/attendance_insights.js` now reads the course-type text
  VTOP prints in the row itself ("Embedded Lab" / "Theory Only" — the same
  signal the 80%-alert column uses); the entries-per-date heuristic remains
  only for rows that name neither.
- Also fixed while there: the banner's "attend the next N lab(s)" recover
  count was in hours for labs — now whole sessions, like every other number.
- Test: the new-layout fixture's MAT2001 now meets twice daily and asserts
  it's reported in class(es). 43 checks green.

## Attendance auto-semester: load + empty-sem fallback (2026-07-05)
- Reported live: opening Attendance lands on the just-opened FALL 2026-27
  with no attendance and you had to reselect the semester by hand. Two causes:
  `chooseCurrentSemester()` only set `selectedIndex` and never fired VTOP's
  onchange (so nothing loaded at all), and its date heuristic counts the new
  semester as "started" the moment its estimated start passes even though no
  attendance exists yet.
- `js/attendance.js` now dispatches the `change` event after auto-picking (so
  VTOP loads it), and if the response has **no attendance rows** it steps to
  the next most recent semester (order from the new `semesterFallbackOrder()`
  in `js/utils/chooseCurrentSem.js`, capped at 3 fallbacks) until one has
  data. Data-driven, so no date guessing decides the final answer; a manual
  semester change is never hijacked (the queue only exists right after page
  load, and clears the moment any semester shows rows).
- Fix within the fix: the empty-sem check must be scheduled *before* the row
  decorator runs — on an empty page the decorator throws (no table) and the
  fallback would never have been scheduled.
- **Reload-loop hotfix (found live)**: the first cut made the page reload
  endlessly. Root cause was in `service_worker/background.js` routing: it
  fired `view_attendance_page` for ANY completed request whose URL contains
  "StudentAttendance" — which includes the per-subject detail endpoints the
  insights script probes (`callStudentAttendanceDetailDisplay`,
  `processViewStudentAttendanceDetail`). Every detail fetch therefore looked
  like "the attendance page opened", and the new auto-select re-triggered a
  semester load each time → reload storm. The router now excludes
  Detail/Display URLs from both attendance messages, `attendance.js` skips
  the auto-trigger when usable data is already on screen, and "has data" now
  means **at least one row with Total Classes > 0** (a just-opened semester
  lists every course as 0/0 — still nothing to look at, keep stepping down).
- `tests/verify.mjs`: new fixture simulating the sem-transition window
  (Fall = all-0/0 table, Summer II = no table, data in Winter) asserting
  exactly 3 loads, auto-landing on Winter, the 80% alert column decorated,
  and — loop regression — that a repeated `view_attendance_page` while data
  is showing does not reload. 42 checks green.

## Attendance insights on the 2026 VTOP layout (2026-07-05, live-debugged)
- Verified on the live portal: nothing rendered at all on the new attendance
  page. Three separate breaks, all in `js/attendance_insights.js`:
  1. **Detail call shape changed** — rows now call
     `callStudentAttendanceDetailDisplay(semesterSubId, registerNumber,
     courseId, courseType)` instead of `fn(classId, slot)`. The extractor,
     default params, class-id regex (new `AM_CSE1005_00100`-style ids),
     request-template swap, and live-row re-finder all now handle both the
     2- and 4-argument forms.
  2. **Detail modal dates are now `dd-mm-yyyy`** — added `NUM_DATE_RE`
     (day-first, verified against the weekday VTOP prints alongside) next to
     the `01-DEC-2025` and ISO formats, and the modal's per-course summary
     row (which also carries a date) is skipped via its "Total Class /
     Percentage" text so it isn't counted as a held class.
  3. **Calendar endpoints changed** — the sidebar `data-url` is encrypted now,
     so the fetcher tries `academics/common/CalendarPreview` first, gets the
     month list from `getDateForSemesterPreview` (semSubId + classGroupId) and
     each month grid from `processViewCalendar` (calDate), falling back to the
     legacy single-endpoint shape on older deployments.
- Follow-up fix found by the new test: history rows were parsed from raw
  `tr.textContent`, which glues adjacent cells ("1" + "01-01-2026" →
  "101-01-2026") and kills the date regex's `\b` — cells are now joined with
  a space (same class of bug as the grade-history Mon-YYYY one below).
- `tests/verify.mjs`: new end-to-end fixture for the 2026 layout (4-arg
  calls, dd-mm-yyyy modal with a summary row, new calendar endpoints).
  Suite is now 38 checks, all green.

## What-if simulator: credits/CGPA from Grade History (2026-07-05, live-debugged)
- Verified on the live portal: the Grades page carries **no credits and no
  CGPA box at all** — both live only on the separate Examination → Grade
  History page, so the simulator showed "—" everywhere and the GPA row stayed
  hidden. The "same page" credit-join assumption from 2026-06-27 was wrong.
- `js/cgpa_simulator.js` now caches credits-by-course-code and the CGPA
  Details box into `chrome.storage.local` (`vrevamp_grade_credits`,
  `vrevamp_cgpa_details`) whenever the Grade History page is open, and — when
  the Grades page needs data the cache doesn't have — silently POSTs to
  `examinations/examGradeView/StudentGradeHistory` (csrf + authorizedID, the
  same pattern attendance insights use; endpoint confirmed live) and harvests
  the response. On the Grade History page itself the panel stays hidden.
- `js/grade_pages.js` ("Your Semester Wise GPA" row) reads the same cache and
  retries via `chrome.storage.onChanged` when the silent fetch lands.
- Also fixed: history-table detection matched Mon-YYYY per whole-row text,
  which fails without whitespace between cells (`\b` sees "BJan-2026") — now
  per-cell.

## What-if simulator crash fix + test refresh (2026-07-05)
- Fixed a crash that could hide the what-if panel entirely: when the grade
  table wasn't detected but the CGPA Details box was, `buildPanel` still
  dereferenced the missing table while picking the insertion anchor and threw —
  so the "panel always renders with a debug button" promise failed exactly in
  the mis-detection case it was built for. The anchor now falls back to the
  CGPA box (`js/cgpa_simulator.js`).
- Two more hardening fixes there: cutoff cells written with `≥`/`≤` (not
  `>=`/`<=`) are now recognised for marks-to-next-grade, and a non-letter
  grade (P/N) no longer shows a bogus "top grade ✓".
- `tests/verify.mjs` still targeted the old simulator UI from before the
  2026-06-27 rebuild (removed IDs like `vrevamp-sim-gpa`), so its checks could
  never pass. Rewrote that section against the current panel — credit join
  from grade history, marks-to-next from per-course cutoffs, grade-change
  recompute, CGPA projection from the CGPA Details box — and added a
  regression test that the panel still renders when no grade table is
  detected. Suite is now 26 checks, all green.

## What-if GPA/CGPA simulator + grade-view fix (2026-06-27)
- VTOP shifted the grade-view table columns (credits left the table entirely),
  which broke the "Your Semester Wise GPA" calc (showed `NaN`) and left the
  CGPA simulator empty. Both now detect columns by **content** instead of fixed
  indices, and pull **credits by course code** from the grade-history table on
  the same page.
- `js/grade_pages.js`: robust column detection + credit join; stays silent
  instead of printing `NaN` when credits can't be resolved.
- `js/cgpa_simulator.js`: rebuilt as a two-mode what-if tool on the grade page —
  **Semester GPA** (fixed credits, editable grades, live projected GPA) and
  **Cumulative CGPA** (folds the change into the real CGPA read from the page's
  "CGPA Details" box and shows the delta). Also shows **marks-to-next-grade**
  per subject using that subject's own relative cutoffs (VIT-AP grades
  relatively) — populated when a course's "+" detail is expanded. Edited grades
  persist across rebuilds; reset button included.
- Robustness pass: the grade table is now found by scanning all tables for
  grade-shaped rows (no fixed selector), the panel is (re)built by a DOM
  MutationObserver instead of relying solely on the grade message (the SPA
  doesn't always fire it), and the panel always renders — with a one-click
  "Copy debug info" button that dumps the detected table structure to the
  clipboard so any mis-detection is fixable without DevTools.

## Home Notices (2026-06)
- A "vRevamp — heads up" card on the VTOP landing page after login: days
  until CAT-1 / CAT-2 / FAT (red when ≤ 7 days away), the next holiday, and
  any subjects with ≤ 1 skippable class before the next exam. Rendered
  instantly from data cached by the attendance insights — nothing fetched.

## Attendance Insights (2026-06)
- **Bunk Calculator**: a table below the attendance table showing, per subject,
  classes held, classes remaining till semester end, and how many classes can
  still be bunked before CAT-1 / CAT-2 / FAT while staying ≥ 75% (past exams
  show what could have been bunked back then). Exam dates and instructional
  days come from the VTOP academic calendar (fetched silently, cached per
  semester in `chrome.storage.local`). Per-class histories come from the same
  endpoint the "view detail" modal uses, learned automatically from VTOP's own
  requests. Renders automatically on attendance page load and degrades to
  "--" if any fetch fails.


## 2026-06 cleanup
- Removed hardcoded Google API keys from the service worker and content scripts
- Fixed the service-worker message router (login/logout/download routing relied on exceptions)
- Download state now persists in `chrome.storage.session`; removed the alarm keep-alive hack and the `alarms` permission
- Fixed 12 PM exams exporting as 24:00 in the `.ics` download, and the file being named after the wrong exam type
- Fixed the outing form script crashing on every page (now injected into the page context where jQuery exists)
- Captcha solver now resolves `weights.json` via `chrome.runtime.getURL` instead of a hardcoded extension ID
- Removed `js/popup.js` from content scripts (it threw on every VTOP page)
- Capped Google Calendar 403 retries (previously retried forever)
- Repaired both GitHub Actions workflows; added ESLint (`npm install && npm run lint`)


\+ added a marks/totalmarks field
![image](images/totalmarks.png)

\+ added new nav bar
![image](images/navbar.png)

\+ auto current semester for class attendance