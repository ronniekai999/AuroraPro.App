import { describe, it, expect, vi } from 'vitest'
import {
  pushUIState,
  pushSupported,
  urlBase64ToUint8Array,
  subscriptionToWire,
  subscriptionKeyMatches,
  enablePush,
  disablePush,
  bootResyncPush,
  unsubscribePushOnLogout,
  type RegistrationLike,
  type SubscriptionLike,
} from './push'

const BASE = {
  supported: true,
  serverEnabled: true,
  isIOS: false,
  standalone: false,
  permission: 'default' as NotificationPermission,
  subscribed: false,
}

describe('pushUIState precedence', () => {
  it('unsupported beats everything', () => {
    expect(pushUIState({ ...BASE, supported: false, subscribed: true, permission: 'granted' })).toBe('unsupported')
  })
  it('operator switch beats platform and permission', () => {
    expect(pushUIState({ ...BASE, serverEnabled: false, permission: 'granted', subscribed: true })).toBe('server-disabled')
  })
  it('an iOS TAB needs install — even when permission reads denied', () => {
    // iOS tabs report Notification.permission 'denied' permanently; the fix
    // is installing, not browser settings, so this MUST outrank
    // permission-denied or iOS users get unactionable advice.
    expect(pushUIState({ ...BASE, isIOS: true, permission: 'denied' })).toBe('ios-needs-install')
  })
  it('an INSTALLED iOS app falls through to the normal flow', () => {
    expect(pushUIState({ ...BASE, isIOS: true, standalone: true })).toBe('off')
    expect(pushUIState({ ...BASE, isIOS: true, standalone: true, subscribed: true })).toBe('on')
  })
  it('denied permission is terminal (non-iOS)', () => {
    expect(pushUIState({ ...BASE, permission: 'denied', subscribed: true })).toBe('permission-denied')
  })
  it('off/on by subscription state', () => {
    expect(pushUIState({ ...BASE })).toBe('off')
    expect(pushUIState({ ...BASE, permission: 'granted', subscribed: true })).toBe('on')
  })
})

describe('pushSupported', () => {
  const full = { navigator: { serviceWorker: {} }, PushManager: {}, Notification: {} }
  it('requires the whole chain', () => {
    expect(pushSupported(full)).toBe(true)
    expect(pushSupported({ ...full, navigator: {} })).toBe(false)
    expect(pushSupported({ ...full, PushManager: undefined })).toBe(false)
    expect(pushSupported({ ...full, Notification: undefined })).toBe(false)
  })
})

describe('urlBase64ToUint8Array', () => {
  it('decodes unpadded base64url with url-safe alphabet', () => {
    // 0xFB 0xEF 0xBE → base64 "++++vg" family; url-safe uses - and _.
    expect(Array.from(urlBase64ToUint8Array('AQI'))).toEqual([1, 2])
    expect(Array.from(urlBase64ToUint8Array('_-8'))).toEqual([0xff, 0xef])
  })
  it('round-trips a realistic VAPID key length (65-byte P-256 point)', () => {
    const key = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
    expect(urlBase64ToUint8Array(key).length).toBe(65)
    expect(urlBase64ToUint8Array(key)[0]).toBe(4) // uncompressed-point marker
  })
})

function fakeSub(over: { json?: ReturnType<SubscriptionLike['toJSON']> } = {}) {
  const json = over.json ?? { endpoint: 'https://push.example/e1', keys: { p256dh: 'P', auth: 'A' } }
  const unsubscribe = vi.fn().mockResolvedValue(true)
  return {
    endpoint: json.endpoint ?? 'https://push.example/e1',
    toJSON: () => json,
    unsubscribe,
  }
}

function fakeReg(existing: SubscriptionLike | null, subscribed?: SubscriptionLike): RegistrationLike & { subscribe: ReturnType<typeof vi.fn> } {
  const subscribe = vi.fn().mockImplementation(async () => {
    if (!subscribed) throw new Error('no sub scripted')
    return subscribed
  })
  return {
    pushManager: {
      getSubscription: async () => existing,
      subscribe,
    },
    subscribe,
  }
}

describe('subscriptionToWire', () => {
  it('maps the full shape and rejects partials', () => {
    expect(subscriptionToWire(fakeSub())).toEqual({ endpoint: 'https://push.example/e1', keys: { p256dh: 'P', auth: 'A' } })
    expect(subscriptionToWire(fakeSub({ json: { endpoint: 'e', keys: { p256dh: 'P' } } }))).toBeNull()
    expect(subscriptionToWire(fakeSub({ json: {} }))).toBeNull()
  })
})

