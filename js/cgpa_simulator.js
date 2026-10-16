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
 *
 * Credits/CGPA live on the separate Grade History page (Examination → Grade
 * History), NOT on the Grades page. They're cached in chrome.storage.local
 * whenever that page is open, and fetched silently from
 * examinations/examGradeView/StudentGradeHistory when the cache can't cover
 * the courses on screen.
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
  let mode = "gpa";

  // credits + CGPA cached from the Grade History page / silent fetch
  const STORE_CREDITS = "vrevamp_grade_credits";
  const STORE_DETAILS = "vrevamp_cgpa_details";
  let cachedCredits = {};
  let cachedDetails = null;
  let historyFetch = "idle"; // idle | pending | done | failed

  // ---- table discovery -----------------------------------------------------

  const rowsOf = (t) => Array.from(t.querySelectorAll("tr"));
  const cellTexts = (tr) => Array.from(tr.children).map(txt);

  // per-cell, not whole-row text: \b fails when cells concatenate ("BJan-2026")
  const isHistoryTable = (t) =>
    rowsOf(t).filter((r) => cellTexts(r).some(hasMonth)).length >= 2;

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
      // the "+" button carries the course id the detail endpoint needs
      const dm = /getGradeViewDetails\('([^']+)'\)/.exec(tr.outerHTML || "");
      out.push({
        code: texts[codeI],
        title: title.slice(0, 40),
        mark: markI >= 0 ? num(texts[markI]) : NaN,
        grade: texts[gradeI],
        rowEl: tr,
        detailId: dm ? dm[1] : null,
      });
    });
    const seen = new Set();
    return out.filter((c) => !seen.has(c.code) && seen.add(c.code));
  };

  const parseCredits = (root = document) => {
    const map = {};
    Array.from(root.querySelectorAll("table tr")).forEach((tr) => {
      const texts = cellTexts(tr);
      if (!texts.some(hasMonth)) return;
      const code = texts.find(isCode);
      const credit = texts.find(isCredit);
      if (code && credit && !(code in map)) map[code] = num(credit);
    });
    return map;
  };

  const parseCgpaDetails = (root = document) => {
    let result = { cgpa: NaN, creditsEarned: NaN };
    Array.from(root.querySelectorAll("table")).forEach((t) => {
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

  const cutoffsFromTable = (t) => {
    let cutoffs = null;
    rowsOf(t).forEach((tr) => {
      const vals = cellTexts(tr).filter((s) => /[<>≥≤]=?\s*\d/.test(s));
      if (vals.length >= 5) {
        cutoffs = {};
        GRADES.forEach((g, i) => {
          cutoffs[g] =
            vals[i] !== undefined ? num(vals[i].replace(/<\d.*/, "")) : NaN;
        });
      }
    });
    return cutoffs;
  };

  const parseRanges = (list) => {
    Array.from(document.querySelectorAll("table"))
      .filter((t) => /Range of Grades/i.test(t.textContent))
      .forEach((t) => {
        const cutoffs = cutoffsFromTable(t);
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

  // ---- silent per-course cutoff fetch ---------------------------------------
  // The "Range of Grades" only exists inside the "+" expansion; instead of
  // making the user expand every course, fetch the same fragment the "+"
  // button does (examinations/examGradeView/getGradeViewDetails) for any
  // course still missing cutoffs, and rebuild when they land.
  const cutoffCache = {}; // detailId -> cutoffs
  const cutoffAttempted = new Set();
  let cutoffFetchRunning = false;

  const fetchMissingCutoffs = (list) => {
    if (cutoffFetchRunning) return;
    const csrf = document.querySelector('input[name="_csrf"]');
    const auth = document.getElementById("authorizedIDX");
    const semEl = document.querySelector("#semesterSubId");
    if (!csrf || !auth || !semEl || !semEl.value) return;
    const todo = list.filter(
      (c) => !c.cutoffs && c.detailId && !cutoffAttempted.has(c.detailId)
    );
    if (!todo.length) return;
    cutoffFetchRunning = true;
    (async () => {
      let landed = false;
      for (const c of todo) {
        cutoffAttempted.add(c.detailId);
        try {
          const body = new URLSearchParams({
            _csrf: csrf.value,
            authorizedID: auth.value,
            x: new Date().toUTCString(),
            semesterSubId: semEl.value,
            courseId: c.detailId,
          });
          const res = await fetch(
            location.origin + "/vtop/examinations/examGradeView/getGradeViewDetails",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
              },
              body: body.toString(),
              credentials: "same-origin",
            }
          );
          if (!res.ok) continue;
          const doc = new DOMParser().parseFromString(await res.text(), "text/html");
          let cutoffs = null;
          Array.from(doc.querySelectorAll("table"))
            .filter((t) => /Range of Grades/i.test(t.textContent))
            .forEach((t) => {
              cutoffs = cutoffs || cutoffsFromTable(t);
            });
          if (cutoffs) {
            cutoffCache[c.detailId] = cutoffs;
            landed = true;
          }
          await new Promise((r) => setTimeout(r, 200));
        } catch (e) {
          /* stays on the expand-course hint */
        }
      }
      cutoffFetchRunning = false;
      if (landed) {
        lastSig = ""; // force a rebuild with the fetched cutoffs
        scheduleBuild();
      }
    })();
  };

  // ---- credits/CGPA cache + silent grade-history fetch ---------------------

  const persistCache = () => {
    try {
      chrome.storage.local.set({
        [STORE_CREDITS]: cachedCredits,
        [STORE_DETAILS]: cachedDetails,
      });
    } catch (e) {
      /* extension context gone — nothing to do */
    }
  };

  const absorb = (creditMap, det) => {
    let grew = false;
    Object.keys(creditMap).forEach((k) => {
      if (cachedCredits[k] !== creditMap[k]) {
        cachedCredits[k] = creditMap[k];
        grew = true;
      }
    });
    if (det && !isNaN(det.cgpa)) {
      if (!cachedDetails || cachedDetails.cgpa !== det.cgpa) grew = true;
      cachedDetails = det;
    }
    if (grew) persistCache();
    return grew;
  };

  // the Grades page carries no credits/CGPA at all — pull the Grade History
  // fragment the same way the SPA does and harvest it
  const fetchHistory = () => {
    if (historyFetch !== "idle") return;
    const csrf = document.querySelector('input[name="_csrf"]');
    const auth = document.getElementById("authorizedIDX");
    if (!csrf || !auth) {
      historyFetch = "failed";
      return;
    }
    historyFetch = "pending";
    const body =
      "verifyMenu=true&authorizedID=" +
      encodeURIComponent(auth.value) +
      "&_csrf=" +
      encodeURIComponent(csrf.value) +
      "&nocache=" +
      Date.now();
    fetch(location.origin + "/vtop/examinations/examGradeView/StudentGradeHistory", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
      .then((html) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        historyFetch = "done";
        if (absorb(parseCredits(doc), parseCgpaDetails(doc))) {
          lastSig = ""; // force a rebuild with the new data
          scheduleBuild();
        }
      })
      .catch((e) => {
        historyFetch = "failed";
        console.warn("vRevamp what-if simulator: grade-history fetch failed", e);
      });
  };

  // ---- computation ---------------------------------------------------------

  let courses = [];
  let credits = {};
  let details = { cgpa: NaN, creditsEarned: NaN };

  const gradeOf = (c) => overrides[c.code] || c.grade;
  const creditOf = (c) => credits[c.code];

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
    return { pts, cr, gpa: cr ? pts / cr : NaN };
  };

  const marksToNext = (c) => {
    if (!c.cutoffs || isNaN(c.mark)) return null;
    const idx = GRADES.indexOf(gradeOf(c));
    if (idx < 0) return null; // P/N/unknown grade — no "next grade" notion
    if (idx === 0) return { top: true };
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
      if (sel.value === c.grade) delete overrides[c.code];
      else overrides[c.code] = sel.value;
      renderBody();
    });
    return sel;
  };

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

  const courseTable = () => {
    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;margin:8px 0;font-size:13px;";
    const head = document.createElement("tr");
    ["Course", "Credits", "Mark", "Grade", "→ Next grade"].forEach((h) => {
      const th = document.createElement("th");
      th.textContent = h;
      th.style.cssText = HEAD;
      head.appendChild(th);
    });
    table.appendChild(head);

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
      else if (!isNaN(c.mark))
        nextText =
          c.detailId && !cutoffAttempted.has(c.detailId)
            ? "fetching…"
            : "expand course ↑";
      tr.appendChild(cell(nextText, "text-align:center;color:#555;font-size:12px;"));
      table.appendChild(tr);
    });
    return table;
  };

  const fmtDelta = (d) => (d > 0 ? "+" : "") + d.toFixed(2);

  const renderBody = () => {
    const body = document.getElementById("vrevamp-sim-body");
    if (!body) return;
    body.textContent = "";

    if (!courses.length) {
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
      btn.type = "button"; // never submit the enclosing VTOP form
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
        stat("Current semester GPA:", isNaN(orig.gpa) ? "—" : orig.gpa.toFixed(2))
      );
      const delta = proj.gpa - orig.gpa;
      body.appendChild(
        stat(
          "Projected semester GPA:",
          isNaN(proj.gpa) ? "—" : proj.gpa.toFixed(2),
          delta > 0 ? "#2e7d32" : delta < 0 ? "#c0392b" : "#333"
        )
      );
      if (!isNaN(delta) && delta !== 0)
        body.appendChild(stat("Change:", fmtDelta(delta), delta > 0 ? "#2e7d32" : "#c0392b"));
      if (courses.some((c) => creditOf(c) == null)) {
        const w = document.createElement("p");
        w.style.cssText = "margin:6px 0;color:#999;font-size:12px;";
        w.textContent =
          historyFetch === "pending" || historyFetch === "idle"
            ? "Loading credits from your grade history…"
            : "Couldn't load credits for some courses — open Examination → Grade History once and come back.";
        body.appendChild(w);
      }
    } else {
      const { cgpa, creditsEarned } = details;
      if (isNaN(cgpa) || isNaN(creditsEarned)) {
        body.appendChild(
          stat(
            "CGPA:",
            historyFetch === "pending" || historyFetch === "idle"
              ? "loading from your grade history…"
              : "couldn't load — open Examination → Grade History once and come back.",
            "#c0392b"
          )
        );
      } else {
        const projCgpa = (cgpa * creditsEarned - orig.pts + proj.pts) / creditsEarned;
        const delta = projCgpa - cgpa;
        body.appendChild(stat("Current CGPA:", cgpa.toFixed(2)));
        body.appendChild(
          stat("Projected CGPA:", projCgpa.toFixed(2), delta > 0 ? "#2e7d32" : delta < 0 ? "#c0392b" : "#333")
        );
        body.appendChild(
          stat("Change:", isNaN(delta) ? "—" : fmtDelta(delta), delta > 0 ? "#2e7d32" : delta < 0 ? "#c0392b" : "#333")
        );
        const note = document.createElement("p");
        note.style.cssText = "margin:6px 0;color:#999;font-size:12px;";
        note.textContent = `Based on ${creditsEarned} credits earned at ${cgpa.toFixed(2)} CGPA. Assumes credits earned stay the same.`;
        body.appendChild(note);
      }
    }

    if (Object.keys(overrides).length) {
      const reset = document.createElement("button");
      reset.type = "button"; // never submit the enclosing VTOP form
      reset.textContent = "↺ Reset changes";
      reset.style.cssText =
        "cursor:pointer;margin-top:8px;padding:4px 10px;border:1px solid #aaa;" +
        "border-radius:3px;background:#f4f4f4;font-size:12px;";
      reset.addEventListener("click", () => {
        Object.keys(overrides).forEach((k) => delete overrides[k]);
        renderBody();
      });
      body.appendChild(reset);
    }
  };

  // one-click structure dump so a mis-detection is debuggable without DevTools
  const debugInfo = () => {
    const lines = [];
    lines.push(`courses found: ${courses.length}`);
    lines.push(`credits map: ${JSON.stringify(credits)}`);
    lines.push(`cgpa details: ${JSON.stringify(details)}`);
    lines.push(`history fetch: ${historyFetch}, cached credits: ${Object.keys(cachedCredits).length}`);
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
    // only act on the grade pages: needs either a grade table or the CGPA box
    if (!gradeTable && !detailsBox) return;

    // harvest whatever this page offers (the Grade History page carries both)
    const pageCredits = parseCredits();
    const pageDetails = parseCgpaDetails();
    absorb(pageCredits, pageDetails);

    // on the Grade History page itself there is nothing to simulate — cache
    // its credits/CGPA for the Grades page and stay out of the way
    if (!gradeTable && Object.keys(pageCredits).length) return;

    courses = gradeTable ? parseCurrentSem(gradeTable) : [];
    credits = { ...cachedCredits, ...pageCredits };
    details = !isNaN(pageDetails.cgpa) ? pageDetails : cachedDetails || pageDetails;
    if (courses.length) {
      parseRanges(courses);
      courses.forEach((c) => {
        if (!c.cutoffs && c.detailId && cutoffCache[c.detailId])
          c.cutoffs = cutoffCache[c.detailId];
      });
      fetchMissingCutoffs(courses);
    }

    // credits/CGPA still missing for what's on screen -> pull grade history
    if (
      courses.length &&
      (courses.some((c) => credits[c.code] == null) || isNaN(details.cgpa))
    )
      fetchHistory();

    const anchorFor = (el) =>
      el && (el.closest("#studentGradeView") || el.closest(".row") || el);
    const anchor = anchorFor(gradeTable) || anchorFor(detailsBox);

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
        "Change any grade to see your projected GPA / CGPA — credits come from your grade history, and per-course grade cutoffs are fetched automatically for the marks-to-next-grade column.";
      panel.appendChild(hint);

      const bodyWrap = document.createElement("div");
      bodyWrap.id = "vrevamp-sim-body";
      panel.appendChild(bodyWrap);

      const dbgBar = document.createElement("div");
      dbgBar.style.cssText = "margin-top:8px;";
      const dbg = document.createElement("button");
      dbg.type = "button"; // never submit the enclosing VTOP form
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
      // cheap gate: no panel and no "Grade"/"CGPA" text anywhere means this is not a
      // grade page, so skip the table walk below (the observer sees the whole
      // session, and most VTOP pages have no grades on them)
      if (
        !document.getElementById(PANEL_ID) &&
        !(document.body && /Grade|CGPA/.test(document.body.textContent || ""))
      )
        return;
      // skip rebuilds when nothing relevant changed (observer can be chatty)
      const gt = findGradeTable();
      const sig =
        (gt ? rowsOf(gt).length : 0) +
        ":" +
        document.querySelectorAll("table").length +
        ":" +
        (document.getElementById(PANEL_ID) ? 1 : 0);
      // `&& document.getElementById(PANEL_ID)` used to be part of this
      // condition, which made the short-circuit unreachable on every page
      // that has no panel — i.e. all of VTOP except the grade pages. The
      // observer watches document.body/subtree for the whole session, so
      // buildPanel() (findGradeTable + parseCredits + parseCgpaDetails, each
      // a walk over every table and row on the page) re-ran on every quiet
      // tick forever. The panel's presence is already the third field of
      // `sig`, so losing it to a re-render still forces a rebuild.
      if (sig === lastSig) return;
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

  // last session's harvest, so credits show instantly on the Grades page
  try {
    chrome.storage.local.get([STORE_CREDITS, STORE_DETAILS], (r) => {
      cachedCredits = { ...(r[STORE_CREDITS] || {}), ...cachedCredits };
      if (!cachedDetails && r[STORE_DETAILS]) cachedDetails = r[STORE_DETAILS];
      lastSig = "";
      scheduleBuild();
    });
  } catch (e) {
    /* no storage (shouldn't happen in the extension) */
  }
  scheduleBuild();
})();
