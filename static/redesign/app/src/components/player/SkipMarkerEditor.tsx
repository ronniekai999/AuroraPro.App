// Admin editor for a file's skip markers, opened from the player's overflow
// menu. It lives in the player rather than on an admin page because fixing a
// marker means looking at the picture: pause on the intro's last frame, press
// "End = now", save. Saved values are written as detector='manual', which the
// background analyser never overwrites. "Off" stores a zero-length marker (the
// analyser will not re-add it and the player never shows it); "Auto" deletes
// the row and queues fresh detection.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { deleteSkipMarker, getAdminSkipMarkers, putSkipMarker, type SkipMarker } from '@/lib/api'
import { PlayerSheet } from './PlayerSheets'

const MARKER_KINDS: SkipMarker['kind'][] = ['recap', 'intro', 'credits']

function fmtMarkerTime(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function SkipMarkerEditor({ fileId, fileType, currentSec, onMarkersChanged, hidden = false, onClose }: {
  fileId: number
  fileType: 'media' | 'episode'
  currentSec: number
  // Called with the file's full marker list after every write, so the
  // player's timeline and Skip button follow the edit (the caller drops
  // zero-length suppressions).
  onMarkersChanged: (markers: SkipMarker[]) => void
  // Closed but kept: on a phone the editor is a sheet over the timeline, so
  // setting a marker means closing it to scrub and opening it again. The
  // unsaved draft has to survive that.
  hidden?: boolean
  // Puts the editor away (keeping its draft). On a phone it is a sheet over
  // the timeline with nothing else on it that closes it.
  onClose?: () => void
}) {
  type Draft = { start_ms: number; end_ms: number; detector?: string }
  const [drafts, setDrafts] = useState<Partial<Record<SkipMarker['kind'], Draft>>>({})
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // The kinds with an edit that has not been saved. A write answers with the
  // file's whole marker list; taking all of it would throw away what the
  // admin has set on the OTHER kinds and not saved yet (set the intro's end,
  // then turn the recap off: the intro's end was gone).
  const dirtyRef = useRef(new Set<SkipMarker['kind']>())
  // What the server says, laid over the drafts: every kind takes the server's
  // value except the unsaved ones, and `written`, the kind this answer is
  // for, always takes it.
  const applyServer = useCallback((markers: SkipMarker[], written: SkipMarker['kind'] | null) => {
    if (written) dirtyRef.current.delete(written)
    const keep = new Set(dirtyRef.current)
    setDrafts(prev => {
      const next: Partial<Record<SkipMarker['kind'], Draft>> = {}
      for (const m of markers) {
        next[m.kind] = { start_ms: m.start_ms, end_ms: m.end_ms, detector: m.detector }
      }
      for (const kind of keep) {
        if (prev[kind]) next[kind] = prev[kind]
      }
      return next
    })
  }, [])

  // The file this editor is for, and whether it is still mounted. A write
  // answers after an await; by then the player may have moved to the next
  // file (or closed), and handing it the previous file's markers would draw
  // them on the wrong timeline. Hidden is not gone: an editor that is merely
  // put away still takes its answers.
  const fileKey = `${fileType}:${fileId}`
  const fileKeyRef = useRef(fileKey)
  const aliveRef = useRef(true)
  useLayoutEffect(() => { fileKeyRef.current = fileKey })
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])
  const stillFor = (key: string) => aliveRef.current && fileKeyRef.current === key

  // The FULL list, suppressions included: stream info carries only the
  // markers a viewer is shown.
  useEffect(() => {
    const ac = new AbortController()
    // A new file starts clean: no drafts, no edits, nothing pending.
    dirtyRef.current = new Set()
    setDrafts({})
    setLoaded(false)
    setBusy(false)
    setErr(null)
    getAdminSkipMarkers(fileId, fileType, ac.signal)
      .then(markers => { applyServer(markers, null); setLoaded(true) })
      .catch(e => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setErr('Failed to load markers')
        setLoaded(true)
      })
    return () => ac.abort()
  }, [fileId, fileType, applyServer])

  const setNow = (kind: SkipMarker['kind'], field: 'start_ms' | 'end_ms') => {
    const nowMs = Math.max(0, Math.round(currentSec * 1000))
    dirtyRef.current.add(kind)
    setDrafts(prev => {
      const d = prev[kind] ?? { start_ms: 0, end_ms: 0 }
      return { ...prev, [kind]: { ...d, [field]: nowMs } }
    })
  }

  const write = async (kind: SkipMarker['kind'], startMs: number, endMs: number) => {
    const key = fileKey
    setBusy(true)
    setErr(null)
    try {
      const markers = await putSkipMarker(fileId, fileType, { kind, start_ms: startMs, end_ms: endMs })
      if (!stillFor(key)) return
      applyServer(markers, kind)
      onMarkersChanged(markers)
    } catch {
      if (stillFor(key)) setErr('Save failed')
    } finally {
      if (stillFor(key)) setBusy(false)
    }
  }

  const redetect = async (kind: SkipMarker['kind']) => {
    const key = fileKey
    setBusy(true)
    setErr(null)
    try {
      await deleteSkipMarker(fileId, fileType, kind)
      const markers = await getAdminSkipMarkers(fileId, fileType)
      if (!stillFor(key)) return
      applyServer(markers, kind)
      onMarkersChanged(markers)
    } catch {
      if (stillFor(key)) setErr('Update failed')
    } finally {
      if (stillFor(key)) setBusy(false)
    }
  }

  return (
    // passKeys: the arrow keys keep scrubbing the picture while the editor is
    // open, which is how a marker's frame is found.
    <PlayerSheet label="Edit skip markers" anchor="top" hidden={hidden} passKeys>
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2">Skip markers</h3>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="h-11 px-3 -mr-1 rounded-control text-[14px] font-semibold text-ink hover:bg-action-soft transition-colors"
            >
              Done
            </button>
          )}
        </div>
        {!loaded && <p className="mt-2 text-[14px] text-ink-2">Loading…</p>}
        {loaded && MARKER_KINDS.map(kind => {
          const d = drafts[kind]
          const suppressed = !!d && d.start_ms === 0 && d.end_ms === 0 && d.detector === 'manual'
          const invalid = !!d && d.end_ms < d.start_ms
          return (
            // A named group: the five buttons read the same for every kind.
            <div key={kind} role="group" aria-label={kind} className="py-3 border-t border-line first:border-t-0">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px] text-ink capitalize">{kind}</span>
                <span className="text-[13px] text-ink-2 tabular-nums">
                  {!d
                    ? 'none'
                    : suppressed
                      ? 'off'
                      : `${fmtMarkerTime(d.start_ms)} to ${fmtMarkerTime(d.end_ms)}${d.detector === 'manual' ? ' · manual' : ''}`}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <MarkerEditButton label="Start = now" disabled={busy} onClick={() => setNow(kind, 'start_ms')} />
                <MarkerEditButton label="End = now" disabled={busy} onClick={() => setNow(kind, 'end_ms')} />
                <MarkerEditButton
                  label="Save"
                  emphasis
                  disabled={busy || !d || invalid}
                  onClick={() => { if (d) void write(kind, d.start_ms, d.end_ms) }}
                />
                <MarkerEditButton label="Off" disabled={busy || suppressed} onClick={() => void write(kind, 0, 0)} />
                <MarkerEditButton label="Auto" disabled={busy || !d} onClick={() => void redetect(kind)} />
              </div>
              {invalid && <p className="text-warn text-[12px] mt-1.5">End must be at or after start.</p>}
            </div>
          )
        })}
        {err && <p role="status" className="text-danger-ink text-[13px] mt-2">{err}</p>}
        <p className="text-ink-2 text-[12px] mt-2 leading-snug">
          Saved values stick: auto-detection never overwrites them.
          Off hides the marker; Auto queues detection again.
        </p>
      </div>
    </PlayerSheet>
  )
}

function MarkerEditButton({ label, onClick, disabled, emphasis }: {
  label: string
  onClick: () => void
  disabled?: boolean
  emphasis?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-9 px-3 rounded-control text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        emphasis
          ? 'bg-action text-action-on hover:brightness-95'
          : 'bg-action-soft text-ink hover:bg-white/[0.16]'
      }`}
    >
      {label}
    </button>
  )
}
