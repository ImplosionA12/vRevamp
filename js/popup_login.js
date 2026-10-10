/*
 * "VTOP sign-in" in the popup: the ID and password that js/login_fill.js types
 * into the login form, instead of whatever Chrome has saved.
 *
 * Stored in chrome.storage.local on this computer, unencrypted — the same place
 * the hostel Wi-Fi credentials already live. The password is never shown back:
 * once saved the field only says that one is stored.
 */
(() => {
  const KEY = "vrevamp_vtop_login";
  const $ = (id) => document.getElementById(id);
  const idBox = $("vr-login-id");
  const passBox = $("vr-login-pass");
  const status = $("vr-login-status");
  if (!idBox || !passBox) return;

  const say = (text, bad) => {
    if (!status) return;
    status.textContent = text;
    status.style.color = bad ? "#b3261e" : "";
  };

  const show = (creds) => {
    idBox.value = (creds && creds.id) || "";
    passBox.value = "";
    passBox.placeholder = creds && creds.pass ? "saved — type to replace" : "password";
  };

  chrome.storage.local.get(KEY, (stored) => show(stored && stored[KEY]));

  $("vr-login-save").addEventListener("click", () => {
    const id = idBox.value.trim();
    const typedPass = passBox.value;
    chrome.storage.local.get(KEY, (stored) => {
      const old = (stored && stored[KEY]) || {};
      const pass = typedPass || old.pass || "";
      if (!id || !pass) {
        say("Enter both your ID and password.", true);
        return;
      }
      chrome.storage.local.set({ [KEY]: { id, pass } }, () => {
        show({ id, pass });
        say("Saved. The VTOP login page will be filled with these.");
      });
    });
  });

  $("vr-login-clear").addEventListener("click", () => {
    chrome.storage.local.remove(KEY, () => {
      show(null);
      say("Removed.");
    });
  });
})();
