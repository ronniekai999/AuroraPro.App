// Aurora V2 — a single episode row (watched / in-progress / unwatched).
//
// State is computed by the caller (lib/detail.episodeWatchState) and passed
// in as a view-model, so this component is pure presentation.

import { cn } from '../../lib/utils'
import { PlayIcon, CheckIcon, InfoIcon } from './icons'

export type EpWatchState = 'watched' | 'in-progress' | 'unwatched'

export interface EpisodeRowVM {
  id: number
  number: number
  title: string
  overview?: string
  still: string
  hasFile: boolean
  state: EpWatchState
  progressPct?: number // 0..100, in-progress only
  leftLabel?: string // "18:23 left of 50m"
  watchedLabel?: string // "Watched · 57m"
  plainLabel?: string // "53m"
}

interface EpisodeRowProps {
  ep: EpisodeRowVM
  onPlay: (id: number) => void
  onUnavailable: (id: number) => void
}

export function EpisodeRow({ ep, onPlay, onUnavailable }: EpisodeRowProps) {
  const inProgress = ep.state === 'in-progress'
  const watched = ep.state === 'watched'
  return (
    <button
      type="button"
      onClick={() => (ep.hasFile ? onPlay(ep.id) : onUnavailable(ep.id))}
      title={ep.hasFile ? 'Play episode' : 'No file available yet'}
      className={cn(
        'group flex gap-4 p-[0.7rem] rounded-2xl border bg-white/[0.02] border-white/[0.05] transition-all cursor-pointer text-left w-full hover:bg-white/[0.05] hover:border-purple-500/30',
        inProgress &&
          'border-purple-400/45 bg-purple-500/[0.06] shadow-[0_0_0_1px_rgba(168,85,247,0.18),0_0_30px_rgba(168,85,247,0.08)]',
        !ep.hasFile && 'opacity-70',
      )}
    >
      <div className="relative w-[140px] sm:w-[176px] aspect-video rounded-xl overflow-hidden flex-shrink-0 bg-white/5">
        <img
          src={ep.still}
          alt=""
          loading="lazy"
          className={cn('w-full h-full object-cover', watched && 'opacity-65')}
        />
        <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-black/60 backdrop-blur-sm">
          E{ep.number}
        </div>
        {watched && (
          <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-purple-600/90 flex items-center justify-center">
            <CheckIcon size={11} className="text-white" />
          </div>
        )}
        {/* hover play / info overlay (skipped for watched to keep the check visible) */}
        {!watched && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity">
            <div
              className={cn(
                'w-10 h-10 rounded-full flex items-center justify-center',
                ep.hasFile ? 'bg-purple-600/90' : 'bg-white/20',
              )}
            >
              {ep.hasFile ? <PlayIcon size={16} className="ml-0.5" /> : <InfoIcon size={16} />}
            </div>
          </div>
        )}
        {!watched && !ep.hasFile && (
          <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 text-[9px] uppercase tracking-wider rounded bg-black/60 text-white/70">
            No file
          </div>
        )}
        {inProgress && (
          <div
            role="progressbar"
            aria-label="Watch progress"
            aria-valuenow={Math.round(ep.progressPct ?? 0)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="absolute inset-x-0 bottom-0 h-1.5 bg-black/40"
          >
            <div className="h-full bg-purple-500" style={{ width: `${ep.progressPct ?? 0}%` }} />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0 py-0.5">
        <div className="flex items-center gap-2 mb-1">
          <h4 className={cn('text-[14.5px] font-semibold truncate', watched ? 'text-white/85' : 'text-white')}>
            {ep.title}
          </h4>
          {inProgress && (
            <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-purple-500/25 text-purple-200 border border-purple-400/30">
              Continue
            </span>
          )}
        </div>
        {ep.overview && (
          <p className={cn('text-[12.5px] leading-snug line-clamp-2', inProgress ? 'text-white/55' : 'text-white/45')}>
            {ep.overview}
          </p>
        )}
        <div
          className={cn(
            'text-[11.5px] mt-1.5 font-medium',
            inProgress ? 'text-purple-300' : 'text-white/45',
          )}
        >
          {ep.leftLabel ?? ep.watchedLabel ?? ep.plainLabel}
        </div>
      </div>
    </button>
  )
}
