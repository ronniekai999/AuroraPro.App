// MediaCardCinema — the one poster card, shared by the rails (via MediaRail)
// and every grid (Movies, TV Shows, My Library, Search, a collection).
//
// A poster is a poster: nothing is painted on the artwork at rest. The title
// and one line of facts sit in a caption UNDER the art, on the page, so their
// contrast never depends on the art. What does go on the art:
//   - a white progress bar, when there is progress;
//   - Play, Add and More, over a short scrim, under a pointer or keyboard
//     focus. On a touch screen (no hover) More is always there instead.
// Saved is a small tick at the head of the caption's facts line. AI
// attribution is said once per rail, in the rail's header, not per card.
//
// More and a long press open the same menu right-click does (onCardContext),
// so nothing is reachable only by a right click.
//
// Lives outside App.tsx because the grid views live in their own files and
// components do not import from App. The icons are inlined so this file has
// no dependency on the shared Icon table.

import { memo, useId, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

// MediaLike is the structural subset of the UI's `Media` this card reads, so
// callers can pass any compatible shape without a cross-file type import.
export interface MediaLike {
  id: number
  title: string
  poster?: string
  // Landscape (16:9) cards (Continue Watching) use the backdrop so the art
  // fills the frame; they fall back to the poster when there is none.
  backdrop?: string
  year?: number
  rating?: number
  genre?: string
  // An LLM-written reason for a personalized pick. Not drawn on the card
  // (the rail's header carries the attribution); kept for assistive tech.
  reason?: string
  progress?: number
  duration?: string
  tags?: string[]
}

export interface MediaCardCinemaProps<T extends MediaLike = MediaLike> {
  item: T
  onSelect: (item: T) => void
  // Opens the card's menu. Called for a right click, for the More button
  // (with that click, so the menu can anchor to the button) and for a long
  // press on a touch screen (with the press's position).
  onCardContext?: (e: ReactMouseEvent, item: T) => void
  libraryIds?: Set<number>
  onToggleLib?: (item: T) => void
  className?: string
  // Replaces the facts line (rating · year · genre) with one caller-written
  // line, e.g. "S2E5 · 23m left" on Continue Watching.
  subtitle?: string
  aspect?: 'poster' | 'landscape'
  // Rendered over the art's top-right corner (a collection's remove-X).
  topRightOverlay?: React.ReactNode
  // Play this title. When there is somewhere to resume from, the caller
  // passes onResume instead and the button says so.
  onPlay?: (item: T) => void
  onResume?: () => void
  // Adds the runtime to the facts line.
  showLength?: boolean
  // Larger caption, for the children's presentation.
  size?: 'default' | 'large'
  // Load the art eagerly (the first cards of a rail above the fold).
  eager?: boolean
}

export interface CardMetaToken {
  kind: 'rating' | 'text'
  value: string
}

/** The facts line, as tokens: rating → year → runtime → genre, or the
 *  caller's subtitle alone. Never an empty token. Exported for tests. */
export function buildCardMeta(
  item: Pick<MediaLike, 'rating' | 'year' | 'genre' | 'duration'>,
  opts: { subtitle?: string; showLength?: boolean } = {},
): CardMetaToken[] {
  if (opts.subtitle) return [{ kind: 'text', value: opts.subtitle }]

  const tokens: CardMetaToken[] = []
  if (item.rating !== undefined && item.rating > 0) {
    tokens.push({ kind: 'rating', value: item.rating.toFixed(1) })
  }
  if (item.year !== undefined && item.year > 0) {
    tokens.push({ kind: 'text', value: String(item.year) })
  }
  if (opts.showLength && item.duration) {
    tokens.push({ kind: 'text', value: item.duration })
  }
  if (item.genre) tokens.push({ kind: 'text', value: item.genre })
  return tokens
}

/** How long a touch must rest on a card before it opens the menu. */
export const LONG_PRESS_MS = 500
/** How far a touch may drift and still count as a press, not a scroll. */
const LONG_PRESS_SLOP_PX = 10

const line = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const
function PlusSvg() {
  return <svg width={20} height={20} {...line}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
}
function CheckSvg({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} {...line}><polyline points="20 6 9 17 4 12" /></svg>
}
function PlaySvg() {
  return <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 3 20 12 6 21" /></svg>
}
function MoreSvg() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  )
}
function StarSvg() {
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}
function MovieSvg() {
  return (
    <svg width={32} height={32} {...line} className="text-ink-3">
      <rect x="2" y="2" width="20" height="20" rx="2.18" />
      <path d="M7 2v20M17 2v20M2 12h20" />
    </svg>
  )
}

