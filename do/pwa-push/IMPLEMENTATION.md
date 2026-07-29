# PWA + Web Push — implementation plan

**Goal:** Aurora installs to the home screen like a native app, and notifications
reach users whose tab is closed — new-request alerts for admins, "your movie is
ready" for requesters — riding on the notification substrate that already exists.

Two phases, an independent adversarial review after each (house rule,
`docs/dev-workflow.md` stage 5):

1. **Phase 1 — Installable PWA.** Manifest, icons, meta tags, a deliberately
   minimal service worker, the CSP fix that makes registration possible, and an
   in-app install experience. No push yet. Ships value on its own (home-screen
   app) and is the prerequisite iOS imposes for push.
2. **Phase 2 — Web Push.** VAPID self-provisioning, a `push_subscriptions`
   table, a Go sender, subscribe/test endpoints, service-worker push +
   click handlers, a Settings card, and two new admin notification types.

Scope decisions taken (each trivially reversible at review):

- **Events that push:** the three existing types — `request_available` /
  `request_failed` (requester), `party_reel_ready` (host) — **plus two new
  admin-only types:** `admin_new_request` (a request awaits review) and
  `scan_complete`. Party invites stay live-only toasts (out of scope).
- **Offline story: none, deliberately.** The service worker never intercepts a
  fetch and never caches an asset (§ Design D1 — this is structural, not taste).
- **Install UX:** a Settings card that adapts to what each browser offers — a
  one-tap install button when the browser volunteers its install prompt,
  short "install from the browser menu" steps otherwise, and a step-by-step
  Add-to-Home-Screen guide on iOS (see the Chromium note in § Ecosystem).

---

## 1. Verified current state

