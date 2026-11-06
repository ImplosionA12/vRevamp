/*
 * Strict sanitizer for saved VTOP HTML that is re-rendered inside EXTENSION
 * pages (offline.html). Those pages run with extension privileges, so a saved
 * <script>, inline on* handler or javascript: URL must never come back to life.
 * Offline views only need tables and text, so this is allow-by-removal of
 * everything executable. Not used for the content-script inserts: there the
 * markup already lives in VTOP's own page and needs its inline handlers.
 */
function vrSafeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html == null ? "" : html), "text/html");
  doc
    .querySelectorAll("script,iframe,frame,object,embed,link,meta,base,form,style")
    .forEach((n) => n.remove());
  doc.body.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
      if (
        name.startsWith("on") ||
        ((name === "href" || name === "src" || name === "action" || name === "formaction" || name === "xlink:href") &&
          /^(javascript|data|vbscript):/.test(value) &&
          !/^data:image\//.test(value))
      ) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}
