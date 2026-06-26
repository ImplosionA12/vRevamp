const VTOP_URLS = [
  "*://vtop.vit.ac.in/*",
  "*://vtopcc.vit.ac.in/vtop/*",
  "*://vtop.vitap.ac.in/vtop/*",
  "*://vtop.vitap.ac.in/*",
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

/* Sends a message to the content script in the active VTOP tab */
const returnMessage = (messageToReturn) => {
  chrome.tabs.query({ active: true }, (tabs) => {
    const vtopTab = tabs.find((tab) => tab.url && tab.url.includes("vtop"));
    if (!vtopTab) return;
    chrome.tabs.sendMessage(vtopTab.id, { message: messageToReturn }, () => {
      // No content script listening on this page; ignore.
      void chrome.runtime.lastError;
    });
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
    returnMessage("showOfflineIcon");
    if (link.indexOf("doStudentMarkView") !== -1) {
      returnMessage("mark_view_page");
    } else if (link.indexOf("StudentTimeTable") !== -1) {
      returnMessage("timetable_view_page");
    } else if (
      link.indexOf("processViewStudentAttendance") !== -1 ||
      link.indexOf("processBackAttendanceDetails") !== -1
    ) {
      returnMessage("view_attendance");
    } else if (link.indexOf("StudentAttendance") !== -1) {
      returnMessage("view_attendance_page");
    } else if (link.indexOf("processViewStudentCourseDetail") !== -1) {
      returnMessage("course_page_change");
    } else if (link.indexOf("doDigitalAssignment") !== -1) {
      returnMessage("da_upload");
    } else if (link.indexOf("vtopcc.vit.ac.in/vtop/vtopLogin") !== -1) {
      returnMessage("vtopcc_captcha");
    } else if (link.indexOf("vtop.vitap.ac.in/vtop/vtopLogin") !== -1) {
      returnMessage("vtop2_captcha");
    } else if (link.indexOf("hrms/employeeSearchForStudent") !== -1) {
      returnMessage("employee_search");
    } else if (link.indexOf("hostel/StudentWeekendOuting") !== -1) {
      returnMessage("weekend_outings");
    } else if (
      link.indexOf("vtop/doLogin") !== -1 ||
      link.indexOf("assets/img/favicon.png") !== -1 ||
      link.indexOf("goHomePage") !== -1
    ) {
      returnMessage("vtop2_nav_bar");
    } else if (link.indexOf("doSearchExamScheduleForStudent") !== -1) {
      returnMessage("exam_schedule");
    } else if (
      link.indexOf("examGradeView/doStudentGradeView") !== -1 ||
      link.indexOf("examGradeView/getGradeViewDetail") !== -1
    ) {
      returnMessage("exam_grade");
    } else if (link.indexOf("menu.js") !== -1 || link.indexOf("home") !== -1) {
      if (link.indexOf("menu.js") !== -1) await sleep(3500);
      returnMessage("nav_bar_change");
    }
  },
  {
    urls: VTOP_URLS,
  }
);

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
    case "login":
      chrome.identity.getAuthToken({ interactive: true }, (auth_token) => {
        chrome.storage.sync.set({ token: auth_token });
        sendResponse(true);
      });
      return true; // keep the message channel open for the async response
    case "logout":
      chrome.identity.clearAllCachedAuthTokens(() => {
        chrome.storage.sync.set({ token: null });
      });
      break;
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
    // TEMP DIAGNOSTIC (remove after hardcoding endpoint):
    console.log("vRevamp captured detail request >>>", JSON.stringify(record));
  },
  { urls: VTOP_URLS },
  ["requestBody"]
);

/*
 * Checks if the user is online or offline
 * and renders an offline view for the page
 */
chrome.webRequest.onBeforeRequest.addListener(
  () => {
    if (!navigator.onLine) {
      viewOfflinePage();
    }
  },
  { urls: VTOP_URLS }
);

function viewOfflinePage() {
  chrome.tabs.create({ url: chrome.runtime.getURL("html/offline.html") });
}
