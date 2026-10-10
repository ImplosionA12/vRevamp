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
  const NUM_DATE_RE = /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/; // dd-mm-yyyy (newer detail modal)

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
    m = NUM_DATE_RE.exec(text);
    if (m) {
      // day-first (verified against the weekday VTOP prints alongside)
      const month = parseInt(m[2]) - 1;
      if (month < 0 || month > 11) return null;
      return new Date(parseInt(m[3]), month, parseInt(m[1]));
    }
    return null;
  };

  const isoOf = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;

  // "YYYY-MM-DD" -> local-time Date. new Date(iso) parses as UTC midnight,
  // which shifts the weekday/day for viewers west of Greenwich — every
  // weekday lookup must go through these.
  const dateOfIso = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const wdOfIso = (iso) => dateOfIso(iso).getDay();

  const normText = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

  const parseHtml = (html) =>
    new DOMParser().parseFromString(html, "text/html");

  /* ---------------- VTOP request helper ---------------- */

  /*
   * Routed through js/shared/vtop.js, which now owns the token, the student
   * id, the concurrency and the circuit breaker. (The local getCsrf /
   * getAuthorizedID that used to sit here went with it — they had no other
   * caller. AUTH_PARAMS below still names those parameters, but only to
   * recognise and strip them from a captured request template.)
   *
   * Sharing the breaker matters here more than anywhere: this file fires one
   * POST PER SUBJECT and, when it cannot find the right endpoint, one per
   * CANDIDATE per subject — comfortably twenty failed requests on a stale
   * session, which is how a merely-expired session became a broken one.
   */
  const vtopPost = async (path, params, options) =>
    window.vrVtop.post(path, params, options);
  // A guess at an endpoint this deployment may not have. Expected to 404, so
  // it must not count toward the "this session is dead" breaker — see the
  // PROBES vs REAL REQUESTS note in js/shared/vtop.js.
  const vtopProbe = async (path, params) =>
    window.vrVtop.post(path, params, { probe: true });

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
        // a wrapper row around a nested table carries the whole register's
        // text — it would match a date + a status and add a phantom entry
        if (tr.querySelector("tr")) return;
        // join cells with a space: raw textContent glues adjacent cells
        // ("1" + "01-01-2026" -> "101-01-2026") and breaks the \b in the
        // date regexes
        const text = Array.from(tr.children, (c) => c.textContent).join(" ");
        // the per-course summary row carries a date AND "Present : n" counts
        if (/total\s*class|percentage/i.test(text)) return;
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

  // old "CSE100511111111" ids and new "AM_ECE2015_00100" course ids
  const CLASSID_RE = /^([A-Z]{2,4}\d{8,}|[A-Z]{1,4}_[A-Z]{2,6}\d{3,4}[A-Z]?_\w+)$/;
  const AUTH_PARAMS = ["_csrf", "x", "authorizedID"];

  // the argument that identifies the class: newer VTOP passes
  // (semesterSubId, registerNumber, courseId, courseType), older (classId, slot)
  const classArgOf = (call) =>
    (call.args.length >= 4 ? call.args[2] : call.args[0]) || "";

  // Build params from a captured VTOP request. Keys the current row itself
  // provides (via its onclick args) always take the row's OWN values — a
  // template captured from a Theory row must not force courseType=TH onto a
  // Lab row, or VTOP silently returns the theory register for it. Other
  // keys are kept, with anything class-id-shaped swapped for this row's.
  const paramsFromTemplate = (template, call) => {
    const out = {};
    const own = defaultParams(call);
    Object.entries(template || {}).forEach(([key, value]) => {
      if (AUTH_PARAMS.includes(key)) return;
      if (key in own) {
        out[key] = own[key];
        return;
      }
      out[key] =
        value === "__CLASSID__" || CLASSID_RE.test(String(value))
          ? classArgOf(call) || value
          : value;
    });
    return Object.keys(out).length ? out : null;
  };

  const defaultParams = (call) =>
    call.args.length >= 4
      ? {
          semesterSubId: call.args[0],
          registerNumber: call.args[1],
          courseId: call.args[2],
          courseType: call.args[3] || "TH",
        }
      : {
          classId: call.args[0] || "",
          slotName: call.args[1] || "ALL",
        };

  let resolvedAttempt = null;
  let lastDetailResponseSample = null;

  const buildAttempts = async (call) => {
    const attempts = [];
    // `probe` marks an attempt as a GUESS. The first two entries are not
    // guesses — one worked earlier in this very run, the other is the request
    // VTOP itself made when the student opened a detail modal — so a refusal
    // there is real news and counts toward the circuit breaker. Everything
    // after them is a list of endpoint names that may simply not exist on this
    // deployment, and 404s from those are routine.
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
    if (mined) attempts.push({ path: mined, params: defaultParams(call), probe: true });
    [call.fn, ...DETAIL_ENDPOINT_CANDIDATES].forEach((path) =>
      attempts.push({ path, params: defaultParams(call), probe: true })
    );
    return attempts;
  };

  const fetchDetailHistory = async (call) => {
    const tried = new Set();
    let lastError = null;
    let sawResponse = false;
    for (const attempt of await buildAttempts(call)) {
      const key = attempt.path + "|" + JSON.stringify(attempt.params);
      if (tried.has(key)) continue;
      tried.add(key);
      let html;
      try {
        html = await vtopPost(attempt.path, attempt.params, { probe: attempt.probe });
      } catch (error) {
        lastError = error;
        continue;
      }
      sawResponse = true;
      const history = parseHistoryHtml(html);
      if (history.length > 0) {
        // remember what worked, with the class id templated out
        const template = {};
        Object.entries(attempt.params).forEach(([k, v]) => {
          template[k] = v === classArgOf(call) ? "__CLASSID__" : v;
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
    // A 200 with no rows is a legitimate empty register (0/0 semester) —
    // don't let a later dead legacy candidate's 404 turn it into an error
    if (!sawResponse && lastError) throw lastError;
    return [];
  };

  /* ---------------- academic calendar ---------------- */

  const classifyDay = (text) => {
    // calendars write both Roman and digit forms ("CAT-II" / "CAT-2")
    const cat2 = /CAT\s*-?\s*(II|2)\b/i.test(text);
    // labs sit no CATs but have their OWN FAT days, usually before the
    // theory FATs — keep the two apart so lab math never counts a theory
    // exam date. A day marked "Theory & Lab" flags both.
    const isFat = /Final\s*Assessment\s*Test/i.test(text);
    const labText = /\blab(oratory)?\b/i.test(text);
    return {
      cat1: !cat2 && /CAT\s*-?\s*(I|1)\b/i.test(text),
      cat2,
      fat: isFat && (!labText || /\btheory\b/i.test(text)),
      labFat: isFat && labText,
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
      // a cell wrapping a nested grid matches the day regex with the whole
      // month's text and would flag a bogus day with every label at once
      if (td.querySelector("td")) return;
      const text = (td.textContent || "").trim();
      const dayMatch = /^(\d{1,2})\b/.exec(text);
      if (!dayMatch) return;
      const flags = classifyDay(text);
      if (
        !flags.cat1 &&
        !flags.cat2 &&
        !flags.fat &&
        !flags.labFat &&
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
    // Newer VTOP encrypts the sidebar data-urls, so try the known calendar
    // endpoint first and only fall back to whatever the link carries.
    const candidates = ["academics/common/CalendarPreview"];
    const legacyUrl = findCalendarMenuUrl();
    if (legacyUrl && /^[\w/-]+$/.test(legacyUrl)) candidates.push(legacyUrl);

    let landing = null;
    let menuUrl = null;
    for (const candidate of candidates) {
      try {
        // both candidates are guesses at where this deployment keeps its
        // academic calendar — the first is the current path, the second is
        // whatever the sidebar link carries on older builds
        const doc = parseHtml(await vtopProbe(candidate, { verifyMenu: "true" }));
        if (doc.querySelector("option")) {
          landing = doc;
          menuUrl = candidate;
          break;
        }
      } catch (error) {
        /* endpoint not on this deployment — try the next */
      }
    }
    if (!landing) throw new Error("calendar page not reachable");

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
    const cgOpt = landing.querySelector("#classGroupId option[value]");
    const classGroupId = cgOpt ? cgOpt.value : "COMB";

    // Month buttons: the dedicated per-semester endpoint is authoritative —
    // the landing page's onclick dates can belong to whatever semester the
    // page defaults to AND can include per-DAY links of the current month.
    // Mixing the two sources (or per-day links) used to fetch the same month
    // repeatedly and multiply-count every instructional day.
    let monthDates = new Set();
    try {
      const monthsPage = parseHtml(
        await vtopProbe("getDateForSemesterPreview", { semSubId, classGroupId })
      );
      monthDates = collectMonthDates(monthsPage);
    } catch (error) {
      /* older deployment */
    }
    if (monthDates.size === 0) monthDates = collectMonthDates(landing);
    if (monthDates.size === 0) {
      const monthsPage = parseHtml(await vtopPost(menuUrl, { semSubId }));
      monthDates = collectMonthDates(monthsPage);
    }
    if (monthDates.size === 0)
      throw new Error("no month buttons found in calendar page");

    // one fetch per calendar month, whatever shape the links took
    // ("01-AUG-2026" vs "15-Aug-2026" are the same month)
    const months = new Map();
    for (const dateStr of monthDates) {
      const monthDate = parseAnyDate(dateStr);
      if (!monthDate) continue;
      const key = `${monthDate.getFullYear()}-${monthDate.getMonth()}`;
      if (!months.has(key)) months.set(key, { dateStr, monthDate });
    }

    const days = [];
    for (const { dateStr, monthDate } of months.values()) {
      const before = days.length;
      try {
        // current VTOP: dedicated grid endpoint with calDate
        const grid = parseHtml(
          await vtopProbe("processViewCalendar", { calDate: dateStr, semSubId, classGroupId })
        );
        parseMonthGrid(grid, monthDate, days);
      } catch (error) {
        /* fall through to the legacy shape */
      }
      if (days.length === before) {
        try {
          const grid = parseHtml(
            await vtopPost(menuUrl, { semSubId, date: dateStr })
          );
          parseMonthGrid(grid, monthDate, days);
        } catch (error) {
          console.warn("vRevamp: calendar month failed", dateStr, error);
        }
      }
      await sleepMs(200);
    }
    if (days.length === 0) throw new Error("no calendar day cells parsed");

    // one record per date, flags OR-ed — a date must never appear twice in
    // instructionalDays (each duplicate silently added a phantom class to
    // "remaining" and every bunkable column)
    const byIso = new Map();
    days.forEach((d) => {
      const prev = byIso.get(d.iso);
      if (!prev) {
        byIso.set(d.iso, { ...d });
        return;
      }
      ["cat1", "cat2", "fat", "labFat", "holiday", "instructional"].forEach(
        (f) => (prev[f] = prev[f] || d[f])
      );
    });
    const dayList = [...byIso.values()];

    const firstIso = (flag) =>
      dayList
        .filter((d) => d[flag])
        .map((d) => d.iso)
        .sort()[0] || null;
    const instructionalDays = dayList
      .filter((d) => d.instructional)
      .map((d) => d.iso)
      .sort();
    const holidays = dayList
      .filter((d) => d.holiday)
      .map((d) => d.iso)
      .sort();

    return {
      version: 4,
      semester: semesterName,
      fetchedAt: Date.now(),
      cat1: firstIso("cat1"),
      cat2: firstIso("cat2"),
      fat: firstIso("fat"),
      labFat: firstIso("labFat"),
      holidays,
      instructionalDays,
      lastInstructional: instructionalDays[instructionalDays.length - 1] || null,
    };
  };

  const getAcademicCalendar = async (semesterName) => {
    const key = CACHE_PREFIX + normText(semesterName);
    try {
      const cached = await chrome.storage.local.get(key);
      // version check invalidates caches built before the duplicate-month /
      // duplicate-day dedupe (those could hold multiply-counted class days)
      if (cached[key] && cached[key].version === 4) {
        // readers on other pages look here instead of scanning all of storage
        chrome.storage.local.set({ vrevamp_latest_calendar: cached[key] });
        return cached[key];
      }
      const calendar = await fetchCalendar(semesterName);
      // drop caches of other semesters, then store this one
      const all = await chrome.storage.local.get(null);
      const stale = Object.keys(all).filter(
        (k) => k.startsWith(CACHE_PREFIX) && k !== key
      );
      if (stale.length) await chrome.storage.local.remove(stale);
      await chrome.storage.local.set({ [key]: calendar, vrevamp_latest_calendar: calendar });
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
      const wd = wdOfIso(iso);
      (samples[wd] = samples[wd] || []).push(perDate[iso]);
    });
    // a weekday the subject met on only ONCE across a 3+ week history is a
    // one-off (makeup class / day-order swap), not a weekly meeting —
    // projecting it forward inflates "remaining" and every bunkable number
    const isos = Object.keys(perDate).sort();
    const spanWeeks = isos.length
      ? (dateOfIso(isos[isos.length - 1]) - dateOfIso(isos[0])) / (7 * 864e5)
      : 0;
    const meetings = {};
    Object.keys(samples).forEach((wd) => {
      if (samples[wd].length === 1 && spanWeeks >= 3) return;
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

  // courseCode -> { theory: {weekdayNum: cells}, lab: {weekdayNum: cells} }
  // built from the actual timetable the student has viewed. This is the real
  // weekly pattern; weekdayMeetings() below only *infers* it from attendance
  // history (and so misses subjects that share a weekday, or whose register
  // is behind). Theory and lab are kept apart — an embedded course carries
  // ONE course code across both its rows, and lumping them made the lab row
  // count the theory's classes. The cell's own slot text is the authority
  // ("L31-…-ELA-…" is lab) since some layouts mix the two arrays.
  const scheduleFromTimetable = (timetable) => {
    const map = {};
    if (!timetable || !Array.isArray(timetable.data)) return map;
    timetable.data.forEach((row) => {
      const wd = dayToNum(row.day);
      if (wd === undefined) return;
      ["theory", "lab"].forEach((arrKind) => {
        const cells = Array.isArray(row[arrKind]) ? row[arrKind] : [];
        cells.forEach((cell) => {
          const text = String(cell).replace(/\s+/g, "");
          const m = COURSE_CODE_RE.exec(text);
          if (!m) return;
          const kind =
            /-(ELA|LO)-/.test(text) || /^L\d/.test(text) ? "lab" : "theory";
          const entry = (map[m[0]] = map[m[0]] || { theory: {}, lab: {} });
          entry[kind][wd] = (entry[kind][wd] || 0) + 1;
        });
      });
    });
    return map;
  };

  // The cached timetable can belong to a previous semester — same course
  // code, different schedule (e.g. a course retaken in a summer term meets
  // daily, not 3x/week). Trust it for a course only if the course's actual
  // history doesn't contradict it: any weekday the subject met on 2+
  // distinct dates must exist in the timetable pattern.
  const timetableMatchesHistory = (scheduled, history) => {
    const seen = {};
    history.forEach((h) => {
      const wd = h.date.getDay();
      (seen[wd] = seen[wd] || new Set()).add(isoOf(h.date));
    });
    return Object.keys(seen).every(
      (wd) => seen[wd].size < 2 || (scheduled[wd] || 0) > 0
    );
  };

  const courseCodeOf = (row) => {
    const text = (row && (row.innerText || row.textContent)) || "";
    const m = COURSE_CODE_RE.exec(text.replace(/\s+/g, ""));
    return m ? m[0] : null;
  };

  // Classes this subject still has on instructional days after today and
  // before untilIso (exclusive); untilIso null = through the last
  // instructional day
  /*
   * Days inside an exam block, from the cached exam schedule — first to last
   * dated exam of a type. Asked for 2026-08-22: "until the cat exams over
   * there wont be classes". Regular classes do not run while a CAT or FAT
   * block is on, so counting those days as class days inflates "Left this sem"
   * and every bunkable column with classes that will never be held.
   *
   * Taken from the exam schedule rather than the calendar's own CAT flags on
   * purpose: the calendar marks only the days an exam is actually sat, and a
   * day mid-block with no exam of your own is still a day with no classes.
   * Empty when nothing is cached, so this can only ever remove phantom
   * classes — never invent them.
   */
  let examBlockDays = new Set();

  const loadExamBlockDays = async () => {
    try {
      const cached = (await chrome.storage.local.get("vrevamp_exam_schedule"))
        .vrevamp_exam_schedule;
      const dates = (((cached || {}).exams) || [])
        .map((e) => e && e.dateIso)
        .filter(Boolean)
        .sort();
      if (!dates.length) return;
      const byType = {};
      (((cached || {}).exams) || []).forEach((e) => {
        if (!e || !e.dateIso) return;
        const t = e.type || "Exam";
        const w = byType[t] || (byType[t] = { from: e.dateIso, to: e.dateIso });
        if (e.dateIso < w.from) w.from = e.dateIso;
        if (e.dateIso > w.to) w.to = e.dateIso;
      });
      const days = new Set();
      Object.values(byType).forEach(({ from, to }) => {
        const [fy, fm, fd] = from.split("-").map(Number);
        const [ty, tm, td] = to.split("-").map(Number);
        const end = new Date(ty, tm - 1, td);
        for (let d = new Date(fy, fm - 1, fd); d <= end; d.setDate(d.getDate() + 1))
          days.add(isoOf(d));
      });
      examBlockDays = days;
    } catch (error) {
      console.warn("vRevamp insights: exam blocks unavailable", error);
    }
  };

  const countClassesUntil = (calendar, meetings, untilIso) => {
    const todayIso = isoOf(new Date());
    let count = 0;
    calendar.instructionalDays.forEach((iso) => {
      if (iso <= todayIso) return;
      if (untilIso && iso >= untilIso) return;
      if (examBlockDays.has(iso)) return; // exam block: no regular classes
      count += meetings[wdOfIso(iso)] || 0;
    });
    return count;
  };

  // Expected class days for this subject after its last posted entry and
  // before today. >= 2 means the faculty's register is lagging — flag the
  // projections as stale instead of presenting them as current.
  const missedPostings = (calendar, meetings, lastPosted) => {
    if (!lastPosted) return 0;
    const startIso = isoOf(lastPosted);
    const todayIso = isoOf(new Date());
    let count = 0;
    const countDay = (iso) => {
      if (meetings[wdOfIso(iso)]) count += 1;
    };
    if (calendar) {
      calendar.instructionalDays.forEach((iso) => {
        if (iso > startIso && iso < todayIso) countDay(iso);
      });
    } else {
      // no calendar: walk plain days on the subject's weekday pattern
      // (holidays aren't visible here, hence the >= 2 threshold)
      const d = new Date(lastPosted);
      d.setDate(d.getDate() + 1);
      while (isoOf(d) < todayIso) {
        countDay(isoOf(d));
        d.setDate(d.getDate() + 1);
      }
    }
    return count;
  };

  const shortDate = (d) =>
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  // Attend everything except b bunks: (A + R - b) / (T + R) >= 75%.
  // Capped at R — you can't skip more classes than remain.
  const bunkable = (attended, total, remaining) =>
    Math.max(
      0,
      Math.min(
        remaining,
        Math.floor(attended + remaining - ATTENDANCE_MIN * (total + remaining))
      )
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
    if (!calendar) return "--";
    // calendar parsed fine but has no such exam day (short summers have no
    // CATs) — say so instead of looking broken
    if (!examIso) return "none this sem";
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

    // below75 is computed from the exact ratio, not the displayed percent —
    // a subject at 74.6% displays as 75% (VTOP-style ceil) but is still short
    const below = rowsData
      .filter((r) => r.below75)
      .sort((a, b) => a.pct - b.pct);
    const tight = rowsData.filter(
      (r) =>
        r.pct !== null &&
        !r.below75 &&
        typeof r.nextBunkable === "number" &&
        r.nextBunkable <= 0
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
        r.canRecover
          ? `\u{1F534} ${r.name}: ${r.pct}% — attend the next ${r.recover} ${r.unit} to reach 75%`
          : `\u{1F534} ${r.name}: ${r.pct}% — can't reach 75% this sem even attending everything (max ${r.maxPct}%)`,
        "#c0392b"
      )
    );
    tight.forEach((r) =>
      addLine(
        `\u{1F7E0} ${r.name}: ${r.pct}% — no class to spare before ${r.nextExamLabel || "the next exam"}`,
        "#b8860b"
      )
    );
    rowsData
      .filter((r) => r.staleSince)
      .forEach((r) =>
        addLine(
          `⚠ ${r.name}: attendance not posted since ${r.staleSince} — its numbers are unreliable until it's updated`,
          "#b8860b"
        )
      );
    if (!below.length && !tight.length) {
      // Rank on safeCount — the same never-dip number the table's "safe now"
      // column shows. Ranking on nextBunkable instead named a subject by one
      // metric while the column beside it showed the other.
      const withBuf = rowsData
        .filter((r) => typeof r.safeCount === "number")
        .sort((a, b) => a.safeCount - b.safeCount || a.pct - b.pct);
      const t = withBuf[0];
      if (t) {
        // both horizons on one line: skipping safeCount never drops you under
        // 75%, nextBunkable only holds if you attend everything else
        const ahead =
          typeof t.nextBunkable === "number" && t.nextBunkable !== t.safeCount
            ? ` (${t.nextBunkable} before ${t.nextExamLabel || "the next exam"} if you attend everything else)`
            : "";
        addLine(
          `\u{1F7E2} Tightest: ${t.name} — ${t.safeCount} ${t.unit} safe to skip right now${ahead}`,
          "#2e7d32"
        );
      }
    }

    anchor.insertAdjacentElement("beforebegin", banner);
  };

  /* ---------------- the skip planner ----------------------------------------
   *
   * Asked for 2026-08-22, after this exact question was answered by hand:
   * "if i skip the college from tuesday to next monday, 25 - 31 august then how
   * much attendance would i have remained".
   *
   * The bunk table cannot answer it, and the reason is worth stating. Its
   * columns are "safe to skip now" and "bunkable before CAT-2 / FAT" — every
   * one of them counts classes from today up to a fixed point. None of them
   * can answer "what about THESE dates", which is the question a student
   * actually asks before booking a train.
   *
   * Doing it by hand also showed why it needs the calendar rather than a
   * seven-day guess. For 25–31 Aug the real answer was FOUR class days, not
   * seven: 26 Aug was Milad-un-Nabi, 30 Aug a Sunday, 31 Aug a "No
   * Instructional Day" — and that student's timetable has no Monday row at
   * all, so the last day of the range cost nothing twice over. A planner that
   * counted weekdays would have been wrong by three days in one direction and
   * silently right for the wrong reason in the other.
   */
  const PLANNER_ID = "vrevamp-skip-planner";
  const PLANNER_OUT = "vrevamp-skip-result";

  // Classes this subject holds inside [fromIso, toIso], in HISTORY units
  // (hours for labs). Only real instructional days count, and exam-block days
  // are excluded for the same reason they are everywhere else: no classes run.
  const classesBetween = (calendar, meetings, fromIso, toIso) => {
    if (!calendar || !calendar.instructionalDays) return null;
    const todayIso = isoOf(new Date());
    let count = 0;
    calendar.instructionalDays.forEach((iso) => {
      if (iso <= todayIso) return; // already held — it is in attended/total
      if (iso < fromIso || iso > toIso) return;
      if (examBlockDays.has(iso)) return;
      count += meetings[wdOfIso(iso)] || 0;
    });
    return count;
  };

  const plannerDays = (calendar, fromIso, toIso) => {
    const todayIso = isoOf(new Date());
    const held = [];
    const off = [];
    const [fy, fm, fd] = fromIso.split("-").map(Number);
    const [ty, tm, td] = toIso.split("-").map(Number);
    const end = new Date(ty, tm - 1, td);
    const instructional = new Set(calendar ? calendar.instructionalDays : []);
    for (let d = new Date(fy, fm - 1, fd); d <= end; d.setDate(d.getDate() + 1)) {
      const iso = isoOf(d);
      if (iso <= todayIso) continue;
      if (instructional.has(iso) && !examBlockDays.has(iso)) held.push(iso);
      else off.push(iso);
    }
    return { held, off };
  };

  const B = "1px solid #b0b0b0";
  const planCell = (v, extra) =>
    `<td style="border:${B};padding:6px 9px;${extra || ""}">${v}</td>`;

  const renderSkipResult = (rowsData, calendar, fromIso, toIso) => {
    const out = document.getElementById(PLANNER_OUT);
    if (!out) return;
    if (!calendar) {
      out.innerHTML =
        '<p style="color:#c0392b;font-size:12px;margin:8px 0">' +
        "The academic calendar hasn't loaded, so the classes in that range " +
        "can't be counted. Reopen this page once it has.</p>";
      return;
    }
    if (toIso < fromIso) {
      out.innerHTML =
        '<p style="color:#c0392b;font-size:12px;margin:8px 0">' +
        "The second date is before the first.</p>";
      return;
    }

    const { held, off } = plannerDays(calendar, fromIso, toIso);
    /*
     * The recovery column, added the same day the planner shipped.
     *
     * "idk how i get 0 marhi like i attend all classe again until a month na"
     * — and that is the tool's fault, not a misreading. "Headroom 0" was
     * measured at the BOTTOM of the dip, the last day of the trip, and the
     * table then said nothing about the month of classes that follows. It
     * showed the scare and hid the recovery.
     *
     * Worked through for the 25-31 Aug case: CSE3009 Theory bottoms out at
     * exactly 75.0% on 31 Aug and is back to 24/28 = 85.7% by CAT-2 if every
     * class after the trip is attended. Both numbers are true; presenting only
     * the first one is what made a survivable trip look like a debar.
     *
     * So: the dip is still shown, because the days right after it are the
     * genuinely risky ones, and beside it where the student actually ends up.
     */
    const nextDay = (iso) => {
      const [y, m, d] = iso.split("-").map(Number);
      const t = new Date(y, m - 1, d + 1);
      return isoOf(t);
    };
    const prevDay = (iso) => {
      const [y, m, d] = iso.split("-").map(Number);
      const t = new Date(y, m - 1, d - 1);
      return isoOf(t);
    };

    const head = ["Subject", "Now", "Classes missed", "Lowest it gets", "By the next exam"]
      .map(
        (h) =>
          `<th style="border:${B};padding:7px 9px;background:#eef1f5;text-align:left;` +
          `font-size:11px;text-transform:uppercase;letter-spacing:.04em;">${h}</th>`
      )
      .join("");

    let worst = null;
    const body = rowsData
      .map((r) => {
        const missed = classesBetween(calendar, r.meetings || {}, fromIso, toIso);
        const after = r.total + missed;
        const pct = after ? (r.attended / after) * 100 : null;
        // headroom AFTER the trip, in whole sessions, on the same integer
        // formula the alert column uses
        const spare = Math.max(
          0,
          Math.floor(Math.floor((4 * r.attended - 3 * after) / 3) / r.size)
        );
        const below = pct !== null && pct < 75;
        if (pct !== null && (worst === null || pct < worst)) worst = pct;
        const unit = /lab/i.test(r.unit || "") ? "lab(s)" : "class(es)";
        const shown = Math.round(missed / r.size);

        // …and where it ends up: every class from the day after the trip until
        // the next exam, attended
        let recovered = null;
        if (r.nextExamIso && r.nextExamIso > toIso) {
          const back = classesBetween(
            calendar,
            r.meetings || {},
            nextDay(toIso),
            prevDay(r.nextExamIso)
          );
          if (back !== null) {
            const denom = after + back;
            if (denom) recovered = ((r.attended + back) / denom) * 100;
          }
        }

        return (
          "<tr>" +
          planCell(r.name, "font-weight:600;") +
          planCell(`${r.pct}%`, "white-space:nowrap;") +
          planCell(
            missed ? `${shown} ${unit}` : "—",
            "white-space:nowrap;" + (missed ? "" : "color:#888;")
          ) +
          planCell(
            (pct === null ? "—" : `${pct.toFixed(1)}%`) +
              `<div style="font-weight:400;color:#666;font-size:11px;">` +
              (below ? "below the line" : `${spare} ${unit} spare`) +
              "</div>",
            "white-space:nowrap;font-weight:700;" +
              (below
                ? "color:#c0392b;background:#fdecea;"
                : pct !== null && pct < 76
                  ? "color:#b8860b;background:#fff8e1;"
                  : "color:#2e7d32;")
          ) +
          planCell(
            recovered === null
              ? '<span style="color:#888;">—</span>'
              : `${recovered.toFixed(1)}%` +
                  `<div style="font-weight:400;color:#666;font-size:11px;">` +
                  `${r.nextExamLabel || "next exam"}, attending the rest</div>`,
            "white-space:nowrap;font-weight:700;" +
              (recovered !== null && recovered < 75
                ? "color:#c0392b;background:#fdecea;"
                : "color:#2e7d32;")
          ) +
          "</tr>"
        );
      })
      .join("");

    const offNote = off.length
      ? ` ${off.length} day(s) in that range cost you nothing (holidays, ` +
        "Sundays, exam days or days you have no class)."
      : "";
    out.innerHTML =
      `<p style="margin:10px 0 6px;font-size:13px;">` +
      `<b>${held.length} teaching day(s)</b> in ${fromIso} → ${toIso}.${offNote}</p>` +
      `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;` +
      `border:${B};font-size:13px;">` +
      `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
      (worst !== null && worst < 75
        ? '<p style="color:#c0392b;font-size:12px;margin:8px 0 0">' +
          "At least one subject drops below 75% — that is a debar, not a warning.</p>"
        : worst !== null && worst < 76
          ? '<p style="color:#b8860b;font-size:12px;margin:8px 0 0">' +
            `Tightest subject bottoms out at ${worst.toFixed(1)}% on the last day of ` +
            "the trip. That is the low point, not where you end up — the last " +
            "column is where you land if you attend everything afterwards. The " +
            "risk is the few days right after, when one more absence has " +
            "nothing to cushion it.</p>"
          : "");
  };

  const renderSkipPlanner = (rowsData, calendar, container) => {
    if (document.getElementById(PLANNER_ID)) return;
    const box = document.createElement("div");
    box.id = PLANNER_ID;
    box.style.cssText =
      "margin:14px 0;padding:10px 12px;border:1px solid #ccc;border-radius:4px;" +
      "background:#fafafa;font-size:13px;";
    const iso = (d) => isoOf(d);
    const today = new Date();
    const weekOut = new Date();
    weekOut.setDate(weekOut.getDate() + 7);
    box.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px;">' +
      "Planning to skip? Pick the dates</div>" +
      '<label style="margin-right:10px;">From ' +
      `<input type="date" id="vrevamp-skip-from" value="${iso(today)}" ` +
      'style="font-size:13px;padding:2px 4px;"></label>' +
      '<label style="margin-right:10px;">To ' +
      `<input type="date" id="vrevamp-skip-to" value="${iso(weekOut)}" ` +
      'style="font-size:13px;padding:2px 4px;"></label>' +
      `<span id="${PLANNER_OUT}"></span>`;
    container.insertAdjacentElement("afterend", box);

    // the result node has to be a block sibling, not the inline span above
    const out = document.createElement("div");
    out.id = PLANNER_OUT;
    document.getElementById(PLANNER_OUT).replaceWith(out);

    if (typeof window.vrButton === "function") {
      const go = window.vrButton("skip-plan", "Show me");
      go.style.cssText =
        "font-size:13px;padding:3px 12px;cursor:pointer;border:1px solid #999;" +
        "border-radius:3px;background:#4975b6;color:#fff;";
      out.insertAdjacentElement("beforebegin", go);
    }

    if (typeof window.vrDelegate === "function") {
      window.vrDelegate("skip-plan", () => {
        const from = (document.getElementById("vrevamp-skip-from") || {}).value;
        const to = (document.getElementById("vrevamp-skip-to") || {}).value;
        if (!from || !to) return;
        renderSkipResult(rowsData, calendar, from, to);
      });
    }
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

    /*
     * WHICH COLUMNS ARE WORTH DRAWING — decided per render, from the data.
     *
     * Read off the live page 2026-08-17, on a day CAT-1 had just started:
     * "Bunkable before CAT-1" said "could've bunked 3" on every single theory
     * row and "no CATs for labs" on every lab row, and "Bunkable before CAT-2"
     * said "no CATs for labs" on half of them. Two of seven columns carried no
     * decision a student could act on, and they sat between the reader and the
     * one number the table exists to give — "safe to skip now", which was the
     * fourth of seven and set in the same weight as the noise around it.
     *
     * A retrospective ("could've bunked N") is history, not advice, so it goes
     * in the tooltip rather than the grid; a column where every row is
     * retrospective or inapplicable is dropped entirely. What is left is
     * always at least Subject / Now / Safe to skip now.
     *
     * Also added: the CURRENT PERCENTAGE. It was genuinely absent — the table
     * told you how many classes you could skip without telling you where you
     * stood, so every reading meant scrolling back to VTOP's own table above.
     */
    const dead = (v) =>
      v === undefined ||
      v === null ||
      v === "--" ||
      /^no CATs for labs$/i.test(String(v)) ||
      /^none this sem$/i.test(String(v)) ||
      /^could've bunked/i.test(String(v));
    const examCols = [
      ["Bunkable before CAT-1", "cat1"],
      ["Bunkable before CAT-2", "cat2"],
      ["Bunkable before FAT", "fat"],
    ].filter(([, key]) => rowsData.some((r) => !dead(r[key])));

    const head = document.createElement("tr");
    [
      ["Subject", null],
      ["Now", null],
      ["Held", null],
      ["Left this sem", null],
      ["SAFE TO SKIP NOW", null],
      ...examCols,
    ].forEach(([h]) =>
      head.appendChild(
        makeCell(
          "th",
          h,
          "background:rgb(60,141,188,0.8);" +
            (h === "SAFE TO SKIP NOW" ? "background:rgb(46,125,50,0.85);" : "")
        )
      )
    );
    table.appendChild(head);

    rowsData.forEach((r) => {
      const tr = document.createElement("tr");
      const subjCell = makeCell("td", r.name, "text-align:left;");
      if (r.staleSince) {
        const warn = document.createElement("div");
        warn.textContent = `⚠ not posted since ${r.staleSince} — unreliable, numbers are as of that date`;
        warn.style.cssText = "color:#c0392b;font-size:11px;margin-top:2px;";
        subjCell.appendChild(warn);
      }
      if (r.partialNote) {
        const warn = document.createElement("div");
        warn.textContent = `⚠ ${r.partialNote} — remaining/bunkable may be low; open the Time Table page once for the exact schedule`;
        warn.style.cssText = "color:#b8860b;font-size:11px;margin-top:2px;";
        subjCell.appendChild(warn);
      }
      if (r.gapNote) {
        const warn = document.createElement("div");
        warn.textContent = `⚠ ${r.gapNote} — class skipped or not posted`;
        warn.style.cssText = "color:#b8860b;font-size:11px;margin-top:2px;";
        subjCell.appendChild(warn);
      }
      // click-to-simulate: step +1 skip / +1 attend and watch the numbers
      if (typeof r.attended === "number" && r.total) {
        subjCell.style.cursor = "pointer";
        subjCell.title = "Click to simulate skipping/attending";
        const sim = document.createElement("div");
        sim.className = "vrevamp-whatif";
        sim.style.cssText = "display:none;margin-top:4px;font-size:12px;";
        let sk = 0;
        let at = 0;
        const status = document.createElement("span");
        const paint = () => {
          const a = r.attended + at * r.size;
          const t = r.total + (at + sk) * r.size;
          const p = (a / t) * 100;
          // like the table's safe-now: capped at what actually remains
          // (minus the sessions already simulated away)
          const remainLeft =
            typeof r.remainEntries === "number"
              ? Math.max(0, r.remainEntries - (at + sk) * r.size)
              : Infinity;
          const safe = Math.max(
            0,
            Math.floor(
              Math.min(remainLeft, Math.floor((4 * a - 3 * t) / 3)) / r.size
            )
          );
          status.textContent =
            ` ${sk} skipped, ${at} attended → ${a}/${t} = ${p.toFixed(1)}%` +
            ` (safe now: ${safe} ${r.unit})`;
          status.style.color = p < 75 ? "#c0392b" : "#2e7d32";
        };
        const btn = (label, fn) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = label;
          b.style.cssText =
            "margin-right:4px;font-size:11px;padding:1px 6px;cursor:pointer;";
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            fn();
            paint();
          });
          return b;
        };
        sim.appendChild(btn("Skip +1", () => sk++));
        sim.appendChild(btn("Attend +1", () => at++));
        sim.appendChild(btn("Reset", () => { sk = 0; at = 0; }));
        sim.appendChild(status);
        paint();
        subjCell.appendChild(sim);
        subjCell.addEventListener("click", (e) => {
          if (e.target.tagName === "BUTTON") return;
          sim.style.display = sim.style.display === "none" ? "block" : "none";
        });
      }
      tr.appendChild(subjCell);
      const addCell = (v, sub) => {
        const td = makeCell("td", String(v));
        if (sub) {
          const d = document.createElement("div");
          d.textContent = sub;
          d.style.cssText = "color:#777;font-size:11px;margin-top:2px;";
          td.appendChild(d);
        }
        tr.appendChild(td);
      };
      // Where you stand right now, in the units VTOP's own table uses so the
      // two can be read against each other without arithmetic.
      const pctCell = makeCell(
        "td",
        r.pct === null ? "--" : `${r.pct}%`,
        "font-weight:bold;" +
          (r.below75 ? "color:#c0392b;" : r.pct !== null && r.pct < 80 ? "color:#b8860b;" : "color:#2e7d32;")
      );
      if (typeof r.attended === "number") {
        const sub = document.createElement("div");
        sub.textContent = `${r.attended}/${r.total}`;
        sub.style.cssText = "color:#777;font-size:11px;font-weight:normal;margin-top:2px;";
        pctCell.appendChild(sub);
      }
      tr.appendChild(pctCell);

      addCell(r.held);
      addCell(r.remaining, r.bestNote);

      // The answer the table exists for, drawn like it. Everything else on
      // this row is context for this number.
      const safeCell = makeCell(
        "td",
        r.safeNow,
        "font-weight:bold;font-size:15px;" +
          (r.safeCount === 0
            ? "color:#c0392b;background:rgba(238,75,43,0.12);"
            : r.safeCount === 1
              ? "color:#b8860b;background:rgba(255,193,7,0.14);"
              : "color:#2e7d32;background:rgba(46,125,50,0.10);")
      );
      if (r.debarNote) {
        const sub = document.createElement("div");
        sub.textContent = r.debarNote;
        sub.style.cssText = "color:#777;font-size:11px;font-weight:normal;margin-top:2px;";
        safeCell.appendChild(sub);
      }
      tr.appendChild(safeCell);

      // Retrospectives are history, not advice — they ride in the tooltip so
      // a column of them cannot crowd out the columns that are.
      const past = [
        ["CAT-1", r.cat1],
        ["CAT-2", r.cat2],
        ["FAT", r.fat],
      ]
        .filter(([, v]) => /^could've bunked/i.test(String(v)))
        .map(([label, v]) => `${label}: ${v}`);
      if (past.length) subjCell.title = past.join("\n");

      examCols.forEach(([, key]) => addCell(dead(r[key]) ? "—" : r[key]));
      table.appendChild(tr);
    });
    container.appendChild(table);

    // 120 words of caveats sat under the table, unread, competing with the
    // numbers. They are all true and worth keeping — behind a disclosure, so
    // they are there when a number is being doubted and invisible otherwise.
    const details = document.createElement("details");
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = "How these numbers are worked out";
    summaryEl.style.cssText = "color:#666;font-size:12px;cursor:pointer;margin-top:6px;";
    details.appendChild(summaryEl);

    const note = document.createElement("p");
    note.textContent =
      "*Based on your timetable (open the Timetable page once for the exact " +
      "schedule; otherwise it's inferred from attendance history) and the " +
      'academic calendar. "Safe to skip now" never lets you dip below 75% at ' +
      "any moment; the before-exam columns mean ≥75% on exam day IF you " +
      "attend all the other remaining classes. Past exams show what you " +
      'could have bunked back then; "none this sem" means the calendar has ' +
      'no such exam; "--" means the calendar could not be ' +
      "read. Lab numbers are whole lab sessions, not hours; lab rows count " +
      "toward the LAB FAT day (labs have no CATs — the theory FAT date is " +
      "used only if the calendar marks no separate lab FAT). One-off " +
      "day-order swaps and unposted attendance are not visible here.";
    note.style.cssText = "color:#666;font-size:12px;margin-top:5px;";
    details.appendChild(note);
    container.appendChild(details);

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
    const key = classArgOf(s.call);
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

  // …and keep them ACROSS page loads. Every visit to Attendance used to refetch
  // one register per subject, one after another, which is the long "fetching
  // attendance details…" wait. A register only changes when the table's own
  // attended/total counts change, so those counts are the cache key's
  // signature: same counts, same register, no request.
  const PERSIST_KEY = "vrevamp_att_history";
  const encodeHistory = (h) => h.map((e) => [e.date.getTime(), e.attended ? 1 : 0]);
  const decodeHistory = (a) => a.map(([t, p]) => ({ date: new Date(t), attended: !!p }));

  const doRun = async () => {
    const tableWrap = document.querySelector(".table-responsive");
    if (!tableWrap) return;
    // A just-opened semester lists every course as 0/0 — those registers are
    // empty, so probing the detail endpoints for them is pure waste
    const headRow =
      tableWrap.querySelector("thead tr") ||
      (tableWrap.querySelector("table") || { rows: [] }).rows[0];
    const totalCol = headRow
      ? Array.from(headRow.cells).findIndex((c) => /total/i.test(c.innerText))
      : -1;
    const attendedCol = headRow
      ? Array.from(headRow.cells).findIndex((c) => /attended/i.test(c.innerText))
      : -1;
    const rowSig = (row) =>
      [totalCol, attendedCol]
        .map((i) => (i >= 0 && row.cells && row.cells[i] ? row.cells[i].innerText.trim() : "?"))
        .join("/");
    const hasClasses = (row) => {
      if (totalCol === -1 || !row.cells || row.cells.length <= totalCol)
        return true; // can't judge — keep the row
      return parseFloat(row.cells[totalCol].innerText) > 0;
    };
    const subjects = Array.from(tableWrap.querySelectorAll("tbody tr"))
      .map((row) => ({ row, call: extractDetailCall(row) }))
      .filter((s) => s.call && hasClasses(s.row));
    if (subjects.length === 0) {
      const sample = tableWrap.querySelector("tbody tr");
      showStatus(
        "VTOP Extension: couldn't find the attendance detail link in the table rows — bunk calculator skipped.",
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
    showStatus("VTOP Extension: fetching attendance details…", null, false);
    const collected = [];
    let lastDetailError = "";
    let persisted = {};
    try {
      persisted = (await chrome.storage.local.get(PERSIST_KEY))[PERSIST_KEY] || {};
    } catch (e) {
      /* no storage: just fetch */
    }
    let persistedDirty = false;
    for (const s of subjects) {
      try {
        // VTOP swapped the table out mid-run (semester change) — these rows
        // are gone, and a fresh run for the new table is already queued
        if (!s.row.isConnected && !liveRowFor(s)) continue;
        const cacheKey = s.call.args.join("|");
        const sig = rowSig(s.row);
        let history = historyCache[cacheKey];
        const saved = persisted[cacheKey];
        if (!history && saved && saved.sig === sig && Array.isArray(saved.h)) {
          history = decodeHistory(saved.h);
          historyCache[cacheKey] = history;
        }
        if (!history) {
          history = await fetchDetailHistory(s.call);
          historyCache[cacheKey] = history;
          if (history.length > 0) {
            persisted[cacheKey] = { sig, h: encodeHistory(history) };
            persistedDirty = true;
          }
          await sleepMs(250);
        }
        if (history.length === 0) continue;
        collected.push({ s, history });
      } catch (error) {
        console.warn("vRevamp: subject insight failed", error);
        lastDetailError = String(error && error.message ? error.message : error);
      }
    }

    if (persistedDirty) {
      try {
        chrome.storage.local.set({ [PERSIST_KEY]: persisted });
      } catch (e) {
        /* best effort */
      }
    }

    if (collected.length === 0) {
      showStatus(
        "VTOP Extension: couldn't fetch attendance details automatically. " +
          "FIX: click the eye icon in the Attendance Detail column for any ONE subject " +
          "(let the popup open), close it, then re-open this attendance page — " +
          "VTOP Extension learns the request from VTOP itself and it will work from then on. " +
          `(${lastDetailError || "responses had no attendance rows"})`,
        lastDetailResponseSample ||
          (subjects[0] ? subjects[0].row.outerHTML : null)
      );
      return;
    }

    // Phase 2: academic calendar, then the bunk table
    showStatus("VTOP Extension: reading the academic calendar…", null, false);
    const calendar = semesterName
      ? await getAcademicCalendar(semesterName)
      : null;

    // The student's actual timetable (if they've opened the timetable page)
    // gives the true weekly schedule; fall back to inferring it from history.
    const schedule = scheduleFromTimetable(await getSavedTimetable());
    const timetableSaved = Object.keys(schedule).length > 0;

    const todayIso = isoOf(new Date());
    const rowsData = collected.map(({ s, history }) => {
      const attended = history.filter((h) => h.attended).length;
      const total = history.length;
      const rowEl = liveRowFor(s) || s.row;
      const code = courseCodeOf(rowEl);
      // Lab or theory comes from the row's own course-type text ("Embedded
      // Lab" / "Theory Only") — inferring it from 2-entries-per-date
      // mislabels summer theory (meets twice daily) as a lab. The data
      // heuristic remains only for rows that name neither.
      const rowText = rowEl.innerText || rowEl.textContent || "";
      const isLab =
        /\blab\b/i.test(rowText) ||
        (!/theory/i.test(rowText) && sessionSize(history) > 1);
      const size = isLab ? sessionSize(history) : 1;
      const unit = isLab ? " lab(s)" : "";
      // this subject's OWN kind from the timetable — embedded theory and
      // lab share the course code
      const sched =
        code && schedule[code]
          ? schedule[code][isLab ? "lab" : "theory"]
          : null;
      let meetings;
      let inferred = false;
      const hadSched = !!(sched && Object.keys(sched).length);
      if (hadSched && timetableMatchesHistory(sched, history)) {
        if (isLab) {
          // timetable lab cells are hours (2 per session); history entries
          // per session vary by deployment — convert to history units
          meetings = {};
          Object.entries(sched).forEach(([wd, cells]) => {
            meetings[wd] = Math.max(1, Math.floor(cells / 2)) * size;
          });
        } else {
          meetings = sched;
        }
      } else {
        meetings = weekdayMeetings(history);
        inferred = true;
      }
      // The row's slot string ("L31+L32+L43+L44") knows the real weekly
      // schedule: L-slots come in 2-hour pairs, so 4 slots = 2 sessions/
      // week. If the register has posted fewer weekly days than that, the
      // projections undercount — warn instead of silently trusting it.
      const slotPairs = isLab
        ? Math.floor((rowText.match(/\bL\d+\b/g) || []).length / 2)
        : 0;
      // next upcoming exam (label + date), for the forecast banner and the
      // home-page notices card. Labs sit no CATs — their only exam is the
      // lab FAT (theory FAT date as fallback when the calendar doesn't mark
      // a separate lab day).
      const nextExam =
        (isLab
          ? [["lab FAT", calendar && (calendar.labFat || calendar.fat)]]
          : [
              ["CAT-1", calendar && calendar.cat1],
              ["CAT-2", calendar && calendar.cat2],
              ["FAT", calendar && calendar.fat],
            ])
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
      // VTOP's own table ceils the percentage (1/3 -> 34%) — display the
      // same so the banner never seems to disagree with the row beside it;
      // threshold checks use the exact ratio so ceil can't hide a shortfall
      const ratio = total ? attended / total : null;
      const pct = ratio === null ? null : Math.ceil(ratio * 100);
      const below75 = ratio !== null && ratio < ATTENDANCE_MIN;
      const lastPosted = history.length
        ? history[history.length - 1].date
        : null;
      const staleSince =
        lastPosted && missedPostings(calendar, meetings, lastPosted) >= 2
          ? shortDate(lastPosted)
          : null;
      // Scheduled class days INSIDE the posted range with no register entry:
      // either the class didn't happen or the faculty never posted it. The
      // percentage math stays correct either way (it only counts entries),
      // but surface the dates so a too-good-looking register can be traced.
      // Bounded by the first and last posted entries — courses register on
      // different dates so earlier days prove nothing, and days after the
      // last entry are the stale flag's territory.
      const postedIsos = new Set(history.map((h) => isoOf(h.date)));
      const gapDates = [];
      if (calendar && history.length) {
        const firstPosted = isoOf(history[0].date);
        const lastPostedIso = isoOf(history[history.length - 1].date);
        calendar.instructionalDays.forEach((dayIso) => {
          if (dayIso <= firstPosted || dayIso >= lastPostedIso) return;
          if ((meetings[wdOfIso(dayIso)] || 0) > 0 && !postedIsos.has(dayIso))
            gapDates.push(dayIso);
        });
      }
      const gapNote = gapDates.length
        ? `no entry for ${gapDates.length} scheduled class day(s): ` +
          gapDates
            .slice(0, 3)
            .map((d) => shortDate(dateOfIso(d)))
            .join(", ") +
          (gapDates.length > 3 ? "…" : "")
        : null;
      const seenDays = Object.keys(meetings).length;
      const remainEntries = calendar
        ? countClassesUntil(calendar, meetings, null)
        : null;
      // Never-dip variant: largest b with attended/(total + b) >= 75% — you
      // stay above the limit at every moment, in any order, no assumption
      // that you attend the rest. (The before-exam columns instead answer
      // "≥75% ON exam day if I attend everything else".)
      const safeNowEntries = Math.max(
        0,
        Math.min(
          remainEntries === null ? Infinity : remainEntries,
          Math.floor((4 * attended - 3 * total) / 3)
        )
      );
      // Debar forecast: if you stop attending today, the date the running
      // percentage first drops under 75% (each future class only grows the
      // denominator)
      const semOver =
        calendar &&
        calendar.lastInstructional &&
        calendar.lastInstructional < todayIso;
      let debarNote = null;
      if (semOver) {
        debarNote = "semester over";
      } else if (total && attended / total < ATTENDANCE_MIN) {
        debarNote = "already below 75%";
      } else if (calendar && total) {
        let cum = 0;
        for (const iso of calendar.instructionalDays) {
          if (iso <= todayIso) continue;
          cum += meetings[wdOfIso(iso)] || 0;
          if (attended / (total + cum) < ATTENDANCE_MIN) {
            debarNote = `skip everything → <75% on ${shortDate(dateOfIso(iso))}`;
            break;
          }
        }
        if (!debarNote) debarNote = "can't drop below 75% this sem";
      }
      // Best case: attend every remaining class. When even that lands under
      // 75%, "attend the next N to recover" is impossible advice — the
      // banner says so instead.
      const maxPct =
        remainEntries !== null && total
          ? Math.round(
              ((attended + remainEntries) / (total + remainEntries)) * 100
            )
          : null;
      const canRecover =
        maxPct === null ||
        (attended + remainEntries) / (total + remainEntries) >= ATTENDANCE_MIN;
      const bestNote =
        maxPct !== null
          ? semOver
            ? `semester over — final ${pct}%`
            : `attend all → ${maxPct}%`
          : null;
      return {
        name: subjectName(liveRowFor(s) || s.row),
        code,
        attended,
        total,
        size,
        // the weekly pattern this subject meets on, carried out of here so the
        // skip planner below can count the classes inside an arbitrary date
        // range rather than only up to an exam (2026-08-22)
        meetings,
        remainEntries,
        staleSince,
        debarNote,
        bestNote,
        safeCount: Math.floor(safeNowEntries / size),
        partialNote:
          slotPairs > seenDays
            ? `register shows only ${seenDays} of ~${slotPairs} weekly lab day(s)`
            : inferred && timetableSaved
              ? (hadSched
                  ? "saved timetable disagrees with this register"
                  : "not in the saved timetable") +
                ` — schedule guessed from ${seenDays} posted weekday(s)`
              : null,
        gapNote,
        canRecover,
        maxPct,
        nextBunkable,
        nextExamLabel: nextExam ? nextExam[0] : null,
        // WHICH exam nextBunkable counts up to. Without it the number is
        // undated and cannot be checked later — which is exactly how the home
        // page came to display "only 0 class(es) skippable before the next
        // exam" for a subject with three in hand: that 0 was computed against
        // CAT-1 days earlier, CAT-1 then arrived, and nothing could tell that
        // the figure had stopped meaning anything. See js/home_notices.js.
        nextExamIso: upcoming,
        pct,
        below75,
        // attendToTarget works in history entries (hours for labs) — show
        // whole sessions like every other number
        recover: below75 ? Math.ceil(attendToTarget(attended, total) / size) : 0,
        unit: isLab ? "lab(s)" : "class(es)",
        // whole sessions for labs, matching every other displayed number
        // (this deployment posts one entry per session, but older ones post
        // per hour — total is in raw entries)
        held: Math.floor(total / size),
        remaining:
          remainEntries !== null
            ? `${Math.floor(remainEntries / size)}${unit}`
            : "--",
        safeNow: `${Math.floor(safeNowEntries / size)}${unit}`,
        cat1: isLab ? "no CATs for labs" : bunkCell(calendar, calendar && calendar.cat1, attended, total, meetings, history, size, unit),
        cat2: isLab ? "no CATs for labs" : bunkCell(calendar, calendar && calendar.cat2, attended, total, meetings, history, size, unit),
        fat: bunkCell(calendar, calendar && (isLab ? calendar.labFat || calendar.fat : calendar.fat), attended, total, meetings, history, size, unit),
      };
    });

    renderForecastBanner(rowsData);
    renderBunkTable(rowsData);
    // and the planner, under the bunk table it complements — that table
    // answers "up to CAT-2", this one answers "between these two dates"
    const bunkBox = document.getElementById("vrevamp-bunk-table-container");
    if (bunkBox) renderSkipPlanner(rowsData, calendar, bunkBox);

    // stale registers also get a visible nudge on VTOP's own row, where the
    // (outdated) percentage is displayed
    rowsData.forEach((r, i) => {
      if (!r.staleSince) return;
      const row = liveRowFor(collected[i].s);
      if (!row || row.querySelector(".vrevamp-stale-flag")) return;
      const cell =
        row.cells && row.cells.length > 2 ? row.cells[2] : row.cells && row.cells[0];
      if (!cell) return;
      const flag = document.createElement("div");
      flag.className = "vrevamp-stale-flag";
      flag.textContent = `⚠ not posted since ${r.staleSince}`;
      flag.title =
        "VTOP Extension: this register hasn't been updated — the percentage shown here is outdated";
      flag.style.cssText =
        "color:#c0392b;font-size:11px;font-weight:bold;margin-top:2px;";
      cell.appendChild(flag);
    });

    // snapshot for the home-page notices card and the marks-page flag
    chrome.storage.local.set({
      vrevamp_attendance_summary: {
        fetchedAt: Date.now(),
        semester: semesterName,
        subjects: rowsData.map((r) => ({
          name: r.name,
          code: r.code,
          pct: r.pct,
          safeNow: r.safeCount,
          nextBunkable: r.nextBunkable,
          nextExamIso: r.nextExamIso,
          nextExamLabel: r.nextExamLabel,
          unit: r.unit,
          /*
           * DEBAR FIELDS — added 2026-08-17 because the home card was asked to
           * stop leading with "skippable before CAT-1" and lead with debarment
           * instead. That is the right call and not only a wording change:
           * "before CAT-1" stops meaning anything the day CAT-1 arrives (see
           * js/home_notices.js), whereas 75% is the rule that actually costs a
           * student the exam hall, and it is measured against the whole
           * semester so it never silently expires.
           *
           * safeNow above already IS the debar headroom — how many sessions can
           * be missed while never dipping under 75%. What the card could not do
           * without these is speak to the student already UNDER the line, who
           * needs "attend the next N", or to the one for whom even a perfect
           * record no longer reaches 75%, who needs to be told to stop counting.
           */
          below75: r.below75,
          recover: r.recover,
          canRecover: r.canRecover,
          maxPct: r.maxPct,
          debarNote: r.debarNote,
        })),
      },
    });

    if (semesterName && !calendar) {
      showStatus(
        `VTOP Extension: academic calendar could not be read — bunk columns show "--". (${lastCalendarError})`
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
      // before any projection: the days no class will be held on because an
      // exam block is running (2026-08-22)
      await loadExamBlockDays();
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
