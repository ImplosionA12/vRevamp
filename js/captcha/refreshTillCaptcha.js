// Retry a login page that failed to render. Historically "no captcha and no
// #stdForm" meant a broken load, but VTOP's 2026 login page is a role picker
// (Student/Employee/Parent/Alumni) with no captcha until a role is chosen —
// so an unconditional reload here loops forever and the page just flickers.
// Only reload when the body is effectively empty, and at most twice per tab.
(() => {
  const RELOAD_KEY = "vrevamp_login_reloads";
  let store = null;
  try {
    store = window.sessionStorage;
  } catch {
    // sandboxed document: can't count attempts, so never reload
  }
  const captchaImg = document.querySelector("img.form-control");
  const stdForm = document.getElementById("stdForm");
  if (captchaImg !== null || stdForm !== null) {
    if (store) store.removeItem(RELOAD_KEY);
    return;
  }
  const rendered =
    document.body !== null && document.body.innerText.trim().length > 0;
  if (rendered || store === null) return;
  const attempts = Number(store.getItem(RELOAD_KEY)) || 0;
  if (attempts >= 2) return;
  store.setItem(RELOAD_KEY, String(attempts + 1));
  setTimeout(() => window.location.reload(), 500);
})();
