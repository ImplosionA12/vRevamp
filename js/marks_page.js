let modify_marks_page = () => {
  let tables = document.querySelectorAll(".customTable-level1 > tbody"); // select all Tables

  tables.forEach((table) => {
    let tot_max_marks = 0,
      tot_weightage_percent = 0,
      tot_scored = 0,
      tot_weightage_equi = 0,
      tot_class_avg = 0;

    let table_marks = Array.from(
      table.querySelectorAll(".tableContent-level1") // select rows excluding header
    );

    table_marks.forEach((row) => {
      let content = row.innerHTML.split("<td>");

      //Removing the tabs and other tags
      let max_marks = content[3].replace(/[^0-9.]+/g, "");
      let weightage_percent = content[4].replace(/[^0-9.]+/g, "");
      let scored = content[6].replace(/[^0-9.]+/g, "");
      let weightage_equi = content[7].replace(/[^0-9.]+/g, "");
      let class_avg = content[8].replace(/[^0-9.]+/g, "");

      //converting string to float
      tot_max_marks += parseFloat(max_marks);
      tot_weightage_percent += parseFloat(weightage_percent);
      tot_scored += parseFloat(scored);
      tot_weightage_equi += parseFloat(weightage_equi);
      tot_class_avg += parseFloat(class_avg);
    });

    //Add the row to display totals
    table.innerHTML += `
        <tr class="tableContent-level1" style='background: rgb(60,141,188,0.8);'>
            <td></td>
            <td><b>Total:</b></td>
            <td>${tot_max_marks.toFixed(2)}</td>
            <td>${tot_weightage_percent.toFixed(2)}</td>
            <td></td>
            <td><b>${tot_scored.toFixed(2)}</b></td>
            <td><b>${tot_weightage_equi.toFixed(2)}</b></td>
            <td>${tot_class_avg.toFixed(2)}</td>
            <td><b>Lost Weightage Marks:</b></td>
            <td>${(tot_weightage_percent - tot_weightage_equi).toFixed(2)}</td>
        </tr>
        `;
  });
};

chrome.runtime.onMessage.addListener((request) => {
  if (request.message === "mark_view_page") {
    try {
      modify_marks_page();
      saveMarksPage(document.querySelector(".box-body").outerHTML);
    } catch (error) {
      console.error(error);
    }
  }
});
