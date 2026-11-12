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

import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { LONG_PRESS_MS } from '@/components/MediaCardCinema'

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

// How far a finger may drift during a long press before it is a scroll.
const LONG_PRESS_SLOP_PX = 10

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

  // Long press, as on a card (MediaCardCinema): touch only. A mouse has its
  // own contextmenu event and Android fires one for a long press, but iOS
  // Safari does not, so a timer does it there, and without it the menu
  // could not be reached from a row on an iPhone at all. When the timer
  // opens the menu, the click that follows the finger lifting must not also
  // open the title.
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)
  const suppressClick = useRef(false)
  const cancelPress = () => {
    if (press.current) { window.clearTimeout(press.current.timer); press.current = null }
  }
  // A row replaced mid-press must not open a menu for the title it held.
  useEffect(() => () => {
    if (press.current) { window.clearTimeout(press.current.timer); press.current = null }
  }, [item.id])
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    suppressClick.current = false
    if (e.pointerType !== 'touch' || !onCardContext) return
    // A press that starts on one of the row's own buttons is that button's.
    if ((e.target as Element).closest?.('button')) return
    cancelPress()
    const el = e.currentTarget
    const { clientX, clientY } = e
    press.current = {
      x: clientX,
      y: clientY,
      timer: window.setTimeout(() => {
        press.current = null
        suppressClick.current = true
        // The menu takes a mouse event for its position; a press has one.
        onCardContext({ preventDefault() {}, clientX, clientY, detail: 1, currentTarget: el } as unknown as ReactMouseEvent)
      }, LONG_PRESS_MS),
    }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP_PX) cancelPress()
  }

  return (
    // role/tabIndex so the whole row is keyboard-activatable like the
    // card (which is a clickable div). Enter/Space open detail.
    <div
      className="media-list-row group"
      data-media-id={item.id}
      onClick={() => {
        if (suppressClick.current) { suppressClick.current = false; return }
        onSelect()
      }}
      onContextMenu={(e) => { cancelPress(); onCardContext?.(e) }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      role="button"
      tabIndex={0}
      // Phase 10 — announce that a context menu exists.
      //
      // Phase 9 established that the menu IS keyboard-reachable (browsers fire a
      // real `contextmenu` for Shift+F10 and the Menu key on a focused element) and
      // concluded "the trigger was never the problem". True for SC 2.1.1 —
      // operability — and beside the point for discoverability: four of that menu's
      // items have NO other route anywhere in the app, and nothing told a
      // screen-reader user they were there. Being reachable by a shortcut you have
      // no way to learn about is not much better than being unreachable.
      //
      // `aria-keyshortcuts`, and NOT `aria-haspopup`. The first version used
      // haspopup alone, and a review showed that is the attribute ARIA's own
      // authoring note argues against in exactly this situation: "If there is no
      // visual indication that an element will trigger a popup, authors are advised
      // to consider whether use of aria-haspopup is necessary, and avoid using it
      // when it's not." This card has no chevron, no ellipsis, no affordance — that
      // absence is the whole premise.
      //
      // It was also misleading in practice. `aria-haspopup` describes what the
      // element's ACTIVATION opens, and activating a card opens the detail view,
      // not the menu; the menu comes from `contextmenu` (Shift+F10 / Menu key /
      // right-click). And NVDA maps the state to the literal string "subMenu", so
      // the announcement read "…, button, subMenu" — "this is inside a menu and
      // opens a submenu", which is not what is true.
      //
      // `aria-keyshortcuts` names the mechanism instead of gesturing at it, is
      // announced by both NVDA and JAWS, and is precisely what closes the gap:
      // four of that menu's items have no other route in the app, and the problem
      // was never operability, it was that nobody could learn the shortcut.
      // Gated on the handler actually being wired. `onCardContext` is optional and
      // four call sites omit it — LibraryView (twice), SearchView and
      // CollectionsView — so advertising the shortcut unconditionally taught it on
      // three surfaces where pressing it does nothing at all. Measured: 7 of 7 cards
      // on My Library carried it, and Shift+F10 produced no menu. MediaRail and
      // BrowseView already thread `onCardContext ? … : undefined`; this matches.
      aria-keyshortcuts={onCardContext ? 'Shift+F10' : undefined}
      onKeyDown={(e) => {
        // Don't activate the row when a nested control (the lib-add
        // button) has focus — that would double-fire (open detail AND
        // toggle the library). Only activate when the row itself is
        // the event target.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      title={item.title}
    >
      {/* The title cell: a small poster and the title. The thumb's own
          fill is its placeholder while the image loads lazily, and what
          shows when a title has no artwork. */}
      <div className="mlr-main">
        <div className="mlr-thumb" aria-hidden="true">
          {item.poster && (
            <img
              src={item.poster}
              alt=""
              className="mlr-thumb-img"
              loading="lazy"
              decoding="async"
            />
          )}
        </div>
        <div className="mlr-text">
          <div className="mlr-title">{item.title}</div>
          {/* A phone's row has room for the title and little else: the
              year, the rating and the viewer's place go under it there,
              and their columns are not drawn (index.css). */}
          {sub && <div className="mlr-sub">{sub}</div>}
        </div>
      </div>

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

      {/* What a card offers, on a row. Play and Add are pointer
          conveniences and stay out of the tab order (and are not drawn on
          a touch screen, index.css); More, which IS in the tab order,
          opens the menu that holds both. Each stops the click from also
          opening the title. */}
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
