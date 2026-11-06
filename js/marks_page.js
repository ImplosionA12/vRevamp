// Totals row per course marks table. Columns are found by HEADER TEXT, not
// position — the 2026 layout dropped "Class Average" and shuffled columns,
// which made the old fixed-index parser emit NaN and a 10-cell row inside
// an 8-column table.
let modify_marks_page = () => {
  document.querySelectorAll(".customTable-level1 > tbody").forEach((table) => {
    if (table.querySelector(".vtopext-marks-total")) return; // already added
    const rows = Array.from(table.querySelectorAll("tr"));
    const headRow = rows.find((r) => r.querySelector("th")) || rows[0];
    if (!headRow) return;
    const headers = Array.from(headRow.children).map((c) =>
      c.textContent.trim().toLowerCase()
    );
    const colCount = headers.length;
    const titleI = headers.findIndex((h) => /title/.test(h));
    const maxI = headers.findIndex((h) => /max/.test(h));
    const wPctI = headers.findIndex((h) => /weightage\s*(%|percent)/.test(h));
    const scoredI = headers.findIndex((h) => /scored/.test(h));
    const wMarkI = headers.findIndex(
      (h, i) => /weightage/.test(h) && i !== wPctI
    );
    const avgI = headers.findIndex((h) => /average/.test(h));
    if (scoredI === -1 || wMarkI === -1) return; // not a marks table we know

    const sums = {};
    [maxI, wPctI, scoredI, wMarkI, avgI].forEach((i) => {
      if (i >= 0) sums[i] = 0;
    });
    let counted = 0;
    Array.from(table.querySelectorAll(".tableContent-level1")).forEach(
      (row) => {
        const cells = row.children;
        if (!cells || cells.length < colCount) return;
        Object.keys(sums).forEach((i) => {
          const v = parseFloat(
            String(cells[i].textContent).replace(/[^0-9.-]+/g, "")
          );
          if (!isNaN(v)) sums[i] += v;
        });
        counted++;
      }
    );
    if (!counted) return;

    const tr = document.createElement("tr");
    tr.className = "tableContent-level1 vtopext-marks-total";
    tr.style.cssText = "background:rgb(60,141,188,0.8);font-weight:bold;";
    for (let i = 0; i < colCount; i++) {
      const td = document.createElement("td");
      if (i === (titleI >= 0 ? titleI : 1)) td.textContent = "Total:";
      else if (i in sums) td.textContent = sums[i].toFixed(2);
      tr.appendChild(td);
    }
    if (wPctI >= 0) {
      // weightage marks dropped so far, shown in the trailing (Remark) cell
      const lost = sums[wPctI] - sums[wMarkI];
      const last = tr.children[colCount - 1];
      if (!last.textContent)
        last.textContent = `Lost: ${lost.toFixed(2)}`;
    }
    table.appendChild(tr);
  });
};

// Attendance-risk badge: courses below 75% (or with zero safe skips) get a
// red flag beside their course row, from the snapshot attendance_insights
// cached on the Attendance page. Purely additive — no fetches.
const flagAttendanceRisk = async () => {
  const stored = await chrome.storage.local.get("vtopext_attendance_summary");
  const subjects = (stored.vtopext_attendance_summary || {}).subjects || [];
  // theory + lab share a course code — keep the worse of the two
  const byCode = {};
  subjects.forEach((s) => {
    if (!s.code || typeof s.pct !== "number") return;
    if (s.pct >= 75 && s.safeNow !== 0) return;
    if (!byCode[s.code] || s.pct < byCode[s.code].pct) byCode[s.code] = s;
  });
  Object.values(byCode).forEach((s) => {
    if (document.querySelector(`[data-vtopext-att-flag="${s.code}"]`)) return;
    // the course row lives OUTSIDE the nested per-course marks table
    const cell = Array.from(document.querySelectorAll("td")).find(
      (td) =>
        td.textContent.includes(s.code) &&
        !td.closest(".customTable-level1") &&
        !td.querySelector("table")
    );
    if (!cell) return;
    const badge = document.createElement("div");
    badge.dataset.vtopextAttFlag = s.code;
    badge.textContent =
      s.pct < 75
        ? `⚠ attendance ${s.pct}%`
        : "⚠ attendance: no safe skips left";
    badge.title = "VTOP Extension: from your last visit to the Attendance page";
    badge.style.cssText =
      "color:#c0392b;font-weight:bold;font-size:11px;margin-top:2px;white-space:nowrap;";
    cell.appendChild(badge);
  });
};

chrome.runtime.onMessage.addListener((request) => {
  if (request.message === "mark_view_page") {
    try {
      // Open on the ongoing semester rather than an empty picker. The page
      // shape lives in js/shared/auto_semester.js now, not here — this message
      // arrives only once VTOP has already rendered a semester's marks, so the
      // call that does the work is the one on "semester_page_open". This is
      // the second chance, and on a loaded page it is a no-op.
      if (typeof window.vrAutoSemesterFor === "function")
        window.vrAutoSemesterFor("mark_view");
      modify_marks_page();
      flagAttendanceRisk().catch((error) =>
        console.warn("VTOP Extension attendance flag:", error)
      );
      // .box-body is absent on some layouts; dereferencing it unguarded threw
      // past the catch below into console.error on every marks message
      const box = document.querySelector(".box-body");
      if (box) saveMarksPage(box.outerHTML);
    } catch (error) {
      console.error(error);
    }
  }
});
