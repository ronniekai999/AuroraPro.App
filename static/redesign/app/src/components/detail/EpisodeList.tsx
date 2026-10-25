// Aurora V2 — Episodes section: season-picker chip row + episode rows.

import { useEffect, useRef } from 'react'
import { cn } from '../../lib/utils'
import { EpisodeRow, type EpisodeRowVM } from './EpisodeRow'
import { SkeletonBlock } from '@/components/Skeletons'

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
  // Rows are still in flight: render row-shaped placeholders instead of the
  // empty-state sentence, so the list does not announce "no episodes" for
  // a season that is simply loading and then jump when the rows land.
  loading?: boolean
  className?: string
}

/** Three episode-row silhouettes: still, title line, synopsis line. Same
 *  outer shape as EpisodeRow (rounded-2xl, p-[0.7rem], the 140/176/212px
 *  still) so the real rows replace them in place. */
function EpisodeRowsSkeleton() {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex gap-4 p-[0.7rem] rounded-2xl border border-white/[0.05] bg-white/[0.02]">
          <SkeletonBlock className="w-[140px] sm:w-[176px] lg:w-[212px] aspect-video shrink-0" />
          <div className="flex-1 min-w-0 py-1 space-y-3">
            <SkeletonBlock className="h-4 w-[55%] rounded-md" />
            <SkeletonBlock className="h-3.5 w-[85%] rounded-md" />
            <SkeletonBlock className="h-3.5 w-[40%] rounded-md" />
          </div>
        </div>
      ))}
    </div>
  )
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
  loading = false,
  className,
}: EpisodeListProps) {
  const showPicker = !!seasons && seasons.length > 1

  // Bring the in-progress episode into view when a season's rows land —
  // a long season otherwise opens at E1 with the current episode below
  // the fold. Keyed by the row id: the primitive dep already skips
  // unrelated re-renders (progress updates, version-chip hovers), and
  // re-runs on every actual change — including switching seasons away and
  // back, which a "scrolled once" guard would wrongly suppress. 'nearest'
  // is a no-op when the row is already visible.
  const inProgressId = rows.find((r) => r.state === 'in-progress')?.id
  const inProgressRowRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (inProgressId == null) return
    inProgressRowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [inProgressId])

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
                    'inline-flex items-center px-3.5 py-[7px] rounded-full text-[13px] font-semibold transition-ui border',
                    on
                      ? 'bg-purple-500/[0.22] border-purple-400/45 text-purple-100'
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
            <div key={ep.id} ref={ep.id === inProgressId ? inProgressRowRef : undefined}>
              <EpisodeRow ep={ep} onPlay={onPlay} onUnavailable={onUnavailable} />
            </div>
          ))}
        </div>
      ) : loading ? (
        <EpisodeRowsSkeleton />
      ) : (
        <p className="text-white/40 text-sm">{emptyText ?? 'No episodes available yet.'}</p>
      )}
    </section>
  )
}
