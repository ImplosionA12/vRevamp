// Heal the Tomcat-404 wall (seen live 2026-07-06). Two distinct causes:
//
// 1. LIVE session: VTOP serves a raw 404 on /vtop/login whenever a session
//    cookie exists (instead of redirecting a logged-in visitor) — so opening
//    the site's front door while logged in dead-ends. Bounce to /vtop/content
//    and never touch the cookies.
// 2. DEAD session: a stale/poisoned cookie makes core paths 404 WITH cookies
//    while the same URLs answer 200 without them, locking the browser out
//    until the site's cookies are cleared. Only that both-sides-confirmed
//    signature triggers a cookie clear + reload.
//
// Both actions are capped at 2 attempts per tab (sessionStorage), so a
// genuinely broken server (404 with AND without cookies) is left alone and
// this can never turn into a reload loop.
(() => {
  const REPAIR_KEY = "vrevamp_session_repairs";
  let store = null;
  try {
    store = window.sessionStorage;
  } catch {
    return; // sandboxed document: can't cap attempts, so never act
  }
  const text = document.body ? document.body.innerText : "";
  const isTomcat404 =
    /HTTP Status 404/.test(text) && /Apache Tomcat/i.test(text);
  if (!isTomcat404) {
    store.removeItem(REPAIR_KEY);
    return;
  }
  const attempts = Number(store.getItem(REPAIR_KEY)) || 0;
  if (attempts >= 2) return;
  (async () => {
    let contentStatus;
    try {
      contentStatus = (
        await fetch("/vtop/content", { credentials: "include", cache: "no-store" })
      ).status;
    } catch {
      return; // network trouble — not ours to fix
    }
    if (contentStatus === 200) {
      // session is alive; this URL is just a dead end for logged-in users
      store.setItem(REPAIR_KEY, String(attempts + 1));
      setTimeout(() => window.location.replace("/vtop/content"), 300);
      return;
    }
    let withCookies, withoutCookies;
    try {
      withCookies = (
        await fetch(location.href, { credentials: "include", cache: "no-store" })
      ).status;
      withoutCookies = (
        await fetch(location.href, { credentials: "omit", cache: "no-store" })
      ).status;
    } catch {
      return;
    }
    if (withCookies !== 404 || withoutCookies !== 200) return;
    store.setItem(REPAIR_KEY, String(attempts + 1));
    chrome.runtime.sendMessage({ message: "clear_site_cookies" }, (cleared) => {
      if (chrome.runtime.lastError || !cleared) return;
      setTimeout(() => window.location.reload(), 300);
    });
  })();
})();
