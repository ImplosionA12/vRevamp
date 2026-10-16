let viewOfflineButton = document.getElementById("view-offline");

viewOfflineButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({
    message: "showOfflinePage",
  });
});

/*
 * Reminders & mail panel.
 *
 * Every setting here already existed in chrome.storage.local and none of it
 * had a control. The account VTOP Extension signs in as, the address it mails, the
 * daily digest and the relay URL were all things you could only change by
 * editing background.js and reloading the extension — which is why "it asks me
 * OAuth every time" had no answer a student could act on. Now the state is
 * legible and each piece can be changed in place.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const panel = $("vr-mail-panel");
  if (!panel) return;

  const status = $("vr-mail-status");
  const say = (text, bad) => {
    status.textContent = text || "";
    status.style.color = bad ? "#b00" : "#2e7d32";
  };

  // Every worker call goes through here: the MV3 worker can be asleep, and an
  // un-caught lastError leaves the panel showing "checking…" forever.
  const ask = (payload) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (reply) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(reply || null);
        });
      } catch {
        resolve(null);
      }
    });

  const paint = (state) => {
    if (!state) {
      $("vr-google-state").textContent = "unavailable";
      return;
    }
    /*
     * "signed in" here means the GRANT exists, not that an access token is
     * currently warm. Those tokens last an hour by design and are refreshed
     * without any screen; showing "(needs re-approval)" the other 23 hours was
     * telling a student their sign-in had failed when nothing had.
     */
    $("vr-google-state").textContent = state.account
      ? `${state.account}${state.signedIn ? "" : " — sign-in needed on next use"}`
      : state.signedIn
        ? "signed in"
        : "not signed in yet";
    $("vr-google-state").title =
      (state.relay
        ? "A mail relay is configured, so sending mail needs no Google sign-in at all — this account is only used for Calendar reminders."
        : "Used for Calendar reminders and for sending mail from your own Gmail.") +
      (state.signedIn
        ? "\n\nAccess renews itself in the background — you should not see a Google window again unless you sign out or Google expires the grant."
        : "");
    if (state.reminderEmail) $("vr-mail-to").value = state.reminderEmail;
    $("vr-digest").checked = !!state.digest;
    $("vr-digest-when").textContent = state.digest ? `around ${state.digestHour}:00 daily` : "";
    if (state.relayUrl) $("vr-relay").value = state.relayUrl;
    if (state.relay) $("vr-advanced").open = false;
  };

  const refresh = async () => paint(await ask({ message: "google_status" }));
  refresh();

  $("vr-google-switch").addEventListener("click", async () => {
    // Deliberately only forgets the tokens on this machine. Revoking the grant
    // is Google's own screen, not something to do silently from a popup.
    const reply = await ask({ message: "google_sign_out" });
    say(
      reply && reply.ok
        ? "Forgotten. The next reminder button will ask which account to use."
        : "Couldn't do that — reopen the popup and retry.",
      !(reply && reply.ok)
    );
    refresh();
  });

  $("vr-mail-save").addEventListener("click", async () => {
    const reply = await ask({ message: "set_reminder_email", address: $("vr-mail-to").value });
    say(
      reply && reply.ok ? `Mail will go to ${reply.address}.` : (reply && reply.error) || "Couldn't save that.",
      !(reply && reply.ok)
    );
  });

  $("vr-digest").addEventListener("change", async (event) => {
    const wanted = event.target.checked;
    const reply = await ask({ message: "set_daily_digest", enabled: wanted });
    if (!reply || !reply.ok) {
      event.target.checked = !wanted;
      say("Couldn't change that.", true);
      return;
    }
    $("vr-digest-when").textContent = reply.enabled ? `around ${reply.hour}:00 daily` : "";
    say(
      reply.enabled
        ? `On. A first summary has just been sent${reply.to ? ` to ${reply.to}` : ""} so you can check it arrives.`
        : "Off.",
      false
    );
  });

  $("vr-relay-save").addEventListener("click", async () => {
    const reply = await ask({ message: "set_mail_relay", url: $("vr-relay").value });
    say(
      reply && reply.ok
        ? reply.url
          ? "Relay is live — mail will come from that address, no sign-in needed."
          : "Relay cleared — mail will send from your own Gmail."
        : (reply && reply.error) || "Couldn't save that.",
      !(reply && reply.ok)
    );
    refresh();
  });
})();
