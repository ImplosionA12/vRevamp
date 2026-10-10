const DA_MONTHS = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Sept: "09", Oct: "10", Nov: "11", Dec: "12",
};
const DA_REMINDER_LEAD_MIN = 24 * 60; // email lands this long before the due

// vrGoogleToken / vrGoogleAuthHint / vrLocalReminders / vrGcalTemplateUrl all
// live in js/shared/google_auth.js, loaded before this file by the manifest.

// One calendar event per assignment with an email (+popup) reminder — unlike
// calendar() below this needs no calendar-notification defaults to be set up.
function create_email_reminder(date_due, course_code, assign_title, course_title, token) {
  const m = date_due.trim().match(/^(\d{1,2})-([A-Za-z]{3,4})-(\d{4})$/);
  if (!m || !DA_MONTHS[m[2]]) return Promise.resolve({ ok: false, status: 0 });
  const iso = `${m[3]}-${DA_MONTHS[m[2]]}-${m[1].padStart(2, "0")}`;
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
        summary: `DA due: ${course_code} — ${assign_title}`,
        description: `${course_title} (VTOP Extension reminder, email ${DA_REMINDER_LEAD_MIN / 60} h before)`,
        start: { dateTime: `${iso}T20:00:00+05:30` },
        end: { dateTime: `${iso}T21:00:00+05:30` },
        reminders: {
          useDefault: false,
          overrides: [
            { method: "email", minutes: DA_REMINDER_LEAD_MIN },
            { method: "popup", minutes: DA_REMINDER_LEAD_MIN },
          ],
        },
      }),
    }
  )
    .then((r) => ({ ok: r.status === 200, status: r.status }))
    .catch(() => ({ ok: false, status: 0 }));
}

const da_header_index = (row, re) =>
  [...row.cells].findIndex((c) => re.test(c.textContent));

// detail fragment (processDigitalAssignment): course info table + the
/*
 * Is this assignment uploaded? Asked of the "Document Details" cell.
 *
 * ---------------------------------------------------------------------------
 * Reported 2026-08-22: "the due date and all of them look off the mark, and i
 * cant see remainders". Both symptoms, one cause, found by reading the real
 * table on the live page:
 *
 *   | # | Title        | Due         | Document Details      |
 *   |---|--------------|-------------|-----------------------|
 *   | 1 | Experiment-1 | 31-Jul-2026 | File Not Uploaded     |
 *   | 2 | Experiment-2 | 16-Aug-2026 | 16 Aug 2026 02:30 PM  |
 *   | 3 | Experiment-3 | 05-Sep-2026 | (blank)               |
 *   | 4 | Experiment-4 | 19-Sep-2026 | (blank)               |
 *   | 5 | Experiment-5 | 18-Oct-2026 | (blank)               |
 *   | 6 | Experiment-6 | 08-Nov-2026 | (blank)               |
 *
 * The old test was `!/file not uploaded/`. A BLANK cell does not match it, so
 * `!false` said uploaded — and rows 3 to 6, four assignments nobody has
 * uploaded, counted as done. The course row therefore reported "1 past due"
 * and nothing upcoming, which is why the dates on screen did not match the
 * ones in the page, and why no 🔔 ever appeared: every reminder control lives
 * behind `upcoming.length`, and upcoming was empty by construction.
 *
 * VTOP writes "File Not Uploaded" only once the upload window has opened. For
 * an assignment posted but not yet open it writes nothing at all — so absence
 * of evidence was being read as evidence of submission, on exactly the rows a
 * reminder is FOR.
 *
 * Inverted: a row counts as uploaded only on POSITIVE evidence — VTOP's own
 * upload timestamp, or a download link for the file it holds. Blank is not
 * uploaded. The failure mode now costs a reminder for something already done,
 * instead of silence about something still owed.
 */
const da_is_uploaded = (cell) => {
  if (!cell) return false;
  const text = (cell.textContent || "").replace(/\s+/g, " ").trim();
  if (/file\s*not\s*uploaded/i.test(text)) return false;
  if (!text) return false; // posted, not yet uploaded — the case that was lost
  // a file VTOP will hand back is proof it holds one
  if (cell.querySelector("a[href], a[onclick]")) return true;
  // "16 Aug 2026 02:30 PM" / "16-Aug-2026" — VTOP's record of the upload
  return (
    /\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}/.test(text) ||
    /\d{1,2}-[A-Za-z]{3,4}-\d{4}/.test(text)
  );
};

// assignment list (Title / Due Date / Document Details), found by header text
const parse_da_detail = (doc) => {
  const tables = [...doc.querySelectorAll("table")];
  let course_code = "", course_title = "";
  const info = tables.find(
    (t) => t.rows[0] && /course\s*code/i.test(t.rows[0].textContent)
  );
  if (info && info.rows[1]) {
    const ci = da_header_index(info.rows[0], /course\s*code/i);
    const ti = da_header_index(info.rows[0], /course\s*title/i);
    if (info.rows[1].cells[ci]) course_code = info.rows[1].cells[ci].textContent.trim();
    if (info.rows[1].cells[ti]) course_title = info.rows[1].cells[ti].textContent.trim();
  }
  const items = [];
  const list = tables.find(
    (t) => t.rows[0] && /due\s*date/i.test(t.rows[0].textContent)
  );
  if (list) {
    const iTitle = da_header_index(list.rows[0], /title/i);
    const iDue = da_header_index(list.rows[0], /due\s*date/i);
    const iDoc = da_header_index(list.rows[0], /document\s*details/i);
    for (const r of [...list.rows].slice(1)) {
      if (r.cells.length <= iDoc) continue; // the Upload/Edit sub-header row
      const due = r.cells[iDue] ? r.cells[iDue].textContent.trim() : "";
      if (!/^\d{1,2}-[A-Za-z]{3,4}-\d{4}$/.test(due)) continue;
      items.push({
        title: r.cells[iTitle] ? r.cells[iTitle].textContent.trim() : "",
        due,
        uploaded: da_is_uploaded(r.cells[iDoc]),
      });
    }
  }
  return { course_code, course_title, items };
};

