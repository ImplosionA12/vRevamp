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
    let sawResponse = false;
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
    return {
      cat1: !cat2 && /CAT\s*-?\s*(I|1)\b/i.test(text),
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
    // Newer VTOP encrypts the sidebar data-urls, so try the known calendar
    // endpoint first and only fall back to whatever the link carries.
    const candidates = ["academics/common/CalendarPreview"];
    const legacyUrl = findCalendarMenuUrl();
    if (legacyUrl && /^[\w/-]+$/.test(legacyUrl)) candidates.push(legacyUrl);

    let landing = null;
    let menuUrl = null;
    for (const candidate of candidates) {
      try {
        const doc = parseHtml(await vtopPost(candidate, { verifyMenu: "true" }));
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

    // month buttons: the dedicated endpoint first, then the legacy shape
    const monthDates = new Set(collectMonthDates(landing));
    try {
      const monthsPage = parseHtml(
        await vtopPost("getDateForSemesterPreview", { semSubId, classGroupId })
      );
      collectMonthDates(monthsPage).forEach((d) => monthDates.add(d));
    } catch (error) {
      /* older deployment */
    }
    if (monthDates.size === 0) {
      const monthsPage = parseHtml(await vtopPost(menuUrl, { semSubId }));
      collectMonthDates(monthsPage).forEach((d) => monthDates.add(d));
    }
    if (monthDates.size === 0)
      throw new Error("no month buttons found in calendar page");

    const days = [];
    for (const dateStr of monthDates) {
      const monthDate = parseAnyDate(dateStr);
      if (!monthDate) continue;
      const before = days.length;
      try {
        // current VTOP: dedicated grid endpoint with calDate
        const grid = parseHtml(
          await vtopPost("processViewCalendar", { calDate: dateStr, semSubId, classGroupId })
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

  // Expected class days for this subject after its last posted entry and
  // before today. >= 2 means the faculty's register is lagging — flag the
  // projections as stale instead of presenting them as current.
  const missedPostings = (calendar, meetings, lastPosted) => {
    if (!lastPosted) return 0;
    const startIso = isoOf(lastPosted);
    const todayIso = isoOf(new Date());
    let count = 0;
    const countDay = (iso) => {
      if (meetings[new Date(iso).getDay()]) count += 1;
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
    rowsData
      .filter((r) => r.staleSince)
      .forEach((r) =>
        addLine(
          `⚠ ${r.name}: attendance not posted since ${r.staleSince} — its numbers are unreliable until it's updated`,
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
      "Safe to skip now (never <75%)",
      "Bunkable before CAT-1",
      "Bunkable before CAT-2",
      "Bunkable before FAT",
    ].forEach((h) =>
      head.appendChild(makeCell("th", h, "background:rgb(60,141,188,0.8);"))
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
          const safe = Math.max(
            0,
            Math.floor(Math.floor((4 * a - 3 * t) / 3) / r.size)
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
      addCell(r.held);
      addCell(r.remaining, r.bestNote);
      addCell(r.safeNow, r.debarNote);
      addCell(r.cat1);
      addCell(r.cat2);
      addCell(r.fat);
      table.appendChild(tr);
    });
    container.appendChild(table);

    const note = document.createElement("p");
    note.textContent =
      "*Based on your timetable (open the Timetable page once for the exact " +
      "schedule; otherwise it's inferred from attendance history) and the " +
      'academic calendar. "Safe to skip now" never lets you dip below 75% at ' +
      "any moment; the before-exam columns mean ≥75% on exam day IF you " +
      "attend all the other remaining classes. Past exams show what you " +
      'could have bunked back then; "none this sem" means the calendar has ' +
      'no such exam; "--" means the calendar could not be ' +
      "read. Lab numbers are whole lab sessions, not hours. One-off " +
      "day-order swaps and unposted attendance are not visible here.";
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
        // VTOP swapped the table out mid-run (semester change) — these rows
        // are gone, and a fresh run for the new table is already queued
        if (!s.row.isConnected && !liveRowFor(s)) continue;
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
      if (
        sched &&
        Object.keys(sched).length &&
        timetableMatchesHistory(sched, history)
      ) {
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
      }
      // The row's slot string ("L31+L32+L43+L44") knows the real weekly
      // schedule: L-slots come in 2-hour pairs, so 4 slots = 2 sessions/
      // week. If the register has posted fewer weekly days than that, the
      // projections undercount — warn instead of silently trusting it.
      const slotPairs = isLab
        ? Math.floor((rowText.match(/\bL\d+\b/g) || []).length / 2)
        : 0;
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
      const lastPosted = history.length
        ? history[history.length - 1].date
        : null;
      const staleSince =
        lastPosted && missedPostings(calendar, meetings, lastPosted) >= 2
          ? shortDate(lastPosted)
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
          cum += meetings[new Date(iso).getDay()] || 0;
          if (attended / (total + cum) < ATTENDANCE_MIN) {
            debarNote = `skip everything → <75% on ${shortDate(new Date(iso))}`;
            break;
          }
        }
        if (!debarNote) debarNote = "can't drop below 75% this sem";
      }
      // Best case: attend every remaining class
      const bestNote =
        remainEntries !== null && total
          ? semOver
            ? `semester over — final ${pct}%`
            : `attend all → ${Math.round(((attended + remainEntries) / (total + remainEntries)) * 100)}%`
          : null;
      return {
        name: subjectName(liveRowFor(s) || s.row),
        code,
        attended,
        total,
        size,
        staleSince,
        debarNote,
        bestNote,
        safeCount: Math.floor(safeNowEntries / size),
        partialNote:
          slotPairs > seenDays
            ? `register shows only ${seenDays} of ~${slotPairs} weekly lab day(s)`
            : null,
        nextBunkable,
        nextExamLabel: nextExam ? nextExam[0] : null,
        pct,
        // attendToTarget works in history entries (hours for labs) — show
        // whole sessions like every other number
        recover:
          pct !== null && pct < 75
            ? Math.ceil(attendToTarget(attended, total) / size)
            : 0,
        unit: isLab ? "lab(s)" : "class(es)",
        held: total,
        remaining:
          remainEntries !== null
            ? `${Math.floor(remainEntries / size)}${unit}`
            : "--",
        safeNow: `${Math.floor(safeNowEntries / size)}${unit}`,
        cat1: bunkCell(calendar, calendar && calendar.cat1, attended, total, meetings, history, size, unit),
        cat2: bunkCell(calendar, calendar && calendar.cat2, attended, total, meetings, history, size, unit),
        fat: bunkCell(calendar, calendar && calendar.fat, attended, total, meetings, history, size, unit),
      };
    });

    renderForecastBanner(rowsData);
    renderBunkTable(rowsData);

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
        "vRevamp: this register hasn't been updated — the percentage shown here is outdated";
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
