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
  // Real chrome.storage structured-clones on the way in AND out, so callers
  // never share a reference with the store or with each other. The stub used
  // to hand back live references ({...s} is shallow), which silently made
  // aliasing bugs untestable: displayTableData() splices index 0 off the
  // header/theory/lab arrays it is given, and with a shared reference that
  // corrupted the "stored" timetable for every later reader in the same page.
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const resolveGet = (keys) => {
    const s = window.__storage;
    if (keys === null || keys === undefined) return clone(s);
    if (typeof keys === "string") return { [keys]: clone(s[keys]) };
    if (Array.isArray(keys)) { const o={}; keys.forEach(k=>o[k]=clone(s[k])); return o; }
    const o={}; Object.keys(keys).forEach(k=>o[k] = (k in s)? clone(s[k]) : keys[k]); return o;
  };
  const area = {
    get: (keys, cb) => { const r = resolveGet(keys); if (cb){cb(r); return;} return Promise.resolve(r); },
    set: (obj, cb) => { Object.assign(window.__storage, clone(obj)); if(cb){cb();return;} return Promise.resolve(); },
    remove: (keys, cb) => { (Array.isArray(keys)?keys:[keys]).forEach(k=>delete window.__storage[k]); if(cb){cb();return;} return Promise.resolve(); },
  };
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => window.__listeners.push(fn) },
      getURL: (p) => "chrome-extension://test/" + p,
      get lastError(){ return null; },
      // minimal worker emulation: Google token comes from __storage.token,
      // local reminders are recorded per-tag in __reminders (future-only,
      // mirroring the worker's schedule_local_reminders filter)
      sendMessage: (m, cb) => {
        (window.__sent = window.__sent || []).push(m);
        if (m && m.message === "get_google_token") {
          const t = window.__storage.token || null;
          if (cb) cb({ token: t, error: t ? null : (window.__storage.google_error || "OAuth2 not granted or revoked.") });
          return;
        }
        if (m && m.message === "gcal_template_import") {
          // worker emulation for the one-click TEMPLATE import: records the
          // links; __autoImportSaves seeds how many events "saved"
          // (undefined = worker from before this update -> unknown message)
          window.__autoImport = m.urls;
          if (cb) cb(window.__autoImportSaves === undefined ? undefined : { saved: window.__autoImportSaves, failed: m.urls.length - window.__autoImportSaves, total: m.urls.length });
          return;
        }
        if (m && m.message === "ics_import_fallback") {
          // TRAP, not a feature: the worker case that handled this was
          // removed (Google's 2026 revamp broke /r/settings/import, so the
          // sign-in-free path is the one-tap TEMPLATE panel). Kept so the
          // assertion below — that nothing sends this any more, and no
          // Import tab is opened — can still tell "not sent" apart from
          // "sent into the void".
          if (window.__swFallbackFails) { if (cb) cb(false); return; }
          window.__downloads.push(m.ics);
          (window.__opened = window.__opened || []).push("https://calendar.google.com/calendar/u/0/r/settings/import");
          if (cb) cb(true);
          return;
        }
        if (m && m.message === "schedule_local_reminders") {
          const future = (Array.isArray(m.reminders) ? m.reminders : []).filter(
            (r) => r && typeof r.when === "number" && r.when > Date.now() + 60000
          );
          (window.__reminders = window.__reminders || {})[m.tag] = future;
          if (cb) cb(future.length);
          return;
        }
        if (cb) cb(undefined);
      },
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
  console.log("\n=== CGPA what-if simulator (grade page) ===");
  {
    // grade table carries NO credits (current VTOP layout); credits live in the
    // grade-history table (Mon-YYYY rows) and CGPA in the "CGPA Details" box.
    // CSE1005: 4cr A(9) mark 85, expanded "Range of Grades" (S needs >=91)
    // MAT2001: 3cr B(8) mark 78, not expanded
    // GPA = (36+24)/7 = 8.571
    const html = `<body><div id="studentGradeView"><div class="row">
      <table><tbody>
        <tr><th>Sl.No.</th><th>Course Code</th><th>Course Title</th><th>Course Type</th><th>Total Marks</th><th>Grade</th></tr>
        <tr><td>1</td><td>CSE1005</td><td>Data Structures</td><td>Theory Only</td><td>85</td><td>A</td>
          <td><table><tbody>
            <tr><td colspan="7">Range of Grades</td></tr>
            <tr><td>S</td><td>A</td><td>B</td><td>C</td><td>D</td><td>E</td><td>F</td></tr>
            <tr><td>&gt;=91</td><td>&gt;=81</td><td>&gt;=71</td><td>&gt;=61</td><td>&gt;=51</td><td>&gt;=41</td><td>&lt;41</td></tr>
          </tbody></table></td></tr>
        <tr><td>2</td><td>MAT2001</td><td>Applied Calculus</td><td>Theory Only</td><td>78</td><td>B</td></tr>
      </tbody></table>
      <table><tbody>
        <tr><td>Credits Registered</td><td>Credits Earned</td><td>CGPA</td></tr>
        <tr><td>30</td><td>27</td><td>8.5</td></tr>
      </tbody></table>
      <table><tbody>
        <tr><td>Jul-2025</td><td>CSE1005</td><td>Data Structures</td><td>4.0</td><td>A</td></tr>
        <tr><td>Jul-2025</td><td>MAT2001</td><td>Applied Calculus</td><td>3.0</td><td>B</td></tr>
      </tbody></table>
    </div></div></body>`;
    const page = await newPage(browser);
    await page.setContent(html);
    await shim(page);
    await inject(page, ["js/cgpa_simulator.js"]);
    await page.evaluate(() => window.__dispatch("exam_grade"));
    await delay(700); // build is debounced 400ms

    ok("panel rendered", await page.evaluate(() => !!document.getElementById("vrevamp-cgpa-sim")));
    const rowCells = await page.evaluate(() =>
      [...document.querySelectorAll("#vrevamp-cgpa-sim table tr")]
        .map((tr) => [...tr.children].map((td) => td.textContent.trim()))
        .filter((c) => /CSE1005|MAT2001/.test(c[0] || ""))
    );
    ok(
      "credits joined from grade history (4, 3)",
      rowCells.length === 2 && rowCells[0][1] === "4" && rowCells[1][1] === "3",
      JSON.stringify(rowCells.map((c) => c[1]))
    );
    const bodyText = () =>
      page.evaluate(() => document.getElementById("vrevamp-sim-body").textContent);
    let text = await bodyText();
    ok("current semester GPA = 8.57", /Current semester GPA:\s*8\.57/.test(text), text.slice(0, 120));
    ok(
      "marks-to-next from per-course cutoffs (85 -> 6 short of S)",
      rowCells[0][4] === "6 mark(s) → S",
      rowCells[0][4]
    );
    ok("unexpanded course prompts to expand", rowCells[1][4] === "expand course ↑", rowCells[1][4]);

    // change CSE1005 A -> S (10): (40+24)/7 = 9.142
    await page.evaluate(() => {
      const sel = document.querySelectorAll("#vrevamp-cgpa-sim select")[0];
      sel.value = "S";
      sel.dispatchEvent(new Event("change"));
    });
    text = await bodyText();
    ok("recompute after grade change -> 9.14", /Projected semester GPA:\s*9\.14/.test(text), text.slice(0, 160));

    // CGPA mode folds the delta into the page's CGPA Details box:
    // (8.5*27 - 60 + 64)/27 = 8.648 -> 8.65
    await page.evaluate(() => {
      [...document.querySelectorAll("#vrevamp-sim-body button")]
        .find((b) => b.textContent === "Cumulative CGPA")
        .click();
    });
    text = await bodyText();
    ok("CGPA mode reads page CGPA (8.50)", /Current CGPA:\s*8\.50/.test(text), text.slice(0, 160));
    ok("projected CGPA = 8.65", /Projected CGPA:\s*8\.65/.test(text), text.slice(0, 160));
    await page.close();
  }

  /* ============ CGPA simulator: grade table missing entirely ============ */
  console.log("\n=== CGPA simulator: no grade table detected (fallback) ===");
  {
    // only the CGPA Details box is recognisable — the panel must still render
    // (with the debug button) instead of crashing on the missing grade table
    const page = await newPage(browser);
    await page.setContent(`<body><div class="row"><table><tbody>
      <tr><td>Credits Registered</td><td>Credits Earned</td><td>CGPA</td></tr>
      <tr><td>30</td><td>27</td><td>8.5</td></tr>
    </tbody></table></div></body>`);
    await shim(page);
    await inject(page, ["js/cgpa_simulator.js"]);
    await page.evaluate(() => window.__dispatch("exam_grade"));
    await delay(700);
    const panelText = await page.evaluate(() => {
      const el = document.getElementById("vrevamp-cgpa-sim");
      return el ? el.textContent : null;
    });
    ok("panel still renders without a grade table", !!panelText, panelText ? "" : "no panel");
    ok(
      "shows couldn't-read hint + debug button",
      !!panelText && /Couldn't read the grade table/.test(panelText) && /Copy debug info/.test(panelText)
    );
    await page.close();
  }

  /* ========= CGPA simulator: credits from cached grade history ========= */
  console.log("\n=== CGPA simulator: real Grades-page layout (credits cached) ===");
  {
    // the live Grades page carries NO credits and NO CGPA box — both come from
    // the Grade History cache (chrome.storage.local, harvested/fetched)
    // ECE2015 carries the "+" button's onclick — its cutoffs must be fetched
    // silently from getGradeViewDetails (no manual expanding)
    const html = `<body>
      <input name="_csrf" value="csrf123">
      <input id="authorizedIDX" value="24MIC7198">
      <input id="semesterSubId" value="AP2025264">
      <div id="studentGradeView"><div class="row">
      <table><tbody>
        <tr><th>Sl.No.</th><th>Course Code</th><th>Course Title</th><th>Course Type</th><th>Grading Type</th><th>Grand Total</th><th>Grade</th><th>View Mark</th></tr>
        <tr><td>1</td><td>ECE2015</td><td>Computer Architecture</td><td>Theory Only</td><td>RG</td><td>80</td><td>B</td><td><button onclick="javascript:getGradeViewDetails('AM_ECE2015_00100');">+</button></td></tr>
        <tr><td>2</td><td>SWE2006</td><td>Database Systems</td><td>Theory Only</td><td>RG</td><td>81</td><td>A</td><td></td></tr>
      </tbody></table>
    </div></div></body>`;
    const rangeFragment = `<div><table><tbody>
      <tr><td colspan="7">Range of Grades</td></tr>
      <tr><td>S</td><td>A</td><td>B</td><td>C</td><td>D</td><td>E</td><td>F</td></tr>
      <tr><td>&gt;=91</td><td>&gt;=81</td><td>&gt;=71</td><td>&gt;=61</td><td>&gt;=51</td><td>&gt;=41</td><td>&lt;41</td></tr>
    </tbody></table></div>`;
    const page = await newPage(browser);
    await page.setContent(html);
    await shim(page, {
      storage: {
        vrevamp_grade_credits: { ECE2015: 3, SWE2006: 4 },
        vrevamp_cgpa_details: { cgpa: 8.28, creditsEarned: 95 },
      },
    });
    await page.addScriptTag({ content: `
      window.fetch = async (url, opts) => {
        const body = (opts && opts.body) || "";
        const text = async () =>
          /getGradeViewDetails/.test(url) && /courseId=AM_ECE2015_00100/.test(body)
            ? ${JSON.stringify(rangeFragment)}
            : "";
        return { ok: true, status: 200, text };
      };
    ` });
    await inject(page, ["js/cgpa_simulator.js"]);
    await page.evaluate(() => window.__dispatch("exam_grade"));
    await delay(2000); // initial build + silent cutoff fetch + rebuild

    ok("panel rendered", await page.evaluate(() => !!document.getElementById("vrevamp-cgpa-sim")));
    const rowCells = await page.evaluate(() =>
      [...document.querySelectorAll("#vrevamp-cgpa-sim table tr")]
        .map((tr) => [...tr.children].map((td) => td.textContent.trim()))
        .filter((c) => /ECE2015|SWE2006/.test(c[0] || ""))
    );
    ok(
      "credits resolved from cache (3, 4)",
      rowCells.length === 2 && rowCells[0][1] === "3" && rowCells[1][1] === "4",
      JSON.stringify(rowCells.map((c) => c[1]))
    );
    ok(
      "cutoffs auto-fetched from the + endpoint (80 -> 1 mark to A)",
      rowCells[0][4] === "1 mark(s) → A",
      rowCells[0][4]
    );
    ok(
      "no + button -> still shows the expand hint",
      rowCells[1][4] === "expand course ↑",
      rowCells[1][4]
    );
    const bodyText = () =>
      page.evaluate(() => document.getElementById("vrevamp-sim-body").textContent);
    let text = await bodyText();
    // 3cr B(8) + 4cr A(9) = 60/7 = 8.571
    ok("semester GPA from cached credits = 8.57", /Current semester GPA:\s*8\.57/.test(text), text.slice(0, 140));

    // ECE2015 B -> A, CGPA mode: (8.28*95 - 60 + 63)/95 = 8.311 -> 8.31
    await page.evaluate(() => {
      const sel = document.querySelectorAll("#vrevamp-cgpa-sim select")[0];
      sel.value = "A";
      sel.dispatchEvent(new Event("change"));
      [...document.querySelectorAll("#vrevamp-sim-body button")]
        .find((b) => b.textContent === "Cumulative CGPA")
        .click();
    });
    text = await bodyText();
    ok("CGPA mode uses cached details (8.28)", /Current CGPA:\s*8\.28/.test(text), text.slice(0, 160));
    ok("projected CGPA = 8.31", /Projected CGPA:\s*8\.31/.test(text), text.slice(0, 160));
    await page.close();
  }

  /* ========= CGPA simulator: Grade History page is harvested ========= */
  console.log("\n=== CGPA simulator: Grade History page harvest (no panel) ===");
  {
    const page = await newPage(browser);
    await page.setContent(`<body><div class="row">
      <table><tbody>
        <tr><td>Credits Registered</td><td>Credits Earned</td><td>CGPA</td></tr>
        <tr><td>98.0</td><td>95.0</td><td>8.28</td></tr>
      </tbody></table>
      <table><tbody>
        <tr><th>Sl.No.</th><th>Course Code</th><th>Course Title</th><th>Course Type</th><th>Credits</th><th>Grade</th><th>Exam Month</th></tr>
        <tr><td>1</td><td>ECE2015</td><td>Computer Architecture</td><td>ETH</td><td>3.0</td><td>B</td><td>Jan-2026</td></tr>
        <tr><td>2</td><td>SWE2006</td><td>Database Systems</td><td>ETH</td><td>4.0</td><td>A</td><td>Jan-2026</td></tr>
      </tbody></table>
    </div></body>`);
    await shim(page);
    await inject(page, ["js/cgpa_simulator.js"]);
    await page.evaluate(() => window.__dispatch("exam_grade"));
    await delay(700);
    ok(
      "no panel on the Grade History page",
      await page.evaluate(() => !document.getElementById("vrevamp-cgpa-sim"))
    );
    const stored = await page.evaluate(() => window.__storage);
    ok(
      "credits harvested to storage",
      !!stored.vrevamp_grade_credits &&
        stored.vrevamp_grade_credits.ECE2015 === 3 &&
        stored.vrevamp_grade_credits.SWE2006 === 4,
      JSON.stringify(stored.vrevamp_grade_credits)
    );
    ok(
      "CGPA details harvested to storage",
      !!stored.vrevamp_cgpa_details && stored.vrevamp_cgpa_details.cgpa === 8.28,
      JSON.stringify(stored.vrevamp_cgpa_details)
    );
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
      "js/shared/ics.js",
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
    ok("lab merged to 14:00-15:50", !!ics && /DTSTART;TZID=Asia\/Kolkata:\d{8}T140000\r\n[\s\S]*?DTEND;TZID=Asia\/Kolkata:\d{8}T155000/.test(ics));
    ok("weekly recurrence with UNTIL", !!ics && /RRULE:FREQ=WEEKLY;UNTIL=20251121T180000Z/.test(ics), "until from calendar +1d buffer");
    ok("has CSE1005 + BCSE204P summaries", !!ics && /SUMMARY:CSE1005/.test(ics) && /SUMMARY:BCSE204P/.test(ics));
    // RFC 5545 conformance — see js/shared/ics.js for what each of these
    // used to get wrong and how it broke real imports.
    ok("CRLF line endings, no bare LF", !!ics && !/[^\r]\n/.test(ics));
    ok(
      "DTSTAMP is UTC with Z and no TZID",
      !!ics && /^DTSTAMP:\d{8}T\d{6}Z$/m.test(ics) && !/DTSTAMP;/.test(ics)
    );
    ok(
      "every UID is unique",
      (() => {
        const uids = [...(ics || "").matchAll(/^UID:(.*)$/gm)].map((m) => m[1]);
        return uids.length > 0 && new Set(uids).size === uids.length;
      })(),
      `uids=${[...(ics || "").matchAll(/^UID:(.*)$/gm)].map((m) => m[1]).join(" ")}`
    );
    ok(
      "no content line exceeds 75 octets",
      (ics || "").split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)
    );
    // RFC 5545 §3.6.5: a TZID parameter must reference a VTIMEZONE defined in
    // the same object. We emitted bare "TZID=Asia/Kolkata" with no definition
    // — Google/Apple resolve the Olson name anyway, which hid it, but a
    // strict consumer may read every class as floating local time.
    ok(
      "TZID=Asia/Kolkata is backed by a VTIMEZONE definition",
      !!ics &&
        /BEGIN:VTIMEZONE\r\nTZID:Asia\/Kolkata\r\n/.test(ics) &&
        /TZOFFSETFROM:\+0530\r\nTZOFFSETTO:\+0530/.test(ics) &&
        ics.indexOf("BEGIN:VTIMEZONE") < ics.indexOf("BEGIN:VEVENT"),
      (ics || "").split("BEGIN:VEVENT")[0]
    );
    await page.close();
  }

  /* ---- the .ics download carries cached exams too, like the gcal import ---- */
  {
    // buildIcs() has always taken an `exams` argument, but the only caller
    // passed two arguments — so the downloaded file held classes only while
    // the 📅 import button beside it added classes AND exams from the same
    // cache. Same fixture as above plus a cached exam schedule.
    const page = await newPage(browser);
    await page.setContent("<body><div id='main-section'><div id='loadMyFragment'></div></div></body>");
    await shim(page, {
      fixedMs: new Date("2025-10-01T09:00:00+05:30").getTime(),
      storage: {
        "timeTable-V1": {
          header: ["Start - End", "08:00 - 08:50"],
          data: [{ day: "MON", theory: ["", "TA1-CSE1005-ETH-G14-CB-ALL"], lab: ["", ""] }],
        },
        "vrevamp_calendar_fall semester 2025-26": {
          lastInstructional: "2025-11-20",
          fetchedAt: Date.now(),
        },
        vrevamp_exam_schedule: {
          fetchedAt: Date.now(),
          semester: "Fall Semester 2025-26",
          exams: [
            // future → included
            { type: "FAT", code: "CSE1005", title: "Data Structures", slot: "A1",
              venue: "CB-324", reporting: "09:30 AM", seatLoc: "R3C1", seatNo: "5",
              dateIso: "2025-11-24", start: "1000", end: "1300" },
            // already past → must NOT be exported
            { type: "CAT1", code: "CSE1005", title: "Data Structures", slot: "A1",
              venue: "CB-324", reporting: "09:30 AM", seatLoc: "R3C1", seatNo: "5",
              dateIso: "2025-09-10", start: "1000", end: "1130" },
          ],
        },
      },
    });
    await inject(page, [
      "js/store/store.js",
      "js/store/saveTimeTableDetails.js",
      "js/utils/filterRepeated.js",
      "js/shared/ics.js",
      "js/timetable_ics.js",
    ]);
    await page.evaluate(() => window.__dispatch("timetable_view_page"));
    await delay(1200);
    await page.evaluate(() => document.getElementById("vrevamp-timetable-ics").click());
    await delay(300);
    const ics = await page.evaluate(() => window.__downloads[0] || null);
    const n = ics ? (ics.match(/BEGIN:VEVENT/g) || []).length : 0;
    ok("1 class + 1 upcoming exam exported", n === 2, `events=${n}`);
    ok(
      "exam event sits on its own window, with no RRULE",
      !!ics &&
        /DTSTART;TZID=Asia\/Kolkata:20251124T100000/.test(ics) &&
        /DTEND;TZID=Asia\/Kolkata:20251124T130000/.test(ics) &&
        /SUMMARY:FAT exam: CSE1005/.test(ics),
      (ics || "").split("BEGIN:VEVENT").pop()
    );
    ok(
      "past exam excluded",
      !!ics && !/20250910/.test(ics) && !/CAT1/.test(ics)
    );
    ok(
      "exam seat/reporting detail carried in DESCRIPTION",
      !!ics && /DESCRIPTION:Slot: A1/.test(ics) && /Reporting: 09:30 AM/.test(ics)
    );
    ok(
      "button reports what it wrote",
      /exam\(s\)/.test(
        await page.evaluate(
          () => document.getElementById("vrevamp-timetable-ics").nextElementSibling?.textContent || ""
        )
      ),
      await page.evaluate(
        () => document.getElementById("vrevamp-timetable-ics").nextElementSibling?.textContent || ""
      )
    );
    await page.close();
  }

  /* ============ timetable → Google Calendar import (weekly, EXDATE) ============ */
  console.log("\n=== timetable → Google Calendar import ===");
  {
    // Wed 1 Oct 2025; MON classes → series anchors on Mon 6 Oct. Mondays to
    // the last instructional day (20 Nov): Oct 6/13/20/27, Nov 3/10/17 — all
    // instructional EXCEPT Oct 20 (holiday), which must be EXDATE'd out.
    const fixed = new Date("2025-10-01T10:00:00+05:30").getTime();
    const header = ["Start - End", "08:00 - 08:50", "14:00 - 14:50", "15:00 - 15:50"];
    const timetable = {
      header,
      data: [
        { day: "MON",
          theory: ["", "TA1-CSE1005-ETH-G14-CB-ALL", "", ""],
          lab: ["", "", "L31-BCSE204P-ELA-AB1-CB-ALL", "L32-BCSE204P-ELA-AB1-CB-ALL"] },
      ],
    };
    const mondays = ["2025-10-06", "2025-10-13", "2025-10-27", "2025-11-03", "2025-11-10", "2025-11-17"];
    const storage = {
      "timeTable-V1": timetable,
      "vrevamp_calendar_fall semester 2025-26": {
        lastInstructional: "2025-11-20",
        instructionalDays: mondays,
        holidays: ["2025-10-20"],
        fetchedAt: fixed,
      },
      vrevamp_attendance_summary: {
        subjects: [{ name: "CSE1005 - Data Structures - Theory Only", code: "CSE1005" }],
      },
      // cached by the Exam Schedule page: one upcoming FAT (after the last
      // instructional day), one past CAT2, one CAT1 without a published time
      vrevamp_exam_schedule: {
        fetchedAt: fixed,
        semester: "Fall Semester 2025-26",
        exams: [
          { type: "FAT", code: "CSE1005", title: "Data Structures", slot: "A1", session: "FN1",
            reporting: "09:30 AM", venue: "CB-324", seatLoc: "R3C1", seatNo: "5",
            dateIso: "2025-11-24", start: "1000", end: "1300" },
          { type: "CAT2", code: "CSE1005", title: "Data Structures", slot: "A1", session: "FN1",
            reporting: "09:30 AM", venue: "CB-101", seatLoc: "R1C1", seatNo: "9",
            dateIso: "2025-09-15", start: "1000", end: "1130" },
          { type: "CAT1", code: "BCSE204P", title: "No Time Yet", slot: "L31", session: "",
            reporting: "", venue: "", seatLoc: "", seatNo: "",
            dateIso: "2025-10-10", start: null, end: null },
        ],
      },
      token: "tok123",
    };
    const gcal = [];
    const page = await newPage(browser);
    await page.route("https://www.googleapis.com/**", (route) => {
      const req = route.request();
      gcal.push({
        method: req.method(),
        url: req.url(),
        body: req.postData() ? JSON.parse(req.postData()) : null,
      });
      // the list call finds one previously imported series to replace
      if (req.method() === "GET")
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [{ id: "old1" }] }) });
      return route.fulfill({ contentType: "application/json", body: "{}" });
    });
    await page.setContent("<body><div id='main-section'><div id='loadMyFragment'></div></div></body>");
    await shim(page, { fixedMs: fixed, storage });
    await inject(page, [
      "js/store/store.js",
      "js/store/saveTimeTableDetails.js",
      "js/utils/filterRepeated.js",
      "js/shared/ics.js",
      "js/timetable_ics.js",
    ]);
    await page.evaluate(() => window.__dispatch("timetable_view_page"));
    await delay(1200);
    ok("import button rendered", await page.evaluate(() => !!document.getElementById("vrevamp-timetable-gcal")));
    await page.evaluate(() => document.getElementById("vrevamp-timetable-gcal").click());
    await delay(2500);
    const posts = gcal.filter((g) => g.method === "POST");
    const dels = gcal.filter((g) => g.method === "DELETE");
    ok("previous import replaced (old series deleted)", dels.length === 1 && /\/events\/old1$/.test(dels[0].url), JSON.stringify(dels.map((d) => d.url)));
    const series = posts.map((p) => p.body).filter((b) => b && b.recurrence);
    const singles = posts.map((p) => p.body).filter((b) => b && !b.recurrence);
    ok("2 weekly series created (theory + merged lab)", series.length === 2, `series=${series.length}`);
    const theory = series.find((b) => /CSE1005/.test(b.summary));
    const lab = series.find((b) => /BCSE204P/.test(b.summary));
    ok(
      "subject title from the attendance snapshot + slot in the summary",
      !!theory && theory.summary === "CSE1005 — Data Structures (TA1)",
      theory && theory.summary
    );
    ok("venue in location (G14)", !!theory && theory.location === "G14", theory && theory.location);
    ok(
      "series anchors on next Monday 08:00 IST",
      !!theory && theory.start && theory.start.dateTime === "2025-10-06T08:00:00" && theory.start.timeZone === "Asia/Kolkata",
      theory && JSON.stringify(theory.start)
    );
    ok(
      "weekly until the last instructional day (+1d buffer)",
      !!theory && theory.recurrence && theory.recurrence[0] === "RRULE:FREQ=WEEKLY;UNTIL=20251121T180000Z",
      theory && JSON.stringify(theory.recurrence)
    );
    ok(
      "holiday Monday EXDATE'd out of the series",
      !!theory && theory.recurrence && theory.recurrence[1] === "EXDATE;TZID=Asia/Kolkata:20251020T080000",
      theory && JSON.stringify(theory.recurrence)
    );
    ok(
      "no-snapshot course falls back to its code; lab merged 14:00-15:50",
      !!lab && lab.summary === "BCSE204P (L31)" && lab.location === "AB1" &&
        lab.start.dateTime === "2025-10-06T14:00:00" && lab.end.dateTime === "2025-10-06T15:50:00" &&
        lab.recurrence[1] === "EXDATE;TZID=Asia/Kolkata:20251020T140000",
      lab && JSON.stringify({ s: lab.summary, l: lab.location, st: lab.start, en: lab.end, r: lab.recurrence })
    );
    ok(
      "ONE exam event added — upcoming FAT only (past + no-time skipped)",
      singles.length === 1 && singles[0].summary === "FAT exam: CSE1005 — Data Structures",
      JSON.stringify(singles.map((s) => s.summary))
    );
    ok(
      "exam event sits on the exam's own window, after the classes end",
      singles.length === 1 &&
        singles[0].start.dateTime === "2025-11-24T10:00:00" &&
        singles[0].end.dateTime === "2025-11-24T13:00:00" &&
        singles[0].location === "CB-324",
      singles[0] && JSON.stringify({ st: singles[0].start, en: singles[0].end, l: singles[0].location })
    );
    ok(
      "exam description carries slot/session/reporting/seat",
      singles.length === 1 &&
        /Slot: A1/.test(singles[0].description) &&
        /Session: FN1/.test(singles[0].description) &&
        /Reporting: 09:30 AM/.test(singles[0].description) &&
        /Seat: R3C1 · No\. 5/.test(singles[0].description),
      singles[0] && JSON.stringify(singles[0].description)
    );
    const note = await page.evaluate(() => document.querySelector(".vrevamp-tt-note")?.textContent);
    ok(
      "inline confirmation with class/exam counts, end date + replaced count",
      note === "✓ 3 event(s) in Google Calendar — 2 weekly class(es) + 1 exam(s), classes until 2025-11-20, replaced 1 old",
      note
    );
    ok(
      "events tagged for future replacement",
      !!theory && theory.extendedProperties?.private?.vrevamp === "timetable" &&
        singles.length === 1 && singles[0].extendedProperties?.private?.vrevamp === "timetable"
    );

    // dead upstream OAuth client (what every user of the published build
    // hits): the import button must fall back to a panel of one-tap
    // TEMPLATE links — Google's 2026 Calendar revamp broke the
    // /r/settings/import page (never renders), so no download / no Import
    // tab any more
    await page.evaluate(() => {
      delete window.__storage.token;
      window.__storage.google_error =
        "OAuth2 request failed: Service responded with error: 'bad client id: 102739538495-xyz.apps.googleusercontent.com'";
      window.__opened = [];
      window.open = (u) => { window.__opened.push(u); return null; };
      window.__downloads.length = 0;
    });
    await page.evaluate(() => document.getElementById("vrevamp-timetable-gcal").click());
    await delay(800);
    const fb = await page.evaluate(() => {
      const panel = document.getElementById("vrevamp-tt-links");
      return {
        links: panel ? [...panel.querySelectorAll("a")].map((a) => ({ t: a.textContent, h: a.href })) : null,
        dl: window.__downloads[0] || null,
        opened: window.__opened,
        sent: (window.__sent || []).map((m) => m && m.message),
        note: document.getElementById("vrevamp-timetable-gcal").nextElementSibling?.textContent || "",
      };
    });
    ok(
      "dead client → one-tap panel with 2 class links + 1 exam link, no download/Import tab",
      !!fb.links && fb.links.length === 3 && !fb.dl && fb.opened.length === 0 &&
        !fb.sent.includes("ics_import_fallback"),
      JSON.stringify({ n: fb.links && fb.links.length, dl: !!fb.dl, opened: fb.opened })
    );
    ok(
      "class link: prefilled TEMPLATE URL with whole-semester weekly RRULE + venue",
      !!fb.links &&
        fb.links[0].h.startsWith("https://calendar.google.com/calendar/render?action=TEMPLATE") &&
        /text=CSE1005/.test(fb.links[0].h) &&
        fb.links[0].h.includes("dates=20251006T080000/20251006T085000") &&
        fb.links[0].h.includes("ctz=Asia/Kolkata") &&
        fb.links[0].h.includes("recur=RRULE%3AFREQ%3DWEEKLY%3BUNTIL%3D20251121T180000Z"),
      fb.links && fb.links[0].h
    );
    ok(
      "exam link: single event on the exam's own window, no recurrence",
      !!fb.links &&
        fb.links[2].h.includes("dates=20251124T100000/20251124T130000") &&
        !fb.links[2].h.includes("recur=") &&
        /location=CB-324/.test(fb.links[2].h) &&
        /FAT exam/.test(fb.links[2].t),
      fb.links && JSON.stringify(fb.links[2])
    );
    ok(
      "instructive note: counts, end date, click-each-and-Save",
      /one-tap links instead: 2 weekly class\(es\) \+ 1 exam\(s\), classes until 2025-11-20/.test(fb.note) &&
        /press Save/.test(fb.note),
      fb.note.slice(0, 160)
    );
    // clicking a link marks it done (grey + ✓) so the user can keep track
    const clicked = await page.evaluate(() => {
      const a = document.querySelector("#vrevamp-tt-links a");
      a.addEventListener("click", (e) => e.preventDefault()); // don't navigate the test page
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return { t: a.textContent, op: a.style.opacity };
    });
    ok(
      "clicked link greys out with a ✓",
      clicked.t.startsWith("✓ ") && clicked.op === "0.45",
      JSON.stringify(clicked)
    );
    ok(
      "dead client → worker was asked to auto-import the 3 TEMPLATE links first",
      await page.evaluate(
        () =>
          Array.isArray(window.__autoImport) &&
          window.__autoImport.length === 3 &&
          window.__autoImport.every((u) =>
            u.startsWith("https://calendar.google.com/calendar/render?action=TEMPLATE")
          )
      )
    );

    // current worker: the one-click auto-import saves everything itself —
    // success note, no manual panel needed
    await page.evaluate(() => {
      window.__autoImportSaves = 3;
      document.getElementById("vrevamp-tt-links")?.remove();
    });
    await page.evaluate(() => document.getElementById("vrevamp-timetable-gcal").click());
    await delay(800);
    const auto = await page.evaluate(() => ({
      note: document.getElementById("vrevamp-timetable-gcal").nextElementSibling?.textContent || "",
      panel: !!document.getElementById("vrevamp-tt-links"),
    }));
    ok(
      "worker auto-import → ✓ 3/3 saved note, no manual panel",
      /✓ 3\/3 event\(s\) saved to Google Calendar — 2 weekly class\(es\) \+ 1 exam\(s\), classes until 2025-11-20/.test(auto.note) &&
        !auto.panel,
      JSON.stringify(auto)
    );

    // partial auto-import (e.g. one editor never loaded): counts + the
    // panel appears so the user can finish by hand
    await page.evaluate(() => {
      window.__autoImportSaves = 2;
    });
    await page.evaluate(() => document.getElementById("vrevamp-timetable-gcal").click());
    await delay(800);
    const partial = await page.evaluate(() => ({
      note: document.getElementById("vrevamp-timetable-gcal").nextElementSibling?.textContent || "",
      links: document.querySelectorAll("#vrevamp-tt-links a").length,
    }));
    ok(
      "partial auto-import → ✓ 2/3 note + one-tap panel to finish manually",
      /✓ 2\/3 event\(s\) saved/.test(partial.note) &&
        /re-click any that are missing/.test(partial.note) &&
        partial.links === 3,
      JSON.stringify(partial)
    );
    await page.close();
  }

  /* ============ timetable compactor: observer must not storm (freeze) ============ */
  console.log("\n=== timetable compactor: no observer storm ===");
  {
    // #loadMyFragment is VTOP's SPA container — every page load floods it
    // with mutations. Un-debounced + stacking observers re-rendered (and
    // re-PNG'd) the timetable per mutation until the renderer froze
    // ("Page Unresponsive", live 2026-07-07).
    const page = await newPage(browser);
    await page.setContent(`<body><div id='wrap'><div id='loadMyFragment'>
      <table id='timeTableStyle'><tbody><tr><td id='cell'>seed</td></tr></tbody></table>
    </div></div></body>`);
    await shim(page, {});
    // stub the compactor's collaborators so renders are countable
    await page.addScriptTag({ content: `
      window.__renders = 0;
      window.getTimeTable = (cb) => cb(null);
      window.extract_header = () => ["h0", "h1"];
      window.extract_tbody_data = () => [];
      window.filterRepeatedColumns = (h, c) => c;
      window.filterRepeated = (x) => x;
      window.saveTimeTable = () => { window.__renders++; };
      window.createTableHead = () => document.createElement("thead");
      window.createTr = () => document.createElement("tr");
      window._create_td_element = () => document.createElement("td");
      window.create_download_link = () => document.createElement("a");
      window.domtoimage = { toPng: async () => "" };
    `});
    await inject(page, ["js/timetable/timetable.js"]);
    await page.evaluate(() => window.__dispatch("timetable_view_page"));
    // a fragment-load style burst: 40 rapid DOM mutations
    await page.evaluate(() => { for (let i = 0; i < 40; i++) document.getElementById("cell").textContent = "burst1-" + i; });
    await delay(900);
    const first = await page.evaluate(() => window.__renders);
    ok("40-mutation burst renders once (debounced + deduped)", first === 1, `renders=${first}`);
    // message re-fires (SPA) — must not stack a second observer
    await page.evaluate(() => window.__dispatch("timetable_view_page"));
    await page.evaluate(() => { for (let i = 0; i < 40; i++) document.getElementById("cell").textContent = "burst2-" + i; });
    await delay(900);
    const second = await page.evaluate(() => window.__renders);
    ok("re-fired message doesn't stack a second observer", second === 2, `renders=${second}`);
    // mutations that settle back to the same content: no re-render
    await page.evaluate(() => { const c = document.getElementById("cell"); const t = c.textContent; for (let i = 0; i < 10; i++) c.textContent = t; });
    await delay(900);
    const third = await page.evaluate(() => window.__renders);
    ok("unchanged table content isn't re-rendered", third === 2, `renders=${third}`);
    await page.close();
  }

  /* =================== Feature 1+accuracy: attendance insights =================== */
  console.log("\n=== attendance insights: forecaster banner + bunk table ===");
  {
    const fixed = new Date("2025-07-01T10:00:00+05:30").getTime();
    // subject A (CSE1005): 8 present / 2 absent = 80% (safe)
    // subject B (MAT2001): 6 present / 4 absent = 60% (below 75)
    // academic calendar fixtures
    // two onclick dates in the SAME month (real landing pages carry per-day
    // links too) — the month must be fetched once, not once per link, or
    // every instructional day double-counts
    const landing = `<html><body>
      <select><option value=""></option><option value="SEM1">Fall Semester 2025-26</option></select>
      <button onclick="m('01-JUL-2025')">Jul</button>
      <button onclick="m('15-JUL-2025')">today</button>
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
    // the grid lists 7 instructional days; the duplicate July link must not
    // double them (each phantom day inflates remaining + every bunkable cell)
    const instr = calendarWorked ? calendarWorked.instructionalDays : [];
    ok(
      "duplicate same-month links don't double-count instructional days",
      instr.length === 7 && new Set(instr).size === 7,
      `instructionalDays=${JSON.stringify(instr)}`
    );
    await page.close();
  }

  /* ============ attendance insights: 2026 VTOP layout ============ */
  console.log("\n=== attendance insights: new layout (4-arg calls, dd-mm-yyyy, new calendar endpoints) ===");
  {
    const fixed = new Date("2026-01-08T10:00:00+05:30").getTime();
    // detail modal: dd-mm-yyyy dates + a summary row that must NOT be counted.
    // perDay=2 mimics a summer theory course meeting twice daily — it must
    // still be reported in class(es), not mislabeled a lab.
    const hist = (p, a, perDay = 1) => {
      let rows = "", n = 0;
      const mk = (s) => {
        const d = Math.floor(n / perDay) + 1;
        n += 1;
        return `<tr><td>${n}</td><td>${String(d).padStart(2, "0")}-01-2026</td><td>A1</td><td>MON / 08:00-08:50</td><td>${s}</td><td></td></tr>`;
      };
      let out = "";
      for (let i = 0; i < p; i++) out += mk("Present");
      for (let i = 0; i < a; i++) out += mk("Absent");
      const summary = `<tr><td>General (Semester)</td><td>01-01-2026 10:00:00</td><td>Present : ${p} Absent : ${a} Total Class : ${p + a} Percentage : ${Math.round((p / (p + a)) * 100)}%</td></tr>`;
      return "<table><tbody>" + summary + out + "</tbody></table>";
    };
    // last posting 29 Dec; two of its class days (5 & 7 Jan, instructional)
    // have since passed unposted -> must be flagged stale
    // lab register that only ever posted ONE of its two weekly days
    // (Tuesdays), like a lagging faculty register — the slot string in the
    // row (2 L-pairs) must trigger the partial-register warning
    const labHistTue = `<table><tbody>
      <tr><td>1</td><td>30-12-2025</td><td>L31</td><td>TUE</td><td>Present</td></tr>
      <tr><td>2</td><td>06-01-2026</td><td>L31</td><td>TUE</td><td>Absent</td></tr>
    </tbody></table>`;
    // all-Present so the uncapped CAT-1 bunkable (2) would exceed the 1
    // class that actually remains before CAT-1 — must be capped to 1
    // nested inside a wrapper table, like live modals — the wrapper <tr>'s
    // joined text carries a date + "Present" and must NOT become an 11th entry
    const histStale = (() => {
      let out = "";
      for (let i = 0; i < 10; i++)
        out += `<tr><td>${i + 1}</td><td>${20 + i}-12-2025</td><td>A1</td><td>X</td><td>Present</td></tr>`;
      return (
        "<table><tbody><tr><td><table><tbody>" + out +
        "</tbody></table></td></tr></tbody></table>"
      );
    })();
    // 1/3 present with a register hole: timetable says MON/WED/FRI, entries
    // exist for 5 & 9 & 12 Jan but the scheduled 7 Jan has none — must get
    // the gap note; 1/3 must display VTOP-style as 34%, not 33%
    const histGap = `<table><tbody>
      <tr><td>1</td><td>05-01-2026</td><td>C1</td><td>MON</td><td>Present</td></tr>
      <tr><td>2</td><td>09-01-2026</td><td>C1</td><td>FRI</td><td>Absent</td></tr>
      <tr><td>3</td><td>12-01-2026</td><td>C1</td><td>MON</td><td>Absent</td></tr>
    </tbody></table>`;
    const calLanding = `<html><body>
      <select id="semesterSubId"><option value=""></option><option value="AP2025264">Winter Semester 2025-26</option></select>
      <select id="classGroupId"><option value="COMB">All Class Group (Combined)</option></select>
      </body></html>`;
    const calMonths = `<html><body><button onclick="processViewCalendar('01-JAN-2026')">Jan</button></body></html>`;
    const calGrid = `<html><body><table><tbody><tr>
      <td>05 Instructional Day - General (Semester)</td><td>07 Instructional Day - General (Semester)</td>
      <td>09 Instructional Day - General (Semester)</td><td>10 CAT - I - General (Semester)</td>
      <td>12 Instructional Day - General (Semester)</td><td>14 Instructional Day - General (Semester)</td>
      <td>15 Holiday - General (Semester)</td><td>16 Instructional Day - General (Semester)</td>
      <td>17 Final Assessment Test (Laboratory) - General (Semester)</td>
      <td>18 Instructional Day - General (Semester)</td><td>20 Final Assessment Test - General (Semester)</td>
      </tr></tbody></table></body></html>`;

    const page = await newPage(browser);
    await page.route("https://vtop.vitap.ac.in/**", (route) => {
      if (route.request().resourceType() === "document")
        return route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" });
      return route.abort();
    });
    await page.goto("https://vtop.vitap.ac.in/vtop/attendance");
    // cached timetable: CSE1005's entry is stale (a PREVIOUS semester —
    // says Mondays only, but its current history meets Thu/Fri/Sat on 2+
    // dates each, so it must be ignored). SWE2088's entry is current:
    // theory spread over 3 days plus lab pairs on TUE and FRI — the lab row
    // must use ONLY the lab cells (2 sessions/week), not absorb the theory.
    await shim(page, {
      fixedMs: fixed,
      storage: {
        "timeTable-V1": {
          header: ["Start - End", "09:00 - 09:50", "10:00 - 10:50", "11:00 - 11:50"],
          data: [
            { day: "MON",
              theory: ["", "A1-CSE1005-ETH-AB1-CB-ALL", "TA1-SWE2088-ETH-511-CB-ALL", "C1-GAP1001-ETH-512-CB-ALL"],
              lab: ["", "", "", ""] },
            { day: "TUE",
              theory: ["", "TB1-SWE2088-ETH-511-CB-ALL", "", ""],
              lab: ["", "", "L31-SWE2088-ELA-409-CB-ALL", "L32-SWE2088-ELA-409-CB-ALL"] },
            { day: "WED",
              theory: ["", "C2-GAP1001-ETH-512-CB-ALL", "", ""],
              lab: ["", "", "", ""] },
            { day: "FRI",
              theory: ["", "TC1-SWE2088-ETH-511-CB-ALL", "", "TC2-GAP1001-ETH-512-CB-ALL"],
              lab: ["", "", "L43-SWE2088-ELA-409-CB-ALL", "L44-SWE2088-ELA-409-CB-ALL"] },
          ],
        },
      },
    });
    await page.addScriptTag({ content: `
      window.fetch = async (url, opts) => {
        const body = (opts && opts.body) || "";
        const text = async () => {
          if (/processViewAttendanceDetail/.test(url)) {
            const m = /courseId=([^&]+)/.exec(body); const id = m ? decodeURIComponent(m[1]) : "";
            const ct = /courseType=([^&]+)/.exec(body);
            if (id.includes("PHY1999")) return ${JSON.stringify(histStale)};
            if (id.includes("GAP1001")) return ${JSON.stringify(histGap)};
            // like live VTOP: the lab's register comes back ONLY for its own
            // courseType — with courseType=TH (e.g. leaked from a template
            // captured off a theory row) it returns the theory register
            if (id.includes("SWE2077") || id.includes("SWE2088"))
              return ct && ct[1] === "LO" ? ${JSON.stringify(labHistTue)} : ${JSON.stringify(hist(8, 2))};
            return id.includes("CSE1005") ? ${JSON.stringify(hist(8, 2))} : ${JSON.stringify(hist(6, 4, 2))};
          }
          if (/CalendarPreview/.test(url)) return ${JSON.stringify(calLanding)};
          if (/getDateForSemesterPreview/.test(url)) return ${JSON.stringify(calMonths)};
          if (/processViewCalendar/.test(url)) return ${JSON.stringify(calGrid)};
          return "";
        };
        return { ok: true, status: 200, text };
      };
    ` });
    await page.evaluate(() => {
      document.body.innerHTML = `
        <input name="_csrf" value="csrf123">
        <input id="authorizedIDX" value="24MIC7198">
        <select id="semesterSubId"><option selected>Winter Semester 2025-26</option></select>
        <div class="table-responsive"><table><tbody>
          <tr><td>CSE1005 - Course A - Theory Only</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2025264','24MIC7198','AM_CSE1005_00100','TH')">view</a></td></tr>
          <tr><td>MAT2001 - Course B - Theory Only</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2025264','24MIC7198','AM_MAT2001_00200','TH')">view</a></td></tr>
          <tr><td>PHY1999 - Course C - Theory Only</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2025264','24MIC7198','AM_PHY1999_00300','TH')">view</a></td></tr>
          <tr><td>GAP1001 - Course F - Theory Only</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2025264','24MIC7198','AM_GAP1001_00600','TH')">view</a></td></tr>
          <tr><td>SWE2077 - Course D - Embedded Lab</td><td>AP2025264000340 - L31+L32+L43+L44 - 409</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2025264','24MIC7198','AM_SWE2077_00400','LO')">view</a></td></tr>
          <tr><td>SWE2088 - Course E - Embedded Lab</td><td>AP2025264000341 - L31+L32+L43+L44 - 409</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2025264','24MIC7198','AM_SWE2088_00500','LO')">view</a></td></tr>
        </tbody></table></div>`;
    });
    await inject(page, [
      "js/store/store.js",
      "js/store/saveTimeTableDetails.js",
      "js/attendance_insights.js",
    ]);
    await page.evaluate(() => window.__dispatch("view_attendance"));
    await delay(2500);

    const banner = await page.evaluate(() => {
      const el = document.getElementById("vrevamp-forecast-banner");
      return el ? el.textContent : null;
    });
    ok("banner rendered (new layout)", !!banner, banner ? banner.slice(0, 80) + "…" : "none");
    ok("MAT2001 (60%) flagged with recover count", !!banner && /MAT2001[\s\S]*60% — attend the next \d+/.test(banner));
    // meets twice daily (summer pattern) but says "Theory Only" -> class(es)
    ok(
      "twice-daily theory NOT mislabeled as lab (6 classes to recover)",
      !!banner && /MAT2001[\s\S]*attend the next 6 class\(es\)/.test(banner),
      banner ? banner.slice(banner.indexOf("MAT2001"), banner.indexOf("MAT2001") + 80) : ""
    );
    const table = await page.evaluate(() => {
      const c = document.getElementById("vrevamp-bunk-table-container");
      if (!c) return null;
      return [...c.querySelectorAll("tr")].map((tr) => [...tr.children].map((td) => td.textContent));
    });
    const heldVals = table ? table.filter((r) => /CSE1005|MAT2001/.test(r[0])).map((r) => r[1]) : [];
    ok(
      "held = 10 for both (summary row NOT counted)",
      heldVals.length === 2 && heldVals.every((v) => v === "10"),
      JSON.stringify(heldVals)
    );
    // staleness: PHY1999 stopped posting 29 Dec (2 class days ago) -> flagged;
    // the up-to-date subjects must NOT be
    const staleCells = table
      ? table.filter((r) => /not posted since/.test(r[0])).map((r) => r[0])
      : [];
    ok(
      "lagging register flagged unreliable with its last-posted date",
      staleCells.length === 1 &&
        /PHY1999/.test(staleCells[0]) &&
        /not posted since 29 Dec/.test(staleCells[0]) &&
        /unreliable/.test(staleCells[0]),
      staleCells.join(" || ").slice(0, 120) || "no stale flag"
    );
    ok(
      "banner warns about the stale subject",
      !!banner && /PHY1999[\s\S]*not posted since 29 Dec/.test(banner)
    );
    // remaining after 8 Jan = instructional days 9,12,14,16,18 -> 5 classes
    // by history; the stale Mondays-only timetable would say 1
    const cseRow = table && table.find((r) => /CSE1005/.test(r[0]));
    ok(
      "contradicted cached timetable ignored (CSE remaining = 5, not 1)",
      !!cseRow && /^5(?!\d)/.test(cseRow[2]),
      cseRow ? `remaining=${cseRow[2]}` : "no row"
    );
    // best-case projection under the remaining cell: (8+5)/(10+5) = 87%
    ok(
      "attend-all projection shown (CSE -> 87%)",
      !!cseRow && /attend all → 87%/.test(cseRow[2]),
      cseRow ? cseRow[2] : "no row"
    );
    // debar forecast under safe-now: CSE is at exactly 80%; one skipped
    // class (9 Jan) drops it to 8/11 = 72.7%
    ok(
      "debar forecast (CSE: <75% on 9 Jan if skipping)",
      !!cseRow && /^0(?!\d)/.test(cseRow[3]) && /<75% on 9 Jan/.test(cseRow[3]),
      cseRow ? cseRow[3] : "no row"
    );
    const phyRow = table && table.find((r) => /PHY1999/.test(r[0]));
    ok(
      "wrapper row of a nested register table not counted (PHY held = 10)",
      !!phyRow && phyRow[1] === "10",
      phyRow ? `held=${phyRow[1]}` : "no row"
    );
    ok(
      "bunkable capped at classes that actually remain (CAT-1: 1, not 2)",
      !!phyRow && phyRow[4] === "1",
      phyRow ? `cat1=${phyRow[4]}` : "no row"
    );
    // never-dip column: PHY 10/10 -> floor((40-30)/3) = 3 (within the 5
    // remaining); CSE 8/10 (80%) -> floor((32-30)/3) = 0
    ok(
      "safe-to-skip-now (never <75%) = 3 for the 100% subject",
      !!phyRow && /^3(?!\d)/.test(phyRow[3]),
      phyRow ? `safeNow=${phyRow[3]}` : "no row"
    );
    ok(
      "debar forecast for the 100% subject (<75% on 16 Jan)",
      !!phyRow && /<75% on 16 Jan/.test(phyRow[3]),
      phyRow ? phyRow[3] : "no row"
    );
    const cseSafe = table && table.find((r) => /CSE1005/.test(r[0]));
    ok(
      "safe-to-skip-now = 0 at exactly 80%",
      !!cseSafe && /^0(?!\d)/.test(cseSafe[3]),
      cseSafe ? `safeNow=${cseSafe[3]}` : "no row"
    );
    // the request template resolved off the first (Theory) row must not
    // leak courseType=TH into the lab's fetch — or it shows theory data
    const labRow = table && table.find((r) => /SWE2077/.test(r[0]));
    ok(
      "lab row fetches its OWN register (held 2, not theory's 10)",
      !!labRow && labRow[1] === "2",
      labRow ? `held=${labRow[1]}` : "no row"
    );
    ok(
      "partial lab register flagged (slots say 2 days/week, register shows 1)",
      !!labRow && /register shows only 1 of ~2 weekly lab day/.test(labRow[0]),
      labRow ? labRow[0].slice(0, 140) : "no row"
    );
    // SWE2088 has a current cached timetable: lab pairs TUE+FRI. Its lab row
    // must use only the LAB cells — remaining after 8 Jan = FRI 9 + FRI 16
    // = 2 lab sessions (not the theory's 3 days, not theory+lab combined) —
    // and with both weekly days known, no partial-register warning.
    const lab88 = table && table.find((r) => /SWE2088/.test(r[0]));
    ok(
      "timetable lab kind separated from theory (SWE2088 remaining = 2 lab(s))",
      !!lab88 && /^2 lab\(s\)/.test(lab88[2]),
      lab88 ? `remaining=${lab88[2]}` : "no row"
    );
    ok(
      "no partial warning when the timetable covers both lab days",
      !!lab88 && !/register shows only/.test(lab88[0])
    );
    // VTOP ceils percentages (1/3 -> 34%) — the banner must match it, and
    // the exact ratio (not the displayed 34) must drive the below-75 flag.
    // Only 4 classes remain (MON/WED/FRI till 18 Jan), so 75% is out of
    // reach: (1+4)/(3+4) = 71% — the banner must say that instead of the
    // impossible "attend the next 5"
    ok(
      "GAP1001 1/3 shown VTOP-style as 34%, unreachable 75% said honestly",
      !!banner && /GAP1001[\s\S]*34% — can't reach 75% this sem even attending everything \(max 71%\)/.test(banner),
      banner ? banner.slice(banner.indexOf("GAP1001"), banner.indexOf("GAP1001") + 110) : "no banner"
    );
    // register-completeness: scheduled 7 Jan (WED per timetable) has no
    // entry between the posted 5 Jan and 12 Jan — must be surfaced
    const gapRow = table && table.find((r) => /GAP1001/.test(r[0]));
    ok(
      "register hole flagged (no entry for scheduled 7 Jan)",
      !!gapRow && /no entry for 1 scheduled class day\(s\): 7 Jan/.test(gapRow[0]),
      gapRow ? gapRow[0].slice(0, 140) : "no row"
    );
    ok(
      "no gap note on a continuous register (CSE1005)",
      !!cseRow && !/no entry for/.test(cseRow[0])
    );
    // rows the saved timetable can't schedule say so: MAT2001 is absent
    // from it, CSE1005's cached entry contradicts its own history
    const matRow = table && table.find((r) => /MAT2001/.test(r[0]));
    ok(
      "course missing from saved timetable gets the coverage note",
      !!matRow && /not in the saved timetable/.test(matRow[0]),
      matRow ? matRow[0].slice(0, 140) : "no row"
    );
    ok(
      "contradicted timetable entry gets the disagree note",
      !!cseRow && /saved timetable disagrees with this register/.test(cseRow[0])
    );
    // VTOP's own table row also carries the stale nudge
    const vtopStale = await page.evaluate(() => {
      const row = [...document.querySelectorAll(".table-responsive tbody tr")]
        .find((r) => /PHY1999/.test(r.innerText));
      const flag = row && row.querySelector(".vrevamp-stale-flag");
      return flag ? flag.textContent : null;
    });
    ok(
      "stale flag shown on VTOP's own attendance row",
      !!vtopStale && /not posted since 29 Dec/.test(vtopStale),
      vtopStale || "no flag"
    );
    // richer snapshot for the home card / marks page
    const snap = await page.evaluate(
      () => (window.__storage.vrevamp_attendance_summary || {}).subjects || []
    );
    const phySnap = snap.find((s) => s.code === "PHY1999");
    ok(
      "snapshot carries code/pct/safeNow (PHY1999: 100%, 3 safe)",
      !!phySnap && phySnap.pct === 100 && phySnap.safeNow === 3,
      JSON.stringify(phySnap)
    );
    // what-if simulator: open CSE's row, skip one -> 8/11 = 72.7%
    const whatIf = await page.evaluate(() => {
      const row = [...document.querySelectorAll("#vrevamp-bunk-table-container tr")]
        .find((r) => /CSE1005/.test(r.textContent));
      const cell = row.cells[0];
      cell.click();
      const skipBtn = [...cell.querySelectorAll("button")]
        .find((b) => b.textContent === "Skip +1");
      skipBtn.click();
      const sim = cell.querySelector(".vrevamp-whatif");
      return { visible: sim.style.display !== "none", text: sim.textContent };
    });
    ok(
      "what-if: skip one on 8/10 -> 8/11 = 72.7%",
      whatIf.visible && /1 skipped, 0 attended → 8\/11 = 72\.7%/.test(whatIf.text),
      whatIf.text.slice(0, 90)
    );
    const cal = await page.evaluate(() => {
      const all = window.__storage;
      const k = Object.keys(all).find((x) => x.startsWith("vrevamp_calendar_"));
      return k ? all[k] : null;
    });
    ok(
      "calendar parsed via new endpoints (CAT-1 + FAT dates)",
      !!cal && cal.cat1 === "2026-01-10" && cal.fat === "2026-01-20",
      cal ? `cat1=${cal.cat1} fat=${cal.fat}` : "no calendar"
    );
    // the 17th is "Final Assessment Test (Laboratory)": it must land in
    // labFat and must NOT drag the theory FAT date earlier
    ok(
      "lab FAT day (17th) split from theory FAT (20th)",
      !!cal && cal.labFat === "2026-01-17" && cal.fat === "2026-01-20",
      cal ? `labFat=${cal.labFat} fat=${cal.fat}` : "no calendar"
    );
    // lab rows sit no CATs: CAT columns say so, and their next-exam math
    // runs to the lab FAT instead of CAT-1
    ok(
      "lab row CAT columns say 'no CATs for labs'",
      !!lab88 && lab88[4] === "no CATs for labs" && lab88[5] === "no CATs for labs",
      lab88 ? `cat1=${lab88[4]} cat2=${lab88[5]}` : "no row"
    );
    ok(
      "theory rows keep their CAT numbers",
      !!phyRow && phyRow[4] === "1",
      phyRow ? `cat1=${phyRow[4]}` : "no row"
    );
    await page.close();
  }

  /* ==== attendance insights: finished semester (live 2026-07-07 report) ==== */
  console.log("\n=== attendance insights: finished semester, digit-CAT calendar, quiet empty registers ===");
  {
    // Viewing an OLD semester in July: calendar labels use digits ("CAT - 1"),
    // there is no CAT-2 at all (short-summer style), one course was dropped
    // before any class (0/0 — its register must not even be probed), and one
    // register answers 200 with no rows (must not warn: live this threw the
    // legacy candidate's 404 as "subject insight failed" on every load)
    const fixed = new Date("2026-07-07T10:00:00+05:30").getTime();
    const hist8of10 = (() => {
      let out = "";
      for (let i = 0; i < 10; i++)
        out += `<tr><td>${i + 1}</td><td>${String(i + 1).padStart(2, "0")}-01-2026</td><td>A1</td><td>X</td><td>${i < 8 ? "Present" : "Absent"}</td></tr>`;
      return "<table><tbody>" + out + "</tbody></table>";
    })();
    const calLanding = `<html><body>
      <select id="semesterSubId"><option value=""></option><option value="AP2024999">Winter Semester 2024-25 Freshers</option></select>
      <select id="classGroupId"><option value="COMB">All Class Group (Combined)</option></select>
      </body></html>`;
    const calMonths = `<html><body><button onclick="processViewCalendar('01-JAN-2026')">Jan</button></body></html>`;
    const calGrid = `<html><body><table><tbody><tr>
      <td>05 Instructional Day - General (Semester)</td><td>07 Instructional Day - General (Semester)</td>
      <td>09 Instructional Day - General (Semester)</td><td>10 CAT - 1 - General (Semester)</td>
      <td>12 Instructional Day - General (Semester)</td><td>14 Instructional Day - General (Semester)</td>
      <td>16 Instructional Day - General (Semester)</td><td>18 Instructional Day - General (Semester)</td>
      <td>20 Final Assessment Test - General (Semester)</td>
      </tr></tbody></table></body></html>`;

    const page = await newPage(browser);
    await page.route("https://vtop.vitap.ac.in/**", (route) => {
      if (route.request().resourceType() === "document")
        return route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" });
      return route.abort();
    });
    await page.goto("https://vtop.vitap.ac.in/vtop/attendance");
    await shim(page, { fixedMs: fixed, storage: {} });
    await page.addScriptTag({ content: `
      window.__detailCalls = {};
      window.__warns = [];
      const origWarn = console.warn.bind(console);
      console.warn = (...a) => { window.__warns.push(a.map(String).join(" ")); origWarn(...a); };
      window.fetch = async (url, opts) => {
        const body = (opts && opts.body) || "";
        if (/AttendanceDetail/i.test(url)) {
          const m = /courseId=([^&]+)/.exec(body);
          const id = m ? decodeURIComponent(m[1]) : "(none)";
          window.__detailCalls[id] = (window.__detailCalls[id] || 0) + 1;
        }
        const good =
          /processViewAttendanceDetail|CalendarPreview|getDateForSemesterPreview|processViewCalendar/.test(url);
        if (!good) return { ok: false, status: 404, text: async () => "" };
        const text = async () => {
          if (/processViewAttendanceDetail/.test(url)) {
            const m = /courseId=([^&]+)/.exec(body); const id = m ? decodeURIComponent(m[1]) : "";
            if (id.includes("CHY1008")) return ${JSON.stringify(hist8of10)};
            return ""; // EMP1111: 200 but an empty register
          }
          if (/CalendarPreview/.test(url)) return ${JSON.stringify(calLanding)};
          if (/getDateForSemesterPreview/.test(url)) return ${JSON.stringify(calMonths)};
          if (/processViewCalendar/.test(url)) return ${JSON.stringify(calGrid)};
          return "";
        };
        return { ok: true, status: 200, text };
      };
    ` });
    await page.evaluate(() => {
      document.body.innerHTML = `
        <input name="_csrf" value="csrf123">
        <input id="authorizedIDX" value="24MIC7198">
        <select id="semesterSubId"><option selected>Winter Semester 2024-25 Freshers</option></select>
        <div class="table-responsive"><table>
          <thead><tr><th>Course Detail</th><th>Attended Classes</th><th>Total Classes</th><th>Attendance Detail</th></tr></thead>
          <tbody>
          <tr><td>CHY1008 - Chemistry - Theory Only</td><td>8</td><td>10</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2024999','24MIC7198','AM_CHY1008_00100','TH')">view</a></td></tr>
          <tr><td>NEW0000 - Dropped Course - Theory Only</td><td>0</td><td>0</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2024999','24MIC7198','AM_NEW0000_00200','TH')">view</a></td></tr>
          <tr><td>EMP1111 - Ghost Register - Theory Only</td><td>5</td><td>5</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2024999','24MIC7198','AM_EMP1111_00300','TH')">view</a></td></tr>
        </tbody></table></div>`;
    });
    await inject(page, [
      "js/store/store.js",
      "js/store/saveTimeTableDetails.js",
      "js/attendance_insights.js",
    ]);
    await page.evaluate(() => window.__dispatch("view_attendance"));
    await delay(2500);

    const state = await page.evaluate(() => {
      const c = document.getElementById("vrevamp-bunk-table-container");
      return {
        rows: c
          ? [...c.querySelectorAll("tr")].map((tr) => [...tr.children].map((td) => td.textContent))
          : null,
        detailCalls: window.__detailCalls,
        warns: window.__warns.filter((w) => /insight failed/.test(w)),
      };
    });
    const chy = state.rows && state.rows.find((r) => /CHY1008/.test(r[0]));
    ok(
      "digit 'CAT - 1' parsed: retrospective could've-bunked shown",
      !!chy && /could've bunked 1(?!\d)/.test(chy[4]),
      chy ? `cat1=${chy[4]}` : "no row"
    );
    ok(
      "no CAT-2 in this calendar -> 'none this sem' (not --)",
      !!chy && /none this sem/.test(chy[5]),
      chy ? `cat2=${chy[5]}` : "no row"
    );
    ok(
      "FAT retrospective on the finished sem (could've bunked 0)",
      !!chy && /could've bunked 0/.test(chy[6]),
      chy ? `fat=${chy[6]}` : "no row"
    );
    ok(
      "finished sem says so: 'semester over — final 80%' + 'semester over'",
      !!chy && /semester over — final 80%/.test(chy[2]) && /semester over/.test(chy[3]),
      chy ? `remaining=${chy[2]} safeNow=${chy[3]}` : "no row"
    );
    ok(
      "0/0 course's register never probed",
      !Object.keys(state.detailCalls).some((k) => k.includes("NEW0000")),
      JSON.stringify(state.detailCalls)
    );
    ok(
      "empty register (200, no rows) does NOT warn 'subject insight failed'",
      state.warns.length === 0,
      state.warns[0] || "no warns"
    );
    await page.close();
  }

  /* ============ marks page: totals row on the 2026 layout ============ */
  console.log("\n=== marks page: header-driven totals + attendance badge ===");
  {
    // 2026 layout: 8 columns, NO Class Average — the old fixed-index parser
    // emitted NaN and a 10-cell row here
    const page = await newPage(browser);
    await page.setContent(`<body><div class="box-body">
      <table><tbody><tr>
        <td>SWE2007 - Introduction to Operating Systems - Embedded Lab</td>
      </tr></tbody></table>
      <table class="customTable-level1"><tbody>
        <tr><th>Sl.No.</th><th>Mark Title</th><th>Max. Mark</th><th>Weightage %</th><th>Status</th><th>Scored Mark</th><th>Weightage Mark</th><th>Remark</th></tr>
        <tr class="tableContent-level1"><td>1</td><td>QUIZ3</td><td>10</td><td>10</td><td>Present</td><td>10.0</td><td>10</td><td></td></tr>
        <tr class="tableContent-level1"><td>2</td><td>CAT1</td><td>50</td><td>15</td><td>Present</td><td>40.0</td><td>12</td><td></td></tr>
      </tbody></table>
    </div></body>`);
    await shim(page, {
      storage: {
        vrevamp_attendance_summary: {
          fetchedAt: Date.now(),
          subjects: [{ name: "SWE2007 - Embedded Lab", code: "SWE2007", pct: 50, safeNow: 0, unit: "lab(s)" }],
        },
      },
    });
    await inject(page, ["js/store/store.js", "js/store/saveMarksPage.js", "js/marks_page.js"]);
    await page.evaluate(() => window.__dispatch("mark_view_page"));
    await delay(500);
    const totals = await page.evaluate(() => {
      const tr = document.querySelector(".vrevamp-marks-total");
      return tr ? [...tr.children].map((c) => c.textContent.trim()) : null;
    });
    ok(
      "totals row has exactly the table's 8 columns",
      !!totals && totals.length === 8,
      totals ? `${totals.length} cells` : "no totals row"
    );
    ok(
      "totals by header: max 60, w% 25, scored 50, wMark 22, lost 3",
      !!totals &&
        totals[2] === "60.00" &&
        totals[3] === "25.00" &&
        totals[5] === "50.00" &&
        totals[6] === "22.00" &&
        totals[7] === "Lost: 3.00",
      JSON.stringify(totals)
    );
    ok("no NaN anywhere in the totals", !!totals && !totals.some((t) => /NaN/.test(t)));
    // repeated message must not duplicate the row
    await page.evaluate(() => window.__dispatch("mark_view_page"));
    await delay(300);
    const rowCount = await page.evaluate(
      () => document.querySelectorAll(".vrevamp-marks-total").length
    );
    ok("totals row not duplicated on message re-fire", rowCount === 1, `rows=${rowCount}`);
    const badge = await page.evaluate(() => {
      const b = document.querySelector("[data-vrevamp-att-flag]");
      return b ? b.textContent : null;
    });
    ok(
      "attendance-risk badge on the course row (50%)",
      !!badge && /attendance 50%/.test(badge),
      badge || "no badge"
    );
    await page.close();
  }

  /* ============ attendance: auto-semester with empty-sem fallback ============ */
  console.log("\n=== attendance auto-semester: triggers load, steps past empty semesters ===");
  {
    // sem-transition window: Fall 2026-27 exists in the dropdown (started
    // 4 days ago per the heuristic) but every course is 0/0 — registered,
    // no attendance posted; Summer II has no table at all. The auto-select
    // must trigger VTOP's own onchange load and walk down to Winter
    // 2025-26, the newest semester with actual attendance.
    const fixed = new Date("2026-07-05T10:00:00+05:30").getTime();
    const page = await newPage(browser);
    await page.setContent(`<body><div class="box-body">
      <select id="semesterSubId">
        <option value="">-- Choose Semester --</option>
        <option value="AP2026272">FALL SEMESTER 2026-27 - AMR</option>
        <option value="AP2025267">Summer Semester-II 2025-26 - AMR</option>
        <option value="AP2025264">Winter Semester 2025-26 - AMR</option>
      </select>
      <div id="content-area"></div>
    </div></body>`);
    await shim(page, { fixedMs: fixed });
    // stand-in for VTOP's processStudentAttendance(): render rows only for
    // Winter, then fire view_attendance like the service worker would
    await page.addScriptTag({ content: `
      window.__semChanges = 0;
      const sel = document.getElementById("semesterSubId");
      sel.addEventListener("change", () => {
        window.__semChanges++;
        const t = sel.options[sel.selectedIndex].text;
        const c = document.getElementById("content-area");
        const tbl = (rows) =>
          '<div class="table-responsive"><table>' +
          '<thead><tr><th>Sl.No.</th><th>Course Detail</th><th>Attended Classes</th><th>Total Classes</th></tr></thead>' +
          "<tbody>" + rows + "</tbody></table></div>";
        if (/winter/i.test(t))
          c.innerHTML = tbl("<tr><td>1</td><td>ECE2015 - Theory</td><td>48</td><td>58</td></tr>");
        else if (/fall/i.test(t))
          // registered courses, nothing posted yet — must count as "no data"
          c.innerHTML = tbl("<tr><td>1</td><td>SWE2009 - Theory</td><td>0</td><td>0</td></tr>");
        else c.innerHTML = "";
        setTimeout(() => window.__dispatch("view_attendance"), 50);
      });
    ` });
    await inject(page, [
      "js/store/store.js",
      "js/store/saveAttendancePage.js",
      "js/utils/chooseCurrentSem.js",
      "js/attendance.js",
    ]);
    await page.evaluate(() => window.__dispatch("view_attendance_page"));
    await delay(3000);

    const state = await page.evaluate(() => {
      const sel = document.getElementById("semesterSubId");
      return {
        selected: sel.options[sel.selectedIndex].text,
        changes: window.__semChanges,
        rows: document.querySelectorAll(".table-responsive tbody tr").length,
        alert: (document.querySelector(".vrevamp-bunk-cell") || {}).textContent || null,
      };
    });
    ok(
      "walked Fall 26-27 -> Summer II -> Winter (3 loads, stops there)",
      /winter/i.test(state.selected) && state.changes === 3,
      `selected="${state.selected}" loads=${state.changes}`
    );
    ok("attendance rows loaded without manual reselect", state.rows === 1);
    // 48/58 at the 75% limit -> floor((4*48 - 3*58)/3) = 6 skippable
    ok(
      "75% alert column decorated on the auto-loaded table",
      state.alert === "Only 6 class(es) can be Skipped",
      state.alert || "no alert cell"
    );

    // loop regression: a repeated view_attendance_page (e.g. a detail fetch
    // misrouted by the service worker) must NOT re-trigger a load while
    // usable data is on screen
    await page.evaluate(() => window.__dispatch("view_attendance_page"));
    await delay(1200);
    const after = await page.evaluate(() => ({
      changes: window.__semChanges,
      selected: document.getElementById("semesterSubId").selectedOptions[0].text,
    }));
    ok(
      "repeated page message does not reload (no loop)",
      after.changes === 3 && /winter/i.test(after.selected),
      `loads=${after.changes} selected="${after.selected}"`
    );
    await page.close();
  }

  /* ============ login page: reload guard (flicker regression) ============ */
  console.log("\n=== login page: refreshTillCaptcha must not reload-loop ===");
  {
    // real navigations on a routed origin: sessionStorage works and persists
    // across loads (about:blank/setContent documents deny it)
    const pages = {
      "/picker": "<body><div class='card'>Student</div><div class='card'>Employee</div></body>",
      "/empty": "<body>   </body>",
      "/captcha": "<body><form><img class='form-control' alt='captcha'></form></body>",
    };
    const page = await newPage(browser);
    await page.route("https://vtop.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      route.fulfill({ contentType: "text/html", body: pages[path] || "<body></body>" });
    });
    // capture scheduled reloads instead of letting them navigate the page
    const trapReloads = `(() => {
      window.__reloads = 0;
      const _st = window.setTimeout;
      window.setTimeout = function (fn, ms) {
        if (typeof fn === "function" && String(fn).includes("reload")) {
          window.__reloads++;
          return 0;
        }
        return _st.call(window, fn, ms);
      };
    })();`;
    const state = () =>
      page.evaluate(() => ({
        reloads: window.__reloads,
        counter: sessionStorage.getItem("vrevamp_login_reloads"),
      }));

    // 2026 role-picker login page: rendered content, no captcha, no #stdForm
    await page.goto("https://vtop.test/picker");
    await page.addScriptTag({ content: trapReloads });
    await inject(page, ["js/captcha/refreshTillCaptcha.js"]);
    const picker = await state();
    ok("role-picker login page is NOT reloaded", picker.reloads === 0, `reloads=${picker.reloads}`);

    // genuinely empty page: reload allowed, but capped at 2 per tab
    await page.goto("https://vtop.test/empty");
    await page.addScriptTag({ content: trapReloads });
    for (let i = 0; i < 4; i++) await inject(page, ["js/captcha/refreshTillCaptcha.js"]);
    const empty = await state();
    ok(
      "empty page retried at most twice",
      empty.reloads === 2 && empty.counter === "2",
      `reloads=${empty.reloads} counter=${empty.counter}`
    );

    // captcha present: counter resets so the next broken load can retry again
    await page.goto("https://vtop.test/captcha");
    await page.addScriptTag({ content: trapReloads });
    await inject(page, ["js/captcha/refreshTillCaptcha.js"]);
    const captcha = await state();
    ok(
      "captcha page not reloaded and counter cleared",
      captcha.reloads === 0 && captcha.counter === null,
      `reloads=${captcha.reloads} counter=${captcha.counter}`
    );
    await page.close();
  }

  /* ============ exam schedule (2026): header-driven .ics export ============ */
  console.log("\n=== exam schedule (2026): per-group .ics export + 🔔 reminders ===");
  {
    // 1 Apr 2026: FAT's ECE2015 (04-May) is upcoming, FRL1001 (10-Feb) and
    // all of CAT1 (10-Mar) are past, PHY0000 has no published time
    const fixedExam = new Date("2026-04-01T09:00:00+05:30").getTime();
    const gcalExam = [];
    const page = await newPage(browser);
    await page.route("https://www.googleapis.com/**", (route) => {
      gcalExam.push(JSON.parse(route.request().postData() || "{}"));
      route.fulfill({ contentType: "application/json", body: "{}" });
    });
    await page.setContent(`<body>
      <select id="semesterSubId"><option selected>Winter Semester 2025-26</option></select>
      <table class="customTable">
        <tr><td>General (Semester)</td></tr>
        <tr><td>S.No.</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Class ID</td><td>Slot</td>
            <td>Exam Date</td><td>Exam Session</td><td>Reporting Time</td><td>Exam Time</td><td>Venue</td>
            <td>Seat Location</td><td>Seat No.</td></tr>
        <tr><td class="panelHead-secondary">FAT</td></tr>
        <tr><td>1</td><td>ECE2015</td><td>Computer Architecture</td><td>TH</td><td>AP1</td><td>A1</td>
            <td>04-May-2026</td><td>FN1</td><td>09:30 AM</td><td>10:00 AM - 01:00 PM</td><td>CB-324</td>
            <td>R3C1</td><td>5</td></tr>
        <tr><td>2</td><td>FRL1001</td><td>Basic French</td><td>TH</td><td>AP2</td><td>G1</td>
            <td>10-Feb-2026</td><td>FN1</td><td>09:30 AM</td><td>10:00 AM - 11:30 AM</td><td>CB-108</td>
            <td>R1C10</td><td>58</td></tr>
        <tr><td>3</td><td>PHY0000</td><td>No Time Yet</td><td>TH</td><td>AP3</td><td>B1</td>
            <td>12-May-2026</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>
        <tr><td class="panelHead-secondary">CAT1</td></tr>
        <tr><td>1</td><td>ECE2015</td><td>Computer Architecture</td><td>TH</td><td>AP1</td><td>A1</td>
            <td>10-Mar-2026</td><td>AN1</td><td>01:30 PM</td><td>02:00 PM - 03:30 PM</td><td>CB-101</td>
            <td>R2C2</td><td>9</td></tr>
      </table></body>`);
    await shim(page, { fixedMs: fixedExam });
    await inject(page, ["js/shared/ics.js", "js/exam_schedule.js"]);
    await page.evaluate(() => window.__dispatch("exam_schedule"));
    await delay(300);
    const btns = await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .map((b) => b.textContent.trim())
        .filter((t) => t.includes("Download"))
    );
    ok("one download button per exam group (FAT + CAT1)", btns.length === 2, JSON.stringify(btns));
    const counts = await page.evaluate(() => ({
      notify: [...document.querySelectorAll("button")].filter((b) => /notify me/.test(b.textContent)).length,
      mail: [...document.querySelectorAll("button")].filter((b) => /email me/.test(b.textContent)).length,
    }));
    ok(
      "one 🔔 notify + one ✉️ email button per exam group",
      counts.notify === 2 && counts.mail === 2,
      JSON.stringify(counts)
    );

    // 📅 one-tap template links need no OAuth at all — only the upcoming
    // exam with a published window gets one (past + no-time rows skipped)
    const gcalLinks = await page.evaluate(() =>
      [...document.querySelectorAll(".vrevamp-gcal-link")].map((a) => a.href)
    );
    ok(
      "📅 one-tap link only on the upcoming published exam",
      gcalLinks.length === 1,
      `links=${gcalLinks.length}`
    );
    // the dead upstream OAuth client must produce an actionable hint, not a
    // dead-end error (seen live 2026-07-16)
    const deadClientHint = await page.evaluate(() => {
      window.vrGoogleAuthError =
        "OAuth2 request failed: Service responded with error: 'bad client id: 102739538495-xyz.apps.googleusercontent.com'";
      return window.vrGoogleAuthHint();
    });
    ok(
      "dead-client sign-in error points at the no-sign-in paths",
      /one-tap/.test(deadClientHint) && /import button on the timetable page/.test(deadClientHint),
      deadClientHint
    );

    ok(
      "link prefills title/window/venue via calendar template URL",
      gcalLinks.length === 1 &&
        gcalLinks[0].startsWith("https://calendar.google.com/calendar/render?action=TEMPLATE") &&
        gcalLinks[0].includes(encodeURIComponent("FAT exam: ECE2015 — Computer Architecture")) &&
        gcalLinks[0].includes("dates=20260504T100000/20260504T130000") &&
        gcalLinks[0].includes("ctz=Asia/Kolkata") &&
        gcalLinks[0].includes("location=CB-324"),
      (gcalLinks[0] || "").slice(0, 180)
    );

    const examCache = await page.evaluate(() => window.__storage.vrevamp_exam_schedule);
    const cachedFat = examCache && examCache.exams && examCache.exams.find((e) => e.type === "FAT" && e.code === "ECE2015");
    const cachedNoTime = examCache && examCache.exams && examCache.exams.find((e) => e.code === "PHY0000");
    ok(
      "schedule cached for the timetable import (all 4 rows, semester name)",
      !!examCache && examCache.exams.length === 4 && examCache.semester === "Winter Semester 2025-26",
      examCache && JSON.stringify({ n: examCache.exams.length, sem: examCache.semester })
    );
    ok(
      "cached exam normalized (ISO date + 24h window + venue/seat)",
      !!cachedFat && cachedFat.dateIso === "2026-05-04" && cachedFat.start === "1000" &&
        cachedFat.end === "1300" && cachedFat.venue === "CB-324" && cachedFat.seatNo === "5",
      JSON.stringify(cachedFat)
    );
    ok(
      "no-time exam cached with null window (import will skip it)",
      !!cachedNoTime && cachedNoTime.start === null && cachedNoTime.end === null,
      JSON.stringify(cachedNoTime)
    );

    await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .find((b) => /Download FAT/.test(b.textContent))
        .click()
    );
    await delay(200);
    const dl = await page.evaluate(() => window.__downloads[0] || null);
    const note = await page.evaluate(
      () => document.querySelector(".vrevamp-exam-note")?.textContent
    );
    ok("FAT export produced an ICS", !!dl && dl.includes("BEGIN:VCALENDAR"));
    ok(
      "2 events — unpublished-time row skipped",
      !!dl && (dl.match(/BEGIN:VEVENT/g) || []).length === 2 && /✓ 2 exam\(s\) exported/.test(note || ""),
      `events=${dl ? (dl.match(/BEGIN:VEVENT/g) || []).length : 0} note=${note}`
    );
    ok(
      "ECE2015: correct 3h window, venue and seat from headers",
      !!dl &&
        dl.includes("DTSTART;TZID=Asia/Kolkata:20260504T100000") &&
        dl.includes("DTEND;TZID=Asia/Kolkata:20260504T130000") &&
        dl.includes("LOCATION:CB-324") &&
        // DESCRIPTION is one escaped TEXT value: "\n" between fields, and the
        // literal ";" separators are gone (they used to be raw, which splits
        // the property into several values)
        dl.includes("Seat: R3C1 No. 5"),
      dl ? dl.slice(dl.indexOf("BEGIN:VEVENT"), dl.indexOf("BEGIN:VEVENT") + 300) : "no ics"
    );

    await page.evaluate(() => window.__dispatch("exam_schedule"));
    await delay(200);
    const btns2 = await page.evaluate(() => document.querySelectorAll("button").length);
    ok("message re-fire does not duplicate buttons", btns2 === 6, `buttons=${btns2}`);

    const bellNote = (btnRe, which) =>
      page.evaluate(([bre, re]) => {
        const b = [...document.querySelectorAll("button")]
          .filter((x) => new RegExp(bre).test(x.textContent))
          .find((x) => new RegExp(re).test(x.closest("td").textContent));
        return b && b.nextElementSibling ? b.nextElementSibling.textContent : null;
      }, [btnRe, which]);

    // 🔔 local notifications: no Google at all — 1 day + 2 h before the one
    // upcoming exam (past FRL1001 and no-time PHY0000 skipped)
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .filter((b) => /notify me/.test(b.textContent))[0]
        .click();
    });
    await delay(300);
    const fatRems = await page.evaluate(() => (window.__reminders || {})["exam:FAT"] || []);
    ok(
      "🔔 FAT schedules 2 Chrome notifications: 1 day + 2 h before the upcoming exam",
      fatRems.length === 2 &&
        fatRems[0].when === Date.parse("2026-05-03T10:00:00+05:30") &&
        fatRems[1].when === Date.parse("2026-05-04T08:00:00+05:30") &&
        /✓ 2 Chrome notification/.test((await bellNote("notify me", "FAT")) || ""),
      JSON.stringify({
        whens: fatRems.map((r) => new Date(r.when).toISOString()),
        note: await bellNote("notify me", "FAT"),
      })
    );
    ok(
      "notification carries venue, seat and reporting time",
      fatRems.length === 2 &&
        /Tomorrow — FAT exam: ECE2015/.test(fatRems[0].title || "") &&
        /CB-324/.test(fatRems[0].body || "") &&
        /R3C1 No\. 5/.test(fatRems[0].body || "") &&
        /reporting 09:30 AM/.test(fatRems[0].body || ""),
      JSON.stringify(fatRems[0] || null)
    );
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .filter((b) => /notify me/.test(b.textContent))[1]
        .click();
    });
    await delay(300);
    const cat1Rems = await page.evaluate(
      () => ((window.__reminders || {})["exam:CAT1"] || []).length
    );
    ok(
      "🔔 CAT1 (all past) reports no upcoming exams, schedules nothing",
      cat1Rems === 0 && /no upcoming exams/.test((await bellNote("notify me", "CAT1")) || ""),
      `rems=${cat1Rems} note=${await bellNote("notify me", "CAT1")}`
    );

    // ✉️ without a Google sign-in: surface the real identity error, create nothing
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .filter((b) => /email me/.test(b.textContent))[0]
        .click();
    });
    await delay(300);
    ok(
      "✉️ without sign-in shows the real Google error, creates nothing",
      gcalExam.length === 0 && /Google sign-in failed/.test((await bellNote("email me", "FAT")) || ""),
      `events=${gcalExam.length} note=${await bellNote("email me", "FAT")}`
    );

    // signed in: only the UPCOMING exam gets an event (past + no-time skipped)
    await page.evaluate(() => (window.__storage.token = "tok123"));
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .filter((b) => /email me/.test(b.textContent))[0]
        .click();
    });
    await delay(900);
    ok(
      "✉️ FAT creates ONE event — only the upcoming exam (past/no-time skipped)",
      gcalExam.length === 1,
      `events=${gcalExam.length}`
    );
    const exEv = gcalExam[0] || {};
    ok(
      "event sits on the exam window with email+popup 24h before",
      (exEv.start || {}).dateTime === "2026-05-04T10:00:00+05:30" &&
        (exEv.end || {}).dateTime === "2026-05-04T13:00:00+05:30" &&
        !!exEv.reminders &&
        exEv.reminders.useDefault === false &&
        exEv.reminders.overrides.some((o) => o.method === "email" && o.minutes === 1440) &&
        /FAT exam: ECE2015/.test(exEv.summary || "") &&
        exEv.location === "CB-324",
      JSON.stringify({ start: exEv.start, end: exEv.end, summary: exEv.summary, location: exEv.location, reminders: exEv.reminders })
    );
    ok(
      "reminder email carries slot, session, reporting time and seat",
      /Slot: A1/.test(exEv.description || "") &&
        /Session: FN1/.test(exEv.description || "") &&
        /Reporting time: 09:30 AM/.test(exEv.description || "") &&
        /Seat: R3C1 · No\. 5/.test(exEv.description || ""),
      JSON.stringify(exEv.description || "")
    );
    ok(
      "✉️ FAT confirms inline",
      /✓ 1 reminder\(s\) set/.test((await bellNote("email me", "FAT")) || ""),
      `note=${await bellNote("email me", "FAT")}`
    );

    // a group whose exams are all in the past: say so, create nothing
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .filter((b) => /email me/.test(b.textContent))[1]
        .click();
    });
    await delay(300);
    ok(
      "✉️ CAT1 (all past) reports no upcoming exams, creates nothing",
      gcalExam.length === 1 && /no upcoming exams/.test((await bellNote("email me", "CAT1")) || ""),
      `events=${gcalExam.length} note=${await bellNote("email me", "CAT1")}`
    );
    await page.close();
  }

  /* ============ exam .ics: RFC 5545 conformance regressions ============ */
  console.log("\n=== exam .ics: UID collision + TEXT escaping (RFC 5545) ===");
  {
    // The bug this guards: a course with BOTH a theory and a lab exam got the
    // same UID (it was built from the export timestamp + course code alone).
    // Same UID means "same event", so importing the file into Google/Apple
    // Calendar silently kept one exam and dropped the other. The titles and
    // venue here also carry the "," and ";" that used to go out unescaped and
    // split one property into several values.
    const page = await newPage(browser);
    await page.setContent(`<body>
      <select id="semesterSubId"><option selected>Winter Semester 2025-26</option></select>
      <table class="customTable">
        <tr><td>S.No.</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Class ID</td><td>Slot</td>
            <td>Exam Date</td><td>Exam Session</td><td>Reporting Time</td><td>Exam Time</td><td>Venue</td>
            <td>Seat Location</td><td>Seat No.</td></tr>
        <tr><td class="panelHead-secondary">FAT</td></tr>
        <tr><td>1</td><td>CSE1005</td><td>Data Structures, Algorithms and Applications</td><td>TH</td><td>AP1</td><td>A1</td>
            <td>04-May-2026</td><td>FN1</td><td>09:30 AM</td><td>10:00 AM - 01:00 PM</td><td>AB-1, Room 324; Block C</td>
            <td>R3C1</td><td>5</td></tr>
        <tr><td>2</td><td>CSE1005</td><td>Data Structures Lab</td><td>ELA</td><td>AP2</td><td>L31</td>
            <td>06-May-2026</td><td>AN1</td><td>01:30 PM</td><td>02:00 PM - 05:00 PM</td><td>CB-Lab</td>
            <td>R1C2</td><td>9</td></tr>
      </table></body>`);
    await shim(page, { fixedMs: new Date("2026-04-01T09:00:00+05:30").getTime() });
    await inject(page, ["js/shared/ics.js", "js/exam_schedule.js"]);
    await page.evaluate(() => window.__dispatch("exam_schedule"));
    await delay(300);
    await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .find((b) => /Download FAT/.test(b.textContent))
        .click()
    );
    await delay(200);
    const ics = await page.evaluate(() => window.__downloads[0] || null);
    const uids = [...(ics || "").matchAll(/^UID:(.*)$/gm)].map((m) => m[1]);

    ok(
      "theory + lab of the SAME course produce 2 events",
      !!ics && (ics.match(/BEGIN:VEVENT/g) || []).length === 2,
      `events=${ics ? (ics.match(/BEGIN:VEVENT/g) || []).length : 0}`
    );
    ok(
      "…with DISTINCT UIDs (the collision that dropped an exam on import)",
      uids.length === 2 && uids[0] !== uids[1],
      JSON.stringify(uids)
    );
    ok(
      "UID is stable — derived from exam content, not the export timestamp",
      uids.every((u) => /^vrevamp-exam-CSE1005-\d{8}-\d{4}-/.test(u)),
      JSON.stringify(uids)
    );
    ok(
      "comma in course title escaped in SUMMARY",
      !!ics && ics.includes("SUMMARY:CSE1005: Data Structures\\, Algorithms and Applications"),
      (ics || "").split("\r\n").find((l) => l.startsWith("SUMMARY:CSE1005: Data"))
    );
    ok(
      "comma AND semicolon in venue escaped in LOCATION",
      !!ics && ics.includes("LOCATION:AB-1\\, Room 324\\; Block C"),
      (ics || "").split("\r\n").find((l) => l.startsWith("LOCATION:AB-1"))
    );
    ok("CRLF line endings, no bare LF", !!ics && !/[^\r]\n/.test(ics));
    ok(
      "DTSTAMP is UTC with Z and carries no TZID parameter",
      !!ics && /^DTSTAMP:\d{8}T\d{6}Z$/m.test(ics) && !/DTSTAMP;/.test(ics)
    );
    ok(
      "no content line exceeds 75 octets (folded per RFC 5545 §3.1)",
      !!ics &&
        ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75),
      (ics || "")
        .split("\r\n")
        .filter((l) => new TextEncoder().encode(l).length > 75)
        .join(" | ") || "all within limit"
    );
    // Folding only triggers past 75 octets, which this fixture stays under —
    // exercise the primitive directly, including the multi-byte case (an em
    // dash is 3 bytes, and course titles are full of them, so a naive
    // character-count fold splits one in half and corrupts the file).
    const foldChecks = await page.evaluate(() => {
      const enc = new TextEncoder();
      const long = "SUMMARY:" + "A".repeat(200);
      const folded = window.vrIcs.fold(long);
      const emdash = "SUMMARY:" + "—".repeat(60); // 3 octets each = 180
      const foldedEm = window.vrIcs.fold(emdash);
      const lines = (s) => s.split("\r\n");
      return {
        wrapped: lines(folded).length > 1,
        allWithin: lines(folded).every((l) => enc.encode(l).length <= 75),
        continuationsSpaced: lines(folded).slice(1).every((l) => l.startsWith(" ")),
        unfoldsExactly: lines(folded).map((l, i) => (i ? l.slice(1) : l)).join("") === long,
        emWithin: lines(foldedEm).every((l) => enc.encode(l).length <= 75),
        emIntact: !foldedEm.includes("�") &&
          lines(foldedEm).map((l, i) => (i ? l.slice(1) : l)).join("") === emdash,
        shortUntouched: window.vrIcs.fold("SUMMARY:short") === "SUMMARY:short",
      };
    });
    ok("fold: long line wraps into 75-octet chunks", foldChecks.wrapped && foldChecks.allWithin);
    ok("fold: continuation lines start with one space", foldChecks.continuationsSpaced);
    ok("fold: unfolding reproduces the original exactly", foldChecks.unfoldsExactly);
    ok(
      "fold: multi-byte em dashes never split mid-character",
      foldChecks.emWithin && foldChecks.emIntact
    );
    ok("fold: a short line is left alone", foldChecks.shortUntouched);

    // The escaping case that actually breaks files: a LITERAL newline in a
    // value. Emitted raw, the parser reads the remainder as a new content
    // line and rejects the whole calendar. It arises from a cell whose
    // content spans multiple SOURCE lines (textContent keeps the whitespace
    // between text nodes; .trim() only strips the ends) — not from <br>,
    // which contributes nothing to textContent. (Unescaped , ; and \ are
    // spec violations too, but lenient parsers such as ical.js recover those
    // intact — this is the one that loses everything.)
    const newlineChecks = await page.evaluate(() => {
      const venue = "AB-1\n        Room 324";        // exactly what textContent gives
      const line = "LOCATION:" + window.vrIcs.esc(venue);
      const unesc = (v) => v.replace(/\\([\\;,nN])/g, (_, c) =>
        (c === "n" || c === "N") ? "\n" : c);
      return {
        noRawNewlineEmitted: !/\n/.test(line),
        escapedAsBackslashN: line.includes("\\n"),
        roundTrips: unesc(line.slice("LOCATION:".length)) === venue,
        staysOneContentLine: line.split(/\r?\n/).length === 1,
      };
    });
    ok("newline in a value is escaped, never emitted raw", newlineChecks.noRawNewlineEmitted && newlineChecks.escapedAsBackslashN);
    ok("newline value stays a single content line (file still parses)", newlineChecks.staysOneContentLine);
    ok("newline value round-trips back to the original text", newlineChecks.roundTrips);
    await page.close();
  }

  /* ============ navbar: one insert despite load+message race ============ */
  console.log("\n=== navbar (AP): load event + nav messages insert exactly one ===");
  {
    const page = await newPage(browser);
    await page.setContent(`<body>
      <a data-url="u1" href="#">Class Attendance</a>
      <a data-url="u2" href="#">Marks</a>
      <nav><div class="collapse navbar-collapse"><div>menu</div></div></nav>
    </body>`);
    await shim(page, {});
    await inject(page, ["js/navbarap.js"]);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("load")); // deferred injection path
      window.__dispatch("nav_bar_change");
      window.__dispatch("nav_bar_change");
    });
    await delay(300);
    const navbars = await page.evaluate(
      () => document.querySelectorAll("#navbar").length
    );
    ok("exactly one #navbar (was duplicated live on 2026 home)", navbars === 1, `navbars=${navbars}`);
    await page.close();
  }

  /* ============ DA page 2026: dues column + email reminder ============ */
  console.log("\n=== DA page (2026): upcoming dues + 🔔 email reminder ===");
  {
    const fixed = new Date("2026-07-06T09:00:00+05:30").getTime();
    // per-class detail: DA1 past-due, DA2 upcoming & not uploaded (the
    // reminder target), DA3 upcoming but already uploaded (must be skipped)
    const detailHtml = `
      <table class="customTable">
        <tr><td>Semester</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Class Number</td></tr>
        <tr><td>Summer II</td><td>MGT1029</td><td>Basic Law for Engineers</td><td>TH</td><td>AP2025267000565</td></tr>
      </table>
      <table class="customTable">
        <tr><td>Sl.No.</td><td>Title</td><td>Max. Mark</td><td>Weightage %</td><td>Due Date</td><td>QP</td><td>Document Details</td></tr>
        <tr><td>Last Updated On</td><td>Upload/Edit</td><td>Download</td></tr>
        <tr><td>1</td><td>Digital Assessment-1</td><td>15</td><td>15</td><td><span style="color:red">24-Jun-2026</span></td><td></td>
            <td><span style="color:red">File Not Uploaded</span></td><td></td><td></td></tr>
        <tr><td>2</td><td>Digital Assessment-2</td><td>15</td><td>15</td><td><span style="color:green">10-Jul-2026</span></td><td></td>
            <td><span style="color:red">File Not Uploaded</span></td><td></td><td></td></tr>
        <tr><td>3</td><td>Digital Assessment-3</td><td>15</td><td>15</td><td><span style="color:green">15-Jul-2026</span></td><td></td>
            <td>06-Jul-2026 10:00</td><td></td><td></td></tr>
      </table>`;
    // second course: everything submitted; third: everything past due
    const doneHtml = detailHtml
      .replace(/MGT1029/g, "SWE2007")
      .replace(/<span style="color:red">File Not Uploaded<\/span>/g, "05-Jul-2026 10:00")
      .replace(/10-Jul-2026|15-Jul-2026/g, "30-Jun-2026");
    const missedHtml = detailHtml
      .replace(/MGT1029/g, "PHY1001")
      .replace(/10-Jul-2026|15-Jul-2026/g, "30-Jun-2026")
      .replace(/06-Jul-2026 10:00/, '<span style="color:red">File Not Uploaded</span>');
    const gcal = [];
    const page = await newPage(browser);
    await page.route("https://vtop-da.test/**", (route) => {
      if (route.request().url().includes("processDigitalAssignment")) {
        const body = route.request().postData() || "";
        route.fulfill({
          contentType: "text/html",
          body: body.includes("classId=AP2025267000153")
            ? doneHtml
            : body.includes("classId=AP2025267000999")
              ? missedHtml
              : detailHtml,
        });
        return;
      }
      route.fulfill({
        contentType: "text/html",
        body: `<body>
          <span class="navbar-text text-light small fw-bold">24MIC7198 (STUDENT)</span>
          <input name="_csrf" value="t0k">
          <table class="customTable">
            <tr><td>Sl.No</td><td>Class Nbr</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Faculty Name</td><td>Dashboard</td></tr>
            <tr><td>1</td><td>AP2025267000565</td><td>MGT1029</td><td>Basic Law for Engineers</td><td>TH</td><td>P Ojha</td><td><a>view</a></td></tr>
            <tr><td>2</td><td>AP2025267000153</td><td>SWE2007</td><td>Operating Systems</td><td>ETH</td><td>S Dara</td><td><a>view</a></td></tr>
            <tr><td>3</td><td>AP2025267000999</td><td>PHY1001</td><td>Physics</td><td>TH</td><td>X Y</td><td><a>view</a></td></tr>
          </table></body>`,
      });
    });
    await page.route("https://www.googleapis.com/**", (route) => {
      gcal.push(JSON.parse(route.request().postData() || "{}"));
      route.fulfill({ contentType: "application/json", body: "{}" });
    });
    await page.goto("https://vtop-da.test/vtop/content");
    await shim(page, { fixedMs: fixed, storage: {} });
    // token lives in chrome.storage.sync (shim maps all areas to one store)
    await page.evaluate(() => (window.__storage.token = "tok123"));
    await inject(page, ["js/da_upload.js"]);
    await page.evaluate(() => window.__dispatch("da_upload"));
    await delay(800);

    const cellText = await page.evaluate(() => {
      const t = document.querySelector("table.customTable");
      return t.rows[1].cells[7] ? t.rows[1].cells[7].textContent : null;
    });
    ok(
      "dues cell shows nearest un-submitted due (skips past-due + uploaded)",
      !!cellText && cellText.includes("10-Jul-2026") && cellText.includes("(4 day(s) left)"),
      cellText || "no cell"
    );
    ok("header gained the Upcoming Dues column", await page.evaluate(() => {
      const t = document.querySelector("table.customTable");
      return /Upcoming Dues/.test(t.rows[0].textContent);
    }));
    const states = await page.evaluate(() => {
      const t = document.querySelector("table.customTable");
      return [2, 3].map((i) => t.rows[i].cells[7].textContent.trim());
    });
    ok(
      "all-submitted course says so; past-due course warns",
      states[0] === "✅ all submitted" && states[1] === "⚠ 3 past due (not uploaded)",
      JSON.stringify(states)
    );

    // 🔔 local: Chrome notifications for the one un-submitted upcoming DA —
    // evening before (18:00) + due-day morning (08:00), no Google involved
    await page.click(".vrevamp-da-remind");
    await delay(300);
    const btnText = await page.evaluate(
      () => document.querySelector(".vrevamp-da-remind").textContent
    );
    const daRems = await page.evaluate(
      () => (window.__reminders || {})["da:MGT1029"] || []
    );
    ok(
      "🔔 schedules 2 Chrome notifications for the un-submitted upcoming DA only",
      daRems.length === 2 && gcal.length === 0 &&
        daRems[0].when === Date.parse("2026-07-09T18:00:00+05:30") &&
        daRems[1].when === Date.parse("2026-07-10T08:00:00+05:30") &&
        /DA due: MGT1029 — Digital Assessment-2/.test(daRems[0].title || ""),
      JSON.stringify({
        whens: daRems.map((r) => new Date(r.when).toISOString()),
        title: (daRems[0] || {}).title,
        gcal: gcal.length,
      })
    );
    ok("🔔 button confirms the schedule", /✓ 2 reminder/.test(btnText), btnText);

    // ✉ optional Google path: one calendar event with the 24 h email
    await page.evaluate(() =>
      document.querySelectorAll(".vrevamp-da-remind")[1].click()
    );
    await delay(600);
    const mailText = await page.evaluate(
      () => document.querySelectorAll(".vrevamp-da-remind")[1].textContent
    );
    ok(
      "✉ creates ONE calendar event (only the un-submitted upcoming DA)",
      gcal.length === 1,
      `events=${gcal.length}`
    );
    const ev = gcal[0] || {};
    ok(
      "event has email reminder 24h before, on the due date",
      !!ev.reminders &&
        ev.reminders.useDefault === false &&
        ev.reminders.overrides.some((o) => o.method === "email" && o.minutes === 1440) &&
        (ev.start || {}).dateTime === "2026-07-10T20:00:00+05:30" &&
        /MGT1029/.test(ev.summary || ""),
      JSON.stringify({ start: ev.start, reminders: ev.reminders, summary: ev.summary })
    );
    ok("✉ button confirms the schedule", /✓ 1 email/.test(mailText), mailText);

    // 📅 one-tap template link (no OAuth): upcoming un-submitted due only
    const daLinks = await page.evaluate(() => {
      const t = document.querySelector("table.customTable");
      return {
        total: document.querySelectorAll(".vrevamp-da-gcal").length,
        row1: [...t.rows[1].cells[7].querySelectorAll(".vrevamp-da-gcal")].map(
          (a) => ({ t: a.textContent, href: a.href, target: a.target })
        ),
      };
    });
    ok(
      "📅 one-tap gcal link on the upcoming due only",
      daLinks.total === 1 && daLinks.row1.length === 1 &&
        daLinks.row1[0].t === "📅 gcal" && daLinks.row1[0].target === "_blank",
      JSON.stringify(daLinks)
    );
    ok(
      "DA link prefills the due (20:00 on due day, template URL)",
      daLinks.row1.length === 1 &&
        daLinks.row1[0].href.startsWith("https://calendar.google.com/calendar/render?action=TEMPLATE") &&
        daLinks.row1[0].href.includes("dates=20260710T200000/20260710T210000") &&
        daLinks.row1[0].href.includes(encodeURIComponent("DA due: MGT1029 — Digital Assessment-2")),
      JSON.stringify(daLinks.row1)
    );

    // re-fired message must not duplicate the column
    await page.evaluate(() => window.__dispatch("da_upload"));
    await delay(400);
    const dupe = await page.evaluate(() => {
      const t = document.querySelector("table.customTable");
      return {
        headCells: t.rows[0].cells.length,
        dues: [...t.rows[0].cells].filter((c) => /Upcoming Dues/.test(c.textContent)).length,
      };
    });
    ok(
      "message re-fire does not duplicate the dues column",
      dupe.headCells === 8 && dupe.dues === 1,
      JSON.stringify(dupe)
    );
    await page.close();
  }

  /* ============ session repair: poisoned cookie self-heal ============ */
  console.log("\n=== session repair: poisoned-cookie 404 self-heal ===");
  {
    const tomcat404 =
      "<body><h1>HTTP Status 404 - Not Found</h1><hr><h3>Apache Tomcat/9.0.85</h3></body>";
    // chrome.sendMessage recorder + reload trap, installed once per document
    const stub = `(() => {
      if (window.__messages) return;
      window.__messages = [];
      window.__reloads = 0;
      window.__bounces = 0;
      const _st = window.setTimeout;
      window.setTimeout = function (fn, ms) {
        if (typeof fn === "function" && /location\\.reload/.test(String(fn))) {
          window.__reloads++;
          return 0;
        }
        if (typeof fn === "function" && /location\\.replace/.test(String(fn))) {
          window.__bounces++;
          return 0;
        }
        return _st.call(window, fn, ms);
      };
      window.chrome = { runtime: {
        sendMessage: (m, cb) => { window.__messages.push(m); if (cb) cb(true); },
        get lastError() { return undefined; },
      } };
    })();`;
    const page = await newPage(browser);

    // sick origin: navigations and cookie-carrying fetches 404 (Tomcat page),
    // cookie-less fetches 200 — the exact poisoned-sticky-cookie signature
    await CTX.addCookies([
      { name: "JSESSIONID", value: "poison", domain: "vtop-sick.test", path: "/" },
    ]);
    await page.route("https://vtop-sick.test/**", (route) => {
      const req = route.request();
      if (new URL(req.url()).pathname === "/healthy") {
        route.fulfill({ contentType: "text/html", body: "<body>Student</body>" });
        return;
      }
      const poisoned = /poison/.test(req.headers()["cookie"] || "");
      route.fulfill({
        status: poisoned ? 404 : 200,
        contentType: "text/html",
        body: poisoned ? tomcat404 : "<body>ok</body>",
      });
    });
    const state = () =>
      page.evaluate(() => ({
        messages: window.__messages,
        reloads: window.__reloads,
        bounces: window.__bounces,
        counter: sessionStorage.getItem("vrevamp_session_repairs"),
      }));

    // live session on a dead URL: /vtop/content answers 200 with cookies →
    // bounce home, never clear cookies
    await CTX.addCookies([
      { name: "JSESSIONID", value: "alive", domain: "vtop-alive.test", path: "/" },
    ]);
    await page.route("https://vtop-alive.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/vtop/content") {
        route.fulfill({ contentType: "text/html", body: "<body>portal</body>" });
        return;
      }
      route.fulfill({ status: 404, contentType: "text/html", body: tomcat404 });
    });
    await page.goto("https://vtop-alive.test/vtop/login");
    await page.addScriptTag({ content: stub });
    await inject(page, ["js/session_repair.js"]);
    await delay(400);
    let sAlive = await state();
    ok(
      "live session on dead /vtop/login bounces home, cookies untouched",
      sAlive.bounces === 1 && sAlive.messages.length === 0 && sAlive.reloads === 0,
      `bounces=${sAlive.bounces} messages=${sAlive.messages.length} reloads=${sAlive.reloads}`
    );

    await page.goto("https://vtop-sick.test/vtop/login");
    await page.addScriptTag({ content: stub });
    await inject(page, ["js/session_repair.js"]);
    await delay(400);
    let s = await state();
    ok(
      "poisoned 404 asks the worker to clear cookies + reloads once",
      s.messages.length === 1 &&
        s.messages[0].message === "clear_site_cookies" &&
        s.reloads === 1 &&
        s.counter === "1",
      `messages=${s.messages.length} reloads=${s.reloads} counter=${s.counter}`
    );

    // repeated failures: capped at 2 repair attempts per tab
    for (let i = 0; i < 3; i++) {
      await inject(page, ["js/session_repair.js"]);
      await delay(400);
    }
    s = await state();
    ok(
      "repair attempts capped at 2 (no clear/reload loop)",
      s.messages.length === 2 && s.reloads === 2 && s.counter === "2",
      `messages=${s.messages.length} reloads=${s.reloads} counter=${s.counter}`
    );

    // healthy page on the same origin resets the attempt counter
    await page.goto("https://vtop-sick.test/healthy");
    await page.addScriptTag({ content: stub });
    await inject(page, ["js/session_repair.js"]);
    await delay(200);
    s = await state();
    ok(
      "healthy page clears the repair counter",
      s.messages.length === 0 && s.counter === null,
      `messages=${s.messages.length} counter=${s.counter}`
    );

    // server genuinely down (404 with AND without cookies): leave it alone
    await CTX.addCookies([
      { name: "JSESSIONID", value: "poison", domain: "vtop-down.test", path: "/" },
    ]);
    await page.route("https://vtop-down.test/**", (route) =>
      route.fulfill({ status: 404, contentType: "text/html", body: tomcat404 })
    );
    await page.goto("https://vtop-down.test/vtop/login");
    await page.addScriptTag({ content: stub });
    await inject(page, ["js/session_repair.js"]);
    await delay(400);
    s = await state();
    ok(
      "site-down 404 (no cookie signature) is left alone",
      s.messages.length === 0 && s.reloads === 0 && s.counter === null,
      `messages=${s.messages.length} reloads=${s.reloads} counter=${s.counter}`
    );
    await page.close();
  }

  /* ============ stale-semester detection (home cards) ============ */
  console.log("\n=== stale-semester detection: heads-up + next-class cards ===");
  {
    // Summer Sem-II 2025-26 ended (FAT 13 Jul); today is 16 Jul 2026 — the
    // Fall term has begun. Cached warnings must NOT render as current.
    const fixed = new Date("2026-07-16T18:00:00+05:30").getTime();
    const oldSem = "Summer Semester-II 2025-26";
    const oldCalendar = {
      version: 2,
      semester: oldSem,
      fetchedAt: fixed - 20 * 86400000,
      cat1: "2026-05-25",
      cat2: "2026-06-20",
      fat: "2026-07-13",
      holidays: [],
      instructionalDays: [],
      lastInstructional: "2026-07-10",
    };
    const oldSummary = {
      fetchedAt: fixed - 5 * 86400000,
      semester: oldSem,
      subjects: [
        { name: "STS1007 - Arithmetic problem solving - Theory Only", code: "STS1007", pct: 76, safeNow: 0, nextBunkable: 0, unit: "class(es)" },
      ],
    };
    const storage = {
      ["vrevamp_calendar_" + oldSem.toLowerCase()]: oldCalendar,
      vrevamp_attendance_summary: oldSummary,
    };

    // heads-up card: stale note shown, at-risk/safe-skip lines suppressed
    let page = await newPage(browser);
    await page.setContent("<body><div id='main-section'></div></body>");
    await shim(page, { fixedMs: fixed, storage });
    await inject(page, ["js/utils/chooseCurrentSem.js", "js/home_notices.js"]);
    await delay(1200);
    let text = await page.evaluate(() => {
      const el = document.getElementById("vrevamp-home-notices");
      return el ? el.textContent : null;
    });
    ok("heads-up card rendered", !!text, text || "no card");
    ok("stale note names the old semester", !!text && text.includes(oldSem) && /looks over/.test(text), (text || "").slice(0, 160));
    ok("old at-risk warnings suppressed", !!text && !/skippable before the next exam/.test(text));
    ok("old safe-skip line suppressed", !!text && !/Safe to skip now/.test(text));
    await page.close();

    // same caches 11 days earlier (semester still running) → normal render
    const during = new Date("2026-07-05T10:00:00+05:30").getTime();
    page = await newPage(browser);
    await page.setContent("<body><div id='main-section'></div></body>");
    await shim(page, { fixedMs: during, storage });
    await inject(page, ["js/utils/chooseCurrentSem.js", "js/home_notices.js"]);
    await delay(1200);
    text = await page.evaluate(() => {
      const el = document.getElementById("vrevamp-home-notices");
      return el ? el.textContent : null;
    });
    ok("mid-semester: no stale note", !!text && !/looks over/.test(text), (text || "").slice(0, 160));
    ok("mid-semester: at-risk warning shown", !!text && /skippable before the next exam/.test(text));
    ok("mid-semester: FAT countdown shown", !!text && /FAT starts in/.test(text));
    await page.close();

    // next-class card, legacy timetable blob (no semester/savedAt stamp):
    // old-sem calendar is over → stale message, not "Done for the day"
    const wd = DAY_CODES[new Date(fixed).getDay()];
    const legacyTimetable = {
      header: ["Start - End", "09:00 - 09:50"],
      data: [{ day: wd, theory: ["", "TA1-CSE1005-ETH-G14-CB-ALL"], lab: ["", ""] }],
    };
    page = await newPage(browser);
    await page.setContent("<body><div id='main-section'></div></body>");
    await shim(page, { fixedMs: fixed, storage: { ...storage, "timeTable-V1": legacyTimetable } });
    await inject(page, [
      "js/utils/chooseCurrentSem.js",
      "js/store/store.js",
      "js/store/saveTimeTableDetails.js",
      "js/utils/filterRepeated.js",
      "js/next_class.js",
    ]);
    await delay(1200);
    text = await page.evaluate(() => {
      const el = document.getElementById("vrevamp-next-class");
      return el ? el.textContent : null;
    });
    ok("legacy timetable + finished sem → stale message", !!text && /last semester/.test(text), text || "no card");
    ok("no 'Done for the day' from the old timetable", !!text && !/Done for the day|No classes scheduled/.test(text));
    await page.close();

    // timetable stamped with the CURRENT semester → normal behaviour even
    // though an old-sem calendar is still cached
    const freshTimetable = { ...legacyTimetable, semester: "Fall Semester 2026-27", savedAt: fixed - 3600000 };
    page = await newPage(browser);
    await page.setContent("<body><div id='main-section'></div></body>");
    await shim(page, { fixedMs: fixed, storage: { ...storage, "timeTable-V1": freshTimetable } });
    await inject(page, [
      "js/utils/chooseCurrentSem.js",
      "js/store/store.js",
      "js/store/saveTimeTableDetails.js",
      "js/utils/filterRepeated.js",
      "js/next_class.js",
    ]);
    await delay(1200);
    text = await page.evaluate(() => {
      const el = document.getElementById("vrevamp-next-class");
      return el ? el.textContent : null;
    });
    ok("current-sem timetable renders normally", !!text && /Done for the day/.test(text), text || "no card");
    await page.close();

    // VTOP can render the registered semester with the dropdown still on the
    // placeholder (seen live 2026-07-16): the blob then has savedAt but NO
    // semester stamp. A save made during the current term must count as fresh
    // even while an old-sem calendar is still cached; one made before the
    // term boundary is stale.
    for (const [label, savedAt, expectStale] of [
      ["unstamped save from this term is fresh", fixed - 3600000, false],
      ["unstamped save from before the term boundary is stale", new Date("2026-06-20T10:00:00+05:30").getTime(), true],
    ]) {
      const tt = { ...legacyTimetable, savedAt };
      page = await newPage(browser);
      await page.setContent("<body><div id='main-section'></div></body>");
      await shim(page, { fixedMs: fixed, storage: { ...storage, "timeTable-V1": tt } });
      await inject(page, [
        "js/utils/chooseCurrentSem.js",
        "js/store/store.js",
        "js/store/saveTimeTableDetails.js",
        "js/utils/filterRepeated.js",
        "js/next_class.js",
      ]);
      await delay(1200);
      text = await page.evaluate(() => {
        const el = document.getElementById("vrevamp-next-class");
        return el ? el.textContent : null;
      });
      ok(label, !!text && /last semester/.test(text) === expectStale, text || "no card");
      await page.close();
    }
  }

  await browser.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
