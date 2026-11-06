/*
 * VTOP Extension mail relay — a free Google Apps Script web app.
 *
 * WHY THIS EXISTS
 * ---------------
 * VTOP Extension's 📧 button sends through the student's own Gmail, so the mail
 * arrives "from me, to me". To send from a dedicated VTOP Extension address instead,
 * something has to hold that mailbox's credential — and it cannot be the
 * extension, because everything shipped inside an extension is readable by
 * every user who installs it.
 *
 * An Apps Script web app solves that without a server: it is hosted by Google,
 * it runs AS the account that deployed it, and the credential never leaves
 * Google. No hosting bill, no domain, no DNS records — which is why a plain
 * @gmail.com sender is the sensible choice here.
 *
 *
 * SETUP  (about five minutes, once)
 * ---------------------------------
 *  1. Make the sender account, e.g. veramp.mailer@gmail.com. Everything below
 *     happens while signed in AS that account — this is the address students
 *     will see in their From line.
 *
 *  2. script.google.com → New project. Delete the placeholder, paste this file.
 *     Give the project a name you will recognise later.
 *
 *  3. Deploy → New deployment → gear icon → Web app.
 *       Description:      VTOP Extension mail relay
 *       Execute as:       Me (veramp.mailer@gmail.com)     <- must be "Me"
 *       Who has access:   Anyone                           <- must be "Anyone"
 *     "Anyone" here means unauthenticated callers, which is what the extension
 *     is. It does NOT give anyone access to the mailbox.
 *
 *  4. Authorise it when prompted. You will meet the "Google hasn't verified
 *     this app" screen — this is your own script, so Advanced → Go to … is
 *     correct here.
 *
 *  5. Copy the /exec URL and paste it into MAIL_RELAY_URL in
 *     service_worker/background.js. Reload the extension.
 *
 * To change the script later you must Deploy → Manage deployments → edit the
 * EXISTING deployment. Creating a new one issues a new URL and silently breaks
 * every installed copy.
 *
 *
 * QUOTA
 * -----
 * A consumer @gmail account gets 100 MailApp recipients/day; Google Workspace
 * gets 1500. `getRemainingDailyQuota()` is checked before every send so the
 * failure is a clear message rather than a silent drop.
 *
 *
 * ABUSE — read this before deploying
 * ----------------------------------
 * The /exec URL ships inside the extension, so it is public. Anyone who
 * extracts it can POST to it. That is inherent to sending from one identity on
 * behalf of an app with no accounts system; the mitigations here are limits,
 * not prevention:
 *
 *   - a per-recipient daily cap, so one address cannot be flooded
 *   - a global daily cap well under the Gmail quota, so an abuser cannot
 *     exhaust the day's sends and silence real reminders
 *   - subject and body length caps
 *   - the sender is fixed; the caller only ever chooses the recipient
 *
 * For a personal or single-campus build that is proportionate. A public Chrome
 * Web Store release should issue a per-user token from something stateful and
 * verify it here.
 */

// ---- limits -------------------------------------------------------------
var MAX_PER_RECIPIENT_PER_DAY = 12;
var MAX_TOTAL_PER_DAY = 60; // deliberately below the 100/day Gmail quota
var MAX_SUBJECT = 200;
var MAX_BODY = 60000;

function doPost(e) {
  try {
    var raw = e && e.postData && e.postData.contents;
    if (!raw) return reply({ ok: false, error: "empty request" });

    var req = JSON.parse(raw);
    var to = String(req.to || "").trim();

    // Scheduled mail: see the SCHEDULING section below.
    if (req.cancelPrefix) return reply(cancelQueued_(to, String(req.cancelPrefix)));
    var subject = String(req.subject || "VTOP Extension").slice(0, MAX_SUBJECT);
    var html = String(req.html || "").slice(0, MAX_BODY);
    var text = String(req.text || "").slice(0, MAX_BODY);

    // one address, basic shape check — no CC, no BCC, no comma lists
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to))
      return reply({ ok: false, error: "invalid recipient" });
    if (!html && !text) return reply({ ok: false, error: "empty body" });

    if (req.sendAt) return reply(queueMail_(req, to, subject, html, text));

    var gate = withinLimits_(to, new Date());
    if (!gate.ok) return reply(gate);

    if (MailApp.getRemainingDailyQuota() < 1)
      return reply({ ok: false, error: "the VTOP Extension mailbox has hit its daily Gmail quota" });

    MailApp.sendEmail({
      to: to,
      subject: subject,
      body: text || html.replace(/<[^>]*>/g, " "),
      htmlBody: html || undefined,
      name: "VTOP Extension",
    });

    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

// A GET is handy for checking the deployment is alive without sending anything.
function doGet() {
  return reply({
    ok: true,
    service: "VTOP Extension mail relay",
    quotaLeft: MailApp.getRemainingDailyQuota(),
    // The extension only hands over scheduled mail when BOTH are true. An old
    // relay would ignore `sendAt` and mail it immediately, so the capability
    // has to be announced, never assumed.
    scheduling: true,
    schedulerInstalled: schedulerInstalled_(),
  });
}

