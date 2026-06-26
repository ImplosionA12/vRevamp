These are the changes made to the project: 

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