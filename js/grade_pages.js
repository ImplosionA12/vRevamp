const GRADE_POINTS = { S: 10, A: 9, B: 8, C: 7, D: 6, E: 5, F: 0 };

let modify_grade_page = () => {
    let subject_header = Array.from(document.querySelectorAll("#studentGradeView > div > div > div.row > div > div > div > table > tbody > tr"));
    let sum = 0;
    let gpa = 0;
    // iterate through the table rows, skipping the header
    for (let i = 1; i < subject_header.length; i++) {
        let sub_header_row = subject_header[i].getElementsByTagName("td");
        let credits_col;
        let grade_col;
        try {
            credits_col = sub_header_row[4].innerHTML;
            grade_col = sub_header_row[9].innerHTML;
        } catch (error) {
            continue;
        }
        let credits = parseFloat(credits_col.replace(/[^0-9.]+/g, ""));
        let grade = grade_col.replace(/[^A-Z.]+/g, "");
        if (!(grade in GRADE_POINTS) || isNaN(credits)) {
            continue;
        }
        gpa += GRADE_POINTS[grade] * credits;
        sum += credits;
    }
    document.querySelector("#studentGradeView > div > div > div.row > div > div > div > table > tbody").innerHTML += `<tr class="tableContent-level1" style='background: rgb(170, 255, 0,0.6);'>
                    <td colspan="11" style="text-align:center">Your Semester Wise GPA : ${(gpa / sum).toFixed(2)}</td>
                </tr>`;
};

chrome.runtime.onMessage.addListener((request) => {
    if (request.message === "exam_grade") {
        try {
            modify_grade_page();
        } catch (error) {
            console.log(error);
        }
    }
});
