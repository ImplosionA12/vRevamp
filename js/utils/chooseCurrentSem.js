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

// Every real option index, ordered by how likely it is to hold the ongoing
// semester's data: semesters that have started (newest first), then the
// rest. attendance.js walks this list when a semester loads with no
// attendance rows (e.g. the just-opened registration semester).
function semesterFallbackOrder() {
    const sel = document.getElementById("semesterSubId");
    if (!sel) return [];
    const now = new Date();
    const entries = Array.from(sel.options)
        .map((opt, index) => ({
            index,
            start:
                opt.value && opt.innerText.trim()
                    ? parseSemesterStart(opt.innerText.trim())
                    : null,
            real: !!(opt.value && opt.innerText.trim()),
        }))
        .filter((e) => e.real);
    const started = entries
        .filter((e) => e.start && e.start <= now)
        .sort((a, b) => b.start - a.start);
    const rest = entries.filter((e) => !e.start || e.start > now);
    return started.concat(rest).map((e) => e.index);
}

// Estimated start of the term in progress today: the latest term boundary
// (Winter ~Dec 1, Summer ~May 1, Fall ~Jul 1 — same estimates as
// parseSemesterStart) that falls on or before `now`.
function currentTermStartEstimate(now = new Date()) {
    const y = now.getFullYear();
    const candidates = [
        new Date(y - 1, 11, 1), // Winter of the previous academic year
        new Date(y, 4, 1),      // Summer terms
        new Date(y, 6, 1),      // Fall
        new Date(y, 11, 1),     // Winter
    ];
    let best = null;
    for (const c of candidates) {
        if (c <= now && (!best || c > best)) best = c;
    }
    return best;
}

// True when cached data tagged with `semesterName` looks like it belongs to a
// finished semester: a newer term has (approximately) begun since it started,
// AND — when that semester's academic calendar is available — its last known
// date (FAT/last instructional day) is behind us. The boundary dates are
// rough estimates, so the calendar check keeps this from crying wolf during
// transition weeks while the old semester is still wrapping up.
function semesterLooksStale(semesterName, calendar, now = new Date()) {
    if (!semesterName) return false;
    const start = parseSemesterStart(String(semesterName));
    if (!start) return false;
    const termStart = currentTermStartEstimate(now);
    if (!termStart || start >= termStart) return false;
    const endIso = [
        calendar && calendar.fat,
        calendar && calendar.lastInstructional,
        calendar && calendar.cat2,
        calendar && calendar.cat1,
    ]
        .filter(Boolean)
        .sort()
        .pop(); // ISO strings — lexicographic max is the latest date
    if (endIso) {
        // parse as LOCAL midnight — new Date("YYYY-MM-DD") is UTC midnight,
        // and the setHours() below is local, so west of Greenwich the two
        // combined landed the end-of-day on the wrong calendar day
        const [y, m, d] = endIso.split("-").map(Number);
        const end = new Date(y, m - 1, d);
        end.setHours(23, 59, 59, 999);
        return now > end;
    }
    return true;
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
