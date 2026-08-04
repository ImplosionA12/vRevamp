/*
 * RFC 5545 helpers shared by every .ics producer (exam schedule, timetable).
 *
 * Hand-assembled ICS strings kept shipping broken calendars. Verified against
 * ical.js (Mozilla/Thunderbird's reference parser) on 2026-07-26 — severity
 * per defect, because they are NOT equally bad:
 *   - a UID built from the course code alone collided between a course's
 *     THEORY and LAB exam. Same UID means "same event", so importing the
 *     file dropped one of the two exams outright. Confirmed: the old output
 *     parses as 2 VEVENTs with 1 distinct UID. This was the severe one.
 *     an unescaped LITERAL NEWLINE inside a value makes the parser treat the
 *     remainder as a new content line: ical.js rejects the WHOLE FILE
 *     ("invalid line (no token ';' or ':')"). Nothing imports at all.
 *     Where the newline comes from (measured in Chrome, 2026-07-26): a cell
 *     whose content SPANS MULTIPLE SOURCE LINES — `<td>\n AB-1\n Room 324\n
 *     </td>`, or one element per line — since textContent keeps the source
 *     whitespace between text nodes and .trim() only strips the ends. A
 *     `<br>` does NOT cause it: `<td>AB-1<br>Room 324</td>` on one line
 *     yields "AB-1Room 324", no newline. (JSP output routinely wraps cell
 *     content across lines, so this is reachable — though it has not been
 *     confirmed against live VTOP markup for the exam table specifically.)
 *   - DTSTAMP is defined as UTC: no TZID parameter, trailing Z required. It
 *     was written as ";TZID=Asia/Kolkata" with no Z, which ical.js reads as
 *     a "floating" (timezone-less) timestamp.
 *   - unescaped "," and ";" are spec violations (RFC 5545 §3.3.11) but are
 *     NOT silently corrupting in practice: ical.js recovers both intact, as
 *     it does an unescaped backslash. Escaping them is still correct — a
 *     stricter or multi-value-aware consumer may differ, and esc() has to
 *     handle the newline case anyway — but do not describe these as data
 *     loss; that claim was made during review and the parser disproved it.
 *   - lines must be CRLF-terminated and folded at 75 octets. We emitted LF
 *     and arbitrarily long lines; strict parsers reject the file.
 *
 * Everything goes through vrIcs.calendar() now — do not concatenate ICS
 * lines by hand again.
 */
(() => {
  if (window.vrIcs) return;

  // RFC 5545 §3.3.11: inside a TEXT value only these carry meaning.
  const esc = (value) =>
    String(value === null || value === undefined ? "" : value)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|\r|\n/g, "\\n");

  const encoder = new TextEncoder();
  const octets = (s) => encoder.encode(s).length;

  // RFC 5545 §3.1: fold at 75 OCTETS, not characters — an em dash is 3 bytes
  // and course titles are full of them. Continuation lines begin with one
  // space. Walk by code point so a multi-byte character is never split.
  const fold = (line) => {
    if (octets(line) <= 75) return line;
    const parts = [];
    let cur = "";
    let bytes = 0;
    for (const ch of line) {
      const size = octets(ch);
      // continuation lines spend one of their 75 octets on the leading space
      const limit = parts.length === 0 ? 75 : 74;
      if (bytes + size > limit) {
        parts.push(cur);
        cur = "";
        bytes = 0;
      }
      cur += ch;
      bytes += size;
    }
    parts.push(cur);
    return parts[0] + parts.slice(1).map((p) => "\r\n " + p).join("");
  };

  const pad = (n) => String(n).padStart(2, "0");

  // DTSTAMP / any UTC date-time value: trailing Z, never a TZID parameter.
  const stamp = (date = new Date()) =>
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(
      date.getUTCDate()
    )}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(
      date.getUTCSeconds()
    )}Z`;

  // A UID must be unique per event AND stable across re-exports of the same
  // event, so a re-import updates the existing entry instead of duplicating
  // it. Build it from the event's own identifying content — never from the
  // export timestamp, which is identical for every event in one file.
  const uid = (...parts) => {
    const slug = parts
      .map((p) =>
        String(p === null || p === undefined ? "" : p).replace(
          /[^A-Za-z0-9._-]+/g,
          "_"
        )
      )
      .filter((p) => p && p !== "_")
      .join("-");
    return `${slug || "vrevamp"}@vitap.ac.in`;
  };

  // RFC 5545 §3.6.5: a TZID parameter must reference a VTIMEZONE defined in
  // the SAME iCalendar object — referencing a bare Olson name is undefined
  // behaviour. Google/Apple resolve "Asia/Kolkata" anyway, which is why the
  // omission went unnoticed, but a strict consumer may drop the offset and
  // read every class as floating local time. IST is UTC+5:30 with no DST
  // (none since 1945), so one STANDARD component covers the whole range.
  const IST_VTIMEZONE = [
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Kolkata",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0530",
    "TZOFFSETTO:+0530",
    "TZNAME:IST",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];

  // events: array of arrays of assembled "NAME;PARAM:value" lines, values
  // already escaped by the caller via esc(). Falsy lines are dropped, so an
  // optional property can be written as `cond ? "LOCATION:..." : ""`.
  const calendar = (prodId, events) => {
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:${prodId}`,
      "CALSCALE:GREGORIAN",
    ];
    // emit the definition only when an event actually references it
    if (events.some((event) => event.some((l) => /TZID=Asia\/Kolkata/.test(l))))
      lines.push(...IST_VTIMEZONE);
    events.forEach((event) => {
      lines.push("BEGIN:VEVENT", ...event.filter(Boolean), "END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.map(fold).join("\r\n") + "\r\n";
  };

  window.vrIcs = { esc, fold, stamp, uid, calendar };
})();
