/*
 * Attendance Insights: the bunk calculator table.
 *
 * Runs automatically when the attendance page loads ("view_attendance"
 * message). All data comes from VTOP itself:
 *  - per-class history: fetched via the same endpoint the per-subject
 *    "view detail" modal uses (learned from a captured VTOP request, the
 *    page's own scripts, or known endpoint names — nothing hardcoded)
 *  - exam dates / instructional days: fetched from the academic calendar
 *    pages and cached in chrome.storage.local keyed by semester name
 *
 * Every step fails soft: if a fetch or parse fails, the affected cells
 * render "--" instead of breaking the page.
 */
(() => {
  const ATTENDANCE_MIN = 0.75;
  const CACHE_PREFIX = "vrevamp_calendar_";

  const MONTHS = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, SEPT: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const VTOP_DATE_RE = /\b(\d{1,2})-([A-Za-z]{3,4})-(\d{4})\b/;
  const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

  const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const parseAnyDate = (text) => {
    let m = VTOP_DATE_RE.exec(text);
    if (m) {
      const month = MONTHS[m[2].toUpperCase()];
      if (month === undefined) return null;
      return new Date(parseInt(m[3]), month, parseInt(m[1]));
    }
    m = ISO_DATE_RE.exec(text);
    if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    return null;
  };

  const isoOf = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;

  const normText = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

  const parseHtml = (html) =>
    new DOMParser().parseFromString(html, "text/html");

  /* ---------------- VTOP request helper ---------------- */

  const getCsrf = () => {
    const el = document.querySelector('input[name="_csrf"]');
    return el ? el.value || el.defaultValue : null;
  };

  const getAuthorizedID = () => {
    const el = document.querySelector("#authorizedIDX");
    return el ? el.value : null;
  };

  const vtopPost = async (path, params) => {
    const csrf = getCsrf();
    const authorizedID = getAuthorizedID();
    if (!csrf || !authorizedID) throw new Error("missing _csrf/authorizedID");
    const body = new URLSearchParams({
      _csrf: csrf,
      authorizedID,
      x: new Date().toUTCString(),
      ...params,
    });
    const res = await fetch(`${location.origin}/vtop/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body.toString(),
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`VTOP request failed: ${path} (${res.status})`);
    return res.text();
  };

  /* ---------------- per-subject attendance history ---------------- */

  // The detail button's onclick looks like fnName('classId','slot'); the
  // VTOP convention is that the JS function name matches the controller path.
  const extractDetailCall = (row) => {
    // scan the whole row markup: VTOP puts the call in onclick, href, or
    // other inline attributes depending on the page version
    const m = /(\w*AttendanceDetail\w*)\(([^)]*)\)/.exec(row.outerHTML || "");
    if (!m) return null;
    const args = (m[2].match(/['"]([^'"]*)['"]/g) || []).map((a) =>
      a.slice(1, -1)
    );
    return { fn: m[1], args };
  };

  const parseHistoryHtml = (html) => {
    const history = [];
    parseHtml(html)
      .querySelectorAll("tr")
      .forEach((tr) => {
        const text = tr.textContent || "";
        const date = parseAnyDate(text);
        if (!date) return;
        if (/absent/i.test(text)) history.push({ date, attended: false });
        else if (/present|on duty/i.test(text))
          history.push({ date, attended: true });
        // rows without a posted status are ignored, matching how VTOP
        // computes the percentage
      });
    history.sort((a, b) => a.date - b.date);
    return history;
  };

  // The row's onclick is often a wrapper (e.g.
  // callStudentAttendanceDetailDisplay) around the real AJAX endpoint
  const normalizeEndpoint = (u) =>
    u.replace(/^https?:\/\/[^/]+/, "").replace(/^\//, "").replace(/^vtop\//, "");

  // Look for the wrapper's definition in the page's inline AND external
  // same-origin scripts and pull the endpoint string out of its body
  const extractEndpointNear = (source, fnName) => {
    let from = 0;
    for (let i = 0; i < 10; i++) {
      const idx = source.indexOf(fnName, from);
      if (idx === -1) return null;
      const seg = source.slice(idx, idx + 1200);
      let m = /url\s*[:=]\s*["']([^"']+)["']/.exec(seg);
      if (!m)
        m = /["']((?:[\w-]+\/)*[\w-]*(?:[Dd]etail|[Dd]isplay)[\w-]*)["']/.exec(
          seg.slice(fnName.length)
        );
      if (m && m[1] !== fnName) return normalizeEndpoint(m[1]);
      from = idx + fnName.length;
    }
    return null;
  };

  let minedEndpointPromise = null;
  const findEndpointInScripts = (fnName) => {
    if (minedEndpointPromise) return minedEndpointPromise;
    minedEndpointPromise = (async () => {
      for (const s of document.querySelectorAll("script:not([src])")) {
        const found = extractEndpointNear(s.textContent || "", fnName);
        if (found) return found;
      }
      for (const s of document.querySelectorAll("script[src]")) {
        const src = s.getAttribute("src") || "";
        const abs = new URL(src, location.href);
        if (abs.origin !== location.origin) continue;
        try {
          const text = await (await fetch(abs.href)).text();
          const found = extractEndpointNear(text, fnName);
          if (found) return found;
        } catch (error) {
          /* script not fetchable — skip */
        }
      }
      return null;
    })();
    return minedEndpointPromise;
  };

  const DETAIL_ENDPOINT_CANDIDATES = [
    "processViewAttendanceDetail",
    "processViewStudentAttendanceDetail",
    "getStudentAttendanceDetail",
  ];

  const CLASSID_RE = /^[A-Z]{2,4}\d{8,}$/;
  const AUTH_PARAMS = ["_csrf", "x", "authorizedID"];

  // Build params from a captured VTOP request, swapping the captured class
  // id for this subject's; vtopPost re-adds fresh auth params
  const paramsFromTemplate = (template, call) => {
    const out = {};
    Object.entries(template || {}).forEach(([key, value]) => {
      if (AUTH_PARAMS.includes(key)) return;
      out[key] =
        value === "__CLASSID__" || CLASSID_RE.test(String(value))
          ? call.args[0] || value
          : value;
    });
    return Object.keys(out).length ? out : null;
  };

  const defaultParams = (call) => ({
    classId: call.args[0] || "",
    slotName: call.args[1] || "ALL",
  });

  let resolvedAttempt = null;
  let lastDetailResponseSample = null;

  const buildAttempts = async (call) => {
    const attempts = [];
    if (resolvedAttempt)
      attempts.push({
        path: resolvedAttempt.path,
        params: paramsFromTemplate(resolvedAttempt.params, call) || defaultParams(call),
      });
    // request captured live by the service worker when the user opened a
    // detail modal — the most reliable source
    const stored = await chrome.storage.local.get("vrevamp_detail_request");
    const rec = stored.vrevamp_detail_request;
    if (rec && rec.path)
      attempts.push({
        path: normalizeEndpoint(rec.path),
        params: paramsFromTemplate(rec.params, call) || defaultParams(call),
      });
    const mined = await findEndpointInScripts(call.fn);
    if (mined) attempts.push({ path: mined, params: defaultParams(call) });
    [call.fn, ...DETAIL_ENDPOINT_CANDIDATES].forEach((path) =>
      attempts.push({ path, params: defaultParams(call) })
    );
    return attempts;
  };

  const fetchDetailHistory = async (call) => {
    const tried = new Set();
    let lastError = null;
    for (const attempt of await buildAttempts(call)) {
      const key = attempt.path + "|" + JSON.stringify(attempt.params);
      if (tried.has(key)) continue;
      tried.add(key);
      let html;
      try {
        html = await vtopPost(attempt.path, attempt.params);
      } catch (error) {
        lastError = error;
        continue;
      }
      const history = parseHistoryHtml(html);
      if (history.length > 0) {
        // remember what worked, with the class id templated out
        const template = {};
        Object.entries(attempt.params).forEach(([k, v]) => {
          template[k] = v === call.args[0] ? "__CLASSID__" : v;
        });
        resolvedAttempt = { path: attempt.path, params: template };
        chrome.storage.local.set({
          vrevamp_detail_request: { path: attempt.path, params: template },
        });
        return history;
      }
      // request succeeded but no attendance rows found — keep a sample for
      // the on-page debug box and try the next candidate
      lastDetailResponseSample = html.slice(0, 2000);
    }
    if (lastError) throw lastError;
    return [];
  };

  /* ---------------- academic calendar ---------------- */

  const classifyDay = (text) => {
    const cat2 = /CAT\s*-?\s*II/i.test(text);
    return {
      cat1: !cat2 && /CAT\s*-?\s*I/i.test(text),
      cat2,
      fat: /Final\s*Assessment\s*Test/i.test(text),
      holiday: /holiday/i.test(text),
      instructional:
        /Instructional\s*Day/i.test(text) && !/No\s*Instructional/i.test(text),
    };
  };

  const findCalendarMenuUrl = () => {
    const link = Array.from(document.querySelectorAll("a[data-url]")).find(
      (a) =>
        /calendar/i.test(a.dataset.url || "") || /calendar/i.test(a.innerText)
    );
    return link ? link.dataset.url : null;
  };

  const collectMonthDates = (doc) => {
    const dates = new Set();
    doc.querySelectorAll("[onclick]").forEach((el) => {
      const m = VTOP_DATE_RE.exec(el.getAttribute("onclick") || "");
      if (m) dates.add(m[0]);
    });
    return dates;
  };

  // Day cells start with the day number and carry the colored label text
  const parseMonthGrid = (doc, monthDate, days) => {
    doc.querySelectorAll("td").forEach((td) => {
      const text = (td.textContent || "").trim();
      const dayMatch = /^(\d{1,2})\b/.exec(text);
      if (!dayMatch) return;
      const flags = classifyDay(text);
      if (
        !flags.cat1 &&
        !flags.cat2 &&
        !flags.fat &&
        !flags.holiday &&
        !flags.instructional
      )
        return;
      const day = parseInt(dayMatch[1]);
      if (day < 1 || day > 31) return;
      const date = new Date(monthDate.getFullYear(), monthDate.getMonth(), day);
      days.push({ iso: isoOf(date), ...flags });
    });
  };

  const fetchCalendar = async (semesterName) => {
    const menuUrl = findCalendarMenuUrl();
    if (!menuUrl) throw new Error("calendar link not found in sidebar");

    const landing = parseHtml(await vtopPost(menuUrl, { verifyMenu: "true" }));

    // match the attendance page's semester against the calendar dropdown
    const options = Array.from(landing.querySelectorAll("option")).filter(
      (o) => o.value && o.value.trim()
    );
    const want = normText(semesterName);
    const opt =
      options.find((o) => normText(o.textContent) === want) ||
      options.find((o) => normText(o.textContent).includes(want)) ||
      options.find((o) => want.includes(normText(o.textContent)));
    if (!opt) throw new Error("semester not found in calendar dropdown");
    const semSubId = opt.value;

    const monthsPage = parseHtml(await vtopPost(menuUrl, { semSubId }));
    const monthDates = new Set([
      ...collectMonthDates(landing),
      ...collectMonthDates(monthsPage),
    ]);
    if (monthDates.size === 0)
      throw new Error("no month buttons found in calendar page");

    const days = [];
    for (const dateStr of monthDates) {
      const monthDate = parseAnyDate(dateStr);
      if (!monthDate) continue;
      try {
        const grid = parseHtml(
          await vtopPost(menuUrl, { semSubId, date: dateStr })
        );
        parseMonthGrid(grid, monthDate, days);
      } catch (error) {
        console.warn("vRevamp: calendar month failed", dateStr, error);
      }
      await sleepMs(200);
    }
    if (days.length === 0) throw new Error("no calendar day cells parsed");

    const firstIso = (flag) =>
      days
        .filter((d) => d[flag])
        .map((d) => d.iso)
        .sort()[0] || null;
    const instructionalDays = days
      .filter((d) => d.instructional)
      .map((d) => d.iso)
      .sort();
    const holidays = [
      ...new Set(days.filter((d) => d.holiday).map((d) => d.iso)),
    ].sort();

    return {
      version: 2,
      semester: semesterName,
      fetchedAt: Date.now(),
      cat1: firstIso("cat1"),
      cat2: firstIso("cat2"),
      fat: firstIso("fat"),
      holidays,
      instructionalDays,
      lastInstructional: instructionalDays[instructionalDays.length - 1] || null,
    };
  };

  const getAcademicCalendar = async (semesterName) => {
    const key = CACHE_PREFIX + normText(semesterName);
    try {
      const cached = await chrome.storage.local.get(key);
      // version check invalidates caches from before holidays were recorded
      if (cached[key] && cached[key].version === 2) return cached[key];
      const calendar = await fetchCalendar(semesterName);
      // drop caches of other semesters, then store this one
      const all = await chrome.storage.local.get(null);
      const stale = Object.keys(all).filter(
        (k) => k.startsWith(CACHE_PREFIX) && k !== key
      );
      if (stale.length) await chrome.storage.local.remove(stale);
      await chrome.storage.local.set({ [key]: calendar });
      return calendar;
    } catch (error) {
      console.warn("vRevamp: academic calendar unavailable", error);
      lastCalendarError = String(error && error.message ? error.message : error);
      return null;
    }
  };

  let lastCalendarError = "";

  /* ---------------- schedule inference + bunk math ---------------- */

  // Entries per session = mode of entries-per-date across the history.
  // Labs log 2 entries (hours) per session, theory logs 1 — detected from
  // the data itself rather than hardcoded.
  const sessionSize = (history) => {
    const perDate = {};
    history.forEach((h) => {
      const iso = isoOf(h.date);
      perDate[iso] = (perDate[iso] || 0) + 1;
    });
    const freq = {};
    Object.values(perDate).forEach((n) => (freq[n] = (freq[n] || 0) + 1));
    const mode = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
    return mode ? Math.max(1, parseInt(mode[0])) : 1;
  };

  // Sessions per weekday = mode of how many entries the subject has on each
  // date of that weekday in its own history
  const weekdayMeetings = (history) => {
    const perDate = {};
    history.forEach((h) => {
      const iso = isoOf(h.date);
      perDate[iso] = (perDate[iso] || 0) + 1;
    });
    const samples = {};
    Object.keys(perDate).forEach((iso) => {
      const wd = new Date(iso).getDay();
      (samples[wd] = samples[wd] || []).push(perDate[iso]);
    });
    const meetings = {};
    Object.keys(samples).forEach((wd) => {
      const freq = {};
      samples[wd].forEach((n) => (freq[n] = (freq[n] || 0) + 1));
      meetings[wd] = parseInt(
        Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]
      );
    });
    return meetings;
  };

  /* ---------------- real schedule from the saved timetable ---------------- */

  // Saved timetable day cells are 3-letter codes ("MON"); also tolerate full
  // names. Returns 0=Sun..6=Sat, or undefined.
  const dayToNum = (name) =>
    ({ SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 })[
      String(name || "").trim().toUpperCase().slice(0, 3)
    ];
  const COURSE_CODE_RE = /[A-Z]{2,4}\d{3,4}/;

  // getTimeTable (defined in js/store/saveTimeTableDetails.js, shared content
  // world) is callback-based; wrap it and never reject.
  const getSavedTimetable = () =>
    new Promise((resolve) => {
      try {
        if (typeof getTimeTable !== "function") return resolve(null);
        getTimeTable((data) => resolve(data || null));
      } catch (error) {
        resolve(null);
      }
    });

  // courseCode -> { weekdayNum: sessions } built from the actual timetable the
  // student has viewed. This is the real weekly pattern; weekdayMeetings()
  // below only *infers* it from attendance history (and so misses subjects
  // that share a weekday or whose history is short). Each filled cell counts
  // as one hour, matching how history entries are counted, so labs (2 cells)
  // line up with their 2 history entries per session.
  const scheduleFromTimetable = (timetable) => {
    const map = {};
    if (!timetable || !Array.isArray(timetable.data)) return map;
    timetable.data.forEach((row) => {
      const wd = dayToNum(row.day);
      if (wd === undefined) return;
      ["theory", "lab"].forEach((kind) => {
        const cells = Array.isArray(row[kind]) ? row[kind] : [];
        cells.forEach((cell) => {
          const m = COURSE_CODE_RE.exec(String(cell).replace(/\s+/g, ""));
          if (!m) return;
          map[m[0]] = map[m[0]] || {};
          map[m[0]][wd] = (map[m[0]][wd] || 0) + 1;
        });
      });
    });
    return map;
  };

  const courseCodeOf = (row) => {
    const text = (row && (row.innerText || row.textContent)) || "";
    const m = COURSE_CODE_RE.exec(text.replace(/\s+/g, ""));
    return m ? m[0] : null;
  };

  // Classes this subject still has on instructional days after today and
  // before untilIso (exclusive); untilIso null = through the last
  // instructional day
  const countClassesUntil = (calendar, meetings, untilIso) => {
    const todayIso = isoOf(new Date());
    let count = 0;
    calendar.instructionalDays.forEach((iso) => {
      if (iso <= todayIso) return;
      if (untilIso && iso >= untilIso) return;
      count += meetings[new Date(iso).getDay()] || 0;
    });
    return count;
  };

  // Attend everything except b bunks: (A + R - b) / (T + R) >= 75%
  const bunkable = (attended, total, remaining) =>
    Math.max(
      0,
      Math.floor(attended + remaining - ATTENDANCE_MIN * (total + remaining))
    );

  // Consecutive classes that must be attended to climb back to 75%:
  // (A + x) / (T + x) >= 0.75  ->  x >= (0.75*T - A) / 0.25
  const attendToTarget = (attended, total) =>
    Math.max(
      0,
      Math.ceil((ATTENDANCE_MIN * total - attended) / (1 - ATTENDANCE_MIN))
    );

  // All internal math is in history entries (hours for labs); size/unit
  // convert the displayed numbers to whole sessions
  const bunkCell = (calendar, examIso, attended, total, meetings, history, size, unit) => {
    if (!calendar || !examIso) return "--";
    if (examIso > isoOf(new Date())) {
      const b = bunkable(
        attended,
        total,
        countClassesUntil(calendar, meetings, examIso)
      );
      return `${Math.floor(b / size)}${unit}`;
    }
    // Exam already happened (e.g. viewing a previous semester): report what
    // was possible back then, from the history as it stood before the exam
    const before = history.filter((h) => isoOf(h.date) < examIso);
    if (before.length === 0) return "--";
    const attendedThen = before.filter((h) => h.attended).length;
    const could = Math.max(
      0,
      Math.floor(attendedThen - ATTENDANCE_MIN * before.length)
    );
    return `could've bunked ${Math.floor(could / size)}${unit}`;
  };

  /* ---------------- on-page status reporting ---------------- */

  // Surfaces progress/failures on the page itself so DevTools isn't required
  const showStatus = (message, debugText, isError = true) => {
    let box = document.getElementById("vrevamp-insights-status");
    if (box && !box.isConnected) {
      // VTOP re-rendered the section and detached our box
      box.remove();
      box = null;
    }
    if (!box) {
      box = document.createElement("div");
      box.id = "vrevamp-insights-status";
      const wrap = document.querySelector(".table-responsive");
      if (wrap) wrap.insertAdjacentElement("afterend", box);
      else document.body.appendChild(box);
    }
    const color = isError ? "#b00" : "#555";
    box.style.cssText = `margin:10px 0;padding:8px;border:1px dashed ${color};color:${color};font-size:13px;`;
    box.textContent = message;
    if (debugText) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Debug info — click, then copy the text below";
      summary.style.cursor = "pointer";
      details.appendChild(summary);
      const ta = document.createElement("textarea");
      ta.readOnly = true;
      ta.value = debugText;
      ta.style.cssText =
        "width:100%;height:120px;font-size:11px;margin-top:4px;";
      details.appendChild(ta);
      box.appendChild(details);
    }
  };

  const clearStatus = () => {
    const box = document.getElementById("vrevamp-insights-status");
    if (box) box.remove();
  };

  /* ---------------- forecast banner ---------------- */

  // A compact at-a-glance summary above the table: which subjects are below
  // 75% (and how many classes to attend to recover), which have no margin
  // before the next exam, and otherwise the tightest safe subject.
  const renderForecastBanner = (rowsData) => {
    const old = document.getElementById("vrevamp-forecast-banner");
    if (old) old.remove();
    const anchor = document.querySelector(".table-responsive");
    if (!anchor) return;

    const below = rowsData
      .filter((r) => r.pct !== null && r.pct < 75)
      .sort((a, b) => a.pct - b.pct);
    const tight = rowsData.filter(
      (r) => r.pct >= 75 && typeof r.nextBunkable === "number" && r.nextBunkable <= 0
    );
    const accent = below.length ? "#c0392b" : tight.length ? "#b8860b" : "#2e7d32";

    const banner = document.createElement("div");
    banner.id = "vrevamp-forecast-banner";
    banner.style.cssText =
      `margin:12px 0;padding:10px 14px;background:#fff;border:1px solid #ddd;` +
      `border-left:4px solid ${accent};border-radius:4px;font-size:13px;` +
      "box-shadow:0 1px 3px rgba(0,0,0,0.08);";

    const head = document.createElement("p");
    head.style.cssText = `font-weight:bold;margin:0 0 6px 0;color:${accent};`;
    head.textContent = below.length
      ? `Attendance forecast — ${below.length} subject(s) below 75%`
      : "Attendance forecast — all subjects ≥ 75%";
    banner.appendChild(head);

    const addLine = (text, color) => {
      const p = document.createElement("p");
      p.textContent = text;
      p.style.cssText = `margin:2px 0;color:${color || "#333"};`;
      banner.appendChild(p);
    };

    below.forEach((r) =>
      addLine(
        `\u{1F534} ${r.name}: ${r.pct}% — attend the next ${r.recover} ${r.unit} to reach 75%`,
        "#c0392b"
      )
    );
    tight.forEach((r) =>
      addLine(
        `\u{1F7E0} ${r.name}: ${r.pct}% — no class to spare before ${r.nextExamLabel || "the next exam"}`,
        "#b8860b"
      )
    );
    if (!below.length && !tight.length) {
      const withBuf = rowsData
        .filter((r) => typeof r.nextBunkable === "number")
        .sort((a, b) => a.nextBunkable - b.nextBunkable);
      if (withBuf[0])
        addLine(
          `\u{1F7E2} Lowest margin: ${withBuf[0].name} — ${withBuf[0].nextBunkable} ${withBuf[0].unit} skippable before ${withBuf[0].nextExamLabel || "the next exam"}`,
          "#2e7d32"
        );
    }

    anchor.insertAdjacentElement("beforebegin", banner);
  };

  /* ---------------- bunk table rendering ---------------- */

  const TD_STYLE =
    "border:1px solid #b2b2b2;padding:6px 10px;text-align:center;vertical-align:middle;";

  const makeCell = (tag, text, extraStyle) => {
    const cell = document.createElement(tag);
    cell.textContent = text;
    cell.style.cssText = TD_STYLE + (extraStyle || "");
    return cell;
  };

  const renderBunkTable = (rowsData) => {
    const old = document.getElementById("vrevamp-bunk-table-container");
    if (old) old.remove();
    // re-query the anchor at render time — the one captured at the start of
    // the run may have been replaced by a VTOP re-render
    const anchor = document.querySelector(".table-responsive");
    if (!anchor) return;

    const container = document.createElement("div");
    container.id = "vrevamp-bunk-table-container";
    container.style.cssText = "margin:15px 0;";

    const heading = document.createElement("p");
    heading.textContent =
      "Bunk Calculator — classes you can still skip and stay ≥ 75%";
    heading.style.cssText = "font-weight:bold;margin-bottom:5px;";
    container.appendChild(heading);

    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;width:100%;";

    const head = document.createElement("tr");
    [
      "Subject",
      "Classes held",
      "Remaining till sem end",
      "Bunkable before CAT-1",
      "Bunkable before CAT-2",
      "Bunkable before FAT",
    ].forEach((h) =>
      head.appendChild(makeCell("th", h, "background:rgb(60,141,188,0.8);"))
    );
    table.appendChild(head);

    rowsData.forEach((r) => {
      const tr = document.createElement("tr");
      tr.appendChild(makeCell("td", r.name, "text-align:left;"));
      [r.held, r.remaining, r.cat1, r.cat2, r.fat].forEach((v) =>
        tr.appendChild(makeCell("td", String(v)))
      );
      table.appendChild(tr);
    });
    container.appendChild(table);

    const note = document.createElement("p");
    note.textContent =
      "*Based on your timetable (open the Timetable page once for the exact " +
      "schedule; otherwise it's inferred from attendance history) and the " +
      'academic calendar. Past exams show what you could have bunked back then; ' +
      '"--" means the calendar could not be read. Lab numbers are whole lab ' +
      "sessions, not hours. One-off day-order swaps and unposted attendance " +
      "are not visible here.";
    note.style.cssText = "color:#666;font-size:12px;margin-top:5px;";
    container.appendChild(note);

    anchor.insertAdjacentElement("afterend", container);
  };

  /* ---------------- main flow ---------------- */

  const subjectName = (row) => {
    const cells = Array.from(row.cells || []);
    const codeCell = cells.find((td) =>
      /[A-Z]{2,4}\s?\d{3,4}/.test(td.innerText)
    );
    const src = codeCell || cells[2] || cells[1];
    return src
      ? src.innerText.replace(/\s+/g, " ").trim().slice(0, 70)
      : "Subject";
  };

  // VTOP re-renders the attendance section while we work, detaching the rows
  // we decorated. Re-find the live row for a subject by its classId.
  const liveRowFor = (s) => {
    if (s.row.isConnected) return s.row;
    const key = s.call.args[0];
    if (!key) return null;
    return (
      Array.from(
        document.querySelectorAll(".table-responsive tbody tr")
      ).find((r) => r.outerHTML.includes(key)) || null
    );
  };

  // Histories don't change within a page session — cache them so re-runs
  // after a VTOP re-render repaint instantly instead of refetching
  const historyCache = {};

  const doRun = async () => {
    const tableWrap = document.querySelector(".table-responsive");
    if (!tableWrap) return;
    const subjects = Array.from(tableWrap.querySelectorAll("tbody tr"))
      .map((row) => ({ row, call: extractDetailCall(row) }))
      .filter((s) => s.call);
    if (subjects.length === 0) {
      const sample = tableWrap.querySelector("tbody tr");
      showStatus(
        "vRevamp: couldn't find the attendance detail link in the table rows — bunk calculator skipped.",
        sample ? sample.outerHTML : "no rows found"
      );
      return;
    }

    const semEl = document.querySelector("#semesterSubId");
    const semesterName =
      semEl && semEl.selectedIndex >= 0
        ? semEl.options[semEl.selectedIndex].innerText.trim()
        : null;

    // Phase 1: fetch per-class histories
    showStatus("vRevamp: fetching attendance details…", null, false);
    const collected = [];
    let lastDetailError = "";
    for (const s of subjects) {
      try {
        const cacheKey = s.call.args.join("|");
        let history = historyCache[cacheKey];
        if (!history) {
          history = await fetchDetailHistory(s.call);
          historyCache[cacheKey] = history;
          await sleepMs(250);
        }
        if (history.length === 0) continue;
        collected.push({ s, history });
      } catch (error) {
        console.warn("vRevamp: subject insight failed", error);
        lastDetailError = String(error && error.message ? error.message : error);
      }
    }

    if (collected.length === 0) {
      showStatus(
        "vRevamp: couldn't fetch attendance details automatically. " +
          "FIX: click the eye icon in the Attendance Detail column for any ONE subject " +
          "(let the popup open), close it, then re-open this attendance page — " +
          "vRevamp learns the request from VTOP itself and it will work from then on. " +
          `(${lastDetailError || "responses had no attendance rows"})`,
        lastDetailResponseSample ||
          (subjects[0] ? subjects[0].row.outerHTML : null)
      );
      return;
    }

    // Phase 2: academic calendar, then the bunk table
    showStatus("vRevamp: reading the academic calendar…", null, false);
    const calendar = semesterName
      ? await getAcademicCalendar(semesterName)
      : null;

    // The student's actual timetable (if they've opened the timetable page)
    // gives the true weekly schedule; fall back to inferring it from history.
    const schedule = scheduleFromTimetable(await getSavedTimetable());

    const todayIso = isoOf(new Date());
    const rowsData = collected.map(({ s, history }) => {
      const attended = history.filter((h) => h.attended).length;
      const total = history.length;
      const code = courseCodeOf(liveRowFor(s) || s.row);
      const scheduled = code ? schedule[code] : null;
      const meetings =
        scheduled && Object.keys(scheduled).length
          ? scheduled
          : weekdayMeetings(history);
      const size = sessionSize(history);
      const unit = size > 1 ? " lab(s)" : "";
      // next upcoming exam (label + date), for the forecast banner and the
      // home-page notices card
      const nextExam =
        [
          ["CAT-1", calendar && calendar.cat1],
          ["CAT-2", calendar && calendar.cat2],
          ["FAT", calendar && calendar.fat],
        ]
          .filter(([, iso]) => iso && iso > todayIso)
          .sort((a, b) => (a[1] < b[1] ? -1 : 1))[0] || null;
      const upcoming = nextExam ? nextExam[1] : null;
      const nextBunkable =
        calendar && upcoming
          ? Math.floor(
              bunkable(
                attended,
                total,
                countClassesUntil(calendar, meetings, upcoming)
              ) / size
            )
          : null;
      const pct = total ? Math.round((attended / total) * 100) : null;
      return {
        name: subjectName(liveRowFor(s) || s.row),
        nextBunkable,
        nextExamLabel: nextExam ? nextExam[0] : null,
        pct,
        recover: pct !== null && pct < 75 ? attendToTarget(attended, total) : 0,
        unit: size > 1 ? "lab(s)" : "class(es)",
        held: total,
        remaining: calendar
          ? `${Math.floor(countClassesUntil(calendar, meetings, null) / size)}${unit}`
          : "--",
        cat1: bunkCell(calendar, calendar && calendar.cat1, attended, total, meetings, history, size, unit),
        cat2: bunkCell(calendar, calendar && calendar.cat2, attended, total, meetings, history, size, unit),
        fat: bunkCell(calendar, calendar && calendar.fat, attended, total, meetings, history, size, unit),
      };
    });

    renderForecastBanner(rowsData);
    renderBunkTable(rowsData);

    // snapshot for the home-page notices card
    chrome.storage.local.set({
      vrevamp_attendance_summary: {
        fetchedAt: Date.now(),
        semester: semesterName,
        subjects: rowsData.map((r) => ({
          name: r.name,
          nextBunkable: r.nextBunkable,
          unit: r.unit,
        })),
      },
    });

    if (semesterName && !calendar) {
      showStatus(
        `vRevamp: academic calendar could not be read — bunk columns show "--". (${lastCalendarError})`
      );
    } else {
      clearStatus();
    }
  };

  // If another attendance event arrives mid-run (VTOP re-rendered the
  // table), queue a re-run instead of skipping — the caches make it cheap
  let running = false;
  let pendingRerun = false;

  const runInsights = async () => {
    if (running) {
      pendingRerun = true;
      return;
    }
    running = true;
    try {
      await doRun();
    } finally {
      running = false;
      if (pendingRerun) {
        pendingRerun = false;
        setTimeout(() => {
          runInsights().catch((error) =>
            console.warn("vRevamp: attendance insights failed", error)
          );
        }, 500);
      }
    }
  };

  chrome.runtime.onMessage.addListener((request) => {
    if (request.message === "view_attendance") {
      // small delay so attendance.js finishes its own row edits first
      setTimeout(() => {
        runInsights().catch((error) =>
          console.warn("vRevamp: attendance insights failed", error)
        );
      }, 400);
    }
  });
})();
