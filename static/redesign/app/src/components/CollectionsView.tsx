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

interface Props {
  isAdmin: boolean
  onOpenCreate: () => void
  onOpenMedia: (id: number) => void
}

export function CollectionsView({ isAdmin, onOpenCreate, onOpenMedia }: Props) {
  const [collections, setCollections] = useState<Collection[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [items, setItems] = useState<ServerMediaItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadingItems, setLoadingItems] = useState(false)

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

  if (error) return <p className="text-red-300 p-8">{error}</p>
  if (collections === null) return <p className="text-white/40 p-8">Loading collections…</p>

  if (selected != null) {
    const c = collections.find((x) => x.id === selected)
    return (
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
        <p className="text-white/40 text-sm mb-8">
          {items.length} title{items.length === 1 ? '' : 's'}
        </p>

        {loadingItems ? (
          <p className="text-white/40 text-sm">Loading…</p>
        ) : items.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-white/60 text-lg">This collection is empty.</p>
            <p className="text-white/40 text-sm mt-2">
              Add titles via the right-click context menu on any media card.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
            {items.map((m) => (
              <div
                key={m.id}
                className="media-card group cursor-pointer"
                onClick={() => onOpenMedia(m.id)}
              >
                <div className="relative aspect-[2/3] overflow-hidden rounded-xl">
                  <img
                    src={posterURL(m.poster_path)}
                    alt={m.title}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                  {isAdmin && (
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (!window.confirm(`Remove "${m.title}" from this collection?`)) return
                        try {
                          await removeFromCollection(selected, m.id)
                          setItems((prev) => prev.filter((x) => x.id !== m.id))
                          // Audit L4 fix — decrement the cached
                          // item_count on the parent list so the
                          // detail-view → back-to-list path doesn't
                          // show a stale count.
                          setCollections((prev) =>
                            prev?.map((c) =>
                              c.id === selected
                                ? { ...c, item_count: Math.max(0, (c.item_count ?? 1) - 1) }
                                : c,
                            ) ?? null,
                          )
                        } catch (err) {
                          window.alert('Remove failed: ' + (err instanceof Error ? err.message : 'unknown'))
                        }
                      }}
                      className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 hover:bg-red-500/80 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs"
                      title="Remove from collection"
                    >
                      ×
                    </button>
                  )}
                </div>
                <div className="mt-2">
                  <h3 className="text-white/90 text-sm font-medium truncate">{m.title}</h3>
                  {m.year && (
                    <span className="text-white/40 text-xs">{m.year}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
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
          <p className="text-white/40 text-sm mt-2 max-w-md mx-auto">
            Create one manually or describe a vibe and let Aurora's AI build it
            from your library.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-5">
          {collections.map((c) => (
            <div
              key={c.id}
              onClick={() => setSelected(c.id)}
              className="cursor-pointer rounded-2xl border border-white/[0.06] overflow-hidden bg-gradient-to-br from-purple-900/30 via-[#0a0a0f] to-[#050505] hover:border-purple-500/40 transition-all group relative h-[180px] p-5 flex flex-col justify-end"
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
                  onClick={async (e) => {
                    e.stopPropagation()
                    if (!window.confirm(`Delete "${c.name}"? This can't be undone.`)) return
                    try {
                      await deleteCollection(c.id)
                      setCollections((prev) => prev?.filter((x) => x.id !== c.id) || [])
                    } catch (err) {
                      window.alert('Delete failed: ' + (err instanceof Error ? err.message : 'unknown'))
                    }
                  }}
                  className="absolute top-3 right-3 w-7 h-7 rounded-full bg-black/40 hover:bg-red-500/80 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs z-10"
                  title="Delete collection"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
