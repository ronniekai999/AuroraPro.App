// Requests view — submitted requests with status, plus an inline TMDB
// search + create dialog. Extracted from App.tsx (2026-06-17 app split,
// Phase 2.3). humanizeRequestError (raw server error -> a short friendly
// sentence, raw kept as a tooltip for admin debugging) rides along as a
// module-private helper — RequestsView is its only consumer. The status/
// date formatting uses formatRequestDate (shared leaf, Phase 0a).

import { useState, useEffect, useMemo } from 'react'
import { Icon } from '@/components/Icon'
import { PageHeader, FilterPills, type FilterPillOption } from '@/components/PageHeader'
import { formatRequestDate } from '@/lib/format'
import {
  createRequest,
  deleteRequest,
  searchTmdb,
  tmdbPosterURL,
  type MediaRequest,
  type TmdbSearchResult,
} from '@/lib/api'

/* ─────────────────────── REQUEST ERROR HUMANIZER ─────────────────────── */
// Server-side request errors are raw Radarr/Sonarr/TVDB API
// responses meant for logs. Pattern-match the common shapes and
// surface a short, friendly sentence. The raw error stays available
// as a tooltip in RequestsView for admin debugging.
function humanizeRequestError(raw: string, mediaType: 'movie' | 'tv'): string {
  if (!raw) return ''
  const r = raw.toLowerCase()
  const kind = mediaType === 'tv' ? 'show' : 'movie'

  // Already-added: Radarr's MovieExistsValidator / Sonarr's
  // SeriesExistsValidator. Common when a user re-requests after a
  // successful add, or a TMDB ID was matched to an existing import.
  if (r.includes('movieexistsvalidator') || r.includes('this movie has already been added')
      || r.includes('seriesexistsvalidator') || r.includes('this series has already been added')) {
    return mediaType === 'tv'
      ? 'This series is already in your Sonarr library.'
      : 'This movie is already in your Radarr library.'
  }

  // TVDB miss — show hasn't propagated yet or doesn't exist on
  // TVDB at all (common for Asian content with non-Latin titles).
  if (r.includes('tvdb') && (r.includes('not found') || r.includes('not be added to tvdb yet') || r.includes("couldn't find") || r.includes('series not found'))) {
    return `TVDB doesn't have this ${kind} yet — try again in a few hours or add it manually at thetvdb.com.`
  }

  // Sonarr's TMDB→TVDB resolver failed
  if (r.includes('sonarr') && (r.includes('lookup') || r.includes('resolve'))) {
    return `Sonarr couldn't match this ${kind} to a TVDB entry.`
  }

  // Generic *arr API failures (4xx/5xx from the *arr endpoint)
  if (r.includes('failed to add') && r.includes('radarr')) {
    return 'Radarr rejected this request. The download server may be busy — try again shortly.'
  }
  if (r.includes('failed to add') && r.includes('sonarr')) {
    return 'Sonarr rejected this request. The download server may be busy — try again shortly.'
  }

  // Network / auth — Aurora's own client-side translation
  if (r.includes('connection refused') || r.includes('econnrefused') || r.includes('dial tcp')) {
    return 'Couldn\'t reach the download server. Check that Radarr/Sonarr is online.'
  }
  if (r.includes('timeout') || r.includes('deadline exceeded')) {
    return 'The download server took too long to respond. Try again in a moment.'
  }
  if (r.includes('401') || r.includes('unauthorized') || r.includes('api key')) {
    return 'Download server rejected our API key. Ask an admin to verify keys in Admin → Integrations.'
  }
  if (r.includes('quality profile') || r.includes('qualityprofile')) {
    return 'Quality profile not configured. An admin needs to pick a default in Admin → Integrations.'
  }

  // Path / root folder problems
  if (r.includes('root folder') || r.includes('rootfolder')) {
    return 'Download server has no root folder configured. An admin needs to set one.'
  }

  // No matches from TMDB search (very rare since we usually only
  // submit valid TMDB IDs, but possible if metadata changed since)
  if (r.includes('no matches') || r.includes('no results')) {
    return `We couldn't find a matching ${kind}. The metadata may have changed since you requested.`
  }

  // Fall back: strip the noisy JSON-validator block (the
  // `[{ "propertyName": ..., "errorMessage": ... }]` payload) and
  // present whatever readable prefix remains. If the result is
  // still too long or looks like raw API output, use a generic.
  const stripped = raw
    .replace(/\[\s*\{[\s\S]*\}\s*\]/g, '')     // strip JSON arrays
    .replace(/api error \(status \d+\):?\s*/i, '')
    .replace(/^[a-z]+: /i, '')                   // strip "radarr:" prefixes
    .trim()
    .replace(/\s+/g, ' ')
  if (stripped.length > 0 && stripped.length < 140) {
    // Capitalize first letter for sentence-case polish.
    return stripped[0].toUpperCase() + stripped.slice(1)
  }
  return 'Something went wrong on the download server. Hover for technical details.'
}

