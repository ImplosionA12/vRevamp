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

// `root` is document on the page itself, and a DOMParser document when the
// venue watcher fetches the schedule in the background from some other VTOP
// page. Everything below it reads textContent and .cells, both of which work
// on a detached document with no layout.
const find_schedule_table = (root = document) => {
  for (const table of root.querySelectorAll("table")) {
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
    ics: vrIcs.calendar("-//VTOP Extension//iCal Generator//EN", blocks),
    events: blocks.length,
  };
};

/*
 * When Google mails the reminder, in minutes before the exam starts.
 *
 * TWO of them, matching the 🔔 button exactly. A single 24 h mail was the
 * original design and it is the wrong shape: a day out you note it and forget
 * it; two hours out is when you need the venue and the reporting time in front
 * of you. Reported 2026-08-16 — "i asked you to send it when 24 hours before
 * the exam and also 2 hours before".
 *
 * Google caps an event at 5 reminder overrides. Two emails plus one popup on
 * the near one leaves room and does not bury the student in popups.
 */
const EXAM_REMINDER_LEADS_MIN = [24 * 60, 2 * 60];

const exam_sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// vrGoogleToken / vrGoogleAuthHint / vrLocalReminders / vrGcalTemplateUrl all
// live in js/shared/google_auth.js, loaded before this file by the manifest.
// They used to be copy-pasted into this file, da_upload.js and timetable_ics.js
// alike, which meant every fix had to be made three times.

// "04-May-2026" -> "2026-05-04" (null when unparseable / no month match)
const exam_date_iso = (date_text) => {
  const d = (date_text || "").trim().split("-");
  if (d.length !== 3 || !EXAM_MONTHS[d[1]]) return null;
  return `${d[2]}-${EXAM_MONTHS[d[1]]}-${d[0].padStart(2, "0")}`;
};

// When this exam starts, in epoch ms (IST). NaN when the row has no published
// window, which every caller treats as "cannot reason about the timing".
const exam_start_ms = (exam) => {
  const iso = exam_date_iso(exam.date);
  const start = exam_time_to_24h((exam.time || "").split("-")[0] || "");
  if (!iso || !start) return NaN;
  return new Date(`${iso}T${start.slice(0, 2)}:${start.slice(2)}:00+05:30`).getTime();
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
          `📍 Venue: ${exam.venue || "not published yet"}   Seat: ${exam.seatLoc || "-"} · No. ${exam.seatNo || "-"}\n\n` +
          `VTOP Extension reminder — email ${EXAM_REMINDER_LEADS_MIN.map((m) => `${m / 60} h`).join(" and ")} before`,
        // Google's reminder email quotes the event's title and LOCATION, and
        // nothing else — so the venue has to live here, not only in the
        // description, or the 2 h mail arrives without the one fact it is for.
        // VTOP publishes venue/seat late (they read "-" until a few days out),
        // so re-run ✉️ closer to the exam to refresh them.
        location: exam.venue || "",
        // Tagged so a re-run can REPLACE this instead of adding a second copy —
        // the same mechanism js/timetable_ics.js uses. Without it every extra
        // click silently doubles the exam events, which is exactly what
        // happened to the timetable import (66 events in one week, 35 distinct,
        // most present three times). Re-running ✉️ is normal here: venue and
        // seat read "-" until VTOP publishes them a few days out.
        extendedProperties: { private: { vrevamp: "exam" } },
        start: { dateTime: `${iso}T${start.slice(0, 2)}:${start.slice(2)}:00+05:30` },
        end: { dateTime: `${iso}T${end.slice(0, 2)}:${end.slice(2)}:00+05:30` },
        reminders: {
          useDefault: false,
          overrides: [
            ...EXAM_REMINDER_LEADS_MIN.map((minutes) => ({ method: "email", minutes })),
            // one popup, on the near lead only — a popup a day early is noise
            { method: "popup", minutes: EXAM_REMINDER_LEADS_MIN[EXAM_REMINDER_LEADS_MIN.length - 1] },
          ],
        },
      }),
    }
  )
    .then((r) => ({ ok: r.status === 200, status: r.status }))
    .catch(() => ({ ok: false, status: 0 }));
};

const EXAM_GCAL_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

