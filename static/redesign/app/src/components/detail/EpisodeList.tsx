// Aurora V2 — Episodes section: season-picker chip row + episode rows.

import { cn } from '../../lib/utils'
import { EpisodeRow, type EpisodeRowVM } from './EpisodeRow'

export interface SeasonOpt {
  season_number: number
  episode_count?: number
}

interface EpisodeListProps {
  count: number
  seasons?: SeasonOpt[]
  selectedSeason?: number | null
  onSelectSeason?: (n: number) => void
  rows: EpisodeRowVM[]
  // fileId is optional — version chips pass an explicit file, the row
  // body omits it (default quality-preference pick).
  onPlay: (id: number, fileId?: number) => void
  onUnavailable: (id: number) => void
  emptyText?: string
  className?: string
}

export function EpisodeList({
  count,
  seasons,
  selectedSeason,
  onSelectSeason,
  rows,
  onPlay,
  onUnavailable,
  emptyText,
  className,
}: EpisodeListProps) {
  const showPicker = !!seasons && seasons.length > 1
  return (
    <section className={className}>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <h3 className="text-lg font-semibold font-display">
          {selectedSeason ? `Season ${selectedSeason}` : 'Episodes'}
          <span className="text-white/40 text-sm font-normal ml-2">· {count}</span>
        </h3>
        {showPicker && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white/45 text-xs uppercase tracking-wider mr-1">Season</span>
            {seasons!.map((s) => {
              const on = selectedSeason === s.season_number
              return (
                <button
                  key={s.season_number}
                  type="button"
                  onClick={() => onSelectSeason?.(s.season_number)}
                  title={s.episode_count ? `${s.episode_count} episodes` : undefined}
                  className={cn(
                    'inline-flex items-center px-3.5 py-[7px] rounded-full text-[13px] font-semibold transition-all border',
                    on
                      ? 'bg-purple-500/22 border-purple-400/45 text-purple-100'
                      : 'bg-white/[0.03] border-white/[0.07] text-white/60 hover:bg-white/[0.07] hover:text-white',
                  )}
                >
                  S{s.season_number}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {rows.length > 0 ? (
        <div className="space-y-2.5">
          {rows.map((ep) => (
            <EpisodeRow key={ep.id} ep={ep} onPlay={onPlay} onUnavailable={onUnavailable} />
          ))}
        </div>
      ) : (
        <p className="text-white/40 text-sm">{emptyText ?? 'No episodes available yet.'}</p>
      )}
    </section>
  )
}
