// Reads a login OTP out of whatever webmail tab the user already has open.
//
// Deliberately provider-agnostic: it scans document.body.innerText rather than
// querying Gmail/Outlook selectors. Both webmails ship obfuscated, frequently
// rechurned class names, so any selector-based reader would rot within a
// release or two; the rendered text is the one thing both are guaranteed to
// keep. The trade-off is that we cannot read a message's true timestamp, so
// freshness is handled by the caller (it passes the codes it has already
// consumed in `ignore`) rather than here.
//
// Nothing is read unless the VTOP login page asks: this script is inert until
// it receives a vtopext_scan_otp message, and it only ever returns the digits
// it matched — never the surrounding mail text.
(() => {
  // The worker re-injects this file into a tab whose content script was
  // orphaned by an extension reload. A plain "already loaded" flag would be
  // the wrong guard: the orphan sets it too and cannot clear it, so it would
  // block the live copy forever — the exact failure it is meant to cure.
  // Instead every copy takes a sequence number and only the newest answers,
  // which is correct whether or not the copies share an isolated world.
  const seq = (window.__vtopextMailScanSeq =
    (window.__vtopextMailScanSeq || 0) + 1);

  // The words a login OTP mail actually puts next to the number.
  const KEYWORDS =
    /(\botp\b|one[\s-]*time\s*(pass(word)?|pin|code)|verification\s*code|security\s*code|verify.{0,12}\bcode\b)/i;
  // Raises confidence that this is the VTOP mail and not some other service's.
  const CONTEXT = /(vtop|\bvit\b|vitap|academic)/i;

  // VTOP mails the code from exactly one address. Anything else in the tab —
  // another service's verification mail, a quoted older thread — is not our
  // OTP, so a candidate is only accepted if the message it sits in was sent
  // by VTOP. `@vitap.ac.in` / `@vit.ac.in` is allowed alongside the exact
  // address so a change of sender at SDC's end degrades instead of breaking.
  const ANY_ADDR = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const VTOP_ADDR = /^noreply\.sdc@vitap\.ac\.in$|@(vitap|vit)\.ac\.in$/i;
  // Gmail's INBOX LIST renders the display name only — "noreply.sdc", never
  // the address — so matching on addresses alone declared a student mailbox
  // to be the wrong account. The display name has to count as VTOP too.
  const VTOP_ANY =
    /noreply\.sdc(@vitap\.ac\.in)?|[A-Za-z0-9._%+-]+@(vitap|vit)\.ac\.in\b/gi;

  const findAll = (re, text) => {
    const out = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) out.push({ at: m.index, text: m[0] });
    return out;
  };

  // A VTOP address must head the block the code sits in. Deliberately NOT
  // "the nearest address above the code" — Gmail can render a recipient line
  // ("to rutvik@vitstudent.ac.in") between the sender and the body, and that
  // address is not a VTOP one, so a nearest-wins rule would reject the real
  // OTP. A window comfortably larger than one mail is the robust reading.
  const SENDER_WINDOW = 1500;
  const ownedByVtop = (marks, at) =>
    marks.some((mk) => mk.at < at && at - mk.at <= SENDER_WINDOW);

  // Never mistake these for a code: they sit next to OTP wording all the time.
  const isNoise = (digits) => {
    const n = Number(digits);
    // years / "valid for 10 minutes" style numbers / plain clock times
    if (digits.length === 4 && n >= 1900 && n <= 2100) return true;
    return false;
  };

  // Freshness, read rather than assumed. The first live run filled a code
  // from MONTHS back: Gmail renders an open conversation OLDEST FIRST, so in
  // a thread of "VTOP Login OTP Needed" mails the topmost code is the most
  // expired one, and "topmost = newest" only ever held for an inbox list.
  // Both views do render a relative age per message, so that is what decides.
  // VTOP's codes expire in 3 minutes; picking the wrong one is the whole
  // difference between working and not.
  const AGE_RE = /(just now)|(\d{1,3})\s*(sec|min|hour|day)[a-z]*\s*ago/gi;
  // Gmail only prints "x minutes ago" for a while; after that a message header
  // is a bare clock time, and older mail gets a date. Both have to be read, or
  // an hours-old code looks undated — and an undated code used to get filled.
  const CLOCK_RE = /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi;
  // A day number is REQUIRED on both sides of the alternation. Without it,
  // "may" matches inside "maybe" and would date a fresh code as ancient.
  const MONTH = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
  const DATE_RE = new RegExp(
    `\\b(\\d{1,2}\\s+(${MONTH})|(${MONTH})[a-z]*\\.?\\s+\\d{1,2})\\b`,
    "gi"
  );
  const VERY_OLD = 100000; // a dated message is never a live 3-minute code

  const ageMarkers = (text) => {
    const out = [];
    let m;

    AGE_RE.lastIndex = 0;
    while ((m = AGE_RE.exec(text)) !== null) {
      let minutes = 0;
      if (!m[1]) {
        const n = Number(m[2]);
        const unit = m[3].toLowerCase();
        minutes =
          unit === "sec" ? 0 : unit === "min" ? n : unit === "hour" ? n * 60 : n * 1440;
      }
      out.push({ at: m.index, minutes });
    }

    const now = new Date();
    CLOCK_RE.lastIndex = 0;
    while ((m = CLOCK_RE.exec(text)) !== null) {
      let hour = Number(m[1]) % 12;
      if (/pm/i.test(m[3])) hour += 12;
      const when = new Date(now);
      when.setHours(hour, Number(m[2]), 0, 0);
      let minutes = Math.round((now - when) / 60000);
      if (minutes < 0) minutes += 1440; // a time later than now means yesterday
      out.push({ at: m.index, minutes });
    }

    DATE_RE.lastIndex = 0;
    while ((m = DATE_RE.exec(text)) !== null) {
      out.push({ at: m.index, minutes: VERY_OLD });
    }

    out.sort((a, b) => a.at - b.at);
    return out;
  };

  // Gmail puts the timestamp in the message header, above the body, so a
  // candidate's age is the nearest marker BEFORE it.
  const ageAt = (marks, at) => {
    let age = null;
    for (const mk of marks) {
      if (mk.at > at) break;
      age = mk.minutes;
    }
    return age;
  };

  // Strongest OTP wording wins first; then the youngest message; then, when
  // no age is rendered at all (Outlook's reading pane shows one mail and no
  // relative time), the LAST match rather than the first — a thread reads
  // oldest to newest, so the bottom one is the live code.
  const beats = (a, b) => {
    if (a.score !== b.score) return a.score > b.score;
    const ax = a.age === null ? Infinity : a.age;
    const bx = b.age === null ? Infinity : b.age;
    if (ax !== bx) return ax < bx;
    return a.at > b.at;
  };

  const NOTHING = { code: null, ageMin: null, sawVtop: false };

  // Zero-setup alternative to the Gmail API. The inbox list truncates the
  // preview, and Gmail only puts a message body in the DOM once it is opened
  // — so open it, the same way the user would. Done ONLY when the login page
  // explicitly asks (never on a normal scan), and only for a row that is
  // unmistakably VTOP's OTP mail.
  const openVtopMail = () => {
    try {
      const rows = [...document.querySelectorAll("tr, div[role='listitem']")];
      const row = rows.find((r) => {
        const t = r.innerText || "";
        // No "row has no digits" guard here: this only ever runs when the
        // scan found no code, and a date like "Aug 5, 2026" in the row would
        // make such a guard refuse the very mail we want.
        return (
          /noreply\.sdc/i.test(t) && /one[\s-]*time\s*password|\botp\b/i.test(t)
        );
      });
      if (!row) return false;
      // Gmail binds the handler to the row, but clicking the subject cell is
      // the more reliable target across its layouts.
      const target =
        row.querySelector("span[data-thread-id]") ||
        row.querySelector("td.xY") ||
        row.querySelector("td:nth-of-type(5)") ||
        row;
      target.click();
      return true;
    } catch {
      return false;
    }
  };

  const scan = (ignore) => {
    const skip = new Set((ignore || []).map(String));
    const text = (document.body ? document.body.innerText : "").slice(0, 200000);
    if (!text) return NOTHING;
    const marks = ageMarkers(text);
    const vtopMarks = findAll(VTOP_ANY, text);
    const foreignAddrs = findAll(ANY_ADDR, text).filter(
      (a) => !VTOP_ADDR.test(a.text)
    );
    // Three cases, in order:
    //   VTOP mail on the page  -> a code must sit under a VTOP sender
    //   only other senders     -> someone else's mailbox, yield nothing
    //   no sender info at all  -> Outlook's pane can show a display name and
    //                             nothing else; refusing there is worse
    const anyVtop = vtopMarks.length > 0;
    if (!anyVtop && foreignAddrs.length) return NOTHING;

    const digitRe = /\b(\d{4,8})\b/g;
    let best = null;
    let match;
    while ((match = digitRe.exec(text)) !== null) {
      const code = match[1];
      if (skip.has(code) || isNoise(code)) continue;

      const at = match.index;
      // "Andhra Pradesh-522241" in VTOP's own footer is six digits close
      // enough to "One-Time Password" to pass every other filter here.
      if (at >= 2 && text[at - 1] === "-" && /[A-Za-z]/.test(text[at - 2])) continue;
      if (anyVtop && !ownedByVtop(vtopMarks, at)) continue; // not VTOP's mail
      const near = text.slice(Math.max(0, at - 160), at + 160);
      if (!KEYWORDS.test(near)) continue;

      // A keyword sitting right beside the number is far stronger evidence
      // than one merely in the same paragraph.
      const tight = text.slice(Math.max(0, at - 40), at + 40);
      let score = 0;
      if (code.length === 6) score += 3; // VTOP's format, and the common one
      if (KEYWORDS.test(tight)) score += 2;
      if (CONTEXT.test(near)) score += 2;
      // Anything but a 6-digit code needs the keyword adjacent, or we are
      // almost certainly reading a phone number / amount / reference id.
      if (code.length !== 6 && !KEYWORDS.test(tight)) continue;

      const cand = { code, score, at, age: ageAt(marks, at) };
      if (!best || beats(cand, best)) best = cand;
    }
    // sawVtop true with code null is the Gmail INBOX LIST: VTOP's mail is
    // right there but the preview truncates at "Use the OTP below…", so the
    // digits are genuinely not in the page. The caller turns that into "open
    // the mail" rather than a pointless countdown.
    return {
      code: best ? best.code : null,
      ageMin: best ? best.age : null,
      sawVtop: anyVtop,
    };
  };

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (seq !== window.__vtopextMailScanSeq) return; // superseded by a newer copy
    if (!request || request.message !== "vtopext_scan_otp") return;
    // sawVtop lets the caller tell three states apart: wrong mailbox, right
    // mailbox but the code isn't rendered (inbox list), and code in hand.
    let hit = NOTHING;
    try {
      hit = scan(request.ignore);
    } catch (error) {
      console.warn("VTOP Extension OTP scan failed", error);
    }
    // Asked for, and nothing readable here, but VTOP's mail is on the page:
    // open it so the next poll can read the body.
    let opened = false;
    if (request.autoOpen && !hit.code && hit.sawVtop) opened = openVtopMail();

    sendResponse({
      code: hit.code,
      ageMin: hit.ageMin,
      sawVtop: hit.sawVtop,
      opened,
      host: location.host,
    });
    return true;
  });
})();
