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
  const findSave = () =>
    Array.from(document.querySelectorAll("button")).find((b) => {
      const text = (b.textContent || "").trim();
      const label = b.getAttribute("aria-label") || "";
      return text === "Save" || label === "Save";
    });
  let btn = null;
  for (let t = 0; t < 15000 && !(btn = findSave()); t += 300) await sleep(300);
  if (!btn) return "no-button";
  btn.click();
  for (let t = 0; t < 15000; t += 300) {
    if (!location.pathname.includes("eventedit")) return "saved";
    await sleep(300);
  }
  return "stuck";
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
          // a broken setup (missing permission, blocked page) fails the same
          // way every time — stop strobing tabs after 3 straight failures
          if (saved === 0 && failed >= 3) break;
        }
        sendResponse({ saved, failed, total: urls.length, lastError });
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