Everything below was read first-hand from the tree at `main` (post-#403).

### The substrate that already exists

| Piece | Where | What it gives us |
|---|---|---|
| `notifications` table | `migrations/037_notifications.up.sql`, `044_notification_link.up.sql` | Durable per-user feed: type, title, media_type, request_id, `link`, read_at. Deduped by unique `(user_id, request_id, type)` — **request-linked rows only**: the migration's own comment notes NULL `request_id` rows never collide, so `party_reel_ready` today (and any new type without a request) gets no table-level dedupe. |
| Query layer | `internal/db/queries_notifications.go:16-104` | `CreateNotification` (returns `created=false` on dedupe), list, unread count, mark read. |
| REST feed | `internal/api/notification_handlers.go`; routes `internal/api/router.go:902-904` | `GET /api/me/notifications` (+unread), mark-read, mark-all — the bell UI. |
| Live delivery | `internal/websocket/events.go:22`, consumed at `src/hooks/useRealtime.ts:100-102` | `notification` event via `Hub.BroadcastToUser`. |
| Producer #1 | `internal/api/request_handlers.go:1422-1456` (`notifyRequest`) | Requester notified on `request_available` / `request_failed`. |
| Producer #2 | `internal/watchparty/manager.go:2056-2075` | Host notified on `party_reel_ready`, with a `link` (an `/api/...` media URL — links are not always SPA routes). |
| Single-origin HTTPS | `https://aurorapro.app`, port 8484 behind TLS | Secure context — the hard requirement for SW + Push. |

Push is precisely the missing transport: everything else — events worth sending,
a durable feed to land in, deep links to open — is built.

### Constraints the design must respect

- **The SPA lives under `/v2/`, not `/`.** Vite `base: '/v2/'`
  (`static/redesign/app/vite.config.ts`), output to `static/v2/`; `/` 302-redirects to
  `/v2/` (`internal/api/router.go:296-302`); `v2Handler` serves real files with an
  index.html SPA fallback (`router.go:353-380`). Everything in `public/` deploys
  under `/v2/`. **Consequence:** `sw.js` lands at `/v2/sw.js` with natural scope
  `/v2/` — which covers the entire app. `start_url`, `scope`, and `id` are all
  `/v2/`. No `Service-Worker-Allowed` header games needed. (If the known-future
  "serve V2 at root" change ever happens — `router.go:276-279` — note that Vite
  copies `public/` files **verbatim**: the `/v2/` strings *inside* the manifest
  and the registration call do not follow `base` and must be edited in that
  change, the same way `index.html:10` already hardcodes `/v2/favicon.svg`.
  All such literals will grep for `/v2/`.) The `/static/*` mount
  (`router.go:317-318`) incidentally aliases the same files at `/static/v2/…` —
  inert as long as every reference uses `/v2/…`, which the plan does
  throughout; the manifest content-type fix lives in `v2Handler` only.
- **CSP currently blocks service workers.** `frontendHeaders` sets
  `worker-src blob:` with no `'self'` (`router.go:1189`). Per spec, SW
  registration is governed by `worker-src`, so `register('/v2/sw.js')` would be
  refused today. Phase 1 changes it to `worker-src 'self' blob:` (blob workers —
  used elsewhere — keep working). `manifest-src` is absent → falls back to
  `default-src 'self'`, which is what we want.
- **The auto-updater makes SW caching structurally unsafe.** Every ≤5 min,
  `scripts/aurora-update.sh` rebuilds the SPA, **atomically replaces**
  `/opt/aurora/static` and **deletes the old bundle** after the health check
  (`rm -rf static.old`). Old hashed chunks cease to exist server-side. A
  precaching service worker would keep serving (or failing on) assets from a
  build that's gone — the exact "stale site" failure class we just spent PR #403
  eliminating at the data layer. Hence D1: the SW never caches, never intercepts.
- **Headers are already SW-update-friendly.** The whole static group gets
  `Cache-Control: no-cache, must-revalidate` (`router.go:1170` via `r.Use` at
  `:286`) — including `/v2/sw.js`, so browsers revalidate the worker on every
  navigation and updates propagate within one load of the merge deploying.
- **Auth is Bearer-first with an httpOnly cookie fallback.** The API reads
  `Authorization: Bearer`, then falls back to the httpOnly `aurora_access`
  cookie (`internal/auth/middleware.go:182-193`, `internal/auth/cookies.go`) —
  the fallback that lets same-origin `<video>`/`<img>`/anchor requests
  authenticate without a JS-readable token. Push subscribe/unsubscribe are
  ordinary authed fetches from page JS via `src/lib/api.ts`. The service
  worker itself never attaches credentials — payload arrives inside the push
  event — but **`/api/...` deep-link opens from a notification click
  authenticate via that access cookie**, exactly as the bell's highlight-reel
  link does today (`src/App.tsx:1755-1756`); a lapsed cookie degrades to the
  login screen, same as the bell.
- **Secrets in `server_settings` have an established pattern.**
  `GET /api/admin/settings` returns all rows but masks any key matching
  `secretSettingSuffixes` (`_secret`, `_api_key`, … — `internal/api/admin_handlers.go:765-778`,
  applied at `:1022-1044`). Write access is gated by the `allowedKeys` map
  (`:1058`): keys not listed are **unwritable** via the API. So the VAPID
  keypair row `push_vapid_secret` (see D6) is, with zero new code:
  listable-but-masked, and immune to accidental admin overwrite.
- **Migration numbering:** 046 is the highest; **047 is free**.
- **No prior art to collide with:** zero hits for
  `serviceWorker|webmanifest|pushManager|requestPermission|beforeinstallprompt|apple-touch`
  in the entire repo.
- **Versions:** Go 1.26.3 / chi 5.2.2 / pgx 5.7.4; React 19.2, Vite 7.2.4,
  TS 5.9.3, vitest 2.1.9, Playwright 1.62, Tailwind 3.4.19.

### Ecosystem facts (verified 2026-07, sources in § References)

- **Go sender:** `github.com/SherClockHolmes/webpush-go` **v1.4.0**
  (2026-01-02) — actively maintained; RFC 8291 `aes128gcm` payload encryption
  + RFC 8292 VAPID. One dependency, no transitive sprawl.
- **`vite-plugin-pwa`: evaluated and not used.** Current v1.3.0 bundles
  Workbox 7.4; its core value is precache manifest injection — exactly the
  thing D1 forbids. A hand-written ~60-line `sw.js` in `public/` plus a
  hand-written manifest is smaller than the plugin's config, has no
  build-time magic to audit, and can't drift into caching by a config
  default. If we ever want offline, the plugin is the on-ramp; today it buys
  nothing.
- **iOS:** Web Push requires the app be **added to the Home Screen** (16.4+)
  and works from the installed web app only. **Declarative Web Push** shipped
  in iOS/iPadOS **18.4** (March 2025) and on macOS in Safari 18.5 (where it
  also works in plain tabs), refined through Safari 26.x: a JSON payload
  carrying the magic key `"web_push": 8030` (a nod to RFC 8030) with a
  `notification` member displays **without waking the service worker**. A
  browser that doesn't recognize the key — Chrome and Firefox today — falls
  back to the classic SW `push` handler, and even on Safari a service worker
  may optionally rewrite the notification, with the declarative content as
  the no-penalty fallback if it fails. We send that envelope and parse the
  same shape in the SW: one payload, every platform (D9).
- **Chromium installability:** since Chrome 108 (mobile) / 112 (desktop),
  **menu installation no longer requires a service worker or fetch handler**
  — manifest (name, icons incl. 512px, start_url, display) + HTTPS is
  enough, with Chrome supplying a default offline page. **But the automatic
  install prompt (`beforeinstallprompt`) still gates on a `fetch()`
  handler**, which D1 rules out — and shipping a no-op fetch handler to game
  that check is the documented anti-pattern that made Chrome drop the
  requirement in the first place. So on Chromium the Settings card shows the
  captured prompt's one-tap button *if Chrome volunteers it* (Chrome is
  working on new promotability signals) and otherwise per-browser menu
  steps. Install is always available; only the tap count varies. Maskable
  icons: mark inside the central **80% safe zone**.
