/*
 * Must stay in sync with manifest.json host_permissions: a host the content
 * scripts are injected into but that is missing here gets no webRequest
 * events, so every message-driven feature is silently dead on it (that was
 * true of web.vitap.ac.in until 2026-07-25).
 */
const VTOP_URLS = [
  "*://vtop.vit.ac.in/*",
  "*://vtopcc.vit.ac.in/vtop/*",
  "*://vtop.vitap.ac.in/*",
  "*://web.vitap.ac.in/*",
];

// Webmail hosts the login-OTP scanner runs on. Must stay in sync with the
// matching content_scripts block and host_permissions in manifest.json.
const MAIL_TAB_PATTERNS = [
  "https://mail.google.com/*",
  "https://outlook.office.com/*",
  "https://outlook.office365.com/*",
  "https://outlook.live.com/*",
];

/* ===================== Gmail-API route for the login OTP =====================
 *
 * The tab-scraping route can only read what Gmail has rendered, and Gmail's
 * inbox list truncates the preview at "Use the OTP below…" — the digits are
 * simply not in the page until the mail is opened. Reading the message
 * through the API removes that limit entirely: no mail tab need be open, no
 * mail need be opened, and the age comes from `internalDate` instead of being
 * parsed out of "13 minutes ago".
 *
 * ---------------------------------------------------------------------------
 * TO SWITCH THIS ON: paste the OAuth client id into GMAIL_CLIENT_ID below.
 * That is the whole change. Blank = dormant, and the scraper handles the OTP
 * exactly as it does today.
 * ---------------------------------------------------------------------------
 *
 * Making that client, once, in Google Cloud:
 *   1. Any Google account may own the project — the project identifies the
 *      APP, not the mailbox, and university Workspace accounts frequently
 *      cannot create Cloud projects at all. Enable the Gmail API on it.
 *   2. OAuth consent screen: External, left in **Testing**, with the STUDENT
 *      address under Test users. gmail.readonly is a RESTRICTED scope, so a
 *      published app would need Google verification plus a paid security
 *      assessment; Testing caps it at 100 hand-added addresses instead.
 *   3. Credentials -> OAuth client ID -> application type **Web application**
 *      (NOT "Chrome Extension": that type is built for getAuthToken, the
 *      route this deliberately avoids). Leave "Authorised JavaScript origins"
 *      empty; put chrome.identity.getRedirectURL() — trailing slash and all —
 *      under "Authorised redirect URIs". A mismatch there is Error 400.
 *   4. Sign in as the STUDENT account at the chooser. The project's owning
 *      account is irrelevant; the account picked at consent is the mailbox
 *      that gets read.
 *
 * launchWebAuthFlow, not getAuthToken: getAuthToken silently uses the Chrome
 * profile's PRIMARY account — a personal Gmail here, not the student mailbox
 * the OTP arrives in. It would be one-click and read the wrong inbox.
 * launchWebAuthFlow with prompt=select_account asks which account to use,
 * which is the only way this lands on the right mailbox.
 *
 * The client id is NOT a secret: it ships inside the extension and is public
 * by design. There is no client secret — the implicit flow has none.
 */

// >>> PASTE THE OAUTH CLIENT ID HERE (…apps.googleusercontent.com) <<<
// Leave "" to keep the Gmail route off entirely.
const GMAIL_CLIENT_ID = "256000685922-v0qi26k4h5d4olfastfer2j6cv0j7frp.apps.googleusercontent.com";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_TOKEN_KEY = "vrevamp_gmail_token";
const GMAIL_CLIENT_KEY = "vrevamp_gmail_client_id";

/*
 * ---------------------------------------------------------------------------
 * GOOGLE CALENDAR — the same escape hatch, for the feature that needs it most.
 * ---------------------------------------------------------------------------
 *
 * Every Calendar feature in this extension already speaks the Calendar API:
 * timetable import POSTs each event to /calendars/primary/events, and the
 * exam/DA ✉️ buttons create events with an email reminder. None of it is
 * reachable, because the only token route was `chrome.identity.getAuthToken`
 * on `manifest.oauth2.client_id` — upstream's client, which is dead
 * ("bad client id") for every user of this build.
 *
 * That single dead id is the whole reason the timetable import falls back to
 * opening one prefilled editor per class and asking the student to press Save
 * forty times. With a live token there is nothing to press: the events are
 * written directly, in one click.
 *
 * TO SWITCH IT ON: paste a client id below. Blank = the no-sign-in TEMPLATE
 * paths stay exactly as they are today, so nothing regresses if it is left
 * empty.
 *
 * It can be the SAME client as GMAIL_CLIENT_ID above — one OAuth client may
 * carry many scopes — provided that in its Cloud project you also:
 *   1. enable the **Google Calendar API**, and
 *   2. add `.../auth/calendar.events` to the OAuth consent screen's scopes.
 * Without both, consent returns a token that 403s on the first write, which
 * looks like a bug rather than a missing checkbox.
 *
 * Scope note: `calendar.events` (not the broader `calendar`) is all the code
 * touches — it only ever reads and writes /calendars/primary/events. It is a
 * SENSITIVE scope, not a restricted one, so an app left in Testing works for
 * up to 100 hand-added addresses with no review; shipping it to every student
 * needs Google verification, but not the paid security assessment that
 * gmail.readonly would.
 */
// >>> PASTE THE OAUTH CLIENT ID HERE (…apps.googleusercontent.com) <<<
// Leave "" to keep Calendar sign-in off.
//
// Deliberately the SAME client as GMAIL_CLIENT_ID: one OAuth client may carry
// many scopes, and this project has exactly one Web-application client, already
// registered with the chromiumapp.org redirect that launchWebAuthFlow needs —
// proven by the Gmail OTP flow running on it. What makes it a *Calendar* client
// is project configuration, not a second id: the Google Calendar API enabled,
// and calendar.events added under Data Access.
const CALENDAR_CLIENT_ID = GMAIL_CLIENT_ID;

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_TOKEN_KEY = "vrevamp_calendar_token";
const CALENDAR_CLIENT_KEY = "vrevamp_calendar_client_id";
// 1h, not 1d: a code lives 3 minutes, so anything older is refused by the
// caller anyway — no reason to pull a day of mail to throw it away.
const GMAIL_QUERY = "from:noreply.sdc@vitap.ac.in newer_than:1h";

// The pasted id, or one stored at runtime (handy for testing a second client
// without editing the file). It deliberately does NOT fall back to
// manifest.oauth2.client_id: that client is the Calendar one, registered
// without a chromiumapp.org redirect, so launchWebAuthFlow died on it with
// "Error 400: redirect_uri_mismatch" — and because the fallback made the
// extension look configured, the failure had no visible cause.
async function gmailClientId() {
  const stored = (await chrome.storage.local.get([GMAIL_CLIENT_KEY]))[GMAIL_CLIENT_KEY];
  if (stored) return String(stored);
  return GMAIL_CLIENT_ID.trim() || null;
}

// Until consent has been granted once, every silent attempt fails — and the
// login page polls every 3 s, so without this it would fire a web-auth flow
// at Google twenty times a minute for nothing. A worker restart clears it,
// which is the right granularity: cheap to retry, never in a tight loop.
// Per scope: a Calendar backoff must not silence Gmail or the reverse.
const silentBlockedUntil = new Map();
const SILENT_BACKOFF_MS = 60000;

/*
 * WHY THE CONSENT SCREEN USED TO APPEAR ON EVERY SINGLE CLICK — fixed
 * 2026-08-17, reported as "the extension asks me oauth everytime when i click
 * mail me".
 *
 * Three independent causes, all of them here, all of them ours:
 *
 * 1. The interactive flow asked for `prompt=consent select_account`.
 *    `consent` is an instruction to Google to SHOW THE CONSENT SCREEN AGAIN
 *    even when the grant already exists — it is for apps that need a fresh
 *    refresh token, and it is exactly wrong for a cached implicit token. It
 *    guaranteed a full screen every time no matter what was already approved.
 * 2. The silent flow (`prompt=none`) carried no `login_hint`. This profile has
 *    three Google accounts signed in, and `prompt=none` must not choose
 *    between them — so it failed by design, once an hour, forever, and every
 *    failure fell through to the interactive flow in (1).
 * 3. Calendar, gmail.send and gmail.readonly were three separate tokens with
 *    three separate consents. One hour after signing in, all three expired,
 *    and the next few clicks were three screens rather than one.
 *
 * The fixes, in the same order: never send `consent`; remember which account
 * was chosen and send it as `login_hint` so the silent refresh can actually
 * resolve; and request calendar.events + gmail.send + userinfo.email as ONE
 * grant (`googleToken` below) so there is one consent to give and one token to
 * cache. `include_granted_scopes` keeps an older narrow grant valid.
 *
 * Net effect: one screen the first time, then silence — until the student
 * revokes access or Google expires the grant (7 days while the app is in
 * Testing; see ROADMAP §3).
 */
const GOOGLE_HINT_KEY = "vrevamp_google_account";

/*
 * ROUND TWO, 2026-08-17 — "the oauth should persist, that's what i asked".
 *
 * The three causes above were all real and all fixed, and a consent screen was
 * STILL appearing about once an hour. Two more, both structural:
 *
 * 4. THE INTERACTIVE PATH NEVER TRIED THE SILENT ONE FIRST. Read the old
 *    webAuthToken: cache miss + interactive:true went straight to
 *    launchWebAuthFlow with a visible window. The silent flow only ran when a
 *    caller explicitly asked for interactive:false — i.e. background polling,
 *    never a button. So every click after the cached hour opened a window, and
 *    whether Google then had something to ask was beside the point: the window
 *    is the thing the student sees, and it appeared unconditionally. A button
 *    click now attempts prompt=none first and only opens a window if that
 *    genuinely fails. This is the single biggest one.
 *
 * 5. THE SILENT FLOW WAS BEING KILLED BEFORE IT FINISHED. launchWebAuthFlow
 *    defaults `abortOnLoadForNonInteractive` to TRUE: in non-interactive mode
 *    Chrome tears the flow down as soon as the first navigation finishes
 *    loading. accounts.google.com does not answer prompt=none in one hop — it
 *    loads, then redirects — so the abort fired on a flow that was about to
 *    succeed, and the failure was indistinguishable from "no consent". Every
 *    silent refresh in this extension has been losing that race. Both knobs
 *    (Chrome 105+) are passed now, with a fallback for older Chrome that
 *    rejects unknown properties.
 *
 * Together with the hint below, the sequence for a returning student is:
 * cached token → silent refresh → nothing on screen. A window means the grant
 * is genuinely gone (revoked, or the 7-day Testing expiry — see ROADMAP §3,
 * which no amount of client code can shorten).
 */
