let view_attendance_page = () => {
  let table_line = document.querySelectorAll(".table-responsive")[0];
  const table = table_line.querySelector("table");
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
      "*Note: This calculator doesn't calculate the attendance till the end of the sem, It only calculates the attendance to 80%";
    table_line.insertAdjacentElement("beforebegin", note);
  }

  //Footer legend
  if (!document.getElementById("vrevamp-attendance-legend")) {
    let color_detail = document.createElement("div");
    color_detail.id = "vrevamp-attendance-legend";
    color_detail.innerHTML = `
    <p style='color:RGB(34 144 62);'>*Green: comfortable buffer above 80%</p>
    <p style='color:rgb(238, 75, 43); margin-top:-10px'>*Red: at or near the 80% limit &mdash; attend, don't skip</p>
    `;
    table_line.insertAdjacentElement("afterend", color_detail);
  }

  //Head edit
  if (!document.getElementById("vrevamp-alert-head")) {
    const th = document.createElement("th");
    th.id = "vrevamp-alert-head";
    th.textContent = "80% Attendance Alert";
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

    // integer math throughout — (attended - 0.8 * total) accumulates float
    // error and floors to the wrong count
    if (attended_classes / tot_classes < 0.8) {
      // smallest n with (attended + n) / (total + n) >= 80%
      let req_classes = Math.ceil(
        (8 * tot_classes - 10 * attended_classes) / 2
      );
      if (is_lab) req_classes = Math.ceil(req_classes / 2);
      td.style.background = "rgb(238, 75, 43,0.7)";
      msg.textContent = `${req_classes} ${unit} should be attended`;
    } else {
      // largest b with attended / (total + b) >= 80%
      let bunk_classes = Math.floor(
        (10 * attended_classes - 8 * tot_classes) / 8
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

chrome.runtime.onMessage.addListener((request) => {
  if (request.message === "view_attendance_page") {
    try {
      chooseCurrentSemester();
    } catch (error) {
      console.error(error);
    } finally {
      saveAttendancePage(document.querySelector(".box-body").outerHTML);
    }
  }
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.message === "view_attendance") {
    try {
      view_attendance_page();
    } catch (error) {
      console.error(error);
    } finally {
      saveAttendancePage(document.querySelector(".box-body").outerHTML);
    }
  }
});
