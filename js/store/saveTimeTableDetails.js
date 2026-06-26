// Util file to set and get the timetable data 
// requires to add storage permission in manifest.json 

// shape of data is as follows
//   header: ["Start - End", "08:00 - 08:50", "09:00 - 09:50", ...]
//           (NOT de-duplicated: repeated time columns are still present;
//            filterRepeated(header) collapses them to align with the rows)
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

function saveTimeTable(header, data) {
  saveData(timeTableKey, {header, data});
}

function getTimeTable(callback) {
  getData(timeTableKey, callback);
}
