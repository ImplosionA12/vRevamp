/*
 * vrDelegate — the only safe way to give an injected button a click handler on
 * VTOP.
 *
 * Three separate things used to kill our buttons, and all three looked
 * identical to a user ("I click it and nothing happens"):
 *
 * 1. `document.createElement("button")` defaults to **type="submit"**. VTOP
 *    wraps its content sections in forms, so a click on a button we appended
 *    inside one submitted that form: the page re-rendered and the handler's
 *    effect was wiped off screen before anyone could see it. js/vtop_otp.js
 *    already carried the comment "never let it submit the login form" — the
 *    lesson just never reached the buttons added later.
 *
 * 2. Handlers were assigned per element (`btn.onclick = …`). Properties do not
 *    survive an innerHTML round-trip, and this page is nothing but innerHTML
 *    round-trips: VTOP's own AJAX writes `$("#main-section").html(response)`,
 *    and we snapshot/restore the same markup ourselves for the offline viewer.
 *    Every one of those leaves a pixel-perfect clone of the button with no
 *    handler attached.
 *
 * 3. The guards meant to detect (2) and re-inject disagreed with it. A guard
 *    is only correct if it is exactly as durable as the handler it protects.
 *    `id`/`dataset` guards are MORE durable (they serialise), so dead clones
 *    permanently blocked their own repair; a property guard is correct but
 *    needs something to re-run it, and the only trigger was a webRequest
 *    message that fires before VTOP has written the response into the DOM.
 *
 * Delegation dissolves all of it. One capture-phase listener on `document` —
 * a node VTOP never replaces — dispatches on the `data-vr-action` attribute.
 * The attribute serialises, so a restored clone is *already* wired up: there
 * is nothing to re-bind, no race to lose, and no guard to get wrong. Identity
 * and behaviour now travel together.
 *
 * Capture phase, deliberately: it runs before any handler on the way down, so
 * a stray `stopPropagation()` in VTOP's jQuery cannot swallow our own clicks.
 */
