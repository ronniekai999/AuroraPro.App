// Aurora V2 — MediaListRow
//
// 2026-05-31 (library hybrid redesign) — the row used by the Movies/TV
// Shows browse "List" density mode (the Grid ⇄ List toggle). It is a
// horizontal, information-dense alternative to MediaCardCinema's poster
// tile: a small thumb + title + genre/length/year/rating + the same
// My-Library quick-add. The grid stays the default; this is for
// power-browsing a large catalog (2,400+ movies / 500+ shows).
//
// Mirrors MediaCardCinema's conventions deliberately:
//   • A LOCAL narrow `RowMedia` interface (no cross-file type import,
//     no dependency on App.tsx — App → component imports are one-way).
//   • Inlined SVGs (no reach back into App.tsx's shared `Icon`).
//   • Same onSelect / onCardContext / libraryIds / onToggleLib contract
//     as the card, so BrowseView wires both identically.

import type { MouseEvent as ReactMouseEvent } from 'react'

// Structural subset this row reads. Any UI `Media` satisfies it.
export interface RowMedia {
  id: number
  title: string
  // Poster URL from mapMedia (posterURL(poster_path)); "" / undefined when
  // the item has no artwork yet. Rendered as a small lazy-loaded thumb;
  // the tinted gradient placeholder shows while it loads or when absent.
  poster?: string
  year?: number
  rating?: number
  genre?: string
  // Formatted runtime from mapMedia (e.g. "2h 55m", or a per-episode
  // runtime like "45m" for shows); "" when unknown. Not a season count.
  duration?: string
  // Quality / maturity chips assembled by mapMedia (e.g. ["4K","TV-MA"]).
  tags?: string[]
}

export interface MediaListRowProps {
  item: RowMedia
  onSelect: () => void
  onCardContext?: (e: ReactMouseEvent) => void
  libraryIds?: Set<number>
  onToggleLib?: () => void
}

function PlusSvg() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
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
function StarSvg() {
  // fill="currentColor" so the surrounding .star color (gold) applies —
  // same approach as MediaCardCinema.
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

export function MediaListRow({
  item, onSelect, onCardContext, libraryIds, onToggleLib,
}: MediaListRowProps) {
  const isInLib = !!libraryIds?.has(item.id)
  const tags = (item.tags ?? []).filter(Boolean)

  return (
    // role/tabIndex so the whole row is keyboard-activatable like the
    // card (which is a clickable div). Enter/Space open detail.
    <div
      className="media-list-row group"
      onClick={onSelect}
      onContextMenu={onCardContext}
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
      // `aria-haspopup="menu"` is what a reader announces ("has pop up menu"), and
      // it is honest here: the popup really is a `role="menu"` of commands. No
      // `aria-expanded` — that is for a trigger that OWNS its popup, and this card
      // does not: the menu is App-level state rendered as a sibling, one instance
      // shared across the whole grid, so a per-card expanded flag would be a lie on
      // every card but one.
      aria-haspopup="menu"
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
      {/* Small poster thumb (#194). The tinted gradient is the box's
          background, so it doubles as the placeholder while the image
          lazy-loads and as the fallback when an item has no artwork.
          loading="lazy" keeps a long list cheap — only thumbs scrolled
          into view fetch. decoding="async" avoids blocking the row. */}
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

      <div className="mlr-main">
        <div className="mlr-title">{item.title}</div>
        <div className="mlr-tags">
          {tags.map((t, i) => (
            // HDR → amber; else first tag (resolution) → purple; rest neutral.
            // Mutually exclusive so an HDR-but-not-4K tag (index 0) reads amber.
            <span key={t} className={`mlr-tag ${t === 'HDR' ? 'is-hdr' : i === 0 ? 'is-quality' : ''}`}>{t}</span>
          ))}
        </div>
      </div>

      <div className="mlr-cell mlr-genre">{item.genre || '—'}</div>
      <div className="mlr-cell mlr-length">{item.duration || '—'}</div>
      <div className="mlr-cell mlr-year">{item.year && item.year > 0 ? item.year : '—'}</div>
      <div className="mlr-cell mlr-rating">
        {item.rating !== undefined && item.rating > 0 ? (
          <span className="mlr-star"><StarSvg /> {item.rating.toFixed(1)}</span>
        ) : (
          <span className="text-white/30">—</span>
        )}
      </div>

      {onToggleLib && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleLib() }}
          className={`mlr-add ${isInLib ? 'in-lib' : ''}`}
          title={isInLib ? 'In My Library — click to remove' : 'Add to My Library'}
          aria-label={isInLib ? `Remove ${item.title} from My Library` : `Add ${item.title} to My Library`}
        >
          {isInLib ? <CheckSvg /> : <PlusSvg />}
        </button>
      )}
    </div>
  )
}
