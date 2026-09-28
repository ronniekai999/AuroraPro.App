// Web Push client plumbing (see docs/push.md): the
// Settings-card state machine, subscribe/unsubscribe orchestration, and the
// boot-time re-POST that keeps subscriptions alive.
//
// House rules apply: every decision is a pure function over explicit inputs,
// and the effectful flows take their platform surfaces as arguments so tests
// inject fakes — no jsdom globals patched, no module state to reset.

import { getPushConfig, postPushSubscription, deletePushSubscription, type PushSubscriptionWire } from '@/lib/api'

/** What the Notifications card renders (D13). */
export type PushUIState =
  | 'unsupported'       // no SW/Push/Notification API in this browser
  | 'server-disabled'   // operator turned push_enabled off
  | 'ios-needs-install' // iOS browser tab — push exists only inside the installed app
  | 'permission-denied' // user said no at the browser level; only they can undo it
  | 'off'               // available, not subscribed on this device
  | 'on'                // subscribed on this device

/**
 * Decide the card state. Precedence is the order a user can actually act on:
 * capability → operator policy → platform prerequisite → permission → toggle.
 * iOS-needs-install outranks permission-denied because an iOS TAB reports
 * Notification.permission 'denied' permanently — the fix there is installing,
 * not browser settings.
 */
export function pushUIState(opts: {
  supported: boolean
  serverEnabled: boolean
  isIOS: boolean
  standalone: boolean
  permission: NotificationPermission
  subscribed: boolean
}): PushUIState {
  if (!opts.supported) return 'unsupported'
  if (!opts.serverEnabled) return 'server-disabled'
  if (opts.isIOS && !opts.standalone) return 'ios-needs-install'
  if (opts.permission === 'denied') return 'permission-denied'
  return opts.subscribed ? 'on' : 'off'
}

/** Push support = the full chain, not any one link. */
export function pushSupported(win: {
  navigator?: { serviceWorker?: unknown }
  PushManager?: unknown
  Notification?: unknown
}): boolean {
  return !!(win.navigator?.serviceWorker && win.PushManager && win.Notification)
}

/**
 * The applicationServerKey bytes from the server's base64url VAPID public
 * key. subscribe() accepts a BufferSource; the string form is only reliably
 * accepted by newer Chromium, so convert unconditionally.
 */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url + '='.repeat((4 - (base64url.length % 4)) % 4)
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  // Explicitly ArrayBuffer-backed: TS 5.9's DOM lib types BufferSource as
  // ArrayBuffer-view, and the default Uint8Array<ArrayBufferLike> is not
  // assignable to it.
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Narrow slice of a PushSubscription the flows below touch. */
export interface SubscriptionLike {
  endpoint: string
  options?: { applicationServerKey?: ArrayBuffer | null }
  toJSON(): { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  unsubscribe(): Promise<boolean>
}

/**
 * Does an existing subscription belong to the server's CURRENT VAPID key?
 *
 * After a key rotation (docs/push.md), every existing subscription is signed
 * for a key the server no longer holds — sends are rejected with 401/403,
 * which deliberately do NOT prune rows (indistinguishable from a server
 * misconfig, and mass-deleting on those would be the worse failure). This
 * comparison is the healing side instead: boot/enable spot the stale key
 * and replace the subscription. Unreadable options (older engines) count as
 * a match — churning every boot on those would be worse than not healing.
 */
export function subscriptionKeyMatches(sub: SubscriptionLike, serverKeyB64: string): boolean {
  const raw = sub.options?.applicationServerKey
  if (!raw) return true
  const have = new Uint8Array(raw)
  const want = urlBase64ToUint8Array(serverKeyB64)
  if (have.length !== want.length) return false
  for (let i = 0; i < have.length; i++) {
    if (have[i] !== want[i]) return false
  }
  return true
}

/** Narrow slice of a ServiceWorkerRegistration. BufferSource (not
 *  Uint8Array) in subscribe so the real registration type satisfies this
 *  interface under TS 5.9's DOM typings. */
export interface RegistrationLike {
  pushManager: {
    getSubscription(): Promise<SubscriptionLike | null>
    subscribe(opts: { userVisibleOnly: boolean; applicationServerKey: BufferSource }): Promise<SubscriptionLike>
  }
}

/** toJSON() → the wire shape, or null when the browser returns a partial. */
export function subscriptionToWire(sub: SubscriptionLike): PushSubscriptionWire | null {
  const j = sub.toJSON()
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return null
  return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } }
}

export type EnableResult = 'enabled' | 'permission-denied' | 'server-disabled' | 'failed'

/**
 * The Settings toggle's enable flow. MUST be called from a user gesture —
 * requestPermission is gesture-gated in every engine. Order matters:
 * permission first (the browser dialog is the moment the user is deciding),
 * then key fetch, then subscribe, then the POST that makes it real. Any
 * failure leaves nothing half-on: an un-POSTed browser subscription is
 * unsubscribed on the way out rather than left to become a zombie.
 */
