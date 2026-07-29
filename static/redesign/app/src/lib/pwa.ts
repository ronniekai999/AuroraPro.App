// PWA plumbing: service-worker registration and the install-prompt lifecycle.
//
// Design contract (do/pwa-push/IMPLEMENTATION.md): the service worker exists
// for push delivery only — it never intercepts fetches and never caches, so
// registering it can never affect what the app serves. Everything here is
// therefore allowed to be best-effort: any failure degrades to "the site
// behaves exactly as before this feature existed".
//
// Every decision is a pure function taking its platform inputs as arguments,
// and the one piece of long-lived state (the captured install prompt) lives
// behind a factory so tests build their own store on a fresh EventTarget
// instead of resetting module globals.

/** Which UI the Settings "App" card shows. */
export type InstallUIState = 'installed' | 'prompt' | 'ios-guide' | 'manual'

/**
 * Decide the install card's state.
 *
 * Precedence: `standalone` wins outright (we're already installed — Chrome can
 * leave a captured prompt lying around for "install this site as a second
 * window", which would read as "not installed yet"). A captured prompt beats
 * the iOS guide because a one-tap button is strictly better than a manual
 * walkthrough wherever the browser offers it — and on real iOS the event
 * never fires, so the guide still shows there.
 */
export function installUIState(opts: {
  standalone: boolean
  hasDeferredPrompt: boolean
  isIOS: boolean
}): InstallUIState {
  if (opts.standalone) return 'installed'
  if (opts.hasDeferredPrompt) return 'prompt'
  if (opts.isIOS) return 'ios-guide'
  return 'manual'
}

/**
 * Is the app currently displayed as an installed app?
 *
 * `display-mode: standalone` is the standard signal (matches what our
 * manifest requests); `navigator.standalone` is the legacy iOS property that
 * predates display-mode support and still reports true on installed
 * home-screen apps.
 */
export function isStandaloneDisplay(win: {
  matchMedia?: (query: string) => { matches: boolean }
  // `unknown` rather than `{ standalone?: boolean }`: lib.dom's Navigator has
  // no `standalone` (it's a non-standard iOS property), so a structural
  // object type here would reject the real `window`. Read it defensively.
  navigator?: unknown
}): boolean {
  if (win.matchMedia?.('(display-mode: standalone)').matches) return true
  return (win.navigator as { standalone?: unknown } | undefined)?.standalone === true
}

/**
 * Is this an iOS/iPadOS device (any browser — they are all WebKit there)?
 *
 * The UA covers iPhone/iPod and pre-13 iPads. iPadOS 13+ deliberately
 * masquerades as macOS Safari, so the tell is "claims Mac, but has a
 * touchscreen" — real Macs report 0 maxTouchPoints.
 */
export function isIOSDevice(nav: {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
}): boolean {
  if (/iPhone|iPad|iPod/i.test(nav.userAgent)) return true
  return /Mac/i.test(nav.platform ?? '') && (nav.maxTouchPoints ?? 0) > 1
}

/** The Chromium-only event; not in lib.dom because it never got standardized. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export interface InstallPromptStore {
  /** Attach listeners. Idempotent; must run before the browser can fire the event. */
  init(): void
  /** Is a captured, unused prompt available right now? */
  has(): boolean
  /**
   * Did `appinstalled` fire in this session? The tab that triggered an
   * install keeps running as a plain tab (standalone stays false), so this is
   * the only signal that lets the Settings card say "installed" instead of
   * pointing the user back at a browser menu they just used.
   */
  installedThisSession(): boolean
  /** Subscribe to availability changes (useSyncExternalStore-shaped). */
  subscribe(cb: () => void): () => void
  /**
   * Show the browser's install dialog. Resolves with the user's choice, or
   * 'unavailable' when no prompt is captured. The captured event is single-use
   * per spec, so it is consumed (and subscribers notified) synchronously,
   * before the dialog opens — a second click during the dialog re-prompts
   * nothing. A rejection from the native prompt() propagates to the caller.
   */
  prompt(): Promise<'accepted' | 'dismissed' | 'unavailable'>
}

export function createInstallPromptStore(target: EventTarget): InstallPromptStore {
  let deferred: BeforeInstallPromptEvent | null = null
  let installed = false
  let inited = false
  const subs = new Set<() => void>()
  const notify = () => {
    for (const cb of subs) cb()
  }
  return {
    init() {
      if (inited) return
      inited = true
      target.addEventListener('beforeinstallprompt', e => {
        // Suppress Chrome's own mini-infobar; the Settings card presents the
        // prompt on the user's terms instead.
        e.preventDefault()
        deferred = e as BeforeInstallPromptEvent
        notify()
      })
      target.addEventListener('appinstalled', () => {
        deferred = null
        installed = true
        notify()
      })
    },
    has: () => deferred !== null,
    installedThisSession: () => installed,
    subscribe(cb) {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    },
    async prompt() {
      const e = deferred
      if (!e) return 'unavailable'
      // Consume BEFORE the dialog: the event is one-shot per spec, and this
      // ordering is what a click on the button behind the open dialog tests.
      deferred = null
      notify()
      await e.prompt()
      return (await e.userChoice).outcome
    },
  }
}

/** The app-wide store, bound to window. Tests build their own via the factory. */
export const installPrompt: InstallPromptStore = createInstallPromptStore(
  typeof window !== 'undefined' ? window : new EventTarget(),
)

/**
 * Register the service worker. Fire-and-forget by design: registration
 * failure (old browser, private mode, CSP) must never affect app boot, and
 * with no fetch handler in the worker there is nothing time-critical about
 * when it activates.
 *
 * The URL derives from Vite's BASE_URL so the mount path has a single source
 * of truth (`vite.config.ts` base — same rule as the router basename in
 * main.tsx). Today that resolves to /v2/sw.js, whose natural scope /v2/
 * covers the whole app.
 */
export function registerServiceWorker(
  nav: { serviceWorker?: { register: (url: string) => Promise<unknown> } } = navigator,
  base: string = import.meta.env.BASE_URL,
): void {
  const sw = nav.serviceWorker
  if (!sw) return
  sw.register(`${base}sw.js`).catch((err: unknown) => {
    console.warn('Aurora: service worker registration failed', err)
  })
}

/**
 * One-call boot hook for main.tsx. Order matters: the prompt listener must be
 * attached before Chrome can fire beforeinstallprompt, which can happen very
 * early on repeat visits; registration is deliberately after it.
 */
export function initPWA(): void {
  installPrompt.init()
  registerServiceWorker()
}
