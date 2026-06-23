// Aurora V2 — sticky left rail for the editorial DetailView.
//
// Poster (with optional resume-progress overlay) + action stack (primary
// Resume / secondary From-start, 3-up Library/List/Party tiles) + a glass
// "Details" credits card + admin Refresh/Identify. Fully presentational —
// all labels/handlers/rows are passed in by DetailView.

import { cn } from '../../lib/utils'
import {
  PlayIcon,
  RestartIcon,
  PlusIcon,
  CheckIcon,
  ListIcon,
  UsersIcon,
  RefreshIcon,
  InfoIcon,
  SparkleIcon,
  TrashIcon,
} from './icons'

export interface DetailRow {
  label: string
  value: string
}

interface DetailRailProps {
  poster: string
  title: string
  // resume-progress overlay on the poster (fraction 0..1; undefined = none)
  resumeFraction?: number
  resumeLeftLabel?: string // "Resume · 0:08" | "S1·E4 · 18:23"
  resumeRightLabel?: string // total duration "1:52:00"
  // primary action
  primaryLabel: string
  onPrimary: () => void
  // Fired on hover/focus of the primary button — lets the page pre-warm
  // playback (pre-create the transcode session / warm the file cache) before
  // the click so playback starts faster. Best-effort; optional.
  onPrimaryIntent?: () => void
  primaryAriaLabel?: string
  primaryTitle?: string
  // secondary "from start" (only when resuming)
  secondaryLabel?: string
  onSecondary?: () => void
  // "Watch Trailer" — only set when the item has a trailer
  onWatchTrailer?: () => void
  // "Previously" — spoiler-safe AI recap; only set for a show with a resume point
  onPrevious?: () => void
  // 3-up tiles
  inLibrary: boolean
  onToggleLibrary: () => void
  onAddToList?: () => void
  onParty?: () => void
  inParty?: boolean
  // credits card
  detailRows: DetailRow[]
  // admin
  onRefresh?: () => void
  onIdentify?: () => void
  // admin "remove from library" — deletes Aurora's catalog entry for this
  // title (files on disk are untouched). Used to clear a "no files available"
  // ghost. Only set for admins; the host confirms before calling.
  onDelete?: () => void
  className?: string
}

const TILE =
  'flex flex-col items-center justify-center gap-1.5 py-3.5 rounded-[0.9rem] border text-[0.78rem] font-semibold transition-all'