- **Operational best practices:** treat `404`/`410` from a push service as
  "subscription dead — delete the row"; set a sane `TTL` (we use 24h) and
  `Urgency: normal`; `userVisibleOnly: true` is still mandatory in Chrome;
  `Notification.requestPermission` must be called from a **user gesture**
  (Settings toggle qualifies); `pushsubscriptionchange` is unreliable in
  practice — the robust pattern is re-validating the subscription on every app
  boot and re-POSTing it (D11).

---

## 2. Design

**D1 — The service worker never caches, never intercepts.** No `fetch`
handler at all. Push-only. This makes stale-UI-via-SW impossible *by
construction* (a worker with no fetch handler can't serve anything), keeps the
auto-updater's contract intact, and means an outdated SW is harmless rather
than dangerous. The file is plain JS in `public/` — no bundler pass, no
hashing (SW URLs must be stable), nothing to configure.

**D2 — No new frontend dependencies.** Manifest and SW are static files;
registration and install-prompt logic are ~100 lines of `src/lib/` TypeScript
with vitest coverage, same as `homeRefresh.ts` / `referral.ts`. (Rationale for
skipping `vite-plugin-pwa` above.)

**D3 — Everything scoped to `/v2/`.** `start_url: "/v2/"`, `scope: "/v2/"`,
`id: "/v2/"`, SW at `/v2/sw.js`. The `/` redirect sits outside SW scope, which
is fine — it's a 302 the browser follows before the app boots, and installed
launches go straight to `/v2/`.

**D4 — CSP:** `worker-src 'self' blob:` (Phase 1, one token). A Go test pins
it so a future CSP edit can't silently break registration.

**D5 — Icons are generated, deterministically, with tooling we already
require.** A committed `scripts/render-icons.mjs` (Playwright + the Chromium
the audit chain already mandates) rasterizes `favicon.svg` into
`icon-192.png`, `icon-512.png`, maskable variants (full-bleed gradient
background, mark within the 80% safe zone), `apple-touch-icon.png` (180×180,
opaque `#050505` matte — iOS dislikes transparency), and a monochrome
`badge-96.png` (Android status-bar glyph). Outputs are committed; the script
makes them reproducible. App chrome color `#050505` (`src/index.css:64`)
becomes `theme_color` and `background_color`.

**D6 — VAPID keys self-provision, atomically.** First time the server needs
them (config endpoint or first send), it generates a P-256 pair and stores it
as **one** `server_settings` row, `push_vapid_secret`, holding a JSON
`{"public": …, "private": …}` — the pair is a single value precisely so it
can never be torn. The write is a new `InsertSettingIfAbsent` query
(`INSERT … ON CONFLICT (key) DO NOTHING`) followed by a re-read, so two
racing first-users both end up holding whichever single pair won; a test
proves the convergence. (The existing `SetSetting`/`UpsertSetting` is
last-write-wins by design — `queries_phase4.go:590-598` — which is exactly
wrong for a keypair, hence the new query.) Zero operator setup. Not in
`allowedKeys` → not writable via the admin API; `_secret` suffix → masked in
the admin listing by the existing `isSecretSettingKey` machinery; the public
half is served only via `/api/me/push/config`. Key rotation = delete the row
(documented in `docs/push.md`); old subscriptions then 401/410 at the push
service, get pruned by D8, and devices re-subscribe on next app boot.

**D7 — One dispatcher instead of three copies.** Today the
persist-then-broadcast dance is duplicated at both producer sites, with
inconsistent WS payloads (requests omit `link`). Phase 2 introduces
`internal/notify` — `Dispatcher.Notify(ctx, n)` = `CreateNotification` →
(if created) WS `BroadcastToUser` → (if created) push fan-out, all
best-effort with the same `context.WithoutCancel` + timeout semantics the
producers use today (`request_handlers.go:1437`). Both existing producers
adopt it (behavior-preserving diff), and the two new producers are one-liners:

- `admin_new_request` — on request creation, notify every admin (title = the
  requested item; link = the admin requests view). The existing dedupe key
  `(user_id, request_id, type)` naturally yields one notification per admin
  per request.
- `scan_complete` — when a scan run transitions running→idle **and added at
  least one item**, notify admins with the library name and count; link =
  home. The added-items gate is load-bearing, not cosmetic: rows without a
  `request_id` get **no table-level dedupe** (the 037 NULL exemption above),
  and the Watcher runs periodic full scans on an operator-set interval
  (`internal/library/watcher.go:21-23`, `scan_interval_default`) — an
  unconditional producer would push every admin on every cycle, forever.
  No-change scans stay silent, which is also the only version anyone wants.
  (Exact hook point located during implementation: wherever the scanner
  emits its terminal `scan_progress` state — the ScanProgressBar's polling
  endpoint proves the transition is already observable server-side.)

**D8 — Push fan-out semantics.** `internal/push.Sender` wraps webpush-go
behind an interface (so the dispatcher is testable with a fake): loads the
user's subscriptions, sends concurrently with a small bound (errgroup —
`x/sync` is already a dependency), `TTL: 86400`, `Urgency: normal`. On
`404`/`410`: delete the subscription row. On success: stamp
`last_success_at`. Failures are logged, never surfaced to the triggering
request — push is a best-effort mirror of the durable feed, exactly like WS.

