// syncDebug.ts
//
// Opt-in instrumentation for the watch-party guest drift loop. The drift
// loop in VideoPlayer.tsx runs 4×/sec and is intentionally silent in
// production (logging every tick would crowd the diagnostic ring buffer
// and the console). This module lets us turn that telemetry ON for a
// single session when we're chasing a sync bug ("video skips on the
// guest's screen"), so the next watch party records exactly WHY each
// correction fired.
//
// How it surfaces:
//   1. console.debug('[party-sync] …') — captured by diagnosticBuffer.ts
//      (it patches console.debug), so it ships inside a Report-a-Bug
//      submission with zero extra work for the user. Anomalies
//      (hard-seek / stale-tick / buffering) are ALWAYS logged; steady
//      state is throttled to ~1/sec so a long session doesn't evict the
//      anomalies from the 500-entry console buffer.
//   2. A full per-tick ring buffer (getSyncSamples / window.auroraSyncDump)
//      for live inspection in DevTools — unthrottled, so you can read the
//      complete drift trajectory.
//   3. A tiny on-screen HUD (top-right) so the user can confirm it's live
//      and watch drift in real time during the party.
//
// Enabling (any one):
//   - DevTools console:  auroraSyncDebug(true)   // persists across reload
//   - Before a reload:   localStorage.aurora_sync_debug = '1'
//   - One-off:           window.__auroraSyncDebug = true
//
// Disabling:  auroraSyncDebug(false)
//
// EVERYTHING here is gated on the flag; when off, the only cost paid by
// the drift loop is a single boolean property read per tick.

// The decision the drift loop reached this tick. Drives console-log
// throttling (anomalies are never throttled) and HUD colour.
export type SyncDecision =
  | 'ignore'      // |drift| < dead zone — no correction
  | 'rate-up'     // behind — playbackRate bumped up to catch up
  | 'rate-down'   // ahead — playbackRate eased down
  | 'hard-seek'   // |drift| >= hard threshold — teleported (the visible "skip")
  | 'rebuild'     // target outside this session's window — new session anchored at target
  | 'stale'       // tick older than the staleness guard — free-running
  | 'buffering'   // local video paused/buffering — correction skipped
  | 'no-tick'     // no server tick yet

// One drift-loop observation. All fields optional past `decision` because
// the early branches (buffering / stale / no-tick) run before drift is
// computed.
export interface SyncSample {
  ms: number            // Date.now() at sample time
  decision: SyncDecision
  driftMs?: number      // localSec - targetSec, in ms (negative = behind)
  localSec?: number     // guest's vid.currentTime
  targetSec?: number    // projected host position, hls-relative seconds
  bufferedAheadSec?: number // seconds of media buffered ahead of the playhead
  readyState?: number   // HTMLMediaElement.readyState (4 = HAVE_ENOUGH_DATA)
  playbackRate?: number
  tickAgeMs?: number    // age of the tick by LOCAL receipt time
  clockOffsetMs?: number
  rttMs?: number
  absMs?: number        // tick.abs_ms (server position when emitted)
  projectedAbsMs?: number
  rev?: number
}

declare global {
  interface Window {
    __auroraSyncDebug?: boolean
    auroraSyncDebug?: (on?: boolean) => boolean
    auroraSyncDump?: () => SyncSample[]
  }
}

const LS_KEY = 'aurora_sync_debug'
const RING_CAP = 600          // ~150s at 4/sec
const STEADY_LOG_INTERVAL_MS = 1000 // throttle non-anomaly console output

// Decisions worth logging to the console on EVERY occurrence (the rest
// are throttled). These are the events that explain a skip.
const ANOMALY: ReadonlySet<SyncDecision> = new Set<SyncDecision>([
  'hard-seek', 'rebuild', 'stale', 'buffering',
])

const ring: SyncSample[] = []
let lastSteadyLogMs = 0
let installed = false

// isSyncDebugEnabled is the per-tick gate. Deliberately cheap — a single
// property read, no localStorage access (the LS value is hydrated into the
// window flag once at install time and on every auroraSyncDebug() toggle).
export function isSyncDebugEnabled(): boolean {
  return typeof window !== 'undefined' && window.__auroraSyncDebug === true
}

