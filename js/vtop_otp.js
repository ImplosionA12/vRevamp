// Fills the VTOP login OTP from the user's already-open webmail tab.
//
// Runs only on the login pages, alongside the captcha solver. The chain the
// user is left with today is: Chrome's password manager fills id + password,
// js/captcha/captchaparser.js fills the captcha, and the OTP is the one field
// still typed by hand. This closes that gap.
//
// It never submits the form. A wrong OTP burned automatically is worse than
// one typed slowly, and VTOP locks accounts after repeated failures, so the
// code is filled and the submit button focused — the last press stays human.
(() => {
  const POLL_MS = 3000; // while the mail is expected to land
  const SLOW_POLL_MS = 6000; // during the long wait on a Resend cooldown
  const FAST_WINDOW_MS = 45000;
  // Long enough to outlast VTOP's ~180 s "Resend OTP" cooldown. An expired
  // code is refused, and the only cure is a resend the user cannot request
  // for three minutes — so the watch has to survive that wait, or it gives up
  // exactly when it is about to become useful.
  const GIVE_UP_MS = 300000;
  const OTP_LIFETIME_MIN = 3; // VTOP's own wording: "Valid for 3 minute"
  const REOPEN_EVERY_MS = 30000; // retry an auto-open now and then, not once
  const USED_KEY = "vtopext_otp_used";

  let panel = null;
  let note = null;
  let button = null;
  // Stays hidden unless the worker says a Gmail client id is configured AND
  // consent is the only thing missing. An install with no client id can never
  // make this work, so it never sees the button.
  let signIn = null;
  // Bumped by every run; a run that finds itself outdated stops. The button is
  // never disabled while a run is in flight — a run lasts minutes, and a
  // locked-out button would leave the user with nothing to press.
  let runId = 0;

  // The OTP box, without hardcoding an id VTOP is free to rename. Named match
  // first; otherwise the one short bounded-length text input on the page that
  // isn't the captcha or the password.
  const findOtpInput = () => {
    const inputs = [...document.querySelectorAll("input")];
    const labelOf = (el) =>
      [
        el.id,
        el.name,
        el.placeholder,
        el.getAttribute("aria-label") || "",
      ].join(" ");

    const named = inputs.find(
      (el) => /otp|one.?time/i.test(labelOf(el)) && el.type !== "hidden"
    );
    if (named) return named;

    return (
      inputs.find((el) => {
        if (el.type === "hidden" || el.type === "password") return false;
        if (/captcha|uname|user|username/i.test(labelOf(el))) return false;
        const max = Number(el.getAttribute("maxlength"));
        return max >= 4 && max <= 8;
      }) || null
    );
  };

  const isVisible = (el) => !!(el && el.offsetParent !== null);

  const findSubmit = () => {
    const byId =
      document.getElementById("submitBtn") || document.getElementById("loginButton");
    if (byId) return byId;
    const typed = document.querySelector('button[type="submit"], input[type="submit"]');
    if (typed) return typed;
    // The OTP step's "Verify OTP" is a plain <button> with a click handler and
    // no type=submit, so neither lookup above finds it — which is why the
    // button never got focused and pressing Enter did nothing.
    // Skip our own panel: "Sign in to Gmail" matches a submit-button label
    // perfectly well, and focusing it instead of VTOP's button is worse than
    // focusing nothing. Hidden buttons are skipped for the same reason.
    return (
      [...document.querySelectorAll("button, input[type='button']")].find(
        (el) =>
          (!panel || !panel.contains(el)) &&
          (el.offsetParent !== null || el.getClientRects().length > 0) &&
          /verify|submit|sign\s*in|log\s*in/i.test(el.textContent || el.value || "")
      ) || null
    );
  };

  const getUsed = () =>
    new Promise((resolve) =>
      chrome.storage.local.get([USED_KEY], (out) =>
        resolve(Array.isArray(out[USED_KEY]) ? out[USED_KEY] : [])
      )
    );

  // Remember consumed codes so a stale mail sitting in the inbox is never
  // re-filled. Without a readable timestamp this is what makes "fresh" mean
  // anything. Five is plenty of history.
  const markUsed = async (code) => {
    const used = await getUsed();
    if (used.includes(code)) return;
    used.push(code);
    chrome.storage.local.set({ [USED_KEY]: used.slice(-5) });
  };

  // Chrome's own lastError text is the only thing that distinguishes the two
  // ways this round-trip fails — "Receiving end does not exist" (the worker
  // never started / this content script was orphaned by an extension reload)
  // versus "message port closed" (the worker got it and answered nothing).
  // They need opposite fixes, so pass the message through verbatim instead of
  // flattening both to one word.
  const askWorker = (ignore, autoOpen) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { message: "vtopext_get_otp", ignore, autoOpen: !!autoOpen },
          (reply) => {
            const err = chrome.runtime.lastError;
            if (err) resolve({ error: err.message || "no detail" });
            else if (!reply) resolve({ error: "worker answered nothing" });
            else resolve(reply);
          }
        );
      } catch (e) {
        // "Extension context invalidated" lands here: the extension was
        // reloaded while this page stayed open, so the page must be reloaded.
        resolve({ error: (e && e.message) || "runtime unreachable" });
      }
    });

  const askSignIn = () =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ message: "vtopext_gmail_signin" }, (reply) => {
          if (chrome.runtime.lastError) resolve({ error: "worker" });
          else resolve(reply || { error: "worker" });
        });
      } catch (e) {
        resolve({ error: (e && e.message) || "runtime unreachable" });
      }
    });

  const fill = (input, code) => {
    input.focus();
    input.value = code;
    // VTOP's own listeners gate the submit button; a bare .value assignment
    // is invisible to them.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // some VTOP validators read event.key, so send the last digit rather than
    // a bare keyup with an empty key
    input.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, key: code.slice(-1) })
    );
    const submit = findSubmit();
    if (submit) submit.focus();
  };

  const say = (text, tone) => {
    if (!note) return;
    note.textContent = text;
    // Bootstrap's own text colours — the login page is Bootstrap 5, so the
    // message takes the portal's palette instead of a hard-coded one
    note.classList.toggle("text-danger", tone === "bad");
    note.classList.toggle("text-success", tone === "good");
    note.classList.toggle("text-muted", tone !== "bad" && tone !== "good");
  };

  // Codes already filled once are ALWAYS skipped, clicks included. An earlier
  // version cleared the list on a manual click, on the theory that a failed
  // captcha leaves the same OTP valid — and that is what put a long-dead code
  // back in the box. VTOP mails a fresh code whenever the page re-renders, so
  // there was nothing to gain and a stale fill to lose.
  const run = async (input, intro) => {
    const id = ++runId;
    const live = () => id === runId; // a later run has taken over
    const started = Date.now();
    const ignore = await getUsed();
    if (!live()) return;
    say(intro || "Looking for the OTP mail…");
    let errors = 0;
    // Poll hard while the mail is expected, then ease off — most of a long
    // run is spent waiting out a Resend cooldown, where a 3 s cadence buys
    // nothing and just churns the mail tab.
    const pollMs = () =>
      Date.now() - started < FAST_WINDOW_MS ? POLL_MS : SLOW_POLL_MS;

    // Ask the mail tab to open VTOP's message itself when the code isn't
    // rendered. Retried periodically rather than once: a run now spans
    // minutes, and a new mail arriving mid-run needs opening too.
    let askOpen = false;
    let lastOpenAt = 0; // 0 makes the first check due immediately
    const openDue = () => Date.now() - lastOpenAt >= REOPEN_EVERY_MS;

    while (live() && Date.now() - started < GIVE_UP_MS) {
      const reply = await askWorker(ignore, askOpen);
      if (askOpen) {
        askOpen = false;
        lastOpenAt = Date.now();
      }
      if (!live()) return;

      if (signIn && reply && reply.needsSignIn) signIn.hidden = false;

      if (reply && reply.code) {
        // VTOP says it itself: the code dies after 3 minutes. A code that
        // cannot be DATED is therefore not usable — an undated one turned out
        // to be hours old twice, and each bad fill spends a login attempt on
        // a certain rejection (VTOP locks accounts after enough of those).
        // So: fill only what is provably fresh, and keep polling otherwise so
        // the right code gets filled the moment it can be read.
        const age = reply.ageMin;
        if (typeof age !== "number") {
          say("Open the OTP mail so its time is visible — won't fill an undated code.", "bad");
          await new Promise((r) => setTimeout(r, pollMs()));
          continue;
        }
        // `>=`, not `>`. Ages are whole minutes floored by the source (Gmail
        // renders "3 minutes ago" for anything from 3:00 to 3:59), so an age
        // of 3 means the code is already past VTOP's 3-minute window. `> 3`
        // let a certainly-dead code through.
        if (age >= OTP_LIFETIME_MIN) {
          say(
            `Newest OTP mail is ${age} min old (expired) — press Resend OTP, I'll fill the new one.`,
            "bad"
          );
          await new Promise((r) => setTimeout(r, pollMs()));
          continue;
        }
        fill(input, reply.code);
        await markUsed(reply.code);
        say(`Filled ${reply.code} — press Submit.`, "good");
        return;
      }
      if (reply && reply.error === "no-mail-tab") {
        say("Open your student mail in another tab, then click again.", "bad");
        return;
      }
      if (reply && reply.error === "mail-tab-stale") {
        // Keep polling rather than giving up: pressing F5 over there fixes it
        // live, with no need to come back and click anything here.
        say("Reload your Gmail tab (F5) — it opened before the extension updated.", "bad");
        await new Promise((r) => setTimeout(r, pollMs()));
        continue;
      }
      if (reply && reply.error) {
        // A sleeping worker can miss one message, so tolerate a couple. Past
        // that it is a real fault (worker crashed, page not recognised as
        // VTOP) and saying so beats spinning out the whole watch looking like
        // the mail merely hasn't arrived.
        if (++errors >= 3) {
          // Much the commonest cause is an orphaned content script: the
          // extension was reloaded at chrome://extensions while this tab
          // stayed open, so its chrome.runtime is dead and only a page
          // reload revives it. Say that, not just the raw error.
          say(`Extension error — reload THIS page (F5). [${reply.error}]`, "bad");
          return;
        }
      } else {
        errors = 0;
      }

      const waited = Math.round((Date.now() - started) / 1000);
      // Three different "no code yet" states, and they need different words.
      // Polling continues in every case, so acting on the advice fixes it
      // without another click.
      if (reply && reply.sawVtop && !reply.code) {
        // VTOP's mail is in that tab but the code isn't rendered — Gmail's
        // inbox list truncates the preview at "Use the OTP below…". Opening
        // it is the fix, so try that before asking the user to.
        if (openDue()) {
          askOpen = true;
          say("Opening the OTP mail in Gmail…");
        } else if (reply.opened) {
          say("Opened the OTP mail — reading it…");
        } else if (waited >= 10) {
          say("Open the newest 'VTOP Login OTP Needed' mail — the inbox list hides the code.", "bad");
        } else {
          say(`Waiting for the OTP mail… ${waited}s`);
        }
      } else if (reply && reply.sawVtop === false && waited >= 15) {
        say("No VTOP mail in the mail tab you have open — is that your student account?", "bad");
      } else {
        say(`Waiting for the OTP mail… ${waited}s`);
      }
      await new Promise((r) => setTimeout(r, pollMs()));
    }

    if (live()) say("No new OTP found — click to look again.", "bad");
  };

  const mount = (input) => {
    if (panel) return;
    panel = document.createElement("div");
    // one tidy row under the OTP field, in the page's own font and sizes
    panel.className = "d-flex align-items-center flex-wrap gap-2 mt-2";

    button = document.createElement("button");
    button.type = "button"; // never let it submit the login form
    button.textContent = "Fill OTP from mail";
    button.className = "btn btn-sm btn-primary"; // same as the page's Submit
    button.addEventListener("click", () => run(input));

    signIn = document.createElement("button");
    signIn.type = "button";
    signIn.textContent = "Sign in to Gmail";
    signIn.hidden = true;
    signIn.className = "btn btn-sm btn-outline-primary";
    signIn.addEventListener("click", async () => {
      say("Opening Google sign-in — pick your STUDENT account…");
      const reply = await askSignIn();
      if (reply && reply.ok) {
        signIn.hidden = true;
        // the intro rides along so the confirmation isn't overwritten by the
        // first poll a beat later
        run(input, "Signed in — reading your mail directly now…");
      } else if (reply && reply.error === "not-configured") {
        say("Gmail sign-in isn't set up in this build.", "bad");
      } else {
        say("Google sign-in didn't complete.", "bad");
      }
    });

    note = document.createElement("span");
    note.className = "small text-muted";

    panel.append(button, signIn, note);
    (input.parentElement || document.body).insertBefore(
      panel,
      input.nextSibling
    );

    // The field appearing means VTOP has just mailed the code, so start
    // looking without waiting to be asked.
    run(input);
  };

  // The login page is server-rendered but swaps in the OTP step without a
  // reload. A capped poll, not a MutationObserver — an observer on this page
  // was what froze the timetable page (commit 8055f0e), and 90 s of 500 ms
  // ticks costs nothing.
  let ticks = 0;
  const timer = setInterval(() => {
    if (++ticks > 180) {
      clearInterval(timer);
      return;
    }
    const input = findOtpInput();
    if (input && isVisible(input)) {
      clearInterval(timer);
      mount(input);
    }
  }, 500);
})();