// Drop the events a previous ✉️ run created, so this run replaces them rather
// than doubling them. Only ever touches events carrying our own
// `vrevamp=exam` private property — an exam the student added by hand, or the
// timetable import's `vrevamp=timetable` events, are invisible to this query.
// Returns how many went, for the status line; failures are non-fatal because a
// failed cleanup must not stop the reminders from being created.
const exam_delete_old_reminders = async (token) => {
  let removed = 0;
  try {
    const list = await fetch(
      `${EXAM_GCAL_API}?privateExtendedProperty=${encodeURIComponent("vrevamp=exam")}&maxResults=250`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!list.ok) return removed;
    const data = await list.json().catch(() => null);
    for (const item of (data && data.items) || []) {
      if (!item || !item.id) continue;
      const r = await fetch(`${EXAM_GCAL_API}/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      // 410 = already gone, which is the outcome we wanted anyway
      if (r.ok || r.status === 410) removed++;
      await exam_sleep(200);
    }
  } catch (error) {
    console.warn("vRevamp exam schedule: cleanup", error);
  }
  return removed;
};

const exam_status = (button, text, good) => {
  let note = button.nextElementSibling;
  if (!note || note.className !== "vrevamp-exam-note") {
    note = document.createElement("span");
    note.className = "vrevamp-exam-note";
    note.style.cssText = "margin-left:6px;font-size:12px;font-weight:normal;";
    button.insertAdjacentElement("afterend", note);
  }
  note.textContent = text;
  // Bootstrap's own text colours, so the message reads as part of VTOP
  note.classList.toggle("text-success", !!good);
  note.classList.toggle("text-danger", !good);
  note.style.color = "";
};

// Our buttons are identified by the `data-vr-action` attribute and serviced by
// one delegated listener on `document` (js/shared/click.js). That pairing is
// the whole fix for "the button does nothing":
//
//   - the handler lives on `document`, which VTOP never replaces, so an
//     innerHTML round-trip cannot detach it;
//   - the identity is an attribute, which serialises through that same
//     round-trip — so a restored clone is already live, and the guard below
//     is right to skip it.
//
// The two earlier designs each got one half of this wrong. A `dataset` guard
// over an `onclick` handler was too durable: the flag came back on dead clones
// and blocked the re-injection that would have repaired them. Swapping in a JS
// property (`__vrevampExamBound`) fixed the detection but not the repair — it
// only re-ran on the `exam_schedule` webRequest message, which fires at
// onCompleted, i.e. *before* VTOP writes the response into the DOM, with no
// retry behind it. Neither survived contact with the real page.
const VR_ACTIONS = ["exam-ics", "exam-bell", "exam-mail", "exam-send", "exam-addr"];
const VR_BTN_SEL = VR_ACTIONS.map((a) => `[data-vr-action="${a}"]`).join(",");

// NOTE: an earlier version also set `position:relative;z-index:1100` to lift
// the buttons above VTOP's jQuery BlockUI overlay (z-index 1000, plus a
// `blockMsg` at 1011), one layer of which sits at opacity ~0.001 — invisible
// but still able to swallow a click. Reverted: it drew our buttons on top of
// VTOP's own open sidebar menu, and the evidence for it was a click that "did
// nothing" — a symptom now explained by the submit-button and clone bugs. If a
// real click is ever confirmed to be eaten by BlockUI, fix it with a value
// just above 1011, scoped to the moment an overlay is up.

// Everything a handler needs, re-derived from the live DOM at click time.
// Deliberately not a closure: a closure would capture the table that existed
// at injection, and after any VTOP re-render that node is detached — the
// handler would read a ghost and report "no upcoming exams" on a page full of
// them. The group is located by walking up from the button actually clicked.
// The group label ("FAT", "CAT1"), read WITHOUT our own injected buttons —
// they are appended into this very cell, so a plain innerText read on a group
// that already has them yields "FAT Download FAT to .ics Format 🔔 notify…".
// textContent, not innerText: this also runs on detached clones, where
// innerText has no layout to work from.
const vr_group_type = (head) => {
  const copy = head.cloneNode(true);
  copy.querySelectorAll(`${VR_BTN_SEL},.vrevamp-exam-note`).forEach((el) => el.remove());
  return copy.textContent.replace(/\s+/gu, " ").trim();
};

const vr_group_heads = (table) =>
  [...table.rows]
    .map((row) => row.children[0])
    .filter((head) => head && head.className === "panelHead-secondary");

// Per-GROUP, not per-table. A table-wide "any of our buttons present?" check
// wedges a partially injected page forever: one group with buttons vouched for
// every group without them, and the groups that were missed stayed bare.
const vr_all_groups_bound = (table) => {
  const heads = vr_group_heads(table);
  return heads.length > 0 && heads.every((head) => head.querySelector(VR_BTN_SEL));
};

const vr_exam_context = (button) => {
  const found = find_schedule_table();
  if (!found) return null;
  const cell = button.closest("td, th");
  const row = cell && cell.parentElement;
  // a nested qualifying table would otherwise let a parent claim its
  // children's rows (the trap grade_history_calc.js hit)
  if (!row || row.closest("table") !== found.table) return null;
  return {
    table: found.table,
    cols: found.cols,
    groupIndex: row.rowIndex,
    examType: button.dataset.vrExamType || "",
  };
};

// These buttons cannot be tested by automation: a synthesised click is
// dispatched in the page's main world and never reaches a handler registered
// from a content script's isolated world, so every button looks permanently
// dead to a script no matter what. Console output, however, DOES cross that
// boundary and can be read back. So the click path narrates itself: one line
// per stage, under a single greppable prefix, which turns "nothing happens"
// into an exact stage number without asking anyone to describe symptoms.
const vr_log = (...args) => {
  try {
    console.log("[vRevamp exam]", ...args);
  } catch {
    /* console gone — never let logging break the feature */
  }
};

// Upcoming exams of one group that have a published date AND time window.
const vr_upcoming_exams = (ctx) => {
  const now = new Date();
  const todayIso =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-` +
    String(now.getDate()).padStart(2, "0");
  return exam_rows_of_group(ctx.table, ctx.groupIndex, ctx.cols).filter((exam) => {
    const iso = exam_date_iso(exam.date);
    const times = exam.time.split("-");
    return (
      iso && iso >= todayIso &&
      exam_time_to_24h(times[0] || "") && exam_time_to_24h(times[1] || "")
    );
  });
};

/*
 * The click handlers, registered once for the life of the page. They are
 * top-level on purpose: registering per injected button is what made the
 * buttons fragile in the first place. Each one re-reads the table through
 * vr_exam_context(), so it works on the DOM that is on screen when the user
 * clicks — not the one that existed when the button was created.
 */
window.vrDelegate("exam-ics", (button) => {
  const ctx = vr_exam_context(button);
  if (!ctx) {
    exam_status(button, "couldn't read the schedule table — reload the page", false);
    return;
  }
  try {
    const exams = exam_rows_of_group(ctx.table, ctx.groupIndex, ctx.cols);
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
    a.setAttribute("download", `${semName} ${ctx.examType}.ics`);
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    exam_status(button, `✓ ${events} exam(s) exported`, true);
  } catch (error) {
    console.warn("vRevamp exam schedule:", error);
    exam_status(button, "export failed — refresh and try again", false);
  }
});

window.vrDelegate("exam-bell", async (bell) => {
  const ctx = vr_exam_context(bell);
  vr_log("bell clicked, group:", ctx ? ctx.examType : "(table not found)");
  if (!ctx) {
    exam_status(bell, "couldn't read the schedule table — reload the page", false);
    return;
  }
  try {
    const upcoming = vr_upcoming_exams(ctx);
    vr_log("upcoming exams in this group:", upcoming.length);
    if (upcoming.length === 0) {
      exam_status(bell, "no upcoming exams with a published time in this group", false);
      vr_log("status shown: no upcoming exams");
      return;
    }
    const reminders = [];
    upcoming.forEach((exam) => {
      const startMs = exam_start_ms(exam);
      const title = `${ctx.examType} exam: ${exam.code}${exam.title ? ` — ${exam.title}` : ""}`;
      const body =
        `${exam.date} · ${exam.time} (reporting ${exam.reporting || "-"})\n` +
        `Venue: ${exam.venue || "-"} · Seat: ${exam.seatLoc || "-"} No. ${exam.seatNo || "-"}`;
      reminders.push({ when: startMs - 24 * 3600 * 1000, title: `Tomorrow — ${title}`, body });
      reminders.push({ when: startMs - 2 * 3600 * 1000, title: `In 2 hours — ${title}`, body });
    });
    bell.disabled = true;
    const n = await window.vrLocalReminders(`exam:${ctx.examType}`, reminders);
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
    bell.disabled = false;
    exam_status(bell, "failed — refresh and try again", false);
  }
});

window.vrDelegate("exam-mail", async (mail) => {
  const ctx = vr_exam_context(mail);
  if (!ctx) {
    exam_status(mail, "couldn't read the schedule table — reload the page", false);
    return;
  }
  try {
    const upcoming = vr_upcoming_exams(ctx);
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
    // replace, never duplicate: clear anything a previous ✉️ run left behind
    // before writing this one
    exam_status(mail, "checking for a previous run…", true);
    const replaced = await exam_delete_old_reminders(token);
    let done = 0;
    let refreshed = false;
    for (let i = 0; i < upcoming.length; i++) {
      const r = await exam_email_reminder(upcoming[i], ctx.examType, token);
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
        ? `✓ ${done} exam(s) — Google will email you 24 h and 2 h before each one` +
          (replaced ? ` (replaced ${replaced} from an earlier run)` : "")
        : "couldn't create the reminders — try again",
      done > 0
    );
  } catch (error) {
    console.warn("vRevamp exam schedule:", error);
    mail.disabled = false;
    exam_status(mail, "failed — refresh and try again", false);
  }
});

// Escaping for the mail body below: the exam table is VTOP's HTML, and a
// course title with an ampersand in it would otherwise break the message.
const exam_html_escape = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// The whole upcoming list as one email. Deliberately a plain table with inline
// styles: Gmail strips <style> blocks, and this has to stay readable in the
// phone client the student will actually read it in.
const exam_mail_body = (exams, examType, semester, opts) => {
  const cell = (v, bold) =>
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;${
      bold ? "font-weight:600;" : ""
    }">${exam_html_escape(v || "-")}</td>`;
  const rows = exams
    .map(
      (e) =>
        "<tr>" +
        cell(e.date, true) +
        cell(e.time) +
        cell(`${e.code}${e.title ? ` — ${e.title}` : ""}`) +
        cell(e.venue) +
        cell(`${e.seatLoc || "-"} / ${e.seatNo || "-"}`) +
        cell(e.reporting) +
        "</tr>"
    )
    .join("");
  const head = ["Date", "Time", "Course", "Venue", "Seat loc / no.", "Report by"]
    .map(
      (h) =>
        `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #111;font-size:12px;text-transform:uppercase;letter-spacing:.04em;">${h}</th>`
    )
    .join("");
  const text = exams
    .map(
      (e) =>
        `${e.date}  ${e.time}  ${e.code}${e.title ? ` — ${e.title}` : ""}\n` +
        `    Venue ${e.venue || "-"} · Seat ${e.seatLoc || "-"} No. ${e.seatNo || "-"} · Report ${e.reporting || "-"}`
    )
    .join("\n");
  // `lead` marks an automatic send (the venue watcher). Same layout either way —
  // the format was asked for by name — with one line saying why it arrived, so
  // an unexpected mail is never a mystery.
  const lead = (opts && opts.lead) || "";
  return {
    subject: (opts && opts.subject) ||
      `${examType} exam schedule — ${exams.length} upcoming${semester ? ` (${semester})` : ""}`,
    text:
      `${examType} — ${exams.length} upcoming exam(s)\n` +
      (lead ? `${lead}\n` : "") +
      `\n${text}\n\nSent by VTOP Extension from your VTOP exam schedule.`,
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;">` +
      `<h2 style="margin:0 0 4px;font-size:18px;">${exam_html_escape(examType)} — ${exams.length} upcoming exam(s)</h2>` +
      (semester
        ? `<div style="color:#666;font-size:13px;margin-bottom:${lead ? "8" : "14"}px;">${exam_html_escape(semester)}</div>`
        : "") +
      (lead
        ? `<div style="margin:0 0 14px;padding:8px 12px;background:#eef6ff;border-left:3px solid #2a83f8;font-size:13px;">${exam_html_escape(lead)}</div>`
        : "") +
      `<table style="border-collapse:collapse;font-size:14px;">` +
      `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` +
      `<p style="color:#666;font-size:12px;margin-top:16px;">Sent by VTOP Extension from your VTOP exam schedule.</p>` +
      `</div>`,
  };
};

/*
 * The parsed schedule, cached under `vrevamp_exam_schedule`.
 *
 * Written from two places now — the page itself, and the background venue
 * check below, which holds a FRESHER copy of exactly this table than the page
 * cached last time. Everything that reads this key (the .ics export, the
 * timetable → Calendar import, the daily digest, and the semester the auto
 * picker matches on) therefore keeps up to date without the student opening
 * the exam schedule page.
 *
 * `semesterId` is new and is what makes the background check possible at all:
 * the cache used to record only the semester's NAME, and a name cannot be
 * POSTed back to VTOP.
 */
const exam_schedule_cache = (table, cols, semester, semesterId) => {
  try {
    const cached = [];
    for (let i = 0; i < table.rows.length; i++) {
      const head = table.rows[i].children[0];
      if (!head || head.className !== "panelHead-secondary") continue;
      const type = vr_group_type(head);
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
    if (!cached.length) return;
    const sem = document.querySelector("#semesterSubId");
    const onPage = sem && sem.selectedIndex >= 0 ? sem.options[sem.selectedIndex] : null;
    chrome.storage.local.set({
      vrevamp_exam_schedule: {
        fetchedAt: Date.now(),
        semester: semester || (onPage ? onPage.innerText.trim() : ""),
        semesterId: semesterId || (sem ? sem.value : "") || "",
        exams: cached,
      },
    });
  } catch (error) {
    console.warn("vRevamp exam schedule: cache", error);
  }
};

/*
 * ===================== the venue watcher =====================
 *
 * Asked for 2026-08-16: *"before the exam it should come with the venue
 * updated — when we open the vtop and if you find it updated then we should get
 * the mail with the venue, in the same format"*.
 *
 * VTOP publishes venue and seat LATE. Until a few days before the exam the
 * whole column reads `-`, so the first 📧 (and Google's own reminder mail) can
 * only ever say "not published yet". The moment they appear is the moment the
 * mail is actually worth having.
 *
 * There is no background fetch here, deliberately. Reading VTOP without the
 * student present means replaying its endpoints with a scraped `_csrf`, and
 * that is what has previously returned 404s and logged the user out. So the
 * check runs where the data legitimately arrives: every time the exam schedule
 * page renders. Open VTOP in the morning and the mail goes out then — which is
 * exactly the behaviour described.
 *
 * Two guarantees that keep this from being obnoxious:
 *
 *  1. **Opt-in.** It only ever runs after 📧 has been pressed once. Pressing it
 *     is the consent, both for mail and for Google.
 *  2. **Never interactive.** The send asks for a token with `interactive:false`,
 *     so a page load can never throw up a Google consent window. If the silent
 *     token has lapsed the send is skipped and retried on the next visit.
 *
 * State lives in `vrevamp_exam_mail_state`: `{ optIn, sent: { key: venue } }`.
 * Keying the record by the VENUE, not by a boolean, is what makes this fire on
 * a *change* — a venue corrected from CB-324 to CB-101 mails again, and an
 * unchanged one never does.
 */

const EXAM_MAIL_STATE_KEY = "vrevamp_exam_mail_state";

// "-", "", "--", whitespace — VTOP's several ways of writing "not yet"
const exam_venue_of = (exam) => {
  const v = String((exam && exam.venue) || "").trim();
  return /^-*$/.test(v) ? "" : v;
};

const exam_mail_key = (examType, exam) =>
  `${examType}|${exam.code}|${exam_date_iso(exam.date) || exam.date}`;

/*
 * How close an exam has to be before its venue is mailed on its own.
 *
 * VTOP publishes venues for a whole group in one batch, overnight — so the
 * normal case is "they all appear at once" and the right output is ONE mail
 * with the complete list. Firing on the first row to change would instead send
 * a trickle: one mail per subject if the student happens to open VTOP while the
 * batch is landing, or if one course lags behind the rest.
 *
 * So the watcher WAITS for every upcoming exam in the group to have a venue
 * before sending. The exception is the case where waiting is worse than a
 * partial list: an exam inside this window is close enough that a straggler
 * course must not be allowed to delay it — and a course whose venue never
 * appears at all (moved online, cancelled) would otherwise suppress the mail
 * forever.
 */
const EXAM_VENUE_URGENT_MS = 36 * 3600 * 1000;

const exam_mail_state = () =>
  new Promise((resolve) => {
    try {
      chrome.storage.local.get([EXAM_MAIL_STATE_KEY], (r) => {
        const s = (r && r[EXAM_MAIL_STATE_KEY]) || {};
        resolve({ optIn: !!s.optIn, sent: s.sent && typeof s.sent === "object" ? s.sent : {} });
      });
    } catch {
      resolve({ optIn: false, sent: {} });
    }
  });

// Remember what was mailed, so the watcher fires on changes only. Called both
// by the manual 📧 (which also flips optIn on) and by the watcher itself.
const exam_mail_remember = async (examType, exams, optIn) => {
  const state = await exam_mail_state();
  exams.forEach((e) => {
    state.sent[exam_mail_key(examType, e)] = exam_venue_of(e);
  });
  if (optIn) state.optIn = true;
  try {
    chrome.storage.local.set({ [EXAM_MAIL_STATE_KEY]: state });
  } catch {
    /* storage full or unavailable — the watcher simply repeats next visit */
  }
};

// sync() re-runs up to ten times per page load while it waits for VTOP to
// finish writing the table; without this the watcher would race itself and
// send the same mail several times over.
let exam_venue_watch_busy = false;

// `semesterName` is supplied by the background check, which has no picker on
// screen to read it off. `opts.holdsLock` says the caller already owns
// exam_venue_watch_busy — it does the fetch, and holding the flag across that
// fetch is what stops the page path and the background path from both
// deciding to send the same mail.
const exam_venue_watch = async (table, cols, semesterName, opts) => {
  const holdsLock = !!(opts && opts.holdsLock);
  if (!holdsLock && exam_venue_watch_busy) return null;
  const state = await exam_mail_state();
  if (!state.optIn) return null; // 📧 has never been pressed — stay silent

  if (!holdsLock) exam_venue_watch_busy = true;
  try {
    for (let i = 0; i < table.rows.length; i++) {
      const head = table.rows[i].children[0];
      if (!head || head.className !== "panelHead-secondary") continue;
      const examType = vr_group_type(head);
      const upcoming = vr_upcoming_exams({ table, cols, groupIndex: i, examType });
      // only exams whose venue is now published AND differs from what was
      // last mailed for them
      const fresh = upcoming.filter((e) => {
        const venue = exam_venue_of(e);
        return venue !== "" && state.sent[exam_mail_key(examType, e)] !== venue;
      });
      if (fresh.length === 0) continue;

      // Hold for the rest of the batch. VTOP publishes a whole group at once,
      // so the complete list is one mail — unless something is close enough
      // that waiting on a straggler would be the worse mistake.
      const stillPending = upcoming.filter((e) => exam_venue_of(e) === "");
      const now = Date.now();
      const urgent = fresh.filter((e) => {
        const ms = exam_start_ms(e);
        return !Number.isNaN(ms) && ms - now <= EXAM_VENUE_URGENT_MS;
      });
      if (stillPending.length > 0 && urgent.length === 0) {
        vr_log(
          `venue watcher: holding — ${fresh.length} published, ` +
            `${stillPending.length} still awaiting a venue, none urgent yet`
        );
        continue;
      }

      const sem = document.querySelector("#semesterSubId");
      const semester =
        semesterName ||
        (sem && sem.selectedIndex >= 0 ? sem.options[sem.selectedIndex].innerText.trim() : "");
      // The mail always carries the WHOLE upcoming group, not just the rows
      // that changed — the format the student asked for is the full list, and
      // a mail showing one exam out of six reads like something went wrong.
      const body = exam_mail_body(upcoming, examType, semester, {
        subject: `${examType} — venue published for ${fresh.length} exam(s)`,
        lead:
          `VTOP has published the venue${fresh.length > 1 ? "s" : ""} for ` +
          `${fresh.length} exam${fresh.length > 1 ? "s" : ""}. Sent automatically.` +
          (stillPending.length
            ? ` ${stillPending.length} still show no venue — you'll get another mail when they appear.`
            : ""),
      });
      // interactive:false — a page load must never open a consent window
      const r = await window.vrSendMail({ ...body, interactive: false });
      if (r && r.ok) {
        // record EVERY upcoming exam, pending ones included: they go in as ""
        // so that when a venue finally appears it reads as a change and fires
        await exam_mail_remember(examType, upcoming, false);
        vr_log(`venue watcher: mailed ${fresh.length} newly published exam(s) to ${r.to}`);
        return { sent: fresh.length, to: r.to, examType };
      }
      vr_log("venue watcher: send skipped —", (r && r.error) || "unknown");
      return null;
    }
  } catch (error) {
    console.warn("vRevamp exam schedule: venue watch", error);
  } finally {
    if (!holdsLock) exam_venue_watch_busy = false;
  }
  return null;
};

/*
 * ============ the venue watcher, without the exam schedule page ============
 *
 * Reported 2026-08-20: *"it waited until i open the exam schedule to mail me
 * when the venue got updated"*. Exactly what the note above describes as the
 * design — "the check runs where the data legitimately arrives" — and it is
 * one page too narrow. Venues are published overnight in a batch; a student
 * who opens VTOP for attendance and never touches Exam Schedule learns nothing
 * until the day they happen to look.
 *
 * So the check now runs from ANY VTOP page, by asking VTOP the one question
 * the Search button asks. What has NOT changed is the rule that mattered:
 * nothing is fetched without the student present and signed in. There is still
 * no alarm, no background session, no stored cookie — this is one POST on a
 * page the student opened themselves, on their own live session.
 *
 * Every guard the ROADMAP asks for is on it:
 *
 *  1. **It is their own request, not a guessed one.** The service worker
 *     records the real search POST (path and parameters) the first time it is
 *     made — by them or by auto_semester.js — exactly as it already learns the
 *     attendance-detail endpoint. Only if nothing has been recorded yet does
 *     this fall back to a named guess, and that guess is marked `probe` so a
 *     404 from it cannot trip the session breaker.
 *  2. **Through window.vrVtop.post**, so it inherits the circuit breaker, the
 *     single non-empty _csrf, and the "200 carrying a session-expired page"
 *     check. Three refusals and vRevamp stops talking to VTOP entirely.
 *  3. **Once every three hours at most**, and the clock is written BEFORE the
 *     request, so a failure costs one POST per window rather than one per page
 *     load. Compare the attendance refresh, which was declined as "a once-a-day
 *     replay is the same bet": that one had no student-initiated original to
 *     copy and no state that made it worth the risk. This one is a single read
 *     of a page they have already opened, gated on them having asked for the
 *     mail.
 *  4. **Nothing to ask about, nothing sent.** It needs an opt-in, a cached
 *     semester id, and at least one exam still ahead. Out of exam season this
 *     costs one storage read per page and never touches the network.
 *
 * It also refreshes `vrevamp_exam_schedule` from what it fetched, so the .ics
 * export, the Calendar import and the daily digest stop showing "-" for a
 * venue that VTOP published days ago.
 */
const EXAM_BG_CHECK_KEY = "vrevamp_exam_bg_check";
const EXAM_BG_MIN_GAP_MS = 3 * 3600 * 1000;
// only used when the worker has never recorded a real one — see (1)
const EXAM_BG_SEARCH_PATH = "examinations/doSearchExamScheduleForStudent";

let exam_bg_inflight = false;

const exam_bg_has_upcoming = (cache) => {
  const now = new Date();
  const todayIso =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-` +
    String(now.getDate()).padStart(2, "0");
  return ((cache && cache.exams) || []).some((e) => e.dateIso && e.dateIso >= todayIso);
};

const exam_venue_background_check = async () => {
  if (exam_bg_inflight) return null;
  // The exam schedule page is showing the table already: the sync path watches
  // it directly, and re-asking VTOP for what is on screen is pure waste.
  if (find_schedule_table()) return null;

  exam_bg_inflight = true;
  try {
    const state = await exam_mail_state();
    if (!state.optIn) return null; // 📧 has never been pressed — stay silent

    const store = await chrome.storage.local.get([
      "vrevamp_exam_schedule",
      "vrevamp_exam_search_request",
      EXAM_BG_CHECK_KEY,
    ]);
    const cache = store.vrevamp_exam_schedule;
    // no semester id means the exam page has not been opened since this
    // version shipped — the next visit records one, and this starts working
    if (!cache || !cache.semesterId) return null;
    if (!exam_bg_has_upcoming(cache)) return null; // exam season is over

    const last = (store[EXAM_BG_CHECK_KEY] || {}).at || 0;
    if (Date.now() - last < EXAM_BG_MIN_GAP_MS) return null;

    // Signed in, and the breaker has not already given up on this session.
    if (!window.vrVtop || window.vrVtop.tripped) return null;
    if (!window.vrVtop.csrf() || !window.vrVtop.authorizedID()) return null;

    // BEFORE the request, deliberately — see (3).
    await chrome.storage.local.set({ [EXAM_BG_CHECK_KEY]: { at: Date.now() } });

    // Held across the fetch, not just across the send: the page path must not
    // read the same "not mailed yet" state while this one is deciding to mail.
    exam_venue_watch_busy = true;

    const learned = store.vrevamp_exam_search_request;
    const html = await window.vrVtop.post(
      (learned && learned.path) || EXAM_BG_SEARCH_PATH,
      { ...((learned && learned.params) || {}), semesterSubId: cache.semesterId },
      { probe: !learned }
    );
    const found = find_schedule_table(window.vrVtop.parse(html));
    if (!found) {
      vr_log("venue watcher (background): the reply carried no schedule table");
      return null;
    }

    exam_schedule_cache(found.table, found.cols, cache.semester, cache.semesterId);
    const sent = await exam_venue_watch(found.table, found.cols, cache.semester, {
      holdsLock: true,
    });
    vr_log(
      sent
        ? `venue watcher (background): mailed ${sent.sent} exam(s) to ${sent.to}`
        : "venue watcher (background): checked, nothing new to mail"
    );
    return sent;
  } catch (error) {
    // A refusal here is already counted by vrVtop's breaker; this path stays
    // quiet either way, because it runs on pages that have nothing to do with
    // exams and must never put anything on screen.
    vr_log("venue watcher (background): skipped —", String((error && error.message) || error));
    return null;
  } finally {
    exam_venue_watch_busy = false;
    exam_bg_inflight = false;
  }
};

/*
 * 📧 — a real email, in the inbox, now.
 *
 * Distinct from ✉️ next to it, which schedules Calendar events that will mail
 * a reminder a day before each exam. Both are wanted: the reminder is for "do
 * not forget", this is for "I want the list on my phone". It goes through the
 * student's own Gmail (see sendMailAsUser in the worker) so it arrives from
 * their own address, and the status line names the address it went to —
 * students routinely have two Google accounts and guess wrong about which one
 * the extension used.
 */
/*
 * "where should vRevamp mail you?" — the whole cost of the mail feature when a
 * relay is configured. One text field, in place, instead of a Google consent
 * screen: it works for a student with no Google account, and it lets them
 * choose the inbox they actually read on their phone rather than whichever
 * account Chrome happens to be signed into.
 *
 * Rendered next to the 📧 button only when the worker answers `need_address`,
 * so nobody who has already answered ever sees it again.
 */
const exam_ask_address = (btn, onSaved) => {
  let box = btn.parentElement.querySelector(".vrevamp-exam-addr");
  if (box) {
    box.querySelector("input").focus();
    return;
  }
  box = document.createElement("span");
  box.className = "vrevamp-exam-addr";
  box.style.cssText =
    "margin-left:6px;font-size:12px;font-weight:normal;white-space:nowrap;" +
    "display:inline-flex;align-items:center;gap:4px;";

  const input = document.createElement("input");
  input.type = "email";
  input.placeholder = "you@example.com";
  input.setAttribute("aria-label", "Email address for VTOP Extension reminders");
  // VTOP's own form control, so it matches the portal's inputs
  input.className = "form-control form-control-sm";
  input.style.cssText = "width:220px;display:inline-block;";

  // type=button, like every other injected control: these sit inside VTOP's own
  // <form id="examSchedule"> and a default-type button submits it
  const save = window.vrButton("exam-addr", "Save", {});
  save.style.marginLeft = "0";

  const note = document.createElement("span");
  note.className = "text-danger";
  note.style.cssText = "margin-left:6px;";

  box.append(input, save, note);
  btn.insertAdjacentElement("afterend", box);
  input.focus();

  const submit = async () => {
    const r = await window.vrSetReminderEmail(input.value);
    if (!r || !r.ok) {
      note.textContent = (r && r.error) || "couldn't save that";
      return;
    }
    box.remove();
    onSaved(r.address);
  };
  save.__vrSubmit = submit;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault(); // Enter in a VTOP form submits it
      submit();
    }
  });
};

window.vrDelegate("exam-addr", (save) => {
  if (typeof save.__vrSubmit === "function") save.__vrSubmit();
});

window.vrDelegate("exam-send", async (btn) => {
  const ctx = vr_exam_context(btn);
  vr_log("send-mail clicked, group:", ctx ? ctx.examType : "(table not found)");
  if (!ctx) {
    exam_status(btn, "couldn't read the schedule table — reload the page", false);
    return;
  }
  try {
    const upcoming = vr_upcoming_exams(ctx);
    if (upcoming.length === 0) {
      exam_status(btn, "no upcoming exams with a published time in this group", false);
      return;
    }
    const sem = document.querySelector("#semesterSubId");
    const semester =
      sem && sem.selectedIndex >= 0 ? sem.options[sem.selectedIndex].innerText.trim() : "";
    const body = exam_mail_body(upcoming, ctx.examType, semester);
    const succeed = async (r) => {
      // pressing this IS the opt-in for the venue watcher, and it records the
      // venues as they stand now so the watcher fires only on a change
      await exam_mail_remember(ctx.examType, upcoming, true);
      const pending = upcoming.filter((e) => exam_venue_of(e) === "").length;
      exam_status(
        btn,
        `✓ emailed ${upcoming.length} exam(s) to ${r.to}` +
          (pending
            ? ` — ${pending} still have no venue; you'll be mailed again automatically once VTOP publishes it`
            : ""),
        true
      );
    };

    btn.disabled = true;
    exam_status(btn, `sending ${upcoming.length} exam(s)…`, true);
    const r = await window.vrSendMail(body);
    btn.disabled = false;
    if (r && r.ok) return succeed(r);

    // Relay mode with nobody to write to yet. Not a failure — ask, then send.
    // This is the ONLY thing the mail feature needs from the student when a
    // relay is configured: no Google account, no consent screen, one field.
    if (r && r.error === "need_address") {
      exam_status(btn, "where should VTOP Extension mail you?", true);
      exam_ask_address(btn, async (address) => {
        btn.disabled = true;
        exam_status(btn, `sending ${upcoming.length} exam(s)…`, true);
        const again = await window.vrSendMail({ ...body, to: address });
        btn.disabled = false;
        if (again && again.ok) return succeed(again);
        exam_status(btn, window.vrSendMailHint(again && again.error), false);
      });
      return;
    }
    exam_status(btn, window.vrSendMailHint(r && r.error), false);
  } catch (error) {
    console.warn("vRevamp exam schedule:", error);
    btn.disabled = false;
    exam_status(btn, "failed — refresh and try again", false);
  }
});

