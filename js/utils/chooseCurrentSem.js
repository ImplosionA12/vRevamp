// Selects the *ongoing* semester in VTOP's semester dropdown.
//
// VTOP normally lists the most recent semester at index 1 (index 0 is the
// "-- Choose Semester --" placeholder), so historically we just picked
// index 1. That breaks during sem-transition windows: when registration for
// an upcoming semester opens, VTOP inserts that future (data-less) semester
// at the top, and index 1 lands on a semester with no attendance/marks yet.
//
// Instead we parse each option's semester name, estimate when it started, and
// pick the latest semester that has actually begun on or before today. If we
// can't confidently parse the options we fall back to the old index-1 choice,
// so this never does worse than before.

function parseSemesterStart(text) {
    // Expected shapes: "Fall Semester 2025-26", "Winter Semester 2024-25",
    // "Summer Term I 2025-26", "Summer Term II 2025-26".
    const yearMatch = text.match(/(\d{4})\s*-\s*\d{2,4}/);
    if (!yearMatch) return null;
    const firstYear = parseInt(yearMatch[1], 10);
    if (Number.isNaN(firstYear)) return null;

    const t = text.toLowerCase();
    // Approximate start month of each term within the "YYYY-YY" academic year.
    let month;
    if (t.includes("fall")) {
        month = 6;            // ~July, in the first calendar year
        return new Date(firstYear, month, 1);
    } else if (t.includes("winter")) {
        month = 11;           // ~December of the first year
        return new Date(firstYear, month, 1);
    } else if (t.includes("summer")) {
        month = 4;            // ~May, in the second calendar year
        return new Date(firstYear + 1, month, 1);
    }
    // Unknown term: assume start of the second calendar year so it sorts
    // sensibly but conservatively.
    return new Date(firstYear + 1, 0, 1);
}

function chooseCurrentSemester() {
    const chooseSemesterSearchBox = document.getElementById("semesterSubId");
    if (!chooseSemesterSearchBox) return;

    const options = Array.from(chooseSemesterSearchBox.options);
    const now = new Date();

    let bestIndex = -1;
    let bestStart = null;
    for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        // Skip the placeholder / empty options.
        if (!opt.value || !opt.innerText.trim()) continue;

        const start = parseSemesterStart(opt.innerText.trim());
        if (!start) continue;
        if (start > now) continue; // future / registration-only semester

        if (!bestStart || start > bestStart) {
            bestStart = start;
            bestIndex = i;
        }
    }

    if (bestIndex >= 0) {
        chooseSemesterSearchBox.selectedIndex = bestIndex;
    } else {
        // Couldn't parse anything useful — keep the original behaviour.
        chooseSemesterSearchBox.selectedIndex = 1;
    }
}
