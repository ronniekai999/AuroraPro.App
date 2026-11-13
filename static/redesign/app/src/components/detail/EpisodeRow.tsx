// One episode as a compact row: its number, a small still, the title with one
// line of synopsis, and what is left of it or how long it runs. The whole
// row is one button; version chips (an episode with a 1080p AND a 4K file)
// are separate buttons after it, so each stays its own focus stop.

import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'

export type EpWatchState = 'watched' | 'in-progress' | 'unwatched'

// One playable file ("version") of an episode: a 1080p and a 4K copy are
// two versions.
export interface EpisodeVersion {
  fileId: number
  label: string // "4K", "1080p", "720p", …
  is4k: boolean
}

export interface EpisodeRowVM {
  id: number
  number: number
  title: string
  overview?: string
  still: string
  hasFile: boolean
  state: EpWatchState
  progressPct?: number // 0..100, in-progress only
  leftLabel?: string // "18 min left"
  plainLabel?: string // "53 min"
  // Present only when the episode has 2+ distinct versions.
  versions?: EpisodeVersion[]
}

interface EpisodeRowProps {
  ep: EpisodeRowVM
  onPlay: (id: number, fileId?: number) => void
  onUnavailable: (id: number) => void
}

/** The still, with the white progress line of an episode in progress. */
export function EpisodeStill({ ep, className }: { ep: EpisodeRowVM; className?: string }) {
  return (
    <span className={cn('relative block flex-none overflow-hidden rounded-art bg-surface-raised-2', className)}>
      <img
        // key: a src swap remounts the node so an earlier hide-on-error
        // cannot stick.
        key={ep.still}
        src={ep.still}
        alt=""
        loading="lazy"
        decoding="async"
        className="w-full h-full object-cover"
        // A still that 404s hides itself and the box's fill shows instead of
        // the browser's broken-image glyph.
        onError={(e) => { e.currentTarget.style.visibility = 'hidden' }}
      />
      {ep.state === 'in-progress' && (
        <span
          role="progressbar"
          aria-label="Watch progress"
          aria-valuenow={Math.round(ep.progressPct ?? 0)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="absolute inset-x-0 bottom-0 h-[3px] bg-[var(--track)]"
        >
          <span className="block h-full bg-action" style={{ width: `${ep.progressPct ?? 0}%` }} />
        </span>
      )}
    </span>
  )
}

export function EpisodeRow({ ep, onPlay, onUnavailable }: EpisodeRowProps) {
  const watched = ep.state === 'watched'
  const hasVersions = !!ep.versions && ep.versions.length > 1
  const status = ep.hasFile ? (ep.leftLabel ?? ep.plainLabel ?? '') : 'Not available'
  return (
    <li className="stage-ep-row flex items-center border-t border-line">
      <button
        type="button"
        onClick={() => (ep.hasFile ? onPlay(ep.id) : onUnavailable(ep.id))}
        title={ep.hasFile ? 'Play episode' : 'No file available yet'}
        className={cn(
          'stage-ep-main flex-1 min-w-0 flex items-center gap-3 sm:gap-4 py-2 pr-3 text-left',
          !ep.hasFile && 'opacity-60',
        )}
      >
        <span className="hidden sm:block flex-none w-8 text-center text-[15px] text-ink-3 tabular-nums" aria-hidden="true">
          {ep.number}
        </span>
        <EpisodeStill ep={ep} className="w-[100px] h-[56px] sm:w-[128px] sm:h-[72px]" />
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="stage-ep-title text-[15px] font-semibold text-ink truncate">
            {/* The number is in the row's name exactly once, at every width:
                the visible ones (this on a phone, the column from sm) are
                for the eye only. */}
            <span className="sm:hidden" aria-hidden="true">{ep.number}. </span>
            <span className="sr-only">Episode {ep.number}: </span>
            {ep.title}
          </span>
          {ep.overview && (
            <span className="hidden sm:block text-[13px] text-ink-2 truncate">{ep.overview}</span>
          )}
          {/* On a phone the status takes the synopsis's line. */}
          {status && <span className="sm:hidden text-[13px] text-ink-2 tabular-nums">{watched ? `Watched · ${status}` : status}</span>}
        </span>
        {watched && (
          <span className="hidden sm:inline-flex flex-none text-ink-2" title="Watched">
            <Check size={18} strokeWidth={2.25} aria-hidden="true" />
            <span className="sr-only">Watched</span>
          </span>
        )}
        {status && (
          <span className="hidden sm:block flex-none w-24 text-right text-[13px] text-ink-2 tabular-nums">{status}</span>
        )}
      </button>
      {/* Each chip plays that specific file. */}
      {hasVersions && (
        <span className="flex-none flex items-center gap-2 pl-1 pr-1" role="group" aria-label={`Play episode ${ep.number} in`}>
          {ep.versions!.map(v => (
            <button
              key={v.fileId}
              type="button"
              onClick={() => onPlay(ep.id, v.fileId)}
              title={`Play in ${v.label}`}
              className="stage-hit44 h-9 min-w-9 px-2.5 rounded-chip border border-line-strong text-[12px] font-semibold text-ink hover:bg-action-soft transition-colors whitespace-nowrap"
            >
              {v.label}
            </button>
          ))}
        </span>
      )}
    </li>
  )
}
