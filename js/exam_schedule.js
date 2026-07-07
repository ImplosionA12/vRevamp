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
    const cell = (idx) =>
      idx >= 0 && row.cells[idx] ? row.cells[idx].textContent.trim() : "";
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
  const now = new Date();
  const stamp =
    `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(now.getUTCDate()).padStart(2, "0")}T` +
    `${String(now.getUTCHours()).padStart(2, "0")}` +
    `${String(now.getUTCMinutes()).padStart(2, "0")}` +
    `${String(now.getUTCSeconds()).padStart(2, "0")}`;
  let ics =
    "BEGIN:VCALENDAR\n" +
    "VERSION:2.0\n" +
    "PRODID:-//vRevamp//iCal Generator//EN\n" +
    "CALSCALE:GREGORIAN\n\n";
  let events = 0;
  for (const exam of exams) {
    const d = exam.date.split("-");
    const times = exam.time.split("-");
    const start = exam_time_to_24h(times[0] || "");
    const end = exam_time_to_24h(times[1] || "");
    if (!start || !end || !EXAM_MONTHS[d[1]]) continue; // no time published yet
    const day = `${d[2]}${EXAM_MONTHS[d[1]]}${d[0].padStart(2, "0")}`;
    ics +=
      "BEGIN:VEVENT\n" +
      `UID:${stamp}-${exam.code}@vitap.ac.in\n` +
      `DTSTAMP;TZID=Asia/Kolkata:${stamp}\n` +
      `DTSTART;TZID=Asia/Kolkata:${day}T${start}00\n` +
      `DTEND;TZID=Asia/Kolkata:${day}T${end}00\n` +
      `SUMMARY:${exam.code}:${exam.title}\n` +
      `DESCRIPTION:Slot : ${exam.slot || "-"}; Reporting : ${exam.reporting || "-"}; ` +
      `Seat Location : ${exam.seatLoc || "-"}; Seat Number : ${exam.seatNo || "-"}\n` +
      `LOCATION:${exam.venue}\n` +
      "END:VEVENT\n\n";
    events++;
  }
  return { ics: ics + "END:VCALENDAR", events };
};

const EXAM_REMINDER_LEAD_MIN = 24 * 60; // email lands this long before the exam

const exam_sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fresh Google token via the worker at click time (chrome.identity refreshes
// silently once consent exists — the token stored at popup-login expires in
// ~1 h). Falls back to the stored token where messaging isn't available.
// Shared with da_upload.js, hence the window guard.
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
          "data:text/plain;charset=utf-8," + encodeURIComponent(ics)
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

    // 🔔 one Google Calendar event per upcoming exam in this group, with an
    // email + popup reminder 24 h before (same sign-in as the DA reminders)
    const bell = document.createElement("button");
    bell.innerText = " 🔔 email me before each exam ";
    bell.className = "btn btn-primary";
    bell.style.marginLeft = "1%";
    bell.style.background = "rgb(73,117,182)";
    bell.onclick = async () => {
      try {
        const now = new Date();
        const todayIso =
          `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-` +
          String(now.getDate()).padStart(2, "0");
        const upcoming = exam_rows_of_group(table, groupIndex, cols).filter((exam) => {
          const iso = exam_date_iso(exam.date);
          const times = exam.time.split("-");
          return (
            iso && iso >= todayIso &&
            exam_time_to_24h(times[0] || "") && exam_time_to_24h(times[1] || "")
          );
        });
        if (upcoming.length === 0) {
          exam_status(bell, "no upcoming exams with a published time in this group", false);
          return;
        }
        let token = await window.vrGoogleToken({});
        // never consented yet — one interactive consent window, right now
        if (!token) token = await window.vrGoogleToken({ interactive: true });
        if (!token) {
          exam_status(bell, "sign in with Google — allow the consent window (or use the vRevamp popup once), then retry", false);
          return;
        }
        bell.disabled = true;
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
            exam_status(bell, "Google session expired — sign in again from the vRevamp popup", false);
            bell.disabled = false;
            return;
          }
          if (r.ok) done++;
          await exam_sleep(400);
        }
        bell.disabled = false;
        exam_status(
          bell,
          done > 0
            ? `✓ ${done} reminder(s) set — email 24 h before each exam`
            : "couldn't create the reminders — try again",
          done > 0
        );
      } catch (error) {
        console.warn("vRevamp exam schedule:", error);
        exam_status(bell, "failed — refresh and try again", false);
      }
    };
    head.appendChild(bell);
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