const SILENT_TIMEOUT_MS = 15000;
// Set once any token has ever come back for this store key. Its only job is to
// keep `prompt=select_account` off every interactive attempt after the first:
// the chooser is a full screen, and re-showing it to someone who has already
// picked an account is the exact behaviour being complained about.
const GRANTED_KEY = "vrevamp_google_granted";

async function googleHint() {
  const stored = (await chrome.storage.local.get([GOOGLE_HINT_KEY]))[GOOGLE_HINT_KEY];
  return stored ? String(stored) : null;
}

// Why the last attempt for this scope failed, in Google's own words. Without
// it every failure looks like "you closed the window", which is wrong for the
// one that actually happens during setup: consent is refused with
// `error=invalid_scope` when the scope has not been added to the OAuth consent
// screen, or the API is not enabled on the project. That is a checkbox in Cloud
// Console, and the message should say so rather than blame the student.
const lastAuthError = new Map();

// One trip to accounts.google.com. Returns the access token, or null, and
// records Google's own words for the failure. `silent` is the only thing that
// differs between the two attempts the caller makes.
async function runAuthFlow({ clientId, scope, storeKey, silent, hint, granted }) {
  const authQuery = {
    client_id: clientId,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope,
    // an older, narrower grant (calendar-only, say) stays usable instead of
    // being replaced — so widening the ask cannot break what already worked
    include_granted_scopes: "true",
  };
  // Without it `prompt=none` cannot pick between the accounts signed into this
  // profile and fails every time, which is what turned a once-per-week consent
  // into a per-click one.
  if (hint) authQuery.login_hint = hint;
  if (silent) authQuery.prompt = "none";
  else if (!hint && !granted) authQuery.prompt = "select_account";
  // Interactive with a known account (or a grant already on record): send no
  // `prompt` at all. Google reuses the grant and returns without rendering
  // anything, and only shows a screen when something is genuinely new.

  const url =
    "https://accounts.google.com/o/oauth2/auth?" + new URLSearchParams(authQuery).toString();

  const details = { url, interactive: !silent };
  if (silent) {
    // See the note at GRANTED_KEY: without these Chrome aborts the silent flow
    // at the first completed navigation, which is one hop before Google's
    // prompt=none redirect arrives.
    details.abortOnLoadForNonInteractive = false;
    details.timeoutMsForNonInteractive = SILENT_TIMEOUT_MS;
  }

  let redirected = null;
  try {
    redirected = await chrome.identity.launchWebAuthFlow(details);
  } catch (error) {
    const message = String((error && error.message) || error);
    // Chrome before 105 rejects the two knobs above by name. Retry plainly
    // rather than treating a schema complaint as a refused consent.
    if (silent && /unexpected property|Invalid value|not allowed/i.test(message)) {
      try {
        redirected = await chrome.identity.launchWebAuthFlow({ url, interactive: false });
      } catch (retryError) {
        lastAuthError.set(storeKey, String((retryError && retryError.message) || retryError));
        return null;
      }
    } else {
      // silent flow refused (no consent yet), or the user closed the window
      if (!silent) lastAuthError.set(storeKey, message);
      return null;
    }
  }
  if (!redirected) return null;

  // Google reports refusals in the fragment too, not only by throwing
  const params = new URLSearchParams(String(redirected).split("#")[1] || "");
  const query = new URLSearchParams(String(redirected).split("?")[1] || "");
  const token = params.get("access_token");
  if (!token) {
    const why =
      params.get("error_description") ||
      params.get("error") ||
      query.get("error_description") ||
      query.get("error");
    if (why) lastAuthError.set(storeKey, String(why).replace(/\+/gu, " "));
    return null;
  }
  return { token, ttl: Number(params.get("expires_in")) || 3600 };
}

// Cached token, else a silent flow, else (only when asked) an interactive one.
// The implicit flow hands back ~1 h tokens with no refresh token, but a silent
// re-run succeeds while the Google session is alive, so this stays quiet.
//
// One function for every scope: the Gmail route proved the mechanism works
// where getAuthToken cannot (a Web-application client with a chromiumapp.org
// redirect, no dependency on the Chrome profile's primary account), and the
// Calendar features need exactly the same thing.
async function webAuthToken({ clientId, scope, storeKey, interactive, stale }) {
  if (!clientId) return null;

  const cached = (await chrome.storage.local.get([storeKey]))[storeKey];
  if (stale && cached && cached.token === stale) {
    // a 401 proved this one dead — drop it rather than hand it back again
    await chrome.storage.local.remove([storeKey]);
  } else if (cached && cached.token && cached.exp > Date.now() + 60000) {
    return cached.token;
  }

  const silentBlocked = Date.now() < (silentBlockedUntil.get(storeKey) || 0);
  if (!interactive && silentBlocked) return null;

  const hint = await googleHint();
  const granted = !!(await chrome.storage.local.get([GRANTED_KEY]))[GRANTED_KEY];

  const keep = async (result) => {
    lastAuthError.delete(storeKey);
    silentBlockedUntil.delete(storeKey); // consent exists; silent refresh works
    await chrome.storage.local.set({
      [storeKey]: { token: result.token, exp: Date.now() + result.ttl * 1000 },
      [GRANTED_KEY]: true,
    });
    // Learn which account this is, once, so every later refresh can be silent.
    // Only possible when the grant includes userinfo.email — which is precisely
    // why it was folded into the merged scope rather than left optional.
    if (!hint && /userinfo\.email/.test(scope)) {
      const who = await googleSelfEmail(result.token);
      if (who) await chrome.storage.local.set({ [GOOGLE_HINT_KEY]: who });
    }
    return result.token;
  };

  /*
   * ALWAYS TRY SILENT FIRST — including for a button click. See cause (4) at
   * GRANTED_KEY: going straight to a visible window on every cache miss is
   * what made a consent screen appear roughly hourly, regardless of whether
   * Google had anything to ask. The only case where the pre-flight is skipped
   * is when a silent attempt failed within the last minute, since repeating it
   * would only add SILENT_TIMEOUT_MS to a click that is going to end in a
   * window anyway.
   */
  // …with one exception: a first run, where nothing has ever been granted and
  // no account is known. prompt=none cannot succeed there, and the pre-flight
  // would only add SILENT_TIMEOUT_MS of nothing-happening before the window a
  // first-time student has to see anyway.
  const worthTrying = granted || !!hint || !interactive;
  if (!silentBlocked && worthTrying) {
    const quiet = await runAuthFlow({ clientId, scope, storeKey, silent: true, hint, granted });
    if (quiet) return keep(quiet);
    silentBlockedUntil.set(storeKey, Date.now() + SILENT_BACKOFF_MS);
  }
  if (!interactive) return null;

  const loud = await runAuthFlow({ clientId, scope, storeKey, silent: false, hint, granted });
  if (!loud) return null;
  return keep(loud);
}

/*
 * The one token every button shares.
 *
 * calendar.events (write the reminder), gmail.send (send the summary) and
 * userinfo.email (know who "me" is) are asked for TOGETHER, so the student
 * approves one screen instead of three and every button afterwards runs off
 * the same cached hour.
 *
 * `feature` only matters on the fallback path: Google refuses a multi-scope
 * request wholesale with `invalid_scope` and does not say WHICH scope it
 * objected to, so if the merged ask is rejected — a Cloud project that never
 * added gmail.send, say — retry with just the scope this caller needs. That
 * keeps a half-configured project working for the half that IS configured
 * instead of failing everything.
 */
const APP_SCOPE = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");
const APP_TOKEN_KEY = "vrevamp_google_app_token";

async function googleToken({ interactive, stale, feature }) {
  const clientId = await calendarClientId();
  if (!clientId) return null;

  const merged = await webAuthToken({
    clientId,
    scope: APP_SCOPE,
    storeKey: APP_TOKEN_KEY,
    interactive,
    stale,
  });
  if (merged) return merged;

  const why = lastAuthError.get(APP_TOKEN_KEY) || "";

  // A stored hint that names an account no longer signed into this profile
  // makes every attempt fail in a way that looks like a refusal. Forget it and
  // ask once — this is the "switch Google account" path, taken automatically.
  if (interactive && /login_required|user_not_signed|invalid_request|consent_required/i.test(why)) {
    // GRANTED_KEY goes too: it is the flag that suppresses the account
    // chooser, and this is the one path that genuinely needs the chooser back.
    await chrome.storage.local.remove([GOOGLE_HINT_KEY, GRANTED_KEY]);
    const retry = await webAuthToken({
      clientId,
      scope: APP_SCOPE,
      storeKey: APP_TOKEN_KEY,
      interactive: true,
    });
    if (retry) return retry;
  }

  if (!/invalid_scope|admin_policy|org_internal/i.test(why)) return null;
  const narrow = feature === "gmail.send" ? GMAIL_SEND_SCOPE : CALENDAR_SCOPE;
  const key = feature === "gmail.send" ? GMAIL_SEND_TOKEN_KEY : CALENDAR_TOKEN_KEY;
  const fallback = await webAuthToken({ clientId, scope: narrow, storeKey: key, interactive, stale });
  if (!fallback) lastAuthError.set(APP_TOKEN_KEY, lastAuthError.get(key) || why);
  return fallback;
}

// Whichever of the three keys actually recorded the refusal, in Google's words.
const googleAuthError = () =>
  lastAuthError.get(APP_TOKEN_KEY) ||
  lastAuthError.get(CALENDAR_TOKEN_KEY) ||
  lastAuthError.get(GMAIL_SEND_TOKEN_KEY) ||
  "";

