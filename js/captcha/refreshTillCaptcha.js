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
 *
 * ---------------------------------------------------------------------------
 * 2026-08-19: A LOGIN FORM WITH NO CAPTCHA OF EITHER KIND — still open
 * ---------------------------------------------------------------------------
 * Reported with a screenshot: /vtop/login, username and password filled,
 * Submit there, and no captcha anywhere. Nothing here acts on that shape —
 * `run()` reaches the reload branch, finds the page rendered, and returns.
 *
 * A capped reload was tried for it and REVERTED the same day, because it is
 * provably the wrong instrument. Measured, not assumed — an unauthenticated
 * `GET /vtop/login` returns **the role picker** (`#stdForm`, four
 * Student/Employee/Parent/Alumni forms, no captcha of any kind, 23 KB). The
 * username/password form is what `POST /vtop/prelogin/setup` (`_csrf` +
 * `flag=VTOP`) answers with, at that same URL. So reloading from the login
 * form lands the student back on the role picker — precisely the complaint
 * this file was written to fix ("you keep doing the complete homepage where i
 * have to choose student, parent or smth").
 *
 * ---------------------------------------------------------------------------
 * ANSWERED 2026-08-20, by reading the real DOM while it was on screen
 * ---------------------------------------------------------------------------
 * That question — hidden `gResponse`, or a broken render of the image variant?
 * — is settled. It is **invisible reCAPTCHA**: `gResponse` present,
 * `.grecaptcha-badge` present, `window.grecaptcha` loaded, one `[data-sitekey]`,
 * `#captchaBlock` absent, `#captchaStr` absent, and `document.images.length`
 * of 1 (the VIT-AP logo). The login form's fields, in full, are `_csrf,
 * username, password, basic-addon2, g-recaptcha-response, gResponse,
 * submitBtn` — there is no captcha input on the page at all.
 *
 * So a login page with a blank space where the captcha used to be is what VTOP
 * MEANT to render. That much still holds, and the DOM readings above are all
 * still true today (re-read 2026-08-22: gResponse present, badge present,
 * images 1, no captchaStr).
 *
 * ---------------------------------------------------------------------------
 * OVERTURNED 2026-08-22 — rendering correctly is not the same as working
 * ---------------------------------------------------------------------------
 * *"the captch should be visible and we need to reload once or twice to get
 * it, there is no invisible captcha or google capthca working here okay?
 * without the captcha we cant login no matter how many times i click submit"*.
 *
 * The DOM reading was right and the conclusion drawn from it was wrong. What
 * the page renders and what the SERVER will accept are different questions,
 * and only one of them is visible in the DOM. On VIT-AP the invisible
 * reCAPTCHA variant does not authenticate: submit does nothing, however many
 * times it is pressed. The only way through is to reload until VTOP serves the
 * IMAGE captcha instead — which it does, usually within a reload or two, and
 * commit bd32fb8 already recorded it flipping type twice inside one hour.
 *
 * So the `gResponse` branch below no longer stands down. It reloads, on the
 * same capped budget as everything else here, and hands over to the image
 * branch the moment #captchaBlock appears. A stand-down that leaves the
 * student on a page they cannot log in from is not a safe default; it is the
 * bug, wearing the costume of one.
 *
 * The cap is what keeps this honest: if VIT-AP ever serves reCAPTCHA that DOES
 * work, this spends MAX_RELOADS and then leaves the page alone forever.
 *
 * ---------------------------------------------------------------------------
 * THE PART THAT WAS ACTUALLY MISSING: what happens AFTER a recovery
 * ---------------------------------------------------------------------------
 * Reported 2026-08-20: *"the previous reloaded the homepage not this page"*.
 * True, and it is the reason the capped reload was reverted on 2026-08-19
 * rather than fixed. `/vtop/login` is **reached by POSTing the role picker**,
 * so re-GETting it can land the student back on the Student/Employee/Parent
 * chooser — which is the original complaint, not a recovery.
 *
 * The answer is not a better reload. It is the step that was missing after it:
 * **press Student**. Read live off `/vtop/open/page` on 2026-08-20:
 *
 *   #stdForm     POST /vtop/prelogin/setup   _csrf + flag=VTOP   "Student"
 *   #empForm     POST /vtop/prelogin/setup   _csrf + flag=VTOP   "Employee"
 *   #parentForm  POST /vtop/prelogin/setup   _csrf + flag=parent "Parent"
 *
 * Two things follow from that table, and both matter:
 *
 *  1. **Nothing is reconstructed.** The page's own `#stdForm` is submitted,
 *     carrying its own `_csrf`. This is the sanctioned pattern — the same one
 *     js/attendance.js uses when it clicks VTOP's own menu entry — and not
 *     rule 4, which is about replaying *authenticated* endpoints with a
 *     scraped token. There is no session here to damage: this runs signed out,
 *     and `/vtop/prelogin/setup` is what the button in front of the student
 *     posts to anyway.
 *  2. **Student and Employee send byte-identical bodies.** Same action, same
 *     `flag=VTOP`, submit inputs with no name and no value, no `onsubmit` on
 *     either. So this cannot pick the wrong role by accident — the role is not
 *     in the request at all, and is settled later by the credentials.
 *
 * Guarded twice over. `vtopext_login_reloads` is shared with the reload cap, so
 * a picker that keeps coming back can never ping-pong; and a SECOND arrival at
 * the picker in the same tab is left alone (`vtopext_role_autopick`), because
 * somebody who navigates back to the chooser after being advanced past it is
 * asking for Employee or Parent, and must be able to get there.
 *
 * Do not "fix" any of this from a screenshot. That is ROADMAP rule 1, and this
 * note exists because it was nearly broken twice in one day.
 */
(() => {
  const RELOAD_KEY = "vtopext_login_reloads";
  /*
   * A breadcrumb, not a gate: the timestamp of the last auto-advance in this
   * tab, so "did it run?" can be answered from the console without guessing.
   *
   * It USED to be the escape hatch, on a two-minute cooldown, and that was
   * wrong — see cameFromLogin() below. Reported 2026-08-20: "it didnt reload
   * even". The feature was working; the cooldown meant that anyone who went
   * back to check it hit the one path where it deliberately does nothing, and
   * then hit it again on every retry. A guard whose failure mode is "looks
   * broken precisely when you test it" is the wrong guard.
   */
  const ROLE_KEY = "vtopext_role_autopick";
  /*
   * One budget for every action in this file — the captcha-hunt reload, the
   * dead-load reload, and the chooser's Student press — so no two of them can
   * ever ping-pong: whatever the sequence, a tab gets MAX_RELOADS actions and
   * then stops for good.
   *
   * Raised 3 -> 5 on 2026-08-22, when the reCAPTCHA branch started drawing on
   * it too. A captcha hunt costs one per attempt and lands on the chooser
   * often enough that a Student press costs another, so 3 could be spent
   * before the image captcha ever appeared — and "we need to reload once or
   * twice to get it" has to fit inside the budget with room to spare, or the
   * feature stops just short of working.
   */
  const MAX_RELOADS = 5;
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
    document.dispatchEvent(new CustomEvent("vtopext:captcha-changed"));
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

  /*
   * The role chooser: Student / Employee / Parent / Alumni, each a form of its
   * own POSTing to /vtop/prelogin/setup. Identified by markup rather than by
   * URL, because it is served at BOTH /vtop/open/page and /vtop/login
   * depending on cookie state — which is exactly why a reload from the login
   * form could land on it.
   *
   * `#vtopLoginForm` absent is the half that keeps this off the login page
   * itself: /vtop/login ships a hidden #stdForm too, and a first cut of the
   * 2026-08-07 reload rule put the home page into a loop by not checking.
   * Visibility is checked for the same reason.
   */
  /*
   * THE ESCAPE HATCH, and the whole of it.
   *
   * Someone on the chooser needs to be left alone in exactly one situation:
   * they were on the login form and came back here on purpose — by pressing
   * Back, or by the "Go to Home Page" link the login card carries — because
   * they want Employee, Parent or Alumni. Advancing them again would take
   * those pages away from them entirely.
   *
   * Both of those routes are visible, and neither is a clock:
   *
   *   Back / Forward   navigation type "back_forward"
   *   the Home link    document.referrer is the login page
   *
   * Everything else — opening VTOP fresh, a bookmark, a link from outside,
   * signing out — is a normal arrival and gets the help, every single time.
   * That is the difference from the cooldown this replaced, which also
   * suppressed the fifth ordinary visit of the day and every deliberate retest.
   */
  const cameFromLogin = () => {
    try {
      const nav = performance.getEntriesByType("navigation")[0];
      if (nav && nav.type === "back_forward") return true;
    } catch {
      // no navigation timing — fall through to the referrer
    }
    return /\/vtop\/login(\b|\/|$)/.test(document.referrer || "");
  };

  const rolePicker = () => {
    if (document.getElementById("vtopLoginForm")) return null;
    const form = document.getElementById("stdForm");
    if (!form || !form.offsetParent) return null;
    // it must be the real thing: VTOP's own action, with its own token
    if (!/prelogin\/setup/.test(form.getAttribute("action") || "")) return null;
    if (!form.elements._csrf || !(form.elements._csrf.value || "").trim()) return null;
    return form;
  };

  /*
   * Press Student. The form element is submitted through its own submit
   * button where there is one, so any handler VTOP adds later is honoured;
   * requestSubmit falls back to submit() on the older shape, which is what the
   * live page is today (no onsubmit, an unnamed submit input).
   */
  const pressStudent = (form) => {
    const button = form.querySelector("[type=submit], button");
    try {
      if (button && typeof button.click === "function") {
        button.click();
        return true;
      }
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
      return true;
    } catch {
      return false; // navigation blocked — leave the chooser on screen
    }
  };

  const run = () => {
    if (otpStep()) return;

    /*
     * The reCAPTCHA variant — the one you cannot log in from (2026-08-22, see
     * the header). Reload and ask VTOP again, until it serves the image
     * captcha instead. This is the branch the file is named for.
     *
     * Nothing is lost by reloading here: run() executes once, at load, before
     * anybody has typed. It is deliberately NOT guarded on the fields being
     * empty — Chrome's password manager fills this form on arrival, so a
     * "don't clobber what's typed" check would read as filled every time and
     * the reload would never happen for exactly the people who need it.
     */
    if (document.querySelector("input[name='gResponse'], input#gResponse")) {
      if (store === null) return; // can't count attempts — never act
      const spent = Number(store.getItem(RELOAD_KEY)) || 0;
      if (spent >= MAX_RELOADS) return; // asked enough; leave the page alone
      store.setItem(RELOAD_KEY, String(spent + 1));
      setTimeout(() => window.location.reload(), 400);
      return;
    }

    if (captchaBlock()) {
      if (store) store.removeItem(RELOAD_KEY);
      if (!haveCaptcha()) ensureCaptcha();
      return;
    }

    /*
     * The chooser. This is where a reload lands, and skipping past it is the
     * whole of "it should come back to THIS page". Counted against the same
     * budget as the reload so the two can never ping-pong, and done at most
     * once per tab so the chooser stays reachable on purpose.
     */
    const picker = rolePicker();
    if (picker) {
      if (store === null) return; // can't count attempts — never act
      // they walked back here from the login form: they want another role
      if (cameFromLogin()) return;
      const attempts = Number(store.getItem(RELOAD_KEY)) || 0;
      if (attempts >= MAX_RELOADS) return;
      store.setItem(RELOAD_KEY, String(attempts + 1));
      store.setItem(ROLE_KEY, String(Date.now()));
      pressStudent(picker);
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
