// SearchView — debounced (300ms/keystroke) search results grid. Extracted
// from App.tsx (2026-06-17 app split, Phase 2.7) and lazy-loaded so the
// search bundle is fetched only on first /search nav. The semantic path is
// LLM-routed server-side; this view just debounces the query, calls
// searchMedia, and renders MediaCardCinema results. App owns the query
// string + library set and passes them as props. Shares Icon,
// MediaCardCinema, searchMedia, and the app-side Media type — no
// reach-back into App, and no dependency on UpdatePanel's ACTIVE_STATES /
// updateStateMeta / timeAgo (those stay with UpdatePanel in the admin chunk).

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/Icon'
import { PageHeader } from '@/components/PageHeader'
import { GridSkeleton } from '@/components/Skeletons'
import { MediaCardCinema } from '@/components/MediaCardCinema'
import { searchMedia } from '@/lib/api'
import { type Media } from '@/lib/types'

/* ─────────────────────── SEARCH VIEW ─────────────────────── */
// SearchView — debounced 300ms per keystroke (the semantic path is
// LLM-routed and not free).
export default function SearchView({ query, onSelect, libraryIds, onToggleLib }: {
  query: string
  onSelect: (m: Media) => void
  // 2028-05-28 (deep-debug Bug C) — dropped the dead `onPlay?` prop. The
  // cinema card has no hover Play CTA for it to attach to, and the
  // SearchView body never read it; leaving it in the type implied a
  // behavior that never fired. Call site must also drop `onPlay={handlePlay}`.
  // My Library + button — same contract as MediaRail / BrowseView.
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
}) {
  const [results, setResults] = useState<Media[]>([])
  // Driven by the server's X-Search-Mode response — only show the
  // Smart badge when semantic search actually fired.
  const [searchMode, setSearchMode] = useState<'literal' | 'semantic'>('literal')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Track the most-recent query the user typed so a late-resolving
  // response from a stale query doesn't overwrite the current results.
  const lastQueryRef = useRef<string>('')

  useEffect(() => {
    lastQueryRef.current = query
    setError(null)
    const q = query.trim()
    if (!q) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    const ac = new AbortController()
    const debounceId = window.setTimeout(() => {
      // Server-side: trigram + optional semantic routing. Endpoint
      // returns an array, not a paginated envelope.
      void (async () => {
        try {
          const r = await searchMedia(q, 30, ac.signal)
          // Ignore stale responses (debounce can let an old request
          // through if the user types fast).
          if (lastQueryRef.current !== q) return
          setResults(r.items as Media[])
          setSearchMode(r.mode)
        } catch (err) {
          if (err && (err as Error).name === 'AbortError') return
          if (lastQueryRef.current !== q) return
          setError(err instanceof Error ? err.message : 'Search failed')
          setResults([])
        } finally {
          if (lastQueryRef.current === q) setLoading(false)
        }
      })()
    }, 300)
    return () => {
      window.clearTimeout(debounceId)
      ac.abort()
    }
  }, [query])

  return (
    // data-search-results: lets TopNav's outside-click-to-close handler
    // exempt clicks on result cards (a page-level sibling, not a DOM
    // descendant of the search pill) from closing the search.
    <div className="animate-fade-in" data-search-results>
      <PageHeader
        // No eyebrow: every other page's kicker names a category the page
        // belongs to ("Curated", "Upcoming"). Search results aren't a
        // category, and a made-up one would be noise.
        title={
          <span className="inline-flex items-baseline gap-3 flex-wrap">
            Search Results
            {/* Smart chip renders only when the server actually used the
                semantic path — it is a statement about how the results were
                produced, so faking it on the lexical path would misreport. */}
            {!loading && results.length > 0 && searchMode === 'semantic' && (
              <span className="stage-smartchip inline-flex">
                <Icon name="sparkle" size={13} />
                Smart search
              </span>
            )}
          </span>
        }
        sub={
          // role="status" (implicit aria-live="polite"): the result count is
          // the entire feedback for a search, and without it a screen-reader
          // user types a query and hears nothing at all — no way to know
          // whether the search ran, found nothing, or is still going. The app
          // already uses this pattern in Toast and the player; the five content
          // views had none.
          //
          // aria-atomic so the whole sentence is re-read rather than just the
          // changed number, which otherwise announces as a bare "12".
          <span role="status" aria-live="polite" aria-atomic="true">
            {loading
              ? `Searching for "${query}"…`
              : query
                ? `${results.length} result${results.length === 1 ? '' : 's'} for "${query}"`
                : 'Type in the search box above to find titles'}
            {error && <span className="block text-red-400 mt-1">{error}</span>}
          </span>
        }
      />

      {loading && results.length === 0 ? (
        // First search (or a new query after an empty result): hold the
        // grid's shape. With results already on screen the previous grid
        // stays up until the new one lands, as before.
        <GridSkeleton />
      ) : !loading && query && results.length === 0 && !error ? (
        <div className="text-center py-20">
          <Icon name="search" size={48} className="mx-auto text-white/20 mb-4" />
          <h2 className="text-white/60 text-lg">No results found</h2>
          <p className="text-white/50 text-sm mt-1">Try a different search term</p>
        </div>
      ) : (
        // 2028-05-28 — Search results converted to <MediaCardCinema/>
        // for consistency with the rest of the app.
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
          {results.map(item => (
            <MediaCardCinema
              key={item.id}
              item={item}
              onSelect={onSelect}
              libraryIds={libraryIds}
              onToggleLib={onToggleLib}
            />
          ))}
        </div>
      )}
    </div>
  )
}
