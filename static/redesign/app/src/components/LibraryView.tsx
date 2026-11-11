// LibraryView — My Library (user-saved titles + Continue Watching).
// Extracted from App.tsx (2026-06-17 app split, Phase 2.6) and lazy-loaded
// so the library bundle is fetched only on first /library nav. App owns
// the saved `library` state + `continueItems` and passes them as props;
// the Resume pill click resolves the freshest CW record via a ref
// (deep-debug H3). Shares isResumable (format), MediaCardCinema, Icon, and
// the app-side Media type with the other views — no reach-back into App.

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Icon } from '@/components/Icon'
import { PageHeader, FilterPills, type FilterPillOption } from '@/components/PageHeader'
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
export default function LibraryView({ library, continueItems, onSelect, onToggleLib, onPlayContinue, onCardContext, onCardPlay, resumableIds, loading = false }: {
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
}) {
  const [filter, setFilter] = useState<'all' | 'movie' | 'show'>('all')
  const filteredLibrary = filter === 'all'
    ? library
    : library.filter(m => (filter === 'show' ? (m.type === 'show' || m.type === 'anime') : m.type === filter))
  const libraryIds = useMemo(() => new Set(library.map(m => m.id)), [library])
  // Pill counts. `show` folds in `anime` to match the filter predicate above —
  // if the count and the predicate disagreed, a pill would advertise a number
  // the grid beneath it doesn't produce.
  const filterOptions: FilterPillOption<typeof filter>[] = useMemo(() => {
    let movies = 0
    let shows = 0
    for (const m of library) {
      if (m.type === 'movie') movies++
      else if (m.type === 'show' || m.type === 'anime') shows++
    }
    return [
      { value: 'all', label: 'All', count: library.length },
      { value: 'movie', label: 'Movies', count: movies },
      { value: 'show', label: 'TV Shows', count: shows },
    ]
  }, [library])
  // Deep-debug H3 — latest-continueItems ref so the Resume pill
  // click handler resolves the freshest record at click-time, not
  // render-time. Without this, a mid-hover refetch (e.g. cross-tab
  // playback updated position_ms) would dispatch a stale record.
  const continueItemsRef = useRef(continueItems)
  useEffect(() => { continueItemsRef.current = continueItems }, [continueItems])

  return (
    <div className="animate-fade-in">
      <PageHeader
        eyebrow="Saved by you"
        title="My Library"
        sub={
          library.length === 0
            // Device-neutral: phones have no hover, and the + is always
            // visible (on every device — it has no hover gating), so "hover …
            // and click" was wrong for exactly the users reading it on a phone.
            ? 'Use the + on any card to save titles here.'
            : library.length === 1
              ? '1 saved title'
              : `${library.length} saved titles`
        }
      />

      {/* Filter pills — only relevant when there are saved items */}
      {library.length > 0 && (
        <FilterPills
          options={filterOptions}
          value={filter}
          onChange={setFilter}
          label="Filter saved titles by kind"
          className="mb-6"
        />
      )}

      {/* Saved items grid.
          QA BUG-003 — the empty-state copy was "Your library is empty",
          which read as contradictory when the Continue Watching rail
          below it had items. Distinguish the two surfaces in the
          copy: "saved titles" vs "in-progress watches". */}
      {library.length === 0 && loading ? (
        <GridSkeleton className="mb-12" />
      ) : library.length === 0 ? (
        <div className="text-center py-16">
          <Icon name="library" size={48} className="mx-auto text-ink-3 mb-4" />
          <h2 className="text-white/70 text-lg mb-2">No saved titles yet</h2>
          <p className="text-white/50 text-sm max-w-md mx-auto">
            Use the <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white/15 border border-line-strong text-white text-xs font-bold align-middle mx-0.5">+</span> in the top-left of any title to bookmark it here.{continueItems.length > 0 ? ' Your in-progress watches still appear in the Continue Watching rail below.' : ''}
          </p>
        </div>
      ) : filteredLibrary.length === 0 ? (
        <p className="text-white/50 text-sm">No {filter === 'movie' ? 'movies' : 'TV shows'} saved.</p>
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
            <h2 className="text-white font-display font-bold type-section">Continue Watching</h2>
            <span className="text-white/50 text-sm">({continueItems.length})</span>
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
