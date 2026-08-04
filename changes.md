These are the changes made to the project: 

## Code audit: dead code removal + latent-bug fixes (2026-08-02)

A read-through of every content script, the service worker and the popup,
looking for code that can never run and for defects the existing tests
don't reach. Lint clean, 186/186 tests green (6 new).

### Dead code removed

- **`js/navbarcc.js` — the whole file.** It only ever ran on
  `request.message === "vtopcc_nav_bar"`, and nothing has ever sent that:
  the worker's vocabulary is `vtop2_nav_bar` / `nav_bar_change`. Its markup
  also targets `loadmydiv(...)`, the pre-2026 vtopcc SPA entry point, so
  reviving it against the current layout would be guesswork. Deleted, and
  unregistered from `manifest.json` — one less content script parsed on
  every VTOP page.
- **`vtopcc_captcha` / `vtop2_captcha` broadcasts** (`background.js`). No
  listener exists anywhere: `js/captcha/captchaparser.js` is a separate
  `content_scripts` entry that self-starts on window `load`. Each one woke
  every content-script `onMessage` listener in the tab for nothing.
- **`case "ics_import_fallback"`** (`background.js`). Documented as kept for
  content scripts predating 2026-07-18 that outlive a worker update — but
  that can't happen: an extension update orphans old content scripts and
  invalidates their `chrome.runtime`, so they cannot send anything.
- **`case "login"` / `case "logout"`** (`background.js`). Both popup buttons
  are commented out in `html/popup.html`, and `js/popup.js` binds neither;
  `get_google_token` superseded `login` anyway.
- **`showOfflineIcon` listener** (`js/showOfflineIcon.js`). The worker's
  per-request broadcast of it was removed in 8055f0e as the listener-storm
  culprit; the listener it fed stayed behind as another no-op woken by
  every message.
- **`getBlockText()`** (`js/timetable/createTimeTable.js`). Its only
  reference was a commented-out line.
- **The unreachable third branch of `get_link()`** (`js/course_page.js`).
  `else if (webadress.indexOf("vtop2") == -1)` re-tested the exact condition
  the `if` above had already consumed — and was a verbatim copy of it, so it
  would have changed nothing even if reachable.
- **`buildIcs()`'s `exams` parameter** (`js/timetable_ics.js`) — see below;
  fixed by wiring it up rather than deleting it.
- Unused `index` parameters threaded through `js/course_page.js`.

### Bugs fixed

- **Timetable .ics download silently omitted exams.** `buildIcs(timetable,
  untilIso, exams)` built exam VEVENTs from the cached schedule, but its one
  caller passed two arguments. So the import button added classes *and*
  upcoming CAT/FAT exams while the .ics button beside it, reading the same
  cache, wrote classes only. Now passes `upcomingCachedExams()`, and reports
  what it wrote instead of staying silent.
- **`TZID=Asia/Kolkata` with no `VTIMEZONE`** (`js/shared/ics.js`). RFC 5545
  section 3.6.5 requires a TZID parameter to reference a definition in the
  same object; a bare Olson name is undefined behaviour. Google and Apple
  resolve it anyway — which is why it went unnoticed in a file written
  specifically for spec conformance — but a strict consumer may read every
  class as floating local time. Emits an IST `STANDARD` component (UTC+5:30,
  no DST since 1945), and only when an event actually references it.
- **Navbar buttons for menu entries the student doesn't have**
  (`js/navbarap.js`). A missing entry (My Curriculum is the usual one) left
  its index `undefined`, and the template still emitted the button — so
  clicking it ran `[undefined].click()` and threw in the page.
  `if (time_table)` had the mirror-image bug: a legitimate index of **0** is
  falsy, silently substituting Calendar for Time Table. Buttons are now
  emitted only for indices that resolved.
- **`js/navbarap.js` threw on every `nav_bar_change`** on pages without
  `.btn-group.dropend`, because the message handler dereferenced `[0].style`
  unguarded — the identical check at load time already used `?.`. The throw
  also skipped the navbar build.
- **Grade simulator re-scanned every table on every VTOP page, forever.**
  `scheduleBuild`'s guard read
  `if (sig === lastSig && document.getElementById(PANEL_ID)) return;`.
  On any page with no panel — i.e. all of VTOP except the grade pages — the
  second clause is false, so the short-circuit was unreachable and
  `buildPanel()` (three separate walks over every table and row in the
  document) ran on every quiet tick of a `document.body` subtree observer
  that never disconnects. Panel presence is already the third field of
  `sig`, so dropping the clause keeps the rebuild-after-re-render behaviour.
  Same failure mode as the freeze fixed in 8055f0e.
