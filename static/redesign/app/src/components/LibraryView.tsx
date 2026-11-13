// LibraryView — My Library (user-saved titles + Continue Watching).
// Extracted from App.tsx (2026-06-17 app split, Phase 2.6) and lazy-loaded
// so the library bundle is fetched only on first /library nav. App owns
// the saved `library` state + `continueItems` and passes them as props;
// the Resume pill click resolves the freshest CW record via a ref
// (deep-debug H3). Shares isResumable (format), MediaCardCinema, Icon, and
// the app-side Media type with the other views — no reach-back into App.

import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Icon } from '@/components/Icon'
import { LibraryTools } from '@/components/LibraryHeader'
import { MediaCardCinema } from '@/components/MediaCardCinema'
import { GridSkeleton } from '@/components/Skeletons'
import { isResumable } from '@/lib/format'
import { mapContinueToMedia, type ContinueWatchingItem } from '@/lib/api'
import { type Media } from '@/lib/types'

/* ─────────────────────── LIBRARY VIEW ─────────────────────── */
// My Library — user-saved titles (the + button on cards) plus a
// Continue Watching section. Saved items are the headline; Continue
// Watching appears below as a secondary surface. Saved state lives
// in App-level `library` and is persisted to localStorage.
export default function LibraryView({ library, continueItems, onSelect, onToggleLib, onPlayContinue, onCardContext, onCardPlay, resumableIds, loading = false, profileName, onFind, onBrowse }: {
  library: Media[]
  continueItems: ContinueWatchingItem[]
  onSelect: (m: Media) => void
  onToggleLib: (m: Media) => void
  // The card menu (right click, More, a long press). It is how a keyboard
  // or a phone removes a title from here or resumes one.
  // `own`: the Continue Watching record a card stands for, so the menu's
  // Resume is that card's record and not another episode of the show.
  onCardContext: (e: MouseEvent, m: Media, own?: ContinueWatchingItem) => void
  // A card's on-poster Play: resumes when the viewer has a position in the
  // title (App decides); resumableIds says which cards that is.
  onCardPlay?: (m: Media) => void
  resumableIds?: Set<number>
  // True until the server's copy of the library has been reconciled once.
  // `library` hydrates from localStorage, so on a device that has never
  // seen this account it starts EMPTY and the view showed the "No saved
  // titles yet" empty state for the whole round trip, then replaced it
  // with the grid. A skeleton holds the shape instead.
  loading?: boolean
  // 2026-05-27 — Continue Watching one-click resume in the
  // LibraryView CW grid. When set, each CW card gets a Resume pill
  // on hover (same pattern as the home CW rail). Optional so the
  // type stays compatible with callers that don't wire it.
  onPlayContinue?: (c: ContinueWatchingItem) => void
  // Whose list this is, for the count in the header ("11 saved for Morgan").
  profileName?: string
  // What an empty list offers, in place: a search for something to save
  // (the words are handed over as typed), and the two catalogs to browse.
  onFind?: (words: string) => void
  onBrowse?: (scope: 'movies' | 'shows') => void
}) {
  const [filter, setFilter] = useState<'all' | 'movie' | 'show'>('all')
  const [findWords, setFindWords] = useState('')
  const filteredLibrary = filter === 'all'
    ? library
    : library.filter(m => (filter === 'show' ? (m.type === 'show' || m.type === 'anime') : m.type === filter))
  const libraryIds = useMemo(() => new Set(library.map(m => m.id)), [library])
  // The kinds on offer, each with how many saved titles it holds. `show`
  // folds in `anime`, as the filter above does: a count and the grid under
  // it must not disagree.
  const kinds = useMemo(() => {
    let movies = 0
    let shows = 0
    for (const m of library) {
      if (m.type === 'movie') movies++
      else if (m.type === 'show' || m.type === 'anime') shows++
    }
    return [
      // `one` and `many`: the kind as a sentence says it ("2 TV shows of 4
      // saved"), where the control's label is a name and keeps its capitals.
      { value: 'all', label: 'All', one: '', many: '', count: library.length },
      { value: 'movie', label: 'Movies', one: 'movie', many: 'movies', count: movies },
      { value: 'show', label: 'TV Shows', one: 'TV show', many: 'TV shows', count: shows },
    ] as const
  }, [library])
  const shown = kinds.find(k => k.value === filter)!
  // Deep-debug H3 — latest-continueItems ref so the Resume pill
  // click handler resolves the freshest record at click-time, not
  // render-time. Without this, a mid-hover refetch (e.g. cross-tab
  // playback updated position_ms) would dispatch a stale record.
  // A LAYOUT effect: a press can land between the commit that draws a
  // card's "Resume" and a passive effect, and found no record there (the
  // press did nothing).
  const continueItemsRef = useRef(continueItems)
  useLayoutEffect(() => { continueItemsRef.current = continueItems }, [continueItems])

  return (
    <div className="animate-fade-in">
      {/* The page has no heading of its own: the Library header's row names
          it, and carries this count and the kind control at its right. */}
      <h1 className="sr-only">My Library</h1>
      <LibraryTools>
        <p className="stage-libhead-note" role="status" data-library-count="">
          {loading && library.length === 0 ? '' : <>
            {/* The line is the page's live region: with a kind chosen it
                says how many of them are showing, out of all that is saved. */}
            {filter !== 'all' && `${shown.count.toLocaleString()} ${shown.count === 1 ? shown.one : shown.many} of `}
            {library.length.toLocaleString()} saved
            {/* A name can be a hundred characters: it is cut with an
                ellipsis, and whole in the title. */}
            {profileName && <> for <span className="stage-libhead-name" title={profileName}>{profileName}</span></>}
          </>}
        </p>
        {/* Only relevant when there is something saved. */}
        {library.length > 0 && (
          <div className="stage-seg flex" role="group" aria-label="Kind">
            {kinds.map(k => (
              <button key={k.value} type="button" aria-pressed={filter === k.value} onClick={() => setFilter(k.value)} className="stage-seg-btn is-label">
                {k.label}
                <span className="stage-seg-count">{k.count.toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
      </LibraryTools>

      {/* Saved items grid.
          QA BUG-003 — the empty-state copy was "Your library is empty",
          which read as contradictory when the Continue Watching rail
          below it had items. Distinguish the two surfaces in the
          copy: "saved titles" vs "in-progress watches". */}
      {library.length === 0 && loading ? (
        <GridSkeleton className="mb-12" />
      ) : library.length === 0 ? (
        // data-library-empty: what a test of a profile switch looks for, so
        // that rewording this cannot quietly blind it.
        // The empty list says what it is for and offers the next thing to
        // do, here: find a title, or browse for one.
        <div className="lib-empty" data-library-empty="">
          <h2 className="lib-empty-title">Nothing saved yet</h2>
          <p className="lib-empty-lead">
            Save a title from its card or its page and it waits here for you, on every device you sign in to.{continueItems.length > 0 ? ' What you have started is below.' : ''}
          </p>
          {onFind && (
            <form
              role="search"
              className="lib-empty-find"
              onSubmit={e => { e.preventDefault(); if (findWords.trim()) onFind(findWords) }}
            >
              <Icon name="search" size={20} className="flex-none text-ink-2" />
              <input
                type="search"
                enterKeyHint="search"
                aria-label="Find something to save"
                placeholder="Find something to save"
                value={findWords}
                onChange={e => setFindWords(e.target.value)}
              />
            </form>
          )}
          {onBrowse && (
            <div className="lib-empty-acts">
              <button type="button" className="stage-btn stage-btn-primary" onClick={() => onBrowse('movies')}>Browse movies</button>
              <button type="button" className="stage-btn stage-btn-ghost" onClick={() => onBrowse('shows')}>Browse shows</button>
            </div>
          )}
        </div>
      ) : filteredLibrary.length === 0 ? (
        <p className="text-sm text-ink-2">No {filter === 'movie' ? 'movies' : 'TV shows'} saved.</p>
      ) : (
        // Every card here IS in the library, so its Add button reads
        // "Remove" and its caption carries the saved tick. Removing is also
        // in the card's menu, which is how a keyboard or a phone does it.
        <div className="poster-grid mb-12">
          {filteredLibrary.map((m) => (
            <MediaCardCinema
              key={m.id}
              item={m}
              onSelect={onSelect}
              onCardContext={onCardContext}
              libraryIds={libraryIds}
              onToggleLib={onToggleLib}
              onPlay={onCardPlay}
              resumable={resumableIds?.has(m.id)}
            />
          ))}
        </div>
      )}

      {/* Continue Watching — secondary section below Saved */}
      {continueItems.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Icon name="clock" size={18} className="text-ink" />
            {/* .type-section (--fs-section, 24px) rather than text-xl, so this
                secondary head sits on the same display scale as every other
                section head in the app instead of one arbitrary step below. */}
            <h2 className="font-display font-bold text-ink type-section">Continue Watching</h2>
            <span className="text-sm text-ink-2">({continueItems.length})</span>
          </div>
          <div className="poster-grid">
            {continueItems.map(c => {
              const m = mapContinueToMedia(c)
              const sub = c.type === 'show' && c.season_number && c.episode_number
                ? `S${c.season_number}E${c.episode_number}`
                : (c.year ? String(c.year) : undefined)
              // mapContinueToMedia already normalizes progress to 0..1
              // (api.ts:1689 divides by 100 — server emits 0-100). The
              // `m` here carries it on m.progress, so no per-card
              // wrapper needed. Rating=0 is also from mapContinueToMedia
              // and the card's meta-star guard hides the star.
              // Play on this card resumes THIS record (a show can have one
              // per episode here), read at click time so a refresh between
              // render and click does not dispatch a stale position. Below
              // the resume threshold it falls back to the card's Play.
              const resumable = !!onPlayContinue && isResumable(c)
              // This card's record as it is now.
              const own = () => continueItemsRef.current.find(
                x => x.media_item_id === c.media_item_id && x.episode_id === c.episode_id,
              )
              const play = resumable
                ? () => {
                    const latest = own()
                    if (latest && isResumable(latest)) onPlayContinue(latest)
                  }
                : onCardPlay
              return (
                <MediaCardCinema
                  key={`${c.media_item_id}-${c.episode_id ?? ''}`}
                  item={m}
                  onSelect={onSelect}
                  libraryIds={libraryIds}
                  onToggleLib={onToggleLib}
                  subtitle={sub}
                  // The menu resumes the same record Play does.
                  onCardContext={(e, item) => onCardContext(e, item, own() ?? c)}
                  onPlay={play}
                  resumable={resumable}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
