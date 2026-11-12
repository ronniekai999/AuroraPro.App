// BrowseView — the body of a Library grid (Movies, TV Shows): the titles, as
// comfortable posters, compact posters or a list, and "Load more". Its
// header (the scope names, the count, the sort, the layout, the genres) is
// LibraryHeader's, which App renders above it so it stays put while the grid
// reloads. A browse page has no featured band (the hero is Tonight's alone)
// and no Continue Watching rail (that is Tonight's too): its first screen is
// its grid.
//
// Lazy-loaded. App keeps the data gate (list === null → <BrowseLoadingState/>)
// and wraps this view in <ViewSuspense fallback={<BrowseLoadingState/>}> so
// the chunk-load fallback is the data-load fallback.
import { type MouseEvent } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { MediaCardCinema } from '@/components/MediaCardCinema'
import { MediaListRow, type RowProgress } from '@/components/MediaListRow'
import { type BrowseLayout } from '@/lib/browseLayout'
import { type Media } from '@/lib/types'

export default function BrowseView({
  items, total, layout,
  onLoadMore, isLoadingMore,
  onSelect, onCardContext, onCardPlay, resumableIds, progressById,
  libraryIds, onToggleLib,
}: {
  items: Media[]
  // Real catalog count from the server (paginated total_items). When
  // null the page is still loading; fall back to items.length.
  total?: number | null
  // Comfortable posters, compact posters, or a list. App owns the choice
  // (it is the header's control) and resolves the default by library size.
  layout: BrowseLayout
  // Load More — appends the next page. Button is rendered only
  // when items.length < total. While in flight isLoadingMore is
  // true so the button can disable + show a spinner.
  onLoadMore: () => void
  isLoadingMore: boolean
  onSelect: (m: Media) => void
  // The card menu. Required: see MediaCardCinema.
  onCardContext: (e: MouseEvent, m: Media) => void
  // A card's on-poster Play: resumes when the viewer has a position in the
  // title (App decides); resumableIds says which cards that is.
  onCardPlay: (m: Media) => void
  resumableIds?: Set<number>
  // The list's "Where you are" column: the viewer's place in each title
  // they have started.
  progressById?: Map<number, RowProgress>
  // My Library + button on cards. Same contract as MediaRail.
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
}) {
  // No client-side sort or filter: the items already reflect the server's
  // (type + genre + sort) set, and a client-side sort would be wrong across
  // paginated loads (later pages arrive in server order).
  const hasMore = total != null && items.length < total
  const remaining = total != null ? Math.max(0, total - items.length) : 0

  return (
    <div className="animate-fade-in relative">
      <div className="stage-gutter pt-6">
      {/* ── Body: grid OR list ───────────────────────────────────────
          The shared card. Comfortable: its facts line with the runtime.
          Compact: more, smaller posters, and under each the year with its
          quality and content rating as chips, which is what a person
          scanning a thousand films is choosing by. List: MediaListRow, a
          table of them: genre, length, year, content rating, score and,
          for a title the viewer has started, where they are in it. */}
      {layout !== 'list' ? (
        <div className={layout === 'compact' ? 'poster-grid is-compact' : 'poster-grid'} data-browse-layout={layout}>
          {items.map((item) => (
            <MediaCardCinema
              key={item.id}
              item={item}
              onSelect={onSelect}
              onCardContext={onCardContext}
              libraryIds={libraryIds}
              onToggleLib={onToggleLib}
              onPlay={onCardPlay}
              resumable={resumableIds?.has(item.id)}
              showLength={layout === 'comfortable'}
              compact={layout === 'compact'}
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
        <div className="media-list" data-browse-layout="list">
          <div className="media-list-head" aria-hidden="true">
            <span>Title</span>
            <span>Genre</span>
            <span>Length</span>
            <span>Year</span>
            <span>Rating</span>
            <span>Score</span>
            <span>Where you are</span>
            <span />
          </div>
          {items.map((item) => (
            <MediaListRow
              key={item.id}
              item={item}
              onSelect={() => onSelect(item)}
              onCardContext={(e) => onCardContext(e, item)}
              libraryIds={libraryIds}
              onToggleLib={onToggleLib ? () => onToggleLib(item) : undefined}
              progress={progressById?.get(item.id)}
              onPlay={() => onCardPlay(item)}
              resumable={resumableIds?.has(item.id)}
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
            type="button"
            onClick={onLoadMore}
            disabled={isLoadingMore}
            // The shared button family (.stage-btn, index.css) rather than
            // a bespoke pill: same height, radius, hover and disabled
            // treatment as the other ghost CTAs.
            className="stage-btn stage-btn-pill stage-btn-ghost"
          >
            {isLoadingMore ? (
              <>
                {/* The button's own text is the announcement; the glyph
                    is decorative here, so the Spinner's role="status" is
                    overridden to keep it out of the accessibility tree. */}
                <Spinner className="size-3.5 text-ink" role="presentation" aria-hidden="true" aria-label={undefined} />
                Loading…
              </>
            ) : (
              <>Load {Math.min(100, remaining).toLocaleString()} more</>
            )}
          </button>
          <p className="text-white/50 text-xs">
            {remaining.toLocaleString()} title{remaining === 1 ? '' : 's'} remaining
          </p>
        </div>
      )}
      {/* .stage-page used to supply 70px of bottom padding; .stage-gutter is
          left/right only, so browse needs the same trailing spacer Home has
          or the last poster row touches the viewport bottom. */}
      <div className="h-16" />
      </div>{/* /stage-gutter */}
    </div>
  )
}
