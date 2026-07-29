import { describe, it, expect, vi } from 'vitest'
import {
  installUIState,
  isStandaloneDisplay,
  isIOSDevice,
  createInstallPromptStore,
  registerServiceWorker,
  type BeforeInstallPromptEvent,
} from './pwa'

describe('installUIState', () => {
  it('standalone wins over everything — including a lingering captured prompt', () => {
    // Chrome keeps offering "install as second window" prompts after install;
    // without this precedence an installed app would show an Install button.
    expect(installUIState({ standalone: true, hasDeferredPrompt: true, isIOS: false })).toBe('installed')
    expect(installUIState({ standalone: true, hasDeferredPrompt: false, isIOS: true })).toBe('installed')
  })

  it('a captured prompt beats the iOS guide', () => {
    // Theoretical combination (iOS never fires the event), but one-tap must
    // win wherever both could be true.
    expect(installUIState({ standalone: false, hasDeferredPrompt: true, isIOS: true })).toBe('prompt')
    expect(installUIState({ standalone: false, hasDeferredPrompt: true, isIOS: false })).toBe('prompt')
  })

  it('iOS without a prompt gets the guide', () => {
    expect(installUIState({ standalone: false, hasDeferredPrompt: false, isIOS: true })).toBe('ios-guide')
  })

  it('everything else gets the browser-menu instructions', () => {
    // The Chromium reality: our SW has no fetch handler (by design), so
    // beforeinstallprompt may simply never fire — the card must still offer a
    // path to install rather than rendering nothing.
    expect(installUIState({ standalone: false, hasDeferredPrompt: false, isIOS: false })).toBe('manual')
  })
})

describe('isStandaloneDisplay', () => {
  const mm = (matches: boolean) => (query: string) => {
    expect(query).toBe('(display-mode: standalone)')
    return { matches }
  }

  it('true when display-mode matches', () => {
    expect(isStandaloneDisplay({ matchMedia: mm(true) })).toBe(true)
  })

  it('true via the legacy iOS navigator.standalone', () => {
    expect(isStandaloneDisplay({ matchMedia: mm(false), navigator: { standalone: true } })).toBe(true)
  })

  it('false in a plain browser tab', () => {
    expect(isStandaloneDisplay({ matchMedia: mm(false), navigator: { standalone: false } })).toBe(false)
  })

  it('false when the platform offers neither signal', () => {
    expect(isStandaloneDisplay({})).toBe(false)
  })
})

