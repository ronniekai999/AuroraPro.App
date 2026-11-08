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
// not a refetch of everything.

/** Events closer together than this become one refresh. */
export const CATALOG_UPDATE_DELAY_MS = 1500

/**
 * A grid refreshed in place refetches every page it has loaded. Past this
 * many pages it is not refetched while on screen (the refresh would be a
 * burst of requests every few seconds during a scan); it is dropped once it is
 * off screen instead, so the next visit loads page 1 afresh.
 */
export const CATALOG_REFRESH_MAX_PAGES = 20

export interface CatalogUpdateScheduler {
  /** A library_update arrived. */
  notify(): void
  /** The document may have become visible; flush a refresh held while hidden. */
  visible(): void
  dispose(): void
}

/**
 * Coalesces library_update events into refreshes.
 *
 * The first event starts a short timer and later events inside it ride along,
 * so a mid-scan event followed closely by the completion, or two libraries
 * scanning at once, make one refresh. A refresh due while the tab is hidden
 * waits until it is visible: a background tab on Home would otherwise refetch
 * every ten seconds of a long import for nobody.
 */
export function createCatalogUpdateScheduler(opts: {
  onFlush: () => void
  isHidden: () => boolean
  delayMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void
}): CatalogUpdateScheduler {
  const delayMs = opts.delayMs ?? CATALOG_UPDATE_DELAY_MS
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? (id => clearTimeout(id))
  let timer: ReturnType<typeof setTimeout> | null = null
  let heldWhileHidden = false
  let disposed = false

  const fire = () => {
    timer = null
    if (disposed) return
    if (opts.isHidden()) {
      heldWhileHidden = true
      return
    }
    opts.onFlush()
  }

  return {
    notify() {
      if (disposed || timer !== null) return
      timer = setTimer(fire, delayMs)
    },
    visible() {
      if (disposed || !heldWhileHidden || opts.isHidden()) return
      heldWhileHidden = false
      opts.onFlush()
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
 * the same depth and a Load More cursor that matches the server again.
 *
 * Pages are fetched together while a scan may still be writing, so a title
 * that moves across a page boundary between two requests could arrive twice;
 * the first copy is kept. (One that moves the other way is missed until the
 * next refresh, which the scan's completion event brings.) Rejects if any page
 * fails, leaving the caller's list as it was.
 */
export async function refetchLoadedPages<T extends { id: number }>(
  fetchPage: (page: number) => Promise<{ items: T[]; total: number }>,
  pages: number,
): Promise<{ items: T[]; total: number; nextPage: number }> {
  const count = Math.max(1, pages)
  const results = await Promise.all(Array.from({ length: count }, (_, i) => fetchPage(i + 1)))
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