(() => {
  if (typeof window.vrDelegate === "function") return;

  const handlers = new Map();

  const log = (...args) => {
    try {
      console.log("[VTOP Extension click]", ...args);
    } catch {
      /* console gone — never let logging break a click */
    }
  };

  /*
   * Which of our buttons did this click mean?
   *
   * Normally the answer is `event.target.closest("[data-vr-action]")`. It is
   * not, however, when VTOP has an overlay up. jQuery BlockUI (which VTOP uses
   * for every AJAX call) covers the viewport with `div.blockUI.blockOverlay` at
   * z-index 1000, and leaves one of them at opacity ~0.001 — completely
   * invisible, fully click-intercepting. The user sees a button, aims at it,
   * and hits the overlay: the event still reaches this listener (we are on
   * `document`), but its target is the overlay, `closest()` finds nothing, and
   * the button looks exactly as dead as it did under the three bugs we already
   * fixed. This is the last way a delegated button can silently do nothing.
   *
   * So when the click landed on one of those overlays, re-aim it: look down the
   * stack at the click point and take the first of our buttons underneath.
   * Deliberately narrow — only a recognised BlockUI overlay gets pierced, never
   * an arbitrary element that happens to sit above a button, and never a click
   * with no coordinates (a keyboard-activated button reports 0,0 and already
   * has the right target).
   *
   * The alternative — lifting our buttons above the overlay with a z-index —
   * was tried in exam_schedule.js and reverted: it also drew them on top of
   * VTOP's own open sidebar menu. Piercing costs nothing visually.
   */
  const isOverlay = (node) =>
    !!node &&
    node.nodeType === 1 &&
    !!node.classList &&
    (node.classList.contains("blockUI") || node.classList.contains("blockOverlay"));

  const target_action = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return null;
    const direct = target.closest("[data-vr-action]");
    if (direct) return direct;
    if (!isOverlay(target)) return null;
    if (typeof document.elementsFromPoint !== "function") return null;
    if (!event.clientX && !event.clientY) return null;
    const under = document
      .elementsFromPoint(event.clientX, event.clientY)
      .map((node) => (node.closest ? node.closest("[data-vr-action]") : null))
      .find(Boolean);
    if (under) log("click was eaten by a VTOP overlay — re-aimed at", under.dataset.vrAction);
    return under || null;
  };

  const dispatch = (event) => {
    const el = target_action(event);
    if (!el) return;
    const handler = handlers.get(el.dataset.vrAction);
    if (!handler) {
      log("no handler registered for", el.dataset.vrAction);
      return;
    }
    // a disabled button is mid-flight (we set .disabled while awaiting) —
    // browsers suppress its own events but not a delegated capture listener
    if (el.disabled) {
      log("ignored — ", el.dataset.vrAction, "is mid-flight (disabled)");
      return;
    }
    // our buttons never mean "submit the VTOP form I happen to sit inside",
    // and never mean "follow the link I was appended next to"
    event.preventDefault();
    // Narration, not noise. These buttons cannot be tested by automation (a
    // synthesised click is dispatched in the page's main world and never
    // reaches an isolated-world handler), so the only account of a real click
    // is the one it writes itself. Console output does cross that boundary, so
    // "nothing happened" can be answered with a log line instead of a guess:
    // no line at all means the click never reached us.
    log("running", el.dataset.vrAction);
    try {
      handler(el, event);
    } catch (error) {
      console.warn("VTOP Extension click:", el.dataset.vrAction, error);
    }
  };

  window.vrDelegate = (action, handler) => {
    if (handlers.size === 0) {
      document.addEventListener("click", dispatch, true);
      log("delegated click listener installed");
    }
    handlers.set(action, handler);
  };

  /*
   * Build a button that is wired up by construction. `action` must match a
   * vrDelegate registration; `data` becomes data-* attributes, which is the
   * only place per-button state may live — a closure would not survive the
   * innerHTML round-trip that the attribute does.
   */
  window.vrButton = (action, label, data) => {
    const button = document.createElement("button");
    button.type = "button"; // never submit the enclosing VTOP form
    // VTOP's own Bootstrap classes and NO colour of our own, so the button
    // takes whatever blue and size the portal defines (2026-10-10: the old
    // hard-coded rgb(73,117,182) was a different blue from VTOP's own buttons).
    button.className = "btn btn-primary btn-sm";
    button.style.margin = "2px 0 2px 6px";
    button.dataset.vrAction = action;
    button.textContent = label;
    Object.entries(data || {}).forEach(([k, v]) => {
      button.dataset[k] = v;
    });
    return button;
  };

  /*
   * The quiet variant, for secondary actions beside a primary one.
   *
   * NOT `btn-outline-primary`: that class exists in Bootstrap 4/5 only. VTOP's
   * login page is Bootstrap 5 but its logged-in pages are an older Bootstrap
   * (the portal's own primary is #337ab7, Bootstrap 3's), where the class does
   * not exist and the button rendered as bare text with no outline at all. It
   * was previewed on the login page, which is why that went unseen. The border
   * and colour are therefore set inline, in the portal's own blue, and work on
   * any Bootstrap (or none).
   */
  window.vrOutline = (button) => {
    button.className = "btn btn-default btn-sm";
    button.style.background = "#fff";
    button.style.color = "#337ab7";
    button.style.border = "1px solid #337ab7";
    return button;
  };

  // Buttons we injected, as they appear in restored markup. Used both to find
  // our own leftovers and to strip them from snapshots shown offline, where
  // no content script runs and nothing could service a click.
  window.vrStripActions = (root) => {
    root
      .querySelectorAll("[data-vr-action], .vtopext-exam-note, .vtopext-tt-note")
      .forEach((el) => el.remove());
    return root;
  };
})();
