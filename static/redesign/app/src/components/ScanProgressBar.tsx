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

import { useEffect, useState } from 'react'
import { getScanStatus, listLibraries, type Library, type ScanStatus } from '@/lib/api'

interface ProgressItem {
  library: Library
  status: ScanStatus
}

export function ScanProgressBar({ isAdmin }: { isAdmin: boolean }) {
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
      const next = new Map<number, ScanStatus>()
      await Promise.all(libraries.map(async lib => {
        try {
          const s = await getScanStatus(lib.id)
          if (!cancelled) next.set(lib.id, s)
        } catch { /* per-library failure ignored */ }
      }))
      if (!cancelled) setStatuses(next)
    }
    void tick()
    const id = window.setInterval(tick, 4000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [libraries, isAdmin])

  // Audit H2 (Phase 5.3 audit-8) — filter on `status === 'running'`
  // (the real server field), and derive percent from total_files /
  // scanned_files since the server doesn't emit a pre-computed
  // progress float.
  const active: ProgressItem[] = []
  for (const lib of libraries) {
    const s = statuses.get(lib.id)
    if (s && s.status === 'running') active.push({ library: lib, status: s })
  }
  if (active.length === 0) return null

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
            <div className="flex items-center justify-between gap-3 mb-1">
              <span className="text-white/80 text-xs font-medium">
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
                className="h-full bg-purple-500 transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
