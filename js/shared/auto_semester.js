/*
 * vrAutoSemester — open a semester-gated VTOP page without making the student
 * pick the semester first.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * Asked for 2026-08-19: "when i click attendance i dont choose the semester,
 * you should keep it like tht" — i.e. do for the other pages what the
 * attendance page already does. (js/attendance.js is deliberately NOT changed
 * or reused here; it was read as the model and left alone.)
 *
 * The shapes below were read off the live portal on 2026-08-19, signed in, not
 * inferred from fixtures:
 *
 *   | page          | data-url                                    | how it loads      |
 *   |---------------|---------------------------------------------|-------------------|
 *   | Marks View    | examinations/StudentMarkView                | onchange          |
 *   | Grades        | examinations/examGradeView/StudentGradeView | onchange          |
 *   | Time Table    | academics/common/StudentTimeTable           | onchange          |
 *   | Exam Schedule | examinations/StudExamSchedule               | **Search button** |
 *
 * Exam Schedule is the odd one and the reason this exists: its #semesterSubId
 * carries NO onchange attribute, so a change event renders nothing at all. It
 * needs `<button class="btn btn-primary btn-block">Search</button>` pressed.
 *
 * ---------------------------------------------------------------------------
 * 2026-08-21 — WHAT THE FOUR PAGES ACTUALLY DID, MEASURED
 * ---------------------------------------------------------------------------
 * Reported as "make it so that the inside applications as auto selctor and
 * stuff work properly". Driven against vtop.vitap.ac.in signed in, one page at
 * a time, before anything here was changed:
 *
 *   | page          | options | it picked                    | rendered |
 *   |---------------|---------|------------------------------|----------|
 *   | Exam Schedule | 69      | Fall Semester 2026-27   ✓    | yes      |
 *   | Time Table    | 8       | Fall Semester 2026-27   ✓    | yes      |
 *   | Grades        | 69      | nothing — left on placeholder| no       |
 *   | Marks         | 69      | Fast Track Fall Semester ✗   | no       |
 *
 * Two failures, with two different causes and one shared lesson.
 *
 * 1. **Grades never ran at all.** Its `loaded()` asked whether
 *    `#studentGradeView` exists — and that div is present on the EMPTY form,
 *    before any semester is chosen. So the very first question this module
 *    asks answered "already showing data, leave it alone" on a page showing
 *    nothing, every single time. The file's own rule ("`loaded` is asked about
 *    CONTENT, never about the existence of a table") was right; this predicate
 *    just broke it. Read live, a grades page with data always carries a table
 *    reading "Course Code … Grading Type", and an empty one carries no table
 *    at all.
 *
 * 2. **Marks walked off the correct answer onto junk.** The step-down walk
 *    rested on an assumption that is simply false: *no data means the wrong
 *    semester.* Measured on Marks, signed in — "Fall Semester 2026-27", the
 *    right semester, renders ZERO tables, because it is August and no marks
 *    have been published yet. `loaded()` can therefore never become true, so
 *    the walk did what it was built to do and kept going:
 *
 *        Fall Semester 2026-27 Freshers  →  Fall Semester 2026-27
 *          →  Fall_Win Transport Semester 2026-27  →  Fast Track Fall …
 *
 *    and left the page parked on a transport/fast-track semester, having also
 *    fired four POSTs at VTOP and — watched live — OVERWRITTEN a semester
 *    picked by hand while it was still in flight.
 *
 * So the walk is gone. It cannot conjure data that has not been published, its
 * failure mode is strictly worse than doing nothing (a wrong semester on
 * screen instead of the right one showing "nothing yet"), and it fights the
 * student. What replaces it is one decisive pick and one submit.
 *
 * ---------------------------------------------------------------------------
 * PICKING THE RIGHT SEMESTER, WITHOUT GUESSING TWICE
 * ---------------------------------------------------------------------------
 * The two dropdowns are not the same list, which is the whole story. Read live:
 *
 *   Attendance, Time Table   8 options, only the student's OWN registered
 *                            semesters, tagged " - AMR". Index 1 is already
 *                            correct, which is why those pages just work.
 *   Marks, Grades, Exam Sch. 69 options, every semester VIT-AP runs. Four of
 *                            them parse to the same start as the real one:
 *                              Fall Semester 2026-27 Freshers
 *                              Fall_Win Transport Semester 2026-27
 *                              Fast Track Fall Semester 2026-27
 *                              CDC PAT 2025-26
 *                            and document order handed the tie to whichever
 *                            came first. That is how "Freshers" won in August
 *                            2026, and how the walk ended on "Fast Track".
 *
 * Three tiers, in order, first hit wins:
 *
 *   1. the semester vRevamp has already SEEN the student registered in —
 *      `vrevamp_attendance_summary.semester` / `vrevamp_exam_schedule.semester`,
 *      both written off registration-scoped dropdowns. Exact match after the
 *      campus tag is stripped, never fuzzy, so "Freshers" cannot survive it.
 *   2. failing that, the newest already-started option that is NOT one of the
 *      known non-registration variants above. A denylist, deliberately: Short
 *      Summer, Long Summer and Winter are real semesters and must not be swept
 *      up by a general "unusual name" rule.
 *   3. failing that, chooseCurrentSemester() — the old behaviour, unchanged.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THAT REPLACED THREE GUARDS
 * ---------------------------------------------------------------------------
 * **Only ever answer a picker that is still on the placeholder.**
 *
 * A picker showing a semester has been answered — by VTOP restoring a choice,
 * by the student, or by this module a moment ago — and none of those are ours
 * to overwrite. That single question subsumes the old load-loop guard (these
 * hooks fire after every VTOP AJAX render; a re-fire finds index > 0 and
 * stops), the "never disturb data on screen" rule (a rendered page always has
 * a semester picked), and the mid-walk race that let a re-fired message start
 * a second walk alongside the first. `loaded()` is kept as a cheap second
 * opinion, no longer as the only thing standing between us and a loop.
 *
 * Behind it, one attempt per picker ELEMENT — not per page name. VTOP is a
 * single-page app that builds a new <select> per render, so the same element
 * twice is a re-fired message while a new one is a genuine revisit, and the
 * second visit to Marks in a session is helped like the first. A dataset flag
 * would NOT do: VTOP replaces the <select> along with everything else, taking
 * the flag with it (the durability trap js/shared/click.js documents).
 *
 * ---------------------------------------------------------------------------
 * 2026-08-20 — why none of this had ever run on three of the four pages
 * ---------------------------------------------------------------------------
 * 1. **The message never arrived.** Each caller hung this off the message the
 *    service worker sends for that page — and those are all sent for the
 *    page's DATA endpoint, which VTOP only POSTs once a semester has been
 *    picked. So the hook that exists to pick the semester fired only after
 *    somebody had picked it. The worker now sends `semester_page_open` for the
 *    page itself, and this module answers it: PAGES below is the registry.
 *
 * 2. **It arrived too early to be usable.** `webRequest.onCompleted` fires
 *    when the RESPONSE completes; VTOP's jQuery writes it into the DOM after
 *    that, so `getElementById("semesterSubId")` was null on the very message
 *    announcing the picker. The select is waited for with a capped poll — the
 *    shape js/captcha/refreshTillCaptcha.js uses, and for the same reason: an
 *    observer on `body` on a page VTOP is actively rendering is what produced
 *    the 2026-08-07 freeze.
 */