describe('enablePush', () => {
  const okConfig = vi.fn().mockResolvedValue({ enabled: true, vapid_public_key: 'AQI' })

  it('stops at a refused permission — no config fetch, no subscribe', async () => {
    const config = vi.fn()
    const result = await enablePush({
      requestPermission: async () => 'denied',
      ready: async () => fakeReg(null),
      config,
      post: vi.fn(),
    })
    expect(result).toBe('permission-denied')
    expect(config).not.toHaveBeenCalled()
  })

  it('stops when the operator disabled push', async () => {
    const reg = fakeReg(null)
    const result = await enablePush({
      requestPermission: async () => 'granted',
      ready: async () => reg,
      config: vi.fn().mockResolvedValue({ enabled: false, vapid_public_key: '' }),
      post: vi.fn(),
    })
    expect(result).toBe('server-disabled')
    expect(reg.subscribe).not.toHaveBeenCalled()
  })

  it('subscribes with the server key and POSTs the wire shape', async () => {
    const sub = fakeSub()
    const reg = fakeReg(null, sub)
    const post = vi.fn().mockResolvedValue(undefined)
    const result = await enablePush({
      requestPermission: async () => 'granted',
      ready: async () => reg,
      config: okConfig,
      post,
    })
    expect(result).toBe('enabled')
    expect(reg.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    })
    expect(post).toHaveBeenCalledWith({ endpoint: 'https://push.example/e1', keys: { p256dh: 'P', auth: 'A' } })
  })

  it('reuses an existing browser subscription instead of re-subscribing', async () => {
    const sub = fakeSub()
    const reg = fakeReg(sub)
    const post = vi.fn().mockResolvedValue(undefined)
    await enablePush({ requestPermission: async () => 'granted', ready: async () => reg, config: okConfig, post })
    expect(reg.subscribe).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalled()
  })

  it('rolls back the browser subscription when the POST fails — no zombie channels', async () => {
    const sub = fakeSub()
    const reg = fakeReg(null, sub)
    const result = await enablePush({
      requestPermission: async () => 'granted',
      ready: async () => reg,
      config: okConfig,
      post: vi.fn().mockRejectedValue(new Error('500')),
    })
    expect(result).toBe('failed')
    // The server never learned of the subscription; leaving it in the
    // browser would deliver nothing forever with the toggle showing off.
    expect(sub.unsubscribe).toHaveBeenCalled()
  })

  it('reports failed when the browser refuses to subscribe', async () => {
    const result = await enablePush({
      requestPermission: async () => 'granted',
      ready: async () => fakeReg(null), // subscribe() throws
      config: okConfig,
      post: vi.fn(),
    })
    expect(result).toBe('failed')
  })
})

describe('disablePush', () => {
  it('unsubscribes the browser FIRST, then deletes the row', async () => {
    const order: string[] = []
    const sub = fakeSub()
    sub.unsubscribe.mockImplementation(async () => {
      order.push('browser')
      return true
    })
    const del = vi.fn().mockImplementation(async () => {
      order.push('server')
    })
    await disablePush({ ready: async () => fakeReg(sub), del })
    expect(order).toEqual(['browser', 'server'])
    expect(del).toHaveBeenCalledWith('https://push.example/e1')
  })

  it('tolerates a failed DELETE (sender 404/410 cleanup collects it later)', async () => {
    const sub = fakeSub()
    await expect(disablePush({
      ready: async () => fakeReg(sub),
      del: vi.fn().mockRejectedValue(new Error('offline')),
    })).resolves.toBeUndefined()
    expect(sub.unsubscribe).toHaveBeenCalled()
  })

  it('is a no-op with no subscription', async () => {
    const del = vi.fn()
    await disablePush({ ready: async () => fakeReg(null), del })
    expect(del).not.toHaveBeenCalled()
  })
})

const okCfg = () => vi.fn().mockResolvedValue({ enabled: true, vapid_public_key: 'AQI' })

/** A subscription whose recorded applicationServerKey is [1,2] — matching
 *  the server key 'AQI' — or something else, for the rotation cases. */
function keyedSub(bytes: number[], json?: ReturnType<SubscriptionLike['toJSON']>) {
  const sub = fakeSub(json ? { json } : {})
  return Object.assign(sub, { options: { applicationServerKey: new Uint8Array(bytes).buffer } })
}

describe('subscriptionKeyMatches', () => {
  it('matches equal bytes, rejects different or different-length keys', () => {
    expect(subscriptionKeyMatches(keyedSub([1, 2]), 'AQI')).toBe(true)
    expect(subscriptionKeyMatches(keyedSub([9, 9]), 'AQI')).toBe(false)
    expect(subscriptionKeyMatches(keyedSub([1, 2, 3]), 'AQI')).toBe(false)
  })
  it('treats an unreadable key as a match — no churn on engines that hide options', () => {
    expect(subscriptionKeyMatches(fakeSub(), 'AQI')).toBe(true)
  })
})

