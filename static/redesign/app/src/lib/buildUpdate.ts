// Noticing that the server now serves a newer build than this tab is running.
//
// A deploy replaces /v2/ wholesale and deletes the previous build's chunks, and
// no service worker keeps them (public/sw.js), so a tab left open across an
// update runs the old JavaScript against the new API, and fails the first time
// it needs a view it had not loaded yet. The build stamps its id into
// index.html (<meta name="aurora-build">, vite-build-id.ts); this module reads
// the id the page was loaded with, re-reads the one /v2/ serves now, and tells
// the user when they differ. It never reloads by itself: that would lose what
// they were doing (a video, a form), which is the ErrorBoundary's reasoning too.

import { useCallback, useEffect, useRef, useState } from 'react'

// Must match BUILD_ID_META_NAME in vite-build-id.ts.
export const BUILD_ID_META_NAME = 'aurora-build'

/** Fired by code that has just seen a chunk fail to load; checks at once. */
export const STALE_BUNDLE_EVENT = 'aurora:stale-bundle'

/** Routine re-checks (focus, visibility, the timer) at most this often. */
export const MIN_CHECK_INTERVAL_MS = 60_000
/** While the tab is visible. The updater runs every five minutes. */
export const CHECK_EVERY_MS = 5 * 60_000

export function readBuildId(doc: Document): string | null {
  const content = doc.querySelector(`meta[name="${BUILD_ID_META_NAME}"]`)?.getAttribute('content')?.trim()
  return content || null
}

export function parseBuildIdFromHtml(html: string): string | null {
  return readBuildId(new DOMParser().parseFromString(html, 'text/html'))
}

/** The build id /v2/ serves right now, or null when it cannot be told. */
export async function fetchDeployedBuildId(
  fetchImpl: typeof fetch = fetch,
  base: string = import.meta.env.BASE_URL,
): Promise<string | null> {
  try {
    const res = await fetchImpl(base, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
    })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) return null
    return parseBuildIdFromHtml(await res.text())
  } catch {
    return null
  }
}

// The messages browsers give a dynamic import() whose chunk is gone, and Vite's
// own for a CSS preload. Chromium, Firefox and WebKit word it differently.
const STALE_BUNDLE_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Unable to preload CSS/i,
]

/** Does this error look like a chunk of an older build that no longer exists? */
export function isStaleBundleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return STALE_BUNDLE_PATTERNS.some(pattern => pattern.test(message))
}

export function announceStaleBundle(): void {
  try {
    window.dispatchEvent(new Event(STALE_BUNDLE_EVENT))
  } catch { /* no window (tests, SSR): nothing to tell */ }
}

interface Options {
  /** The id this page was loaded with; defaults to the document's <meta>. */
  ownBuildId?: string | null
  fetchDeployed?: () => Promise<string | null>
  now?: () => number
}

/**
 * Whether a newer build than this page's is deployed. `dismiss` hides the
 * notice for the build it was shown for; a later, different build shows it
 * again. Does nothing for a page without a build id (the dev server).
 */
export function useNewBuildAvailable(options: Options = {}): { available: boolean; dismiss: () => void } {
  const own = useRef(options.ownBuildId !== undefined ? options.ownBuildId : readBuildId(document))
  // Held in refs so a caller passing fresh functions each render does not
  // re-subscribe the listeners or restart the timer.
  const fetchDeployed = useRef(options.fetchDeployed ?? fetchDeployedBuildId)
  fetchDeployed.current = options.fetchDeployed ?? fetchDeployedBuildId
  const now = useRef(options.now ?? Date.now)
  now.current = options.now ?? Date.now
  const [newer, setNewer] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const lastCheck = useRef(Number.NEGATIVE_INFINITY)
  const inFlight = useRef(false)

  const check = useCallback(async (force: boolean) => {
    if (!own.current || inFlight.current) return
    if (!force && now.current() - lastCheck.current < MIN_CHECK_INTERVAL_MS) return
    inFlight.current = true
    lastCheck.current = now.current()
    try {
      const deployed = await fetchDeployed.current()
      // A failed or unreadable answer (a deploy mid-restart, offline) says nothing.
      if (deployed && deployed !== own.current) setNewer(deployed)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    if (!own.current) return
    const routine = () => {
      if (document.visibilityState === 'visible') void check(false)
    }
    const urgent = () => { void check(true) }
    document.addEventListener('visibilitychange', routine)
    window.addEventListener('focus', routine)
    window.addEventListener('online', routine)
    // Vite dispatches this when a lazy chunk (or its CSS) fails to load.
    window.addEventListener('vite:preloadError', urgent)
    window.addEventListener(STALE_BUNDLE_EVENT, urgent)
    const timer = window.setInterval(routine, CHECK_EVERY_MS)
    return () => {
      document.removeEventListener('visibilitychange', routine)
      window.removeEventListener('focus', routine)
      window.removeEventListener('online', routine)
      window.removeEventListener('vite:preloadError', urgent)
      window.removeEventListener(STALE_BUNDLE_EVENT, urgent)
      window.clearInterval(timer)
    }
  }, [check])

  const dismiss = useCallback(() => setDismissed(newer), [newer])
  return { available: newer !== null && newer !== dismissed, dismiss }
}
