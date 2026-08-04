// Exam schedule → .ics download, one button per exam-type group (FAT/CAT…).
// 2026 layout (verified live 2026-07-06): one .customTable; group rows carry
// class "panelHead-secondary"; a header row lists S.No / Course Code / Course
// Title / Course Type / Class ID / Slot / Exam Date / Exam Session /
// Reporting Time / Exam Time / Venue / Seat Location / Seat No. Columns are
// resolved from that header row — never by fixed index (the old parser read
// seat data at 12/13 and threw when the layout shifted).

const EXAM_MONTHS = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Sept: "09", Oct: "10", Nov: "11", Dec: "12",
};

// "02:30 PM" -> "14:30" (handles the 12 AM/PM edge cases)
const exam_time_to_24h = (time_text) => {
  const m = time_text.trim().match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const mer = m[3].toUpperCase();
  if (mer === "PM" && hour !== 12) hour += 12;
  if (mer === "AM" && hour === 12) hour = 0;
  return String(hour).padStart(2, "0") + m[2];
};

const exam_header_index = (row, re) =>
  [...row.cells].findIndex((c) => re.test(c.textContent));

const find_schedule_table = () => {
  for (const table of document.querySelectorAll("table")) {
    for (let i = 0; i < Math.min(table.rows.length, 4); i++) {
      const row = table.rows[i];
      if (
        /course\s*code/i.test(row.textContent) &&
        /exam\s*date/i.test(row.textContent)
      ) {
        return {
          table,
          cols: {
            code: exam_header_index(row, /course\s*code/i),
            title: exam_header_index(row, /course\s*title/i),
            slot: exam_header_index(row, /slot/i),
            date: exam_header_index(row, /exam\s*date/i),
            session: exam_header_index(row, /exam\s*session/i),
            reporting: exam_header_index(row, /reporting\s*time/i),
            time: exam_header_index(row, /exam\s*time/i),
            venue: exam_header_index(row, /venue/i),
            seatLoc: exam_header_index(row, /seat\s*location/i),
            seatNo: exam_header_index(row, /seat\s*no/i),
          },
        };
      }
    }
  }
  return null;
};

const exam_rows_of_group = (table, groupIndex, cols) => {
  const exams = [];
  for (let i = groupIndex + 1; i < table.rows.length; i++) {
    const row = table.rows[i];
    if (row.children[0] && row.children[0].className === "panelHead-secondary")
      break; // next exam-type group
    // read around vRevamp's own 📅 links — they live inside the date cell,
    // and their text must not pollute the parsed values
    const cell = (idx) => {
      if (idx < 0 || !row.cells[idx]) return "";
      if (!row.cells[idx].querySelector(".vrevamp-gcal-link"))
        return row.cells[idx].textContent.trim();
      const clone = row.cells[idx].cloneNode(true);
      clone.querySelectorAll(".vrevamp-gcal-link").forEach((n) => n.remove());
      return clone.textContent.trim();
    };
    const date = cell(cols.date);
    if (!/^\d{1,2}-[A-Za-z]{3,4}-\d{4}$/.test(date)) continue; // header/blank
    exams.push({
      code: cell(cols.code),
      title: cell(cols.title),
      slot: cell(cols.slot),
      date,
      session: cell(cols.session),
      reporting: cell(cols.reporting),
      time: cell(cols.time),
      venue: cell(cols.venue),
      seatLoc: cell(cols.seatLoc),
      seatNo: cell(cols.seatNo),
    });
  }
  return exams;
};

