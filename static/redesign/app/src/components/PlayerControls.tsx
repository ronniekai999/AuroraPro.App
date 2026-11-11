// The player's bottom control band: the timeline and the transport row.
//
// Custom controls rather than `<video controls>` for two reasons that still
// hold. Native controls hide and reveal on browser heuristics the app cannot
// steer (a cursor over the letterbox bars does not count as "over the video").
// And their clock is `vid.duration`, which for a transcode is the length of
// the playlist so far and GROWS as segments are produced; people syncing with
// friends need the real source duration, which the parent passes in.
//
// Fully controlled: every piece of state lives in VideoPlayer, next to the
// stream it describes, and this component only renders and emits callbacks.
// The scrub drag is the one exception (local until released, because
// committing on every pointermove makes hls.js seek on every pixel).

import { useRef, useState, useEffect, type ReactNode } from 'react'
import {
  Captions, Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw, RotateCw,
  SkipForward, Volume2, VolumeX,
} from 'lucide-react'
import { speedLabel, speedLockMessage, type SpeedLock, type TimelineRange } from '@/lib/playerChrome'

interface PlayerControlsProps {
  playing: boolean
  // Current playback time in REAL-FILE seconds (the element's time plus the
  // session's start offset), never hls.js's local time.
  currentSec: number
  // REAL total duration in seconds (stream info's duration_ms, not
  // vid.duration). 0 hides the readout rather than showing "12:34 / 0:00".
  durationSec: number
  // Buffered high-water mark in REAL-FILE seconds: how far the transcoder
  // has got.
  bufferedSec: number
  volume: number          // 0..1
  muted: boolean
  fullscreen: boolean
  // Whether the band is visible right now. The parent decides ("paused, or
  // the pointer moved recently") so it can keep the top bar in step.
  visible: boolean
  // Intro, recap and credits ranges to draw on the timeline.
  ranges?: TimelineRange[]

  onPlayPause: () => void
  onSeek: (sec: number) => void
  onSeekRelative: (deltaSec: number) => void
  onVolumeChange: (v: number) => void
  onMuteToggle: () => void
  onFullscreenToggle: () => void

  // Absent → the control is not offered at all.
  nextEpisode?: { label: string; onClick: () => void } | null
  tracks?: { open: boolean; onToggle: () => void } | null
  speed?: { rate: number; lock: SpeedLock; open: boolean; onToggle: () => void } | null
  pip?: { active: boolean; onToggle: () => void } | null
  // Extra content after the time readout (the party's sync line).
  status?: ReactNode
}

