/*
 * CGPA / GPA what-if simulator on the grade-view page.
 *
 * The grade-view page holds three things we join by course code:
 *   1. the current-semester grade table — course code, scored mark and awarded
 *      grade, plus a "+" that expands a per-subject "Range of Grades" table
 *      (VIT-AP grades relatively, so every subject has its own cutoffs);
 *   2. the grade-history table — the only place credits live (4.0/3.0/…), its
 *      rows carry a Mon-YYYY token;
 *   3. the "CGPA Details" box — current CGPA and total credits earned.
 *
 * Modes:
 *   GPA  — fixed credits, editable grades, live projected semester GPA, and
 *          (for any expanded course) marks short of the next grade.
 *   CGPA — folds the change into the real CGPA read from the page, with the
 *          difference.
 *
 * Robustness: VTOP shuffles columns between layouts and the SPA may not always
 * fire the grade message, so the table is found by scanning all tables for
 * grade-shaped rows, the build is driven by a DOM observer (not just the
 * message), and the panel always renders with a "copy debug info" button so a
 * mis-detection still yields the exact structure to fix.
 */
(() => {
  const GRADE_POINTS = { S: 10, A: 9, B: 8, C: 7, D: 6, E: 5, F: 0 };
  const GRADES = ["S", "A", "B", "C", "D", "E", "F"];
  const PANEL_ID = "vrevamp-cgpa-sim";

  const txt = (el) => (el ? el.textContent : "").replace(/\s+/g, " ").trim();
  const num = (s) => {
    const m = /-?\d+(\.\d+)?/.exec(String(s));
    return m ? parseFloat(m[0]) : NaN;
  };
  const isCode = (s) => /^[A-Z]{2,4}\d{3,4}[A-Z]?$/.test(s.trim());
  const isGrade = (s) => /^[SABCDEF]$/.test(s.trim());
  const isCredit = (s) => /^\d{1,2}\.\d+$/.test(s.trim()); // 4.0, 3.0 …
  const isMark = (s) => /^\d{1,3}(\.\d+)?$/.test(s.trim()) && +num(s) >= 0 && +num(s) <= 100;
  const hasMonth = (s) => /\b[A-Z][a-z]{2}-\d{4}\b/.test(s);

  const overrides = {}; // code -> hypothetical grade, survives rebuilds
  const customCourses = []; // user-added hypothetical courses, survive rebuilds
  let manualPriorCgpa = null; // string; null = fall back to auto-read value
  let manualPriorCr = null;
  let mode = "gpa";

  // ---- table discovery -----------------------------------------------------

  const rowsOf = (t) => Array.from(t.querySelectorAll("tr"));
  const cellTexts = (tr) => Array.from(tr.children).map(txt);

  const isHistoryTable = (t) =>
    rowsOf(t).filter((r) => hasMonth(txt(r))).length >= 2;

  // the current-semester grade table = most "code + grade" rows, excluding the
  // history table (which also has codes/grades but carries Mon-YYYY)
  const findGradeTable = () => {
    let best = null;
    let bestScore = 0;
    Array.from(document.querySelectorAll("table")).forEach((t) => {
      if (isHistoryTable(t)) return;
      let score = 0;
      rowsOf(t).forEach((tr) => {
        const c = cellTexts(tr);
        if (c.some(isCode) && c.some(isGrade)) score++;
      });
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    });
    return bestScore >= 1 ? best : null;
  };

  // ---- parsing -------------------------------------------------------------

  const parseCurrentSem = (table) => {
    const out = [];
    rowsOf(table).forEach((tr) => {
      const texts = cellTexts(tr);
      const codeI = texts.findIndex(isCode);
      const gradeI = texts.findIndex(isGrade);
      if (codeI < 0 || gradeI < 0) return;
      let markI = gradeI - 1;
      if (!(markI > codeI && isMark(texts[markI])))
        markI = texts.findIndex((t, i) => i > codeI && i !== gradeI && isMark(t));
      const title =
        texts.slice(codeI + 1).find((t) => t.length > 6 && !/^\d/.test(t)) || "";
      out.push({
        code: texts[codeI],
        title: title.slice(0, 40),
        mark: markI >= 0 ? num(texts[markI]) : NaN,
        grade: texts[gradeI],
        rowEl: tr,
      });
    });
    const seen = new Set();
    return out.filter((c) => !seen.has(c.code) && seen.add(c.code));
  };

  const parseCredits = () => {
    const map = {};
    Array.from(document.querySelectorAll("table tr")).forEach((tr) => {
      const texts = cellTexts(tr);
      if (!texts.some(hasMonth)) return;
      const code = texts.find(isCode);
      const credit = texts.find(isCredit);
      if (code && credit && !(code in map)) map[code] = num(credit);
    });
    return map;
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

  const parseRanges = (list) => {
    Array.from(document.querySelectorAll("table"))
      .filter((t) => /Range of Grades/i.test(t.textContent))
      .forEach((t) => {
        let cutoffs = null;
        rowsOf(t).forEach((tr) => {
          const vals = cellTexts(tr).filter((s) => /[<>]=?\s*\d/.test(s));
          if (vals.length >= 5) {
            cutoffs = {};
            GRADES.forEach((g, i) => {
              cutoffs[g] =
                vals[i] !== undefined ? num(vals[i].replace(/<\d.*/, "")) : NaN;
            });
          }
        });
        if (!cutoffs) return;
        let owner = null;
        list.forEach((c) => {
          if (
            c.rowEl &&
            c.rowEl.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING
          )
            owner = c;
        });
        if (owner && !owner.cutoffs) owner.cutoffs = cutoffs;
      });
  };

  // ---- computation ---------------------------------------------------------

  let courses = [];
  let credits = {};
  let details = { cgpa: NaN, creditsEarned: NaN };

  const gradeOf = (c) => (c.custom ? c.grade : overrides[c.code] || c.grade);
  // custom courses keep credits as the raw typed string (parsed lazily) so a
  // mid-edit empty/partial field doesn't get coerced back to "0" on rebuild
  const creditOf = (c) => (c.custom ? num(c.creditStr) : credits[c.code]);

  // "current" totals reflect the real transcript only; hypothetical added
  // courses only ever show up in the projected ("useOverrides") totals
  const semTotals = (useOverrides) => {
    let pts = 0;
    let cr = 0;
    courses.forEach((c) => {
      const credit = creditOf(c);
      const g = useOverrides ? gradeOf(c) : c.grade;
      if (!credit || !(g in GRADE_POINTS)) return;
      pts += GRADE_POINTS[g] * credit;
      cr += credit;
    });
    if (useOverrides) {
      customCourses.forEach((c) => {
        const credit = creditOf(c);
        const g = c.grade;
        if (!credit || isNaN(credit) || !(g in GRADE_POINTS)) return;
        pts += GRADE_POINTS[g] * credit;
        cr += credit;
      });
    }
    return { pts, cr, gpa: cr ? pts / cr : NaN };
  };

  const marksToNext = (c) => {
    if (!c.cutoffs || isNaN(c.mark)) return null;
    const idx = GRADES.indexOf(gradeOf(c));
    if (idx <= 0) return { top: true };
    const need = c.cutoffs[GRADES[idx - 1]];
    if (isNaN(need)) return null;
    return { nextGrade: GRADES[idx - 1], gap: Math.max(0, +(need - c.mark).toFixed(1)) };
  };

  // ---- rendering -----------------------------------------------------------

  const CELL = "border:1px solid #ccc;padding:4px 8px;";
  const HEAD = CELL + "background:rgba(60,141,188,0.85);color:#fff;font-weight:bold;";

  const cell = (content, extra) => {
    const td = document.createElement("td");
    td.style.cssText = CELL + (extra || "");
    if (content instanceof Node) td.appendChild(content);
    else td.textContent = content;
    return td;
  };

  const gradeSelect = (c) => {
    const sel = document.createElement("select");
    sel.style.cssText = "padding:2px 6px;";
    GRADES.forEach((g) => {
      const o = document.createElement("option");
      o.value = g;
      o.textContent = g;
      if (g === gradeOf(c)) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => {
      if (c.custom) c.grade = sel.value;
      else if (sel.value === c.grade) delete overrides[c.code];
      else overrides[c.code] = sel.value;
      renderBody();
    });
    return sel;
  };

  const stat = (label, value, color, id) => {
    const p = document.createElement("p");
    p.style.cssText = "margin:4px 0;font-size:13px;";
    const b = document.createElement("b");
    if (id) b.id = id;
    b.textContent = value;
    if (color) b.style.color = color;
    p.appendChild(document.createTextNode(label + " "));
    p.appendChild(b);
    return p;
  };

  const courseTable = () => {
    const wrap = document.createElement("div");
    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;margin:8px 0;font-size:13px;";
    const thead = document.createElement("thead");
    const head = document.createElement("tr");
    ["Course", "Credits", "Mark", "Grade", "→ Next grade", ""].forEach((h) => {
      const th = document.createElement("th");
      th.textContent = h;
      th.style.cssText = HEAD;
      head.appendChild(th);
    });
    thead.appendChild(head);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    courses.forEach((c) => {
      const credit = creditOf(c);
      const tr = document.createElement("tr");
      if (c.code in overrides) tr.style.background = "rgba(255,235,150,0.5)";
      tr.appendChild(cell(`${c.code} ${c.title}`.trim()));
      tr.appendChild(
        cell(credit != null ? String(credit) : "—", "text-align:center;color:#777;")
      );
      tr.appendChild(cell(isNaN(c.mark) ? "—" : String(c.mark), "text-align:center;"));
      tr.appendChild(cell(gradeSelect(c), "text-align:center;"));
      const mtn = marksToNext(c);
      let nextText = "—";
      if (mtn && mtn.top) nextText = "top grade ✓";
      else if (mtn)
        nextText =
          mtn.gap === 0 ? `at ${mtn.nextGrade} cutoff` : `${mtn.gap} mark(s) → ${mtn.nextGrade}`;
      else if (!isNaN(c.mark)) nextText = "expand course ↑";
      tr.appendChild(cell(nextText, "text-align:center;color:#555;font-size:12px;"));
      tr.appendChild(cell(""));
      tbody.appendChild(tr);
    });

    customCourses.forEach((c, idx) => {
      const tr = document.createElement("tr");
      tr.style.background = "rgba(200,230,255,0.4)";

      const titleInp = document.createElement("input");
      titleInp.id = `vrevamp-custom-title-${idx}`;
      titleInp.value = c.title;
      titleInp.style.cssText = "width:130px;padding:2px 4px;";
      titleInp.addEventListener("input", () => {
        c.title = titleInp.value;
      });
      tr.appendChild(cell(titleInp));

      const crInp = document.createElement("input");
      crInp.id = `vrevamp-custom-credit-${idx}`;
      // type="text" + inputmode, not type="number": renderBody() rebuilds this
      // input on every keystroke, and a number input's .value collapses to ""
      // on an in-progress invalid value (e.g. a trailing "."), silently
      // reverting mid-typing — a plain text field just keeps what was typed
      crInp.type = "text";
      crInp.inputMode = "decimal";
      crInp.value = c.creditStr;
      crInp.style.cssText = "width:50px;text-align:center;";
      crInp.addEventListener("input", () => {
        // store the raw text, not a coerced number — coercing here (e.g. via
        // `|| 0`) would echo "0" back into the field the moment it's cleared,
        // stomping whatever the user is about to type next
        c.creditStr = crInp.value;
        renderBody();
      });
      tr.appendChild(cell(crInp, "text-align:center;"));

      tr.appendChild(cell("—", "text-align:center;color:#999;"));
      tr.appendChild(cell(gradeSelect(c), "text-align:center;"));
      tr.appendChild(cell("—", "text-align:center;color:#999;font-size:12px;"));

      const rm = document.createElement("button");
      rm.textContent = "✕";
      rm.title = "Remove";
      rm.style.cssText = "cursor:pointer;border:0;background:none;color:#c0392b;";
      rm.addEventListener("click", () => {
        const i = customCourses.indexOf(c);
        if (i >= 0) customCourses.splice(i, 1);
        renderBody();
      });
      tr.appendChild(cell(rm, "text-align:center;"));

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);

    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Add a course";
    addBtn.style.cssText =
      "cursor:pointer;padding:4px 10px;margin:2px 0 4px;border:1px solid #aaa;" +
      "border-radius:3px;background:#f4f4f4;font-size:12px;";
    addBtn.addEventListener("click", () => {
      customCourses.push({ title: "New course", creditStr: "3", grade: "S", custom: true, mark: NaN, cutoffs: null });
      renderBody();
    });
    wrap.appendChild(addBtn);

    return wrap;
  };

  const fmtDelta = (d) => (d > 0 ? "+" : "") + d.toFixed(2);

  const renderBody = () => {
    const body = document.getElementById("vrevamp-sim-body");
    if (!body) return;
    // rebuilding the DOM on every keystroke would otherwise steal focus from
    // whatever input the user is typing in — restore it after re-rendering
    const active = document.activeElement;
    const activeId = active && active.id;
    const selStart = active && "selectionStart" in active ? active.selectionStart : null;

    body.textContent = "";

    if (!courses.length && !customCourses.length) {
      const p = document.createElement("p");
      p.style.cssText = "margin:6px 0;color:#c0392b;font-size:13px;";
      p.textContent =
        "Couldn't read the grade table on this page yet. If you're on the Grade View page, click \"Copy debug info\" below and paste it to the developer.";
      body.appendChild(p);
      return;
    }

    const tabs = document.createElement("div");
    tabs.style.cssText = "margin-bottom:8px;";
    [["gpa", "Semester GPA"], ["cgpa", "Cumulative CGPA"]].forEach(([m, label]) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      const active = mode === m;
      btn.style.cssText =
        "cursor:pointer;padding:5px 12px;margin-right:6px;border:1px solid #aaa;" +
        "border-radius:3px;font-size:13px;" +
        (active
          ? "background:rgb(60,141,188);color:#fff;border-color:rgb(60,141,188);"
          : "background:#f4f4f4;color:#333;");
      btn.addEventListener("click", () => {
        mode = m;
        renderBody();
      });
      tabs.appendChild(btn);
    });
    body.appendChild(tabs);
    body.appendChild(courseTable());

    const orig = semTotals(false);
    const proj = semTotals(true);

    if (mode === "gpa") {
      body.appendChild(
        stat(
          "Current semester GPA:",
          isNaN(orig.gpa) ? "—" : `${orig.gpa.toFixed(2)} over ${orig.cr} credit(s)`
        )
      );
      const delta = proj.gpa - orig.gpa;
      body.appendChild(
        stat(
          "Projected semester GPA:",
          isNaN(proj.gpa) ? "—" : `${proj.gpa.toFixed(2)} over ${proj.cr} credit(s)`,
          delta > 0 ? "#2e7d32" : delta < 0 ? "#c0392b" : "#333",
          "vrevamp-sim-gpa"
        )
      );
      if (!isNaN(delta) && delta !== 0)
        body.appendChild(stat("Change:", fmtDelta(delta), delta > 0 ? "#2e7d32" : "#c0392b"));
      if (courses.some((c) => creditOf(c) == null)) {
        const w = document.createElement("p");
        w.style.cssText = "margin:6px 0;color:#999;font-size:12px;";
        w.textContent =
          "Some courses have no credits on this page — open the Grade History view once so credits load.";
        body.appendChild(w);
      }
    } else {
      // prefer the CGPA/credits read straight off the page; fall back to
      // (and let the user override with) manual entry when that fails
      const autoCgpa = details.cgpa;
      const autoCr = details.creditsEarned;
      if (!isNaN(autoCgpa) && !isNaN(autoCr) && manualPriorCgpa === null && manualPriorCr === null) {
        const note = document.createElement("p");
        note.style.cssText = "margin:4px 0;color:#999;font-size:12px;";
        note.textContent = `Auto-read from this page: ${autoCgpa.toFixed(2)} CGPA over ${autoCr} credit(s). Edit below if it's wrong.`;
        body.appendChild(note);
      }

      const cgpaStr = manualPriorCgpa !== null ? manualPriorCgpa : !isNaN(autoCgpa) ? String(autoCgpa) : "";
      const crStr = manualPriorCr !== null ? manualPriorCr : !isNaN(autoCr) ? String(autoCr) : "";

      const priorWrap = document.createElement("div");
      priorWrap.style.cssText = "margin:6px 0;";
      const mkPrior = (id, value, ph, width, onInput) => {
        const i = document.createElement("input");
        i.id = id;
        // see the crInp comment above: text+inputmode avoids a number input's
        // .value silently reverting to "" while a decimal is mid-typing
        i.type = "text";
        i.inputMode = "decimal";
        i.placeholder = ph;
        i.value = value;
        i.style.cssText = `width:${width}px;margin-right:8px;padding:3px 6px;`;
        i.addEventListener("input", () => {
          onInput(i.value);
          renderBody();
        });
        return i;
      };
      priorWrap.appendChild(
        mkPrior("vrevamp-sim-prior-cgpa", cgpaStr, "Prior CGPA", 90, (v) => (manualPriorCgpa = v))
      );
      priorWrap.appendChild(
        mkPrior("vrevamp-sim-prior-cr", crStr, "Credits earned", 110, (v) => (manualPriorCr = v))
      );
      body.appendChild(priorWrap);

      const priorCgpa = num(cgpaStr);
      const priorCr = num(crStr);
      if (!isNaN(priorCgpa) && !isNaN(priorCr) && priorCr + proj.cr > 0) {
        const totalCr = priorCr + proj.cr;
        const projCgpa = (priorCgpa * priorCr + proj.pts) / totalCr;
        const delta = projCgpa - priorCgpa;
        body.appendChild(
          stat(
            "Projected CGPA:",
            `${projCgpa.toFixed(2)} over ${totalCr} credit(s)`,
            delta > 0 ? "#2e7d32" : delta < 0 ? "#c0392b" : "#333",
            "vrevamp-sim-cgpa"
          )
        );
        body.appendChild(
          stat("Change:", isNaN(delta) ? "—" : fmtDelta(delta), delta > 0 ? "#2e7d32" : delta < 0 ? "#c0392b" : "#333")
        );
      } else {
        body.appendChild(stat("Projected CGPA:", "enter prior CGPA & credits earned", "#c0392b", "vrevamp-sim-cgpa"));
      }
    }

    if (Object.keys(overrides).length || customCourses.length) {
      const reset = document.createElement("button");
      reset.textContent = "↺ Reset changes";
      reset.style.cssText =
        "cursor:pointer;margin-top:8px;padding:4px 10px;border:1px solid #aaa;" +
        "border-radius:3px;background:#f4f4f4;font-size:12px;";
      reset.addEventListener("click", () => {
        Object.keys(overrides).forEach((k) => delete overrides[k]);
        customCourses.length = 0;
        renderBody();
      });
      body.appendChild(reset);
    }

    if (activeId) {
      const el = document.getElementById(activeId);
      if (el) {
        el.focus();
        if (selStart != null && "setSelectionRange" in el) {
          try {
            el.setSelectionRange(selStart, selStart);
          } catch (e) {
            /* not all input types support selection ranges */
          }
        }
      }
    }
  };

  // one-click structure dump so a mis-detection is debuggable without DevTools
  const debugInfo = () => {
    const lines = [];
    lines.push(`courses found: ${courses.length}`);
    lines.push(`credits map: ${JSON.stringify(credits)}`);
    lines.push(`cgpa details: ${JSON.stringify(details)}`);
    const gt = findGradeTable();
    lines.push("--- grade table (first 4 rows) ---");
    if (gt)
      rowsOf(gt)
        .slice(0, 4)
        .forEach((r, ri) =>
          lines.push(
            `R${ri}: ` +
              cellTexts(r).map((t, i) => `${i}=[${t.slice(0, 26)}]`).join(" ")
          )
        );
    else lines.push("NONE");
    lines.push("--- tables with Credits/Mon-YYYY (first 3 rows each) ---");
    Array.from(document.querySelectorAll("table"))
      .filter((t) => isHistoryTable(t) || /CGPA/i.test(t.textContent))
      .slice(0, 3)
      .forEach((t, ti) => {
        lines.push(`T${ti}:`);
        rowsOf(t)
          .slice(0, 3)
          .forEach((r, ri) =>
            lines.push(
              ` R${ri}: ` +
                cellTexts(r).map((c, i) => `${i}=[${c.slice(0, 22)}]`).join(" ")
            )
          );
      });
    return lines.join("\n");
  };

  const buildPanel = () => {
    const gradeTable = findGradeTable();
    const detailsBox = document.querySelector("table") &&
      Array.from(document.querySelectorAll("table")).find((t) => /CGPA/i.test(t.textContent));
    // only act on the grade page: needs either a grade table or the CGPA box
    if (!gradeTable && !detailsBox) return;

    courses = gradeTable ? parseCurrentSem(gradeTable) : [];
    credits = parseCredits();
    details = parseCgpaDetails();
    if (courses.length) parseRanges(courses);

    const anchor =
      gradeTable.closest("#studentGradeView") ||
      gradeTable.closest(".row") ||
      gradeTable;

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      panel.style.cssText =
        "margin:16px;padding:12px 16px;background:#fff;border:1px solid #ccc;" +
        "border-left:4px solid rgb(60,141,188);border-radius:4px;";

      const title = document.createElement("p");
      title.textContent = "vRevamp — what-if simulator";
      title.style.cssText =
        "font-weight:bold;margin:0 0 4px 0;font-size:15px;color:rgb(60,141,188);";
      panel.appendChild(title);

      const hint = document.createElement("p");
      hint.style.cssText = "margin:0 0 6px 0;color:#666;font-size:12px;";
      hint.textContent =
        "Change any grade to see your projected GPA / CGPA — credits come from your grade history, no guessing. Expand a course (the + button) to see marks short of the next grade.";
      panel.appendChild(hint);

      const bodyWrap = document.createElement("div");
      bodyWrap.id = "vrevamp-sim-body";
      panel.appendChild(bodyWrap);

      const dbgBar = document.createElement("div");
      dbgBar.style.cssText = "margin-top:8px;";
      const dbg = document.createElement("button");
      dbg.textContent = "Copy debug info";
      dbg.style.cssText =
        "cursor:pointer;padding:3px 9px;border:1px solid #bbb;border-radius:3px;" +
        "background:#fafafa;color:#666;font-size:11px;";
      const dbgMsg = document.createElement("span");
      dbgMsg.style.cssText = "margin-left:8px;color:#2e7d32;font-size:11px;";
      dbg.addEventListener("click", async () => {
        const text = debugInfo();
        try {
          await navigator.clipboard.writeText(text);
          dbgMsg.textContent = "copied ✔ — paste it to the developer";
        } catch (e) {
          console.log("[vRevamp what-if debug]\n" + text);
          dbgMsg.textContent = "see console (F12) and copy from there";
        }
      });
      dbgBar.appendChild(dbg);
      dbgBar.appendChild(dbgMsg);
      panel.appendChild(dbgBar);

      anchor.insertAdjacentElement("afterend", panel);
    }
    renderBody();
  };

  // ---- triggers ------------------------------------------------------------

  let timer = null;
  let lastSig = "";
  const scheduleBuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // skip rebuilds when nothing relevant changed (observer can be chatty)
      const gt = findGradeTable();
      const sig =
        (gt ? rowsOf(gt).length : 0) +
        ":" +
        document.querySelectorAll("table").length +
        ":" +
        (document.getElementById(PANEL_ID) ? 1 : 0);
      if (sig === lastSig && document.getElementById(PANEL_ID)) return;
      lastSig = sig;
      try {
        buildPanel();
      } catch (error) {
        console.warn("vRevamp what-if simulator:", error);
      }
    }, 400);
  };

  chrome.runtime.onMessage.addListener((request) => {
    if (request.message === "exam_grade" || request.message === "nav_bar_change")
      scheduleBuild();
  });

  // the SPA swaps the grade table in without always firing our message, so
  // watch the DOM and (re)build whenever tables appear or expand
  const observer = new MutationObserver(scheduleBuild);
  const startObserving = () => {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    else setTimeout(startObserving, 300);
  };
  startObserving();
  scheduleBuild();
})();
