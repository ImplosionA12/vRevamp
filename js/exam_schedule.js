let is_venue = (i) => {
  i++;
  let row = document.getElementsByTagName("tbody")[0].rows;
  let empty_venue_count = 0;
  while (row[i].children[0].className !== "panelHead-secondary") {
    if (row[i].children[11].innerText == "-") {
      empty_venue_count++;
    }
    i++;
    if (i == row.length) {
      break;
    }
  }
  return empty_venue_count <= 2;
};

const MONTH_MAP = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Sept: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

// "02:30 PM" -> "14:30" (handles the 12 AM/PM edge cases)
const exam_time_to_24h = (time_text) => {
  const trimmed = time_text.trim();
  const time = trimmed.slice(0, 5);
  const meridiem = trimmed.slice(6, 8).toUpperCase();
  let hour = parseInt(time.split(":")[0]);
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return String(hour).padStart(2, "0") + ":" + time.split(":")[1];
};

let exam_schedule_sync = () => {
  let row = document.getElementsByTagName("tbody")[0].rows;
  for (let i = 0; i < row.length; i++) {
    if (row[i].children[0].className === "panelHead-secondary" && is_venue(i)) {
      let exam_type = row[i].children[0].innerText;
      let sync_button = document.createElement("button");
      sync_button.innerText = ` Download ${exam_type} to .ics Format `;
      sync_button.id = i;
      sync_button.className = "btn btn-primary";
      sync_button.onclick = () => call_sync(i, exam_type);
      sync_button.style.marginLeft = "1%";
      sync_button.style.background = "rgb(73,117,182)";
      row[i].children[0].appendChild(sync_button);
    }
  }

  let get_details = (i, exam_type) => {
    i = parseInt(i);
    i++;
    let row_count = document.getElementsByTagName("tbody")[0].rows.length;
    let temp_row = document.getElementsByTagName("tbody")[0].rows;
    let exam = {
      course_code: [],
      course_title: [],
      exam_date: [],
      exam_time: [],
      venue: [],
      venue_room: [],
      seat_number: [],
      seat_location: [],
    };
    let header =
      "BEGIN:VCALENDAR\n" +
      "VERSION:2.0\n" +
      "PRODID:-//vRevamp//iCal Generator//EN\n" +
      "CALSCALE:GREGORIAN\n\n";
    while (temp_row[i].children[0].className !== "panelHead-secondary") {
      exam.course_code.push(temp_row[i].children[1].innerText);
      exam.course_title.push(temp_row[i].children[2].innerText);
      exam.exam_date.push(temp_row[i].children[6].innerText);
      exam.exam_time.push(temp_row[i].children[9].innerText);
      exam.venue.push(temp_row[i].children[10].innerText);
      exam.venue_room.push(temp_row[i].children[11].innerText);
      try {
        exam.seat_location.push(temp_row[i].children[12].innerHTML);
      } catch (error) {
        console.log(error);
      }
      exam.seat_number.push(temp_row[i].children[13].innerText);
      i++;
      if (i == row_count) {
        break;
      }
    }
    i = 0;
    while (i < exam.course_code.length) {
      let tmp = exam.exam_date[i].split("-");
      let start_time, end_time;
      try {
        start_time = exam_time_to_24h(exam.exam_time[i].split("-")[0]);
        end_time = exam_time_to_24h(exam.exam_time[i].split("-")[1]);
      } catch (error) {
        alert(
          "Please check your exam schedule and try again, " +
            exam.course_code[i] +
            " has no exam time"
        );
      }
      const now = new Date();
      // Format the date and time as a string in the correct format
      const year1 = now.getUTCFullYear();
      const month1 = String(now.getUTCMonth() + 1).padStart(2, "0");
      const day1 = String(now.getUTCDate()).padStart(2, "0");
      const hour1 = String(now.getUTCHours()).padStart(2, "0");
      const minute1 = String(now.getUTCMinutes()).padStart(2, "0");
      const second1 = String(now.getUTCSeconds()).padStart(2, "0");

      try {
        header +=
          "BEGIN:VEVENT\n" +
          "UID:" +
          `${year1}${month1}${day1}T${hour1}${minute1}${second1}-${exam.course_code[i]}@vitap.ac.in\n` +
          "DTSTAMP;TZID=Asia/Kolkata:" +
          `${year1}${month1}${day1}T${hour1}${minute1}${second1}\n` +
          "DTSTART;TZID=Asia/Kolkata:" +
          `${tmp[2]}${MONTH_MAP[tmp[1]]}${tmp[0]}T` +
          start_time.replace(":", "") +
          "00\n" +
          "DTEND;TZID=Asia/Kolkata:" +
          `${tmp[2]}${MONTH_MAP[tmp[1]]}${tmp[0]}T` +
          end_time.replace(":", "") +
          "00\n" +
          "SUMMARY:" +
          exam.course_code[i] +
          ":" +
          exam.course_title[i] +
          "\n" +
          "DESCRIPTION:" +
          "Seat Location : " +
          exam.seat_location[i] +
          ";" +
          " Seat Number : " +
          exam.seat_number[i] +
          "\n" +
          "LOCATION:" +
          exam.venue[i] +
          " " +
          exam.venue_room[i] +
          "\n" +
          "END:VEVENT\n\n";
      } catch (error) {
        header += "\n";
      }

      i++;
    }
    const ics = header + "END:VCALENDAR";
    try {
      // download ics as file
      let element = document.createElement("a");
      element.setAttribute(
        "href",
        "data:text/plain;charset=utf-8," + encodeURIComponent(ics)
      );
      const semester_select = document.querySelector("#semesterSubId");
      const semester_name =
        semester_select.options[semester_select.options.selectedIndex]
          .innerText;
      element.setAttribute("download", `${semester_name} ${exam_type}.ics`);
      element.style.display = "none";
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);
    } catch (error) {
      console.log(error);
    }
    return exam;
  };

  let call_sync = (i, exam_type) => {
    try {
      let details = get_details(i, exam_type);
      if (details.course_code.length == 0) {
        alert("No exams are scheduled");
        return;
      }
      alert("Successfully downloaded the exam schedule");
    } catch (error) {
      alert("Refresh the page and try again");
    }
  };
};

chrome.runtime.onMessage.addListener((request) => {
  if (request.message === "exam_schedule") {
    try {
      exam_schedule_sync();
      saveExamSchedulePage(document.querySelector("#main-section").innerHTML);
    } catch (error) {
      console.log(error);
    }
  }
});