let exam_schedule_sync = () => {
  const found = find_schedule_table();
  if (!found) return;
  const { table, cols } = found;
  // re-fires on every SPA message and on every retry tick; skip only when
  // EVERY group already carries our buttons. Clones restored from a snapshot
  // count as present — with the handler on `document` they are fully live, so
  // there is nothing to strip and nothing to rebind.
  if (vr_all_groups_bound(table)) {
    vr_log("sync skipped — every group already has its buttons");
    return;
  }
  vr_log("sync running — injecting buttons for any group missing them");

  // cache the parsed schedule so the timetable → Google Calendar import can
  // add exam events without needing this page open at the time
  exam_schedule_cache(table, cols);

  // Has VTOP published a venue since the last mail? If so, mail it — same
  // format, sent automatically. No-op unless 📧 has been pressed once, and
  // never interactive, so this cannot surprise anyone with a consent window.
  exam_venue_watch(table, cols).then((r) => {
    if (!r) return;
    const anyButton = document.querySelector('[data-vr-action="exam-send"]');
    if (anyButton)
      exam_status(
        anyButton,
        `✓ venue published — ${r.sent} exam(s) emailed to ${r.to} just now`,
        true
      );
  });

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
    if (head.querySelector(VR_BTN_SEL)) continue; // this group already has them
    const exam_type = vr_group_type(head);
    head.appendChild(
      window.vrButton("exam-ics", `Download ${exam_type} (.ics)`, {
        vrExamType: exam_type,
      })
    );

    // 🔔 Chrome desktop notifications 1 day and 2 h before each upcoming
    // exam — pure chrome.alarms, works with zero Google sign-in
    const bell = window.vrButton("exam-bell", "Notify me before each exam", {
      vrExamType: exam_type,
    });
    bell.className = "btn btn-outline-primary btn-sm";
    bell.title =
      "Chrome notification 1 day and 2 h before each exam — no sign-in needed";
    head.appendChild(bell);

    // ✉️ one Google Calendar event per upcoming exam, with email reminders 24 h
    // AND 2 h before. Sent by Google's servers, so they arrive on a phone with
    // Chrome closed — and they come from Google Calendar, not from the student.
    const mail = window.vrButton("exam-mail", "Email me 24 h & 2 h before", {
      vrExamType: exam_type,
    });
    mail.className = "btn btn-outline-primary btn-sm";
    mail.title =
      "One Google Calendar event per exam; Google emails you 24 h and 2 h before each. " +
      "Sent by Google's servers, so it arrives even with Chrome closed. Needs one-time Google consent.";
    head.appendChild(mail);

    // 📧 the whole list, mailed now, from the student's own Gmail. The ✉️
    // above is "remind me later"; this is "put it in my inbox".
    const send = window.vrButton("exam-send", "Mail me the list now", {
      vrExamType: exam_type,
    });
    send.className = "btn btn-outline-primary btn-sm";
    send.title =
      "Sends the upcoming exams of this group to your own inbox straight away — needs one-time Google consent";
    head.appendChild(send);
    vr_log("buttons injected for group:", exam_type);
  }
};