/*
 * The mail body: a real table, grouped by subject.
 *
 * Asked for 2026-08-22 — "email looks the worst man, like cant u said as table
 * subejct wise". It was already a <table>, which is why the complaint looked
 * odd at first, but it had no borders, no header row and no grouping, so
 * twenty-one rows of "date · CODE — Assignment" read as an undifferentiated
 * list. Six of those rows were CSE3009 experiments all due 20-Oct, printed one
 * under another with the code repeated every time.
 *
 * Grouped, the same twenty-one rows become six short blocks a student can scan
 * by subject, and the repetition disappears into the group heading.
 *
 * All styling is INLINE and the layout is a table: Gmail strips <style> blocks
 * and ignores most modern CSS, so anything clever here would arrive as the
 * flat list it is meant to replace.
 */
const vr_da_group_key = (item, info) => {
  // the all-courses payload writes "SWE3004 — Experiment-3"; the per-course
  // one writes just "Experiment-3" and carries the code on the envelope
  const m = /^([A-Z]{2,4}\d{3,4}[A-Z]?)\s*[—-]\s*(.*)$/.exec(String(item.title || ""));
  return {
    code: m ? m[1] : info.code || "Course",
    title: m ? m[2] : String(item.title || ""),
    // the readable name ("Front End Design and Testing"), asked for 2026-08-22:
    // a code alone is not what a student calls the subject
    course: String(item.course || "").trim(),
  };
};

const vr_da_mail_body = (info) => {
  const dueMs = (d) => new Date(String(d).replace(/-/g, " ")).getTime();
  const today = new Date().setHours(0, 0, 0, 0);

  const groups = new Map();
  const courseNames = new Map();
  info.dues
    .slice()
    .sort((a, b) => dueMs(a.due) - dueMs(b.due))
    .forEach((item) => {
      const { code, title, course } = vr_da_group_key(item, info);
      if (!groups.has(code)) groups.set(code, []);
      if (course && !courseNames.has(code)) courseNames.set(code, course);
      groups.get(code).push({ ...item, title });
    });

  /*
   * Styled to match exam_mail_body() in js/exam_schedule.js, by request —
   * "make a proper tabble as we get exam scedule". Same wrapper, same h2, the
   * same uppercase thead over a 2px rule, the same 6px/10px cells on a 1px
   * rule.
   *
   * ONE table, not one per subject: the subject is a spanning row inside it,
   * so it reads as a single table that happens to be grouped rather than as
   * six little tables stacked up — which is what the previous attempt did, and
   * why it still did not look like the exam mail.
   */
  const esc = (v) =>
    String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  /*
   * A FULLY BORDERED grid, asked for twice: "make a proper tabble as we get
   * exam scedule", then "send it more in forms of tables okay? Like with
   * proper borders".
   *
   * Two earlier attempts missed it. The first was one table per subject; the
   * second was one table but with bottom rules only, which still reads as a
   * list with lines through it. Every cell carries a border here, the header
   * row is shaded, and the subject is a MERGED first column (rowspan) rather
   * than a spanning header row — so it is subject-wise and a real grid at the
   * same time.
   *
   * rowspan and inline styles, deliberately: Gmail strips <style> blocks and
   * ignores most modern CSS, but it has rendered bordered tables since it
   * existed. Nothing here needs a stylesheet to survive.
   */
  const B = "1px solid #b0b0b0";
  const td = (v, extra) =>
    `<td style="border:${B};padding:7px 10px;${extra || ""}">${v}</td>`;
  const head = ["Subject", "Due", "Left", "Assignment"]
    .map(
      (h) =>
        `<th style="border:${B};padding:8px 10px;background:#eef1f5;text-align:left;` +
        `font-size:12px;text-transform:uppercase;letter-spacing:.04em;">${h}</th>`
    )
    .join("");

  const body = [];
  for (const [code, items] of groups) {
    items.forEach((a2, i) => {
      const days = Math.ceil((dueMs(a2.due) - today) / 86400000);
      const late = days < 0;
      const subject =
        i === 0
          ? `<td rowspan="${items.length}" style="border:${B};padding:7px 10px;` +
            `background:#f7f9fb;font-weight:700;vertical-align:top;">` +
            `${esc(code)}` +
            (courseNames.get(code)
              ? `<div style="font-weight:400;font-size:12px;">${esc(
                  courseNames.get(code)
                )}</div>`
              : "") +
            "</td>"
          : "";
      body.push(
        "<tr>" +
          subject +
          td(esc(a2.due), "white-space:nowrap;font-weight:600;") +
          td(
            late
              ? `<span style="color:#c0392b;font-weight:700;">${-days} day(s) overdue</span>`
              : `${days} day(s)`,
            "white-space:nowrap;" + (late ? "background:#fdecea;" : "")
          ) +
          td(esc(a2.title)) +
          "</tr>"
      );
    });
  }

  // plain-text fallback, grouped the same way — a client showing this part
  // must not show the flat list this replaces
  const text = [];
  for (const [code, items] of groups) {
    text.push(code);
    items.forEach((a2) => text.push(`  ${a2.due}  ${a2.title}`));
    text.push("");
  }

  return {
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;">` +
      `<h2 style="margin:0 0 4px;font-size:18px;">Still to upload — ${info.dues.length} assignment(s)</h2>` +
      `<div style="color:#666;font-size:13px;margin-bottom:12px;">` +
      `Across ${groups.size} subject(s), soonest first within each.</div>` +
      `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;` +
      `border:${B};font-size:14px;">` +
      `<thead><tr>${head}</tr></thead><tbody>${body.join("")}</tbody></table>` +
      `<p style="color:#666;font-size:12px;margin-top:16px;">` +
      `Sent by VTOP Extension from your VTOP digital assignments page.</p></div>`,
    text: text.join("\n"),
  };
};

