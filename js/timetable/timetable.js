// What actions this `timetable_view_page` performs
// 1. Selects the recent semester
// 2. Compacts the time table into a viewable format which is easier to see. 
// TODO: add colors to the table 
// TODO: A toggle switch for the timetable view
// TODO: add a simple toggle switch for the auto view button


const change_time_table = () => {
  const parent_table = document.getElementById("timeTableStyle");
  if (parent_table === null || parent_table === undefined || parent_table.children.length === 0) return;

  const tbody_table = parent_table.children[0]; // the first element is the <tbody> with data
  const extractedHeader = extract_header(tbody_table.children);
  const extractedLabHeader = extract_lab_header(tbody_table.children);
  const extracted_children = extract_tbody_data(tbody_table.children);
  const merged_data = filterRepeatedColumns(extractedHeader, extracted_children)
  const childrenDataArr = merged_data;
  const semEl = document.getElementById("semesterSubId");
  const semesterName =
    semEl && semEl.selectedIndex >= 0
      ? (semEl.options[semEl.selectedIndex].innerText || "").trim()
      : null;
  saveTimeTable(
    extractedHeader,
    childrenDataArr,
    semesterName,
    extractedLabHeader
  );
  displayTableData(extractedHeader, childrenDataArr)
};

function displayTableData(headerData, childrenData) {
  // Drop the leading "starttime-endtime" junk column. This used to splice()
  // the caller's array in place — and change_time_table() passes the SAME
  // array to saveTimeTable() one line earlier, so the render was mutating
  // data that was mid-flight to storage. It survives only because
  // chrome.storage serializes its argument at call time; reordering those
  // two lines, or awaiting anything between them, would have silently
  // persisted a timetable missing its first column. Copy instead.
  const table = createTable(headerData.slice(1), childrenData);
  insertTable(table);
}

function createTable(header, bodyData) {
  const tdHeader = createTableHead(filterRepeated(header));
  const table = document.createElement("table"); table.className = "styled-table";
  table.appendChild(tdHeader);
  const tBody = document.createElement("tbody");
  const dayIndex = (new Date()).getDay();
  for (let i = 0; i < bodyData.length; i++) {
    const { day, theory, lab } = bodyData[i];
    // slice, not splice: bodyData belongs to the caller (and, on the live
    // page, to the blob being saved) — see displayTableData above. Index 0
    // is the same starttime-endtime placeholder.
    const theoryDataArr = theory.slice(1);
    const labDataArr = lab.slice(1);
    const tr = createTr(theoryDataArr, labDataArr);
    const day_td = _create_td_element(day, "day-block");
    tr.insertBefore(day_td, tr.children[0]);
    if (dayIndex == toIndex(day)) {
      tr.classList.add("current-day");
    }
    tBody.appendChild(tr);
  }
  table.appendChild(tBody);
  const table_div = document.createElement("div");
  table_div.className = "table-div";
  table_div.appendChild(table);
  return table_div;
}

function toIndex(day) {
  if (day === "MON") return 1;
  if (day === "TUE") return 2;
  if (day === "WED") return 3;
  if (day === "THU") return 4;
  if (day === "FRI") return 5;
  if (day === "SAT") return 6;
  return 0;
}

function insertTable(table_div) {
  // getting the actual div of the timetable
  const timeTableLoader = document.getElementById("loadMyFragment");
  if (!timeTableLoader || !timeTableLoader.parentElement) return;
  const parent_div = timeTableLoader.parentElement;
  // remove the previous table and download link if it exists
  document.querySelectorAll(".table-div").forEach((div) => { div.remove() });
  document.querySelectorAll(".download-timetable").forEach((a) => a.remove());
  // create a new table div and add the table to it
  parent_div.insertBefore(table_div, timeTableLoader);

  const a = create_download_link("download-timetable"); // className = download-timetable
  // Render the PNG only when the link is clicked. It used to be rendered on
  // every table render whether or not anyone downloaded it, and dom-to-image
  // re-fetches every web font (several 404s on VTOP) and rasterises the whole
  // table each time — seconds of work on every visit to this page.
  a.href = "#";
  a.download = "timetable.png";
  let rendering = false;
  a.addEventListener("click", (event) => {
    if (a.dataset.ready === "1") return; // second pass: let the download happen
    event.preventDefault();
    if (rendering) return;
    rendering = true;
    domtoimage.toPng(table_div, { quality: 0.99 }).then(
      (dataUrl) => {
        a.href = dataUrl;
        a.dataset.ready = "1";
        rendering = false;
        a.click();
      },
      () => {
        rendering = false;
      }
    );
  });
  parent_div.insertBefore(a, table_div);
}

// #loadMyFragment is VTOP's generic SPA container: EVERY page load churns
// thousands of mutations through it. The observer must therefore be cheap
// per mutation (debounce), skip repeat renders of the same table content
// (signature), and exist at most once per document (a stacked observer per
// re-fired message multiplied the work until the renderer froze —
// "Page Unresponsive", seen live 2026-07-07). attributes:true was pure
// noise: the loading spinner's style toggles fired full re-renders.
const MutationObserverConfig = { childList: true, subtree: true };

let vr_tt_timer = null;
let vr_tt_lastSig = null;
let vr_tt_observer = null;

const vr_tt_schedule = () => {
  clearTimeout(vr_tt_timer);
  vr_tt_timer = setTimeout(() => {
    const parent_table = document.getElementById("timeTableStyle");
    if (!parent_table) return;
    const sig = parent_table.textContent;
    if (sig === vr_tt_lastSig) return; // same table — nothing to re-render
    vr_tt_lastSig = sig;
    change_time_table();
  }, 400);
};

chrome.runtime.onMessage.addListener((request) => {
  if (request.message === "timetable_view_page") {
    try {
      // same — the page-open message does the real work; see marks_page.js
      // (its predicate also carried two literal 0x08 bytes where a regex word
      // boundary was meant; that is gone with it — the shape now lives in
      // js/shared/auto_semester.js)
      if (typeof window.vrAutoSemesterFor === "function")
        window.vrAutoSemesterFor("timetable_view");
      // try to display the timetable data if it exists
      getTimeTable((d) => {
        if (d && d.header && d.data) displayTableData(d.header, d.data);
      });

      // attaching the observer to the div (once — re-fired messages must
      // not stack a second one)
      const timeTableDiv = document.getElementById("loadMyFragment");
      if (!timeTableDiv) return;
      if (vr_tt_observer) vr_tt_observer.disconnect();
      vr_tt_observer = new MutationObserver(vr_tt_schedule);
      vr_tt_observer.observe(timeTableDiv, MutationObserverConfig);
      vr_tt_schedule(); // the table may already be in the DOM
    } catch (error) {
      // console.log(error);
      console.error(error)
    }
  }
});
