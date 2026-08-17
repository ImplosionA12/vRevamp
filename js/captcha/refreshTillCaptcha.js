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

    // No captcha block and no form: a dead load. This is the only case a
    // reload can help with, and it is capped so it can never become a loop.
    const rendered = document.body ? document.body.innerText.trim().length > 0 : false;
    const haveForm = !!document.getElementById("vtopLoginForm");
    if (rendered || haveForm || store === null) return;

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
  const watch = () => {
    const block = captchaBlock();
    if (!block) return;
    let pending = false;
    new MutationObserver(() => {
      if (pending || haveCaptcha()) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        ensureCaptcha();
      }, 400);
    }).observe(block, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      run();
      watch();
    });
  } else {
    watch();
  }
})();