**D9 — One payload for every platform.** JSON:

```json
{
  "web_push": 8030,
  "notification": {
    "title": "Dune: Part Two is ready",
    "body": "Your request finished downloading.",
    "navigate": "/v2/",
    "app_badge": 3
  },
  "aurora": { "type": "request_available", "notification_id": 123, "link": "/v2/..." }
}
```

iOS ≥18.4 renders it declaratively (no SW wake, `navigate` handles the click,
`app_badge` sets the icon badge). Chrome/Firefox/older-Safari fire the SW
`push` handler, which reads the same object and calls `showNotification` +
handles `notificationclick` (focus an existing `/v2/` client and route it, else
`openWindow`; `link`s that start with `/api/` — e.g. the highlight reel MP4 —
open directly). `tag: aurora-<notification_id>` keeps re-sends from stacking.

**Foreground policy:** when a same-origin window is focused, the SW skips
`showNotification` — the WS toast (`useRealtime.ts:100-102`) has already
delivered the moment in-app, and a simultaneous OS banner would be a double
tap on the shoulder. With no focused window, the OS notification shows. On
iOS the declarative path renders without running our code, so foreground
suppression is impossible there — accepted platform behavior, noted in
`docs/push.md` rather than fought.

**D10 — Operator kill switch.** One new admin setting `push_enabled`
(default on) in `allowedKeys`, checked by the sender. Web Push necessarily
transits Google/Apple/Mozilla push services (payloads E2E-encrypted per
RFC 8291, but the *fact* of a notification transits them) — on self-hosted
software that must be the operator's choice, so it's a first-class toggle,
not a code edit.

**D11 — Subscription lifecycle.**
Table (migration 047):

```sql
CREATE TABLE push_subscriptions (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint        TEXT   NOT NULL UNIQUE,
    p256dh          TEXT   NOT NULL,
    auth            TEXT   NOT NULL,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_success_at TIMESTAMPTZ
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
```

