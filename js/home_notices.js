/*
 * vRevamp home notices: a small card on the VTOP landing page (after login)
 * showing exam countdowns, the next holiday, and subjects at risk — all from
 * data attendance_insights.js has already cached in chrome.storage.local.
 * Nothing is fetched here, so the card renders instantly.
 */
(() => {
  const CACHE_PREFIX = "vrevamp_calendar_";
  const DAY_MS = 24 * 60 * 60 * 1000;

  const todayMidnight = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  };

  const daysUntil = (iso) =>
    Math.round((new Date(iso) - todayMidnight()) / DAY_MS);

  const fmt = (iso) =>
    new Date(iso).toLocaleDateString("en-IN", {
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

    if (calendar) {
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
    } else {
      body.appendChild(
        line(
          "Open the Attendance page once so vRevamp can read the academic calendar.",
          "#888"
        )
      );
      added++;
    }

    if (summary && Array.isArray(summary.subjects)) {
      const atRisk = summary.subjects.filter(
        (s) => typeof s.nextBunkable === "number" && s.nextBunkable <= 1
      );
      if (atRisk.length) {
        atRisk.forEach((s) => {
          body.appendChild(
            line(
              `⚠️ ${s.name}: only ${s.nextBunkable} ${s.unit || "class(es)"} skippable before the next exam`,
              "#c0392b"
            )
          );
          added++;
        });
      } else if (summary.subjects.length) {
        body.appendChild(
          line(
            "✅ Attendance: all subjects have buffer before the next exam.",
            "#2e7d32"
          )
        );
        added++;
      }
      // compact safe-skip overview — the "never dip below 75%" numbers
      const withSafe = summary.subjects.filter(
        (s) => typeof s.safeNow === "number"
      );
      if (withSafe.length) {
        body.appendChild(
          line(
            `🎯 Safe to skip now: ${withSafe
              .map(
                (s) =>
                  `${s.code || s.name.split(" ")[0]}${/lab/i.test(s.unit || "") ? " (lab)" : ""} ${s.safeNow}`
              )
              .join(" · ")}`,
            null
          )
        );
        added++;
      }
      const ageDays = Math.floor(
        (Date.now() - (summary.fetchedAt || 0)) / DAY_MS
      );
      if (ageDays >= 1) {
        body.appendChild(
          line(
            `(attendance data is ${ageDays} day(s) old — open the Attendance page to refresh)`,
            "#888"
          )
        );
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

  // the landing content loads asynchronously after the nav message, so retry
  // briefly until the container exists
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
      if (done || attempts >= 10) clearInterval(timer);
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
