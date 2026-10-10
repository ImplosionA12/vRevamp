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

  // vrGoogleToken / vrGoogleAuthHint / vrGcalTemplateUrl live in
  // js/shared/google_auth.js, loaded before this file by the manifest.

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
  // `grid` is { theory, lab }: the two time headers from headerOf(), already
  // collapsed on identical indices so grid.lab[i] describes the same column as
  // grid.theory[i].
  const classesForDay = (grid, row) => {
    const theory = Array.isArray(row.theory) ? row.theory : [];
    const lab = Array.isArray(row.lab) ? row.lab : [];
    const raw = [];
    for (let i = 1; i < grid.theory.length; i++) {
      const fromTheory = parseCell(theory[i]);
      const fromLab = fromTheory ? null : parseCell(lab[i]);
      const info = fromTheory || fromLab;
      if (!info) continue;
      // labs run on their own offset grid; borrowing the theory column's time
      // exported every lab event at the wrong hour
      const range = parseRange(
        fromLab ? grid.lab[i] || grid.theory[i] : grid.theory[i]
      );
      if (!range) continue;
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
    const pointer = await chrome.storage.local.get("vrevamp_latest_calendar");
    if (pointer.vrevamp_latest_calendar && pointer.vrevamp_latest_calendar.lastInstructional)
      return pointer.vrevamp_latest_calendar;
    // written by the attendance page; until it has run once, fall back to the scan
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

  // header is only guaranteed on timetables saved by the current build; an
  // older/partial blob without it must degrade into "no classes found"
  // rather than throwing out of an un-awaited click handler
  // Returns both grids, collapsed on the SAME kept indices so a lab cell can
  // be timed from the lab row rather than the theory row beside it.
  const headerOf = (timetable) => {
    const raw = Array.isArray(timetable.header) ? timetable.header : [];
    const rawLab = Array.isArray(timetable.headerLab) ? timetable.headerLab : [];
    const seen = new Set();
    const keep = [];
    raw.forEach((h, i) => {
      if (seen.has(h)) return;
      seen.add(h);
      keep.push(i);
    });
    return {
      theory: keep.map((i) => raw[i]),
      lab: keep.map((i) => rawLab[i]),
    };
  };

  const buildIcs = (timetable, untilIso, exams) => {
    const header = headerOf(timetable);
    const dtstamp = vrIcs.stamp();

    // recurrence end: lastInstructional + 1 day buffer, else ~17 weeks out
    const end = untilIso
      ? new Date(untilIso + "T00:00:00")
      : new Date(Date.now() + 17 * 7 * 24 * 3600 * 1000);
    end.setDate(end.getDate() + 1);
    const until = ymd(end) + "T180000Z";

    const blocks = [];
    timetable.data.forEach((row) => {
      const wd = dayToNum(row.day);
      if (wd === undefined) return;
      const date = ymd(anchorDate(wd));
      classesForDay(header, row).forEach((c) => {
        blocks.push([
          // weekday + slot + start time identify a weekly class; no export
          // counter, so re-exporting produces the same UIDs and a re-import
          // updates the series instead of duplicating it
          `UID:${vrIcs.uid("vrevamp-class", c.course, wd, c.slot, hms(c.start))}`,
          `DTSTAMP:${dtstamp}`,
          `DTSTART;TZID=Asia/Kolkata:${date}T${hms(c.start)}`,
          `DTEND;TZID=Asia/Kolkata:${date}T${hms(c.end)}`,
          `RRULE:FREQ=WEEKLY;UNTIL=${until}`,
          `SUMMARY:${vrIcs.esc(`${c.course}${c.slot ? ` (${c.slot})` : ""}`)}`,
          c.venue ? `LOCATION:${vrIcs.esc(c.venue)}` : "",
        ]);
      });
    });

    // single (non-recurring) events for cached upcoming exams, so the one
    // downloaded file carries classes AND exams — the same set the Google
    // Calendar import adds (examEvents / templateLinks)
    (exams || []).forEach((e) => {
      const day = e.dateIso.replace(/-/g, "");
      const detail = [
        e.slot ? `Slot: ${e.slot}` : "",
        e.reporting ? `Reporting: ${e.reporting}` : "",
        e.seatLoc || e.seatNo ? `Seat: ${e.seatLoc || "-"} No. ${e.seatNo || "-"}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      blocks.push([
        `UID:${vrIcs.uid("vrevamp-exam", e.type, e.code, day, e.start)}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;TZID=Asia/Kolkata:${day}T${e.start}00`,
        `DTEND;TZID=Asia/Kolkata:${day}T${e.end}00`,
        `SUMMARY:${vrIcs.esc(
          `${e.type} exam: ${e.code}${e.title ? ` — ${e.title}` : ""}`
        )}`,
        e.venue ? `LOCATION:${vrIcs.esc(e.venue)}` : "",
        detail ? `DESCRIPTION:${vrIcs.esc(detail)}` : "",
      ]);
    });

    if (blocks.length === 0) return null;
    return vrIcs.calendar("-//VTOP Extension//Timetable//EN", blocks);
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
    const header = headerOf(timetable);
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
          description: "VTOP Extension timetable import",
          start: { dateTime: `${isoOf(first)}T${hmsColon(c.start)}`, timeZone: "Asia/Kolkata" },
          end: { dateTime: `${isoOf(first)}T${hmsColon(c.end)}`, timeZone: "Asia/Kolkata" },
          recurrence,
          extendedProperties: { private: { vrevamp: "timetable" } },
        });
      });
    });
    return { events, untilIso };
  };

  // upcoming CAT/FAT exams (raw rows) from the schedule cached by the Exam
  // Schedule page. Returns null when that page has never been opened.
  const upcomingCachedExams = async () => {
    const r = await chrome.storage.local.get(["vrevamp_exam_schedule"]);
    const cache = (r || {}).vrevamp_exam_schedule;
    if (!cache || !Array.isArray(cache.exams)) return null;
    const today = isoOf(new Date());
    return cache.exams.filter(
      (e) => e && e.dateIso && e.dateIso >= today && e.start && e.end
    );
  };

  // the same exams as Google Calendar API bodies — one single
  // (non-recurring) event per exam, at the exam's own window
  const examEvents = async () => {
    const upcoming = await upcomingCachedExams();
    if (upcoming === null) return null;
    const hm = (t) => `${t.slice(0, 2)}:${t.slice(2)}:00`; // "1000" -> "10:00:00"
    return upcoming
      .map((e) => ({
        summary: `${e.type} exam: ${e.code}${e.title ? ` — ${e.title}` : ""}`,
        location: e.venue || undefined,
        description: [
          e.slot ? `Slot: ${e.slot}` : "",
          e.session ? `Session: ${e.session}` : "",
          e.reporting ? `Reporting: ${e.reporting}` : "",
          e.seatLoc || e.seatNo ? `Seat: ${e.seatLoc || "-"} · No. ${e.seatNo || "-"}` : "",
          "VTOP Extension timetable import",
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

  // sign-in failures the user can actually fix by retrying — everything else
  // (dead OAuth client, unknown errors) goes to the sign-in-free fallback
  const retryableAuthError = (e) =>
    /not signed in|did not approve|access|denied|closed|cancel/i.test(e || "");

  // Sign-in-free import. Used to download the .ics and open Google
  // Calendar's own Import page, but the 2026 Calendar revamp broke that
  // page outright — /r/settings (and /r/settings/import) never renders, it
  // just shows the week view "loading" forever (live 2026-07-18). So the
  // fallback is now a panel of one-tap render?action=TEMPLATE links — the
  // same no-OAuth mechanism as the exam/DA 📅 links, which the new UI still
  // honours (recurrence included via the recur= param): one link per weekly
  // class carrying its whole-semester RRULE, one per upcoming exam. Each
  // opens the user's calendar prefilled; they press Save, close the tab,
  // click the next one.
  const templateLinks = (timetable, cal, titles, rawExams) => {
    const header = headerOf(timetable);
    const untilIso =
      cal && cal.lastInstructional
        ? cal.lastInstructional
        : isoOf(new Date(Date.now() + 17 * 7 * 24 * 3600 * 1000));
    const untilD = new Date(untilIso + "T00:00:00");
    untilD.setDate(untilD.getDate() + 1); // same buffer as the .ics
    const until = ymd(untilD) + "T180000Z";

    const links = [];
    timetable.data.forEach((row) => {
      const wd = dayToNum(row.day);
      if (wd === undefined) return;
      const first = nextDate(wd);
      if (isoOf(first) > untilIso) return; // this weekday is done for the sem
      classesForDay(header, row).forEach((c) => {
        const title = titles[c.course];
        const day = ymd(first);
        links.push({
          label:
            `${String(row.day).trim().toUpperCase().slice(0, 3)} ` +
            `${hmsColon(c.start).slice(0, 5)} · ` +
            (title ? `${c.course} — ${title}` : c.course) +
            (c.slot ? ` (${c.slot})` : ""),
          url:
            "https://calendar.google.com/calendar/render?action=TEMPLATE" +
            `&text=${encodeURIComponent(
              (title ? `${c.course} — ${title}` : c.course) + (c.slot ? ` (${c.slot})` : "")
            )}` +
            `&dates=${day}T${hms(c.start)}/${day}T${hms(c.end)}` +
            "&ctz=Asia/Kolkata" +
            `&recur=${encodeURIComponent(`RRULE:FREQ=WEEKLY;UNTIL=${until}`)}` +
            `&details=${encodeURIComponent("VTOP Extension timetable import")}` +
            (c.venue ? `&location=${encodeURIComponent(c.venue)}` : ""),
        });
      });
    });

    (rawExams || []).forEach((e) => {
      const day = e.dateIso.replace(/-/g, "");
      const detail = [
        e.slot ? `Slot: ${e.slot}` : "",
        e.reporting ? `Reporting: ${e.reporting}` : "",
        e.seatLoc || e.seatNo ? `Seat: ${e.seatLoc || "-"} No. ${e.seatNo || "-"}` : "",
        "VTOP Extension timetable import",
      ]
        .filter(Boolean)
        .join("\n");
      links.push({
        label: `${e.dateIso} · ${e.type} exam: ${e.code}${e.title ? ` — ${e.title}` : ""}`,
        url:
          "https://calendar.google.com/calendar/render?action=TEMPLATE" +
          `&text=${encodeURIComponent(
            `${e.type} exam: ${e.code}${e.title ? ` — ${e.title}` : ""}`
          )}` +
          `&dates=${day}T${e.start}00/${day}T${e.end}00` +
          "&ctz=Asia/Kolkata" +
          `&details=${encodeURIComponent(detail)}` +
          (e.venue ? `&location=${encodeURIComponent(e.venue)}` : ""),
      });
    });
    return { links, untilIso };
  };

  const LINKS_ID = "vrevamp-tt-links";

  const showLinksPanel = (btn, links) => {
    const old = document.getElementById(LINKS_ID);
    if (old) old.remove();
    const panel = document.createElement("div");
    panel.id = LINKS_ID;
    panel.style.cssText =
      "margin:8px;padding:10px 12px;border:1px solid #c4cfdd;border-radius:8px;" +
      "background:#f6f8fb;font-size:13px;line-height:1.5;max-width:920px;color:#222;";
    // Queue them for the student instead of making them click 40 links: same
    // prefilled editors, one at a time, paced by their Save.
    const guided = window.vrButton(
      "tt-guided",
      ` ▶ open them one at a time (${links.length}) `,
      {}
    );
    guided.title =
      "Opens each class in a tab you can see. Press Save, and the next one opens. Close the tab to stop — clicking again carries on from there.";
    guided.style.marginLeft = "0";
    guided.style.marginBottom = "8px";
    panel.appendChild(guided);

    const head = document.createElement("div");
    head.style.cssText = "margin-bottom:8px;";
    head.textContent =
      "Or click each class once — Google Calendar opens with it prefilled " +
      "(weekly repeat for the whole semester included) — press Save there, " +
      "come back, click the next. Saved ones grey out.";
    panel.appendChild(head);
    links.forEach((l) => {
      const a = document.createElement("a");
      a.href = l.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "📅 " + l.label;
      a.style.cssText =
        "display:inline-block;margin:3px 6px 3px 0;padding:3px 10px;" +
        "border:1px solid #4975b6;border-radius:14px;background:#fff;" +
        "color:#204b86;text-decoration:none;";
      a.addEventListener("click", () => {
        a.style.opacity = "0.45";
        a.style.borderColor = "#999";
        if (!a.textContent.startsWith("✓")) a.textContent = "✓ " + a.textContent;
      });
      panel.appendChild(a);
    });
    // after the status note (btn's nextElementSibling) when it exists
    const after = btn.nextElementSibling && btn.nextElementSibling.className === "vrevamp-tt-note"
      ? btn.nextElementSibling
      : btn;
    after.insertAdjacentElement("afterend", panel);
  };

  // Fully automatic path: the worker opens each prefilled editor in a
  // background tab, presses Save there itself, closes it (message:
  // gcal_template_import) — one click imports the whole semester with no
  // sign-in. lastAutoProgress mirrors the worker's progress messages so a
  // dropped sendResponse (worker suspended mid-run) can't make a
  // successful import look like a failure.
  let lastAutoProgress = null;

  const autoImport = (urls) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ message: "gcal_template_import", urls }, (r) => {
          resolve(chrome.runtime.lastError || r === undefined ? null : r);
        });
      } catch {
        resolve(null);
      }
    });

  /*
   * Guided import — the student presses Save, we just queue the tabs.
   *
   * The automatic path opens a background tab per class and presses Save
   * itself. When that works it is the best experience there is; when it does
   * not, it is the worst, because each tab is also closed again before anyone
   * could have reached for Save by hand. This path inverts that: one FOREGROUND
   * tab at a time, and the next one does not open until this one is saved.
   */
  const guidedImport = (urls) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ message: "gcal_guided_import", urls }, (r) => {
          resolve(chrome.runtime.lastError || r === undefined ? null : r);
        });
      } catch {
        resolve(null);
      }
    });

  // Re-derived at click time rather than closed over: the handler below runs on
  // whatever button is on screen when it is clicked, which after a VTOP
  // re-render is not the element that existed when the panel was built.
  const collectTemplateLinks = async () => {
    const timetable = await getSavedTimetable();
    if (!timetable || !Array.isArray(timetable.data) || !timetable.data.length)
      return null;
    const cal = await getLatestCalendar();
    const titles = await courseTitles();
    const rawExams = (await upcomingCachedExams()) || [];
    return templateLinks(timetable, cal, titles, rawExams);
  };

  const onGuidedClick = async (gbtn) => {
    const found = await collectTemplateLinks();
    if (!found || !found.links.length) {
      tt_status(gbtn, "no classes to import — reload the timetable page and retry", false);
      return;
    }
    // same duplicate trap as the automatic route, and the same one-click-to-
    // confirm out of it (resuming a stopped run is exempt: dataset.vrDone > 0
    // means these are the events that have NOT been created yet)
    if (!Number(gbtn.dataset.vrDone || 0) && (await askBeforeDuplicating(gbtn, found.links.length)))
      return;
    // Resume where the last run stopped. Without this, a student who closes the
    // tab halfway and clicks again re-saves everything before the stopping
    // point — and Google Calendar has no opinion about duplicates.
    const from = Number(gbtn.dataset.vrDone || 0);
    const pending = found.links.slice(from);
    if (!pending.length) {
      tt_status(gbtn, `✓ all ${found.links.length} already done in this session`, true);
      return;
    }
    gbtn.disabled = true;
    tt_status(
      gbtn,
      `opening ${from + 1} of ${found.links.length} — press Save in the tab that opens, ` +
        "and the next one follows. Close the tab to stop.",
      true
    );
    const res = await guidedImport(pending.map((l) => l.url));
    gbtn.disabled = false;
    const saved = res && typeof res.saved === "number" ? res.saved : 0;
    const done = from + saved;
    gbtn.dataset.vrDone = String(done);
    if (saved > 0) await markImported(done);
    const stopped = res && res.stopped;
    tt_status(
      gbtn,
      done === 0
        ? `nothing saved${stopped ? ` (${stopped})` : ""} — use the one-tap links below instead`
        : `✓ ${done}/${found.links.length} saved` +
            (done < found.links.length
              ? stopped === "closed"
                ? " — stopped when you closed the tab. Click again to carry on from here."
                : ` — stopped (${stopped || "unknown"}). Click again to carry on from here.`
              : ""),
      done > 0
    );
  };

  /*
   * The TEMPLATE routes cannot clean up after themselves.
   *
   * The API import calls deleteOldImports() first, so re-running it REPLACES
   * the previous run. A TEMPLATE link cannot: it carries no extended property
   * to find the old events by, and without a token there is nothing to delete
   * them with. So every re-run silently adds a complete second copy of the
   * timetable, and Google Calendar has no opinion about that whatsoever.
   *
   * Verified on the real calendar 2026-08-09: 66 class events in one week, 35
   * distinct — most of them present exactly three times, from three runs. The
   * import had been working correctly the entire time; nothing warned that
   * running it again was destructive-by-addition.
   *
   * So: remember that a run happened, and make the second one deliberate. The
   * status line already said "re-running adds everything AGAIN" — but only
   * AFTER the run that had just added it.
   */
  const IMPORT_MARK = "vrevamp_tt_imported";

  const previousImport = async () => {
    try {
      const all = await chrome.storage.local.get([IMPORT_MARK]);
      return all[IMPORT_MARK] || null;
    } catch {
      return null;
    }
  };

  const markImported = async (count) => {
    try {
      await chrome.storage.local.set({
        [IMPORT_MARK]: { count, at: Date.now() },
      });
    } catch {
      /* storage gone — worst case we warn one time too few */
    }
  };

  // Second click within the same page view means "yes, I meant it".
  const confirmedRerun = (btn) => btn.dataset.vrConfirm === "1";

  const askBeforeDuplicating = async (btn, count) => {
    const prev = await previousImport();
    if (!prev || confirmedRerun(btn)) return false;
    const when = new Date(prev.at);
    const ago = Math.max(0, Math.round((Date.now() - prev.at) / 86400000));
    btn.dataset.vrConfirm = "1";
    tt_status(
      btn,
      `⚠ you already imported ${prev.count} event(s) on ${when.toLocaleDateString()}` +
        (ago === 0 ? " (today)" : ago === 1 ? " (yesterday)" : ` (${ago} days ago)`) +
        `. Importing again ADDS a second copy of all ${count} — Google will not merge them, ` +
        "and this route cannot delete the old ones (that needs Google sign-in). " +
        "Delete the old ones in Google Calendar first, or click again to add anyway.",
      false
    );
    return true;
  };

  const oneTapFallback = async (btn, timetable, cal, titles) => {
    const rawExams = (await upcomingCachedExams()) || [];
    const { links, untilIso } = templateLinks(timetable, cal, titles, rawExams);
    if (!links.length) return false;
    if (await askBeforeDuplicating(btn, links.length)) return true;
    btn.disabled = true;
    tt_status(
      btn,
      `sign-in isn't possible in this build — importing directly instead: 0/${links.length}…`,
      true
    );
    lastAutoProgress = null;
    const res = (await autoImport(links.map((l) => l.url))) || lastAutoProgress;
    btn.disabled = false;
    const saved = res && typeof res.saved === "number" ? res.saved : 0;
    if (saved > 0) {
      await markImported(saved);
      tt_status(
        btn,
        `✓ ${saved}/${links.length} event(s) saved to Google Calendar — ` +
          `${links.length - rawExams.length} weekly class(es)` +
          (rawExams.length ? ` + ${rawExams.length} exam(s)` : "") +
          `, classes until ${untilIso}` +
          (saved < links.length
            ? " — some didn't save; the one-tap links below cover everything, re-click any that are missing"
            : "") +
          ". (Re-running this import adds everything AGAIN — to redo it, first delete the old events in Google Calendar.)",
        true
      );
      if (saved < links.length) showLinksPanel(btn, links);
      return true;
    }
    // worker can't do it (old build, no permission, or the editor never
    // loaded — e.g. Chrome has no Google session): manual one-tap panel
    showLinksPanel(btn, links);
    tt_status(
      btn,
      `✓ sign-in isn't possible in this build (and Google's Import page is broken), ` +
        `so here are one-tap links instead: ${links.length - rawExams.length} weekly class(es)` +
        (rawExams.length ? ` + ${rawExams.length} exam(s)` : "") +
        `, classes until ${untilIso} — click each one below and press Save` +
        (res && res.lastError ? ` (auto-import failed: ${res.lastError})` : ""),
      true
    );
    return true;
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
        const err = window.vrGoogleAuthError || "";
        console.info(
          "VTOP Extension timetable import: Google sign-in failed:",
          err || "(no error reported)"
        );
        // sign-in is impossible in this build (the upstream OAuth client id
        // is dead — every user hits this) or failed for an unknown reason:
        // do the import the no-sign-in way instead of dead-ending
        if (!retryableAuthError(err) && (await oneTapFallback(btn, timetable, cal, titles)))
          return;
        tt_status(btn, window.vrGoogleAuthHint(), false);
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
          // a cached token from when the OAuth client was still alive can get
          // this far and then die un-refreshably — same fallback as above
          btn.disabled = false;
          if (
            !retryableAuthError(window.vrGoogleAuthError) &&
            (await oneTapFallback(btn, timetable, cal, titles))
          )
            return;
          tt_status(btn, "Google session expired — click again to re-consent", false);
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
      // a chrome://extensions reload orphans this script in already-open
      // tabs: the button stays visible but every chrome.* call throws —
      // only a page refresh reattaches the new build
      const orphaned = /context invalidated|Extension context/i.test(
        String((error && error.message) || error)
      );
      tt_status(
        btn,
        orphaned
          ? "VTOP Extension was updated under this page — refresh the page (F5), then click again"
          : "failed — refresh and try again",
        false
      );
      btn.disabled = false;
    }
  };

  const download = (ics) => {
    const a = document.createElement("a");
    a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
    a.download = "VTOP Extension timetable.ics";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const onClick = async (btn) => {
    try {
      const timetable = await getSavedTimetable();
      if (!timetable || !Array.isArray(timetable.data) || !timetable.data.length) {
        tt_status(
          btn,
          "no saved timetable yet — let the page finish loading, then retry",
          false
        );
        return;
      }
      // buildIcs took an `exams` argument that nothing ever passed, so the
      // downloaded file silently held classes only while the Google import
      // beside it included exams. Same cache, same filter as examEvents().
      const exams = (await upcomingCachedExams()) || [];
      const ics = buildIcs(timetable, await getLatestCalendarEnd(), exams);
      if (!ics) {
        tt_status(btn, "couldn't read any classes from the timetable", false);
        return;
      }
      download(ics);
      tt_status(
        btn,
        `✓ downloaded — weekly classes` +
          (exams.length ? ` + ${exams.length} upcoming exam(s)` : ""),
        true
      );
    } catch (error) {
      console.warn("vRevamp timetable .ics:", error);
      tt_status(btn, "export failed — refresh the page and try again", false);
    }
  };

  /*
   * Delegated, for the reasons in js/shared/click.js. This file used to hold
   * the exact inverse of exam_schedule.js's old bug: the retry loop below was
   * right, but the guard was `getElementById(BTN_ID)` — an id, which serialises
   * into innerHTML. So once VTOP re-rendered the timetable from cached markup,
   * a handler-less clone of the button satisfied the guard and permanently
   * blocked its own replacement: the button sat there looking normal and did
   * nothing until a full page reload. With the handler on `document` and the
   * identity in an attribute, that same clone is live and the id guard is
   * doing what it reads like it does — preventing duplicates.
   */
  window.vrDelegate("tt-ics", (btn) => onClick(btn));
  window.vrDelegate("tt-gcal", (btn) => onGcalClick(btn));
  window.vrDelegate("tt-guided", (btn) => onGuidedClick(btn));

  const addButton = () => {
    if (document.getElementById(BTN_ID)) return true;
    const loader = document.getElementById("loadMyFragment");
    const anchor = loader ? loader.parentElement : document.querySelector("#main-section");
    if (!anchor) return false;
    const btn = window.vrButton("tt-ics", " Export timetable to .ics ");
    btn.id = BTN_ID;
    btn.style.cssText = "margin:8px;background:rgb(73,117,182);";
    anchor.insertBefore(btn, anchor.firstChild);
    const gbtn = window.vrButton("tt-gcal", " 📅 import timetable to Google Calendar ");
    gbtn.id = GCAL_BTN_ID;
    gbtn.style.cssText = "margin:8px;background:rgb(73,117,182);";
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
    if (request.message === "gcal_template_progress") {
      lastAutoProgress = { saved: request.saved || 0 };
      // guided runs report against their own button — the student is watching
      // the tab, not the timetable, and the count is the only thing that tells
      // them the queue is still moving when they come back
      const b = request.guided
        ? document.querySelector('[data-vr-action="tt-guided"]')
        : document.getElementById(GCAL_BTN_ID);
      if (b)
        tt_status(
          b,
          request.guided
            ? `${request.saved} saved — opening ${Math.min(request.done + 1, request.total)} of ${request.total}…`
            : `importing… ${request.done}/${request.total} (${request.saved} saved)`,
          true
        );
    }
  });

  // NOTE: there used to be a window.postMessage("gcal_import") hook here so
  // automation could drive the import without a real click. It shipped, and
  // page-world code is not trusted: anything running on the VTOP page (VTOP
  // itself, an injected script, an XSS on the portal) could fire it and make
  // the worker open dozens of background tabs writing to the student's Google
  // Calendar, with no user gesture. Removed 2026-07-25. To drive this from a
  // test, call onGcalClick via chrome.scripting in the isolated world, or
  // dispatch the "timetable_view_page" message and click the real button.
})();