const build_exam_ics = (exams) => {
  const dtstamp = vrIcs.stamp();
  const blocks = [];
  for (const exam of exams) {
    const d = exam.date.split("-");
    const times = exam.time.split("-");
    const start = exam_time_to_24h(times[0] || "");
    const end = exam_time_to_24h(times[1] || "");
    if (!start || !end || !EXAM_MONTHS[d[1]]) continue; // no time published yet
    const day = `${d[2]}${EXAM_MONTHS[d[1]]}${d[0].padStart(2, "0")}`;
    blocks.push([
      // date + start + slot keep a course's THEORY and LAB exams apart: a UID
      // of just the course code made them the same event, and importing the
      // file silently dropped one of the two.
      `UID:${vrIcs.uid("vrevamp-exam", exam.code, day, start, exam.slot)}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;TZID=Asia/Kolkata:${day}T${start}00`,
      `DTEND;TZID=Asia/Kolkata:${day}T${end}00`,
      `SUMMARY:${vrIcs.esc(`${exam.code}: ${exam.title}`)}`,
      `DESCRIPTION:${vrIcs.esc(
        `Slot: ${exam.slot || "-"}\n` +
          `Session: ${exam.session || "-"}\n` +
          `Reporting: ${exam.reporting || "-"}\n` +
          `Seat: ${exam.seatLoc || "-"} No. ${exam.seatNo || "-"}`
      )}`,
      exam.venue ? `LOCATION:${vrIcs.esc(exam.venue)}` : "",
    ]);
  }
  return {
    ics: vrIcs.calendar("-//vRevamp//iCal Generator//EN", blocks),
    events: blocks.length,
  };
};

const EXAM_REMINDER_LEAD_MIN = 24 * 60; // email lands this long before the exam

const exam_sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fresh Google token via the worker at click time (chrome.identity refreshes
// silently once consent exists). The worker replies { token, error } — the
// error is kept so the buttons can say WHY no consent window appeared (most
// often: the Chrome profile itself has no Google account signed in).
// Shared with da_upload.js / timetable_ics.js, hence the window guard.
if (typeof window.vrGoogleToken !== "function") {
  window.vrGoogleAuthError = null;
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
          (resp) => {
            if (chrome.runtime.lastError || resp === undefined) return fallback();
            if (resp && typeof resp === "object") {
              window.vrGoogleAuthError = resp.error || null;
              return resolve(resp.token || null);
            }
            resolve(resp || null); // worker from before the update: bare token
          }
        );
      } catch {
        fallback();
      }
    });
  // the sign-in failure, phrased for the button status lines
  window.vrGoogleAuthHint = () => {
    const e = window.vrGoogleAuthError || "";
    if (/bad client id|invalid_client|deleted_client/i.test(e))
      return "Google sign-in can't work in this build (its OAuth client id is dead) — no sign-in needed though: use the 📅 one-tap links on the exam/DA pages, or the 📅 import button on the timetable page";
    if (/not signed in/i.test(e))
      return "Chrome has no Google account signed in (so no consent window can open) — sign in to Chrome itself, then retry";
    if (/did not approve|access|denied|closed|cancel/i.test(e))
      return "the Google consent window was closed — click again and allow access";
    return e
      ? `Google sign-in failed: ${e}`
      : "Google sign-in failed — allow the consent window, then retry";
  };
}

// Chrome-native reminders via the worker (chrome.alarms + notifications) —
// needs no Google account at all. Shared with da_upload.js (window guard).
if (typeof window.vrLocalReminders !== "function") {
  window.vrLocalReminders = (tag, reminders) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { message: "schedule_local_reminders", tag, reminders },
          (n) => {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(typeof n === "number" ? n : null);
          }
        );
      } catch {
        resolve(null);
      }
    });
}

// One-tap "add to Google Calendar": a calendar.google.com/render?action=
// TEMPLATE URL opens the user's own calendar with the event prefilled — the
// student just presses Save. No extension OAuth client and no consent flow,
// so it works for EVERY user with zero setup (the upstream OAuth client id
// baked into the manifest is dead — "bad client id", seen live 2026-07-16 —
// which killed the ✉️ Calendar-API path for everyone). `start`/`end` are
// compact local times (YYYYMMDDTHHMMSS), pinned to IST via ctz.
// Shared with da_upload.js, hence the window guard.
if (typeof window.vrGcalTemplateUrl !== "function") {
  window.vrGcalTemplateUrl = (ev) =>
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    `&text=${encodeURIComponent(ev.title)}` +
    `&dates=${ev.start}/${ev.end}` +
    "&ctz=Asia/Kolkata" +
    `&details=${encodeURIComponent(ev.details || "")}` +
    (ev.location ? `&location=${encodeURIComponent(ev.location)}` : "");
}

// "04-May-2026" -> "2026-05-04" (null when unparseable / no month match)
const exam_date_iso = (date_text) => {
  const d = (date_text || "").trim().split("-");
  if (d.length !== 3 || !EXAM_MONTHS[d[1]]) return null;
  return `${d[2]}-${EXAM_MONTHS[d[1]]}-${d[0].padStart(2, "0")}`;
};

