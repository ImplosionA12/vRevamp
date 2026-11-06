/*
 * Leave / General Outing approval watcher.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * Asked 2026-08-23: "when the leave is approved and we open the vtop then send
 * us it got approved and the approval file".
 *
 * A leave request is not decided when you file it. It sits with a mentor, then
 * a warden, and the only way to learn it has moved is to open Hostel → General
 * Outing and read a table. So the student refreshes a page for days, or misses
 * the approval entirely and travels without the OutPass they are supposed to
 * carry.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE, READ LIVE 2026-08-23 (signed in, not inferred)
 * ---------------------------------------------------------------------------
 * Page: hostel/StudentGeneralOuting. One table:
 *
 *   S.No | Registration Number | Place Of Visit | Purpose Of Visit |
 *   From Date | From Time | To Date | To Time | Action | Status |
 *   Download OutPass
 *
 * Three statuses observed, and they are a pipeline rather than a flag:
 *
 *   "Waiting for Mentor's Approval"   -> pending
 *   "Waiting for Warden's Approval"   -> pending, one step further
 *   "Leave Request Accepted"          -> approved
 *
 * The OutPass — the thing you actually have to show at the gate — appears in
 * the last column ONLY on accepted rows. That is why "approved" and "your file
 * is ready" are the same event and are reported together.
 *
 * ---------------------------------------------------------------------------
 * WHY IT COMPARES RATHER THAN COUNTS
 * ---------------------------------------------------------------------------
 * "Approved" is not a number going up. A request can be filed, sit at Mentor
 * for a week, move to Warden, and be accepted — while an older one is rejected
 * and a newer one is filed. Counting accepted rows would announce the wrong
 * trip, or nothing at all when two states change at once.
 *
 * So each row is remembered by identity (its S.No plus its From date, which
 * together survive the table being re-ordered) and the transition that matters
 * is per-row: NOT accepted before, accepted now. A row seen for the first time
 * already accepted is recorded silently — it is history, not news, and
 * announcing it on first install would cry wolf about a trip taken months ago.
 */
