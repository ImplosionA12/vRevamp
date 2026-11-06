# Privacy Policy - VTOP Extension (unofficial)

_Last updated: 2026-11-06. DRAFT - fill in the contact line and host this page at a public URL before submitting to the Chrome Web Store._

VTOP Extension is an independent, unofficial helper for VIT-AP students. It is not made by, endorsed by, or affiliated with VIT or the VTOP portal.

**Short version:** the extension has no server of its own, no analytics, no ads, and does not sell or share data. Everything it stores stays in your browser. The only data that leaves your browser goes to services you choose to turn on (Google Calendar, Gmail, or a mail relay you deploy yourself) and to VIT's own sites.

## What is stored on your device

Stored in `chrome.storage.local` (and the VTOP page's own `localStorage` for offline pages). It never leaves your browser unless a feature below says so.

- **Saved timetable, attendance, marks, exam schedule and grade pages** - copies of pages you opened on VTOP, so they can be shown offline and used for calculators.
- **Saved logins (optional, only if you enter them):** your VTOP register number and password for auto-fill, and your hostel Wi-Fi username and password. These are stored **unencrypted** in extension storage on this device, like any other saved extension setting. They are only ever sent to the matching VIT login pages (VTOP or the hostel firewall) and nowhere else. Remove them at any time from the popup, or by removing the extension.
- **Settings and state** - reminder preferences, the last calendar-import record, and similar flags.

## What leaves your browser, and where it goes

| Feature | What is sent | To whom |
|---|---|---|
| Using VTOP | Normal VTOP requests, plus the login you entered | VIT sites (`vitap.ac.in`, `vit.ac.in`) |
| Hostel Wi-Fi login | Your Wi-Fi username and password, over HTTPS | `hfw.vitap.ac.in` (VIT's firewall) |
| Google Calendar import (optional) | Your timetable as calendar events; Google sign-in is handled by Chrome's identity API | Google Calendar API |
| Gmail reminders (optional) | Reminder email text, sent to your own address | Gmail API (Google), using your Google sign-in |
| Mail relay (optional) | Your email address and the reminder or digest text | A Google Apps Script web app **that you deploy yourself** and paste into the popup. The developer does not operate any relay. |

The extension requests the Google Calendar scope only to create, update and delete the timetable events it created. Google sign-in tokens are kept by Chrome and are not copied into extension storage.

## Webmail access and OTP autofill

If you use the OTP autofill feature, the extension runs on `mail.google.com`, `outlook.office.com`, `outlook.office365.com` and `outlook.live.com`. On those pages it looks only for the one-time VTOP verification code in the visible messages and passes the code to the VTOP login tab. It does not store or transmit your mailbox contents, and nothing from webmail is sent anywhere except that code to the VTOP login page on your own machine.

## Captcha and login autofill

On the VTOP login page the extension can read the login captcha image locally, using a small recognition model that ships inside the extension, and type the result into the captcha box. It can also fill your saved register number and password. Nothing from the captcha is sent anywhere. The extension may click VTOP's "Student" role button and reload the login page until a captcha appears, but it only focuses the final Sign-in button; you press it. You can leave the saved login empty to turn the fill off.

## Cookies

The `cookies` permission is used only to clear VIT site cookies when you ask for a session reset or to repair a broken login session. Cookies are not read for any other purpose and are not sent anywhere.

## Notifications and background activity

Reminders and the optional daily digest use alarms and notifications. The digest is off unless you turn it on.

## What we do not do

- No analytics, tracking, advertising, or profiling.
- No selling, renting or sharing of data.
- No remote code: all code ships inside the extension package.
- No collection of browsing history.

## Your control

Disable features in the popup, clear saved logins, or remove the extension; removing it deletes everything stored locally. You can revoke Google access at https://myaccount.google.com/permissions.

## Children

The extension is meant for university students and is not directed at children.

## Changes

Material changes will be noted here and in `changes.md`, with a new "Last updated" date.

## Contact

Developer: ImplosionA12 - https://github.com/ImplosionA12/vRevamp (open an issue)
