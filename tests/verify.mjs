import { chromium } from "playwright";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// repo root, resolved relative to this test file so it runs anywhere
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✅" : "  ❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
};

// chrome shim + optional Date freeze + storage seed, installed before page scripts
const initScript = (fixedMs, storageSeed) => `
(() => {
  if (${fixedMs ? "true" : "false"}) {
    const F = ${fixedMs || 0};
    const _D = Date;
    class FakeDate extends _D {
      constructor(...a){ if(a.length===0) super(F); else super(...a); }
      static now(){ return F; }
    }
    window.Date = FakeDate;
  }
  window.__listeners = [];
  window.__storage = ${JSON.stringify(storageSeed || {})};
  window.__downloads = [];
  const resolveGet = (keys) => {
    const s = window.__storage;
    if (keys === null || keys === undefined) return { ...s };
    if (typeof keys === "string") return { [keys]: s[keys] };
    if (Array.isArray(keys)) { const o={}; keys.forEach(k=>o[k]=s[k]); return o; }
    const o={}; Object.keys(keys).forEach(k=>o[k] = (k in s)? s[k] : keys[k]); return o;
  };
  const area = {
    get: (keys, cb) => { const r = resolveGet(keys); if (cb){cb(r); return;} return Promise.resolve(r); },
    set: (obj, cb) => { Object.assign(window.__storage, obj); if(cb){cb();return;} return Promise.resolve(); },
    remove: (keys, cb) => { (Array.isArray(keys)?keys:[keys]).forEach(k=>delete window.__storage[k]); if(cb){cb();return;} return Promise.resolve(); },
  };
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => window.__listeners.push(fn) },
      getURL: (p) => "chrome-extension://test/" + p,
      get lastError(){ return null; },
    },
    storage: { local: area, session: area, sync: area },
    tabs: { query: () => {}, sendMessage: () => {}, create: () => {} },
    downloads: { download: () => {} },
  };
  window.__dispatch = (message) => window.__listeners.forEach((l) => { try { l({ message }, {}, () => {}); } catch(e){ console.error('listener', e);} });
  // capture .ics / png downloads triggered via anchor clicks
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function(){
    if (this.href && this.href.startsWith("data:")) { window.__downloads.push(decodeURIComponent(this.href.replace(/^data:[^,]*,/, ""))); return; }
    return realClick.apply(this, arguments);
  };
})();
`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let CTX;
async function newPage(browser) {
  if (!CTX) CTX = await browser.newContext({ timezoneId: "Asia/Kolkata" });
  const page = await CTX.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("    [page error]", m.text()); });
  page.on("pageerror", (e) => console.log("    [pageerror]", e.message));
  return page;
}

// inject the chrome/Date/storage shim into the *current* document (after the
// DOM is in place), so injection order — not navigation timing — guarantees
// the shim exists before the content scripts run
async function shim(page, { fixedMs, storage } = {}) {
  await page.addScriptTag({ content: initScript(fixedMs, storage) });
}

async function inject(page, files) {
  for (const f of files) await page.addScriptTag({ content: read(f) });
}

// weekday code for a given ms (matches the extension's MON/TUE/... cells)
const DAY_CODES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