/*
 * Counters in script properties, bucketed by UTC date so they reset on their
 * own and nothing has to be cleaned up. A LOCK is taken because two students
 * opening VTOP at once genuinely do run this concurrently, and read-then-write
 * without one would undercount.
 */
function withinLimits_(to, when) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (e) {
    return { ok: false, error: "relay busy, try again" };
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var day = Utilities.formatDate(when || new Date(), "UTC", "yyyy-MM-dd");
    var totalKey = "n:" + day;
    var toKey = "r:" + day + ":" + to.toLowerCase();

    var total = Number(props.getProperty(totalKey) || 0);
    if (total >= MAX_TOTAL_PER_DAY)
      return { ok: false, error: "relay daily limit reached, try tomorrow" };

    var mine = Number(props.getProperty(toKey) || 0);
    if (mine >= MAX_PER_RECIPIENT_PER_DAY)
      return { ok: false, error: "too many mails to this address today" };

    props.setProperties({ [totalKey]: String(total + 1), [toKey]: String(mine + 1) });
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/*
 * SCHEDULING — mail that arrives even when Chrome is closed
 * ---------------------------------------------------
 * A chrome.alarms reminder only fires while the browser is running. A student
 * who closes Chrome the evening before an exam used to get the mail at the next
 * launch at best, and nothing at all once the exam had started. Google's servers
 * are always on, so the extension hands the mail over here with a `sendAt` time
 * and a time-driven trigger delivers it.
 *
 * ONE-TIME SETUP, after pasting this version and redeploying: open the script
 * editor, choose `setup` in the function dropdown and press Run. It asks for
 * one extra permission (managing this script's own triggers).
 *
 * Keys are idempotent: queueing the same (to, key) again REPLACES the earlier
 * entry, so a retried request cannot send twice. Counters are charged to the
 * day the mail will be SENT, not the day it was queued.
 */
var MAX_QUEUE_AHEAD_MS = 120 * 24 * 3600 * 1000;
var STALE_AFTER_MS = 6 * 3600 * 1000; // a mail this late is yesterday's news
var MAX_QUEUED_BODY = 8000; // script properties cap a value at ~9 KB

function queuedProp_(to, key) {
  var d = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    to.toLowerCase() + "|" + key
  );
  return "q:" + Utilities.base64EncodeWebSafe(d).slice(0, 32);
}

function queueMail_(req, to, subject, html, text) {
  var key = String(req.key || "").slice(0, 100);
  var at = Number(req.sendAt);
  var now = Date.now();
  if (!key) return { ok: false, error: "missing key" };
  if (!isFinite(at) || at < now - 60000 || at > now + MAX_QUEUE_AHEAD_MS)
    return { ok: false, error: "sendAt out of range" };

  var props = PropertiesService.getScriptProperties();
  var prop = queuedProp_(to, key);
  // Re-queueing an existing key is a replace, not a new mail: don't charge twice.
  if (!props.getProperty(prop)) {
    var gate = withinLimits_(to, new Date(at));
    if (!gate.ok) return gate;
  }
  var item = {
    to: to,
    key: key,
    at: at,
    until: isFinite(Number(req.until)) ? Number(req.until) : null,
    subject: subject,
    text: text.slice(0, MAX_QUEUED_BODY),
    html: html.length <= MAX_QUEUED_BODY ? html : "",
  };
  props.setProperty(prop, JSON.stringify(item));
  return { ok: true, queued: true };
}

function cancelQueued_(to, prefix) {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var n = 0;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf("q:") !== 0) return;
    try {
      var it = JSON.parse(all[k]);
      if (it.to.toLowerCase() === to.toLowerCase() && String(it.key).indexOf(prefix) === 0) {
        props.deleteProperty(k);
        n++;
      }
    } catch (e) {
      props.deleteProperty(k); // unreadable entry: never let it jam the queue
    }
  });
  return { ok: true, cancelled: n };
}

// Run by the time-driven trigger. Cheap when the queue is empty.
function dispatchDue() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return; // the next tick will pick it up
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties();
    var now = Date.now();
    Object.keys(all).forEach(function (k) {
      if (k.indexOf("q:") !== 0) return;
      var it;
      try {
        it = JSON.parse(all[k]);
      } catch (e) {
        props.deleteProperty(k);
        return;
      }
      if (it.at > now) return;
      // Delete BEFORE sending: a crash mid-send then loses one mail instead of
      // repeating it every five minutes.
      props.deleteProperty(k);
      if (now - it.at > STALE_AFTER_MS) return;
      if (it.until && now > it.until) return;
      if (MailApp.getRemainingDailyQuota() < 1) return;
      MailApp.sendEmail({
        to: it.to,
        subject: it.subject,
        body: it.text || String(it.html || "").replace(/<[^>]*>/g, " "),
        htmlBody: it.html || undefined,
        name: "VTOP Extension",
      });
    });
  } finally {
    lock.releaseLock();
  }
}

function schedulerInstalled_() {
  return ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === "dispatchDue";
  });
}

// Run this ONCE from the editor (see SCHEDULING above).
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "dispatchDue") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("dispatchDue").timeBased().everyMinutes(5).create();
}
