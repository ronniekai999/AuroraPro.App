// MediaListRow: one title as a row of a Library grid's list layout. The
// dense alternative to MediaCardCinema's poster: a small poster and the
// title, then genre, length, year, content rating, score, where the viewer
// is in it, and the same My Library quick-add. For reading down a large
// catalog.
//
// Like the card, it reads a local, narrow `RowMedia` (any UI `Media`
// satisfies it), inlines its two glyphs, and takes the card's onSelect /
// onCardContext / libraryIds / onToggleLib contract, so BrowseView wires
// both the same way.

import { type MouseEvent as ReactMouseEvent } from 'react'
import { useLongPress } from '@/hooks/useLongPress'

// Structural subset this row reads. Any UI `Media` satisfies it.
export interface RowMedia {
  id: number
  title: string
  // Poster URL from mapMedia (posterURL(poster_path)); "" / undefined when
  // the item has no artwork yet. Rendered as a small lazy-loaded thumb.
  poster?: string
  year?: number
  rating?: number
  genre?: string
  // Formatted runtime from mapMedia (e.g. "2h 55m", or a per-episode
  // runtime like "45m" for shows); "" when unknown. Not a season count.
  duration?: string
  // Quality marks and then the content rating, assembled by mapMedia (e.g.
  // ["4K", "TV-MA"]).
  tags?: string[]
}

/** The viewer's place in a title they have started: "S2 E4 · 29 min left"
 *  and how far through it they are (0 to 1). */
export interface RowProgress { label: string; fraction: number }

// The list shows the content rating in a column of its own; quality is the
// compact grid's and the title page's to show.
const QUALITY = new Set(['4K', 'HDR'])
export function contentRatingOf(tags: readonly string[] | undefined): string {
  return (tags ?? []).find(t => t && !QUALITY.has(t)) ?? ''
}

export interface MediaListRowProps {
  item: RowMedia
  onSelect: () => void
  onCardContext?: (e: ReactMouseEvent) => void
  libraryIds?: Set<number>
  onToggleLib?: () => void
  /** Where the viewer is in the title, when they have started it. */
  progress?: RowProgress
  /** Plays the title, resuming when the viewer has a place in it (the
   *  caller decides); `resumable` says which the button is. */
  onPlay?: () => void
  resumable?: boolean
}