- **A rate-limited GitHub response poisoned the contributors list forever**
  (`js/contributors.js`). Unauthenticated API calls are capped at 60/h/IP and
  then answer 403 with an *object*, not an array. That object was written
  straight to `chrome.storage.local`, so `.forEach` threw *and* the junk was
  cached permanently — the list stayed empty on every later popup open. The
  surrounding try/catch caught none of it: everything ran inside an async
  storage callback. Now validates the shape before caching, and catches
  inside the callback.
- **Offline mode opened a burst of tabs.** The `onBeforeRequest` listener
  called `chrome.tabs.create` per *request*, and an offline page load still
  emits one event per subresource it attempts. Rate-limited to one tab per
  offline episode; coming back online re-arms it.
- **`displayTableData()` mutated the blob being saved**
  (`js/timetable/timetable.js`). It `splice()`d index 0 off the header and
  each theory/lab array — the same array objects `change_time_table()` hands
  to `saveTimeTable()` one line earlier. It works only because
  `chrome.storage` serialises its argument at call time; reordering those two
  lines, or awaiting anything between them, would have persisted a timetable
  missing its first column. (The test shim already carried a workaround
  comment for this.) Now copies with `slice()`; both callers render
  identically.
- **Bare ISO dates parsed as UTC** (`js/home_notices.js`,
  `js/utils/chooseCurrentSem.js`). `new Date("2026-08-15")` is UTC midnight,
  so for any viewer west of Greenwich the heads-up card printed the previous
  day and weekday for every exam and holiday, and `semesterLooksStale`
  computed end-of-day on the wrong date. `js/attendance_insights.js` already
  documents this hazard and carries the local-time parser; the other two now
  match it.
- **Duplicated course-page toolbar** (`js/course_page.js`). Every
  `course_page_change` message started a fresh interval that called
  `modify_page()` with no idempotency guard, so a second message appended a
  second "Select All", a second file-name dropdown, and a second checkbox in
  front of every material link. Guarded on `#select_all`, which a genuine SPA
  navigation clears.
- **`js/marks_page.js` dereferenced `.box-body` unguarded**, throwing past
  its own `catch` into `console.error` on layouts without it.
- **`js/timetable_ics.js` .ics button did nothing, silently**, when the saved
  timetable had no `header` array: `filterRepeated(undefined)` threw out of an
  un-awaited click handler. Header access is now guarded (degrades to
  "couldn't read any classes") and the handler has a `catch`.

### Known, not fixed

- `js/wifi/hostel.js` `login()` reports "Login successful" whenever the fetch
  doesn't throw — it never inspects the response, so wrong credentials look
  like success. It also uses `mode: "cors"` against a host that isn't in
  `host_permissions`. Both need an on-campus test against
  `hfw.vitap.ac.in:8090` to fix correctly; guessing at the response format
  would be worse than leaving it.
- `js/outing/store.js` appends the form field as `"x="` (trailing `=` in the
  key). Page-context code mirroring VTOP's own form; unverifiable without a
  live outing form.
- `js/da_upload.js`'s pre-2026 `da_page()` path and `js/course_page.js`'s
  `get_link()` legacy branch are kept deliberately as layout fallbacks, not
  treated as dead.

## Forecast banner contradicted the column beside it (2026-07-26)

Verified against live VTOP data (10 subjects): every bunk number the
extension prints is arithmetically correct — `safeNow`, session sizing,
"attend all →%", banner/table sync, and the FAT column re-derived
independently from remaining classes all match. The defect was purely in
how the banner phrased one of them.

`renderForecastBanner` (`js/attendance_insights.js`) printed
`nextBunkable` — "≥75% **on exam day** if you attend everything else" —
with the qualifier dropped:

> 🟢 Lowest margin: CSE3009 — 2 class(es) skippable before CAT-1

directly above that subject's own table cell reading *"Only 0 class(es)
can be Skipped, be Cautious"*. Two different numbers for one subject on
one screen. Worse, it *ranked* subjects by `nextBunkable`, so it named
CSE3009 at 2 while four rows sat at 0 by the never-dip metric — ranking
on one metric with the eye landing on the other.

Now it ranks on `safeCount` (the same never-dip number the table's
safe-now column shows) and carries both horizons on one line:

> 🟢 Tightest: CSE3009 — 0 class(es) safe to skip right now (2 before
> CAT-1 if you attend everything else)

