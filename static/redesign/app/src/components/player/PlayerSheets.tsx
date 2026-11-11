// The player's menus: Audio and subtitles, playback speed, and the overflow
// menu. Each is a popover anchored to the corner its button lives in on a wide
// screen and a sheet rising from the bottom edge on a phone or any coarse
// pointer (the `.player-sheet` rules in index.css decide which).
//
// Presentational only. Picking a track calls back into VideoPlayer, which
// owns what a pick does: an audio pick rebuilds the session, a subtitle pick
// goes through applySubtitle and its holds.

import { useEffect, useRef, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import type { AudioTrack, SubtitleTrack } from '@/lib/streaming'
import { SPEED_OPTIONS, audioNote, speedLabel, trackLabel } from '@/lib/playerChrome'

/** The container every player menu shares. Focus moves into it when it opens
 *  and Escape closes it without reaching the app's own Escape handler, which
 *  would close the whole player. */
export function PlayerSheet({ label, anchor = 'bottom', onClose, children }: {
  label: string
  anchor?: 'bottom' | 'top'
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // The sheet itself, not its first option: focusing an option would scroll
    // a long subtitle list and announce one item instead of the menu.
    ref.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-anchor={anchor}
      className="player-sheet"
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
      // A click inside the sheet must not reach the video underneath (which
      // would toggle playback) or the surface's own handlers.
      onClick={e => e.stopPropagation()}
    >
      {/* The grab line a bottom sheet carries; hidden on the popover form. */}
      <span className="player-sheet-grip" aria-hidden="true" />
      {children}
    </div>
  )
}

function SheetHeading({ children }: { children: ReactNode }) {
  return <h3 className="px-3 pt-3 pb-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2">{children}</h3>
}

/** One choice in a group where exactly one is on. */
function SheetOption({ checked, label, note, onSelect }: {
  checked: boolean
  label: string
  note?: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onSelect}
      className="player-sheet-item"
    >
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {note && <span className="text-[13px] text-ink-2 flex-none">{note}</span>}
      <Check size={18} strokeWidth={2.5} aria-hidden="true" className={`flex-none ${checked ? 'opacity-100' : 'opacity-0'}`} />
    </button>
  )
}

export function TracksSheet({
  audio, audioIndex, onPickAudio,
  subtitles, subtitleIndex, onPickSubtitle,
  error, details, onClose,
}: {
  audio: AudioTrack[]
  // The `index` of the track that is playing (lib/playerChrome
  // activeAudioIndex); undefined when it cannot be told.
  audioIndex: number | undefined
  onPickAudio: (index: number) => void
  subtitles: SubtitleTrack[]
  subtitleIndex: number
  onPickSubtitle: (index: number) => void
  error: string | null
  details: string | null
  onClose: () => void
}) {
  const activeAudio = audioIndex
  return (
    <PlayerSheet label="Audio and subtitles" onClose={onClose}>
      <div role="menu" aria-label="Audio and subtitles">
      {audio.length > 1 && (
        <div role="group" aria-label="Audio">
          <SheetHeading>Audio</SheetHeading>
          {audio.map(a => (
            <SheetOption
              key={a.index}
              checked={activeAudio === a.index}
              label={trackLabel(a, 'Track')}
              note={audioNote(a.codec, a.channels)}
              onSelect={() => onPickAudio(a.index)}
            />
          ))}
        </div>
      )}
      {subtitles.length > 0 && (
        <div role="group" aria-label="Subtitles">
          <SheetHeading>Subtitles</SheetHeading>
          <SheetOption checked={subtitleIndex === -1} label="Off" onSelect={() => onPickSubtitle(-1)} />
          {subtitles.map(s => (
            <SheetOption
              key={s.index}
              checked={subtitleIndex === s.index}
              label={trackLabel(s, 'Subtitle')}
              note={s.forced ? 'Forced only' : undefined}
              onSelect={() => onPickSubtitle(s.index)}
            />
          ))}
        </div>
      )}
      </div>
      {/* A subtitle track that failed to load. role="status" so it is read
          out; it clears by itself a few seconds later. */}
      {error && (
        <p role="status" className="mx-3 mt-2 text-[13px] text-danger-ink">{error}</p>
      )}
      {details && (
        <p className="mx-3 mt-2 mb-2 pt-3 border-t border-line-strong text-[12px] text-ink-2">
          Playback details: {details}
        </p>
      )}
    </PlayerSheet>
  )
}

export function SpeedMenu({ rate, onPick, onClose }: {
  rate: number
  onPick: (rate: number) => void
  onClose: () => void
}) {
  return (
    <PlayerSheet label="Playback speed" onClose={onClose}>
      <SheetHeading>Speed</SheetHeading>
      <div role="menu" aria-label="Playback speed">
        {SPEED_OPTIONS.map(r => (
          <SheetOption
            key={r}
            checked={rate === r}
            label={r === 1 ? 'Normal' : speedLabel(r)}
            note={r === 1 ? '1x' : undefined}
            onSelect={() => onPick(r)}
          />
        ))}
      </div>
    </PlayerSheet>
  )
}

/** A plain action row in the overflow menu. */
export function SheetAction({ icon, label, note, onSelect }: {
  icon?: ReactNode
  label: string
  note?: string
  onSelect: () => void
}) {
  return (
    <button type="button" role="menuitem" onClick={onSelect} className="player-sheet-item">
      {icon && <span className="flex-none text-ink-2" aria-hidden="true">{icon}</span>}
      <span className="flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        {note && <span className="block text-[12px] text-ink-2 truncate">{note}</span>}
      </span>
    </button>
  )
}

export function MoreMenu({ details, children, onClose }: {
  details: string | null
  children?: ReactNode
  onClose: () => void
}) {
  return (
    <PlayerSheet label="More" anchor="top" onClose={onClose}>
      <SheetHeading>Playback details</SheetHeading>
      <p className="px-3 pb-2 text-[14px] text-ink">
        {details ?? 'Working out how to play this…'}
      </p>
      {children && <div role="menu" aria-label="More">{children}</div>}
    </PlayerSheet>
  )
}
