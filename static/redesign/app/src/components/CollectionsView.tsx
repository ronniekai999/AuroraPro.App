// Phase 6 — Collections list/detail view.
//
// Two states: list (all visible collections) and detail (one
// collection's items). Click a collection card → detail.

import { useEffect, useState } from 'react'
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
import { PageHeader } from '@/components/PageHeader'
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
  if (c.cover_path) return [backdropURL(c.cover_path)]
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
  // QA 2026-05-25 — bumped by App.handleNavigate when the user clicks
  // the Collections nav item while already on /collections. Acts as
  // a "back to index" signal so the side-nav doubles as a back
  // button from a collection detail view. Optional so callers that
  // don't wire it just keep the old behavior (drill-down state
  // sticky until the user clicks the in-page Back affordance).
  rewindNonce?: number
}

export default function CollectionsView({ isAdmin, onOpenCreate, onOpenMedia, libraryIds, onToggleLib, rewindNonce }: Props) {
  const [collections, setCollections] = useState<Collection[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
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

  // Re-click on the Collections nav resets to the index. Skip the
  // initial render (nonce === 0 OR undefined) so first-paint doesn't
  // wipe a selection set via deep-link.
  useEffect(() => {
    if (rewindNonce === undefined || rewindNonce === 0) return
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
      .then((d) => { if (!cancelled) setItems(d.items) })
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

  if (error) return <p className="text-red-300 p-8">{error}</p>
  if (collections === null) return <p className="text-white/60 p-8">Loading collections…</p>

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
          className="inline-flex items-center gap-2 text-white/60 hover:text-white text-sm mb-6"
        >
          <Icon name="arrowLeft" size={14} />
          Back to collections
        </button>
        {/* PageHeader, like the index — this was the sixth header surface in the
            app with a seventh title treatment (a hand-rolled text-4xl h1), which
            is exactly the divergence PageHeader exists to stop, one level
            deeper than the five screens Phase 6 set out to cover. */}
        <PageHeader
          eyebrow={c?.kind === 'ai' ? 'AI-curated' : 'Curated'}
          title={c?.name || 'Collection'}
          sub={
            <>
              {items.length} title{items.length === 1 ? '' : 's'}
              {c?.description && <span className="block mt-1">{c.description}</span>}
              {c?.kind === 'ai' && c.prompt && (
                <span className="block mt-1 text-purple-300/80 text-xs italic">
                  ✨ AI-curated from: "{c.prompt}"
                </span>
              )}
            </>
          }
          className="mb-8"
        />

        {loadingItems ? (
          <p className="text-white/60 text-sm">Loading…</p>
        ) : items.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-white/60 text-lg">This collection is empty.</p>
            <p className="text-white/60 text-sm mt-2">
              Add titles via the right-click context menu on any media card.
            </p>
          </div>
        ) : (
          // 2028-05-28 — Collections detail grid converted to the
          // shared <MediaCardCinema/>. The admin "remove from
          // collection" X is passed through as topRightOverlay so the
          // card's own JSX stays the same shape as every other surface.
          // Note that ServerMediaItem uses `poster_path` (not the UI
          // Media's `poster`), so we map the prop here.
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
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
      <PageHeader
        eyebrow="Curated"
        title="Collections"
        sub={`Smart shelves, yours and Aurora's — ${collections.length} collection${collections.length === 1 ? '' : 's'}`}
        action={
          // The mockup's dashed "+ New Collection" tile. Dashed reads as "this
          // creates a new thing" rather than "this is a thing", which matters
          // here because it sits directly above a grid of solid cards that all
          // OPEN something.
          <button type="button" onClick={onOpenCreate} className="stage-newcol inline-flex px-5">
            <Icon name="plus" size={14} />
            New Collection
          </button>
        }
      />

      {collections.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-white/60 text-lg">No collections yet.</p>
          <p className="text-white/60 text-sm mt-2 max-w-md mx-auto">
            Create one manually or describe a vibe and let Aurora's AI build it
            from your library.
          </p>
        </div>
      ) : (
        // Audit MED — collection cards were bare <div onClick> with no
        // keyboard/AT affordance. Each card is now operable by keyboard and
        // announced via aria-label.
        //
        // The mechanism changed in Phase 6. It used to be `role="button"` on
        // the card container, chosen specifically because the admin delete
        // control is a <button> and nesting <button> in <button> is invalid.
        // That traded one problem for a worse one: role="button" is Children
        // Presentational, so it pruned the card's own subtree AND still held a
        // focusable descendant. Two real sibling <button>s — one stretched over
        // the card, one for delete — has neither problem, and needs no
        // stopPropagation at all.
        //
        // <ul>/<li> so the grid announces as "list, N items".
        <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3.5 list-none p-0 m-0">
          {collections.map((c) => {
            const strips = collectionStrips(c)
            return (
              // The CARD is a plain container; the whole-surface click target is
              // a real <button> stretched over it with position:absolute inset-0
              // (see below), and the admin delete <button> is a SIBLING of that
              // rather than a descendant.
              //
              // This replaces `role="button" tabIndex={0}` on the container. That
              // pattern avoided invalid button-in-button nesting, which the old
              // comment here claimed settled the matter — but role="button" is
              // Children Presentational (ARIA 1.2 §5.2.8), so it pruned the
              // subtree from the accessibility tree AND held a focusable
              // descendant, which the spec forbids and Chrome half-honours
              // (pruned from the a11y tree, still in the tab order). Two real
              // buttons side by side has neither problem.
              <li key={c.id} className="stage-colcard group list-none">
                {/* aria-hidden: the strips are decorative — the button's label
                    names the collection and its size, and announcing four
                    unlabelled member posters would add noise, not information. */}
                <div className="absolute inset-0 flex" aria-hidden="true">
                  {strips.map((src, i) => (
                    <img
                      key={i}
                      src={src}
                      alt=""
                      loading="lazy"
                      // flex-1 min-w-0 so 1, 2, 3 or 4 strips each fill the
                      // card evenly — the count is data-driven (a collection
                      // with two members yields two strips), so a fixed 25%
                      // would leave dead space.
                      className="flex-1 min-w-0 h-full object-cover"
                    />
                  ))}
                </div>
                <div className="stage-colcard-scrim" />
                {/* The click target: a real button covering the card, under the
                    badge row's z-[3] so the delete control stays clickable.
                    z-[2] also puts it above the strips and scrim. */}
                <button
                  type="button"
                  onClick={() => setSelected(c.id)}
                  aria-label={`Open collection ${c.name}, ${c.item_count || 0} ${c.item_count === 1 ? 'title' : 'titles'}`}
                  className="absolute inset-0 z-[2] w-full h-full flex flex-col justify-end items-start text-left px-[17px] pb-[14px] rounded-[15px]"
                >
                  <span className="font-display text-[16.5px] font-bold text-white truncate max-w-full">{c.name}</span>
                  <span className="text-[11.5px] text-white/65 mt-0.5">
                    {c.item_count || 0} title{c.item_count === 1 ? '' : 's'}
                  </span>
                </button>
                {/* Badges top-right. The admin delete control also wants that
                    corner, so it is offset LEFT of the badges rather than
                    stacked on top of them — an earlier version put both at
                    top-3 right-3 and the × landed on the "Public" chip. */}
                <div className="absolute top-3 right-3.5 z-[3] flex items-center gap-1.5">
                  {c.kind === 'ai' && <span className="stage-cbadge stage-cbadge-ai">✨ AI</span>}
                  {c.is_public && <span className="stage-cbadge stage-cbadge-pub">PUBLIC</span>}
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => setConfirm({ kind: 'delete', collectionId: c.id, title: c.name })}
                      // focus-visible:opacity-100 alongside the hover reveal:
                      // opacity-0 alone left this focusable but invisible, so
                      // a keyboard user tabbing the grid hit an unseen control
                      // (WCAG 2.4.7). No stopPropagation needed now that the
                      // card's handler lives on a sibling, not an ancestor.
                      className="w-7 h-7 rounded-md grid place-items-center bg-black/60 hover:bg-red-500/80 text-white/80 hover:text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                      title="Delete collection"
                      aria-label={`Delete collection ${c.name}`}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  )}
                </div>
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