describe('isIOSDevice', () => {
  it('detects iPhone and iPod by UA', () => {
    expect(isIOSDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)' })).toBe(true)
    expect(isIOSDevice({ userAgent: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)' })).toBe(true)
  })

  it('detects an iPadOS that masquerades as macOS — the touch tell', () => {
    // iPadOS 13+ reports a Mac UA/platform; real Macs have no touchscreen.
    expect(isIOSDevice({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.4 Safari/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    })).toBe(true)
  })

  it('does NOT flag a real Mac', () => {
    expect(isIOSDevice({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.4 Safari/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 0,
    })).toBe(false)
  })

  it('does NOT flag Android or desktop Windows', () => {
    expect(isIOSDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/126', platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe(false)
    expect(isIOSDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126', platform: 'Win32', maxTouchPoints: 0 })).toBe(false)
  })
})

/** Build a fake BeforeInstallPromptEvent the store can capture. */
function fakePromptEvent(outcome: 'accepted' | 'dismissed') {
  const e = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent & {
    prompt: ReturnType<typeof vi.fn>
  }
  Object.assign(e, {
    prompt: vi.fn().mockResolvedValue(undefined),
    userChoice: Promise.resolve({ outcome }),
  })
  return e
}

describe('createInstallPromptStore', () => {
  it('captures the event, preventDefaults it, and notifies subscribers', () => {
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    store.init()
    const cb = vi.fn()
    store.subscribe(cb)

    expect(store.has()).toBe(false)
    const e = fakePromptEvent('accepted')
    target.dispatchEvent(e)

    expect(store.has()).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    // preventDefault is what suppresses Chrome's own mini-infobar.
    expect(e.defaultPrevented).toBe(true)
  })

  it('does nothing until init() attaches the listeners', () => {
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    target.dispatchEvent(fakePromptEvent('accepted'))
    expect(store.has()).toBe(false)
  })

  it('prompt() consumes the single-use event synchronously, before the dialog resolves', async () => {
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    store.init()
    const e = fakePromptEvent('accepted')
    target.dispatchEvent(e)
    const cb = vi.fn()
    store.subscribe(cb)

    const inFlight = store.prompt()
    // BEFORE awaiting: the store must already be empty — this is the "second
    // click while the dialog is open" scenario. (The review's mutation pass
    // proved an after-the-await assertion here is order-blind: moving the
    // consumption below `await e.prompt()` kept every test green.)
    expect(store.has()).toBe(false)
    expect(cb).toHaveBeenCalled()

    await expect(inFlight).resolves.toBe('accepted')
    expect(e.prompt).toHaveBeenCalledTimes(1)
    await expect(store.prompt()).resolves.toBe('unavailable')
  })

  it('a rejecting native prompt propagates — and the event stays consumed', async () => {
    // Chrome rejects prompt() on a stale event (NotAllowedError). The store
    // does not swallow it (the caller decides the UX), but must not re-offer
    // the dead event either.
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    store.init()
    const e = fakePromptEvent('accepted')
    e.prompt.mockRejectedValue(new Error('NotAllowedError'))
    target.dispatchEvent(e)

    await expect(store.prompt()).rejects.toThrow('NotAllowedError')
    expect(store.has()).toBe(false)
    await expect(store.prompt()).resolves.toBe('unavailable')
  })

  it('prompt() reports a dismissal', async () => {
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    store.init()
    target.dispatchEvent(fakePromptEvent('dismissed'))
    await expect(store.prompt()).resolves.toBe('dismissed')
  })

  it('appinstalled clears the captured prompt, marks the session installed, and notifies', () => {
    // Chrome fires appinstalled when the user installs (button OR browser
    // menu). The tab that installed keeps running un-standalone, so
    // installedThisSession is what stops the card from pointing the user at
    // the browser menu they just came from.
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    store.init()
    target.dispatchEvent(fakePromptEvent('accepted'))
    expect(store.has()).toBe(true)
    expect(store.installedThisSession()).toBe(false)
    const cb = vi.fn()
    store.subscribe(cb)
    target.dispatchEvent(new Event('appinstalled'))
    expect(store.has()).toBe(false)
    expect(store.installedThisSession()).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe stops notifications', () => {
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    store.init()
    const cb = vi.fn()
    store.subscribe(cb)()
    target.dispatchEvent(fakePromptEvent('accepted'))
    expect(cb).not.toHaveBeenCalled()
  })

  it('init() is idempotent — no double-capture, no double-notify', () => {
    const target = new EventTarget()
    const store = createInstallPromptStore(target)
    store.init()
    store.init()
    const cb = vi.fn()
    store.subscribe(cb)
    target.dispatchEvent(fakePromptEvent('accepted'))
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('registerServiceWorker', () => {
  it('registers sw.js relative to the Vite base — the mount path single source of truth', () => {
    const register = vi.fn().mockResolvedValue({})
    registerServiceWorker({ serviceWorker: { register } }, '/v2/')
    expect(register).toHaveBeenCalledWith('/v2/sw.js')
  })

  it('silently no-ops where service workers are unsupported', () => {
    expect(() => registerServiceWorker({}, '/v2/')).not.toThrow()
  })

  it('a registration failure is contained — app boot must never depend on it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const register = vi.fn().mockRejectedValue(new Error('CSP blocked'))
    expect(() => registerServiceWorker({ serviceWorker: { register } }, '/v2/')).not.toThrow()
    // Let the rejection propagate through the .catch.
    await new Promise(r => setTimeout(r, 0))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