/*
 * The two 2026-layout due buttons, registered once for the life of the page
 * (js/shared/click.js). They are top-level and stateless on purpose: everything
 * they need arrives on the clicked button as a data-* attribute.
 *
 * These buttons sit in a cell of VTOP's OWN class table — a node VTOP rewrites
 * wholesale with `$(…).html(response)` on every navigation, and one we
 * snapshot and restore ourselves for the offline viewer. Both leave a
 * pixel-perfect clone of the button behind. A per-element handler does not
 * survive that (properties do not serialise) and neither does a closure over
 * `upcoming`/`meta`: the clone would either do nothing at all, or worse, report
 * on the course that happened to be there when it was built. A data attribute
 * survives precisely as long as the button it is written on, which is the only
 * lifetime that is ever correct here.
 */
const vr_da_payload = (button) => {
  try {
    const info = JSON.parse(button.dataset.vrDues || "null");
    return info && Array.isArray(info.dues) ? info : null;
  } catch {
    return null;
  }
};

// Two Chrome notifications per un-submitted due: the evening before (6 PM, i.e.
// the due day's 8 AM anchor less 14 h) and 8 AM on the day itself.
const vr_da_reminders = (info) => {
  const reminders = [];
  info.dues.forEach((a) => {
    const m = a.due.trim().match(/^(\d{1,2})-([A-Za-z]{3,4})-(\d{4})$/u);
    if (!m || !DA_MONTHS[m[2]]) return;
    const iso = `${m[3]}-${DA_MONTHS[m[2]]}-${m[1].padStart(2, "0")}`;
    const dueDay = new Date(`${iso}T08:00:00+05:30`).getTime();
    const title = `DA due: ${info.code} — ${a.title}`;
    const body = `${info.title}\nDue ${a.due} — not uploaded yet`;
    reminders.push({ when: dueDay - 14 * 3600 * 1000, title: `Tomorrow — ${title}`, body });
    reminders.push({ when: dueDay, title: `Today — ${title}`, body });
  });
  return reminders;
};

window.vrDelegate("da-bell", async (btn) => {
  const info = vr_da_payload(btn);
  if (!info) {
    btn.textContent = "couldn't read this row — refresh";
    return;
  }
  btn.disabled = true;
  const n = await window.vrLocalReminders(`da:${info.key}`, vr_da_reminders(info));
  btn.textContent =
    n === null ? "failed — retry" : n === 0 ? "already due" : `✓ ${n} reminder(s)`;
  btn.disabled = n > 0;
});

window.vrDelegate("da-mail", async (mailBtn) => {
  const info = vr_da_payload(mailBtn);
  if (!info) {
    mailBtn.textContent = "couldn't read this row — refresh";
    return;
  }
  // fresh token at click time — a stored one expires in ~1 h
  let token = await window.vrGoogleToken({});
  if (!token) token = await window.vrGoogleToken({ interactive: true });
  if (!token) {
    // never alert(): a modal dialog blocks the page's event loop, and this one
    // fires on a button the student may be clicking once per course
    mailBtn.textContent = "sign-in needed";
    mailBtn.title = window.vrGoogleAuthHint();
    return;
  }
  mailBtn.disabled = true;
  mailBtn.textContent = "…";
  let done = 0;
  let refreshed = false;
  for (let i = 0; i < info.dues.length; i++) {
    const a = info.dues[i];
    const r = await create_email_reminder(a.due, info.code, a.title, info.title, token);
    if (r.status === 401 && !refreshed) {
      // token died mid-flight — invalidate it, mint a fresh one, retry
      refreshed = true;
      token = await window.vrGoogleToken({ stale: token });
      if (token) {
        i--; // redo this assignment with the fresh token
        continue;
      }
    }
    if (r.status === 401) {
      mailBtn.textContent = "sign-in expired — click again";
      mailBtn.disabled = false;
      return;
    }
    if (r.ok) done++;
    await sleep(400);
  }
  mailBtn.textContent = done > 0 ? `✓ ${done} email(s)` : "failed — retry";
  mailBtn.disabled = done > 0;
});

