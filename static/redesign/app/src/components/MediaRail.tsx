// MediaRail — glassy horizontal rail of <MediaCardCinema> cards, shared by
// HomeView (eager, in App) + BrowseView (lazy). Extracted from App.tsx
// (2026-06-17 app split, Phase 2.4) so the lazy BrowseView chunk can reuse it
// without reaching back into App. RailTint + railIconFor (title → {icon,tint}
// resolver) are module-private — only MediaRail uses them.
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
// 2026-05-27 — Per-rail icon + chip tint mapping. Each rail's title
// drives both the icon glyph and the chip color via railIconFor()
// (defined just below MediaRail). When the caller doesn't supply an
// `icon`/`tint` explicitly, MediaRail resolves them from the title;
// when nothing matches, defaults to the generic compass + purple chip.
// This keeps the dynamic Discover/anchor rails (AI-generated titles)
// working without per-rail wiring at every call site — but note that
// LLM-curated titles are exactly the ones MOST likely to drift from
// the prefix patterns in railIconFor, so the fallback exists for that
// case, not as a "rare exception."
type RailTint = 'purple' | 'teal' | 'amber' | 'pink' | 'rose' | 'indigo'

export function MediaRail({ title, items, onSelect, aspect = 'poster', onCardContext, libraryIds, onToggleLib, onSeeAll, icon, tint, resolveResume, subtitle, aiPick, showBadges, cardSubtitleFor }: {
  title: string
  items: Media[]
  onSelect: (m: Media) => void
  onPlay?: (m: Media) => void
  aspect?: 'poster' | 'landscape'
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
  // Optional Icon name for the decorative glyph next to the rail
  // title. When omitted, MediaRail resolves it from the title via
  // railIconFor() — covers all known rail titles + falls back to
  // 'compass' for unknown (dynamic AI-curated) ones. Explicit value
  // wins; this keeps test setups + future one-off rails easy to wire.
  icon?: string
  // Chip tint that overrides whatever railIconFor would pick from the
  // title. Same resolution rules as `icon`.
  tint?: RailTint
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
  // Resolve icon + tint. Caller-supplied value wins; otherwise look
  // up by title; otherwise the generic compass / purple chip.
  const resolved = railIconFor(title)
  const resolvedIcon = icon ?? resolved.icon
  const resolvedTint = tint ?? resolved.tint

  return (
    <section className="rail-container">
      {/* 2026-06-05 (Home redesign D) — header now supports a stacked
          title + subtitle and an inline "AI PICK" chip. When no subtitle
          is passed the title row layout is unchanged. */}
      <div className="rail-header">
        <span className="rail-icon" data-tint={resolvedTint}><Icon name={resolvedIcon} size={16} /></span>
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2.5">
            <h2 className="rail-title">{title}</h2>
            {aiPick && (
              <span className="inline-flex items-center gap-1 px-2 py-[2px] rounded-full bg-yellow-400/10 border border-yellow-400/30 text-yellow-300 text-[9.5px] font-bold tracking-[0.08em] uppercase">
                <Icon name="sparkle" size={10} className="text-yellow-300" /> AI Pick
              </span>
            )}
          </div>
          {subtitle && <span className="text-white/55 text-xs">{subtitle}</span>}
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
              // 2026-07-25 (Aurora Stage Phase 3) — 180→206 / 320→336. The
              // art is the card now (no text shelf below it), so the poster
              // carries the whole design and gets the room back.
              className={aspect === 'poster' ? 'w-[206px]' : 'w-[336px]'}
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

/* 2026-05-27 — Resolve a rail's icon + chip tint from its title. Title
 * is the ONLY consistent identity for a rail (some are constructed
 * inline at the call site; some come back from the API; some are
 * AI-generated). Matching on title prefix means a single map covers
 * static rails ("Continue Watching", "Top Rated Movies") AND dynamic
 * variants ("Top Rated Sci-Fi", "Because you watched Severance").
 *
 * Match order matters — more specific patterns first. Unknown titles
 * fall through to the generic compass + purple chip, which keeps the
 * current default behavior intact.
 *
 * Tints come from index.css :root tokens; adding a new tint = one CSS
 * block + one entry here. Keep the palette tight (current: 6 colors)
 * so the homepage doesn't turn into a Skittles ad. */
function railIconFor(title: string): { icon: string; tint: RailTint } {
  const t = title.trim().toLowerCase()

  // Continue Watching — purple clock. Only one rail uses this exact
  // title, but the prefix match defends against any future variant
  // (e.g. "Continue Watching (S2)").
  if (t.startsWith('continue watching')) return { icon: 'clock', tint: 'purple' }

  // Recently Added — teal sparkle. Fresh / new content cue.
  if (t.startsWith('recently added')) return { icon: 'sparkle', tint: 'teal' }

  // Top Rated — amber. Different glyph for movies vs shows so the
  // icon also signals the content type at a glance.
  if (t.startsWith('top rated movie')) return { icon: 'star', tint: 'amber' }
  if (t.startsWith('top rated show') || t.startsWith('top rated tv')) {
    return { icon: 'tv', tint: 'amber' }
  }
  // Catch-all for other "Top Rated ..." rails (e.g. "Top Rated Sci-Fi").
  if (t.startsWith('top rated')) return { icon: 'star', tint: 'amber' }

  // "Because you watched X" — anchor rails, pink heart for the
  // recommendation-by-affinity cue.
  if (t.startsWith('because you')) return { icon: 'heart', tint: 'pink' }

  // "Trending" — rose flame. Reserved for future "Trending Now" rail.
  if (t.startsWith('trending')) return { icon: 'zap', tint: 'rose' }

  // Discover / AI-curated rails. Catches "Discover" + "For You" +
  // server-stamped "Aurora …" rails (e.g. "Aurora Picks", "Aurora
  // Recommends").
  //
  // Deep-debug fix: narrowed from `t.includes('aurora')` to a prefix
  // match. A bare contains-check would mis-tint a future rail like
  // "Northern Aurora Nature Docs" (movie title surfaced via search /
  // genre rail) as Discover/indigo. Prefix is tight enough to catch
  // the intended product-named rails without grabbing movie titles.
  if (
    t.startsWith('discover') ||
    t.startsWith('for you') ||
    t.startsWith('aurora ')
  ) {
    return { icon: 'sparkle', tint: 'indigo' }
  }

  // Library / Saved — placeholder for future Library page rails.
  if (t.startsWith('saved') || t.startsWith('library') || t.startsWith('your library')) {
    return { icon: 'heart', tint: 'pink' }
  }

  // Unknown / dynamic genre rail → default compass + purple. Same
  // behavior as before the per-rail icon refactor.
  return { icon: 'compass', tint: 'purple' }
}