// install hydrates the window flag from localStorage and wires the
// console helpers. Idempotent; safe to call from module import and from
// React mount. Never throws.
export function installSyncDebug(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  try {
    if (window.__auroraSyncDebug === undefined) {
      window.__auroraSyncDebug = localStorage.getItem(LS_KEY) === '1'
    }
  } catch { /* localStorage may throw in private mode */ }
  window.auroraSyncDebug = (on?: boolean): boolean => {
    const next = on === undefined ? !isSyncDebugEnabled() : !!on
    window.__auroraSyncDebug = next
    try {
      if (next) localStorage.setItem(LS_KEY, '1')
      else localStorage.removeItem(LS_KEY)
    } catch { /* ignore */ }
    if (!next) removeHud()
    console.info(`[party-sync] debug ${next ? 'ENABLED' : 'disabled'}`)
    return next
  }
  window.auroraSyncDump = (): SyncSample[] => {
    const out = ring.slice()
    try {
      // A compact, scannable view; the returned array has everything.
      console.table(out.map(s => ({
        t: new Date(s.ms).toISOString().slice(11, 23),
        decision: s.decision,
        driftMs: s.driftMs !== undefined ? Math.round(s.driftMs) : undefined,
        bufAhead: s.bufferedAheadSec !== undefined ? +s.bufferedAheadSec.toFixed(1) : undefined,
        rs: s.readyState,
        rate: s.playbackRate,
        rtt: s.rttMs !== undefined ? Math.round(s.rttMs) : undefined,
        off: s.clockOffsetMs !== undefined ? Math.round(s.clockOffsetMs) : undefined,
      })))
    } catch { /* console.table unsupported — array is still returned */ }
    return out
  }
}

// getSyncSamples returns a copy of the full per-tick ring buffer.
export function getSyncSamples(): SyncSample[] {
  return ring.slice()
}

// recordSyncSample is the single entry point called by the drift loop.
// Pushes to the ring buffer (always, when enabled), logs to the console
// (anomalies always, steady-state throttled), and refreshes the HUD.
// Callers MUST gate on isSyncDebugEnabled() before building the sample so
// the hot path pays nothing when debug is off.
export function recordSyncSample(s: SyncSample): void {
  ring.push(s)
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP)

  const anomaly = ANOMALY.has(s.decision)
  if (anomaly || s.ms - lastSteadyLogMs >= STEADY_LOG_INTERVAL_MS) {
    if (!anomaly) lastSteadyLogMs = s.ms
    console.debug(
      `[party-sync] ${s.decision}`,
      `drift=${fmt(s.driftMs)}ms`,
      `buf=${fmt(s.bufferedAheadSec, 1)}s`,
      `rs=${s.readyState ?? '-'}`,
      `rate=${s.playbackRate ?? '-'}`,
      `tickAge=${fmt(s.tickAgeMs)}ms`,
      `off=${fmt(s.clockOffsetMs)}ms`,
      `rtt=${fmt(s.rttMs)}ms`,
    )
  }
  try { updateHud(s) } catch { /* HUD is best-effort */ }
}

function fmt(n: number | undefined, digits = 0): string {
  if (n === undefined || Number.isNaN(n)) return '-'
  return digits > 0 ? n.toFixed(digits) : String(Math.round(n))
}

// ── On-screen HUD ────────────────────────────────────────────────────
// A self-contained DOM singleton (no React) so it can't perturb the
// player's render path. Created lazily on first sample, removed on
// disable. pointer-events:none so it never intercepts clicks.

let hudEl: HTMLDivElement | null = null

const DECISION_COLOR: Record<SyncDecision, string> = {
  'ignore': '#7ee787',
  'rate-up': '#79c0ff',
  'rate-down': '#79c0ff',
  'hard-seek': '#ff7b72',
  'rebuild': '#ff7b72',
  'stale': '#d29922',
  'buffering': '#d29922',
  'no-tick': '#8b949e',
}

function ensureHud(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null
  if (hudEl && hudEl.isConnected) return hudEl
  const el = document.createElement('div')
  el.id = 'aurora-sync-hud'
  el.setAttribute('data-screenshot-exclude', 'true') // keep it out of bug-report captures
  el.style.cssText = [
    'position:fixed', 'top:8px', 'right:8px', 'z-index:2147483646',
    'pointer-events:none', 'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
    'background:rgba(10,10,15,0.82)', 'color:#e6edf3', 'padding:6px 9px',
    'border:1px solid rgba(255,255,255,0.12)', 'border-radius:8px',
    'white-space:pre', 'max-width:280px', 'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
  ].join(';')
  document.body.appendChild(el)
  hudEl = el
  return el
}

function updateHud(s: SyncSample): void {
  const el = ensureHud()
  if (!el) return
  const color = DECISION_COLOR[s.decision] ?? '#e6edf3'
  el.innerHTML =
    `<b style="color:${color}">party-sync · ${s.decision}</b>\n` +
    `drift ${fmt(s.driftMs)}ms   buf ${fmt(s.bufferedAheadSec, 1)}s\n` +
    `rs ${s.readyState ?? '-'}   rate ${s.playbackRate ?? '-'}   tickAge ${fmt(s.tickAgeMs)}ms\n` +
    `offset ${fmt(s.clockOffsetMs)}ms   rtt ${fmt(s.rttMs)}ms`
}

function removeHud(): void {
  if (hudEl && hudEl.isConnected) hudEl.remove()
  hudEl = null
}