// Forget every Google token and the remembered account. Used by "sign out" and
// whenever an API answers 401 on a token we believed was live.
async function forgetGoogleTokens() {
  await chrome.storage.local.remove([
    APP_TOKEN_KEY,
    CALENDAR_TOKEN_KEY,
    GMAIL_SEND_TOKEN_KEY,
    GOOGLE_HINT_KEY,
    // without this a signed-out student gets no account chooser on the way
    // back in, because "a grant exists" is exactly what sign-out revokes
    GRANTED_KEY,
  ]);
  lastAuthError.clear();
  silentBlockedUntil.clear();
}

async function gmailToken(interactive) {
  return webAuthToken({
    clientId: await gmailClientId(),
    scope: GMAIL_SCOPE,
    storeKey: GMAIL_TOKEN_KEY,
    interactive,
  });
}

// Same shape as gmailClientId: a runtime override, else the pasted constant,
// and deliberately NO fallback to manifest.oauth2.client_id — that is the dead
// upstream client, registered without a chromiumapp.org redirect, so falling
// back to it would fail with redirect_uri_mismatch while making the extension
// look configured.
async function calendarClientId() {
  const stored = (await chrome.storage.local.get([CALENDAR_CLIENT_KEY]))[CALENDAR_CLIENT_KEY];
  if (stored) return String(stored);
  return CALENDAR_CLIENT_ID.trim() || null;
}

// Calendar callers go through the shared grant, so signing in for the exam ✉️
// also signs in for the timetable import and the 📧 mail — one screen, not
// three. (googleToken is declared above; this stays as a named wrapper because
// every call site already reads as "give me a calendar token".)
async function calendarToken({ interactive, stale }) {
  return googleToken({ interactive, stale, feature: "calendar" });
}

/* ===================== Direct email (Gmail users.messages.send) =============
 *
 * The ✉️ buttons schedule Calendar events carrying an email reminder, and that
 * is the right mechanism for "tell me the day before": Google's servers send
 * it, so it arrives whether or not Chrome is running. What it cannot do is put
 * the list in the student's inbox *right now* — which is what "just mail it to
 * me" actually means. This does that.
 *
 * It sends AS the student, through their own Gmail, so the mail arrives from
 * their address and is in their own Sent folder. No third-party mail relay is
 * involved and no address ever leaves the browser.
 *
 * `gmail.send` is SENSITIVE, not restricted — write-only, it cannot read a
 * mailbox — so an app in Testing may use it with no review, exactly like
 * calendar.events. It is a separate token from the Gmail OTP scanner's
 * `gmail.readonly` on purpose: the two features are independent, and a student
 * who wants mail should not be asked to hand over inbox-read access.
 *
 * `userinfo.email` rides along so "me" resolves without asking the student to
 * type their own address. It is a non-sensitive scope, granted automatically.
 */
const GMAIL_SEND_SCOPE =
  "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email";
const GMAIL_SEND_TOKEN_KEY = "vrevamp_gmail_send_token";
// A remembered "send my reminders here" address, so a student can point mail at
// a phone-checked personal inbox rather than the account Calendar runs under.
const REMINDER_EMAIL_KEY = "vrevamp_reminder_email";

/* ===================== Sending from a vRevamp address instead ===============
 *
 * Asked for 2026-08-16: *"i asked for the mails to be sent by a specific mail
 * instead of same person to same person"*. Fair — a mail from yourself, to
 * yourself, reads like a draft you forgot to finish.
 *
 * The obstacle is that **a Chrome extension cannot hold a sender credential**.
 * Everything shipped inside it is readable by every user, so a refresh token or
 * SMTP password for a vRevamp mailbox would let anyone send mail as vRevamp,
 * and Google would suspend the account quickly. Something the users cannot read
 * has to do the sending.
 *
 * That normally means a server. It does not have to: a **Google Apps Script web
 * app** is a free endpoint, hosted by Google, that runs AS the account that
 * deployed it. Paste `tools/mail-relay.gs` into script.google.com under a
 * dedicated Gmail address, deploy it as "execute as me / anyone can access",
 * and put the /exec URL below. The mailbox credential never exists outside
 * Google, there is nothing to host, and no domain is needed — which is the
 * whole reason a plain @gmail sender is the right call here.
 *
 * Blank = off, and the gmail.send path below runs exactly as it does today, so
 * leaving it empty cannot regress anyone.
 *
 * KNOWN TRADE-OFF, do not pretend otherwise: the /exec URL ships in the
 * extension and is therefore public. Anyone who extracts it can post to it.
 * `tools/mail-relay.gs` caps sends per day and per recipient for that reason.
 * For a personal or single-campus build that is proportionate; a public Web
 * Store release would want a per-user token issued by something stateful.
 */
// >>> PASTE THE APPS SCRIPT /exec URL HERE <<<  (blank = send from the student)
const MAIL_RELAY_URL = "";
const MAIL_RELAY_KEY = "vrevamp_mail_relay_url";

/*
 * WHAT RELAY MODE COSTS THE STUDENT, precisely — asked 2026-08-16, "we do not
 * need their oauth too?":
 *
 *   📧 mail   — NO Google sign-in. Not one scope. The relay owns the sending
 *               identity, and the only unknown left is the recipient, which is
 *               asked for once in a text field and kept in that student's own
 *               chrome.storage.local. Works for a student with no Google
 *               account whatsoever.
 *   ✉️ Calendar — sign-in is UNAVOIDABLE. Writing an event into someone's
 *               Google Calendar requires that person's consent; there is no
 *               mechanism, relay or otherwise, that gets around it. The
 *               sign-in-free substitute is the 📅 one-tap TEMPLATE links,
 *               where the student presses Save themselves.
 *
 * So the relay does not remove OAuth from the extension — it removes it from
 * the mail feature, which is the feature that was asked for.
 */
async function mailRelayUrl() {
  const stored = (await chrome.storage.local.get([MAIL_RELAY_KEY]))[MAIL_RELAY_KEY];
  if (stored) return String(stored);
  return MAIL_RELAY_URL.trim() || null;
}

// btoa() is byte-oriented and throws on anything above U+00FF, which every
// vRevamp subject line hits (em dashes, emoji). TextEncoder widens to UTF-8
// bytes first. Deliberately not the `unescape(encodeURIComponent(…))` trick:
// that relies on Annex B globals, which is a needless bet inside a worker.
function b64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
const b64url = (text) => b64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Whose mailbox is this token for? Needed only to address the mail to the
// sender themselves; nothing else reads it.
async function googleSelfEmail(token) {
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const j = await r.json();
      if (j && j.email) return String(j.email);
    }
  } catch {
    /* fall through to tokeninfo */
  }
  /*
   * Second source, and not redundant: this address is also the `login_hint`
   * that makes every later refresh silent, so failing to learn it costs a
   * consent screen an hour, forever. /userinfo needs the People-ish endpoint to
   * be reachable; /tokeninfo is part of the OAuth endpoint itself and answers
   * with `email` whenever the userinfo.email scope is on the token. If both
   * fail the flow still works — it is just louder.
   */
  try {
    const r = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.email ? String(j.email) : null;
  } catch {
    return null;
  }
}

/*
 * Relay mode: the Apps Script sends, so the extension needs no send scope at
 * all — only the address to send to. That is a strictly smaller ask of every
 * student who signs in: `calendar.events` for the reminders, `userinfo.email`
 * to know where to write, and nothing that can touch a mailbox.
 */
async function sendMailViaRelay(url, { subject, html, text, to }) {
  const address = to || (await chrome.storage.local.get([REMINDER_EMAIL_KEY]))[REMINDER_EMAIL_KEY];
  // No Google sign-in on this path AT ALL. The only thing missing is where to
  // write, and asking is both cheaper and better than an OAuth round-trip:
  // it costs one text field instead of a consent screen, it works for a student
  // with no Google account, and it lets them choose the inbox they actually
  // read rather than whichever account Chrome happens to be signed into.
  // `need_address` is a signal, not an error — the page turns it into a prompt.
  if (!address) return { ok: false, to: null, error: "need_address" };

  try {
    // text/plain, not application/json: Apps Script web apps do not answer the
    // CORS preflight that a JSON content-type would trigger, so a JSON body
    // fails before it is ever sent. The script parses e.postData.contents.
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ to: address, subject, html, text }),
    });
    const out = await r.json().catch(() => null);
    if (r.ok && out && out.ok) return { ok: true, to: address, error: null };
    return {
      ok: false,
      to: address,
      error: (out && out.error) || `relay returned HTTP ${r.status}`,
    };
  } catch (error) {
    return { ok: false, to: address, error: `relay unreachable: ${String((error && error.message) || error)}` };
  }
}

