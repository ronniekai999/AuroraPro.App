// BrowseView — Movies / TV Shows browse grid: hero, sort, genre filter,
// pagination, and a Continue Watching rail. Lazy-loaded (Phase 2.4 of the
// 2026-06-17 app split) so the browse experience leaves the main chunk. App
// keeps the data gate (list === null → <BrowseLoadingState/>) and wraps this
// view in <ViewSuspense fallback={<BrowseLoadingState/>}> so the chunk-load
// fallback is visually identical to the data-load fallback — no two-phase
// flash. BrowseSort is module-private.
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Icon } from '@/components/Icon'
import { HeroSection } from '@/components/HeroSection'
import { MediaRail } from '@/components/MediaRail'
import { MediaCardCinema } from '@/components/MediaCardCinema'
import { MediaListRow } from '@/components/MediaListRow'
import { isResumable } from '@/lib/format'
import { mapContinueToMedia, type ContinueWatchingItem } from '@/lib/api'
import { type Media } from '@/lib/types'

type BrowseSort = 'rating' | 'title' | 'year' | 'recent'
export default function BrowseView({
  items, title, subtitle, total, sortBy, onSortChange,
  genreFilter, onGenreChange, availableGenres,
  onLoadMore, isLoadingMore,
  onSelect, onPlay, onCardContext,
  libraryIds, onToggleLib,
  mediaType, continueItems, onPlayContinue,
}: {
  items: Media[]
  title: string
  subtitle: string
  // Real catalog count from the server (paginated total_items). When
  // null the page is still loading; fall back to items.length.
  total?: number | null
  // Sort is parent-controlled: changing it triggers a re-fetch from
  // page 1. Client-side sort is not safe across paginated loads
  // (later pages arrive in server-order and would concat after a
  // re-sorted page 1).
  sortBy: BrowseSort
  onSortChange: (s: BrowseSort) => void
  // Genre is ALSO parent-controlled (QA BUG-003) so it survives
  // the moviesList=null intermediate state on sort changes. Empty
  // string = "All Genres". Genre is now also server-side: changing
  // it clears items and re-fetches page 1, same lifecycle as sort.
  genreFilter: string
  onGenreChange: (g: string) => void
  // Canonical genre catalog from /api/media/genres. Stable across
  // pagination + sort changes so the dropdown never offers a filter
  // that returns zero results, and never hides a genre that exists
  // in the library but hasn't been paginated into view yet. Null
  // while loading.
  availableGenres: string[] | null
  // Load More — appends the next page. Button is rendered only
  // when items.length < total. While in flight isLoadingMore is
  // true so the button can disable + show a spinner.
  onLoadMore: () => void
  isLoadingMore: boolean
  onSelect: (m: Media) => void
  // 2026-05-31 (library hybrid redesign) — onPlay is back, but ONLY for
  // the hero's primary CTA (Play / Resume). The grid/list cards still
  // open detail on click (the established "click → detail → act"
  // language); they do NOT call onPlay. So unlike the pre-2028 prop this
  // one has a real, single consumer.
  onPlay: (m: Media) => void
  onCardContext?: (e: MouseEvent, m: Media) => void
  // My Library + button on cards. Same contract as MediaRail.
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
  // 2026-05-31 — 'movie' | 'show' so the hero eyebrow + Continue
  // Watching filter know which catalog this is. (title is display-only;
  // don't branch behavior on it.)
  mediaType: 'movie' | 'show'
  // Continue Watching records (App-level). BrowseView shows a CW rail
  // in grid view, filtered to this view's media type. Empty/absent just
  // hides the rail.
  continueItems?: ContinueWatchingItem[]
  onPlayContinue?: (c: ContinueWatchingItem) => void
}) {
  // Genre is now server-side (Batch A 2026-05-25). The server filters
  // + paginates against the FULL catalog, so `items.length` is already
  // the count of horror titles loaded so far and `total` is the real
  // horror catalog size — not "horror within the loaded page" which
  // was the previous bug (Top-Rated returned 3, A-Z returned 11 for
  // the same Horror filter because the loaded subsets differed).
  //
  // availableGenres comes from /api/media/genres and is stable
  // regardless of pagination. Falls back to deriving from items
  // while the genres fetch is in flight, so first paint isn't blocked.
  const genres = availableGenres && availableGenres.length > 0
    ? ['All Genres', ...availableGenres]
    : ['All Genres', ...Array.from(new Set(items.map(i => i.genre).filter(Boolean)))]

  // No client-side filter — items array already reflects the server's
  // (type + genre + sort) filter set.
  const filtered = items
  const hasMore = total != null && items.length < total
  const remaining = total != null ? Math.max(0, total - items.length) : 0

  // ── Density (Grid ⇄ List) ─────────────────────────────────────────
  // Persisted in localStorage, NOT React state alone: changing sort or
  // genre sets moviesList=null in the parent, which UNMOUNTS BrowseView
  // and would reset a plain useState back to 'grid' on every sort
  // change. A lazy initializer that reads localStorage on each mount
  // survives that remount. Writes happen in the toggle handler.
  const DENSITY_KEY = 'aurora.browse.density'
  const [density, setDensity] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem(DENSITY_KEY) === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })
  const changeDensity = (d: 'grid' | 'list') => {
    setDensity(d)
    try { localStorage.setItem(DENSITY_KEY, d) } catch { /* ignore quota/denied */ }
  }

  // ── Hero (featured) ───────────────────────────────────────────────
  // Feature top-rated titles that have a backdrop (same rule Home uses:
  // a missing backdrop makes a flat hero). Cap the pool so rotation
  // doesn't crawl the whole catalog. Only meaningful when sorted by
  // rating; under A-Z / Newest the "featured" pool is just the visible
  // order's backdrop-having items, which is still a reasonable showcase.
  const heroPool = useMemo(
    () => items.filter(m => m.backdrop && m.backdrop.length > 0).slice(0, 5),
    [items],
  )
  const [heroIdx, setHeroIdx] = useState(0)
  const [heroPaused, setHeroPaused] = useState(false)
  // Clamp index when the pool shrinks (e.g. genre change loads fewer
  // backdrop items) so we never index past the end.
  useEffect(() => {
    if (heroIdx >= heroPool.length && heroPool.length > 0) setHeroIdx(0)
  }, [heroPool.length, heroIdx])
  // Auto-advance every 9s (matches Home), paused on hover. Only when
  // there's more than one to rotate through.
  useEffect(() => {
    if (heroPool.length < 2 || heroPaused) return
    // 2026-06-17 (a11y quick-win) — respect prefers-reduced-motion: a
    // 9s crossfade that swaps the hero background + text mid-read is
    // problematic for low-vision users. Skip auto-rotation; the manual
    // hover-pause / "Not tonight" affordances still work.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const id = window.setInterval(() => {
      setHeroIdx(i => (i + 1) % heroPool.length)
    }, 9000)
    return () => window.clearInterval(id)
  }, [heroPool.length, heroPaused])
  const heroMedia = heroPool[heroIdx] ?? heroPool[0]
  // Resume bundle for the hero's CTA — if the featured title has a
  // resumable CW record, the hero shows "Resume …" instead of "Play".
  const heroResume = heroMedia && continueItems
    ? (() => {
        const match = continueItems.find(
          c => c.media_item_id === heroMedia.id && isResumable(c),
        )
        return match && onPlayContinue
          ? { item: match, onPlay: onPlayContinue }
          : undefined
      })()
    : undefined

  // ── Continue Watching rail (grid view only) ───────────────────────
  // Filter App-level CW records to THIS view's media type, dedupe by
  // media_item_id (a show with progress on several episodes surfaces
  // once), and map to the card's Media shape. Mirrors the Home rail.
  const cwRailItems = useMemo(() => {
    if (!continueItems || continueItems.length === 0) return []
    const seen = new Set<number>()
    return continueItems
      .filter(c => c.type === mediaType && isResumable(c))
      .filter(c => {
        if (seen.has(c.media_item_id)) return false
        seen.add(c.media_item_id)
        return true
      })
      .map(c => mapContinueToMedia(c) as Media)
  }, [continueItems, mediaType])
  // Deep-debug H3 (mirrored from HomeView) — the resume click must
  // resolve the match against the FRESHEST continueItems at click time,
  // not the render-time closure. Otherwise a mid-hover refresh (another
  // device advanced position_ms) could dispatch a stale record. Keep a
  // ref in sync and read it inside the click handler.
  const continueItemsRef = useRef(continueItems)
  useEffect(() => { continueItemsRef.current = continueItems }, [continueItems])
  // Click-time resolver for the CW rail's resume pills. Render-time
  // check decides whether to show a pill; click-time re-lookup (via the
  // ref) dispatches against the latest data.
  const cwResolveResume = (m: Media) => {
    if (!continueItems || !onPlayContinue) return undefined
    if (!continueItems.some(c => c.media_item_id === m.id && isResumable(c))) {
      return undefined
    }
    return () => {
      const latest = continueItemsRef.current
      if (!latest) return
      const match = latest.find(
        c => c.media_item_id === m.id && isResumable(c),
      )
      if (match) onPlayContinue(match)
    }
  }

  // Phase 5.3 final QA — pill identifier above the page headline.
  // "TV Shows" and "Movies" pages both use the same pattern. Built
  // from the page title for now; could be derived from view if we
  // grow more browse pages.
  const pillLabel = title === 'TV Shows' ? 'BROWSE SERIES' : title === 'Movies' ? 'BROWSE FILMS' : 'BROWSE'
  // Count label fragment, reused under the title in both densities.
  const countLabel = total != null && total > items.length ? (
    <>
      Showing {items.length.toLocaleString()} of{' '}
      <span className="text-white/90 font-medium">{total.toLocaleString()}</span>
      {genreFilter && genreFilter !== 'All Genres' ? ` ${genreFilter}` : ''} title{total === 1 ? '' : 's'}
    </>
  ) : (
    <>
      <span className="text-white/90 font-medium">{(total ?? items.length).toLocaleString()}</span>
      {genreFilter && genreFilter !== 'All Genres' ? ` ${genreFilter}` : ''} title{(total ?? items.length) === 1 ? '' : 's'}
    </>
  )

  return (
    <div className="animate-fade-in relative">
      {/* ── Hero (featured) ──────────────────────────────────────────
          Reuses the same HeroSection component the Home view uses, so
          the look + parallax + rotation behave identically. We only
          mount it once there's at least one backdrop-bearing title;
          otherwise the page goes straight to the toolbar (no empty
          hero). The hero's primary CTA plays (or resumes) via the
          threaded handlers; "More Info" opens detail. */}
      {heroMedia && (
        <HeroSection
          hero={heroMedia}
          onPlay={onPlay}
          onInfo={onSelect}
          onPauseChange={setHeroPaused}
          resume={heroResume}
        />
      )}

      {/* Edgeless header glow — only when there's no hero (the hero
          already paints its own gradient floor; doubling them muddies
          the top of the page). */}
      {!heroMedia && (
        <div
          aria-hidden="true"
          // Negative insets track --page-gutter so the glow still reaches
          // the page edges. They were -8 (32px) to cancel the old global
          // p-8 exactly; after the Phase 2 shell change the gutter is 48px
          // and the glow silently stopped 16px short on each side, which is
          // the one thing an "edgeless" glow must not do.
          className="absolute -top-[var(--page-gutter)] -left-[var(--page-gutter)] -right-[var(--page-gutter)] h-[360px] pointer-events-none overflow-hidden"
        >
          <div className="absolute -top-32 right-0 w-[600px] h-[600px] rounded-full bg-purple-500/[0.08] blur-3xl" />
          <div className="absolute top-20 -right-20 w-[400px] h-[400px] rounded-full bg-fuchsia-500/[0.05] blur-3xl" />
        </div>
      )}

      {/* Page title + count */}
      <div className="relative mb-5">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 mb-3">
          <Icon name={mediaType === 'show' ? 'tv' : 'film'} size={12} className="text-purple-300" />
          <span className="text-purple-200 text-xs font-medium uppercase tracking-wider">{pillLabel}</span>
        </div>
        <h1 className="text-white text-4xl font-bold font-display">{title}</h1>
        <p className="text-white/60 text-sm mt-2">
          {subtitle}
          <span className="text-white/30 mx-1.5">•</span>
          {countLabel}
        </p>
      </div>

      {/* ── Toolbar: genre chips · density toggle · sort ─────────────
          In-flow (not sticky): the app's top header is itself sticky
          with a DYNAMIC height (the admin ScanProgressBar appears and
          disappears), so a fixed sticky offset here would gap/overlap.
          Sticky is a clean follow-up once that header exposes a stable
          height. */}
      <div className="browse-toolbar relative mb-6 flex items-center gap-3 flex-wrap">
        {/* Genre chips — replaces the old <select>. Horizontally
            scrollable so a long genre list never wraps into a tall
            block. "All Genres" maps to the empty-string filter the
            server expects. */}
        <div className="genre-chips flex items-center gap-2 overflow-x-auto flex-1 min-w-0 pb-1">
          {genres.map(g => {
            const value = g === 'All Genres' ? '' : g
            const active = genreFilter === value || (g === 'All Genres' && !genreFilter)
            return (
              <button
                key={g}
                type="button"
                onClick={() => onGenreChange(value)}
                className={`genre-chip ${active ? 'is-active' : ''}`}
                aria-pressed={active}
              >
                {g}
              </button>
            )
          })}
        </div>

        {/* Density toggle (Grid ⇄ List) */}
        <div className="density-toggle flex items-center gap-1 flex-none" role="group" aria-label="View density">
          <button
            type="button"
            onClick={() => changeDensity('grid')}
            className={`density-btn ${density === 'grid' ? 'is-active' : ''}`}
            aria-pressed={density === 'grid'}
            aria-label="Grid view"
            title="Grid view"
          >
            <Icon name="grid" size={16} />
          </button>
          <button
            type="button"
            onClick={() => changeDensity('list')}
            className={`density-btn ${density === 'list' ? 'is-active' : ''}`}
            aria-pressed={density === 'list'}
            aria-label="List view"
            title="List view"
          >
            <Icon name="list" size={16} />
          </button>
        </div>

        {/* Sort — kept as a native select (accessible, compact). */}
        <div className="flex items-center gap-2 flex-none">
          <span className="text-white/40 text-sm">Sort</span>
          <select
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value as BrowseSort)}
            className="text-sm py-2 px-3"
            aria-label="Sort titles"
          >
            <option value="rating">Top Rated</option>
            <option value="year">Newest</option>
            <option value="title">A-Z</option>
            <option value="recent">Recently Added</option>
          </select>
        </div>
      </div>

      {/* ── Continue Watching rail (grid view only) ──────────────────
          Hidden in list view (which is the lean, no-chrome density
          mode) and when there's nothing in progress for this type. */}
      {density === 'grid' && cwRailItems.length > 0 && (
        <MediaRail
          title="Continue Watching"
          items={cwRailItems}
          onSelect={onSelect}
          aspect="poster"
          onCardContext={onCardContext}
          libraryIds={libraryIds}
          onToggleLib={onToggleLib}
          resolveResume={cwResolveResume}
        />
      )}

      {/* ── Body: grid OR list ───────────────────────────────────────
          Grid uses the shared cinema card with the browse-only
          enrichments (length in meta, quality/maturity badges, hover
          preview). List uses MediaListRow for a dense, scannable
          table. */}
      {density === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
          {filtered.map((item) => (
            <MediaCardCinema
              key={item.id}
              item={item}
              onSelect={() => onSelect(item)}
              onCardContext={onCardContext ? (e) => onCardContext(e, item) : undefined}
              libraryIds={libraryIds}
              onToggleLib={onToggleLib ? () => onToggleLib(item) : undefined}
              showLength
              showBadges
              hoverPreview
            />
          ))}
        </div>
      ) : (
        // Visually-tabular list of clickable rows. Deliberately NOT
        // role="table": the rows are buttons (click → detail), and a
        // table whose rows are buttons is a broken a11y tree. The header
        // is decorative (aria-hidden) — each row carries its own
        // accessible name via the row's title + the +/✓ button's
        // aria-label.
        <div className="media-list">
          <div className="media-list-head" aria-hidden="true">
            <span>Title</span>
            <span>Genre</span>
            <span>Length</span>
            <span>Year</span>
            <span>Rating</span>
            <span />
          </div>
          {filtered.map((item) => (
            <MediaListRow
              key={item.id}
              item={item}
              onSelect={() => onSelect(item)}
              onCardContext={onCardContext ? (e) => onCardContext(e, item) : undefined}
              libraryIds={libraryIds}
              onToggleLib={onToggleLib ? () => onToggleLib(item) : undefined}
            />
          ))}
        </div>
      )}

      {/* Load More — Server caps per_page at 100, so a 2,394-item
          library needs 24 clicks to see every poster. Acceptable
          for now; future iteration could swap for infinite-scroll
          with IntersectionObserver if users ask for it. Button
          shows "Load 100 more (1,294 remaining)" so the user knows
          the cadence + scope.

          With server-side genre filtering, Load More works the same
          whether a genre is selected or not — paginating the filtered
          set instead of the full library. The "filtering loaded titles
          only" banner is gone; counts and pagination now reflect the
          real (type + genre) catalog. */}
      {hasMore && (
        <div className="mt-10 flex flex-col items-center gap-2">
          <button
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="px-6 py-3 rounded-full bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/30 text-purple-100 text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {isLoadingMore ? (
              <>
                <span className="w-3 h-3 rounded-full border-2 border-purple-300 border-t-transparent animate-spin" />
                Loading…
              </>
            ) : (
              <>Load {Math.min(100, remaining).toLocaleString()} more</>
            )}
          </button>
          <p className="text-white/40 text-xs">
            {remaining.toLocaleString()} title{remaining === 1 ? '' : 's'} remaining
          </p>
        </div>
      )}
    </div>
  )
}