The parenthetical is omitted when the two numbers agree. No maths
changed. The home-page card was checked and already labels the two
metrics distinctly ("skippable before the next exam" vs "Safe to skip
now"), so it needed no change.

## Code review follow-ups: ICS correctness, backdoor, CI, message storm (2026-07-25)

Acting on a senior review of the whole extension. Five items, worst first.

- **Malformed .ics was silently dropping exams** (new `js/shared/ics.js`,
  used by `js/exam_schedule.js` + `js/timetable_ics.js`). Reproduced with
  real data: a course with BOTH a theory and a lab exam produced two events
  with the **identical UID** (it was built from the export timestamp +
  course code alone). Same UID means "same event", so Google/Apple Calendar
  kept one and discarded the other — the student's exam simply wasn't
  there, with no error anywhere. Three more RFC 5545 violations in the same
  output: unescaped TEXT values; `DTSTAMP;TZID=Asia/Kolkata:…` (DTSTAMP is
  defined as UTC — no TZID, must end in `Z`); and LF endings with unfolded,
  arbitrarily long lines.

  **Correction (2026-07-26), after checking against ical.js** — the review
  claimed unescaped `,`/`;` "split one property into several values". That
  is **wrong**: ical.js recovers unescaped commas, semicolons *and*
  backslashes intact, so they were never causing the data loss attributed to
  them. The escaping defect that genuinely breaks files is a **literal
  newline** inside a value: the parser reads the remainder as a new content
  line and **rejects the entire calendar** ("invalid line (no token ';' or
  ':')"). Nothing imports at all.
  A second correction, from testing in Chrome: this was first written up as
  "a cell containing `AB-1<br>Room 324` yields a newline via `textContent`".
  Also wrong — `<br>` contributes nothing to `textContent`; that markup on
  one line gives `"AB-1Room 324"`. The newline actually comes from a cell
  whose content **spans multiple source lines** (`<td>\n AB-1\n Room 324\n
  </td>`, or one nested element per line), because `textContent` preserves
  the source whitespace between text nodes and `.trim()` only strips the
  ends. JSP output routinely wraps cell content that way, so it is
  reachable — but it has not been confirmed against live VTOP markup for
  the exam table specifically. Escaping
  `,`/`;` stays — it is required by RFC 5545 §3.3.11 and a stricter or
  multi-value-aware consumer may well differ from ical.js — but it should
  not be described as fixing data loss. The confirmed-severe defects are the
  **UID collision** and the **literal newline**.
  All .ics generation now goes through `vrIcs.calendar()`, which escapes
  TEXT values, folds at **75 octets** (code-point walk, so a 3-byte em dash
  is never split), emits CRLF, and builds content-derived UIDs — stable
  across re-exports, so re-importing updates rather than duplicates. Exam
  download also corrected from `data:text/plain` to `text/calendar`.
- **Removed a page-world backdoor** (`js/timetable_ics.js`): a
  `window.postMessage({vrevamp:"gcal_import"})` listener, added as a
  live-verification hook, shipped. Any script running on the VTOP page
  (VTOP itself, an injected script, an XSS on the portal) could fire it and
  make the worker open dozens of background tabs writing to the student's
  Google Calendar — no user gesture required.
- **CI had never run once**: both workflows triggered on `main` while the
  default branch is `master`. Pointed at `master` and added lint + the full
  verification suite as a gate — the Web Store upload job now refuses to
  publish a build that hasn't passed both. Packing moved to
  `.github/pack.sh`, an **allowlist** (the old `zip -r . -x …` denylist
  excluded neither `node_modules/` nor `tests/` nor `package-lock.json`; it
  only ever produced a sane archive because CI never ran `npm ci`). The
  script self-checks the archive before handing it over.
- **`web.vitap.ac.in` was a dead zone**: injected by `content_scripts` but
  absent from `host_permissions` *and* from `VTOP_URLS` in the worker, so
  it received no webRequest events — all 17 content scripts loaded and not
  one message-driven feature worked there. Added to both (confirmed live).
  Note: this is a new host permission, so Chrome will disable the extension
  until each user re-accepts it, and the Web Store will re-review.
  Also deduped redundant `matches`/`host_permissions` entries.
- **Message storm** (`service_worker/background.js`, `js/showOfflineIcon.js`):
  `showOfflineIcon` was broadcast once per *completed request* — every
  image, stylesheet, script and XHR. A single VTOP page load is 50–100
  requests, and each message wakes all ~17 content-script `onMessage`
  listeners, so one load cost well over a thousand listener invocations —
  the same budget that caused the "Page Unresponsive" freeze fixed in
  8055f0e. The icon never needed a message: it now renders itself on load
  and stays idempotent. The listener is kept for explicit re-renders.
- Tests: added an RFC 5545 conformance block (UID collision with a
  theory+lab pair, comma/semicolon escaping, CRLF, UTC DTSTAMP, 75-octet
  folding incl. multi-byte and exact unfold round-trip) plus conformance
  assertions on the timetable export. **177/177 pass** (was 160), eslint
  clean. `vrIcs` declared in `eslint.config.mjs` as a shared global.
- **Test harness fidelity** (`tests/verify.mjs`): the `chrome.storage` stub
  returned live references (`{...s}` is shallow), where the real API
  structured-clones both in and out. That made a whole bug class untestable
  — `displayTableData()` splices index 0 off the header/theory/lab arrays it
  is handed, and with a shared reference that corrupted the "stored"
  timetable for every later reader in the same page. Found while running the
  full manifest bundle in a real browser: `timetable.js` and
  `timetable_ics.js` both answer `timetable_view_page`, and under the old
  stub the first silently ate the second's 08:00 theory class. The real
  extension is unaffected (every `get` is a fresh clone), but the stub now
  clones too, so the aliasing can't hide. Suite still 177/177.

### Live verification (2026-07-25, real Chrome, not Playwright)
Nothing in the suite reads `manifest.json`, so a bad path or a
shared-scope collision would ship undetected. Built a harness that
concatenates all 29 `content_scripts[0].js` files **in manifest order** into
one page, as Chrome does at inject time:
- all 29 paths resolve, **0 uncaught errors**, 18 listeners registered,
  `vrIcs` present with its full API, and every pre-existing shared global
  (`filterRepeated`, `getTimeTable`, `saveData`, `semesterLooksStale`,
  `domtoimage`) still resolves — no redeclaration collision from the new file.
- exam export driven end-to-end (real button click, captured download) and
  the .ics parsed by an **independent** RFC 5545 consumer written from the
  spec: 2 events with distinct UIDs, and `SUMMARY`/`LOCATION` round-trip to
  the *exact* original strings, commas and semicolons intact. The folded
  `DESCRIPTION` unfolds back to `Seat: R3C1 No. 5` — fold/unfold is
  lossless. Max line exactly 75 octets, no bare LF, `DTSTAMP` UTC.
- timetable export: theory + merged 2-hour lab, unique UIDs, weekly RRULE.
- security: `window.postMessage({vrevamp:"gcal_import"})` now does **nothing**
  (no `gcal_template_import` reaches the worker).
- offline icon renders itself on load with **zero** messages sent.

## Bunk Calculator accuracy hardening, round 2 (2026-07-19)
- **Calendar month fetch rework** (`js/attendance_insights.js`): the month
  list previously merged the landing page's onclick dates with the
  per-semester endpoint's — the same month could be fetched several times
  (per-day links, case-variant date strings, or a landing page defaulted to
  a different semester), and every re-fetch **duplicated its instructional
  days**, inflating "remaining till sem end" and every bunkable column.
  Now: per-semester endpoint first (landing only as fallback), one fetch
  per calendar month, and day records are merged per date (flags OR-ed) so
  a date can never appear twice in `instructionalDays`. Cache version 3→4
  so previously stored (possibly inflated) calendars refetch once.
- **Nested-table guards**: a wrapper `<td>` around a nested month grid used
  to match the day regex against the whole month's text (bogus day flagged
  with every label — could even shift the "first CAT-1 day"); a wrapper
  `<tr>` around a nested register table could add a phantom
  Present/Absent entry. Both are now skipped.
