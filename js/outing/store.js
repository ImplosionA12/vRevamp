/*
 * Runs in the page context (injected by weekend_outing.js) so it can use the
 * page's jQuery, blockUI and datepicker plugins. The functions below are
 * called from inline handlers in VTOP's own markup.
 */
/* exported submitOutingForm, getReport, downloadform, updateBookingInfo, deleteStudentBookingInfo */

$("#outingDate").datepicker({
  autoClose: true,
  dateFormat: "dd-M-yy",
  minDate: "0",
  maxDate: "6",
  beforeShowDay: function (d) {
    var day = d.getDay();
    return [day != 2 && day != 3 && day != 4 && day != 5 && day != 6];
  },
});

function getCsrfValue() {
  return document.querySelector("#logoutForm1 > input[type=hidden]:nth-child(1)").value;
}

function submitOutingForm() {
  var form = document.getElementById("outingForm");
  var now = new Date();
  var fd = new FormData(form);
  var purposeOfVisit = document.getElementById("purposeOfVisit").value;

  if (purposeOfVisit == "") {
    alert("Please fill Purpose of visit");
    return false;
  }
  var outingDate = document.getElementById("outingDate").value;

  if (outingDate == "") {
    alert("Please fill Date");
    return false;
  }

  var contactNumber = document.getElementById("contactNumber").value;

  if (contactNumber == "") {
    alert("Please fill contact number");
    return false;
  }

  if (contactNumber.length != 10) {
    alert("Mobile No. is not valid, Please Enter 10 Digit Mobile No.");
    return false;
  }

  fd.append("_csrf", getCsrfValue());
  fd.append("x=", now.toUTCString());

  $.blockUI({
    message: '<img src="assets/img/482.GIF"> loading... Just a moment...',
  });

  $.ajax({
    url: "hostel/saveOutingForm",
    type: "POST",
    data: fd,
    cache: false,
    processData: false,
    contentType: false,
    success: function (response) {
      $.unblockUI();
      $("#main-section").html(response);
    },
    error: function () {
      $.unblockUI();
    },
  });
}

function getReport() {
  $.blockUI({
    message: '<img src="assets/img/482.GIF"> loading... Just a moment...',
  });

  var now = new Date();
  var authorizedID = document.querySelector("#authorizedIDX").value;
  var params =
    "_csrf=" + getCsrfValue() +
    "&authorizedID=" + authorizedID +
    "&x=" + now.toUTCString();

  $.ajax({
    url: "hostel/downloadOutingForm",
    type: "POST",
    data: params,
    success: function (response) {
      $.unblockUI();
      $("#main-section").html(response);
    },
    error: function (jqXHR, textStatus, errorMessage) {
      $.unblockUI();
      $("#upload-file-message").text(errorMessage + "Error while Addition");
    },
  });

  $("html, body").animate(
    {
      scrollTop: 0,
    },
    "slow"
  );
}

function downloadform() {
  var data = getnumber();

  document.getElementById("recieptLink").href = "downloadReciept/" + data;
}

//Update and Delete the form details

function updateBookingInfo(BookingId) {
  var authorizedID = document.getElementById("authorizedID").value;
  var now = new Date();
  var params =
    "_csrf=" + getCsrfValue() +
    "&BookingId=" + BookingId +
    "&authorizedID=" + authorizedID +
    "&x=" + now.toUTCString();

  $.ajax({
    url: "hostel/updateBookingInfo",
    type: "POST",
    data: params,
    success: function (response) {
      $("#main-section").html(response);
    },
  });
}

function deleteStudentBookingInfo(BookingId) {
  var authorizedID = document.getElementById("authorizedID").value;
  var now = new Date();
  var params =
    "_csrf=" + getCsrfValue() +
    "&BookingId=" + BookingId +
    "&authorizedID=" + authorizedID +
    "&x=" + now.toUTCString();

  $.ajax({
    url: "hostel/deleteBookingInfo",
    type: "POST",
    data: params,
    success: function (response) {
      $("#main-section").html(response);
    },
  });
}
