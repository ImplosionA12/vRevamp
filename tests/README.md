# Tests

End-to-end verification for the content-script features. Each check loads the
**real** content scripts into a headless Chromium browser, feeds them mock VTOP
HTML (and a mock VTOP network for the attendance flow), fires the same
`chrome.runtime` message VTOP would, and asserts what actually renders.

It does **not** touch the live VTOP portal — no login or credentials are needed.

## What it covers

- **Next-class widget** — current/next class + countdown from the saved timetable
- **CGPA what-if simulator** — credit join from the grade-history table,
  semester GPA, marks-to-next-grade from per-course cutoffs, live recompute on
  grade change, cumulative-CGPA projection from the page's CGPA Details box,
  the fallback panel when the grade table can't be detected, credits/CGPA
  resolved from the chrome.storage cache (the real Grades page carries
  neither), and the silent harvest of the Grade History page into that cache
- **Full timetable `.ics` export** — event count, lab-hour merging, weekly
  recurrence ending at the calendar's last instructional day
- **Attendance forecaster banner + bunk table** — below-75% flagging, recovery
  counts, and academic-calendar parsing/caching

## Running

```sh
npm install
npx playwright install chromium   # one-time browser download
npm test
```

Expected output ends with `34 passed, 0 failed`.
