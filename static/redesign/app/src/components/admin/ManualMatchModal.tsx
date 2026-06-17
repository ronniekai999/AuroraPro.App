// Manual identify modal — shared by App (the global admin-only
// "manual identify" overlay, rendered at App level so it overlays any
// screen) and by AdminView's Flagged tab. Extracted to its own module
// (2026-06-17 app split) so App can import it WITHOUT pulling the lazy
// AdminView chunk into the main bundle — a static import from
// AdminView.tsx would defeat the code split.

import { useState, useEffect } from 'react'
import {
  searchForMatch,
  manualMatch,
  tmdbPosterURL,
  type MatchSearchResult,
  type ServerMediaItem,
} from '@/lib/api'
import { Icon } from '@/components/Icon'

// Phase 5.3 — Manual match modal. Search TMDB (and TVDB for shows),
// pick a candidate, confirm. Posts to /api/media/{id}/match. Also
// supports direct-ID entry for the case where the user has the
// TMDB/TVDB ID handy from a browser tab.
export default function ManualMatchModal({ target, onClose, onMatched }: {
  target: ServerMediaItem
  onClose: () => void
  onMatched: () => void
}) {
  const isShow = target.type === 'show'
  const [q, setQ] = useState(target.title)
  const [results, setResults] = useState<MatchSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [directIdSource, setDirectIdSource] = useState<'tmdb' | 'tvdb'>('tmdb')
  const [directId, setDirectId] = useState('')
  useEffect(() => {
    const term = q.trim()
    if (!term) { setResults([]); return }
    const ac = new AbortController()
    setSearching(true)
    const t = window.setTimeout(() => {
      void searchForMatch(term, isShow ? 'show' : 'movie', ac.signal)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 300)
    return () => { window.clearTimeout(t); ac.abort() }
  }, [q, isShow])

  const submit = async (source: 'tmdb' | 'tvdb', id: number) => {
    setSubmitting(true)
    try {
      const body: { tmdb_id?: number; tvdb_id?: number; type: 'movie' | 'show' } = {
        type: isShow ? 'show' : 'movie',
      }
      if (source === 'tvdb') body.tvdb_id = id
      else body.tmdb_id = id
      await manualMatch(target.id, body)
      window.alert(`Matched "${target.title}". Metadata is re-enriching in the background.`)
      onMatched()
    } catch (err) {
      window.alert('Match failed: ' + (err instanceof Error ? err.message : 'unknown'))
    } finally { setSubmitting(false) }
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-start justify-center p-4 pt-16" onClick={onClose}>
      <div className="w-full max-w-xl bg-[#0a0a0f] border border-white/[0.06] rounded-2xl p-5 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-white text-lg font-semibold">Match "{target.title}"</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/70 hover:text-white text-lg flex items-center justify-center">×</button>
        </div>
        <p className="text-white/40 text-xs mb-3 truncate">{target.file_path}</p>

        <input
          type="text"
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={isShow ? 'Search TMDB or TVDB for the show…' : 'Search TMDB for the movie…'}
          className="w-full px-4 py-2.5 bg-white/[0.04] border border-white/[0.06] rounded-lg text-white text-sm focus:outline-none focus:bg-white/[0.06] mb-3"
        />

        <div className="flex-1 overflow-y-auto space-y-2 mb-3">
          {searching && <p className="text-white/40 text-sm">Searching…</p>}
          {!searching && q.trim() && results.length === 0 && <p className="text-white/40 text-sm">No candidates.</p>}
          {results.map(r => (
            <div key={`${r.source}-${r.id}`} className="flex items-center gap-3 p-2 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.04]">
              <div className="w-[50px] h-[75px] rounded bg-white/5 flex-shrink-0 overflow-hidden flex items-center justify-center">
                {/* Audit L3 (Phase 5.3 audit-8) — TMDB posters are
                    relative paths (need CDN prefix); TVDB
                    image_url is a full URL (render directly).
                    QA 2026-05-25 — explicit glyph fallback for
                    posterless candidates. */}
                {r.poster_path ? (
                  // 2026-05-27 — Dropped crossOrigin="anonymous" for
                  // the same reason as RequestsView (TMDB's CDN
                  // intermittently serves responses without the CORS
                  // header for less-popular posters). The onError
                  // handler hides the broken image so the bg-white/5
                  // wrapper shows through instead of broken alt-text.
                  <img
                    // Deep-debug M1 — key on src so a future
                    // poster_path update remounts the img and
                    // resets the inline display:none mutation.
                    key={r.poster_path}
                    src={r.source === 'tvdb' ? r.poster_path : tmdbPosterURL(r.poster_path)}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <Icon name="film" size={20} className="text-white/25" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white/90 text-sm font-medium truncate">{r.title}{r.year ? ` (${r.year})` : ''}</p>
                <p className="text-white/40 text-[10px] uppercase">{r.source} · id {r.id}</p>
                {r.overview && <p className="text-white/40 text-xs line-clamp-2 mt-1">{r.overview}</p>}
              </div>
              <button
                disabled={submitting}
                onClick={() => void submit(r.source, r.id)}
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded disabled:opacity-50"
              >
                Match
              </button>
            </div>
          ))}
        </div>

        {/* Direct-ID path — when the user has a TMDB/TVDB ID in hand. */}
        <div className="border-t border-white/[0.06] pt-3">
          <p className="text-white/40 text-xs mb-2">Or match by ID directly:</p>
          <div className="flex gap-2">
            <select value={directIdSource} onChange={e => setDirectIdSource(e.target.value as 'tmdb' | 'tvdb')} className="px-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm">
              <option value="tmdb">TMDB</option>
              {isShow && <option value="tvdb">TVDB</option>}
            </select>
            <input
              value={directId}
              onChange={e => setDirectId(e.target.value)}
              placeholder="123456"
              className="flex-1 px-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm"
            />
            <button
              disabled={submitting || !directId.trim() || !/^\d+$/.test(directId.trim())}
              onClick={() => void submit(directIdSource, parseInt(directId.trim(), 10))}
              className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded disabled:opacity-50"
            >
              {submitting ? 'Matching…' : 'Match by ID'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