// "M:SS" under an hour, "H:MM:SS" from an hour. Negative or NaN reads as 0:00
// so a half-booted stream can never print "NaN:undefined".
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
    volume, muted, fullscreen, visible, ranges = [],
    onPlayPause, onSeek, onSeekRelative,
    onVolumeChange, onMuteToggle, onFullscreenToggle,
    nextEpisode, tracks, speed, pip, status,
  } = props

  const [dragging, setDragging] = useState(false)
  const [dragSec, setDragSec] = useState(0)
  const scrubRef = useRef<HTMLDivElement | null>(null)
  const [hoverSec, setHoverSec] = useState<number | null>(null)

  // While dragging, show the drag position; the seek is committed on release.
  const displaySec = dragging ? dragSec : currentSec
  const hasDuration = durationSec > 0
  const pct = hasDuration ? Math.min(100, Math.max(0, (displaySec / durationSec) * 100)) : 0
  const bufferedPct = hasDuration ? Math.min(100, Math.max(0, (bufferedSec / durationSec) * 100)) : 0

  const pointerSec = (clientX: number): number => {
    if (!scrubRef.current || !hasDuration) return 0
    const rect = scrubRef.current.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return ratio * durationSec
  }

  // Pointer Events cover mouse, touch and stylus; capturing the pointer keeps
  // the drag alive when the cursor leaves the bar.
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

  // A session reload can shorten the duration mid-drag; keep the marker on
  // the bar without snapping it to the committed position.
  useEffect(() => {
    if (!dragging && hasDuration && dragSec > durationSec) {
      setDragSec(durationSec)
    }
  }, [dragging, hasDuration, durationSec, dragSec])

  const speedLocked = speed ? speedLockMessage(speed.lock) : null
  const labelled = ranges.filter(r => r.showLabel)

  return (
    <div
      // pointer-events-none on the wrapper lets a click reach the video for
      // click-to-pause; the band re-enables it for its own controls.
      className={`absolute inset-x-0 bottom-0 z-50 pointer-events-none transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      aria-hidden={!visible}
      // Marks an auto-hiding region. VideoPlayer's hide timer refuses to fire
      // while KEYBOARD focus is inside one: going `inert` under a focused
      // element makes the browser drop focus to <body>, so a keyboard user
      // parked on the timeline would lose their place (WCAG 2.4.3). The guard
      // is modality-gated (lib/chromeFocus): mouse click-focus does not pin
      // the chrome.
      data-player-chrome=""
      // `inert`, not only aria-hidden: hidden buttons must leave the tab order
      // too, or Tab paints a focus ring on nothing.
      inert={!visible || undefined}
    >
      <div className="stage-controls-scrim player-band pointer-events-auto">
        {/* Timeline. */}
        <div
          ref={scrubRef}
          onPointerDown={onScrubPointerDown}
          onPointerMove={onScrubPointerMove}
          onPointerUp={onScrubPointerUp}
          onPointerCancel={onScrubPointerUp}
          // The browser can take pointer capture away (an OS-level focus
          // change) without a pointerup; without this the bar would show a
          // phantom drag until the next press.
          onLostPointerCapture={() => setDragging(false)}
          onPointerLeave={onScrubPointerLeave}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.max(1, Math.floor(durationSec))}
          aria-valuenow={Math.floor(displaySec)}
          // A screen reader would otherwise announce "2704" for 45:04 (WCAG
          // 4.1.2; APG Slider asks for aria-valuetext whenever the number is
          // not what a person would say).
          aria-valuetext={hasDuration ? `${formatTime(displaySec)} of ${formatTime(durationSec)}` : 'Duration unknown'}
          tabIndex={0}
          // ArrowUp/ArrowDown are deliberately NOT handled: they bubble to the
          // player's window-level handler, which maps them to volume.
          // Everything handled here is stopped so that handler cannot apply
          // the same seek twice.
          onKeyDown={e => {
            if (!hasDuration) return
            const abs = (sec: number) => {
              e.preventDefault()
              e.stopPropagation()
              onSeek(Math.min(durationSec, Math.max(0, sec)))
            }
            const relative = (deltaSec: number) => {
              e.preventDefault()
              e.stopPropagation()
              // The active transport converts from its own trusted clock;
              // the displayed second may be only a raw receiver fallback.
              onSeekRelative(Math.min(durationSec, Math.max(0, displaySec + deltaSec)) - displaySec)
            }
            switch (e.key) {
              case 'ArrowLeft': relative(-10); break
              case 'ArrowRight': relative(10); break
              // APG's "large step": a minute keeps the arrows' ratio to a
              // 45 to 90 minute runtime.
              case 'PageDown': relative(-60); break
              case 'PageUp': relative(60); break
              case 'Home': abs(0); break
              case 'End': abs(durationSec); break
            }
          }}
          // `.stage-scrub` is the hook the knob's hover and focus growth hangs
          // off in index.css. It must stay CSS: a Tailwind scale utility emits
          // the whole transform chain and would replace the knob's centring.
          className={`stage-scrub relative h-5 flex items-center ${hasDuration ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
        >
          <div className="stage-scrub-track">
            <div className="stage-scrub-buf" style={{ width: `${bufferedPct}%` }} />
            {/* Intro, recap and credits: a taller, brighter stretch of the
                track. Drawn under the played fill so progress stays readable
                across them, and aria-hidden because the Skip button and its
                announcement are how these reach a screen reader. */}
            {ranges.map(r => (
              <span
                key={`${r.kind}:${r.leftPct}`}
                className="stage-scrub-range"
                data-range={r.kind}
                title={r.label}
                aria-hidden="true"
                style={{ left: `${r.leftPct}%`, width: `${r.widthPct}%` }}
              />
            ))}
            <div className="stage-scrub-pos" style={{ width: `${pct}%` }} />
            <div className="stage-scrub-knob" style={{ left: `${pct}%` }} />
            {/* What time a click would seek to. Hidden while dragging: the
                knob already says it. clamp() keeps the label on the bar at
                both ends. */}
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
        {/* Range names, under the timeline. Wide screens only: on a phone the
            ranges are a few pixels apart and the names would collide. */}
        {labelled.length > 0 && (
          <div className="relative h-4 mt-1 hidden md:block text-[12px] leading-4 text-ink-2" aria-hidden="true">
            {labelled.map(r => (
              <span
                key={`${r.kind}:${r.leftPct}`}
                className="absolute whitespace-nowrap"
                style={{ left: `min(${r.leftPct}%, calc(100% - 56px))` }}
              >
                {r.label}
              </span>
            ))}
          </div>
        )}

        {/* Transport row. Wraps on a narrow screen instead of clipping. */}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <ControlButton
            onClick={onPlayPause}
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
            size="large"
          >
            {playing ? <Pause size={28} fill="currentColor" strokeWidth={0} /> : <Play size={28} fill="currentColor" strokeWidth={0} />}
          </ControlButton>
          <ControlButton
            onClick={() => onSeekRelative(-10)}
            aria-label="Skip back 10 seconds"
            title="Back 10 seconds (←)"
          >
            <RotateCcw size={24} strokeWidth={1.75} />
            <span className="stage-tr-secs" aria-hidden="true">10</span>
          </ControlButton>
          <ControlButton
            onClick={() => onSeekRelative(10)}
            aria-label="Skip forward 10 seconds"
            title="Forward 10 seconds (→)"
          >
            <RotateCw size={24} strokeWidth={1.75} />
            <span className="stage-tr-secs" aria-hidden="true">10</span>
          </ControlButton>
          <ControlButton
            onClick={onMuteToggle}
            aria-label={muted ? 'Unmute' : 'Mute'}
            title={muted ? 'Unmute (M)' : 'Mute (M)'}
          >
            {muted || volume === 0 ? <VolumeX size={24} strokeWidth={1.75} /> : <Volume2 size={24} strokeWidth={1.75} />}
          </ControlButton>
          {/* A phone sets volume with its hardware keys; the slider would only
              take a row of its own there. */}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
            className="stage-volume hidden sm:block w-[84px]"
            aria-label="Volume"
          />
          <span className="ml-2 text-[15px] text-ink tabular-nums whitespace-nowrap">
            {formatTime(displaySec)}
            <span className="text-ink-2"> / {hasDuration ? formatTime(durationSec) : '—'}</span>
          </span>
          {status}

          {/* `ml-auto`, not a spacer: when the row wraps on a phone this
              group still sits against the right edge. */}
          <div className="ml-auto flex items-center gap-1">
          {nextEpisode && (
            <button
              type="button"
              onClick={nextEpisode.onClick}
              className="stage-tr-btn stage-tr-btn-text inline-flex"
              aria-label={nextEpisode.label}
              title={nextEpisode.label}
            >
              <SkipForward size={22} fill="currentColor" strokeWidth={0} />
              <span className="hidden lg:inline">Next episode</span>
            </button>
          )}
          {tracks && (
            <button
              type="button"
              onClick={tracks.onToggle}
              aria-label="Audio and subtitles"
              aria-haspopup="dialog"
              aria-expanded={tracks.open}
              title="Audio and subtitles"
              className="stage-tr-btn stage-tr-btn-text inline-flex"
              data-open={tracks.open || undefined}
            >
              <Captions size={24} strokeWidth={1.75} className="lg:hidden" />
              <span className="hidden lg:inline">Audio and subtitles</span>
            </button>
          )}
          {speed && (
            <button
              type="button"
              onClick={speed.onToggle}
              // A locked speed stays on screen, disabled, with the reason as
              // its name: a control that vanishes in a party reads as a bug,
              // one that says why does not.
              disabled={speed.lock !== null}
              aria-label={speedLocked ?? `Playback speed, ${speedLabel(speed.rate)}`}
              aria-haspopup={speed.lock === null ? 'dialog' : undefined}
              aria-expanded={speed.lock === null ? speed.open : undefined}
              title={speedLocked ?? 'Playback speed'}
              className="stage-tr-btn stage-tr-btn-text inline-flex tabular-nums"
              data-open={speed.open || undefined}
            >
              {speedLabel(speed.rate)}
            </button>
          )}
          {pip && (
            <ControlButton
              onClick={pip.onToggle}
              aria-label={pip.active ? 'Exit picture in picture' : 'Picture in picture'}
              aria-pressed={pip.active}
              title={pip.active ? 'Exit picture in picture' : 'Picture in picture'}
            >
              <PictureInPicture2 size={24} strokeWidth={1.75} />
            </ControlButton>
          )}
          <ControlButton
            onClick={onFullscreenToggle}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={fullscreen ? 'Exit full screen (F)' : 'Full screen (F)'}
          >
            {fullscreen ? <Minimize size={24} strokeWidth={1.75} /> : <Maximize size={24} strokeWidth={1.75} />}
          </ControlButton>
          </div>
        </div>
      </div>
    </div>
  )
}

// Icon button for the transport row. `size="large"` is play/pause.
function ControlButton({
  children, onClick, size = 'normal', ...rest
}: {
  children: ReactNode
  onClick: () => void
  size?: 'normal' | 'large'
} & React.AriaAttributes & { title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      // `grid` at the call site, not in the rule: the primitive sets no
      // `display`, so a `hidden` on it elsewhere can never be overridden.
      className={`stage-tr-btn grid ${size === 'large' ? 'stage-tr-btn-primary' : ''}`}
      {...rest}
    >
      {children}
    </button>
  )
}
