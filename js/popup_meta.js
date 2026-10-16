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

  /*
   * Update check. An unpacked extension never updates itself and Chrome's
   * `update_url` only works for Web Store installs, so the one thing that can
   * be done is to LOOK: read the manifest on the default branch and say so
   * when it is newer than the running copy. raw.githubusercontent.com sends
   * `Access-Control-Allow-Origin: *`, so this needs no host permission.
   * At most one request every six hours; any failure is silent.
   */
  // Where "the project" lives comes from /config.json, not from this file.
  const loadConfig = async () => {
    try {
      const res = await fetch(chrome.runtime.getURL("config.json"));
      return (await res.json()) || {};
    } catch {
      return {};
    }
  };
  const CHECK_KEY = "vtopext_update_check";
  const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

  const isNewer = (remote, local) => {
    const a = String(remote).split(".").map((n) => parseInt(n, 10) || 0);
    const b = String(local).split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return false;
  };
  window.vrIsNewerVersion = isNewer;

  let RELEASES = "";
  const showUpdate = (remote) => {
    const box = document.getElementById("vr-update");
    if (!box) return;
    box.hidden = false;
    box.textContent = "";
    const text = document.createElement("span");
    text.textContent = `v${remote} is available. `;
    const link = document.createElement("a");
    link.href = RELEASES;
    link.textContent = "Download it";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: RELEASES });
    });
    const how = document.createElement("div");
    how.className = "vr-hint";
    how.textContent =
      "Unzip over the old folder, then press reload on VTOP Extension at chrome://extensions.";
    box.append(text, link, how);
  };

  const checkForUpdate = async (config) => {
    if (!config.repo) return; // no project configured: nothing to compare with
    const branch = config.branch || "master";
    const RAW_MANIFEST = `https://raw.githubusercontent.com/${config.repo}/${branch}/manifest.json`;
    RELEASES = `https://github.com/${config.repo}/releases/latest`;
    let local;
    try {
      local = chrome.runtime.getManifest().version;
      const stored = (await chrome.storage.local.get(CHECK_KEY))[CHECK_KEY] || {};
      let remote = stored.version;
      if (!stored.at || Date.now() - stored.at > CHECK_EVERY_MS) {
        const res = await fetch(RAW_MANIFEST, { cache: "no-store" });
        if (!res.ok) return;
        remote = (await res.json()).version;
        await chrome.storage.local.set({ [CHECK_KEY]: { at: Date.now(), version: remote } });
      }
      if (remote && isNewer(remote, local)) showUpdate(remote);
    } catch {
      /* offline, rate-limited, or not an extension context: say nothing */
    }
  };

  // footer links, from the same config
  const links = (config) => {
    if (!config.repo) return;
    const set = (id, href) => {
      const a = document.getElementById(id);
      if (a) {
        a.href = href;
        a.hidden = false;
      }
    };
    set("vr-link-repo", `https://github.com/${config.repo}`);
    set("vr-link-issues", `https://github.com/${config.repo}/issues`);
  };

  version();
  openVtop();
  loadConfig().then((config) => {
    links(config);
    checkForUpdate(config);
  });
})();
