/*
 * "At a glance" — the popup's summary cards.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * Every number here was ALREADY being cached by the page scripts and had
 * nowhere to be seen. Attendance headroom, what you still owe, the next exam —
 * all of it sat in chrome.storage.local, readable only by opening VTOP and
 * navigating to the page that wrote it. Which is exactly the errand a summary
 * is supposed to save.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS FETCHED HERE, AND THAT IS THE DESIGN
 * ---------------------------------------------------------------------------
 * Storage only. The popup therefore opens instantly, works with VTOP closed,
 * and works offline. It is also the one safe choice: driving VTOP's endpoints
 * from a popup is exactly the "replay with a scraped token" pattern that
 * returns 404s and ends the session (ROADMAP #4), and a popup has no VTOP page
 * to borrow a live _csrf from in the first place.
 *
 * The cost is that these numbers are only as fresh as the last visit to each
 * page — so every card SAYS how old it is rather than implying it is live. A
 * stale figure presented as current is the failure this project has hit
 * repeatedly (the home card's "0 skippable before CAT-1" long after CAT-1).
 */
(() => {
  const DAY = 86400000;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const ageOf = (ms) => {
    if (typeof ms !== "number") return null;
    const days = Math.floor((Date.now() - ms) / DAY);
    if (days <= 0) return "updated today";
    if (days === 1) return "1 day old";
    return `${days} days old`;
  };

  // "05-Sep-2026" -> local midnight. Never new Date(iso): that parses as UTC
  // and lands on the previous day for anyone west of Greenwich, the trap
  // js/home_notices.js documents.
  const MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  };
  const dmy = (s) => {
    const m = /^(\d{1,2})-([A-Za-z]{3,4})-(\d{4})$/.exec(String(s || "").trim());
    if (!m) return null;
    const mon = MONTHS[m[2].toLowerCase()];
    return mon === undefined ? null : new Date(+m[3], mon, +m[1]);
  };
  const iso = (s) => {
    const p = String(s || "").split("-").map(Number);
    return p.length === 3 && p[0] > 1900 ? new Date(p[0], p[1] - 1, p[2]) : null;
  };
  const daysTo = (d) => {
    if (!d) return null;
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return Math.round((d - t) / DAY);
  };
  const inDays = (n) =>
    n === 0 ? "today" : n === 1 ? "tomorrow" : n < 0 ? `${-n} day(s) ago` : `in ${n} days`;

  const card = (tone, icon, title, detail) => {
    const c = el("div", `vr-card ${tone}`);
    c.appendChild(el("div", "vr-card-i", icon));
    const body = el("div");
    body.appendChild(el("div", "vr-card-t", title));
    if (detail) body.appendChild(el("div", "vr-card-d", detail));
    c.appendChild(body);
    return c;
  };

  /* ---- attendance --------------------------------------------------------
   * Leads with debarment rather than with a per-exam figure, for the reason
   * js/home_notices.js records: "skippable before CAT-1" stops meaning
   * anything the day CAT-1 arrives, whereas 75% is the rule that actually
   * costs a seat in the exam hall and is measured across the whole semester.
   */
  const attendanceCard = (summary) => {
    const subjects = (summary && summary.subjects) || [];
    if (!subjects.length) return null;
    const age = ageOf(summary.fetchedAt);

    const below = subjects.filter((s) => s.below75);
    if (below.length) {
      const worst = below.sort((a, b) => (a.pct || 0) - (b.pct || 0))[0];
      return card(
        "bad",
        "\u{1F534}",
        `${below.length} subject(s) below 75%`,
        `Lowest ${worst.name || worst.code} at ${worst.pct}% · ${age}`
      );
    }
    const tight = subjects
      .filter((s) => typeof s.safeNow === "number")
      .sort((a, b) => a.safeNow - b.safeNow)[0];
    if (!tight) return null;
    const unit = /lab/i.test(tight.unit || "") ? "lab(s)" : "class(es)";
    return card(
      tight.safeNow <= 1 ? "warn" : "good",
      tight.safeNow <= 1 ? "\u{26A0}\u{FE0F}" : "\u{2705}",
      tight.safeNow === 0
        ? `No room left in ${tight.code || tight.name}`
        : `Can still miss ${tight.safeNow} ${unit}`,
      `Tightest: ${tight.name || tight.code} at ${tight.pct}% · ${age}`
    );
  };

  /* ---- assignments -------------------------------------------------------
   * Overdue outranks upcoming. A student with something already past due and
   * never uploaded is the one case that most deserves the line, and it is the
   * case the DA summary bar used to render with no controls at all.
   */
  const duesCard = (dues) => {
    const courses = (dues && dues.courses) || [];
    if (!courses.length) return null;
    const age = ageOf(dues.fetchedAt);

    const overdue = courses.flatMap((c) =>
      (c.overdue || []).map((a) => ({ ...a, code: c.code }))
    );
    const upcoming = courses
      .flatMap((c) => (c.upcoming || []).map((a) => ({ ...a, code: c.code })))
      .map((a) => ({ ...a, when: dmy(a.due) }))
      .filter((a) => a.when)
      .sort((a, b) => a.when - b.when);

    if (overdue.length) {
      return card(
        "bad",
        "\u{1F4CC}",
        `${overdue.length} assignment(s) past due`,
        `${overdue[0].code} — ${overdue[0].title} (${overdue[0].due}) · ${age}`
      );
    }
    if (!upcoming.length) {
      return card("good", "\u{2705}", "No assignments due", `Nothing outstanding · ${age}`);
    }
    const next = upcoming[0];
    const n = daysTo(next.when);
    return card(
      n <= 3 ? "warn" : "",
      "\u{1F4DD}",
      `${upcoming.length} assignment(s) to upload`,
      `Next: ${next.code} — ${next.title}, ${inDays(n)} · ${age}`
    );
  };

  /* ---- next exam ---------------------------------------------------------
   * From the exam schedule cache, which carries a dated row per exam. Only
   * exams still ahead: a past one is not a countdown.
   */
  const examCard = (schedule) => {
    const exams = ((schedule && schedule.exams) || [])
      .map((e) => ({ ...e, when: iso(e.dateIso) }))
      .filter((e) => e.when && daysTo(e.when) >= 0)
      .sort((a, b) => a.when - b.when);
    if (!exams.length) return null;
    const next = exams[0];
    const n = daysTo(next.when);
    const where = next.venue && next.venue !== "-" ? ` @ ${next.venue}` : "";
    return card(
      n <= 3 ? "warn" : "",
      "\u{1F4C5}",
      `${next.type || "Exam"} ${inDays(n)}`,
      `${next.code}${where}${next.reporting ? ` · report ${next.reporting}` : ""}`
    );
  };

  const render = async () => {
    const box = document.getElementById("vr-glance");
    if (!box) return;
    let store = {};
    try {
      store = await chrome.storage.local.get([
        "vrevamp_attendance_summary",
        "vrevamp_da_dues",
        "vrevamp_exam_schedule",
      ]);
    } catch {
      /* storage unavailable — fall through to the empty state */
    }

    const cards = [
      attendanceCard(store.vrevamp_attendance_summary),
      duesCard(store.vrevamp_da_dues),
      examCard(store.vrevamp_exam_schedule),
    ].filter(Boolean);

    box.textContent = "";
    if (!cards.length) {
      // Never a bare "no data": the reason is actionable and the student
      // cannot guess it.
      box.appendChild(
        el(
          "div",
          "vr-empty",
          "Nothing cached yet — open VTOP's Attendance, DA Upload and Exam Schedule pages once and this fills in."
        )
      );
      return;
    }
    cards.forEach((c) => box.appendChild(c));
  };

  const version = () => {
    const node = document.getElementById("vr-version");
    try {
      if (node) node.textContent = "v" + chrome.runtime.getManifest().version;
    } catch {
      /* not in an extension context */
    }
  };

  const openVtop = () => {
    const button = document.getElementById("vr-open-vtop");
    if (!button) return;
    button.addEventListener("click", () => {
      chrome.tabs.create({ url: "https://vtop.vitap.ac.in/vtop/content" });
      window.close();
    });
  };

  version();
  openVtop();
  render().catch(() => {
    /* nothing renderable — the empty state above already covers it */
  });
})();
