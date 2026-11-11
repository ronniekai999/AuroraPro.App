// MediaRail — a titled horizontal row of <MediaCardCinema> cards, shared by
// Tonight (eager, in App) and the lazy views. Its own module so a lazy view
// can import it without pulling in App; the app keeps one copy either way.
//
// A rail's header is its title. When the rail has somewhere to "see all",
// the title itself is that link. Under it sits at most one line: a plain
// subtitle, or, for a rail the recommender built, the AI attribution (the
// aurora dot and "Picked by Aurora", with the rail's reason after it). The
// attribution is said once here, not on every card.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { Icon } from '@/components/Icon'
import { MediaCardCinema } from '@/components/MediaCardCinema'
import { type Media } from '@/lib/types'

/** Card widths and the gap between cards, in px. The poster step is the
 *  page-scroll unit; the CSS (`.rail-scroll`'s gap, the card's width
 *  classes below) holds the same numbers. */
const RAIL = {
  poster: { card: 176, art: 264, cls: 'w-[176px]' },
  landscape: { card: 256, art: 144, cls: 'w-[256px]' },
  large: { card: 232, art: 348, cls: 'w-[232px]' },
  gap: 20,
} as const

export function MediaRail({ title, items, onSelect, onPlay, aspect = 'poster', onCardContext, libraryIds, onToggleLib, onSeeAll, resumableIds, subtitle, aiPick, cardSubtitleFor, eagerCount = 0, size = 'default' }: {
  title: string
  items: Media[]
  onSelect: (m: Media) => void
  // Play a card's title from its hover Play button. The handler resumes
  // when the viewer has a position in the title; resumableIds says which
  // cards that is, so their button reads "Resume".
  onPlay?: (m: Media) => void
  resumableIds?: Set<number>
  aspect?: 'poster' | 'landscape'
  // How many leading cards load their art eagerly (a rail at the fold).
  eagerCount?: number
  // One line under the title. With aiPick it follows "Picked by Aurora".
  subtitle?: string
  // The recommender built this rail: its header carries the attribution.
  aiPick?: boolean
  // Per-card facts line override (Continue Watching's "S2E5 · 23m left").
  cardSubtitleFor?: (m: Media) => string | undefined
  // The card menu (right click, More, a long press). Required: it is the
  // only way a keyboard or a touch screen adds, removes or resumes.
  onCardContext: (e: MouseEvent, m: Media) => void
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
  // Makes the title a link to the rail's full list.
  onSeeAll?: () => void
  // 'large': bigger posters and captions (the children's presentation).
  size?: 'default' | 'large'
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)
  // The paddles and edge fades follow how far the row can still scroll.
  const updatePaddles = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setCanLeft(el.scrollLeft > 2)
    setCanRight(el.scrollLeft < max - 2)
  }, [])
  useLayoutEffect(() => {
    updatePaddles()
  }, [items, updatePaddles])
  useEffect(() => {
    window.addEventListener('resize', updatePaddles)
    return () => window.removeEventListener('resize', updatePaddles)
  }, [updatePaddles])

  const titleId = useId()
  const dims = aspect === 'landscape' ? RAIL.landscape : size === 'large' ? RAIL.large : RAIL.poster
  // A page is as many whole cards as fit in 90% of the row.
  const page = (dir: -1 | 1) => {
    const el = scrollRef.current
    if (!el) return
    const step = dims.card + RAIL.gap
    const cards = Math.max(1, Math.floor((el.clientWidth * 0.9) / step))
    el.scrollBy({ left: dir * cards * step, behavior: 'smooth' })
  }

  return (
    // Named by its own heading, so the rail is one landmark with one name,
    // not a label that repeats the h2 beside it.
    <section className="rail-container" aria-labelledby={titleId}>
      <div className="rail-header">
        <h2 className="rail-title" id={titleId}>
          {onSeeAll ? (
            <button type="button" onClick={onSeeAll} className="rail-see-all" aria-label={`${title}, see all`}>
              <span>{title}</span>
              <Icon name="chevronRight" size={18} className="rail-chev" />
            </button>
          ) : title}
        </h2>
        {(aiPick || subtitle) && (
          <p className="rail-sub">
            {aiPick && <span className="rail-dot" aria-hidden="true" />}
            <span className="rail-sub-text">
              {aiPick ? (subtitle ? `Picked by Aurora: ${subtitle}` : 'Picked by Aurora') : subtitle}
            </span>
          </p>
        )}
      </div>
      <div
        className="rail-scroll-wrap"
        data-can-left={canLeft || undefined}
        data-can-right={canRight || undefined}
        style={{ '--rail-art-h': `${dims.art}px` } as React.CSSProperties}
      >
        {canLeft && (
          <button type="button" className="rail-paddle rail-paddle-left" aria-label={`Scroll ${title} rail left`} onClick={() => page(-1)}>
            <Icon name="chevronLeft" size={20} />
          </button>
        )}
        <div ref={scrollRef} className="rail-scroll scrollbar-hide" onScroll={updatePaddles}>
          {items.map((item, idx) => (
            <MediaCardCinema
              key={item.id}
              item={item}
              eager={idx < eagerCount}
              onSelect={onSelect}
              onPlay={onPlay}
              onCardContext={onCardContext}
              libraryIds={libraryIds}
              onToggleLib={onToggleLib}
              className={dims.cls}
              aspect={aspect}
              size={size}
              resumable={resumableIds?.has(item.id)}
              subtitle={cardSubtitleFor?.(item)}
            />
          ))}
        </div>
        {canRight && (
          <button type="button" className="rail-paddle rail-paddle-right" aria-label={`Scroll ${title} rail right`} onClick={() => page(1)}>
            <Icon name="chevronRight" size={20} />
          </button>
        )}
      </div>
    </section>
  )
}