// The list, in an inbox, now. Distinct from ✉ above: that schedules Calendar
// events which mail you later, this one is "just send me the list".
window.vrDelegate("da-mailnow", async (btn) => {
  const info = vr_da_payload(btn);
  if (!info) {
    btn.textContent = "couldn't read this row — refresh";
    return;
  }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "sending…";

  const mail = vr_da_mail_body(info);

  const result = await window.vrMailOrAsk(
    btn,
    {
      subject: `VTOP Extension — ${info.dues.length} assignment(s) still to upload`,
      html: mail.html,
      text: mail.text,
    },
    (text, ok) => {
      btn.textContent = ok ? text : `✗ ${text}`;
    }
  );

  btn.disabled = false;
  if (result.ok) {
    btn.textContent = `✓ sent to ${result.to}`;
    btn.disabled = true;
  } else if (btn.textContent === "sending…") {
    btn.textContent = label;
  }
});

// Turn the recurring digest on (or off) from the page it is about.
window.vrDelegate("da-digest", async (btn) => {
  btn.disabled = true;
  const on = btn.dataset.vrOn === "1";
  const reply = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ message: "set_daily_digest", enabled: !on }, (r) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(r);
      });
    } catch {
      resolve(null);
    }
  });
  btn.disabled = false;
  if (!reply || !reply.ok) {
    btn.textContent = "couldn't change that — retry";
    return;
  }
  btn.dataset.vrOn = reply.enabled ? "1" : "0";
  btn.textContent = reply.enabled
    ? "📬 daily digest is ON — click to stop"
    : "📬 mail me a daily digest";
  btn.title = reply.enabled
    ? `Sent every day around ${reply.hour}:00 to ${reply.to || "your reminder address"}`
    : "Once a day, VTOP Extension mails you what's still to upload and where your attendance stands";
});

