// Live catalog updates: what the app does when a library scan adds titles.
//
// The server sends `library_update` on /ws while a scan is adding files (at
// most every 10 seconds per scan, `LibraryUpdateInterval`) and when a scan
// that added files completes (internal/api/library_updates.go). Every catalog
// view used to load once and keep its data in App state, so new titles stayed
// invisible until a page reload: Home refreshed only on an admin's scan-bar
// edge or a 30-second staleness gate on return, the Movies and Shows grids
// were cached for the session, and the admin dashboard read its counts once.
//
// The app turns those events into one `catalogVersion` number. Each view
// remembers the version its data was loaded at and refetches when it is on
// screen and behind; a view that is not on screen catches up the next time it
// is shown. So an event costs each open tab one refetch of the view it shows,
// not a refetch of everything, and Home refetches only its catalog rails, not
// the hero, Continue Watching or the personalized rails.

/** Events closer together than this become one refresh. */
export const CATALOG_UPDATE_DELAY_MS = 1500

/**
 * The least time between two refreshes. The server holds each scan to one
 * mid-scan event per 10 seconds, but several libraries scanning at once each
 * send their own; this keeps a tab to one refresh per 10 seconds whatever the
 * server sends.
 */
export const CATALOG_UPDATE_MIN_GAP_MS = 10_000

/**
 * A grid refreshed in place refetches every page it has loaded. Past this
 * many pages it is left as it is (stale until a sort or genre change or a
 * reload) rather than refetched, which would be a burst of requests every ten
 * seconds of a scan, or dropped, which would lose the reader's place.
 */
export const CATALOG_REFRESH_MAX_PAGES = 10

/** Page requests one grid refresh has in flight at once. */
export const CATALOG_REFRESH_CONCURRENCY = 3

export interface CatalogUpdateScheduler {
  /** A library_update arrived (or the socket reconnected). */
  notify(): void
  /** The tab may have become visible, or the hold lifted; flush a held refresh. */
  visible(): void
  dispose(): void
}

/**
 * Coalesces library_update events into refreshes.
 *
 * The first event starts a short timer and later events inside it ride along,
 * so a mid-scan event followed closely by the completion, or two libraries
 * scanning at once, make one refresh; a refresh also waits until
 * `minGapMs` after the previous one. A refresh due while `isHidden()` (the tab
 * is hidden, or the app holds refreshes while the player is open) waits until
 * `visible()` is called with it false: a background tab on Home would
 * otherwise refetch every ten seconds of a long import for nobody.
 */
export function createCatalogUpdateScheduler(opts: {
  onFlush: () => void
  isHidden: () => boolean
  delayMs?: number
  minGapMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void
}): CatalogUpdateScheduler {
  const delayMs = opts.delayMs ?? CATALOG_UPDATE_DELAY_MS
  const minGapMs = opts.minGapMs ?? CATALOG_UPDATE_MIN_GAP_MS
  const now = opts.now ?? (() => Date.now())
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? (id => clearTimeout(id))
  let timer: ReturnType<typeof setTimeout> | null = null
  let heldWhileHidden = false
  let lastFlushAt = -Infinity
  let disposed = false

  const flush = () => {
    lastFlushAt = now()
    // Whatever was held is covered by this refresh.
    heldWhileHidden = false
    opts.onFlush()
  }
  const fire = () => {
    timer = null
    if (disposed) return
    if (opts.isHidden()) {
      heldWhileHidden = true
      return
    }
    flush()
  }

  return {
    notify() {
      if (disposed || timer !== null) return
      timer = setTimer(fire, Math.max(delayMs, lastFlushAt + minGapMs - now()))
    },
    visible() {
      if (disposed || !heldWhileHidden || opts.isHidden() || timer !== null) return
      heldWhileHidden = false
      // Through the timer, so a held refresh still keeps the minimum gap.
      timer = setTimer(fire, Math.max(0, lastFlushAt + minGapMs - now()))
    },
    dispose() {
      disposed = true
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}

/** Pages of `perPage` a grid holding `loaded` items has fetched (at least 1). */
export function loadedPageCount(loaded: number, perPage: number): number {
  if (perPage <= 0) return 1
  return Math.max(1, Math.ceil(loaded / perPage))
}

/**
 * Refetches pages 1..`pages` of a grid, so it can be replaced in place with
 * the same depth and a Load More cursor that matches the server again. At most
 * `concurrency` pages are in flight at once, so a refresh never takes all of a
 * browser's connections to the server.
 *
 * Pages are fetched while a scan may still be writing, so a title that moves
 * across a page boundary between two requests could arrive twice; the first
 * copy is kept. (One that moves the other way is missed until the next
 * refresh, which the scan's completion event brings.) Rejects if any page
 * fails, leaving the caller's list as it was; no further page is asked for
 * then, and the caller aborts those in flight.
 */
export async function refetchLoadedPages<T extends { id: number }>(
  fetchPage: (page: number) => Promise<{ items: T[]; total: number }>,
  pages: number,
  concurrency = CATALOG_REFRESH_CONCURRENCY,
): Promise<{ items: T[]; total: number; nextPage: number }> {
  const count = Math.max(1, pages)
  const results: { items: T[]; total: number }[] = new Array(count)
  let next = 0
  let failed = false
  const worker = async () => {
    while (next < count && !failed) {
      const i = next++
      try {
        results[i] = await fetchPage(i + 1)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), count) }, worker))
  const seen = new Set<number>()
  const items: T[] = []
  for (const r of results) {
    for (const it of r.items) {
      if (seen.has(it.id)) continue
      seen.add(it.id)
      items.push(it)
    }
  }
  return { items, total: results[0].total, nextPage: count + 1 }
}

/**
 * The rails with every title in `removed` taken out. Home keeps the rails it
 * fetched in buffers and recomposes them on each refresh, so a card removed
 * from the screen (a 👎, an admin delete) has to be removed from what is
 * recomposed too, or the next refresh puts it back.
 */
export function withoutRemoved<R extends { items: { id: number }[] }>(rails: R[], removed: ReadonlySet<number>): R[] {
  if (removed.size === 0) return rails
  return rails.map(r => ({ ...r, items: r.items.filter(it => !removed.has(it.id)) }))
}
