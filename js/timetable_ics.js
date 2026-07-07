/*
 * Full-timetable calendar export. Adds two buttons to the timetable page:
 *  - .ics download: the saved weekly timetable (timeTable-V1) as weekly
 *    recurring events (one per class), ending on the cached academic
 *    calendar's last instructional day when available.
 *  - Google Calendar import: the same series created directly in the
 *    user's primary calendar (subject title + venue), with holidays and
 *    other non-instructional days EXDATE'd out. Tagged, so a re-import
 *    replaces the previous one instead of duplicating it.
 */
(() => {
  const BTN_ID = "vrevamp-timetable-ics";
  const GCAL_BTN_ID = "vrevamp-timetable-gcal";
  const CALENDAR_PREFIX = "vrevamp_calendar_";
  const GCAL_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

  // Fresh Google token via the worker at click time (chrome.identity refreshes
  // silently once consent exists). Shared with exam_schedule.js/da_upload.js,
  // hence the window guard.
  if (typeof window.vrGoogleToken !== "function") {
    window.vrGoogleToken = (opts) =>
      new Promise((resolve) => {
        const fallback = () =>
          chrome.storage.sync.get(["token"], (r) => resolve(r.token || null));
        try {
          chrome.runtime.sendMessage(
            {
              message: "get_google_token",
              interactive: !!(opts && opts.interactive),
              stale: (opts && opts.stale) || null,
            },
            (t) => {
              if (chrome.runtime.lastError || t === undefined) return fallback();
              resolve(t || null);
            }
          );
        } catch {
          fallback();
        }
      });
  }

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

  const getLatestCalendar = async () => {
    const all = await chrome.storage.local.get(null);
    const cals = Object.keys(all)
      .filter((k) => k.startsWith(CALENDAR_PREFIX))
      .map((k) => all[k])
      .filter((c) => c && c.lastInstructional)
      .sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
    return cals[0] || null;
  };

  const getLatestCalendarEnd = async () => {
    const cal = await getLatestCalendar();
    return cal ? cal.lastInstructional : null; // "YYYY-MM-DD"
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

  /* ---- Google Calendar import ------------------------------------------ */

  const tt_sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const tt_status = (button, text, good) => {
    let note = button.nextElementSibling;
    if (!note || note.className !== "vrevamp-tt-note") {
      note = document.createElement("span");
      note.className = "vrevamp-tt-note";
      note.style.cssText = "margin-left:8px;font-size:12px;font-weight:normal;";
      button.insertAdjacentElement("afterend", note);
    }
    note.textContent = text;
    note.style.color = good ? "#1a7f37" : "#c00";
  };

  // "CSE1005 - Data Structures - Theory Only" -> { CSE1005: "Data Structures" }
  // (best-effort: the attendance snapshot only exists once the attendance
  // page has been opened; events fall back to the course code without it)
  const courseTitles = async () => {
    const r = await chrome.storage.local.get(["vrevamp_attendance_summary"]);
    const titles = {};
    (((r || {}).vrevamp_attendance_summary || {}).subjects || []).forEach((s) => {
      const parts = String(s.name || "").split(" - ");
      if (s.code && parts.length >= 2)
        titles[s.code] = parts.length >= 3 ? parts.slice(1, -1).join(" - ") : parts[1];
    });
    return titles;
  };

  const isoOf = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
  const hmsColon = (mins) =>
    `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(
      2,
      "0"
    )}:00`;

  // next occurrence of weekday wd on/after today — the imported series only
  // ever starts in the future
  const nextDate = (wd) => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    base.setDate(base.getDate() + ((wd - base.getDay() + 7) % 7));
    return base;
  };

  const buildGcalEvents = (timetable, cal, titles) => {
    const header = filterRepeated(timetable.header);
    const untilIso =
      cal && cal.lastInstructional
        ? cal.lastInstructional
        : isoOf(new Date(Date.now() + 17 * 7 * 24 * 3600 * 1000));
    const untilD = new Date(untilIso + "T00:00:00");
    untilD.setDate(untilD.getDate() + 1); // same buffer as the .ics
    const until = ymd(untilD) + "T180000Z";
    const instructional =
      cal && Array.isArray(cal.instructionalDays) && cal.instructionalDays.length
        ? new Set(cal.instructionalDays)
        : null;

    const events = [];
    timetable.data.forEach((row) => {
      const wd = dayToNum(row.day);
      if (wd === undefined) return;
      const first = nextDate(wd);
      if (isoOf(first) > untilIso) return; // this weekday is done for the sem
      classesForDay(header, row).forEach((c) => {
        // weekly occurrences the academic calendar doesn't list as
        // instructional (holidays, exam days) are excluded from the series
        const skips = [];
        if (instructional) {
          for (const d = new Date(first); isoOf(d) <= untilIso; d.setDate(d.getDate() + 7)) {
            if (!instructional.has(isoOf(d))) skips.push(ymd(d) + "T" + hms(c.start));
          }
        }
        const title = titles[c.course];
        const recurrence = [`RRULE:FREQ=WEEKLY;UNTIL=${until}`];
        if (skips.length)
          recurrence.push(`EXDATE;TZID=Asia/Kolkata:${skips.join(",")}`);
        events.push({
          summary:
            (title ? `${c.course} — ${title}` : c.course) +
            (c.slot ? ` (${c.slot})` : ""),
          location: c.venue || undefined,
          description: "vRevamp timetable import",
          start: { dateTime: `${isoOf(first)}T${hmsColon(c.start)}`, timeZone: "Asia/Kolkata" },
          end: { dateTime: `${isoOf(first)}T${hmsColon(c.end)}`, timeZone: "Asia/Kolkata" },
          recurrence,
          extendedProperties: { private: { vrevamp: "timetable" } },
        });
      });
    });
    return { events, untilIso };
  };

  // upcoming CAT/FAT exams from the schedule cached by the Exam Schedule
  // page — one single (non-recurring) event per exam, at the exam's own
  // window. Returns null when that page has never been opened.
  const examEvents = async () => {
    const r = await chrome.storage.local.get(["vrevamp_exam_schedule"]);
    const cache = (r || {}).vrevamp_exam_schedule;
    if (!cache || !Array.isArray(cache.exams)) return null;
    const today = isoOf(new Date());
    const hm = (t) => `${t.slice(0, 2)}:${t.slice(2)}:00`; // "1000" -> "10:00:00"
    return cache.exams
      .filter((e) => e && e.dateIso && e.dateIso >= today && e.start && e.end)
      .map((e) => ({
        summary: `${e.type} exam: ${e.code}${e.title ? ` — ${e.title}` : ""}`,
        location: e.venue || undefined,
        description: [
          e.slot ? `Slot: ${e.slot}` : "",
          e.session ? `Session: ${e.session}` : "",
          e.reporting ? `Reporting: ${e.reporting}` : "",
          e.seatLoc || e.seatNo ? `Seat: ${e.seatLoc || "-"} · No. ${e.seatNo || "-"}` : "",
          "vRevamp timetable import",
        ]
          .filter(Boolean)
          .join("\n"),
        start: { dateTime: `${e.dateIso}T${hm(e.start)}`, timeZone: "Asia/Kolkata" },
        end: { dateTime: `${e.dateIso}T${hm(e.end)}`, timeZone: "Asia/Kolkata" },
        extendedProperties: { private: { vrevamp: "timetable" } },
      }));
  };

  // a re-import replaces the previously imported series (found by our tag)
  // instead of stacking duplicates in the user's calendar
  const deleteOldImports = async (token) => {
    let removed = 0;
    try {
      const list = await fetch(
        `${GCAL_API}?privateExtendedProperty=${encodeURIComponent("vrevamp=timetable")}&maxResults=250`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!list.ok) return removed;
      const data = await list.json().catch(() => null);
      for (const item of (data && data.items) || []) {
        if (!item || !item.id) continue;
        const r = await fetch(`${GCAL_API}/${encodeURIComponent(item.id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok || r.status === 410) removed++;
        await tt_sleep(200);
      }
    } catch (error) {
      console.warn("vRevamp timetable import: cleanup", error);
    }
    return removed;
  };

  const onGcalClick = async (btn) => {
    try {
      const timetable = await getSavedTimetable();
      if (!timetable || !Array.isArray(timetable.data) || !timetable.data.length) {
        tt_status(btn, "no saved timetable yet — let the page finish loading, then retry", false);
        return;
      }
      const cal = await getLatestCalendar();
      const titles = await courseTitles();
      const { events, untilIso } = buildGcalEvents(timetable, cal, titles);
      const exams = await examEvents(); // null = Exam Schedule page never opened
      const all = events.concat(exams || []);
      if (!all.length) {
        tt_status(btn, "couldn't read any classes from the timetable", false);
        return;
      }
      let token = await window.vrGoogleToken({});
      // never consented yet — one interactive consent window, right now
      if (!token) token = await window.vrGoogleToken({ interactive: true });
      if (!token) {
        tt_status(btn, "sign in with Google — allow the consent window (or use the vRevamp popup once), then retry", false);
        return;
      }
      btn.disabled = true;
      tt_status(btn, "importing…", true);
      const removed = await deleteOldImports(token);
      let done = 0;
      let refreshed = false;
      for (let i = 0; i < all.length; i++) {
        const r = await fetch(GCAL_API, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(all[i]),
        });
        if (r.status === 401 && !refreshed) {
          // token died mid-flight — invalidate it, mint a fresh one, retry
          refreshed = true;
          token = await window.vrGoogleToken({ stale: token });
          if (token) {
            i--;
            continue;
          }
        }
        if (r.status === 401) {
          tt_status(btn, "Google session expired — sign in again from the vRevamp popup", false);
          btn.disabled = false;
          return;
        }
        if (r.ok) done++;
        tt_status(btn, `importing… ${done}/${all.length}`, true);
        await tt_sleep(300);
      }
      btn.disabled = false;
      tt_status(
        btn,
        done > 0
          ? `✓ ${done} event(s) in Google Calendar — ${events.length} weekly class(es)` +
              (exams === null
                ? " (open the Exam Schedule page once to include CAT/FAT exams)"
                : ` + ${exams.length} exam(s)`) +
              `, classes until ${untilIso}` +
              (removed ? `, replaced ${removed} old` : "")
          : "couldn't create the events — try again",
        done > 0
      );
    } catch (error) {
      console.warn("vRevamp timetable → Google Calendar:", error);
      tt_status(btn, "failed — refresh and try again", false);
      btn.disabled = false;
    }
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
    const gbtn = document.createElement("button");
    gbtn.id = GCAL_BTN_ID;
    gbtn.className = "btn btn-primary";
    gbtn.textContent = " 📅 import timetable to Google Calendar ";
    gbtn.style.cssText = "margin:8px;background:rgb(73,117,182);";
    gbtn.onclick = () => onGcalClick(gbtn);
    anchor.insertBefore(gbtn, btn.nextSibling);
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
