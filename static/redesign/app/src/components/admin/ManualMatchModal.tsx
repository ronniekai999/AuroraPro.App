// Manual identify modal — shared by App (the global admin-only
// "manual identify" overlay, rendered at App level so it overlays any
// screen) and by AdminView's Flagged tab. Extracted to its own module
// (2026-06-17 app split) so App can import it WITHOUT pulling the lazy
// AdminView chunk into the main bundle — a static import from
// AdminView.tsx would defeat the code split.

import { useEffect, useId, useRef, useState } from 'react'
import {
  searchForMatch,
  manualMatch,
  tmdbPosterURL,
  type MatchSearchResult,
  type ServerMediaItem,
} from '@/lib/api'
import { Icon } from '@/components/Icon'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useReturnFocus } from '@/lib/returnFocus'

// Manual match. Search TMDB (and TVDB for a show), pick the right title,
// and Aurora re-reads its details from it. Posts to /api/media/{id}/match.
// An id from a browser tab can be typed in directly instead.
//
// The app's dialog: focus goes in and stays in, Escape and the close button
// leave, and focus goes back to what opened it (it is opened by state, so
// that last part is said here: lib/returnFocus).
//
// It can always be closed, also while a match is being sent: a server that
// does not answer must not hold anyone in it. A match closed on is dropped
// here (its request is aborted and a late answer changes nothing), but the
// server may have saved it all the same, so the caller is told, and reads
// what it shows again instead of assuming either way.
export default function ManualMatchModal({ target, onClose, onMatched }: {
  target: ServerMediaItem
  /** `matchInFlight`: the dialog was closed while a match was being sent.
   *  It may or may not have been saved: read again what the page shows. */
  onClose: (matchInFlight?: boolean) => void
  onMatched: () => void
}) {
  const ids = useId()
  const returnFocus = useReturnFocus()
  const isShow = target.type === 'show'
  const [q, setQ] = useState(target.title)
  const [results, setResults] = useState<MatchSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // The match being sent, if one is.
  const inFlight = useRef<AbortController | null>(null)
  useEffect(() => () => inFlight.current?.abort(), [])
  // A match the server refused, said in the dialog: the search and the
  // candidates stay as they are for another try.
  const [failed, setFailed] = useState<string | null>(null)
  const [directIdSource, setDirectIdSource] = useState<'tmdb' | 'tvdb'>('tmdb')
  const [directId, setDirectId] = useState('')
  // Searches a moment after the typing stops. Each search answers for
  // itself only: one that a newer search (or an emptied field) has replaced
  // is aborted and sets nothing, so it can neither end the newer one's
  // "Searching…" nor put "Nothing found" up before its results.
  useEffect(() => {
    const term = q.trim()
    setSearchFailed(false)
    if (!term) { setResults([]); setSearching(false); return }
    const ac = new AbortController()
    setSearching(true)
    const t = window.setTimeout(() => {
      searchForMatch(term, isShow ? 'show' : 'movie', ac.signal)
        .then(found => { if (!ac.signal.aborted) { setResults(found); setSearching(false) } })
        .catch(() => { if (!ac.signal.aborted) { setResults([]); setSearchFailed(true); setSearching(false) } })
    }, 300)
    return () => { window.clearTimeout(t); ac.abort() }
  }, [q, isShow])

  const submit = async (source: 'tmdb' | 'tvdb', id: number) => {
    if (inFlight.current) return
    const ac = new AbortController()
    inFlight.current = ac
    setSubmitting(true)
    setFailed(null)
    try {
      const body: { tmdb_id?: number; tvdb_id?: number; type: 'movie' | 'show' } = {
        type: isShow ? 'show' : 'movie',
      }
      if (source === 'tvdb') body.tvdb_id = id
      else body.tmdb_id = id
      await manualMatch(target.id, body, ac.signal)
      // Closed meanwhile: the caller has been told, and this answer is not
      // reported a second time.
      if (ac.signal.aborted) return
      inFlight.current = null
      onMatched()
    } catch (err) {
      if (ac.signal.aborted) return
      inFlight.current = null
      setFailed(`The match was not saved${err instanceof Error && err.message ? `: ${err.message}` : '.'}`)
      setSubmitting(false)
    }
  }
  const close = () => {
    const sending = inFlight.current
    inFlight.current = null
    sending?.abort()
    onClose(sending !== null)
  }
  const directOk = /^\d+$/.test(directId.trim())

  return (
    <Dialog open onOpenChange={open => { if (!open) close() }}>
      <DialogContent
        {...returnFocus}
        // Above the title page's own layers, where it has always sat.
        overlayClassName="z-[70]"
        className="z-[71] flex max-h-[85vh] w-[calc(100%-2rem)] flex-col gap-0 sm:max-w-xl rounded-sheet border-0 bg-surface-raised-2 p-5 text-ink sm:p-6"
      >
        <DialogTitle className="pr-10 font-display text-[22px] font-semibold leading-tight text-ink">
          Match “{target.title}”
        </DialogTitle>
        <DialogDescription className="mt-1 break-all text-[13px] leading-snug text-ink-2">
          {target.file_path || 'Pick the title this file is.'}
        </DialogDescription>

        <label htmlFor={`${ids}-q`} className="sr-only">{isShow ? 'Search TMDB or TVDB for the show' : 'Search TMDB for the film'}</label>
        <input
          id={`${ids}-q`}
          type="search"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={isShow ? 'Search TMDB or TVDB for the show…' : 'Search TMDB for the film…'}
          className="mt-4 w-full"
        />

        <div className="relative mt-3 min-h-[5rem] flex-1 overflow-y-auto overflow-x-hidden">
          <p role="status" className={searching || (q.trim() && results.length === 0) ? `text-[14px] leading-snug ${searchFailed && !searching ? 'text-danger-ink' : 'text-ink-2'}` : 'sr-only'}>
            {searching ? 'Searching…'
              : searchFailed ? 'The search could not be run. Try again, or match by the id below.'
              : !q.trim() ? ''
              : results.length === 0 ? 'Nothing found. Try the title as TMDB spells it, or its id below.'
              : `${results.length} found.`}
          </p>
          <ul className="grid grid-cols-1 gap-2">
            {results.map(r => {
              const name = `${r.title}${r.year ? ` (${r.year})` : ''}`
              return (
                <li key={`${r.source}-${r.id}`} className="flex items-center gap-3 rounded-control bg-surface-raised p-2">
                  <div className="flex h-[75px] w-[50px] flex-none items-center justify-center overflow-hidden rounded-chip bg-surface-raised-2">
                    {/* TMDB posters are paths (they need the CDN's prefix);
                        a TVDB image_url is a whole address. One that fails
                        to load is hidden, and the box shows instead. */}
                    {r.poster_path ? (
                      <img
                        // Keyed on its address, so a new poster remounts the
                        // image and undoes the hiding below.
                        key={r.poster_path}
                        src={r.source === 'tvdb' ? r.poster_path : tmdbPosterURL(r.poster_path)}
                        alt=""
                        className="h-full w-full object-cover"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                      />
                    ) : (
                      <Icon name="film" size={20} className="text-ink-3" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-ink">{name}</p>
                    <p className="text-xs uppercase tabular-nums text-ink-2">{r.source} · id {r.id}</p>
                    {r.overview && <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-ink-2">{r.overview}</p>}
                  </div>
                  <button
                    type="button"
                    aria-disabled={submitting}
                    onClick={() => void submit(r.source, r.id)}
                    className="stage-btn stage-btn-sm stage-hit44 stage-btn-ghost flex-none"
                  >
                    Match{' '}<span className="sr-only">{name}, from {r.source.toUpperCase()}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <p role="alert" className={failed ? 'mt-3 text-[14px] leading-snug text-danger-ink' : 'sr-only'}>{failed ?? ''}</p>

        {/* For an id already in hand, from a TMDB or TVDB page. */}
        <div className="mt-3 border-t border-line pt-4">
          <p id={`${ids}-direct`} className="mb-2 text-[13px] text-ink-2">Or match by its id:</p>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby={`${ids}-direct`}>
            <select
              aria-label="Where the id is from"
              value={directIdSource}
              onChange={e => setDirectIdSource(e.target.value as 'tmdb' | 'tvdb')}
            >
              <option value="tmdb">TMDB</option>
              {isShow && <option value="tvdb">TVDB</option>}
            </select>
            <input
              aria-label="Id"
              inputMode="numeric"
              value={directId}
              onChange={e => setDirectId(e.target.value)}
              placeholder="123456"
              className="min-w-0 flex-1 basis-[8rem]"
            />
            <button
              type="button"
              aria-disabled={submitting || !directOk}
              onClick={() => { if (directOk) void submit(directIdSource, parseInt(directId.trim(), 10)) }}
              className="stage-btn stage-btn-ghost"
            >
              {submitting ? 'Matching…' : 'Match by id'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
