// SearchRequest: where a search that finds nothing in the library ends.
// The words are looked up outside the library (the server asks TMDB), and
// each match can be asked for where it stands. Requesting has no tab and no
// composer of its own: it is this list, on the search page, shown when a
// search comes up empty, and on request ("Not here? Request a title") when
// it did not.
//
// What the rows can say is what the routes return. A match (GET
// /api/requests/search) is a kind, a title, a year, a poster and an
// overview: no genre names and no season count. What has been asked for
// already is the caller's own list (GET /api/requests), which holds other
// members' requests only for a session with the admin powers; the server
// refuses a second active request for a title from the same account and
// says so. How many requests an account may have open is a server setting
// no member route returns, so no count is drawn: past the limit the server
// holds a request for an admin, and the row says so when it happens.

import { useEffect, useState } from 'react'
import {
  createRequest,
  getRequestsConfig,
  listRequests,
  searchTmdb,
  tmdbPosterURL,
  type MediaRequest,
  type RequestsConfig,
  type TmdbSearchResult,
} from '@/lib/api'

const keyOf = (r: { media_type: string; tmdb_id: number }) => `${r.media_type}:${r.tmdb_id}`

/** The letter a title is filed under, for the tile that stands in for a
 *  poster: its first, past a leading article ("The Glass Orchard" is G). */
const initialOf = (title: string) => title.trim().replace(/^(the|a|an)\s+/i, '').charAt(0).toUpperCase()

/** What a request's status means to the person who asked. */
const STATUS_SAYS: Record<MediaRequest['status'], string> = {
  pending: 'sent, nothing found yet',
  pending_approval: 'waiting for an admin to approve it',
  processing: 'being fetched',
  available: 'in the library now',
  failed: 'it could not be fetched',
}

/** A refusal in words: the server's reasons that a person can act on, and
 *  one sentence for the rest. Never a status code. */
function refusalSays(err: unknown): string {
  const raw = err instanceof Error ? err.message.toLowerCase() : ''
  if (raw.includes('already have an active request')) return 'You have already asked for this one.'
  if (raw.includes('not configured')) return 'This server is not set up to fetch this kind of title.'
  return 'The request could not be sent. Try again in a moment.'
}

