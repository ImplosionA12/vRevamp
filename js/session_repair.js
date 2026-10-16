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
  const REPAIR_KEY = "vtopext_session_repairs";
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

/*
 * The third session state: shell healthy, content POSTs 404.
 *
 * The block above can only judge the document, and in this state the document
 * is fine — 200s, the student's name in the top bar, no Tomcat page anywhere.
 * What is broken is invisible from here: every menu click POSTs and gets a 404,
 * so the content area just goes blank. VTOP makes those calls with jQuery in
 * the page's MAIN world, which an isolated-world content script cannot see, so
 * the detection lives in the service worker (see "shell healthy, content POSTs
 * 404" in background.js) and arrives as a message.
 *
 * All this end does is say so, once, and offer the only recovery there is.
 *
 * Why the button clears cookies first: a fresh sign-in is the fix, but sending
 * someone to /vtop/login while the bad cookie is still in the jar is exactly
 * the dead end the poisoned-cookie heal above exists for — VTOP answers that
 * URL with a 404 whenever a session cookie is present. Dropping the cookies
 * makes it serve the real login form. It is the same worker route the heal
 * uses, and it touches nothing but this site's cookies.
 *
 * Deliberately NOT automatic. Clearing cookies under someone mid-page would
 * throw away a form they were filling in, and this detector infers a broken
 * session from three refusals rather than knowing it. A button lets the
 * student decide, and costs nothing if the inference was wrong.
 */
(() => {
  const relogin = () => {
    const go = () => window.location.assign("/vtop/login");
    try {
      chrome.runtime.sendMessage({ message: "clear_site_cookies" }, () => {
        // whether or not the clear succeeded, the login page is where they
        // need to be — never strand them on the banner
        void chrome.runtime.lastError;
        go();
      });
    } catch {
      go(); // extension context gone (reloaded/updated mid-session)
    }
  };

  chrome.runtime.onMessage.addListener((request) => {
    if (!request || request.message !== "session_dead") return;
    if (typeof window.vrVtop === "undefined" || !window.vrVtop.banner) return;
    // vrVtop's own circuit breaker may have already drawn this banner from the
    // requests VTOP Extension sends; banner() is keyed on its id and returns null
    // rather than stacking a second one.
    window.vrVtop.banner(
      `VTOP refused ${request.failures || 3} page requests in a row (HTTP 404) ` +
        "while your session still looks signed in. That is what a session that " +
        "has gone stale on the server looks like — clicking menu items will " +
        "keep coming back blank until you sign in again. ",
      { label: "Sign in again", run: relogin }
    );
  });
})();