(() => {
  const SNAPSHOT_KEY = "vtopext_leave_status";
  const REQUEST_KEY = "vtopext_leave_request";
  const CHECKED_KEY = "vtopext_leave_checked_at";
  // Same budget the exam venue watcher uses, and for the same reason: this
  // runs on ordinary page arrivals, so it must be rare enough that browsing
  // VTOP normally never turns into a stream of requests.
  const CHECK_EVERY_MS = 3 * 60 * 60 * 1000;

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const isAccepted = (status) => /accepted|approved/i.test(status) && !/waiting/i.test(status);

  /*
   * The table is found by its HEADERS, never by position — this page also
   * carries the filing form, and a future layout may wrap either in more
   * markup. "Place Of Visit" plus "Status" is a pair no other table here has.
   */
  const findLeaveTable = (root) => {
    const tables = Array.from((root || document).querySelectorAll("table"));
    return (
      tables.find((t) => {
        const head = clean(t.rows && t.rows[0] ? t.rows[0].textContent : "").toLowerCase();
        return /place\s*of\s*visit/.test(head) && /status/.test(head);
      }) || null
    );
  };

  const parseLeaveTable = (table) => {
    if (!table || !table.rows.length) return null;
    const head = Array.from(table.rows[0].cells).map((c) => clean(c.textContent).toLowerCase());
    const col = (re) => head.findIndex((h) => re.test(h));
    const iNo = col(/^s\.?\s*no/);
    const iPlace = col(/place\s*of\s*visit/);
    const iPurpose = col(/purpose/);
    const iFrom = col(/from\s*date/);
    const iTo = col(/to\s*date/);
    const iStatus = col(/status/);
    const iPass = col(/outpass|download/);
    if (iStatus < 0 || iPlace < 0) return null;

    const rows = [];
    Array.from(table.rows)
      .slice(1)
      .forEach((tr) => {
        const cells = tr.cells;
        if (!cells || cells.length <= iStatus) return;
        const at = (i) => (i >= 0 && cells[i] ? clean(cells[i].textContent) : "");
        const status = at(iStatus);
        if (!status) return;
        // "2026-04-11 00:00:00.0" — the time half is noise for identity
        const from = at(iFrom).split(" ")[0];
        rows.push({
          key: `${at(iNo)}|${from}`,
          place: at(iPlace),
          purpose: at(iPurpose),
          from,
          to: at(iTo).split(" ")[0],
          status,
          accepted: isAccepted(status),
          // the OutPass link only exists once accepted — see the note above
          hasPass:
            iPass >= 0 && cells[iPass]
              ? cells[iPass].querySelectorAll("a, button").length > 0
              : false,
        });
      });
    return rows.length ? rows : null;
  };

  const notify = (title, body) => {
    try {
      chrome.runtime.sendMessage({ message: "notify_now", title, body }, () => {
        void chrome.runtime.lastError; // worker asleep — nothing to recover
      });
    } catch {
      /* extension context gone */
    }
  };

  const describe = (row) => {
    const where = row.place || "your leave";
    const when = row.from ? ` (${row.from}${row.to && row.to !== row.from ? ` → ${row.to}` : ""})` : "";
    return `${where}${when}`;
  };

  /*
   * Compare against the last snapshot and announce only real transitions.
   * Returns the rows worth telling the student about.
   */
  const newlyAccepted = (previous, current) => {
    const before = {};
    (previous || []).forEach((r) => {
      before[r.key] = r;
    });
    return current.filter((r) => {
      if (!r.accepted) return false;
      const old = before[r.key];
      if (!old) return false; // first sighting — history, not news
      return !old.accepted;
    });
  };

  const remember = async (rows) => {
    const store = await chrome.storage.local.get([SNAPSHOT_KEY]);
    const previous = (store[SNAPSHOT_KEY] || {}).rows || null;
    const fresh = newlyAccepted(previous, rows);
    await chrome.storage.local.set({
      [SNAPSHOT_KEY]: { fetchedAt: Date.now(), rows },
    });
    if (!fresh.length) return fresh;

    /*
     * The LATEST trip, not whichever row VTOP happened to list first — asked
     * 2026-08-23: "only the file of the recent or latest leave approval". If
     * two approvals land together, the one being travelled on next is the one
     * worth naming, and the older is a count rather than a headline. Sorted by
     * From date, which is already normalised to YYYY-MM-DD, so a string sort
     * is a date sort.
     */
    fresh.sort((a, b) => String(b.from).localeCompare(String(a.from)));
    const one = fresh[0];
    const more = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : "";
    notify(
      `Leave approved — ${describe(one)}`,
      one.hasPass
        ? `Your OutPass is ready to download on Hostel → General Outing.${more}`
        : `Approved on VTOP.${more}`
    );
    return fresh;
  };

  /* ---- is the DOM the whole story? ---------------------------------------
   *
   * It is not, and this was shipped wrong for an hour before being caught:
   * *"there are muktiole entries not just 8 check the site properly"*.
   *
   * VTOP renders this table through DataTables with client-side paging. The
   * SERVER sends every row — 28 rows in an 80 KB response, verified — and
   * DataTables then removes all but the current page from the DOM. So reading
   * the live page finds ten rows and believes that is everything, while the
   * student's list is twenty-seven long.
   *
   * The failure would have been silent and specific: an approval landing on
   * page 2 or 3 would never be noticed, and only ever for the students with
   * enough history to paginate — i.e. the ones who travel most.
   *
   * DataTables leaves its own count in the DOM ("Showing 1 to 10 of 27
   * entries"), which is readable from an isolated world without touching the
   * page's jQuery. When it says there is more than we can see, the page read
   * is abandoned for the network one, which returns the complete table.
   */
  const domIsComplete = (table) => {
    const info = document.querySelector(".dataTables_info");
    if (!info) return true; // not a DataTable — the DOM is all there is
    const match = /of\s+([\d,]+)\s+entries/i.exec(clean(info.textContent));
    if (!match) return true;
    const total = parseInt(match[1].replace(/,/g, ""), 10);
    if (!Number.isFinite(total) || total <= 0) return true;
    return table.rows.length - 1 >= total;
  };

  /* ---- on the page itself -------------------------------------------------
   * The cheapest read when the DOM really does hold everything: the student
   * opened the page, so no request has to be made at all. When it does not —
   * see domIsComplete — this escalates rather than reporting a partial table.
   */
  const readFromPage = async () => {
    const table = findLeaveTable(document);
    if (!table) return false;
    if (!domIsComplete(table)) {
      // a deliberate visit, so the rate limit is bypassed: the student is
      // looking at this page precisely because they want to know
      await backgroundCheck({ force: true });
      return true;
    }
    const rows = parseLeaveTable(table);
    if (!rows) return false;
    await remember(rows);
    await chrome.storage.local.set({ [CHECKED_KEY]: Date.now() });
    return true;
  };

  /* ---- from anywhere else -------------------------------------------------
   * Replays the student's OWN recorded request through window.vrVtop, which
   * supplies a live _csrf and carries the circuit breaker. Nothing is guessed:
   * if the worker has not recorded the request yet (the page has never been
   * opened since install), this does nothing at all rather than inventing an
   * endpoint — the same rule the attendance refresh and the venue watcher follow.
   */
  let running = false;
  const backgroundCheck = async (opts) => {
    if (running) return;
    if (!window.vrVtop || typeof window.vrVtop.post !== "function") return;
    running = true;
    try {
      const store = await chrome.storage.local.get([REQUEST_KEY, CHECKED_KEY]);
      const request = store[REQUEST_KEY];
      if (!request || !request.path) return;
      const last = Number(store[CHECKED_KEY]) || 0;
      if (!(opts && opts.force) && Date.now() - last < CHECK_EVERY_MS) return;
      // stamp BEFORE the request: a failure must not free the budget, or a
      // broken session turns every page arrival into another attempt
      await chrome.storage.local.set({ [CHECKED_KEY]: Date.now() });

      const html = await window.vrVtop.post(request.path, request.params || {});
      const doc = new DOMParser().parseFromString(html, "text/html");
      const rows = parseLeaveTable(findLeaveTable(doc));
      if (rows) await remember(rows);
    } catch (error) {
      console.warn("VTOP Extension leave watcher:", error);
    } finally {
      running = false;
    }
  };

  // Exposed for the tests, which drive the comparison directly rather than
  // through a page load.
  window.vrLeaveParse = (root) => parseLeaveTable(findLeaveTable(root || document));
  window.vrLeaveDomComplete = () => {
    const t = findLeaveTable(document);
    return t ? domIsComplete(t) : null;
  };
  window.vrLeaveRemember = remember;
  window.vrLeaveCheck = backgroundCheck;

  chrome.runtime.onMessage.addListener((request) => {
    if (!request) return;
    // The leave page itself just opened — read it directly.
    if (request.message === "leave_page") {
      readFromPage().catch((error) => console.warn("VTOP Extension leave watcher:", error));
      return;
    }
    // Any other arrival on VTOP is a chance to check quietly, rate-limited.
    if (
      request.message === "nav_bar_change" ||
      request.message === "vtop2_nav_bar" ||
      request.message === "view_attendance_page" ||
      request.message === "semester_page_open"
    ) {
      backgroundCheck().catch(() => {});
    }
  });

  // …and once per page without waiting for a message, for the arrivals that
  // are not routed. Costs one storage read when the budget is unspent.
  setTimeout(() => {
    if (findLeaveTable(document)) readFromPage().catch(() => {});
    else backgroundCheck().catch(() => {});
  }, 7000);
})();
