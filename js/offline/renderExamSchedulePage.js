getExamSchedulePage((htmlDataAsStr) => {
  const marksPageBody = document.getElementById('exam-schedule-body');
  if (htmlDataAsStr === null) {
    marksPageBody.innerHTML = `<p class="no-data">No Data Available</p>`;
    return;
  }
  marksPageBody.innerHTML = htmlDataAsStr;
  // Snapshots taken before js/shared/click.js landed embedded our own buttons
  // (.ics export, 🔔 reminders, ✉️ email). Nothing services a click here —
  // this is an extension page with no VTOP content script — so they could only
  // ever look broken. Drop them from what we render.
  marksPageBody
    .querySelectorAll('[data-vr-action], .vrevamp-exam-note, .vrevamp-gcal-link')
    .forEach((el) => el.remove());
  marksPageBody.querySelectorAll('button').forEach((b) => {
    if (/notify me before|email me instead|to \.ics Format/i.test(b.textContent)) b.remove();
  });
});