- **One-off classes no longer projected forward**: in the
  inferred-from-history schedule, a weekday the subject met on only once
  across a 3+ week history (makeup class / day-order swap) is dropped
  instead of being counted as a weekly meeting.
- What-if simulator's "safe now" is now capped by the classes actually
  remaining (shrinking as skips/attends are simulated), matching the table.
- **Honest unreachable-75% banner**: a below-75 subject whose remaining
  classes can't lift it back used to get impossible advice ("attend the
  next 5" when 4 remain) — it now says "can't reach 75% this sem even
  attending everything (max N%)", consistent with the attend-all note.
- **TZ-safe weekday math**: every `new Date("YYYY-MM-DD").getDay()` (UTC
  parse — wrong weekday west of Greenwich) replaced with local-time
  `wdOfIso`/`dateOfIso` helpers; gap/debar dates display via the same.
- Tests: duplicate same-month link fixture, nested-wrapper register
  fixture + held-count assertion, unreachable-75% banner assertion —
  160/160 pass, eslint clean.
- **Live verification (2026-07-19, Fall 2026-27)**: pulled the real
  calendar (75 instructional days 14 Jul–14 Nov, CAT-1 17 Aug, CAT-2
  28 Sep, FAT 16 Nov, no lab-FAT marked yet) and all 8 non-empty registers
  directly from VTOP, then brute-forced which weekly pattern explains each
  subject's rendered row — for **every subject one pattern reproduces all
  six columns exactly** (remaining, CAT-1/2, FAT, safe-now, debar date).
  Confirmed live: labs post ONE register row per session while VTOP's
  headline counts hours (0/2 vs 1 entry); Mondays are genuinely
  "No Instructional Day" this semester (Tue–Sat teaching) and the parser
  excludes them correctly; calendar landing/months endpoints currently
  clean (no per-day links, no nested grids) — the dedupe/nesting guards
  protect against layouts that did/could ship them. Soft spot: LIB2006 is
  absent from the saved timetable (flagged on its row) so its schedule is
  guessed from a 1-entry register — reopening the Time Table page fixes.