// Resolves { ok, to, error }. `to` is echoed back so the button can say where
// the mail went — students routinely have two Google accounts and guess wrong.
async function sendMailAsUser({ subject, html, text, to, interactive }) {
  // a configured relay wins: it sends from the vRevamp address, and needs no
  // gmail.send consent from the student at all
  const relay = await mailRelayUrl();
  if (relay) return sendMailViaRelay(relay, { subject, html, text, to, interactive });

  const clientId = await calendarClientId();
  if (!clientId) return { ok: false, to: null, error: "not_configured" };

  const token = await googleToken({ interactive, feature: "gmail.send" });
  if (!token) {
    const why = googleAuthError();
    return {
      ok: false,
      to: null,
      // invalid_scope here is one Cloud Console checkbox, not a student error
      error: /invalid_scope/i.test(why)
        ? "gmail_send_scope"
        : why || (interactive ? "the Google consent window was closed or denied" : "not consented yet"),
    };
  }

  const stored = (await chrome.storage.local.get([REMINDER_EMAIL_KEY]))[REMINDER_EMAIL_KEY];
  const address = to || stored || (await googleSelfEmail(token));
  if (!address) return { ok: false, to: null, error: "couldn't work out which address to send to" };

  // RFC 2822. The subject is RFC 2047 encoded-word wrapped because vRevamp's
  // own subjects carry em dashes and emoji; the body is base64 for the same
  // reason. Sending both parts lets a plain-text client read it too.
  const boundary = `vrevamp-${Date.now().toString(36)}`;
  const plain = text || String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const raw = [
    `To: ${address}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(plain),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(html || plain),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  try {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: b64url(raw) }),
    });
    if (r.ok) return { ok: true, to: address, error: null };
    const j = await r.json().catch(() => ({}));
    const msg = (j && j.error && j.error.message) || `HTTP ${r.status}`;
    // "has not been used in project … before or it is disabled" — the Gmail
    // API itself is off in Cloud Console, which reads the same to the student
    // as a missing scope, so it is reported the same way.
    return {
      ok: false,
      to: address,
      error: /accessNotConfigured|has not been used|disabled/i.test(msg) ? "gmail_send_scope" : msg,
    };
  } catch (error) {
    return { ok: false, to: address, error: String((error && error.message) || error) };
  }
}

function b64urlToText(data) {
  const b64 = String(data || "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    // decodeURIComponent(escape(...)) turns the byte string into UTF-8 text
    return decodeURIComponent(
      atob(b64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
  } catch {
    return "";
  }
}

// Gmail nests parts arbitrarily; collect every text/* body it has.
function gmailBodyText(payload) {
  const out = [];
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || "";
    if (part.body && part.body.data && mime.startsWith("text/")) {
      const text = b64urlToText(part.body.data);
      out.push(mime === "text/html" ? text.replace(/<[^>]*>/g, " ") : text);
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return out.join("\n");
}

// The sender is already guaranteed by the query, so this only has to pick the
// code out of one known-good mail. Exposed for the test suite.
function otpFromMailText(text, ignore) {
  const skip = new Set((ignore || []).map(String));
  const keywords = /(\botp\b|one[\s-]*time\s*(pass(word)?|pin|code)|verification\s*code)/i;
  const re = /\b(\d{4,8})\b/g;
  let best = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    const code = m[1];
    if (skip.has(code)) continue;
    if (code.length === 4 && Number(code) >= 1900 && Number(code) <= 2100) continue;
    // "Andhra Pradesh-522241" in VTOP's own footer is six digits sitting
    // inside the same 160 chars as "One-Time Password", so a keyword nearby
    // is not enough on its own.
    if (m.index >= 2 && text[m.index - 1] === "-" && /[A-Za-z]/.test(text[m.index - 2])) continue;
    const near = text.slice(Math.max(0, m.index - 160), m.index + 160);
    if (!keywords.test(near)) continue;
    // VTOP prints the code alone on its line. Accept that, or a keyword
    // pressed right up against the digits — not merely one in the paragraph.
    const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
    const lineEnd = text.indexOf("\n", m.index);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
    const tight = text.slice(Math.max(0, m.index - 48), m.index + 48);
    if (line !== code && !keywords.test(tight)) continue;
    const score = code.length === 6 ? 2 : 0;
    if (!best || score > best.score) best = { code, score };
  }
  return best ? best.code : null;
}
self.__vrevampOtpFromMailText = otpFromMailText;

// Newest VTOP OTP mail via the API. Returns {code, ageMin} | {error}.
async function gmailFindOtp(ignore) {
  const token = await gmailToken(false);
  if (!token) return { error: "gmail-signin" };
  const auth = { Authorization: "Bearer " + token };

  const list = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=" +
    encodeURIComponent(GMAIL_QUERY),
    { headers: auth }
  );
  if (list.status === 401) {
    await chrome.storage.local.remove([GMAIL_TOKEN_KEY]);
    return { error: "gmail-signin" };
  }
  if (!list.ok) return { error: "gmail-http-" + list.status };

  const ids = ((await list.json()).messages || []).map((x) => x.id);
  if (!ids.length) return { code: null }; // signed in, nothing sent yet

  // Take the YOUNGEST usable code rather than trusting list order — the API's
  // ordering is not a promise, and picking the wrong message here is the exact
  // mistake that put an hours-old code in the box twice.
  let best = null;
  for (const id of ids) {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      { headers: auth }
    );
    if (!res.ok) continue;
    const msg = await res.json();
    const code = otpFromMailText(gmailBodyText(msg.payload), ignore);
    if (!code) continue;
    // internalDate is the real send time — no "13 minutes ago" to parse.
    // FLOOR, so the number means whole elapsed minutes: the caller treats 3 as
    // expired, and rounding 2.6 up to 3 would reject a code still in its
    // window.
    const ageMin = Math.max(
      0,
      Math.floor((Date.now() - Number(msg.internalDate || 0)) / 60000)
    );
    if (!best || ageMin < best.ageMin) best = { code, ageMin };
  }
  return best || { code: null };
}

// One scan of one webmail tab.
//
// A tab that was already open when the extension was installed or reloaded
// has an ORPHANED content script: its chrome.runtime is dead, so it answers
// nothing and sendMessage rejects. That is the state the panel used to report
// as "Reload your Gmail tab (F5)" — correct, but a poor answer, because the
// scanner can simply be put back. Inject it and ask again; only a tab that
// still cannot be reached (no host permission, a restricted page, a tab mid
// -navigation) comes back null and is reported as stale.
async function scanMailTab(tab, ignore, autoOpen) {
  const ask = () =>
    chrome.tabs.sendMessage(tab.id, {
      message: "vrevamp_scan_otp",
      ignore,
      autoOpen,
    });
  try {
    return await ask();
  } catch {
    // no scanner in this tab (yet) — put one there
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["js/otp/mail_scan.js"],
    });
  } catch {
    return null;
  }
  try {
    return await ask();
  } catch {
    return null;
  }
}

/*
 * Download state lives in chrome.storage.session (not module globals) so it
 * survives MV3 service-worker restarts between browsing a course page and
 * the download actually starting.
 */
const getDownloadState = () =>
  chrome.storage.session.get({
    det_file_name: "table_name",
    file_name: {},
    course: "",
    faculty_slot: "",
  });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * Sends a message to the content script in the VTOP tab that triggered the
 * request. webRequest events carry the exact tabId — never guess via
 * tabs.query({active:true}): the VTOP tab is often NOT the focused one
 * (user switched tabs while the page loads), and then every message was
 * silently dropped, killing all message-driven features on that tab.
 */
const returnMessage = (messageToReturn, tabId) => {
  const send = (id) =>
    chrome.tabs.sendMessage(id, { message: messageToReturn }, () => {
      // No content script listening on this page; ignore.
      void chrome.runtime.lastError;
    });
  if (typeof tabId === "number" && tabId >= 0) {
    send(tabId);
    return;
  }
  // request not tied to a tab — fall back to any open VTOP tab
  chrome.tabs.query({ url: VTOP_URLS }, (tabs) => {
    (tabs || []).forEach((tab) => send(tab.id));
  });
};

//Trigger download from course_page
const trigger_download = async (request) => {
  const state = await getDownloadState();
  request.message.link_data.forEach((link) => {
    state.file_name[link.url] = link.title;
  });
  await chrome.storage.session.set({
    course: request.message.course,
    faculty_slot: request.message.faculty_slot,
    file_name: state.file_name,
  });
  request.message.link_data.forEach((link) => {
    chrome.downloads.download({
      url: link.url,
      conflictAction: "overwrite",
    });
  });
};

// "<index>-<topic>-<slot>.<ext>" built from the faculty's uploaded file name
const faculty_upload_name = (fname, file_extension, table_title) => {
  const index = table_title.split("-")[0] + "-";
  const parts = fname.split("_");
  let title = "";
  for (let i = 8; i < parts.length; i++) {
    title += parts[i] + " ";
  }
  return index + title.split(".")[0] + "-" + parts[7] + file_extension;
};

//Gives the file name
const get_file_name = (fname, url, state) => {
  // splits after the eighth occurrence of '_'
  let file_extension = fname.replace(/([^_]*_){8}/, "").split(".");
  file_extension = "." + file_extension[file_extension.length - 1];
  const table_title = state.file_name[url] || "";
  if (state.det_file_name === "table_name") {
    const file_prefix = table_title.split("\n")[0];
    if (file_prefix.length >= 4) {
      return file_prefix + file_extension;
    }
  }
  return faculty_upload_name(fname, file_extension, table_title);
};

//Change File Name for the file
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.url.indexOf("vtop") === -1) return;
  getDownloadState().then((state) => {
    const title = get_file_name(item.filename, item.url, state);
    if (state.course !== "" && state.faculty_slot !== "") {
      suggest({
        filename:
          "VIT Downloads/" +
          state.course.replace(":", "") +
          "/" +
          state.faculty_slot +
          "/" +
          title,
      });
    } else {
      suggest({ filename: "VIT Downloads/Other Downloads/" + title });
    }
  });
  return true; // suggest() is called asynchronously
});

/* Fires after the completion of a request */
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const link = details["url"];
    // deliver to the tab that made this request, not the focused tab
    const notify = (m) => returnMessage(m, details.tabId);
    // NOTE: "showOfflineIcon" used to be broadcast here, i.e. once per
    // COMPLETED REQUEST — every image, stylesheet, script and XHR. A single
    // VTOP page load is 50-100 requests, and each message wakes all ~17
    // content-script onMessage listeners in the tab, so one page load cost
    // well over a thousand listener invocations. That is the same budget that
    // produced the "Page Unresponsive" freeze in 8055f0e. The icon needs no
    // message at all: showOfflineIcon.js renders itself on load and is
    // idempotent.
    if (link.indexOf("doStudentMarkView") !== -1) {
      notify("mark_view_page");
    } else if (link.indexOf("StudentTimeTable") !== -1) {
      notify("timetable_view_page");
    } else if (
      // NOT the per-subject detail endpoints (…AttendanceDetail /
      // …DetailDisplay): those fire for every row the insights script
      // fetches, and routing them here re-runs the page scripts in a loop
      (link.indexOf("processViewStudentAttendance") !== -1 &&
        link.indexOf("processViewStudentAttendanceDetail") === -1) ||
      link.indexOf("processBackAttendanceDetails") !== -1
    ) {
      notify("view_attendance");
    } else if (
      link.indexOf("StudentAttendance") !== -1 &&
      link.indexOf("Detail") === -1 &&
      link.indexOf("Display") === -1
    ) {
      notify("view_attendance_page");
    } else if (link.indexOf("processViewStudentCourseDetail") !== -1) {
      notify("course_page_change");
    } else if (link.indexOf("doDigitalAssignment") !== -1) {
      notify("da_upload");
      // NOTE: "vtopcc_captcha" / "vtop2_captcha" used to be broadcast for
      // .../vtop/vtopLogin here. Nothing has ever listened for either —
      // js/captcha/captchaparser.js is a separate content_scripts entry that
      // runs itself off window "load" and registers no onMessage handler. The
      // branches only cost a wake-up of all ~17 listeners per login request.
    } else if (link.indexOf("hrms/employeeSearchForStudent") !== -1) {
      notify("employee_search");
    } else if (link.indexOf("hostel/StudentWeekendOuting") !== -1) {
      notify("weekend_outings");
    } else if (
      link.indexOf("vtop/doLogin") !== -1 ||
      link.indexOf("assets/img/favicon.png") !== -1 ||
      link.indexOf("goHomePage") !== -1
    ) {
      notify("vtop2_nav_bar");
    } else if (link.indexOf("doSearchExamScheduleForStudent") !== -1) {
      notify("exam_schedule");
    } else if (
      link.indexOf("examGradeView/doStudentGradeView") !== -1 ||
      link.indexOf("examGradeView/getGradeViewDetail") !== -1
    ) {
      notify("exam_grade");
    } else if (link.indexOf("menu.js") !== -1 || link.indexOf("home") !== -1) {
      if (link.indexOf("menu.js") !== -1) await sleep(3500);
      notify("nav_bar_change");
    }
  },
  {
    urls: VTOP_URLS,
  }
);

/*
 * Local reminders — Chrome-native notifications via chrome.alarms, no Google
 * account needed. Content scripts send { message: "schedule_local_reminders",
 * tag, reminders: [{ when(ms), title, body }] }; re-scheduling with the same
 * tag replaces that tag's previous reminders instead of stacking duplicates.
 * Alarms survive browser restarts; ones missed while Chrome was closed fire
 * once at the next launch.
 */
const REMINDERS_KEY = "vrevamp_local_reminders";

const scheduleLocalReminders = async (tag, reminders) => {
  const safeTag = String(tag || "misc").replace(/[^\w:-]/g, "");
  const prefix = `vrrem|${safeTag}|`;
  const store =
    (await chrome.storage.local.get(REMINDERS_KEY))[REMINDERS_KEY] || {};
  for (const alarm of await chrome.alarms.getAll()) {
    if (alarm.name.startsWith(prefix)) await chrome.alarms.clear(alarm.name);
  }
  for (const name of Object.keys(store)) {
    if (name.startsWith(prefix)) delete store[name];
  }
  const now = Date.now();
  let scheduled = 0;
  for (const item of reminders) {
    if (!item || typeof item.when !== "number" || item.when <= now + 60000)
      continue; // already past (or about to be)
    const name = `${prefix}${++scheduled}`;
    store[name] = {
      title: String(item.title || "vRevamp reminder").slice(0, 150),
      body: String(item.body || "").slice(0, 500),
      when: item.when,
    };
    chrome.alarms.create(name, { when: item.when });
  }
  await chrome.storage.local.set({ [REMINDERS_KEY]: store });
  return scheduled;
};

/* ===================== The daily digest ====================================
 *
 * Asked for 2026-08-17: "i need mail notifications and all", about assignments
 * and bunkable classes.
 *
 * Everything needed already existed and none of it ever reached the student.
 * Attendance percentages, upcoming dues and exam dates were each computed by a
 * content script and then left in that page — so the only way to learn that an
 * assignment was due tomorrow was to open the DA page and read a cell, which
 * is precisely the thing a reminder is supposed to replace. The per-course 🔔
 * helped only if you had already gone and looked.
 *
 * This closes the loop. Once a day the worker reads the three snapshots the
 * pages leave behind and sends one message: what is due, what is overdue,
 * which subjects are near 75%, and which exams are close. It runs whether or
 * not VTOP is open, because it reads storage rather than the DOM.
 *
 * Honest limit, stated because it will otherwise be mistaken for a bug: those
 * snapshots are only as fresh as the last visit to each page. The digest says
 * how old its data is and stops asserting anything once it is stale, rather
 * than quietly reporting last month's attendance as today's. VTOP cannot be
 * scraped in the background — it needs the session in a real tab, and driving
 * it from here is what breaks sessions (ROADMAP #4).
 */
const DIGEST_KEY = "vrevamp_digest";
const DIGEST_ALARM = "vrevamp|digest";
const DIGEST_DEFAULT_HOUR = 7;
const STALE_DAYS = 14;

const digestSettings = async () => {
  const stored = (await chrome.storage.local.get([DIGEST_KEY]))[DIGEST_KEY] || {};
  return { enabled: !!stored.enabled, hour: Number(stored.hour) || DIGEST_DEFAULT_HOUR };
};

const nextDigestTime = (hour) => {
  const when = new Date();
  when.setHours(hour, 0, 0, 0);
  if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
  return when.getTime();
};

const setDigest = async (enabled, hour) => {
  const settings = {
    enabled: !!enabled,
    hour: Number.isInteger(hour) ? hour : (await digestSettings()).hour,
  };
  await chrome.storage.local.set({ [DIGEST_KEY]: settings });
  await chrome.alarms.clear(DIGEST_ALARM);
  if (settings.enabled) {
    chrome.alarms.create(DIGEST_ALARM, {
      when: nextDigestTime(settings.hour),
      periodInMinutes: 24 * 60,
    });
  }
  return settings;
};

const daysBetween = (iso) => {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return null;
  const then = new Date(y, m - 1, d).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  return Math.round((then - today) / 86400000);
};

const ageInDays = (ms) => (ms ? Math.floor((Date.now() - ms) / 86400000) : null);

// { subject, html, text, urgent } — `urgent` decides whether the Chrome
// notification is worth raising at all, so a quiet day stays quiet.
async function buildDigest() {
  const store = await chrome.storage.local.get([
    "vrevamp_da_dues",
    "vrevamp_attendance_summary",
    "vrevamp_exam_schedule",
  ]);

  const sections = [];
  // Footnotes that are true but are never, on their own, worth a mail.
  const notes = [];
  const plain = [];
  const headline = [];
  let urgent = false;

  /* --- assignments --- */
  const dues = store.vrevamp_da_dues;
  const duesAge = ageInDays(dues && dues.fetchedAt);
  if (dues && duesAge !== null && duesAge <= STALE_DAYS) {
    const upcoming = [];
    let overdue = 0;
    (dues.courses || []).forEach((course) => {
      overdue += (course.overdue || []).length;
      (course.upcoming || []).forEach((item) => {
        const left = daysBetween(dueIsoOf(item.due));
        if (left === null || left < 0) return;
        upcoming.push({ ...item, code: course.code, left });
      });
    });
    upcoming.sort((a, b) => a.left - b.left);
    if (upcoming.length) {
      if (upcoming[0].left <= 2) urgent = true;
      headline.push(
        upcoming[0].left === 0
          ? `${upcoming[0].code} due TODAY`
          : `${upcoming[0].code} due in ${upcoming[0].left}d`
      );
      sections.push(
        "<h3>Assignments still to upload</h3><ul>" +
          upcoming
            .map(
              (a) =>
                `<li><b>${a.code}</b> — ${a.title}<br>due ${a.due} · ` +
                (a.left === 0 ? "<b>today</b>" : `${a.left} day(s) left`) +
                "</li>"
            )
            .join("") +
          "</ul>"
      );
      plain.push(
        "ASSIGNMENTS\n" +
          upcoming.map((a) => `  ${a.due}  ${a.code} — ${a.title} (${a.left}d)`).join("\n")
      );
    }
    if (overdue) {
      urgent = true;
      sections.push(`<p><b>${overdue} assignment(s) are past due and were never uploaded.</b></p>`);
      plain.push(`${overdue} assignment(s) past due, never uploaded.`);
    }
  }

  /* --- attendance --- */
  const attendance = store.vrevamp_attendance_summary;
  const attAge = ageInDays(attendance && attendance.fetchedAt);
  if (attendance && attAge !== null && attAge <= STALE_DAYS) {
    const subjects = (attendance.subjects || []).filter((s) => typeof s.pct === "number");
    const risky = subjects.filter((s) => s.pct < 80).sort((a, b) => a.pct - b.pct);
    if (risky.length) {
      if (risky[0].pct < 75) urgent = true;
      headline.push(`${risky[0].name.split(" ")[0]} at ${risky[0].pct}%`);
      /*
       * The same correction the home card got: a student ALREADY under 75% is
       * not helped by "cannot skip any more" — they are past that, and the only
       * number they can act on is how many in a row get them back over the
       * line. `recover` / `canRecover` come from the same snapshot.
       */
      const verdict = (s) => {
        if (s.below75 || s.pct < 75) {
          if (s.canRecover === false)
            return ` · <b>attending everything still only reaches ${
              typeof s.maxPct === "number" ? `${s.maxPct}%` : "under 75%"
            }</b> — talk to the faculty`;
          return typeof s.recover === "number" && s.recover > 0
            ? ` · <b>debarred unless you attend the next ${s.recover} ${s.unit || "class(es)"}</b>`
            : " · <b>below 75%</b>";
        }
        if (typeof s.safeNow !== "number") return "";
        return s.safeNow > 0
          ? ` · ${s.safeNow} ${s.unit || "class(es)"} left before you drop under 75%`
          : " · <b>no room left — one more absence puts you under 75%</b>";
      };
      sections.push(
        "<h3>Attendance worth watching</h3><ul>" +
          risky.map((s) => `<li><b>${s.name}</b> — ${s.pct}%${verdict(s)}</li>`).join("") +
          "</ul>"
      );
      plain.push(
        "ATTENDANCE\n" +
          risky
            .map(
              (s) =>
                `  ${s.pct}%  ${s.name}${verdict(s).replace(/<\/?b>/g, "").replace(/^ · /, " — ")}`
            )
            .join("\n")
      );
    }
    const safe = subjects.filter((s) => typeof s.safeNow === "number" && s.safeNow > 0);
    if (safe.length && !risky.length) {
      sections.push(
        "<h3>Free to skip today</h3><ul>" +
          safe
            .map((s) => `<li>${s.name} — ${s.safeNow} ${s.unit || "class(es)"} in hand</li>`)
            .join("") +
          "</ul>"
      );
      plain.push("CAN SKIP\n" + safe.map((s) => `  ${s.safeNow}  ${s.name}`).join("\n"));
    }
  } else if (attendance) {
    /*
     * A RIDER, NOT A REASON TO MAIL. This used to push into `sections`, and
     * `sections.length` is the test for "is there anything to say" — so a
     * student who had not opened the attendance page in a fortnight got a mail
     * EVERY MORNING whose entire content was "your figures are 40 days old".
     * That is how a digest gets muted, and a muted digest takes the one that
     * mattered with it. It rides along on a digest that has real news, and
     * otherwise says nothing.
     */
    notes.push(
      `<p style="color:#777">Attendance figures are ${attAge} days old — open the VTOP attendance page to refresh them.</p>`
    );
  }

  /* --- exams --- */
  const exams = store.vrevamp_exam_schedule;
  if (exams && Array.isArray(exams.exams)) {
    const soon = exams.exams
      .map((e) => ({ ...e, left: daysBetween(e.dateIso) }))
      .filter((e) => e.left !== null && e.left >= 0 && e.left <= 10)
      .sort((a, b) => a.left - b.left);
    if (soon.length) {
      if (soon[0].left <= 1) urgent = true;
      headline.push(`${soon[0].code} exam in ${soon[0].left}d`);
      sections.push(
        "<h3>Exams in the next 10 days</h3><ul>" +
          soon
            .map(
              (e) =>
                `<li><b>${e.code}</b> ${e.title || ""} — ${e.dateIso} ${e.start || ""}` +
                (e.venue ? ` · ${e.venue}` : "") +
                (e.seatNo ? ` · seat ${e.seatNo}` : "") +
                ` · in ${e.left} day(s)</li>`
            )
            .join("") +
          "</ul>"
      );
      plain.push(
        "EXAMS\n" + soon.map((e) => `  ${e.dateIso}  ${e.code} (${e.left}d)`).join("\n")
      );
    }
  }

  if (!sections.length) return null; // nothing to say — say nothing

  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
  return {
    subject: `vRevamp — ${headline.slice(0, 2).join(", ") || "your day"} (${today})`,
    html:
      `<div style="font-family:system-ui,sans-serif;max-width:560px">` +
      `<p>Here's where things stand, ${today}.</p>` +
      sections.join("") +
      notes.join("") +
      `<p style="color:#888;font-size:12px">Built from what VTOP showed the last time you opened each page. ` +
      `Reply-free automated message from the vRevamp extension — turn it off with the 📬 button on the digital assignments page.</p></div>`,
    text: plain.join("\n\n"),
    urgent,
    headline: headline.join(" · "),
  };
}