/* ─────────────────────── REQUESTS VIEW ─────────────────────── */
// RequestsView — submitted requests with status. Includes an inline
// TMDB search + create dialog.
export default function RequestsView({ requests, onRequestSubmitted, onRequestDeleted }: { requests: MediaRequest[] | null; onRequestSubmitted: (r: MediaRequest) => void; onRequestDeleted: (id: number) => void }) {
  const [filter, setFilter] = useState<'all' | 'pending' | 'pending_approval' | 'processing' | 'available' | 'failed'>('all')
  // QA 2026-05-25 — request cards looked clickable but didn't do
  // anything when clicked. The request carries `overview` text from
  // TMDB that we were fetching and storing but never rendering. Now:
  // clicking a card toggles an inline overview reveal. Tracks which
  // request IDs are currently expanded so multiple can be open at
  // once. Closes on a second click. Stays a no-op if overview is
  // empty (some older TMDB entries have nothing).
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  // Inline TMDB search + create dialog.
  const [createOpen, setCreateOpen] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<TmdbSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [submitting, setSubmitting] = useState<number | null>(null) // tmdb_id currently submitting
  // 4K toggle — default false. We can't easily probe whether a 4K
  // ARR service is configured here, so we always offer it.
  const [requestQuality4K, setRequestQuality4K] = useState(false)
  useEffect(() => {
    if (!createOpen) return
    const q = searchQ.trim()
    if (!q) { setSearchResults([]); return }
    setSearching(true)
    const ac = new AbortController()
    const id = window.setTimeout(() => {
      void searchTmdb(q, ac.signal).then(r => setSearchResults(r)).catch(() => setSearchResults([])).finally(() => setSearching(false))
    }, 300)
    return () => { window.clearTimeout(id); ac.abort() }
  }, [searchQ, createOpen])

  // Status → .stage-stb variant. The five colours are UNCHANGED from the
  // Tailwind map this replaces (amber pending / orange pending-approval / blue
  // processing / emerald available / red failed) — they moved into index.css
  // because each is a coordinated fill+border+text triple, and the mockup's
  // own badge palette happens to agree with all five. The semantics are the
  // server's, so this is a relocation, not a recolour.
  const statusBadge: Record<string, string> = {
    pending: 'stage-stb-pending',
    // Held for admin approval (carve-out C) — distinct orange so it reads
    // apart from the amber "pending" (admitted, awaiting dispatch).
    pending_approval: 'stage-stb-approval',
    processing: 'stage-stb-processing',
    available: 'stage-stb-available',
    failed: 'stage-stb-failed',
  }
  // Status display labels. snake_case statuses (pending_approval) need an
  // explicit human label since the badge otherwise renders the raw value.
  const statusLabels: Record<string, string> = {
    pending_approval: 'Pending approval',
  }

  // Counts for the filter pills. Computed in one pass over the list rather
  // than a .filter() per pill inside the render (which is what the previous
  // inline version did — six passes over every request on every keystroke of
  // the unrelated TMDB search box, because that state lives in this
  // component). Keyed on `requests` so it recomputes only when the data does.
  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of requests ?? []) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [requests])

  const filterOptions: FilterPillOption<typeof filter>[] = [
    { value: 'all', label: 'All', count: requests?.length ?? 0 },
    { value: 'pending', label: 'Pending', count: statusCounts.pending ?? 0 },
    { value: 'pending_approval', label: 'Pending approval', count: statusCounts.pending_approval ?? 0 },
    { value: 'processing', label: 'Processing', count: statusCounts.processing ?? 0 },
    { value: 'available', label: 'Available', count: statusCounts.available ?? 0 },
    { value: 'failed', label: 'Failed', count: statusCounts.failed ?? 0 },
  ]

  const newRequestButton = (
    <button
      type="button"
      onClick={() => setCreateOpen(true)}
      className="stage-btn stage-btn-primary"
    >
      <Icon name="plus" size={15} />
      Request New
    </button>
  )

  if (requests === null) {
    return (
      <div className="animate-fade-in">
        <PageHeader title="Requests" sub="Loading requests…" />
      </div>
    )
  }

  const filtered = filter === 'all' ? requests : requests.filter(r => r.status === filter)

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Requests"
        sub={`${requests.length} total`}
        action={newRequestButton}
      />

      {/* Phase 4.6 — TMDB search + create dialog. Small modal so
          users don't lose scroll position in the requests list. */}
      {createOpen && (
        <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-start justify-center p-4 pt-20" onClick={() => setCreateOpen(false)}>
          <div className="w-full max-w-xl bg-[#0a0a0f] border border-white/[0.06] rounded-2xl p-5 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-white text-lg font-semibold">Request a Movie or TV Show</h2>
              <button onClick={() => setCreateOpen(false)} className="w-8 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/70 hover:text-white text-lg flex items-center justify-center">×</button>
            </div>
            <input
              type="text"
              autoFocus
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="Search TMDB for title…"
              className="w-full px-4 py-2.5 bg-white/[0.04] border border-white/[0.06] rounded-lg text-white text-sm focus:outline-none focus:bg-white/[0.06] mb-3"
            />
            {/* 4K request toggle. Server-side, this routes to the
                configured *_4k Radarr/Sonarr; without one it falls
                back to the 1080p ARR. */}
            <label className="flex items-center gap-2 mb-3 text-sm text-white/70">
              <input type="checkbox" checked={requestQuality4K} onChange={e => setRequestQuality4K(e.target.checked)} />
              Request in 4K when available
            </label>
            <div className="flex-1 overflow-y-auto space-y-2">
              {searching && <p className="text-white/40 text-sm">Searching…</p>}
              {!searching && searchResults.length === 0 && searchQ.trim() && <p className="text-white/40 text-sm">No matches.</p>}
              {searchResults.map(r => (
                <div key={`${r.media_type}-${r.tmdb_id}`} className="flex items-center gap-3 p-2 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.04]">
                  {/* QA 2026-05-25 — explicit placeholder for entries
                      with no TMDB poster (older + obscure titles).
                      Previously rendered as an empty box; now shows
                      a film/TV glyph centered in the same frame, so
                      the row layout stays consistent. */}
                  <div className="w-[50px] h-[75px] rounded bg-white/5 flex-shrink-0 overflow-hidden flex items-center justify-center">
                    {r.poster_path ? (
                      // 2026-05-27 — Dropped crossOrigin="anonymous".
                      // The previous comment claimed "TMDB serves
                      // Access-Control-Allow-Origin: * so the request
                      // succeeds" — that's only true for popular
                      // posters whose CloudFront edge cached the
                      // CORS-headered response first. For lower-traffic
                      // posters, an earlier non-CORS request can cache
                      // a response WITHOUT the header, and every
                      // subsequent crossorigin request fails (visible
                      // as broken alt-text in the card; verified on
                      // "In the City (2026)" 2026-05-27). Without the
                      // attribute the image always loads in normal
                      // viewing; the trade-off is that bug-report
                      // screenshots won't include the poster pixels
                      // (it'll render as an empty square), which is
                      // acceptable since the screenshot's purpose is
                      // UI state, not pixel-perfect imagery.
                      // onError hides the broken-image icon if the
                      // image genuinely 404s; the wrapper's bg-white/5
                      // backdrop takes over so the row layout stays
                      // consistent.
                      <img
                        // Deep-debug M1 — key the img on src so React
                        // unmounts/remounts when poster_path changes
                        // for the same row. Without this, the onError
                        // handler's direct DOM mutation (style.display
                        // = 'none') would persist across a re-render
                        // with a new src, hiding a perfectly good
                        // poster.
                        key={r.poster_path}
                        src={tmdbPosterURL(r.poster_path)}
                        alt=""
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                      />
                    ) : (
                      <Icon name={r.media_type === 'tv' ? 'tv' : 'film'} size={20} className="text-white/25" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white/90 text-sm font-medium truncate">{r.title}{r.year ? ` (${r.year})` : ''}</p>
                    <p className="text-white/40 text-xs uppercase">{r.media_type === 'tv' ? 'TV' : 'Movie'}</p>
                  </div>
                  <button
                    disabled={submitting === r.tmdb_id}
                    onClick={async () => {
                      setSubmitting(r.tmdb_id)
                      try {
                        const created = await createRequest({
                          media_type: r.media_type,
                          tmdb_id: r.tmdb_id,
                          title: r.title,
                          poster_path: r.poster_path || '',
                          overview: r.overview || '',
                          year: r.year || 0,
                          quality_1080p: !requestQuality4K,
                          quality_4k: requestQuality4K,
                        })
                        onRequestSubmitted(created)
                        setCreateOpen(false)
                        setSearchQ('')
                      } catch (err) {
                        const msg = err instanceof Error ? err.message : 'Failed to submit'
                        window.alert('Request failed: ' + msg)
                      } finally {
                        setSubmitting(null)
                      }
                    }}
                    className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submitting === r.tmdb_id ? 'Submitting…' : 'Request'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <FilterPills
        options={filterOptions}
        value={filter}
        onChange={setFilter}
        label="Filter requests by status"
        className="mb-6"
      />

      {filtered.length === 0 ? (
        <div className="text-center py-20">
          <Icon name="download" size={48} className="mx-auto text-white/20 mb-4" />
          <h3 className="text-white/60 text-lg mb-2">
            No requests {filter !== 'all' ? `in "${statusLabels[filter] ?? filter}"` : 'yet'}
          </h3>
          <p className="text-white/40 text-sm">Use the "Request New" button above to submit one.</p>
        </div>
      ) : (
        // Single column, not the previous 2-up grid: the mockup's request row
        // is wide (70×105 poster, a title line that carries year + kind + 4K +
        // status, a meta line, and a right-hand date/delete stack), and half a
        // page cannot hold that without the title line wrapping on almost
        // every entry. xl:grid-cols-2 is deliberately NOT restored — at 1400px
        // the row still wants ~700px.
        <div className="flex flex-col gap-3">
          {filtered.map(req => {
            const poster = tmdbPosterURL(req.poster_path)
            const isExpanded = expanded.has(req.id)
            const hasOverview = !!req.overview && req.overview.trim().length > 0
            const toggle = () => {
              if (!hasOverview) return
              setExpanded(prev => {
                const next = new Set(prev)
                if (next.has(req.id)) next.delete(req.id)
                else next.add(req.id)
                return next
              })
            }
            return (
              <div key={req.id} className={`stage-req flex gap-4 sm:gap-[18px] p-3 sm:pr-[18px] ${hasOverview ? 'cursor-pointer' : 'cursor-default'}`}
                onClick={toggle}
                role={hasOverview ? 'button' : undefined}
                tabIndex={hasOverview ? 0 : undefined}
                // A div with role="button" is not keyboard-operable on its own.
                // The row has been clickable-to-expand since QA 2026-05-25 and
                // reachable only by mouse ever since; Enter/Space now activate
                // it. The nested delete <button> already stops propagation on
                // click, and stops keydown too so its own Enter can't also
                // toggle the overview.
                onKeyDown={hasOverview ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
                } : undefined}
                aria-expanded={hasOverview ? isExpanded : undefined}
                aria-label={hasOverview ? `${req.title}, ${isExpanded ? 'hide' : 'show'} overview` : undefined}
              >
                <div className="stage-req-poster flex-shrink-0 flex items-center justify-center">
                  {/* Layout invariant: the img and the fallback div
                      are mutually-exclusive flex siblings — only one
                      is `display: flex/block` at a time. Don't add a
                      third sibling here without rewiring the onError
                      handler's nextElementSibling lookup. */}
                  {poster ? (
                    // 2026-05-27 — Dropped crossOrigin="anonymous"
                    // (see RequestsView search row above for full
                    // rationale; tl;dr: TMDB's edge cache occasionally
                    // serves responses without the CORS header so the
                    // crossorigin request fails for less-popular
                    // posters, which is exactly what showed up on
                    // "In the City (2026)" — broken alt-text rendered
                    // in the card). alt="" so the card doesn't echo
                    // the title twice (the <h3> below already shows
                    // it). onError swaps in the film/tv glyph from
                    // the no-poster path.
                    <img
                      // Deep-debug M1 — key on src so a future
                      // poster_path update remounts the img and
                      // resets the inline display:none mutation.
                      key={poster}
                      src={poster}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        const img = e.currentTarget as HTMLImageElement
                        img.style.display = 'none'
                        // Reveal the fallback glyph we always render
                        // below the img (hidden when img is visible).
                        const fallback = img.nextElementSibling as HTMLElement | null
                        if (fallback) fallback.style.display = 'flex'
                      }}
                    />
                  ) : null}
                  <div
                    className="w-full h-full items-center justify-center"
                    style={{ display: poster ? 'none' : 'flex' }}
                    aria-hidden="true"
                  >
                    <Icon name={req.media_type === 'tv' ? 'tv' : 'film'} size={22} className="text-white/25" />
                  </div>
                </div>
                {/* Info column. The mockup puts everything that identifies the
                    request on ONE line — title, year, kind, quality, status —
                    with a secondary meta line under it. The old layout split
                    those across three rows and pushed the status badge into a
                    justify-between footer, which meant the two things you scan
                    for (what it is, where it's up to) were at opposite ends of
                    the card. */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-x-[9px] gap-y-1.5 flex-wrap">
                    <h3 className="text-[15px] font-semibold text-white min-w-0 truncate max-w-full">{req.title}</h3>
                    {req.year > 0 && <span className="text-white/55 text-[13px]">({req.year})</span>}
                    <span className="stage-typetag">{req.media_type === 'tv' ? 'TV' : 'Movie'}</span>
                    {req.quality_4k && <span className="stage-typetag !text-purple-200 !border-purple-400/40 !bg-purple-500/15">4K</span>}
                    {req.quality_1080p && <span className="stage-typetag">1080p</span>}
                    <span className={`stage-stb ${statusBadge[req.status] ?? 'stage-stb-pending'}`}>
                      {statusLabels[req.status] ?? req.status}
                    </span>
                  </div>
                  {/* Meta line. `username` is optional on MediaRequest (the
                      server omits it for requests whose user was deleted), so
                      the "requested by" clause is conditional rather than
                      rendering "requested by undefined". */}
                  <div className="mt-1.5 flex items-center gap-x-[9px] gap-y-1 flex-wrap text-xs text-white/55">
                    {req.username && <span>requested by {req.username}</span>}
                    {req.username && <span className="text-white/25">·</span>}
                    <span>{formatRequestDate(req.requested_at)}</span>
                  </div>
                  {req.error_message && (
                    // Phase 5.3 final QA — show humanized error in
                    // the body; keep the raw server response in the
                    // tooltip so admins can still debug.
                    <p className="text-red-300 text-xs mt-2 line-clamp-2 flex items-start gap-1.5" title={req.error_message}>
                      <Icon name="alertTriangle" size={13} className="shrink-0 mt-px" />
                      {humanizeRequestError(req.error_message, req.media_type)}
                    </p>
                  )}
                  {hasOverview && (
                    isExpanded ? (
                      <p className="text-white/65 text-xs mt-2 leading-relaxed">{req.overview}</p>
                    ) : (
                      // The mockup's .expand-hint. The row has been
                      // expandable since QA 2026-05-25 with nothing to say so
                      // — "cursor: pointer" was the only affordance, which
                      // touch users and keyboard users never see.
                      <div className="mt-1.5 text-[11px] text-white/40 inline-flex items-center gap-1.5">
                        <Icon name="chevronDown" size={12} />
                        Click to expand overview
                      </div>
                    )
                  )}
                </div>
                {/* Right stack — delete above, nothing below. Kept as a
                    column so a future second control lands in the mockup's
                    intended place; the requested-at date moved to the meta
                    line, where it reads with "requested by". */}
                {(req.status === 'pending' || req.status === 'failed') && (
                  <div className="flex-none flex flex-col items-end gap-2.5">
                    <button
                      type="button"
                      onClick={async (e) => {
                        // Stops propagation to the clickable row wrapper —
                        // without this, clicking delete also toggles the
                        // overview expand.
                        e.stopPropagation()
                        if (!window.confirm(`Delete request for "${req.title}"?`)) return
                        try {
                          await deleteRequest(req.id)
                          onRequestDeleted(req.id)
                        } catch (err) {
                          window.alert('Delete failed: ' + (err instanceof Error ? err.message : 'unknown'))
                        }
                      }}
                      // Enter on this button would otherwise bubble to the
                      // row's new onKeyDown and expand the overview behind
                      // the confirm dialog.
                      onKeyDown={(e) => e.stopPropagation()}
                      className="w-9 h-9 rounded-[10px] grid place-items-center text-white/45 bg-white/[0.04] border border-white/[0.08] hover:text-red-300 hover:border-red-500/40 transition-colors"
                      title="Delete request"
                      aria-label={`Delete request for ${req.title}`}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