describe('bootResyncPush', () => {
  it('re-POSTs the live subscription', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    await bootResyncPush({ supported: true, permission: 'granted', ready: async () => fakeReg(fakeSub()), config: okCfg(), post })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('HEALS a rotated key: replaces the stale subscription with one for the current key', async () => {
    // The operator procedure in docs/push.md (delete the row, restart) only
    // works because of this path — 401/403 sends do NOT prune server-side.
    const stale = keyedSub([9, 9])
    const fresh = fakeSub({ json: { endpoint: 'https://push.example/e2', keys: { p256dh: 'P2', auth: 'A2' } } })
    const reg = fakeReg(stale, fresh)
    const post = vi.fn().mockResolvedValue(undefined)
    await bootResyncPush({ supported: true, permission: 'granted', ready: async () => reg, config: okCfg(), post })

    expect(stale.unsubscribe).toHaveBeenCalled()
    expect(reg.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) })
    expect(post).toHaveBeenCalledWith({ endpoint: 'https://push.example/e2', keys: { p256dh: 'P2', auth: 'A2' } })
  })

  it('does NOT churn the subscription while the operator has push disabled', async () => {
    // Disabled config serves no key; replacing/unsubscribing here would
    // erode the fleet the operator expects back when they re-enable. The
    // plain re-POST keeps last_seen_at fresh instead.
    const stale = keyedSub([9, 9])
    const reg = fakeReg(stale)
    const post = vi.fn().mockResolvedValue(undefined)
    await bootResyncPush({
      supported: true, permission: 'granted', ready: async () => reg,
      config: vi.fn().mockResolvedValue({ enabled: false, vapid_public_key: '' }), post,
    })
    expect(stale.unsubscribe).not.toHaveBeenCalled()
    expect(reg.subscribe).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('never runs without support or granted permission', async () => {
    const post = vi.fn()
    const ready = vi.fn()
    await bootResyncPush({ supported: false, permission: 'granted', ready, post, config: okCfg() })
    await bootResyncPush({ supported: true, permission: 'default', ready, post, config: okCfg() })
    expect(ready).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('never CREATES — an absent subscription is left absent', async () => {
    // Re-subscribing from nothing would resurrect push on a device where
    // the user turned it off from another tab. (The heal path above only
    // ever REPLACES an existing subscription.)
    const reg = fakeReg(null)
    const post = vi.fn()
    const config = vi.fn()
    await bootResyncPush({ supported: true, permission: 'granted', ready: async () => reg, post, config })
    expect(reg.subscribe).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
    expect(config).not.toHaveBeenCalled()
  })

  it('swallows every failure — boot must never depend on it', async () => {
    await expect(bootResyncPush({
      supported: true,
      permission: 'granted',
      ready: async () => { throw new Error('sw dead') },
      config: okCfg(),
      post: vi.fn(),
    })).resolves.toBeUndefined()
  })
})

describe('enablePush with a stale-key subscription', () => {
  it('replaces it instead of reusing a channel the server can no longer sign for', async () => {
    const stale = keyedSub([9, 9])
    const fresh = fakeSub({ json: { endpoint: 'https://push.example/e2', keys: { p256dh: 'P2', auth: 'A2' } } })
    const reg = fakeReg(stale, fresh)
    const post = vi.fn().mockResolvedValue(undefined)
    const result = await enablePush({
      requestPermission: async () => 'granted',
      ready: async () => reg,
      config: okCfg(),
      post,
    })
    expect(result).toBe('enabled')
    expect(stale.unsubscribe).toHaveBeenCalled()
    expect(reg.subscribe).toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://push.example/e2' }))
  })
})

describe('unsubscribePushOnLogout', () => {
  it('is bounded — a hung service worker cannot hold logout hostage', async () => {
    const never = new Promise<RegistrationLike>(() => {})
    const start = Date.now()
    await unsubscribePushOnLogout({ supported: true, ready: () => never, timeoutMs: 30 })
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('cleans up browser + server when things work', async () => {
    const sub = fakeSub()
    const del = vi.fn().mockResolvedValue(undefined)
    await unsubscribePushOnLogout({ supported: true, ready: async () => fakeReg(sub), del })
    expect(sub.unsubscribe).toHaveBeenCalled()
    expect(del).toHaveBeenCalled()
  })

  it('no-ops where push is unsupported', async () => {
    const ready = vi.fn()
    await unsubscribePushOnLogout({ supported: false, ready })
    expect(ready).not.toHaveBeenCalled()
  })
})
