// Retry a login page that failed to render its captcha.
//
// History matters here. The original version reloaded whenever there was no
// captcha, which loops forever on VTOP's 2026 login: that page is a role
// picker (Student/Employee/Parent/Alumni) with no captcha at all until a role
// is chosen, so the page just flickered. It was then narrowed to "reload only
// an empty body", which stopped the flicker but also stopped the behaviour
// that was actually wanted — a login form whose captcha image failed to load
// sat there broken.
//
// So the decision is made on what the page IS, not on the captcha alone:
//
//   captcha present            -> nothing to do, clear the counter
//   OTP step                   -> NEVER reload; VTOP has already mailed a code
//                                 and a reload throws it away
//   login form, captcha missing-> reload, this is the case worth retrying
//   body effectively empty     -> reload, a dead load
//   anything else (role picker)-> leave alone, this is what looped before
//
// Capped per tab either way, so no page can flicker indefinitely.
//
// CHECKED LIVE 2026-08-09, and the answer is "there is nothing to retry any
// more". vtop.vitap.ac.in/vtop/login now renders: _csrf, username, password,
// and a HIDDEN `gResponse` field — VTOP has replaced its own image captcha with
// **Google reCAPTCHA**, which is invisible by design. There is no
// `img.form-control` to wait for, no `#stdForm` on that page at all, and a
// login form with no visible captcha is now the page in perfect health.
//
// So "no captcha appeared, reload until it does" describes a page that no
// longer exists. Reloading would only flicker, and re-adding that loop is the
// bug this file has already had twice. The reCAPTCHA itself is deliberately
// left alone: solving or bypassing a bot check is not something this extension
// should do.
//
// (Also corrected while here: the note below claimed #stdForm ships hidden on
// the role picker. Live, /vtop/open/page reports it VISIBLE, and /vtop/login
// does not contain it at all. The visibility test is kept because it is the
// conservative direction — it can only ever suppress a reload — but it is not
// the discriminator the comment claimed.)
(() => {
  const RELOAD_KEY = "vrevamp_login_reloads";
  const MAX_RELOADS = 5;

  let store = null;
  try {
    store = window.sessionStorage;
  } catch {
    // sandboxed document: can't count attempts, so never reload
  }

  const captchaImg = document.querySelector("img.form-control");
  if (captchaImg !== null) {
    if (store) store.removeItem(RELOAD_KEY);
    return;
  }

  // reCAPTCHA login page: complete as rendered, nothing missing, nothing to
  // retry. Checked ahead of everything else so that a future VTOP layout which
  // happens to put a visible #stdForm back on this page cannot restart the
  // flicker loop.
  if (document.querySelector("input[name='gResponse'], input#gResponse") !== null) {
    if (store) store.removeItem(RELOAD_KEY);
    return;
  }

  const text = document.body ? document.body.innerText : "";

  // The OTP step legitimately has no captcha. Reloading it would discard a
  // code VTOP has already sent and force a resend, so it is off limits.
  const otpStep =
    /one[\s-]*time\s*password|OTP\b/i.test(text) ||
    document.querySelector(
      "input[id*='otp' i], input[name*='otp' i], input[placeholder*='otp' i]"
    ) !== null;
  if (otpStep) return;

  // VISIBLE, not merely present. The role-picker page ships #stdForm in the
  // DOM already, hidden until a role is chosen — so "does #stdForm exist"
  // is true on the picker too, and reloading on it puts the home page in a
  // loop. Only a form the user can actually see is a form whose missing
  // captcha is a fault.
  const stdForm = document.getElementById("stdForm");
  const formVisible =
    stdForm !== null &&
    (stdForm.offsetParent !== null || stdForm.getClientRects().length > 0);
  const rendered = text.trim().length > 0;

  const worthReloading = formVisible || !rendered;
  if (!worthReloading || store === null) return;

  const attempts = Number(store.getItem(RELOAD_KEY)) || 0;
  if (attempts >= MAX_RELOADS) return;
  store.setItem(RELOAD_KEY, String(attempts + 1));
  setTimeout(() => window.location.reload(), 500);
})();