function PlusSvg() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}
function PlaySvg() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4.5v15l12-7.5z" />
    </svg>
  )
}
function MoreSvg() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  )
}
function CheckSvg() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
export function MediaListRow({
  item, onSelect, onCardContext, libraryIds, onToggleLib, progress, onPlay, resumable,
}: MediaListRowProps) {
  const isInLib = !!libraryIds?.has(item.id)
  const rated = contentRatingOf(item.tags)
  const sub = [item.year && item.year > 0 ? String(item.year) : '', rated, progress?.label ?? ''].filter(Boolean).join(' · ')
  const said = [
    item.year && item.year > 0 ? String(item.year) : '',
    rated,
    item.genre ?? '',
    item.duration ?? '',
    item.rating !== undefined && item.rating > 0 ? `score ${item.rating.toFixed(1)}` : '',
    progress?.label ?? '',
  ].filter(Boolean).join(', ')

  // Long press, as on a card: touch only (hooks/useLongPress). A press that
  // starts on one of the row's actions is that button's. (The title is a
  // button too, and most of what a finger lands on: a press there is the
  // row's.)
  const longPress = useLongPress(onCardContext, item.id, '.mlr-acts')

  return (
    // The row is a plain container: the title is the button (what a
    // keyboard and a screen reader open the title with), and Play, Add and
    // More are its siblings. The whole row used to be `role="button"` with
    // those three inside it, and the children of a button are presentational:
    // More, the keyboard's way to the menu, could be dropped from the
    // accessibility tree while it stayed in the tab order. A click anywhere
    // on the row still opens the title (a pointer's convenience; the
    // button's own click arrives here too).
    <div
      className="media-list-row group"
      data-media-id={item.id}
      onClick={() => { if (!longPress.swallowClick()) onSelect() }}
      onContextMenu={(e) => { longPress.cancel(); onCardContext?.(e) }}
      {...longPress.handlers}
      title={item.title}
    >
      {/* The title cell: a small poster and the title, and the row's one
          tab stop besides More. The thumb's own fill is its placeholder
          while the image loads lazily, and what shows when a title has no
          artwork.

          `aria-keyshortcuts`, not `aria-haspopup`: activating this opens
          the title, and the menu comes from the context-menu key (Shift+F10,
          the Menu key, a right click), which nothing on screen says. Naming
          the shortcut is what tells a screen-reader user it is there;
          haspopup would describe what ACTIVATION opens, and NVDA reads it
          as "subMenu". Only where the menu is wired. */}
      <button type="button" className="mlr-main" aria-keyshortcuts={onCardContext ? 'Shift+F10' : undefined}>
        <span className="mlr-thumb" aria-hidden="true">
          {item.poster && (
            <img
              src={item.poster}
              alt=""
              className="mlr-thumb-img"
              loading="lazy"
              decoding="async"
            />
          )}
        </span>
        <span className="mlr-text">
          <span className="mlr-title">{item.title}</span>
          {/* What the row's cells say, as part of the button's name: the
              cells are outside the button and their header is not read, so
              without this a keyboard user heard the title alone where a
              card says the year and the rating too. */}
          {said && <span className="sr-only">, {said}</span>}
          {/* A phone's row has room for the title and little else: the
              year, the rating and the viewer's place go under it there,
              and their columns are not drawn (index.css). For the eye
              only: the line above already says it. */}
          {sub && <span className="mlr-sub" aria-hidden="true">{sub}</span>}
        </span>
      </button>

      <div className="mlr-cell mlr-genre">{item.genre || '—'}</div>
      <div className="mlr-cell mlr-length">{item.duration || '—'}</div>
      <div className="mlr-cell mlr-year">{item.year && item.year > 0 ? item.year : '—'}</div>
      <div className="mlr-cell mlr-rated">{rated || '—'}</div>
      <div className="mlr-cell mlr-score">{item.rating !== undefined && item.rating > 0 ? item.rating.toFixed(1) : '—'}</div>
      {/* Where the viewer is, for a title they have started. Empty for the
          rest: the catalog does not say which titles are finished, so the
          list does not guess "not started". */}
      <div className="mlr-cell mlr-where">
        {progress && (
          <>
            <span className="mlr-where-label">{progress.label}</span>
            <span className="mlr-bar" aria-hidden="true">
              <span className="mlr-bar-fill" style={{ width: `${Math.round(Math.min(1, Math.max(0, progress.fraction)) * 100)}%` }} />
            </span>
          </>
        )}
      </div>

      {/* What a card offers, on a row, beside the title's button and never
          inside it. Play and Add are pointer conveniences and stay out of
          the tab order (and are not drawn on a touch screen, index.css);
          More, which IS in the tab order, opens the menu that holds both.
          Each stops the click from also opening the title. */}
      <div className="mlr-acts">
        {onPlay && (
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); onPlay() }}
            className="mlr-act mlr-play"
            aria-label={`${resumable ? 'Resume' : 'Play'} ${item.title}`}
          >
            <PlaySvg />
          </button>
        )}
        {onToggleLib && (
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); onToggleLib() }}
            className={`mlr-act mlr-add ${isInLib ? 'in-lib' : ''}`}
            title={isInLib ? 'In My Library' : 'Add to My Library'}
            aria-label={isInLib ? `Remove ${item.title} from My Library` : `Add ${item.title} to My Library`}
          >
            {isInLib ? <CheckSvg /> : <PlusSvg />}
          </button>
        )}
        {onCardContext && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onCardContext(e) }}
            className="mlr-act mlr-more"
            aria-haspopup="menu"
            // The menu sets this to true on this button while it is open.
            aria-expanded={false}
            aria-label={`More actions for ${item.title}`}
          >
            <MoreSvg />
          </button>
        )}
      </div>
    </div>
  )
}