function MediaCardCinemaInner<T extends MediaLike>({
  item, onSelect, onCardContext, libraryIds, onToggleLib,
  className = '', subtitle, aspect = 'poster', topRightOverlay, onPlay, onResume,
  showLength = false, size = 'default', eager = false,
}: MediaCardCinemaProps<T>) {
  const isInLib = !!libraryIds?.has(item.id)
  const landscapeStyle: CSSProperties | undefined =
    aspect === 'landscape' ? { aspectRatio: '16 / 9' } : undefined
  // Landscape cards prefer the wide backdrop; portrait cards use the poster.
  const wantedSrc = aspect === 'landscape' ? (item.backdrop ?? item.poster) : item.poster
  // The URL that failed, not a boolean: a recycled card that gets a new item
  // must try the new art, and a retry of the same broken URL must not loop.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const artSrc = wantedSrc && wantedSrc !== failedSrc ? wantedSrc : undefined
  // An image served from cache can be complete before React attaches onLoad.
  const markLoaded = (el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth > 0) el.setAttribute('data-loaded', '')
  }
  const metaTokens = buildCardMeta(item, { subtitle, showLength })
  const hasProgress = item.progress !== undefined && item.progress > 0
  const play = onResume ?? (onPlay ? () => onPlay(item) : undefined)
  const reasonId = useId()

  // Long press (touch only): a mouse has its own contextmenu event, and
  // Android fires one for a long press too, but iOS Safari does not, so a
  // timer does it there. When the timer opens the menu, the click that
  // follows the finger lifting must not also open the title.
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)
  const suppressClick = useRef(false)
  const cancelPress = () => {
    if (press.current) { window.clearTimeout(press.current.timer); press.current = null }
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    suppressClick.current = false
    if (!onCardContext || e.pointerType !== 'touch') return
    // A press that starts on one of the card's own buttons is that button's.
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
        onCardContext({ preventDefault() {}, clientX, clientY, detail: 1, currentTarget: el } as unknown as ReactMouseEvent, item)
      }, LONG_PRESS_MS),
    }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP_PX) cancelPress()
  }

  return (
    <div
      className={`media-card-cinema group ${size === 'large' ? 'is-large ' : ''}${className}`}
      onClick={() => {
        if (suppressClick.current) { suppressClick.current = false; return }
        onSelect(item)
      }}
      onContextMenu={onCardContext ? (e) => { cancelPress(); onCardContext(e, item) } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      role="button"
      tabIndex={0}
      // The menu is also the context-menu key's (Shift+F10 fires a
      // contextmenu event); announce it where there is one.
      aria-keyshortcuts={onCardContext ? 'Shift+F10' : undefined}
      // The whole card's name: title, year, the facts line, and whether it
      // is saved. Sighted users get the same from the caption.
      aria-label={[
        `${item.title}${item.year ? ` (${item.year})` : ''}`,
        metaTokens.length > 0
          ? metaTokens.map(t => (t.kind === 'rating' ? `rated ${t.value}` : t.value)).join(', ')
          : '',
        isInLib ? 'in My Library' : '',
      ].filter(Boolean).join(' — ')}
      aria-describedby={item.reason ? reasonId : undefined}
      // No text selection or image callout from a long press on the card.
      style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
      onKeyDown={(e) => {
        // Only when the card itself has focus: a nested button handles its
        // own Enter and Space.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(item)
        }
      }}
    >
      <div className="poster-wrap">
        {artSrc ? (
          <img
            // Keyed on the URL so a new item gets a fresh element, and with
            // it a fresh fade-in and error state.
            key={artSrc}
            src={artSrc}
            alt={item.title}
            draggable={false}
            className="poster-img"
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
            style={landscapeStyle}
            ref={markLoaded}
            onLoad={(e) => e.currentTarget.setAttribute('data-loaded', '')}
            onError={() => setFailedSrc(artSrc)}
          />
        ) : (
          <div className="poster-img poster-placeholder" style={landscapeStyle}>
            <MovieSvg />
          </div>
        )}

        {hasProgress && (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${Math.min(100, item.progress ?? 0)}%` }} />
          </div>
        )}

        {/* Play and Add are pointer conveniences and stay out of the tab
            order: the card itself opens the title, and More, which IS in the
            tab order, opens a menu that holds both. Two stops per card, not
            four. Each stops the click from also opening the title. */}
        {(play || onToggleLib || onCardContext) && (
          <div className={`card-actions${hasProgress ? ' has-progress' : ''}`}>
            {play && (
              <button
                type="button"
                tabIndex={-1}
                className="card-act card-act-play"
                aria-label={`${onResume ? 'Resume' : 'Play'} ${item.title}`}
                onClick={(e) => { e.stopPropagation(); play() }}
              >
                <PlaySvg />
              </button>
            )}
            {onToggleLib && (
              <button
                type="button"
                tabIndex={-1}
                className="card-act"
                aria-pressed={isInLib}
                aria-label={isInLib ? `Remove ${item.title} from My Library` : `Add ${item.title} to My Library`}
                title={isInLib ? 'In My Library' : 'Add to My Library'}
                onClick={(e) => { e.stopPropagation(); onToggleLib(item) }}
              >
                {isInLib ? <CheckSvg /> : <PlusSvg />}
              </button>
            )}
            {onCardContext && (
              <button
                type="button"
                className="card-act card-act-more"
                aria-haspopup="menu"
                aria-label={`More actions for ${item.title}`}
                onClick={(e) => { e.stopPropagation(); onCardContext(e, item) }}
              >
                <MoreSvg />
              </button>
            )}
          </div>
        )}

        {topRightOverlay}
      </div>

      <div className="card-caption">
        <div className="cc-title" title={item.title}>{item.title}</div>
        {(metaTokens.length > 0 || isInLib) && (
          <div className="co-meta">
            {/* The saved mark leads the row as a sibling of the tokens, so
                the tokens stay exactly one element each. */}
            {isInLib && <span className="co-saved" title="In My Library"><CheckSvg size={12} /></span>}
            {metaTokens.map((t, i) => (
              // One element per token, holding the separator that PRECEDES
              // it, so a token that wraps out of the one-line row takes its
              // own dot with it and none is left trailing.
              <span key={i} className="co-tok">
                {i > 0 && <span className="sep" aria-hidden="true">·</span>}
                {t.kind === 'rating' ? (
                  <span className="star"><StarSvg /> {t.value}</span>
                ) : (
                  <span className="co-txt">{t.value}</span>
                )}
              </span>
            ))}
          </div>
        )}
        {item.reason && <span id={reasonId} className="sr-only">{item.reason}</span>}
      </div>
    </div>
  )
}

// Memoised: a rail or grid re-renders on every hover-driven state change
// above it, and the card's props are stable between those. `memo` drops the
// generic, so the cast restores it for callers.
export const MediaCardCinema = memo(MediaCardCinemaInner) as typeof MediaCardCinemaInner
