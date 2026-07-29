// Aurora service worker.
//
// DELIBERATELY minimal: no 'fetch' handler, no caches, ever. The server
// rebuilds and atomically REPLACES the SPA bundle on every deploy (up to
// every 5 minutes via aurora-update.timer) and deletes the old files, so any
// asset a service worker held onto would outlive the bundle it came from —
// the "stale site" failure class this design forbids by construction. Full
// rationale: do/pwa-push/IMPLEMENTATION.md (decision D1). A repo test pins
// the absence of a fetch listener; do not add one.
//
// This file's URL is its identity (/v2/sw.js) — never rename or hash it. It
// is served with `Cache-Control: no-cache`, so browsers revalidate it on
// navigation and updates take effect within one page load of a deploy.
//
// Push and notification-click handlers arrive with Phase 2.

self.addEventListener('install', () => {
  // Take over from any previous worker version immediately — with no fetch
  // handler there is no in-flight state a waiting phase would protect.
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  // Claim open clients so a future push subscription created right after
  // first registration is owned by this worker without a reload.
  event.waitUntil(self.clients.claim())
})
