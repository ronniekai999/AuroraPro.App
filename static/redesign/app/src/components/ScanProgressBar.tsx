// The scan bar: one row under the top bar for each library that is being
// scanned, saying which, how far along, and where to see more.
//
// It polls `/api/libraries/{id}/scan/status` for every known library every
// 4s while any are active. Idle, the component renders nothing.
//
// Future: replace polling with a global WebSocket subscription to
// the existing server-side `scan_progress` events. The polling
// fallback is correct but burns one API call per library every 4s
// while a scan runs — acceptable for the typical 1-3 library case.

import { useEffect, useRef, useState } from 'react'
import { getScanStatus, listLibraries, type Library, type ScanStatus } from '@/lib/api'
import { restoreFollowed } from './admin/restoreOutcome'

interface ProgressItem {
  library: Library
  status: ScanStatus
}

export function ScanProgressBar({ isAdmin, onScanComplete, onOpenLibraries }: {
  isAdmin: boolean
  /** Opens the admin page's Libraries section, where a scan is run and
   *  watched. The row offers it when this is given. */
  onOpenLibraries?: () => void
  /**
   * Fired once when the last running scan finishes.
   *
   * App treats it as a catalog change (a live catalog refresh, see
   * lib/catalogUpdates.ts). Every client already hears of scans that add
   * titles through the server's library_update events; this edge also
   * covers, for whoever is watching the scan (the polling is admin-gated),
   * scans that only removed titles, which send no event.
   */
  onScanComplete?: () => void
}) {
  const [libraries, setLibraries] = useState<Library[]>([])
  const [statuses, setStatuses] = useState<Map<number, ScanStatus>>(new Map())

  // Load libraries once on mount (admin only). Refresh periodically
  // in case admin adds one.
  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    const fetchLibs = async () => {
      try { const ls = await listLibraries(); if (!cancelled) setLibraries(ls) }
      catch { /* non-fatal */ }
    }
    void fetchLibs()
    const id = window.setInterval(fetchLibs, 30000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [isAdmin])

  // Poll scan status of all libraries every 4s. We don't get a
  // server-side hint about which libraries are scanning right now,
  // so we just ask each; tiny query, fast on Postgres.
  useEffect(() => {
    if (!isAdmin || libraries.length === 0) return
    let cancelled = false
    let polling = false
    const tick = async () => {
      // One poll at a time, and none while this tab follows a database
      // restore: its transaction holds locks the status read waits on, and a
      // poll every 4 s would stack requests, each holding one of the
      // server's database connections until the restore ends.
      if (polling || restoreFollowed()) return
      polling = true
      try { await poll() } finally { polling = false }
    }
    const poll = async () => {
      // Collect only the libraries that ANSWERED, then merge over the previous
      // map. Rebuilding from empty each poll meant one failed request dropped
      // that library, which read as "no longer running" — indistinguishable
      // from the scan actually finishing. Since the completion signal keys off
      // exactly that, a blip fired a spurious Home refetch, and every
      // outage/recovery cycle fired another. Merging leaves the last known
      // state in place; only a definitive response replaces it.
      //
      // The merge happens inside the updater rather than off a ref, so nothing
      // reads mutable state during render.
      const answered = new Map<number, ScanStatus>()
      await Promise.all(libraries.map(async lib => {
        try {
          const s = await getScanStatus(lib.id)
          if (!cancelled) answered.set(lib.id, s)
        } catch { /* per-library failure: keep the last known status */ }
      }))
      if (!cancelled) {
        setStatuses(prev => {
          const next = new Map(prev)
          for (const [id, st] of answered) next.set(id, st)
          return next
        })
      }
    }
    void tick()
    const id = window.setInterval(tick, 4000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [libraries, isAdmin])

  // Detect the running -> idle edge. Derived from the same `statuses` the bar
  // renders from, so it cannot disagree with what the user just watched finish.
  const wasScanningRef = useRef(false)
  const scanning = libraries.some(lib => statuses.get(lib.id)?.status === 'running')
  useEffect(() => {
    if (wasScanningRef.current && !scanning) onScanComplete?.()
    wasScanningRef.current = scanning
  }, [scanning, onScanComplete])

  // Audit H2 (Phase 5.3 audit-8) — filter on `status === 'running'`
  // (the real server field), and derive percent from total_files /
  // scanned_files since the server doesn't emit a pre-computed
  // progress float.
  const active: ProgressItem[] = []
  for (const lib of libraries) {
    const s = statuses.get(lib.id)
    if (s && s.status === 'running') active.push({ library: lib, status: s })
  }
  // Not admin (a switch to a restricted profile on an admin account): show
  // nothing, including the last scan polled while it was. The state is kept,
  // not cleared, so the completion edge above does not read the switch as a
  // scan finishing; polling restarts if the session is an admin's again.
  if (!isAdmin) return null
  // What a screen reader is told: which libraries are being scanned, once,
  // when that changes ("Scanning Movies"), and nothing as the counts tick.
  // Its own element, mounted for as long as an admin is (a live region put
  // on the page already filled is often not read), and not the bar: the
  // bar's counts change every four seconds, and a status that held them
  // would be read out each time. Emptied when the last scan ends, which
  // says nothing.
  const said = active.length > 0 ? `Scanning ${active.map(a => a.library.name).join(', ')}` : ''

  // In normal flow, not fixed: App wraps this bar and the top bar in one
  // sticky container, so both stay pinned together and the bar's height
  // pushes the page down. (Fixed, it sat over the top bar.)
  return (
    <>
      <p className="sr-only" role="status" data-scan-said="">{said}</p>
      {active.length > 0 && (
        <div className="scanbar">
          {active.map(({ library: lib, status: s }) => {
            const pct = s.total_files > 0
              ? Math.min(100, Math.max(0, (s.scanned_files / s.total_files) * 100))
              : 0
            return (
              // One row of a fixed height, nothing in it wrapping. This bar
              // is in the sticky chrome stack, whose measured height App
              // publishes as --chrome-h; the counts change every 4s, and a
              // row that grew as its digits did would step everything
              // placed under the stack.
              <div key={lib.id} className="scanbar-row" data-scan-library={lib.id}>
                <span className="scanbar-name">Scanning {lib.name}</span>
                {s.total_files > 0 && (
                  <span className="scanbar-count">
                    {s.scanned_files.toLocaleString()} of {s.total_files.toLocaleString()} files
                    {s.new_files > 0 && <> · {s.new_files.toLocaleString()} new</>}
                  </span>
                )}
                <span className="scanbar-track" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
                {onOpenLibraries && (
                  <button type="button" className="scanbar-open" onClick={onOpenLibraries}>
                    Open Libraries
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
