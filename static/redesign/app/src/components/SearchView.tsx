// SearchView — the search page: one field's worth of results, found two ways.
//
// Typing matches titles as you go (debounced, 300ms a keystroke), asked of
// the server as a title search only. Asking for it, by Enter in either
// search field or the button here, searches by what the words DESCRIBE ("a
// cozy mystery, nothing too dark"): the server's model-backed search, which
// takes a model call, so it runs once per ask and never per keystroke. That
// second way used to be a separate "describe a vibe" bar on Tonight with its
// own rail of results; it is this page's now.
//
// The page: one line that says what was found and how, a kind filter, the
// best match as a row of its own, the rest as cards, the collections whose
// name or description holds the words; beside them (under them on a narrow
// screen) what can be done with the search, and what was searched for
// lately. On a phone the titles are rows, as in the Library's list.
//
// Lazy-loaded, so the search bundle is fetched on the first visit. App owns
// the query string, the ask (`describe`) and the library set, and passes
// them as props.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react'
import { Icon } from '@/components/Icon'
import { GridSkeleton } from '@/components/Skeletons'
import { MediaCardCinema } from '@/components/MediaCardCinema'
import { MediaListRow, contentRatingOf, type RowProgress } from '@/components/MediaListRow'
import { useLongPress } from '@/hooks/useLongPress'
import { listCollections, posterURL, searchMedia, type Collection } from '@/lib/api'
import { describedAnswerFor, keepDescribedAnswer } from '@/lib/describedSearch'
import { type Media } from '@/lib/types'

/** The kinds the results can be narrowed to. Titles carry their kind;
 *  nothing in a result says who is in it or whether it has been watched, so
 *  there is no filter for either. */
type Kind = 'all' | 'movie' | 'show' | 'collection'
const KINDS: readonly { id: Kind; label: string; none: string }[] = [
  { id: 'all', label: 'Everything', none: '' },
  { id: 'movie', label: 'Movies', none: 'No movies match' },
  { id: 'show', label: 'TV Shows', none: 'No TV shows match' },
  { id: 'collection', label: 'Collections', none: 'No collections match' },
]
const isShow = (m: Media) => m.type === 'show' || m.type === 'anime'

/** From md up (the widths the top bar has its own search field at). A phone
 *  lists titles as rows; a wider screen has room for the best match's row
 *  and a grid of cards. Wide where the browser cannot say. */
const WIDE = '(min-width: 768px)'
function useWide(): boolean {
  return useSyncExternalStore(
    notify => {
      const mq = typeof window.matchMedia === 'function' ? window.matchMedia(WIDE) : null
      mq?.addEventListener?.('change', notify)
      return () => mq?.removeEventListener?.('change', notify)
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(WIDE).matches : true),
    () => true,
  )
}

/** The words of a search a collection is matched on: every one of them must
 *  be in its name, its note or the description it was built from. */
function wordsOf(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2)
}
export function collectionMatches(c: Collection, query: string): boolean {
  const words = wordsOf(query)
  if (words.length === 0) return false
  const hay = `${c.name} ${c.description ?? ''} ${c.prompt ?? ''}`.toLowerCase()
  return words.every(w => hay.includes(w))
}
function collectionFacts(c: Collection): string {
  const n = c.item_count ?? 0
  return [`${n.toLocaleString()} title${n === 1 ? '' : 's'}`, c.kind === 'ai' ? 'built by Aurora' : '', c.is_public ? 'public' : '']
    .filter(Boolean).join(' · ')
}

/** The best match: the first result, as a row of its own with its art, what
 *  it is, and Play. A plain container, like a list row: the title is the
 *  button, and Play and More sit beside it, never inside it. */
