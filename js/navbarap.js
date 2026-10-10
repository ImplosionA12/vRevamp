const nav_bar_change = () => {
	// idempotent: the load event, the SW message, and SPA re-fires can all
	// land here — never build a second navbar
	if (document.getElementById("navbar")) return;
	let items_list = Array.from(document.getElementsByTagName("a")).filter(
		(e) => e.dataset.url
	);
	let marks, attendance, course_page, da_upload, time_table, calendar, curriculum;
	for (let i = 0; i < items_list.length; i++) {
		const item = items_list[i].innerText.trim();
		if (item.includes("Class Attendance")) {
			attendance = i;
		} else if (item.includes("Course Page")) {
			course_page = i;
		} else if (item.includes("Digital Assignment Upload")) {
			da_upload = i;
		} else if (item.includes("Time Table")) {
			time_table = i;
		} else if (item.includes("Calendar")) {
			calendar = i;
		} else if (
			// by VTOP's own data-url, then by the exact label. A bare
			// includes("Marks") also matched "Photo & 12th Marksheet Upload",
			// and since the last match won, the Marks View button opened
			// "Access Denied — Photo Upload Option not opened for you".
			marks === undefined &&
			(/StudentMarkView/i.test(items_list[i].dataset.url || "") ||
				/^marks(\s*view)?$/i.test(item))
		) {
			marks = i;
		}
    else if (item.includes("My Curriculum")) {
      curriculum = i;}

	}
	// console.log(marks, attendance, course_page, da_upload, time_table, calendar);
	let nav = document.getElementsByClassName("collapse navbar-collapse");
	if (!nav[0]) return; // page without the VTOP navbar (login/404): nothing to decorate
	let span = document.createElement("div");
	span.id = "navbar";
	span.innerHTML = `
    <span class="navbar-text px-0 px-sm-2 mx-0 mx-sm-1 text-light" ></span>
    `;
	// A menu entry the student's role doesn't have (My Curriculum is the
	// usual one) left its index `undefined`, and the template still emitted
	// the button — so clicking it ran `[undefined].click()` and threw in the
	// page. `if (time_table)` had the same shape of bug from the other end:
	// a legitimate index of 0 is falsy, which silently swapped Time Table
	// for Calendar. Only emit a button whose target index actually resolved.
	const navButton = (index, label) => {
		if (typeof index !== "number") return;
		span.innerHTML += `<button class="btn btn-primary border-primary shadow-none" type="button" style="background: rgba(13,110,253,0);border-style: none;" onclick="Array.from(document.getElementsByTagName('a')).filter((e) => e.dataset.url)[${index}].click()" id="nav_short">${label}</button>`;
	};
	navButton(curriculum, "Curriculum");
	navButton(marks, "Marks View");
	navButton(attendance, "Attendance");
	navButton(course_page, "Course Page");
	navButton(da_upload, "DA Upload");
	// Time Table when the menu has it, Calendar as the stand-in when it doesn't
	if (typeof time_table === "number") navButton(time_table, "Time Table");
	else navButton(calendar, "Calendar");
	nav[0].insertBefore(span, nav[0].children[0]);

	let buttons = document.querySelectorAll("[id=nav_short]");
	buttons.forEach((button) => {
		button.addEventListener("click", () => {
			buttons.forEach((but) => {
				but.disabled = true;
				setTimeout(() => {
					buttons.forEach((btn) => {
						btn.disabled = false;
					});
				}, 1500);
			});
		});
	});
};

let flag = false;

chrome.runtime.onMessage.addListener((request) => {
	if (request.message === "nav_bar_change") {
		try {
			// optional chaining like the load-time copy below: on pages
			// without that element this threw on EVERY nav_bar_change message
			// and filled the console, and the throw skipped the navbar build
			if (
				document.getElementsByClassName("btn-group dropend")[0]?.style
					.backgroundColor === "red"
			) {
				document.getElementsByClassName("btn-group dropend")[0].remove();
			}
			if (
				document.getElementsByClassName(
					"btn btn-primary border-primary shadow-none"
				).length == 0 &&
				flag
			) {
				nav_bar_change();
			}
		} catch (error) {
			console.log(error);
		}
	}
});
if (
	document.getElementsByClassName("btn-group dropend")[0]?.style
		.backgroundColor === "red"
) {
	document.getElementsByClassName("btn-group dropend")[0].remove();
}
if (
	document.getElementsByClassName("btn btn-primary border-primary shadow-none")
		.length == 0
) {
	window.addEventListener("load", nav_bar_change, false);
	flag = true;
}