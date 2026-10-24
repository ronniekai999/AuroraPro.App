// Aurora V2 — sticky left rail for the editorial DetailView.
//
// Poster (with optional resume-progress overlay) + action stack (primary
// Resume / secondary From-start, 3-up Library/List/Party tiles) + a glass
// "My Rating" 1-5★ card + a glass "Details" credits card + admin
// Refresh/Identify. Fully presentational — all labels/handlers/rows are
// passed in by DetailView.

import { useState } from 'react'
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
  StarIcon,
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
  // "My Rating" star widget — the profile's own 1-5★ verdict on this title
  // (feeds the AI recommender: 4-5★ = more like this, 1-2★ = avoid it and its
  // likes). userRating 0 = unrated; undefined onRate hides the card entirely
  // (callers that support rating pass it always — even while the saved value
  // loads, so the card doesn't pop in and shift the rail — and no-op clicks
  // until the value arrives).
  userRating?: number
  onRate?: (stars: number) => void
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
  'flex flex-col items-center justify-center gap-1.5 py-3.5 rounded-[0.9rem] border text-[0.78rem] font-semibold transition-ui'

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

// Resume label row + progress bar. Rendered over the poster's foot, or —
// below lg, when the poster is dropped — on its own above the action stack.
// Only one of the two is ever displayed at a given width.
function ResumeProgress({ leftLabel, rightLabel, pct }: { leftLabel?: string; rightLabel?: string; pct: number }) {
  return (
    <>
      <div className="flex items-center justify-between text-[11px] text-white/80 mb-1.5 font-medium">
        <span className="truncate">{leftLabel}</span>
        {rightLabel && <span className="flex-shrink-0 ml-2">{rightLabel}</span>}
      </div>
      <div
        role="progressbar"
        aria-label="Resume progress"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-[3px] rounded-full bg-white/20 overflow-hidden"
      >
        <div
          className="h-full bg-purple-500 rounded-full shadow-[0_0_8px_rgba(168,85,247,0.9)]"
          style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
        />
      </div>
    </>
  )
}

// RATING_LABELS[n] captions the n-star verdict — shown for the hovered star
// (preview) or the saved rating, and read to screen readers via the buttons'
// aria-labels.
const RATING_LABELS = ['', 'Hated it', 'Not for me', 'It was OK', 'Really liked it', 'Loved it']

