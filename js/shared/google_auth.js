/*
 * Everything the injected buttons need to talk to Google, in one place.
 *
 * This block used to be copy-pasted verbatim into da_upload.js,
 * exam_schedule.js and timetable_ics.js, so every fix had to be made three
 * times and the wording drifted between them. It lives here now; the manifest
 * loads this file before all three.
 *
 * ---------------------------------------------------------------------------
 * 2026-08-16, verified live against Google — read this before "fixing" the
 * hints again:
 *
 * The OAuth client this build ships (256000685922-…, project "VEramp") is
 * ALIVE. Driving its authorisation URL by hand —
 *
 *   accounts.google.com/o/oauth2/auth
 *     ?client_id=256000685922-…&response_type=token
 *     &redirect_uri=https://jfmlhhjlkbliphgkmeingeacbijcilcl.chromiumapp.org/
 *     &scope=https://www.googleapis.com/auth/calendar.events
 *
 * — reaches the account chooser ("to continue to VEramp"), then the consent
 * card ("View and edit events on all your calendars"), and lands back on the
 * chromiumapp.org redirect carrying a real
 * `access_token=…&expires_in=3599&scope=…/auth/calendar.events`.
 *
 * So: the client id is valid, the chromiumapp redirect is registered, and
 * calendar.events IS on the consent screen. The app sits in Testing with the
 * student address as a test user (Google's "currently being tested" interstitial
 * appears, and Continue works).
 *
 * The old "this build's OAuth client id is dead" line was left over from
 * upstream's client (102739538495-…) and is simply false for this build. It was
 * the ONLY reason the ✉️ buttons dead-ended, and it is gone — along with the
 * legacy getAuthToken route in the worker that produced it.
 * ---------------------------------------------------------------------------
 */

// Fresh Google token via the worker at click time (a silent re-auth succeeds
// while the Google session is alive, so this stays quiet once consent exists).
// The worker replies { token, error } — the error is kept so a button can say
// WHY no consent window appeared instead of failing mutely.
if (typeof window.vrGoogleToken !== "function") {
  window.vrGoogleAuthError = null;
  window.vrGoogleToken = (opts) =>
    new Promise((resolve) => {
      const fallback = () =>
        chrome.storage.sync.get(["token"], (r) => resolve(r.token || null));
      try {
        chrome.runtime.sendMessage(
          {
            message: "get_google_token",
            interactive: !!(opts && opts.interactive),
            stale: (opts && opts.stale) || null,
          },
          (resp) => {
            if (chrome.runtime.lastError || resp === undefined) return fallback();
            if (resp && typeof resp === "object") {
              window.vrGoogleAuthError = resp.error || null;
              return resolve(resp.token || null);
            }
            resolve(resp || null); // worker from before the update: bare token
          }
        );
      } catch {
        fallback();
      }
    });

  // the sign-in failure, phrased for the button status lines. Ordered most
  // specific first: every branch below names something the reader can act on.
  window.vrGoogleAuthHint = () => {
    const e = window.vrGoogleAuthError || "";
    // a Cloud Console checkbox, not anything the student can click past
    if (/invalid_scope|accessNotConfigured|not enabled|has not been used/i.test(e))
      return "Google refused the scope — in Cloud Console enable the Google Calendar API and add calendar.events under Data Access, then retry";
    // Testing-mode apps expire consent after 7 days, and non-test-users are
    // refused outright. Both arrive as access_denied / admin_policy_enforced.
    if (/admin_policy_enforced|org_internal|disallowed_useragent/i.test(e))
      return "your Google account's admin blocks this app — sign in with a personal Google account instead, or use the 📅 one-tap links (no sign-in)";
    if (/not_configured/i.test(e))
      return "this build has no Google sign-in configured — no sign-in needed though: use the 📅 one-tap links on the exam/DA pages, or the 📅 import button on the timetable page";
    // A genuinely wrong/removed client id. NOT true of this build's client
    // (see the note at the top of this file) — kept because a fork that swaps
    // CALENDAR_CLIENT_ID for a broken one should still get a useful line.
    if (/bad client id|invalid_client|deleted_client/i.test(e))
      return "Google rejected this build's OAuth client — no sign-in needed though: use the 📅 one-tap links on the exam/DA pages, or the 📅 import button on the timetable page";
    if (/redirect_uri_mismatch/i.test(e))
      return "Google refused the redirect URI — add https://" +
        (chrome.runtime && chrome.runtime.id ? chrome.runtime.id : "<extension-id>") +
        ".chromiumapp.org/ (trailing slash) to the OAuth client, then retry";
    if (/not signed in/i.test(e))
      return "Chrome has no Google account signed in (so no consent window can open) — sign in to Chrome itself, then retry";
    /*
     * access_denied has TWO causes that look identical from here, and the
     * advice for them is opposite:
     *
     *   - the student closed the window   -> clicking again works
     *   - the app is in Testing mode and  -> clicking again NEVER works, no
     *     they are not a test user           matter how many times they try
     *
     * Google sends the same code for both, so this cannot tell them apart and
     * must not pretend to. It used to say only "the window was closed — click
     * again", which is advice that loops forever for anyone who was refused —
     * and after 2026-08-23 that is the expected case, because the decision was
     * made not to hand-add test users at all. So name both, and point at the
     * path that needs no sign-in either way.
     */
    if (/did not approve|access|denied|closed|cancel/i.test(e))
      return (
        "Google did not grant access — either the consent window was closed, or " +
        "this account is not on the app's test-user list. The 📅 one-tap links " +
        "need no sign-in and do the same job."
      );
    return e
      ? `Google sign-in failed: ${e}`
      : "Google sign-in failed — allow the consent window, then retry";
  };
}