// 2026 layout: class table is Sl.No / Class Nbr / Course Code / Course Title /
// Course Type / Faculty Name / Dashboard. Adds an "Upcoming Dues" column with
// the nearest un-submitted due date and a 🔔 button that creates calendar
// events (email reminder 24 h before) for every upcoming due of that course.
let da_page_2026 = async () => {
  const classTable = [...document.querySelectorAll("table")].find(
    (t) =>
      t.rows[0] &&
      /class\s*nbr/i.test(t.rows[0].textContent) &&
      /dashboard/i.test(t.rows[0].textContent)
  );
  if (!classTable || classTable.dataset.vrevampDues === "1") return;
  classTable.dataset.vrevampDues = "1";

  const iNbr = da_header_index(classTable.rows[0], /class\s*nbr/i);
  const th = document.createElement("td");
  th.textContent = "Upcoming Dues";
  th.style.width = "14%";
  classTable.rows[0].appendChild(th);

  /*
   * Every course's detail fragment, three at a time instead of one at a time.
   *
   * This loop used to be strictly serial and hand-rolled its own fetch: it
   * built the body by string concatenation with the FIRST `_csrf` on the page
   * (sometimes an empty placeholder), read the student id off the navbar with
   * no fallback, and caught every failure into a "--" cell. With eight courses
   * that is eight sequential round-trips before the column finishes, and when
   * the session is stale it is eight consecutive 404s fired at VTOP on every
   * single page view — the thing that damages the session in the first place.
   *
   * js/shared/vtop.js now owns the token, the id, the concurrency and the
   * circuit breaker; see the comment at the top of that file.
   */
  const rows = [...classTable.rows].slice(1).map((row) => {
    const cell = document.createElement("td");
    cell.textContent = "…";
    row.appendChild(cell);
    return { row, cell, classId: row.cells[iNbr] ? row.cells[iNbr].textContent.trim() : "" };
  });

  const fetched = await window.vrVtop.pool(rows, 3, async (entry) => {
    if (!/^\w+$/.test(entry.classId)) return null;
    const html = await window.vrVtop.post("examinations/processDigitalAssignment", {
      classId: entry.classId,
    });
    return parse_da_detail(window.vrVtop.parse(html));
  });

  const allDues = []; // snapshot for the daily digest — see service_worker

  for (let idx = 0; idx < rows.length; idx++) {
    const { cell, classId } = rows[idx];
    const meta = fetched[idx] && !fetched[idx].error ? fetched[idx] : null;
    if (!meta) {
      cell.textContent = window.vrVtop.tripped ? "session stale" : "--";
      continue;
    }
    const now = new Date().getTime();
    const dueMs = (d) => new Date(d.replace(/-/g, " ")).getTime();
    const upcoming = meta.items
      .filter((a) => !a.uploaded && dueMs(a.due) + 86399000 >= now)
      .sort((a, b) => dueMs(a.due) - dueMs(b.due));
    cell.textContent = "";
    cell.title = meta.items
      .map((a) => `${a.title}: ${a.due} ${a.uploaded ? "✓ submitted" : "✗ not uploaded"}`)
      .join("\n");

    // Recorded whether or not anything is upcoming, so the digest can also say
    // "3 past due, never uploaded" — the case a student most needs told.
    allDues.push({
      code: meta.course_code || classId,
      title: meta.course_title,
      upcoming: upcoming.map((a) => ({ due: a.due, title: a.title })),
      overdue: meta.items
        .filter((a) => !a.uploaded && dueMs(a.due) + 86399000 < now)
        .map((a) => ({ due: a.due, title: a.title })),
    });

    if (upcoming.length === 0) {
      const missed = meta.items.filter((a) => !a.uploaded).length;
      if (meta.items.length === 0) cell.textContent = "No DAs posted";
      else if (missed > 0) {
        cell.textContent = `⚠ ${missed} past due (not uploaded)`;
        cell.style.background = "rgb(238, 75, 43,0.35)";
      } else cell.textContent = "✅ No dues";
      continue;
    }
    const days = Math.ceil((dueMs(upcoming[0].due) - now) / 86400000);
    cell.style.background =
      days <= 3 ? "rgb(238, 75, 43,0.6)" : "rgb(170, 255, 0,0.6)";
    const span = document.createElement("span");
    // one line, not three: "05-Sep · 14d" instead of "05-Sep-2026 (14 day(s)
    // left)" wrapped across a 90px column
    span.style.cssText = "font-size:11px;white-space:nowrap;";
    span.textContent = `${upcoming[0].due} · ${days}d left`;
    span.title = `${upcoming[0].title} — due ${upcoming[0].due}`;
    cell.appendChild(span);
    // Everything both buttons need, written onto the buttons themselves. See
    // the handlers above for why this is an attribute and not a closure.
    const payload = JSON.stringify({
      key: meta.course_code || classId,
      code: meta.course_code,
      title: meta.course_title,
      dues: upcoming.map((a) => ({
        due: a.due,
        title: a.title,
        course: meta.course_title,
      })),
    });

    /*
     * ONE ROW OF ICONS, and the reason is measured rather than aesthetic.
     *
     * "those boxes look the ugliest dude dont enlarge them like that at all"
     * (2026-08-22). This column is about 90px wide. Labelled controls —
     * "🔔 remind me", "✉ email", "📅 gcal" — each wrapped onto two lines and
     * stacked, so a single course row grew to several hundred pixels and
     * pushed VTOP's own table off the screen. The words were never carrying
     * the meaning anyway: the title attribute says far more than three
     * squeezed words ever did, and it says it on hover where there is room.
     *
     * nowrap on the strip is the part that actually holds the height down —
     * without it the three icons still wrap one per line in a narrow column.
     */
    const strip = document.createElement("div");
    strip.className = "vrevamp-da-actions";
    strip.style.cssText =
      "margin-top:3px;white-space:nowrap;line-height:1;font-size:13px;";
    cell.appendChild(strip);

    // 🔔 Chrome notifications for every upcoming due of this course — 6 PM
    // the evening before and 8 AM on the due day. No Google sign-in.
    const btn = window.vrButton("da-bell", "🔔", { vrDues: payload });
    btn.className = "vrevamp-da-remind";
    btn.title =
      `Remind me — Chrome notification the evening before (6 PM) and the morning of (8 AM) for each of the ${upcoming.length} upcoming due(s). No sign-in needed.`;
    btn.style.cssText =
      "border:none;background:none;padding:0 3px;font-size:13px;cursor:pointer;line-height:1;";
    strip.appendChild(btn);

    // ✉ optional Google Calendar events with an email 24 h before each due
    const mailBtn = window.vrButton("da-mail", "✉", { vrDues: payload });
    mailBtn.className = "vrevamp-da-remind";
    mailBtn.title = `Email me — a Google Calendar event per upcoming due, mailed ${DA_REMINDER_LEAD_MIN / 60} h before. Needs one-time Google consent.`;
    mailBtn.style.cssText =
      "border:none;background:none;padding:0 3px;font-size:13px;cursor:pointer;line-height:1;";
    strip.appendChild(mailBtn);

    /*
     * 📅 one-tap: a prefilled Google Calendar event — opens in a new tab, the
     * student just presses Save. No sign-in setup at all.
     *
     * ONE link, for the soonest due. It used to render one per upcoming due,
     * and once the blank-cell fix (same day) started counting every posted
     * assignment, that became six dated links stacked in a ~90px column —
     * "right now it loooks horrible wha is that stretching", 2026-08-22. Each
     * link wrapped onto two lines and drove the row several hundred pixels
     * tall, which is a worse failure than a missing shortcut: it pushed the
     * actual table off the screen.
     *
     * Nothing is lost by showing one. 🔔 already schedules a notification for
     * every due, ✉ creates a calendar event for every due, and this is the
     * no-sign-in shortcut for the next one — which is the only one a student
     * is acting on today. The rest are named in the tooltip.
     */
    [upcoming[0]].forEach((a) => {
      const m = a.due.trim().match(/^(\d{1,2})-([A-Za-z]{3,4})-(\d{4})$/);
      if (!m || !DA_MONTHS[m[2]]) return;
      const day = `${m[3]}${DA_MONTHS[m[2]]}${m[1].padStart(2, "0")}`;
      const link = document.createElement("a");
      link.className = "vrevamp-da-gcal";
      link.textContent = "📅";
      link.title =
        `one tap: opens Google Calendar with ${a.title} (${a.due}) prefilled — ` +
        "just press Save (no sign-in setup)" +
        (upcoming.length > 1
          ? `. ${upcoming.length - 1} more upcoming: use 🔔 or ✉ to cover them all — ` +
            upcoming
              .slice(1)
              .map((x) => `${x.title} (${x.due})`)
              .join(", ")
          : "");
      link.target = "_blank";
      link.rel = "noopener";
      link.style.cssText =
        "display:inline-block;padding:0 3px;font-size:13px;text-decoration:none;line-height:1;";
      link.href = window.vrGcalTemplateUrl({
        title: `DA due: ${meta.course_code} — ${a.title}`,
        start: `${day}T200000`,
        end: `${day}T210000`,
        details:
          `${meta.course_title}\nDue ${a.due}\n\n` +
          "Tip: add an Email notification to this event (or set one as your Google Calendar default) to get it mailed to you.",
      });
      strip.appendChild(link);
    });
  }

  /*
   * Hand the whole picture to the worker.
   *
   * Until now a due date only ever existed inside this page: the student had
   * to open the DA page, read eight cells, and press 🔔 on each course to be
   * told about anything. Nobody does that, which is why "the assignments one
   * is bad" and "i need mail notifications" are the same complaint. Stored
   * here, the daily digest in service_worker/background.js can notify and mail
   * without the page ever being opened again.
   */
  try {
    await chrome.storage.local.set({
      vrevamp_da_dues: { fetchedAt: Date.now(), courses: allDues },
    });
  } catch {
    /* storage full or unavailable — the on-page column still works */
  }

  renderDaSummary(classTable, allDues);
};

