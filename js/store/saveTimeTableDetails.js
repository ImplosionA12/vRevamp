// Util file to set and get the timetable data 
// requires to add storage permission in manifest.json 

// shape of data is as follows
//   header: ["Start - End", "08:00 - 08:50", "09:00 - 09:50", ...]
//           (NOT de-duplicated: repeated time columns are still present;
//            filterRepeated(header) collapses them to align with the rows)
//   headerLab: same shape, but the LAB grid's times for the same columns
//           ["Start - End", "08:00 - 08:50", "08:50 - 09:40", ...]. Labs do
//           not share the theory grid — the column whose theory time is
//           18:00-18:50 is 17:40-18:30 for labs — so a reader must take lab
//           cells' times from here, never from `header`. Absent on timetables
//           saved before 2026-08-04; readers fall back to `header` and are
//           correct again once the Time Table page is opened once.
//   data:  [
//     {
//       "day": "TUE",   // 3-letter code
//       // de-duplicated; index 0 is a junk "start-end" placeholder. From
//       // index 1, each cell aligns with filterRepeated(header)[i].
//       "theory": ["", "TA1-CSE1005-ETH-G14-CB-ALL", "E1-CSE3015-ETH-323-CB-ALL", ...],
//       "lab":    ["", "", "L31+L32-BCSE204P-ELA-AB1-...", ...]
//     }, ...
//   ]

const timeTableKey = "timeTable-V1"

// semester + savedAt let readers (next_class.js) detect a timetable saved
// during a previous semester; old blobs without them are treated as legacy
function saveTimeTable(header, data, semester, headerLab) {
  saveData(timeTableKey, {
    header,
    headerLab: Array.isArray(headerLab) ? headerLab : [],
    data,
    semester: semester || null,
    savedAt: Date.now(),
  });
}

function getTimeTable(callback) {
  getData(timeTableKey, callback);
}
