/*
 * Make sure the login page HAS a captcha — without ever navigating.
 *
 * ---------------------------------------------------------------------------
 * THE COMPLAINT THIS FIXES, 2026-08-17
 * ---------------------------------------------------------------------------
 * "i asked you to reload this part till you get a captcha but you keep doing
 *  the complete homepage where i have to choose student, parent or smth"
 *
 * Both halves of that were true, and they had different causes.
 *
 * 1. It did not reload at all. The old rule was "reload when a VISIBLE #stdForm
 *    has no captcha". Checked live: /vtop/login does not contain #stdForm — it
 *    lives on /vtop/open/page, the role picker, and holds the four
 *    Student/Employee/Parent/Alumni forms. So the condition was false on the
 *    only page this script runs on, and a captcha-less login form sat there
 *    broken forever.
 *
 * 2. Reloading was the wrong instrument anyway. /vtop/login is reached by
 *    POSTing the role picker's #stdForm to /vtop/prelogin/setup. Re-issuing
 *    that navigation is what drops the student back on the role picker with the
 *    Student/Parent buttons — the exact behaviour being complained about. A
 *    reload can never be the fix here, however carefully it is guarded.
 *
 * VTOP already solves this itself. Its own refresh button (the green ⟳ beside
 * the captcha) calls loadCaptcha(), which is:
 *
 *     GET /vtop/get/new/captcha  ->  innerHTML of #captchaBlock
 *
 * Verified live 2026-08-17: 200, ~5 KB, an <img class="form-control …"> with a
 * fresh base64 JPEG plus the refresh button. No _csrf, no POST, no navigation,
 * no session cost — which also settles the "don't drive VTOP's internal
 * endpoints" rule (ROADMAP #4): that rule is about replaying authenticated
 * endpoints with a scraped token on a live session. This is an unauthenticated
 * GET the page itself performs, before any session exists.
 *
 * So: swap the captcha block, never the page. Retried a few times, spaced out,
 * and it gives up quietly rather than strobing.
 *
 * The one surviving reload is for a genuinely empty document — a dead load with
 * no form and no text, where there is nothing to refresh in place.
 */
