import { chromium } from "playwright";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import vm from "node:vm";

// repo root, resolved relative to this test file so it runs anywhere
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");

let pass = 0,
  fail = 0;
/*
 * Read the bunk table by HEADER NAME, never by column index.
 *
 * The table decides its own columns now: a CAT column in which every row is
 * "no CATs for labs" or a retrospective is dropped rather than drawn, because
 * on the live page two of seven columns carried nothing a student could act
 * on. That makes a positional read wrong the moment a fixture changes shape —
 * which is how eighteen assertions failed at once while every number in them
 * was still correct.
 *
 * Returns the legacy positional layout so existing assertions keep reading the
 * way they did, with `null` where a column was dropped, plus the extras at the
 * named indices below. (Extra properties on an array do not survive
 * page.evaluate serialisation, hence indices rather than keys.)
 */
const B = { subject: 0, held: 1, remaining: 2, safeNow: 3, cat1: 4, cat2: 5, fat: 6, now: 7, title: 8, headers: 9 };
const READ_BUNK = `(() => {
  const c = document.getElementById("vtopext-bunk-table-container");
  if (!c) return null;
  const trs = [...c.querySelectorAll("tr")];
  if (!trs.length) return null;
  const heads = [...trs[0].children].map((th) => th.textContent.trim().toLowerCase());
  const at = (cells, name) => {
    const i = heads.indexOf(name);
    return i === -1 || !cells[i] ? null : cells[i].textContent;
  };
  return trs.slice(1).map((tr) => {
    const cells = [...tr.children];
    return [
      cells[0] ? cells[0].textContent : "",
      at(cells, "held"),
      at(cells, "left this sem"),
      at(cells, "safe to skip now"),
      at(cells, "bunkable before cat-1"),
      at(cells, "bunkable before cat-2"),
      at(cells, "bunkable before fat"),
      at(cells, "now"),
      cells[0] ? cells[0].getAttribute("title") || "" : "",
      heads.join(" | "),
    ];
  });
})()`;

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
        if (m && m.message === "set_reminder_email") {
          const a = String((m && m.address) || "").trim();
          if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(a)) {
            if (cb) cb({ ok: false, error: "that doesn't look like an email address" });
            return;
          }
          window.__storage.vtopext_reminder_email = a;
          if (cb) cb({ ok: true, address: a });
          return;
        }
        if (m && m.message === "send_mail") {
          // relay mode with nobody to write to yet: the worker answers
          // need_address and the page must ask, not fail
          // (no backticks in this comment - the whole shim is a template literal)
          if (window.__mailNeedsAddress && !m.to && !window.__storage.vtopext_reminder_email) {
            if (cb) cb({ ok: false, to: null, error: "need_address" });
            return;
          }
          // worker emulation for the direct-Gmail send: __mailError seeds a
          // failure (e.g. "gmail_send_scope"), otherwise the mail "arrives"
          // and is recorded so its subject/body can be asserted
          (window.__mails = window.__mails || []).push(m);
          if (cb)
            cb(
              window.__mailError
                ? { ok: false, to: null, error: window.__mailError }
                : {
                    ok: true,
                    // the worker echoes back the address it actually used, so
                    // the button can name it — students routinely have two
                    // Google accounts and guess wrong about which one was used
                    to: m.to || window.__storage.vtopext_reminder_email ||
                      window.__mailTo || "student@vitapstudent.ac.in",
                    error: null,
                  }
            );
          return;
        }
        if (m && m.message === "get_reminder_email") {
          // what the worker knows: the saved address, and that mail goes
          // through the extension's own relay (no Google sign-in)
          if (cb) cb({ address: window.__storage.vtopext_reminder_email || null, relay: true });
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
  // the same, for the messages that carry more than their own name
  // (semester_page_open names WHICH page opened)
  window.__dispatchMsg = (msg) => window.__listeners.forEach((l) => { try { l(msg, {}, () => {}); } catch(e){ console.error('listener', e);} });
  // capture .ics / png downloads triggered via anchor clicks
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function(){
    if (this.href && this.href.startsWith("data:")) { window.__downloads.push(decodeURIComponent(this.href.replace(/^data:[^,]*,/, ""))); return; }
    return realClick.apply(this, arguments);
  };
})();
`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const window_reminders_for = (all, tag) => (all && all[tag] && all[tag].length ? all[tag] : null);

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
      const el = document.getElementById("vtopext-next-class");
      return el ? el.textContent : null;
    });
    ok("card rendered", !!text, text || "no card");
    // 09:30 falls inside the 09:00-09:50 CSE1005 class
    ok("shows in-class-now for CSE1005", !!text && /In class now: CSE1005/.test(text), text || "");
    ok("shows ends-in-20-min", !!text && /ends in 20 min/.test(text), text || "");
    await page.close();

    /* ---- exam blocks: the timetable is the wrong thing to read out ----
     *
     * Asked 2026-08-22: "it says i have a next class on hompage but until the
     * last exam coplete ... until the cat exams over there wont be classes".
     * A timetable describes an ordinary week; an exam block is precisely the
     * week that is not ordinary, and the card had no way to know.
     *
     * The block is first-to-last dated exam of a type, so a day INSIDE it
     * with no exam of your own still has no classes — the case being asked
     * about. Same fixture and same clock as above, so the only thing that
     * changes the answer is the cached schedule.
     */
    const examCard = async (exams) => {
      const p = await newPage(browser);
      await p.setContent("<body><div id='main-section'></div></body>");
      await shim(p, {
        fixedMs: fixed,
        storage: {
          "timeTable-V1": timetable,
          vtopext_exam_schedule: { semester: "Fall Semester 2026-27", exams },
        },
      });
      await inject(p, [
        "js/store/store.js",
        "js/store/saveTimeTableDetails.js",
        "js/utils/filterRepeated.js",
        "js/next_class.js",
      ]);
      await p.evaluate(() => window.__dispatch("nav_bar_change"));
      await delay(1200);
      const out = await p.evaluate(() => {
        const el = document.getElementById("vtopext-next-class");
        return el ? el.textContent : null;
      });
      await p.close();
      return out;
    };

    // today is 2026-06-29; the CAT-2 block runs 29 Jun - 03 Jul
    const withExamToday = await examCard([
      { type: "CAT-2", code: "CSE1005", dateIso: "2026-06-29", reporting: "09:30 AM", venue: "CB-324", start: "1000" },
      { type: "CAT-2", code: "MAT2001", dateIso: "2026-07-03", reporting: "09:30 AM", venue: "CB-101", start: "1000" },
    ]);
    ok(
      "an exam day says so instead of announcing the class that will not run",
      !!withExamToday &&
        /CAT-2 today: CSE1005/.test(withExamToday) &&
        /no regular classes/.test(withExamToday) &&
        !/In class now/.test(withExamToday),
      withExamToday || "no card"
    );

    // a day inside the block with no exam of your own — the case being asked
    // about, and the one a per-day check would get wrong
    const insideBlock = await examCard([
      { type: "CAT-2", code: "CSE1005", dateIso: "2026-06-27", reporting: "09:30 AM", venue: "CB-324" },
      { type: "CAT-2", code: "MAT2001", dateIso: "2026-07-01", reporting: "09:30 AM", venue: "CB-101" },
    ]);
    ok(
      "a block day with no exam of your own still has no classes",
      !!insideBlock &&
        /CAT-2 block runs to 1 Jul/.test(insideBlock) &&
        !/In class now/.test(insideBlock),
      insideBlock || "no card"
    );

    // and outside the block nothing changes — the timetable is right again
    const outsideBlock = await examCard([
      { type: "FAT", code: "CSE1005", dateIso: "2026-07-20", reporting: "09:30 AM", venue: "CB-324" },
    ]);
    ok(
      "outside any block the timetable is read out exactly as before",
      !!outsideBlock && /In class now: CSE1005/.test(outsideBlock),
      outsideBlock || "no card"
    );
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

    ok("panel rendered", await page.evaluate(() => !!document.getElementById("vtopext-cgpa-sim")));
    const rowCells = await page.evaluate(() =>
      [...document.querySelectorAll("#vtopext-cgpa-sim table tr")]
        .map((tr) => [...tr.children].map((td) => td.textContent.trim()))
        .filter((c) => /CSE1005|MAT2001/.test(c[0] || ""))
    );
    ok(
      "credits joined from grade history (4, 3)",
      rowCells.length === 2 && rowCells[0][1] === "4" && rowCells[1][1] === "3",
      JSON.stringify(rowCells.map((c) => c[1]))
    );
    const bodyText = () =>
      page.evaluate(() => document.getElementById("vtopext-sim-body").textContent);
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
      const sel = document.querySelectorAll("#vtopext-cgpa-sim select")[0];
      sel.value = "S";
      sel.dispatchEvent(new Event("change"));
    });
    text = await bodyText();
    ok("recompute after grade change -> 9.14", /Projected semester GPA:\s*9\.14/.test(text), text.slice(0, 160));

    // CGPA mode folds the delta into the page's CGPA Details box:
    // (8.5*27 - 60 + 64)/27 = 8.648 -> 8.65
    await page.evaluate(() => {
      [...document.querySelectorAll("#vtopext-sim-body button")]
        .find((b) => b.textContent === "Cumulative CGPA")
        .click();
    });
    text = await bodyText();
    ok("CGPA mode reads page CGPA (8.50)", /Current CGPA:\s*8\.50/.test(text), text.slice(0, 160));
    ok("projected CGPA = 8.65", /Projected CGPA:\s*8\.65/.test(text), text.slice(0, 160));
    /* ---- a failed re-parse must not poison a working panel ----
     *
     * Reproduced live 2026-08-22 on the real transcript: the select moved
     * B -> A, the row tinted yellow as though it had registered, and the panel
     * replaced itself with "Couldn't read any graded rows on this page" - no
     * projected CGPA, no bar.
     *
     * buildPanel() assigned straight into `courses` and only then checked
     * whether the parse had produced anything, so one empty rebuild left the
     * module holding no courses while the panel and all its dropdowns stayed
     * on screen. That page carries twenty tables and VTOP re-renders them, so
     * an empty rebuild is ordinary - it must not be able to do this.
     */
    {
      const p3 = await newPage(browser);
      await p3.setContent(html);
      await shim(p3);
      await inject(p3, ["js/shared/click.js", "js/grade_history_calc.js"]);
      await p3.evaluate(() => window.__dispatch("exam_grade"));
      await delay(700);
      const after = await p3.evaluate(async () => {
        // a rebuild that parses nothing: blank every cell of the history table
        // without removing it, then let the observer run
        const t = [...document.querySelectorAll("table")].sort(
          (a, b) => b.rows.length - a.rows.length
        )[0];
        t.querySelectorAll("td").forEach((td) => {
          if (!td.querySelector("select")) td.textContent = "";
        });
        await new Promise((r) => setTimeout(r, 900));
        // now change a grade, as the student would
        const sel = document.querySelector("select.vtopext-gh-select:not([disabled])");
        sel.value = sel.value === "S" ? "A" : "S";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
        return document.getElementById("vtopext-gradehist-body").textContent;
      });
      ok(
        "an empty re-parse cannot leave the calculator with no courses",
        !/Couldn't read any graded rows/.test(after),
        after.replace(/\s+/g, " ").slice(0, 110)
      );
      await p3.close();
    }

    {
      // its own page: this test destroys the table, and everything below still
      // needs it
      const p2 = await newPage(browser);
      await p2.setContent(html);
      await shim(p2);
      await inject(p2, ["js/shared/click.js", "js/grade_history_calc.js"]);
      await p2.evaluate(() => window.__dispatch("exam_grade"));
      await delay(700);
      const before = await p2.evaluate(
        () => !!document.getElementById("vtopext-gradehist-calc")
      );
      const gone = await p2.evaluate(async () => {
        document.querySelectorAll("table").forEach((t) => t.remove());
        await new Promise((r) => setTimeout(r, 900)); // build is debounced 400ms
        return {
          panel: !!document.getElementById("vtopext-gradehist-calc"),
          bar: !!document.getElementById("vtopext-gh-bar"),
        };
      });
      ok(
        "the panel is removed once its table is gone, not left quoting a CGPA",
        before === true && gone.panel === false && gone.bar === false,
        JSON.stringify({ before, ...gone })
      );
      await p2.close();
    }
    await page.close();
  }

  /* =============== Grade calculator on the Grade History page =============== */

  console.log("\n=== grade calculator (Grade History page) ===");
  {
    // Real-shaped history: a header row, a "Grade Point" column that must NOT
    // be mistaken for "Grade", CSE1005 taken TWICE (F then re-registered as B)
    // so the repeated-code keying is exercised, and a P grade that is off the
    // 10-point scale. Official CGPA box says 8.50 over 27 credits.
    const html = `<body><div class="row">
      <table><tbody>
        <tr><td>Credits Registered</td><td>Credits Earned</td><td>CGPA</td></tr>
        <tr><td>30</td><td>27</td><td>8.5</td></tr>
      </tbody></table>
      <table><tbody>
        <tr><th>Sl.No.</th><th>Exam Held</th><th>Course Code</th><th>Course Title</th>
            <th>Credits</th><th>Grade</th><th>Grade Point</th></tr>
        <tr><td>1</td><td>Jul-2025</td><td>CSE1005</td><td>Data Structures</td>
            <td>4.0</td><td>F</td><td>0</td></tr>
        <tr><td>2</td><td>Jan-2026</td><td>CSE1005</td><td>Data Structures</td>
            <td>4.0</td><td>B</td><td>8</td></tr>
        <tr><td>3</td><td>Jan-2026</td><td>MAT2001</td><td>Applied Calculus</td>
            <td>3.0</td><td>A</td><td>9</td></tr>
        <tr><td>4</td><td>Jan-2026</td><td>STS1001</td><td>Soft Skills</td>
            <td>1.0</td><td>P</td><td>-</td></tr>
      </tbody></table>
    </div></body>`;
    const page = await newPage(browser);
    await page.setContent(html);
    await shim(page);
    await inject(page, ["js/shared/click.js", "js/grade_history_calc.js"]);
    await page.evaluate(() => window.__dispatch("exam_grade"));
    await delay(700); // build is debounced 400ms

    ok("panel rendered", await page.evaluate(() => !!document.getElementById("vtopext-gradehist-calc")));

    /* ---- and it must LEAVE when the table it describes does ----
     *
     * Reported 2026-08-22: "the grade history is not we did o can't see the
     * change or updated cgpa". Read live, the student was on the HOME page -
     * zero tables in the document - with the calculator still sitting there
     * saying "Current CGPA: 7.73, change any grade in the table above". There
     * was no table above, so there was nothing to change and nothing could
     * ever update.
     *
     * Only the fixed bar was being dropped on navigation; the panel was left
     * behind. A panel quoting a real CGPA on a page with no grades reads as a
     * broken calculator rather than a stale one.
     */

    const sels = await page.evaluate(() =>
      [...document.querySelectorAll("select.vtopext-gh-select")].map((s) => ({
        value: s.value,
        disabled: s.disabled,
        // the select must sit in the same cell as the grade it belongs to
        cellText: s.parentElement.textContent.replace(/\s+/g, ""),
      }))
    );
    ok("one select per history row (4)", sels.length === 4, String(sels.length));
    ok(
      "selects read the Grade column, not Grade Point",
      sels.length === 4 &&
        sels[0].value === "F" && sels[1].value === "B" && sels[2].value === "A",
      JSON.stringify(sels.map((s) => s.value))
    );
    ok(
      "off-scale P grade is preserved and disabled",
      sels.length === 4 && sels[3].value === "P" && sels[3].disabled === true,
      JSON.stringify(sels[3] || null)
    );

    const bodyText = () =>
      page.evaluate(() => document.getElementById("vtopext-gradehist-body").textContent);
    let text = await bodyText();
    ok("baseline is the page's official CGPA (8.50)", /Current CGPA:\s*8\.50/.test(text), text.slice(0, 120));
    ok("counts 3 of 4 rows towards the CGPA", /3 of 4 rows/.test(text), text.slice(0, 200));

    // change the FAILED attempt (row 1, F) to B: delta = (8-0)*4 = +32
    // projected = (8.5*27 + 32)/27 = 9.685 -> 9.69
    await page.evaluate(() => {
      const sel = document.querySelectorAll("select.vtopext-gh-select")[0];
      sel.value = "B";
      sel.dispatchEvent(new Event("change"));
    });
    text = await bodyText();
    ok("projected CGPA after F->B on the first attempt = 9.69", /Projected CGPA:\s*9\.69/.test(text), text.slice(0, 200));
    ok("change shown as +1.19", /Change:\s*\+1\.19/.test(text), text.slice(0, 200));
    ok(
      "only the changed row is tinted",
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll("tr[data-vtopext-gh]")];
        return rows.filter((r) => r.style.background).length === 1;
      })
    );

    // The reported complaint: "where is the CGPA change visible? it's not."
    // The summary panel renders AFTER the table, which on a real transcript is
    // 29 rows below the dropdown just changed — correct, and off screen. The
    // projected CGPA now also rides in a fixed bar that stays with the user.
    const bar = await page.evaluate(() => {
      const b = document.getElementById("vtopext-gh-bar");
      if (!b) return null;
      const cs = getComputedStyle(b);
      return {
        text: b.textContent.replace(/\s+/g, " ").trim(),
        position: cs.position,
        zIndex: cs.zIndex,
        hasReset: !!b.querySelector('[data-vr-action="gh-reset"]'),
        resetType: (b.querySelector('[data-vr-action="gh-reset"]') || {}).type,
      };
    });
    ok(
      "the projected CGPA follows the user in a fixed bar",
      !!bar && bar.position === "fixed" && /8\.50/.test(bar.text) && /9\.69/.test(bar.text),
      JSON.stringify(bar)
    );
    ok(
      "the bar sits BELOW VTOP's own overlays (z-index < 1000)",
      !!bar && Number(bar.zIndex) < 1000,
      String(bar && bar.zIndex)
    );
    ok(
      "its reset is a delegated type=button, not a per-element handler",
      !!bar && bar.hasReset && bar.resetType === "button",
      JSON.stringify(bar)
    );

    // and it must go away again when there is nothing to report
    await page.evaluate(() => {
      const b = document.querySelector('[data-vr-action="gh-reset"]');
      b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await delay(200);
    ok(
      "reset clears the bar and the tints",
      await page.evaluate(
        () =>
          !document.getElementById("vtopext-gh-bar") &&
          [...document.querySelectorAll("tr[data-vtopext-gh]")].every((r) => !r.style.background)
      )
    );

    // put the change back for the assertions that follow
    await page.evaluate(() => {
      const sel = document.querySelectorAll("select.vtopext-gh-select")[0];
      sel.value = "B";
      sel.dispatchEvent(new Event("change"));
    });

    // the SECOND CSE1005 attempt must be independent of the first
    await page.evaluate(() => {
      const sel = document.querySelectorAll("select.vtopext-gh-select")[1];
      sel.value = "S";
      sel.dispatchEvent(new Event("change"));
    });
    text = await bodyText();
    // +32 from row 1, plus (10-8)*4 = +8 from row 2 -> (229.5+40)/27 = 9.981
    ok(
      "repeated course code keeps the two attempts independent (9.98)",
      /Projected CGPA:\s*9\.98/.test(text),
      text.slice(0, 200)
    );

    await page.evaluate(() => {
      [...document.querySelectorAll("#vtopext-gradehist-body button")]
        .find((b) => /Reset changes/.test(b.textContent))
        .click();
    });
    text = await bodyText();
    ok("reset restores the baseline", !/Projected CGPA/.test(text) && /3 of 4 rows/.test(text), text.slice(0, 160));
    ok(
      "reset clears every select and tint",
      await page.evaluate(() => {
        const sels = [...document.querySelectorAll("select.vtopext-gh-select")];
        const rows = [...document.querySelectorAll("tr[data-vtopext-gh]")];
        return sels[0].value === "F" && sels[1].value === "B" &&
          rows.every((r) => !r.style.background);
      })
    );
    await page.close();
  }

  /* ===== Grade calculator: nested table must not steal the detection ===== */
  console.log("\n=== grade calculator: nested table inside the history table ===");
  {
    // Shape taken from the live VIT-AP page, which nests a small qualifying
    // table inside the real history table. Counting rows with
    // querySelectorAll("tr") let the parent claim its child's rows, and the
    // old "skip a table that contains a qualifying table" rule then threw the
    // real table away and left the nested one as the winner.
    const page = await newPage(browser);
    await page.setContent(`<body><div class="row"><table id="outer"><tbody>
      <tr><th>Sl.No.</th><th>Course Code</th><th>Course Title</th><th>Course Type</th>
          <th>Credits</th><th>Grade</th><th>Exam Month</th><th>Detail View</th></tr>
      <tr><td>1</td><td>CSE1005</td><td>Data Structures</td><td>Theory Only</td>
          <td>4.0</td><td>A</td><td>Jul-2025</td><td>view</td></tr>
      <tr><td>2</td><td>MAT2001</td><td>Applied Calculus</td><td>Theory Only</td>
          <td>3.0</td><td>B</td><td>Jan-2026</td><td>view</td></tr>
      <tr><td>3</td><td>PHY1001</td><td>Engineering Physics</td><td>Embedded Theory</td>
          <td>3.0</td><td>S</td><td>Jan-2026</td><td>view</td></tr>
      <tr><td colspan="8"><table id="inner"><tbody>
        <tr><td>Jul-2025</td><td>CHY1008</td><td>4.0</td><td>B</td></tr>
        <tr><td>Jan-2026</td><td>CHY1008</td><td>4.0</td><td>S</td></tr>
      </tbody></table></td></tr>
    </tbody></table></div></body>`);
    await shim(page);
    await inject(page, ["js/shared/click.js", "js/grade_history_calc.js"]);
    await delay(700);
    const picked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("tr[data-vtopext-gh]")];
      return {
        n: rows.length,
        table: rows.length ? rows[0].closest("table").id : null,
        codes: rows.map((r) => r.children[1] && r.children[1].textContent.trim()),
      };
    });
    ok(
      "picks the outer 3-row history table, not the nested 2-row one",
      picked.n === 3 && picked.table === "outer",
      JSON.stringify(picked)
    );
    ok(
      "reads all three courses",
      JSON.stringify(picked.codes) === JSON.stringify(["CSE1005", "MAT2001", "PHY1001"]),
      JSON.stringify(picked.codes)
    );
    // (9*4 + 8*3 + 10*3)/10 = 9.0
    const text = await page.evaluate(() =>
      document.getElementById("vtopext-gradehist-body").textContent
    );
    ok("CGPA computed over the outer table = 9.00", /Current CGPA:\s*9\.00/.test(text), text.slice(0, 140));
    await page.close();
  }

  /* ====== Grade calculator: no CGPA box -> computed baseline, flagged ====== */
  console.log("\n=== grade calculator: history with no CGPA box ===");
  {
    // (9*4 + 8*2)/6 = 8.666 -> 8.67, and the note must admit it's computed
    const page = await newPage(browser);
    await page.setContent(`<body><div class="row"><table><tbody>
      <tr><th>Exam Held</th><th>Course Code</th><th>Credits</th><th>Grade</th></tr>
      <tr><td>Jul-2025</td><td>CSE1005</td><td>4.0</td><td>A</td></tr>
      <tr><td>Jul-2025</td><td>MAT2001</td><td>2.0</td><td>B</td></tr>
    </tbody></table></div></body>`);
    await shim(page);
    await inject(page, ["js/shared/click.js", "js/grade_history_calc.js"]);
    await delay(700);
    let text = await page.evaluate(() => {
      const el = document.getElementById("vtopext-gradehist-body");
      return el ? el.textContent : null;
    });
    ok("computed baseline CGPA = 8.67", !!text && /Current CGPA:\s*8\.67/.test(text), (text || "").slice(0, 120));
    await page.evaluate(() => {
      const sel = document.querySelectorAll("select.vtopext-gh-select")[1];
      sel.value = "S";
      sel.dispatchEvent(new Event("change"));
    });
    text = await page.evaluate(() => document.getElementById("vtopext-gradehist-body").textContent);
    // (52 + (10-8)*2)/6 = 9.333 -> 9.33
    ok("projected from the computed baseline = 9.33", /Projected CGPA:\s*9\.33/.test(text), text.slice(0, 200));
    ok(
      "says the figure is computed, not VTOP's official CGPA",
      /No CGPA box on this page/.test(text),
      text.slice(0, 260)
    );
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
      const el = document.getElementById("vtopext-cgpa-sim");
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
      <input id="authorizedIDX" value="24TEST0001">
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
        vtopext_grade_credits: { ECE2015: 3, SWE2006: 4 },
        vtopext_cgpa_details: { cgpa: 8.28, creditsEarned: 95 },
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

    ok("panel rendered", await page.evaluate(() => !!document.getElementById("vtopext-cgpa-sim")));
    const rowCells = await page.evaluate(() =>
      [...document.querySelectorAll("#vtopext-cgpa-sim table tr")]
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
      page.evaluate(() => document.getElementById("vtopext-sim-body").textContent);
    let text = await bodyText();
    // 3cr B(8) + 4cr A(9) = 60/7 = 8.571
    ok("semester GPA from cached credits = 8.57", /Current semester GPA:\s*8\.57/.test(text), text.slice(0, 140));

    // ECE2015 B -> A, CGPA mode: (8.28*95 - 60 + 63)/95 = 8.311 -> 8.31
    await page.evaluate(() => {
      const sel = document.querySelectorAll("#vtopext-cgpa-sim select")[0];
      sel.value = "A";
      sel.dispatchEvent(new Event("change"));
      [...document.querySelectorAll("#vtopext-sim-body button")]
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
      await page.evaluate(() => !document.getElementById("vtopext-cgpa-sim"))
    );
    const stored = await page.evaluate(() => window.__storage);
    ok(
      "credits harvested to storage",
      !!stored.vtopext_grade_credits &&
        stored.vtopext_grade_credits.ECE2015 === 3 &&
        stored.vtopext_grade_credits.SWE2006 === 4,
      JSON.stringify(stored.vtopext_grade_credits)
    );
    ok(
      "CGPA details harvested to storage",
      !!stored.vtopext_cgpa_details && stored.vtopext_cgpa_details.cgpa === 8.28,
      JSON.stringify(stored.vtopext_cgpa_details)
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
      "vtopext_calendar_fall semester 2025-26": { lastInstructional: "2025-11-20", fetchedAt: Date.now() },
    };
    const page = await newPage(browser);
    await page.setContent("<body><div id='main-section'><div id='loadMyFragment'></div></div></body>");
    await shim(page, { storage });
    await inject(page, [
      "js/store/store.js",
      "js/store/saveTimeTableDetails.js",
      "js/utils/filterRepeated.js",
      "js/shared/click.js",
      "js/shared/ics.js",
      "js/shared/google_auth.js",
      "js/timetable_ics.js",
    ]);
    await page.evaluate(() => window.__dispatch("timetable_view_page"));
    await delay(1200);
    ok("export button rendered", await page.evaluate(() => !!document.getElementById("vtopext-timetable-ics")));
    await page.evaluate(() => document.getElementById("vtopext-timetable-ics").click());
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
        "vtopext_calendar_fall semester 2025-26": {
          lastInstructional: "2025-11-20",
          fetchedAt: Date.now(),
        },
        vtopext_exam_schedule: {
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
      "js/shared/click.js",
      "js/shared/ics.js",
      "js/shared/google_auth.js",
      "js/timetable_ics.js",
    ]);
    await page.evaluate(() => window.__dispatch("timetable_view_page"));
    await delay(1200);
    await page.evaluate(() => document.getElementById("vtopext-timetable-ics").click());
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
          () => document.getElementById("vtopext-timetable-ics").nextElementSibling?.textContent || ""
        )
      ),
      await page.evaluate(
        () => document.getElementById("vtopext-timetable-ics").nextElementSibling?.textContent || ""
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
      "vtopext_calendar_fall semester 2025-26": {
        lastInstructional: "2025-11-20",
        instructionalDays: mondays,
        holidays: ["2025-10-20"],
        fetchedAt: fixed,
      },
      vtopext_attendance_summary: {
        subjects: [{ name: "CSE1005 - Data Structures - Theory Only", code: "CSE1005" }],
      },
      // cached by the Exam Schedule page: one upcoming FAT (after the last
      // instructional day), one past CAT2, one CAT1 without a published time
      vtopext_exam_schedule: {
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
      "js/shared/click.js",
      "js/shared/ics.js",
      "js/shared/google_auth.js",
      "js/timetable_ics.js",
    ]);
    await page.evaluate(() => window.__dispatch("timetable_view_page"));
    await delay(1200);
    ok("import button rendered", await page.evaluate(() => !!document.getElementById("vtopext-timetable-gcal")));
    await page.evaluate(() => document.getElementById("vtopext-timetable-gcal").click());
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
    const note = await page.evaluate(() => document.querySelector(".vtopext-tt-note")?.textContent);
    ok(
      "inline confirmation with class/exam counts, end date + replaced count",
      note === "✓ 3 event(s) in Google Calendar — 2 weekly class(es) + 1 exam(s), classes until 2025-11-20, replaced 1 old",
      note
    );
    ok(
      "events tagged for future replacement",
      !!theory && theory.extendedProperties?.private?.vtopext === "timetable" &&
        singles.length === 1 && singles[0].extendedProperties?.private?.vtopext === "timetable"
    );

    // dead upstream OAuth client (what every user of the published build
    // hits): the import button must fall back to a panel of one-tap
    // TEMPLATE links — Google's 2026 Calendar revamp broke the
    // /r/settings/import page (never renders), so no download / no Import
    // tab any more
    await page.evaluate(() => {
      delete window.__storage.token;
      // the API import above now records itself; this scenario is a student who
      // has never imported, so forget it or the duplicate warning rightly fires
      delete window.__storage.vtopext_tt_imported;
      window.__storage.google_error =
        "OAuth2 request failed: Service responded with error: 'bad client id: 102739538495-xyz.apps.googleusercontent.com'";
      window.__opened = [];
      window.open = (u) => { window.__opened.push(u); return null; };
      window.__downloads.length = 0;
    });
    await page.evaluate(() => document.getElementById("vtopext-timetable-gcal").click());
    await delay(800);
    const fb = await page.evaluate(() => {
      const panel = document.getElementById("vtopext-tt-links");
      return {
        links: panel ? [...panel.querySelectorAll("a")].map((a) => ({ t: a.textContent, h: a.href })) : null,
        dl: window.__downloads[0] || null,
        opened: window.__opened,
        sent: (window.__sent || []).map((m) => m && m.message),
        note: document.getElementById("vtopext-timetable-gcal").nextElementSibling?.textContent || "",
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
      const a = document.querySelector("#vtopext-tt-links a");
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
      document.getElementById("vtopext-tt-links")?.remove();
    });
    await page.evaluate(() => document.getElementById("vtopext-timetable-gcal").click());
    await delay(800);
    const auto = await page.evaluate(() => ({
      note: document.getElementById("vtopext-timetable-gcal").nextElementSibling?.textContent || "",
      panel: !!document.getElementById("vtopext-tt-links"),
    }));
    ok(
      "worker auto-import → ✓ 3/3 saved note, no manual panel",
      /✓ 3\/3 event\(s\) saved to Google Calendar — 2 weekly class\(es\) \+ 1 exam\(s\), classes until 2025-11-20/.test(auto.note) &&
        !auto.panel,
      JSON.stringify(auto)
    );

    // A SECOND import must warn first. The TEMPLATE route cannot delete the
    // previous run — no extended property to find it by, no token to delete it
    // with — so re-running silently adds a complete second copy. Verified on
    // the real calendar 2026-08-09: 35 distinct classes in one week, most of
    // them present three times, from three runs that each reported success.
    await page.evaluate(() => {
      window.__autoImportSaves = 2;
    });
    await page.evaluate(() => document.getElementById("vtopext-timetable-gcal").click());
    await delay(500);
    const warned = await page.evaluate(() => ({
      note: document.getElementById("vtopext-timetable-gcal").nextElementSibling?.textContent || "",
      sent: (window.__sent || []).filter((m) => m && m.message === "gcal_template_import").length,
    }));
    ok(
      "a second import warns about duplicating instead of silently doing it",
      /already imported/.test(warned.note) &&
        /second copy/.test(warned.note) &&
        warned.sent === 2, // still 2 — this click imported nothing
      JSON.stringify(warned)
    );

    // clicking again is the confirmation, and then it proceeds as before:
    // partial auto-import (e.g. one editor never loaded) counts what saved and
    // shows the panel so the rest can be finished by hand
    await page.evaluate(() => document.getElementById("vtopext-timetable-gcal").click());
    await delay(800);
    const partial = await page.evaluate(() => ({
      note: document.getElementById("vtopext-timetable-gcal").nextElementSibling?.textContent || "",
      links: document.querySelectorAll("#vtopext-tt-links a").length,
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
      window.extract_lab_header = () => ["h0", "h1"];
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
      "js/shared/click.js", // the skip planner's button is delegated
      "js/shared/vtop.js",
      "js/attendance_insights.js",
    ]);    await page.evaluate(() => window.__dispatch("view_attendance"));
    await delay(2500);

    const banner = await page.evaluate(() => {
      const el = document.getElementById("vtopext-forecast-banner");
      return el ? el.textContent : null;
    });
    ok("forecast banner rendered", !!banner, banner ? banner.slice(0, 80) + "…" : "none");
    ok("flags 1 subject below 75%", !!banner && /1 subject\(s\) below 75%/.test(banner), banner ? "" : "no banner");
    ok("MAT2001 (60%) flagged below with recover count", !!banner && /MAT2001[\s\S]*60% — attend the next \d+/.test(banner));
    ok("CSE1005 (80%) NOT in below list", !!banner && !/CSE1005: 80% — attend/.test(banner));

    const table = await page.evaluate(READ_BUNK);
    ok("bunk table rendered", !!table, table ? table.length + " rows" : "none");
    // held column should be 10 for both (8+2, 6+4)
    const heldVals = table ? table.filter((r) => /CSE1005|MAT2001/.test(r[0])).map((r) => r[1]) : [];
    ok("held counts = 10 for both subjects", heldVals.length === 2 && heldVals.every((v) => v === "10"), JSON.stringify(heldVals));
    // bunkable-before-CAT-1 cells should be numeric (calendar parsed)
    const calendarWorked = await page.evaluate(() => {
      const all = window.__storage;
      const cal = Object.keys(all).find((k) => k.startsWith("vtopext_calendar_"));
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

    /* ---- the skip planner: real teaching days, not calendar days ----
     *
     * Added 2026-08-22, after this was worked out by hand for 25-31 Aug and
     * came to FOUR teaching days rather than seven - a holiday, a Sunday and a
     * "No Instructional Day" sat inside the range, and the student had no
     * Monday classes at all.
     *
     * This fixture's July is instructional on the 5th, 7th, 9th, 12th, 14th,
     * 16th and 18th; the 10th is CAT-I and the 15th a holiday. So 05-Jul to
     * 15-Jul is FIVE teaching days where counting calendar days says eleven.
     * That gap is the entire feature.
     */
    const planner = await page.evaluate(() => !!document.getElementById("vtopext-skip-planner"));
    ok("the skip planner renders under the bunk table", planner, String(planner));
    if (planner) {
      await page.evaluate(() => {
        document.getElementById("vtopext-skip-from").value = "2025-07-05";
        document.getElementById("vtopext-skip-to").value = "2025-07-15";
      });
      await page.click('[data-vr-action="skip-plan"]');
      await delay(400);
      const result = await page.evaluate(() => {
        const el = document.getElementById("vtopext-skip-result");
        return el
          ? { text: el.textContent.replace(/\s+/g, " "), rows: el.querySelectorAll("tbody tr").length }
          : null;
      });
      ok(
        "it counts teaching days from the calendar, not calendar days",
        !!result && /5 teaching day\(s\)/.test(result.text) && !/11 teaching/.test(result.text),
        (result && result.text.slice(0, 130)) || "no result"
      );
      ok(
        "the holiday and the CAT day inside the range are named as free",
        !!result && /cost you nothing/.test(result.text),
        (result && result.text.slice(0, 170)) || "no result"
      );
      ok(
        "one row per subject, each carrying an after-percentage",
        !!result && result.rows === 2 && /%/.test(result.text),
        JSON.stringify(result && result.rows)
      );

      /* ---- the recovery column ----
       *
       * "idk how i get 0 marhi like i attend all classe again until a month
       * na". The dip was being presented as the outcome: headroom measured on
       * the last day of the trip, with nothing said about the month of classes
       * after it. For the real 25-31 Aug case that meant showing 75.0% and
       * hiding the 85.7% the same student reaches by CAT-2.
       *
       * Range 05-08 July here so the exam (CAT-I, the 10th) falls AFTER it and
       * there is a teaching day between the two - the 9th - for the recovery
       * to be computed from. The property: the last column is a real figure
       * and never lower than the dip beside it.
       */
      await page.evaluate(() => {
        document.getElementById("vtopext-skip-from").value = "2025-07-05";
        document.getElementById("vtopext-skip-to").value = "2025-07-08";
      });
      await page.click('[data-vr-action="skip-plan"]');
      await delay(400);
      const pair = await page.evaluate(() =>
        [...document.querySelectorAll("#vtopext-skip-result tbody tr")].map((tr) => {
          const cells = [...tr.cells].map((c) => c.textContent);
          const num = (t) => {
            const m = /(\d+(?:\.\d+)?)%/.exec(t || "");
            return m ? parseFloat(m[1]) : null;
          };
          return { dip: num(cells[3]), back: num(cells[4]), backText: cells[4] };
        })
      );
      ok(
        "the recovery column is a real number, not a dash",
        pair.length === 2 && pair.every((p2) => typeof p2.back === "number"),
        JSON.stringify(pair.map((p2) => p2.backText))
      );
      ok(
        "attending everything afterwards never leaves you lower than the dip",
        pair.every((p2) => p2.back >= p2.dip),
        JSON.stringify(pair.map((p2) => `${p2.dip} -> ${p2.back}`))
      );
      ok(
        "the dip is labelled as the low point, not as the outcome",
        await page.evaluate(() =>
          /Lowest it gets/.test(document.getElementById("vtopext-skip-result").textContent) ||
          /Lowest it gets/.test(document.getElementById("vtopext-skip-planner").textContent)
        ),
        "header text"
      );
    }
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
        <input id="authorizedIDX" value="24TEST0001">
        <select id="semesterSubId"><option selected>Winter Semester 2025-26</option></select>
        <div class="table-responsive"><table><tbody>
          <tr><td>CSE1005 - Course A - Theory Only</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2025264','24TEST0001','AM_CSE1005_00100','TH')">view</a></td></tr>
          <tr><td>MAT2001 - Course B - Theory Only</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2025264','24TEST0001','AM_MAT2001_00200','TH')">view</a></td></tr>
          <tr><td>PHY1999 - Course C - Theory Only</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2025264','24TEST0001','AM_PHY1999_00300','TH')">view</a></td></tr>
          <tr><td>GAP1001 - Course F - Theory Only</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2025264','24TEST0001','AM_GAP1001_00600','TH')">view</a></td></tr>
          <tr><td>SWE2077 - Course D - Embedded Lab</td><td>AP2025264000340 - L31+L32+L43+L44 - 409</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2025264','24TEST0001','AM_SWE2077_00400','LO')">view</a></td></tr>
          <tr><td>SWE2088 - Course E - Embedded Lab</td><td>AP2025264000341 - L31+L32+L43+L44 - 409</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2025264','24TEST0001','AM_SWE2088_00500','LO')">view</a></td></tr>
        </tbody></table></div>`;
    });
    await inject(page, [
      "js/store/store.js",
      "js/store/saveTimeTableDetails.js",
      "js/shared/vtop.js",
      "js/utils/chooseCurrentSem.js",
      "js/attendance_insights.js",
    ]);
    await page.evaluate(() => window.__dispatch("view_attendance"));
    await delay(2500);

    const banner = await page.evaluate(() => {
      const el = document.getElementById("vtopext-forecast-banner");
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
    const table = await page.evaluate(READ_BUNK);
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
    // proactive load (home card): nothing cached, no semester name given -> it
    // reads the newest started plain semester itself instead of asking the
    // student to open Attendance first
    await page.evaluate(() => {
      Object.keys(window.__storage)
        .filter((k) => /calendar/.test(k))
        .forEach((k) => delete window.__storage[k]);
    });
    const auto = await page.evaluate(async () => {
      const c = await window.vrAcademicCalendar();
      return c ? { semester: c.semester, days: (c.instructionalDays || []).length } : null;
    });
    ok(
      "home card can load the calendar with no semester name",
      !!auto && auto.semester === "Winter Semester 2025-26",
      JSON.stringify(auto)
    );
    const ptr = await page.evaluate(() => !!window.__storage.vtopext_latest_calendar);
    ok("...and leaves the latest-calendar pointer the card reads", ptr);
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
      const flag = row && row.querySelector(".vtopext-stale-flag");
      return flag ? flag.textContent : null;
    });
    ok(
      "stale flag shown on VTOP's own attendance row",
      !!vtopStale && /not posted since 29 Dec/.test(vtopStale),
      vtopStale || "no flag"
    );
    // richer snapshot for the home card / marks page
    const snap = await page.evaluate(
      () => (window.__storage.vtopext_attendance_summary || {}).subjects || []
    );
    const phySnap = snap.find((s) => s.code === "PHY1999");
    ok(
      "snapshot carries code/pct/safeNow (PHY1999: 100%, 3 safe)",
      !!phySnap && phySnap.pct === 100 && phySnap.safeNow === 3,
      JSON.stringify(phySnap)
    );
    // what-if simulator: open CSE's row, skip one -> 8/11 = 72.7%
    const whatIf = await page.evaluate(() => {
      const row = [...document.querySelectorAll("#vtopext-bunk-table-container tr")]
        .find((r) => /CSE1005/.test(r.textContent));
      const cell = row.cells[0];
      cell.click();
      const skipBtn = [...cell.querySelectorAll("button")]
        .find((b) => b.textContent === "Skip +1");
      skipBtn.click();
      const sim = cell.querySelector(".vtopext-whatif");
      return { visible: sim.style.display !== "none", text: sim.textContent };
    });
    ok(
      "what-if: skip one on 8/10 -> 8/11 = 72.7%",
      whatIf.visible && /1 skipped, 0 attended → 8\/11 = 72\.7%/.test(whatIf.text),
      whatIf.text.slice(0, 90)
    );
    const cal = await page.evaluate(() => {
      const all = window.__storage;
      const k = Object.keys(all).find((x) => x.startsWith("vtopext_calendar_"));
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
    // Labs sit no CATs. What matters is that a lab row NEVER shows a CAT bunk
    // count — it used to say so in words, on every lab row, in two columns,
    // which is ten cells of the same non-answer on a real page. Now the cell
    // is an em dash and the distinction is proved by it not being a number.
    ok(
      "a lab row never shows a CAT bunk count",
      !!lab88 && !/\d/.test(String(lab88[4])) && !/\d/.test(String(lab88[5])),
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
        <input id="authorizedIDX" value="24TEST0001">
        <select id="semesterSubId"><option selected>Winter Semester 2024-25 Freshers</option></select>
        <div class="table-responsive"><table>
          <thead><tr><th>Course Detail</th><th>Attended Classes</th><th>Total Classes</th><th>Attendance Detail</th></tr></thead>
          <tbody>
          <tr><td>CHY1008 - Chemistry - Theory Only</td><td>8</td><td>10</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2024999','24TEST0001','AM_CHY1008_00100','TH')">view</a></td></tr>
          <tr><td>NEW0000 - Dropped Course - Theory Only</td><td>0</td><td>0</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2024999','24TEST0001','AM_NEW0000_00200','TH')">view</a></td></tr>
          <tr><td>EMP1111 - Ghost Register - Theory Only</td><td>5</td><td>5</td><td><a onclick="callStudentAttendanceDetailDisplay('AP2024999','24TEST0001','AM_EMP1111_00300','TH')">view</a></td></tr>
        </tbody></table></div>`;
    });
    await inject(page, [
      "js/store/store.js",
      "js/store/saveTimeTableDetails.js",
      "js/shared/vtop.js",
      "js/attendance_insights.js",
    ]);
    await page.evaluate(() => window.__dispatch("view_attendance"));
    await delay(2500);

    const state = await page.evaluate(`({
      rows: ${READ_BUNK},
      detailCalls: window.__detailCalls,
      warns: window.__warns.filter((w) => /insight failed/.test(w)),
    })`);
    const chy = state.rows && state.rows.find((r) => /CHY1008/.test(r[0]));
    /*
     * These three used to assert grid cells reading "could've bunked 1",
     * "none this sem" and "could've bunked 0". The computation is unchanged;
     * the presentation is not. On a FINISHED semester every exam column is a
     * retrospective or an exam that never happened — seven columns of history
     * where a student is looking for advice — so those columns are dropped and
     * the retrospectives ride in the subject cell's tooltip instead. The
     * assertions therefore check the tooltip, and check that the columns are
     * genuinely gone rather than rendering "--".
     */
    ok(
      "digit 'CAT - 1' parsed: retrospective could've-bunked kept in the tooltip",
      !!chy && /CAT-1: could've bunked 1(?!\d)/.test(chy[B.title]),
      chy ? `title=${chy[B.title]}` : "no row"
    );
    ok(
      "FAT retrospective on the finished sem (could've bunked 0)",
      !!chy && /FAT: could've bunked 0/.test(chy[B.title]),
      chy ? `title=${chy[B.title]}` : "no row"
    );
    ok(
      "a finished semester draws no exam columns at all",
      !!chy && chy[B.cat1] === null && chy[B.cat2] === null && chy[B.fat] === null,
      chy ? `headers=${chy[B.headers]}` : "no row"
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
        vtopext_attendance_summary: {
          fetchedAt: Date.now(),
          subjects: [{ name: "SWE2007 - Embedded Lab", code: "SWE2007", pct: 50, safeNow: 0, unit: "lab(s)" }],
        },
      },
    });
    await inject(page, ["js/store/store.js", "js/store/saveMarksPage.js", "js/marks_page.js"]);
    await page.evaluate(() => window.__dispatch("mark_view_page"));
    await delay(500);
    const totals = await page.evaluate(() => {
      const tr = document.querySelector(".vtopext-marks-total");
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
      () => document.querySelectorAll(".vtopext-marks-total").length
    );
    ok("totals row not duplicated on message re-fire", rowCount === 1, `rows=${rowCount}`);
    const badge = await page.evaluate(() => {
      const b = document.querySelector("[data-vtopext-att-flag]");
      return b ? b.textContent : null;
    });
    ok(
      "attendance-risk badge on the course row (50%)",
      !!badge && /attendance 50%/.test(badge),
      badge || "no badge"
    );
    await page.close();
  }

  /* ========== attendance: one decisive pick, and never a walk ==========
   *
   * REWRITTEN 2026-08-21. The old block asserted the step-down walk —
   * "walked Fall 26-27 -> Summer II -> Winter (3 loads, stops there)" — which
   * is the behaviour that had to go. Measured on the live Marks page the same
   * day: a semester with no rows is almost always a semester that has only
   * just begun, not a wrong guess. Answering that by loading LAST semester
   * under this semester's heading is a wrong answer rather than an empty one.
   *
   * The page is also no longer driven by attendance.js's own copy of the
   * logic: it is registered as "attendance" in js/shared/auto_semester.js and
   * answers `semester_page_open`, which is the message that fires when the
   * PICKER arrives rather than after somebody has already answered it.
   */
  console.log("\n=== attendance auto-semester: one decisive pick, no walk ===");
  {
    const fixed = new Date("2026-07-05T10:00:00+05:30").getTime();

    // `fallRows` is what VTOP returns for the semester the student is in:
    // real attendance in one case, registered-but-nothing-posted in the other.
    const attendancePage = async (fallRows) => {
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
      // stand-in for VTOP's processStudentAttendance(), then the data message
      // the service worker sends once the rows come back
      await page.addScriptTag({
        content: `
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
            c.innerHTML = tbl("<tr><td>1</td><td>ECE2015 - Theory</td><td>40</td><td>50</td></tr>");
          else if (/fall/i.test(t)) c.innerHTML = tbl(${JSON.stringify(fallRows)});
          else c.innerHTML = "";
          setTimeout(() => window.__dispatch("view_attendance"), 50);
        });
      `,
      });
      await inject(page, [
        "js/store/store.js",
        "js/store/saveAttendancePage.js",
        "js/utils/chooseCurrentSem.js",
        "js/shared/auto_semester.js",
        "js/attendance.js",
      ]);
      return page;
    };

    const readState = (page) =>
      page.evaluate(() => {
        const sel = document.getElementById("semesterSubId");
        return {
          selected: sel.options[sel.selectedIndex].text,
          changes: window.__semChanges,
          rows: document.querySelectorAll(".table-responsive tbody tr").length,
          alert: (document.querySelector(".vtopext-bunk-cell") || {}).textContent || null,
        };
      });

    // The ordinary case: the semester the student is in has attendance.
    {
      const page = await attendancePage(
        "<tr><td>1</td><td>ECE2015 - Theory</td><td>48</td><td>58</td></tr>"
      );
      await page.evaluate(() =>
        window.__dispatchMsg({ message: "semester_page_open", page: "attendance" })
      );
      await delay(1500);
      const state = await readState(page);
      ok(
        "the picker is answered with the student's own semester, once",
        /fall/i.test(state.selected) && state.changes === 1,
        `selected="${state.selected}" loads=${state.changes}`
      );
      ok("attendance rows loaded without a manual reselect", state.rows === 1);
      // 48/58 at the 75% limit -> floor((4*48 - 3*58)/3) = 6 skippable
      ok(
        "75% alert column decorated on the auto-loaded table",
        state.alert === "Only 6 class(es) can be Skipped",
        state.alert || "no alert cell"
      );

      // loop regression: a repeated page message (e.g. a detail fetch the
      // worker misrouted) must not re-trigger a load
      await page.evaluate(() =>
        window.__dispatchMsg({ message: "semester_page_open", page: "attendance" })
      );
      await page.evaluate(() => window.__dispatch("view_attendance_page"));
      await delay(1200);
      const after = await readState(page);
      ok(
        "repeated page messages do not reload (no loop)",
        after.changes === 1 && /fall/i.test(after.selected),
        `loads=${after.changes} selected="${after.selected}"`
      );
      await page.close();
    }

    /*
     * THE ONE THE WALK USED TO GET WRONG: registration is done, the semester
     * has begun, and every course still reads 0/0 because no class has been
     * marked yet. The old code read that as "wrong semester" and loaded Winter
     * 2025-26 instead. It must now stay put and show an honest empty table.
     */
    {
      const page = await attendancePage(
        "<tr><td>1</td><td>SWE2009 - Theory</td><td>0</td><td>0</td></tr>"
      );
      await page.evaluate(() =>
        window.__dispatchMsg({ message: "semester_page_open", page: "attendance" })
      );
      await delay(1800);
      const state = await readState(page);
      ok(
        "a semester with nothing posted yet is not 'corrected' to the last one",
        /fall/i.test(state.selected) && state.changes === 1,
        `selected="${state.selected}" loads=${state.changes}`
      );
      await page.close();
    }
  }

  /* ============ login page: reload guard (flicker regression) ============ */
  console.log("\n=== login page: heal the captcha in place, never navigate ===");
  {
    /*
     * REWRITTEN 2026-08-17 against the live page, not against a belief.
     *
     * The previous fixtures asserted a login page with a visible `#stdForm`
     * and no `#captchaBlock`, and the code was written to match them. Read off
     * https://vtop.vitap.ac.in/vtop/login the same day:
     *
     *   - the form is `#vtopLoginForm`; `#stdForm` is NOT on this page at all,
     *     it lives on /vtop/open/page (the role picker) alongside empForm,
     *     parentForm and alumniForm, all POSTing to /vtop/prelogin/setup
     *   - the captcha lives in `#captchaBlock` as an <img> with a base64 JPEG
     *   - VTOP's own ⟳ button calls loadCaptcha(), which is
     *     `GET /vtop/get/new/captcha` -> innerHTML of #captchaBlock
     *
     * So the old "reload when a visible #stdForm has no captcha" could never
     * fire, and reloading was the wrong instrument anyway: /vtop/login is
     * reached by POSTing the role picker, so re-navigating it is what dropped
     * the student back on the Student/Parent chooser. These fixtures now model
     * the real markup, and the assertions are about the captcha ENDPOINT being
     * used rather than about reload counts.
     */
    const captchaImg =
      "<img class='form-control img-fluid bg-light border-0' src='data:image/jpeg;base64,/9j/AAA'>";
    const loginForm = (inner) =>
      "<body><form id='vtopLoginForm'><input name='_csrf' type='hidden' value='x'>" +
      "<input id='username' name='username'><input id='password' type='password'>" +
      `<div id='captchaBlock' class='input-group'>${inner}</div>` +
      "<input id='captchaStr' name='captchaStr'><button id='submitBtn'>Submit</button>" +
      "</form></body>";

    const pages = {
      // /vtop/open/page — the real role picker. Nothing here is broken and
      // nothing may be touched: this is the page the student was being thrown
      // back to, and it has no captcha to heal.
      "/picker":
        "<body><div class='card'>Student</div><div class='card'>Employee</div>" +
        "<div class='card'>Parent</div><div class='card'>Alumni</div>" +
        "<form id='stdForm' action='/vtop/prelogin/setup' method='post'><input id='uname'></form>" +
        "<form id='parentForm' action='/vtop/prelogin/setup' method='post'></form></body>",
      // the reCAPTCHA variant VIT-AP sometimes serves instead: invisible by
      // design, so "no image" is health, not a fault
      "/recaptcha":
        "<body><form id='vtopLoginForm'><input name='_csrf' type='hidden' value='x'>" +
        "<input name='username'><input name='password' type='password'>" +
        "<input name='gResponse' type='hidden'><button>Submit</button></form></body>",
      "/empty": "<body>   </body>",
      // healthy image-captcha login page
      "/captcha": loginForm(captchaImg),
      // THE case this file exists for: the form arrived, the captcha did not
      "/nocaptcha": loginForm(""),
      // the OTP step must never be touched — a code has already been sent
      "/otp":
        "<body><form id='vtopLoginForm'>An OTP has been sent to your registered email." +
        "<input id='otpValue' maxlength='6'><button>Verify OTP</button></form></body>",
    };

    const page = await newPage(browser);
    let captchaHits = 0;
    await page.route("https://vtop.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/vtop/get/new/captcha") {
        captchaHits++;
        return route.fulfill({
          contentType: "text/html",
          body: `${captchaImg}<button class='btn btn-success'><i class='fa fa-refresh'></i></button>`,
        });
      }
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
        counter: sessionStorage.getItem("vtopext_login_reloads"),
        blockHasImg: !!document.querySelector("#captchaBlock img[src^='data:image/']"),
      }));
    const resetCounter = () =>
      page.evaluate(() => sessionStorage.removeItem("vtopext_login_reloads"));

    // --- the role picker is left completely alone ---
    await page.goto("https://vtop.test/picker");
    await page.addScriptTag({ content: trapReloads });
    await resetCounter();
    captchaHits = 0;
    for (let i = 0; i < 3; i++) await inject(page, ["js/captcha/refreshTillCaptcha.js"]);
    await delay(300);
    const picker = await state();
    ok(
      "the role picker is never reloaded and never probed",
      picker.reloads === 0 && captchaHits === 0,
      `reloads=${picker.reloads} captchaFetches=${captchaHits}`
    );

    /* --- reCAPTCHA page: the one you cannot log in from ---
     *
     * INVERTED 2026-08-22. This used to assert "left alone", on the strength
     * of a DOM reading showing the page rendered exactly as VTOP intended.
     * It does — and it still will not authenticate: "without the captcha we
     * cant login no matter how many times i click submit". Rendering correctly
     * and working are different properties, and only the first is visible in
     * the DOM. So the page is reloaded until VTOP serves the image captcha.
     *
     * Both halves matter: it must ask, and it must stop asking. Injected more
     * times than the budget allows, the reload count must equal the cap and
     * not the number of injections.
     */
    await page.goto("https://vtop.test/recaptcha");
    await page.addScriptTag({ content: trapReloads });
    await resetCounter();
    captchaHits = 0;
    for (let i = 0; i < 8; i++) await inject(page, ["js/captcha/refreshTillCaptcha.js"]);
    await delay(500);
    const recap = await state();
    ok(
      "reCAPTCHA login page is reloaded to hunt for the image captcha",
      recap.reloads > 0 && captchaHits === 0,
      JSON.stringify({ ...recap, captchaHits })
    );
    ok(
      "…and the hunt is capped, so it can never become a reload loop",
      recap.reloads === 5 && recap.counter === "5",
      JSON.stringify({ ...recap, captchaHits })
    );

    // --- the healthy image-captcha page ---
    await page.goto("https://vtop.test/captcha");
    await page.addScriptTag({ content: trapReloads });
    captchaHits = 0;
    await inject(page, ["js/captcha/refreshTillCaptcha.js"]);
    await delay(300);
    const captcha = await state();
    ok(
      "a login page that already has its captcha is not touched",
      captcha.reloads === 0 && captcha.counter === null && captchaHits === 0,
      JSON.stringify({ ...captcha, captchaHits })
    );

    // --- THE FIX: captcha missing, healed in place, page never navigated ---
    await page.goto("https://vtop.test/nocaptcha");
    await page.addScriptTag({ content: trapReloads });
    await resetCounter();
    captchaHits = 0;
    await inject(page, ["js/captcha/refreshTillCaptcha.js"]);
    await delay(600);
    const healed = await state();
    ok(
      "a captcha-less login form fetches a new captcha from VTOP's own endpoint",
      captchaHits === 1,
      `captchaFetches=${captchaHits}`
    );
    ok(
      "...and the block now holds a real image, so the student can log in",
      healed.blockHasImg,
      JSON.stringify(healed)
    );
    ok(
      "...WITHOUT reloading — a reload is what dropped them on the role picker",
      healed.reloads === 0,
      `reloads=${healed.reloads}`
    );

    // --- the OTP step is untouchable ---
    await page.goto("https://vtop.test/otp");
    await page.addScriptTag({ content: trapReloads });
    await resetCounter();
    captchaHits = 0;
    for (let i = 0; i < 3; i++) await inject(page, ["js/captcha/refreshTillCaptcha.js"]);
    await delay(300);
    const otp = await state();
    ok(
      "the OTP step is neither reloaded nor refreshed",
      otp.reloads === 0 && captchaHits === 0,
      JSON.stringify({ ...otp, captchaHits })
    );

    // --- a dead load is reloaded too, on the same shared budget ---
    await page.goto("https://vtop.test/empty");
    await page.addScriptTag({ content: trapReloads });
    await resetCounter();
    for (let i = 0; i < 8; i++) await inject(page, ["js/captcha/refreshTillCaptcha.js"]);
    const empty = await state();
    ok(
      "a genuinely empty page is retried, capped per tab so it cannot loop",
      empty.reloads === 5 && empty.counter === "5",
      `reloads=${empty.reloads} counter=${empty.counter}`
    );

    /* ---- the login form that arrives AFTER the script ran ----
     *
     * FOUND LIVE 2026-08-17, by walking the portal signed out. `/vtop/login`
     * can serve the four-role landing page (Student / Employee / Parent /
     * Alumni), and the login form arrives only once Student is pressed — at
     * the SAME URL. Whatever ran at document load therefore ran against the
     * landing page, found no #captchaBlock, and returned; both this file and
     * captchaparser.js then never looked again, because each attached its
     * observer to a block that did not exist yet.
     *
     * So on the path a student actually takes, the healing and the solver were
     * both dead on arrival whenever VIT-AP was serving the image captcha.
     */
    await page.goto("https://vtop.test/picker");
    await page.addScriptTag({ content: trapReloads });
    await resetCounter();
    captchaHits = 0;
    await inject(page, ["js/captcha/refreshTillCaptcha.js"]);
    await delay(200);
    ok(
      "nothing is fetched while only the landing page is on screen",
      captchaHits === 0,
      `captchaFetches=${captchaHits}`
    );
    // press Student: VTOP swaps the login form in, same document, no navigation
    await page.evaluate(() => {
      document.body.innerHTML =
        "<form id='vtopLoginForm'><input name='_csrf' type='hidden' value='x'>" +
        "<input id='username' name='username'><input id='password' type='password'>" +
        "<div id='captchaBlock' class='input-group'></div>" +
        "<input id='captchaStr' name='captchaStr'><button id='submitBtn'>Submit</button></form>";
    });
    await delay(1400);
    const late = await state();
    ok(
      "a login form that appears after load still gets its captcha healed",
      captchaHits === 1 && late.blockHasImg,
      JSON.stringify({ ...late, captchaHits })
    );
    ok(
      "...and still without a reload",
      late.reloads === 0,
      `reloads=${late.reloads}`
    );

    // Same late arrival, reCAPTCHA variant: no image is ever coming, so the
    // wait has to end rather than poll for its full cap against a page that
    // is not broken.
    await page.goto("https://vtop.test/picker");
    await page.addScriptTag({ content: trapReloads });
    await resetCounter();
    captchaHits = 0;
    await inject(page, ["js/captcha/refreshTillCaptcha.js"]);
    await page.evaluate(() => {
      document.body.innerHTML =
        "<form id='vtopLoginForm'><input name='_csrf' type='hidden' value='x'>" +
        "<input name='username'><input name='password' type='password'>" +
        "<input name='gResponse' type='hidden'><button>Submit</button></form>";
    });
    await delay(1400);
    const lateRecap = await state();
    ok(
      "a late reCAPTCHA form is recognised and left alone",
      captchaHits === 0 && lateRecap.reloads === 0 && lateRecap.counter === null,
      JSON.stringify({ ...lateRecap, captchaHits })
    );

    await page.close();
  }

  /* ============ the solver, on a login form that arrives late ============
   *
   * captchaparser.js had the same fault as refreshTillCaptcha.js and for the
   * same reason: it attached its MutationObserver to #captchaBlock once, at
   * window "load", and returned quietly when the block was not there yet. On
   * the landing-page → Student path (same URL, no navigation) that meant the
   * solver never ran at all, however well the model worked.
   *
   * Running the model itself needs 600 KB of weights and a real captcha image,
   * neither of which belongs in a unit test. What IS worth asserting is that
   * the solver reaches the point of ASKING for the weights — that is the first
   * thing solve() does, and it only happens if the block was found.
   */
  console.log("\n=== captcha solver: attaches to a block that appears later ===");
  {
    const captchaImg =
      "<img class='form-control img-fluid bg-light border-0' " +
      "src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'>";
    const landing =
      "<body><div class='card'>Student</div><div class='card'>Employee</div></body>";

    const runSolver = async (afterHtml) => {
      const page = await newPage(browser);
      let weightsHits = 0;
      await page.route("https://vtop.vitap.ac.in/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/weights.json") {
          weightsHits++;
          return route.fulfill({ contentType: "application/json", body: '{"weights":[],"biases":[]}' });
        }
        route.fulfill({ contentType: "text/html", body: landing });
      });
      await page.goto("https://vtop.vitap.ac.in/vtop/login");
      await shim(page, {});
      await page.addScriptTag({
        content:
          "chrome.runtime.getURL = () => 'https://vtop.vitap.ac.in/weights.json';",
      });
      await inject(page, ["js/captcha/captchaparser.js"]);
      // the real page fires "load" before our script is added in this harness
      await page.evaluate(() => window.dispatchEvent(new Event("load")));
      await delay(200);
      const before = weightsHits;
      await page.evaluate((html) => { document.body.innerHTML = html; }, afterHtml);
      await delay(1400);
      await page.close();
      return { before, after: weightsHits };
    };

    const withImage = await runSolver(
      "<form id='vtopLoginForm'><div id='captchaBlock'>" + captchaImg + "</div>" +
        "<input id='captchaStr'><button id='submitBtn'>Submit</button></form>"
    );
    ok(
      "nothing is attempted while only the landing page is on screen",
      withImage.before === 0,
      JSON.stringify(withImage)
    );
    ok(
      "a captcha that appears after load is picked up and solved",
      withImage.after >= 1,
      JSON.stringify(withImage)
    );

    const withRecaptcha = await runSolver(
      "<form id='vtopLoginForm'><input name='gResponse' type='hidden'>" +
        "<button>Submit</button></form>"
    );
    ok(
      "a late reCAPTCHA form is left alone — the model is never loaded for it",
      withRecaptcha.after === 0,
      JSON.stringify(withRecaptcha)
    );
  }

  /* ============ exam schedule (2026): header-driven .ics export ============ */
  console.log("\n=== exam schedule (2026): per-group .ics export + 🔔 reminders ===");
  {
    // 1 Apr 2026: FAT's ECE2015 (04-May) is upcoming, FRL1001 (10-Feb) and
    // all of CAT1 (10-Mar) are past, PHY0000 has no published time
    const fixedExam = new Date("2026-04-01T09:00:00+05:30").getTime();
    const gcalExam = [];
    const page = await newPage(browser);
    const gcalExamDeletes = [];
    await page.route("https://www.googleapis.com/**", (route) => {
      const req = route.request();
      const method = req.method();
      // Split by verb: ✉️ now LISTS its previous run and DELETEs it before
      // POSTing the new events, so counting every request as "an event created"
      // would make a working replace look like a duplication.
      if (method === "POST") gcalExam.push(JSON.parse(req.postData() || "{}"));
      if (method === "DELETE") gcalExamDeletes.push(req.url());
      // answer the cleanup's list query with one stale event, so the
      // replace-don't-duplicate path is actually exercised rather than skipped
      if (method === "GET" && /privateExtendedProperty/.test(req.url()))
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ items: [{ id: "old-run-1" }] }),
        });
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
    await inject(page, ["js/shared/click.js", "js/shared/ics.js", "js/shared/google_auth.js", "js/exam_schedule.js"]);
    await page.evaluate(() => window.__dispatch("exam_schedule"));
    await delay(300);
    const btns = await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .map((b) => b.textContent.trim())
        .filter((t) => t.includes("Download"))
    );
    ok("one download button per exam group (FAT + CAT1)", btns.length === 2, JSON.stringify(btns));
    const counts = await page.evaluate(() => ({
      notify: [...document.querySelectorAll("button")].filter((b) => /notify me/i.test(b.textContent)).length,
      mail: [...document.querySelectorAll("button")].filter((b) => /email me/i.test(b.textContent)).length,
    }));
    ok(
      "one 🔔 notify + one ✉️ email button per exam group",
      counts.notify === 2 && counts.mail === 2,
      JSON.stringify(counts)
    );

    // 📅 one-tap template links need no OAuth at all — only the upcoming
    // exam with a published window gets one (past + no-time rows skipped)
    const gcalLinks = await page.evaluate(() =>
      [...document.querySelectorAll(".vtopext-gcal-link")].map((a) => a.href)
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

    const examCache = await page.evaluate(() => window.__storage.vtopext_exam_schedule);
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
      () => document.querySelector(".vtopext-exam-note")?.textContent
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
    ok("message re-fire does not duplicate buttons", btns2 === 8, `buttons=${btns2}`);

    const bellNote = (btnRe, which) =>
      page.evaluate(([bre, re]) => {
        const b = [...document.querySelectorAll("button")]
          .filter((x) => new RegExp(bre, "i").test(x.textContent))
          .find((x) => new RegExp(re).test(x.closest("td").textContent));
        return b && b.nextElementSibling ? b.nextElementSibling.textContent : null;
      }, [btnRe, which]);

    // 🔔 local notifications: no Google at all — 1 day + 2 h before the one
    // upcoming exam (past FRL1001 and no-time PHY0000 skipped)
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .filter((b) => /notify me/i.test(b.textContent))[0]
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
        .filter((b) => /notify me/i.test(b.textContent))[1]
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

    /*
     * 📧 the OTHER kind of "email me": a real message in the inbox NOW, sent
     * through the student's own Gmail — as opposed to ✉️ below, which schedules
     * Calendar events that will mail a reminder a day before each exam. Both
     * are wanted, and confusing them is exactly what made the old single ✉️
     * button feel broken: it looked like "mail me the schedule" and behaved
     * like "remind me later".
     */
    await page.evaluate(() => {
      window.__mails = [];
      [...document.querySelectorAll("button")]
        .filter((b) => /mail me the list/i.test(b.textContent))[0]
        .click();
    });
    await delay(400);
    const sentMail = await page.evaluate(() => (window.__mails || [])[0] || null);
    ok(
      "📧 FAT mails the one upcoming exam, and says which inbox it went to",
      !!sentMail &&
        /FAT exam schedule — 1 upcoming/.test(sentMail.subject) &&
        /✓ emailed 1 exam\(s\) to student@vitapstudent\.ac\.in/.test(
          (await bellNote("mail me the list", "FAT")) || ""
        ),
      JSON.stringify({ subject: sentMail && sentMail.subject, note: await bellNote("mail me the list", "FAT") })
    );
    ok(
      "the mail carries date, window, venue and seat — not just the course code",
      !!sentMail &&
        /ECE2015/.test(sentMail.html) &&
        /04-May-2026/.test(sentMail.html) &&
        /10:00 AM - 01:00 PM/.test(sentMail.html) &&
        /CB-324/.test(sentMail.html) &&
        /R3C1/.test(sentMail.html) &&
        // past FRL1001 and the no-time PHY0000 row must not be in there
        !/FRL1001|PHY0000/.test(sentMail.html),
      (sentMail && sentMail.html ? sentMail.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ") : "no mail").slice(0, 220)
    );
    ok(
      "and a plain-text alternative rides along for phone clients",
      !!sentMail && /ECE2015/.test(sentMail.text) && /Venue CB-324/.test(sentMail.text),
      (sentMail && sentMail.text ? sentMail.text : "no text").slice(0, 160)
    );
    // The one failure a student cannot fix by clicking again: gmail.send not
    // added to the Cloud project. It must name the checkbox, not say "failed".
    await page.evaluate(() => {
      window.__mailError = "gmail_send_scope";
      window.__mails = [];
      [...document.querySelectorAll("button")]
        .filter((b) => /mail me the list/i.test(b.textContent))[0]
        .click();
    });
    await delay(400);
    ok(
      "a missing gmail.send scope names the Cloud Console fix, not 'failed'",
      /gmail\.send/.test((await bellNote("mail me the list", "FAT")) || ""),
      String(await bellNote("mail me the list", "FAT"))
    );
    // CAT1 is entirely in the past — nothing to mail, and nothing sent
    await page.evaluate(() => {
      window.__mailError = null;
      window.__mails = [];
      [...document.querySelectorAll("button")]
        .filter((b) => /mail me the list/i.test(b.textContent))[1]
        .click();
    });
    await delay(400);
    ok(
      "📧 on an all-past group sends no mail at all",
      (await page.evaluate(() => (window.__mails || []).length)) === 0 &&
        /no upcoming exams/.test((await bellNote("mail me the list", "CAT1")) || ""),
      String(await bellNote("mail me the list", "CAT1"))
    );

    // SEEN LIVE 2026-10-11: the three secondary buttons rendered as bare text on
    // the real page, because btn-outline-primary does not exist in the older
    // Bootstrap the logged-in portal uses. Their outline must not depend on any
    // framework class, so assert it on the element itself.
    const looks = await page.evaluate(() =>
      [...document.querySelectorAll("[data-vr-action]")]
        .filter((b) => /^exam-(bell|mail|send)$/.test(b.dataset.vrAction))
        .map((b) => {
          const c = getComputedStyle(b);
          return { w: c.borderTopWidth, style: c.borderTopStyle, color: c.color, cls: b.className };
        })
    );
    ok(
      "the secondary exam buttons carry their own visible border and colour",
      looks.length >= 3 &&
        looks.every((l) => l.w === "1px" && l.style === "solid" && l.color !== "rgb(0, 0, 0)" && !/outline-primary/.test(l.cls)),
      JSON.stringify(looks[0])
    );

    // ✉️ is now mailed by the extension itself — no Google sign-in anywhere.
    // With no saved address the ONLY thing missing is where to write, so it asks.
    await page.evaluate(() => {
      delete window.__storage.vtopext_reminder_email;
      window.__sent = [];
      [...document.querySelectorAll("button")]
        .filter((b) => /email me/i.test(b.textContent))[0]
        .click();
    });
    await delay(400);
    const askShown = await page.evaluate(() => !!document.querySelector(".vtopext-mail-ask input"));
    ok(
      "✉️ with no saved address asks where to send, and schedules nothing yet",
      askShown && !(window_reminders_for(await page.evaluate(() => window.__reminders || {}), "exam-mail:FAT")),
      `ask=${askShown}`
    );
    await page.fill(".vtopext-mail-ask input", "me@vitapstudent.ac.in");
    await page.press(".vtopext-mail-ask input", "Enter");
    await delay(900);
    const scheduled = await page.evaluate(() => (window.__reminders || {})["exam-mail:FAT"] || []);
    ok(
      "✉️ FAT schedules TWO emails for the one upcoming exam (24 h and 2 h before)",
      scheduled.length === 2,
      `scheduled=${scheduled.length}`
    );
    const start = new Date("2026-05-04T10:00:00+05:30").getTime();
    const whens = scheduled.map((r) => start - r.when).sort((x, y) => y - x);
    ok(
      "…exactly 24 h and 2 h before it starts, and they stop being useful when it starts",
      whens[0] === 24 * 3600000 && whens[1] === 2 * 3600000 && scheduled.every((r) => r.until === start),
      JSON.stringify({ whens, until: scheduled.map((r) => r.until === start) })
    );
    const first = scheduled.find((r) => /^Tomorrow/.test((r.mail || {}).subject || "")) || {};
    ok(
      "each one is a mail (not a popup) carrying slot, session, reporting time, venue and seat",
      first.notify === false &&
        /FAT exam: ECE2015/.test((first.mail || {}).subject || "") &&
        /Slot A1/.test((first.mail || {}).text || "") &&
        /Session FN1/.test((first.mail || {}).text || "") &&
        /09:30 AM/.test((first.mail || {}).text || "") &&
        /Venue: CB-324/.test((first.mail || {}).text || "") &&
        /Seat: R3C1 · No\. 5/.test((first.mail || {}).text || ""),
      JSON.stringify(first.mail || null).slice(0, 220)
    );
    ok(
      "no Google token was asked for at any point",
      !(await page.evaluate(() => (window.__sent || []).some((m) => m && m.message === "get_google_token"))),
      JSON.stringify(await page.evaluate(() => (window.__sent || []).map((m) => m.message)))
    );
    ok(
      "✉️ FAT confirms inline, naming the address and when they arrive",
      /✓ 2 email\(s\) scheduled to me@vitapstudent\.ac\.in — 24 h and 2 h before each exam/.test(
        (await bellNote("email me", "FAT")) || ""
      ),
      `note=${await bellNote("email me", "FAT")}`
    );

    // pressing again REPLACES the run (same tag): still two, not four
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .filter((b) => /email me/i.test(b.textContent))[0]
        .click();
    });
    await delay(500);
    ok(
      "pressing ✉️ again replaces the earlier run instead of adding a second set",
      (await page.evaluate(() => (window.__reminders || {})["exam-mail:FAT"] || [])).length === 2
    );

    // a group whose exams are all in the past: say so, schedule nothing
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .filter((b) => /email me/i.test(b.textContent))[1]
        .click();
    });
    await delay(300);
    ok(
      "✉️ CAT1 (all past) reports no upcoming exams, schedules nothing",
      !(await page.evaluate(() => (window.__reminders || {})["exam-mail:CAT1"])) &&
        /no upcoming exams/.test((await bellNote("email me", "CAT1")) || ""),
      `note=${await bellNote("email me", "CAT1")}`
    );
    await page.close();
  }

  /* ===== exam buttons survive a restored page snapshot (live 2026-08-07) ===== */
  console.log("\n=== exam schedule: buttons survive an innerHTML restore ===");
  {
    // Live symptom: the 🔔 button was on screen and a real click landed on it
    // (proven with a capture listener) yet nothing happened at all — no note,
    // no console error.
    //
    // Two causes, both fixed by js/shared/click.js:
    //   1. the button defaulted to type="submit", so a click inside one of
    //      VTOP's forms submitted the form and re-rendered the page;
    //   2. handlers were per-element (`btn.onclick`), and properties do not
    //      survive an innerHTML round-trip — which is all this page does
    //      (saveExamSchedulePage here, `$("#main-section").html(response)` in
    //      VTOP itself). Every round-trip left a pixel-perfect dead clone.
    //
    // The guards then disagreed with the breakage instead of repairing it: a
    // `dataset` flag serialises, so it came back on the dead clones and blocked
    // their own re-injection. The invariant now is stronger than "it re-binds":
    // a restored clone is live ALREADY, because the handler sits on `document`
    // and the identity is an attribute that survives exactly as the clone does.
    const fixedExam = new Date("2026-04-01T09:00:00+05:30").getTime();
    const page = await newPage(browser);
    await page.setContent(`<body><div id="main-section">
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
      </table></div></body>`);
    await shim(page, { fixedMs: fixedExam });
    await inject(page, ["js/shared/click.js", "js/shared/ics.js", "js/shared/google_auth.js", "js/exam_schedule.js"]);
    await page.evaluate(() => window.__dispatch("exam_schedule"));
    await delay(300);

    const firstPass = await page.evaluate(() => ({
      bells: [...document.querySelectorAll("button")].filter((b) => /notify me/i.test(b.textContent)).length,
      bound: document.querySelectorAll("[data-vr-action]").length,
      // the submit bug: a type="submit" button inside a VTOP form navigates
      // instead of running its handler
      types: [...document.querySelectorAll("[data-vr-action]")].map((b) => b.type),
      // must NOT outrank VTOP's own chrome: an earlier fix set z-index 1100 to
      // clear the BlockUI overlay and ended up drawing these buttons on top of
      // the site's open sidebar menu
      zIndex: (() => {
        const b = [...document.querySelectorAll("button")].find((x) => /notify me/i.test(x.textContent));
        return b ? getComputedStyle(b).zIndex : null;
      })(),
    }));
    ok("first pass injects four delegated buttons", firstPass.bells === 1 && firstPass.bound === 4,
      JSON.stringify(firstPass));
    ok(
      "none of them can submit the VTOP form they sit in",
      firstPass.types.length === 4 && firstPass.types.every((t) => t === "button"),
      JSON.stringify(firstPass.types)
    );
    ok(
      "buttons do not stack above the site's own overlays",
      firstPass.zIndex === "auto" || Number(firstPass.zIndex) <= 1011,
      String(firstPass.zIndex)
    );

    // the exact break: snapshot the page (buttons included) and restore it,
    // which is what saveExamSchedulePage / VTOP's .html(response) effectively do
    const afterRestore = await page.evaluate(async () => {
      const section = document.getElementById("main-section");
      const snapshot = section.innerHTML; // the identity serialises with it
      section.innerHTML = snapshot;
      const b = [...document.querySelectorAll("button")].find((x) => /notify me/i.test(x.textContent));
      // NO message is dispatched here: the whole point is that the clone needs
      // no repair. This is the click that used to do nothing at all.
      b.click();
      await new Promise((r) => setTimeout(r, 300));
      const note = document.querySelector(".vtopext-exam-note");
      return {
        action: b ? b.dataset.vrAction : null,
        type: b ? b.type : null,
        note: note ? note.textContent : null,
      };
    });
    ok(
      "a clone restored from innerHTML is live with no re-injection at all",
      afterRestore.action === "exam-bell" &&
        afterRestore.type === "button" &&
        !!afterRestore.note &&
        /scheduled/.test(afterRestore.note),
      JSON.stringify(afterRestore)
    );

    // the SPA message fires again — it must not stack a second set beside the
    // (perfectly good) restored one
    await page.evaluate(() => window.__dispatch("exam_schedule"));
    await delay(300);
    const repaired = await page.evaluate(() => ({
      bells: [...document.querySelectorAll("button")].filter((b) => /notify me/i.test(b.textContent)).length,
      bound: document.querySelectorAll("[data-vr-action]").length,
    }));
    ok("a later sync adds no duplicates beside the restored set",
      repaired.bells === 1 && repaired.bound === 4, JSON.stringify(repaired));
    await page.close();
  }

  /* ============ the fourth way a button can silently do nothing ============ */
  console.log("\n=== injected buttons: a click eaten by VTOP's BlockUI overlay ===");
  {
    // Delegation fixes the button that is never wired up. It does not fix the
    // button that is never aimed at: jQuery BlockUI, which VTOP raises for every
    // AJAX call, covers the viewport with div.blockUI.blockOverlay at z-index
    // 1000 — and leaves one of them at opacity ~0.001, invisible but fully
    // click-intercepting. The click still reaches our listener on `document`,
    // but event.target is the overlay, so closest("[data-vr-action]") finds
    // nothing and the button is as dead as it ever was. Only a real (trusted)
    // mouse click at a coordinate reproduces this; element.click() dispatches
    // straight at the element and sails past the overlay, which is why every
    // earlier test in this file missed it.
    const fixedExam = new Date("2026-04-01T09:00:00+05:30").getTime();
    const page = await newPage(browser);
    await page.setContent(`<body><div id="main-section">
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
      </table></div></body>`);
    await shim(page, { fixedMs: fixedExam });
    await inject(page, ["js/shared/click.js", "js/shared/ics.js", "js/shared/google_auth.js", "js/exam_schedule.js"]);
    await page.evaluate(() => window.__dispatch("exam_schedule"));
    await delay(300);

    // VTOP's overlay, reproduced with the exact classes and stacking it uses
    const aim = await page.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.className = "blockUI blockOverlay";
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:1000;background:#000;opacity:0.001;";
      document.body.appendChild(overlay);
      const bell = [...document.querySelectorAll("button")].find((b) =>
        /notify me/i.test(b.textContent)
      );
      const r = bell.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    ok(
      "the overlay really is what the click would hit",
      await page.evaluate(
        (p) => {
          const hit = document.elementFromPoint(p.x, p.y);
          return !!hit && hit.classList.contains("blockOverlay");
        },
        aim
      )
    );

    await page.mouse.click(aim.x, aim.y);
    await delay(400);
    const pierced = await page.evaluate(() => {
      const note = document.querySelector(".vtopext-exam-note");
      return note ? note.textContent : null;
    });
    ok(
      "the click is re-aimed through the overlay and the handler runs",
      !!pierced && /scheduled/.test(pierced),
      pierced || "no note — the overlay still eats it"
    );

    // and the piercing must stay narrow: an overlay click nowhere near one of
    // our buttons is still just a click on the overlay
    const stray = await page.evaluate(() => {
      document.querySelectorAll(".vtopext-exam-note").forEach((n) => n.remove());
      window.__reminders = {};
      return true;
    });
    await page.mouse.click(5, 5);
    await delay(300);
    ok(
      "a click elsewhere on the overlay is not re-aimed at anything",
      stray &&
        (await page.evaluate(
          () =>
            !document.querySelector(".vtopext-exam-note") &&
            Object.keys(window.__reminders || {}).length === 0
        ))
    );
    await page.close();
  }

  /* ====== the two defects that had no coverage: submit + the DOM race ====== */
  console.log("\n=== exam schedule: inside a <form>, and injected before the DOM lands ===");
  {
    const fixedExam = new Date("2026-04-01T09:00:00+05:30").getTime();
    const EXAM_TABLE = `
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
      </table>`;

    // Defect 1: VTOP wraps its content in forms. A button that defaults to
    // type="submit" submits that form on click — the page navigates and the
    // handler's effect is gone before the user can see it. Every fixture in
    // this file used to omit the <form>, which is exactly why 299 green tests
    // never noticed. The form here reports any submit instead of navigating.
    {
      const page = await newPage(browser);
      await page.setContent(
        `<body><div id="main-section"><form id="stdForm" action="/vtop/submitted">${EXAM_TABLE}</form></div></body>`
      );
      await shim(page, { fixedMs: fixedExam });
      await inject(page, ["js/shared/click.js", "js/shared/ics.js", "js/shared/google_auth.js", "js/exam_schedule.js"]);
      await page.evaluate(() => window.__dispatch("exam_schedule"));
      await delay(300);
      const result = await page.evaluate(async () => {
        window.__submits = 0;
        document.getElementById("stdForm").addEventListener("submit", (e) => {
          window.__submits++;
          e.preventDefault(); // keep the harness on this page either way
        });
        const b = [...document.querySelectorAll("button")].find((x) => /notify me/i.test(x.textContent));
        b.click();
        await new Promise((r) => setTimeout(r, 300));
        const note = document.querySelector(".vtopext-exam-note");
        return { submits: window.__submits, note: note ? note.textContent : null };
      });
      ok(
        "🔔 inside a VTOP form does not submit it",
        result.submits === 0,
        `submits=${result.submits}`
      );
      ok(
        "and it schedules the reminders instead",
        !!result.note && /scheduled/.test(result.note),
        String(result.note)
      );
      await page.close();
    }

    // Defect 2: the trigger is chrome.webRequest.onCompleted — it fires when
    // the response ARRIVES, not when VTOP's success callback has written it in.
    // A single immediate sync therefore ran against a page with no schedule
    // table at all, found nothing, and never tried again: buttons never
    // appeared. Here the table lands 1.2 s after the message, as it does live.
    {
      const page = await newPage(browser);
      await page.setContent(`<body><div id="main-section"></div></body>`);
      await shim(page, { fixedMs: fixedExam });
      await inject(page, ["js/shared/click.js", "js/shared/ics.js", "js/shared/google_auth.js", "js/exam_schedule.js"]);
      await page.evaluate(() => window.__dispatch("exam_schedule"));
      const immediately = await page.evaluate(
        () => document.querySelectorAll("[data-vr-action]").length
      );
      await page.evaluate((html) => {
        setTimeout(() => {
          document.getElementById("main-section").innerHTML = html;
        }, 1200);
      }, EXAM_TABLE);
      await delay(3000);
      const eventually = await page.evaluate(() => ({
        buttons: document.querySelectorAll("[data-vr-action]").length,
        bells: [...document.querySelectorAll("button")].filter((b) => /notify me/i.test(b.textContent)).length,
      }));
      ok(
        "nothing to inject into when the message arrives (the live race)",
        immediately === 0,
        `buttons=${immediately}`
      );
      ok(
        "the retry catches the table VTOP writes 1.2 s later",
        eventually.buttons === 4 && eventually.bells === 1,
        JSON.stringify(eventually)
      );
      await page.close();
    }
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
    await inject(page, ["js/shared/click.js", "js/shared/ics.js", "js/shared/google_auth.js", "js/exam_schedule.js"]);
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
      uids.every((u) => /^vtopext-exam-CSE1005-\d{8}-\d{4}-/.test(u)),
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

  /* ============ navbar: Marks View must not open Photo Marksheet Upload ============
   * SEEN LIVE 2026-10-10: the menu also has "Photo & 12th Marksheet Upload",
   * and includes("Marks") with last-match-wins sent the Marks View button
   * there ("Access Denied — Photo Upload Option not opened for you"). */
  console.log("\n=== navbar (AP): Marks View targets StudentMarkView, not Marksheet Upload ===");
  {
    const page = await newPage(browser);
    await page.setContent(`<body>
      <a data-url="examinations/StudentMarkView" href="#">Marks</a>
      <a data-url="students/photomarksheetupload" href="#">Photo & 12th Marksheet Upload</a>
      <a data-url="academics/common/StudentAttendance" href="#">Class Attendance</a>
      <nav><div class="collapse navbar-collapse"><div>menu</div></div></nav>
    </body>`);
    await shim(page, {});
    await inject(page, ["js/navbarap.js"]);
    await page.evaluate(() => window.__dispatch("nav_bar_change"));
    await delay(300);
    const target = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("#nav_short")).find(
        (b) => b.textContent.trim() === "Marks View"
      );
      if (!btn) return null;
      const idx = Number(/\[(\d+)\]\.click/.exec(btn.getAttribute("onclick"))[1]);
      return Array.from(document.getElementsByTagName("a")).filter((e) => e.dataset.url)[idx].dataset.url;
    });
    ok("Marks View button points at examinations/StudentMarkView", target === "examinations/StudentMarkView", String(target));
    await page.close();
  }

  /* ============ DA page: nothing upcoming, something still owed ============
   *
   * SEEN LIVE 2026-08-17 on this student's own page. Every control in the
   * summary bar used to sit inside `if (upcoming.length)`, so the one state
   * that most deserves attention — work you owe and never submitted — was the
   * one state with no buttons at all. The bar named it and then offered
   * nothing.
   */
  console.log("\n=== DA page: overdue with nothing upcoming ===");
  {
    const fixed = new Date("2026-07-06T09:00:00+05:30").getTime();
    const lateHtml = `
      <table class="customTable">
        <tr><td>Semester</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Class Number</td></tr>
        <tr><td>Summer II</td><td>MGT1029</td><td>Basic Law for Engineers</td><td>TH</td><td>AP2025267000565</td></tr>
      </table>
      <table class="customTable">
        <tr><td>Sl.No.</td><td>Title</td><td>Max. Mark</td><td>Weightage %</td><td>Due Date</td><td>QP</td><td>Document Details</td></tr>
        <tr><td>Last Updated On</td><td>Upload/Edit</td><td>Download</td></tr>
        <tr><td>1</td><td>Digital Assessment-1</td><td>15</td><td>15</td><td><span style="color:red">02-Jul-2026</span></td><td></td>
            <td><span style="color:red">File Not Uploaded</span></td><td></td><td></td></tr>
      </table>`;
    const page = await newPage(browser);
    await page.route("https://vtop-late.test/**", (route) => {
      if (route.request().url().includes("processDigitalAssignment"))
        return route.fulfill({ contentType: "text/html", body: lateHtml });
      route.fulfill({
        contentType: "text/html",
        body: `<body>
          <span class="navbar-text text-light small fw-bold">24TEST0001 (STUDENT)</span>
          <input name="_csrf" value="t0k">
          <table class="customTable">
            <tr><td>Sl.No</td><td>Class Nbr</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Faculty Name</td><td>Dashboard</td></tr>
            <tr><td>1</td><td>AP2025267000565</td><td>MGT1029</td><td>Basic Law for Engineers</td><td>TH</td><td>P Ojha</td><td><a>view</a></td></tr>
          </table></body>`,
      });
    });
    await page.goto("https://vtop-late.test/vtop/content");
    await shim(page, { fixedMs: fixed, storage: {} });
    await inject(page, ["js/shared/click.js", "js/shared/google_auth.js", "js/shared/vtop.js", "js/da_upload.js"]);
    await page.evaluate(() => window.__dispatch("da_upload"));
    await delay(800);

    const bar = await page.evaluate(() => {
      const el = document.getElementById("vtopext-da-summary");
      if (!el) return null;
      return {
        text: el.textContent,
        buttons: [...el.querySelectorAll("button")].map((b) => b.textContent),
        dues: [...el.querySelectorAll("button")]
          .map((b) => b.dataset.vrDues)
          .filter(Boolean)
          .map((d) => JSON.parse(d)),
      };
    });
    ok("the bar says plainly that nothing is upcoming but something is owed",
      !!bar && /Nothing upcoming — but 1 assignment\(s\) are past due and never uploaded/.test(bar.text),
      (bar && bar.text.slice(0, 160)) || "no bar");
    ok("the overdue item is named, with its own title and date",
      !!bar && /Past due: MGT1029 — Digital Assessment-1 \(02-Jul-2026\)/.test(bar.text),
      (bar && bar.text.slice(0, 200)) || "no bar");
    ok(
      "📧 is offered, and says what it will send",
      !!bar && bar.buttons.some((b) => /email me what I still owe/i.test(b)),
      JSON.stringify(bar && bar.buttons)
    );
    ok(
      "📬 the daily digest is offered too — nothing due today is exactly who wants it",
      !!bar && bar.buttons.some((b) => /daily digest/.test(b)),
      JSON.stringify(bar && bar.buttons)
    );
    /*
     * And NOT 🔔. A Chrome notification for a date that has already passed can
     * never fire, so offering it would be a button that silently does nothing —
     * worse than no button, because it looks like the problem is handled.
     */
    ok(
      "🔔 is NOT offered — it could only schedule a reminder for a past date",
      !!bar && !bar.buttons.some((b) => /remind me/i.test(b)),
      JSON.stringify(bar && bar.buttons)
    );
    ok(
      "the payload 📧 carries is the overdue list, named per assignment",
      !!bar && bar.dues.length === 1 &&
        bar.dues[0].dues.length === 1 &&
        bar.dues[0].dues[0].title === "MGT1029 — Digital Assessment-1",
      JSON.stringify(bar && bar.dues)
    );
    await page.close();
  }

  /* ====== DA page: a blank "Document Details" is NOT a submission ======
   *
   * READ OFF THE LIVE PAGE 2026-08-22, reported as "the due date and all of
   * them look off the mark, and i cant see remainders". SWE3004's real table:
   * one row saying "File Not Uploaded", one carrying an upload timestamp, and
   * FOUR future rows whose Document Details cell is empty because VTOP has not
   * opened the upload window yet.
   *
   * The old predicate was `!/file not uploaded/`, so a blank cell answered
   * "uploaded" and those four counted as done. The course row said "1 past
   * due", nothing was upcoming, and every reminder control lives behind
   * `upcoming.length` — so no 🔔 could ever appear, on precisely the rows a
   * reminder is for. Absence of evidence was being read as evidence of
   * submission.
   *
   * Every fixture above happens to fill that cell, which is why the suite
   * stayed green while the live page was wrong.
   */
  console.log("\n=== DA page: a blank Document Details is not a submission ===");
  {
    const fixed = new Date("2026-08-21T09:00:00+05:30").getTime();
    const blankHtml = `
      <table class="customTable">
        <tr><td>Semester</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Class Number</td></tr>
        <tr><td>Fall 26-27</td><td>SWE3004</td><td>Front End Design and Testing</td><td>ELA</td><td>AP2026272001506</td></tr>
      </table>
      <table class="customTable">
        <tr><td>Sl.No.</td><td>Title</td><td>Max. Mark</td><td>Weightage %</td><td>Due Date</td><td>QP</td><td>Document Details</td></tr>
        <tr><td>Last Updated On</td><td>Upload/Edit</td><td>Download</td></tr>
        <tr><td>1</td><td>Experiment-1</td><td>10</td><td>10</td><td>31-Jul-2026</td><td></td>
            <td><span style="color:red">File Not Uploaded</span></td><td></td><td></td></tr>
        <tr><td>2</td><td>Experiment-2</td><td>10</td><td>10</td><td>16-Aug-2026</td><td></td>
            <td>16 Aug 2026 02:30 PM</td><td></td><td></td></tr>
        <tr><td>3</td><td>Experiment-3</td><td>10</td><td>10</td><td>05-Sep-2026</td><td></td>
            <td></td><td></td><td></td></tr>
        <tr><td>4</td><td>Experiment-4</td><td>10</td><td>10</td><td>19-Sep-2026</td><td></td>
            <td></td><td></td><td></td></tr>
      </table>`;
    const page = await newPage(browser);
    await page.route("https://vtop-blank.test/**", (route) => {
      if (route.request().url().includes("processDigitalAssignment"))
        return route.fulfill({ contentType: "text/html", body: blankHtml });
      route.fulfill({
        contentType: "text/html",
        body: `<body>
          <span class="navbar-text text-light small fw-bold">24TEST0001 (STUDENT)</span>
          <input name="_csrf" value="t0k">
          <table class="customTable">
            <tr><td>Sl.No</td><td>Class Nbr</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Faculty Name</td><td>Dashboard</td></tr>
            <tr><td>1</td><td>AP2026272001506</td><td>SWE3004</td><td>Front End Design and Testing</td><td>ELA</td><td>K L S Praneeth</td><td><a>view</a></td></tr>
          </table></body>`,
      });
    });
    await page.goto("https://vtop-blank.test/vtop/content");
    await shim(page, { fixedMs: fixed, storage: {} });
    await inject(page, [
      "js/shared/click.js",
      "js/shared/google_auth.js",
      "js/shared/vtop.js",
      "js/da_upload.js",
    ]);
    await page.evaluate(() => window.__dispatch("da_upload"));
    await delay(900);

    const seen = await page.evaluate(() => {
      const bar = document.getElementById("vtopext-da-summary");
      const cell = [...document.querySelectorAll("td")].find((t) =>
        /No dues|past due|d left/.test(t.textContent)
      );
      return {
        cell: cell ? cell.textContent.replace(/\s+/g, " ").trim() : null,
        barText: bar ? bar.textContent.replace(/\s+/g, " ") : null,
        buttons: bar ? [...bar.querySelectorAll("button")].map((b) => b.textContent) : [],
        dues: [...document.querySelectorAll("[data-vr-dues]")]
          .map((b) => JSON.parse(b.dataset.vrDues))
          .flatMap((d) => d.dues.map((x) => x.due)),
      };
    });

    ok(
      "the two blank-cell assignments are counted as still owed, not submitted",
      !!seen.dues && seen.dues.includes("05-Sep-2026") && seen.dues.includes("19-Sep-2026"),
      JSON.stringify(seen.dues)
    );
    ok(
      "the course row stops claiming everything is submitted",
      !!seen.cell && !/No dues/.test(seen.cell),
      String(seen.cell)
    );
    ok(
      "🔔 comes back — there is now something in the future to remind about",
      seen.buttons.some((b) => /remind me/i.test(b)),
      JSON.stringify(seen.buttons)
    );
    ok(
      "the row VTOP timestamped is still read as uploaded",
      !seen.dues.includes("16-Aug-2026"),
      JSON.stringify(seen.dues)
    );
    await page.close();
  }

  /* ====== leave approval: the transition, not the count ======
   *
   * Asked 2026-08-23: "when the leave is approved and we open the vtop then
   * send us it got approved and the approval file". Table shape read live the
   * same day off hostel/StudentGeneralOuting, including the three real status
   * strings — the apostrophes in "Mentor's" are VTOP's own.
   *
   * The property that matters is that this compares rather than counts. A
   * request can move Mentor -> Warden -> Accepted while an older one is
   * rejected and a newer one filed; counting accepted rows would announce the
   * wrong trip, or stay silent when two things change at once.
   */
  console.log("\n=== leave approval watcher ===");
  {
    const table = (rows) => `<body><table>
      <tr><th>S.No</th><th>Registration Number</th><th>Place Of Visit</th>
          <th>Purpose Of Visit</th><th>From Date</th><th>From Time</th>
          <th>To Date</th><th>To Time</th><th>Action</th><th>Status</th>
          <th>Download OutPass</th></tr>
      ${rows}</tr></table></body>`;
    const row = (no, place, from, status, pass) =>
      `<tr><td>${no}</td><td>24TEST0001</td><td>${place}</td><td>Visit</td>
       <td>${from} 00:00:00.0</td><td>01:00 PM</td><td>${from} 00:00:00.0</td>
       <td>08:00 PM</td><td> </td><td>${status}</td>
       <td>${pass ? '<a href="#">Download</a>' : " "}</td></tr>`;

    const PENDING = "Waiting for Mentor&#39;s Approval";
    const WARDEN = "Waiting for Warden&#39;s Approval";
    const OK = "Leave Request Accepted";

    const boot = async (html, store) => {
      const p = await newPage(browser);
      await p.setContent(html);
      await shim(p, { storage: store || {} });
      await inject(p, ["js/shared/click.js", "js/shared/vtop.js", "js/leave_watch.js"]);
      await p.evaluate(() => {
        window.__notes = [];
        const send = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = (msg, cb) => {
          if (msg && msg.message === "notify_now") {
            window.__notes.push({ title: msg.title, body: msg.body });
            if (cb) cb({ ok: true });
            return;
          }
          return send(msg, cb);
        };
      });
      return p;
    };

    // parsing, against the live column order
    {
      const p = await boot(table(row(12, "Hyderabad", "2026-04-11", PENDING, false)));
      const rows = await p.evaluate(() => window.vrLeaveParse());
      ok(
        "the table is read by header, with status and OutPass located",
        rows && rows.length === 1 && rows[0].place === "Hyderabad" &&
          rows[0].accepted === false && rows[0].hasPass === false,
        JSON.stringify(rows)
      );
      await p.close();
    }

    // "Waiting for Warden" is still pending — "Approval" appears in BOTH
    // pending strings, so a naive /approv/ test would call it accepted
    {
      const p = await boot(table(row(12, "Hyderabad", "2026-04-11", WARDEN, false)));
      const rows = await p.evaluate(() => window.vrLeaveParse());
      ok(
        "waiting-for-approval is not approved",
        rows && rows[0].accepted === false,
        JSON.stringify(rows && rows[0])
      );
      await p.close();
    }

    // the transition: pending before, accepted now -> one notification
    {
      const seeded = {
        vtopext_leave_status: {
          fetchedAt: Date.now() - 1000,
          rows: [{ key: "12|2026-04-11", place: "Hyderabad", from: "2026-04-11", status: PENDING, accepted: false, hasPass: false }],
        },
      };
      const p = await boot(table(row(12, "Hyderabad", "2026-04-11", OK, true)), seeded);
      const out = await p.evaluate(async () => {
        const rows = window.vrLeaveParse();
        const fresh = await window.vrLeaveRemember(rows);
        return { fresh: fresh.length, notes: window.__notes, stored: window.__storage.vtopext_leave_status.rows[0] };
      });
      ok(
        "a row that moved from pending to accepted is announced once",
        out.fresh === 1 && out.notes.length === 1 &&
          /Leave approved/.test(out.notes[0].title) && /Hyderabad/.test(out.notes[0].title),
        JSON.stringify(out.notes)
      );
      ok(
        "…and the OutPass is what the message tells them to collect",
        /OutPass/.test(out.notes[0].body),
        JSON.stringify(out.notes[0])
      );
      ok(
        "the new state is remembered, so it is not announced twice",
        out.stored && out.stored.accepted === true,
        JSON.stringify(out.stored)
      );
      await p.close();
    }

    /*
     * FIRST SIGHTING IS HISTORY, NOT NEWS. On a fresh install the table is
     * full of trips already taken; announcing those would cry wolf about a
     * holiday from last October.
     */
    {
      const p = await boot(table(row(3, "HYDERABAD", "2025-10-11", OK, true)));
      const out = await p.evaluate(async () => {
        const fresh = await window.vrLeaveRemember(window.vrLeaveParse());
        return { fresh: fresh.length, notes: window.__notes.length };
      });
      ok(
        "an already-accepted row seen for the first time is recorded silently",
        out.fresh === 0 && out.notes === 0,
        JSON.stringify(out)
      );
      await p.close();
    }

    /* ---- the DOM is not the whole table ----
     *
     * Caught after shipping: "there are muktiole entries not just 8 check the
     * site properly". VTOP renders this through DataTables with CLIENT-side
     * paging — the server sends every row (28 rows in an 80 KB response,
     * verified live) and DataTables then strips all but the current page from
     * the DOM. Reading the live page finds ten and believes that is all, while
     * the student's list is twenty-seven long.
     *
     * The failure would have been silent and aimed at exactly the wrong
     * people: an approval landing on page 2 or 3 is invisible, and only
     * students with enough history to paginate have a page 2 — the ones who
     * travel most.
     */
    {
      const ten = Array.from({ length: 10 }, (_, i) =>
        row(i + 1, "Hyderabad", "2026-04-11", OK, true)
      ).join("");
      const p = await boot(
        table(ten).replace(
          "</table>",
          '</table><div class="dataTables_info">Showing 1 to 10 of 27 entries</div>'
        )
      );
      const out = await p.evaluate(() => ({
        parsed: (window.vrLeaveParse() || []).length,
        complete: window.vrLeaveDomComplete(),
      }));
      ok(
        "a paginated table is not mistaken for the whole list",
        out.parsed === 10 && out.complete === false,
        JSON.stringify(out)
      );
      await p.close();
    }

    // …and when the counts agree, the DOM really is everything
    {
      const p = await boot(
        table(row(1, "Hyderabad", "2026-04-11", OK, true)).replace(
          "</table>",
          '</table><div class="dataTables_info">Showing 1 to 1 of 1 entries</div>'
        )
      );
      const complete = await p.evaluate(() => window.vrLeaveDomComplete());
      ok("an unpaginated table is read straight from the page", complete === true, String(complete));
      await p.close();
    }

    // a second pass over unchanged rows says nothing
    {
      const seeded = {
        vtopext_leave_status: {
          fetchedAt: Date.now() - 1000,
          rows: [{ key: "12|2026-04-11", place: "Hyderabad", from: "2026-04-11", status: OK, accepted: true, hasPass: true }],
        },
      };
      const p = await boot(table(row(12, "Hyderabad", "2026-04-11", OK, true)), seeded);
      const out = await p.evaluate(async () => {
        const fresh = await window.vrLeaveRemember(window.vrLeaveParse());
        return { fresh: fresh.length, notes: window.__notes.length };
      });
      ok(
        "nothing changed means nothing is sent",
        out.fresh === 0 && out.notes === 0,
        JSON.stringify(out)
      );
      await p.close();
    }
  }

  /* ====== the mail body: a table, grouped by subject ======
   *
   * "email looks the worst man, like cant u said as table subejct wise"
   * (2026-08-22). It WAS a <table> — with no borders, no header and no
   * grouping, so twenty-one rows read as one undifferentiated list, six of
   * them CSE3009 experiments sharing a due date with the code repeated on
   * every line. Grouping is the whole fix.
   */
  console.log("\n=== DA mail body: grouped by subject, not one flat list ===");
  {
    const page = await newPage(browser);
    await page.setContent("<body></body>");
    await shim(page, { fixedMs: new Date("2026-08-22T09:00:00+05:30").getTime() });
    await inject(page, [
      "js/shared/click.js",
      "js/shared/google_auth.js",
      "js/shared/vtop.js",
      "js/da_upload.js",
    ]);
    const mail = await page.evaluate(() =>
      vr_da_mail_body({
        code: "all courses",
        dues: [
          { due: "20-Oct-2026", title: "CSE3009 — Experiment-1", course: "NoSQL Databases" },
          { due: "20-Oct-2026", title: "CSE3009 — Experiment-2", course: "NoSQL Databases" },
          { due: "20-Oct-2026", title: "CSE3009 — Experiment-3", course: "NoSQL Databases" },
          { due: "05-Sep-2026", title: "SWE3004 — Experiment-3", course: "Front End Design and Testing" },
          { due: "27-Aug-2026", title: "SWE3004 — Digital Assessment-1", course: "Front End Design and Testing" },
          { due: "31-Jul-2026", title: "SWE3004 — Experiment-1", course: "Front End Design and Testing" },
        ],
      })
    );

    ok(
      "one heading per subject, not one line per assignment",
      (mail.html.match(/>CSE3009</g) || []).length === 1 &&
        (mail.html.match(/>SWE3004</g) || []).length === 1,
      mail.html.slice(0, 200)
    );
    /*
     * "just add the course name and no comments it would be perfect"
     * (2026-08-22). The subject cell names the course as a student would say
     * it, and the grey "N pending" note under it is gone - the count is
     * already in the header line, and repeating it per subject was noise in a
     * column that had just been given something worth reading.
     */
    ok(
      "the subject cell names the course, not just the code",
      /CSE3009<div[^>]*>NoSQL Databases</.test(mail.html) &&
        /SWE3004<div[^>]*>Front End Design and Testing</.test(mail.html),
      (mail.html.match(/<div[^>]*>[A-Z][^<]{4,40}</g) || []).slice(0, 3).join(" | ")
    );
    ok(
      "and carries no per-subject commentary",
      !/pending/.test(mail.html),
      (mail.html.match(/\d+ pending/g) || []).join(" | ") || "none"
    );
    ok(
      "the code is stripped from the row once it is in the heading",
      /<td[^>]*>Experiment-1<\/td>/.test(mail.html) &&
        !/CSE3009 — Experiment-1/.test(mail.html),
      mail.html.slice(0, 300)
    );
    ok(
      "an already-passed due is called overdue, in red",
      /31-Jul-2026/.test(mail.html) &&
        /day\(s\) overdue/.test(mail.html) &&
        /#c0392b/.test(mail.html),
      (mail.html.match(/\d+ day\(s\) (overdue|left)/g) || []).join(" | ")
    );
    /*
     * "make a proper tabble as we get exam scedule" — the first grouped
     * attempt emitted one <table> per subject, which is six little tables
     * stacked, not the exam mail's shape. One table, one thead, subjects as
     * spanning rows inside it.
     */
    ok(
      "one table with one header row, like the exam schedule mail",
      (mail.html.match(/<table/g) || []).length === 1 &&
        (mail.html.match(/<thead/g) || []).length === 1 &&
        /text-transform:uppercase/.test(mail.html),
      (mail.html.match(/<table[^>]*>/g) || []).join(" | ")
    );
    /*
     * "send it more in forms of tables okay? Like with proper borders" — the
     * previous pass had bottom rules only, which still reads as a list with
     * lines through it. Every cell carries a border now, and the subject is a
     * MERGED column rather than a spanning header row, so it stays subject-wise
     * while being an actual grid.
     */
    ok(
      "every cell is bordered, not just ruled underneath",
      !/border-bottom:1px/.test(mail.html) &&
        (mail.html.match(/border:1px solid #b0b0b0/g) || []).length >= 8,
      (mail.html.match(/border[^;"]*/g) || []).slice(0, 4).join(" | ")
    );
    ok(
      "the subject is a merged column spanning its own rows",
      (mail.html.match(/rowspan="3"/g) || []).length === 2,
      (mail.html.match(/rowspan="\d+"/g) || []).join(" ")
    );
    ok(
      "styling is inline — Gmail strips <style> blocks",
      !/<style/i.test(mail.html) && /style="/.test(mail.html),
      String(/<style/i.test(mail.html))
    );
    ok(
      "the plain-text part is grouped too, not the old flat sort",
      /^SWE3004\n/m.test(mail.text) && /^CSE3009\n/m.test(mail.text),
      mail.text.slice(0, 120)
    );
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
        <tr><td>1</td><td>Digital Assessment-1</td><td>15</td><td>15</td><td><span style="color:red">02-Jul-2026</span></td><td></td>
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
          <span class="navbar-text text-light small fw-bold">24TEST0001 (STUDENT)</span>
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
    await inject(page, ["js/shared/click.js", "js/shared/google_auth.js", "js/shared/vtop.js", "js/da_upload.js"]);
    await page.evaluate(() => window.__dispatch("da_upload"));
    await delay(800);

    const cellText = await page.evaluate(() => {
      const t = document.querySelector("table.customTable");
      return t.rows[1].cells[7] ? t.rows[1].cells[7].textContent : null;
    });
    ok(
      // compact since 2026-08-22: "10-Jul · 4d left", not "10-Jul-2026 (4
      // day(s) left)" wrapped across a 90px column
      "dues cell shows nearest un-submitted due (skips past-due + uploaded)",
      !!cellText && cellText.includes("10-Jul") && /4d left/.test(cellText),
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
      states[0] === "✅ No dues" && states[1] === "⚠ 3 past due (not uploaded)",
      JSON.stringify(states)
    );

    // 🔔 local: Chrome notifications for the one un-submitted upcoming DA —
    // evening before (18:00) + due-day morning (08:00), no Google involved
    await page.click(".vtopext-da-remind");
    await delay(300);
    const btnText = await page.evaluate(
      () => document.querySelector(".vtopext-da-remind").textContent
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

    // ✉ is mailed by the extension itself: no Google sign-in, no calendar event
    await page.evaluate(() => {
      window.__storage.vtopext_reminder_email = "me@vitapstudent.ac.in";
      window.__sent = [];
    });
    await page.evaluate(() =>
      document.querySelectorAll(".vtopext-da-remind")[1].click()
    );
    await delay(700);
    const mailText = await page.evaluate(
      () => document.querySelectorAll(".vtopext-da-remind")[1].textContent
    );
    const mailRems = await page.evaluate(() => {
      const all = window.__reminders || {};
      return Object.keys(all).filter((k) => /^da-mail:/.test(k)).flatMap((k) => all[k]);
    });
    ok(
      "✉ schedules ONE email (only the un-submitted upcoming DA), not a calendar event",
      mailRems.length === 1 && gcal.length === 0,
      `emails=${mailRems.length} calendarEvents=${gcal.length}`
    );
    const mr = mailRems[0] || {};
    ok(
      "…sent the evening before the due date (20:00 IST) and useless after it",
      mr.when === new Date("2026-07-09T20:00:00+05:30").getTime() &&
        mr.until === new Date("2026-07-10T21:00:00+05:30").getTime() &&
        mr.notify === false &&
        /MGT1029/.test((mr.mail || {}).subject || "") &&
        /Due 10-Jul-2026/.test((mr.mail || {}).text || ""),
      JSON.stringify({ when: mr.when && new Date(mr.when).toISOString(), mail: mr.mail && mr.mail.subject })
    );
    ok(
      "…with no Google token asked for",
      !(await page.evaluate(() => (window.__sent || []).some((m) => m && m.message === "get_google_token")))
    );
    ok("✉ button confirms the schedule", /✓ 1 email/.test(mailText), mailText);

    // 📅 one-tap template link (no OAuth): upcoming un-submitted due only
    const daLinks = await page.evaluate(() => {
      const t = document.querySelector("table.customTable");
      return {
        total: document.querySelectorAll(".vtopext-da-gcal").length,
        row1: [...t.rows[1].cells[7].querySelectorAll(".vtopext-da-gcal")].map(
          (a) => ({ t: a.textContent, href: a.href, target: a.target })
        ),
      };
    });
    ok(
      "📅 one-tap gcal link on the upcoming due only",
      daLinks.total === 1 && daLinks.row1.length === 1 &&
        daLinks.row1[0].t === "📅" && daLinks.row1[0].target === "_blank",
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

    /*
     * The summary bar above the table. Mixed state first: something upcoming
     * AND something past due — both have to be named, because "1 still to
     * upload" alone reads like everything else is fine.
     */
    const barMixed = await page.evaluate(() => {
      const bar = document.getElementById("vtopext-da-summary");
      if (!bar) return null;
      return {
        text: bar.textContent,
        buttons: [...bar.querySelectorAll("button")].map((b) => b.textContent),
        types: [...bar.querySelectorAll("button")].map((b) => b.type),
      };
    });
    ok(
      "the summary bar counts what is upcoming AND what is already past due",
      !!barMixed && /1 assignment\(s\) still to upload, and 4 already past due/.test(barMixed.text),
      (barMixed && barMixed.text.slice(0, 160)) || "no bar"
    );
    ok(
      "past-due items are named, not just counted",
      !!barMixed && /Past due: MGT1029 — Digital Assessment-1 \(02-Jul-2026\); PHY1001 — Digital Assessment-1/.test(barMixed.text),
      (barMixed && barMixed.text.slice(0, 240)) || "no bar"
    );
    ok(
      "and every bar button is type=button, so none of them submits VTOP's form",
      !!barMixed && barMixed.types.length >= 3 && barMixed.types.every((t) => t === "button"),
      JSON.stringify(barMixed && barMixed.types)
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

    // The same clone problem the exam buttons had. These two sit in a cell of
    // VTOP's own class table, which VTOP rewrites with .html(response) and we
    // snapshot for the offline viewer — so their state cannot live in a closure
    // over `upcoming`/`meta` any more than their handler could live on the
    // element. Restore the table from its own markup and click the clone: no
    // re-injection, no second round of fetches, and the reminders must still be
    // the right ones for THIS course.
    const restored = await page.evaluate(async () => {
      window.__reminders = {};
      // undo the earlier click in this fixture: a scheduled button disables
      // itself, and `disabled` is an attribute — it serialises into the clone
      // (correctly: an already-scheduled course stays scheduled)
      // scoped to the table: there is also a "remind me about all of them"
      // button in the summary bar above it, and it is deliberately first in
      // document order. This assertion is about the PER-COURSE button knowing
      // which course it belongs to after a clone.
      const t = document.querySelector("table.customTable");
      const first = t.querySelector('[data-vr-action="da-bell"]');
      first.disabled = false;
      first.textContent = "🔔 remind me";
      t.innerHTML = t.innerHTML;
      const bell = t.querySelector('[data-vr-action="da-bell"]');
      bell.click();
      await new Promise((r) => setTimeout(r, 400));
      return {
        text: bell.textContent,
        keys: Object.keys(window.__reminders || {}),
        count: (window.__reminders["da:MGT1029"] || []).length,
        title: ((window.__reminders["da:MGT1029"] || [])[0] || {}).title,
      };
    });
    ok(
      "a DA button restored from innerHTML still knows its own course",
      restored.count === 2 &&
        restored.keys.length === 1 &&
        /MGT1029 — Digital Assessment-2/.test(restored.title || "") &&
        /✓ 2 reminder/.test(restored.text),
      JSON.stringify(restored)
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
        counter: sessionStorage.getItem("vtopext_session_repairs"),
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

  /* ====== session repair: shell healthy, content POSTs 404 ======
   *
   * The state the block above is structurally blind to: /vtop/content still
   * answers 200, the top bar still shows the student, no Tomcat page renders —
   * and every menu click POSTs, 404s, and blanks the content area. The
   * evidence exists only in the network layer, so the detector lives in the
   * service worker and the banner arrives as a message. Both halves are
   * tested, because a detector firing into a page with no listener is no
   * better than no detector.
   */
  console.log("\n=== session repair: shell healthy, content POSTs 404 ===");
  {
    /* ---- half one: the worker's detector ---- */
    const manifest = JSON.parse(read("manifest.json"));
    const evt = () => ({ addListener: () => {}, removeListener: () => {} });
    const nsProxy = (seed = {}) =>
      new Proxy({ ...seed }, {
        get(t, k) {
          if (k in t) return t[k];
          if (typeof k === "string" && /^on[A-Z]/.test(k)) return (t[k] = evt());
          return (t[k] = (...a) => {
            const cb = a[a.length - 1];
            if (typeof cb === "function") return cb(undefined);
            return Promise.resolve(undefined);
          });
        },
      });

    let onCompleted = null;
    const sent = [];
    const chromeStub = {
      runtime: nsProxy({ lastError: null, getManifest: () => manifest, id: "test" }),
      webRequest: nsProxy({
        onCompleted: { addListener: (fn) => { onCompleted = fn; }, removeListener: () => {} },
      }),
      tabs: nsProxy({
        sendMessage: (tabId, msg) => { sent.push({ tabId, msg }); },
        onRemoved: evt(),
        query: (_q, cb) => cb([]),
      }),
      storage: { local: nsProxy(), session: nsProxy(), sync: nsProxy() },
    };
    for (const perm of manifest.permissions || []) {
      if (!(perm in chromeStub)) chromeStub[perm] = nsProxy();
    }
    if (manifest.action) chromeStub.action = nsProxy();

    const ctx = vm.createContext({
      chrome: chromeStub,
      console: { log: () => {}, warn: () => {}, error: () => {} },
      setTimeout, clearTimeout, setInterval, clearInterval,
      fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
      URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, atob, btoa,
    });
    ctx.self = ctx;
    ctx.globalThis = ctx;
    vm.runInContext(read("service_worker/background.js"), ctx, { filename: "background.js" });

    // a path matching none of the routing branches, so this measures the
    // detector and nothing else
    const NEUTRAL = "https://vtop.vitap.ac.in/vtop/academics/common/StudentGrade";
    const hit = (over = {}) =>
      onCompleted({
        url: NEUTRAL, method: "POST", statusCode: 404, tabId: 7,
        type: "xmlhttprequest", ...over,
      });

    if (typeof onCompleted !== "function") {
      ok("worker registers a webRequest.onCompleted listener", false, "missing");
    } else {
      hit();
      hit();
      ok("two 404s in a row say nothing yet", sent.length === 0, JSON.stringify(sent));

      hit();
      ok(
        "the third consecutive 404 warns the tab that made them",
        sent.length === 1 &&
          sent[0].tabId === 7 &&
          sent[0].msg.message === "session_dead" &&
          sent[0].msg.failures === 3,
        JSON.stringify(sent)
      );

      hit();
      hit();
      ok("and it warns once per run, not once per click", sent.length === 1, JSON.stringify(sent));

      // a success means VTOP is answering; whatever run was building is over
      sent.length = 0;
      hit({ statusCode: 200 });
      hit();
      hit();
      ok("one success resets the run", sent.length === 0, JSON.stringify(sent));
      hit();
      ok("…and the count restarts from there", sent.length === 1, JSON.stringify(sent));

      /*
       * The three ways this must NOT fire. Each is a 404 that happens on a
       * perfectly healthy session, and each would make the banner into noise
       * that students learn to dismiss.
       */
      sent.length = 0;
      for (let i = 0; i < 5; i++) hit({ url: "https://vtop.vitap.ac.in/vtop/login", tabId: 8 });
      ok("a failed sign-in is not a stale session", sent.length === 0, JSON.stringify(sent));

      sent.length = 0;
      for (let i = 0; i < 5; i++)
        hit({ method: "GET", tabId: 9, url: "https://vtop.vitap.ac.in/vtop/assets/gone.css" });
      ok("a missing asset is not a stale session", sent.length === 0, JSON.stringify(sent));

      // A reload or a sign-in arrives as a main_frame request. VTOP menu
      // clicks never do, so a run survives the clicks that build it and ends
      // only at a genuine navigation.
      sent.length = 0;
      hit({ tabId: 10 });
      hit({ tabId: 10 });
      hit({ tabId: 10, type: "main_frame", method: "GET", statusCode: 200,
            url: "https://vtop.vitap.ac.in/vtop/content" });
      hit({ tabId: 10 });
      hit({ tabId: 10 });
      ok(
        "a reload starts a new session, so the old count is dropped",
        sent.length === 0,
        JSON.stringify(sent)
      );

      sent.length = 0;
      hit({ tabId: -1 });
      hit({ tabId: -1 });
      hit({ tabId: -1 });
      ok("a request with no tab is counted against nothing", sent.length === 0, JSON.stringify(sent));
    }

    /* ---- half two: what the page does with that message ---- */
    const stub = `(() => {
      window.__sent = [];
      window.__listeners = [];
      window.chrome = { runtime: {
        sendMessage: (m, cb) => { window.__sent.push(m); if (cb) cb(1); },
        onMessage: { addListener: (fn) => window.__listeners.push(fn) },
        get lastError() { return undefined; },
      } };
    })();`;
    const page = await newPage(browser);
    await page.route("https://vtop-stale.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<body><div id='vtopMainDiv'><p>Signed in as a student</p></div></body>",
      })
    );
    await page.goto("https://vtop-stale.test/vtop/content");
    await page.addScriptTag({ content: stub });
    await inject(page, ["js/shared/click.js", "js/shared/vtop.js", "js/session_repair.js"]);

    const fire = (failures) =>
      page.evaluate(
        (n) => window.__listeners.forEach((fn) => fn({ message: "session_dead", failures: n })),
        failures
      );
    await fire(4);
    const banner = await page.evaluate(() => {
      const b = document.getElementById("vtopext-session-banner");
      return b && {
        text: b.textContent,
        buttons: [...b.querySelectorAll("button")].map((x) => ({
          label: x.textContent, type: x.type, action: x.dataset.vrAction,
        })),
      };
    });
    ok(
      "the message draws the banner, naming the count VTOP actually refused",
      !!banner && /refused 4 page requests/.test(banner.text) && /sign in again/i.test(banner.text),
      JSON.stringify(banner)
    );
    ok(
      "with a recovery button that can never submit the VTOP form it sits in",
      !!banner &&
        banner.buttons.length === 1 &&
        banner.buttons[0].type === "button" &&
        banner.buttons[0].action === "session-recover",
      JSON.stringify(banner && banner.buttons)
    );

    // the breaker and this detector describe the same broken session; the
    // second one to notice must not stack a second red bar
    await fire(9);
    const stacked = await page.evaluate(
      () => document.querySelectorAll("#vtopext-session-banner").length
    );
    ok("a second warning does not stack a second banner", stacked === 1, `count=${stacked}`);

    await page.click("[data-vr-action='session-recover']");
    await page.waitForURL(/\/vtop\/login$/, { timeout: 5000 }).catch(() => {});
    const landed = await page.evaluate(() => location.pathname);
    ok(
      "the recovery button lands on the login page",
      landed === "/vtop/login",
      `url=${landed}`
    );
    await page.close();

    /*
     * Clearing the cookies is the half of the recovery a student cannot do
     * themselves: while the stale cookie is in the jar VTOP answers
     * /vtop/login with a 404 too, so sending them there without clearing is
     * the same dead end. Checked on its own page because the navigation above
     * wipes the recorder — the stub here never calls the callback, so the
     * handler never navigates and the record survives to be read.
     */
    const p2 = await newPage(browser);
    await p2.route("https://vtop-stale2.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<body><div id='vtopMainDiv'></div></body>" })
    );
    await p2.goto("https://vtop-stale2.test/vtop/content");
    await p2.addScriptTag({
      content: stub.replace("if (cb) cb(1);", "/* never answers */"),
    });
    await inject(p2, ["js/shared/click.js", "js/shared/vtop.js", "js/session_repair.js"]);
    await p2.evaluate(() =>
      window.__listeners.forEach((fn) => fn({ message: "session_dead", failures: 3 }))
    );
    await p2.click("[data-vr-action='session-recover']");
    const sent2 = await p2.evaluate(() => window.__sent);
    ok(
      "the recovery asks the worker to clear this site's cookies first",
      sent2.length === 1 && sent2[0].message === "clear_site_cookies",
      JSON.stringify(sent2)
    );
    await p2.close();
  }

  /* ============ the VTOP circuit breaker ============
   *
   * `js/shared/vtop.js` is the thing standing between the student and *"make
   * sure the vtop doesnt get logged out"*, and it shipped with no direct test —
   * only indirect exercise through the pages that use it. Repeated failed POSTs
   * are what damages a session, so the one behaviour that must be true is that
   * failure makes it STOP, not try the other seven.
   */
  console.log("\n=== VTOP circuit breaker: stop, don't retry ===");
  {
    // `plan` is one entry per fetch; the last entry repeats for anything beyond.
    const bootVtop = async (plan) => {
      const page = await newPage(browser);
      await page.setContent(
        "<body>" +
          // VTOP ships EMPTY _csrf placeholders on some fragments and
          // querySelector takes the first match — picking that one 404s every
          // request made with it. The first non-empty token is the right one.
          '<input name="_csrf" value="">' +
          '<input name="_csrf" value="TOKEN-1">' +
          '<input id="authorizedIDX" value="24TEST0001">' +
          '<div class="table-responsive"><table></table></div>' +
          "</body>"
      );
      await page.addScriptTag({
        content:
          "window.__fetches = [];\n" +
          `const plan = ${JSON.stringify(plan)};\n` +
          "window.fetch = (url) => {\n" +
          "  window.__fetches.push(String(url));\n" +
          "  const step = plan[Math.min(window.__fetches.length - 1, plan.length - 1)];\n" +
          "  return Promise.resolve({\n" +
          "    ok: step.status >= 200 && step.status < 300,\n" +
          "    status: step.status,\n" +
          "    text: () => Promise.resolve(step.body || 'ok'),\n" +
          "  });\n" +
          "};\n" +
          "window.__try = async (n, opts) => {\n" +
          "  const out = [];\n" +
          "  for (let i = 0; i < n; i++) {\n" +
          "    try { out.push('ok'); await window.vrVtop.post('p' + i, {}, opts); }\n" +
          "    catch (e) { out[out.length - 1] = String(e.message); }\n" +
          "  }\n" +
          "  return out;\n" +
          "};",
      });
      await inject(page, ["js/shared/vtop.js"]);
      return page;
    };

    {
      const page = await bootVtop([{ status: 200 }]);
      const ids = await page.evaluate(() => [window.vrVtop.csrf(), window.vrVtop.authorizedID()]);
      ok(
        "the first NON-EMPTY _csrf is used, not the first one on the page",
        ids[0] === "TOKEN-1" && ids[1] === "24TEST0001",
        JSON.stringify(ids)
      );
      await page.close();
    }

    {
      const page = await bootVtop([{ status: 404 }]);
      const r = await page.evaluate(() => window.__try(6));
      const state = await page.evaluate(() => ({
        fetches: window.__fetches.length,
        banner: (document.getElementById("vtopext-session-banner") || {}).textContent || null,
      }));
      ok(
        "three refusals in a row stop it — the other three are never sent",
        state.fetches === 3,
        JSON.stringify({ fetches: state.fetches, results: r })
      );
      ok(
        "and every later call fails fast, saying the session is stale",
        r.slice(3).every((m) => /vtop-session-stale/.test(m)),
        JSON.stringify(r)
      );
      ok(
        "the student is told why, and what fixes it",
        !!state.banner && /refused 3 requests in a row \(HTTP 404\)/.test(state.banner) &&
          /sign in again/i.test(state.banner),
        String(state.banner).slice(0, 160)
      );
      await page.close();
    }

    {
      // Consecutive, not cumulative. A deployment that answers every other
      // request is annoying, not hostile, and must not be shut down.
      const page = await bootVtop([
        { status: 404 }, { status: 404 }, { status: 200 },
        { status: 404 }, { status: 404 }, { status: 200 },
      ]);
      await page.evaluate(() => window.__try(6));
      const state = await page.evaluate(() => ({
        fetches: window.__fetches.length,
        tripped: window.vrVtop.tripped,
      }));
      ok(
        "a success in between resets the count — the breaker stays shut",
        state.fetches === 6 && state.tripped === false,
        JSON.stringify(state)
      );
      await page.close();
    }

    {
      // Endpoint probing 404s by design on every deployment it guessed wrong
      // about. Counting those like real failures would trip the breaker on the
      // first subject of every page load and kill the feature permanently.
      const page = await bootVtop([{ status: 404 }]);
      await page.evaluate(() => window.__try(11, { probe: true }));
      let tripped = await page.evaluate(() => window.vrVtop.tripped);
      ok("eleven failed probes do not trip it", tripped === false);
      await page.evaluate(() => window.__try(1, { probe: true }));
      const state = await page.evaluate(() => ({
        tripped: window.vrVtop.tripped,
        banner: (document.getElementById("vtopext-session-banner") || {}).textContent || null,
      }));
      ok(
        "but twelve, with nothing ever having worked, is a session refusing everything",
        state.tripped === true && /refused 12 requests in a row/.test(state.banner || ""),
        JSON.stringify(state)
      );
      await page.close();
    }

    {
      // One success anywhere proves the session is fine, so probe failures
      // stop meaning anything at all from then on.
      const page = await bootVtop([{ status: 200 }, { status: 404 }]);
      await page.evaluate(() => window.__try(1));
      await page.evaluate(() => window.__try(30, { probe: true }));
      const tripped = await page.evaluate(() => window.vrVtop.tripped);
      ok("after one success, no number of failed probes trips it", tripped === false);
      await page.close();
    }

    {
      // The state the ROADMAP says users actually hit: shell healthy, content
      // POSTs answered 200 with VTOP's own session-expired page inside. A
      // failure wearing a success code still has to count.
      const page = await bootVtop([{ status: 200, body: "<html>Session Expired. Please Login Again</html>" }]);
      const r = await page.evaluate(() => window.__try(5));
      const state = await page.evaluate(() => ({
        fetches: window.__fetches.length,
        tripped: window.vrVtop.tripped,
      }));
      ok(
        "a 200 carrying 'session expired' counts as a refusal and trips it",
        state.tripped === true && state.fetches === 3 && /session expired/i.test(r[0]),
        JSON.stringify({ state, first: r[0] })
      );
      await page.close();
    }

    {
      // The pool must not queue work behind a tripped breaker either.
      const page = await bootVtop([{ status: 404 }]);
      const done = await page.evaluate(async () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8];
        const out = await window.vrVtop.pool(items, 3, async (n) => window.vrVtop.post("c" + n, {}));
        return { fetches: window.__fetches.length, results: out.length };
      });
      ok(
        "eight queued jobs stop after the breaker trips, not after eight failures",
        done.fetches <= 5,
        JSON.stringify(done)
      );
      await page.close();
    }

    {
      // No token means the page is not what we think it is. Send nothing.
      const page = await newPage(browser);
      await page.setContent("<body><div class='table-responsive'></div></body>");
      await page.addScriptTag({
        content: "window.__fetches=[];window.fetch=(u)=>{window.__fetches.push(u);return Promise.resolve({ok:true,status:200,text:()=>Promise.resolve('')});};",
      });
      await inject(page, ["js/shared/vtop.js"]);
      const r = await page.evaluate(async () => {
        let message = null;
        try { await window.vrVtop.post("x", {}); } catch (e) { message = e.message; }
        return { message, fetches: window.__fetches.length };
      });
      ok(
        "with no _csrf on the page nothing is sent at all",
        r.fetches === 0 && /missing _csrf/.test(r.message || ""),
        JSON.stringify(r)
      );
      await page.close();
    }
  }

  /* ============ home card leads with debarment, not with CAT-1 ============
   *
   * Asked for 2026-08-17. The old card's headline was "only N class(es)
   * skippable before CAT-1" — a number that stops meaning anything the day
   * CAT-1 arrives, and which nothing on the card could tell had expired. It
   * had been seen live reading 0 for a subject with three in hand.
   *
   * The 75% line does not expire: it is measured against the whole semester.
   * These assert that the card says which subjects are close to it, in the
   * three states a student can actually be in.
   */
  console.log("\n=== home card: how close to being debarred ===");
  {
    const now = new Date("2026-08-17T09:00:00+05:30").getTime();
    const sem = "Fall Semester 2026-27";
    const cardText = async (subjects) => {
      const page = await newPage(browser);
      await page.setContent("<body><div id='main-section'></div></body>");
      await shim(page, {
        fixedMs: now,
        storage: {
          ["vtopext_calendar_" + sem.toLowerCase()]: {
            version: 2,
            semester: sem,
            fetchedAt: now,
            cat1: "2026-08-24",
            holidays: [],
            instructionalDays: [],
            lastInstructional: "2026-12-05",
          },
          vtopext_attendance_summary: { fetchedAt: now, semester: sem, subjects },
        },
      });
      await inject(page, ["js/utils/chooseCurrentSem.js", "js/home_notices.js"]);
      await delay(1200);
      const text = await page.evaluate(() => {
        const el = document.getElementById("vtopext-home-notices");
        return el ? el.textContent : null;
      });
      await page.close();
      return text || "";
    };

    // Already under 75% and recoverable: the only actionable number is how
    // many in a row must be attended.
    let text = await cardText([
      {
        name: "CSE3009 - NoSQL Databases",
        code: "CSE3009",
        pct: 68,
        safeNow: 0,
        below75: true,
        recover: 4,
        canRecover: true,
        maxPct: 88,
        unit: "class(es)",
      },
    ]);
    ok("below 75% is named as debarment, with the recovery count", /below 75%/.test(text) && /debarred unless you attend the next 4 class\(es\)/.test(text), text.slice(0, 240));
    ok("the old exam-relative headline is gone", !/skippable before/.test(text), text.slice(0, 240));

    // Under 75% and beyond saving: telling this student to "attend 6 more" is
    // arithmetic that does not exist. Say what perfect attendance reaches.
    text = await cardText([
      {
        name: "CHY1008 - Chemistry",
        code: "CHY1008",
        pct: 52,
        safeNow: 0,
        below75: true,
        recover: 9,
        canRecover: false,
        maxPct: 71,
        unit: "class(es)",
      },
    ]);
    ok(
      "an unrecoverable subject is not given impossible advice",
      /still only reaches 71%/.test(text) && !/attend the next/.test(text),
      text.slice(0, 240)
    );

    // Above the line, but one absence from crossing it.
    text = await cardText([
      { name: "MAT2002 - Applied Numerical Methods", code: "MAT2002", pct: 76, safeNow: 0, below75: false, unit: "class(es)" },
      { name: "CSE2005 - Operating Systems", code: "CSE2005", pct: 78, safeNow: 1, below75: false, unit: "class(es)" },
      { name: "CSE2005 - Operating Systems Lab", code: "CSE2005L", pct: 90, safeNow: 4, below75: false, unit: "lab(s)" },
    ]);
    ok("no headroom is stated as such", /no room left/.test(text), text.slice(0, 240));
    ok("one left is singular, not '1 class(es)'", /1 class left before debar/.test(text), text.slice(0, 240));
    ok(
      "everyone else is one compact line, tightest first",
      /Can still miss before debar: CSE2005L \(lab\) 4/.test(text),
      text.slice(0, 240)
    );

    /*
     * A SHELL THAT ARRIVES LATE. ROADMAP records VTOP stalling its own static
     * assets for thirty seconds or more; the retry budget was seven, so on one
     * of those loads the card simply never appeared — silently, nothing in the
     * console, indistinguishable from the feature being broken.
     *
     * Deliberately a slow test (~10 s): the container is added at 8 s, past the
     * old cap and inside the new one. There is no way to assert this quickly
     * that would still have caught the bug.
     */
    {
      const page = await newPage(browser);
      await page.setContent("<body></body>");
      await shim(page, {
        fixedMs: now,
        storage: {
          vtopext_attendance_summary: {
            fetchedAt: now,
            semester: sem,
            subjects: [
              { name: "CSE3009 - NoSQL", code: "CSE3009", pct: 93, safeNow: 3, below75: false, unit: "class(es)" },
            ],
          },
        },
      });
      await inject(page, ["js/utils/chooseCurrentSem.js", "js/home_notices.js"]);
      await delay(8000);
      const earlyCard = await page.evaluate(() => !!document.getElementById("vtopext-home-notices"));
      await page.evaluate(() => {
        const d = document.createElement("div");
        d.id = "main-section";
        document.body.appendChild(d);
      });
      await delay(2000);
      const lateCard = await page.evaluate(() => !!document.getElementById("vtopext-home-notices"));
      ok(
        "a shell that takes 8s to arrive still gets the card",
        earlyCard === false && lateCard === true,
        JSON.stringify({ earlyCard, lateCard })
      );
      await page.close();
    }

    // Comfortable across the board: say so once rather than listing nothing.
    text = await cardText([
      { name: "CSE3009 - NoSQL Databases", code: "CSE3009", pct: 93, safeNow: 3, below75: false, unit: "class(es)" },
    ]);
    ok("a safe student is told so, in one line", /Nothing is close to the 75% line/.test(text), text.slice(0, 240));

    // An exam figure is still worth showing — but only while its exam is ahead.
    text = await cardText([
      { name: "CSE3009 - NoSQL", code: "CSE3009", pct: 76, safeNow: 0, below75: false, nextBunkable: 2, nextExamIso: "2026-08-24", nextExamLabel: "CAT-1", unit: "class(es)" },
      { name: "CHY1008 - Chemistry", code: "CHY1008", pct: 76, safeNow: 0, below75: false, nextBunkable: 9, nextExamIso: "2026-08-10", nextExamLabel: "CAT-1", unit: "class(es)" },
    ]);
    ok("a live exam figure rides along in brackets", /\(2 before CAT-1\)/.test(text), text.slice(0, 300));
    ok(
      "an exam that has already happened is dropped, not shown",
      !/9 before/.test(text),
      text.slice(0, 300)
    );
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
      ["vtopext_calendar_" + oldSem.toLowerCase()]: oldCalendar,
      vtopext_attendance_summary: oldSummary,
    };

    // heads-up card: stale note shown, at-risk/safe-skip lines suppressed
    let page = await newPage(browser);
    await page.setContent("<body><div id='main-section'></div></body>");
    await shim(page, { fixedMs: fixed, storage });
    await inject(page, ["js/utils/chooseCurrentSem.js", "js/home_notices.js"]);
    await delay(1200);
    let text = await page.evaluate(() => {
      const el = document.getElementById("vtopext-home-notices");
      return el ? el.textContent : null;
    });
    ok("heads-up card rendered", !!text, text || "no card");
    ok("stale note names the old semester", !!text && text.includes(oldSem) && /looks over/.test(text), (text || "").slice(0, 160));
    ok("old at-risk warnings suppressed", !!text && !/no room left|before debar/.test(text));
    ok("old safe-skip line suppressed", !!text && !/Can still miss before debar/.test(text));
    await page.close();

    // same caches 11 days earlier (semester still running) → normal render
    const during = new Date("2026-07-05T10:00:00+05:30").getTime();
    page = await newPage(browser);
    await page.setContent("<body><div id='main-section'></div></body>");
    await shim(page, { fixedMs: during, storage });
    await inject(page, ["js/utils/chooseCurrentSem.js", "js/home_notices.js"]);
    await delay(1200);
    text = await page.evaluate(() => {
      const el = document.getElementById("vtopext-home-notices");
      return el ? el.textContent : null;
    });
    ok("mid-semester: no stale note", !!text && !/looks over/.test(text), (text || "").slice(0, 160));
    ok("mid-semester: at-risk warning shown", !!text && /no room left/.test(text), (text || "").slice(0, 200));
    ok("mid-semester: FAT countdown shown", !!text && /FAT starts in/.test(text));
    await page.close();

    /* ===== the stale-attendance line does the chore instead of naming it =====
     *
     * Asked for 2026-08-19: "(attendance data is 2 day(s) old — open the
     * Attendance page to refresh)… this one it should be auto na".
     *
     * It refreshes by clicking VTOP's own Class Attendance menu entry, not by
     * replaying the attendance POST — that is ROADMAP rule 4, and the state it
     * produces is the one session_repair now has to warn about. What this
     * cannot cover is the world boundary: here the click and the listener are
     * in the same world. That direction is settled by js/attendance.js, which
     * drives #semesterSubId with a dispatched `change` from the isolated world
     * and is the route rule 4 names as sanctioned.
     */
    {
      const stale = {
        fetchedAt: during - 2 * 86400000,
        semester: oldSem,
        subjects: oldSummary.subjects,
      };
      const staleStore = {
        ["vtopext_calendar_" + oldSem.toLowerCase()]: oldCalendar,
        vtopext_attendance_summary: stale,
      };

      page = await newPage(browser);
      await page.setContent(
        "<body><a id='attmenu' data-url='academics/common/StudentAttendance'>Class Attendance</a>" +
          "<div id='main-section'></div></body>"
      );
      await shim(page, { fixedMs: during, storage: staleStore });
      await inject(page, [
        "js/shared/click.js",
        "js/utils/chooseCurrentSem.js",
        "js/home_notices.js",
      ]);
      await delay(1200);
      await page.evaluate(() => {
        window.__menuClicks = 0;
        document
          .getElementById("attmenu")
          .addEventListener("click", () => (window.__menuClicks += 1));
      });
      const shown = await page.evaluate(() => {
        const el = document.getElementById("vtopext-home-notices");
        return el ? el.textContent : null;
      });
      ok(
        "a 2-day-old summary still says so, without the chore",
        !!shown && /attendance data is 2 day\(s\) old/.test(shown) && !/open the Attendance page/.test(shown),
        (shown || "no card").slice(-160)
      );
      const btn = await page.$('[data-vr-action="home-attendance-refresh"]');
      ok("and it offers the refresh instead", !!btn, String(!!btn));
      if (btn) {
        await page.click('[data-vr-action="home-attendance-refresh"]');
        await delay(200);
        const clicks = await page.evaluate(() => window.__menuClicks);
        ok(
          "with nothing recorded to replay, it stays on the home page (no surprise navigation)",
          clicks === 0,
          String(clicks)
        );
        const open = await page.$('[data-vr-action="home-attendance-open"]');
        ok("...says why and offers an explicit Open Attendance button", !!open, String(!!open));
        if (open) {
          await page.click('[data-vr-action="home-attendance-open"]');
          await delay(200);
          const after = await page.evaluate(() => window.__menuClicks);
          ok("pressing Open Attendance opens it", after === 1, String(after));
        }
      }
      await page.close();

      /* ---- refresh in place, when the student's own request is known ----
       *
       * 2026-08-22: the button used to navigate, always. It replays now —
       * their OWN recorded POST, through window.vrVtop (live token, circuit
       * breaker), which is what makes this different from the guessed burst
       * ROADMAP rule 4 warns about. The page must NOT be opened.
       */
      {
        const p = await newPage(browser);
        await p.setContent(
          "<body><a id='attmenu' data-url='academics/common/StudentAttendance'>Class Attendance</a>" +
            "<input name='_csrf' value='live-token'>" +
            "<input id='authorizedIDX' value='24TEST0001'>" +
            "<div id='main-section'></div></body>"
        );
        await shim(p, {
          fixedMs: during,
          storage: {
            ...staleStore,
            // the previous real visit: exam-dated fields this response cannot
            // reproduce, on a subject the response DOES carry, so "carried
            // forward" is a claim with something behind it
            vtopext_attendance_summary: {
              fetchedAt: during - 2 * 24 * 60 * 60 * 1000,
              semester: "Fall Semester 2026-27",
              subjects: [
                {
                  name: "SWE2009 - Theory",
                  code: "SWE2009",
                  pct: 71,
                  below75: true,
                  safeNow: 0,
                  nextBunkable: 4,
                  nextExamIso: "2026-09-15",
                  nextExamLabel: "CAT-1",
                  unit: "class(es)",
                },
              ],
            },
            vtopext_attendance_request: {
              path: "processViewStudentAttendance",
              params: { semesterSubId: "AP2026272" },
            },
          },
        });
        // VTOP's answer: one theory subject comfortably above the line, one
        // LAB whose headroom must come back in sessions rather than hours
        await p.evaluate(() => {
          window.__posts = [];
          window.fetch = async (url, init) => {
            window.__posts.push({ url: String(url), body: String((init || {}).body || "") });
            return {
              ok: true,
              status: 200,
              text: async () =>
                "<table><thead><tr><th>Sl.No.</th><th>Course Detail</th>" +
                "<th>Attended Classes</th><th>Total Classes</th></tr></thead><tbody>" +
                "<tr><td>1</td><td>SWE2009 - Theory</td><td>45</td><td>50</td></tr>" +
                "<tr><td>2</td><td>ECE1006 - Lab</td><td>20</td><td>24</td></tr>" +
                "</tbody></table>",
            };
          };
        });
        await inject(p, [
          "js/shared/click.js",
          "js/shared/vtop.js",
          "js/utils/chooseCurrentSem.js",
          "js/home_notices.js",
        ]);
        await delay(1200);
        await p.evaluate(() => {
          window.__menuClicks = 0;
          document
            .getElementById("attmenu")
            .addEventListener("click", () => (window.__menuClicks += 1));
        });
        await p.click('[data-vr-action="home-attendance-refresh"]');
        await delay(900);

        const after = await p.evaluate(() => ({
          menuClicks: window.__menuClicks,
          posts: window.__posts.map((x) => x.url),
          body: (window.__posts[0] || {}).body || "",
          cached: window.__storage.vtopext_attendance_summary,
        }));
        ok(
          "it replays the student's own attendance POST instead of navigating",
          after.menuClicks === 0 &&
            after.posts.length === 1 &&
            /processViewStudentAttendance$/.test(after.posts[0]) &&
            /semesterSubId=AP2026272/.test(after.body),
          JSON.stringify(after.posts) + " " + after.body.slice(0, 120)
        );
        ok(
          "…with a LIVE token, not the stale one that was recorded",
          /_csrf=live-token/.test(after.body) && /authorizedID=24TEST0001/.test(after.body),
          after.body.slice(0, 140)
        );
        const subjects = (after.cached || {}).subjects || [];
        const lab = subjects.find((s) => /lab/i.test(s.unit || ""));
        const theory = subjects.find((s) => /SWE2009/.test(s.name || ""));
        ok(
          "the snapshot is rewritten from the response — 45/50 is 90%",
          !!theory && theory.pct === 90 && theory.safeNow === 7,
          JSON.stringify(theory)
        );
        // 20/24 -> floor(20 - 0.75*24) = 2 class-hours = ONE lab session
        ok(
          "a lab's headroom comes back in sessions, not class-hours",
          !!lab && lab.pct === 83 && lab.safeNow === 1 && lab.unit === "lab(s)",
          JSON.stringify(lab)
        );
        /*
         * The honest limit of a refresh that never opens the page: the
         * exam-dated columns come from the calendar and the per-subject
         * history, neither of which is in this response, so they are carried
         * forward rather than recomputed badly or silently dropped.
         */
        ok(
          "calendar-derived fields survive the refresh that cannot recompute them",
          !!theory && theory.nextExamLabel === "CAT-1" && theory.nextBunkable === 4,
          JSON.stringify(theory)
        );
        // …and the numbers this response CAN prove are the ones that changed:
        // the cached snapshot had SWE2009 below the line at 71%
        ok(
          "a subject that has climbed back above 75% is no longer flagged",
          !!theory && theory.below75 === false && theory.pct === 90,
          JSON.stringify(theory)
        );
        await p.close();
      }

      // A role whose menu has no Class Attendance entry must not be given a
      // button that cannot work — it gets the instruction that is still true.
      // The menu has to be PRESENT for that judgement: an empty document is
      // "the sidebar has not rendered yet", which is the next case down.
      page = await newPage(browser);
      await page.setContent(
        "<body><a data-url='examinations/StudentMarkView'>Marks</a>" +
          "<div id='main-section'></div></body>"
      );
      await shim(page, { fixedMs: during, storage: staleStore });
      await inject(page, [
        "js/shared/click.js",
        "js/utils/chooseCurrentSem.js",
        "js/home_notices.js",
      ]);
      await delay(1200);
      const noMenu = await page.evaluate(() => {
        const el = document.getElementById("vtopext-home-notices");
        return {
          text: el ? el.textContent : null,
          button: !!document.querySelector('[data-vr-action="home-attendance-refresh"]'),
        };
      });
      ok(
        "with no menu entry it falls back to the instruction, not a dead button",
        !noMenu.button && /open the Attendance page to refresh/.test(noMenu.text || ""),
        JSON.stringify(noMenu).slice(0, 200)
      );
      await page.close();

      /*
       * …but a menu that has not rendered YET is not the same thing, and
       * treating it as "this role cannot" is how the button goes missing on a
       * page that could have offered it. The card can render before VTOP has
       * written the sidebar, so with no menu anchors at all the button is
       * offered and the link is resolved at click time instead.
       */
      page = await newPage(browser);
      await page.setContent("<body><div id='main-section'></div></body>");
      await shim(page, { fixedMs: during, storage: staleStore });
      await inject(page, [
        "js/shared/click.js",
        "js/utils/chooseCurrentSem.js",
        "js/home_notices.js",
      ]);
      await delay(1200);
      const notYet = await page.evaluate(
        () => !!document.querySelector('[data-vr-action="home-attendance-refresh"]')
      );
      ok(
        "a sidebar that has not rendered yet still gets the button",
        notYet === true,
        String(notYet)
      );
      await page.close();
    }

    /* ============ vrAutoSemester: open the page, not the picker ============
     *
     * Asked for 2026-08-19 ("when i click attendance i dont choose the
     * semester, you should keep it like tht"). Shapes read off the live portal
     * the same day: Marks/Grades/Time Table load from #semesterSubId's own
     * onchange, Exam Schedule has NO onchange and needs its Search button —
     * which is why its venue watcher so rarely ran.
     *
     * Verified end-to-end on the real portal too: a fresh Exam Schedule page
     * with an empty picker auto-selected, searched, found "Examination
     * Schedule Details Not Found" on "Fall Semester 2026-27 Freshers" (which
     * is what chooseCurrentSemester picks — the names tie and document order
     * wins), stepped down, and rendered the real CAT-1 table.
     *
     * The property that matters most here is the one a live check cannot show
     * safely: that it CANNOT loop. These hooks fire after every VTOP AJAX
     * render, so a semester that legitimately has no rows would otherwise
     * re-trigger on its own response forever — the repeated-POST state
     * session_repair exists for.
     */
    console.log("\n=== vrAutoSemester: semester-gated pages open themselves ===");
    {
      const semPage = async (opts = {}) => {
        const p = await newPage(browser);
        await p.setContent(`<body><div id='main-section'>
          <select id='semesterSubId'>
            <option value=''>-- Choose Semester --</option>
            <option value='AP1'>Fall Semester 2026-27 Freshers</option>
            <option value='AP2'>Fall Semester 2026-27</option>
            <option value='AP3'>Winter Semester 2025-26</option>
          </select>
          <button class='btn'>Search</button>
          <div id='out'>${opts.out || ""}</div>
        </div></body>`);
        await shim(p, {
          fixedMs: new Date("2026-08-19T21:00:00+05:30").getTime(),
          storage: opts.storage || {},
        });
        await inject(p, ["js/utils/chooseCurrentSem.js", "js/shared/auto_semester.js"]);
        return p;
      };

      // The Exam Schedule shape: a Search button, and the first pick is wrong.
      {
        const p = await semPage();
        await p.evaluate(() => {
          window.submits = [];
          document.querySelector("button").addEventListener("click", () => {
            const v = document.getElementById("semesterSubId").value;
            window.submits.push(v);
            // only the student's own semester has a schedule
            document.getElementById("out").innerHTML =
              v === "AP2"
                ? "<table><tr><td>Exam Date</td><td>Venue</td></tr></table>"
                : "Examination Schedule Details Not Found";
          });
          window.vrAutoSemester({
            name: "exam_schedule",
            loaded: () =>
              Array.from(document.querySelectorAll("table")).some((t) =>
                /exam\s*date|venue/i.test(t.innerText || "")
              ),
            submit: window.vrSemesterSearch,
            settleMs: 120,
          });
        });
        await delay(900);
        const r = await p.evaluate(() => ({
          submits: window.submits,
          value: document.getElementById("semesterSubId").value,
          rendered: /Exam Date/.test(document.getElementById("out").innerText),
        }));
        ok(
          "it presses Search itself instead of leaving an empty picker",
          r.submits.length >= 1 && r.submits[0] === "AP2",
          JSON.stringify(r)
        );
        ok(
          "it lands on the student's own semester without a second attempt",
          r.rendered && r.value === "AP2" && r.submits.length === 1,
          JSON.stringify(r)
        );
        await p.close();
      }

      /*
       * THE SAFETY PROPERTY: re-fired messages must not re-submit — and, since
       * 2026-08-21, a semester that renders nothing must not be "corrected"
       * either. Measured live that day: the Marks page shows ZERO tables for
       * the semester the student is actually in, because it is August and no
       * marks have been published. The old walk read that as a wrong guess and
       * stepped through Freshers → Transport → Fast Track, ending on a junk
       * semester after four POSTs. Empty is an answer; one submit, and stop.
       */
      {
        const p = await semPage();
        await p.evaluate(async () => {
          window.submits = [];
          document.querySelector("button").addEventListener("click", () => {
            window.submits.push(document.getElementById("semesterSubId").value);
            // every semester comes back empty — the loop bait
            document.getElementById("out").innerHTML = "Details Not Found";
          });
          const run = () =>
            window.vrAutoSemester({
              name: "exam_schedule",
              loaded: () => false,
              submit: window.vrSemesterSearch,
              settleMs: 60,
            });
          for (let i = 0; i < 8; i++) {
            run();
            await new Promise((r) => setTimeout(r, 60));
          }
        });
        await delay(900);
        const submits = await p.evaluate(() => window.submits);
        ok(
          "a semester that renders nothing is submitted once and then left alone",
          submits.length === 1,
          `${submits.length} submits: ${JSON.stringify(submits)}`
        );
        await p.close();
      }

      // Data already on screen is never disturbed.
      {
        const p = await semPage({ out: "<table><tr><td>Exam Date</td></tr></table>" });
        const r = await p.evaluate(async () => {
          window.submits = [];
          document.querySelector("button").addEventListener("click", () =>
            window.submits.push(1)
          );
          const started = await window.vrAutoSemester({
            name: "exam_schedule",
            loaded: () =>
              Array.from(document.querySelectorAll("table")).some((t) =>
                /exam\s*date/i.test(t.innerText || "")
              ),
            submit: window.vrSemesterSearch,
          });
          return { started, submits: window.submits.length };
        });
        ok(
          "a page already showing its data is left completely alone",
          r.started === false && r.submits === 0,
          JSON.stringify(r)
        );
        await p.close();
      }

      /*
       * THE ONE THAT MATTERS, reported 2026-08-19: "i am not a fresher so it
       * should select fall semester".
       *
       * The Exam Schedule dropdown lists every semester VIT-AP runs, and
       * "Fall Semester 2026-27 Freshers" parses identically to "Fall Semester
       * 2026-27" — chooseCurrentSemester() takes the first, which is the wrong
       * one for anybody past first year. The attendance page never shows this
       * because its dropdown holds only the student's own semesters, tagged
       * " - AMR"; that name is cached, so it is the answer. Getting there via
       * the fallback walk was a workaround for a question already answered.
       */
      {
        const p = await semPage({
          storage: {
            vtopext_attendance_summary: { semester: "Fall Semester 2026-27 - AMR" },
          },
        });
        await p.evaluate(async () => {
          window.submits = [];
          document.querySelector("button").addEventListener("click", () => {
            window.submits.push(document.getElementById("semesterSubId").value);
            document.getElementById("out").innerHTML =
              "<table><tr><td>Exam Date</td></tr></table>";
          });
          await window.vrAutoSemester({
            name: "exam_schedule",
            loaded: () =>
              Array.from(document.querySelectorAll("table")).some((t) =>
                /exam\s*date/i.test(t.innerText || "")
              ),
            submit: window.vrSemesterSearch,
            settleMs: 100,
          });
        });
        await delay(500);
        const r = await p.evaluate(() => window.submits);
        ok(
          "it opens the semester the student is REGISTERED in, first try, not Freshers",
          r.length === 1 && r[0] === "AP2",
          JSON.stringify(r)
        );
        await p.close();
      }

      // With nothing cached it still has to work — just by parsing, as before.
      {
        const p = await semPage();
        await p.evaluate(async () => {
          window.submits = [];
          document.querySelector("button").addEventListener("click", () => {
            window.submits.push(document.getElementById("semesterSubId").value);
          });
          await window.vrAutoSemester({
            name: "exam_schedule",
            loaded: () => false,
            submit: window.vrSemesterSearch,
            settleMs: 60,
          });
        });
        await delay(500);
        const r = await p.evaluate(() => window.submits);
        ok(
          "with no cache it falls back to parsing rather than doing nothing",
          r.length >= 1 && r[0] === "AP2",
          JSON.stringify(r)
        );
        await p.close();
      }

      // The onchange pages (Marks, Grades, Time Table) use the other submit.
      {
        const p = await semPage();
        const r = await p.evaluate(async () => {
          window.changes = [];
          document
            .getElementById("semesterSubId")
            .addEventListener("change", function () {
              window.changes.push(this.value);
            });
          await window.vrAutoSemester({
            name: "mark_view",
            loaded: () => window.changes.length > 0,
            submit: window.vrSemesterChange,
            settleMs: 60,
          });
          return { changes: window.changes };
        });
        ok(
          "the onchange pages are driven by a change event, not a button",
          r.changes.length === 1 && r.changes[0] === "AP2",
          JSON.stringify(r)
        );
        await p.close();
      }
    }

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
      const el = document.getElementById("vtopext-next-class");
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
      const el = document.getElementById("vtopext-next-class");
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
        const el = document.getElementById("vtopext-next-class");
        return el ? el.textContent : null;
      });
      ok(label, !!text && /last semester/.test(text) === expectStale, text || "no card");
      await page.close();
    }
  }

  /* ============ next-class widget: labs use the LAB time grid ============ */
  console.log("\n=== next-class widget: lab times (own grid, not theory's) ===");
  {
    // Real VIT-AP columns, read off the live timetable 2026-08-04: the last
    // theory column is 18:00-18:50 while the LAB column for the same position
    // is 17:40-18:30. L35 was rendering at 18:00 — 20 minutes late — because
    // only the theory header row was ever saved.
    const fixed = new Date("2026-08-04T16:00:00+05:30").getTime();
    const wd = new Date(fixed).getDay();
    const code = DAY_CODES[wd];
    const header = ["Start - End", "17:00 - 17:50", "18:00 - 18:50"];
    const headerLab = ["Start - End", "16:40 - 17:30", "17:40 - 18:30"];
    const mk = (withLabHeader) => ({
      header,
      ...(withLabHeader ? { headerLab } : {}),
      data: [
        {
          day: code,
          theory: ["", "", ""],
          lab: ["", "", "L35-SWE2009-ELA-321-CB-ALL"],
        },
      ],
    });

    const render = async (tt) => {
      const p = await newPage(browser);
      await p.setContent("<body><div id='main-section'></div></body>");
      await shim(p, { fixedMs: fixed, storage: { "timeTable-V1": tt } });
      await inject(p, [
        "js/store/store.js",
        "js/store/saveTimeTableDetails.js",
        "js/utils/filterRepeated.js",
        "js/next_class.js",
      ]);
      await p.evaluate(() => window.__dispatch("nav_bar_change"));
      await delay(1200);
      const t = await p.evaluate(() => {
        const el = document.getElementById("vtopext-next-class");
        return el ? el.textContent : null;
      });
      await p.close();
      return t;
    };

    const fixedText = await render(mk(true));
    ok("lab shows its LAB start 17:40", !!fixedText && /at 17:40/.test(fixedText), fixedText || "no card");
    ok("lab does NOT show the theory column's 18:00", !!fixedText && !/at 18:00/.test(fixedText), fixedText || "");
    ok("countdown follows the lab start (1 h 40 min)", !!fixedText && /in 1 h 40 min/.test(fixedText), fixedText || "");

    const legacyText = await render(mk(false));
    ok(
      "legacy save without headerLab degrades to the theory time, not a crash",
      !!legacyText && /at 18:00/.test(legacyText),
      legacyText || "no card"
    );
  }

  /* =================== login OTP: webmail scanner =================== */
  console.log("\n=== login OTP scanner (webmail tab) ===");
  {
    // Drives js/otp/mail_scan.js the way the service worker does: set the page
    // text to what a webmail tab renders, send vtopext_scan_otp, read the code.
    const scan = async (bodyText, ignore = []) => {
      const p = await newPage(browser);
      await p.setContent("<body></body>");
      await p.evaluate((t) => { document.body.innerText = t; }, bodyText);
      await shim(p, {});
      await inject(p, ["js/otp/mail_scan.js"]);
      const out = await p.evaluate(
        (ig) =>
          new Promise((resolve) => {
            const l = window.__listeners[window.__listeners.length - 1];
            l({ message: "vtopext_scan_otp", ignore: ig }, {}, resolve);
          }),
        ignore
      );
      await p.close();
      return out && out.code;
    };
    // same, but keeps the rendered age the scanner worked out
    const scanFull = async (bodyText, ignore = []) => {
      const p = await newPage(browser);
      await p.setContent("<body></body>");
      await p.evaluate((t) => { document.body.innerText = t; }, bodyText);
      await shim(p, {});
      await inject(p, ["js/otp/mail_scan.js"]);
      const out = await p.evaluate(
        (ig) =>
          new Promise((resolve) => {
            const l = window.__listeners[window.__listeners.length - 1];
            l({ message: "vtopext_scan_otp", ignore: ig }, {}, resolve);
          }),
        ignore
      );
      await p.close();
      return out;
    };

    const inbox =
      "Inbox\nVIT VTOP  Your OTP for VTOP login is 481920. Valid for 10 minutes.  10:32 AM\n" +
      "Amazon  Your order 3391 has shipped  09:14 AM\n© 2026 VIT University";

    ok("reads the OTP out of rendered mail text", (await scan(inbox)) === "481920",
      String(await scan(inbox)));

    ok(
      "already-used code is skipped (stale mail never refilled)",
      (await scan(inbox, ["481920"])) === null,
      String(await scan(inbox, ["481920"]))
    );

    ok(
      "a newer code wins once the old one is ignored",
      (await scan(
        "VTOP one time password: 778812\n" + inbox,
        ["481920"]
      )) === "778812"
    );

    ok(
      "copyright year next to OTP wording is not mistaken for a code",
      (await scan("Your OTP is expired. © 2026 VIT")) === null,
      String(await scan("Your OTP is expired. © 2026 VIT"))
    );

    ok(
      "digits with no OTP wording anywhere are ignored",
      (await scan("Call 9876543210 or reference 445566 for details")) === null,
      String(await scan("Call 9876543210 or reference 445566 for details"))
    );

    ok(
      "6-digit VTOP code beats an unrelated short number nearby",
      (await scan("Ref 12 — verification code 902133 for VTOP")) === "902133",
      String(await scan("Ref 12 — verification code 902133 for VTOP"))
    );

    /* ---- the live failure: an open Gmail thread reads OLDEST FIRST ---- */
    // Reproduces the 2026-08-06 report verbatim. Every VTOP login mail lands
    // in one conversation, Gmail renders it oldest-to-newest, and the scanner
    // filled the TOP code — a months-old, long-expired OTP.
    const mail = (time, ago, code) =>
      `noreply.sdc@vitap.ac.in\n${time} (${ago})\nto me\n` +
      "🔐 VTOP Login Verification\nOne-Time Password Request\n\nDear VITian,\n" +
      "Use the OTP below to complete your login.\n\nYour One-Time Password\n\n" +
      `${code}\n⏱ Expires in 3 minutes\n\nRegards,\nVTOP Team\n\n`;
    const thread =
      "VTOP Login OTP Needed\n" +
      mail("11:02 PM", "2 hours ago", "233266") +
      mail("12:31 AM", "13 minutes ago", "915298") +
      mail("12:43 AM", "1 minute ago", "039837") +
      mail("12:43 AM", "just now", "363453");

    const live = await scanFull(thread);
    ok(
      "open thread: takes the NEWEST OTP, not the topmost",
      live.code === "363453",
      JSON.stringify(live)
    );
    ok(
      "the 2-hour-old code at the top of the thread is not filled",
      live.code !== "233266",
      String(live.code)
    );
    ok("reports the winning mail's age", live.ageMin === 0, String(live.ageMin));

    const aged = await scanFull(
      "VTOP Login OTP Needed\n" + mail("9:00 PM", "4 hours ago", "778812")
    );
    ok(
      "a stale-only thread still reports how old it is (caller warns)",
      aged.code === "778812" && aged.ageMin === 240,
      JSON.stringify(aged)
    );

    ok(
      "newest wins even when the freshest code sits at the top",
      (await scanFull(
        "VTOP Login OTP Needed\n" +
          mail("12:44 AM", "just now", "111333") +
          mail("11:02 PM", "2 hours ago", "233266")
      )).code === "111333",
      "inbox-list order"
    );

    ok(
      "no rendered ages (Outlook pane): falls back to the LAST match",
      (await scanFull(
        "VTOP one time password: 100001\nVTOP one time password: 200002"
      )).code === "200002",
      "no-age fallback"
    );

    /* ---- only noreply.sdc@vitap.ac.in is trusted ---- */
    const other =
      "security@github.com\n1 minute ago\nYour verification code is 654321\n\n";
    ok(
      "another service's fresher code is ignored, VTOP's is taken",
      (await scanFull(other + mail("12:43 AM", "5 minutes ago", "363453"))).code ===
        "363453",
      JSON.stringify(await scanFull(other + mail("12:43 AM", "5 minutes ago", "363453")))
    );
    ok(
      "a mailbox with no VTOP mail at all yields nothing",
      (await scanFull(other)).code === null,
      JSON.stringify(await scanFull(other))
    );
    ok(
      "no address rendered anywhere → sender rule not enforced (Outlook pane)",
      (await scanFull("Your one time password is 442211")).code === "442211",
      "lenient when no address is present"
    );

    /* ---- multiple Google accounts: which mailbox am I looking at? ---- */
    // The browser is signed into a personal AND a student account, so the
    // caller has to tell "the mail hasn't arrived" apart from "wrong mailbox".
    ok(
      "personal mailbox reports no VTOP mail present",
      (await scanFull(other)).sawVtop === false,
      JSON.stringify(await scanFull(other))
    );
    ok(
      "student mailbox reports VTOP mail present even before a fresh code",
      (await scanFull(mail("11:02 PM", "2 hours ago", "233266"))).sawVtop === true,
      JSON.stringify(await scanFull(mail("11:02 PM", "2 hours ago", "233266")))
    );

    /* ---- Gmail INBOX LIST: display name only, snippet truncated ---- */
    // Verbatim from the 2026-08-06 report. The list renders "noreply.sdc"
    // with no address at all, and cuts the preview off before the digits.
    const inboxList =
      "Inbox (1,147) - student2@vitapstudent.ac.in\n" +
      "noreply.sdc 9\tVTOP Login OTP Needed - 🔐 VTOP Login Verification " +
      "One-Time Password Request Dear VITian, Use the OTP below...\t1:04 AM\n" +
      "VTAPP Convenor\tReg: Call for V-TAPP 2026, T-Shirt Design - Dear Students,\t6:46 PM\n";
    const listed = await scanFull(inboxList);
    ok(
      "inbox list: display name 'noreply.sdc' counts as VTOP mail present",
      listed.sawVtop === true,
      JSON.stringify(listed)
    );
    ok(
      "inbox list: no code invented from a truncated preview",
      listed.code === null,
      JSON.stringify(listed)
    );

    /* ---- dating a message when Gmail has stopped saying "x minutes ago" ---- */
    // A code that can't be dated is refused by the caller, so a bare clock
    // time in the header has to be enough. Built inside the page so the
    // browser's clock and timezone are the ones doing the arithmetic.
    const clockScan = async (minutesAgo, extra = "") => {
      const p = await newPage(browser);
      await p.setContent("<body></body>");
      await p.evaluate(
        ({ mins, extra }) => {
          const d = new Date(Date.now() - mins * 60000);
          const ampm = d.getHours() >= 12 ? "PM" : "AM";
          const h = d.getHours() % 12 || 12;
          const mm = String(d.getMinutes()).padStart(2, "0");
          document.body.innerText =
            `noreply.sdc@vitap.ac.in\n${h}:${mm} ${ampm}\nto me\n` +
            `${extra}Your One-Time Password\n\n915298\n`;
        },
        { mins: minutesAgo, extra }
      );
      await shim(p, {});
      await inject(p, ["js/otp/mail_scan.js"]);
      const out = await p.evaluate(
        () =>
          new Promise((resolve) => {
            const l = window.__listeners[window.__listeners.length - 1];
            l({ message: "vtopext_scan_otp", ignore: [] }, {}, resolve);
          })
      );
      await p.close();
      return out;
    };

    const fresh = await clockScan(1);
    ok(
      "a bare clock time dates a fresh message",
      fresh.code === "915298" && fresh.ageMin <= 2,
      JSON.stringify(fresh)
    );
    const old = await clockScan(90);
    ok(
      "a bare clock time dates an old message as old",
      old.ageMin >= 88 && old.ageMin <= 92,
      JSON.stringify(old)
    );
    const maybe = await clockScan(1, "This code may expire. Maybe check soon.\n");
    ok(
      "the word 'maybe' is not read as the month May",
      maybe.ageMin <= 2,
      JSON.stringify(maybe)
    );
    const dated = await scanFull(
      "noreply.sdc@vitap.ac.in\nAug 5, 2026\nto me\nYour One-Time Password\n\n233266\n"
    );
    ok(
      "a message headed by a DATE is old, never a live 3-minute code",
      dated.ageMin > 1000,
      JSON.stringify(dated)
    );

    /* ---- auto-open: click VTOP's row so its body renders ---- */
    // Gmail only puts a message body in the DOM once the mail is opened, so
    // the scanner opens it — but ONLY when the login page asks.
    const gmailRows =
      "<body><table>" +
      "<tr class='zA'><td>noreply.sdc</td>" +
      "<td class='xY'>VTOP Login OTP Needed - One-Time Password Request. Use the OTP below</td>" +
      "<td>1:04 AM</td></tr>" +
      "<tr class='zA'><td>VTAPP Convenor</td>" +
      "<td class='xY'>Call for V-TAPP T-Shirt Design</td><td>6:46 PM</td></tr>" +
      "</table></body>";

    const openRun = async (autoOpen) => {
      const p = await newPage(browser);
      await p.setContent(gmailRows);
      await shim(p, {});
      await p.evaluate(() => {
        window.__clicked = [];
        document.querySelectorAll("td").forEach((td) =>
          td.addEventListener("click", (e) =>
            window.__clicked.push(e.currentTarget.textContent.slice(0, 24))
          )
        );
      });
      await inject(p, ["js/otp/mail_scan.js"]);
      const out = await p.evaluate(
        (ao) =>
          new Promise((resolve) => {
            const l = window.__listeners[window.__listeners.length - 1];
            l({ message: "vtopext_scan_otp", ignore: [], autoOpen: ao }, {}, resolve);
          }),
        autoOpen
      );
      const clicked = await p.evaluate(() => window.__clicked);
      await p.close();
      return { out, clicked };
    };

    const opened = await openRun(true);
    ok(
      "auto-open clicks VTOP's row",
      opened.clicked.length === 1 && /VTOP Login OTP/.test(opened.clicked[0]),
      JSON.stringify(opened.clicked)
    );
    ok("auto-open reports back that it opened it", opened.out.opened === true, JSON.stringify(opened.out));
    ok(
      "the unrelated row is never clicked",
      !opened.clicked.some((c) => /T-Shirt/.test(c)),
      JSON.stringify(opened.clicked)
    );

    const untouched = await openRun(false);
    ok(
      "without autoOpen the scanner clicks nothing at all",
      untouched.clicked.length === 0 && untouched.out.opened === false,
      JSON.stringify(untouched)
    );
  }

  /* ============ login OTP: filling the VTOP login form ============ */
  console.log("\n=== login OTP autofill (VTOP login page) ===");
  {
    // Drives js/vtop_otp.js against a stand-in login form with the worker
    // stubbed out, so the field-detection and never-submit rules are pinned
    // even though the real page can only be exercised by hand.
    const LOGIN_NAMED = `<body><form id="lf">
      <input id="uname" maxlength="20">
      <input id="pwd" type="password" maxlength="20">
      <input id="captchaStr" maxlength="6">
      <input id="otpValue" maxlength="6">
      <button id="submitBtn" type="submit">Submit</button>
    </form></body>`;
    // same page, but nothing is called "otp" — forces the fallback heuristic
    const LOGIN_UNNAMED = LOGIN_NAMED.replace('id="otpValue"', 'id="authCode"');
    // VTOP's real OTP step: "Verify OTP" is a plain button, NOT type=submit,
    // so Enter in the field did nothing until findSubmit() learned to match
    // it by label.
    const LOGIN_VERIFY = `<body><form id="lf">
      <input id="otpValue" maxlength="6" placeholder="Enter OTP sent to your email">
      <button id="verifyBtn" type="button">Verify OTP</button>
    </form></body>`;

    const boot = async (html, reply, seed, wait) => {
      const p = await newPage(browser);
      await p.setContent(html);
      await shim(p, { storage: seed || {} });
      await p.evaluate((r) => {
        window.__asked = [];
        window.__submits = 0;
        window.__inputEvents = 0;
        document
          .getElementById("lf")
          .addEventListener("submit", (e) => {
            e.preventDefault();
            window.__submits++;
          });
        document.querySelectorAll("input").forEach((el) =>
          el.addEventListener("input", () => window.__inputEvents++)
        );
        window.chrome.runtime.sendMessage = (m, cb) => {
          window.__asked.push(m);
          if (m && m.message === "vtopext_get_otp") {
            cb(r);
            return;
          }
          if (cb) cb(undefined);
        };
      }, reply);
      await inject(p, ["js/vtop_otp.js"]);
      await delay(wait || 1500);
      return p;
    };

    {
      const p = await boot(LOGIN_NAMED, { code: "481920", ageMin: 0 });
      const s = await p.evaluate(() => ({
        otp: document.getElementById("otpValue").value,
        captcha: document.getElementById("captchaStr").value,
        user: document.getElementById("uname").value,
        submits: window.__submits,
        focused: document.activeElement && document.activeElement.id,
        inputs: window.__inputEvents,
        note: document.querySelector("#lf div span")
          ? document.querySelector("#lf div span").textContent
          : "",
        used: window.__storage["vtopext_otp_used"],
      }));
      ok("fills the named OTP field", s.otp === "481920", JSON.stringify(s));
      ok("leaves the captcha and username alone", s.captcha === "" && s.user === "", JSON.stringify(s));
      ok("NEVER submits the login form", s.submits === 0, `submits=${s.submits}`);
      ok("focuses Submit so the last press stays human", s.focused === "submitBtn", String(s.focused));
      ok("fires an input event VTOP's validators can see", s.inputs >= 1, String(s.inputs));
      ok("says what it filled", /Filled 481920/.test(s.note), s.note);
      ok("remembers the code as used", JSON.stringify(s.used) === '["481920"]', JSON.stringify(s.used));
      await p.close();
    }

    {
      const p = await boot(LOGIN_UNNAMED, { code: "550132", ageMin: 1 });
      const s = await p.evaluate(() => ({
        otp: document.getElementById("authCode").value,
        captcha: document.getElementById("captchaStr").value,
        pwd: document.getElementById("pwd").value,
      }));
      ok("finds the OTP box even when it isn't called 'otp'", s.otp === "550132", JSON.stringify(s));
      ok("fallback never picks the captcha or password box", s.captcha === "" && s.pwd === "", JSON.stringify(s));
      await p.close();
    }

    {
      // an expired code must NOT be typed: it would spend a login attempt on
      // a certain rejection, and VTOP locks accounts after enough of those
      const p = await boot(LOGIN_NAMED, { code: "915298", ageMin: 13, needsSignIn: true });
      const s = await p.evaluate(() => ({
        otp: document.getElementById("otpValue").value,
        note: document.querySelector("#lf div span").textContent,
        used: window.__storage["vtopext_otp_used"],
        signInShown: [...document.querySelectorAll("#lf div button")].some(
          (b) => b.textContent.includes("Sign in to Gmail") && !b.hidden
        ),
      }));
      ok("a 13-min-old code is NOT filled", s.otp === "", JSON.stringify(s));
      ok(
        "sign-in stays offered even when a (stale) code was found",
        s.signInShown === true,
        JSON.stringify(s)
      );
      ok("tells you to press Resend OTP", /expired.*Resend OTP/.test(s.note), s.note);
      ok("an unfilled code isn't burned as used", s.used === undefined, JSON.stringify(s.used));
      await p.close();
    }

    {
      const p = await boot(LOGIN_NAMED, { code: "363453", ageMin: 0 });
      const s = await p.evaluate(() => document.getElementById("otpValue").value);
      ok("a fresh code still fills", s === "363453", s);
      await p.close();
    }

    {
      // The boundary. Sources FLOOR the age — Gmail renders "3 minutes ago"
      // for anything from 3:00 to 3:59 — so age 3 is already past VTOP's
      // 3-minute window, while age 2 can still be as young as 2:00.
      const at2 = await boot(LOGIN_NAMED, { code: "111222", ageMin: 2 });
      const v2 = await at2.evaluate(() => document.getElementById("otpValue").value);
      ok("age 2 is still live and fills", v2 === "111222", v2);
      await at2.close();

      const at3 = await boot(LOGIN_NAMED, { code: "333444", ageMin: 3 }, {}, 5000);
      const s3 = await at3.evaluate(() => ({
        otp: document.getElementById("otpValue").value,
        note: document.querySelector("#lf div span").textContent,
      }));
      ok("age 3 is expired and is NOT filled", s3.otp === "", JSON.stringify(s3));
      ok(
        "and it promises to fill the resent one",
        /Resend OTP, I'll fill the new one/.test(s3.note),
        s3.note
      );
      await at3.close();
    }

    {
      // The watch has to outlast VTOP's ~180 s Resend cooldown, or it gives up
      // exactly when it is about to become useful. Checked by reading the
      // constant rather than waiting five minutes in a test.
      const src = read("js/vtop_otp.js");
      const giveUp = Number((src.match(/GIVE_UP_MS = (\d+)/) || [])[1]);
      ok("the watch outlasts the Resend cooldown", giveUp >= 240000, String(giveUp));
    }

    {
      // the real OTP page: Verify OTP must be focused so Enter submits
      const p = await boot(LOGIN_VERIFY, { code: "363453", ageMin: 0 });
      const s = await p.evaluate(() => ({
        otp: document.getElementById("otpValue").value,
        focused: document.activeElement && document.activeElement.id,
      }));
      ok("'Verify OTP' (not type=submit) is found and focused", s.focused === "verifyBtn", JSON.stringify(s));
      ok("code still fills on the real OTP markup", s.otp === "363453", JSON.stringify(s));
      await p.close();
    }

    {
      // An UNDATED code must not be filled. Twice on 2026-08-06 an undated
      // one turned out to be hours old, and a 3-minute code that can't be
      // dated is a coin flip that costs a login attempt when it loses.
      const p = await boot(LOGIN_NAMED, { code: "233266", ageMin: null }, {}, 5000);
      const s = await p.evaluate(() => ({
        otp: document.getElementById("otpValue").value,
        note: document.querySelector("#lf div span").textContent,
        used: window.__storage["vtopext_otp_used"],
      }));
      ok("an undated code is NOT filled", s.otp === "", JSON.stringify(s));
      ok("says why, and what to do about it", /undated code/.test(s.note), s.note);
      ok("an unfilled code isn't burned as used", s.used === undefined, JSON.stringify(s.used));
      await p.close();
    }

    {
      // signed into the personal account only: say so instead of counting up
      const p = await boot(LOGIN_NAMED, { code: null, sawVtop: false }, {}, 18000);
      const s = await p.evaluate(() => document.querySelector("#lf div span").textContent);
      ok("wrong Google account is named, not just 'waiting'", /student account/.test(s), s);
      await p.close();
    }

    {
      // VTOP's mail is in the tab but the code isn't rendered — the Gmail
      // inbox list. Rather than telling the user to go and click it, ask the
      // mail tab to open it. Requested ONCE per run, never repeatedly.
      const p = await boot(LOGIN_NAMED, { code: null, sawVtop: true }, {}, 8000);
      const s = await p.evaluate(() => ({
        opens: window.__asked.filter((m) => m.autoOpen === true).length,
        polls: window.__asked.length,
      }));
      ok("code not rendered → asks the mail tab to open it", s.opens === 1, JSON.stringify(s));
      ok("the open is requested once, not every poll", s.opens < s.polls, JSON.stringify(s));
      await p.close();
    }

    {
      // the mail tab reports it opened the message
      const p = await boot(LOGIN_NAMED, { code: null, sawVtop: true, opened: true }, {}, 6000);
      const s = await p.evaluate(() => document.querySelector("#lf div span").textContent);
      ok("says it opened the mail and is reading it", /Opened the OTP mail/.test(s), s);
      await p.close();
    }

    {
      // auto-open didn't take (Gmail markup moved): fall back to telling the
      // user, rather than sitting on "waiting" for the full 90 s
      const p = await boot(LOGIN_NAMED, { code: null, sawVtop: true, opened: false }, {}, 15000);
      const s = await p.evaluate(() => document.querySelector("#lf div span").textContent);
      ok("auto-open failed → asks the user to open it", /Open the newest/.test(s), s);
      await p.close();
    }

    {
      // Gmail tab open since before the extension reloaded: its content
      // script is orphaned and answers nothing. Blaming the Google account
      // there was a lie — and it must keep polling so an F5 fixes it live.
      const p = await boot(LOGIN_NAMED, { error: "mail-tab-stale" }, {}, 7000);
      const s = await p.evaluate(() => ({
        note: document.querySelector("#lf div span").textContent,
        polls: window.__asked.length,
      }));
      ok("stale mail tab → says to reload Gmail, not 'wrong account'", /Reload your Gmail tab/.test(s.note), s.note);
      ok("and keeps polling so F5 recovers it", s.polls > 1, JSON.stringify(s));
      await p.close();
    }

    {
      const p = await boot(LOGIN_NAMED, { error: "no-mail-tab" });
      const s = await p.evaluate(() => ({
        otp: document.getElementById("otpValue").value,
        note: document.querySelector("#lf div span").textContent,
        asks: window.__asked.length,
      }));
      ok("no webmail tab open → asks the user to open one", /Open your student mail/.test(s.note), s.note);
      ok("nothing typed into the form when there's no code", s.otp === "", s.otp);
      ok("stops asking instead of polling for 90 s", s.asks === 1, String(s.asks));
      await p.close();
    }

    {
      // a code filled earlier must not be auto-refilled from a stale mail...
      const p = await boot(LOGIN_NAMED, { code: null }, { vtopext_otp_used: ["111111"] });
      const auto = await p.evaluate(() => window.__asked[0].ignore);
      ok("automatic run skips codes already used", JSON.stringify(auto) === '["111111"]', JSON.stringify(auto));

      // ...and a manual click does NOT clear that list. An earlier version
      // did, on the theory that a failed captcha leaves the same OTP valid —
      // and that is exactly what put a long-dead code back in the box.
      await p.evaluate(() => {
        window.__asked = [];
        document.querySelector("#lf div button").click();
      });
      await delay(300);
      const manual = await p.evaluate(() => window.__asked[0].ignore);
      ok(
        "clicking the button still skips used codes",
        JSON.stringify(manual) === '["111111"]',
        JSON.stringify(manual)
      );
      await p.close();
    }

    {
      // 3 attempts at POLL_MS=3000 apart, so ~6 s of real time
      const p = await boot(LOGIN_NAMED, { error: "forbidden" }, {}, 8000);
      const s = await p.evaluate(() => ({
        note: document.querySelector("#lf div span").textContent,
        asks: window.__asked.length,
      }));
      ok("a broken worker is reported, not spun on", /Extension error/.test(s.note), s.note);
      ok("gives up after 3 tries, not 90 s", s.asks === 3, String(s.asks));
      await p.close();
    }

    {
      const p = await newPage(browser);
      await p.setContent(LOGIN_NAMED);
      await shim(p, {});
      await inject(p, ["js/vtop_otp.js"]);
      await delay(900);
      const kind = await p.evaluate(() => {
        const b = document.querySelector("#lf div button");
        return b ? b.type : null;
      });
      ok("its own button is type=button (can't submit the form)", kind === "button", String(kind));
      await p.close();
    }

    /* ---- the Gmail sign-in button is opt-in, and invisible without a client ---- */
    {
      // GMAIL_CLIENT_ID blank -> the worker never sets needsSignIn -> an
      // install that could never complete the flow is never offered it.
      const p = await boot(LOGIN_NAMED, { code: null, sawVtop: false }, {}, 5000);
      const shown = await p.evaluate(() =>
        [...document.querySelectorAll("#lf div button")].some(
          (b) => b.textContent.includes("Sign in to Gmail") && !b.hidden
        )
      );
      ok("no client id configured → no sign-in button at all", shown === false, String(shown));
      await p.close();
    }

    {
      const p = await newPage(browser);
      await p.setContent(LOGIN_NAMED);
      await shim(p, {});
      await p.evaluate(() => {
        window.__signins = 0;
        window.__signedIn = false;
        window.chrome.runtime.sendMessage = (m, cb) => {
          if (m.message === "vtopext_get_otp")
            return cb({ code: null, sawVtop: false, needsSignIn: !window.__signedIn });
          if (m.message === "vtopext_gmail_signin") {
            window.__signins++;
            window.__signedIn = true;
            return cb({ ok: true });
          }
          return cb(undefined);
        };
      });
      await inject(p, ["js/vtop_otp.js"]);
      await delay(1200);
      const offered = await p.evaluate(() =>
        [...document.querySelectorAll("#lf div button")].some(
          (b) => b.textContent.includes("Sign in to Gmail") && !b.hidden
        )
      );
      ok("client id configured + no consent yet → button offered", offered === true, String(offered));

      await p.evaluate(() =>
        [...document.querySelectorAll("#lf div button")]
          .find((b) => b.textContent.includes("Sign in to Gmail"))
          .click()
      );
      await delay(500);
      const after = await p.evaluate(() => ({
        signins: window.__signins,
        stillOffered: [...document.querySelectorAll("#lf div button")].some(
          (b) => b.textContent.includes("Sign in to Gmail") && !b.hidden
        ),
      }));
      ok("clicking it runs the consent flow once", after.signins === 1, JSON.stringify(after));
      ok("and it goes away once consent is granted", after.stillOffered === false, JSON.stringify(after));
      await p.close();
    }

  }

  /* ====== service worker: boots, and reads an OTP out of a Gmail body ====== */
  console.log("\n=== service worker: startup + Gmail-API OTP extraction ===");
  {
    // Boot background.js with ONLY the chrome namespaces manifest.json grants.
    // A worker that throws on startup answers no messages at all, which is
    // indistinguishable from a code bug from the content script's side — and
    // is exactly what had to be ruled out by hand on 2026-08-06.
    const manifest = JSON.parse(read("manifest.json"));
    const granted = new Set(manifest.permissions || []);
    const evt = () => ({ addListener: () => {}, removeListener: () => {} });
    const nsProxy = (seed = {}) =>
      new Proxy({ ...seed }, {
        get(t, k) {
          if (k in t) return t[k];
          if (typeof k === "string" && /^on[A-Z]/.test(k)) return (t[k] = evt());
          return (t[k] = (...a) => {
            const cb = a[a.length - 1];
            if (typeof cb === "function") return cb(undefined);
            return Promise.resolve(undefined);
          });
        },
      });

    const chromeStub = {
      runtime: nsProxy({ lastError: null, getManifest: () => manifest, id: "test" }),
    };
    if (manifest.action) chromeStub.action = nsProxy();
    for (const p of granted) {
      if (p === "storage") chromeStub.storage = { local: nsProxy(), session: nsProxy(), sync: nsProxy() };
      else chromeStub[p] = nsProxy();
    }
    const missing = [];
    const guarded = new Proxy(chromeStub, {
      get(t, k) {
        if (!(k in t) && typeof k === "string") { missing.push(k); return undefined; }
        return t[k];
      },
    });

    const ctx = vm.createContext({
      chrome: guarded, console, setTimeout, clearTimeout, setInterval, clearInterval,
      fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
      URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, atob, btoa,
    });
    ctx.self = ctx;
    ctx.globalThis = ctx;

    let booted = true;
    let bootError = "";
    try {
      vm.runInContext(read("service_worker/background.js"), ctx, { filename: "background.js" });
    } catch (e) {
      booted = false;
      bootError = `${e.constructor.name}: ${e.message}`;
    }
    ok("service worker boots with only its granted permissions", booted, bootError);
    ok(
      "no chrome namespace used that the manifest doesn't permit",
      missing.length === 0,
      [...new Set(missing)].join(", ")
    );

    const extract = ctx.__vtopextOtpFromMailText;
    if (typeof extract !== "function") {
      ok("worker exposes the Gmail OTP extractor", false, "missing");
    } else {
      // the real mail body, as the Gmail API hands it back
      const body =
        "🔐 VTOP Login Verification\nOne-Time Password Request\n\nDear VITian,\n" +
        "Use the OTP below to complete your login. This code is valid for a " +
        "limited time only.\n\nYour One-Time Password\n\n915298\n" +
        "⏱ Expires in 3 minutes\n\nRegards,\nVTOP Team\n" +
        "Copyright © 2026 Software Development Cell, VIT-AP University, " +
        "Andhra Pradesh-522241.";
      ok("reads the code from a Gmail message body", extract(body, []) === "915298", String(extract(body, [])));
      ok("skips a code already used", extract(body, ["915298"]) === null, String(extract(body, ["915298"])));
      ok(
        "the copyright year is not mistaken for a code",
        extract("Your OTP expired. Copyright © 2026 VIT-AP", []) === null,
        String(extract("Your OTP expired. Copyright © 2026 VIT-AP", []))
      );
      ok(
        "a 6-digit code beats other numbers in the same mail",
        extract("Reference 4471 — your one time password is 778812", []) === "778812",
        String(extract("Reference 4471 — your one time password is 778812", []))
      );
    }
  }

  console.log("\n=== service worker: vtopext_get_otp message handling ===");
  {
    // The startup test above proves background.js LOADS. This one drives the
    // message it exists to answer, because every bug found on 2026-08-06 lived
    // past startup: a `const` read one branch too early (a ReferenceError that
    // only fires when no mail tab is open), and a `return` that put the whole
    // Gmail-API route behind the mail tab it was written to make unnecessary.
    const manifest = JSON.parse(read("manifest.json"));

    // opts: { tabs, token, messages, sendMessage }
    const bootWorker = (opts = {}) => {
      const calls = { executeScript: [], sendMessage: [] };
      const listeners = [];
      const evt = () => ({ addListener: () => {}, removeListener: () => {} });
      const nsProxy = (seed = {}) =>
        new Proxy({ ...seed }, {
          get(t, k) {
            if (k in t) return t[k];
            if (typeof k === "string" && /^on[A-Z]/.test(k)) return (t[k] = evt());
            return (t[k] = (...a) => {
              const cb = a[a.length - 1];
              if (typeof cb === "function") return cb(undefined);
              return Promise.resolve(undefined);
            });
          },
        });

      const store = {};
      if (opts.token) store.vtopext_gmail_token = opts.token;

      const chromeStub = {
        runtime: nsProxy({
          lastError: null,
          id: "test",
          getManifest: () => manifest,
          onMessage: {
            addListener: (fn) => listeners.push(fn),
            removeListener: () => {},
          },
        }),
        storage: {
          local: nsProxy({
            get: (keys) => {
              const out = {};
              for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
              return Promise.resolve(out);
            },
            set: (obj) => (Object.assign(store, obj), Promise.resolve()),
            remove: (keys) => {
              for (const k of [].concat(keys)) delete store[k];
              return Promise.resolve();
            },
          }),
          session: nsProxy(),
          sync: nsProxy(),
        },
        tabs: nsProxy({
          query: () => Promise.resolve(opts.tabs || []),
          sendMessage: (tabId, msg) => {
            calls.sendMessage.push(tabId);
            return (opts.sendMessage || (() => Promise.reject(new Error("no receiver"))))(
              tabId,
              msg,
              calls
            );
          },
        }),
        scripting: nsProxy({
          executeScript: (arg) => {
            calls.executeScript.push(arg);
            return Promise.resolve([]);
          },
        }),
        identity: nsProxy({
          getRedirectURL: () => "https://ext.chromiumapp.org/",
          // no consent granted: the silent flow is what really happens here
          launchWebAuthFlow: () => Promise.reject(new Error("no consent")),
        }),
      };
      for (const p of manifest.permissions || []) {
        if (!chromeStub[p]) chromeStub[p] = nsProxy();
      }
      if (manifest.action) chromeStub.action = nsProxy();

      const ctx = vm.createContext({
        chrome: chromeStub,
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        fetch:
          opts.fetch ||
          (() =>
            Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })),
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        structuredClone,
        atob,
        btoa,
      });
      ctx.self = ctx;
      ctx.globalThis = ctx;
      vm.runInContext(read("service_worker/background.js"), ctx, {
        filename: "background.js",
      });

      const ask = (request) =>
        new Promise((resolve) => {
          let settled = false;
          const done = (r) => {
            if (settled) return;
            settled = true;
            resolve(r);
          };
          const sender = { url: "https://vtop.vitap.ac.in/vtop/login" };
          for (const fn of listeners) {
            try {
              fn(request, sender, done);
            } catch (e) {
              done({ error: `THREW ${e.constructor.name}: ${e.message}` });
            }
          }
          setTimeout(() => done({ error: "no response" }), 2000);
        });

      return { ask, calls, store };
    };

    // 1. No mail tab, no Gmail consent. The honest answer is "open your mail",
    //    plus the sign-in button that makes the tab unnecessary. Before the
    //    fix this branch read `needsSignIn` above its own `const` and the user
    //    was told "Extension error" instead.
    {
      const { ask } = bootWorker({ tabs: [] });
      const r = await ask({ message: "vtopext_get_otp", ignore: [] });
      ok(
        "no mail tab open → 'no-mail-tab', not a ReferenceError",
        r && r.error === "no-mail-tab",
        JSON.stringify(r)
      );
      ok(
        "and the sign-in escape hatch is offered there",
        !!(r && r.needsSignIn),
        JSON.stringify(r)
      );
    }

    // 2. Signed in to the Gmail API, no mail sent yet, and no mail tab open at
    //    all. That combination has to keep the caller polling: the API route
    //    does not need a tab, so reporting "no-mail-tab" would kill the watch
    //    of the one user for whom everything is set up correctly.
    {
      const { ask } = bootWorker({
        tabs: [],
        token: { token: "live", exp: Date.now() + 3600000 },
        fetch: () =>
          Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
      });
      const r = await ask({ message: "vtopext_get_otp", ignore: [] });
      ok(
        "signed in + no mail yet → keeps polling, no error",
        !!r && !r.error && r.code === null,
        JSON.stringify(r)
      );
    }

    // 3. A mail tab whose content script was orphaned by an extension reload.
    //    It answers nothing on the first ask; the scanner is injected and the
    //    second ask succeeds — no "press F5 over there" for the user to miss.
    {
      let asked = 0;
      const { ask, calls } = bootWorker({
        tabs: [{ id: 7, url: "https://mail.google.com/mail/u/0/#inbox" }],
        sendMessage: () => {
          asked += 1;
          if (asked === 1) return Promise.reject(new Error("Receiving end does not exist"));
          return Promise.resolve({ code: "424242", ageMin: 1, sawVtop: true, host: "mail.google.com" });
        },
      });
      const r = await ask({ message: "vtopext_get_otp", ignore: [] });
      ok(
        "orphaned mail tab is re-injected instead of being called stale",
        calls.executeScript.length === 1,
        JSON.stringify(calls.executeScript)
      );
      ok(
        "and the code comes back on the retry — 424242",
        !!r && r.code === "424242",
        JSON.stringify(r)
      );
      ok(
        "the file injected is the scanner itself",
        calls.executeScript[0] &&
          (calls.executeScript[0].files || []).includes("js/otp/mail_scan.js"),
        JSON.stringify(calls.executeScript[0])
      );
    }

    // 4. A tab that cannot be reached even after injection is still reported
    //    as stale rather than silently swallowed.
    {
      const { ask } = bootWorker({
        tabs: [{ id: 9, url: "https://mail.google.com/mail/u/0/#inbox" }],
        sendMessage: () => Promise.reject(new Error("Receiving end does not exist")),
      });
      const r = await ask({ message: "vtopext_get_otp", ignore: [] });
      ok(
        "unreachable mail tab still reports 'mail-tab-stale'",
        !!r && r.error === "mail-tab-stale",
        JSON.stringify(r)
      );
    }

    // 5. The sender check still holds: only a VTOP page may trigger a mail read.
    {
      const { ask } = bootWorker({ tabs: [] });
      const r = await new Promise((resolve) => {
        const listenersRan = ask({ message: "vtopext_get_otp", ignore: [] });
        resolve(listenersRan);
      });
      ok("a VTOP sender is accepted", !!r && r.error !== "forbidden", JSON.stringify(r));
    }
  }

  /* ====== Google Calendar import: finding Save, and letting the user press it ====== */
  console.log("\n=== timetable → Google Calendar: the Save button, and pacing ===");
  {
    // Reported symptom: "the calendar is reloaded with each subject before we
    // can see it and click Add, so it doesn't work." Two causes.
    const swSrc = read("service_worker/background.js");
    const at = swSrc.indexOf("const gcalClickSave");
    const clickSaveSrc = swSrc.slice(at, swSrc.indexOf("\n};", at) + 3);

    // Cause 1: Google Calendar's Save is a <div role="button">, not a <button>.
    // The old search was querySelectorAll("button"), so it found nothing on a
    // perfectly ordinary editor and reported "no-button" for every class.
    {
      const page = await newPage(browser);
      // Modelled on the LIVE editor (checked 2026-08-09): Save is a real
      // <button aria-label="Save">, and Google tears the editor down once the
      // event is written. The div[role=button] beside it is the defensive case.
      await page.setContent(`<body>
        <button aria-label="Save" id="save">Save</button>
        <div role="button" aria-label="Close">Close</div>
        <span>Saved</span>
      </body>`);
      const out = await page.evaluate(
        `(async () => {
           ${clickSaveSrc}
           window.__clicked = null;
           document.getElementById("save").addEventListener("click", () => {
             window.__clicked = "save";
             document.getElementById("save").remove(); // Google closes the editor
           });
           const r = await gcalClickSave();
           return { r, clicked: window.__clicked };
         })()`
      );
      ok(
        "Save is clicked, and 'saved' waits for the editor to actually close",
        out.r === "saved" && out.clicked === "save",
        JSON.stringify(out)
      );

      // The failure that matters: the click lands but the editor never goes
      // away. Reporting "saved" there would be a lie, and the worker would
      // close the tab on a write that never happened.
      await page.setContent(`<body><button aria-label="Save" id="s">Save</button></body>`);
      const stuck = await page.evaluate(
        `(async () => { ${clickSaveSrc} return await gcalClickSave(); })()`
      );
      ok(
        "a Save that changes nothing reports 'stuck', never 'saved'",
        stuck === "stuck",
        String(stuck)
      );

      await page.setContent(`<body><span>Saved</span><div role="button">Cancel</div></body>`);
      const none = await page.evaluate(
        `(async () => { ${clickSaveSrc} return await gcalClickSave(); })()`
      );
      ok(
        "a page with no Save still reports no-button ('Saved' is not a control)",
        none === "no-button",
        String(none)
      );
      await page.close();
    }

    // Cause 2: when it cannot press Save, the import used to open, fail and
    // close three tabs in a row — fast enough that nobody could reach for Save
    // by hand. A "no-button" is structural: it will fail identically on all 40
    // classes, so it must stop after ONE.
    const manifest = JSON.parse(read("manifest.json"));
    const bootGcal = (opts = {}) => {
      const listeners = [];
      const created = [];
      const removed = [];
      const tabs = new Map();
      // Whether the prefilled editor is still on screen in that tab. This, not
      // the URL, is what the worker now asks about: the 2026 Calendar UI opens
      // a TEMPLATE as an overlay on /calendar/u/0/r and never puts "eventedit"
      // in the address bar, so the URL is byte-identical before and after a
      // save. Reading it was why every event was declared saved instantly.
      const editors = new Map();
      let nextId = 100;
      const evt = () => ({ addListener: () => {}, removeListener: () => {} });
      const nsProxy = (seed = {}) =>
        new Proxy({ ...seed }, {
          get(t, k) {
            if (k in t) return t[k];
            if (typeof k === "string" && /^on[A-Z]/.test(k)) return (t[k] = evt());
            return (t[k] = (...a) => {
              const cb = a[a.length - 1];
              if (typeof cb === "function") return cb(undefined);
              return Promise.resolve(undefined);
            });
          },
        });
      const chromeStub = {
        runtime: nsProxy({
          lastError: null,
          id: "test",
          getManifest: () => manifest,
          onMessage: { addListener: (fn) => listeners.push(fn), removeListener: () => {} },
        }),
        storage: { local: nsProxy(), session: nsProxy(), sync: nsProxy() },
        tabs: nsProxy({
          create: ({ url, active }) => {
            const id = nextId++;
            created.push({ id, url, active });
            // live shape: the TEMPLATE link redirects into /eventedit, and
            // leaves it again once Google has written the event
            tabs.set(id, {
              id,
              status: "complete",
              url: "https://calendar.google.com/calendar/u/0/r/eventedit?text=x",
            });
            editors.set(id, true);
            if (opts.onCreate) opts.onCreate(created.length - 1, id, { tabs, editors });
            return Promise.resolve({ id });
          },
          // callback form (waitTabComplete) and promise form (waitGcalSaved)
          get: (id, cb) => {
            const t = tabs.get(id);
            if (cb) {
              cb(t);
              return undefined;
            }
            return t ? Promise.resolve(t) : Promise.reject(new Error("No tab with id"));
          },
          remove: (id) => (removed.push(id), tabs.delete(id), Promise.resolve()),
          sendMessage: () => Promise.resolve(),
        }),
        scripting: nsProxy({
          executeScript: ({ target, func }) =>
            Promise.resolve([
              {
                result:
                  func && func.name === "gcalEditorOpen"
                    ? !!editors.get(target.tabId)
                    : opts.saveResult || "no-button",
              },
            ]),
        }),
      };
      for (const p of manifest.permissions || []) if (!chromeStub[p]) chromeStub[p] = nsProxy();
      if (manifest.action) chromeStub.action = nsProxy();
      const ctx = vm.createContext({
        chrome: chromeStub, console, setTimeout, clearTimeout, setInterval, clearInterval,
        fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
        URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, atob, btoa,
      });
      ctx.self = ctx;
      ctx.globalThis = ctx;
      vm.runInContext(swSrc, ctx, { filename: "background.js" });
      const ask = (request) =>
        new Promise((resolve) => {
          let settled = false;
          const done = (r) => { if (!settled) { settled = true; resolve(r); } };
          const sender = { tab: { id: 1 }, url: "https://vtop.vitap.ac.in/vtop/content" };
          for (const fn of listeners) { try { fn(request, sender, done); } catch (e) { done({ error: String(e) }); } }
          setTimeout(() => done({ error: "no response" }), 25000);
        });
      return { ask, created, removed, tabs };
    };

    {
      const urls = ["u1", "u2", "u3", "u4", "u5"].map(
        (u) => `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${u}`
      );
      const { ask, created } = bootGcal({ saveResult: "no-button" });
      const r = await ask({ message: "gcal_template_import", urls });
      ok(
        "an unpressable Save stops after ONE tab, not a strobe of them",
        created.length === 1 && r && r.saved === 0 && r.lastError === "no-button",
        JSON.stringify({ tabs: created.length, r })
      );
    }

    // The guided path: one FOREGROUND tab at a time, and the next does not open
    // until this one is saved. This is the answer to "we can't see it and click
    // Add" — the pacing belongs to the student, not to a timer.
    {
      const urls = ["a", "b", "c"].map(
        (u) => `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${u}`
      );
      const { ask, created, removed } = bootGcal({
        // the student presses Save: the overlay closes, URL unchanged
        onCreate: (_i, id, { tabs, editors }) =>
          setTimeout(() => {
            editors.set(id, false);
            const t = tabs.get(id);
            if (t) t.url = "https://calendar.google.com/calendar/u/0/r/week";
          }, 100),
      });
      const r = await ask({ message: "gcal_guided_import", urls });
      ok(
        "guided import saves each event the student presses Save on",
        r && r.saved === 3 && r.total === 3 && !r.stopped,
        JSON.stringify(r)
      );
      ok(
        "and every tab is opened in the foreground, one at a time, then closed",
        created.length === 3 && created.every((c) => c.active === true) && removed.length === 3,
        JSON.stringify({ created, removed })
      );
    }

    // Closing the tab is how you cancel. Opening more tabs at someone who is
    // closing them is the exact behaviour being fixed here.
    {
      const urls = ["a", "b", "c"].map(
        (u) => `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${u}`
      );
      const { ask, created } = bootGcal({
        onCreate: (i, id, { tabs, editors }) =>
          setTimeout(() => {
            if (i === 1) {
              tabs.delete(id); // student closes the second one
              return;
            }
            editors.set(id, false); // saved
            const t = tabs.get(id);
            if (t) t.url = "https://calendar.google.com/calendar/u/0/r/week";
          }, 100),
      });
      const r = await ask({ message: "gcal_guided_import", urls });
      ok(
        "closing the tab stops the run and reports what was already saved",
        r && r.saved === 1 && r.stopped === "closed" && created.length === 2,
        JSON.stringify({ r, tabs: created.length })
      );
    }
  }

  /* ====== Google Calendar: the token that makes "push all" possible ====== */
  console.log("\n=== Google Calendar token: launchWebAuthFlow, not the dead client ===");
  {
    // The whole reason the timetable import degrades to pressing Save once per
    // class is that its only token route was getAuthToken on
    // manifest.oauth2.client_id — upstream's dead client. The Gmail OTP feature
    // already proved the working shape (a Web-application client + a
    // chromiumapp.org redirect via launchWebAuthFlow); this wires Calendar to
    // the same one, so every existing API path starts working untouched.
    const manifest = JSON.parse(read("manifest.json"));
    const swSrc = read("service_worker/background.js");

    const bootAuth = (opts = {}) => {
      const listeners = [];
      const store = { ...(opts.store || {}) };
      const calls = { webAuth: [], webAuthFlows: [], getAuthToken: 0 };
      const evt = () => ({ addListener: () => {}, removeListener: () => {} });
      const nsProxy = (seed = {}) =>
        new Proxy({ ...seed }, {
          get(t, k) {
            if (k in t) return t[k];
            if (typeof k === "string" && /^on[A-Z]/.test(k)) return (t[k] = evt());
            return (t[k] = (...a) => {
              const cb = a[a.length - 1];
              if (typeof cb === "function") return cb(undefined);
              return Promise.resolve(undefined);
            });
          },
        });
      const chromeStub = {
        runtime: nsProxy({
          lastError: null,
          id: "test",
          getManifest: () => manifest,
          getURL: (p) => "chrome-extension://test/" + p,
          onMessage: { addListener: (fn) => listeners.push(fn), removeListener: () => {} },
        }),
        storage: {
          local: nsProxy({
            get: (keys) => {
              const out = {};
              for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
              return Promise.resolve(out);
            },
            set: (obj) => (Object.assign(store, obj), Promise.resolve()),
            remove: (keys) => {
              for (const k of [].concat(keys)) delete store[k];
              return Promise.resolve();
            },
          }),
          session: nsProxy(),
          sync: nsProxy({ set: () => Promise.resolve() }),
        },
        tabs: nsProxy(),
        scripting: nsProxy(),
        identity: nsProxy({
          getRedirectURL: () => "https://test-ext-id.chromiumapp.org/",
          // `details` is recorded whole, not just the URL: whether a VISIBLE
          // WINDOW opened is `details.interactive`, and that — not the query
          // string — is the thing a student experiences as "it asked me again".
          launchWebAuthFlow: (details) => {
            const url = details.url;
            calls.webAuth.push(url);
            calls.webAuthFlows.push({
              url,
              interactive: !!details.interactive,
              abortOnLoadForNonInteractive: details.abortOnLoadForNonInteractive,
              timeoutMsForNonInteractive: details.timeoutMsForNonInteractive,
            });
            return opts.webAuth
              ? opts.webAuth(url, details)
              : Promise.resolve(
                  "https://test-ext-id.chromiumapp.org/#access_token=CAL-TOKEN&expires_in=3600"
                );
          },
          getAuthToken: (o, cb) => {
            calls.getAuthToken += 1;
            cb(opts.legacyToken || undefined);
          },
          removeCachedAuthToken: (o, cb) => cb && cb(),
        }),
      };
      // alarms and notifications are captured so a test can fire an alarm and
      // see what the worker did about it
      const alarmListeners = [];
      const alarmsLive = {};
      const notes = [];
      chromeStub.alarms = nsProxy({
        create: (name, info) => { alarmsLive[name] = info; return Promise.resolve(); },
        getAll: () => Promise.resolve(Object.keys(alarmsLive).map((name) => ({ name, ...alarmsLive[name] }))),
        clear: (name) => { delete alarmsLive[name]; return Promise.resolve(true); },
        get: (name) => Promise.resolve(alarmsLive[name] ? { name } : undefined),
        onAlarm: { addListener: (fn) => alarmListeners.push(fn), removeListener: () => {} },
      });
      chromeStub.notifications = nsProxy({
        create: (id, o) => { notes.push({ id, ...o }); return Promise.resolve(id); },
      });
      const fireAlarm = async (name) => { for (const fn of alarmListeners) await fn({ name }); };
      for (const p of manifest.permissions || []) if (!chromeStub[p]) chromeStub[p] = nsProxy();
      if (manifest.action) chromeStub.action = nsProxy();
      const ctx = vm.createContext({
        chrome: chromeStub, console, setTimeout, clearTimeout, setInterval, clearInterval,
        fetch: opts.fetch ||
          (() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })),
        URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, atob, btoa,
      });
      ctx.self = ctx;
      ctx.globalThis = ctx;
      // opts.noClient blanks the pasted constant, so the "not configured yet"
      // guarantee stays testable now that the shipped build HAS an id in it
      const src = opts.noClient
        ? swSrc.replace(/const CALENDAR_CLIENT_ID = .*;/, 'const CALENDAR_CLIENT_ID = "";')
        : swSrc;
      vm.runInContext(src, ctx, { filename: "background.js" });
      const ask = (request) =>
        new Promise((resolve) => {
          let settled = false;
          const done = (r) => { if (!settled) { settled = true; resolve(r); } };
          const sender = { tab: { id: 1 }, url: "https://vtop.vitap.ac.in/vtop/content" };
          for (const fn of listeners) { try { fn(request, sender, done); } catch (e) { done({ error: String(e) }); } }
          setTimeout(() => done({ error: "no response" }), 8000);
        });
      return { ask, calls, store, alarmsLive, notes, fireAlarm };
    };

    // The shipped build is configured — this is the line that decides whether
    // a student presses Save forty times or clicks once, so it gets an
    // assertion rather than a comment.
    ok(
      "the build ships a Calendar client id (Calendar API path is live)",
      /const CALENDAR_CLIENT_ID = (?!"")\S/.test(swSrc),
      (swSrc.match(/const CALENDAR_CLIENT_ID = .*/) || ["missing"])[0]
    );

    // Unconfigured: say so, and do not fall back to manifest.oauth2.client_id.
    // That is upstream's client and it is dead for every user of this build, so
    // the only thing the old fallback ever produced was a "bad client id"
    // error — which the buttons then rendered as "this build's OAuth client id
    // is dead", making a WORKING sign-in look permanently broken to anyone
    // running a stale copy. Verified live 2026-08-16: client 256000685922-…
    // issues real calendar.events tokens on the chromiumapp redirect.
    {
      const { ask, calls } = bootAuth({ noClient: true });
      const r = await ask({ message: "get_google_token" });
      ok(
        "with no Calendar client id, the dead legacy route is NOT used",
        calls.getAuthToken === 0 && calls.webAuth.length === 0 && r && r.token === null,
        JSON.stringify({ calls, r })
      );
      ok(
        "and it reports 'not configured' rather than a dead client id",
        r && r.error === "not_configured",
        JSON.stringify(r)
      );
    }

    // Configured: a real token, from our own client, for every caller at once.
    {
      const { ask, calls, store } = bootAuth({
        store: { vtopext_calendar_client_id: "999-cal.apps.googleusercontent.com" },
        // userinfo.email rides along in the merged grant purely so the worker
        // can learn WHICH account approved it — that address is what makes
        // every later refresh silent, so the mock has to answer it.
        fetch: (url) =>
          /oauth2\/v3\/userinfo/.test(url)
            ? Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ email: "student@vitapstudent.ac.in" }),
              })
            : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
      });
      const r = await ask({ message: "get_google_token", interactive: true });
      const url = calls.webAuth[0] || "";
      ok(
        "a Calendar client id switches the token route to launchWebAuthFlow",
        r && r.token === "CAL-TOKEN" && calls.getAuthToken === 0,
        JSON.stringify({ r, legacyCalls: calls.getAuthToken })
      );
      ok(
        "and it asks for calendar.events against OUR client, on the chromiumapp redirect",
        url.includes("client_id=999-cal.apps.googleusercontent.com") &&
          url.includes(encodeURIComponent("https://www.googleapis.com/auth/calendar.events")) &&
          url.includes(encodeURIComponent("https://test-ext-id.chromiumapp.org/")),
        url
      );
      ok(
        "the token is cached with an expiry, so the next click is silent",
        !!store.vtopext_google_app_token &&
          store.vtopext_google_app_token.token === "CAL-TOKEN" &&
          store.vtopext_google_app_token.exp > Date.now(),
        JSON.stringify(store.vtopext_google_app_token)
      );

      /*
       * The three causes of "it asks me OAuth every time", asserted directly.
       * Each one was a single parameter, and each one on its own was enough to
       * put a consent screen in front of every click.
       */
      ok(
        "the consent screen is NOT forced on every click (no prompt=consent)",
        !/[?&]prompt=[^&]*consent/.test(url),
        url
      );
      ok(
        "one grant covers Calendar AND mail, so there is one consent, not three",
        url.includes(encodeURIComponent("https://www.googleapis.com/auth/gmail.send")) &&
          url.includes(encodeURIComponent("https://www.googleapis.com/auth/userinfo.email")),
        url
      );
      ok(
        "an existing narrower grant is kept (include_granted_scopes)",
        /include_granted_scopes=true/.test(url),
        url
      );
      ok(
        "the account that consented is remembered, so refreshes can be silent",
        store.vtopext_google_account === "student@vitapstudent.ac.in",
        JSON.stringify(store.vtopext_google_account)
      );
    }

    /*
     * The silent refresh, which is what actually runs on click 2..n.
     *
     * `prompt=none` cannot pick between the several Google accounts signed
     * into a profile, so without login_hint it fails EVERY time and falls
     * through to an interactive flow — an hourly consent screen that looks,
     * from the outside, exactly like consent never being remembered.
     */
    {
      const { ask, calls } = bootAuth({
        store: {
          vtopext_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vtopext_google_account: "student@vitapstudent.ac.in",
        },
      });
      await ask({ message: "get_google_token" });
      const url = calls.webAuth[0] || "";
      ok(
        "a silent refresh names the account, so prompt=none can resolve it",
        /[?&]prompt=none/.test(url) &&
          url.includes("login_hint=" + encodeURIComponent("student@vitapstudent.ac.in")),
        url
      );
    }

    /*
     * A BUTTON CLICK MUST TRY THE SILENT FLOW BEFORE IT OPENS A WINDOW.
     *
     * This is cause (4) in background.js, and it is the one that survived the
     * first round of fixes: the old code went straight to
     * `launchWebAuthFlow({interactive: true})` on every cache miss. Whether
     * Google then had anything to ask was beside the point — the window is
     * what the student sees, and it appeared roughly hourly, which is exactly
     * the complaint ("the oauth should persist").
     *
     * So the assertion is about `details.interactive`, not the query string. A
     * click that ends in a live token must not have opened a window at all.
     */
    {
      const { ask, calls } = bootAuth({
        store: {
          vtopext_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vtopext_google_account: "student@vitapstudent.ac.in",
        },
      });
      const r = await ask({ message: "get_google_token", interactive: true });
      const first = calls.webAuthFlows[0] || {};
      ok(
        "an interactive click tries prompt=none FIRST, with the known account",
        first.interactive === false &&
          /[?&]prompt=none/.test(first.url || "") &&
          String(first.url).includes("login_hint=" + encodeURIComponent("student@vitapstudent.ac.in")),
        JSON.stringify(first)
      );
      ok(
        "and when that works, no consent window is ever opened",
        r && r.token === "CAL-TOKEN" && calls.webAuthFlows.every((f) => !f.interactive),
        JSON.stringify({ token: r && r.token, flows: calls.webAuthFlows.map((f) => f.interactive) })
      );
      /*
       * Cause (5): Chrome kills a non-interactive flow at the first completed
       * navigation unless told not to. accounts.google.com answers prompt=none
       * with a page load THEN a redirect, so the default aborted a flow that
       * was about to succeed — and the abort is indistinguishable from "never
       * consented", which sent every refresh to the interactive path.
       */
      ok(
        "the silent flow is not aborted at the first page load",
        first.abortOnLoadForNonInteractive === false &&
          typeof first.timeoutMsForNonInteractive === "number" &&
          first.timeoutMsForNonInteractive > 0,
        JSON.stringify(first)
      );
    }

    // Only when the silent attempt genuinely fails does a window open — and
    // then with no `prompt`, so a student who has already chosen an account is
    // not shown the chooser a second time.
    {
      let n = 0;
      const { ask, calls } = bootAuth({
        store: {
          vtopext_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vtopext_google_account: "student@vitapstudent.ac.in",
        },
        webAuth: (url, details) =>
          details.interactive
            ? Promise.resolve(
                `https://test-ext-id.chromiumapp.org/#access_token=LOUD${++n}&expires_in=3600`
              )
            : Promise.reject(new Error("User interaction required.")),
      });
      const r = await ask({ message: "get_google_token", interactive: true });
      const loud = calls.webAuthFlows.filter((f) => f.interactive);
      ok(
        "a failed silent refresh falls back to exactly one window",
        r && r.token === "LOUD1" && loud.length === 1,
        JSON.stringify({ token: r && r.token, flows: calls.webAuthFlows.length })
      );
      ok(
        "and that window carries no prompt, so the account chooser stays away",
        !/[?&]prompt=/.test(loud[0].url) && loud[0].url.includes("login_hint="),
        loud[0].url
      );
    }

    // First run ever — nobody has chosen an account, so the chooser IS right.
    {
      const { ask, calls } = bootAuth({
        store: { vtopext_calendar_client_id: "999-cal.apps.googleusercontent.com" },
        webAuth: (url, details) =>
          details.interactive
            ? Promise.resolve(
                "https://test-ext-id.chromiumapp.org/#access_token=CAL-TOKEN&expires_in=3600"
              )
            : Promise.reject(new Error("User interaction required.")),
      });
      await ask({ message: "get_google_token", interactive: true });
      const loud = calls.webAuthFlows.filter((f) => f.interactive)[0] || {};
      ok(
        "with no account on record the first window does ask which one",
        /[?&]prompt=select_account/.test(loud.url || ""),
        loud.url || "no interactive flow"
      );
    }

    // …and never again. Once a grant exists, the chooser is suppressed even if
    // the remembered address is lost, because re-showing it to someone who has
    // already picked is the behaviour being complained about.
    {
      const { ask, calls } = bootAuth({
        store: {
          vtopext_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vtopext_google_granted: true,
        },
        webAuth: (url, details) =>
          details.interactive
            ? Promise.resolve(
                "https://test-ext-id.chromiumapp.org/#access_token=CAL-TOKEN&expires_in=3600"
              )
            : Promise.reject(new Error("User interaction required.")),
      });
      await ask({ message: "get_google_token", interactive: true });
      const loud = calls.webAuthFlows.filter((f) => f.interactive)[0] || {};
      ok(
        "a grant already on record suppresses the account chooser",
        !/[?&]prompt=/.test(loud.url || ""),
        loud.url || "no interactive flow"
      );
    }

    /*
     * The OTP scanner is a DIFFERENT account question — reported 2026-08-19 as
     * "got asked again", with the chooser on screen and the VTOP OTP page
     * behind it. It reads a mailbox with gmail.readonly, and the mailbox VTOP
     * writes to is not the account the calendar/mail grant runs under. So the
     * app account must not leak into it, and the app grant must not suppress
     * the one chooser that is genuinely needed.
     */
    {
      const gmailFetch = (url) =>
        /gmail\/v1\/users\/me\/profile/.test(url)
          ? Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ emailAddress: "student@vitapstudent.ac.in" }),
            })
          : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });

      const { ask, calls, store } = bootAuth({
        store: {
          vtopext_gmail_client_id: "999-gmail.apps.googleusercontent.com",
          // everything the app flow leaves behind after a successful sign-in
          vtopext_google_account: "personal@gmail.com",
          vtopext_google_granted: true,
        },
        fetch: gmailFetch,
        webAuth: (url, details) =>
          details.interactive
            ? Promise.resolve(
                "https://test-ext-id.chromiumapp.org/#access_token=GMAIL-TOKEN&expires_in=3600"
              )
            : Promise.reject(new Error("User interaction required.")),
      });
      const r = await ask({ message: "vtopext_gmail_signin" });
      const loud = calls.webAuthFlows.filter((f) => f.interactive)[0] || {};
      ok(
        "the mailbox flow never names the app account (that scans the wrong inbox)",
        r && r.ok === true && !/login_hint=/.test(loud.url || ""),
        loud.url || "no interactive flow"
      );
      ok(
        "and an app grant does NOT suppress the chooser — only this pick names the inbox",
        /[?&]prompt=select_account/.test(loud.url || ""),
        loud.url || "no interactive flow"
      );
      ok(
        "the chosen mailbox is learned from Gmail itself, per flow, without widening the scope",
        (store.vtopext_google_accounts || {}).vtopext_gmail_token ===
          "student@vitapstudent.ac.in" &&
          !/userinfo\.email/.test(loud.url || ""),
        JSON.stringify(store.vtopext_google_accounts)
      );
      ok(
        "and learning it leaves the app account alone",
        store.vtopext_google_account === "personal@gmail.com",
        JSON.stringify(store.vtopext_google_account)
      );
    }

    // Second scan, an hour later with the token expired: this is the click the
    // student kept being asked about, and it must be silent now.
    {
      const { ask, calls } = bootAuth({
        store: {
          vtopext_gmail_client_id: "999-gmail.apps.googleusercontent.com",
          vtopext_google_granted: true,
          vtopext_google_accounts: { vtopext_gmail_token: "student@vitapstudent.ac.in" },
        },
        webAuth: () =>
          Promise.resolve(
            "https://test-ext-id.chromiumapp.org/#access_token=GMAIL-TOKEN&expires_in=3600"
          ),
      });
      await ask({ message: "vtopext_gmail_signin" });
      const first = calls.webAuthFlows[0] || {};
      ok(
        "a remembered mailbox makes the next scan silent, naming that mailbox",
        first.interactive === false &&
          /[?&]prompt=none/.test(first.url || "") &&
          String(first.url).includes(
            "login_hint=" + encodeURIComponent("student@vitapstudent.ac.in")
          ),
        JSON.stringify(first)
      );
      ok(
        "and no window opens at all once it succeeds",
        !calls.webAuthFlows.some((f) => f.interactive),
        JSON.stringify(calls.webAuthFlows.map((f) => f.interactive))
      );
    }

    // Signing out has to put both back, or the student cannot switch account.
    {
      const { ask, store } = bootAuth({
        store: {
          vtopext_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vtopext_google_account: "student@vitapstudent.ac.in",
          vtopext_google_accounts: { vtopext_gmail_token: "student@vitapstudent.ac.in" },
          vtopext_google_granted: true,
          vtopext_google_app_token: { token: "OLD", exp: Date.now() + 3600000 },
        },
      });
      await ask({ message: "google_sign_out" });
      ok(
        "sign-out forgets the token, the account AND the grant flag",
        !store.vtopext_google_app_token &&
          !store.vtopext_google_account &&
          !store.vtopext_google_granted,
        JSON.stringify(Object.keys(store))
      );
      ok(
        "…including the per-flow mailbox, or the next student lands in this one's inbox",
        !store.vtopext_google_accounts ||
          !store.vtopext_google_accounts.vtopext_gmail_token,
        JSON.stringify(store.vtopext_google_accounts)
      );
    }

    // The failure this setup actually produces: consent refused because
    // calendar.events was never added to the consent screen, or the Calendar
    // API is not enabled on the project. Reporting that as "you closed the
    // window" sends someone hunting through Chrome instead of Cloud Console.
    {
      const { ask } = bootAuth({
        store: { vtopext_calendar_client_id: "999-cal.apps.googleusercontent.com" },
        webAuth: () =>
          Promise.resolve(
            "https://test-ext-id.chromiumapp.org/#error=invalid_scope&error_description=Some+requested+scopes+were+invalid"
          ),
      });
      const r = await ask({ message: "get_google_token", interactive: true });
      ok(
        "a refused scope is reported in Google's own words, not as a closed window",
        r && r.token === null && /invalid|scope/i.test(r.error || ""),
        JSON.stringify(r)
      );
    }

    // A 401 mid-import must not be answered with the same dead token forever.
    {
      let issued = 0;
      const { ask } = bootAuth({
        store: {
          vtopext_calendar_client_id: "999-cal.apps.googleusercontent.com",
          // the merged grant's key — Calendar and mail share one token now
          vtopext_google_app_token: { token: "OLD", exp: Date.now() + 3600000 },
        },
        webAuth: () =>
          Promise.resolve(
            `https://test-ext-id.chromiumapp.org/#access_token=FRESH${++issued}&expires_in=3600`
          ),
      });
      const cached = await ask({ message: "get_google_token" });
      const fresh = await ask({ message: "get_google_token", stale: "OLD", interactive: true });
      ok(
        "a cached token is reused, and `stale` forces a fresh one",
        cached && cached.token === "OLD" && fresh && fresh.token === "FRESH1",
        JSON.stringify({ cached: cached && cached.token, fresh: fresh && fresh.token })
      );
    }

    /* ---- direct email: a real message, not a calendar entry that mails later --- */
    console.log("\n=== send_mail: a real email through the student's own Gmail ===");
    const mailBoot = (o = {}) => {
      const seen = { auth: [], sends: [] };
      const { ask, store } = bootAuth({
        /*
         * Relay explicitly OFF. Since 2026-08-22 a real relay URL ships in
         * MAIL_RELAY_URL, so relay mode is the default and these tests — which
         * exist to prove the student's-own-Gmail path — would otherwise never
         * reach it. "off" is the sentinel that says "declined", as distinct
         * from "nobody configured one"; the relay-mode test below opts back in
         * by storing a URL.
         */
        store: {
          vtopext_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vtopext_mail_relay_url: "off",
          ...(o.store || {}),
        },
        webAuth: (url) => {
          seen.auth.push(url);
          return o.refuseScope
            ? Promise.resolve("https://test-ext-id.chromiumapp.org/#error=invalid_scope")
            : Promise.resolve(
                "https://test-ext-id.chromiumapp.org/#access_token=SEND-TOKEN&expires_in=3600"
              );
        },
        fetch: (url, init) => {
          if (/oauth2\/v3\/userinfo/.test(url))
            return Promise.resolve({
              ok: true, status: 200,
              json: () => Promise.resolve({ email: "student@vitapstudent.ac.in" }),
            });
          seen.sends.push({ url, body: JSON.parse((init && init.body) || "{}") });
          if (o.sendFails)
            return Promise.resolve({
              ok: false, status: 403,
              json: () => Promise.resolve({ error: { message: o.sendFails } }),
            });
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: "m1" }) });
        },
      });
      return { ask, store, seen };
    };
    // base64url -> the raw RFC 2822 message the worker built
    const rawOf = (send) =>
      Buffer.from(String(send.body.raw).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

    {
      const { ask, seen } = mailBoot();
      // an em dash and an emoji in the subject: btoa() throws on both unless
      // the worker widens to UTF-8 bytes first, and a naive header would emit
      // raw 8-bit into a header field
      const r = await ask({
        message: "send_mail",
        subject: "FAT exam schedule — 1 upcoming 📧",
        html: "<b>ECE2015</b>",
        text: "ECE2015",
        interactive: true,
      });
      const raw = seen.sends.length ? rawOf(seen.sends[0]) : "";
      ok(
        "it asks for gmail.send (not inbox read) and resolves the address itself",
        /scope=[^&]*gmail\.send/.test(seen.auth[0] || "") &&
          /userinfo\.email/.test(decodeURIComponent(seen.auth[0] || "")) &&
          !/gmail\.readonly/.test(decodeURIComponent(seen.auth[0] || "")),
        decodeURIComponent(seen.auth[0] || "(no auth)")
      );
      ok(
        "the mail is sent and the address it went to is reported back",
        r && r.ok === true && r.to === "student@vitapstudent.ac.in" &&
          /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/.test(seen.sends[0].url),
        JSON.stringify(r)
      );
      ok(
        "a non-ASCII subject survives as an RFC 2047 encoded word",
        /^Subject: =\?UTF-8\?B\?(\S+)\?=$/mu.test(raw) &&
          Buffer.from(
            (raw.match(/^Subject: =\?UTF-8\?B\?(\S+)\?=$/mu) || [])[1],
            "base64"
          ).toString("utf8") === "FAT exam schedule — 1 upcoming 📧",
        (raw.match(/^Subject:.*$/mu) || ["missing"])[0]
      );
      ok(
        "both a text/plain and a text/html part are sent, inside one boundary",
        /^Content-Type: multipart\/alternative; boundary="(vtopext-[a-z0-9]+)"$/mu.test(raw) &&
          /Content-Type: text\/plain; charset="UTF-8"/u.test(raw) &&
          /Content-Type: text\/html; charset="UTF-8"/u.test(raw) &&
          raw.trimEnd().endsWith("--"),
        raw.replace(/\r\n/g, " | ").slice(0, 200)
      );
    }
    {
      // a remembered address wins over the signed-in mailbox: two Google
      // accounts is the norm, and the one Calendar runs under is often not the
      // one the student reads on their phone
      const { ask, seen } = mailBoot({ store: { vtopext_reminder_email: "me@personal.example" } });
      const r = await ask({ message: "send_mail", subject: "s", text: "t", interactive: true });
      ok(
        "a remembered reminder address overrides the signed-in mailbox",
        r && r.to === "me@personal.example" && /To: me@personal\.example/u.test(rawOf(seen.sends[0])),
        JSON.stringify(r)
      );
    }
    {
      // the ONE failure a student cannot click past
      const { ask } = mailBoot({ refuseScope: true });
      const r = await ask({ message: "send_mail", subject: "s", text: "t", interactive: true });
      ok(
        "a refused gmail.send scope is reported as a config problem, not a closed window",
        r && r.ok === false && r.error === "gmail_send_scope",
        JSON.stringify(r)
      );
    }
    {
      // the Gmail API itself switched off reads the same to the student
      const { ask } = mailBoot({ sendFails: "Gmail API has not been used in project 123 before" });
      const r = await ask({ message: "send_mail", subject: "s", text: "t", interactive: true });
      ok(
        "a disabled Gmail API is folded into the same actionable message",
        r && r.ok === false && r.error === "gmail_send_scope",
        JSON.stringify(r)
      );
    }
    {
      // relay off here too, or the send never reaches the no-client-id branch
      const { ask } = bootAuth({ noClient: true, store: { vtopext_mail_relay_url: "off" } });
      const r = await ask({ message: "send_mail", subject: "s", text: "t" });
      ok(
        "with no client id it says so instead of opening a doomed consent window",
        r && r.ok === false && r.error === "not_configured",
        JSON.stringify(r)
      );
    }

    /* ---- relay mode: mail comes FROM VTOP Extension, not from the student ---- */
    console.log("\n=== mail relay: sending from a VTOP Extension address, no server ===");
    const relayBoot = (o = {}) => {
      const seen = { auth: [], posts: [], gmail: 0 };
      const { ask } = bootAuth({
        store: {
          vtopext_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vtopext_mail_relay_url: "https://script.google.com/macros/s/AKfy-test/exec",
          ...(o.store || {}),
        },
        webAuth: (url) => {
          seen.auth.push(url);
          return Promise.resolve(
            "https://test-ext-id.chromiumapp.org/#access_token=ADDR-TOKEN&expires_in=3600"
          );
        },
        fetch: (url, init) => {
          if (/oauth2\/v3\/userinfo/.test(url))
            return Promise.resolve({
              ok: true, status: 200,
              json: () => Promise.resolve({ email: "student@vitapstudent.ac.in" }),
            });
          if (/gmail\.googleapis\.com/.test(url)) {
            seen.gmail += 1;
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
          }
          seen.posts.push({ url, init, body: JSON.parse((init && init.body) || "{}") });
          if (o.relayError)
            return Promise.resolve({
              ok: true, status: 200,
              json: () => Promise.resolve({ ok: false, error: o.relayError }),
            });
          if (o.httpFail)
            return Promise.resolve({ ok: false, status: o.httpFail, json: () => Promise.resolve(null) });
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        },
      });
      return { ask, seen };
    };

    /* ---- and the way back out of relay mode ----
     *
     * A regression caught the day a real relay URL was put into
     * MAIL_RELAY_URL (2026-08-22). Clearing the field used to just delete the
     * storage key, which was fine while the constant was blank — nothing to
     * fall back to. With a URL shipping in the build, deleting the key fell
     * back to THAT, so clearing the box silently did nothing and the popup's
     * own instruction ("Leave blank to send from your own Gmail") became
     * false.
     *
     * "I declined a relay" and "nobody configured one" are different states
     * and now store differently.
     */
    {
      const seen = { posts: [], gmail: 0 };
      const { ask, store } = bootAuth({
        store: {
          vtopext_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vtopext_mail_relay_url: "https://script.google.com/macros/s/AKfy-test/exec",
          vtopext_reminder_email: "me@vitapstudent.ac.in",
        },
        webAuth: () =>
          Promise.resolve(
            "https://test-ext-id.chromiumapp.org/#access_token=T&expires_in=3600"
          ),
        fetch: (url, init) => {
          if (/oauth2\/v3\/userinfo/.test(url))
            return Promise.resolve({
              ok: true, status: 200,
              json: () => Promise.resolve({ email: "student@vitapstudent.ac.in" }),
            });
          if (/gmail\.googleapis\.com/.test(url)) {
            seen.gmail += 1;
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: "m" }) });
          }
          seen.posts.push(url);
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        },
      });

      const cleared = await ask({ message: "set_mail_relay", url: "" });
      ok(
        "clearing the relay records a refusal, it does not forget the setting",
        cleared && cleared.ok === true && store.vtopext_mail_relay_url === "off",
        JSON.stringify({ cleared, stored: store.vtopext_mail_relay_url })
      );

      await ask({ message: "send_mail", subject: "s", text: "t", interactive: true });
      ok(
        "…and mail then goes through the student's own Gmail, not the shipped relay",
        seen.gmail === 1 && seen.posts.length === 0,
        JSON.stringify({ gmail: seen.gmail, relayPosts: seen.posts.length })
      );
    }

    /* ---- the shipped relay comes from config.json, not from code ---- */
    {
      const run = async (config) => {
        const seen = { posts: [], gmail: 0 };
        const { ask } = bootAuth({
          store: {
            vtopext_calendar_client_id: "999-cal.apps.googleusercontent.com",
            vtopext_reminder_email: "me@vitapstudent.ac.in",
          },
          webAuth: () =>
            Promise.resolve("https://test-ext-id.chromiumapp.org/#access_token=T&expires_in=3600"),
          fetch: (url, init) => {
            if (/config\.json$/.test(url))
              return config === "broken"
                ? Promise.reject(new Error("unreadable"))
                : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(config) });
            if (/oauth2\/v3\/userinfo/.test(url))
              return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ email: "student@vitapstudent.ac.in" }) });
            if (/gmail\.googleapis\.com/.test(url)) {
              seen.gmail += 1;
              return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: "m" }) });
            }
            seen.posts.push(url);
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
          },
        });
        await ask({ message: "send_mail", subject: "s", text: "t", interactive: true });
        return seen;
      };
      const withRelay = await run({ mailRelayUrl: "https://script.google.com/macros/s/CFG-test/exec" });
      ok(
        "with a relay in config.json, mail goes through it and not through Gmail",
        withRelay.posts.length === 1 && /CFG-test/.test(withRelay.posts[0]) && withRelay.gmail === 0,
        JSON.stringify(withRelay)
      );
      const blank = await run({ mailRelayUrl: "" });
      ok("a blank relay in config.json sends from the student's own Gmail", blank.posts.length === 0 && blank.gmail === 1, JSON.stringify(blank));
      const broken = await run("broken");
      ok("an unreadable config.json falls back to the student's own Gmail", broken.posts.length === 0 && broken.gmail === 1, JSON.stringify(broken));
    }

    /* ---- scheduled mail reminders: the extension's mail, fired by an alarm ---- */
    {
      const RELAY = "https://script.google.com/macros/s/ALARM-test/exec";
      const boot = (o = {}) => {
        const posts = [];
        const b = bootAuth({
          store: { vtopext_mail_relay_url: RELAY, vtopext_reminder_email: "me@vitapstudent.ac.in", ...(o.store || {}) },
          fetch: (url, init) => {
            posts.push({ url, body: JSON.parse((init && init.body) || "{}") });
            return Promise.resolve({
              ok: true, status: 200,
              json: () => Promise.resolve(o.fail ? { ok: false, error: "relay busy" } : { ok: true }),
            });
          },
        });
        return { ...b, posts };
      };
      const mailReminder = (extra = {}) => ({
        when: Date.now() + 3600000,
        title: "Tomorrow - FAT exam: ECE2015",
        body: "CB-324",
        notify: false,
        until: Date.now() + 7200000,
        mail: { subject: "Tomorrow: FAT exam: ECE2015", text: "Venue CB-324", html: "<b>Venue CB-324</b>" },
        ...extra,
      });
      const names = (b) => Object.keys(b.alarmsLive).filter((n) => n.startsWith("vrrem|"));

      // get_reminder_email tells the page what is saved and that mail is relayed
      {
        const b = boot();
        const r = await b.ask({ message: "get_reminder_email" });
        ok("the page can ask what address is saved and whether mail is relayed",
          r && r.address === "me@vitapstudent.ac.in" && r.relay === true, JSON.stringify(r));
      }

      // 1. the alarm sends the mail through the relay, once, and no popup
      {
        const b = boot();
        const n = await b.ask({ message: "schedule_local_reminders", tag: "exam-mail:FAT", reminders: [mailReminder()] });
        const name = names(b)[0];
        await b.fireAlarm(name);
        ok(
          "an alarm sends its mail through the relay to the saved address, and shows no popup",
          n === 1 && b.posts.length === 1 && /ALARM-test/.test(b.posts[0].url) &&
            b.posts[0].body.to === "me@vitapstudent.ac.in" &&
            b.posts[0].body.subject === "Tomorrow: FAT exam: ECE2015" && b.notes.length === 0,
          JSON.stringify({ n, posts: b.posts.length, notes: b.notes.length })
        );
        await b.fireAlarm(name);
        ok("a second firing of the same alarm sends nothing more", b.posts.length === 1, `posts=${b.posts.length}`);
      }

      // 2. a reminder that is also a popup still pops up
      {
        const b = boot();
        await b.ask({ message: "schedule_local_reminders", tag: "x", reminders: [mailReminder({ notify: true })] });
        await b.fireAlarm(names(b)[0]);
        ok("notify:true keeps the popup as well as the mail", b.notes.length === 1 && b.posts.length === 1,
          JSON.stringify({ notes: b.notes.length, posts: b.posts.length }));
      }

      // 3. the moment has passed (Chrome was closed): do not mail yesterday's news
      {
        const b = boot();
        await b.ask({ message: "schedule_local_reminders", tag: "x", reminders: [mailReminder({ until: Date.now() - 1000 })] });
        await b.fireAlarm(names(b)[0]);
        ok("a reminder past its useful moment is dropped, not mailed", b.posts.length === 0, `posts=${b.posts.length}`);
      }

      // 4. failure: retried ten minutes later while still useful, then said out loud
      {
        const b = boot({ fail: true });
        await b.ask({ message: "schedule_local_reminders", tag: "x", reminders: [mailReminder({ until: Date.now() + 6 * 3600000 })] });
        const name = names(b)[0];
        await b.fireAlarm(name);
        const retryAt = b.alarmsLive[name] && b.alarmsLive[name].when;
        ok(
          "a failed send is retried in about ten minutes, without a scary popup yet",
          !!retryAt && retryAt > Date.now() + 9 * 60000 && retryAt < Date.now() + 11 * 60000 && b.notes.length === 0,
          JSON.stringify({ retryIn: retryAt && Math.round((retryAt - Date.now()) / 60000), notes: b.notes.length })
        );
        await b.fireAlarm(name);
        await b.fireAlarm(name);
        await b.fireAlarm(name);
        ok(
          "after four failures it says so with a notification instead of failing silently",
          b.posts.length === 4 && b.notes.length === 1 && /email your reminder/.test(b.notes[0].title) &&
            /relay busy/.test(b.notes[0].message),
          JSON.stringify({ posts: b.posts.length, notes: b.notes.map((x) => x.title + " | " + x.message) })
        );
      }

      // 5. nowhere to send: the failure names the fix
      {
        const b = boot({ store: { vtopext_reminder_email: undefined } });
        await b.ask({ message: "schedule_local_reminders", tag: "x", reminders: [mailReminder({ until: Date.now() + 30000 })] });
        await b.fireAlarm(names(b)[0]);
        ok(
          "with no saved address the notification says to add one in the popup",
          b.posts.length === 0 && b.notes.length === 1 && /add one in the popup/.test(b.notes[0].message),
          JSON.stringify(b.notes)
        );
      }
    }

    {
      // Asked 2026-08-16 — "we do not need their oauth too?". For mail: no. Not
      // one scope. The relay owns the sending identity, so the only unknown is
      // the recipient, and the answer to that is a text field, not a consent
      // screen. `need_address` is the signal that asks for it.
      const { ask, seen } = relayBoot();
      const first = await ask({ message: "send_mail", subject: "s", text: "t", interactive: true });
      ok(
        "relay mode never touches Google — no address means ask, not sign in",
        first && first.ok === false && first.error === "need_address" &&
          seen.auth.length === 0 && seen.gmail === 0 && seen.posts.length === 0,
        JSON.stringify({ first, auths: seen.auth.length, gmail: seen.gmail })
      );
    }
    {
      const { ask, seen } = relayBoot({ store: { vtopext_reminder_email: "student@vitapstudent.ac.in" } });
      const r = await ask({ message: "send_mail", subject: "FAT — 6 upcoming", html: "<b>x</b>", interactive: true });
      ok(
        "a configured relay takes over, and Gmail's send API is never touched",
        r && r.ok === true && r.to === "student@vitapstudent.ac.in" &&
          seen.posts.length === 1 && seen.gmail === 0 && seen.auth.length === 0 &&
          /script\.google\.com\/macros\/s\/.*\/exec$/.test(seen.posts[0].url),
        JSON.stringify({ r, gmailCalls: seen.gmail, auths: seen.auth.length })
      );
      ok(
        "the relay is told only who to write to — the FROM identity is its own",
        seen.posts[0].body.to === "student@vitapstudent.ac.in" &&
          seen.posts[0].body.subject === "FAT — 6 upcoming" &&
          !("from" in seen.posts[0].body),
        JSON.stringify(seen.posts[0].body)
      );
      ok(
        "posted as text/plain, so Apps Script isn't asked for a CORS preflight it won't answer",
        /text\/plain/.test((seen.posts[0].init.headers || {})["Content-Type"] || ""),
        JSON.stringify(seen.posts[0].init.headers)
      );
    }
    {
      // the address the student typed is stored per-browser and reused
      const { ask, seen } = relayBoot();
      const saved = await ask({ message: "set_reminder_email", address: "me@personal.example" });
      const r = await ask({ message: "send_mail", subject: "s", text: "t" });
      ok(
        "an address typed once is remembered, and every later send just works",
        saved && saved.ok === true && r && r.ok === true && r.to === "me@personal.example" &&
          seen.auth.length === 0,
        JSON.stringify({ saved, r })
      );
      const bad = await ask({ message: "set_reminder_email", address: "not an email" });
      ok(
        "a typo is refused rather than silently stored and mailed into the void",
        bad && bad.ok === false && /doesn't look like an email/.test(bad.error),
        JSON.stringify(bad)
      );
    }
    {
      // the script's own refusals are already written for a student to read
      const { ask } = relayBoot({ store: { vtopext_reminder_email: "student@vitapstudent.ac.in" }, relayError: "too many mails to this address today" });
      const r = await ask({ message: "send_mail", subject: "s", text: "t", interactive: true });
      ok(
        "a relay refusal is surfaced in the relay's own words",
        r && r.ok === false && r.error === "too many mails to this address today",
        JSON.stringify(r)
      );
    }
    {
      const { ask } = relayBoot({ store: { vtopext_reminder_email: "student@vitapstudent.ac.in" }, httpFail: 503 });
      const r = await ask({ message: "send_mail", subject: "s", text: "t", interactive: true });
      ok(
        "a relay that is down reports the status, and does NOT silently fall back to the student's Gmail",
        r && r.ok === false && /relay returned HTTP 503/.test(r.error),
        JSON.stringify(r)
      );
    }

    /* ---------------- the daily digest ----------------
     *
     * Built last session and shipped with NO test at all, which is how the
     * home card's mistake — telling a student already under 75% how many
     * classes they may skip — came to be duplicated in the mail nobody had
     * read yet. `set_daily_digest {enabled:true}` sends one immediately, which
     * is also the only way to see it without firing an alarm.
     */
    console.log("\n=== daily digest: what actually lands in the inbox ===");
    const digestBoot = (subjects, extra = {}) =>
      relayBoot({
        store: {
          vtopext_reminder_email: "me@personal.example",
          vtopext_attendance_summary: { fetchedAt: Date.now(), subjects },
          ...extra,
        },
      });

    {
      const { ask, seen } = digestBoot([
        { name: "CSE3009 - NoSQL", code: "CSE3009", pct: 68, safeNow: 0, below75: true, recover: 4, canRecover: true, maxPct: 88, unit: "class(es)" },
      ]);
      const r = await ask({ message: "set_daily_digest", enabled: true });
      const body = seen.posts[0] ? seen.posts[0].body : {};
      ok(
        "turning the digest on sends one straight away, to the saved address",
        r && r.ok === true && r.enabled === true && seen.posts.length === 1 && body.to === "me@personal.example",
        JSON.stringify({ r, posts: seen.posts.length })
      );
      ok(
        "a subject under 75% is told what to attend, not what it may skip",
        /debarred unless you attend the next 4 class\(es\)/.test(body.html || "") &&
          !/you can still skip/.test(body.html || ""),
        String(body.html || "").slice(0, 400)
      );
      ok(
        "the plain-text part carries the same verdict, without the markup",
        /debarred unless you attend the next 4 class\(es\)/.test(body.text || "") &&
          !/<b>/.test(body.text || ""),
        String(body.text || "").slice(0, 300)
      );
    }

    {
      const { ask, seen } = digestBoot([
        { name: "CHY1008 - Chemistry", code: "CHY1008", pct: 52, safeNow: 0, below75: true, recover: 9, canRecover: false, maxPct: 71, unit: "class(es)" },
      ]);
      await ask({ message: "set_daily_digest", enabled: true });
      const html = (seen.posts[0] && seen.posts[0].body.html) || "";
      ok(
        "an unrecoverable subject is not sent impossible arithmetic",
        /still only reaches 71%/.test(html) && !/attend the next/.test(html),
        html.slice(0, 400)
      );
    }

    {
      const { ask, seen } = digestBoot([
        { name: "MAT2002 - Numerical Methods", code: "MAT2002", pct: 76, safeNow: 0, below75: false, unit: "class(es)" },
        { name: "CSE2005 - OS", code: "CSE2005", pct: 79, safeNow: 2, below75: false, unit: "class(es)" },
      ]);
      await ask({ message: "set_daily_digest", enabled: true });
      const html = (seen.posts[0] && seen.posts[0].body.html) || "";
      ok(
        "above the line, the number given is headroom before 75%",
        /no room left/.test(html) && /2 class\(es\) left before you drop under 75%/.test(html),
        html.slice(0, 400)
      );
    }

    {
      // Nothing cached at all: no mail, no notification, no error. A digest
      // that mails "I have nothing to tell you" every morning gets muted, and
      // then the one that matters is muted too.
      const { ask, seen } = relayBoot({ store: { vtopext_reminder_email: "me@personal.example" } });
      const r = await ask({ message: "set_daily_digest", enabled: true });
      ok(
        "a day with nothing to report sends nothing at all",
        r && r.ok === true && seen.posts.length === 0,
        JSON.stringify({ r, posts: seen.posts.length })
      );
    }

    {
      // Stale snapshots must not be mailed as today's news — the same failure
      // the home card had, in the surface a student reads before opening VTOP.
      const { ask, seen } = relayBoot({
        store: {
          vtopext_reminder_email: "me@personal.example",
          vtopext_attendance_summary: {
            fetchedAt: Date.now() - 40 * 86400000,
            subjects: [{ name: "CSE3009", code: "CSE3009", pct: 60, safeNow: 0, below75: true, recover: 5, canRecover: true, unit: "class(es)" }],
          },
        },
      });
      await ask({ message: "set_daily_digest", enabled: true });
      ok(
        "a 40-day-old attendance snapshot is not mailed as today's news",
        seen.posts.length === 0,
        JSON.stringify(seen.posts.map((p) => ({ url: p.url, body: p.body })))
      );
    }
  }

  /* ====== the venue watcher: mail me again once VTOP publishes the venue ===== */
  console.log("\n=== exam venue watcher: auto-mail when '-' becomes a real venue ===");
  {
    // VTOP publishes venue and seat late — the column reads "-" until a few
    // days out, so the first 📧 can only ever say "not published yet". Asked
    // for 2026-08-16: mail it again, same format, the moment it appears.
    const fixedExam = new Date("2026-04-01T09:00:00+05:30").getTime();
    const body = (venue, seatLoc, seatNo) => `<body>
      <select id="semesterSubId"><option selected>Winter Semester 2025-26</option></select>
      <table class="customTable">
        <tr><td>General (Semester)</td></tr>
        <tr><td>S.No.</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Class ID</td><td>Slot</td>
            <td>Exam Date</td><td>Exam Session</td><td>Reporting Time</td><td>Exam Time</td><td>Venue</td>
            <td>Seat Location</td><td>Seat No.</td></tr>
        <tr><td class="panelHead-secondary">FAT</td></tr>
        <tr><td>1</td><td>ECE2015</td><td>Computer Architecture</td><td>ETH</td><td>AP1</td><td>A1</td>
            <td>04-May-2026</td><td>FN1</td><td>09:30 AM</td><td>10:00 AM - 01:00 PM</td><td>${venue}</td>
            <td>${seatLoc}</td><td>${seatNo}</td></tr>
      </table></body>`;

    const page = await newPage(browser);
    await page.route("https://www.googleapis.com/**", (route) =>
      route.fulfill({ contentType: "application/json", body: "{}" })
    );
    await page.setContent(body("-", "-", "-"));
    await shim(page, { fixedMs: fixedExam });
    await inject(page, [
      "js/shared/click.js", "js/shared/ics.js", "js/shared/google_auth.js", "js/exam_schedule.js",
    ]);
    await page.evaluate(() => { window.__mails = []; window.__dispatch("exam_schedule"); });
    await delay(600);
    // Guarantee 1: silence until 📧 has been pressed. A page load must never
    // send mail — or open a Google consent window — on its own.
    ok(
      "no mail before 📧 has ever been pressed",
      (await page.evaluate(() => (window.__mails || []).length)) === 0,
      JSON.stringify(await page.evaluate(() => window.__mails || []))
    );

    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .filter((b) => /mail me the list/i.test(b.textContent))[0].click();
    });
    await delay(600);
    const firstNote = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => /mail me the list/i.test(x.textContent));
      return b && b.nextElementSibling ? b.nextElementSibling.textContent : null;
    });
    ok(
      "📧 says which exams are still waiting on a venue, and promises the follow-up",
      /still have no venue/.test(firstNote || "") &&
        /mailed again automatically/.test(firstNote || ""),
      String(firstNote)
    );
    ok(
      "and it records the opt-in so the watcher may run from now on",
      (await page.evaluate(() => (window.__storage.vtopext_exam_mail_state || {}).optIn)) === true,
      JSON.stringify(await page.evaluate(() => window.__storage.vtopext_exam_mail_state || null))
    );

    // Nothing has changed yet: re-rendering the same page must not re-send.
    await page.evaluate(() => { window.__mails = []; window.__dispatch("exam_schedule"); });
    await delay(600);
    ok(
      "an unchanged page does not mail again",
      (await page.evaluate(() => (window.__mails || []).length)) === 0,
      JSON.stringify(await page.evaluate(() => (window.__mails || []).map((m) => m.subject)))
    );

    // VTOP publishes the venue. This is the whole feature.
    await page.evaluate((html) => {
      document.body.innerHTML = new DOMParser()
        .parseFromString(html, "text/html").body.innerHTML;
      window.__mails = [];
      window.__dispatch("exam_schedule");
    }, body("CB-324", "R3C1", "5"));
    await delay(900);
    const auto = await page.evaluate(() => (window.__mails || [])[0] || null);
    ok(
      "a venue appearing mails automatically, in the same format, saying why",
      !!auto &&
        /FAT — venue published for 1 exam\(s\)/.test(auto.subject) &&
        /published the venue/.test(auto.html) &&
        /CB-324/.test(auto.html) &&
        /R3C1/.test(auto.html) &&
        // same table layout as the manual 📧 — the format was asked for by name
        /Seat loc \/ no\./.test(auto.html),
      JSON.stringify({ subject: auto && auto.subject, sent: (await page.evaluate(() => (window.__mails || []).length)) })
    );
    ok(
      "the automatic send is never interactive (no consent window on page load)",
      !!auto && auto.interactive === false,
      JSON.stringify({ interactive: auto && auto.interactive })
    );
    // Guarantee 2: the sync retries up to ten times per load. Keying the record
    // by the VENUE, not a boolean, is what stops a storm of identical mails.
    await page.evaluate(() => { window.__mails = []; window.__dispatch("exam_schedule"); });
    await delay(900);
    ok(
      "the same venue never mails twice",
      (await page.evaluate(() => (window.__mails || []).length)) === 0,
      JSON.stringify(await page.evaluate(() => (window.__mails || []).map((m) => m.subject)))
    );
    // ...but a CORRECTED venue is news, and must go out
    await page.evaluate((html) => {
      document.body.innerHTML = new DOMParser()
        .parseFromString(html, "text/html").body.innerHTML;
      window.__mails = [];
      window.__dispatch("exam_schedule");
    }, body("CB-101", "R1C1", "12"));
    await delay(900);
    const moved = await page.evaluate(() => (window.__mails || [])[0] || null);
    ok(
      "a venue CHANGED after the fact mails again",
      !!moved && /CB-101/.test(moved.html),
      JSON.stringify({ subject: moved && moved.subject })
    );
    await page.close();
  }

  /* ---- the address prompt: the whole cost of mail once a relay exists ---- */
  console.log("\n=== 📧 with a relay: one text field instead of a Google sign-in ===");
  {
    const fixedExam = new Date("2026-04-01T09:00:00+05:30").getTime();
    const page = await newPage(browser);
    await page.route("https://www.googleapis.com/**", (route) =>
      route.fulfill({ contentType: "application/json", body: "{}" })
    );
    await page.setContent(`<body>
      <select id="semesterSubId"><option selected>Winter Semester 2025-26</option></select>
      <form id="examSchedule"><table class="customTable">
        <tr><td>General (Semester)</td></tr>
        <tr><td>S.No.</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Class ID</td><td>Slot</td>
            <td>Exam Date</td><td>Exam Session</td><td>Reporting Time</td><td>Exam Time</td><td>Venue</td>
            <td>Seat Location</td><td>Seat No.</td></tr>
        <tr><td class="panelHead-secondary">FAT</td></tr>
        <tr><td>1</td><td>ECE2015</td><td>Computer Architecture</td><td>ETH</td><td>AP1</td><td>A1</td>
            <td>04-May-2026</td><td>FN1</td><td>09:30 AM</td><td>10:00 AM - 01:00 PM</td><td>CB-324</td>
            <td>R3C1</td><td>5</td></tr>
      </table></form></body>`);
    await shim(page, { fixedMs: fixedExam });
    await inject(page, [
      "js/shared/click.js", "js/shared/ics.js", "js/shared/google_auth.js", "js/exam_schedule.js",
    ]);
    await page.evaluate(() => {
      window.__mailNeedsAddress = true; // a relay is configured, address unknown
      window.__mails = [];
      window.__dispatch("exam_schedule");
    });
    await delay(400);
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .filter((b) => /mail me the list/i.test(b.textContent))[0].click();
    });
    await delay(400);
    const prompted = await page.evaluate(() => {
      const box = document.querySelector(".vtopext-exam-addr");
      const save = box && box.querySelector("[data-vr-action='exam-addr']");
      return {
        hasInput: !!(box && box.querySelector("input")),
        // these sit inside VTOP's own <form>; a default-type button submits it
        saveType: save ? save.type : null,
        mails: (window.__mails || []).length,
      };
    });
    ok(
      "no address yet: it asks in place, sends nothing, and cannot submit VTOP's form",
      prompted.hasInput && prompted.saveType === "button" && prompted.mails === 0,
      JSON.stringify(prompted)
    );

    // a typo is caught before anything is stored or sent
    await page.evaluate(() => {
      const box = document.querySelector(".vtopext-exam-addr");
      box.querySelector("input").value = "nonsense";
      box.querySelector("[data-vr-action='exam-addr']").click();
    });
    await delay(300);
    ok(
      "a typo is refused in place, the prompt stays open, still nothing sent",
      (await page.evaluate(() => !!document.querySelector(".vtopext-exam-addr"))) &&
        (await page.evaluate(() => (window.__mails || []).length)) === 0 &&
        !(await page.evaluate(() => window.__storage.vtopext_reminder_email)),
      JSON.stringify(await page.evaluate(() => (window.__mails || []).length))
    );

    await page.evaluate(() => {
      const box = document.querySelector(".vtopext-exam-addr");
      box.querySelector("input").value = "me@personal.example";
      box.querySelector("[data-vr-action='exam-addr']").click();
    });
    await delay(600);
    const after = await page.evaluate(() => ({
      stored: window.__storage.vtopext_reminder_email || null,
      gone: !document.querySelector(".vtopext-exam-addr"),
      mail: (window.__mails || [])[0] || null,
      note: (() => {
        const b = [...document.querySelectorAll("button")]
          .find((x) => /mail me the list/i.test(x.textContent));
        return b && b.nextElementSibling ? b.nextElementSibling.textContent : null;
      })(),
    }));
    ok(
      "answering it sends immediately — no re-click, no sign-in, ever",
      after.stored === "me@personal.example" && after.gone && !!after.mail &&
        after.mail.to === "me@personal.example" && /ECE2015/.test(after.mail.html),
      JSON.stringify({ stored: after.stored, gone: after.gone, to: after.mail && after.mail.to })
    );
    ok(
      "and the confirmation names the address the student just typed",
      /✓ emailed 1 exam\(s\) to me@personal\.example/.test(after.note || ""),
      String(after.note)
    );
    await page.close();
  }

  /* --- and it waits for the whole batch, instead of one mail per subject --- */
  {
    // VTOP publishes a group's venues together, overnight. Reported
    // 2026-08-16: "it sends even if one subject gets the venue na" — firing on
    // the first row to change would mean a trickle of mails whenever the
    // student opens VTOP mid-batch, or when one course lags.
    const fixedExam = new Date("2026-04-01T09:00:00+05:30").getTime();
    // ECE2015 is 33 days out, PHY1701 is 32 — neither is urgent
    const two = (v1, v2) => `<body>
      <select id="semesterSubId"><option selected>Winter Semester 2025-26</option></select>
      <table class="customTable">
        <tr><td>General (Semester)</td></tr>
        <tr><td>S.No.</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Class ID</td><td>Slot</td>
            <td>Exam Date</td><td>Exam Session</td><td>Reporting Time</td><td>Exam Time</td><td>Venue</td>
            <td>Seat Location</td><td>Seat No.</td></tr>
        <tr><td class="panelHead-secondary">FAT</td></tr>
        <tr><td>1</td><td>ECE2015</td><td>Computer Architecture</td><td>ETH</td><td>AP1</td><td>A1</td>
            <td>04-May-2026</td><td>FN1</td><td>09:30 AM</td><td>10:00 AM - 01:00 PM</td><td>${v1}</td>
            <td>R3C1</td><td>5</td></tr>
        <tr><td>2</td><td>PHY1701</td><td>Modern Physics</td><td>ETH</td><td>AP2</td><td>B1</td>
            <td>03-May-2026</td><td>FN1</td><td>09:30 AM</td><td>10:00 AM - 01:00 PM</td><td>${v2}</td>
            <td>R1C2</td><td>7</td></tr>
      </table></body>`;

    const page = await newPage(browser);
    await page.route("https://www.googleapis.com/**", (route) =>
      route.fulfill({ contentType: "application/json", body: "{}" })
    );
    await page.setContent(two("-", "-"));
    await shim(page, { fixedMs: fixedExam });
    await inject(page, [
      "js/shared/click.js", "js/shared/ics.js", "js/shared/google_auth.js", "js/exam_schedule.js",
    ]);
    await page.evaluate(() => window.__dispatch("exam_schedule"));
    await delay(400);
    // opt in, with both venues still unpublished
    await page.evaluate(() => {
      window.__mails = [];
      [...document.querySelectorAll("button")]
        .filter((b) => /mail me the list/i.test(b.textContent))[0].click();
    });
    await delay(600);

    // ONE of two lands: hold, because neither exam is close
    await page.evaluate((html) => {
      document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
      window.__mails = [];
      window.__dispatch("exam_schedule");
    }, two("CB-324", "-"));
    await delay(900);
    ok(
      "one subject's venue alone does NOT mail — it waits for the rest of the batch",
      (await page.evaluate(() => (window.__mails || []).length)) === 0,
      JSON.stringify(await page.evaluate(() => (window.__mails || []).map((m) => m.subject)))
    );

    // the batch completes: exactly one mail, carrying BOTH exams
    await page.evaluate((html) => {
      document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
      window.__mails = [];
      window.__dispatch("exam_schedule");
    }, two("CB-324", "CB-108"));
    await delay(900);
    const batch = await page.evaluate(() => window.__mails || []);
    ok(
      "when the batch completes, ONE mail carries the whole group",
      batch.length === 1 &&
        /venue published for 2 exam\(s\)/.test(batch[0].subject) &&
        /CB-324/.test(batch[0].html) &&
        /CB-108/.test(batch[0].html),
      JSON.stringify({ count: batch.length, subject: batch[0] && batch[0].subject })
    );
    await page.close();
  }

  /* --- unless waiting would mean missing the exam --- */
  {
    // A course whose venue never appears (moved online, cancelled) must not
    // suppress the mail for an exam that is tomorrow. Inside 36 h, a partial
    // list beats no list.
    const soon = new Date("2026-05-03T09:00:00+05:30").getTime(); // ECE2015 is next morning
    const page = await newPage(browser);
    await page.route("https://www.googleapis.com/**", (route) =>
      route.fulfill({ contentType: "application/json", body: "{}" })
    );
    const html = (v1) => `<body>
      <select id="semesterSubId"><option selected>Winter Semester 2025-26</option></select>
      <table class="customTable">
        <tr><td>General (Semester)</td></tr>
        <tr><td>S.No.</td><td>Course Code</td><td>Course Title</td><td>Course Type</td><td>Class ID</td><td>Slot</td>
            <td>Exam Date</td><td>Exam Session</td><td>Reporting Time</td><td>Exam Time</td><td>Venue</td>
            <td>Seat Location</td><td>Seat No.</td></tr>
        <tr><td class="panelHead-secondary">FAT</td></tr>
        <tr><td>1</td><td>ECE2015</td><td>Computer Architecture</td><td>ETH</td><td>AP1</td><td>A1</td>
            <td>04-May-2026</td><td>FN1</td><td>09:30 AM</td><td>10:00 AM - 01:00 PM</td><td>${v1}</td>
            <td>R3C1</td><td>5</td></tr>
        <tr><td>2</td><td>PHY1701</td><td>Modern Physics</td><td>ETH</td><td>AP2</td><td>B1</td>
            <td>20-May-2026</td><td>FN1</td><td>09:30 AM</td><td>10:00 AM - 01:00 PM</td><td>-</td>
            <td>R1C2</td><td>7</td></tr>
      </table></body>`;
    await page.setContent(html("-"));
    await shim(page, { fixedMs: soon });
    await inject(page, [
      "js/shared/click.js", "js/shared/ics.js", "js/shared/google_auth.js", "js/exam_schedule.js",
    ]);
    await page.evaluate(() => window.__dispatch("exam_schedule"));
    await delay(400);
    await page.evaluate(() => {
      window.__mails = [];
      [...document.querySelectorAll("button")]
        .filter((b) => /mail me the list/i.test(b.textContent))[0].click();
    });
    await delay(600);
    await page.evaluate((h) => {
      document.body.innerHTML = new DOMParser().parseFromString(h, "text/html").body.innerHTML;
      window.__mails = [];
      window.__dispatch("exam_schedule");
    }, html("CB-324"));
    await delay(900);
    const urgent = await page.evaluate(() => (window.__mails || [])[0] || null);
    ok(
      "an exam inside 36 h mails immediately, without waiting on a straggler",
      !!urgent && /CB-324/.test(urgent.html),
      JSON.stringify({ subject: urgent && urgent.subject })
    );
    ok(
      "and it says the rest are still pending, so the silence is explained",
      !!urgent && /still show no venue/.test(urgent.html),
      (urgent ? urgent.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ") : "no mail").slice(0, 200)
    );
    await page.close();
  }

  /* ====== the page-open message: the wiring auto_semester.js never had ======
   *
   * Reported 2026-08-20: "the auto selecter of semester didnt work". The
   * picking was fine; nothing ever asked it to pick. Every caller hung off the
   * message the worker sends for that page, and those are all routed off the
   * page's DATA endpoint — which VTOP only POSTs once a semester has been
   * chosen by hand. Of the four data-urls exactly one, the Time Table's,
   * happened to collide with an existing branch.
   *
   * These assertions were checked against the pre-fix worker first: the four
   * "announces ..." ones all failed there, and the "data load, not a page
   * open" ones passed, which is the pair that says the fix is the missing half
   * rather than a re-labelling of what was already sent.
   */
  console.log("\n=== semester_page_open: the message that announces the picker ===");
  {
    const manifest = JSON.parse(read("manifest.json"));
    const evt = () => ({ addListener: () => {}, removeListener: () => {} });
    const nsProxy = (seed = {}) =>
      new Proxy({ ...seed }, {
        get(t, k) {
          if (k in t) return t[k];
          if (typeof k === "string" && /^on[A-Z]/.test(k)) return (t[k] = evt());
          return (t[k] = (...a) => {
            const cb = a[a.length - 1];
            if (typeof cb === "function") return cb(undefined);
            return Promise.resolve(undefined);
          });
        },
      });

    let onCompleted = null;
    const onBefore = [];
    const sent = [];
    const store = {};
    const chromeStub = {
      runtime: nsProxy({ lastError: null, getManifest: () => manifest, id: "test" }),
      webRequest: nsProxy({
        onCompleted: { addListener: (fn) => { onCompleted = fn; }, removeListener: () => {} },
        onBeforeRequest: { addListener: (fn) => onBefore.push(fn), removeListener: () => {} },
      }),
      tabs: nsProxy({
        sendMessage: (tabId, msg) => { sent.push({ tabId, msg }); },
        onRemoved: evt(),
        query: (_q, cb) => cb([]),
      }),
      storage: {
        local: nsProxy({
          get: (keys) => {
            const out = {};
            for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
            return Promise.resolve(out);
          },
          set: (obj) => (Object.assign(store, obj), Promise.resolve()),
        }),
        session: nsProxy(),
        sync: nsProxy(),
      },
    };
    for (const perm of manifest.permissions || []) if (!(perm in chromeStub)) chromeStub[perm] = nsProxy();
    if (manifest.action) chromeStub.action = nsProxy();

    const ctx = vm.createContext({
      chrome: chromeStub,
      console: { log: () => {}, warn: () => {}, error: () => {} },
      setTimeout, clearTimeout, setInterval, clearInterval,
      fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
      URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, atob, btoa,
    });
    ctx.self = ctx;
    ctx.globalThis = ctx;
    vm.runInContext(read("service_worker/background.js"), ctx, { filename: "background.js" });

    const VT = "https://vtop.vitap.ac.in/vtop/";
    // every hit is a 200 so the session_repair detector stays out of the way
    const load = (path) => {
      sent.length = 0;
      onCompleted({ url: VT + path, method: "POST", statusCode: 200, tabId: 4, type: "xmlhttprequest" });
      return sent.map((s) => s.msg);
    };
    const opens = (msgs) =>
      (msgs.find((m) => m.message === "semester_page_open") || {}).page || null;

    if (typeof onCompleted !== "function") {
      ok("worker registers a webRequest.onCompleted listener", false, "missing");
    } else {
      // The live data-urls, read off the portal 2026-08-19.
      const cases = [
        ["examinations/StudExamSchedule", "exam_schedule"],
        ["examinations/StudentMarkView", "mark_view"],
        ["academics/common/StudentTimeTable", "timetable_view"],
        ["academics/common/StudentAttendance", "attendance"],
        // added 2026-08-22: the DA page is the list of everything you owe, and
        // answering its picker is what makes the dues column and its reminders
        // appear at all
        ["examinations/StudentDA", "da_upload"],
      ];
      for (const [path, page] of cases) {
        const msgs = load(path);
        ok(
          "opening " + path.split("/").pop() + " announces the picker (page: " + page + ")",
          opens(msgs) === page,
          JSON.stringify(msgs)
        );
      }

      /*
       * And the endpoint each page POSTs AFTERWARDS must not announce itself
       * as a page open. The two names differ only by a "do" prefix, so a
       * careless substring match would make every rendered table look like a
       * freshly opened picker — which is the load loop auto_semester.js is
       * built to avoid, arriving through the front door.
       */
      const after = [
        ["examinations/doSearchExamScheduleForStudent", "exam_schedule"],
        ["examinations/doStudentMarkView", "mark_view_page"],
        ["examinations/examGradeView/doStudentGradeView", "exam_grade"],
        ["examinations/doDigitalAssignment", "da_upload"],
      ];
      for (const [path, still] of after) {
        const msgs = load(path);
        ok(
          path.split("/").pop() + " is a data load, not a page open",
          opens(msgs) === null && msgs.some((m) => m.message === still),
          JSON.stringify(msgs)
        );
      }

      /*
       * Grades is deliberately absent from the registry (2026-08-21): one
       * semester on screen means a semester chosen for you is a semester you
       * did not ask for. It must still get its DATA message, or the table
       * stops being decorated.
       */
      {
        const pageMsgs = load("examinations/examGradeView/StudentGradeView");
        const dataMsgs = load("examinations/examGradeView/doStudentGradeView");
        ok(
          "the Grades page is never announced, but its data load still is",
          opens(pageMsgs) === null &&
            opens(dataMsgs) === null &&
            dataMsgs.some((m) => m.message === "exam_grade"),
          JSON.stringify({ pageMsgs, dataMsgs })
        );
      }

      /*
       * The attendance exclusion. These carry "StudentAttendance" as a
       * substring and the insights script fetches one PER ROW, so without the
       * third field in the registry each one would announce a freshly opened
       * picker — a dozen page-opens for one visit.
       */
      for (const path of [
        "processViewStudentAttendanceDetail",
        "academics/common/StudentAttendanceDetailDisplay",
      ]) {
        ok(
          path.split("/").pop() + " is a per-row fetch, not a page open",
          opens(load(path)) === null,
          JSON.stringify(load(path))
        );
      }
    }

    /*
     * The other half of the venue fix: the worker records the real search
     * request, so the background check replays the student's own POST instead
     * of a guessed one. Same mechanism that already learns the
     * attendance-detail endpoint.
     */
    const fireBefore = (details) =>
      onBefore.forEach((fn) => {
        try { fn(details); } catch { /* the other recorders ignore this shape */ }
      });
    fireBefore({
      method: "POST",
      url: VT + "examinations/doSearchExamScheduleForStudent",
      requestBody: {
        formData: {
          _csrf: ["stale-token"],
          authorizedID: ["24TEST0001"],
          x: ["Wed, 20 Aug 2026 00:00:00 GMT"],
          semesterSubId: ["AP2026271"],
        },
      },
    });
    const learned = store.vtopext_exam_search_request;
    ok(
      "the search request is learned from the student's own click",
      !!learned &&
        learned.path === "examinations/doSearchExamScheduleForStudent" &&
        learned.params.semesterSubId === "AP2026271",
      JSON.stringify(learned)
    );
    ok(
      "...without its credentials — a stored _csrf is stale by definition",
      !!learned &&
        !("_csrf" in learned.params) &&
        !("authorizedID" in learned.params) &&
        !("x" in learned.params),
      JSON.stringify(learned && learned.params)
    );

    /*
     * And the same for attendance, added 2026-08-22 so the home card's
     * "Refresh now" can replay the student's own request instead of navigating
     * to the page. The Detail/Display exclusion is the half that matters:
     * those fire once per subject, and recording one as "the attendance
     * request" would have the button replay a single row's history and find
     * no table at all.
     */
    fireBefore({
      method: "POST",
      url: VT + "processViewStudentAttendance",
      requestBody: {
        formData: {
          _csrf: ["stale-token"],
          authorizedID: ["24TEST0001"],
          x: ["Wed, 20 Aug 2026 00:00:00 GMT"],
          semesterSubId: ["AP2026272"],
        },
      },
    });
    const att = store.vtopext_attendance_request;
    ok(
      "the attendance request is learned, credentials stripped",
      !!att &&
        att.path === "processViewStudentAttendance" &&
        att.params.semesterSubId === "AP2026272" &&
        !("_csrf" in att.params) &&
        !("authorizedID" in att.params),
      JSON.stringify(att)
    );

    fireBefore({
      method: "POST",
      url: VT + "processViewStudentAttendanceDetail",
      requestBody: {
        formData: { semesterSubId: ["AP2026272"], classId: ["ECE2015"] },
      },
    });
    ok(
      "a per-subject detail POST never overwrites it",
      store.vtopext_attendance_request.path === "processViewStudentAttendance" &&
        !("classId" in store.vtopext_attendance_request.params),
      JSON.stringify(store.vtopext_attendance_request)
    );
  }

  /* ====== vrAutoSemester: the picker arrives AFTER the message ====== */
  console.log("\n=== vrAutoSemester: late DOM, and a second visit ===");
  {
    const semShell = async () => {
      const p = await newPage(browser);
      // deliberately EMPTY: onCompleted fires on the response, and VTOP's
      // jQuery writes the picker into the DOM after that, so the message
      // legitimately beats the markup it is announcing
      await p.setContent("<body><div id='main-section'></div></body>");
      await shim(p, { fixedMs: new Date("2026-08-20T09:00:00+05:30").getTime() });
      await inject(p, ["js/utils/chooseCurrentSem.js", "js/shared/auto_semester.js"]);
      await p.evaluate(() => {
        window.submits = [];
        window.__render = () => {
          document.getElementById("main-section").innerHTML =
            "<select id='semesterSubId'>" +
            "<option value=''>-- Choose Semester --</option>" +
            "<option value='AP1'>Fall Semester 2026-27 Freshers</option>" +
            "<option value='AP2'>Fall Semester 2026-27</option>" +
            "</select><button class='btn'>Search</button><div id='out'></div>";
          document.querySelector("#main-section button").addEventListener("click", () => {
            window.submits.push(document.getElementById("semesterSubId").value);
            document.getElementById("out").innerHTML =
              "<table><tr><td>Exam Date</td><td>Venue</td></tr></table>";
          });
        };
      });
      return p;
    };

    {
      const p = await semShell();
      await p.evaluate(() => {
        window.__dispatchMsg({ message: "semester_page_open", page: "exam_schedule" });
        // VTOP renders three quarters of a second later
        setTimeout(() => window.__render(), 750);
      });
      await delay(2000);
      const r = await p.evaluate(() => ({
        submits: window.submits,
        rendered: /Venue/.test(document.getElementById("out").innerText),
      }));
      ok(
        "a message that beats the DOM still opens the page once the picker lands",
        r.submits.length === 1 && r.rendered,
        JSON.stringify(r)
      );
      await p.close();
    }

    {
      // Revisit, which the old per-document Set could never allow: VTOP is a
      // single-page app, so opening Marks twice in one session is two page
      // opens against one document. The guard keys on the picker ELEMENT, and
      // VTOP builds a new one per render.
      const p = await semShell();
      await p.evaluate(() => {
        window.__render();
        window.__dispatchMsg({ message: "semester_page_open", page: "exam_schedule" });
      });
      await delay(1200);
      const first = await p.evaluate(() => window.submits.length);
      await p.evaluate(() => {
        window.__render(); // student navigates away and comes back
        window.__dispatchMsg({ message: "semester_page_open", page: "exam_schedule" });
      });
      await delay(1200);
      const second = await p.evaluate(() => window.submits.length);
      ok(
        "coming back to the page a second time is helped too, not just the first",
        first === 1 && second === 2,
        JSON.stringify({ first, second })
      );
      await p.close();
    }

    {
      // ...and the re-fired message on the SAME picker still must not re-submit.
      const p = await semShell();
      await p.evaluate(async () => {
        window.__render();
        for (let i = 0; i < 6; i++) {
          window.__dispatchMsg({ message: "semester_page_open", page: "exam_schedule" });
          await new Promise((r) => setTimeout(r, 80));
        }
      });
      await delay(1500);
      const n = await p.evaluate(() => window.submits.length);
      ok("six re-fired messages on one picker are still one search", n === 1, String(n));
      await p.close();
    }
  }

  /* ====== the venue watcher, off the exam schedule page ====== */
  console.log("\n=== venue watcher: mails without the exam schedule page open ===");
  {
    // Reported 2026-08-20: "it waited until i open the exam schedule to mail
    // me when the venue got updated". This is any OTHER VTOP page — an
    // attendance page, say — with no schedule table anywhere on it.
    const fixed = new Date("2026-04-01T09:00:00+05:30").getTime();
    const SCHEDULE = (venue) =>
      "<html><body><table class='customTable'>" +
      "<tr><td>S.No.</td><td>Course Code</td><td>Course Title</td><td>Course Type</td>" +
      "<td>Class ID</td><td>Slot</td><td>Exam Date</td><td>Exam Session</td>" +
      "<td>Reporting Time</td><td>Exam Time</td><td>Venue</td><td>Seat Location</td><td>Seat No.</td></tr>" +
      "<tr><td class='panelHead-secondary'>FAT</td></tr>" +
      "<tr><td>1</td><td>ECE2015</td><td>Computer Architecture</td><td>ETH</td><td>AP1</td><td>A1</td>" +
      "<td>04-May-2026</td><td>FN1</td><td>09:30 AM</td><td>10:00 AM - 01:00 PM</td><td>" + venue +
      "</td><td>R3C1</td><td>5</td></tr></table></body></html>";

    const seed = (over = {}) => ({
      vtopext_exam_mail_state: {
        optIn: true,
        // last mailed with no venue — so a real one reads as a change
        sent: { "FAT|ECE2015|2026-05-04": "" },
      },
      vtopext_exam_schedule: {
        fetchedAt: fixed - 86400000,
        semester: "Winter Semester 2025-26",
        semesterId: "AP2025264",
        exams: [{ type: "FAT", code: "ECE2015", dateIso: "2026-05-04", venue: "-" }],
      },
      vtopext_exam_search_request: {
        path: "examinations/doSearchExamScheduleForStudent",
        // a stale semester from an older search: the CACHE is the authority
        params: { semesterSubId: "AP2024OLD" },
      },
      ...over,
    });

    const elsewhere = async (storage, opts = {}) => {
      const p = await newPage(browser);
      await p.setContent(
        "<body><div class='navbar-text text-light small fw-bold'>24TEST0001 (STUDENT)</div>" +
          (opts.signedOut ? "" : "<input name='_csrf' value='live-token'>") +
          "<div id='main-section'><h4>Class Attendance</h4></div></body>"
      );
      await shim(p, { fixedMs: fixed, storage });
      await inject(p, [
        "js/shared/click.js",
        "js/shared/ics.js",
        "js/shared/google_auth.js",
        "js/shared/vtop.js",
        "js/exam_schedule.js",
      ]);
      await p.evaluate((html) => {
        window.__mails = [];
        window.__posts = [];
        window.fetch = (url, init) => {
          window.__posts.push({ url, body: String((init && init.body) || "") });
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(html) });
        };
      }, SCHEDULE(opts.venue === undefined ? "CB-324" : opts.venue));
      return p;
    };

    {
      const p = await elsewhere(seed());
      await p.evaluate(() => window.__dispatch("nav_bar_change"));
      await delay(1500);
      const r = await p.evaluate(() => ({
        posts: window.__posts,
        mails: (window.__mails || []).map((m) => ({
          subject: m.subject, html: m.html, interactive: m.interactive,
        })),
        cache: window.__storage.vtopext_exam_schedule,
      }));
      ok(
        "it asks VTOP itself, from a page with no schedule on it",
        r.posts.length === 1 && /doSearchExamScheduleForStudent$/.test(r.posts[0].url),
        JSON.stringify(r.posts.map((x) => x.url))
      );
      ok(
        "with the semester from the cache, not the one the old search used",
        r.posts.length === 1 &&
          /semesterSubId=AP2025264/.test(r.posts[0].body) &&
          !/AP2024OLD/.test(r.posts[0].body),
        (r.posts[0] || {}).body
      );
      ok(
        "and mails the newly published venue, same format as the manual send",
        r.mails.length === 1 &&
          /venue published for 1 exam/.test(r.mails[0].subject) &&
          /CB-324/.test(r.mails[0].html),
        JSON.stringify(r.mails.map((m) => m.subject))
      );
      ok(
        "never interactive — a page load must not open a Google window",
        r.mails.length === 1 && r.mails[0].interactive === false,
        JSON.stringify(r.mails.map((m) => m.interactive))
      );
      ok(
        "the cached schedule is refreshed too, so .ics and the digest agree",
        !!r.cache && (r.cache.exams || []).some((e) => e.venue === "CB-324"),
        JSON.stringify(r.cache && r.cache.exams)
      );

      // ...and it must not ask again on the next page. One POST per window.
      await p.evaluate(() => { window.__mails = []; window.__dispatch("nav_bar_change"); });
      await delay(1000);
      const again = await p.evaluate(() => ({
        posts: window.__posts.length, mails: window.__mails.length,
      }));
      ok(
        "the next page load in the same window asks nothing",
        again.posts === 1 && again.mails === 0,
        JSON.stringify(again)
      );
      await p.close();
    }

    {
      // The opt-in guarantee still holds off the exam page: no press, no traffic.
      const p = await elsewhere(seed({ vtopext_exam_mail_state: { optIn: false, sent: {} } }));
      await p.evaluate(() => window.__dispatch("nav_bar_change"));
      await delay(1000);
      const r = await p.evaluate(() => ({
        posts: window.__posts.length, mails: (window.__mails || []).length,
      }));
      ok(
        "the mail button never pressed: nothing is fetched and nothing is sent",
        r.posts === 0 && r.mails === 0,
        JSON.stringify(r)
      );
      await p.close();
    }

    {
      // A page with no session must not POST at all — that is the request
      // shape that returns 404s and damages the session.
      const p = await elsewhere(seed(), { signedOut: true });
      await p.evaluate(() => window.__dispatch("nav_bar_change"));
      await delay(1000);
      const posts = await p.evaluate(() => window.__posts.length);
      ok("signed out (no _csrf on the page): it does not ask", posts === 0, String(posts));
      await p.close();
    }

    {
      // Exam season over: nothing ahead in the cache, so no reason to look.
      const p = await elsewhere(
        seed({
          vtopext_exam_schedule: {
            fetchedAt: fixed,
            semester: "Winter Semester 2025-26",
            semesterId: "AP2025264",
            exams: [{ type: "FAT", code: "ECE2015", dateIso: "2026-01-04", venue: "CB-1" }],
          },
        })
      );
      await p.evaluate(() => window.__dispatch("nav_bar_change"));
      await delay(1000);
      const posts = await p.evaluate(() => window.__posts.length);
      ok("no exam still ahead: it does not ask", posts === 0, String(posts));
      await p.close();
    }

    {
      // Still "-" in the reply: checked, correctly silent. The 2026-08-19
      // ROADMAP note about CAT-1 venues reading "-" is this case.
      const p = await elsewhere(seed(), { venue: "-" });
      await p.evaluate(() => window.__dispatch("nav_bar_change"));
      await delay(1500);
      const r = await p.evaluate(() => ({
        posts: window.__posts.length, mails: (window.__mails || []).length,
      }));
      ok(
        "a venue still unpublished is checked and mails nothing",
        r.posts === 1 && r.mails === 0,
        JSON.stringify(r)
      );
      await p.close();
    }
  }

  /* ====== the role chooser: press Student, so a recovery lands on the form ===
   *
   * Reported 2026-08-20: "the previous reloaded the homepage not this page".
   * True — /vtop/login is REACHED BY POSTing the chooser, so re-GETting it can
   * land the student back on Student/Employee/Parent/Alumni, which is the
   * original complaint rather than a recovery. The missing step was never a
   * better reload; it was pressing Student afterwards.
   *
   * Markup read live off /vtop/open/page, 2026-08-20:
   *   #stdForm     POST /vtop/prelogin/setup  _csrf + flag=VTOP    "Student"
   *   #empForm     POST /vtop/prelogin/setup  _csrf + flag=VTOP    "Employee"
   *   #parentForm  POST /vtop/prelogin/setup  _csrf + flag=parent  "Parent"
   *
   * Student and Employee send byte-identical bodies, so this cannot pick the
   * wrong role: the role is not in the request at all.
   *
   * Served from a routed host rather than setContent: this code keeps its
   * whole budget in sessionStorage, and an about:blank document has an opaque
   * origin where reading it throws.
   */
  console.log("\n=== the role chooser: Student is pressed, once, and escapably ===");
  {
    // The labels are part of the fixture on purpose. The live chooser reads
    // "Student"/"Employee"/"Parent"/"Alumni" beside each form, so its body has
    // visible text — and the pre-existing reload rule keys off exactly that
    // (`rendered`). A label-less fixture would have made the old code reload
    // here, which the real page never does, and every assertion below would
    // have been measured against a document VIT-AP does not serve.
    const roleForm = (id, flag, label, cls) =>
      "<div>" + label +
      "<form id='" + id + "' action='/vtop/prelogin/setup' method='post'>" +
      "<input type='hidden' name='_csrf' value='tok'>" +
      "<input type='hidden' name='flag' value='" + flag + "'>" +
      "<input type='submit' class='" + cls + "'></form></div>";

    const PICKER =
      "<body>" +
      roleForm("stdForm", "VTOP", "Student", "btn btn-primary fw-bold") +
      roleForm("empForm", "VTOP", "Employee", "btn btn-outline employeeBtnColor fw-bold") +
      roleForm("parentForm", "parent", "Parent", "btn btn-success fw-bold") +
      roleForm("alumniForm", "alumni", "Alumni", "btn btn-info fw-bold") +
      "</body>";

    const LOGIN_HIDDEN_PICKER =
      "<body><form id='vtopLoginForm' action='/vtop/login'>" +
      "<input name='_csrf' type='hidden' value='tok'>" +
      "<input name='username'><input name='password' type='password'>" +
      "<input type='hidden' name='gResponse'>" +
      "<button id='submitBtn'>Submit</button></form>" +
      "<form id='stdForm' style='display:none' action='/vtop/prelogin/setup'>" +
      "<input type='hidden' name='_csrf' value='tok'>" +
      "<input type='hidden' name='flag' value='VTOP'>" +
      "<input type='submit'></form></body>";

    const LOGIN_RECAPTCHA =
      "<body><form id='vtopLoginForm' action='/vtop/login'>" +
      "<input name='_csrf' type='hidden' value='tok'>" +
      "<input name='username'><input name='password' type='password'>" +
      "<input type='hidden' name='gResponse' value=''>" +
      "<textarea name='g-recaptcha-response'></textarea>" +
      "<button id='submitBtn'>Submit</button></form>" +
      "<div class='grecaptcha-badge'></div></body>";

    const OTP_STEP =
      "<body><p>An OTP has been sent to your email</p>" +
      "<form id='stdForm' action='/vtop/prelogin/setup'>" +
      "<input type='hidden' name='_csrf' value='tok'>" +
      "<input type='hidden' name='flag' value='VTOP'>" +
      "<input type='submit'></form></body>";

    /*
     * The submit is intercepted rather than performed: a real navigation would
     * take the fixture away, and what is asserted is WHICH form goes.
     * `seed` writes sessionStorage before the script runs, standing in for
     * what an earlier page in the same tab would have left behind.
     */
    /*
     * `from` makes the arrival realistic. The escape hatch keys on HOW the
     * chooser was reached, so a fixture that always arrives out of nowhere
     * cannot exercise it: the page is reached by a real click from `from`,
     * which is what sets document.referrer.
     */
    const chooser = async (html, seed, from) => {
      const p = await newPage(browser);
      await p.route("https://vtop-role.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: route.request().url().includes("/vtop/login")
            ? "<body><a id='home' href='/vtop/open/page'>Go to Home Page</a></body>"
            : html,
        })
      );
      if (from) {
        await p.goto("https://vtop-role.test" + from);
        await p.click("#home");
        await p.waitForURL("**/vtop/open/page");
      } else {
        await p.goto("https://vtop-role.test/vtop/open/page");
      }
      await p.evaluate((s) => {
        window.__submitted = [];
        [...document.forms].forEach((f) =>
          f.addEventListener("submit", (e) => {
            e.preventDefault();
            window.__submitted.push(f.id);
          })
        );
        /*
         * Reload is trapped, not allowed to happen (2026-08-22). Since the
         * reCAPTCHA branch started reloading, a fixture carrying a hidden
         * gResponse would navigate away mid-assertion and take window.
         * __submitted with it — the crash that exposed this. Counting the
         * calls keeps both questions answerable on one page: did it press
         * Student, and did it reload.
         */
        window.__reloads = 0;
        try {
          Object.defineProperty(window.location, "reload", {
            configurable: true,
            value: () => {
              window.__reloads++;
            },
          });
        } catch {
          /* some engines refuse; the submit trap still answers the main question */
        }
        Object.entries(s || {}).forEach(([k, v]) => sessionStorage.setItem(k, v));
      }, seed || {});
      await shim(p);
      await inject(p, ["js/captcha/refreshTillCaptcha.js"]);
      await delay(500);
      return p;
    };

    const readState = (p) =>
      p.evaluate(() => ({
        submitted: window.__submitted || [],
        reloadCalls: window.__reloads,
        reloads: sessionStorage.getItem("vtopext_login_reloads"),
        picked: sessionStorage.getItem("vtopext_role_autopick"),
      }));

    {
      const p = await chooser(PICKER);
      const r = await readState(p);
      ok(
        "the chooser is advanced by pressing Student, not Employee or Parent",
        r.submitted.length === 1 && r.submitted[0] === "stdForm",
        JSON.stringify(r)
      );
      ok(
        "and it is counted against the same budget as the reload",
        r.reloads === "1" && !!r.picked,
        JSON.stringify(r)
      );
      await p.close();
    }

    {
      /*
       * THE ESCAPE HATCH. Somebody who walks BACK to the chooser from the
       * login form — by the card's "Go to Home Page" link, or the Back button
       * — is going for Employee, Parent or Alumni. If this fired again they
       * could never reach those pages at all.
       *
       * Keyed on how the page was REACHED, never on a clock. The cooldown this
       * replaced also suppressed every ordinary repeat visit, which is how the
       * feature came to look broken to the person testing it (2026-08-20).
       */
      const p = await chooser(PICKER, null, "/vtop/login");
      const r = await readState(p);
      ok(
        "walking back from the login form is left alone — Employee stays reachable",
        r.submitted.length === 0,
        JSON.stringify(r)
      );
      await p.close();
    }

    {
      /*
       * THE REGRESSION THAT PROMPTED THE REWRITE. Having been advanced once,
       * the SECOND ordinary arrival must be helped exactly like the first —
       * a student opening VTOP again, and equally the person checking whether
       * the feature works. The old cooldown failed this for two minutes.
       */
      const p = await chooser(PICKER, {
        vtopext_role_autopick: String(Date.now() - 1000), // advanced a second ago
      });
      const r = await readState(p);
      ok(
        "a fresh arrival right after a previous one is still helped",
        r.submitted.length === 1 && r.submitted[0] === "stdForm",
        JSON.stringify(r)
      );
      await p.close();
    }

    {
      // A chooser that keeps coming back must stop, or it is the loop the
      // 2026-08-07 freeze was made of.
      // the budget is MAX_RELOADS, raised to 5 on 2026-08-22 when the captcha
      // hunt started drawing on the same counter
      const p = await chooser(PICKER, { vtopext_login_reloads: "5" });
      const r = await readState(p);
      ok(
        "with the reload budget spent it stops rather than ping-ponging",
        r.submitted.length === 0,
        JSON.stringify(r)
      );
      await p.close();
    }

    {
      /*
       * THE REGRESSION THAT MATTERS MOST. /vtop/login ships a HIDDEN #stdForm
       * of its own. A first cut of the 2026-08-07 reload rule missed that and
       * put the login page into a loop — so this must never fire where a
       * #vtopLoginForm exists, hidden chooser or not.
       */
      const p = await chooser(LOGIN_HIDDEN_PICKER);
      const r = await readState(p);
      /*
       * The property is that Student is never PRESSED here — a login page is
       * not a chooser, hidden #stdForm or not. Since 2026-08-22 this fixture
       * also carries a hidden gResponse, so the captcha hunt legitimately
       * reloads it; that is a different branch and is asserted separately
       * above. What must never happen is the submit.
       */
      ok(
        "the login page's own hidden #stdForm is never mistaken for the chooser",
        r.submitted.length === 0 && r.picked === null,
        JSON.stringify(r)
      );
      await p.close();
    }

    {
      /*
       * The live login shape: invisible reCAPTCHA, no captcha input at all.
       *
       * REWRITTEN 2026-08-22. It used to require the counter CLEARED and
       * nothing done, because the page renders exactly as VTOP intends. It
       * does — and it still cannot be logged in from, so the page is now
       * reloaded to hunt for the image variant. The half that never changes is
       * that this is a login form and not a chooser: Student is not pressed
       * and no role is recorded, whatever the captcha situation.
       */
      const p = await chooser(LOGIN_RECAPTCHA, { vtopext_login_reloads: "2" });
      const r = await readState(p);
      ok(
        "invisible reCAPTCHA: no role is pressed, and the hunt is counted",
        r.submitted.length === 0 &&
          r.picked === null &&
          Number(r.reloads) > 2 &&
          Number(r.reloads) <= 5,
        JSON.stringify(r)
      );
      await p.close();
    }

    {
      // The OTP step is served at /vtop/login/error, which this script also
      // runs on. VTOP has already mailed a code; nothing may be touched.
      const p = await chooser(OTP_STEP);
      const r = await readState(p);
      ok(
        "an OTP page is never advanced — a navigation there bins the mailed code",
        r.submitted.length === 0,
        JSON.stringify(r)
      );
      await p.close();
    }

    // The manifest has to actually run this file where the chooser lives.
    {
      const mf = JSON.parse(read("manifest.json"));
      const entry = (mf.content_scripts || []).find((c) =>
        (c.js || []).some((j) => /refreshTillCaptcha/.test(j))
      );
      ok(
        "the chooser page is in the manifest, or none of the above ever runs",
        !!entry && entry.matches.some((m) => /\/vtop\/open\/page/.test(m)),
        JSON.stringify(entry && entry.matches)
      );
    }
  }

  /* ====== venue check: the paths the first round of tests never entered ======
   *
   * Audit gap found 2026-08-20. The first block always seeded a learned search
   * request, always answered 200, and always triggered by message — so the
   * fallback endpoint, the circuit breaker, the in-flight guard, the load-time
   * trigger and the semesterId write were all unexercised.
   */
  console.log("\n=== venue check: fallback endpoint, breaker, and the load-time trigger ===");
  {
    const fixed = new Date("2026-04-01T09:00:00+05:30").getTime();
    const SCHEDULE =
      "<html><body><table class='customTable'>" +
      "<tr><td>S.No.</td><td>Course Code</td><td>Course Title</td><td>Course Type</td>" +
      "<td>Class ID</td><td>Slot</td><td>Exam Date</td><td>Exam Session</td>" +
      "<td>Reporting Time</td><td>Exam Time</td><td>Venue</td><td>Seat Location</td><td>Seat No.</td></tr>" +
      "<tr><td class='panelHead-secondary'>FAT</td></tr>" +
      "<tr><td>1</td><td>ECE2015</td><td>Computer Architecture</td><td>ETH</td><td>AP1</td><td>A1</td>" +
      "<td>04-May-2026</td><td>FN1</td><td>09:30 AM</td><td>10:00 AM - 01:00 PM</td><td>CB-324</td>" +
      "<td>R3C1</td><td>5</td></tr></table></body></html>";

    const baseStore = (over = {}) => ({
      vtopext_exam_mail_state: { optIn: true, sent: { "FAT|ECE2015|2026-05-04": "" } },
      vtopext_exam_schedule: {
        fetchedAt: fixed - 86400000,
        semester: "Winter Semester 2025-26",
        semesterId: "AP2025264",
        exams: [{ type: "FAT", code: "ECE2015", dateIso: "2026-05-04", venue: "-" }],
      },
      ...over,
    });

    // a VTOP page that is not the exam schedule, with a live-looking session
    const otherPage = async (storage, reply) => {
      const p = await newPage(browser);
      await p.setContent(
        "<body><div class='navbar-text text-light small fw-bold'>24TEST0001 (STUDENT)</div>" +
          "<input name='_csrf' value='live-token'>" +
          "<div id='main-section'><h4>Class Attendance</h4></div></body>"
      );
      await shim(p, { fixedMs: fixed, storage });
      await inject(p, [
        "js/shared/click.js", "js/shared/ics.js", "js/shared/google_auth.js",
        "js/shared/vtop.js", "js/exam_schedule.js",
      ]);
      await p.evaluate((r) => {
        window.__mails = [];
        window.__posts = [];
        window.fetch = (url, init) => {
          window.__posts.push({ url, body: String((init && init.body) || "") });
          if (r.hang) return new Promise(() => {}); // never settles
          return Promise.resolve({
            ok: r.status === 200,
            status: r.status,
            text: () => Promise.resolve(r.body || ""),
          });
        };
      }, reply);
      return p;
    };

    /*
     * NOTHING LEARNED YET — the state every student is in until they open the
     * exam schedule page once. The named endpoint is the fallback, and it must
     * be sent as a `probe` so that a wrong guess on some other VTOP deployment
     * cannot trip the breaker and silence every other VTOP Extension feature.
     */
    {
      const p = await otherPage(baseStore(), { status: 200, body: SCHEDULE });
      await p.evaluate(() => window.__dispatch("nav_bar_change"));
      await delay(1500);
      const r = await p.evaluate(() => ({
        posts: window.__posts.map((x) => x.url),
        body: (window.__posts[0] || {}).body || "",
        mails: (window.__mails || []).length,
      }));
      ok(
        "with no request ever recorded it falls back to the named endpoint",
        r.posts.length === 1 &&
          /examinations\/doSearchExamScheduleForStudent$/.test(r.posts[0]) &&
          /semesterSubId=AP2025264/.test(r.body) &&
          r.mails === 1,
        JSON.stringify(r)
      );
      await p.close();
    }

    {
      // ...and when that guess is wrong, the 404 must not trip the breaker.
      const p = await otherPage(baseStore(), { status: 404, body: "not found" });
      await p.evaluate(() => window.__dispatch("nav_bar_change"));
      await delay(1200);
      const r = await p.evaluate(() => ({
        posts: window.__posts.length,
        tripped: window.vrVtop.tripped,
        banner: !!document.getElementById("vtopext-session-banner"),
        mails: (window.__mails || []).length,
      }));
      ok(
        "a 404 from the guessed endpoint is a probe: no breaker, no red banner",
        r.posts === 1 && r.tripped === false && r.banner === false && r.mails === 0,
        JSON.stringify(r)
      );
      await p.close();
    }

    {
      /*
       * A RECORDED request that 404s is different — that is real news, and the
       * breaker must count it. Three of them and VTOP Extension stops talking to VTOP.
       * The rate-limit key is cleared between tries to stand in for three page
       * loads three hours apart.
       */
      const p = await otherPage(
        baseStore({
          vtopext_exam_search_request: {
            path: "examinations/doSearchExamScheduleForStudent",
            params: {},
          },
        }),
        { status: 404, body: "not found" }
      );
      for (let i = 0; i < 4; i++) {
        await p.evaluate(() => {
          delete window.__storage.vtopext_exam_bg_check;
          window.__dispatch("nav_bar_change");
        });
        await delay(500);
      }
      const r = await p.evaluate(() => ({
        posts: window.__posts.length,
        tripped: window.vrVtop.tripped,
      }));
      ok(
        "a recorded request that keeps 404ing trips the breaker and stops",
        r.tripped === true && r.posts === 3,
        JSON.stringify(r)
      );
      await p.close();
    }

    {
      // THE RATE LIMIT IS THE POINT, so it is asserted without the clear above:
      // four arrivals in a row, one request.
      const p = await otherPage(baseStore(), { status: 404, body: "no" });
      for (let i = 0; i < 4; i++) {
        await p.evaluate(() => window.__dispatch("nav_bar_change"));
        await delay(300);
      }
      const posts = await p.evaluate(() => window.__posts.length);
      ok("four page arrivals in one window are still one request", posts === 1, String(posts));
      await p.close();
    }

    {
      // In-flight guard: a slow VTOP must not collect a queue of duplicates.
      const p = await otherPage(baseStore(), { hang: true });
      await p.evaluate(() => {
        window.__dispatch("nav_bar_change");
        window.__dispatch("vtop2_nav_bar");
        window.__dispatch("view_attendance_page");
      });
      await delay(800);
      const posts = await p.evaluate(() => window.__posts.length);
      ok(
        "three triggers while one request is still in flight send one request",
        posts === 1,
        String(posts)
      );
      await p.close();
    }

    {
      /*
       * The load-time trigger. The messages are routed off specific URLs, so a
       * student who lands somewhere unrouted would otherwise get nothing —
       * this is the path that needs no message at all.
       */
      const p = await otherPage(baseStore(), { status: 200, body: SCHEDULE });
      await delay(7000); // the timer is 6 s after the content script loads
      const r = await p.evaluate(() => ({
        posts: window.__posts.length,
        mails: (window.__mails || []).length,
      }));
      ok(
        "it also runs once per page with no message at all",
        r.posts === 1 && r.mails === 1,
        JSON.stringify(r)
      );
      await p.close();
    }
  }

  /* ====== semesterId: the field the whole background check bootstraps from ====== */
  console.log("\n=== the exam page records the semester ID, not just its name ===");
  {
    const fixed = new Date("2026-04-01T09:00:00+05:30").getTime();
    const p = await newPage(browser);
    await p.setContent(
      "<body><select id='semesterSubId'>" +
        "<option value=''>-- Choose Semester --</option>" +
        "<option value='AP2025264' selected>Winter Semester 2025-26</option></select>" +
        "<table class='customTable'>" +
        "<tr><td>S.No.</td><td>Course Code</td><td>Course Title</td><td>Course Type</td>" +
        "<td>Class ID</td><td>Slot</td><td>Exam Date</td><td>Exam Session</td>" +
        "<td>Reporting Time</td><td>Exam Time</td><td>Venue</td><td>Seat Location</td><td>Seat No.</td></tr>" +
        "<tr><td class='panelHead-secondary'>FAT</td></tr>" +
        "<tr><td>1</td><td>ECE2015</td><td>Computer Architecture</td><td>ETH</td><td>AP1</td><td>A1</td>" +
        "<td>04-May-2026</td><td>FN1</td><td>09:30 AM</td><td>10:00 AM - 01:00 PM</td><td>CB-324</td>" +
        "<td>R3C1</td><td>5</td></tr></table></body>"
    );
    await shim(p, { fixedMs: fixed });
    await inject(p, [
      "js/shared/click.js", "js/shared/ics.js", "js/shared/google_auth.js",
      "js/shared/vtop.js", "js/exam_schedule.js",
    ]);
    await p.evaluate(() => window.__dispatch("exam_schedule"));
    await delay(1200);
    const cache = await p.evaluate(() => window.__storage.vtopext_exam_schedule);
    ok(
      "opening the exam page records the semester ID the background check needs",
      !!cache &&
        cache.semesterId === "AP2025264" &&
        cache.semester === "Winter Semester 2025-26",
      JSON.stringify(cache && { semester: cache.semester, semesterId: cache.semesterId })
    );
    await p.close();
  }

  /* ====== the three page shapes that were MOVED, not written ======
   *
   * Audit gap found 2026-08-20: the registry test above only ever dispatches
   * page "exam_schedule", so PAGES.mark_view / exam_grade / timetable_view —
   * the three predicates lifted out of marks_page.js, grade_pages.js and
   * timetable.js — were executed by nothing. Moving code is exactly where a
   * silent typo lands: the timetable predicate turned out to have been
   * carrying two literal 0x08 bytes where \b was meant, and nothing caught it
   * because nothing ran it.
   *
   * Each page is checked BOTH ways: it fires on its own shape, and it does not
   * consider the bare picker "already loaded" (which would make it a no-op
   * forever).
   */
  /* ============ popup ID + password beat Chrome's autofill on the login page ============ */
  console.log("\n=== login fill: the popup's credentials win, and typing stops it ===");
  {
    const FORM =
      "<body><form id='vtopLoginForm'><input name='username' type='text'>" +
      "<input name='password' type='password'></form></body>";
    const open = async (seed, afterInject) => {
      const p = await newPage(browser);
      await p.setContent(FORM);
      await shim(p, { storage: seed });
      await inject(p, ["js/login_fill.js"]);
      if (afterInject) await afterInject(p);
      return p;
    };
    const vals = (p) =>
      p.evaluate(() => ({
        u: document.querySelector("[name=username]").value,
        w: document.querySelector("[name=password]").value,
        auto: document.querySelector("[name=password]").getAttribute("autocomplete"),
      }));
    const creds = { vtopext_vtop_login: { id: "24TEST0001", pass: "from-popup" } };

    // 1. filled, and Chrome's late autofill is overwritten again
    let p = await open(creds, async (pg) => {
      await delay(600);
      await pg.evaluate(() => {
        document.querySelector("[name=username]").value = "chrome-saved";
        document.querySelector("[name=password]").value = "chrome-pass";
      });
      await delay(900);
    });
    let v = await vals(p);
    ok("saved ID and password are filled in", v.u === "24TEST0001" && v.w === "from-popup", JSON.stringify(v));
    ok("Chrome's later autofill does not win", v.u !== "chrome-saved" && v.w !== "chrome-pass");
    ok("the password field is told not to autofill", v.auto === "new-password", String(v.auto));
    await p.close();

    // 2. a real keystroke stops it
    p = await open(creds, async (pg) => {
      await delay(500);
      await pg.focus("[name=username]");
      await pg.keyboard.press("End");
      await pg.keyboard.type("X");
      await delay(900);
    });
    v = await vals(p);
    ok("typing hands control back: the person's edit survives", v.u === "24TEST0001X", JSON.stringify(v));
    await p.close();

    // 3. nothing saved, nothing touched
    p = await open({}, async () => delay(700));
    v = await vals(p);
    ok("with nothing saved the fields are left alone", v.u === "" && v.w === "", JSON.stringify(v));
    await p.close();

    // 4. the form arriving late is still filled
    p = await newPage(browser);
    await p.setContent("<body><div id='slot'></div></body>");
    await shim(p, { storage: creds });
    await inject(p, ["js/login_fill.js"]);
    await delay(700);
    await p.evaluate((html) => { document.getElementById("slot").innerHTML = html; }, FORM.replace(/<\/?body>/g, ""));
    await delay(900);
    v = await vals(p);
    ok("a login form that appears after load is filled too", v.u === "24TEST0001" && v.w === "from-popup", JSON.stringify(v));
    await p.close();
  }

  console.log("\n=== popup: save and clear the VTOP sign-in ===");
  {
    const p = await newPage(browser);
    await p.setContent(
      "<body><input id='vr-login-id'><input id='vr-login-pass' type='password'>" +
      "<button id='vr-login-save'></button><button id='vr-login-clear'></button><div id='vr-login-status'></div></body>"
    );
    await shim(p, {});
    await inject(p, ["js/popup_login.js"]);
    const stored = () => p.evaluate(() => window.__storage.vtopext_vtop_login || null);
    await p.fill("#vr-login-id", "24TEST0001");
    await p.click("#vr-login-save");
    await delay(150);
    ok("saving with no password is refused and stores nothing", (await stored()) === null);
    await p.fill("#vr-login-pass", "s3cret");
    await p.click("#vr-login-save");
    await delay(150);
    const saved = await stored();
    ok("ID and password are stored", saved && saved.id === "24TEST0001" && saved.pass === "s3cret", JSON.stringify(saved));
    const shown = await p.evaluate(() => ({
      pass: document.getElementById("vr-login-pass").value,
      ph: document.getElementById("vr-login-pass").placeholder,
    }));
    ok("the password is never shown back", shown.pass === "" && /saved/.test(shown.ph), JSON.stringify(shown));
    await p.fill("#vr-login-id", "24TEST0002");
    await p.click("#vr-login-save");
    await delay(150);
    const kept = await stored();
    ok("changing only the ID keeps the saved password", kept && kept.id === "24TEST0002" && kept.pass === "s3cret", JSON.stringify(kept));
    await p.click("#vr-login-clear");
    await delay(150);
    ok("clear removes both", (await stored()) === null);
    await p.close();
  }

  /* ============ popup: update check against the GitHub manifest ============ */
  console.log("\n=== popup: says so when GitHub has a newer version ===");
  {
    const run = async (remote) => {
      const p = await newPage(browser);
      await p.setContent("<body><div id='vr-version'></div><button id='vr-open-vtop'></button><div id='vr-update' hidden></div><a id='vr-link-repo' hidden></a><a id='vr-link-issues' hidden></a></body>");
      await shim(p, {});
      await p.evaluate((remoteVersion) => {
        chrome.runtime.getManifest = () => ({ version: "4.6.0" });
        chrome.tabs = { create: () => {} };
        window.fetch = async (url) => {
          // the project location now comes from config.json, not from code
          if (/config\.json$/.test(String(url)))
            return { ok: true, json: async () => (remoteVersion === "NOCONFIG" ? {} : { repo: "owner/project", branch: "main" }) };
          (window.__fetched = window.__fetched || []).push(String(url));
          if (remoteVersion === "FAIL") throw new Error("offline");
          return { ok: true, json: async () => ({ version: remoteVersion }) };
        };
      }, remote);
      await inject(p, ["js/popup_meta.js"]);
      await delay(300);
      const r = await p.evaluate(() => ({
        fetched: window.__fetched || [],
        links: ["vr-link-repo", "vr-link-issues"].map((id) => (document.getElementById(id) || {}).href).join("|"),
        shown: !document.getElementById("vr-update").hidden,
        text: document.getElementById("vr-update").textContent,
        newer: [window.vrIsNewerVersion("4.10.0", "4.9.9"), window.vrIsNewerVersion("4.6.0", "4.6.0"), window.vrIsNewerVersion("4.5.20", "4.6.0")],
      }));
      await p.close();
      return r;
    };
    const newer = await run("4.7.0");
    ok("a newer GitHub version shows the banner with the version", newer.shown && /v4\.7\.0/.test(newer.text), JSON.stringify(newer));
    ok("versions compare numerically, not as text", JSON.stringify(newer.newer) === "[true,false,false]", JSON.stringify(newer.newer));
    const same = await run("4.6.0");
    ok("the same version shows nothing", !same.shown, JSON.stringify(same));
    const failed = await run("FAIL");
    ok("an offline check is silent", !failed.shown, JSON.stringify(failed));
    const none = await run("NOCONFIG");
    ok("no repo in config.json means no check and no banner", !none.shown && none.fetched.length === 0, JSON.stringify(none));
    ok("the check reads the repo and branch from config.json", newer.fetched.length === 1 && newer.fetched[0] === "https://raw.githubusercontent.com/owner/project/main/manifest.json", JSON.stringify(newer.fetched));
    ok("footer links are filled from config.json", newer.links === "https://github.com/owner/project|https://github.com/owner/project/issues", String(newer.links));
  }

  /* ============ page-open beats the DOM: the previous page's picker is still there ============
   * SEEN LIVE 2026-10-10 (Attendance -> Marks View, Attendance -> DA Upload):
   * the worker's semester_page_open message arrives BEFORE VTOP draws the new
   * page, so the only picker on screen was the previous page's, already
   * answered. Auto-semester read that as "somebody answered it" and gave up. */
  console.log("\n=== auto-semester: a stale answered picker from the page just left ===");
  {
    const p = await newPage(browser);
    await p.setContent("<body><div id='main-section'></div></body>");
    await shim(p, { fixedMs: new Date("2026-08-20T09:00:00+05:30").getTime() });
    await inject(p, ["js/utils/chooseCurrentSem.js", "js/shared/auto_semester.js"]);
    await p.evaluate(() => {
      window.submits = [];
      const picker = (answered) =>
        "<select id='semesterSubId'>" +
        "<option value=''>-- Choose Semester --</option>" +
        "<option value='AP1'>Fall Semester 2026-27 Freshers</option>" +
        "<option value='AP2'" + (answered ? " selected" : "") + ">Fall Semester 2026-27</option>" +
        "</select>";
      // the PREVIOUS page, answered
      document.getElementById("main-section").innerHTML = picker(true);
      // the new page lands half a second after the message
      setTimeout(() => {
        document.getElementById("main-section").innerHTML = picker(false);
        document
          .getElementById("semesterSubId")
          .addEventListener("change", () =>
            window.submits.push(document.getElementById("semesterSubId").value)
          );
      }, 500);
      window.__started = window.vrAutoSemesterFor("mark_view", { waitMs: 8000 });
    });
    await delay(2500);
    const r = await p.evaluate(() => ({
      submits: window.submits,
      sel: document.getElementById("semesterSubId").selectedIndex,
    }));
    ok(
      "the replacement picker is answered once, not skipped as 'already answered'",
      r.submits.length === 1 && r.sel > 0,
      JSON.stringify(r)
    );
    await p.close();
  }

  console.log("\n=== the page registry: every shape, not just the exam one ===");
  {
    // what VTOP renders for that page once a semester is chosen
    const RENDERS = {
      mark_view:
        "<table><tr><td>Course Code</td><td>Course Title</td></tr>" +
        "<tr><td>CSE1005</td><td>Software Engineering</td></tr></table>",
      attendance:
        "<div class='table-responsive'><table>" +
        "<thead><tr><th>Course</th><th>Attended Classes</th><th>Total Classes</th></tr></thead>" +
        "<tbody><tr><td>ECE2015</td><td>40</td><td>50</td></tr></tbody></table></div>",
      timetable_view:
        "<table><tr><td>Slot</td><td>Course</td></tr><tr><td>A1</td><td>Theory</td></tr></table>",
      exam_schedule: "<table><tr><td>Exam Date</td><td>Venue</td></tr></table>",
    };

    for (const page of ["mark_view", "attendance", "timetable_view", "exam_schedule"]) {
      const p = await newPage(browser);
      await p.setContent("<body><div id='main-section'></div></body>");
      await shim(p, { fixedMs: new Date("2026-08-20T09:00:00+05:30").getTime() });
      await inject(p, ["js/utils/chooseCurrentSem.js", "js/shared/auto_semester.js"]);
      await p.evaluate((render) => {
        window.submits = [];
        document.getElementById("main-section").innerHTML =
          "<select id='semesterSubId'>" +
          "<option value=''>-- Choose Semester --</option>" +
          "<option value='AP1'>Fall Semester 2026-27 Freshers</option>" +
          "<option value='AP2'>Fall Semester 2026-27</option>" +
          "</select><button class='btn'>Search</button><div id='out'></div>";
        const fill = () => {
          window.submits.push(document.getElementById("semesterSubId").value);
          document.getElementById("out").innerHTML = render;
        };
        // both submit shapes are wired, so the registry entry picks which one
        // is actually used — a change event for the three onchange pages, the
        // Search button for the exam schedule
        document.getElementById("semesterSubId").addEventListener("change", fill);
        document.querySelector("#main-section button").addEventListener("click", fill);
      }, RENDERS[page]);

      // the bare picker must NOT read as "already showing its data"
      const before = await p.evaluate(
        (name) => window.vrAutoSemesterFor(name, { settleMs: 50, waitMs: 0 }).then(() => null),
        page
      );
      void before;
      await delay(900);
      const r = await p.evaluate(() => ({
        submits: window.submits,
        out: document.getElementById("out").innerHTML.length,
      }));
      ok(
        `the ${page} shape is recognised and submitted exactly once`,
        r.submits.length === 1 && r.out > 0,
        JSON.stringify(r)
      );

      // …and now that it IS loaded, a fresh call must leave it alone
      const second = await p.evaluate((name) => window.vrAutoSemesterFor(name), page);
      ok(
        `a loaded ${page} page is left alone`,
        second === false && (await p.evaluate(() => window.submits.length)) === 1,
        JSON.stringify({ second, submits: await p.evaluate(() => window.submits) })
      );
      await p.close();
    }

    /* ---- the three faults the fixtures above could not see (live 2026-08-21) --
     *
     * All three were found by driving the real portal, and each one is here
     * because the fixture was politer than VTOP is.
     */
    const livePage = async (extra) => {
      const p = await newPage(browser);
      await p.setContent("<body><div id='main-section'></div></body>");
      await shim(p, { fixedMs: new Date("2026-08-21T09:00:00+05:30").getTime() });
      await inject(p, ["js/utils/chooseCurrentSem.js", "js/shared/auto_semester.js"]);
      await p.evaluate((markup) => {
        window.submits = [];
        // the real 69-option list, trimmed to the five that tie on start date
        document.getElementById("main-section").innerHTML =
          "<select id='semesterSubId'>" +
          "<option value=''>-- Choose Semester --</option>" +
          "<option value='AP1'>Fall Semester 2026-27 Freshers</option>" +
          "<option value='AP2'>Fall Semester 2026-27</option>" +
          "<option value='AP3'>Fall_Win Transport Semester 2026-27</option>" +
          "<option value='AP4'>CDC PAT 2025-26</option>" +
          "<option value='AP5'>Fast Track Fall Semester 2026-27</option>" +
          "</select><div id='out'></div>" +
          markup;
        document
          .getElementById("semesterSubId")
          .addEventListener("change", function () {
            window.submits.push(this.value);
          });
      }, extra || "");
      return p;
    };

    /*
     * (1) GRADES IS NOT AUTO-ANSWERED, and that is now the requirement rather
     * than the bug. It was found broken here — `#studentGradeView` is present
     * on the EMPTY form, so the old predicate answered "already loaded" on
     * every real visit — and then asked for on purpose the same day: the page
     * shows ONE semester, so picking one picks what you came to look at.
     * Nothing must touch that picker, even with the page's own div present.
     */
    {
      const p = await livePage("<div id='studentGradeView'></div>");
      const started = await p.evaluate(() => window.vrAutoSemesterFor("exam_grade"));
      await delay(400);
      const r = await p.evaluate(() => ({
        started: null,
        submits: window.submits,
        idx: document.getElementById("semesterSubId").selectedIndex,
      }));
      ok(
        "the Grades picker is left for the student — no entry, no submit",
        started === false && r.submits.length === 0 && r.idx === 0,
        JSON.stringify({ started, ...r })
      );
      await p.close();
    }

    /*
     * (2) IT WALKED ONTO JUNK. Four options parse to the same start as the
     * real semester, and document order handed the tie to "Freshers"; the walk
     * then stepped on to Transport and Fast Track. With no cache to go on the
     * pick must still be the undecorated name, first try.
     */
    {
      const p = await livePage();
      await p.evaluate(() => window.vrAutoSemesterFor("mark_view"));
      await delay(400);
      const r = await p.evaluate(() => window.submits);
      ok(
        "Freshers, Transport, Fast Track and CDC PAT all lose to the plain name",
        r.length === 1 && r[0] === "AP2",
        JSON.stringify(r)
      );
      await p.close();
    }

    /*
     * (3) IT FOUGHT THE STUDENT. Watched live: a semester picked by hand while
     * the walk was still in flight was overwritten by the next step. A picker
     * that already names a semester is somebody's answer, and never ours.
     */
    {
      const p = await livePage();
      const r = await p.evaluate(async () => {
        const select = document.getElementById("semesterSubId");
        select.selectedIndex = 4; // the student chose CDC PAT on purpose
        const started = await window.vrAutoSemesterFor("mark_view");
        return { started, value: select.value, submits: window.submits };
      });
      ok(
        "a semester the student chose is never re-picked underneath them",
        r.started === false && r.value === "AP4" && r.submits.length === 0,
        JSON.stringify(r)
      );
      await p.close();
    }

    // The one that used to carry the mangled \b: "Slots left" must not be read
    // as a rendered timetable, or the picker is never answered on that page.
    {
      const p = await newPage(browser);
      await p.setContent("<body><div id='main-section'></div></body>");
      await shim(p, { fixedMs: new Date("2026-08-20T09:00:00+05:30").getTime() });
      await inject(p, ["js/utils/chooseCurrentSem.js", "js/shared/auto_semester.js"]);
      const r = await p.evaluate(() => {
        document.getElementById("main-section").innerHTML =
          "<select id='semesterSubId'><option value=''>x</option>" +
          "<option value='AP2'>Fall Semester 2026-27</option></select>" +
          // "Collaborate" would match the predicate's unbounded /lab/ — which
          // is pre-existing and deliberate, so the fixture avoids it and tests
          // the one boundary that IS asserted
          "<table><tr><td>Slotting</td><td>Choose one</td></tr></table>";
        window.changes = 0;
        document.getElementById("semesterSubId").addEventListener("change", () => {
          window.changes++;
        });
        return window.vrAutoSemesterFor("timetable_view", { settleMs: 50 });
      });
      await delay(400);
      ok(
        "'Slotting' is not a rendered timetable — the word boundary is real",
        r === true && (await p.evaluate(() => window.changes)) >= 1,
        JSON.stringify({ started: r, changes: await p.evaluate(() => window.changes) })
      );
      await p.close();
    }
  }

  await browser.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