// StarRatingRow — five toggle stars. Click sets; clicking the current rating
// clears (the widget's only affordance for "un-rate", mirroring the thumbs
// context-menu's re-click-to-clear). Hover/focus previews the would-be rating.
//
// Semantics are toggle-buttons in a group (aria-pressed), NOT a radiogroup:
// review flagged that role="radio" promises the roving-tabindex + arrow-key
// contract these five tab-stop buttons don't implement, and "re-click to
// uncheck" is behavior radios never have. Plain pressed-buttons describe the
// control honestly to screen readers with the same labels.
function StarRatingRow({ rating, onRate }: { rating: number; onRate: (stars: number) => void }) {
  const [hovered, setHovered] = useState(0)
  const shown = hovered || rating
  return (
    <div>
      <div
        role="group"
        aria-label="Rate this title"
        className="flex items-center justify-between"
        onMouseLeave={() => setHovered(0)}
      >
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            aria-pressed={rating === n}
            aria-label={n === rating ? `Clear your ${n}-star rating` : `Rate ${n} star${n === 1 ? '' : 's'} — ${RATING_LABELS[n]}`}
            title={n === rating ? 'Clear rating' : RATING_LABELS[n]}
            // Reset the hover preview on click: without this, the just-set
            // (or just-cleared) value hides behind the stuck `hovered` until
            // the pointer leaves — and on touch, where mouseleave never
            // fires, a clear looked like a no-op forever (review M-finding).
            onClick={() => { setHovered(0); onRate(n === rating ? 0 : n) }}
            onMouseEnter={() => setHovered(n)}
            onFocus={() => setHovered(n)}
            onBlur={() => setHovered(0)}
            className={cn(
              'p-1.5 rounded-lg transition-ui motion-safe:hover:scale-110',
              n <= shown ? 'text-yellow-400' : 'text-white/25 hover:text-white/50',
            )}
          >
            <StarIcon size={22} />
          </button>
        ))}
      </div>
      {/* Fixed-height caption slot so the card doesn't jump between states. */}
      <div className="h-4 mt-1 text-center text-[12px] text-white/45" aria-live="polite">
        {shown > 0 ? RATING_LABELS[shown] : 'Tap a star — Aurora learns from it'}
      </div>
    </div>
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
  userRating,
  onRate,
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
    // Top offset clears the app's sticky nav + a small gap. Reads
    // --topnav-h (2026-07-25, Aurora Stage Phase 2) instead of the old
    // hardcoded 76px so it tracks the bar rather than drifting the next
    // time its height changes. Note the admin scan bar sits above the nav
    // and adds ~3px while a scan runs; that pre-existing few-pixel drift
    // is the same one BrowseView's toolbar comment calls out.
    //
    // flex + gap, not `space-y-5`: Tailwind 3's space-y selector
    // (`> :not([hidden]) ~ :not([hidden])`) only skips the hidden ATTRIBUTE, so
    // a poster hidden by `hidden lg:block` still earned the next child a 20px
    // top margin below lg. A display:none flex item takes no gap. Same 1.25rem
    // spacing at every width otherwise.
    <div className={cn('lg:sticky lg:z-20 lg:top-[calc(var(--chrome-h,var(--topnav-h))+12px)] self-start flex flex-col gap-5', className)}>
      {/* Poster + resume overlay */}
      {/* bg matters now that the poster overlaps the hero: posterURL() returns
          '' for an unmatched title, so this box renders the alt text and a
          broken-image glyph — previously against flat #050505 below the hero,
          now against backdrop artwork at ~17% scrim alpha. */}
      {/* `hidden lg:block`: the poster is a DESKTOP rail element. Below lg the
          grid is one column, so it rendered full-width — ~530px tall on a
          phone, ~990px on an iPad in portrait — between the hero and Play,
          pushing the page's primary action one to two screens down under a
          second copy of the hero's art. DetailHero falls back to this same
          poster when there is no backdrop, so the art is not lost.

          Unconditional ON PURPOSE. Keying it on "does the hero have a
          backdrop" was tried and flips for the same title between the
          pre-payload render and the payload's: My Library / Calendar /
          Collections open titles with no backdrop field at all, so the ~530px
          box appeared or collapsed above Play after the page had settled.

          display:none, so below lg the poster's progress bar is out of the
          accessibility tree as well as out of sight, and the compact copy
          below is the only one exposed. */}
      <div className="relative rounded-2xl overflow-hidden ring-1 ring-white/15 shadow-2xl bg-[#0b0b12] hidden lg:block">
        {/* decoding=async keeps a 2:3 decode off the click-to-detail frame;
            a poster that 404s hides itself and the box's own fill shows. */}
        <img
          // key: a src swap (media.poster → the detail payload's poster)
          // remounts the node so an earlier hide-on-error cannot stick.
          key={poster}
          src={poster}
          alt={title}
          // stage-img-fade (DT1) — see DetailHero.
          className="stage-img-fade w-full aspect-[2/3] object-cover"
          // lazy: below lg the box is display:none, and a lazy image that never
          // lays out is never fetched — without it every phone detail view
          // downloaded a w500 poster it could not show. From lg up the poster
          // sits in the first viewport, so lazy loading starts it at once.
          loading="lazy"
          decoding="async"
          ref={(el) => { if (el && el.complete && el.naturalWidth > 0) el.setAttribute('data-loaded', '') }}
          onLoad={(e) => e.currentTarget.setAttribute('data-loaded', '')}
          onError={(e) => { e.currentTarget.style.visibility = 'hidden' }}
        />
        {hasProgress && (
          <>
            <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/85 to-transparent" />
            <div className="absolute bottom-3 left-3.5 right-3.5">
              <ResumeProgress leftLabel={resumeLeftLabel} rightLabel={resumeRightLabel} pct={progressPct} />
            </div>
          </>
        )}
      </div>
      {/* The poster's progress, relocated for the single-column layout. The
          exact complement of the poster's `hidden lg:block`, so exactly one
          copy is displayed at every width. */}
      {hasProgress && (
        <div className="lg:hidden px-0.5">
          <ResumeProgress leftLabel={resumeLeftLabel} rightLabel={resumeRightLabel} pct={progressPct} />
        </div>
      )}

      {/* Action stack */}
      <div className="space-y-2.5">
        <button
          type="button"
          onClick={onPrimary}
          onMouseEnter={onPrimaryIntent}
          onFocus={onPrimaryIntent}
          aria-label={primaryAriaLabel}
          title={primaryTitle}
          // Shared button family (index.css .stage-btn) — the same primary,
          // ghost and small/danger variants the hero and Load More use.
          className="w-full stage-btn stage-btn-pill stage-btn-primary"
        >
          <PlayIcon size={19} />
          {primaryLabel}
        </button>
        {secondaryLabel && onSecondary && (
          <button
            type="button"
            onClick={onSecondary}
            className="w-full stage-btn stage-btn-pill stage-btn-ghost"
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
            className="w-full stage-btn stage-btn-pill stage-btn-ghost is-on"
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
            className="w-full stage-btn stage-btn-pill stage-btn-ghost"
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

      {/* My Rating star card — personal 1-5★ verdict, feeds the recommender */}
      {onRate && (
        <div className="glass-card rounded-2xl px-4 pt-3.5 pb-2.5">
          <div className="text-[11px] uppercase tracking-[.18em] text-white/40 mb-1.5 font-semibold">My Rating</div>
          <StarRatingRow rating={userRating ?? 0} onRate={onRate} />
        </div>
      )}

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
                  className="flex-1 stage-btn stage-btn-sm stage-btn-ghost"
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
                  className="flex-1 stage-btn stage-btn-sm stage-btn-ghost"
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
              className="w-full stage-btn stage-btn-sm stage-btn-danger"
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