/*
 * One control bar above the table, instead of only per-row buttons.
 *
 * The per-course 🔔 stays — it is the right thing when you care about one
 * subject — but "remind me about everything" is what is actually wanted, and
 * pressing it eight times was not a feature.
 */
const renderDaSummary = (classTable, courses) => {
  document.getElementById("vrevamp-da-summary")?.remove();

  /*
   * `title` on an assignment is the ASSIGNMENT's name ("Digital
   * Assessment-2"); `title` on a course is the course's ("Basic Law for
   * Engineers"). Spreading the assignment and then setting `title: c.title`
   * overwrote the first with the second — so this bar, and the list that gets
   * emailed by 📧, named the course once per assignment:
   *
   *   Past due: MGT1029 — Basic Law for Engineers (24-Jun-2026);
   *             MGT1029 — Basic Law for Engineers (24-Jun-2026);  …
   *
   * Three identical lines where three different assignments should be. The
   * course name is kept, under a name that does not collide.
   */
  const withCourse = (list, c) =>
    (list || []).map((a) => ({ ...a, code: c.code, course: c.title }));

  const upcoming = courses.flatMap((c) => withCourse(c.upcoming, c));
  /*
   * SEEN LIVE 2026-08-17 on this student's own page: nothing upcoming, and
   * ONE assignment past due and never uploaded. The bar named it and then
   * offered nothing — every control was inside `if (upcoming.length)`, so the
   * single state that most deserves attention was the one state with no
   * buttons at all. Overdue work is still work; it is chased, extended and
   * submitted late all the time.
   *
   * So overdue items are first-class here: listed by name, and carried in the
   * same payload the buttons read. `📬 daily digest` is lifted out of the
   * condition entirely — a student with nothing due today is exactly who
   * wants to be told when that changes.
   */
  const overdueItems = courses.flatMap((c) => withCourse(c.overdue, c));
  const overdue = overdueItems.length;

  const bar = document.createElement("div");
  bar.id = "vrevamp-da-summary";
  bar.style.cssText =
    "margin:10px 0;padding:8px 12px;border-radius:4px;font-size:13px;" +
    "background:#eef4fb;border:1px solid #c9dcf0;";

  const line = document.createElement("span");
  line.textContent = upcoming.length
    ? `${upcoming.length} assignment(s) still to upload` +
      (overdue ? `, and ${overdue} already past due` : "")
    : overdue
      ? `Nothing upcoming — but ${overdue} assignment(s) are past due and never uploaded`
      : "Nothing due — everything is uploaded.";
  line.style.fontWeight = "bold";
  bar.appendChild(line);

  if (upcoming.length) {
    const soonest = upcoming
      .slice()
      .sort((a, b) => new Date(a.due.replace(/-/g, " ")) - new Date(b.due.replace(/-/g, " ")))[0];
    const next = document.createElement("div");
    next.textContent = `Next: ${soonest.code} — ${soonest.title} on ${soonest.due}`;
    next.style.cssText = "margin-top:2px;color:#33506e;";
    bar.appendChild(next);
  }

  if (overdue) {
    const late = document.createElement("div");
    late.textContent =
      "Past due: " +
      overdueItems.map((a) => `${a.code} — ${a.title} (${a.due})`).join("; ");
    late.style.cssText = "margin-top:2px;color:#8a1c12;";
    bar.appendChild(late);
  }

  {
    const listed = upcoming.length ? upcoming : overdueItems;
    const payload = JSON.stringify({
      key: "all",
      code: "all courses",
      title: upcoming.length ? "All upcoming assignments" : "Assignments past due",
      dues: listed.map((a) => ({
        due: a.due,
        title: `${a.code} — ${a.title}`,
        course: a.course,
      })),
    });

    const controls = document.createElement("div");
    controls.style.cssText = "margin-top:6px;";

    // 🔔 only makes sense for a date still ahead — a notification for a due
    // that has already passed can never fire, and offering it would be a
    // button that silently does nothing.
    if (upcoming.length) {
      const bell = window.vrButton("da-bell", "🔔 remind me about all of them", {
        vrDues: payload,
      });
      bell.title =
        "Chrome notification the evening before and the morning of every due — no Google sign-in";
      bell.style.cssText = "font-size:12px;cursor:pointer;margin-right:6px;";
      controls.appendChild(bell);
    }

    if (listed.length) {
      const mail = window.vrButton(
        "da-mailnow",
        upcoming.length ? "📧 email me this list" : "📧 email me what I still owe",
        { vrDues: payload }
      );
      mail.title = "Sends the whole list to your reminder address right now";
      mail.style.cssText = "font-size:12px;cursor:pointer;margin-right:6px;";
      controls.appendChild(mail);
    }

    const daily = window.vrButton("da-digest", "📬 mail me a daily digest", {});
    daily.title =
      "Once a day, VTOP Extension mails you what's still to upload and where your attendance stands";
    daily.style.cssText = "font-size:12px;cursor:pointer;";
    controls.appendChild(daily);
    // reflect the setting rather than always offering to switch it on — a
    // toggle that lies about its own state is worse than no toggle
    try {
      chrome.runtime.sendMessage({ message: "google_status" }, (status) => {
        if (chrome.runtime.lastError || !status || !status.digest) return;
        daily.dataset.vrOn = "1";
        daily.textContent = "📬 daily digest is ON — click to stop";
        daily.title = `Sent every day around ${status.digestHour}:00`;
      });
    } catch {
      /* worker asleep — the button still works, it just starts at "off" */
    }

    bar.appendChild(controls);
  }

  classTable.insertAdjacentElement("beforebegin", bar);
};

