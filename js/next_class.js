/*
 * Next-class widget on the VTOP home page. Reads the saved timetable
 * (timeTable-V1) and shows the current or next class with a live countdown
 * that ticks every minute. Nothing is fetched; if the timetable hasn't been
 * saved yet (the student hasn't opened the Timetable page) it stays silent.
 */
(() => {
  const CARD_ID = "vtopext-next-class";

  // Saved day cells are 3-letter codes ("MON"); tolerate full names too.
  const dayToNum = (name) =>
    ({ SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 })[
      String(name || "").trim().toUpperCase().slice(0, 3)
    ];

  // getTimeTable (js/store/saveTimeTableDetails.js, shared content world) is
  // callback-based; wrap it and never reject.
  const getSavedTimetable = () =>
    new Promise((resolve) => {
      try {
        if (typeof getTimeTable !== "function") return resolve(null);
        getTimeTable((d) => resolve(d || null));
      } catch (error) {
        resolve(null);
      }
    });

  const clean = (html) =>
    String(html || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

  const parseRange = (text) => {
    const m = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/.exec(text || "");
    if (!m) return null;
    return { start: +m[1] * 60 + +m[2], end: +m[3] * 60 + +m[4] };
  };

  // Cell looks like "TA1-CSE1005-ETH-G14-CB-ALL" (slot-course-type-venue-…).
  const parseCell = (cell) => {
    const text = clean(cell);
    if (!/[A-Z]{2,4}\d{3,4}/.test(text)) return null;
    const seg = text.split(" ").find((t) => /[A-Z]{2,4}\d{3,4}/.test(t)) || text;
    const parts = seg.split("-");
    return { slot: parts[0] || "", course: parts[1] || "", venue: parts[3] || "" };
  };

  // Today's classes, sorted by start time. Returns null when there's no saved
  // timetable, [] when today simply has no classes.
  const todaysClasses = (timetable) => {
    if (
      !timetable ||
      !Array.isArray(timetable.data) ||
      !Array.isArray(timetable.header)
    )
      return null;
    // saved header keeps repeated time columns; filterRepeated collapses them
    // so index i aligns with the de-duplicated theory/lab rows
    // Collapse repeated time columns by the SAME kept indices for both grids,
    // so headerLab[i] still describes the column theory header[i] describes.
    // (filterRepeated(headerLab) on its own could drop different positions and
    // silently shift every lab time by a column.)
    const seen = new Set();
    const keep = [];
    timetable.header.forEach((h, i) => {
      if (seen.has(h)) return;
      seen.add(h);
      keep.push(i);
    });
    const header = keep.map((i) => timetable.header[i]);
    const rawLab = Array.isArray(timetable.headerLab) ? timetable.headerLab : [];
    const headerLab = keep.map((i) => rawLab[i]);

    const today = new Date().getDay();
    const row = timetable.data.find((r) => dayToNum(r.day) === today);
    if (!row) return [];
    const theory = Array.isArray(row.theory) ? row.theory : [];
    const lab = Array.isArray(row.lab) ? row.lab : [];
    const classes = [];
    for (let i = 1; i < header.length; i++) {
      const fromTheory = parseCell(theory[i]);
      const fromLab = fromTheory ? null : parseCell(lab[i]);
      const info = fromTheory || fromLab;
      if (!info) continue;
      // A lab must take its own grid's time. Falling back to the theory column
      // (legacy saves have no headerLab) is what showed L35 as 18:00 when it
      // really starts at 17:40.
      const range = parseRange(
        fromLab ? headerLab[i] || header[i] : header[i]
      );
      if (!range) continue;
      classes.push({ ...range, ...info });
    }
    classes.sort((a, b) => a.start - b.start);
    return classes;
  };

  const fmtMin = (m) => {
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  };
  const fmtClock = (mins) =>
    `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(
      mins % 60
    ).padStart(2, "0")}`;

  /* -------------------------------------------------------------------------
   * EXAM BLOCKS — asked for 2026-08-22
   * -------------------------------------------------------------------------
   * "it says i have a next class on hompage but until the last exam coplete
   * ... until the cat exams over there wont be classes".
   *
   * Right, and the card had no way to know: it reads the saved timetable and
   * nothing else, so during a CAT it cheerfully announces the class that
   * would have run. A timetable says what happens in an ordinary week; an
   * exam block is precisely the week that is not ordinary.
   *
   * The block is taken from the cached exam schedule rather than the academic
   * calendar, deliberately. The calendar marks a day "CAT-2" only where an
   * exam is actually sat, and whether it ALSO marks it instructional varies;
   * the exam schedule carries dated rows per exam, so first-to-last of a type
   * is the block — and a day inside it with no exam of your own is still a day
   * with no classes, which is exactly the case the student is asking about.
   */
  // LOCAL "YYYY-MM-DD". toISOString() is UTC, which east of Greenwich rolls
  // the date over before midnight local — the same trap home_notices.js and
  // attendance_insights.js both document.
  const isoToday = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const examWindows = (schedule) => {
    const byType = {};
    (((schedule || {}).exams) || []).forEach((exam) => {
      if (!exam || !exam.dateIso) return;
      const type = exam.type || "Exam";
      const window = byType[type];
      if (!window) {
        byType[type] = { type, from: exam.dateIso, to: exam.dateIso };
        return;
      }
      if (exam.dateIso < window.from) window.from = exam.dateIso;
      if (exam.dateIso > window.to) window.to = exam.dateIso;
    });
    return Object.keys(byType).map((k) => byType[k]);
  };

  const examBlockOn = (schedule, iso) =>
    examWindows(schedule).find((w) => iso >= w.from && iso <= w.to) || null;

  const describeExamDay = (schedule, block, iso) => {
    const mine = (((schedule || {}).exams) || [])
      .filter((e) => e.dateIso === iso)
      .sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));
    if (mine.length) {
      const first = mine[0];
      const when = first.reporting ? `, report ${first.reporting}` : "";
      const where = first.venue && first.venue !== "-" ? ` @ ${first.venue}` : "";
      const more = mine.length > 1 ? ` (+${mine.length - 1} more today)` : "";
      return {
        tone: "#c0392b",
        text: `\u{1F4DD} ${block.type} today: ${first.code}${where}${when}${more} — no regular classes.`,
      };
    }
    const [y, m, d] = block.to.split("-").map(Number);
    const until = new Date(y, m - 1, d).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
    });
    return {
      tone: "#b8860b",
      text: `\u{1F4DD} ${block.type} block runs to ${until} — no regular classes, and no exam of yours today.`,
    };
  };

  const describe = (classes) => {
    if (classes === null) return null; // no saved timetable
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const venueOf = (c) => (c.venue ? ` @ ${c.venue}` : "");
    if (classes.length === 0)
      return { tone: "#2e7d32", text: "\u{1F4ED} No classes scheduled today — enjoy!" };
    const ongoing = classes.find((c) => cur >= c.start && cur < c.end);
    if (ongoing)
      return {
        tone: "#b8860b",
        text: `\u{1F7E2} In class now: ${ongoing.course} (${ongoing.slot})${venueOf(
          ongoing
        )} — ends in ${fmtMin(ongoing.end - cur)}`,
      };
    const next = classes.find((c) => c.start > cur);
    if (!next)
      return { tone: "#2e7d32", text: "✅ Done for the day — no more classes." };
    return {
      tone: "#c0392b",
      text: `⏰ Next: ${next.course} (${next.slot})${venueOf(next)} at ${fmtClock(
        next.start
      )} — in ${fmtMin(next.start - cur)}`,
    };
  };

  let timetable; // undefined = not loaded yet, null = none saved
  let timetableStale = false;

  const getLatestCalendar = async () => {
    const pointer = await chrome.storage.local.get("vtopext_latest_calendar");
    if (pointer.vtopext_latest_calendar) return pointer.vtopext_latest_calendar;
    // written by the attendance page; until it has run once, fall back to the scan
    const all = await chrome.storage.local.get(null);
    const calendars = Object.keys(all)
      .filter((k) => k.startsWith("vtopext_calendar_"))
      .map((k) => all[k]);
    calendars.sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
    return calendars[0] || null;
  };

  // A timetable saved during a previous semester must not drive "Done for
  // the day" / "No classes today" — the new semester's classes are simply
  // unknown. semesterLooksStale lives in js/utils/chooseCurrentSem.js.
  const checkStale = async (tt) => {
    if (!tt || typeof semesterLooksStale !== "function") return false;
    const calendar = await getLatestCalendar();
    if (tt.semester) {
      // only trust the calendar's end dates if it belongs to the same sem
      const calMatches =
        calendar &&
        String(calendar.semester || "").trim() === String(tt.semester).trim();
      return semesterLooksStale(tt.semester, calMatches ? calendar : null);
    }
    // no semester stamp but a save date: VTOP's timetable page can render
    // the registered semester with the dropdown still on the placeholder
    // (seen live 2026-07-16), so judge by when it was saved — a save made
    // during the current term is current data
    if (typeof tt.savedAt === "number") {
      const termStart =
        typeof currentTermStartEstimate === "function"
          ? currentTermStartEstimate()
          : null;
      return !!(termStart && tt.savedAt < termStart.getTime());
    }
    // legacy blob (no stamps at all — saved before this feature): it is at
    // least as old as the newest cached calendar, so if that calendar's
    // semester is over, the timetable is too
    return !!(calendar && semesterLooksStale(calendar.semester, calendar));
  };

  const render = async () => {
    const container =
      document.querySelector("#main-section") ||
      document.querySelector(".content-wrapper") ||
      // 2026 layout: the scrollable content wrapper (see home_notices.js)
      document.querySelector("#core-container .overflow-auto.showBlock") ||
      document.querySelector("#b5wrapper");
    if (!container) return false;
    if (timetable === undefined) {
      timetable = await getSavedTimetable();
      timetableStale = await checkStale(timetable);
    }
    /*
     * The exam block outranks the timetable, but NOT the stale-timetable
     * warning: if the saved timetable is last semester's, that is the thing
     * the student has to fix, and a confident exam line on top of it would
     * only bury it. It is read fresh each render — this runs once a minute,
     * a storage read is cheap, and a schedule cached mid-session should take
     * effect without a reload.
     */
    let examLine = null;
    if (!timetableStale) {
      try {
        const iso = isoToday();
        const cached = (await chrome.storage.local.get("vtopext_exam_schedule"))
          .vtopext_exam_schedule;
        const block = examBlockOn(cached, iso);
        if (block) examLine = describeExamDay(cached, block, iso);
      } catch (error) {
        console.warn("VTOP Extension next-class:", error); // no schedule cached yet
      }
    }

    const info = timetableStale
      ? {
          tone: "#b8860b",
          text: "\u{1F5D3}️ Saved timetable looks like last semester's — open the Time Table page once to refresh it.",
        }
      : examLine || describe(todaysClasses(timetable));
    if (!info) return true; // no timetable saved — stay silent
    let card = document.getElementById(CARD_ID);
    if (!card) {
      card = document.createElement("div");
      card.id = CARD_ID;
      card.style.cssText =
        "margin:10px;padding:8px 14px;background:#fff;border:1px solid #ccc;" +
        "border-radius:4px;font-size:14px;color:#333;" +
        "box-shadow:0 1px 3px rgba(0,0,0,0.1);";
      container.insertBefore(card, container.firstChild);
    }
    card.style.borderLeft = `4px solid ${info.tone}`;
    card.textContent = info.text;
    return true;
  };

  const renderWithRetries = () => {
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts++;
      let done = false;
      try {
        done = await render();
      } catch (error) {
        done = true;
        console.warn("VTOP Extension next-class:", error);
      }
      if (done || attempts >= 10) clearInterval(timer);
    }, 700);
  };

  // live countdown: re-render once a minute while the card is on screen
  setInterval(() => {
    if (document.getElementById(CARD_ID))
      render().catch((error) => console.warn("VTOP Extension next-class:", error));
  }, 60000);

  chrome.runtime.onMessage.addListener((request) => {
    if (
      request.message === "vtop2_nav_bar" ||
      request.message === "nav_bar_change"
    ) {
      timetable = undefined; // re-read in case the timetable was updated
      renderWithRetries();
    }
  });

  renderWithRetries();
})();
