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
    <div className="animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-white text-3xl font-bold font-display">Search Results</h1>
          {/* Smart badge renders only when the server actually used
              the semantic path. */}
          {!loading && results.length > 0 && searchMode === 'semantic' && (
            <span className="px-3 py-1 rounded-full bg-purple-500/15 border border-purple-500/30 text-purple-200 text-xs font-medium">
              ✨ Smart search
            </span>
          )}
        </div>
        <p className="text-white/50 text-sm mt-1">
          {loading
            ? `Searching for "${query}"…`
            : query
              ? `${results.length} result${results.length === 1 ? '' : 's'} for "${query}"`
              : 'Type in the search box above to find titles'}
        </p>
        {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
      </div>

      {!loading && query && results.length === 0 && !error ? (
        <div className="text-center py-20">
          <Icon name="search" size={48} className="mx-auto text-white/20 mb-4" />
          <h3 className="text-white/60 text-lg">No results found</h3>
          <p className="text-white/40 text-sm mt-1">Try a different search term</p>
        </div>
      ) : (
        // 2028-05-28 — Search results converted to <MediaCardCinema/>
        // for consistency with the rest of the app.
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
          {results.map(item => (
            <MediaCardCinema
              key={item.id}
              item={item}
              onSelect={() => onSelect(item)}
              libraryIds={libraryIds}
              onToggleLib={onToggleLib ? () => onToggleLib(item) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}