## Bunk Calculator accuracy audit + fixes (2026-07-18, late night)
- **User-reported**: suspected wrong CSE4007 (embedded theory+lab) numbers.
  Verified live against VTOP's own data, recomputed every cell by hand:
  theory register 1/3 (14/15 Jul absent, 17 Jul present), lab register one
  row per session (VTOP's headline 2/2 counts HOURS), CAT-1 starts 17 Aug,
  12 Tue/Wed/Fri instructional days before it → bunkable-before-CAT-1 = 1
  is **correct** (as are CAT-2: 5, FAT: 9, remaining 42 / lab 15, FAT 4).
  The scary numbers were real: 2 of 3 theory classes missed.
- Accuracy fixes that DID come out of the audit:
  - Percentages now display VTOP-style (ceil: 1/3 → 34%) so the banner
    never disagrees with VTOP's row beside it; all below-75% checks now use
    the exact ratio, so 74.6% (displayed 75%) can no longer escape the red
    flag (previously `Math.round` hid it).
  - Lab "Classes held" is now whole sessions (`total/size`) like every
    other lab number — on per-hour deployments it showed hours.
  - Rows the saved timetable can't schedule now say so on the subject cell
    ("not in the saved timetable" / "saved timetable disagrees with this
    register — schedule guessed from N posted weekday(s)"): live, LIB2006
    fell back to 1-day/week history inference (remaining 13 vs true ~40)
    with no hint why.
  - **Register-completeness check** (user request): scheduled class days
    with no register entry between the first and last posted entries get a
    "⚠ no entry for N scheduled class day(s): dates — class skipped or not
    posted" note (days after the last entry stay the stale flag's job;
    today excluded — often not posted yet).
- Tests: GAP1001 fixture (MON/WED/FRI timetable, 7 Jan hole, 1/3 → 34%) —
  5 new assertions; 158/158 pass, eslint clean.

## Timetable import fallback: one-tap links — Google broke their Import page (2026-07-18)
- **User-reported**: the fallback's Import tab "keeps loading infinitely".
  Reproduced live: Google's 2026 Calendar revamp broke the whole classic
  settings surface — `/r/settings/import` (and `/r/settings`, even via the
  in-app gear → Settings) never renders; the URL changes but the week view
  stays up forever. `calendar.google.com/render?action=TEMPLATE` still
  works in the new UI, **including recurrence via `recur=RRULE:…`**
  (verified live: prefilled editor shows "Weekly on Monday, until 15 Nov").
- The no-sign-in fallback no longer downloads an .ics or opens the dead
  Import page. It now renders a one-tap links panel under the button
  (`#vrevamp-tt-links`): one TEMPLATE link per weekly class carrying the
  whole-semester `RRULE…UNTIL` (attendance-snapshot title, venue, slot,
  next-occurrence anchor — same data as the API path, minus EXDATEs which
  TEMPLATE URLs can't express) + one single-event link per cached upcoming
  exam. Click → prefilled editor in a new tab → Save; clicked links grey
  out with a ✓. The plain "Export timetable to .ics" button stays for
  file-based calendars.
- Worker's `ics_import_fallback` handler kept as legacy (pre-update content
  scripts), current builds never send it. Dead-client sign-in hint in all
  three copies (timetable/exam/DA) no longer points at ⚙ Settings → Import.
- Tests: dead-client block rewritten (panel contents, class-link RRULE
  encoding, exam link sans recur, no download/no Import tab, ✓ grey-out);
  old-worker test dropped with the path — 150/150 pass, eslint clean.

## Same day, round 2: fully automatic one-click import (2026-07-18)
- **User-reported**: 22 one-tap clicks is still manual labour — the button
  should import everything itself, for every user, with zero setup.
- New worker message `gcal_template_import`: for each TEMPLATE link it
  opens a background tab, waits for the editor, `chrome.scripting`-injects
  a MAIN-world clicker that presses Save (verified live that a JS click on
  the editor's Save button works) and waits for the editor to close, then
  closes the tab. Progress streams back per event
  (`gcal_template_progress`) so the button counts "importing… n/22".
  Manifest: + `scripting` permission, + `https://calendar.google.com/*`
  host permission.
- Button flow on dead sign-in: try the automatic import first; ✓ n/N note
  on success. Partial success (an editor never loaded) shows the counts
  AND the one-tap panel to finish by hand; total failure (old worker,
  missing permission, no Google session, non-English Save label) falls
  back to the panel exactly as before. A worker suspension that drops the
  final sendResponse can't fake a failure — the content script keeps the
  last progress message as the source of truth.
- Tests: shim emulates the new worker message; 3 new tests (links handed
  to the worker first; ✓ 3/3 + no panel; partial 2/3 + panel) — 153/153
  pass, eslint clean.
- **Verified live end-to-end** (22-class Fall 2026-27 timetable): triggered
  the import via the page hook, watched "importing… n/22" count to
  ✓ 22/22, confirmed all 22 weekly series in Google Calendar (~8 s/event).
  Two hardening rounds from the live run: the worker stops after 3
  straight zero-save failures instead of strobing 22 tabs, and reports
  `lastError` (shown in the button note) so failures aren't silent. A
  first run that "looked crashed" was actually saving slowly in the
  background — re-clicking stacks a second copy of everything, so the
  success note now warns that re-running duplicates (no API access = no
  automatic replace-old like the OAuth path had).

## Timetable import fallback: route it through the worker (2026-07-17)
- **User-reported**: the 2026-07-16 fallback still "did nothing" when
  clicked. Root cause: by the time the fallback ran, the click's user
  activation was already spent on the two failed sign-in round-trips, so
  the page-side `window.open()` (Import tab) — and potentially the anchor
  download — were silently popup-blocked.
- The worker now does both (new `ics_import_fallback` message): it
  downloads the .ics via `chrome.downloads` and opens the Import page via
  `chrome.tabs.create` — neither needs user activation, so nothing can be
  blocked. The old page-side path stays as a last resort if the message
  fails (worker from an older build).
- The fallback also triggers more broadly: any sign-in failure that isn't
  user-fixable (previously only the exact dead-client regex; now unknown
  errors too), and the 401 dead end where a cached token from when the
  client was alive dies un-refreshably mid-import.
- Orphaned-content-script clicks (extension reloaded, tab not refreshed:
  every `chrome.*` call throws "Extension context invalidated") now say
  "vRevamp was updated under this page — refresh the page (F5)" instead of
  the generic failure line. Sign-in failures are also `console.info`'d so
  live debugging can see WHY.
- Test shim emulates the new worker message (+ a flag to simulate an old
  worker); 2 new tests (fallback goes through the worker; old worker →
  page-side path still fires) — 149/149 pass, eslint clean.

## Timetable → Google Calendar: no-sign-in fallback for the dead client (2026-07-16)
- The "📅 import timetable to Google Calendar" button dead-ended for every
  user: the API path needs OAuth and the published build's client id is dead.
- Now, when sign-in fails with the bad/invalid/deleted-client error, the
  button does the import the no-sign-in way in one click: builds the .ics
  (weekly classes + cached upcoming exams — `buildIcs` gained an optional
  exams argument, `upcomingCachedExams()` split out of `examEvents`),
  downloads it, opens Google Calendar's Import page
  (calendar.google.com/…/settings/import) in a new tab, and tells the user
  to pick the file and press Import. Other sign-in failures (no Chrome
  account, consent closed) keep their specific retryable hints.
- Test shim's get_google_token now honours a seeded `google_error`; 2 new
  tests (fallback .ics contents incl. exam VEVENT, Import page + note) —
  147/147 pass, eslint clean.

## Labs: bunk math targets the LAB FAT, never CATs (2026-07-16)
- **User-reported**: lab components were treated like theory — "skippable
  before the next exam" counted toward CAT-1/CAT-2 dates, but labs sit no
  CATs; their only exam is the lab FAT (usually before the theory FATs).
- Calendar parser (`classifyDay`) now splits FAT days: `fat` = theory
  ("Final Assessment Test", or explicitly Theory), `labFat` = days whose
  label mentions Lab/Laboratory ("Theory & Lab" flags both). This also stops
  a lab-FAT day from dragging the theory FAT date earlier via firstIso.
  Calendar cache version 2 → 3 so existing caches refetch with `labFat`.
- Per-subject math: lab rows' next exam is now `["lab FAT", labFat || fat]`
  (fallback when the calendar marks no separate lab day) — banner and home
  card follow via nextExamLabel. Bunk table: lab rows show "no CATs for
  labs" in the CAT columns and compute the FAT column to the lab FAT date;
  footnote updated.
- 3 new tests (labFat split, lab CAT columns, theory rows untouched) —
  145/145 pass, eslint clean. (Test run note: machine was under memory
  pressure from a running game; suite output had to go to a file.)

## One-tap "add to Google Calendar" links — no OAuth needed (2026-07-16)
- **Why**: the ✉️ email-reminder buttons ride on the Calendar API and the
  manifest's OAuth client id — which is the original author's and is dead
  ("bad client id", captured live on the button's error line 2026-07-16).
  Every user would have to create their own Google Cloud OAuth client to use
  them, which is unreasonable for a distributed extension.
- **New universal path**: plain `calendar.google.com/render?action=TEMPLATE`
  anchors (shared `window.vrGcalTemplateUrl` helper, guarded copy in
  exam_schedule.js + da_upload.js). Clicking opens the user's own Google
  Calendar with the event prefilled (title/window/venue/seat details,
  `ctz=Asia/Kolkata`) — they just press Save. No extension OAuth, no consent
  flow, works for every user.
- Exam schedule page: every **upcoming** exam row with a published time gets
  a "📅 add" link in its date cell (past / no-time rows skipped).
  `exam_rows_of_group`'s cell reader now strips `.vrevamp-gcal-link` before
  parsing — the link text was polluting the date cell and silently dropping
  the row from the .ics/🔔/✉️ parsers (caught by the test suite).
- DA page (2026): each course's Upcoming Dues cell gets "📅 gcal" per
  un-submitted upcoming due (20:00–21:00 on the due day, like the ✉ path).
- Event details carry a tip: add an Email notification to the event (or set
  an email default in Google Calendar settings) to get reminders mailed.
- ✉️/🔔 buttons unchanged (🔔 needs nothing; ✉️ works for whoever configures
  their own client id). `vrGoogleAuthHint` (all three copies) now recognises
  the bad/invalid/deleted-client errors and answers with the no-sign-in
  alternatives (📅 links, .ics import) instead of a dead-end message.
- 5 new tests — 142/142 pass, eslint clean.

## Stale-semester detection: home cards stop showing last sem's data (2026-07-16)
- **Bug (user-reported with screenshot)**: after the new semester started, the
  home heads-up card still showed last semester's cached warnings ("only 0
  class(es) skippable…", safe-skip counts) as if current, and the next-class
  card said "Done for the day" from the old timetable.
- New helpers in `js/utils/chooseCurrentSem.js`: `currentTermStartEstimate`
  (latest of the ~Dec 1 / ~May 1 / ~Jul 1 term boundaries ≤ today) and
  `semesterLooksStale(name, calendar)` — stale only when a newer term has
  begun **and** the cached calendar's own last date (FAT / last instructional
  day) is behind us, so it never cries wolf during transition weeks while the
  old sem is still wrapping up.
- `home_notices.js`: when stale, the at-risk / safe-skip / buffer / holiday
  lines are suppressed and one amber note renders instead: cached data is
  from "<sem>", open Attendance + Time Table once to load the new semester.
  Exam countdowns from a stale calendar are skipped too.
- `saveTimeTable` now stamps `semester` (from the timetable page's dropdown)
  and `savedAt`; `next_class.js` checks staleness — a stamped old-sem
  timetable, or a legacy unstamped blob while the newest cached calendar's
  semester is over, renders "Saved timetable looks like last semester's —
  open the Time Table page once to refresh it." instead of Done-for-the-day.
- Live-verify follow-up (same day): VTOP's timetable page renders the
  registered semester with the dropdown still on the placeholder, so the
  blob got `savedAt` but no semester stamp and the legacy rule wrongly
  flagged the fresh save. Fix: a blob with `savedAt` is judged by save date
  vs `currentTermStartEstimate()` — only stampless blobs use the
  calendar-proxy legacy rule.
- Verified live on VTOP (2026-07-16): heads-up card showed the stale note
  for "Summer Semester-II 2025-26 - AMR"; after opening Attendance (auto-
  picked FALL SEMESTER 2026-27) the card flipped to new-sem data — CAT-1/
  CAT-2/FAT countdowns, 19 Jul holiday, new-sem at-risk subjects — and the
  next-class card runs off the new timetable.
- 12 new tests (stale note + suppression, mid-semester negative case,
  legacy/stamped/savedAt-only timetables) — 137/137 pass, eslint clean.

## Message routing: deliver to the requesting tab, not the focused one (2026-07-16, live)
- **Root cause of "features randomly missing" found live**: the worker's
  `returnMessage` used `chrome.tabs.query({active:true})`, so page messages
  (exam_schedule, timetable_view_page, da_upload…) only ever reached the
  VTOP tab **while it was the focused tab**. Switch tabs/windows while VTOP
  loads and every message-driven feature silently dies — including the
  Google sign-in path (the token helper then fell back to a stale stored
  token and reported "sign in" without ever opening the consent window).
- Fix: `webRequest` events carry the requesting `details.tabId` — messages
  now go straight to that tab; the active-tab guess is gone (fallback:
  broadcast to all VTOP tabs when a request isn't tab-bound).
- Verified live on VTOP (2026-07-16): with the tab **not** focused, the exam
  schedule page now gets all three buttons (.ics / 🔔 notify / ✉️ email).
- Live-testing gotcha discovered: claude-in-chrome's clicks are synthetic
  events from *its* isolated world — they trigger VTOP's main-world handlers
  but can never fire vRevamp's isolated-world button handlers. Button clicks
  must be tested by a real user click.

## Reminders without Google sign-in + real sign-in errors (2026-07-16)
- **New: local reminders via `chrome.alarms` + `chrome.notifications`** — no
  Google account, no consent window, nothing leaves the machine. The worker
  handles `schedule_local_reminders` messages (`service_worker/background.js`):
  reminders are stored under `vrevamp_local_reminders`, one alarm each, and
  fire as Chrome desktop notifications; re-scheduling with the same tag
  replaces the old set instead of stacking duplicates. Alarms survive browser
  restarts (ones missed while Chrome was closed fire once at next launch).
  Manifest regains `alarms` + adds `notifications`.
- **Exam schedule page**: the bell is now "🔔 notify me before each exam" —
  Chrome notifications 1 day and 2 h before each upcoming exam (venue, seat,
  reporting time in the notification). The Google Calendar email path moved to
  a separate opt-in "✉️ email me instead (Google)" button.
- **DA page (2026)**: "🔔 remind me" now schedules Chrome notifications at
  6 PM the evening before and 8 AM on the due day for every un-submitted
  upcoming due of that course; "✉ email" keeps the Google Calendar route.
- **Fixed the invisible sign-in failure**: `get_google_token` used to swallow
  `chrome.runtime.lastError`, so when `chrome.identity.getAuthToken` failed
  (most commonly the Chrome profile has no Google account signed in — then no
  consent window can ever open) the buttons just looked dead. The worker now
  returns `{ token, error }` and the shared `vrGoogleToken` helper (exam / DA /
  timetable-import scripts) surfaces a readable reason via
  `vrGoogleAuthHint()` — e.g. "Chrome has no Google account signed in…".
- Removed all stale "sign in from the vRevamp popup" advice — the popup lost
  its Google sign-in button long ago, so that instruction led nowhere.
- Tests: shim now emulates the worker's `get_google_token` /
  `schedule_local_reminders` messages; exam + DA sections rewritten for the
  two-button UX with checks on the exact notification times. 125 checks, all
  green; ESLint clean.

## "Page Unresponsive" freeze: timetable observer storm fixed (2026-07-07, live)
- User screenshot: Chrome's "Page Unresponsive" dialog on VTOP. Root cause
  in the ORIGINAL upstream `js/timetable/timetable.js`: its MutationObserver
  watches `#loadMyFragment` — VTOP's generic SPA container that EVERY page
  load floods with mutations — and ran the full pipeline (table re-parse +
  storage save + **domtoimage PNG render**) synchronously on EVERY mutation,
  with `attributes:true` so even the loading spinner's style toggles fired
  it. Worse, each re-fired `timetable_view_page` message attached ANOTHER
  observer (they stack), multiplying the work each time until the renderer
  froze. (My earlier "it's just VTOP's slow server" diagnosis was only half
  the story — the asset stalls are real, but the freeze was ours.)
- Fix: one observer per document (re-message disconnects the old one),
  400 ms debounce, a textContent signature so identical table content is
  never re-rendered, `attributes` dropped from the config, and crash guards
  (missing `#loadMyFragment`, empty saved timetable).
- Harness: stubbed-collaborator fixture counting renders — a 40-mutation
  burst = 1 render, re-fired message doesn't stack, unchanged content = 0.
  120 checks green.

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