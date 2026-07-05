// MediaRail — a catalogue shelf of <MediaCardCinema> cards, shared by
// HomeView (eager, in App) + BrowseView (lazy). Extracted from App.tsx
// (2026-06-17 app split, Phase 2.4) so the lazy BrowseView chunk can reuse it
// without reaching back into App.
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { Icon } from '@/components/Icon'
import { MediaCardCinema } from '@/components/MediaCardCinema'
import { type Media } from '@/lib/types'

// onPlay is still accepted for backward compatibility with callers
// (HomeView etc.) but the new cinema card design no longer renders a
// hover-only Play CTA — clicking the card opens detail where Play
// is the primary CTA. Keeping the prop in the type avoids touching
// every call site; ignoring it via destructure-rest avoids the
// unused-var lint.
// (The 2026-05-27 per-rail icon/tint resolver — railIconFor + RailTint —
// was retired in the Catalogue redesign, phases 2+3 review: the tint CSS
// became a no-op in phase 1, home rails lead with a SHELF number instead
// of an icon chip, and no caller passed icon/tint. Title prefixes no
// longer drive any visual.)

export function MediaRail({ title, items, onSelect, aspect = 'poster', onCardContext, libraryIds, onToggleLib, onSeeAll, resolveResume, subtitle, aiPick, showBadges, cardSubtitleFor, index }: {
  title: string
  items: Media[]
  onSelect: (m: Media) => void
  onPlay?: (m: Media) => void
  aspect?: 'poster' | 'landscape'
  // Catalogue Edition — zero-based shelf position. When provided, the
  // header leads with a red "SHELF NN" catalogue number instead of the
  // icon chip (the numbering mirrors on-page order, like the proposal's
  // shelf marks). Rails without it keep the icon.
  index?: number
  // 2026-06-05 (Home redesign D) — optional one-line "why it's here"
  // subtitle under the rail title, and an "✨ AI PICK" chip beside the
  // title for recommender-driven rails (discover / anchor). Both are
  // additive: rails that don't pass them render exactly as before.
  subtitle?: string
  aiPick?: boolean
  // Forward MediaCardCinema's quality/maturity badge opt-in so Home
  // rail cards can show 4K/HDR chips (the mockup shows them).
  showBadges?: boolean
  // 2026-06-05 (Home redesign C) — per-card subtitle resolver (e.g. the
  // Continue Watching "S2E4 · 23m left" line). Returns undefined to keep
  // the default star/year/genre meta for that card.
  cardSubtitleFor?: (m: Media) => string | undefined
  // 2026-05-27 — Per-card resume resolver. Caller passes a function
  // that returns a click handler when the item has a Continue
  // Watching match worth resuming (caller decides — typically only
  // wired for the Continue Watching rail so partial-watches on
  // other rails don't sprout resume pills). MediaRail invokes this
  // per-card and forwards the result to MediaCardCinema's onResume.
  resolveResume?: (m: Media) => (() => void) | undefined
  // Phase 5.2 parity — right-click on a card opens the context
  // menu (Mark Watched / Clear Progress / Add to Watchlist /
  // Refresh Metadata for admins).
  onCardContext?: (e: MouseEvent, m: Media) => void
  // My Library — set of IDs currently saved by the user. When passed
  // with onToggleLib, each card renders a top-left + button (purple ✓
  // when already in the library). Optional so existing callers that
  // don't care about library state stay unchanged.
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
  // QA 2026-05-25 — "See All" was a non-functional button (no onClick)
  // that the QA report flagged as misleading because clicking it did
  // nothing (and felt like a scroll glitch since the rail itself
  // scrolls horizontally when you drag). Now: optional callback;
  // when supplied the button is shown and clickable, when not the
  // button is hidden entirely. AI-curated rails (no dedicated page
  // for them) skip it; "Top Rated Movies" etc. wire it to navigate
  // to the right browse view with the matching sort.
  onSeeAll?: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Chevron paddles — the rail hides its scrollbar (.scrollbar-hide), so
  // without these a plain-mouse user can only ever see the first
  // viewport-width of cards: the vertical wheel scrolls the page and
  // there is no other affordance. Hover/focus reveals a paddle per
  // scrollable direction; each pages by ~90% of the visible width.
  // Two primitive booleans (not one object) so React's built-in Object.is
  // bail-out skips the re-render when neither edge changed — no hand-rolled
  // equality check to keep in sync as the handler fires every scroll frame.
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)
  const updatePaddles = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    // 2px slop — fractional scroll positions on zoomed/hidpi layouts
    // never quite reach the exact max.
    setCanLeft(el.scrollLeft > 2)
    setCanRight(el.scrollLeft < max - 2)
  }, [])
  useEffect(() => {
    updatePaddles()
    window.addEventListener('resize', updatePaddles)
    return () => window.removeEventListener('resize', updatePaddles)
  }, [items, updatePaddles])
  const page = (dir: -1 | 1) => {
    const el = scrollRef.current
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: 'smooth' })
  }
  return (
    <section className="rail-container">
      {/* 2026-06-05 (Home redesign D) — header now supports a stacked
          title + subtitle and an inline "AI PICK" chip. When no subtitle
          is passed the title row layout is unchanged. */}
      <div className="rail-header">
        {index != null && (
          <span className="cat-label cat-label--red shrink-0">Shelf {String(index + 1).padStart(2, '0')}</span>
        )}
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2.5">
            <h2 className="rail-title">{title}</h2>
            {aiPick && (
              // Catalogue stamp — the old yellow-on-glass chip was
              // illegible on the paper ground (phase-1 review finding).
              <span className="stamp stamp--red inline-flex items-center gap-1">
                <Icon name="sparkle" size={10} /> AI Pick
              </span>
            )}
          </div>
          {subtitle && <span className="text-[var(--ink-2)] text-xs">{subtitle}</span>}
        </div>
        <span className="rail-spacer" aria-hidden="true" />
        {onSeeAll && (
          <button onClick={onSeeAll} className="rail-see-all">
            See All <Icon name="chevronRight" size={14} />
          </button>
        )}
      </div>
      <div className="rail-scroll-wrap">
        {canLeft && (
          <button
            type="button"
            className="rail-paddle rail-paddle-left"
            aria-label={`Scroll ${title} rail left`}
            onClick={() => page(-1)}
          >
            <Icon name="chevronLeft" size={18} />
          </button>
        )}
        <div ref={scrollRef} className="rail-scroll scrollbar-hide" onScroll={updatePaddles}>
          {items.map((item) => (
            <MediaCardCinema
              key={item.id}
              item={item}
              onSelect={() => onSelect(item)}
              onCardContext={onCardContext ? (e) => onCardContext(e, item) : undefined}
              libraryIds={libraryIds}
              onToggleLib={onToggleLib ? () => onToggleLib(item) : undefined}
              className={aspect === 'poster' ? 'w-[180px]' : 'w-[320px]'}
              aspect={aspect}
              onResume={resolveResume?.(item)}
              showBadges={showBadges}
              subtitle={cardSubtitleFor?.(item)}
            />
          ))}
        </div>
        {canRight && (
          <button
            type="button"
            className="rail-paddle rail-paddle-right"
            aria-label={`Scroll ${title} rail right`}
            onClick={() => page(1)}
          >
            <Icon name="chevronRight" size={18} />
          </button>
        )}
      </div>
    </section>
  )
}