function BestMatch({ item, resumable, where, onSelect, onCardContext, onPlay }: {
  item: Media
  resumable: boolean
  where?: string
  onSelect: (m: Media) => void
  onCardContext: (e: MouseEvent, m: Media) => void
  onPlay?: (m: Media) => void
}) {
  const longPress = useLongPress(e => onCardContext(e, item), item.id, '.search-best-acts')
  const facts = [
    item.year > 0 ? String(item.year) : '',
    contentRatingOf(item.tags),
    item.duration,
    item.genre,
    where ?? '',
  ].filter(Boolean).join(' · ')
  const art = item.backdrop || item.poster
  return (
    <div
      className="search-best"
      data-media-id={item.id}
      onClick={() => { if (!longPress.swallowClick()) onSelect(item) }}
      onContextMenu={e => { longPress.cancel(); onCardContext(e, item) }}
      {...longPress.handlers}
    >
      {/* The menu key works on what has the focus, and nothing on screen
          says so: the shortcut is named here, as on a card. */}
      <button type="button" className="search-best-open" aria-keyshortcuts="Shift+F10">
        <span className="search-best-art" aria-hidden="true">
          {art && <img src={art} alt="" loading="lazy" decoding="async" />}
        </span>
        <span className="search-best-text">
          <span className="search-best-title">{item.title}</span>
          {facts && <span className="search-best-facts">{facts}</span>}
          {item.description && <span className="search-best-line">{item.description}</span>}
        </span>
      </button>
      <div className="search-best-acts">
        {onPlay && (
          <button
            type="button"
            className="stage-btn stage-btn-primary"
            aria-label={`${resumable ? 'Resume' : 'Play'} ${item.title}`}
            onClick={e => { e.stopPropagation(); onPlay(item) }}
          >
            <Icon name="play" size={16} /> {resumable ? 'Resume' : 'Play'}
          </button>
        )}
        <button
          type="button"
          className="search-best-more"
          aria-haspopup="menu"
          // The menu sets this to true on this button while it is open.
          aria-expanded={false}
          aria-label={`More actions for ${item.title}`}
          onClick={e => { e.stopPropagation(); onCardContext(e, item) }}
        >
          <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
      </div>
    </div>
  )
}