(async () => {
  const browser = await chromium.launch();

  /* =================== Feature 2: next-class widget =================== */
  console.log("\n=== next-class widget (home page) ===");
  {
    const fixed = new Date("2026-06-29T09:30:00+05:30").getTime(); // 09:30 local-ish
    const wd = new Date(fixed).getDay();
    const code = DAY_CODES[wd];
    // header: index0 junk, then time columns (deduped already)
    const header = ["Start - End", "09:00 - 09:50", "10:00 - 10:50", "11:00 - 11:50"];
    const timetable = {
      header,
      data: [
        { day: code, // today
          theory: ["", "TA1-CSE1005-ETH-G14-CB-ALL", "", "B1-MAT2001-ETH-AB2-CB-ALL"],
          lab: ["", "", "", ""] },
      ],
    };
    const page = await newPage(browser);
    await page.setContent("<body><div id='main-section'></div></body>");
    await shim(page, { fixedMs: fixed, storage: { "timeTable-V1": timetable } });
    await inject(page, [
      "js/store/store.js",
      "js/store/saveTimeTableDetails.js",
      "js/utils/filterRepeated.js",
      "js/next_class.js",
    ]);
    await page.evaluate(() => window.__dispatch("nav_bar_change"));
    await delay(1200);
    const text = await page.evaluate(() => {
      const el = document.getElementById("vrevamp-next-class");
      return el ? el.textContent : null;
    });
    ok("card rendered", !!text, text || "no card");
    // 09:30 falls inside the 09:00-09:50 CSE1005 class
    ok("shows in-class-now for CSE1005", !!text && /In class now: CSE1005/.test(text), text || "");
    ok("shows ends-in-20-min", !!text && /ends in 20 min/.test(text), text || "");
    await page.close();
  }

  /* =================== Feature 3: CGPA what-if simulator =================== */
  // Current design joins three tables by course code: the current-sem grade
  // table (code+mark+grade), the grade-history table (credits, Mon-YYYY rows),
  // and the CGPA Details box (cgpa + credits earned).
  console.log("\n=== CGPA what-if simulator (grade page) ===");
  {
    const bodyText = (page) =>
      page.evaluate(() => {
        const el = document.getElementById("vrevamp-sim-body");
        return el ? el.textContent.replace(/\s+/g, " ") : null;
      });

    // CSE1005: 88 -> A(9), 4cr ; MAT2001: 76 -> B(8), 3cr -> GPA (36+24)/7 = 8.57
    const gradeTable = `<table>
      <tr><th>Sl</th><th>Code</th><th>Title</th><th>Type</th><th>Mark</th><th>Grade</th></tr>
      <tr><td>1</td><td>CSE1005</td><td>Problem Solving</td><td>ETH</td><td>88</td><td>A</td></tr>
      <tr><td>2</td><td>MAT2001</td><td>Statistics</td><td>ETH</td><td>76</td><td>B</td></tr>
    </table>`;
    // grade history (the only place credits live), rows carry a Mon-YYYY token
    const historyTable = `<table>
      <tr><th>Sem</th><th>Code</th><th>Title</th><th>Credits</th><th>Grade</th></tr>
      <tr><td>Jul-2025</td><td>CSE1005</td><td>Problem Solving</td><td>4.0</td><td>A</td></tr>
      <tr><td>Jul-2025</td><td>MAT2001</td><td>Statistics</td><td>3.0</td><td>B</td></tr>
    </table>`;
    const cgpaBox = `<table>
      <tr><td>CGPA</td><td>Credits Earned</td><td>Credits Registered</td></tr>
      <tr><td>8.20</td><td>60</td><td>64</td></tr>
    </table>`;
    const html = `<body><div id="studentGradeView">${gradeTable}${historyTable}${cgpaBox}</div></body>`;

    const page = await newPage(browser);
    await page.setContent(html);
    await shim(page);
    await inject(page, ["js/cgpa_simulator.js"]);
    await page.evaluate(() => window.__dispatch("exam_grade"));
    await delay(900);

    ok("panel rendered", await page.evaluate(() => !!document.getElementById("vrevamp-cgpa-sim")));
    let t = await bodyText(page);
    ok("reads credits from history (4 & 3) + current GPA 8.57", !!t && /Current semester GPA: 8\.57/.test(t), t ? t.slice(0, 90) : "none");
    ok("debug button present", await page.evaluate(() => [...document.querySelectorAll("#vrevamp-cgpa-sim button")].some((b) => /debug/i.test(b.textContent))));

    // change CSE1005 A->S(10): (40+24)/7 = 9.14
    await page.evaluate(() => {
      const sel = [...document.querySelectorAll("#vrevamp-cgpa-sim select")][0];
      sel.value = "S";
      sel.dispatchEvent(new Event("change"));
    });
    t = await bodyText(page);
    ok("recompute after grade change -> projected 9.14", !!t && /Projected semester GPA: 9\.14/.test(t), t ? t.match(/Projected[^.]*\d\.\d\d/)?.[0] : "none");

    // switch to CGPA mode: (8.20*60 - 60 + 64)/60 = 496/60 = 8.27
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("#vrevamp-cgpa-sim button")].find((b) => /Cumulative CGPA/.test(b.textContent));
      btn.click();
    });
    t = await bodyText(page);
    ok("CGPA mode reads real CGPA 8.20", !!t && /Current CGPA: 8\.20/.test(t), t ? t.match(/Current CGPA: [\d.]+/)?.[0] : "none");
    ok("projected CGPA folds the change -> 8.27", !!t && /Projected CGPA: 8\.27/.test(t), t ? t.match(/Projected CGPA: [\d.]+/)?.[0] : "none");
    await page.close();
  }

  /* sub-test: CGPA box but no detectable grade table must not crash (bug fix) */
  console.log("\n=== CGPA simulator: graceful when no grade table ===");
  {
    const page = await newPage(browser);
    let crashed = false;
    page.on("pageerror", () => (crashed = true));
    await page.setContent(`<body><div id="studentGradeView"><table>
      <tr><td>CGPA</td><td>Credits Earned</td></tr><tr><td>8.20</td><td>60</td></tr>
    </table></div></body>`);
    await shim(page);
    await inject(page, ["js/cgpa_simulator.js"]);
    await page.evaluate(() => window.__dispatch("exam_grade"));
    await delay(900);
    ok("no exception thrown", !crashed);
    ok("panel still renders with debug button", await page.evaluate(() =>
      !!document.getElementById("vrevamp-cgpa-sim") &&
      [...document.querySelectorAll("#vrevamp-cgpa-sim button")].some((b) => /debug/i.test(b.textContent))));
    await page.close();
  }

  /* =================== Feature 4: timetable .ics export =================== */
  console.log("\n=== full timetable .ics export ===");
  {
    const header = ["Start - End", "08:00 - 08:50", "14:00 - 14:50", "15:00 - 15:50"];
    const timetable = {
      header,
      data: [
        { day: "MON",
          theory: ["", "TA1-CSE1005-ETH-G14-CB-ALL", "", ""],
          lab: ["", "", "L31-BCSE204P-ELA-AB1-CB-ALL", "L32-BCSE204P-ELA-AB1-CB-ALL"] },
      ],
    };
    const storage = {
      "timeTable-V1": timetable,
      "vrevamp_calendar_fall semester 2025-26": { lastInstructional: "2025-11-20", fetchedAt: Date.now() },
    };
    const page = await newPage(browser);
    await page.setContent("<body><div id='main-section'><div id='loadMyFragment'></div></div></body>");
    await shim(page, { storage });
    await inject(page, [
      "js/store/store.js",
      "js/store/saveTimeTableDetails.js",
      "js/utils/filterRepeated.js",
      "js/timetable_ics.js",
    ]);
    await page.evaluate(() => window.__dispatch("timetable_view_page"));
    await delay(1200);
    ok("export button rendered", await page.evaluate(() => !!document.getElementById("vrevamp-timetable-ics")));
    await page.evaluate(() => document.getElementById("vrevamp-timetable-ics").click());
    await delay(300);
    const ics = await page.evaluate(() => window.__downloads[0] || null);
    const eventCount = ics ? (ics.match(/BEGIN:VEVENT/g) || []).length : 0;
    ok("ICS produced", !!ics && ics.startsWith("BEGIN:VCALENDAR"));
    ok("2 events (theory + merged lab)", eventCount === 2, "events=" + eventCount);
    ok("lab merged to 14:00-15:50", !!ics && /DTSTART;TZID=Asia\/Kolkata:\d{8}T140000\n[\s\S]*?DTEND;TZID=Asia\/Kolkata:\d{8}T155000/.test(ics));
    ok("weekly recurrence with UNTIL", !!ics && /RRULE:FREQ=WEEKLY;UNTIL=20251121T180000Z/.test(ics), "until from calendar +1d buffer");
    ok("has CSE1005 + BCSE204P summaries", !!ics && /SUMMARY:CSE1005/.test(ics) && /SUMMARY:BCSE204P/.test(ics));
    await page.close();
  }

  /* =================== Feature 1+accuracy: attendance insights =================== */
  console.log("\n=== attendance insights: forecaster banner + bunk table ===");
  {
    const fixed = new Date("2025-07-01T10:00:00+05:30").getTime();
    // subject A (CSE1005): 8 present / 2 absent = 80% (safe)
    // subject B (MAT2001): 6 present / 4 absent = 60% (below 75)
    // academic calendar fixtures
    const landing = `<html><body>
      <select><option value=""></option><option value="SEM1">Fall Semester 2025-26</option></select>
      <button onclick="m('01-JUL-2025')">Jul</button>
      </body></html>`;
    const monthGrid = `<html><body><table><tbody>
      <tr>
        <td>05 Instructional Day</td><td>07 Instructional Day</td><td>09 Instructional Day</td>
        <td>10 CAT - I</td><td>12 Instructional Day</td><td>14 Instructional Day</td>
        <td>16 Instructional Day</td><td>18 Instructional Day</td><td>20 Final Assessment Test</td>
        <td>15 Holiday</td>
      </tr></tbody></table></body></html>`;

    const page = await newPage(browser);
    await page.route("https://vtop.vitap.ac.in/**", (route) => {
      if (route.request().resourceType() === "document")
        return route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" });
      return route.abort();
    });
    await page.goto("https://vtop.vitap.ac.in/vtop/attendance");
    await shim(page, { fixedMs: fixed });
    // mock VTOP network: window.fetch override
    await page.addScriptTag({ content: `
      window.fetch = async (url, opts) => {
        const body = (opts && opts.body) || "";
        const hist = (p, a) => {
          let r = "", d = 1;
          const mk = (s) => { const x = "<tr><td>" + String(d).padStart(2,"0") + "-JUL-2025</td><td> " + s + " </td></tr>"; d += 2; return x; };
          for (let i = 0; i < p; i++) r += mk("Present");
          for (let i = 0; i < a; i++) r += mk("Absent");
          return "<table><tbody>" + r + "</tbody></table>";
        };
        const text = async () => {
          if (/academicCalendar/.test(url)) {
            if (/date=/.test(body)) return ${JSON.stringify(monthGrid)};
            return ${JSON.stringify(landing)};
          }
          if (/AttendanceDetail/.test(url)) {
            const m = /classId=([^&]+)/.exec(body); const id = m ? decodeURIComponent(m[1]) : "";
            return id.includes("1111") ? hist(8, 2) : hist(6, 4);
          }
          return "";
        };
        return { ok: true, status: 200, text };
      };
    ` });    // build attendance DOM
    await page.evaluate(() => {
      document.body.innerHTML = `
        <input name="_csrf" value="csrf123">
        <input id="authorizedIDX" value="STU1">
        <select id="semesterSubId"><option selected>Fall Semester 2025-26</option></select>
        <a data-url="academicCalendar">Academic Calendar</a>
        <div class="table-responsive"><table><tbody>
          <tr><td>CSE1005 Course A</td><td><a onclick="processViewAttendanceDetail('CSE100511111111','TA1')">view</a></td></tr>
          <tr><td>MAT2001 Course B</td><td><a onclick="processViewAttendanceDetail('MAT200122222222','B1')">view</a></td></tr>
        </tbody></table></div>`;
    });
    await inject(page, [
      "js/store/store.js",
      "js/store/saveTimeTableDetails.js",
      "js/attendance_insights.js",
    ]);    await page.evaluate(() => window.__dispatch("view_attendance"));
    await delay(2500);

    const banner = await page.evaluate(() => {
      const el = document.getElementById("vrevamp-forecast-banner");
      return el ? el.textContent : null;
    });
    ok("forecast banner rendered", !!banner, banner ? banner.slice(0, 80) + "…" : "none");
    ok("flags 1 subject below 75%", !!banner && /1 subject\(s\) below 75%/.test(banner), banner ? "" : "no banner");
    ok("MAT2001 (60%) flagged below with recover count", !!banner && /MAT2001[\s\S]*60% — attend the next \d+/.test(banner));
    ok("CSE1005 (80%) NOT in below list", !!banner && !/CSE1005: 80% — attend/.test(banner));

    const table = await page.evaluate(() => {
      const c = document.getElementById("vrevamp-bunk-table-container");
      if (!c) return null;
      const rows = [...c.querySelectorAll("tbody tr, tr")].map((tr) => [...tr.children].map((td) => td.textContent));
      return rows;
    });
    ok("bunk table rendered", !!table, table ? table.length + " rows" : "none");
    // held column should be 10 for both (8+2, 6+4)
    const heldVals = table ? table.filter((r) => /CSE1005|MAT2001/.test(r[0])).map((r) => r[1]) : [];
    ok("held counts = 10 for both subjects", heldVals.length === 2 && heldVals.every((v) => v === "10"), JSON.stringify(heldVals));
    // bunkable-before-CAT-1 cells should be numeric (calendar parsed)
    const calendarWorked = await page.evaluate(() => {
      const all = window.__storage;
      const cal = Object.keys(all).find((k) => k.startsWith("vrevamp_calendar_"));
      return cal ? all[cal] : null;
    });
    ok("academic calendar parsed & cached", !!calendarWorked && calendarWorked.cat1 === "2025-07-10" && calendarWorked.fat === "2025-07-20",
      calendarWorked ? `cat1=${calendarWorked.cat1} fat=${calendarWorked.fat}` : "no calendar");
    await page.close();
  }

  await browser.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
