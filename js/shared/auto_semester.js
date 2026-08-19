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
 * 2. **The wrong semester.** chooseCurrentSemester() picks by parsing the
 *    option names, and "Fall Semester 2026-27 Freshers" parses identically to
 *    "Fall Semester 2026-27" — a tie the sort resolves by document order, so
 *    the Freshers list can win for a student who is not one. Verified on the
 *    live dropdown: both exist, and only the second holds this student's
 *    exams. So a pick that renders nothing steps down semesterFallbackOrder()
 *    a few times, exactly as the attendance page does.
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
   * `name`     which page this is, for the once-only guard
   * `loaded()` true when the page's own data is on screen
   * `submit()` how THIS page asks VTOP to load (change event, or a button)
   * `settleMs` how long to let VTOP answer before judging the result
   */
  window.vrAutoSemester = ({ name, loaded, submit, settleMs = 1200, maxTries = 3 }) => {
    const select = semesterSelect();
    if (!select) return false; // not a semester-gated page (or not rendered yet)
    if (loaded()) return false; // already showing data — never touch it
    if (attempted.has(name)) return false;
    attempted.add(name);

    if (typeof chooseCurrentSemester === "function") chooseCurrentSemester();
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
