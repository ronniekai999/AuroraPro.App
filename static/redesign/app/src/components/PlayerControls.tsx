// Phase 7 — Custom video player controls overlay.
//
// Replaces the browser-native `<video controls>` UI for two reasons:
//   1. Native controls hide/reveal on browser-specific heuristics
//      (cursor over letterbox bars doesn't trigger, fullscreen-API
//      edge cases hide them entirely, Chrome+Mac specifically has
//      had reports of them not appearing at all). The custom overlay
//      is rendered by React unconditionally so visibility is fully
//      under app control.
//   2. Native controls' time display uses `vid.duration`, which is
//      the HLS-playlist duration during transcode (it GROWS as
//      segments are produced). For sync-with-friends parity the
//      user needs the REAL source-file duration. We pass it in as a
//      prop and the time display uses THAT.
//
// State strategy: this component is fully controlled by the parent
// (VideoPlayer). All state lives there; we just render and emit
// callbacks. That keeps hls.js orchestration + the various refs in
// one place and makes this component trivially testable.
//
// Visibility behavior:
//   - Always visible when paused, or for the first second after
//     mount, or on touch devices.
//   - When playing: visible after any `mousemove` / `keydown` inside
//     the player overlay; auto-fades after 3s of inactivity.
//   - Parent owns the `visible` prop so it can override (e.g. force
//     visible during seek-bar drag).

import { useRef, useState, useEffect } from 'react'

// Inline SVG icons. Aurora's main Icon component lives in App.tsx
// (inline-defined for the V2 prototype's single-file design) and
// isn't importable from a sub-component without a wider refactor.
// The 7 icons the player needs are duplicated here — small enough
// to be self-contained without bloating the bundle measurably.
function PlayerIcon({ name, size = 18 }: { name: 'play' | 'pause' | 'skipBack' | 'skipForward' | 'volume' | 'volumeX' | 'maximize'; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    play: <polygon points="5 3 19 12 5 21 5 3" />,
    pause: <><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></>,
    skipBack: <><polygon points="19 20 9 12 19 4 19 20" /><line x1="5" y1="19" x2="5" y2="5" /></>,
    skipForward: <><polygon points="5 4 15 12 5 20 5 4" /><line x1="19" y1="5" x2="19" y2="19" /></>,
    volume: <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" /></>,
    volumeX: <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>,
    maximize: <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />,
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  )
}

interface PlayerControlsProps {
  // Player state (controlled by parent)
  playing: boolean
  // Current playback time in REAL-FILE seconds (i.e. hls.currentTime
  // plus the session's start_sec offset). NOT hls.js's local time.
  currentSec: number
  // REAL total duration in seconds (from streamInfo.duration_ms, NOT
  // vid.duration). When 0/undefined, we hide the time display rather
  // than show a misleading "12:34 / 0:00".
  durationSec: number
  // Buffered range high-water mark in REAL-FILE seconds. Visualized
  // as a translucent fill on the scrub bar so the user can see the
  // transcoder's progress.
  bufferedSec: number
  volume: number          // 0..1
  muted: boolean
  fullscreen: boolean
  // Whether the bar should be visible right now. Parent computes
  // this from "paused OR recent mousemove" logic.
  visible: boolean

  // Callbacks
  onPlayPause: () => void
  onSeek: (sec: number) => void
  onSeekRelative: (deltaSec: number) => void
  onVolumeChange: (v: number) => void
  onMuteToggle: () => void
  onFullscreenToggle: () => void
}