// One calendar event per exam, at the exam's own start-end window, with an
// email (+popup) reminder — the same mechanism as the DA page's 🔔 button.
const exam_email_reminder = (exam, exam_type, token) => {
  const iso = exam_date_iso(exam.date);
  const times = exam.time.split("-");
  const start = exam_time_to_24h(times[0] || "");
  const end = exam_time_to_24h(times[1] || "");
  if (!iso || !start || !end) return Promise.resolve({ ok: false, status: 0 });
  return fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?alt=json",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: `${exam_type} exam: ${exam.code} — ${exam.title}`,
        description:
          `📚 ${exam.code} — ${exam.title}\n` +
          `🪑 Slot: ${exam.slot || "-"}   Session: ${exam.session || "-"}\n` +
          `⏰ Reporting time: ${exam.reporting || "-"} (exam ${exam.time})\n` +
          `📍 Venue: ${exam.venue || "-"}   Seat: ${exam.seatLoc || "-"} · No. ${exam.seatNo || "-"}\n\n` +
          `vRevamp reminder — email ${EXAM_REMINDER_LEAD_MIN / 60} h before`,
        location: exam.venue || "",
        start: { dateTime: `${iso}T${start.slice(0, 2)}:${start.slice(2)}:00+05:30` },
        end: { dateTime: `${iso}T${end.slice(0, 2)}:${end.slice(2)}:00+05:30` },
        reminders: {
          useDefault: false,
          overrides: [
            { method: "email", minutes: EXAM_REMINDER_LEAD_MIN },
            { method: "popup", minutes: EXAM_REMINDER_LEAD_MIN },
          ],
        },
      }),
    }
  )
    .then((r) => ({ ok: r.status === 200, status: r.status }))
    .catch(() => ({ ok: false, status: 0 }));
};

const exam_status = (button, text, good) => {
  let note = button.nextElementSibling;
  if (!note || note.className !== "vrevamp-exam-note") {
    note = document.createElement("span");
    note.className = "vrevamp-exam-note";
    note.style.cssText = "margin-left:8px;font-size:12px;font-weight:normal;";
    button.insertAdjacentElement("afterend", note);
  }
  note.textContent = text;
  note.style.color = good ? "#1a7f37" : "#c00";
};