// REMOVED 2026-08-16 with the legacy sync button above: calendar() posted DA
// events with the chrome.storage.sync token that button supplied. Nothing
// writes that key any more. The live equivalents are create_email_reminder()
// (Calendar API, real token) and the 📅 TEMPLATE links (no sign-in at all).

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let da_page = async () => {
  let due_sync = [];
  try {
    let reg_no, csrf;
    if (document.getElementsByClassName("navbar-text text-light small fw-bold")[0] != undefined) {
      reg_no = document.getElementsByClassName("navbar-text text-light small fw-bold")[0].innerText.replace("(STUDENT)", "").trim();
    }
    else {
      reg_no = document.getElementsByClassName("VTopHeaderStyle")[0].innerText.replace("(STUDENT)", "").trim();
    }
    let table = document.getElementsByClassName("customTable")[0].children[0];
    let date = new Date().getTime();
    try { csrf = document.getElementsByName("_csrf")[3].defaultValue; } catch { }

    //Head Edit
    let table_head = document.getElementsByClassName("tableHeader");
    let edited_head = table_head[0].innerHTML.split("\n");
    edited_head.splice(5, 0, '<td style="width: 12%;">Upcoming Dues</td>');
    table_head[0].innerHTML = edited_head.join("");

    //body edit
    let rows = document.querySelectorAll(".tableContent");
    rows.forEach((row) => {
      let edited_row = row.innerHTML.split("\n");
      edited_row.splice(6, 0, '<td style="width: 12%;"></td>');
      row.innerHTML = edited_row.join("");
    });

    for (let i = 1; i < table.children.length; i++) {
      var classid = table.children[i].children[1].innerHTML;
      if (table.children[i].children[3].children.length != 1) {
        await fetch(
          `${window.location.origin}/vtop/examinations/processDigitalAssignment`,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
            },
            body: `authorizedID=${reg_no}&x=${new Date().toGMTString()}&classId=${classid}&_csrf=${csrf}`,
          }
        )
          .then((res) => res.text())
          .then(async (data) => {
            var parser = new DOMParser();
            var doc = parser.parseFromString(data, "text/html");
            var table_inner = doc.getElementsByClassName("fixedContent tableContent");
            let course_code = doc.getElementsByClassName("fixedContent tableContent")[0].children[1].innerText;
            let course_title = doc.getElementsByClassName("fixedContent tableContent")[0].children[2].innerText;
            //   console.log(table_inner);
            var due_date = await new Promise((resolve) => {
              let due_dates = [];
              table_inner = Array.from(table_inner);
              table_inner.forEach((row) => {
                let date = row.childNodes[9].childNodes[1];
                let is_uploaded = true;
                try {
                  is_uploaded = row.children[6].children[0].innerHTML === "";
                } catch { }
                try {
                  if (date.style.color == "green" && is_uploaded) {
                    try {
                      let download_link = row.childNodes[11].childNodes;
                      due_dates.push({
                        date_due: date.innerHTML,
                        download_link: download_link.length > 0 ? download_link[0] : document.createElement("div"),
                        course_code: course_code,
                        course_title: course_title,
                      });
                    } catch { }
                  }
                } catch { }
              });
              if (due_dates.length > 0) {
                due_dates.sort((a, b) => {
                  return new Date(a.date_due) - new Date(b.date_due);
                });
                // console.log(due_dates);
                resolve(due_dates[0]);
              }
              else {
                resolve({
                  date_due: "Nothing Left.",
                  download_link: document.createElement("div"),
                  course_code: course_code,
                  course_title: course_title,
                });
              }
              due_sync.push(due_dates);
            }).then(
              (data) => data
            );

            var due = new Date(due_date.date_due.replace(/-/g, " ")).getTime();
            var color = (due - date) / (3600 * 24 * 1000) <= 3 ? "rgb(238, 75, 43,0.6)" : "rgb(170, 255, 0,0.6)";
            let days_left = Math.ceil((due - date) / (3600 * 24 * 1000));
            table.children[i].children[4].style.background = color;
            if (!isNaN(days_left)) {
              table.children[i].children[4].innerHTML += `<span>${due_date.date_due}<br>(${days_left} days left)</span>`;
            } else {
              table.children[i].children[4].innerHTML += `<span>${due_date.date_due}</span>`;
            }
            table.children[i].children[4].children[0].appendChild(due_date.download_link);
          })
          .catch((err) => console.log(err));
      }
    }
    // console.log(due_sync);
    sort();

    let sort_text_div = document.createElement("div");
    let sort_text = document.createElement("p");
    sort_text.style.color = "red";
    sort_text.innerHTML = "*Click on the Header (Sl. No,Course code..) of the table to sort";
    sort_text_div.appendChild(sort_text);
    document.getElementsByClassName("customTable")[0].insertAdjacentElement("beforebegin", sort_text_div);

    // REMOVED 2026-08-16: the legacy "Sync assignments with Google Calendar"
    // button and its companion red "Sign in with Google in extension" line.
    // Both read a token from chrome.storage.sync that was only ever written by
    // a popup sign-in button deleted long ago, against upstream's dead OAuth
    // client — so the button could never appear and the instruction pointed at
    // a control that does not exist. The live paths are the per-assignment 📅
    // one-tap links and the 🔔 / ✉ buttons above.

  }
  catch (err) {
    // console.log(err);
  }
};

