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
  const c = document.getElementById("vrevamp-bunk-table-container");
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
          window.__storage.vrevamp_reminder_email = a;
          if (cb) cb({ ok: true, address: a });
          return;
        }
        if (m && m.message === "send_mail") {
          // relay mode with nobody to write to yet: the worker answers
          // need_address and the page must ask, not fail
          // (no backticks in this comment - the whole shim is a template literal)
          if (window.__mailNeedsAddress && !m.to && !window.__storage.vrevamp_reminder_email) {
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
                    to: m.to || window.__storage.vrevamp_reminder_email ||
                      window.__mailTo || "student@vitapstudent.ac.in",
                    error: null,
                  }
            );
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

    ok("panel rendered", await page.evaluate(() => !!document.getElementById("vrevamp-gradehist-calc")));

    const sels = await page.evaluate(() =>
      [...document.querySelectorAll("select.vrevamp-gh-select")].map((s) => ({
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
      page.evaluate(() => document.getElementById("vrevamp-gradehist-body").textContent);
    let text = await bodyText();
    ok("baseline is the page's official CGPA (8.50)", /Current CGPA:\s*8\.50/.test(text), text.slice(0, 120));
    ok("counts 3 of 4 rows towards the CGPA", /3 of 4 rows/.test(text), text.slice(0, 200));

    // change the FAILED attempt (row 1, F) to B: delta = (8-0)*4 = +32
    // projected = (8.5*27 + 32)/27 = 9.685 -> 9.69
    await page.evaluate(() => {
      const sel = document.querySelectorAll("select.vrevamp-gh-select")[0];
      sel.value = "B";
      sel.dispatchEvent(new Event("change"));
    });
    text = await bodyText();
    ok("projected CGPA after F->B on the first attempt = 9.69", /Projected CGPA:\s*9\.69/.test(text), text.slice(0, 200));
    ok("change shown as +1.19", /Change:\s*\+1\.19/.test(text), text.slice(0, 200));
    ok(
      "only the changed row is tinted",
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll("tr[data-vrevamp-gh]")];
        return rows.filter((r) => r.style.background).length === 1;
      })
    );

    // The reported complaint: "where is the CGPA change visible? it's not."
    // The summary panel renders AFTER the table, which on a real transcript is
    // 29 rows below the dropdown just changed — correct, and off screen. The
    // projected CGPA now also rides in a fixed bar that stays with the user.
    const bar = await page.evaluate(() => {
      const b = document.getElementById("vrevamp-gh-bar");
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
          !document.getElementById("vrevamp-gh-bar") &&
          [...document.querySelectorAll("tr[data-vrevamp-gh]")].every((r) => !r.style.background)
      )
    );

    // put the change back for the assertions that follow
    await page.evaluate(() => {
      const sel = document.querySelectorAll("select.vrevamp-gh-select")[0];
      sel.value = "B";
      sel.dispatchEvent(new Event("change"));
    });

    // the SECOND CSE1005 attempt must be independent of the first
    await page.evaluate(() => {
      const sel = document.querySelectorAll("select.vrevamp-gh-select")[1];
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
      [...document.querySelectorAll("#vrevamp-gradehist-body button")]
        .find((b) => /Reset changes/.test(b.textContent))
        .click();
    });
    text = await bodyText();
    ok("reset restores the baseline", !/Projected CGPA/.test(text) && /3 of 4 rows/.test(text), text.slice(0, 160));
    ok(
      "reset clears every select and tint",
      await page.evaluate(() => {
        const sels = [...document.querySelectorAll("select.vrevamp-gh-select")];
        const rows = [...document.querySelectorAll("tr[data-vrevamp-gh]")];
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
      const rows = [...document.querySelectorAll("tr[data-vrevamp-gh]")];
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
      document.getElementById("vrevamp-gradehist-body").textContent
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
      const el = document.getElementById("vrevamp-gradehist-body");
      return el ? el.textContent : null;
    });
    ok("computed baseline CGPA = 8.67", !!text && /Current CGPA:\s*8\.67/.test(text), (text || "").slice(0, 120));
    await page.evaluate(() => {
      const sel = document.querySelectorAll("select.vrevamp-gh-select")[1];
      sel.value = "S";
      sel.dispatchEvent(new Event("change"));
    });
    text = await page.evaluate(() => document.getElementById("vrevamp-gradehist-body").textContent);
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
      "js/shared/click.js",
      "js/shared/ics.js",
      "js/shared/google_auth.js",
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
      "js/shared/click.js",
      "js/shared/ics.js",
      "js/shared/google_auth.js",
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
      "js/shared/click.js",
      "js/shared/ics.js",
      "js/shared/google_auth.js",
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

    // A SECOND import must warn first. The TEMPLATE route cannot delete the
    // previous run — no extended property to find it by, no token to delete it
    // with — so re-running silently adds a complete second copy. Verified on
    // the real calendar 2026-08-09: 35 distinct classes in one week, most of
    // them present three times, from three runs that each reported success.
    await page.evaluate(() => {
      window.__autoImportSaves = 2;
    });
    await page.evaluate(() => document.getElementById("vrevamp-timetable-gcal").click());
    await delay(500);
    const warned = await page.evaluate(() => ({
      note: document.getElementById("vrevamp-timetable-gcal").nextElementSibling?.textContent || "",
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
      "js/shared/vtop.js",
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

    const table = await page.evaluate(READ_BUNK);
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
      "js/shared/vtop.js",
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
        counter: sessionStorage.getItem("vrevamp_login_reloads"),
        blockHasImg: !!document.querySelector("#captchaBlock img[src^='data:image/']"),
      }));
    const resetCounter = () =>
      page.evaluate(() => sessionStorage.removeItem("vrevamp_login_reloads"));

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

    // --- reCAPTCHA page: healthy, nothing missing ---
    await page.goto("https://vtop.test/recaptcha");
    await page.addScriptTag({ content: trapReloads });
    await resetCounter();
    captchaHits = 0;
    for (let i = 0; i < 3; i++) await inject(page, ["js/captcha/refreshTillCaptcha.js"]);
    await delay(300);
    const recap = await state();
    ok(
      "reCAPTCHA login page is left alone (invisible captcha is not a missing one)",
      recap.reloads === 0 && recap.counter === null && captchaHits === 0,
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

    // --- a dead load is the ONLY thing a reload is still used for ---
    await page.goto("https://vtop.test/empty");
    await page.addScriptTag({ content: trapReloads });
    await resetCounter();
    for (let i = 0; i < 8; i++) await inject(page, ["js/captcha/refreshTillCaptcha.js"]);
    const empty = await state();
    ok(
      "a genuinely empty page is retried, capped per tab so it cannot loop",
      empty.reloads === 3 && empty.counter === "3",
      `reloads=${empty.reloads} counter=${empty.counter}`
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
    ok("message re-fire does not duplicate buttons", btns2 === 8, `buttons=${btns2}`);

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
        .filter((b) => /mail me the list/.test(b.textContent))[0]
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
        .filter((b) => /mail me the list/.test(b.textContent))[0]
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
        .filter((b) => /mail me the list/.test(b.textContent))[1]
        .click();
    });
    await delay(400);
    ok(
      "📧 on an all-past group sends no mail at all",
      (await page.evaluate(() => (window.__mails || []).length)) === 0 &&
        /no upcoming exams/.test((await bellNote("mail me the list", "CAT1")) || ""),
      String(await bellNote("mail me the list", "CAT1"))
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
      "event sits on the exam window, titled and located for the reminder mail",
      (exEv.start || {}).dateTime === "2026-05-04T10:00:00+05:30" &&
        (exEv.end || {}).dateTime === "2026-05-04T13:00:00+05:30" &&
        /FAT exam: ECE2015/.test(exEv.summary || "") &&
        // Google's reminder mail quotes only summary + location, so the venue
        // has to be here or the 2 h mail lands without the fact it exists for
        exEv.location === "CB-324",
      JSON.stringify({ start: exEv.start, end: exEv.end, summary: exEv.summary, location: exEv.location })
    );
    // TWO emails, not one. A single 24 h mail was the original shape and it is
    // wrong: a day out you note it and forget it, two hours out is when you
    // need the venue in front of you. Reported 2026-08-16.
    ok(
      "Google is asked to email 24 h AND 2 h before, with one popup on the near one",
      !!exEv.reminders &&
        exEv.reminders.useDefault === false &&
        exEv.reminders.overrides.some((o) => o.method === "email" && o.minutes === 1440) &&
        exEv.reminders.overrides.some((o) => o.method === "email" && o.minutes === 120) &&
        exEv.reminders.overrides.filter((o) => o.method === "popup").length === 1 &&
        exEv.reminders.overrides.every((o) => o.method !== "popup" || o.minutes === 120) &&
        // Google refuses more than 5 overrides outright
        exEv.reminders.overrides.length <= 5,
      JSON.stringify(exEv.reminders)
    );
    ok(
      "reminder email carries slot, session, reporting time and seat",
      /Slot: A1/.test(exEv.description || "") &&
        /Session: FN1/.test(exEv.description || "") &&
        /Reporting time: 09:30 AM/.test(exEv.description || "") &&
        /Seat: R3C1 · No\. 5/.test(exEv.description || ""),
      JSON.stringify(exEv.description || "")
    );
    // The timetable import learned this the hard way: 66 class events in one
    // week, 35 distinct, most present three times, because a re-run only ever
    // added. ✉️ re-runs are NORMAL here — venue and seat read "-" until VTOP
    // publishes them — so it must replace, and say that it did.
    ok(
      "✉️ deletes its own previous run before writing, and says so",
      gcalExamDeletes.length === 1 &&
        /events\/old-run-1$/.test(gcalExamDeletes[0]) &&
        /\(replaced 1 from an earlier run\)/.test((await bellNote("email me", "FAT")) || ""),
      JSON.stringify({ deletes: gcalExamDeletes, note: await bellNote("email me", "FAT") })
    );
    ok(
      "the events it writes are tagged so the NEXT run can find them",
      (exEv.extendedProperties || {}).private &&
        exEv.extendedProperties.private.vrevamp === "exam",
      JSON.stringify(exEv.extendedProperties || null)
    );
    ok(
      "✉️ FAT confirms inline, naming both leads and who sends them",
      /✓ 1 exam\(s\) — Google will email you 24 h and 2 h before each one/.test(
        (await bellNote("email me", "FAT")) || ""
      ),
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
      bells: [...document.querySelectorAll("button")].filter((b) => /notify me/.test(b.textContent)).length,
      bound: document.querySelectorAll("[data-vr-action]").length,
      // the submit bug: a type="submit" button inside a VTOP form navigates
      // instead of running its handler
      types: [...document.querySelectorAll("[data-vr-action]")].map((b) => b.type),
      // must NOT outrank VTOP's own chrome: an earlier fix set z-index 1100 to
      // clear the BlockUI overlay and ended up drawing these buttons on top of
      // the site's open sidebar menu
      zIndex: (() => {
        const b = [...document.querySelectorAll("button")].find((x) => /notify me/.test(x.textContent));
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
      const b = [...document.querySelectorAll("button")].find((x) => /notify me/.test(x.textContent));
      // NO message is dispatched here: the whole point is that the clone needs
      // no repair. This is the click that used to do nothing at all.
      b.click();
      await new Promise((r) => setTimeout(r, 300));
      const note = document.querySelector(".vrevamp-exam-note");
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
      bells: [...document.querySelectorAll("button")].filter((b) => /notify me/.test(b.textContent)).length,
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
        /notify me/.test(b.textContent)
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
      const note = document.querySelector(".vrevamp-exam-note");
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
      document.querySelectorAll(".vrevamp-exam-note").forEach((n) => n.remove());
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
            !document.querySelector(".vrevamp-exam-note") &&
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
        const b = [...document.querySelectorAll("button")].find((x) => /notify me/.test(x.textContent));
        b.click();
        await new Promise((r) => setTimeout(r, 300));
        const note = document.querySelector(".vrevamp-exam-note");
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
        bells: [...document.querySelectorAll("button")].filter((b) => /notify me/.test(b.textContent)).length,
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
    await inject(page, ["js/shared/click.js", "js/shared/google_auth.js", "js/shared/vtop.js", "js/da_upload.js"]);
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
          ["vrevamp_calendar_" + sem.toLowerCase()]: {
            version: 2,
            semester: sem,
            fetchedAt: now,
            cat1: "2026-08-24",
            holidays: [],
            instructionalDays: [],
            lastInstructional: "2026-12-05",
          },
          vrevamp_attendance_summary: { fetchedAt: now, semester: sem, subjects },
        },
      });
      await inject(page, ["js/utils/chooseCurrentSem.js", "js/home_notices.js"]);
      await delay(1200);
      const text = await page.evaluate(() => {
        const el = document.getElementById("vrevamp-home-notices");
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
      const el = document.getElementById("vrevamp-home-notices");
      return el ? el.textContent : null;
    });
    ok("mid-semester: no stale note", !!text && !/looks over/.test(text), (text || "").slice(0, 160));
    ok("mid-semester: at-risk warning shown", !!text && /no room left/.test(text), (text || "").slice(0, 200));
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
        const el = document.getElementById("vrevamp-next-class");
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
    // text to what a webmail tab renders, send vrevamp_scan_otp, read the code.
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
            l({ message: "vrevamp_scan_otp", ignore: ig }, {}, resolve);
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
            l({ message: "vrevamp_scan_otp", ignore: ig }, {}, resolve);
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
      "Inbox (1,147) - ruthvik.24mic7159@vitapstudent.ac.in\n" +
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
            l({ message: "vrevamp_scan_otp", ignore: [] }, {}, resolve);
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
            l({ message: "vrevamp_scan_otp", ignore: [], autoOpen: ao }, {}, resolve);
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
          if (m && m.message === "vrevamp_get_otp") {
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
        used: window.__storage["vrevamp_otp_used"],
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
        used: window.__storage["vrevamp_otp_used"],
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
        used: window.__storage["vrevamp_otp_used"],
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
      const p = await boot(LOGIN_NAMED, { code: null }, { vrevamp_otp_used: ["111111"] });
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
          if (m.message === "vrevamp_get_otp")
            return cb({ code: null, sawVtop: false, needsSignIn: !window.__signedIn });
          if (m.message === "vrevamp_gmail_signin") {
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

    const extract = ctx.__vrevampOtpFromMailText;
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

  console.log("\n=== service worker: vrevamp_get_otp message handling ===");
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
      if (opts.token) store.vrevamp_gmail_token = opts.token;

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
      const r = await ask({ message: "vrevamp_get_otp", ignore: [] });
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
      const r = await ask({ message: "vrevamp_get_otp", ignore: [] });
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
      const r = await ask({ message: "vrevamp_get_otp", ignore: [] });
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
      const r = await ask({ message: "vrevamp_get_otp", ignore: [] });
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
        const listenersRan = ask({ message: "vrevamp_get_otp", ignore: [] });
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
      return { ask, calls, store };
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
        store: { vrevamp_calendar_client_id: "999-cal.apps.googleusercontent.com" },
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
        !!store.vrevamp_google_app_token &&
          store.vrevamp_google_app_token.token === "CAL-TOKEN" &&
          store.vrevamp_google_app_token.exp > Date.now(),
        JSON.stringify(store.vrevamp_google_app_token)
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
        store.vrevamp_google_account === "student@vitapstudent.ac.in",
        JSON.stringify(store.vrevamp_google_account)
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
          vrevamp_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vrevamp_google_account: "student@vitapstudent.ac.in",
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
          vrevamp_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vrevamp_google_account: "student@vitapstudent.ac.in",
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
          vrevamp_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vrevamp_google_account: "student@vitapstudent.ac.in",
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
        store: { vrevamp_calendar_client_id: "999-cal.apps.googleusercontent.com" },
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
          vrevamp_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vrevamp_google_granted: true,
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

    // Signing out has to put both back, or the student cannot switch account.
    {
      const { ask, store } = bootAuth({
        store: {
          vrevamp_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vrevamp_google_account: "student@vitapstudent.ac.in",
          vrevamp_google_granted: true,
          vrevamp_google_app_token: { token: "OLD", exp: Date.now() + 3600000 },
        },
      });
      await ask({ message: "google_sign_out" });
      ok(
        "sign-out forgets the token, the account AND the grant flag",
        !store.vrevamp_google_app_token &&
          !store.vrevamp_google_account &&
          !store.vrevamp_google_granted,
        JSON.stringify(Object.keys(store))
      );
    }

    // The failure this setup actually produces: consent refused because
    // calendar.events was never added to the consent screen, or the Calendar
    // API is not enabled on the project. Reporting that as "you closed the
    // window" sends someone hunting through Chrome instead of Cloud Console.
    {
      const { ask } = bootAuth({
        store: { vrevamp_calendar_client_id: "999-cal.apps.googleusercontent.com" },
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
          vrevamp_calendar_client_id: "999-cal.apps.googleusercontent.com",
          // the merged grant's key — Calendar and mail share one token now
          vrevamp_google_app_token: { token: "OLD", exp: Date.now() + 3600000 },
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
        store: { vrevamp_calendar_client_id: "999-cal.apps.googleusercontent.com", ...(o.store || {}) },
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
        /^Content-Type: multipart\/alternative; boundary="(vrevamp-[a-z0-9]+)"$/mu.test(raw) &&
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
      const { ask, seen } = mailBoot({ store: { vrevamp_reminder_email: "me@personal.example" } });
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
      const { ask } = bootAuth({ noClient: true });
      const r = await ask({ message: "send_mail", subject: "s", text: "t" });
      ok(
        "with no client id it says so instead of opening a doomed consent window",
        r && r.ok === false && r.error === "not_configured",
        JSON.stringify(r)
      );
    }

    /* ---- relay mode: mail comes FROM vRevamp, not from the student ---- */
    console.log("\n=== mail relay: sending from a vRevamp address, no server ===");
    const relayBoot = (o = {}) => {
      const seen = { auth: [], posts: [], gmail: 0 };
      const { ask } = bootAuth({
        store: {
          vrevamp_calendar_client_id: "999-cal.apps.googleusercontent.com",
          vrevamp_mail_relay_url: "https://script.google.com/macros/s/AKfy-test/exec",
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
      const { ask, seen } = relayBoot({ store: { vrevamp_reminder_email: "student@vitapstudent.ac.in" } });
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
      const { ask } = relayBoot({ store: { vrevamp_reminder_email: "student@vitapstudent.ac.in" }, relayError: "too many mails to this address today" });
      const r = await ask({ message: "send_mail", subject: "s", text: "t", interactive: true });
      ok(
        "a relay refusal is surfaced in the relay's own words",
        r && r.ok === false && r.error === "too many mails to this address today",
        JSON.stringify(r)
      );
    }
    {
      const { ask } = relayBoot({ store: { vrevamp_reminder_email: "student@vitapstudent.ac.in" }, httpFail: 503 });
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
          vrevamp_reminder_email: "me@personal.example",
          vrevamp_attendance_summary: { fetchedAt: Date.now(), subjects },
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
      const { ask, seen } = relayBoot({ store: { vrevamp_reminder_email: "me@personal.example" } });
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
          vrevamp_reminder_email: "me@personal.example",
          vrevamp_attendance_summary: {
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
        .filter((b) => /mail me the list/.test(b.textContent))[0].click();
    });
    await delay(600);
    const firstNote = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => /mail me the list/.test(x.textContent));
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
      (await page.evaluate(() => (window.__storage.vrevamp_exam_mail_state || {}).optIn)) === true,
      JSON.stringify(await page.evaluate(() => window.__storage.vrevamp_exam_mail_state || null))
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
        .filter((b) => /mail me the list/.test(b.textContent))[0].click();
    });
    await delay(400);
    const prompted = await page.evaluate(() => {
      const box = document.querySelector(".vrevamp-exam-addr");
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
      const box = document.querySelector(".vrevamp-exam-addr");
      box.querySelector("input").value = "nonsense";
      box.querySelector("[data-vr-action='exam-addr']").click();
    });
    await delay(300);
    ok(
      "a typo is refused in place, the prompt stays open, still nothing sent",
      (await page.evaluate(() => !!document.querySelector(".vrevamp-exam-addr"))) &&
        (await page.evaluate(() => (window.__mails || []).length)) === 0 &&
        !(await page.evaluate(() => window.__storage.vrevamp_reminder_email)),
      JSON.stringify(await page.evaluate(() => (window.__mails || []).length))
    );

    await page.evaluate(() => {
      const box = document.querySelector(".vrevamp-exam-addr");
      box.querySelector("input").value = "me@personal.example";
      box.querySelector("[data-vr-action='exam-addr']").click();
    });
    await delay(600);
    const after = await page.evaluate(() => ({
      stored: window.__storage.vrevamp_reminder_email || null,
      gone: !document.querySelector(".vrevamp-exam-addr"),
      mail: (window.__mails || [])[0] || null,
      note: (() => {
        const b = [...document.querySelectorAll("button")]
          .find((x) => /mail me the list/.test(x.textContent));
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
        .filter((b) => /mail me the list/.test(b.textContent))[0].click();
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
        .filter((b) => /mail me the list/.test(b.textContent))[0].click();
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

  await browser.close();
  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