Upsert is `ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id,
p256dh = …, auth = …, last_seen_at = NOW()` — an endpoint identifies a
*browser profile on a device*, so when a different account signs in on the
same device and enables push, the row **reassigns** to them. That single
clause is what prevents user A receiving user B's notifications on a shared
device. Sign-out best-effort unsubscribes (SW `pushManager` unsubscribe +
`DELETE`). Every authenticated app boot with permission granted re-POSTs the
current subscription — that's the reliability answer to the dead
`pushsubscriptionchange` event, and it keeps `last_seen_at` honest enough to
prune rows unseen for 180 days (opportunistically, on subscribe).

**D12 — API surface** (authed group, alongside `router.go:902-904`):

| Route | Does |
|---|---|
| `GET /api/me/push/config` | `{enabled, vapid_public_key}` — lazily provisions keys (D6). |
| `POST /api/me/push/subscriptions` | Upsert `{endpoint, p256dh, auth}` (D11). 204. |
| `DELETE /api/me/push/subscriptions` | Remove by endpoint (owner-scoped). 204. |
| `POST /api/me/push/test` | Sends a test push to the caller's subscriptions; per-user cooldown (10s) so it can't be a spam lever. |

**D13 — iOS-aware Settings UX.** The Notifications card renders by capability,
decided by a pure, unit-tested state machine (`src/lib/push.ts`):
`unsupported` → explain; `ios-needs-install` (iOS Safari, not standalone) →
show the A2HS guide from Phase 1; `permission-denied` → how to re-allow in
browser settings; `off` → enable toggle (gesture → `requestPermission` →
subscribe → POST); `on` → disable + "Send test notification". No automatic
permission prompts anywhere — prompting is always a direct response to the
user's tap.

---

## 3. Phase 1 — Installable PWA

**Branch `feat/pwa-installable`.** No new dependencies, no migrations.

Frontend (`static/redesign/app/`):

- `public/manifest.webmanifest` — name/short_name "Aurora", `start_url`/
  `scope`/`id` `/v2/`, `display: standalone`, colors `#050505`, description,
  `categories: ["entertainment"]`, 4 icons (192/512 × any/maskable).
- `public/sw.js` — install→`skipWaiting`, activate→`clients.claim`. **No
  fetch handler** (D1). Push handlers arrive in Phase 2.
- `public/` icons + `scripts/render-icons.mjs` (D5).
- `index.html` — manifest link, `theme-color` meta, `apple-touch-icon` link.
- `src/lib/pwa.ts` — `registerServiceWorker()` (feature-detected, never
  throws into app boot), `beforeinstallprompt` capture (listener attached at
  module init from `main.tsx`, before the event can fire), `isStandalone()`,
  `isIOSSafari()`, install-prompt state. **Vitest** on every branch of the
  gates — jsdom, mocked `navigator`/`matchMedia`, house style.
- `SettingsView.tsx` — "App" card (sibling `<h2>` section, matching
  `SettingsView.tsx:182` and friends), state-driven: "Installed" when
  standalone / Install button when a captured `beforeinstallprompt` is held /
  numbered A2HS steps on iOS Safari / short per-browser menu instructions
  otherwise (the Chromium reality above). The state decision is a pure
  function in `lib/pwa.ts` with a test per branch.
- `scripts/verify-pwa.mjs` — builds, serves the bundle, and asserts in real
  Chromium: manifest fetches with 200 + parses, SW registers and activates,
  `navigator.serviceWorker.controller` present after reload. Run in review;
  wired into `npm run audit` only if it stays cheap (~seconds).

Backend:

- `router.go` CSP: `worker-src 'self' blob:` (D4).
- `v2Handler`: explicit `Content-Type: application/manifest+json` for
  `.webmanifest` — verified `mime.TypeByExtension(".webmanifest")` returns `""`
  in this environment *even though* `/etc/mime.types` here has a webmanifest
  entry (Go 1.26 prefers the XDG shared-mime DB, which lacks one). The lookup
  is host-dependent in ways that can't be reasoned about from the repo, so
  serving the manifest correctly must not depend on it.
- `internal/api/static_pwa_test.go` — table test: `/v2/manifest.webmanifest` →
  200 + `application/manifest+json`; `/v2/sw.js` → 200 **with
  `text/javascript` content type and a body marker** — a bare 200/`no-cache`
  assertion would be vacuous, because the SPA fallback
  (`router.go:376-377`) answers 200 with those same group headers for *any*
  missing `/v2/*` path; CSP header contains `worker-src 'self'`. These pin
  the server-side facts registration depends on, in a way that actually
  fails when the files are absent.