// VTOP prints "17-Aug-2026"; everything downstream wants an ISO day.
function dueIsoOf(due) {
  const m = String(due).trim().match(/^(\d{1,2})-([A-Za-z]{3,4})-(\d{4})$/);
  const months = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", sept: "09", oct: "10", nov: "11", dec: "12",
  };
  if (!m) return String(due);
  const mm = months[m[2].toLowerCase()];
  if (!mm) return String(due);
  return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
}

async function runDigest() {
  const digest = await buildDigest();
  if (!digest) return { sent: false, reason: "nothing to report" };

  // The notification goes out first and unconditionally: it needs no account,
  // no scope and no network, so a failed mail must never cost the student the
  // reminder itself.
  chrome.notifications.create(`vrdigest|${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("assets/icons/img_128.png"),
    title: digest.urgent ? "vRevamp — needs attention today" : "vRevamp — today's summary",
    message: digest.headline || "Open VTOP for details",
    priority: digest.urgent ? 2 : 1,
    requireInteraction: !!digest.urgent,
  });

  // Never interactive. A consent window that opens by itself at 7 am, with no
  // click behind it, is indistinguishable from malware — if the grant has
  // lapsed the digest simply stays a notification until the next manual send.
  const mail = await sendMailAsUser({
    subject: digest.subject,
    html: digest.html,
    text: digest.text,
    interactive: false,
  });
  return { sent: mail.ok, reason: mail.error || null, to: mail.to };
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === DIGEST_ALARM) {
    try {
      await runDigest();
    } catch (error) {
      console.warn("vRevamp digest", error);
    }
    return;
  }
  if (!alarm.name.startsWith("vrrem|")) return;
  const store =
    (await chrome.storage.local.get(REMINDERS_KEY))[REMINDERS_KEY] || {};
  const reminder = store[alarm.name];
  if (!reminder) return;
  chrome.notifications.create(alarm.name, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("assets/icons/img_128.png"),
    title: reminder.title,
    message: reminder.body,
    priority: 2,
    requireInteraction: true,
  });
  delete store[alarm.name];
  await chrome.storage.local.set({ [REMINDERS_KEY]: store });
});

// Resolves when the tab finishes loading (status "complete"), or after
// timeoutMs — Google Calendar's TEMPLATE URL redirects to the event editor,
// so "complete" fires on the editor page.
const waitTabComplete = (tabId, timeoutMs) =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.status === "complete") finish();
    });
    setTimeout(finish, timeoutMs);
  });

// Injected (MAIN world) into a prefilled Google Calendar event editor:
// wait for the Save button, click it, wait for the editor to close.
// Locale note: matches the English label — non-English Google accounts fall
// back to the one-tap panel (the click simply never lands and this returns
// "no-button").
const gcalClickSave = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Verified against the live editor 2026-08-09: Save is a real
  // <button aria-label="Save">, exactly one match among ~55 candidates. The
  // [role="button"] arm is defensive breadth for a UI that uses div-buttons
  // elsewhere — NOT a bug that was observed. An earlier version of this comment
  // claimed the div form was why imports failed; that was wrong, and the import
  // was in fact working the whole time.
  const findSave = () =>
    Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => {
      const text = (b.textContent || "").trim();
      const label = (b.getAttribute("aria-label") || "").trim();
      // \b keeps "Saved" (a status, not a control) from matching
      return /^save\b/i.test(text) || /^save\b/i.test(label);
    });
  let btn = null;
  for (let t = 0; t < 15000 && !(btn = findSave()); t += 300) await sleep(300);
  if (!btn) return "no-button";

  // A TEMPLATE link lands on /calendar/u/0/r/eventedit?... (verified live), so
  // leaving that path is Google acknowledging the write.
  //
  // `hadEditUrl` matters: the old code asked "is the path free of eventedit?"
  // without checking it was ever there, and that is a condition which can be
  // true before the click — on any page that never used an eventedit URL it
  // reports success instantly, having proved nothing. A signal only counts if
  // it CHANGED. Losing the Save button is the second acceptable signal, for a
  // UI that writes the event without moving the URL.
  const hadEditUrl = location.pathname.includes("eventedit");
  btn.click();
  for (let t = 0; t < 20000; t += 300) {
    await sleep(300);
    if (hadEditUrl && !location.pathname.includes("eventedit")) return "saved";
    if (!findSave()) return "saved";
  }
  return "stuck";
};

/*
 * Guided import: wait for the STUDENT to press Save in a tab they can see.
 *
 * Resolves "saved" when the editor navigates away from /eventedit (Google's
 * own signal that the event was created), "closed" if they close the tab —
 * which is the natural cancel gesture and must stop the run, because opening
 * more tabs at someone who is closing them is the exact behaviour being fixed.
 *
 * Polling, not one long sleep, on purpose: every chrome.* call resets the MV3
 * worker's idle timer, so a student who takes two minutes over the first event
 * does not get the worker suspended out from under them.
 */
const waitGcalSaved = async (tabId, timeoutMs) => {
  const step = 900;
  let entered = false;
  for (let t = 0; t < timeoutMs; t += step) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return "closed";
    }
    // The TEMPLATE url redirects into /eventedit and leaves it on save
    // (verified live 2026-08-09), so the URL alone is enough — no need to
    // inject a probe into the page once a second.
    const url = tab.url || "";
    if (url.includes("eventedit")) entered = true;
    else if (entered) return "saved";
    // never reached the editor at all — usually no Google session in this
    // profile, so the student was bounced to a sign-in page
    else if (t > 25000 && /accounts\.google\.com/.test(url)) return "no-editor";
    await new Promise((r) => setTimeout(r, step));
  }
  return "timeout";
};

//Routes the messages from content scripts and the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const msg = request && request.message;

  // Download request from course_page: { course, faculty_slot, link_data }
  if (msg && typeof msg === "object" && Array.isArray(msg.link_data)) {
    if (msg.course !== "") trigger_download(request);
    return;
  }

  switch (msg) {
    case "table_name":
    case "fac_upload_name":
      chrome.storage.session.set({ det_file_name: msg });
      break;
    case "showOfflinePage":
      viewOfflinePage();
      break;
    // NOTE: "login" and "logout" cases lived here for the popup's Google
    // sign-in / Sign Out buttons. Both buttons are commented out in
    // html/popup.html and js/popup.js binds neither, so nothing has sent
    // either message for a long time; "login" was superseded by
    // "get_google_token" below, which mints interactively on demand.
    // Access tokens expire after ~1 h, so the one stored at popup-login time
    // is stale by the time a 🔔 is clicked. Content scripts ask here for a
    // fresh one at click time — chrome.identity refreshes it silently once
    // the user has consented. `stale` invalidates a token a 401 proved dead.
    case "get_google_token": {
      // ONE route: launchWebAuthFlow on CALENDAR_CLIENT_ID, the same mechanism
      // the Gmail OTP feature runs on. Every caller (timetable import, exam ✉️,
      // DA ✉) asks through this message, so they all share its consent.
      //
      // The old `chrome.identity.getAuthToken` fallback on
      // manifest.oauth2.client_id is GONE. That is upstream's client and it is
      // dead ("bad client id") for every user of this build, so the fallback
      // could only ever produce an error — and because the content scripts
      // pattern-matched that error into "this build's OAuth client id is dead",
      // one stale build was enough to make a working sign-in look permanently
      // broken. A missing client id now says exactly that instead.
      calendarClientId().then((id) => {
        if (!id) {
          sendResponse({ token: null, error: "not_configured" });
          return;
        }
        calendarToken({ interactive: !!request.interactive, stale: request.stale }).then(
          (token) => {
            const why = googleAuthError();
            sendResponse({
              token: token || null,
              error: token
                ? null
                : // Google's own words first: "invalid_scope" here means
                  // calendar.events was never added to the consent screen (or
                  // the Calendar API is not enabled), which no amount of
                  // clicking Allow will fix.
                  why ||
                  (request.interactive
                    ? "the Google consent window was closed or denied"
                    : "not consented yet"),
            });
          },
          (error) => sendResponse({ token: null, error: String((error && error.message) || error) })
        );
      });
      return true;
    }
    // A real email, sent now, from the student's own Gmail — the companion to
    // the ✉️ buttons' "Calendar will mail you a day before". See
    // sendMailAsUser() for why this is a separate scope and token.
    // Where the student wants vRevamp's mail. Stored per-browser; the relay is
    // told it per request and keeps no list of its own.
    // Who vRevamp is signed in as, and where its mail is pointed. Lets a page
    // say "signed in as x@gmail.com" instead of leaving the student guessing
    // which of their accounts approved the last consent screen.
    case "google_status":
      (async () => {
        const local = await chrome.storage.local.get([APP_TOKEN_KEY, GRANTED_KEY]);
        const cached = local[APP_TOKEN_KEY];
        const digest = await digestSettings();
        sendResponse({
          account: await googleHint(),
          // `signedIn` used to mean "there is an unexpired access token", which
          // is false for most of any given day and made a perfectly healthy
          // grant read as "needs re-approval" in the popup. An access token
          // lasting an hour is how the implicit flow WORKS; what the student
          // wants to know is whether the grant is still on record, because that
          // is what decides whether the next click is silent.
          signedIn: !!local[GRANTED_KEY],
          tokenFresh: !!(cached && cached.token && cached.exp > Date.now()),
          tokenExpires: cached && cached.exp ? cached.exp : null,
          reminderEmail:
            (await chrome.storage.local.get([REMINDER_EMAIL_KEY]))[REMINDER_EMAIL_KEY] || null,
          relay: !!(await mailRelayUrl()),
          relayUrl: (await mailRelayUrl()) || "",
          digest: digest.enabled,
          digestHour: digest.hour,
        });
      })();
      return true;
    /*
     * Point mail at an Apps Script relay without editing the source.
     *
     * MAIL_RELAY_URL was a hardcoded blank constant, so switching relay mode
     * on meant editing background.js and reloading the extension — fine for
     * whoever wrote it, impossible for anyone who installed it. The URL is
     * CHECKED before it is stored: the script answers a GET with
     * {"ok":true,"service":"vRevamp mail relay"}, so a typo or a
     * not-yet-deployed script is caught here rather than silently swallowing
     * every mail from then on.
     */
    case "set_mail_relay":
      (async () => {
        const url = String(request.url || "").trim();
        if (!url) {
          await chrome.storage.local.remove([MAIL_RELAY_KEY]);
          sendResponse({ ok: true, url: "" });
          return;
        }
        if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec/.test(url)) {
          sendResponse({
            ok: false,
            error: "that isn't an Apps Script /exec URL — it should end in /exec",
          });
          return;
        }
        try {
          const probe = await fetch(url, { method: "GET" });
          const body = await probe.json().catch(() => null);
          if (!probe.ok || !body || !body.ok) {
            sendResponse({
              ok: false,
              error: `the script answered HTTP ${probe.status} instead of {"ok":true} — check it is deployed with access "Anyone"`,
            });
            return;
          }
        } catch (error) {
          sendResponse({
            ok: false,
            error: `couldn't reach the script (${String((error && error.message) || error)})`,
          });
          return;
        }
        await chrome.storage.local.set({ [MAIL_RELAY_KEY]: url });
        sendResponse({ ok: true, url });
      })();
      return true;
    // Switch the daily digest on or off, and prove it works by sending one
    // immediately — a scheduled feature whose first evidence arrives tomorrow
    // morning is a feature nobody can tell is broken.
    case "set_daily_digest":
      (async () => {
        const settings = await setDigest(request.enabled, request.hour);
        let to = (await chrome.storage.local.get([REMINDER_EMAIL_KEY]))[REMINDER_EMAIL_KEY] || null;
        if (settings.enabled) {
          const run = await runDigest().catch(() => ({ sent: false }));
          if (run && run.to) to = run.to;
        }
        sendResponse({ ok: true, enabled: settings.enabled, hour: settings.hour, to });
      })();
      return true;
    // Drop the tokens AND the remembered account, so the next click shows the
    // chooser again. The grant on Google's side is untouched — this is "use a
    // different account", not "revoke access", which belongs in Google's own
    // security settings and should not be done behind the student's back.
    case "google_sign_out":
      forgetGoogleTokens().then(
        () => sendResponse({ ok: true }),
        (error) => sendResponse({ ok: false, error: String((error && error.message) || error) })
      );
      return true;
    case "set_reminder_email": {
      const address = String(request.address || "").trim();
      if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(address)) {
        sendResponse({ ok: false, error: "that doesn't look like an email address" });
        return true;
      }
      // promise form, not the callback overload: MV3 returns a promise when no
      // callback is passed, and this way a storage failure is actually reported
      // instead of the caller waiting for a reply that never comes
      Promise.resolve(chrome.storage.local.set({ [REMINDER_EMAIL_KEY]: address })).then(
        () => sendResponse({ ok: true, address }),
        (error) => sendResponse({ ok: false, error: String((error && error.message) || error) })
      );
      return true;
    }
    case "send_mail":
      sendMailAsUser({
        subject: request.subject || "vRevamp",
        html: request.html || "",
        text: request.text || "",
        to: request.to || null,
        interactive: request.interactive !== false,
      }).then(
        (r) => sendResponse(r),
        (error) =>
          sendResponse({ ok: false, to: null, error: String((error && error.message) || error) })
      );
      return true;
    // One-click no-OAuth timetable import: for each prefilled
    // calendar.google.com/render?action=TEMPLATE link, open a background
    // tab, press its Save button, close it. Google's own Import page never
    // renders since the 2026 Calendar revamp and the extension's OAuth
    // client is dead, so the worker drives the editor the user would
    // otherwise click through by hand (needs the calendar.google.com host
    // permission + "scripting"). Progress is streamed back to the sending
    // tab so the button can count along.
    case "gcal_template_import":
      (async () => {
        const urls = Array.isArray(request.urls) ? request.urls.slice(0, 60) : [];
        const origin = sender && sender.tab ? sender.tab.id : null;
        let saved = 0;
        let failed = 0;
        let lastError = null; // surfaced in the button note on total failure
        for (let i = 0; i < urls.length; i++) {
          let tab = null;
          try {
            tab = await chrome.tabs.create({ url: urls[i], active: false });
            await waitTabComplete(tab.id, 20000);
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: "MAIN",
              func: gcalClickSave,
            });
            const out = results && results[0] ? results[0].result : "no-result";
            if (out === "saved") saved++;
            else {
              failed++;
              lastError = out;
            }
          } catch (error) {
            console.warn("gcal_template_import", urls[i], error);
            failed++;
            lastError = String((error && error.message) || error);
          }
          if (tab)
            try {
              await chrome.tabs.remove(tab.id);
            } catch (error) {
              /* already closed */
            }
          if (origin !== null)
            try {
              chrome.tabs.sendMessage(origin, {
                message: "gcal_template_progress",
                done: i + 1,
                total: urls.length,
                saved,
              });
            } catch (error) {
              /* originating tab gone — keep importing */
            }
          // Stop strobing. A "no-button" means this Google UI does not expose a
          // Save control we can find — that is structural, it will fail
          // identically on all 40 classes, so bail on the FIRST one rather than
          // flashing tabs past the student. Timeouts can be transient, so those
          // still get three tries.
          if (saved === 0 && (lastError === "no-button" || failed >= 3)) break;
        }
        sendResponse({ saved, failed, total: urls.length, lastError });
      })();
      return true; // async sendResponse
    /*
     * The same TEMPLATE links, paced by the student instead of by us: one tab
     * at a time, in the FOREGROUND, and the next one does not open until this
     * one is saved. Slower by design. The automatic path above is a background
     * strobe — when it cannot press Save it is worse than useless, because it
     * also denies the student the chance to press Save themselves.
     */
    case "gcal_guided_import":
      (async () => {
        const urls = Array.isArray(request.urls) ? request.urls.slice(0, 60) : [];
        const origin = sender && sender.tab ? sender.tab.id : null;
        let saved = 0;
        let stopped = null;
        for (let i = 0; i < urls.length && !stopped; i++) {
          let tab = null;
          try {
            tab = await chrome.tabs.create({ url: urls[i], active: true });
            await waitTabComplete(tab.id, 20000);
            const outcome = await waitGcalSaved(tab.id, 10 * 60 * 1000);
            if (outcome === "saved") saved++;
            else stopped = outcome; // closed / timeout / no-editor
          } catch (error) {
            console.warn("gcal_guided_import", urls[i], error);
            stopped = String((error && error.message) || error);
          }
          // "closed" means it is already gone, and closing it again would race
          // with whatever the student clicked next
          if (tab && stopped !== "closed")
            try {
              await chrome.tabs.remove(tab.id);
            } catch (error) {
              /* already closed */
            }
          if (origin !== null)
            try {
              chrome.tabs.sendMessage(origin, {
                message: "gcal_template_progress",
                done: i + 1,
                total: urls.length,
                saved,
                guided: true,
              });
            } catch (error) {
              /* originating tab gone — the run still stands */
            }
        }
        sendResponse({ saved, total: urls.length, stopped, guided: true });
      })();
      return true; // async sendResponse
    // NOTE: an "ics_import_fallback" case sat here — download the built .ics,
    // then open Google Calendar's Import page. It was kept "for content
    // scripts from before 2026-07-18 that outlive a worker update", but that
    // can't happen: updating the extension orphans old content scripts and
    // invalidates their chrome.runtime, so they cannot send anything. No
    // current caller either — the sign-in-free path is the one-tap TEMPLATE
    // links in timetable_ics.js, because Google's 2026 revamp broke
    // /r/settings/import outright (it never renders).
    case "schedule_local_reminders":
      scheduleLocalReminders(
        request.tag,
        Array.isArray(request.reminders) ? request.reminders : []
      )
        .then(sendResponse)
        .catch(() => sendResponse(null));
      return true; // async sendResponse
    // session_repair.js detected a poisoned session cookie (Tomcat 404 with
    // cookies, 200 without): clear the requesting site's cookies so the next
    // load starts a fresh session
    case "clear_site_cookies":
      (async () => {
        try {
          const url = sender && sender.url;
          if (!url || !/^https:\/\/[^/]*(vitap|vit)\.ac\.in\//.test(url)) {
            sendResponse(false);
            return;
          }
          const cookies = await chrome.cookies.getAll({ url });
          await Promise.all(
            cookies.map((c) => chrome.cookies.remove({ url, name: c.name }))
          );
          sendResponse(cookies.length || true);
        } catch {
          sendResponse(false);
        }
      })();
      return true; // async sendResponse
    // js/vtop_otp.js is waiting on the login OTP: ask every open webmail tab
    // to scan itself and hand back the first unseen code. One scan per call —
    // the polling loop lives in the content script, because an MV3 worker can
    // be torn down mid-wait and a loop parked here would die with it.
    case "vrevamp_get_otp":
      (async () => {
        try {
          // Only the VTOP login pages may trigger a mail read. http is allowed
          // because the content_scripts matches are `*://` — a page served
          // over http is still the VTOP page, and nothing but our own content
          // scripts can reach this listener in the first place.
          const from = (sender && sender.url) || "";
          if (!/^https?:\/\/[^/]*(vitap|vit)\.ac\.in\/vtop\//.test(from)) {
            sendResponse({ error: "forbidden" });
            return;
          }
          const ignore = Array.isArray(request.ignore) ? request.ignore : [];

          // Gmail API first when it's set up: it reads the message itself, so
          // no mail tab need be open and nothing depends on what Gmail chose
          // to render. Any failure falls through to the scraper below rather
          // than breaking a route that already works.
          //
          // This runs BEFORE the mail-tab check on purpose. Behind that check
          // it could never fire for the users it exists to serve — "no mail
          // tab need be open" was exactly the promise a `return` above it
          // broke — and the sign-in button, which is the way out of that
          // state, could never be offered either.
          let gmail = null;
          try {
            gmail = await gmailFindOtp(ignore);
          } catch {
            gmail = { error: "gmail-failed" };
          }
          if (gmail && gmail.code) {
            sendResponse({ code: gmail.code, ageMin: gmail.ageMin, via: "gmail" });
            return;
          }
          // Offer sign-in ONLY when a client id exists and consent is what's
          // missing. With GMAIL_CLIENT_ID blank nobody ever sees the button,
          // which matters because an unconfigured install could never make it
          // work anyway.
          const needsSignIn =
            !!(await gmailClientId()) && !!gmail && gmail.error === "gmail-signin";
          // Signed in and reading the mailbox directly, just no OTP mail yet.
          // Whether a mail tab happens to be open is irrelevant then.
          const gmailReading = !!gmail && !gmail.error;

          const tabs = await chrome.tabs.query({ url: MAIL_TAB_PATTERNS });
          if (!tabs.length) {
            if (gmailReading) {
              // keep the caller polling — the mail is simply not sent yet
              sendResponse({ code: null, needsSignIn, via: "gmail" });
              return;
            }
            sendResponse({ error: "no-mail-tab", needsSignIn });
            return;
          }

          // A browser signed into a personal AND a student Google account has
          // a tab for each, and only one of them ever holds VTOP's mail. Once
          // we have learned which mailbox that is, scan ONLY it: there is no
          // reason for this to keep reading a personal inbox. The learned
          // value is a /mail/u/<n>/ prefix, so it survives navigation within
          // the mailbox. Fall back to all tabs when the learned one isn't
          // open, otherwise a closed tab would break the feature outright.
          const learnedKey = "vrevamp_otp_mailbox";
          const learned = (await chrome.storage.local.get([learnedKey]))[learnedKey];
          const preferred = learned
            ? tabs.filter((t) => (t.url || "").startsWith(learned))
            : [];
          const scanning = preferred.length ? preferred : tabs;

          // Ask every candidate tab, then take the YOUNGEST code rather than
          // the first tab that answers — a code expires in 3 minutes, and one
          // of the tabs may be showing an older thread.
          let best = null;
          let sawVtop = false;
          let opened = false;
          // Tabs that actually answered. A mail tab open since before the
          // last extension reload has an orphaned content script: it answers
          // nothing, which is indistinguishable from "no VTOP mail here" and
          // made the panel blame the wrong Google account.
          let answered = 0;
          for (const tab of scanning) {
            const reply = await scanMailTab(tab, ignore, !!request.autoOpen);
            if (!reply) continue;
            answered++;
            if (reply.opened) opened = true;
            if (reply.sawVtop) {
              sawVtop = true;
              // This is the mailbox VTOP writes to. Remember it so later
              // scans leave every other account alone.
              const m = (tab.url || "").match(/^https:\/\/mail\.google\.com\/mail\/u\/\d+\//);
              if (m && m[0] !== learned) {
                await chrome.storage.local.set({ [learnedKey]: m[0] });
              }
            }
            if (!reply.code) continue;
            const age = reply.ageMin === null ? Infinity : reply.ageMin;
            if (!best || age < best.age) {
              best = { code: reply.code, ageMin: reply.ageMin, host: reply.host, age };
            }
          }
          if (best) {
            // needsSignIn rides along even on a hit: the caller may still
            // reject this code as expired, and that is precisely a moment the
            // user might want the sturdier route offered to them.
            sendResponse({
              code: best.code,
              ageMin: best.ageMin,
              host: best.host,
              needsSignIn,
            });
            return;
          }
          // Mail tabs are open but not one of them answered: their content
          // scripts are orphaned and only a page reload revives them. Saying
          // "wrong account" here would be a lie.
          if (!answered) {
            sendResponse({ error: "mail-tab-stale", needsSignIn });
            return;
          }
          // nothing yet — caller retries, but it needs to know whether it is
          // waiting on a mail, on the wrong mailbox being open, or on a Gmail
          // sign-in that would sidestep the whole problem
          sendResponse({ code: null, sawVtop, opened, needsSignIn });
        } catch (error) {
          sendResponse({ error: String((error && error.message) || error) });
        }
      })();
      return true; // async sendResponse
    // The one place a Google window may be opened: the panel's sign-in button,
    // which only appears when a client id is configured and consent is what's
    // missing. prompt=select_account is what puts the STUDENT mailbox in
    // reach — the profile's primary account is the personal one.
    case "vrevamp_gmail_signin":
      (async () => {
        try {
          const from = (sender && sender.url) || "";
          if (!/^https?:\/\/[^/]*(vitap|vit)\.ac\.in\/vtop\//.test(from)) {
            sendResponse({ error: "forbidden" });
            return;
          }
          if (!(await gmailClientId())) {
            sendResponse({ error: "not-configured" });
            return;
          }
          const token = await gmailToken(true);
          sendResponse(token ? { ok: true } : { error: "denied" });
        } catch (error) {
          sendResponse({ error: String((error && error.message) || error) });
        }
      })();
      return true; // async sendResponse
  }
});

