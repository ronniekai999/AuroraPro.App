// Aurora V2 — global scan progress bar.
//
// Phase 5.3 parity port. V1 has a top-of-page bar that fills as the
// scanner ticks; here we poll `/api/libraries/{id}/scan/status` for
// every known library every 4s while any are active. Renders a thin
// bar at the very top of the viewport when at least one scan is
// running. Idle = component returns null.
//
// Future: replace polling with a global WebSocket subscription to
// the existing server-side `scan_progress` events. The polling
// fallback is correct but burns one API call per library every 4s
// while a scan runs — acceptable for the typical 1-3 library case.

import { useEffect, useRef, useState } from 'react'
import { getScanStatus, listLibraries, type Library, type ScanStatus } from '@/lib/api'

interface ProgressItem {
  library: Library
  status: ScanStatus
}

export function ScanProgressBar({ isAdmin, onScanComplete }: {
  isAdmin: boolean
  /**
   * Fired once when the last running scan finishes.
   *
   * This component was purely decorative: it polled, drew a bar, and told
   * nobody. So a scan could add titles and Home — which loads once and keeps
   * its rails in state — would keep showing the pre-scan library until a hard
   * refresh. It already knows the exact moment new content landed; this hands
   * that fact to the one place that can act on it.
   *
   * Only whoever is watching the scan gets this, because the polling is
   * admin-gated. Everyone else is covered by Home's staleness gate.
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
    const tick = async () => {
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
  if (!isAdmin || active.length === 0) return null

  // Phase 5.3 final QA — flow positioning. Previously the bar was
  // `fixed top-0` which collided with the page's sticky top header
  // (both wanted row 0). `fixed` removes the element from the
  // parent's layout, so the header could not be pushed down to make
  // room. Now: render in normal flow. The parent (App.tsx) wraps
  // this bar + header in a single `sticky top-0` container so both
  // stay pinned together AND the bar's height pushes the page
  // content down naturally.
  return (
    <div className="bg-[#0a0a0f]/90 backdrop-blur-md border-b border-purple-500/30">
      {active.map(({ library: lib, status: s }) => {
        const pct = s.total_files > 0
          ? Math.min(100, Math.max(0, (s.scanned_files / s.total_files) * 100))
          : 0
        return (
          <div key={lib.id} className="px-4 py-1.5">
            {/* Fixed row height + nowrap. This bar sits ABOVE the nav inside
                the sticky chrome stack, and App publishes that stack's
                measured height as --chrome-h. The counts here update every
                4s, so if the text can wrap as digits grow the stack height
                changes and every consumer of --chrome-h (the sticky browse
                toolbar, both drawers, DetailRail) steps with it. */}
            <div className="flex items-center justify-between gap-3 mb-1 h-4">
              <span className="text-white/80 text-xs font-medium whitespace-nowrap overflow-hidden text-ellipsis">
                Scanning <strong className="text-purple-200">{lib.name}</strong>
                {s.total_files > 0 && (
                  <span className="text-white/40 ml-2">
                    {s.scanned_files.toLocaleString()} / {s.total_files.toLocaleString()}
                    {s.new_files > 0 && <> · <span className="text-emerald-300">{s.new_files} new</span></>}
                  </span>
                )}
              </span>
              {s.current_file && (
                <span className="text-white/40 text-[10px] truncate max-w-[40%]" title={s.current_file}>
                  {/* Audit L4 — server already passes the basename;
                      the extra split is harmless but unnecessary. */}
                  {s.current_file}
                </span>
              )}
            </div>
            <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className="h-full bg-purple-500 transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
