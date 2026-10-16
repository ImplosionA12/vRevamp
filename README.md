# vRevamp

A Chrome extension that makes the VIT-AP VTOP portal faster and more useful.
Works on `vtop.vitap.ac.in` (and `web.vitap.ac.in`).

## What it does

- **Fills the login captcha** for you, and can fetch the login OTP from your mail.
- **Signs-in helper**: save your ID and password in the popup and the login page is
  filled with them instead of Chrome's saved ones (it never presses Sign in for you;
  stored unencrypted on your computer).
- **Auto-picks the current semester** on Attendance, Marks, Time Table, DA Upload
  and Exam Schedule, so you stop choosing it every time.
- **Attendance**: how many classes you can still skip, per subject, before each
  CAT/FAT and the 75% debar line, plus a skip planner for a date range.
- **Home card**: days to CAT-1/CAT-2/FAT, the next holiday, and subjects close to debar.
- **Digital Assignments**: shows what you owe and when, with reminders.
- **Exam Schedule**: download as `.ics`, get Chrome notifications before each exam,
  or have the extension email you 24 h and 2 h before (no Google sign-in).
- **Time Table**: export to `.ics` / Google Calendar, a "next class" card, PNG download.
- **Grades**: a what-if CGPA calculator on Grade History, and marks needed for the
  next grade using each subject's own cutoffs.
- **Leave**: tells you when a General Outing request gets approved.

Your VTOP password and data stay in your browser. Something leaves it only when you
press a button that needs it: the Calendar and Gmail buttons talk to Google (and ask you
to sign in first), and "Mail me the list now" sends that one email through a small
relay run by the project, unless you switch the relay off in the popup.

## Install (GitHub)

1. Open the [latest release](https://github.com/ImplosionA12/vRevamp/releases/latest)
   and download the source zip, then unzip it somewhere permanent
   (Chrome reads the extension from that folder, so do not delete it).
2. Go to `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped folder (the one containing `manifest.json`).

## Update

Unpacked extensions never update themselves. The popup shows **"vX is available"**
when a newer version is on GitHub. To update:

1. Download the new release and unzip it **over the old folder** (same location).
2. Go to `chrome://extensions` and press the **reload** (circular arrow) button on vRevamp.
3. Reload any open VTOP tab.

If something stops working after you changed or re-downloaded files, step 2 is
the first thing to try: Chrome keeps running the old code until you reload.

## Troubleshooting

- A section "does nothing" or the page keeps loading: reload the extension and the VTOP tab.
- Google sign-in shows an "unverified app" screen: choose **Advanced > Continue**.
- Report issues at <https://github.com/ImplosionA12/vRevamp/issues>.

## Configuration

`config.json` (next to `manifest.json`) holds the two deployment settings: the
GitHub `repo` / `branch` the popup checks for updates, and the `mailRelayUrl`
that "Mail me the list now" sends through. Leave `mailRelayUrl` blank to send
from your own Gmail instead.

## Develop

```
npm install
npm run lint
npm test        # about 5 minutes; drives the content scripts in a headless browser
```

Changes are logged in [changes.md](changes.md); open work is in [ROADMAP.md](ROADMAP.md).

## Credits and licence

Started from [sanjay7178/vRevamp](https://github.com/sanjay7178/vRevamp) and
substantially reworked. Licensed under GPL-3.0, see [LICENSE](LICENSE).
