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

// Why the last attempt for this scope failed, in Google's own words. Without
// it every failure looks like "you closed the window", which is wrong for the
// one that actually happens during setup: consent is refused with
// `error=invalid_scope` when the scope has not been added to the OAuth consent
// screen, or the API is not enabled on the project. That is a checkbox in Cloud
// Console, and the message should say so rather than blame the student.
const lastAuthError = new Map();

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

  if (!interactive && Date.now() < (silentBlockedUntil.get(storeKey) || 0)) return null;
  const block = () => {
    if (!interactive) silentBlockedUntil.set(storeKey, Date.now() + SILENT_BACKOFF_MS);
    return null;
  };

  const redirect = chrome.identity.getRedirectURL();
  const url =
    "https://accounts.google.com/o/oauth2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      response_type: "token",
      redirect_uri: redirect,
      scope,
      prompt: interactive ? "consent select_account" : "none",
    }).toString();

  let redirected = null;
  try {
    redirected = await chrome.identity.launchWebAuthFlow({ url, interactive: !!interactive });
  } catch (error) {
    // silent flow refused (no consent yet), or the user closed the window
    if (interactive) lastAuthError.set(storeKey, String((error && error.message) || error));
    return block();
  }
  if (!redirected) return block();

  // Google reports refusals in the fragment too, not only by throwing
  const frag = String(redirected).split("#")[1] || "";
  const params = new URLSearchParams(frag);
  const query = new URLSearchParams(String(redirected).split("?")[1] || "");
  const token = params.get("access_token");
  if (!token) {
    const why =
      params.get("error_description") ||
      params.get("error") ||
      query.get("error_description") ||
      query.get("error");
    if (why) lastAuthError.set(storeKey, String(why).replace(/\+/gu, " "));
    return block();
  }

  lastAuthError.delete(storeKey);
  silentBlockedUntil.delete(storeKey); // consent exists; silent refresh works
  const ttl = Number(params.get("expires_in")) || 3600;
  await chrome.storage.local.set({
    [storeKey]: { token, exp: Date.now() + ttl * 1000 },
  });
  return token;
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

async function calendarToken({ interactive, stale }) {
  return webAuthToken({
    clientId: await calendarClientId(),
    scope: CALENDAR_SCOPE,
    storeKey: CALENDAR_TOKEN_KEY,
    interactive,
    stale,
  });
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

chrome.alarms.onAlarm.addListener(async (alarm) => {
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
      // Legacy route: getAuthToken on manifest.oauth2.client_id. That is
      // upstream's client id and it is dead ("bad client id") for every user of
      // this build — which is the entire reason the Calendar features fall back
      // to "open the editor and press Save yourself", once per class.
      const legacy = () => {
        const mint = () =>
          chrome.identity.getAuthToken(
            { interactive: !!request.interactive },
            (auth_token) => {
              // surface the failure reason (e.g. Chrome profile has no Google
              // account — then no consent window ever opens) instead of
              // swallowing it; the buttons show it to the user
              const err = chrome.runtime.lastError;
              if (auth_token) chrome.storage.sync.set({ token: auth_token });
              sendResponse({
                token: auth_token || null,
                error: auth_token ? null : (err && err.message) || null,
              });
            }
          );
        if (request.stale)
          chrome.identity.removeCachedAuthToken({ token: request.stale }, mint);
        else mint();
      };
      // Preferred route, the moment a Calendar client id exists: the same
      // launchWebAuthFlow the Gmail OTP feature already runs on. Every caller
      // (timetable import, exam ✉️, DA ✉) asks for a token through this one
      // message, so they all start working with no change of their own.
      calendarClientId().then((id) => {
        if (!id) {
          legacy();
          return;
        }
        calendarToken({ interactive: !!request.interactive, stale: request.stale }).then(
          (token) => {
            const why = lastAuthError.get(CALENDAR_TOKEN_KEY);
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
