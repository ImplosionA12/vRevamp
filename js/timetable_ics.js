/*
 * Full-timetable .ics export. Adds a button to the timetable page that turns
 * the saved weekly timetable (timeTable-V1) into a calendar of weekly
 * recurring events (one per class), reusing the cached academic calendar's
 * last instructional day as the recurrence end when available.
 */
(() => {
  const BTN_ID = "vrevamp-timetable-ics";
  const CALENDAR_PREFIX = "vrevamp_calendar_";

  // getDay() index for the recurrence: 0=Sun..6=Sat
  const dayToNum = (name) =>
    ({ SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 })[
      String(name || "").trim().toUpperCase().slice(0, 3)
    ];

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

  const parseCell = (cell) => {
    const text = clean(cell);
    if (!/[A-Z]{2,4}\d{3,4}/.test(text)) return null;
    const seg = text.split(" ").find((t) => /[A-Z]{2,4}\d{3,4}/.test(t)) || text;
    const parts = seg.split("-");
    return { slot: parts[0] || "", course: parts[1] || "", venue: parts[3] || "" };
  };

  // Per day: classes sorted by start, with contiguous same-course slots merged
  // into a single block (so a 2-hour lab becomes one event).
  const classesForDay = (header, row) => {
    const theory = Array.isArray(row.theory) ? row.theory : [];
    const lab = Array.isArray(row.lab) ? row.lab : [];
    const raw = [];
    for (let i = 1; i < header.length; i++) {
      const range = parseRange(header[i]);
      if (!range) continue;
      const info = parseCell(theory[i]) || parseCell(lab[i]);
      if (!info) continue;
      raw.push({ ...range, ...info });
    }
    raw.sort((a, b) => a.start - b.start);
    const merged = [];
    raw.forEach((c) => {
      const prev = merged[merged.length - 1];
      // merge back-to-back hours of the same course (VTOP leaves a ~10 min
      // gap between consecutive slots, so allow a small gap)
      if (prev && prev.course === c.course && c.start <= prev.end + 15) {
        prev.end = Math.max(prev.end, c.end);
      } else {
        merged.push({ ...c });
      }
    });
    return merged;
  };

  // Most recent occurrence of weekday wd on/before today, so the series
  // includes the current week.
  const anchorDate = (wd) => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const diff = (base.getDay() - wd + 7) % 7;
    base.setDate(base.getDate() - diff);
    return base;
  };

  const ymd = (d) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
      d.getDate()
    ).padStart(2, "0")}`;
  const hms = (mins) =>
    `${String(Math.floor(mins / 60)).padStart(2, "0")}${String(mins % 60).padStart(
      2,
      "0"
    )}00`;

  const getLatestCalendarEnd = async () => {
    const all = await chrome.storage.local.get(null);
    const cals = Object.keys(all)
      .filter((k) => k.startsWith(CALENDAR_PREFIX))
      .map((k) => all[k])
      .filter((c) => c && c.lastInstructional)
      .sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
    return cals[0] ? cals[0].lastInstructional : null; // "YYYY-MM-DD"
  };

  const buildIcs = (timetable, untilIso) => {
    const header = filterRepeated(timetable.header);
    const now = new Date();
    const stamp =
      now.getUTCFullYear() +
      String(now.getUTCMonth() + 1).padStart(2, "0") +
      String(now.getUTCDate()).padStart(2, "0") +
      "T" +
      String(now.getUTCHours()).padStart(2, "0") +
      String(now.getUTCMinutes()).padStart(2, "0") +
      String(now.getUTCSeconds()).padStart(2, "0") +
      "Z";

    // recurrence end: lastInstructional + 1 day buffer, else ~17 weeks out
    const end = untilIso
      ? new Date(untilIso + "T00:00:00")
      : new Date(Date.now() + 17 * 7 * 24 * 3600 * 1000);
    end.setDate(end.getDate() + 1);
    const until = ymd(end) + "T180000Z";

    let count = 0;
    let body = "";
    timetable.data.forEach((row) => {
      const wd = dayToNum(row.day);
      if (wd === undefined) return;
      const date = ymd(anchorDate(wd));
      classesForDay(header, row).forEach((c) => {
        count++;
        body +=
          "BEGIN:VEVENT\n" +
          `UID:${stamp}-${c.course}-${wd}-${c.slot}-${count}@vitap.ac.in\n` +
          `DTSTAMP:${stamp}\n` +
          `DTSTART;TZID=Asia/Kolkata:${date}T${hms(c.start)}\n` +
          `DTEND;TZID=Asia/Kolkata:${date}T${hms(c.end)}\n` +
          `RRULE:FREQ=WEEKLY;UNTIL=${until}\n` +
          `SUMMARY:${c.course}${c.slot ? ` (${c.slot})` : ""}\n` +
          (c.venue ? `LOCATION:${c.venue}\n` : "") +
          "END:VEVENT\n\n";
      });
    });

    if (count === 0) return null;
    return (
      "BEGIN:VCALENDAR\n" +
      "VERSION:2.0\n" +
      "PRODID:-//vRevamp//Timetable//EN\n" +
      "CALSCALE:GREGORIAN\n\n" +
      body +
      "END:VCALENDAR"
    );
  };

  const download = (ics) => {
    const a = document.createElement("a");
    a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
    a.download = "vRevamp timetable.ics";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const onClick = async () => {
    const timetable = await getSavedTimetable();
    if (!timetable || !Array.isArray(timetable.data) || !timetable.data.length) {
      alert(
        "vRevamp: no saved timetable yet. Let the timetable finish loading on " +
          "this page, then try again."
      );
      return;
    }
    const ics = buildIcs(timetable, await getLatestCalendarEnd());
    if (!ics) {
      alert("vRevamp: couldn't read any classes from the timetable.");
      return;
    }
    download(ics);
  };

  const addButton = () => {
    if (document.getElementById(BTN_ID)) return true;
    const loader = document.getElementById("loadMyFragment");
    const anchor = loader ? loader.parentElement : document.querySelector("#main-section");
    if (!anchor) return false;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.className = "btn btn-primary";
    btn.textContent = " Export timetable to .ics ";
    btn.style.cssText = "margin:8px;background:rgb(73,117,182);";
    btn.onclick = onClick;
    anchor.insertBefore(btn, anchor.firstChild);
    return true;
  };

  const addWithRetries = () => {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (addButton() || attempts >= 10) clearInterval(timer);
    }, 700);
  };

  chrome.runtime.onMessage.addListener((request) => {
    if (request.message === "timetable_view_page") addWithRetries();
  });
})();