function Tile({
  onClick,
  icon,
  label,
  active,
  disabled,
  title,
}: {
  onClick?: () => void
  icon: React.ReactNode
  label: string
  active?: boolean
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        TILE,
        active
          ? 'bg-purple-500/12 border-purple-400/30 text-purple-200'
          : 'bg-white/[0.04] border-white/[0.07] text-white/80 hover:bg-white/[0.09] hover:text-white',
        disabled && 'opacity-40 cursor-not-allowed hover:bg-white/[0.04]',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

export function DetailRail({
  poster,
  title,
  resumeFraction,
  resumeLeftLabel,
  resumeRightLabel,
  primaryLabel,
  onPrimary,
  onPrimaryIntent,
  primaryAriaLabel,
  primaryTitle,
  secondaryLabel,
  onSecondary,
  onWatchTrailer,
  onPrevious,
  inLibrary,
  onToggleLibrary,
  onAddToList,
  onParty,
  inParty,
  detailRows,
  onRefresh,
  onIdentify,
  onDelete,
  className,
}: DetailRailProps) {
  const hasProgress = resumeFraction !== undefined
  const progressPct = Math.round((resumeFraction ?? 0) * 100)
  const tileCount = 1 + (onAddToList ? 1 : 0) + (onParty ? 1 : 0)
  return (
    // top offset clears the app's sticky header (~60px) + a small gap.
    <div className={cn('lg:sticky lg:top-[76px] self-start space-y-5', className)}>
      {/* Poster + resume overlay */}
      <div className="relative rounded-2xl overflow-hidden ring-1 ring-white/15 shadow-2xl">
        <img src={poster} alt={title} className="w-full aspect-[2/3] object-cover" />
        {hasProgress && (
          <>
            <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/85 to-transparent" />
            <div className="absolute bottom-3 left-3.5 right-3.5">
              <div className="flex items-center justify-between text-[11px] text-white/80 mb-1.5 font-medium">
                <span className="truncate">{resumeLeftLabel}</span>
                {resumeRightLabel && <span className="flex-shrink-0 ml-2">{resumeRightLabel}</span>}
              </div>
              <div
                role="progressbar"
                aria-label="Resume progress"
                aria-valuenow={progressPct}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-[3px] rounded-full bg-white/20 overflow-hidden"
              >
                <div
                  className="h-full bg-purple-500 rounded-full shadow-[0_0_8px_rgba(168,85,247,0.9)]"
                  style={{ width: `${Math.min(100, Math.max(2, progressPct))}%` }}
                />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Action stack */}
      <div className="space-y-2.5">
        <button
          type="button"
          onClick={onPrimary}
          onMouseEnter={onPrimaryIntent}
          onFocus={onPrimaryIntent}
          aria-label={primaryAriaLabel}
          title={primaryTitle}
          className="w-full h-12 inline-flex items-center justify-center gap-2.5 rounded-full font-semibold bg-purple-600 hover:bg-purple-500 transition-all shadow-[0_0_24px_rgba(168,85,247,0.45)]"
        >
          <PlayIcon size={19} />
          {primaryLabel}
        </button>
        {secondaryLabel && onSecondary && (
          <button
            type="button"
            onClick={onSecondary}
            className="w-full h-11 inline-flex items-center justify-center gap-2 rounded-full font-medium bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-white/85 transition-all"
          >
            <RestartIcon size={16} />
            {secondaryLabel}
          </button>
        )}
        {onPrevious && (
          <button
            type="button"
            onClick={onPrevious}
            title="Catch up on the story so far — spoiler-free"
            className="w-full h-11 inline-flex items-center justify-center gap-2 rounded-full font-medium bg-purple-500/10 hover:bg-purple-500/20 border border-purple-400/25 text-purple-100 transition-all"
          >
            <SparkleIcon size={16} />
            Previously
          </button>
        )}
        {onWatchTrailer && (
          <button
            type="button"
            onClick={onWatchTrailer}
            title="Watch the trailer"
            className="w-full h-11 inline-flex items-center justify-center gap-2 rounded-full font-medium bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-white/85 transition-all"
          >
            <PlayIcon size={16} />
            Watch Trailer
          </button>
        )}
        <div className={cn('grid gap-2.5 pt-1', tileCount === 3 ? 'grid-cols-3' : tileCount === 2 ? 'grid-cols-2' : 'grid-cols-1')}>
          <Tile
            onClick={onToggleLibrary}
            active={inLibrary}
            icon={inLibrary ? <CheckIcon size={19} /> : <PlusIcon size={19} />}
            label={inLibrary ? 'Saved' : 'Library'}
            title={inLibrary ? 'Remove from library' : 'Add to library'}
          />
          {onAddToList && <Tile onClick={onAddToList} icon={<ListIcon size={18} />} label="List" title="Add to a list" />}
          {onParty && (
            <Tile
              onClick={onParty}
              disabled={inParty}
              icon={<UsersIcon size={19} />}
              label={inParty ? 'In Party' : 'Party'}
              title={inParty ? 'Already in a party' : 'Start a watch party'}
            />
          )}
        </div>
      </div>

      {/* Details credits card */}
      {detailRows.length > 0 && (
        <div className="glass-card rounded-2xl p-5">
          <div className="text-[11px] uppercase tracking-[.18em] text-white/40 mb-2 font-semibold">Details</div>
          {detailRows.map((r, i) => (
            <div
              key={i}
              className="flex justify-between gap-4 py-[0.62rem] border-b border-white/[0.05] last:border-0 text-[13.5px]"
            >
              <span className="text-white/45 flex-shrink-0">{r.label}</span>
              <span className="text-white/90 text-right font-medium">{r.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Admin utilities */}
      {(onRefresh || onIdentify || onDelete) && (
        <div className="space-y-2.5">
          {(onRefresh || onIdentify) && (
            <div className="flex gap-2.5">
              {onRefresh && (
                <button
                  type="button"
                  onClick={onRefresh}
                  title="Re-fetch metadata from TMDB/TVDB"
                  className="flex-1 h-10 inline-flex items-center justify-center gap-2 rounded-xl text-[13px] font-medium bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.05] text-white/55 hover:text-white/85 transition-all"
                >
                  <RefreshIcon size={15} />
                  Refresh
                </button>
              )}
              {onIdentify && (
                <button
                  type="button"
                  onClick={onIdentify}
                  title="Manually search TMDB/TVDB and pick the correct match"
                  className="flex-1 h-10 inline-flex items-center justify-center gap-2 rounded-xl text-[13px] font-medium bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.05] text-white/55 hover:text-white/85 transition-all"
                >
                  <InfoIcon size={15} />
                  Identify
                </button>
              )}
            </div>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              title="Remove from Aurora — deletes the library entry (files on disk are kept)"
              className="w-full h-10 inline-flex items-center justify-center gap-2 rounded-xl text-[13px] font-medium bg-red-500/[0.06] hover:bg-red-500/[0.14] border border-red-500/15 text-red-300/70 hover:text-red-200 transition-all"
            >
              <TrashIcon size={15} />
              Remove from Library
            </button>
          )}
        </div>
      )}
    </div>
  )
}
