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
  const KEY = "vrevamp_vtop_login";
  const WINDOW_MS = 6000;
  const WAIT_FOR_FORM_MS = 30000;
  const TICK_MS = 250;

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
    const mark = (event) => {
      if (event.isTrusted) typed = true;
    };
    document.addEventListener("keydown", mark, true);
    document.addEventListener("paste", mark, true);

    // The form can arrive after load (VTOP swaps the login step in), so the
    // re-assert window starts when the fields are first seen, not at load.
    const giveUpAt = Date.now() + WAIT_FOR_FORM_MS;
    let deadline = null;
    const apply = () => {
      if (typed) return true; // they took over — leave it alone
      const f = find();
      if (!f) return Date.now() > giveUpAt;
      if (deadline === null) deadline = Date.now() + WINDOW_MS;
      // Ask the browser not to autofill these in the first place
      f.user.setAttribute("autocomplete", "off");
      f.pass.setAttribute("autocomplete", "new-password");
      if (f.user.value !== creds.id) setValue(f.user, creds.id);
      if (f.pass.value !== creds.pass) setValue(f.pass, creds.pass);
      return false;
    };

    const timer = setInterval(() => {
      const stop = apply();
      if (stop || (deadline !== null && Date.now() > deadline)) {
        clearInterval(timer);
        document.removeEventListener("keydown", mark, true);
        document.removeEventListener("paste", mark, true);
      }
    }, TICK_MS);
    apply();
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
