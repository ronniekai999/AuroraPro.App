// The title page's action row, in the hero: one white primary (Resume or
// Play), then everything else a viewer does with a title, in one line that
// wraps. On a phone the primary takes the full width and the rest share the
// row beneath it.
//
// Presentational: every label and handler comes from DetailView.

import { useState } from 'react'
import { Check, Film, ListPlus, Play, Plus, RotateCcw, Star, Users } from 'lucide-react'
import { cn } from '@/lib/utils'

interface DetailActionsProps {
  primaryLabel: string
  onPrimary: () => void
  // Fired on hover or focus of the primary button, so the page can pre-warm
  // playback before the click. Best-effort.
  onPrimaryIntent?: () => void
  primaryAriaLabel?: string
  primaryTitle?: string
  // "Play from start": only when the primary is a resume.
  secondaryLabel?: string
  onSecondary?: () => void
  // "Previously on": the spoiler-safe recap, for a show in progress.
  onPrevious?: () => void
  onWatchTrailer?: () => void
  inLibrary: boolean
  onToggleLibrary: () => void
  onAddToList?: () => void
  onParty?: () => void
  inParty?: boolean
  // The profile's own 1 to 5 star verdict (0 = unrated). It feeds the
  // recommender: 4 and 5 mean "more like this", 1 and 2 "avoid it and its
  // likes". An undefined onRate hides the control; callers that support
  // rating pass it always, even while the saved value loads, so the row does
  // not shift when it arrives.
  userRating?: number
  onRate?: (stars: number) => void
  // Resume progress, 0..1, with what is left ("37 min left").
  resumeFraction?: number
  resumeLeftLabel?: string
}

const QUIET =
  'stage-detail-action inline-flex items-center justify-center gap-2 h-11 px-4 rounded-control text-[15px] font-medium text-ink'

export function DetailActions({
  primaryLabel, onPrimary, onPrimaryIntent, primaryAriaLabel, primaryTitle,
  secondaryLabel, onSecondary,
  onPrevious, onWatchTrailer,
  inLibrary, onToggleLibrary, onAddToList,
  onParty, inParty,
  userRating, onRate,
  resumeFraction, resumeLeftLabel,
}: DetailActionsProps) {
  const hasProgress = resumeFraction !== undefined
  const pct = Math.round((resumeFraction ?? 0) * 100)
  return (
    <div className="flex flex-col gap-3.5 mt-0.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
        <button
          type="button"
          onClick={onPrimary}
          onMouseEnter={onPrimaryIntent}
          onFocus={onPrimaryIntent}
          aria-label={primaryAriaLabel}
          title={primaryTitle}
          // Full width on a phone: the one thing most visits are for.
          className="stage-btn stage-btn-primary w-full sm:w-auto"
        >
          <Play size={18} fill="currentColor" strokeWidth={0} aria-hidden="true" />
          {primaryLabel}
        </button>
        {secondaryLabel && onSecondary && (
          <button type="button" onClick={onSecondary} className="stage-btn stage-btn-pill stage-btn-ghost">
            <RotateCcw size={16} aria-hidden="true" />
            {secondaryLabel}
          </button>
        )}
        {onPrevious && (
          <button
            type="button"
            onClick={onPrevious}
            title="Catch up on the story so far, without spoilers"
            className="stage-btn stage-btn-pill stage-btn-ghost"
          >
            {/* The aurora dot: this is written by Aurora, not by the studio. */}
            <i aria-hidden="true" className="w-2 h-2 rounded-full [background:var(--aurora)]" />
            Previously on
          </button>
        )}
        {onWatchTrailer && (
          <button type="button" onClick={onWatchTrailer} className={QUIET} title="Watch the trailer">
            <Film size={18} strokeWidth={1.75} aria-hidden="true" />
            Trailer
          </button>
        )}
        <button
          type="button"
          onClick={onToggleLibrary}
          aria-pressed={inLibrary}
          className={QUIET}
          title={inLibrary ? 'Remove from My Library' : 'Add to My Library'}
        >
          {/* The name stays "My Library" and `aria-pressed` carries the
              state; a toggle whose name also changes says it twice, or says
              two different things. The icon is the state for the eye. */}
          {inLibrary
            ? <Check size={18} strokeWidth={2.25} aria-hidden="true" />
            : <Plus size={18} strokeWidth={2} aria-hidden="true" />}
          My Library
        </button>
        {onAddToList && (
          <button type="button" onClick={onAddToList} className={QUIET} title="Add to a list">
            <ListPlus size={18} strokeWidth={1.75} aria-hidden="true" />
            List
          </button>
        )}
        {onParty && (
          <button
            type="button"
            onClick={onParty}
            disabled={inParty}
            className={cn(QUIET, inParty && 'opacity-50 cursor-not-allowed')}
            title={inParty ? 'Already in a party' : 'Start a watch party'}
          >
            <Users size={18} strokeWidth={1.75} aria-hidden="true" />
            {inParty ? 'In a party' : 'Watch together'}
          </button>
        )}
        {onRate && <StarRating rating={userRating ?? 0} onRate={onRate} />}
      </div>
      {hasProgress && (
        <div className="flex items-center gap-3 max-w-[460px]">
          <div
            role="progressbar"
            aria-label="Resume progress"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="flex-1 h-[3px] rounded-full bg-[var(--track)] overflow-hidden"
          >
            <div className="h-full rounded-full bg-action" style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
          </div>
          {resumeLeftLabel && <span className="text-[13px] text-ink-2 tabular-nums flex-none">{resumeLeftLabel}</span>}
        </div>
      )}
    </div>
  )
}

