let error_code = 0;

const DA_MONTHS = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Sept: "09", Oct: "10", Nov: "11", Dec: "12",
};
const DA_REMINDER_LEAD_MIN = 24 * 60; // email lands this long before the due

// Fresh Google token via the worker at click time (chrome.identity refreshes
// silently once consent exists). The worker replies { token, error } — the
// error is kept so the buttons can say WHY no consent window appeared (most
// often: the Chrome profile itself has no Google account signed in).
// Shared with exam_schedule.js / timetable_ics.js, hence the window guard.
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
    // a Cloud Console checkbox, not anything the student can click past
    if (/invalid_scope|accessNotConfigured|not enabled|has not been used/i.test(e))
      return "Google refused the scope — in Cloud Console enable the Google Calendar API and add calendar.events under Data Access, then retry";
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
// needs no Google account at all. Shared with exam_schedule.js (window guard).
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

// One-tap "add to Google Calendar" template URL — see exam_schedule.js for
// the rationale (no OAuth client / consent needed, works for every user).
// Shared with exam_schedule.js, hence the window guard.
if (typeof window.vrGcalTemplateUrl !== "function") {
  window.vrGcalTemplateUrl = (ev) =>
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    `&text=${encodeURIComponent(ev.title)}` +
    `&dates=${ev.start}/${ev.end}` +
    "&ctz=Asia/Kolkata" +
    `&details=${encodeURIComponent(ev.details || "")}` +
    (ev.location ? `&location=${encodeURIComponent(ev.location)}` : "");
}

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
        description: `${course_title} (vRevamp reminder, email ${DA_REMINDER_LEAD_MIN / 60} h before)`,
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
        uploaded: r.cells[iDoc]
          ? !/file\s*not\s*uploaded/i.test(r.cells[iDoc].textContent)
          : true,
      });
    }
  }
  return { course_code, course_title, items };
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

  const csrfEl = document.querySelector("input[name=_csrf]");
  const csrf = csrfEl ? csrfEl.value : "";
  const regEl =
    document.querySelector(".navbar-text.text-light.small.fw-bold") ||
    document.getElementsByClassName("VTopHeaderStyle")[0];
  const reg = regEl ? regEl.innerText.replace("(STUDENT)", "").trim() : "";

  for (const row of [...classTable.rows].slice(1)) {
    const cell = document.createElement("td");
    cell.textContent = "…";
    row.appendChild(cell);
    const classId = row.cells[iNbr] ? row.cells[iNbr].textContent.trim() : "";
    if (!/^\w+$/.test(classId)) {
      cell.textContent = "--";
      continue;
    }
    let meta;
    try {
      const res = await fetch(
        `${window.location.origin}/vtop/examinations/processDigitalAssignment`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: `authorizedID=${reg}&x=${new Date().toGMTString()}&classId=${classId}&_csrf=${csrf}`,
        }
      );
      meta = parse_da_detail(
        new DOMParser().parseFromString(await res.text(), "text/html")
      );
    } catch {
      cell.textContent = "--";
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
    if (upcoming.length === 0) {
      const missed = meta.items.filter((a) => !a.uploaded).length;
      if (meta.items.length === 0) cell.textContent = "No DAs posted";
      else if (missed > 0) {
        cell.textContent = `⚠ ${missed} past due (not uploaded)`;
        cell.style.background = "rgb(238, 75, 43,0.35)";
      } else cell.textContent = "✅ all submitted";
      continue;
    }
    const days = Math.ceil((dueMs(upcoming[0].due) - now) / 86400000);
    cell.style.background =
      days <= 3 ? "rgb(238, 75, 43,0.6)" : "rgb(170, 255, 0,0.6)";
    const span = document.createElement("span");
    span.textContent = `${upcoming[0].due} (${days} day(s) left)`;
    cell.appendChild(span);
    // Everything both buttons need, written onto the buttons themselves. See
    // the handlers above for why this is an attribute and not a closure.
    const payload = JSON.stringify({
      key: meta.course_code || classId,
      code: meta.course_code,
      title: meta.course_title,
      dues: upcoming.map((a) => ({ due: a.due, title: a.title })),
    });

    // 🔔 Chrome notifications for every upcoming due of this course — 6 PM
    // the evening before and 8 AM on the due day. No Google sign-in.
    const btn = window.vrButton("da-bell", "🔔 remind me", { vrDues: payload });
    btn.className = "vrevamp-da-remind";
    btn.title =
      "Chrome notification the evening before (6 PM) and the morning of (8 AM) each due — no sign-in needed";
    btn.style.cssText =
      "display:inline-block;margin-top:4px;font-size:11px;cursor:pointer;";
    cell.appendChild(btn);

    // ✉ optional Google Calendar events with an email 24 h before each due
    const mailBtn = window.vrButton("da-mail", "✉ email", { vrDues: payload });
    mailBtn.className = "vrevamp-da-remind";
    mailBtn.title = `Google Calendar event per upcoming due, email ${DA_REMINDER_LEAD_MIN / 60} h before — needs one-time Google consent`;
    mailBtn.style.cssText =
      "display:inline-block;margin-top:4px;margin-left:4px;font-size:11px;cursor:pointer;";
    cell.appendChild(mailBtn);

    // 📅 one-tap: prefilled Google Calendar event per upcoming due — opens
    // in a new tab, the student just presses Save. No sign-in setup at all.
    upcoming.forEach((a) => {
      const m = a.due.trim().match(/^(\d{1,2})-([A-Za-z]{3,4})-(\d{4})$/);
      if (!m || !DA_MONTHS[m[2]]) return;
      const day = `${m[3]}${DA_MONTHS[m[2]]}${m[1].padStart(2, "0")}`;
      const link = document.createElement("a");
      link.className = "vrevamp-da-gcal";
      link.textContent = upcoming.length > 1 ? `📅 ${a.due}` : "📅 gcal";
      link.title =
        "one tap: opens Google Calendar with this due prefilled — just press Save (no sign-in setup)";
      link.target = "_blank";
      link.rel = "noopener";
      link.style.cssText =
        "display:inline-block;margin-top:4px;margin-left:4px;font-size:11px;";
      link.href = window.vrGcalTemplateUrl({
        title: `DA due: ${meta.course_code} — ${a.title}`,
        start: `${day}T200000`,
        end: `${day}T210000`,
        details:
          `${meta.course_title}\nDue ${a.due}\n\n` +
          "Tip: add an Email notification to this event (or set one as your Google Calendar default) to get it mailed to you.",
      });
      cell.appendChild(link);
    });
  }
};