(() => {
  if (typeof window.vrAutoSemester === "function") return;

  // name -> the picker ELEMENT already answered for that page. See "one rule".
  const tried = new Map();

  // How long to wait for VTOP to write the picker into the DOM — see (2).
  const SELECT_WAIT_MS = 8000;
  const SELECT_POLL_MS = 250;

  const semesterSelect = () => document.getElementById("semesterSubId");

  // How long to look for a DIFFERENT picker once the one in hand looks
  // answered. Seen live 2026-10-10: the worker's page-open message beats the
  // new page's DOM, so on a section-to-section move the only picker on screen
  // was the PREVIOUS page's, already answered — and "an answered picker is
  // somebody's answer" made auto-semester give up on every page but the first.
  const STALE_GRACE_MS = 3000;

  const waitForNewSelect = async (old, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = semesterSelect();
      if (now && now !== old) return now;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };

  const waitForSelect = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const select = semesterSelect();
      if (select) return select;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, SELECT_POLL_MS));
    }
  };

  /*
   * "Fall Semester 2026-27 - AMR" and "Fall Semester 2026-27" are one semester
   * written by two pages; the trailing " - AMR" is a campus tag the
   * registration-scoped dropdowns add. Deliberately an EXACT match after that
   * is stripped, never a fuzzy one: "Fall Semester 2026-27 Freshers" must not
   * survive it, and avoiding exactly that string is the point.
   */
  const normaliseSemester = (text) =>
    String(text || "")
      .replace(/\s+-\s+[A-Za-z]{2,5}\s*$/, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  /*
   * The option names that sit in the 69-entry list but are not the semester an
   * ordinary student is registered in — all four read off the live dropdown on
   * 2026-08-21, all four parsing to the same start date as the real one.
   *
   * A denylist and not a general "looks unusual" rule, on purpose: "Short
   * Summer Semester I", "Long Summer Semester" and "Winter Semester" are real
   * registrable semesters sitting in the same list, and a cleverer heuristic
   * would eat them.
   */
  const DECOY_SEMESTER =
    /\bfreshers?\b|\btransport\b|\bfast\s*track\b|\bcdc\b|\bpat\b|\bspecial\s+arrear\b/i;

  // The semester vRevamp has already seen this student registered in, named by
  // a page whose dropdown lists only their own. Read-only.
  const knownSemesterNames = async () => {
    try {
      const store = await chrome.storage.local.get([
        "vrevamp_attendance_summary",
        "vrevamp_exam_schedule",
      ]);
      return [
        store.vrevamp_attendance_summary && store.vrevamp_attendance_summary.semester,
        store.vrevamp_exam_schedule && store.vrevamp_exam_schedule.semester,
      ]
        .filter(Boolean)
        .map(normaliseSemester)
        .filter(Boolean);
    } catch {
      return []; // storage gone — parsing still works, just less precisely
    }
  };

  // TIER 1 — select the option naming a semester we know the student is in.
  // True only when one actually matched.
  const selectKnownSemester = (select, names) => {
    if (!names.length) return false;
    for (let i = 1; i < select.options.length; i++) {
      const option = select.options[i];
      if (!option.value) continue;
      if (names.includes(normaliseSemester(option.innerText))) {
        select.selectedIndex = i;
        return true;
      }
    }
    return false;
  };

  /*
   * TIER 2 — newest already-started option that is not one of the variants
   * above. The tie-break is the SHORTEST name, which is what "Fall Semester
   * 2026-27" is next to every decorated form of itself; it only ever settles
   * ties the denylist did not already break.
   */
  const selectPlainSemester = (select) => {
    if (typeof parseSemesterStart !== "function") return false;
    const now = Date.now();
    let best = -1;
    let bestStart = null;
    let bestLength = Infinity;
    for (let i = 1; i < select.options.length; i++) {
      const option = select.options[i];
      const text = String(option.innerText || "").trim();
      if (!option.value || !text) continue;
      if (DECOY_SEMESTER.test(text)) continue;
      const start = parseSemesterStart(text);
      if (!start || start.getTime() > now) continue; // future / registration-only
      const length = normaliseSemester(text).length;
      const newer = !bestStart || start.getTime() > bestStart.getTime();
      const shorter = bestStart && start.getTime() === bestStart.getTime() && length < bestLength;
      if (newer || shorter) {
        best = i;
        bestStart = start;
        bestLength = length;
      }
    }
    if (best < 0) return false;
    select.selectedIndex = best;
    return true;
  };

  /*
   * `name`     which page this is, for the guard above
   * `loaded()` true when the page's own data is on screen — a second opinion
   *            behind the placeholder rule, never the only guard
   * `submit()` how THIS page asks VTOP to load (change event, or a button)
   * `waitMs`   how long to wait for the picker to be rendered at all
   */
  // Where did the last attempt stop? Written to an attribute on <html> so it
  // can be read from the page without DevTools ("data-vr-auto"), because
  // "the picker was never answered" has several causes and no log line.
  const trace = (name, stage) => {
    try {
      const el = document.documentElement;
      const prev = (el.getAttribute("data-vr-auto") || "").split(" > ").slice(-8);
      prev.push(name + ":" + stage);
      el.setAttribute("data-vr-auto", prev.join(" > "));
    } catch (e) {
      /* diagnostics only */
    }
  };

  window.vrAutoSemester = async ({ name, loaded, submit, waitMs = 0 }) => {
    trace(name, "start");
    // `waitMs` is only ever non-zero on the page-open route, where the message
    // legitimately beats the DOM (see the 2026-08-20 note). A direct call with
    // no picker on screen is not a semester-gated page and returns at once.
    let select = waitMs > 0 ? await waitForSelect(waitMs) : semesterSelect();
    if (!select) {
      trace(name, "no-picker");
      return false; // not a semester-gated page (or never rendered)
    }

    // Page-open route only: the picker (or table) in hand may still belong to
    // the page just left. Look for its replacement before trusting it.
    if (
      waitMs > 0 &&
      (select.selectedIndex > 0 || (typeof loaded === "function" && loaded()))
    ) {
      const fresh = await waitForNewSelect(select, STALE_GRACE_MS);
      if (fresh) {
        trace(name, "stale-replaced");
        select = fresh;
      }
    }

    // THE RULE: an answered picker is somebody's answer — VTOP's, the
    // student's, or ours from a moment ago. Never overwrite one.
    if (select.selectedIndex > 0) {
      trace(name, "already-answered");
      tried.delete(name); // it was answered — the next visit starts clean
      return false;
    }
    if (typeof loaded === "function" && loaded()) {
      trace(name, "already-loaded");
      tried.delete(name);
      return false;
    }

    // the SAME picker element twice is a re-fired message, not a revisit
    if (tried.get(name) === select) {
      trace(name, "same-picker");
      return false;
    }
    tried.set(name, select);

    // What the student is REGISTERED in beats what the names parse to.
    const names = await knownSemesterNames();
    let picked = selectKnownSemester(select, names) || selectPlainSemester(select);
    if (!picked && typeof chooseCurrentSemester === "function") {
      chooseCurrentSemester();
      picked = select.selectedIndex > 0;
    }
    // nothing sensible to pick (placeholder still selected): leave the page as
    // it is rather than submitting an empty semester
    if (!picked || !select.value || select.selectedIndex <= 0) {
      trace(name, "nothing-to-pick");
      return false;
    }

    /*
     * One submit, and then it is VTOP's answer to give. If the semester has no
     * data yet — August, marks unpublished — an empty page IS the answer, and
     * the picker is left showing the semester the student is actually in.
     */
    trace(name, "submit:" + String(select.options[select.selectedIndex].innerText).trim().slice(0, 30));
    try {
      submit();
    } catch (error) {
      console.warn("vRevamp auto-semester:", name, error);
      return false;
    }
    return true;
  };

  /*
   * The four page shapes, in one place. Each is `loaded()` — is this page's own
   * data on screen? — plus which of the two submit shapes it needs.
   *
   * `loaded` is asked about CONTENT, never about the existence of a container:
   * every one of these pages renders its picker inside markup of its own, and
   * the Grades page shipped a predicate that asked for a div present on the
   * empty form, which is why it never ran (see the 2026-08-21 note).
   */
  const anyTableMatching = (re) =>
    Array.from(document.querySelectorAll("table")).some((t) => re.test(t.innerText || ""));

  const PAGES = {
    exam_schedule: {
      loaded: () => anyTableMatching(/exam\s*date|venue/i),
      submit: () => window.vrSemesterSearch(),
    },
    mark_view: {
      loaded: () => anyTableMatching(/course\s*code|course\s*title/i),
      submit: () => window.vrSemesterChange(),
    },
    /*
     * No `exam_grade` entry, on purpose — asked for 2026-08-21. The Grades
     * page shows a SINGLE semester, so choosing one for the student is
     * choosing which semester they wanted to look at; Grade History lists
     * every subject ever taken and carries the calculator, which is where
     * that question actually belongs. The service worker stops announcing
     * this page too, so nothing arrives here to ignore.
     */
    timetable_view: {
      // \b on `slot` deliberately: the picker's own markup says "Semester
      // Subject", and an unbounded /slot/ matches words this page is full of
      loaded: () => anyTableMatching(/theory|lab|\bslot\b/i),
      submit: () => window.vrSemesterChange(),
    },
    /*
     * Attendance had its own copy of all this in js/attendance.js — written
     * first, and the model the rest were built from — so it never received the
     * fixes they did. `attendanceHasData` stays where it is and is borrowed:
     * it is the sharper predicate (a just-registered semester lists every
     * course at 0/0, which is rows without data), and the page that owns it
     * should keep owning it.
     */
    /*
     * The DA page's own table is the course list — "Class Nbr / Course Code /
     * Course Title" — which is what appears once a semester is chosen, and
     * what the dues column is then written into. Asked for 2026-08-22, after
     * the reminders it feeds were verified working.
     */
    da_upload: {
      loaded: () => anyTableMatching(/class\s*nbr|course\s*code/i),
      submit: () => window.vrSemesterChange(),
    },
    attendance: {
      loaded: () =>
        typeof attendanceHasData === "function"
          ? attendanceHasData()
          : anyTableMatching(/attendance|total\s*class/i),
      submit: () => window.vrSemesterChange(),
    },
  };

  window.vrAutoSemesterFor = (name, overrides) => {
    const page = PAGES[name];
    if (!page) return Promise.resolve(false);
    return window.vrAutoSemester({ name, ...page, ...(overrides || {}) });
  };

  /*
   * The page-open message, which is the route that actually works. Sent by the
   * service worker for the page's OWN data-url, i.e. the moment the picker is
   * on its way, rather than for the data endpoint it POSTs afterwards.
   *
   * `waitMs` is what makes it usable: onCompleted fires on the response, and
   * VTOP writes it into the DOM after that.
   */
  chrome.runtime.onMessage.addListener((request) => {
    if (!request || request.message !== "semester_page_open") return;
    trace(request.page, "msg");
    window
      .vrAutoSemesterFor(request.page, { waitMs: SELECT_WAIT_MS })
      .catch((error) => console.warn("vRevamp auto-semester:", request.page, error));
  });

  // The two submit shapes, so callers do not each re-derive them.
  window.vrSemesterChange = () => {
    const select = semesterSelect();
    // VTOP's own inline onchange (doViewExamMark, processViewTimeTable, …)
    if (select) select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  /*
   * The Search button, found by text inside the content area only — the navbar
   * is full of buttons and VTOP gives this one no id and no inline onclick
   * (checked live 2026-08-19: `<button class="btn btn-primary btn-block">`).
   */
  window.vrSemesterSearch = () => {
    const main = document.querySelector("#main-section") || document.body;
    const button = Array.from(
      main.querySelectorAll("button, input[type=button], input[type=submit]")
    ).find((b) => /^\s*search\s*$/i.test(b.innerText || b.value || ""));
    if (button) button.click();
  };
})();