let sort_table = (n) => {
  let table = document.getElementsByTagName("tbody")[0];
  let i, x, y, count = 0;
  let switching = true;
  let direction = "ascending";

  while (switching) {
    switching = false;
    var rows = table.rows;

    //Loop to go through all rows
    for (i = 1; i < (rows.length - 1); i++) {
      var Switch = false;

      // Fetch 2 elements that need to be compared
      x = rows[i].getElementsByTagName("TD")[n];
      y = rows[i + 1].getElementsByTagName("TD")[n];
      let x_due, y_due;
      if (n == 4) {
        x_due = parseInt(x.children[0].innerHTML.split("(")[1]);
        y_due = parseInt(y.children[0].innerHTML.split("(")[1]);
        if (isNaN(x_due)) {
          x_due = -1;
        }
        if (isNaN(y_due)) {
          y_due = -1;
        }
      }
      // Check the direction of order
      if (direction == "ascending") {
        // Check if 2 rows need to be switched
        if (x.innerHTML.toLowerCase() > y.innerHTML.toLowerCase() && [1, 2, 3, 5, 6].includes(n)) {
          // If yes, mark Switch as needed and break loop
          Switch = true;
          break;
        }
        else if (n == 0 && parseInt(x.innerHTML.toLowerCase()) > parseInt(y.innerHTML.toLowerCase())) {
          // If yes, mark Switch as needed and break loop
          Switch = true;
          break;
        }
        else if (n == 4 && x_due > y_due) {
          // If yes, mark Switch as needed and break loop
          Switch = true;
          break;
        }
      }
      else if (direction == "descending") {
        // Check direction
        if (x.innerHTML.toLowerCase() < y.innerHTML.toLowerCase() && [1, 2, 3, 5, 6].includes(n)) {
          // If yes, mark Switch as needed and break loop
          Switch = true;
          break;
        }
        else if (n == 0 && parseInt(x.innerHTML.toLowerCase()) < parseInt(y.innerHTML.toLowerCase())) {
          // If yes, mark Switch as needed and break loop
          Switch = true;
          break;
        }
        else if (n == 4 && x_due < y_due) {
          // If yes, mark Switch as needed and break loop
          Switch = true;
          break;
        }
      }
    }
    if (Switch) {
      // Function to switch rows and mark switch as completed
      rows[i].parentNode.insertBefore(rows[i + 1], rows[i]);
      switching = true;

      // Increase count for each switch
      count++;
    } else {
      // Run while loop again for descending order
      if (count == 0 && direction == "ascending") {
        direction = "descending";
        switching = true;
      }
    }
  }

};

let sort = () => {
  let head_change = Array.from(document.getElementsByClassName("tableHeader")[0].children);
  for (let i = 0; i < head_change.length - 1; i++) {
    head_change[i].addEventListener("click", () => { sort_table(i); });
  }
};

chrome.runtime.onMessage.addListener((request) => {
  if (request.message === "da_upload") {
    try {
      // Second chance only. The call that answers the picker is the one
      // auto_semester.js makes on "semester_page_open" — this message arrives
      // for the DATA load, i.e. after a semester has been chosen, so on an
      // answered page it is a no-op. See js/marks_page.js for the same shape.
      if (typeof window.vrAutoSemesterFor === "function")
        window.vrAutoSemesterFor("da_upload");
      const is2026 = [...document.querySelectorAll("table")].some(
        (t) =>
          t.rows[0] &&
          /class\s*nbr/i.test(t.rows[0].textContent) &&
          /dashboard/i.test(t.rows[0].textContent)
      );
      if (is2026) da_page_2026();
      else da_page();
    } catch (error) {
      // console.log(error);
    }
  }
});