/*
 * The message we run on comes from chrome.webRequest.onCompleted, which fires
 * when the RESPONSE ARRIVES — not when VTOP's jQuery success callback has
 * written it into the page. A single immediate sync therefore ran against the
 * previous DOM about as often as the new one: find_schedule_table() returned
 * null (or the old table, promptly replaced) and nothing ever tried again, so
 * the page settled with no buttons at all. Retry until every group has them.
 * Same shape as js/timetable_ics.js's addWithRetries, which needed it first.
 */
const exam_schedule_snapshot = () => {
  if (typeof saveExamSchedulePage !== "function") return;
  const section = document.querySelector("#main-section");
  if (!section) return;
  // Strip our buttons from what we cache: the offline viewer renders this HTML
  // with no content script behind it, so saved buttons could only ever be
  // decoration that does nothing when pressed.
  const copy = section.cloneNode(true);
  window.vrStripActions(copy);
  saveExamSchedulePage(copy.innerHTML);
};

const exam_schedule_sync_with_retries = () => {
  let attempts = 0;
  const tick = () => {
    attempts++;
    try {
      exam_schedule_sync();
      const found = find_schedule_table();
      const done = found && vr_all_groups_bound(found.table);
      if (done) exam_schedule_snapshot();
      if (done || attempts >= 10) return;
    } catch (error) {
      console.warn("vRevamp exam schedule:", error);
    }
    setTimeout(tick, 700);
  };
  tick();
};

