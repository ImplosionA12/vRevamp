# Extension Review - VTOP Extension v1 (2026-11-05)

Method: the `extension-review` checklist from quangpl/browser-extension-skills,
run by hand with grep/jq on this folder (third-party `js/modules/dom-to-image.js`
excluded). Static read only; nothing was exercised against the Web Store.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 3 |
| MEDIUM   | 3 |
| PASS     | 8 |

**Verdict: NEEDS FIXES** (for a Web Store submission; fine for unpacked campus use).

## HIGH

### Missing privacy policy (Purple Lithium)
- Root cause: no `privacy_policy` field and no policy file/README section, yet the
  extension uses `chrome.storage`, `identity`, `cookies`, and sends the student's
  email address plus reminder/digest content to a Google Apps Script mail relay.
- Files: manifest.json, service_worker/background.js (sendMailViaRelay ~L753).
- Fix: publish a short policy (what is stored locally, what the relay receives,
  that VTOP credentials never leave the browser) and link it in the listing.

### Undisclosed sensitive access (Purple Nickel / Purple Magnesium)
- Root cause: host permissions for mail.google.com, outlook.office.com, outlook.live.com
  (reads open webmail tabs to find the login OTP), plus `cookies` (clears site cookies).
- Files: manifest.json host_permissions; js/otp/mail_scan.js; background.js `clear_site_cookies`.
- Fix: disclose both in the listing and policy; keep the sender.url gating (tightened today).

### Weak / non-matching description (Yellow Zinc / Red Nickel)
- Root cause: description is "Enhancing the better way to use VTOP", version is "1",
  name is "VTOP Extension". The real feature set (calendar import, email reminders,
  hostel Wi-Fi login, OTP autofill) is not described.
- Fix: write a specific description listing the features; use a semver version.

## MEDIUM
- **Single purpose (Red Magnesium):** hostel Wi-Fi login (js/wifi/hostel.js -> hfw.vitap.ac.in)
  is unrelated to VTOP; consider splitting or justifying as "VIT-AP student tools".
- **Naming (Red Copper):** uses the VTOP name and a VIT domain list; make clear it is unofficial.
- **Notifications (Yellow Nickel):** reminders/digest use priority 2 + requireInteraction;
  acceptable, but keep the digest opt-in (it is) and avoid more sticky notifications.

## PASS
- Remote code: no eval/new Function/external scripts/importScripts.
- Obfuscation: only `btoa`/`atob`/`fromCharCode` in background.js for UTF-8 base64 of MIME - benign.
- Permissions: every declared permission is used (tabs, cookies, webRequest, downloads, identity,
  scripting, alarms, notifications, storage). No `<all_urls>`.
- HTTPS only; Wi-Fi password is POSTed in the body over HTTPS, not put in a URL.
- No crypto mining, no download-helper/paywall bypass, no history tracking (only tabs.onUpdated
  for the extension's own flows), icons present.