function calendar(date, course_code, course_name, token, time, retries = 3) {
  var map = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Sept: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12",
  };
  var tmp = date.split("-");
  var dte = `${tmp[2]}-${map[tmp[1]]}-${tmp[0]}`;

  fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&sendNotifications=true&alt=json`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
      },
      body: JSON.stringify({
        end: {
          dateTime: dte + "T23:59:00.000+05:30",
        },
        start: {
          dateTime: dte + time,
        },
        eventType: "default",
        description: course_name,
        summary: "Digital Assignment- " + course_code,
      }),
    }
  )
    .then((res) => {
      return res.json();
    })
    .then((data) => {
      try {
        if (data.error.code == 401) {
          error_code = 401;
        } else if (data.error.code == 403 && retries > 0) {
          // Rate-limited: back off before retrying, give up after 3 attempts
          setTimeout(() => {
            calendar(date, course_code, course_name, token, time, retries - 1);
          }, 1000);
        }
      } catch { }
      return true;
    })
    .catch(() => { });
}

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

    chrome.storage.sync.get(["token"], (token) => {
      if (token.token != null) {
        // console.log(token.token);
        var btn = document.createElement("button");
        btn.type = "button"; // never submit the enclosing VTOP form
        btn.innerHTML = `
                      <svg xmlns="http://www.w3.org/2000/svg" data-name="Layer 1" viewBox="0 0 141.7 141.7" width="24" height="24"><path fill="#fff" d="M95.8,45.9H45.9V95.8H95.8Z"/><path fill="#34a853" d="M95.8,95.8H45.9v22.5H95.8Z"/><path fill="#4285f4" d="M95.8,23.4H30.9a7.55462,7.55462,0,0,0-7.5,7.5V95.8H45.9V45.9H95.8Z"/><path fill="#188038" d="M23.4,95.8v15a7.55462,7.55462,0,0,0,7.5,7.5h15V95.8Z"/><path fill="#fbbc04" d="M118.3,45.9H95.8V95.8h22.5Z"/><path fill="#1967d2" d="M118.3,45.9v-15a7.55462,7.55462,0,0,0-7.5-7.5h-15V45.9Z"/><path fill="#ea4335" d="M95.8,118.3l22.5-22.5H95.8Z"/><polygon fill="#2a83f8" points="77.916 66.381 75.53 63.003 84.021 56.868 87.243 56.868 87.243 85.747 82.626 85.747 82.626 62.772 77.916 66.381"/><path fill="#2a83f8" d="M67.29834,70.55785A7.88946,7.88946,0,0,0,70.78,64.12535c0-4.49-4-8.12-8.94-8.12a8.77525,8.77525,0,0,0-8.74548,6.45379l3.96252,1.58258a4.41779,4.41779,0,0,1,4.473-3.51635,4.138,4.138,0,1,1,.06256,8.24426v.00513h-.0559l-.00666.00061-.00964-.00061H59.15v3.87677h2.70642L61.88,72.65a4.70514,4.70514,0,1,1,0,9.37,5.35782,5.35782,0,0,1-3.96588-1.69354,4.59717,4.59717,0,0,1-.80408-1.2442l-.69757-1.69946L52.23005,79c.62,4.33,4.69,7.68,9.61,7.68,5.36,0,9.7-3.96,9.7-8.83A8.63346,8.63346,0,0,0,67.29834,70.55785Z"/></svg><span>Sync assignments with Google Calendar</span>`;
        btn.style = `display: flex;align-items: center;gap: 1rem;font-family: inherit;justify-content: space-around;color: #535353;font-size: 13px;font-weight: 500;margin: 8px auto;cursor: pointer;background-color: white;border-radius: 32px;transition: all 0.2s ease-in-out;padding: 6px 10px;border: 1px solid rgba(0, 0, 0, 0.25);`;
        btn.id = "sync_dates_btn";
        document.getElementsByClassName("box-header with-border")[0].insertAdjacentElement("afterend", btn);
        let tot_sub;
        btn.addEventListener("click", async () => {
          let table = document.getElementsByClassName("customTable")[0].children[0].children;

          btn.disabled = true;

          let sync_btn = document.getElementById("sync_dates_btn");
          let sync_wait = document.createElement("div");
          sync_wait.className = "col-md-12";
          let stmt = document.createElement("h4");
          stmt.innerText = `Please Wait while the dates get synced!!!`;
          stmt.style.textAlign = "center";
          stmt.style.color = "red";
          sync_wait.appendChild(stmt);
          sync_wait.id = "sync_wait_txt";
          sync_btn.insertAdjacentElement("afterend", sync_wait);

          for (let i = 0; i < table.length - 1; i++) {

            tot_sub = due_sync[i].length;

            if (error_code == 401) {
              alert("Please Re-login with your Google account and refresh the page");
              chrome.storage.sync.set({ token: null });
              error_code = 0;
              break;
            }
            for (let j = 0; j < tot_sub; j++) {
              // console.log(due_sync,course_code,course_name);
              calendar(due_sync[i][j].date_due, due_sync[i][j].course_code, due_sync[i][j].course_title, token.token, "T22:00:00.000+05:30");
              calendar(due_sync[i][j].date_due, due_sync[i][j].course_code, due_sync[i][j].course_title, token.token, "T10:00:00.000+05:30");
              // console.log(due_sync[i][j].date_due,due_sync[i][j].course_code,due_sync[i][j].course_title);
              if (error_code == 401) {
                break;
              }
              await sleep(550);
            }
            if (error_code != 401 && i == table.length - 2) {
              document.getElementById("sync_wait_txt").hidden = true;
              alert("Due Dates are successfully synced to your calendar");
              btn.disabled = false;
            }
          }
        });

      }
      else {
        let div = document.createElement("div");
        div.className = "col-md-12";
        let stmt = document.createElement("p");
        stmt.innerText = "**Sign in with Google in extension to sync your due dates with Google Calendar";
        stmt.style.color = "red";
        div.appendChild(stmt);
        document.getElementsByClassName("box-header with-border")[0].insertAdjacentElement("afterend", div);
      }
    });

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