chrome.runtime.onMessage.addListener((request) => {
  if (!request) return;

  if (request.message === "exam_schedule") {
    /*
     * Pick the semester and press Search, so the page opens showing the
     * schedule instead of an empty form (asked for 2026-08-19). The call that
     * does the work is the one auto_semester.js makes on "semester_page_open";
     * by the time THIS message arrives a semester has already been searched,
     * so this is a second chance and a no-op on a rendered page.
     */
    if (typeof window.vrAutoSemesterFor === "function")
      window.vrAutoSemesterFor("exam_schedule");
    exam_schedule_sync_with_retries();
    return;
  }

  // Any arrival on VTOP is a chance to notice a newly published venue, whether
  // or not the exam schedule page is the one being opened — see the background
  // check above. Cheap and rate-limited, so extra triggers cost nothing.
  if (
    request.message === "nav_bar_change" ||
    request.message === "vtop2_nav_bar" ||
    request.message === "view_attendance_page" ||
    // …but not when the page opening IS the exam schedule: auto_semester.js is
    // about to search it for real, and asking VTOP the same question twice
    // would also spend the three-hour budget on the one page that never
    // needed it
    (request.message === "semester_page_open" && request.page !== "exam_schedule")
  ) {
    exam_venue_background_check();
  }
});

/*
 * …and once per page, without waiting for a message at all. The messages above
 * cover the common arrivals, but they are routed off specific URLs and a
 * student who lands somewhere unrouted would still get nothing. This costs one
 * storage read on a page with no exams pending.
 */
setTimeout(exam_venue_background_check, 6000);