let exam_schedule_sync = () => {
  const found = find_schedule_table();
  if (!found) return;
  const { table, cols } = found;
  if (table.dataset.vrevampIcs === "1") return; // message re-fires on the SPA
  table.dataset.vrevampIcs = "1";

  // cache the parsed schedule so the timetable → Google Calendar import can
  // add exam events without needing this page open at the time
  try {
    const cached = [];
    for (let i = 0; i < table.rows.length; i++) {
      const head = table.rows[i].children[0];
      if (!head || head.className !== "panelHead-secondary") continue;
      const type = head.innerText.trim();
      exam_rows_of_group(table, i, cols).forEach((exam) => {
        const times = exam.time.split("-");
        cached.push({
          type,
          code: exam.code,
          title: exam.title,
          slot: exam.slot,
          session: exam.session,
          reporting: exam.reporting,
          venue: exam.venue,
          seatLoc: exam.seatLoc,
          seatNo: exam.seatNo,
          dateIso: exam_date_iso(exam.date),
          start: exam_time_to_24h(times[0] || ""),
          end: exam_time_to_24h(times[1] || ""),
        });
      });
    }
    if (cached.length) {
      const sem = document.querySelector("#semesterSubId");
      chrome.storage.local.set({
        vrevamp_exam_schedule: {
          fetchedAt: Date.now(),
          semester: sem ? sem.options[sem.selectedIndex].innerText.trim() : "",
          exams: cached,
        },
      });
    }
  } catch (error) {
    console.warn("vRevamp exam schedule: cache", error);
  }

  // per-exam 📅 one-tap links (added before the group buttons below so the
  // group-head innerText is still just the exam type)
  try {
    const now = new Date();
    const todayIso =
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-` +
      String(now.getDate()).padStart(2, "0");
    let examType = "";
    for (const row of table.rows) {
      const head = row.children[0];
      if (head && head.className === "panelHead-secondary") {
        examType = head.innerText.trim();
        continue;
      }
      const cell = (idx) =>
        idx >= 0 && row.cells[idx] ? row.cells[idx].textContent.trim() : "";
      const iso = exam_date_iso(cell(cols.date));
      const times = cell(cols.time).split("-");
      const start = exam_time_to_24h(times[0] || "");
      const end = exam_time_to_24h(times[1] || "");
      if (!iso || !start || !end || iso < todayIso) continue; // past / no time
      const dateCell = row.cells[cols.date];
      if (!dateCell || dateCell.querySelector(".vrevamp-gcal-link")) continue;
      const day = iso.replace(/-/g, "");
      const link = document.createElement("a");
      link.className = "vrevamp-gcal-link";
      link.textContent = "📅 add";
      link.title =
        "one tap: opens Google Calendar with this exam prefilled — just press Save (no sign-in setup)";
      link.target = "_blank";
      link.rel = "noopener";
      link.style.cssText = "display:block;font-size:11px;white-space:nowrap;";
      link.href = window.vrGcalTemplateUrl({
        title: `${examType} exam: ${cell(cols.code)} — ${cell(cols.title)}`,
        start: `${day}T${start}00`,
        end: `${day}T${end}00`,
        details:
          `Slot: ${cell(cols.slot) || "-"}   Session: ${cell(cols.session) || "-"}\n` +
          `Reporting: ${cell(cols.reporting) || "-"}\n` +
          `Venue: ${cell(cols.venue) || "-"}   Seat: ${cell(cols.seatLoc) || "-"} · No. ${cell(cols.seatNo) || "-"}\n\n` +
          "Tip: add an Email notification to this event (or set one as your Google Calendar default) to get exam reminders mailed to you.",
        location: cell(cols.venue),
      });
      dateCell.appendChild(link);
    }
  } catch (error) {
    console.warn("vRevamp exam schedule: gcal links", error);
  }

  for (let i = 0; i < table.rows.length; i++) {
    const head = table.rows[i].children[0];
    if (!head || head.className !== "panelHead-secondary") continue;
    const exam_type = head.innerText.trim();
    const button = document.createElement("button");
    button.innerText = ` Download ${exam_type} to .ics Format `;
    button.className = "btn btn-primary";
    button.style.marginLeft = "1%";
    button.style.background = "rgb(73,117,182)";
    const groupIndex = i;
    button.onclick = () => {
      try {
        const exams = exam_rows_of_group(table, groupIndex, cols);
        const { ics, events } = build_exam_ics(exams);
        if (events === 0) {
          exam_status(button, "no exams with a published time in this group", false);
          return;
        }
        const a = document.createElement("a");
        a.setAttribute(
          "href",
          "data:text/calendar;charset=utf-8," + encodeURIComponent(ics)
        );
        const sem = document.querySelector("#semesterSubId");
        const semName = sem
          ? sem.options[sem.selectedIndex].innerText.trim()
          : "Semester";
        a.setAttribute("download", `${semName} ${exam_type}.ics`);
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        exam_status(button, `✓ ${events} exam(s) exported`, true);
      } catch (error) {
        console.warn("vRevamp exam schedule:", error);
        exam_status(button, "export failed — refresh and try again", false);
      }
    };
    head.appendChild(button);

    // upcoming exams of this group that have a published date + time window
    const upcoming_exams = () => {
      const now = new Date();
      const todayIso =
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-` +
        String(now.getDate()).padStart(2, "0");
      return exam_rows_of_group(table, groupIndex, cols).filter((exam) => {
        const iso = exam_date_iso(exam.date);
        const times = exam.time.split("-");
        return (
          iso && iso >= todayIso &&
          exam_time_to_24h(times[0] || "") && exam_time_to_24h(times[1] || "")
        );
      });
    };

    // 🔔 Chrome desktop notifications 1 day and 2 h before each upcoming
    // exam — pure chrome.alarms, works with zero Google sign-in
    const bell = document.createElement("button");
    bell.innerText = " 🔔 notify me before each exam ";
    bell.title =
      "Chrome notification 1 day and 2 h before each exam — no sign-in needed";
    bell.className = "btn btn-primary";
    bell.style.marginLeft = "1%";
    bell.style.background = "rgb(73,117,182)";
    bell.onclick = async () => {
      try {
        const upcoming = upcoming_exams();
        if (upcoming.length === 0) {
          exam_status(bell, "no upcoming exams with a published time in this group", false);
          return;
        }
        const reminders = [];
        upcoming.forEach((exam) => {
          const iso = exam_date_iso(exam.date);
          const start = exam_time_to_24h(exam.time.split("-")[0] || "");
          const startMs = new Date(
            `${iso}T${start.slice(0, 2)}:${start.slice(2)}:00+05:30`
          ).getTime();
          const title = `${exam_type} exam: ${exam.code}${exam.title ? ` — ${exam.title}` : ""}`;
          const body =
            `${exam.date} · ${exam.time} (reporting ${exam.reporting || "-"})\n` +
            `Venue: ${exam.venue || "-"} · Seat: ${exam.seatLoc || "-"} No. ${exam.seatNo || "-"}`;
          reminders.push({ when: startMs - 24 * 3600 * 1000, title: `Tomorrow — ${title}`, body });
          reminders.push({ when: startMs - 2 * 3600 * 1000, title: `In 2 hours — ${title}`, body });
        });
        bell.disabled = true;
        const n = await window.vrLocalReminders(`exam:${exam_type}`, reminders);
        bell.disabled = false;
        exam_status(
          bell,
          n === null
            ? "couldn't schedule — reload the extension (chrome://extensions) and retry"
            : n === 0
              ? "every exam here is under 2 h away — nothing left to schedule"
              : `✓ ${n} Chrome notification(s) scheduled (1 day & 2 h before each exam) — no sign-in needed`,
          n > 0
        );
      } catch (error) {
        console.warn("vRevamp exam schedule:", error);
        exam_status(bell, "failed — refresh and try again", false);
      }
    };
    head.appendChild(bell);

    // ✉️ optional: one Google Calendar event per upcoming exam with an email
    // (+popup) reminder 24 h before — this one does need Google consent
    const mail = document.createElement("button");
    mail.innerText = " ✉️ email me instead (Google) ";
    mail.title = "Google Calendar event per exam with an email 24 h before — needs one-time Google consent";
    mail.className = "btn btn-primary";
    mail.style.marginLeft = "1%";
    mail.style.background = "rgb(73,117,182)";
    mail.onclick = async () => {
      try {
        const upcoming = upcoming_exams();
        if (upcoming.length === 0) {
          exam_status(mail, "no upcoming exams with a published time in this group", false);
          return;
        }
        let token = await window.vrGoogleToken({});
        // never consented yet — one interactive consent window, right now
        if (!token) token = await window.vrGoogleToken({ interactive: true });
        if (!token) {
          exam_status(mail, window.vrGoogleAuthHint(), false);
          return;
        }
        mail.disabled = true;
        let done = 0;
        let refreshed = false;
        for (let i = 0; i < upcoming.length; i++) {
          const r = await exam_email_reminder(upcoming[i], exam_type, token);
          if (r.status === 401 && !refreshed) {
            // token died mid-flight — invalidate it, mint a fresh one, retry
            refreshed = true;
            token = await window.vrGoogleToken({ stale: token });
            if (token) {
              i--; // redo this exam with the fresh token
              continue;
            }
          }
          if (r.status === 401) {
            exam_status(mail, "Google session expired — click again to re-consent", false);
            mail.disabled = false;
            return;
          }
          if (r.ok) done++;
          await exam_sleep(400);
        }
        mail.disabled = false;
        exam_status(
          mail,
          done > 0
            ? `✓ ${done} reminder(s) set — email 24 h before each exam`
            : "couldn't create the reminders — try again",
          done > 0
        );
      } catch (error) {
        console.warn("vRevamp exam schedule:", error);
        exam_status(mail, "failed — refresh and try again", false);
      }
    };
    head.appendChild(mail);
  }
};

chrome.runtime.onMessage.addListener((request) => {
  if (request.message === "exam_schedule") {
    try {
      exam_schedule_sync();
      if (typeof saveExamSchedulePage === "function") {
        const section = document.querySelector("#main-section");
        if (section) saveExamSchedulePage(section.innerHTML);
      }
    } catch (error) {
      console.warn("vRevamp exam schedule:", error);
    }
  }
});
