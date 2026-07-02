These are the changes made to the project: 

## What-if simulator regression fix (2026-07-02)
- The 2026-06-27 rewrite below dropped several working pieces while adding its
  robustness pass: the `vrevamp-sim-gpa` element the projected GPA rendered
  into lost its id, the "add a hypothetical course" feature was removed
  entirely, the manual prior-CGPA/credits fallback inputs were dropped in
  favor of only auto-reading the page's CGPA Details box (silently useless
  when that box isn't present), and the course table lost its `<tbody>`. The
  end-to-end test suite (`npm test`) caught 3 of these; restored all of them —
  add-course is back (editable title/credits/grade, removable), the CGPA tab
  auto-fills from the page but stays editable/usable as a manual fallback, and
  typing in a number input no longer loses focus on every keystroke (the
  rebuild-driven render now restores focus + cursor position).

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