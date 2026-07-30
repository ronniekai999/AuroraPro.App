# Web Push — how it works and what operators should know

Aurora delivers notifications to devices even when no tab is open: request
ready/failed (to the requester), watch-party highlight reels (to the host),
and two admin alerts — a new request awaiting review, and library scans that
added items. Design: `do/pwa-push/IMPLEMENTATION.md` (Phase 2).

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

Delete the `push_vapid_secret` row from `server_settings` and restart. Every
existing subscription then fails auth at the push service and is pruned on
the next send; devices re-subscribe automatically at their next app boot
(the boot re-POST) — users don't need to touch anything, but there is a
delivery gap until each device next opens Aurora.

## Retention hygiene

Subscriptions unseen for 180 days (no app boot on that device) are pruned
opportunistically. Dead endpoints (404/410 from the push service) are pruned
on send. Signing out best-effort unsubscribes the device so the next account
on a shared machine doesn't inherit the channel — and the subscription
upsert reassigns an endpoint to whichever account most recently enabled
push, closing the same gap from the other side.
