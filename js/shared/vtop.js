/*
 * One place that talks to VTOP's own AJAX endpoints, with a circuit breaker.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS — "make sure the vtop doesnt get logged out"
 * ---------------------------------------------------------------------------
 * Two features replay VTOP's internal POSTs: the DA page asks
 * examinations/processDigitalAssignment once per course, and the attendance
 * insights ask the attendance-detail endpoint once per subject. Both used to
 * do it as a burst of requests on page load, each with its own copy of the
 * scraped `_csrf`, each swallowing its own failures.
 *
 * That is the exact shape the ROADMAP warns about ("don't drive VTOP's
 * internal endpoints with a scraped _csrf — it returns 404s and logs the user
 * out"), and it fails in the worst possible way: silently. When the token or
 * the session is stale, every request 404s, every cell renders "--", and the
 * extension keeps firing eight more on the next page view. The student sees a
 * broken table and, a few navigations later, a dead session.
 *
 * So this module adds the three things those call sites were each missing:
 *
 *   1. ONE token source, picked properly. `querySelector("input[name=_csrf]")`
 *      takes the first match, which on some VTOP fragments is an empty
 *      placeholder; this takes the first NON-EMPTY one. Same for the student
 *      id: #authorizedIDX when present, the navbar text when not.
 *   2. A CIRCUIT BREAKER. Consecutive 401/403/404s trip it, and once tripped
 *      nothing else is sent for the rest of the page. Repeated failed POSTs
 *      are what damages a session, so the response to failure must be to stop,
 *      not to try the other seven.
 *   3. A VISIBLE reason. When it trips, the student is told the session looks
 *      stale and that a fresh sign-in fixes it — instead of reading "--" and
 *      concluding the extension is broken.
 *
 * Not a retry layer on purpose. A 404 here means "VTOP will not answer this",
 * and retrying it is the damaging action, not the recovery.
 */