export function SearchRequest({ query, userId, onRequested, onOpenRequests }: {
  /** The words, as searched for. */
  query: string
  userId: number
  /** A request was made: the app's own list and its toast. */
  onRequested: (r: MediaRequest) => void
  /** "See my requests". */
  onOpenRequests: () => void
}) {
  const [config, setConfig] = useState<RequestsConfig | null>(null)
  // Whether the question "does this server take requests" has been answered
  // (or could not be): nothing is looked up before it has.
  const [configAsked, setConfigAsked] = useState(false)
  const [mine, setMine] = useState<MediaRequest[]>([])
  // Read once: whether this server takes requests at all (and of which
  // kind), and what has been asked for already. Either failing leaves the
  // list as it would be without it; the server still refuses what it must.
  useEffect(() => {
    const ac = new AbortController()
    getRequestsConfig(ac.signal)
      .then(c => { if (!ac.signal.aborted) setConfig(c) })
      .catch(() => {})
      .finally(() => { if (!ac.signal.aborted) setConfigAsked(true) })
    listRequests(ac.signal).then(r => { if (!ac.signal.aborted) setMine(r) }).catch(() => {})
    return () => ac.abort()
  }, [])

  // The lookup, after a pause in the typing (a search field is being typed
  // in above this, and each lookup is a call the server makes to TMDB).
  const [found, setFound] = useState<{ query: string; items: TmdbSearchResult[] } | null>(null)
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const [again, setAgain] = useState(0)
  const off = config !== null && !config.enabled
  useEffect(() => {
    // A server that takes no requests is not asked what could be requested.
    if (!configAsked || off) return
    const ac = new AbortController()
    const id = window.setTimeout(() => {
      searchTmdb(query, ac.signal)
        .then(items => { if (!ac.signal.aborted) { setFound({ query, items }); setFailedFor(null) } })
        .catch(err => { if (!ac.signal.aborted && (err as Error)?.name !== 'AbortError') setFailedFor(query) })
    }, 500)
    return () => { window.clearTimeout(id); ac.abort() }
  }, [query, again, off, configAsked])
  const loading = found?.query !== query && failedFor !== query
  const failed = failedFor === query
  const matches = found?.query === query ? found.items : []

  const [want4k, setWant4k] = useState(false)
  const [sending, setSending] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ key: string; says: string } | null>(null)
  const request = async (r: TmdbSearchResult) => {
    const key = keyOf(r)
    setSending(key)
    setRefused(null)
    try {
      const made = await createRequest({
        media_type: r.media_type,
        tmdb_id: r.tmdb_id,
        title: r.title,
        poster_path: r.poster_path || '',
        overview: r.overview || '',
        year: r.year || 0,
        quality_1080p: !want4k,
        quality_4k: want4k,
      })
      setMine(prev => [made, ...prev])
      onRequested(made)
    } catch (err) {
      setRefused({ key, says: refusalSays(err) })
    } finally {
      setSending(null)
    }
  }

  /** Whether this kind can be fetched here. Unknown counts as yes: the
   *  server says no when it must. */
  const canFetch = (r: TmdbSearchResult) => config === null || (r.media_type === 'tv' ? config.has_sonarr : config.has_radarr)
  // The newest request for a match that is still standing (one that failed
  // can be asked for again).
  const standing = (r: TmdbSearchResult) => mine.find(m => keyOf(m) === keyOf(r) && m.status !== 'failed')
  let firstOpen = true

  if (off) {
    return <p className="search-req-note" data-search-requests-off="">Requests are not set up on this server.</p>
  }
  return (
    <div data-search-request="">
      {config?.has_4k && (
        <label className="search-req-4k">
          <input type="checkbox" checked={want4k} onChange={e => setWant4k(e.target.checked)} />
          Ask for 4K where the server has it
        </label>
      )}
      {/* One line for a screen reader: the list arriving is otherwise silent. */}
      <p className="search-req-note" role="status" aria-live="polite" data-search-request-status="">
        {loading
          ? `Looking for “${query}” outside your library…`
          : failed
            ? 'The titles that can be requested could not be loaded.'
            : matches.length === 0
              ? 'Nothing to request was found for these words. Check the spelling, or try the original title.'
              : ''}
        {failed && (
          <button type="button" onClick={() => setAgain(n => n + 1)} className="stage-btn stage-btn-sm stage-btn-ghost search-req-retry stage-hit44">
            Try again
          </button>
        )}
      </p>
      {matches.length > 0 && (
        <ul aria-label="Matches you can request" className="search-req-list">
          {matches.map(r => {
            const key = keyOf(r)
            const has = standing(r)
            const fetchable = canFetch(r)
            const primary = !has && fetchable && firstOpen
            if (primary) firstOpen = false
            const others = has && has.user_id !== userId && has.username
            return (
              <li key={key} className="search-req-row" data-request-key={key}>
                <span className="search-req-art" aria-hidden="true">
                  {r.poster_path
                    // key: the handler below hides a poster that fails, and
                    // must not go on hiding the next one drawn in this row.
                    ? <img key={r.poster_path} src={tmdbPosterURL(r.poster_path)} alt="" loading="lazy" decoding="async" onError={e => { e.currentTarget.style.display = 'none' }} />
                    : null}
                  <span className="search-req-initial">{initialOf(r.title)}</span>
                </span>
                <span className="search-req-text">
                  <span className="search-req-title">{r.title}</span>
                  <span className="search-req-facts">{[r.media_type === 'tv' ? 'TV show' : 'Movie', r.year ? String(r.year) : ''].filter(Boolean).join(' · ')}</span>
                  {has ? (
                    <span className="search-req-state" data-status={has.status}>
                      <span className="search-req-dot" aria-hidden="true" />
                      {others ? `Already requested by ${has.username}` : 'Requested'} · {STATUS_SAYS[has.status]}
                    </span>
                  ) : !fetchable ? (
                    <span className="search-req-overview">This server is not set up to fetch {r.media_type === 'tv' ? 'TV shows' : 'movies'}.</span>
                  ) : r.overview ? (
                    <span className="search-req-overview">{r.overview}</span>
                  ) : null}
                  {refused?.key === key && <span className="search-req-refused" role="alert">{refused.says}</span>}
                </span>
                {has ? (
                  <button type="button" onClick={onOpenRequests} className="stage-btn stage-btn-sm stage-btn-quiet search-req-see stage-hit44" aria-label={`See my requests (${r.title})`}>
                    See my requests
                  </button>
                ) : fetchable ? (
                  <button
                    type="button"
                    disabled={sending !== null}
                    onClick={() => { void request(r) }}
                    aria-label={`Request ${r.title}${r.year ? ` (${r.year})` : ''}`}
                    className={primary ? 'stage-btn stage-btn-primary search-req-btn' : 'stage-btn stage-btn-ghost search-req-btn'}
                  >
                    {sending === key ? 'Requesting…' : 'Request'}
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <p className="search-req-foot">
        Past the server&rsquo;s limit, a request waits for an admin to approve it.
        <button type="button" onClick={onOpenRequests} className="stage-btn stage-btn-sm stage-btn-quiet search-req-all stage-hit44">See my requests</button>
      </p>
    </div>
  )
}