// RATING_LABELS[n] captions the n-star verdict: shown for the hovered star
// (a preview) or the saved rating, and read out through the buttons' labels.
const RATING_LABELS = ['', 'Hated it', 'Not for me', 'It was OK', 'Really liked it', 'Loved it']

// Five toggle stars. A press sets the rating; a press on the current rating
// clears it, which is the control's only way to un-rate. Hover and focus
// preview the would-be rating.
//
// Toggle buttons in a group (aria-pressed), NOT a radiogroup: role="radio"
// promises a roving tabindex and arrow keys these five tab stops do not
// implement, and "press again to uncheck" is something radios never do.
function StarRating({ rating, onRate }: { rating: number; onRate: (stars: number) => void }) {
  const [hovered, setHovered] = useState(0)
  const shown = hovered || rating
  return (
    <div className="flex items-center gap-2 sm:ml-2">
      <div
        role="group"
        aria-label={rating > 0 ? `Your rating: ${rating} of 5` : 'Rate this title'}
        className="flex items-center"
        onMouseLeave={() => setHovered(0)}
      >
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            aria-pressed={rating === n}
            aria-label={n === rating ? `Clear your ${n}-star rating` : `Rate ${n} star${n === 1 ? '' : 's'}: ${RATING_LABELS[n]}`}
            title={n === rating ? 'Clear rating' : RATING_LABELS[n]}
            // Reset the hover preview on press. Without this the value just
            // set (or cleared) hides behind the stuck preview until the
            // pointer leaves, and on touch, where it never leaves, a clear
            // looked like nothing had happened.
            onClick={() => { setHovered(0); onRate(n === rating ? 0 : n) }}
            onMouseEnter={() => setHovered(n)}
            onFocus={() => setHovered(n)}
            onBlur={() => setHovered(0)}
            // A filled star is the rating; an empty one is an outline in the
            // same ink, so the difference is shape, not a faint colour.
            // 44px at every width: five tab stops side by side, with no gap
            // between them for a larger invisible area to reach into.
            className="w-11 h-11 grid place-items-center rounded-control text-ink"
          >
            <Star size={20} strokeWidth={1.75} fill={n <= shown ? 'currentColor' : 'none'} aria-hidden="true" />
          </button>
        ))}
      </div>
      {/* The verdict in words. A fixed slot, so the row does not jump. */}
      <span className="hidden lg:inline text-[13px] text-ink-2 min-w-[7.5em]" aria-live="polite">
        {shown > 0 ? RATING_LABELS[shown] : ''}
      </span>
    </div>
  )
}
