// A show's episodes: a season switch, the episode to continue pinned first,
// then every episode of the season as a compact row.
//
// The page is NOT scrolled to the episode in progress on load. It used to be,
// which moved a show's page away from its own hero the moment it opened; the
// pinned card does that job without taking the page out of the viewer's
// hands.

import { Play } from 'lucide-react'
import { cn } from '../../lib/utils'
import { EpisodeRow, EpisodeStill, type EpisodeRowVM } from './EpisodeRow'
import { SkeletonBlock } from '@/components/Skeletons'

export interface SeasonOpt {
  season_number: number
  episode_count?: number
}

interface EpisodeListProps {
  // Episodes in the selected season.
  count: number
  seasons?: SeasonOpt[]
  selectedSeason?: number | null
  onSelectSeason?: (n: number) => void
  rows: EpisodeRowVM[]
  // The episode the title's Resume button would play (the most recent
  // continue-watching record). When it is in this season it is the one the
  // pinned card offers, so the card and the button never name two episodes.
  continueEpisodeId?: number
  onPlay: (id: number, fileId?: number) => void
  onUnavailable: (id: number) => void
  emptyText?: string
  // True while the episode list is still loading. Without it a show's page
  // would say "No episodes available yet." about a show that has them, for
  // as long as the request takes.
  loading?: boolean
  className?: string
}

// More seasons than this and the chips become a menu at every width.
const MAX_SEASON_CHIPS = 8

/** Season 0 is where a show's specials are filed. */
export function seasonName(n: number): string {
  return n === 0 ? 'Specials' : `Season ${n}`
}

/** Row silhouettes at the real rows' size, so they are replaced in place. */
function EpisodeRowsSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 sm:gap-4 py-2 border-t border-line">
          <span className="hidden sm:block w-8" />
          <SkeletonBlock className="w-[100px] h-[56px] sm:w-[128px] sm:h-[72px] rounded-art shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <SkeletonBlock className="h-4 w-[45%] rounded-md" />
            <SkeletonBlock className="h-3.5 w-[75%] rounded-md" />
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
  continueEpisodeId,
  onPlay,
  onUnavailable,
  emptyText,
  loading = false,
  className,
}: EpisodeListProps) {
  const showPicker = !!seasons && seasons.length > 1
  const asMenu = showPicker && seasons!.length > MAX_SEASON_CHIPS
  const watched = rows.filter(r => r.state === 'watched').length
  // The episode to continue. The one Resume would play, when it is in this
  // season: someone who left episode 2 at 40% and then got 30% into episode
  // 5 is resuming episode 5, and the first in-progress row is episode 2.
  // Otherwise the first in progress here.
  const current = rows.find(r => r.id === continueEpisodeId && r.hasFile && r.state !== 'watched')
    ?? rows.find(r => r.state === 'in-progress' && r.hasFile)

  return (
    <section className={className} aria-labelledby="detail-episodes-heading">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <h2 id="detail-episodes-heading" className="font-display text-[22px] leading-tight font-semibold tracking-[-0.01em]">
          Episodes
        </h2>
        {showPicker && (
          <>
            {/* Chips where there is room for them; a menu on a phone, and
                at every width once a show has more seasons than fit. */}
            {!asMenu && (
              <div role="group" aria-label="Season" className="hidden md:flex flex-wrap gap-2">
                {seasons!.map((s) => {
                  const on = selectedSeason === s.season_number
                  return (
                    <button
                      key={s.season_number}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onSelectSeason?.(s.season_number)}
                      title={s.episode_count ? `${s.episode_count} episodes` : undefined}
                      className={cn(
                        'h-9 px-4 rounded-full text-[14px] transition-colors',
                        on
                          ? 'bg-ink text-action-on font-semibold'
                          : 'bg-surface-raised-2 text-ink-2 font-medium hover:text-ink',
                      )}
                    >
                      {seasonName(s.season_number)}
                    </button>
                  )
                })}
              </div>
            )}
            <label className={cn('ml-auto', !asMenu && 'md:hidden')}>
              <span className="sr-only">Season</span>
              <select
                value={selectedSeason ?? ''}
                onChange={(e) => onSelectSeason?.(Number(e.target.value))}
                className="stage-select h-11 pl-3 pr-9 rounded-control border border-line-strong bg-surface-raised text-ink text-[14px]"
              >
                {selectedSeason == null && <option value="" disabled>Season</option>}
                {seasons!.map(s => (
                  <option key={s.season_number} value={s.season_number}>{seasonName(s.season_number)}</option>
                ))}
              </select>
            </label>
          </>
        )}
        {rows.length > 0 && (
          // With the season menu at every width (a long-running show) the
          // count keeps its own line; it is never dropped.
          <span className={cn('text-[14px] text-ink-2 tabular-nums', !showPicker ? 'ml-auto' : asMenu ? 'w-full' : 'w-full md:w-auto md:ml-auto')}>
            {count} episode{count === 1 ? '' : 's'}{watched > 0 ? ` · ${watched} watched` : ''}
          </span>
        )}
      </div>

      {current && (
        <button
          type="button"
          onClick={() => onPlay(current.id)}
          className="stage-ep-continue mt-4 w-full flex flex-wrap items-center gap-4 sm:gap-5 p-3 sm:p-4 rounded-control bg-surface-raised text-left"
        >
          <EpisodeStill ep={current} className="w-[100px] h-[56px] sm:w-[128px] sm:h-[72px]" />
          <span className="flex-1 min-w-[160px] flex flex-col gap-0.5">
            <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2">Continue</span>
            <span className="text-[17px] font-semibold text-ink truncate">{current.number} · {current.title}</span>
            {current.leftLabel && <span className="text-[13px] text-ink-2 tabular-nums">{current.leftLabel}</span>}
          </span>
          <span className="inline-flex items-center gap-2 h-10 pl-3.5 pr-4 rounded-full bg-action text-action-on text-[14px] font-semibold flex-none">
            <Play size={15} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            Resume
          </span>
        </button>
      )}

      {rows.length > 0 ? (
        <ul className="mt-4">
          {rows.map((ep) => (
            <EpisodeRow key={ep.id} ep={ep} onPlay={onPlay} onUnavailable={onUnavailable} />
          ))}
        </ul>
      ) : loading ? (
        <div className="mt-4"><EpisodeRowsSkeleton /></div>
      ) : (
        <p className="mt-4 text-ink-2 text-[15px]">{emptyText ?? 'No episodes available yet.'}</p>
      )}
    </section>
  )
}