// Chrome-native reminders via the worker (chrome.alarms + notifications) —
// needs no Google account at all, so this is the path that always works.
if (typeof window.vrLocalReminders !== "function") {
  window.vrLocalReminders = (tag, reminders) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { message: "schedule_local_reminders", tag, reminders },
          (n) => {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(typeof n === "number" ? n : null);
          }
        );
      } catch {
        resolve(null);
      }
    });
}

/*
 * A real email, sent now — not a calendar entry that will mail you later.
 *
 * The ✉️ buttons schedule Google Calendar events carrying an email reminder,
 * which is the right mechanism for "tell me a day before": Google's servers
 * send it, so it arrives whether or not Chrome is running. What it cannot do
 * is put the whole list in your inbox *right now*, on demand — and that is
 * what students actually ask for when they say "just mail it to me".
 *
 * This sends it through the student's own Gmail (users.messages.send), so the
 * mail comes from their address and lands in their own Sent. It needs the
 * `gmail.send` scope, which is SENSITIVE but not restricted — the same Testing
 * allowance the rest of this app runs under, no security assessment. If that
 * scope has not been added to the Cloud project the worker replies with a
 * `gmail_send_scope` error and the caller falls back to the calendar path
 * rather than dead-ending.
 *
 * Resolves { ok, to, error }.
 */
if (typeof window.vrSendMail !== "function") {
  window.vrSendMail = (mail) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            message: "send_mail",
            subject: (mail && mail.subject) || "VTOP Extension",
            html: (mail && mail.html) || "",
            text: (mail && mail.text) || "",
            to: (mail && mail.to) || null,
            interactive: !(mail && mail.interactive === false),
          },
          (resp) => {
            if (chrome.runtime.lastError || !resp)
              return resolve({ ok: false, to: null, error: "worker unreachable" });
            resolve(resp);
          }
        );
      } catch {
        resolve({ ok: false, to: null, error: "worker unreachable" });
      }
    });

  // Remember where to send. Resolves { ok, address, error }. In relay mode this
  // replaces a Google sign-in entirely — one text field instead of a consent
  // screen, and it works for a student with no Google account at all.
  window.vrSetReminderEmail = (address) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ message: "set_reminder_email", address }, (resp) => {
          if (chrome.runtime.lastError || !resp)
            return resolve({ ok: false, error: "worker unreachable" });
          resolve(resp);
        });
      } catch {
        resolve({ ok: false, error: "worker unreachable" });
      }
    });

  // why the direct mail failed, phrased for a button status line
  window.vrSendMailHint = (error) => {
    const e = String(error || "");
    // relay mode: the Apps Script answered, and said no. Its messages are
    // already written for a student to read, so pass them straight through
    // rather than wrapping them in a second layer of explanation.
    if (/daily limit reached|too many mails to this address|daily Gmail quota/i.test(e))
      return e;
    if (/relay unreachable|relay returned|relay busy/i.test(e))
      return `the VTOP Extension mail service didn't answer (${e}) — try again in a minute, or use the 📅 one-tap links`;
    if (/gmail_send_scope|invalid_scope/i.test(e))
      return "Gmail sending isn't switched on for this build — in Cloud Console add https://www.googleapis.com/auth/gmail.send under Data Access, then retry";
    if (/not_configured/i.test(e))
      return "this build has no Google sign-in configured, so it can't send mail directly";
    if (/did not approve|denied|closed|cancel/i.test(e))
      return "the Google consent window was closed — click again and allow access";
    return e ? `couldn't send the email: ${e}` : "couldn't send the email";
  };
}

/*
 * Send a mail, and deal with the one answer that is not an error.
 *
 * `need_address` means the relay is live and the ONLY thing missing is where
 * to write — no sign-in, no scope, nothing to diagnose. Every caller was
 * turning that into a red failure string, which is both wrong and unhelpful:
 * the fix is a text field, so show one. Once given, the address is remembered
 * for every later send.
 *
 * `note(text, ok)` is the caller's own status line, so this stays agnostic
 * about where the message goes (a button label, a banner, a table cell).
 */
/*
 * Ask where to send, in place next to `anchor`. Resolves the saved address, or
 * null when there is nowhere to put the field. Shared by "mail me now" and by
 * the scheduled mail reminders, so the prompt looks and behaves the same.
 */