// Format seconds as either "M:SS" (< 1 hour) or "H:MM:SS" (>= 1h).
// Negative or NaN inputs render as "0:00" to avoid leaking weird
// states like "NaN:undefined" into the UI.
function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad2 = (n: number) => n.toString().padStart(2, '0')
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`
  return `${m}:${pad2(s)}`
}

export function PlayerControls(props: PlayerControlsProps) {
  const {
    playing, currentSec, durationSec, bufferedSec,
    volume, muted, fullscreen, visible,
    onPlayPause, onSeek, onSeekRelative,
    onVolumeChange, onMuteToggle, onFullscreenToggle,
  } = props

  // Local-only state for the scrub-bar drag interaction. While
  // dragging we render the marker at the drag position even though
  // we haven't committed the seek yet (committing on pointerdown
  // causes jittery hls.js seeks).
  const [dragging, setDragging] = useState(false)
  const [dragSec, setDragSec] = useState(0)
  const scrubRef = useRef<HTMLDivElement | null>(null)
  const [hoverSec, setHoverSec] = useState<number | null>(null)

  // Display position = drag position while dragging, else committed
  // current position. Same idiom YouTube/Netflix use.
  const displaySec = dragging ? dragSec : currentSec
  const hasDuration = durationSec > 0
  // Pct only meaningful when we have a duration; default to 0 so
  // the scrub bar renders an empty (but visible) track.
  const pct = hasDuration ? Math.min(100, Math.max(0, (displaySec / durationSec) * 100)) : 0
  const bufferedPct = hasDuration ? Math.min(100, Math.max(0, (bufferedSec / durationSec) * 100)) : 0

  // pointerSec computes the real-file second corresponding to a
  // pointer x position over the scrub bar. Clamped to [0, duration].
  const pointerSec = (clientX: number): number => {
    if (!scrubRef.current || !hasDuration) return 0
    const rect = scrubRef.current.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return ratio * durationSec
  }

  // Pointer interactions on the scrub bar. We use Pointer Events
  // (covers mouse + touch + stylus) and capture the pointer so the
  // drag tracks even if the cursor leaves the bar's bounds.
  const onScrubPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hasDuration) return
    e.preventDefault()
    const sec = pointerSec(e.clientX)
    setDragging(true)
    setDragSec(sec)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onScrubPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (hasDuration) setHoverSec(pointerSec(e.clientX))
    if (!dragging) return
    setDragSec(pointerSec(e.clientX))
  }
  const onScrubPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const sec = pointerSec(e.clientX)
    setDragging(false)
    onSeek(sec)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* defensive */ }
  }
  const onScrubPointerLeave = () => setHoverSec(null)

  // Keep state synced if parent props update while we're mid-drag
  // (e.g. session reload bumps duration). Don't override dragSec
  // from props — that'd snap the marker out from under the user.
  useEffect(() => {
    if (!dragging && hasDuration && dragSec > durationSec) {
      setDragSec(durationSec)
    }
  }, [dragging, hasDuration, durationSec, dragSec])

  return (
    <div
      // High z-index so we sit above the video AND above any
      // letterbox bars. pointer-events-none on the wrapper lets
      // mouse hit the video for click-to-pause; the inner row
      // re-enables pointer-events for interactive elements.
      // Audit M5 fix — `inert` actually prevents tab-focus from
      // landing on invisible buttons. `aria-hidden` alone is just
      // an a11y hint and doesn't block focus. React 19 supports
      // `inert` as a JSX prop; we pass empty string when invisible
      // (HTML attribute pattern) and undefined when visible.
      className={`absolute inset-x-0 bottom-0 z-50 pointer-events-none transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      aria-hidden={!visible}
      // 2026-05-20 — React 19 supports `inert` as a proper boolean
      // prop. The previous code used `{inert: '' | undefined}` as a
      // React-18-era hack; React 19's native form is cleaner and
      // (more importantly) doesn't risk the empty-string being
      // re-interpreted by React's prop handling in a way that
      // accidentally blocks parent event bubbling.
      //
      // `!visible || undefined` evaluates to `true` (apply inert)
      // when invisible, `undefined` (no attribute) when visible —
      // React 19 treats `inert={true}` as the attribute being set.
      inert={!visible || undefined}
    >
      {/* Gradient backdrop to lift legibility off bright frames. */}
      <div className="bg-gradient-to-t from-black via-black/70 to-transparent pt-12 pb-4 px-6 pointer-events-auto">
        {/* Scrub bar row */}
        <div className="flex items-center gap-3.5 mb-4">
          {/* tabular-nums, not font-mono: the mockup's readout is the body face
              with figures locked to one advance width, which reads as part of
              the chrome rather than as code. Both stop the row twitching as
              digits change. */}
          <span className="text-white/85 text-[12.5px] font-medium tabular-nums min-w-[52px] text-right">
            {formatTime(displaySec)}
          </span>
          <div
            ref={scrubRef}
            onPointerDown={onScrubPointerDown}
            onPointerMove={onScrubPointerMove}
            onPointerUp={onScrubPointerUp}
            onPointerCancel={onScrubPointerUp}
            // `lostpointercapture` fires when the browser yanks
            // pointer capture (OS-level focus change, etc.) without
            // firing pointerup or pointercancel. Without this
            // handler, `dragging` state would stick true and the
            // scrub bar would show a phantom drag indicator until
            // the next pointerdown.
            onLostPointerCapture={() => setDragging(false)}
            onPointerLeave={onScrubPointerLeave}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.max(1, Math.floor(durationSec))}
            aria-valuenow={Math.floor(displaySec)}
            tabIndex={0}
            // h-3.5 on the hit target, 5px on the visible track: the mockup's
            // .scrub wraps a thin bar in a taller row so the pointer has 14px
            // to find rather than 5. Fitts's law — the bar this thin is
            // otherwise genuinely hard to grab.
            className={`relative flex-1 h-3.5 flex items-center ${hasDuration ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'} group`}
          >
            <div className="stage-scrub-track">
              {/* Buffered fill — the transcoder's progress. Sits below the
                  position fill but above the track. */}
              <div className="stage-scrub-buf" style={{ width: `${bufferedPct}%` }} />
              {/* Position fill — "you've watched up to here". */}
              <div className="stage-scrub-pos" style={{ width: `${pct}%` }} />
              {/* Handle. */}
              <div
                className="stage-scrub-knob transition-transform group-hover:scale-110"
                style={{ left: `${pct}%` }}
              />
              {/* Hover readout — what time a click would seek to. Suppressed
                  while dragging, since the knob already shows that position and
                  two competing indicators read as a bug.
                  clamp() keeps the label inside the track at the extremes: at
                  0% and 100% a translateX(-50%) label would hang half outside
                  the theater's overflow:hidden box and get sliced. */}
              {hoverSec !== null && !dragging && hasDuration && (
                <div
                  className="stage-scrub-ts"
                  style={{ left: `clamp(28px, ${(hoverSec / durationSec) * 100}%, calc(100% - 28px))` }}
                >
                  {formatTime(hoverSec)}
                </div>
              )}
            </div>
          </div>
          {/* The remaining/total readout is dimmer than the elapsed one — the
              mockup's `.tm.r`. 0.7, not its 0.55: at 12.5px over a bright frame
              0.55 measured 3.4:1. */}
          <span className="text-white/70 text-[12.5px] font-medium tabular-nums min-w-[52px]">
            {hasDuration ? formatTime(durationSec) : '—'}
          </span>
        </div>

        {/* Transport row. The mockup squares these off (12px radius on a 42px
            box, 14px on the 52px primary) rather than the round pills this had
            — it reads as equipment rather than as web buttons, which is the
            whole point of the theater framing.

            The skip buttons carry their interval as a subscript. They were
            asymmetric (-10 / +30) with the amount only in the tooltip, so on
            touch there was no way to know either number. Both are 10s now:
            asymmetric skip is a YouTube-ism that assumes you only ever skip
            forward past something, and this player is used to re-hear a line
            as often as to jump an intro. */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <ControlButton
              onClick={() => onSeekRelative(-10)}
              aria-label="Skip back 10 seconds"
              title="Skip back 10s (←)"
            >
              <PlayerIcon name="skipBack" size={19} />
              <span className="stage-tr-secs" aria-hidden="true">10</span>
            </ControlButton>
            <ControlButton
              onClick={onPlayPause}
              aria-label={playing ? 'Pause' : 'Play'}
              title={playing ? 'Pause (Space)' : 'Play (Space)'}
              size="large"
            >
              <PlayerIcon name={playing ? 'pause' : 'play'} size={23} />
            </ControlButton>
            <ControlButton
              onClick={() => onSeekRelative(10)}
              aria-label="Skip forward 10 seconds"
              title="Skip forward 10s (→)"
            >
              <PlayerIcon name="skipForward" size={19} />
              <span className="stage-tr-secs" aria-hidden="true">10</span>
            </ControlButton>

            {/* Volume cluster */}
            <div className="flex items-center gap-2.5 ml-1.5">
              <ControlButton
                onClick={onMuteToggle}
                aria-label={muted ? 'Unmute' : 'Mute'}
                title={muted ? 'Unmute (M)' : 'Mute (M)'}
              >
                <PlayerIcon name={muted || volume === 0 ? 'volumeX' : 'volume'} size={19} />
              </ControlButton>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                className="w-[78px] accent-purple-400"
                aria-label="Volume"
              />
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <ControlButton
              onClick={onFullscreenToggle}
              aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
            >
              <PlayerIcon name="maximize" size={19} />
            </ControlButton>
          </div>
        </div>
      </div>
    </div>
  )
}

// Reusable styled control button. `size='large'` for the central
// play/pause; default for skip + volume + fullscreen.
function ControlButton({
  children, onClick, size = 'normal', ...rest
}: {
  children: React.ReactNode
  onClick: () => void
  size?: 'normal' | 'large'
} & React.AriaAttributes & { title?: string }) {
  return (
    <button
      onClick={onClick}
      // `grid` at the call site, not in the primitive — the CASCADE HAZARD rule.
      className={`stage-tr-btn grid ${size === 'large' ? 'stage-tr-btn-primary' : ''}`}
      {...rest}
    >
      {children}
    </button>
  )
}
