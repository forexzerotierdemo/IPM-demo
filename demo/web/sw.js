/* PestCare CRM service worker — offline app shell for field agents.
 * Strategy:
 *  - Supabase (cross-origin) and non-GET: always go to network. The page's
 *    offline queue handles mutations; API responses are never cached.
 *  - same-origin GET of the app's own code (/, /index.html, /js/*, /css/*):
 *    NETWORK FIRST with a 3s ceiling, cache only as the offline fallback.
 *  - other same-origin GETs (icons, logo, pdf.js, jsQR): stale-while-revalidate.
 *  - navigations: fall back to the cached shell when offline.
 */
const VERSION = "pestcare-63d9fbfef6ab";
const SHELL = [
  "/",
  "/index.html",
  "/css/styles.css",
  // Supabase edition: the client library and the endpoint config are part
  // of the shell now, so the app still boots on a phone with no signal.
  "/js/supabase.js",
  "/js/config.js",
  "/js/i18n.js",
  "/js/offline.js",
  "/js/store.js",
  "/js/api.js",
  "/js/qrcode.js",
  // decoder for the in-app scanner; precached so it still loads in the field
  // (app.js only injects the <script> when the camera dialog opens)
  "/js/jsqr.js",
  "/js/app.js",
  "/js/nav-extra.js",
  "/foxsyslogo.png",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/favicon-32.png",
  "/icons/favicon-16.png",
];

// `cache: "reload"` on every one of these: a precache that is allowed to read
// the browser's own HTTP store can install a copy of the app that is hours old
// and call it the new version. See the fetch handler below for the whole story.
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
    await nudgeClients();
  })());
});

// Pages that are ALREADY OPEN are still running the previous app.js and have no
// idea new code exists. In the Android app that page can live for days: the
// WebView restores it on resume instead of navigating, pull-to-refresh is off,
// and the CRM's own ↻ button only re-fetches data. That is how a web-only fix —
// the app's whole deployment model — could ship and never arrive on a phone.
//
// So the new worker tells every open page that an update landed. A page new
// enough to understand it acks and reloads itself at a safe moment (never over
// someone's typing — see applyPendingUpdate in app.js). Anything older cannot
// ack, so it is navigated here after a short grace period; that is the one-time
// cost of getting an install off old code.
const acked = new Set();
async function nudgeClients() {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (!wins.length) return;
  wins.forEach((c) => c.postMessage({ type: "sw-updated", version: VERSION }));
  // Long enough for a page that understands the message to ack (it answers in
  // milliseconds), short enough not to hold activation open.
  await new Promise((r) => setTimeout(r, 1500));
  for (const c of wins) {
    if (acked.has(c.id)) continue;
    // NOT awaited, deliberately: the navigation it starts has to be served by
    // this very worker, and awaiting it here would wait on a request that is
    // itself waiting for this activation to finish — a deadlock that hangs the
    // worker and leaves the page on old code forever.
    try { c.navigate(c.url); } catch (err) { /* nothing else we can do */ }
  }
}
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "sw-update-ack" && e.source) acked.add(e.source.id);
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Never intercept API traffic or cross-origin or non-GET requests.
  // /uploads/ is excluded too: those files are PRIVATE and authorized per file
  // and per user, but Cache Storage is one shared box per origin and cache
  // matching ignores the Authorization header — so a cached photo or PDF would
  // be handed to whoever logs into that phone next, and served stale even after
  // their access is revoked. The cost is that uploaded pictures are no longer
  // viewable offline; a document that must not leak is worth more than that.
  if (req.method !== "GET" || url.origin !== self.location.origin ||
      url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) {
    return; // default browser handling
  }

  // Navigations: try network, fall back to cached shell when offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(() => caches.match("/index.html").then((r) => r || caches.match("/")))
    );
    return;
  }

  // THE APP'S OWN CODE IS FETCHED FROM THE NETWORK FIRST, and only falls back
  // to the cache when the network cannot answer within three seconds.
  //
  // Stale-while-revalidate — the old rule for everything — hands back the
  // CACHED script and refreshes the cache for NEXT time. On a browser that is
  // one stale load and no harm done. In the installed app it is the difference
  // between a fix arriving and not arriving at all: the WebView restores its
  // page instead of navigating, so "next time" may be days away, and every
  // web-side fix shipped in between simply never appears. That is exactly what
  // happened with the ☰ corner, the ✎ on an attachment and the pick lists.
  //
  // The three-second ceiling is what keeps this honest offline: a phone with no
  // signal fails fast and starts from the cache, and an engineer in a basement
  // sees no difference. Everything else (icons, the logo, pdf.js, jsQR) stays
  // stale-while-revalidate: megabytes that almost never change.
  const isCode = url.pathname === "/" || url.pathname === "/index.html" ||
    url.pathname === "/manifest.webmanifest" ||
    (url.pathname.startsWith("/js/") && !url.pathname.startsWith("/js/pdfjs/") &&
     url.pathname !== "/js/jsqr.js") ||
    url.pathname.startsWith("/css/");
  if (isCode) {
    e.respondWith(caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      try {
        const res = await Promise.race([
          // "NETWORK FIRST" HAS TO MEAN THE NETWORK. A plain fetch() is allowed
          // to be answered by the browser's own HTTP cache, and the CDN in front
          // of the CRM was telling that cache to hold the app for four hours —
          // so this fetch looked like it went to the server, came back in a
          // millisecond, and handed the page the same old code, over and over.
          // `cache: "reload"` walks past the HTTP store and asks the server.
          // The origin now says no-store as well (server.py), so this is belt
          // and braces: either one alone is enough to get a fix onto a phone.
          fetch(req, { cache: "reload" }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 3000)),
        ]);
        if (res && res.status === 200 && res.type === "basic") cache.put(req, res.clone());
        return res;
      } catch (err) {
        if (cached) return cached;
        throw err;
      }
    }));
    return;
  }

  // Everything else: stale-while-revalidate.
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
