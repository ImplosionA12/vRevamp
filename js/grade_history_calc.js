/*
 * Grade calculator on the Grade History page (Examination -> Grade History).
 *
 * The what-if simulator in js/cgpa_simulator.js covers the *Grades* page — the
 * current semester only — and deliberately stands down on Grade History
 * (see the early return there): that page has no "current semester" table to
 * simulate, so the simulator harvests its credits and leaves. The result was
 * that the one page listing EVERY subject the student has ever taken offered
 * no calculator at all. This fills that gap.
 *
 * What it does:
 *   - drops a grade <select> beside the grade already printed in each history
 *     row, so a subject is changed where it is read rather than in a separate
 *     panel that has to repeat the whole list;
 *   - recomputes the CGPA live from those changes.
 *
 * Baseline choice matters. The projected CGPA is folded into the CGPA the page
 * itself reports, not into a CGPA recomputed from the rows:
 *
 *     projected = (cgpa * creditsEarned + SUM(newPoints - oldPoints)) / creditsEarned
 *
 * VTOP excludes some rows from the official CGPA (audited, exempted and
 * re-registered courses, and grades outside S-F such as P/N), so a from-scratch
 * total rarely reproduces the number on screen — and a calculator whose
 * "current" value disagrees with the page is worse than none. Only the DELTA
 * from changed rows is trusted, which is exact regardless of which rows VTOP
 * counted. The from-scratch figure is used only when the page has no CGPA box.
 *
 * Repeated course codes are normal here (a re-registered subject appears once
 * per attempt), so overrides are keyed by semester + code + occurrence rather
 * than by code, and survive the SPA re-rendering the table.
 */
