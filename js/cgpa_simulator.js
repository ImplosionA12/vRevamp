/*
 * CGPA what-if simulator on the grade-view page. Reads the graded courses
 * already on the page (credits + grade), then lets the student change any
 * grade, add hypothetical/registered courses, and optionally fold in a prior
 * CGPA + credits to see a live projected semester GPA and cumulative CGPA.
 * Pure client-side; nothing is fetched or saved.
 */
(() => {
  const GRADE_POINTS = { S: 10, A: 9, B: 8, C: 7, D: 6, E: 5, F: 0 };
  const GRADES = ["S", "A", "B", "C", "D", "E", "F"];
  const PANEL_ID = "vrevamp-cgpa-sim";

  const num = (s) => parseFloat(String(s).replace(/[^0-9.]+/g, ""));

  // The same columns grade_pages.js reads: credits = td[4], grade = td[9].
  const parseCourses = () => {
    const rows = Array.from(
      document.querySelectorAll("#studentGradeView table tbody tr")
    );
    const courses = [];
    rows.forEach((tr) => {
      const tds = tr.getElementsByTagName("td");
      if (tds.length < 10) return; // skips header and the appended GPA row
      const credits = num(tds[4].innerHTML);
      const grade = (tds[9].textContent || "").replace(/[^A-Z]+/g, "");
      if (isNaN(credits) || credits <= 0 || !(grade in GRADE_POINTS)) return;
      const title =
        (tds[2] && tds[2].textContent.trim()) ||
        (tds[3] && tds[3].textContent.trim()) ||
        "Course";
      courses.push({ title: title.slice(0, 40), credits, grade, editable: false });
    });
    return courses;
  };

  let entries = [];

  const tally = () => {
    let points = 0;
    let credits = 0;
    entries.forEach((e) => {
      const c = parseFloat(e.credits) || 0;
      if (c <= 0) return;
      points += GRADE_POINTS[e.grade] * c;
      credits += c;
    });
    return { points, credits, gpa: credits ? points / credits : null };
  };

  const recompute = () => {
    const { points, credits, gpa } = tally();
    const gpaEl = document.getElementById("vrevamp-sim-gpa");
    if (gpaEl)
      gpaEl.textContent =
        gpa != null ? `${gpa.toFixed(2)} over ${credits} credit(s)` : "—";

    const priorCgpa = parseFloat(
      (document.getElementById("vrevamp-sim-prior-cgpa") || {}).value
    );
    const priorCr = parseFloat(
      (document.getElementById("vrevamp-sim-prior-cr") || {}).value
    );
    const cgpaEl = document.getElementById("vrevamp-sim-cgpa");
    if (!cgpaEl) return;
    if (!isNaN(priorCgpa) && !isNaN(priorCr) && priorCr + credits > 0) {
      const cgpa = (priorCgpa * priorCr + points) / (priorCr + credits);
      cgpaEl.textContent = `${cgpa.toFixed(2)} over ${priorCr + credits} credit(s)`;
    } else {
      cgpaEl.textContent = "enter prior CGPA & credits earned";
    }
  };

  const gradeSelect = (value, onChange) => {
    const sel = document.createElement("select");
    sel.style.cssText = "padding:2px 6px;";
    GRADES.forEach((g) => {
      const o = document.createElement("option");
      o.value = g;
      o.textContent = g;
      if (g === value) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  };

  const CELL = "border:1px solid #ccc;padding:4px 8px;";

  const buildRows = (tbody) => {
    tbody.textContent = "";
    entries.forEach((e, idx) => {
      const tr = document.createElement("tr");

      const tdName = document.createElement("td");
      tdName.style.cssText = CELL;
      if (e.editable) {
        const inp = document.createElement("input");
        inp.value = e.title;
        inp.style.cssText = "width:140px;";
        inp.addEventListener("input", () => (e.title = inp.value));
        tdName.appendChild(inp);
      } else {
        tdName.textContent = e.title;
      }
      tr.appendChild(tdName);

      const tdCr = document.createElement("td");
      tdCr.style.cssText = CELL + "text-align:center;";
      if (e.editable) {
        const inp = document.createElement("input");
        inp.type = "number";
        inp.min = "0";
        inp.step = "1";
        inp.value = e.credits;
        inp.style.cssText = "width:50px;text-align:center;";
        inp.addEventListener("input", () => {
          e.credits = inp.value;
          recompute();
        });
        tdCr.appendChild(inp);
      } else {
        tdCr.textContent = e.credits;
      }
      tr.appendChild(tdCr);

      const tdGrade = document.createElement("td");
      tdGrade.style.cssText = CELL + "text-align:center;";
      tdGrade.appendChild(
        gradeSelect(e.grade, (v) => {
          e.grade = v;
          recompute();
        })
      );
      tr.appendChild(tdGrade);

      const tdDel = document.createElement("td");
      tdDel.style.cssText = CELL + "text-align:center;";
      if (e.editable) {
        const btn = document.createElement("button");
        btn.textContent = "✕";
        btn.title = "Remove";
        btn.style.cssText = "cursor:pointer;border:0;background:none;color:#c0392b;";
        btn.addEventListener("click", () => {
          entries.splice(idx, 1);
          buildRows(tbody);
          recompute();
        });
        tdDel.appendChild(btn);
      }
      tr.appendChild(tdDel);

      tbody.appendChild(tr);
    });
  };

  const buildPanel = () => {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

    const anchor = document.querySelector("#studentGradeView");
    if (!anchor) return;

    entries = parseCourses();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText =
      "margin:16px;padding:12px 16px;background:#fff;border:1px solid #ccc;" +
      "border-left:4px solid rgb(60,141,188);border-radius:4px;font-size:13px;";

    const title = document.createElement("p");
    title.textContent = "vRevamp — CGPA what-if simulator";
    title.style.cssText =
      "font-weight:bold;margin:0 0 8px 0;font-size:14px;color:rgb(60,141,188);";
    panel.appendChild(title);

    const hint = document.createElement("p");
    hint.textContent =
      "Change any grade, or add courses you're registered for, to see your " +
      "projected GPA. Enter your current CGPA and total credits earned to " +
      "project your cumulative CGPA.";
    hint.style.cssText = "margin:0 0 8px 0;color:#666;";
    panel.appendChild(hint);

    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;margin-bottom:8px;";
    const thead = document.createElement("tr");
    ["Course", "Credits", "Grade", ""].forEach((h) => {
      const th = document.createElement("th");
      th.textContent = h;
      th.style.cssText = CELL + "background:rgb(60,141,188,0.8);color:#fff;";
      thead.appendChild(th);
    });
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    panel.appendChild(table);
    buildRows(tbody);

    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Add a course";
    addBtn.style.cssText =
      "cursor:pointer;padding:4px 10px;margin-bottom:10px;border:1px solid #aaa;" +
      "border-radius:3px;background:#f4f4f4;";
    addBtn.addEventListener("click", () => {
      entries.push({ title: "New course", credits: 3, grade: "S", editable: true });
      buildRows(tbody);
      recompute();
    });
    panel.appendChild(addBtn);

    const priorWrap = document.createElement("div");
    priorWrap.style.cssText = "margin:6px 0;";
    const mkInput = (id, ph, w) => {
      const i = document.createElement("input");
      i.id = id;
      i.type = "number";
      i.min = "0";
      i.placeholder = ph;
      i.style.cssText = `width:${w}px;margin-right:8px;padding:3px 6px;`;
      i.addEventListener("input", recompute);
      return i;
    };
    priorWrap.appendChild(mkInput("vrevamp-sim-prior-cgpa", "Prior CGPA", 90));
    priorWrap.appendChild(mkInput("vrevamp-sim-prior-cr", "Credits earned", 110));
    panel.appendChild(priorWrap);

    const result = (label, id) => {
      const p = document.createElement("p");
      p.style.cssText = "margin:4px 0;font-weight:bold;";
      const span = document.createElement("span");
      span.id = id;
      p.appendChild(document.createTextNode(label + " "));
      p.appendChild(span);
      return p;
    };
    panel.appendChild(result("Projected semester GPA:", "vrevamp-sim-gpa"));
    panel.appendChild(result("Projected CGPA:", "vrevamp-sim-cgpa"));

    anchor.insertAdjacentElement("afterend", panel);
    recompute();
  };

  chrome.runtime.onMessage.addListener((request) => {
    if (request.message === "exam_grade") {
      // let grade_pages.js finish appending its GPA row first
      setTimeout(() => {
        try {
          buildPanel();
        } catch (error) {
          console.warn("vRevamp CGPA simulator:", error);
        }
      }, 300);
    }
  });
})();
