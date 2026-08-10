# Web Push — how it works and what operators should know

Aurora delivers notifications to devices even when no tab is open: request
ready/failed (to the requester), watch-party highlight reels (to the host),
watch-party invites / RSVPs / start reminders (migration 051), and two admin
alerts — a new request awaiting review, and library scans that added items.
Every type the dispatcher persists is also pushed; `push.Envelope` is the
single place that maps a notification type to its title and body. Design:
`do/pwa-push/IMPLEMENTATION.md` (Phase 2).

## Zero configuration

There is nothing to set up. The first time the server needs them, it
generates a VAPID keypair and stores it as **one** `server_settings` row
(`push_vapid_secret`, a JSON `{"public","private"}` pair — single row so the
halves can never be torn by a race). The row is masked in the admin settings
listing and cannot be written through the admin API.

Users enable push per device: **Settings → Notifications → Push to this
device**, which asks browser permission (only ever on that tap), subscribes,
and registers the subscription. **Settings → Send test notification** proves
the pipe end-to-end.

## The operator switch

**Admin → Settings → Push notifications** (`push_enabled`, default on).

Why it exists: Web Push necessarily routes through the browser vendors' push
services (FCM for Chrome, Apple for Safari/iOS, Mozilla for Firefox).
Payloads are end-to-end encrypted (RFC 8291) — the services cannot read
titles or content — but the *fact* that your server sent a notification, and
when, transits their infrastructure. On self-hosted software that trade-off
is the operator's call, so it's a first-class switch, hot-read on every send
(no restart).

The box needs outbound HTTPS to those services; a fully egress-blocked
server will log send failures and deliver everything via the in-app bell and
WebSocket exactly as before.

## iOS

Push on iPhone/iPad works only from the **installed** app (Add to Home
Screen — the Settings App card walks users through it). Aurora sends the
declarative-web-push envelope, so on iOS 18.4+ notifications render even
without waking the service worker. Two known platform behaviors: Focus modes
gate delivery like any app's notifications, and deleting the home-screen
icon silently kills the subscription — the server prunes such dead
subscriptions automatically when the push service reports them gone (404/410),
and every app boot re-registers the live subscription.

Foreground difference, by design: when an Aurora window is focused,
Chrome/Firefox/desktop-Safari suppress the OS banner (the in-app toast
already delivered it). iOS's declarative path renders without running our
code, so an installed iOS app in the foreground may show both.

## Key rotation

Delete the `push_vapid_secret` row from `server_settings` and restart. What
actually happens next, honestly:

- Sends to existing subscriptions are **rejected** by the push services
  (401/403 — the old key no longer signs). These rejections are logged and
  deliberately **not** pruned: from the server's side they are
  indistinguishable from a misconfiguration, and mass-deleting every
  subscription on a misconfig would be the worse failure.
- Each device **heals itself at its next app boot**: the boot re-sync
  compares its subscription's key against the server's current one, and on
  mismatch replaces the subscription (unsubscribe → re-subscribe → register)
  with no user interaction. Enabling push from Settings does the same check.
- Devices that never come back age out via the 180-day prune.

So: rotation is safe, but expect a per-device delivery gap until each device
next opens Aurora, and warn-level send logs in the meantime.

## Retention hygiene

Subscriptions unseen for 180 days (no app boot on that device) are pruned
opportunistically. Dead endpoints (404/410 from the push service) are pruned
on send. Signing out best-effort unsubscribes the device so the next account
on a shared machine doesn't inherit the channel — and the subscription
upsert reassigns an endpoint to whichever account most recently enabled
push, closing the same gap from the other side.
