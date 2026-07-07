let view_attendance_page = () => {
  const table_line = document.querySelector(".table-responsive");
  const table = table_line && table_line.querySelector("table");
  if (!table) return;
  const headRow = table.querySelector("thead tr") || table.rows[0];
  if (!headRow) return;

  // Locate columns by header text instead of hardcoded offsets, so VTOP
  // markup changes don't silently produce NaN
  const headers = Array.from(headRow.cells).map((c) =>
    c.innerText.trim().toLowerCase()
  );
  const colOf = (label) => headers.findIndex((h) => h.includes(label));
  const attendedCol = colOf("attended");
  const totalCol = colOf("total");
  const courseCol = colOf("course");
  if (attendedCol === -1 || totalCol === -1) return;

  //Working of the calculator
  if (!document.getElementById("vrevamp-attendance-note")) {
    const note = document.createElement("p");
    note.id = "vrevamp-attendance-note";
    note.style.color = "red";
    note.textContent =
      "*Note: This calculator doesn't calculate the attendance till the end of the sem, It only calculates the attendance to the 75% debar limit";
    table_line.insertAdjacentElement("beforebegin", note);
  }

  //Footer legend
  if (!document.getElementById("vrevamp-attendance-legend")) {
    let color_detail = document.createElement("div");
    color_detail.id = "vrevamp-attendance-legend";
    color_detail.innerHTML = `
    <p style='color:RGB(34 144 62);'>*Green: comfortable buffer above 75%</p>
    <p style='color:rgb(238, 75, 43); margin-top:-10px'>*Red: at or near the 75% limit &mdash; attend, don't skip</p>
    `;
    table_line.insertAdjacentElement("afterend", color_detail);
  }

  //Head edit
  if (!document.getElementById("vrevamp-alert-head")) {
    const th = document.createElement("th");
    th.id = "vrevamp-alert-head";
    th.textContent = "75% Attendance Alert";
    th.style.cssText =
      "vertical-align: middle; text-align: center; border-right: 1px solid #b2b2b2; padding: 5px;";
    headRow.appendChild(th);
  }

  //Body Edit
  table.querySelectorAll("tbody tr").forEach((row) => {
    if (row.querySelector(".vrevamp-bunk-cell")) return;
    const cells = row.cells;
    if (!cells || cells.length <= Math.max(attendedCol, totalCol)) return;
    const attended_classes = parseFloat(cells[attendedCol].innerText);
    const tot_classes = parseFloat(cells[totalCol].innerText);
    if (isNaN(attended_classes) || isNaN(tot_classes) || tot_classes === 0)
      return;
    const is_lab =
      courseCol !== -1 && /\blab\b/i.test(cells[courseCol].innerText);
    const unit = is_lab ? "lab(s)" : "class(es)";

    const td = document.createElement("td");
    td.className = "vrevamp-bunk-cell";
    td.style.cssText =
      "vertical-align: middle; border: 1px solid #b2b2b2; padding: 5px;";
    const msg = document.createElement("p");
    msg.style.margin = "0px";

    // integer math throughout — (attended - 0.75 * total) accumulates float
    // error and floors to the wrong count. 75% is the debar limit.
    if (attended_classes / tot_classes < 0.75) {
      // smallest n with (attended + n) / (total + n) >= 75%
      let req_classes = Math.ceil(
        3 * tot_classes - 4 * attended_classes
      );
      if (is_lab) req_classes = Math.ceil(req_classes / 2);
      td.style.background = "rgb(238, 75, 43,0.7)";
      msg.textContent = `${req_classes} ${unit} should be attended`;
    } else {
      // largest b with attended / (total + b) >= 75%
      let bunk_classes = Math.floor(
        (4 * attended_classes - 3 * tot_classes) / 3
      );
      if (is_lab) bunk_classes = Math.floor(bunk_classes / 2);
      if (bunk_classes < 0) bunk_classes = 0;

      if (bunk_classes <= 1) {
        td.style.background = "rgb(238, 75, 43,0.7)";
        msg.textContent = `Only ${bunk_classes} ${unit} can be Skipped, be Cautious`;
      } else {
        td.style.background = "rgb(170, 255, 0,0.7)";
        msg.textContent = `Only ${bunk_classes} ${unit} can be Skipped`;
      }
    }
    td.appendChild(msg);
    row.appendChild(td);
  });
};

/* Auto-semester: chooseCurrentSemester() picks the ongoing semester, but it
   only sets the dropdown — VTOP never loads anything until its onchange
   fires. Worse, during a sem transition the newest semester exists in the
   dropdown with no attendance rows yet, so the "right" pick renders an empty
   page. So: trigger VTOP's own load for the pick, and while the response has
   no attendance rows, step down the fallback list (next most recent
   semester) until one has data. */
let autoSemQueue = null;

const semesterSelect = () => document.getElementById("semesterSubId");

// dispatching change runs VTOP's inline onchange (processStudentAttendance)
const triggerAttendanceLoad = () => {
  const sel = semesterSelect();
  if (sel) sel.dispatchEvent(new Event("change", { bubbles: true }));
};

// "Has data" = at least one row with Total Classes > 0. A just-opened
// semester lists every registered course as 0/0 — that still means there's
// no attendance to look at, so keep stepping down.
const attendanceHasData = () => {
  const table = document.querySelector(".table-responsive table");
  if (!table) return false;
  const rows = Array.from(table.querySelectorAll("tbody tr"));
  if (rows.length === 0) return false;
  const headRow = table.querySelector("thead tr") || table.rows[0];
  if (!headRow) return true;
  const headers = Array.from(headRow.cells).map((c) =>
    c.innerText.trim().toLowerCase()
  );
  const totalCol = headers.findIndex((h) => h.includes("total"));
  if (totalCol === -1) return true; // can't judge the totals — accept rows
  return rows.some(
    (r) => parseFloat((r.cells[totalCol] || {}).innerText) > 0
  );
};

chrome.runtime.onMessage.addListener((request) => {
  if (request.message === "view_attendance_page") {
    try {
      // if usable data is already on screen, leave it alone — re-triggering
      // here on a repeated message caused a reload loop
      if (!attendanceHasData()) {
        chooseCurrentSemester();
        const sel = semesterSelect();
        if (sel && sel.selectedIndex > 0) {
          autoSemQueue =
            typeof semesterFallbackOrder === "function"
              ? semesterFallbackOrder()
                  .filter((i) => i !== sel.selectedIndex)
                  .slice(0, 3)
              : [];
          triggerAttendanceLoad();
        }
      }
    } catch (error) {
      console.error(error);
    } finally {
      const box = document.querySelector(".box-body");
      if (box) saveAttendancePage(box.outerHTML);
    }
  }
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.message === "view_attendance") {
    try {
      // schedule the empty-sem check BEFORE decorating, so a failure in the
      // decorator can never skip the fallback walk. Give VTOP a moment to
      // insert the response HTML before judging it.
      setTimeout(() => {
        if (!autoSemQueue) return;
        const sel = semesterSelect();
        if (attendanceHasData() || autoSemQueue.length === 0 || !sel) {
          autoSemQueue = null; // found data (or nothing left to try)
          return;
        }
        sel.selectedIndex = autoSemQueue.shift();
        triggerAttendanceLoad();
      }, 700);
      view_attendance_page();
    } catch (error) {
      console.error(error);
    } finally {
      const box = document.querySelector(".box-body");
      if (box) saveAttendancePage(box.outerHTML);
    }
  }
});
