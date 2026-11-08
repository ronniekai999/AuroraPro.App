import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { createCatalogUpdateScheduler, type CatalogUpdateScheduler } from '@/lib/catalogUpdates'

/**
 * The catalog's version as this tab knows it: 0 at load, plus one for each
 * coalesced batch of library_update events (lib/catalogUpdates.ts).
 *
 * `held`: refreshes wait while it is true (the app passes "the player is
 * open", so an import does not refetch what is behind a film), as they do
 * while the tab is hidden, and one held refresh runs when it turns false.
 *
 * Returns the version (state, for effects to depend on), a ref holding the
 * same number (for a fetch to record which version it loaded without
 * depending on it), and `notify`, which the socket handler calls per event.
 */
export function useCatalogVersion({ held = false }: { held?: boolean } = {}): {
  catalogVersion: number
  catalogVersionRef: RefObject<number>
  notifyCatalogChanged: () => void
} {
  const [catalogVersion, setCatalogVersion] = useState(0)
  const catalogVersionRef = useRef(0)
  const schedulerRef = useRef<CatalogUpdateScheduler | null>(null)
  const heldRef = useRef(held)

  useEffect(() => {
    const scheduler = createCatalogUpdateScheduler({
      isHidden: () => heldRef.current ||
        (typeof document !== 'undefined' && document.visibilityState === 'hidden'),
      onFlush: () => {
        // The ref moves first, so a fetch that starts in the render this
        // update causes records the new version.
        catalogVersionRef.current += 1
        setCatalogVersion(catalogVersionRef.current)
      },
    })
    schedulerRef.current = scheduler
    const onVisible = () => scheduler.visible()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      scheduler.dispose()
      if (schedulerRef.current === scheduler) schedulerRef.current = null
    }
  }, [])

  useEffect(() => {
    heldRef.current = held
    if (!held) schedulerRef.current?.visible()
  }, [held])

  const notifyCatalogChanged = useCallback(() => schedulerRef.current?.notify(), [])

  return { catalogVersion, catalogVersionRef, notifyCatalogChanged }
}
