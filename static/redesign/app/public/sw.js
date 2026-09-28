// Aurora service worker.
//
// DELIBERATELY no 'fetch' handler and no caches, ever. The server rebuilds
// and atomically REPLACES the SPA bundle on every deploy (up to every 5
// minutes via aurora-update.timer) and deletes the old files, so any asset a
// service worker held onto would outlive the bundle it came from — the
// "stale site" failure class this design forbids by construction. Full
// rationale: docs/push.md. A repo test pins
// the absence of a fetch listener; do not add one.
//
// This file's URL is its identity (/v2/sw.js) — never rename or hash it. It
// is served with `Cache-Control: no-cache`, so browsers revalidate it on
// navigation and updates take effect within one page load of a deploy.

self.addEventListener('install', () => {
  // Take over from any previous worker version immediately — with no fetch
  // handler there is no in-flight state a waiting phase would protect.
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  // Claim open clients so the page that registered us is controlled without
  // a reload — push subscriptions created right after first registration
  // then belong to this worker.
  event.waitUntil(self.clients.claim())
})

// ── Push delivery (see docs/push.md) ──────────────
//
// The payload is the declarative-web-push envelope:
//   { web_push: 8030, notification: {title, body, navigate, app_badge},
//     aurora: {type, notification_id, link} }
// iOS ≥18.4 renders it without ever waking this worker; here we parse the
// same object for Chrome/Firefox/older Safari. Field names are mirrored
// from internal/push/payload.go — change them together.

self.addEventListener('push', event => {
  let env
  try {
    env = event.data ? event.data.json() : null
  } catch {
    env = null
  }
  const note = env && env.notification
  if (!note || !note.title) return // unrecognized payload — show nothing

  event.waitUntil((async () => {
    // Badging is independent of whether we show a banner.
    if ('setAppBadge' in navigator && typeof note.app_badge === 'number') {
      try {
        if (note.app_badge > 0) await navigator.setAppBadge(note.app_badge)
        else await navigator.clearAppBadge()
      } catch { /* badging is a nicety */ }
    }

    // Foreground policy (D9): a focused Aurora window means the WS toast is
    // already delivering this moment in-app — a simultaneous OS banner would
    // be a double tap on the shoulder. (iOS's declarative path can't make
    // this call; accepted platform difference.)
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (wins.some(w => w.focused)) return

    const aurora = env.aurora || {}
    await self.registration.showNotification(note.title, {
      body: note.body || '',
      icon: '/v2/icon-192.png',
      badge: '/v2/badge-96.png',
      // One tag per stored notification: a re-send replaces, never stacks.
      tag: 'aurora-' + (aurora.notification_id || 'generic'),
      data: { link: aurora.link || note.navigate || '/v2/' },
    })
  })())
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const link = (event.notification.data && event.notification.data.link) || '/v2/'
  event.waitUntil((async () => {
    // Direct media links (/api/... — e.g. the highlight-reel MP4) open as
    // plain navigations; the httpOnly auth cookie rides along exactly as it
    // does for the bell's anchor today.
    if (link.startsWith('/api/')) {
      await self.clients.openWindow(link)
      return
    }
    // SPA routes: reuse an existing Aurora window when there is one.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins.find(w => w.url.includes('/v2'))
    if (win) {
      await win.focus()
      // navigate() can be refused (cross-origin redirect in history, etc.) —
      // fall back to a fresh window rather than doing nothing.
      try {
        await win.navigate(link)
        return
      } catch { /* fall through */ }
    }
    await self.clients.openWindow(link)
  })())
})

self.addEventListener('pushsubscriptionchange', event => {
  // Unreliable across browsers (the robust answer is the boot-time re-POST,
  // lib/push.ts), but when it does fire, re-subscribing here keeps the
  // channel alive without a visit. The POST authenticates via the httpOnly
  // access cookie — this fetch CALL is not a fetch HANDLER (D1 intact).
  event.waitUntil((async () => {
    try {
      const key = event.oldSubscription && event.oldSubscription.options
        ? event.oldSubscription.options.applicationServerKey
        : null
      if (!key) return
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      })
      await fetch('/api/me/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      })
    } catch { /* best-effort; the next app boot re-POSTs regardless */ }
  })())
})
