/*
 * Fills the VTOP login form from the ID and password saved in the popup.
 *
 * The point is that the popup's pair WINS over whatever Chrome (or a password
 * manager) wants to put in the same fields. Chrome autofills after the page
 * settles and again when a field is focused, so a single assignment at load is
 * overwritten a moment later. This script therefore re-applies its values for a
 * few seconds, and stops the instant the person types: `isTrusted` is false for
 * every event this script dispatches and true for a real keystroke, which is
 * the whole difference between "Chrome overwrote us" and "they are editing".
 *
 * It fills; it never submits. The captcha and the sign-in press stay theirs.
 */
(() => {
  const KEY = "vtopext_vtop_login";
  // Used to be 6 s. Chrome's password manager can also fill when a field is
  // clicked or focused, long after 6 s, and by then this script had stopped —
  // so Google's saved pair won whenever the student took a moment. Keep
  // guarding for minutes, and only stand down for real typing in these fields.
  const WINDOW_MS = 5 * 60 * 1000;
  const WAIT_FOR_FORM_MS = 30000;
  const TICK_MS = 250;
  const SHIELD_MS = 400;

  const find = () => {
    const user = document.querySelector("#vtopLoginForm input[name='username']");
    const pass = document.querySelector("#vtopLoginForm input[name='password']");
    return user && pass ? { user, pass } : null;
  };

  // Real assignment through the native setter, so frameworks that track the
  // value (and VTOP's own listeners) see a change rather than a no-op.
  const setValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const start = (creds) => {
    let typed = false;
    // Only a real edit of the ID/password counts. A keystroke ANYWHERE (Tab,
    // typing the captcha) used to hand control back to Chrome's autofill.
    const NAVIGATION = /^(Tab|Shift|Control|Alt|Meta|CapsLock|Escape|Enter)$/;
    const mark = (event) => {
      if (!event.isTrusted) return;
      const f = find();
      if (!f || (event.target !== f.user && event.target !== f.pass)) return;
      if (event.type === "keydown" && NAVIGATION.test(event.key)) return;
      typed = true;
    };
    document.addEventListener("keydown", mark, true);
    document.addEventListener("paste", mark, true);

    // The form can arrive after load (VTOP swaps the login step in), so the
    // re-assert window starts when the fields are first seen, not at load.
    const giveUpAt = Date.now() + WAIT_FOR_FORM_MS;
    let deadline = null;
    let shielded = false;
    const apply = () => {
      if (typed) return true; // they took over — leave it alone
      const f = find();
      if (!f) return Date.now() > giveUpAt;
      if (deadline === null) deadline = Date.now() + WINDOW_MS;
      // Chrome's password manager does not fill a read-only field. Hold both
      // fields read-only for the moment its load-time fill happens, put our pair
      // in, then release them. Before this, Chrome filled first and the blue
      // "autofilled" look stayed even where our value had been written over it.
      if (!shielded) {
        shielded = true;
        f.user.readOnly = true;
        f.pass.readOnly = true;
        setTimeout(() => {
          f.user.readOnly = false;
          f.pass.readOnly = false;
        }, SHIELD_MS);
      }
      // Ask the browser not to autofill these in the first place
      f.user.setAttribute("autocomplete", "off");
      f.pass.setAttribute("autocomplete", "new-password");
      if (f.user.value !== creds.id) setValue(f.user, creds.id);
      if (f.pass.value !== creds.pass) setValue(f.pass, creds.pass);
      return false;
    };

    // Chrome's password manager also fills when a field is clicked or focused.
    // Answer each focus right away and again shortly after, so the saved pair
    // is back before the person has time to see the other one.
    const onFocus = (event) => {
      const f = find();
      if (!f || (event.target !== f.user && event.target !== f.pass)) return;
      [40, 300, 900].forEach((ms) => setTimeout(apply, ms));
    };
    document.addEventListener("focusin", onFocus, true);

    const timer = setInterval(() => {
      const stop = apply();
      if (stop || (deadline !== null && Date.now() > deadline)) {
        clearInterval(timer);
        document.removeEventListener("keydown", mark, true);
        document.removeEventListener("paste", mark, true);
        document.removeEventListener("focusin", onFocus, true);
      }
    }, TICK_MS);
    apply();
    // Don't wait for the next tick when the form is swapped in: act the moment
    // it exists, which is before Chrome's own fill gets a chance.
    const watcher = new MutationObserver(() => {
      if (find()) {
        apply();
        watcher.disconnect();
      }
    });
    if (!find()) watcher.observe(document.documentElement, { childList: true, subtree: true });
  };

  try {
    chrome.storage.local.get(KEY, (stored) => {
      const creds = stored && stored[KEY];
      if (creds && creds.id && creds.pass) start(creds);
    });
  } catch {
    /* no storage: nothing to fill */
  }
})();