/*
 * Learns the attendance-detail endpoint by watching the request VTOP itself
 * makes when the user opens a detail modal. attendance_insights.js reads
 * this record to fetch per-class histories without guessing endpoints.
 */
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== "POST") return;
    if (
      !/attendance/i.test(details.url) ||
      !(/detail/i.test(details.url) || /display/i.test(details.url))
    )
      return;
    const path = details.url
      .replace(/^https?:\/\/[^/]+\//, "")
      .replace(/^vtop\//, "")
      .split("?")[0];
    const record = { path, params: null };
    if (details.requestBody && details.requestBody.formData) {
      const params = {};
      Object.entries(details.requestBody.formData).forEach(([key, value]) => {
        params[key] = Array.isArray(value) ? value[0] : value;
      });
      record.params = params;
    }
    chrome.storage.local.set({ vrevamp_detail_request: record });
  },
  { urls: VTOP_URLS },
  ["requestBody"]
);

/*
 * Checks if the user is online or offline
 * and renders an offline view for the page
 *
 * This fires per REQUEST, and an offline page load still emits one event per
 * subresource it tries — so an unconditional tabs.create() here opened a
 * burst of identical offline tabs from a single navigation. Rate-limit to one
 * tab per offline episode; going back online arms it again.
 */
let offlineTabOpenedAt = 0;
const OFFLINE_TAB_COOLDOWN_MS = 30000;