/* ─────────────────────── SEARCH VIEW ─────────────────────── */
export default function SearchView({ query, onQueryChange, describe, onDescribe, focusNonce, takeFocus, onSelect, onCardContext, onCardPlay, resumableIds, progressById, libraryIds, onToggleLib, onRequest, onWatchTogether, onOpenCollection, recent, onPickRecent, onClearRecent }: {
  query: string
  // Below md the top bar has no search field, so the page carries its own.
  // It is the only way to type a query on a phone.
  onQueryChange?: (q: string) => void
  // The words the viewer asked to have searched by what they describe, a
  // number for the ask, and who asked. Honoured only while it is the query on
  // screen: editing the field goes back to matching titles.
  describe?: { query: string; n: number; owner?: string } | null
  // Ask for that search (the page's own field's Enter, and its button).
  onDescribe?: (q: string) => void
  // The page's field takes focus when the Search tab is pressed, and only
  // then: `takeFocus` answers (once) whether that just happened, and
  // `focusNonce` changes on each press so a press while the page is already
  // open is seen too. Mounting for any other reason (Back from a title, a
  // reload) leaves the keyboard down.
  focusNonce?: number
  takeFocus?: () => boolean
  onSelect: (m: Media) => void
  // The card menu (right click, More, a long press): how a keyboard or a
  // phone adds a result to My Library or plays it.
  onCardContext: (e: MouseEvent, m: Media) => void
  // A card's on-poster Play: resumes when the viewer has a position in the
  // title (App decides); resumableIds says which cards that is.
  onCardPlay?: (m: Media) => void
  resumableIds?: Set<number>
  // Where the viewer is in a title they have started ("1h 11m left").
  progressById?: Map<number, RowProgress>
  // My Library + button — same contract as MediaRail / BrowseView.
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
  // Where a search that found nothing ends: asking for the title to be
  // added. Not given to a session that is not offered requests.
  onRequest?: (query: string) => void
  // "Start a watch party with" the best match. Not given to a session that
  // is not offered Together.
  onWatchTogether?: (m: Media) => void
  // Opens a collection. Given only to a session that may open the
  // Library's Collections; without it no collection is listed or asked for.
  onOpenCollection?: (id: number) => void
  // What this profile searched for lately in this browser (newest first),
  // offered again while nothing is typed. Picking one searches for it;
  // "Clear" forgets them.
  recent?: string[]
  onPickRecent?: (words: string) => void
  onClearRecent?: () => void
}) {
  const [results, setResults] = useState<Media[]>([])
  // Driven by the server's X-Search-Mode response — only show the
  // Smart badge when semantic search actually fired.
  const [searchMode, setSearchMode] = useState<'literal' | 'semantic'>('literal')
  const [loading, setLoading] = useState(false)
  // Which query the results on screen answer, and how they were asked for:
  // what decides whether "search by description" is still on offer.
  const [answered, setAnswered] = useState<{ query: string; described: boolean } | null>(null)
  const described = !!describe && describe.query === query.trim()
  const describeN = described ? describe.n : 0
  // The ask's own key: its answer is kept under it, so coming Back to this
  // page shows it again instead of asking the model again.
  const describeKey = described ? `${describe.owner ?? ''}:${describe.n}:${describe.query}` : null
  // A search that failed, and which kind, so the page can say so in words
  // and offer to try again. Never the transport's status code.
  const [failed, setFailed] = useState<'title' | 'description' | null>(null)
  // Asks the title search again (a description search is asked again through
  // onDescribe, which gives it a new number).
  const [retry, setRetry] = useState(0)
  // Track the most-recent query the user typed so a late-resolving
  // response from a stale query doesn't overwrite the current results.
  const lastQueryRef = useRef<string>('')
  const fieldRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (takeFocus?.()) fieldRef.current?.focus()
  }, [focusNonce, takeFocus])
  const wide = useWide()
  // Narrowing the results to a kind. It lasts while there is a search: with
  // the field emptied, the next search starts from everything.
  const [kind, setKind] = useState<Kind>('all')
  const hasQuery = !!query.trim()
  if (!hasQuery && kind !== 'all') setKind('all')
  // The collections this session may open, read once: a search matches
  // their names and descriptions here, as the server's search is of titles.
  // A failed read lists none, which is what the page shows without them.
  const mayOpenCollections = !!onOpenCollection
  const [collections, setCollections] = useState<Collection[]>([])
  useEffect(() => {
    if (!mayOpenCollections) return
    const ac = new AbortController()
    listCollections(ac.signal).then(c => { if (!ac.signal.aborted) setCollections(c ?? []) }).catch(() => {})
    return () => ac.abort()
  }, [mayOpenCollections])

  useEffect(() => {
    const q = query.trim()
    // The words as they are asked for: an answer is compared with these. It
    // used to hold the field's text untrimmed, so the answer for "harbor "
    // (a space typed before the next word) never matched, was dropped as
    // stale, and the page sat on its skeleton.
    lastQueryRef.current = q
    setFailed(null)
    if (!q) {
      setResults([])
      setAnswered(null)
      setLoading(false)
      return
    }
    // Back on this page with the same ask standing: its answer, as it was.
    const keptAnswer = describeKey ? describedAnswerFor(describeKey) : null
    if (keptAnswer) {
      setResults(keptAnswer.items)
      setSearchMode(keptAnswer.mode)
      setAnswered({ query: q, described: true })
      setLoading(false)
      return
    }
    setLoading(true)
    const ac = new AbortController()
    // Typed: titles only, after a pause in the typing. Asked for: by
    // description, at once. The mode is always named, so the server never
    // decides by itself to spend a model call on a keystroke.
    const debounceId = window.setTimeout(() => {
      // The endpoint returns an array, not a paginated envelope.
      void (async () => {
        try {
          const r = await searchMedia(q, 30, ac.signal, described ? 'semantic' : 'literal')
          // Ignore stale responses (debounce can let an old request
          // through if the user types fast).
          if (ac.signal.aborted || lastQueryRef.current !== q) return
          setResults(r.items as Media[])
          setSearchMode(r.mode)
          setAnswered({ query: q, described })
          if (describeKey) keepDescribedAnswer(describeKey, { items: r.items as Media[], mode: r.mode })
        } catch (err) {
          if (ac.signal.aborted || (err && (err as Error).name === 'AbortError')) return
          if (lastQueryRef.current !== q) return
          setFailed(described ? 'description' : 'title')
          setResults([])
          setAnswered({ query: q, described })
        } finally {
          if (!ac.signal.aborted && lastQueryRef.current === q) setLoading(false)
        }
      })()
    }, described ? 0 : 300)
    return () => {
      window.clearTimeout(debounceId)
      ac.abort()
    }
    // describeN: asking again for the same words runs the search again.
  }, [query, described, describeN, describeKey, retry])

  const q = query.trim()
  // On offer once the title search for these words has answered, and until
  // the description search has been asked for.
  const canDescribe = !!onDescribe && !!q && !loading && !described && answered?.query === q && !failed
  // Asked for by description, and the server says these are title matches:
  // its description search found nothing for the words, or it has none (no
  // model is set up). The server does not say which, so neither does this.
  const describedAsTitles = !loading && !failed && described && answered?.query === q && searchMode !== 'semantic'
  const tryAgain = () => {
    if (failed === 'description') onDescribe?.(query)
    else setRetry(n => n + 1)
  }

  // What is shown of the answer: the titles of the chosen kind, and the
  // collections that hold the words (for the words the answer is for, so a
  // collection never shows beside another query's titles).
  const answeredQuery = answered?.query ?? ''
  const matched = useMemo(
    () => (mayOpenCollections && answeredQuery ? collections.filter(c => collectionMatches(c, answeredQuery)) : []),
    [collections, answeredQuery, mayOpenCollections],
  )
  // The kind filter is a wide screen's (a phone's page has no room for it,
  // and its lists are short): a kind chosen there does not narrow a phone's.
  const kindShown: Kind = wide ? kind : 'all'
  const titles = kindShown === 'collection' ? [] : kindShown === 'movie' ? results.filter(m => m.type === 'movie') : kindShown === 'show' ? results.filter(isShow) : results
  const cols = kindShown === 'all' || kindShown === 'collection' ? matched : []
  const found = results.length + matched.length
  const shown = titles.length + cols.length
  // On a phone every title is a row; wider, the first is the best match.
  const best = wide && titles.length > 0 ? titles[0] : null
  const rest = best ? titles.slice(1) : titles
  // By description, and the server says that is what it ran.
  const readAsMood = !loading && !failed && found > 0 && searchMode === 'semantic'
  const empty = !loading && !!q && found === 0 && !failed
  const kinds = KINDS.filter(k => k.id !== 'collection' || mayOpenCollections)

  return (
    // data-search-results: lets TopNav's outside-click-to-close handler
    // exempt clicks on result cards (a page-level sibling, not a DOM
    // descendant of the search pill) from closing the search.
    <div className="animate-fade-in" data-search-results>
      {onQueryChange && (
        // The page's own field, below md only: there the top bar has no
        // search field, and without this one no query could be typed on a
        // phone at all. From md up the bar's field is the one field.
        // A form, so the phone keyboard's Search key (and Enter) asks for
        // the search by description, as Enter does in the top bar's field.
        <form
          role="search"
          onSubmit={e => { e.preventDefault(); if (q) onDescribe?.(query) }}
          className="mb-6 flex h-12 items-center gap-2.5 rounded-control border border-line-strong bg-surface-raised px-3.5 focus-within:border-white md:hidden"
        >
          <Icon name="search" size={18} className="flex-none text-ink-2" />
          <input
            type="search"
            enterKeyHint="search"
            ref={fieldRef}
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            placeholder="Search, or describe a mood"
            aria-label="Search titles"
            className="h-full min-w-0 flex-1 !border-0 !bg-transparent !p-0 text-base text-ink !shadow-none"
          />
          {query && (
            <button type="button" onClick={() => onQueryChange('')} aria-label="Clear search" className="grid h-9 w-9 flex-none place-items-center rounded-full text-ink-2 hover:bg-white/10 hover:text-ink">
              <Icon name="x" size={16} />
            </button>
          )}
        </form>
      )}
      <div className="search-cols">
        <div className="search-main">
          {/* The page's name, for a heading to land on: what is on screen
              is the search's own line below, as the design has it. With
              nothing typed there are no results to head. */}
          <h1 className="sr-only">{q ? 'Search Results' : 'Search'}</h1>
          {/* role="status" (implicit aria-live="polite"): this line is the
              entire feedback for a search, and without it a screen-reader
              user types a query and hears nothing at all: no way to know
              whether the search ran, found nothing, or is still going.
              aria-atomic so the whole sentence is re-read rather than just
              the changed number, which otherwise announces as a bare "12". */}
          <p className="search-status" role="status" aria-live="polite" aria-atomic="true">
            {/* The mark for "Aurora did this", only when the server says
                the description search is what ran: it is a statement about
                how the results were produced. */}
            {readAsMood && <span className="aurora-dot flex-none" aria-hidden="true" data-search-read-as-mood="" />}
            <span>
              {loading
                ? described ? `Looking for titles like "${query}"…` : `Searching for "${query}"…`
                : failed
                  ? failed === 'description' ? 'The search by description did not work.' : 'The search did not work.'
                  : !query
                    ? 'Type a title, or describe what you are in the mood for'
                    : readAsMood
                      ? 'Aurora read this as a mood, not a title. Showing the closest matches in your library.'
                      : kindShown !== 'all' && shown === 0 && found > 0
                        ? `${KINDS.find(k => k.id === kindShown)!.none} "${query}"`
                        : `${shown} result${shown === 1 ? '' : 's'} for "${query}"`}
            </span>
          </p>
          {failed && !loading && (
            <p className="search-failed-line mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-2" data-search-failed>
              {failed === 'description' ? 'Nothing is wrong with what you typed. The server could not run it.' : 'The server could not be reached, or could not answer.'}
              <button type="button" onClick={tryAgain} className="stage-btn stage-btn-sm stage-btn-ghost search-retry-btn stage-hit44">
                Try again
              </button>
            </p>
          )}
          {describedAsTitles && (
            <p className="mt-3 text-sm text-ink-2" data-search-by-title-instead>
              {results.length > 0 ? 'These match the title. ' : ''}A search by description found nothing for these words, or is not set up on this server.
            </p>
          )}
          {canDescribe && results.length > 0 && (
            // The other way to search these words, said where the results are:
            // nothing on the page otherwise tells a pointer or touch user that
            // Enter does something typing did not.
            <p className="search-describe-line mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-2" data-search-describe>
              These match the title.
              {/* Drawn at 36px; a touch screen gets the 44px target. */}
              <button type="button" onClick={() => onDescribe?.(query)} className="stage-btn stage-btn-sm stage-btn-ghost search-describe-btn stage-hit44">
                <Icon name="sparkle" size={14} /> Search by description
              </button>
            </p>
          )}
          {/* Narrowing to a kind, once there is something to narrow. */}
          {wide && !loading && found > 0 && (
            <div role="group" aria-label="Filter results" className="search-filters" data-search-filters="">
              {kinds.map(k => (
                <button key={k.id} type="button" className="genre-chip" aria-pressed={kindShown === k.id} onClick={() => setKind(k.id)}>
                  {k.label}
                </button>
              ))}
            </div>
          )}

          {loading && found === 0 ? (
            // First search (or a new query after an empty result): hold the
            // grid's shape. With results already on screen the previous
            // results stay up until the new ones land, as before.
            <div className="mt-8"><GridSkeleton /></div>
          ) : empty ? (
            <div className="text-center py-20" data-search-empty>
              <Icon name="search" size={48} className="mx-auto mb-4 text-ink-3" />
              {canDescribe ? (
                <>
                  <h2 className="text-lg text-ink">No title matches &ldquo;{query}&rdquo;</h2>
                  <p className="mt-1 text-sm text-ink-2">If that describes what you want to watch, search by description.</p>
                  <button type="button" onClick={() => onDescribe?.(query)} className="stage-btn stage-btn-primary mt-5">
                    <Icon name="sparkle" size={16} /> Search by description
                  </button>
                </>
              ) : (
                <>
                  <h2 className="text-lg text-ink">Nothing found</h2>
                  <p className="mt-1 text-sm text-ink-2">Try other words, or a title.</p>
                </>
              )}
              {/* Requesting has no page of its own to go looking for: it is
                  offered here, where a search has just come up empty. */}
              {onRequest && (
                <p className="search-request-line mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm text-ink-2" data-search-request>
                  Not in the library?
                  <button type="button" onClick={() => onRequest(q)} className="stage-btn stage-btn-sm stage-btn-ghost search-request-btn stage-hit44">
                    Request it
                  </button>
                </p>
              )}
            </div>
          ) : (
            <>
              {best && (
                <section aria-labelledby="search-best-heading" className="search-section" data-search-best="">
                  <h2 id="search-best-heading" className="search-h2">Best match</h2>
                  <BestMatch
                    item={best}
                    resumable={!!resumableIds?.has(best.id)}
                    where={progressById?.get(best.id)?.label}
                    onSelect={onSelect}
                    onCardContext={onCardContext}
                    onPlay={onCardPlay}
                  />
                </section>
              )}
              {rest.length > 0 && (
                <section aria-labelledby="search-titles-heading" className="search-section" data-search-titles="">
                  <h2 id="search-titles-heading" className="search-h2">
                    Titles
                    {best && <span className="search-h2-note">{rest.length.toLocaleString()} more</span>}
                  </h2>
                  {wide ? (
                    // The app's own cards, in the Library's compact grid: a
                    // screen of results is a screen of results.
                    <div className="poster-grid is-compact mt-4">
                      {rest.map(item => (
                        <MediaCardCinema
                          key={item.id}
                          item={item}
                          onSelect={onSelect}
                          onCardContext={onCardContext}
                          libraryIds={libraryIds}
                          onToggleLib={onToggleLib}
                          onPlay={onCardPlay}
                          resumable={resumableIds?.has(item.id)}
                          compact
                        />
                      ))}
                    </div>
                  ) : (
                    // A phone: rows, as the Library's list is, each with its
                    // More button and a long press for the same menu.
                    <div className="media-list mt-2" data-search-rows="">
                      {rest.map(item => (
                        <MediaListRow
                          key={item.id}
                          item={item}
                          onSelect={() => onSelect(item)}
                          onCardContext={e => onCardContext(e, item)}
                          libraryIds={libraryIds}
                          onToggleLib={onToggleLib ? () => onToggleLib(item) : undefined}
                          onPlay={onCardPlay ? () => onCardPlay(item) : undefined}
                          resumable={resumableIds?.has(item.id)}
                          progress={progressById?.get(item.id)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}
              {cols.length > 0 && onOpenCollection && (
                <section aria-labelledby="search-collections-heading" className="search-section" data-search-collections="">
                  <h2 id="search-collections-heading" className="search-h2">Collections</h2>
                  <div className="search-colgrid">
                    {cols.map(c => (
                      <button key={c.id} type="button" className="search-colrow" onClick={() => onOpenCollection(c.id)}>
                        {/* Up to three of its posters, side by side. */}
                        {(c.poster_paths?.length ?? 0) > 0 && (
                          <span className="search-colrow-art" aria-hidden="true">
                            {c.poster_paths!.slice(0, 3).map(path => <img key={path} src={posterURL(path, 'w154')} alt="" loading="lazy" decoding="async" />)}
                          </span>
                        )}
                        <span className="search-colrow-text">
                          <span className="search-colrow-name">{c.name}</span>
                          <span className="search-colrow-facts">{collectionFacts(c)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>

        {/* Beside the results from the width two columns fit at, under them
            below it: what can be done with this search, and what was
            searched for lately. */}
        <aside className="search-aside" aria-label="Search actions and recent searches">
          {q && !loading && found > 0 && ((onWatchTogether && titles.length > 0) || onRequest) && (
            <section aria-labelledby="search-actions-heading" data-search-actions="">
              {/* Under the results on a phone, where it is what else there is. */}
              <h2 id="search-actions-heading" className="search-aside-h">{wide ? 'Actions' : 'More'}</h2>
              {onWatchTogether && titles.length > 0 && (
                <button type="button" className="search-action-row" onClick={() => onWatchTogether(titles[0])}>
                  <Icon name="users" size={18} className="flex-none text-ink-2" />
                  <span className="min-w-0 flex-1">Start a watch party with {titles[0].title}</span>
                </button>
              )}
              {onRequest && (
                <button type="button" className="search-action-row" onClick={() => onRequest(q)}>
                  <Icon name="download" size={18} className="flex-none text-ink-2" />
                  <span className="min-w-0 flex-1">Not here? Request a title</span>
                </button>
              )}
            </section>
          )}
          {/* What this profile looked for lately, to pick up again. */}
          {recent && recent.length > 0 && onPickRecent && (
            <section aria-labelledby="search-recent-heading" data-search-recent>
              <div className="mb-1 flex items-center">
                <h2 id="search-recent-heading" className="search-aside-h flex-1">Recent searches</h2>
                {onClearRecent && (
                  <button type="button" onClick={onClearRecent} className="stage-btn stage-btn-sm stage-btn-quiet search-recent-clear stage-hit44">
                    Clear
                  </button>
                )}
              </div>
              <ul className="m-0 list-none p-0">
                {recent.map(words => (
                  <li key={words}>
                    <button type="button" onClick={() => onPickRecent(words)} className="search-recent-row flex w-full items-center text-left">
                      <Icon name="clock" size={16} className="flex-none text-ink-3" />
                      <span className="min-w-0 flex-1 truncate">{words}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {onDescribe && (
            <p className="search-hint">
              Titles appear as you type. Press Enter to search by mood or description, which takes a few seconds longer.
            </p>
          )}
        </aside>
      </div>
    </div>
  )
}