export async function enablePush(deps: {
  requestPermission: () => Promise<NotificationPermission>
  ready: () => Promise<RegistrationLike>
  config?: typeof getPushConfig
  post?: typeof postPushSubscription
}): Promise<EnableResult> {
  const config = deps.config ?? getPushConfig
  const post = deps.post ?? postPushSubscription

  const permission = await deps.requestPermission()
  if (permission !== 'granted') return 'permission-denied'

  const cfg = await config()
  if (!cfg.enabled || !cfg.vapid_public_key) return 'server-disabled'

  const reg = await deps.ready()
  let sub: SubscriptionLike
  try {
    let existing = await reg.pushManager.getSubscription()
    if (existing && !subscriptionKeyMatches(existing, cfg.vapid_public_key)) {
      // Signed for a rotated-away key — reusing it would subscribe a
      // channel the server can never authenticate to again.
      await existing.unsubscribe().catch(() => {})
      existing = null
    }
    sub = existing
      ?? await reg.pushManager.subscribe({
        userVisibleOnly: true, // mandatory in Chrome; honest everywhere
        applicationServerKey: urlBase64ToUint8Array(cfg.vapid_public_key),
      })
  } catch {
    return 'failed'
  }

  const wire = subscriptionToWire(sub)
  if (!wire) {
    await sub.unsubscribe().catch(() => {})
    return 'failed'
  }
  try {
    await post(wire)
  } catch {
    // The server never heard about it — a subscription the sender doesn't
    // know is a zombie channel; roll it back.
    await sub.unsubscribe().catch(() => {})
    return 'failed'
  }
  return 'enabled'
}

/**
 * The disable flow: browser first, then the server row. A failed DELETE is
 * tolerable (the sender's 404/410 cleanup will collect it once the browser
 * side is gone); a failed browser unsubscribe with a deleted row would keep
 * OS-level delivery alive with no way to manage it — hence this order.
 */
export async function disablePush(deps: {
  ready: () => Promise<RegistrationLike>
  del?: typeof deletePushSubscription
}): Promise<void> {
  const del = deps.del ?? deletePushSubscription
  const reg = await deps.ready()
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  const endpoint = sub.endpoint
  await sub.unsubscribe().catch(() => {})
  await del(endpoint).catch(() => {})
}

/**
 * Boot-time re-POST (D11): pushsubscriptionchange is unreliable in practice,
 * so every authenticated app start re-registers the live subscription. This
 * refreshes last_seen_at (the 180-day prune's liveness signal) — and it is
 * the fleet-wide healing path after a VAPID key rotation: a subscription
 * signed for a stale key is replaced (unsubscribe → subscribe with the
 * current key) right here, which is what makes "delete the row and restart"
 * a safe operator procedure instead of a silent fleet-wide kill.
 *
 * Deliberately does NOT ask for permission and never CREATES a subscription
 * where none exists — a device that turned push off stays off.
 */
export async function bootResyncPush(deps: {
  supported: boolean
  permission: NotificationPermission
  ready: () => Promise<RegistrationLike>
  config?: typeof getPushConfig
  post?: typeof postPushSubscription
}): Promise<void> {
  if (!deps.supported || deps.permission !== 'granted') return
  const post = deps.post ?? postPushSubscription
  const config = deps.config ?? getPushConfig
  try {
    const reg = await deps.ready()
    const sub = await reg.pushManager.getSubscription()
    if (!sub) return

    const cfg = await config()
    if (cfg.enabled && cfg.vapid_public_key && !subscriptionKeyMatches(sub, cfg.vapid_public_key)) {
      // Rotated key: replace the dead channel with a live one.
      await sub.unsubscribe().catch(() => {})
      const fresh = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.vapid_public_key),
      })
      const wire = subscriptionToWire(fresh)
      if (wire) await post(wire)
      return
    }

    // Steady state (including operator-disabled: keep the liveness stamp
    // fresh so re-enabling later doesn't find a pruned fleet).
    const wire = subscriptionToWire(sub)
    if (wire) await post(wire)
  } catch {
    /* best-effort by definition */
  }
}

/**
 * Best-effort logout cleanup: this device should stop receiving the
 * outgoing account's notifications. Bounded so it can never hold the
 * logout hostage — same pattern as settleReferral.
 */
export async function unsubscribePushOnLogout(deps: {
  supported: boolean
  ready: () => Promise<RegistrationLike>
  del?: typeof deletePushSubscription
  timeoutMs?: number
}): Promise<void> {
  if (!deps.supported) return
  const timeout = new Promise<void>(resolve => setTimeout(resolve, deps.timeoutMs ?? 1500))
  await Promise.race([
    disablePush({ ready: deps.ready, del: deps.del }).catch(() => {}),
    timeout,
  ])
}
