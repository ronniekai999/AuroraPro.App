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
                  await removeFromCollection(confirm.collectionId, confirm.mediaId)
                  setItems((prev) => prev.filter((x) => x.id !== confirm.mediaId))
                  setCollections((prev) =>
                    prev?.map((c) =>
                      c.id === confirm.collectionId
                        ? { ...c, item_count: Math.max(0, (c.item_count ?? 1) - 1) }
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
        <button
          onClick={() => setSelected(null)}
          className="flex items-center gap-2 text-white/60 hover:text-white text-sm mb-6"
        >
          ← Back to collections
        </button>
        <h1 className="text-white text-4xl font-bold font-display mb-1">
          {c?.name || 'Collection'}
        </h1>
        {c?.description && (
          <p className="text-white/60 text-sm mb-2">{c.description}</p>
        )}
        {c?.kind === 'ai' && c.prompt && (
          <p className="text-purple-300/80 text-xs italic mb-6">
            ✨ AI-curated from: "{c.prompt}"
          </p>
        )}
        <p className="text-white/60 text-sm mb-8">
          {items.length} title{items.length === 1 ? '' : 's'}
        </p>

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
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 mb-3">
            <span className="text-purple-200 text-xs font-medium uppercase tracking-wider">
              Curated
            </span>
          </div>
          <h1 className="text-white text-4xl font-bold font-display">Collections</h1>
          <p className="text-white/60 text-sm mt-2">
            {collections.length} collection{collections.length === 1 ? '' : 's'} —
            curated manually or by Aurora's AI.
          </p>
        </div>
        <button
          onClick={onOpenCreate}
          className="px-5 py-2.5 bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded-full transition-all glow-purple"
        >
          + New Collection
        </button>
      </div>

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
        // keyboard/AT affordance. Each card is now keyboard-operable
        // (role=button + tabIndex), announced via aria-label, activates on
        // Enter/Space, and shows a visible focus ring. We keep a
        // <div role="button"> rather than a real <button> because the admin
        // delete control below is itself a <button> — nesting <button>
        // inside <button> is invalid HTML, whereas role="button" avoids
        // that. The delete button stops propagation on BOTH click and keydown,
        // so its activation never bubbles up to this card handler.
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-5">
          {collections.map((c) => (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              aria-label={`Open collection ${c.name}`}
              onClick={() => setSelected(c.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelected(c.id)
                }
              }}
              className="cursor-pointer rounded-2xl border border-white/[0.06] overflow-hidden bg-gradient-to-br from-purple-900/30 via-[#0a0a0f] to-[#050505] hover:border-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#050505] transition-all group relative h-[180px] p-5 flex flex-col justify-end"
            >
              {c.cover_path && (
                <img
                  src={backdropURL(c.cover_path)}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover opacity-30 group-hover:opacity-40 transition-opacity"
                  loading="lazy"
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-[#050505] via-[#050505]/70 to-transparent" />
              <div className="relative">
                <div className="flex items-center gap-2 mb-2">
                  {c.kind === 'ai' && (
                    <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider bg-purple-500/20 text-purple-200 border border-purple-500/30 rounded">
                      ✨ AI
                    </span>
                  )}
                  {c.is_public && (
                    <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider bg-emerald-500/15 text-emerald-200 border border-emerald-500/30 rounded">
                      Public
                    </span>
                  )}
                </div>
                <h3 className="text-white text-xl font-bold font-display mb-1">
                  {c.name}
                </h3>
                <p className="text-white/50 text-xs">
                  {c.item_count || 0} title{c.item_count === 1 ? '' : 's'}
                </p>
              </div>
              {isAdmin && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirm({ kind: 'delete', collectionId: c.id, title: c.name })
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="absolute top-3 right-3 w-7 h-7 rounded-full bg-black/40 hover:bg-red-500/80 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs z-10"
                  title="Delete collection"
                  aria-label={`Delete collection ${c.name}`}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
    {confirmDialog}
    </>
  )
}
