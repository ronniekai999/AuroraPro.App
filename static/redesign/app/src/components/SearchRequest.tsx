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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { REQUEST_STATUS, requestRefusalSays } from '@/lib/requestStatus'

const keyOf = (r: { media_type: string; tmdb_id: number }) => `${r.media_type}:${r.tmdb_id}`

/** The letter a title is filed under, for the tile that stands in for a
 *  poster: its first, past a leading article ("The Glass Orchard" is G). */
const initialOf = (title: string) => title.trim().replace(/^(the|a|an)\s+/i, '').charAt(0).toUpperCase()

/** What the request list needs to know that does not change with the words:
 *  whether this server takes requests (and of which kind), and what has been
 *  asked for already. Held by the search page for as long as it is mounted
 *  (which is per profile), so neither is fetched again at every empty
 *  search: the list itself is unmounted for each keystroke's skeleton.
 *
 *  The config is read at once (the page words its offers by it). The list
 *  of requests is read the first time a request list is shown (`wantMine`):
 *  for a session with the admin powers it is every member's.
 *  Either failing leaves things as they would be without it; the server
 *  still refuses what it must. */
export interface Requesting {
  config: RequestsConfig | null
  /** The config has been answered for, or could not be. */
  configAsked: boolean
  /** Requests may be offered: the config says so, or it could not be read
   *  (the server then says no where it must). False until it is known. */
  offered: boolean
  mine: MediaRequest[]
  wantMine: () => void
  noteMade: (r: MediaRequest) => void
}
export function useRequesting(enabled: boolean): Requesting {
  const [config, setConfig] = useState<RequestsConfig | null>(null)
  const [configAsked, setConfigAsked] = useState(false)
  const [mine, setMine] = useState<MediaRequest[]>([])
  const [mineWanted, setMineWanted] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const ac = new AbortController()
    getRequestsConfig(ac.signal)
      .then(c => { if (!ac.signal.aborted) setConfig(c) })
      .catch(() => {})
      .finally(() => { if (!ac.signal.aborted) setConfigAsked(true) })
    return () => ac.abort()
  }, [enabled])
  useEffect(() => {
    if (!enabled || !mineWanted) return
    const ac = new AbortController()
    listRequests(ac.signal).then(r => { if (!ac.signal.aborted) setMine(prev => [...prev, ...r.filter(x => !prev.some(p => p.id === x.id))]) }).catch(() => {})
    return () => ac.abort()
  }, [enabled, mineWanted])
  const wantMine = useCallback(() => setMineWanted(true), [])
  const noteMade = useCallback((r: MediaRequest) => setMine(prev => [r, ...prev]), [])
  return { config, configAsked, offered: enabled && (config ? !!config.enabled : configAsked), mine, wantMine, noteMade }
}