chrome.webRequest.onBeforeRequest.addListener(
  () => {
    if (navigator.onLine) {
      offlineTabOpenedAt = 0; // back online — arm for the next episode
      return;
    }
    if (Date.now() - offlineTabOpenedAt < OFFLINE_TAB_COOLDOWN_MS) return;
    offlineTabOpenedAt = Date.now();
    viewOfflinePage();
  },
  { urls: VTOP_URLS }
);

function viewOfflinePage() {
  chrome.tabs.create({ url: chrome.runtime.getURL("html/offline.html") });
}

/*
 * Re-arm the digest alarm on startup and on update.
 *
 * chrome.alarms survive a browser restart, but NOT an extension update or
 * reinstall — and this extension is loaded unpacked, so it is updated often.
 * Without this the digest silently stops the first time the extension is
 * reloaded, which is the worst failure mode a scheduled feature has: it looks
 * enabled and does nothing. Creating an alarm that already exists with the
 * same name just replaces it, so running this on both events is safe.
 */
const rearmDigest = async () => {
  const settings = await digestSettings();
  if (!settings.enabled) return;
  if (await chrome.alarms.get(DIGEST_ALARM)) return;
  chrome.alarms.create(DIGEST_ALARM, {
    when: nextDigestTime(settings.hour),
    periodInMinutes: 24 * 60,
  });
};
chrome.runtime.onStartup.addListener(rearmDigest);
chrome.runtime.onInstalled.addListener(rearmDigest);