(() => {
  const GRADE_POINTS = { S: 10, A: 9, B: 8, C: 7, D: 6, E: 5, F: 0 };
  const GRADES = ["S", "A", "B", "C", "D", "E", "F"];
  const PANEL_ID = "vrevamp-gradehist-calc";
  const BODY_ID = "vrevamp-gradehist-body";
  const FITTED = "data-vrevamp-gh"; // marks a row that already has a select

  const txt = (el) => (el ? el.textContent : "").replace(/\s+/g, " ").trim();
  const num = (s) => {
    const m = /-?\d+(\.\d+)?/.exec(String(s));
    return m ? parseFloat(m[0]) : NaN;
  };
  const isCode = (s) => /^[A-Z]{2,4}\d{3,4}[A-Z]?$/.test(s.trim());
  const isGrade = (s) => /^[SABCDEF]$/.test(s.trim());
  // anything grade-shaped, including the off-scale awards (P, N, W, Ab)
  const isGradeToken = (s) => /^[A-Z][a-z]?[+-]?$/.test(s.trim());
  const isCredit = (s) => /^\d{1,2}\.\d+$/.test(s.trim()); // 4.0, 3.0 …
  const hasMonth = (s) => /\b[A-Z][a-z]{2}-\d{4}\b/.test(s);

  const rowsOf = (t) => Array.from(t.querySelectorAll("tr"));
  const cellTexts = (tr) => Array.from(tr.children).map(txt);

  // code -> hypothetical grade, keyed sem|code|occurrence so a re-registered
  // subject's two attempts stay independent
  const overrides = {};

  /* ---- page / table discovery -------------------------------------------- */

  // The history table is the one whose rows carry the exam month (Mon-YYYY).
  // Tested per cell, not on the row's joined text: adjacent cells concatenate
  // ("BJan-2026") and \b then fails to match.
  // Rows this table OWNS. querySelectorAll("tr") descends into nested tables,
  // and VTOP nests one inside the history table (the per-course expansion), so
  // an ownership test is what keeps a parent from claiming its child's rows.
  const ownRows = (t) => rowsOf(t).filter((r) => r.closest("table") === t);

  const monthRows = (t) => ownRows(t).filter((r) => cellTexts(r).some(hasMonth));

  const isHistoryTable = (t) => monthRows(t).length >= 2;

  // Simply the table owning the most exam-month rows. An earlier "prefer the
  // innermost table" rule looked equivalent and was not: it skipped any table
  // containing another qualifying table, which on the live page disqualified
  // the real 98-row history table because of the small nested one inside it,
  // and left a 7-row re-registration sub-table as the winner — 2 courses read
  // out of 98. Ownership makes the row counts honest, so "most rows" is
  // enough on its own and the nesting rule is gone.
  const findHistoryTable = () => {
    let best = null;
    let bestRows = 0;
    Array.from(document.querySelectorAll("table")).forEach((t) => {
      const n = monthRows(t).length;
      if (n >= 2 && n > bestRows) {
        bestRows = n;
        best = t;
      }
    });
    return best;
  };

  // Column positions from the header row where it can be read. Content
  // sniffing alone is not enough on this page: "Grade" and "Grade Point" are
  // both present in some layouts, and Sl.No. is as numeric as Credits.
  const columnsOf = (table) => {
    const cols = { code: -1, title: -1, credit: -1, grade: -1, sem: -1 };
    let bestHits = 0;
    ownRows(table).forEach((tr) => {
      const cells = cellTexts(tr).map((s) => s.toLowerCase());
      const find = (re) => cells.findIndex((c) => re.test(c));
      const guess = {
        code: find(/^course\s*code$/),
        title: find(/^course\s*title$/),
        // "grade point"/"grade points" is a different column and must not win
        credit: find(/^credits?$/),
        grade: cells.findIndex((c) => /^grade$/.test(c)),
        // the live VIT-AP page labels it "Exam Month"; other layouts say
        // "Exam Held" or "Semester"
        sem: find(/exam\s*(held|month)|semester/),
      };
      const hits = Object.values(guess).filter((i) => i >= 0).length;
      if (hits > bestHits) {
        bestHits = hits;
        Object.assign(cols, guess);
      }
    });
    return bestHits >= 2 ? cols : null;
  };

  /* ---- parsing ------------------------------------------------------------ */

  // Read one history row. Header-derived indexes are used only when the cell
  // they point at actually looks right, so a layout whose header we misread
  // still falls back to content sniffing instead of producing junk.
  const parseRow = (tr, cols) => {
    const texts = cellTexts(tr);
    if (!texts.some(hasMonth)) return null;

    // `typeof i === "number"` is load-bearing: callers pass `cols && cols.x`,
    // which is null when the header was unreadable — and `null >= 0` is true
    // in JS, so a bare range check would index the row with null and hand
    // undefined to the content test.
    const at = (i, test) =>
      typeof i === "number" && i >= 0 && i < texts.length &&
      (!test || test(texts[i]))
        ? i
        : -1;

    const codeI = at(cols && cols.code, isCode) >= 0
      ? cols.code
      : texts.findIndex(isCode);
    if (codeI < 0) return null;

    // Grade column. When the header named it, trust that position for any
    // grade-SHAPED token rather than only S-F: VIT-AP also awards P, N, W and
    // Ab, and requiring S-F here silently dropped those rows entirely — so a
    // course the student passed on a non-10-point scale vanished from a page
    // that is supposed to list every subject taken. They are parsed, shown,
    // and then excluded from the arithmetic by countable().
    let gradeI = at(cols && cols.grade, isGradeToken);
    if (gradeI < 0) {
      for (let i = texts.length - 1; i >= 0; i--) {
        if (i !== codeI && isGrade(texts[i])) {
          gradeI = i;
          break;
        }
      }
    }
    if (gradeI < 0) return null;

    let creditI = at(cols && cols.credit, (s) => !isNaN(num(s)));
    if (creditI < 0) creditI = texts.findIndex(isCredit);
    const credit = creditI >= 0 ? num(texts[creditI]) : NaN;

    const sem = texts.find(hasMonth) || "";
    const title =
      (cols && cols.title >= 0 && texts[cols.title]) ||
      texts.slice(codeI + 1).find((t) => t.length > 6 && !/^\d/.test(t)) ||
      "";

    return {
      sem: (/\b[A-Z][a-z]{2}-\d{4}\b/.exec(sem) || [sem])[0],
      code: texts[codeI],
      title: title.slice(0, 40),
      credit,
      grade: texts[gradeI],
      gradeCell: tr.children[gradeI],
      rowEl: tr,
    };
  };

  const parseCgpaDetails = () => {
    let result = { cgpa: NaN, creditsEarned: NaN };
    Array.from(document.querySelectorAll("table")).forEach((t) => {
      if (!/CGPA/i.test(t.textContent) || !/Credits Earned/i.test(t.textContent))
        return;
      const rows = rowsOf(t);
      if (rows.length < 2) return;
      const head = cellTexts(rows[0]).map((h) => h.toLowerCase());
      const vals = cellTexts(rows[1]);
      const at = (label) => {
        const i = head.findIndex((h) => h === label);
        return i >= 0 ? num(vals[i]) : NaN;
      };
      const cgpa = at("cgpa");
      if (!isNaN(cgpa)) result = { cgpa, creditsEarned: at("credits earned") };
    });
    return result;
  };

  /* ---- computation -------------------------------------------------------- */

  let courses = [];
  let details = { cgpa: NaN, creditsEarned: NaN };

  const keyOf = (c) => `${c.sem}|${c.code}|${c.n}`;
  const gradeOf = (c) => overrides[keyOf(c)] || c.grade;
  const countable = (c) => !isNaN(c.credit) && c.credit > 0 && c.grade in GRADE_POINTS;

  // Only rows the user actually changed contribute — see the header note on
  // why the untouched rows are never re-added up.
  const deltaPoints = () => {
    let d = 0;
    courses.forEach((c) => {
      if (!countable(c)) return;
      const g = gradeOf(c);
      if (g === c.grade || !(g in GRADE_POINTS)) return;
      d += (GRADE_POINTS[g] - GRADE_POINTS[c.grade]) * c.credit;
    });
    return d;
  };

  // Fallback baseline for a page with no CGPA box: every countable row.
  const fromScratch = () => {
    let pts = 0;
    let cr = 0;
    courses.forEach((c) => {
      if (!countable(c)) return;
      pts += GRADE_POINTS[c.grade] * c.credit;
      cr += c.credit;
    });
    return { pts, cr, cgpa: cr ? pts / cr : NaN };
  };

  const changedCount = () =>
    courses.filter((c) => gradeOf(c) !== c.grade).length;

  /* ---- rendering ---------------------------------------------------------- */

  const stat = (label, value, color) => {
    const p = document.createElement("p");
    p.style.cssText = "margin:4px 0;font-size:13px;";
    const b = document.createElement("b");
    b.textContent = value;
    if (color) b.style.color = color;
    p.appendChild(document.createTextNode(label + " "));
    p.appendChild(b);
    return p;
  };

  const fmtDelta = (d) => (d > 0 ? "+" : "") + d.toFixed(2);

  const gradeSelect = (c) => {
    const sel = document.createElement("select");
    sel.className = "vrevamp-gh-select";
    sel.style.cssText =
      "margin-left:6px;padding:1px 4px;font-size:12px;vertical-align:middle;";
    // A course VTOP did not grade S-F (P/N, audited, withdrawn) has no place
    // on a 10-point scale, so it keeps its printed grade as an inert option
    // rather than being silently coerced to something it never was.
    const opts = c.grade in GRADE_POINTS ? GRADES : [c.grade, ...GRADES];
    opts.forEach((g) => {
      const o = document.createElement("option");
      o.value = g;
      o.textContent = g;
      if (g === gradeOf(c)) o.selected = true;
      sel.appendChild(o);
    });
    if (!countable(c)) {
      sel.disabled = true;
      sel.title = isNaN(c.credit)
        ? "No credits listed for this row — it can't affect the CGPA."
        : "This grade isn't on the 10-point scale, so it can't affect the CGPA.";
    }
    sel.addEventListener("change", () => {
      if (sel.value === c.grade) delete overrides[keyOf(c)];
      else overrides[keyOf(c)] = sel.value;
      // the row's own tint, so a change is visible where it was made even when
      // the summary panel is scrolled off screen
      c.rowEl.style.background =
        sel.value === c.grade ? "" : "rgba(255,235,150,0.5)";
      renderBody();
    });
    return sel;
  };

  const fitSelects = () => {
    courses.forEach((c) => {
      if (!c.gradeCell || c.rowEl.hasAttribute(FITTED)) return;
      c.rowEl.setAttribute(FITTED, "1");
      c.gradeCell.appendChild(gradeSelect(c));
      if (gradeOf(c) !== c.grade)
        c.rowEl.style.background = "rgba(255,235,150,0.5)";
    });
  };

  const resetAll = () => {
    clearBar();
    Object.keys(overrides).forEach((k) => delete overrides[k]);
    courses.forEach((c) => {
      c.rowEl.style.background = "";
      const sel = c.rowEl.querySelector("select.vrevamp-gh-select");
      if (sel) sel.value = c.grade;
    });
    renderBody();
  };

  /*
   * The answer, pinned where the question is asked.
   *
   * The summary panel sits after the table — which on a real transcript means
   * 29 rows below the dropdown you just changed. So the projected CGPA was
   * rendered correctly and then scrolled off screen, and the feature looked
   * like it did nothing: "where is the CGPA change visible? it's not."
   *
   * This is a fixed bar, so it stays put while you work down the table. It
   * exists only while something is actually changed — no changes, no bar, no
   * clutter over VTOP's own UI.
   *
   * z-index 999 is deliberate: BELOW jQuery BlockUI's 1000 overlay, so the bar
   * cannot draw on top of VTOP's own modals or its open sidebar. That was the
   * mistake an earlier z-index:1100 made on the exam buttons.
   *
   * …which is exactly why it then had to move UP. Reported 2026-08-21 ("i cant
   * see the changed gpa"), and measured on the live page: VTOP's support chat
   * bubble is a fixed 62x62 div at right:25px, bottom:25px with **z-index
   * 1000**. The bar was at right:18px, bottom:18px — the same corner, one
   * layer below — so the projected CGPA rendered correctly and was painted
   * over every time. Raising the bar above 1000 would re-make the modal bug
   * this comment already warns about, so the bar clears the bubble instead:
   * 62px of bubble + 25px of its own inset + a gap.
   */
  const BAR_BOTTOM_PX = 100;
  const BAR_ID = "vrevamp-gh-bar";

  const clearBar = () => {
    const old = document.getElementById(BAR_ID);
    if (old) old.remove();
  };

  const renderBar = ({ base, proj, delta, changed }) => {
    let bar = document.getElementById(BAR_ID);
    if (!bar) {
      bar = document.createElement("div");
      bar.id = BAR_ID;
      bar.style.cssText =
        `position:fixed;right:18px;bottom:${BAR_BOTTOM_PX}px;z-index:999;` +
        "display:flex;align-items:center;gap:14px;" +
        "padding:10px 14px;border-radius:10px;" +
        "background:#1f2d3d;color:#fff;font-size:13px;line-height:1.35;" +
        "box-shadow:0 6px 20px rgba(0,0,0,0.28);max-width:92vw;";
      document.body.appendChild(bar);
    }
    bar.textContent = "";

    const up = delta > 0;
    const flat = !delta || Math.abs(delta) < 0.005;
    const tint = flat ? "#cfd8e3" : up ? "#7ee2a8" : "#ff9b9b";

    const num = document.createElement("div");
    num.style.cssText = "display:flex;align-items:baseline;gap:8px;";
    const from = document.createElement("span");
    from.style.cssText = "opacity:0.65;";
    from.textContent = isNaN(base) ? "—" : base.toFixed(2);
    const arrow = document.createElement("span");
    arrow.style.cssText = "opacity:0.65;";
    arrow.textContent = "→";
    const to = document.createElement("strong");
    to.style.cssText = `font-size:19px;color:${tint};`;
    to.textContent = isNaN(proj) ? "—" : proj.toFixed(2);
    const d = document.createElement("span");
    d.style.cssText = `color:${tint};font-weight:600;`;
    d.textContent = isNaN(delta) ? "" : flat ? "no change" : fmtDelta(delta);
    num.append(from, arrow, to, d);

    const sub = document.createElement("div");
    sub.style.cssText = "opacity:0.7;font-size:11px;";
    sub.textContent = `projected CGPA · ${changed} grade${changed === 1 ? "" : "s"} changed`;

    const left = document.createElement("div");
    left.append(num, sub);

    // delegated: this bar is rebuilt on every keystroke of the table, and a
    // per-element handler on a re-created node is the bug this repo keeps
    // relearning (js/shared/click.js)
    const reset = window.vrButton("gh-reset", "↺ reset", {});
    reset.className = "";
    reset.style.cssText =
      "cursor:pointer;padding:5px 10px;border:1px solid rgba(255,255,255,0.35);" +
      "border-radius:6px;background:transparent;color:#fff;font-size:12px;";

    bar.append(left, reset);
  };

  const renderBody = () => {
    const body = document.getElementById(BODY_ID);
    if (!body) return;
    body.textContent = "";

    if (!courses.length) {
      body.appendChild(
        stat("Couldn't read any graded rows on this page.", "", "#c0392b")
      );
      return;
    }

    const scratch = fromScratch();
    const usingPage = !isNaN(details.cgpa) && !isNaN(details.creditsEarned) &&
      details.creditsEarned > 0;
    const baseCgpa = usingPage ? details.cgpa : scratch.cgpa;
    const baseCredits = usingPage ? details.creditsEarned : scratch.cr;

    body.appendChild(
      stat("Current CGPA:", isNaN(baseCgpa) ? "—" : baseCgpa.toFixed(2))
    );

    const changed = changedCount();
    if (!changed) {
      clearBar();
      const p = document.createElement("p");
      p.style.cssText = "margin:6px 0;color:#666;font-size:12px;";
      p.textContent =
        "Change any grade in the table above to see what it does to your CGPA — " +
        "the new CGPA appears in the corner of the screen as you go. " +
        `${courses.filter(countable).length} of ${courses.length} rows count towards the CGPA.`;
      body.appendChild(p);
      return;
    }

    const proj = isNaN(baseCgpa)
      ? NaN
      : (baseCgpa * baseCredits + deltaPoints()) / baseCredits;
    const delta = proj - baseCgpa;
    const colour = delta > 0 ? "#2e7d32" : delta < 0 ? "#c0392b" : "#333";

    renderBar({ base: baseCgpa, proj, delta, changed });

    body.appendChild(
      stat("Projected CGPA:", isNaN(proj) ? "—" : proj.toFixed(2), colour)
    );
    body.appendChild(
      stat("Change:", isNaN(delta) ? "—" : fmtDelta(delta), colour)
    );

    const note = document.createElement("p");
    note.style.cssText = "margin:6px 0;color:#999;font-size:12px;";
    note.textContent = usingPage
      ? `${changed} grade(s) changed, applied to the ${baseCredits} credits earned behind your real ${baseCgpa.toFixed(2)} CGPA.`
      : `${changed} grade(s) changed. No CGPA box on this page, so this is computed from the ${baseCredits} credits listed above and may differ from VTOP's official CGPA.`;
    body.appendChild(note);

    const reset = document.createElement("button");
    reset.type = "button"; // never submit the enclosing VTOP form
    reset.textContent = "↺ Reset changes";
    reset.style.cssText =
      "cursor:pointer;margin-top:8px;padding:4px 10px;border:1px solid #aaa;" +
      "border-radius:3px;background:#f4f4f4;font-size:12px;";
    reset.addEventListener("click", resetAll);
    body.appendChild(reset);
  };

  const buildPanel = () => {
    const table = findHistoryTable();
    if (!table) return;

    const cols = columnsOf(table);
    const seen = {};
    /*
     * Parse into a LOCAL and commit only on success.
     *
     * This used to assign straight into `courses` and then bail out when the
     * parse came back empty — which left the module holding an empty course
     * list while the panel and all 29 grade dropdowns stayed on screen. The
     * next grade the student changed was then computed against nothing:
     * "Couldn't read any graded rows on this page", no projected CGPA, no bar,
     * and the row still tinted yellow as though it had registered.
     *
     * Reproduced live 2026-08-22 on the real transcript — select moved B → A,
     * row highlighted, panel replaced by the error. This page carries TWENTY
     * tables and VTOP re-renders them, so a rebuild that momentarily parses
     * nothing is normal; it must not be able to poison a working panel.
     *
     * Keeping the last good parse is right rather than merely safer: the rows
     * on screen are the rows the student is editing, and a transient failure
     * to re-read them changes nothing about what they mean.
     */
    const parsed = ownRows(table)
      .map((tr) => parseRow(tr, cols))
      .filter(Boolean)
      .map((c) => {
        const k = `${c.sem}|${c.code}`;
        seen[k] = (seen[k] || 0) + 1;
        return { ...c, n: seen[k] };
      });
    if (!parsed.length) return; // keep whatever was already working
    courses = parsed;

    details = parseCgpaDetails();
    fitSelects();

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      panel.style.cssText =
        "margin:16px;padding:12px 16px;background:#fff;border:1px solid #ccc;" +
        "border-left:4px solid rgb(60,141,188);border-radius:4px;";

      const title = document.createElement("p");
      title.textContent = "VTOP Extension — grade calculator";
      title.style.cssText =
        "font-weight:bold;margin:0 0 4px 0;font-size:15px;color:rgb(60,141,188);";
      panel.appendChild(title);

      const bodyWrap = document.createElement("div");
      bodyWrap.id = BODY_ID;
      panel.appendChild(bodyWrap);

      (table.closest(".row") || table).insertAdjacentElement("afterend", panel);
    }
    renderBody();
  };

  /* ---- triggers ----------------------------------------------------------- */

  // Debounced, and short-circuited on an unchanged signature. An unguarded
  // observer on a VTOP page is what froze the timetable page (commit 8055f0e):
  // buildPanel() walks every table and row, and the SPA mutates the DOM
  // constantly, so it must not re-run on every quiet tick.
  let timer = null;
  let lastSig = "";
  const scheduleBuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // cheap gate: no panel and no "Grade" text anywhere means this is not a
      // grade page, so skip the table walk below (the observer sees the whole
      // session, and most VTOP pages have no grades on them)
      if (
        !document.getElementById(PANEL_ID) &&
        !(document.body && (document.body.textContent || "").includes("Grade"))
      )
        return;
      const t = findHistoryTable();
      const sig =
        (t ? rowsOf(t).length : 0) +
        ":" +
        document.querySelectorAll("table").length +
        ":" +
        (document.getElementById(PANEL_ID) ? 1 : 0);
      dropIfOrphaned();
      if (sig === lastSig) return;
      lastSig = sig;
      try {
        buildPanel();
      } catch (error) {
        console.warn("vRevamp grade calculator:", error);
      }
    }, 400);
  };

  window.vrDelegate("gh-reset", () => resetAll());

  /*
   * Neither the bar nor the PANEL is attached to the table they describe — the
   * bar is fixed to the viewport, the panel is inserted near the table but
   * survives VTOP replacing it. So when VTOP navigates away and the transcript
   * is gone, nothing removed either of them.
   *
   * The bar half was handled from the start. The panel half was not, and it is
   * the one the student actually hits — reported 2026-08-22, "the grade history
   * is not we did o can't see the change or updated cgpa". Read live: they were
   * on the HOME page, zero tables in the document, and the calculator was
   * still sitting there reading "Current CGPA: 7.73 — change any grade in the
   * table above". There was no table above. Nothing to change, so of course
   * nothing ever updated.
   *
   * Worse than useless: a panel quoting a real CGPA on a page with no grades
   * looks like a broken calculator rather than a stale one.
   */
  const dropIfOrphaned = () => {
    if (findHistoryTable()) return;
    clearBar();
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
  };

  chrome.runtime.onMessage.addListener((request) => {
    if (
      request.message === "exam_grade" ||
      request.message === "nav_bar_change" ||
      request.message === "grade_history"
    ) {
      dropIfOrphaned();
      scheduleBuild();
    }
  });

  const observer = new MutationObserver(scheduleBuild);
  const startObserving = () => {
    if (document.body)
      observer.observe(document.body, { childList: true, subtree: true });
    else setTimeout(startObserving, 300);
  };
  startObserving();
  scheduleBuild();
})();
