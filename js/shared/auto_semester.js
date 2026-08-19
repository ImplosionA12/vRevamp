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
 * That third step is why the venue watcher in js/exam_schedule.js so rarely
 * ran — three manual actions stood in front of it.
 *
 * ---------------------------------------------------------------------------
 * THE TWO WAYS THIS COULD GO WRONG, AND WHAT STOPS THEM
 * ---------------------------------------------------------------------------
 * 1. **A load loop.** These hooks fire on a message that arrives after every
 *    one of VTOP's AJAX renders. A semester that legitimately has no rows
 *    (registration just opened) would re-trigger on its own response, forever,
 *    POSTing as fast as VTOP answers — which is precisely the repeated-failure
 *    state session_repair had to be built for. So the guard is a module-scoped
 *    Set: it survives VTOP's innerHTML re-renders, because a content script's
 *    world does, and it resets only on a real navigation. A dataset flag would
 *    NOT do — VTOP replaces the <select> along with everything else, taking
 *    the flag with it (the same durability trap js/shared/click.js documents).
 *
 * 2. **The wrong semester — and why the attendance page never has this
 *    problem.** The two dropdowns are not the same list at all. Read live,
 *    signed in, 2026-08-19:
 *
 *      Attendance     8 options, only the student's OWN registered semesters,
 *                     labelled "Fall Semester 2026-27 - AMR". Index 1 is
 *                     already correct, which is why that page just works.
 *      Exam Schedule  60+ options, every semester VIT-AP runs, including
 *                     "Fall Semester 2026-27 Freshers" — which is what
 *                     chooseCurrentSemester() lands on, since it parses
 *                     identically to "Fall Semester 2026-27" and a tie goes
 *                     to document order. A second-year student is not in it.
 *
 *    Stepping down the fallback list gets there eventually, but it is a
 *    workaround for not knowing which semester the student is in — and vRevamp
 *    already knows: `vrevamp_attendance_summary.semester` (and the exam cache)
 *    record the name off a registration-scoped dropdown. So match the cached
 *    name against the options FIRST, and fall back to parsing only when there
 *    is no cache to go on. Nothing in the attendance code is touched; a value
 *    it already writes is read.
 *
 * Never re-triggers when the page already has data on screen: the first thing
 * asked is `loaded()`, and a page that is showing something is left alone.
 */
(() => {
  if (typeof window.vrAutoSemester === "function") return;

  // one attempt per page per real navigation — see (1) above
  const attempted = new Set();

  const semesterSelect = () => document.getElementById("semesterSubId");

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

  // Select the option naming a semester we know the student is in. True only
  // when one actually matched.
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
   * `name`     which page this is, for the once-only guard
   * `loaded()` true when the page's own data is on screen
   * `submit()` how THIS page asks VTOP to load (change event, or a button)
   * `settleMs` how long to let VTOP answer before judging the result
   */
  window.vrAutoSemester = async ({ name, loaded, submit, settleMs = 1200, maxTries = 3 }) => {
    const select = semesterSelect();
    if (!select) return false; // not a semester-gated page (or not rendered yet)
    if (loaded()) return false; // already showing data — never touch it
    if (attempted.has(name)) return false;
    attempted.add(name);

    // What the student is REGISTERED in beats what the names parse to — see
    // (2). Falls back to parsing only when nothing is cached yet.
    const matched = selectKnownSemester(select, await knownSemesterNames());
    if (!matched && typeof chooseCurrentSemester === "function") chooseCurrentSemester();
    // nothing sensible to pick (placeholder still selected): leave the page as
    // it is rather than submitting an empty semester
    if (!select.value || select.selectedIndex <= 0) return false;

    const queue = (
      typeof semesterFallbackOrder === "function" ? semesterFallbackOrder() : []
    )
      .filter((i) => i !== select.selectedIndex)
      .slice(0, maxTries);

    const step = () => {
      try {
        submit();
      } catch (error) {
        console.warn("vRevamp auto-semester:", name, error);
        return;
      }
      setTimeout(() => {
        if (loaded()) return; // done
        const again = semesterSelect();
        if (!again || queue.length === 0) return; // out of candidates: give up quietly
        again.selectedIndex = queue.shift();
        step();
      }, settleMs);
    };
    step();
    return true;
  };

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
