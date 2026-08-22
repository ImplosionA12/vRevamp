/*
 * The popup's two pieces of chrome: its version, and the way out to VTOP.
 *
 * This file used to render an "At a glance" summary — attendance headroom,
 * what was still to upload, the next exam — all read from chrome.storage.
 * That was removed on request the day it was written: *"do not givve his class
 * info or anything on the popup, they are popup na they will eb small"*.
 *
 * Right call, and worth keeping the reason rather than the code. A popup is a
 * few hundred pixels that opens on a click and closes on the next one; every
 * number put in it is a number the student has to read in the wrong place,
 * when the same figures already live on the pages that own them — the bunk
 * table, the dues column, the exam schedule — with the room to explain
 * themselves. A summary here would only ever be a worse copy, and a stale one:
 * the popup cannot fetch (no VTOP page means no live _csrf to borrow), so it
 * could only show what was cached at some earlier visit.
 *
 * So the popup does what a popup is good at: settings, and a door.
 */
(() => {
  const version = () => {
    const node = document.getElementById("vr-version");
    try {
      if (node) node.textContent = "v" + chrome.runtime.getManifest().version;
    } catch {
      /* not running in an extension context */
    }
  };

  const openVtop = () => {
    const button = document.getElementById("vr-open-vtop");
    if (!button) return;
    button.addEventListener("click", () => {
      chrome.tabs.create({ url: "https://vtop.vitap.ac.in/vtop/content" });
      window.close();
    });
  };

  version();
  openVtop();
})();
