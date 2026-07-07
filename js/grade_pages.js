/*
 * Appends a "Your Semester Wise GPA" row under the grade-view table.
 *
 * VTOP shifted the grade-view columns (credits no longer sit in the table at
 * all), so this detects columns by content and pulls credits by course code
 * from the grade-history table on the same page. If credits can't be resolved
 * it stays silent instead of printing NaN.
 */
const GRADE_POINTS = { S: 10, A: 9, B: 8, C: 7, D: 6, E: 5, F: 0 };

const _txt = (el) => (el ? el.textContent : "").replace(/\s+/g, " ").trim();
const _num = (s) => {
  const m = /-?\d+(\.\d+)?/.exec(String(s));
  return m ? parseFloat(m[0]) : NaN;
};
const _isCode = (s) => /^[A-Z]{2,4}\d{3,4}[A-Z]?$/.test(s.trim());
const _isGrade = (s) => /^[SABCDEF]$/.test(s.trim());
const _isCredit = (s) => /^\d{1,2}\.\d+$/.test(s.trim());
const _hasMonth = (s) => /\b[A-Z][a-z]{2}-\d{4}\b/.test(s);

// credits by course code from the grade-history table (rows carry Mon-YYYY)
let creditsByCode = () => {
  const map = {};
  Array.from(document.querySelectorAll("table tr")).forEach((tr) => {
    const texts = Array.from(tr.children).map(_txt);
    if (!texts.some(_hasMonth)) return;
    const code = texts.find(_isCode);
    const credit = texts.find(_isCredit);
    if (code && credit && !(code in map)) map[code] = _num(credit);
  });
  return map;
};

let modify_grade_page = () => {
  if (document.getElementById("vrevamp-sem-gpa-row")) return; // already added
  const root = document.querySelector("#studentGradeView");
  if (!root) return;
  // credits live on the Grade History page, cached there by the what-if
  // simulator (vrevamp_grade_credits); same-page tables win if present
  chrome.storage.local.get("vrevamp_grade_credits", (stored) => {
    if (document.getElementById("vrevamp-sem-gpa-row")) return;
    const credits = {
      ...((stored && stored.vrevamp_grade_credits) || {}),
      ...creditsByCode(),
    };
    addGpaRow(root, credits);
  });
};

let addGpaRow = (root, credits) => {
  let points = 0;
  let sum = 0;
  let tbody = null;
  let colspan = 11;
  Array.from(root.querySelectorAll("table tr")).forEach((tr) => {
    const texts = Array.from(tr.children).map(_txt);
    const code = texts.find(_isCode);
    const gradeI = texts.findIndex(_isGrade);
    if (!code || gradeI < 0) return;
    const credit = credits[code];
    const grade = texts[gradeI];
    if (!credit || !(grade in GRADE_POINTS)) return;
    points += GRADE_POINTS[grade] * credit;
    sum += credit;
    tbody = tr.parentElement;
    colspan = Math.max(colspan, tr.children.length);
  });

  if (!tbody || sum <= 0) return; // couldn't resolve credits — stay silent
  const gpa = (points / sum).toFixed(2);
  const row = document.createElement("tr");
  row.id = "vrevamp-sem-gpa-row";
  row.className = "tableContent-level1";
  row.style.background = "rgb(170, 255, 0, 0.6)";
  row.innerHTML = `<td colspan="${colspan}" style="text-align:center">Your Semester Wise GPA : ${gpa}</td>`;
  tbody.appendChild(row);
};

chrome.runtime.onMessage.addListener((request) => {
  if (request.message === "exam_grade") {
    try {
      modify_grade_page();
    } catch (error) {
      console.log(error);
    }
  }
});

// the simulator may finish its silent grade-history fetch after our message
// fired — retry when the cached credits land
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.vrevamp_grade_credits) {
    try {
      modify_grade_page();
    } catch (error) {
      console.log(error);
    }
  }
});
