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
// Lazy-loaded, so the search bundle is fetched on the first visit. App owns
// the query string, the ask (`describe`) and the library set, and passes
// them as props.

import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Icon } from '@/components/Icon'
import { PageHeader } from '@/components/PageHeader'
import { GridSkeleton } from '@/components/Skeletons'
import { MediaCardCinema } from '@/components/MediaCardCinema'
import { searchMedia } from '@/lib/api'
import { describedAnswerFor, keepDescribedAnswer } from '@/lib/describedSearch'
import { type Media } from '@/lib/types'

/* ─────────────────────── SEARCH VIEW ─────────────────────── */
export default function SearchView({ query, onQueryChange, describe, onDescribe, focusNonce, takeFocus, onSelect, onCardContext, onCardPlay, resumableIds, libraryIds, onToggleLib, onRequest }: {
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
  // My Library + button — same contract as MediaRail / BrowseView.
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
  // Where a search that found nothing ends: asking for the title to be
  // added. Not given to a session that is not offered requests.
  onRequest?: (query: string) => void
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
              ? described ? `Looking for titles like "${query}"…` : `Searching for "${query}"…`
              : failed
                ? failed === 'description' ? 'The search by description did not work.' : 'The search did not work.'
                : query
                  ? `${results.length} result${results.length === 1 ? '' : 's'} for "${query}"`
                  : 'Type a title, or describe what you are in the mood for'}
          </span>
        }
      />
      {failed && !loading && (
        <p className="search-failed-line -mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-2" data-search-failed>
          {failed === 'description' ? 'Nothing is wrong with what you typed. The server could not run it.' : 'The server could not be reached, or could not answer.'}
          <button type="button" onClick={tryAgain} className="stage-btn stage-btn-sm stage-btn-ghost search-retry-btn stage-hit44">
            Try again
          </button>
        </p>
      )}
      {describedAsTitles && (
        <p className="-mt-2 mb-6 text-sm text-ink-2" data-search-by-title-instead>
          {results.length > 0 ? 'These match the title. ' : ''}A search by description found nothing for these words, or is not set up on this server.
        </p>
      )}
      {canDescribe && results.length > 0 && (
        // The other way to search these words, said where the results are:
        // nothing on the page otherwise tells a pointer or touch user that
        // Enter does something typing did not.
        <p className="search-describe-line -mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-2" data-search-describe>
          These match the title.
          {/* Drawn at 36px; a touch screen gets the 44px target. */}
          <button type="button" onClick={() => onDescribe?.(query)} className="stage-btn stage-btn-sm stage-btn-ghost search-describe-btn stage-hit44">
            <Icon name="sparkle" size={14} /> Search by description
          </button>
        </p>
      )}

      {loading && results.length === 0 ? (
        // First search (or a new query after an empty result): hold the
        // grid's shape. With results already on screen the previous grid
        // stays up until the new one lands, as before.
        <GridSkeleton />
      ) : !loading && query && results.length === 0 && !failed ? (
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
        // 2028-05-28 — Search results converted to <MediaCardCinema/>
        // for consistency with the rest of the app.
        <div className="poster-grid">
          {results.map(item => (
            <MediaCardCinema
              key={item.id}
              item={item}
              onSelect={onSelect}
              onCardContext={onCardContext}
              libraryIds={libraryIds}
              onToggleLib={onToggleLib}
              onPlay={onCardPlay}
              resumable={resumableIds?.has(item.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