Gate: `go build/test ./...`, `npm run audit`, adversarial review of the diff,
then PR.

## 4. Phase 2 — Web Push

**Branch `feat/web-push`** (after Phase 1 merges). One new Go dependency.

Backend:

- `migrations/047_push_subscriptions.{up,down}.sql` (D11) — validated against
  a scratch PG16 like 046 was.
- `internal/push/` — VAPID provisioning (D6) + `Sender` (D8), webpush-go
  behind an interface, injectable `*http.Client` so tests use a fake
  transport: asserts 410→row deleted, concurrency bound respected, TTL/
  urgency headers set, disabled switch short-circuits.
- `internal/notify/` — the dispatcher (D7); both existing producers adopt it;
  two new producers (`admin_new_request`, `scan_complete`); needs a
  `GetAdminUserIDs` query.
- `internal/api/push_handlers.go` + routes (D12), handler tests via fake
  store interface (referral pattern — the store interface exists so mutation
  testing can prove the `WHERE user_id` scoping binds).
- `allowedKeys` + `push_enabled` (+ admin toggle in the admin settings UI).
- `docs/push.md` — ops story: zero config, rotation, vendor-transit note,
  the operator switch, egress requirement (box must reach push endpoints).

Frontend:

- `sw.js` + `push`/`notificationclick`/`pushsubscriptionchange` handlers
  (D9); declarative-envelope payload shared with iOS.
- `src/lib/push.ts` — state machine + subscribe orchestration +
  `urlBase64ToUint8Array`; vitest across every state and transition,
  mutation-spot-checked (the tautology trap from the referral reviews:
  callers call the extracted function, tests never re-implement it).
- `SettingsView.tsx` Notifications card (D13) + boot-time re-POST of the
  live subscription; sign-out best-effort unsubscribe in the existing logout
  path (`api.ts:243-249`).

Gate: same as Phase 1 + migration validated on real PG16.

## 5. Verification on the real box

After each phase merges: `bash scripts/server-test-loop.sh --trigger-update`,
then a device pass — Android/desktop Chrome: install, enable push, send test,
tap-through deep link; iPhone: A2HS via the guide, enable push from the
installed app, receive a declarative push with the app closed. (The phone
half needs your hands — I'll give you a 2-minute checklist with each PR.)

## 6. Risks & honest edges

- **Scan-complete hook point** is the one place the plan says "locate during
  implementation" — the transition is provably observable (the progress bar
  polls it) but the cleanest producer seam needs eyes on the scanner code.
- **iOS remains iOS.** Declarative push is the reliability play, but iOS push
  for PWAs has real-world quirks (per-device Focus modes, users deleting the
  icon kills the subscription silently — the 410 cleanup + boot re-POST are
  the mitigations).
- **CSP changes** are pinned by tests, but any future tightening must keep
  `worker-src 'self'`.
- **Payload privacy:** titles of requested media transit (encrypted) through
  vendor push services; the operator switch (D10) exists for exactly that
  judgment call.
- **The SW file itself** is the one asset that must never be renamed — its
  URL is its identity. `no-cache` (already served) is what makes updates to
  it safe; a review-time grep guard asserts `sw.js` contains no `fetch`
  listener so D1 can't erode quietly.

## 7. References

Primary sources verified 2026-07-29:

- WebKit, *Meet Declarative Web Push* — webkit.org/blog/16535 (payload
  envelope, SW fallback semantics, platform availability).
- Chrome for Developers, *Revisiting Chrome's installability criteria* —
  developer.chrome.com/blog/update-install-criteria (menu install without SW
  since 108/112; `beforeinstallprompt` still gated on a fetch handler).
- `SherClockHolmes/webpush-go` releases — v1.4.0, 2026-01-02.
- `vite-plugin-pwa` — v1.3.0 on npm, Workbox 7.4 (evaluated, not adopted).
- RFC 8030 (Web Push protocol; TTL/Urgency, 404/410 semantics), RFC 8291
  (message encryption), RFC 8292 (VAPID).
- MDN, *Making PWAs installable* / Push API.
