/*
 * Next-class widget on the VTOP home page. Reads the saved timetable
 * (timeTable-V1) and shows the current or next class with a live countdown
 * that ticks every minute. Nothing is fetched; if the timetable hasn't been
 * saved yet (the student hasn't opened the Timetable page) it stays silent.
 */
(() => {
  const CARD_ID = "vrevamp-next-class";

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
    const header = filterRepeated(timetable.header);
    const today = new Date().getDay();
    const row = timetable.data.find((r) => dayToNum(r.day) === today);
    if (!row) return [];
    const theory = Array.isArray(row.theory) ? row.theory : [];
    const lab = Array.isArray(row.lab) ? row.lab : [];
    const classes = [];
    for (let i = 1; i < header.length; i++) {
      const range = parseRange(header[i]);
      if (!range) continue;
      const info = parseCell(theory[i]) || parseCell(lab[i]);
      if (!info) continue;
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

  const render = async () => {
    const container =
      document.querySelector("#main-section") ||
      document.querySelector(".content-wrapper");
    if (!container) return false;
    if (timetable === undefined) timetable = await getSavedTimetable();
    const info = describe(todaysClasses(timetable));
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
        console.warn("vRevamp next-class:", error);
      }
      if (done || attempts >= 10) clearInterval(timer);
    }, 700);
  };

  // live countdown: re-render once a minute while the card is on screen
  setInterval(() => {
    if (document.getElementById(CARD_ID))
      render().catch((error) => console.warn("vRevamp next-class:", error));
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
