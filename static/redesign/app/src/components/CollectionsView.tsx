// Phase 6 — Collections list/detail view.
//
// Two states: list (all visible collections) and detail (one
// collection's items). Click a collection card → detail.

import { useEffect, useRef, useState, type MouseEvent } from 'react'
import {
  listCollections,
  getCollection,
  deleteCollection,
  removeFromCollection,
  posterURL,
  backdropURL,
  type Collection,
  type ServerMediaItem,
} from '@/lib/api'
import { MediaCardCinema } from '@/components/MediaCardCinema'
import { Icon } from '@/components/Icon'
import { LibraryTools } from '@/components/LibraryHeader'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'

// Which images the stacked-poster card draws, in order (Aurora Stage Phase 6).
// Exported and pure so the three-branch fallback is testable — an untested
// fallback chain is how you end up shipping blank cards against a server that
// predates the field.
//
//   1. poster_paths — up to four MEMBER posters. Four strips read as "a group
//      of titles", which is the whole point of the card.
//   2. cover_path — one image, auto-populated server-side from the first item
//      ever added. Reads as one title, but beats an empty card. This is the
//      path a frontend deployed ahead of its server takes.
//   3. nothing — a genuinely empty collection, or one whose members all lack
//      poster art. The card falls back to its own flat background.
//
// NOT `.map(posterURL)`: map passes the index as the second argument and
// posterURL's second parameter is `size`, so strip 1 would request size `1`.
// w185 because each strip is only ~110px wide on this card.
export function collectionStrips(
  c: Pick<Collection, 'poster_paths' | 'cover_path'>,
): string[] {
  if (c.poster_paths?.length) return c.poster_paths.map(p => posterURL(p, 'w185'))
  if (c.cover_path) return [backdropURL(c.cover_path, 'w780')]
  return []
}

interface Props {
  isAdmin: boolean
  onOpenCreate: () => void
  onOpenMedia: (id: number) => void
  // QA BUG-007 — wire the same + button users see on Movies/Shows/Search.
  // libraryIds is the set of media IDs currently in My Library;
  // onToggleLib adds/removes via the full ServerMediaItem so the
  // mapped UIMedia carries real poster/year/rating fields into
  // localStorage. A stub-with-empties would clobber the persisted
  // record on toggle. Both optional so the component still renders
  // if a caller hasn't wired them yet.
  libraryIds?: Set<number>
  onToggleLib?: (m: ServerMediaItem) => void
  // The card menu (right click, More, a long press), given the server's
  // record like onToggleLib: how a keyboard or a phone adds a title here to
  // My Library or plays it.
  onCardContext: (e: MouseEvent, m: ServerMediaItem) => void
  // QA 2026-05-25 — bumped by App.handleNavigate when the user clicks
  // the Collections nav item while already on /collections. Acts as
  // a "back to index" signal so the side-nav doubles as a back
  // button from a collection detail view. Optional so callers that
  // don't wire it just keep the old behavior (drill-down state
  // sticky until the user clicks the in-page Back affordance).
  rewindNonce?: number
  /** A collection to open the page on (picked from a search's results);
   *  `n` tells one ask from the next. */
  open?: { id: number; n: number } | null
  /** Called once the ask has been taken, so that coming back to the page
   *  later shows the index. */
  onOpenTaken?: () => void
}