if (typeof window.vrAskAddress !== "function") {
  window.vrAskAddress = (anchor, say) =>
    new Promise((resolve) => {
      if (!anchor || !anchor.parentNode) return resolve(null);
      const existing = anchor.parentNode.querySelector(".vrevamp-mail-ask");
      if (existing) existing.remove();

      const wrap = document.createElement("span");
      wrap.className = "vrevamp-mail-ask";
      wrap.style.cssText = "display:inline-block;margin-left:6px;font-size:12px;";

      const field = document.createElement("input");
      field.type = "email";
      field.placeholder = "where should we mail it?";
      field.className = "form-control input-sm form-control-sm";
      field.style.cssText = "width:210px;display:inline-block;height:30px;padding:2px 8px;font-size:13px;";

      const go = document.createElement("button");
      go.type = "button"; // never submit the VTOP form this sits inside
      go.textContent = "Save";
      go.className = "btn btn-sm btn-primary";
      go.style.cssText = "margin-left:4px;";

      const submit = async () => {
        const address = field.value.trim();
        if (!address) return;
        go.disabled = true;
        const saved = await window.vrSetReminderEmail(address);
        if (!saved.ok) {
          go.disabled = false;
          field.title = saved.error || "that address was refused";
          field.style.borderColor = "#c0392b";
          return;
        }
        wrap.remove();
        resolve(address);
      };

      go.addEventListener("click", submit);
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      });

      wrap.append(field, go);
      anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
      field.focus();
      say("tell me where to send it →", true);
    });
}

// What the extension already knows: { address, relay }. `relay` is true when
// mail goes out through the extension's own address (no Google sign-in).
if (typeof window.vrGetReminderEmail !== "function") {
  window.vrGetReminderEmail = () =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ message: "get_reminder_email" }, (resp) => {
          if (chrome.runtime.lastError || !resp) return resolve({ address: null, relay: false });
          resolve(resp);
        });
      } catch {
        resolve({ address: null, relay: false });
      }
    });
}

/*
 * Reminders that arrive as EMAIL from the extension, at the right time.
 *
 * "Email me 24 h & 2 h before" used to create Google Calendar events and let
 * Google send the mail, which needed the student's own Google sign-in. This
 * schedules the same reminders in the extension instead (chrome.alarms) and
 * sends each through the extension's mail when it falls due: nothing is written
 * to anyone's calendar and no Google account is involved. The trade-off is
 * honest and stated on the button: Chrome has to be running at that time (one
 * that was closed catches up the next time it opens).
 *
 * `reminders`: [{ when(ms), title, body, subject, html, text, until(ms) }].
 * Resolves { ok, n, to, error } — `error` is "need_address" only when there is
 * no anchor to ask next to.
 */
if (typeof window.vrScheduleMailReminders !== "function") {
  window.vrScheduleMailReminders = async (anchor, tag, reminders, say) => {
    const note = typeof say === "function" ? say : () => {};
    let { address } = await window.vrGetReminderEmail();
    if (!address) address = await window.vrAskAddress(anchor, note);
    if (!address) return { ok: false, n: 0, to: null, error: "need_address" };
    const n = await window.vrLocalReminders(
      tag,
      reminders.map((r) => ({
        when: r.when,
        title: r.title,
        body: r.body,
        notify: false, // the mail IS the reminder; the 🔔 button is the popup one
        until: r.until,
        mail: { subject: r.subject, html: r.html, text: r.text },
      }))
    );
    return { ok: typeof n === "number" && n > 0, n: n === null ? 0 : n, to: address, error: n === null ? "worker unreachable" : null };
  };
}

if (typeof window.vrMailOrAsk !== "function") {
  window.vrMailOrAsk = async (anchor, mail, note) => {
    const say = typeof note === "function" ? note : () => {};
    let result = await window.vrSendMail(mail);
    if (result.ok) return result;
    if (result.error !== "need_address") {
      say(window.vrSendMailHint(result.error), false);
      return result;
    }

    const asked = await window.vrAskAddress(anchor, say);

    if (!asked) return result;
    result = await window.vrSendMail(mail);
    if (!result.ok) say(window.vrSendMailHint(result.error), false);
    return result;
  };
}

// One-tap "add to Google Calendar": a calendar.google.com/render?action=
// TEMPLATE URL opens the user's own calendar with the event prefilled — the
// student just presses Save. No OAuth client and no consent flow, so it works
// for EVERY user with zero setup, which is why it stays the fallback even now
// that sign-in works. `start`/`end` are compact local times
// (YYYYMMDDTHHMMSS), pinned to IST via ctz.
if (typeof window.vrGcalTemplateUrl !== "function") {
  window.vrGcalTemplateUrl = (ev) =>
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    `&text=${encodeURIComponent(ev.title)}` +
    `&dates=${ev.start}/${ev.end}` +
    "&ctz=Asia/Kolkata" +
    `&details=${encodeURIComponent(ev.details || "")}` +
    (ev.location ? `&location=${encodeURIComponent(ev.location)}` : "");
}