(() => {
  if (window.vrVtop) return;

  const TRIP_AFTER = 3; // consecutive hard failures before we stop entirely
  const BANNER_ID = "vrevamp-session-banner";

  /*
   * PROBES vs REAL REQUESTS — the distinction the breaker lives or dies on.
   *
   * attendance_insights.js does not know which endpoint this VTOP deployment
   * uses for per-subject history, so it tries a list until one answers. Most
   * of those 404 on any given deployment, every time, on a perfectly healthy
   * session. Counting them would trip the breaker on the first subject of
   * every page load and make the feature permanently dead.
   *
   * So a guess is declared as `{ probe: true }` and judged differently:
   *   - a NON-probe failure means something we believed would work did not.
   *     Three in a row and we stop.
   *   - probe failures are expected, and only mean something in bulk WITH
   *     nothing ever having succeeded — which is the signature of a session
   *     that is refusing everything, not of a deployment we guessed wrong
   *     about. One success anywhere clears that suspicion for good.
   */
  const PROBE_TRIP_AFTER = 12;

  // A request that never answers used to leave "reading…" on screen forever.
  // A timeout is VTOP having a bad minute, not a refused session, so it does
  // not count toward the breaker.
  const REQUEST_TIMEOUT_MS = 25000;

  const state = {
    consecutiveFailures: 0,
    probeFailures: 0,
    successes: 0,
    tripped: false,
    lastStatus: 0,
  };

  const csrf = () => {
    // first NON-EMPTY token: VTOP ships empty _csrf placeholders on some
    // fragments, and picking one of those 404s every request that uses it
    for (const el of document.querySelectorAll("input[name='_csrf']")) {
      const v = el.value || el.defaultValue;
      if (v && v.trim()) return v.trim();
    }
    return null;
  };

  const authorizedID = () => {
    const hidden = document.querySelector("#authorizedIDX, input[name='authorizedID']");
    if (hidden && (hidden.value || "").trim()) return hidden.value.trim();
    const nav =
      document.querySelector(".navbar-text.text-light.small.fw-bold") ||
      document.getElementsByClassName("VTopHeaderStyle")[0];
    if (!nav) return null;
    const text = (nav.innerText || "").replace(/\(STUDENT\)/i, "").trim();
    return text || null;
  };

  /*
   * The one stale-session banner. Deliberately ONE, keyed on BANNER_ID: two
   * things can now conclude the session is gone — this breaker, from the
   * requests vRevamp itself sends, and js/session_repair.js, from the 404s
   * VTOP's own menu clicks get (the service worker sees those; no content
   * script can). Both routes describe the same broken session, so the second
   * one to arrive must not stack a second red bar on top of the first.
   *
   * `action` is optional: { label, run }. It exists because the old banner
   * said "sign out and sign in again" and then left the student to find their
   * own way there — which is a dead end precisely when it matters, since a
   * poisoned cookie makes /vtop/login answer 404 too. A button that clears the
   * cookies first is the recovery, so the advice should be clickable.
   */
  const showBanner = (text, action) => {
    if (document.getElementById(BANNER_ID)) return null;
    const bar = document.createElement("div");
    bar.id = BANNER_ID;
    bar.style.cssText =
      "margin:10px 0;padding:8px 12px;border-radius:4px;font-size:13px;" +
      "background:#fdecea;color:#8a1c12;border:1px solid #f5c6c0;";
    const line = document.createElement("span");
    line.textContent = text;
    bar.appendChild(line);
    if (action && action.label && typeof window.vrDelegate === "function") {
      // registered per call: the handler is a closure, and only the
      // data-vr-action attribute has to survive an innerHTML round-trip
      window.vrDelegate("session-recover", action.run);
      bar.appendChild(window.vrButton("session-recover", action.label));
    }
    const anchor =
      document.querySelector(".table-responsive") ||
      document.querySelector("#vtopMainDiv") ||
      document.body;
    if (anchor === document.body) anchor.insertAdjacentElement("afterbegin", bar);
    else anchor.insertAdjacentElement("beforebegin", bar);
    return bar;
  };

  // `count` is however many refusals actually did it — the probe route trips
  // on PROBE_TRIP_AFTER, not TRIP_AFTER, and a banner that names the wrong
  // number is a banner nobody can check against the network tab.
  const trip = (status, count) => {
    state.tripped = true;
    state.lastStatus = status;
    showBanner(
      `vRevamp stopped talking to VTOP: it refused ${count} requests in a row ` +
        `(HTTP ${status}). That usually means the ` +
        "session has gone stale. Sign out of VTOP and sign in again — vRevamp " +
        "deliberately sends nothing more until then, because repeating failed " +
        "requests is what breaks the session further."
    );
  };

  /*
   * POST to `vtop/<path>`. Resolves the response text, or throws.
   *
   * `hard` failures (401/403/404) count toward the breaker; a 5xx or a network
   * blip does not, because those are VTOP having a bad minute rather than this
   * session being unwelcome.
   */
  const post = async (path, params, options) => {
    const probe = !!(options && options.probe);
    if (state.tripped) throw new Error(`vtop-session-stale (${state.lastStatus})`);
    const token = csrf();
    const id = authorizedID();
    if (!token || !id) throw new Error("missing _csrf/authorizedID");

    const body = new URLSearchParams({
      _csrf: token,
      authorizedID: id,
      x: new Date().toUTCString(),
      ...(params || {}),
    });

    let res;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      res = await fetch(`${location.origin}/vtop/${path}`, {
        signal: abort.signal,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: body.toString(),
        credentials: "same-origin",
      });
    } catch (error) {
      if (error && error.name === "AbortError")
        throw new Error(`network: ${path} timed out`);
      throw new Error(`network: ${String((error && error.message) || error)}`);
    } finally {
      clearTimeout(timer);
    }

    const countFailure = (status) => {
      if (probe) {
        state.probeFailures++;
        if (state.probeFailures >= PROBE_TRIP_AFTER && state.successes === 0)
          trip(status, state.probeFailures);
        return;
      }
      state.consecutiveFailures++;
      if (state.consecutiveFailures >= TRIP_AFTER) trip(status, state.consecutiveFailures);
    };

    if (res.status === 401 || res.status === 403 || res.status === 404) {
      countFailure(res.status);
      throw new Error(`VTOP refused ${path} (${res.status})`);
    }
    if (!res.ok) throw new Error(`VTOP request failed: ${path} (${res.status})`);

    const text = await res.text();
    // A 200 carrying VTOP's session-expired page is a failure wearing a
    // success code — count it, or the breaker never trips on the state that
    // actually happens (see ROADMAP: "shell healthy, content POSTs 404").
    if (/session\s*(has\s*)?expired|please\s*login\s*again/i.test(text.slice(0, 2000))) {
      countFailure(200);
      throw new Error(`VTOP session expired on ${path}`);
    }

    state.consecutiveFailures = 0;
    state.successes++;
    return text;
  };

  /*
   * Run `jobs` with bounded concurrency.
   *
   * The DA page used to await one course at a time, so eight courses meant
   * eight serial round-trips and a column that read "…" for several seconds.
   * Firing all eight at once is the other extreme and is exactly the burst
   * that upsets VTOP. Three at a time is the compromise, and it stops early
   * once the breaker trips rather than queueing work that cannot succeed.
   */
  const pool = async (items, limit, worker) => {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length || state.tripped) return;
        try {
          results[i] = await worker(items[i], i);
        } catch (error) {
          results[i] = { error };
        }
      }
    });
    await Promise.all(runners);
    return results;
  };

  window.vrVtop = {
    csrf,
    authorizedID,
    post,
    pool,
    banner: showBanner,
    get tripped() {
      return state.tripped;
    },
    parse: (html) => new DOMParser().parseFromString(html, "text/html"),
  };
})();