export default function CollectionsView({ isAdmin, onOpenCreate, onOpenMedia, libraryIds, onToggleLib, onCardContext, rewindNonce, open, onOpenTaken }: Props) {
  const [collections, setCollections] = useState<Collection[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  // A collection picked somewhere else (the search page): the page opens
  // on it, once per ask.
  const [openTaken, setOpenTaken] = useState(0)
  if (open && open.n !== openTaken) {
    setOpenTaken(open.n)
    setSelected(open.id)
  }
  const openN = open?.n
  useEffect(() => { if (openN !== undefined) onOpenTaken?.() }, [openN, onOpenTaken])
  const [items, setItems] = useState<ServerMediaItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadingItems, setLoadingItems] = useState(false)
  // 2026-06-17 (a11y quick-win) — replaces window.confirm / window.alert
  // on remove-from-collection + delete-collection. The native dialogs
  // clash with the dark glass UI and aren't part of the app's design
  // language. `confirm` holds the pending destructive op; `dialogError`
  // surfaces a failure inside the same dialog so the user can retry /
  // cancel without a jarring native popup.
  const [confirm, setConfirm] = useState<
    | { kind: 'remove'; collectionId: number; mediaId: number; title: string }
    | { kind: 'delete'; collectionId: number; title: string }
    | null
  >(null)
  const [dialogError, setDialogError] = useState<string | null>(null)

  // Pressing the Collections nav item again goes back to the index. Only a
  // press made while this page is up: the counter is the app's, one for
  // every destination, so a page mounted later starts from whatever it has
  // reached. It used to skip only a count of zero, and with any nav item
  // re-pressed earlier in the session it ran on mount and undid a selection
  // the page was opened on (a collection picked on the search page).
  const rewindSeen = useRef(rewindNonce)
  useEffect(() => {
    if (rewindNonce === rewindSeen.current) return
    rewindSeen.current = rewindNonce
    setSelected(null)
  }, [rewindNonce])

  // Initial list fetch.
  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    listCollections(ac.signal)
      .then((c) => { if (!cancelled) setCollections(c) })
      .catch((e) => {
        if (!cancelled && e.name !== 'AbortError') {
          setError(e instanceof Error ? e.message : 'Failed to load')
        }
      })
    return () => { cancelled = true; ac.abort() }
  }, [])

  // Detail fetch on selection.
  useEffect(() => {
    if (selected == null) {
      setItems([])
      return
    }
    let cancelled = false
    const ac = new AbortController()
    setLoadingItems(true)
    getCollection(selected, ac.signal)
      .then((d) => { if (!cancelled) setItems(d.items ?? []) })
      .catch(() => { /* surfaces via error state */ })
      .finally(() => { if (!cancelled) setLoadingItems(false) })
    return () => { cancelled = true; ac.abort() }
  }, [selected])

  // 2026-06-17 (a11y quick-win) — controlled confirm dialog for the
  // remove-from-collection + delete-collection destructive actions
  // (replaces window.confirm / window.alert). Rendered once and
  // appended to both the detail and list return paths below.
  const confirmDialog = confirm && (
    <AlertDialog
      open
      onOpenChange={(o) => { if (!o) { setConfirm(null); setDialogError(null) } }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {confirm.kind === 'remove' ? `Remove "${confirm.title}"?` : `Delete "${confirm.title}"?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {confirm.kind === 'remove'
              ? 'Remove this title from the collection?'
              : 'Delete this collection? This cannot be undone.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {dialogError && <p role="alert" className="text-sm text-red-400">{dialogError}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 hover:bg-red-500 text-white"
            onClick={async (e) => {
              // Keep the dialog open while the op runs / on error so
              // dialogError shows in place. Radix closes AlertDialog
              // Action on click by default; preventDefault stops that.
              e.preventDefault()
              try {
                if (confirm.kind === 'remove') {
                  // Capture the removed member's poster BEFORE dropping it from
                  // `items`, so the cached list's mosaic can be patched too.
                  const removedPoster = items.find((x) => x.id === confirm.mediaId)?.poster_path
                  await removeFromCollection(confirm.collectionId, confirm.mediaId)
                  setItems((prev) => prev.filter((x) => x.id !== confirm.mediaId))
                  setCollections((prev) =>
                    prev?.map((c) =>
                      c.id === confirm.collectionId
                        ? {
                            ...c,
                            item_count: Math.max(0, (c.item_count ?? 1) - 1),
                            // poster_paths has to be patched alongside
                            // item_count. The list is fetched once on mount and
                            // the back-to-index path just clears `selected`, so
                            // without this the card kept rendering the removed
                            // title's poster as strip 1 while its caption read
                            // one fewer title. A stale cover_path was
                            // defensible — it's a server-sticky value by design
                            // — but poster_paths claims to BE the collection's
                            // first four members, so a stale entry is a wrong
                            // claim, not just an old picture.
                            //
                            // This does not backfill a 5th member into the
                            // vacated slot; the next list fetch does that. Four
                            // real members shown as three beats three real
                            // members shown as four.
                            poster_paths: removedPoster
                              ? c.poster_paths?.filter((p) => p !== removedPoster)
                              : c.poster_paths,
                          }
                        : c,
                    ) ?? null,
                  )
                } else {
                  await deleteCollection(confirm.collectionId)
                  setCollections((prev) => prev?.filter((x) => x.id !== confirm.collectionId) || [])
                  // If viewing the deleted collection's detail, pop back to the list.
                  if (selected === confirm.collectionId) setSelected(null)
                }
                setConfirm(null)
                setDialogError(null)
              } catch (err) {
                setDialogError(
                  (confirm.kind === 'remove' ? 'Remove failed: ' : 'Delete failed: ') +
                  (err instanceof Error ? err.message : 'unknown'),
                )
              }
            }}
          >
            {confirm.kind === 'remove' ? 'Remove' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  // In words, never the transport's own message (it read "HTTP 500").
  // (The page's heading is drawn in these two states as well: it is the
  // only heading the page has.)
  if (error) return <><h1 className="sr-only">Collections</h1><p className="py-8 text-sm text-ink-2" role="alert">Collections could not be loaded. Reload the page to try again.</p></>
  if (collections === null) return <><h1 className="sr-only">Collections</h1><p className="py-8 text-sm text-ink-2" role="status">Loading collections…</p></>

  if (selected != null) {
    const c = collections.find((x) => x.id === selected)
    return (
      <>
      <div className="animate-fade-in">
        {/* autoFocus: drilling in swaps the whole return path, so the focused
            card unmounts and focus falls to <body>. A keyboard user then had to
            tab from the top of the document to get back. Landing focus on Back
            keeps them where the interaction left them (WCAG 2.4.3). */}
        <button
          type="button"
          autoFocus
          onClick={() => setSelected(null)}
          // The Library header has a "Collections" too (the scope's name):
          // this one says where it goes.
          aria-label="Back to collections"
          className="stage-colback inline-flex min-h-[44px] items-center gap-1.5 text-sm font-medium text-ink-2 hover:text-ink md:min-h-0"
        >
          <Icon name="arrowLeft" size={14} />
          Collections
        </button>
        {/* The collection's own heading: its name, and one line of facts
            (who filled it and from what words, how many titles, who can see
            it), then its note when it has one. */}
        <div className="mb-10 mt-4 flex flex-col gap-2.5">
          <h1 className="stage-coltitle">{c?.name || 'Collection'}</h1>
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2" data-collection-facts="">
            {c?.kind === 'ai' && <span className="aurora-dot" aria-hidden="true" />}
            {[
              c?.kind === 'ai' ? (c.prompt ? `Built by Aurora from “${c.prompt}”` : 'Built by Aurora') : '',
              loadingItems ? '' : `${items.length} title${items.length === 1 ? '' : 's'}`,
              c ? (c.is_public ? 'public' : 'private') : '',
            ].filter(Boolean).join(' · ')}
          </p>
          {c?.description && <p className="max-w-2xl text-[15px] text-ink-2">{c.description}</p>}
        </div>

        {loadingItems ? (
          <p className="text-sm text-ink-2" role="status">Loading…</p>
        ) : items.length === 0 ? (
          <div className="py-20 text-center">
            <p className="text-lg text-ink">This collection is empty.</p>
            <p className="mt-2 text-sm text-ink-2">
              Add titles from any poster's menu: its More button, a right click or a long press.
            </p>
          </div>
        ) : (
          // 2028-05-28 — Collections detail grid converted to the
          // shared <MediaCardCinema/>. The admin "remove from
          // collection" X is passed through as topRightOverlay so the
          // card's own JSX stays the same shape as every other surface.
          // Note that ServerMediaItem uses `poster_path` (not the UI
          // Media's `poster`), so we map the prop here.
          <div className="poster-grid">
            {items.map((m) => (
              <MediaCardCinema
                key={m.id}
                item={{
                  id: m.id,
                  title: m.title,
                  poster: posterURL(m.poster_path),
                  year: m.year,
                  // ServerMediaItem doesn't carry a UI-friendly rating
                  // on this endpoint — leave undefined so the star
                  // hides via the existing meta guard.
                }}
                onSelect={() => onOpenMedia(m.id)}
                onCardContext={(e) => onCardContext(e, m)}
                libraryIds={libraryIds}
                onToggleLib={onToggleLib ? () => onToggleLib(m) : undefined}
                topRightOverlay={isAdmin && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirm({ kind: 'remove', collectionId: selected, mediaId: m.id, title: m.title })
                    }}
                    title="Remove from collection"
                    aria-label={`Remove ${m.title} from collection`}
                    className="absolute top-3 right-3 z-[4] w-7 h-7 rounded-full bg-black/65 hover:bg-red-500/80 text-white text-xs flex items-center justify-center border border-white/15 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                  >
                    ×
                  </button>
                )}
              />
            ))}
          </div>
        )}
      </div>
      {confirmDialog}
      </>
    )
  }

  return (
    <>
    <div className="animate-fade-in">
      {/* No heading block of its own: the Library header's row names the
          page, and carries this count and "New collection" at its right. */}
      <h1 className="sr-only">Collections</h1>
      <LibraryTools>
        <p className="stage-libhead-note" role="status" data-collections-count="">
          {collections.length.toLocaleString()} collection{collections.length === 1 ? '' : 's'}
        </p>
        <button type="button" onClick={onOpenCreate} className="stage-btn stage-btn-sm stage-btn-ghost stage-hit44">
          <Icon name="plus" size={14} />
          New collection
        </button>
      </LibraryTools>

      {collections.length === 0 ? (
        <div className="py-20 text-center">
          <h2 className="text-lg text-ink">No collections yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-2">
            Make one by hand, or describe it and let Aurora fill it from your library.
          </p>
        </div>
      ) : (
        // <ul>/<li> so the grid announces as "list, N items". Each card is a
        // plain container holding two sibling buttons: the one that opens
        // the collection (the artwork, the name and the line under it), and,
        // for an admin, delete. Not one button inside the other (invalid),
        // and not role="button" on the container (it prunes its subtree from
        // the accessibility tree while keeping a focusable descendant).
        <ul className="stage-colgrid m-0 grid list-none p-0">
          {collections.map((c) => {
            const strips = collectionStrips(c)
            const count = c.item_count || 0
            // What the line under the name says, in words: how many, who
            // filled it, and who can see it.
            const facts = [`${count} title${count === 1 ? '' : 's'}`, c.kind === 'ai' ? 'built by Aurora' : '', c.is_public ? 'public' : 'private'].filter(Boolean)
            return (
              <li key={c.id} className="stage-colcard group relative list-none">
                <button
                  type="button"
                  onClick={() => setSelected(c.id)}
                  aria-label={`Open collection ${c.name}, ${facts.join(', ')}`}
                  className="stage-colcard-open flex w-full flex-col text-left"
                >
                  {/* Decorative: the button's label names the collection, and
                      four unlabelled posters would add noise, not information.
                      One to four strips share the width evenly (the count is
                      the collection's own); none leaves the frame's fill. */}
                  <span className="stage-colcard-art flex" aria-hidden="true">
                    {strips.map((src, i) => (
                      <img key={i} src={src} alt="" loading="lazy" className="h-full min-w-0 flex-1 object-cover" />
                    ))}
                  </span>
                  <span className="stage-colcard-name">{c.name}</span>
                  <span className="stage-colcard-meta flex items-center">
                    {c.kind === 'ai' && <span className="aurora-dot" aria-hidden="true" />}
                    {facts.join(' · ')}
                  </span>
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => setConfirm({ kind: 'delete', collectionId: c.id, title: c.name })}
                    // Shown on hover and on keyboard focus: opacity-0 alone
                    // left a focusable control nobody could see.
                    className="stage-colcard-delete absolute right-2 top-2 grid place-items-center opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                    title="Delete collection"
                    aria-label={`Delete collection ${c.name}`}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
    {confirmDialog}
    </>
  )
}
