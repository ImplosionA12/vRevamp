/*
 * vRevamp home notices: a small card on the VTOP landing page (after login)
 * showing exam countdowns, the next holiday, and subjects at risk — all from
 * data attendance_insights.js has already cached in chrome.storage.local.
 * Nothing is fetched here, so the card renders instantly.
 */
(() => {
  const CACHE_PREFIX = "vrevamp_calendar_";
  const DAY_MS = 24 * 60 * 60 * 1000;

  /*
   * VTOP's own Class Attendance menu entry. Found the way js/navbarap.js finds
   * it — the menu anchors are the ones carrying data-url — because that
   * shortcut has been navigating this way since the beginning, and the entry
   * simply is not present for every role.
   */
  const attendanceMenuLink = () =>
    Array.from(document.getElementsByTagName("a"))
      .filter((a) => a.dataset && a.dataset.url)
      .find((a) => /class\s*attendance/i.test(a.innerText || "")) || null;

  /*
   * The click is a synthetic one from the isolated world, which is fine here
   * and only here: it is VTOP's handler that has to receive it, not ours.
   * js/attendance.js drives #semesterSubId with a dispatched `change` the same
   * way, and ROADMAP rule 4 names that as the sanctioned route. (The rule that
   * a synthetic click never arrives is about OUR handlers, which live in the
   * isolated world — the reverse direction.)
   */
  if (typeof window.vrDelegate === "function") {
    window.vrDelegate("home-attendance-refresh", (button) => {
      const menu = attendanceMenuLink();
      if (!menu) {
        button.textContent = "open Attendance from the menu";
        button.disabled = true;
        return;
      }
      button.textContent = "opening…";
      button.disabled = true;
      menu.click();
    });
  }

  const todayMidnight = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  };

  // "YYYY-MM-DD" -> LOCAL midnight. new Date(iso) parses a bare ISO date as
  // UTC midnight, so for any viewer west of Greenwich it lands on the
  // previous local day — fmt() then printed the wrong date and weekday for
  // every exam and holiday. Same hazard attendance_insights.js documents.
  const dateOfIso = (iso) => {
    const [y, m, d] = String(iso).split("-").map(Number);
    return new Date(y, m - 1, d);
  };

  const daysUntil = (iso) =>
    Math.round((dateOfIso(iso) - todayMidnight()) / DAY_MS);

  const fmt = (iso) =>
    dateOfIso(iso).toLocaleDateString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });

  const getLatestCalendar = async () => {
    const all = await chrome.storage.local.get(null);
    const calendars = Object.keys(all)
      .filter((k) => k.startsWith(CACHE_PREFIX))
      .map((k) => all[k]);
    calendars.sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
    return calendars[0] || null;
  };

  const line = (text, color) => {
    const p = document.createElement("p");
    p.textContent = text;
    p.style.cssText = `margin:2px 0;font-size:13px;${color ? `color:${color};` : "color:#333;"}`;
    return p;
  };

  const buildCard = (calendar, summary, collapsed) => {
    const card = document.createElement("div");
    card.id = "vrevamp-home-notices";
    card.style.cssText =
      "margin:8px 10px;padding:8px 12px;background:#fff;border:1px solid #ccc;" +
      "border-left:4px solid rgb(60,141,188);border-radius:4px;" +
      "box-shadow:0 1px 3px rgba(0,0,0,0.1);";

    // header doubles as a collapse toggle so the card never hogs the page;
    // the body is height-capped and scrolls internally
    const head = document.createElement("div");
    head.style.cssText =
      "display:flex;justify-content:space-between;align-items:center;cursor:pointer;";
    const title = document.createElement("p");
    title.textContent = "vRevamp — heads up";
    title.style.cssText =
      "font-weight:bold;margin:0;font-size:13px;color:rgb(60,141,188);";
    const toggle = document.createElement("span");
    toggle.textContent = collapsed ? "▸ show" : "▾ hide";
    toggle.style.cssText = "font-size:11px;color:#888;";
    head.appendChild(title);
    head.appendChild(toggle);
    card.appendChild(head);

    const body = document.createElement("div");
    body.style.cssText = `max-height:96px;overflow-y:auto;margin-top:4px;${collapsed ? "display:none;" : ""}`;
    card.appendChild(body);
    head.addEventListener("click", () => {
      const wasHidden = body.style.display === "none";
      body.style.display = wasHidden ? "" : "none";
      toggle.textContent = wasHidden ? "▾ hide" : "▸ show";
      chrome.storage.local.set({ vrevamp_notices_collapsed: !wasHidden });
    });

    let added = 0;

    // Data cached during a semester that has since ended must not render as
    // if it were current ("only 0 classes skippable…" from last sem). Detect
    // it via the semester name both caches carry (semesterLooksStale is in
    // js/utils/chooseCurrentSem.js, loaded before this script).
    const semName =
      (summary && summary.semester) || (calendar && calendar.semester) || null;
    const stale =
      typeof semesterLooksStale === "function" &&
      semesterLooksStale(semName, calendar);
    if (stale) {
      body.appendChild(
        line(
          `\u{1F4CC} vRevamp's cached data is from "${semName}", which looks over — open the Attendance and Time Table pages once so the new semester loads.`,
          "#b8860b"
        )
      );
      added++;
    }

    if (calendar && !stale) {
      [
        ["CAT-1", calendar.cat1],
        ["CAT-2", calendar.cat2],
        ["FAT", calendar.fat],
      ].forEach(([label, iso]) => {
        if (!iso) return;
        const d = daysUntil(iso);
        if (d < 0) return;
        const text =
          d === 0
            ? `\u{1F4DD} ${label} starts today! (${fmt(iso)})`
            : `\u{1F4DD} ${label} starts in ${d} day(s) (${fmt(iso)})`;
        body.appendChild(line(text, d <= 7 ? "#c0392b" : null));
        added++;
      });

      const nextHoliday = (calendar.holidays || []).find(
        (iso) => daysUntil(iso) >= 0
      );
      if (nextHoliday) {
        body.appendChild(
          line(
            `\u{1F3D6}️ Next holiday: ${fmt(nextHoliday)} (in ${daysUntil(nextHoliday)} day(s))`,
            "#2e7d32"
          )
        );
        added++;
      }
    } else if (!calendar) {
      body.appendChild(
        line(
          "Open the Attendance page once so vRevamp can read the academic calendar.",
          "#888"
        )
      );
      added++;
    }

    const summaryAgeDays =
      summary && summary.fetchedAt
        ? Math.floor((Date.now() - summary.fetchedAt) / DAY_MS)
        : null;

    /*
     * WHY THIS CARD NOW TALKS ABOUT DEBARMENT, NOT ABOUT CAT-1.
     * Asked for 2026-08-17: "instead of showing how many skippable classes
     * before cat1 u can say how many debarred".
     *
     * It is the right number for two reasons, only one of which is wording.
     *
     * 1. "N skippable before CAT-1" is a fact with an expiry date, and nothing
     *    on the card could see it pass. Seen live the same morning: the card
     *    said "only 0 class(es) skippable before the next exam" for a subject
     *    the attendance page gave three in hand. Neither number was wrong — the
     *    0 had been measured against CAT-1 days earlier, CAT-1 arrived, and a
     *    figure counted up to a date in the past carried on rendering as news.
     * 2. Missing an exam-window class costs nothing by itself. Falling under
     *    75% costs the exam hall. The 75% line is measured against the rest of
     *    the semester, so it cannot silently expire the way the other did.
     *
     * `safeNow` is that number already: sessions that can be missed while never
     * dipping under 75%. So the card leads with it, and says what it is for.
     *
     * The exam figure is not deleted — it is demoted to a parenthetical, and
     * only while the exam it counts to is still ahead. A stale one is dropped
     * rather than shown, because an alarming number nobody can date is worse
     * than no number.
     */
    // LOCAL date, not toISOString(). Between midnight and 05:30 IST the UTC
    // day is still yesterday, so a UTC "today" would keep showing an exam
    // figure for an exam that started this morning — the exact class of bug
    // this rewrite exists to remove. Same hazard dateOfIso() guards above.
    const d0 = todayMidnight();
    const todayIso = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, "0")}-${String(
      d0.getDate()
    ).padStart(2, "0")}`;
    const examStillAhead = (s) =>
      typeof s.nextBunkable === "number" &&
      !!s.nextExamIso &&
      s.nextExamIso > todayIso;

    const label = (s) =>
      `${s.code || String(s.name || "").split(" ")[0]}${/lab/i.test(s.unit || "") ? " (lab)" : ""}`;
    // "3 class(es)" / "1 class" — the unit strings carry the plural in
    // brackets, which reads badly next to a 1.
    const count = (n, unit) => {
      const u = unit || "class(es)";
      return n === 1 ? `${n} ${u.replace("(es)", "").replace("(s)", "")}` : `${n} ${u}`;
    };

    if (!stale && summary && Array.isArray(summary.subjects) && summary.subjects.length) {
      const subjects = summary.subjects;

      // Already under the line. This is the only group with a deadline it can
      // still act on, so it goes first and is never collapsed into a summary.
      subjects
        .filter((s) => s.below75)
        .sort((a, b) => (a.pct || 0) - (b.pct || 0))
        .forEach((s) => {
          const where = typeof s.pct === "number" ? ` (${s.pct}%)` : "";
          body.appendChild(
            line(
              s.canRecover === false
                ? `\u{1F6AB} ${s.name}: below 75%${where} — attending every remaining class still only reaches ${
                    typeof s.maxPct === "number" ? `${s.maxPct}%` : "under 75%"
                  }. Debarment is decided by the faculty from here; ask now.`
                : `\u{1F6AB} ${s.name}: below 75%${where} — debarred unless you attend the next ${count(
                    s.recover || 1,
                    s.unit
                  )} in a row.`,
              "#c0392b"
            )
          );
          added++;
        });

      // Above the line but with no room left: one more absence is the one that
      // costs the exam.
      subjects
        .filter((s) => !s.below75 && typeof s.safeNow === "number" && s.safeNow <= 1)
        .sort((a, b) => a.safeNow - b.safeNow)
        .forEach((s) => {
          const ahead = examStillAhead(s)
            ? ` (${s.nextBunkable} before ${s.nextExamLabel || "the next exam"})`
            : "";
          body.appendChild(
            line(
              s.safeNow === 0
                ? `\u{26A0}\u{FE0F} ${s.name}: no room left — miss one more and you are under 75%${ahead}`
                : `\u{26A0}\u{FE0F} ${s.name}: ${count(s.safeNow, s.unit)} left before debar${ahead}`,
              s.safeNow === 0 ? "#c0392b" : "#b8860b"
            )
          );
          added++;
        });

      // Everyone else, one line, smallest headroom first — the order a student
      // reads it in is the order they should worry in.
      const comfortable = subjects
        .filter((s) => !s.below75 && typeof s.safeNow === "number" && s.safeNow > 1)
        .sort((a, b) => a.safeNow - b.safeNow);
      if (comfortable.length) {
        body.appendChild(
          line(
            `\u{1F3AF} Can still miss before debar: ${comfortable
              .map((s) => `${label(s)} ${s.safeNow}`)
              .join(" · ")}`,
            null
          )
        );
        added++;
      }

      if (
        !subjects.some((s) => s.below75) &&
        !subjects.some((s) => typeof s.safeNow === "number" && s.safeNow <= 1) &&
        comfortable.length
      ) {
        body.appendChild(
          line("✅ Nothing is close to the 75% line.", "#2e7d32")
        );
        added++;
      }

      if (summaryAgeDays !== null && summaryAgeDays >= 1) {
        /*
         * "open the Attendance page to refresh" is a chore the card can do
         * itself — asked for 2026-08-19 as "this one should be auto na".
         *
         * It stops one step short of automatic, on purpose. The only way to
         * refresh without the page is to replay VTOP's own attendance POST,
         * and replaying VTOP endpoints is what returns 404s and ends the
         * session (ROADMAP rule 4) — the exact failure session_repair now
         * has to warn about. Driving the real menu entry is the sanctioned
         * route, and it is the same mechanism the navbar shortcut has used
         * all along: VTOP's menu anchors carry data-url, and a click on one
         * navigates. So the nag becomes the click it was asking for.
         */
        const row = line(
          `(attendance data is ${summaryAgeDays} day(s) old)`,
          "#888"
        );
        const menu = attendanceMenuLink();
        if (menu && typeof window.vrButton === "function") {
          const refresh = window.vrButton("home-attendance-refresh", "Refresh now");
          refresh.style.cssText =
            "margin-left:6px;padding:0 6px;font-size:11px;line-height:18px;" +
            "background:rgb(73,117,182);border:none;border-radius:3px;color:#fff;";
          row.appendChild(refresh);
        } else {
          // a role whose menu has no Class Attendance entry, or the navbar
          // never rendered: the old instruction is still the true one
          row.textContent =
            `(attendance data is ${summaryAgeDays} day(s) old — open the Attendance page to refresh)`;
        }
        body.appendChild(row);
      }
    }

    return added ? card : null;
  };

  const tryRender = async () => {
    if (document.getElementById("vrevamp-home-notices")) return true;
    // don't stack the card on top of the attendance page's own insights
    if (document.getElementById("vrevamp-alert-head")) return true;
    const container =
      document.querySelector("#main-section") ||
      document.querySelector(".content-wrapper") ||
      // 2026 layout: the SCROLLABLE content wrapper, not #core-container —
      // that one is overflow:hidden, so a card there is pinned above the
      // scroll region and permanently eats viewport height
      document.querySelector("#core-container .overflow-auto.showBlock") ||
      document.querySelector("#b5wrapper") ||
      document.querySelector("#core-container");
    if (!container) return false;
    const calendar = await getLatestCalendar();
    const stored = await chrome.storage.local.get([
      "vrevamp_attendance_summary",
      "vrevamp_notices_collapsed",
    ]);
    const summary = stored.vrevamp_attendance_summary || null;
    const card = buildCard(calendar, summary, !!stored.vrevamp_notices_collapsed);
    // re-check after the awaits: two message-triggered renders can interleave
    // at the storage reads and both pass the guard at the top (seen live —
    // duplicated card on the 2026 home page)
    if (card && !document.getElementById("vrevamp-home-notices"))
      container.insertBefore(card, container.firstChild);
    return true;
  };

  /*
   * The landing content loads asynchronously after the nav message, so retry
   * until the container exists.
   *
   * The cap was 10 × 700 ms — seven seconds. VTOP's own server is documented in
   * ROADMAP as intermittently stalling its static assets for **thirty seconds
   * or more** (readyState "loading", the navbar and cards appearing only after),
   * which is longer than the whole retry budget. On one of those loads the card
   * simply never appeared, silently and with nothing in the console, which is
   * indistinguishable from the feature being broken.
   *
   * 45 ticks is ~31 s. The work per tick is a handful of querySelectors against
   * a shell that has not rendered yet, so the cost of the extra 35 is nil, and
   * the interval still ends — an unbounded retry on VTOP's SPA is how the
   * "Page Unresponsive" freeze happened.
   */
  const renderWithRetries = () => {
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts++;
      let done = false;
      try {
        done = await tryRender();
      } catch (error) {
        done = true;
        console.warn("vRevamp notices:", error);
      }
      if (done || attempts >= 45) clearInterval(timer);
    }, 700);
  };

  chrome.runtime.onMessage.addListener((request) => {
    if (
      request.message === "vtop2_nav_bar" ||
      request.message === "nav_bar_change"
    ) {
      renderWithRetries();
    }
  });

  renderWithRetries();
})();