(() => {
  const RELOAD_KEY = "vrevamp_login_reloads";
  const MAX_RELOADS = 3;
  const MAX_CAPTCHA_FETCHES = 6;
  const RETRY_MS = 1200;

  let store = null;
  try {
    store = window.sessionStorage;
  } catch {
    // sandboxed document: can't count attempts, so never act
  }

  const captchaBlock = () => document.getElementById("captchaBlock");

  // A captcha is "there" only when it is an image with actual pixels behind it.
  // VTOP serves the block with an empty <img> when its generator hiccups, and
  // that renders as the blank gap the student sees.
  const haveCaptcha = () => {
    const block = captchaBlock();
    if (!block) return false;
    const img = block.querySelector("img");
    return !!img && /^data:image\//.test(img.getAttribute("src") || "");
  };

  // Announced so captchaparser.js can re-solve the new image. Same extension,
  // same isolated world, so a plain CustomEvent on document is enough and
  // nothing in the page can see it.
  const announce = () => {
    document.dispatchEvent(new CustomEvent("vrevamp:captcha-changed"));
  };

  const fetchNewCaptcha = async () => {
    const block = captchaBlock();
    if (!block) return false;
    try {
      const res = await fetch("/vtop/get/new/captcha", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) return false;
      const html = await res.text();
      // Parse before touching the DOM: a 200 carrying an error page must not
      // wipe a block that still had a usable image in it.
      const doc = new DOMParser().parseFromString(html, "text/html");
      const img = doc.querySelector("img");
      if (!img || !/^data:image\//.test(img.getAttribute("src") || "")) return false;
      block.innerHTML = html;
      const field = document.getElementById("captchaStr");
      if (field) field.value = "";
      announce();
      return true;
    } catch {
      return false; // offline or blocked — leave the page alone
    }
  };

  const ensureCaptcha = async () => {
    for (let i = 0; i < MAX_CAPTCHA_FETCHES; i++) {
      if (haveCaptcha()) return true;
      if (await fetchNewCaptcha()) return true;
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
    return haveCaptcha();
  };

  // The OTP step legitimately has no captcha, and VTOP has already mailed a
  // code by then. Nothing on this page may be refreshed or reloaded.
  const otpStep = () => {
    const text = document.body ? document.body.innerText : "";
    return (
      /one[\s-]*time\s*password|\bOTP\b/i.test(text) ||
      document.querySelector(
        "input[id*='otp' i], input[name*='otp' i], input[placeholder*='otp' i]"
      ) !== null
    );
  };

  const run = () => {
    if (otpStep()) return;

    // reCAPTCHA variant of the login page: complete as rendered, nothing to
    // fetch. (VIT-AP flips between this and the image captcha — see ROADMAP.)
    if (document.querySelector("input[name='gResponse'], input#gResponse")) {
      if (store) store.removeItem(RELOAD_KEY);
      return;
    }

    if (captchaBlock()) {
      if (store) store.removeItem(RELOAD_KEY);
      if (!haveCaptcha()) ensureCaptcha();
      return;
    }

    /*
     * A LOGIN FORM WITH NO CAPTCHA OF EITHER KIND — reported 2026-08-19 with a
     * screenshot: /vtop/login, username and password filled, Submit there, and
     * no captcha anywhere. "the normal original extension reloads this page
     * until the captcha appears and u cant do it for some reason".
     *
     * True, and this is the branch that let it through. The old rule reloaded
     * only for a document with no form AND no text; here the page is fully
     * rendered and the form is right there, so `rendered` was true and run()
     * returned having done nothing. ensureCaptcha() could not help either —
     * fetchNewCaptcha() injects INTO #captchaBlock, and on this page shape
     * there is no block to inject into.
     *
     * So the one instrument left is the one upstream used: reload, capped. The
     * file's argument against reloading (see the header) is about /vtop/login
     * reached by POSTing the role picker, where a reload re-issues that
     * navigation and lands on Student/Employee/Parent/Alumni. That argument
     * holds for the role-picker path and is why this is last, not first — it
     * runs only when there is a login form present, no block to heal, and
     * neither captcha variant on the page. MAX_RELOADS still caps it at three,
     * so the worst case is three loads and then a page that is left alone.
     */
    const rendered = document.body ? document.body.innerText.trim().length > 0 : false;
    const haveForm = !!document.getElementById("vtopLoginForm");
    if (store === null) return;
    if (rendered && !haveForm) return; // a rendered page that is not the login form

    const attempts = Number(store.getItem(RELOAD_KEY)) || 0;
    if (attempts >= MAX_RELOADS) return;
    store.setItem(RELOAD_KEY, String(attempts + 1));
    setTimeout(() => window.location.reload(), 500);
  };

  run();

  // VTOP re-renders #captchaBlock on its own refresh button and after a failed
  // submit. Watch for a block that comes back empty and heal it too — that is
  // the "wrong captcha, try again" path, where a student is most likely to be
  // staring at a blank box.
  const attach = () => {
    const block = captchaBlock();
    if (!block) return false;
    let pending = false;
    new MutationObserver(() => {
      if (pending || haveCaptcha()) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        ensureCaptcha();
      }, 400);
    }).observe(block, { childList: true, subtree: true });
    return true;
  };

  /*
   * WAIT FOR THE BLOCK, DON'T GIVE UP ON IT — found live 2026-08-17.
   *
   * `attach()` used to be called once and return silently when #captchaBlock
   * was absent, which is a permanent decision made from one instant. Checked
   * against the real portal that morning: /vtop/login can serve the four-role
   * landing page (Student/Employee/Parent/Alumni), and the login form arrives
   * only after Student is pressed — at the SAME URL. Whatever ran at document
   * load ran against the landing page, found no block, and never looked again,
   * so on the image-captcha variant neither the healing here nor the solver in
   * captchaparser.js would ever attach on the path a student actually takes.
   *
   * A capped poll, not an observer on body. The 2026-08-07 "Page Unresponsive"
   * freeze was a MutationObserver storm on VTOP's SPA container, and this file
   * is loaded on the login page where a wedged main thread means nobody can
   * sign in at all. Twenty ticks at 400 ms is eight seconds and then it is
   * over, whatever happened.
   *
   * It also stops early on the reCAPTCHA variant — which is what the live page
   * was serving that day — because there no block is ever coming.
   */
  const waitForBlock = () => {
    if (attach()) return;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
      const recaptcha = !!document.querySelector(
        "input[name='gResponse'], input#gResponse, .g-recaptcha"
      );
      if (recaptcha || attach() || ticks >= 20) {
        clearInterval(timer);
        // a block that appeared after load has never been through run()
        if (!recaptcha && captchaBlock() && !haveCaptcha()) ensureCaptcha();
      }
    }, 400);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      run();
      waitForBlock();
    });
  } else {
    waitForBlock();
  }
})();