export function SearchRequest({ query, userId, state, onRequested, onOpenRequests, takeFocus = false }: {
  /** The words, as searched for. */
  query: string
  userId: number
  /** The page's own knowledge of this server's requests (useRequesting). */
  state: Requesting
  /** The list was asked for by a press (not by a search coming up empty):
   *  its status line takes the focus the pressed button is about to lose. */
  takeFocus?: boolean
  /** A request was made: the app's own list and its toast. */
  onRequested: (r: MediaRequest) => void
  /** "See my requests". */
  onOpenRequests: () => void
}) {
  const { config, configAsked, mine, wantMine, noteMade } = state
  useEffect(() => { wantMine() }, [wantMine])

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
  // The line that says what the list is doing. It is also where the focus
  // goes when the control that had it is about to go ("Try again", which is
  // drawn only while the lookup has failed).
  const statusRef = useRef<HTMLParagraphElement | null>(null)
  const tryAgain = () => {
    // Back to "Looking for…" at once: the press is answered, and a second
    // failure is a change the live region announces again.
    setFailedFor(null)
    setFound(null)
    setAgain(n => n + 1)
    statusRef.current?.focus()
  }
  useLayoutEffect(() => { if (takeFocus) statusRef.current?.focus() }, [takeFocus])

  const [want4k, setWant4k] = useState(false)
  const [sending, setSending] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ key: string; says: string } | null>(null)
  const request = async (r: TmdbSearchResult) => {
    // One at a time. The buttons stay focusable while one is out
    // (aria-disabled, not disabled: a disabled control can drop the focus
    // it holds), and a press then does nothing.
    if (sending !== null) return
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
      noteMade(made)
      onRequested(made)
    } catch (err) {
      setRefused({ key, says: requestRefusalSays(err) })
    } finally {
      setSending(null)
    }
  }

  /** Whether this kind can be fetched here. Unknown counts as yes: the
   *  server says no when it must. */
  const canFetch = (r: TmdbSearchResult) => config === null || (r.media_type === 'tv' ? config.has_sonarr : config.has_radarr)
  // A request for a match that is still standing (one that failed can be
  // asked for again): the caller's own, which is what the server's
  // one-request-per-title rule is about, and another member's, which only
  // the list a session with the admin powers is given holds.
  const standing = (r: TmdbSearchResult, own: boolean) =>
    mine.find(m => keyOf(m) === keyOf(r) && m.status !== 'failed' && (m.user_id === userId) === own)
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
      {/* What the list is doing, and then what it holds: the matches
          arriving is otherwise silent to a screen reader. Always in the
          tree (an empty live region that is taken out of it announces
          nothing when it comes back). */}
      <p ref={statusRef} tabIndex={-1} className="search-req-note" role="status" aria-live="polite" data-search-request-status="">
        {loading
          ? `Looking for “${query}” outside your library…`
          : failed
            ? 'The titles that can be requested could not be loaded.'
            : matches.length === 0
              ? 'Nothing to request was found for these words. Check the spelling, or try the original title.'
              : `${matches.length.toLocaleString()} title${matches.length === 1 ? '' : 's'} can be requested.`}
        {failed && (
          <button type="button" onClick={tryAgain} className="stage-btn stage-btn-sm stage-btn-ghost search-req-retry stage-hit44">
            Try again
          </button>
        )}
      </p>
      {matches.length > 0 && (
        <ul aria-label="Matches you can request" className="search-req-list">
          {matches.map(r => {
            const key = keyOf(r)
            const has = standing(r, true)
            // Another member's request does not stop this one's: the line
            // says who asked, and the button stays.
            const theirs = has ? undefined : standing(r, false)
            const said = has ?? theirs
            const fetchable = canFetch(r)
            const primary = !has && fetchable && firstOpen
            if (primary) firstOpen = false
            return (
              <li key={key} className="search-req-row" data-request-key={key}>
                <span className="search-req-art" aria-hidden="true">
                  {r.poster_path
                    // key: the handler below hides a poster that fails, and
                    // must not go on hiding the next one drawn in this row.
                    // The tile is 48px wide: TMDB's smallest poster that covers it twice over.
                    ? <img key={r.poster_path} src={tmdbPosterURL(r.poster_path, 'w154')} alt="" loading="lazy" decoding="async" onError={e => { e.currentTarget.style.display = 'none' }} />
                    : null}
                  <span className="search-req-initial">{initialOf(r.title)}</span>
                </span>
                <span className="search-req-text">
                  <span className="search-req-title">{r.title}</span>
                  <span className="search-req-facts">{[r.media_type === 'tv' ? 'TV show' : 'Movie', r.year ? String(r.year) : ''].filter(Boolean).join(' · ')}</span>
                  {said ? (
                    <span className="search-req-state" data-tone={REQUEST_STATUS[said.status]?.tone ?? 'wait'}>
                      <span className="search-req-dot" aria-hidden="true" />
                      {said === theirs && theirs?.username ? `Already requested by ${theirs.username}` : said === theirs ? 'Already requested' : 'Requested'} · {REQUEST_STATUS[said.status]?.says ?? said.status}
                    </span>
                  ) : !fetchable ? (
                    <span className="search-req-overview">This server is not set up to fetch {r.media_type === 'tv' ? 'TV shows' : 'movies'}.</span>
                  ) : r.overview ? (
                    <span className="search-req-overview">{r.overview}</span>
                  ) : null}
                  {refused?.key === key && <span className="search-req-refused" role="alert">{refused.says}</span>}
                </span>
                {/* One button in this place, whichever it is: when a request
                    goes through, Request BECOMES "See my requests" (the
                    same element), so the focus it held stays on the row. */}
                {has ? (
                  <button type="button" onClick={onOpenRequests} className="stage-btn stage-btn-sm stage-btn-quiet search-req-see stage-hit44" aria-label={`See my requests (${r.title})`}>
                    See my requests
                  </button>
                ) : fetchable ? (
                  <button
                    type="button"
                    aria-disabled={sending !== null || undefined}
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
