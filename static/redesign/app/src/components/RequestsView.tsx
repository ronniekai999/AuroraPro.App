// Requests view: what this account has asked for, and what became of each.
// ("My requests"; for a session with the admin powers, every member's.)
//
// One row per request: its poster, what it is and when it was asked for,
// its status with one sentence about it, and what can be done with it. The
// page makes no request itself: asking is the end of a search that finds
// nothing, so the row at the top opens the search page (it used to open a
// modal composer with a search of its own).
//
// What a row can do is what the routes allow. DELETE /api/requests/{id}
// takes only a pending or a failed request, so only those have a delete. A
// request carries no id of the title it became in the library, so one that
// is available is found by searching for its title. A failed one is asked
// for again with the same details (POST /api/requests), and the failed row
// is then deleted.
//
// humanizeRequestError (raw server error -> a short friendly sentence, the
// raw text kept as a tooltip for whoever debugs it) is module-private:
// this page is its only reader.

import { failureWords } from '@/lib/failureWords'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/components/Icon'
import { formatRequestDay } from '@/lib/format'
import { REQUEST_STATUS, REQUEST_STATUSES, requestRefusalSays } from '@/lib/requestStatus'
import {
  APIError,
  createRequest,
  deleteRequest,
  tmdbPosterURL,
  type MediaRequest,
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

  // An admin said no to a request that was waiting for approval.
  if (r.includes('denied by admin')) return 'An admin turned this request down.'

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

type Filter = 'all' | MediaRequest['status']
/** "today", "yesterday", "3 days ago", or "on Nov 6": after "Added to the library". */
const whenArrived = (iso: string) => { const d = formatRequestDay(iso); return /^[A-Z]/.test(d) ? `on ${d}` : d }
/** The letter a title is filed under, past a leading article. */
const initialOf = (title: string) => title.trim().replace(/^(the|a|an)\s+/i, '').charAt(0).toUpperCase()

/* ─────────────────────── REQUESTS VIEW ─────────────────────── */
export default function RequestsView({ requests, onRequestSubmitted, onRequestDeleted, onRequestMoved, everyone = false, userId, onAsk, onFind }: {
  /** The server lists every member's requests to a session with the admin
   *  powers and only the caller's own to anyone else; the page says which. */
  everyone?: boolean
  requests: MediaRequest[] | null
  onRequestSubmitted: (r: MediaRequest) => void
  /** `replaced`: a failed request that was just asked for again, deleted
   *  as housekeeping; nothing needs saying about it. */
  onRequestDeleted: (id: number, replaced?: boolean) => void
  /** A request turned out to have moved on (a delete was refused because
   *  the downloader has it now): the list's copy of it is put right. */
  onRequestMoved?: (id: number, status: MediaRequest['status']) => void
  /** Whose session this is. A list with every member's requests in it marks
   *  the caller's own by this: a failed request can be asked for again only
   *  by whoever asked for it. */
  userId?: number
  /** Opens the search page with its field ready: where a title is asked for. */
  onAsk?: () => void
  /** Searches the library for a title (a request that is now available). */
  onFind?: (title: string) => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  // The filter as it stands when an answer lands, which can be after the
  // viewer has changed it (the filters stay live while a delete is out).
  const filterRef = useRef(filter)
  useLayoutEffect(() => { filterRef.current = filter }, [filter])
  const heading = everyone ? 'Requests' : 'My requests'
  // The row whose delete was pressed and is waiting to be confirmed; the row
  // being worked on (one thing at a time on the page: a second press, on
  // this row or another, does nothing until the first has answered); and
  // what went wrong on a row, said on that row.
  const [confirming, setConfirming] = useState<number | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const busyRef = useRef<number | null>(null)
  // `above`: the row was leaving the list being shown as this was set, so
  // it was said above the list. It is announced once, where it first
  // appears; drawn in the other place later (the viewer changes the
  // filter), it is plain text there.
  const [wrong, setWrong] = useState<{ id: number; says: string; above?: boolean } | null>(null)
  // The server's answer to a delete of a request that is not there: someone
  // (another tab, an admin) deleted it first. It is deleted, which is what
  // was asked for; "try again" could never work.
  const alreadyGone = (err: unknown) => err instanceof APIError && err.status === 404

  // Where the keyboard's focus goes when the control that holds it is about
  // to leave the page. The question's buttons take the bin's place and the
  // bin theirs; a deleted row takes all of its controls with it. (The native
  // confirm this replaced handed the focus back by itself.)
  const listRef = useRef<HTMLUListElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const [focusTo, setFocusTo] = useState<{ kind: 'keep'; id: number } | { kind: 'bin'; id: number } | { kind: 'after'; ids: number[] } | null>(null)
  useLayoutEffect(() => {
    if (!focusTo) return
    const inRow = (id: number, sel: string) => listRef.current?.querySelector<HTMLElement>(`[data-request-id="${id}"] ${sel}`) ?? null
    if (focusTo.kind === 'keep') inRow(focusTo.id, '.req-keep')?.focus()
    else if (focusTo.kind === 'bin') inRow(focusTo.id, '.req-del')?.focus()
    else {
      // The first control of a row that came after the deleted one; the
      // page's heading when there is none (it was the last, or what
      // follows has nothing to press).
      const next = focusTo.ids.map(id => inRow(id, 'button')).find(Boolean)
      ;(next ?? headingRef.current)?.focus()
    }
    setFocusTo(null)
  }, [focusTo])
  const ask = (id: number) => { setWrong(null); setConfirming(id); setFocusTo({ kind: 'keep', id }) }
  const keep = (id: number) => { setConfirming(null); setFocusTo({ kind: 'bin', id }) }

  // Counts for the filters, in one pass over the list.
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of requests ?? []) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [requests])

  const filteredNow = requests ? (filter === 'all' ? requests : requests.filter(r => r.status === filter)) : []
  const remove = async (req: MediaRequest) => {
    if (busyRef.current !== null) return
    busyRef.current = req.id
    setBusy(req.id)
    setWrong(null)
    // The rows under this one, as they stand now: where the focus goes.
    const at = filteredNow.findIndex(r => r.id === req.id)
    const after = filteredNow.slice(at + 1).map(r => r.id)
    try {
      await deleteRequest(req.id)
      setConfirming(null)
      setFocusTo({ kind: 'after', ids: after })
      onRequestDeleted(req.id)
    } catch (err) {
      // A pending request is handed to the downloader within seconds, and
      // the server deletes only a pending or a failed one. That refusal is
      // not something to try again: the row is put right and says why.
      if (alreadyGone(err)) {
        setConfirming(null)
        setFocusTo({ kind: 'after', ids: after })
        onRequestDeleted(req.id)
      } else if (req.status === 'pending' && err instanceof APIError && err.status === 400) {
        // The server refuses a delete with a 400 for a request that is no
        // longer pending or failed (the id it was given is a number, so its
        // other 400 cannot happen here).
        setConfirming(null)
        setFocusTo({ kind: 'after', ids: [req.id, ...after] })
        onRequestMoved?.(req.id, 'processing')
        // Under any filter but All the row, now Processing, leaves the list.
        // Judged by the filter in force now, not at the press: where the
        // words are drawn first is where they are announced.
        const shown = filterRef.current
        setWrong({ id: req.id, says: 'It is with the downloader now and can no longer be deleted.', above: shown !== 'all' && shown !== 'processing' })
      } else {
        // A refusal is the same next time; a failure of the server or the
        // connection may not be.
        const refused = 'It could not be deleted.'
        setWrong({ id: req.id, says: err instanceof APIError && err.status < 500 ? (failureWords(err, 'delete it', { status: { 400: refused, 409: refused, 422: refused } }) ?? refused) : 'It could not be deleted. Try again in a moment.' })
      }
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }
  // Asked for again with what the first request held. The failed row goes
  // once the new one is made (best effort: if that fails it stays, and can
  // be deleted by hand).
  const again = async (req: MediaRequest) => {
    if (busyRef.current !== null) return
    busyRef.current = req.id
    setBusy(req.id)
    setWrong(null)
    const at = filteredNow.findIndex(r => r.id === req.id)
    const after = filteredNow.slice(at + 1).map(r => r.id)
    try {
      const made = await createRequest({
        media_type: req.media_type,
        tmdb_id: req.tmdb_id,
        title: req.title,
        poster_path: req.poster_path || '',
        overview: req.overview || '',
        year: req.year || 0,
        quality_1080p: req.quality_1080p,
        quality_4k: req.quality_4k,
      })
      onRequestSubmitted(made)
      try {
        await deleteRequest(req.id)
        setFocusTo({ kind: 'after', ids: after })
        onRequestDeleted(req.id, true)
      } catch (err) {
        // Deleted elsewhere meanwhile: gone all the same. Anything else,
        // the failed row stays.
        if (alreadyGone(err)) {
          setFocusTo({ kind: 'after', ids: after })
          onRequestDeleted(req.id, true)
        }
      }
    } catch (err) {
      // In the server's own terms where it gave them (already asked for
      // again from the search page; requests switched off): "try again in a
      // moment" would be wrong for those.
      const says = requestRefusalSays(err)
      setWrong({ id: req.id, says: says === 'The request could not be sent. Try again in a moment.' ? 'The request could not be sent again. Try again in a moment.' : says })
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }

  const askRow = onAsk && (
    <button type="button" onClick={onAsk} className="req-ask" data-requests-ask="">
      <Icon name="search" size={18} className="flex-none text-ink-2" />
      <span className="min-w-0 flex-1">Ask for a movie or show that is not in the library</span>
    </button>
  )

  if (requests === null) {
    return (
      <div className="req-page animate-fade-in">
        <h1 className="req-title">{heading}</h1>
        {askRow}
        <p className="req-note mt-8" role="status">Loading requests…</p>
      </div>
    )
  }

  const filtered = filteredNow
  // What went wrong is said on its row. A row can leave the list being
  // shown as it is put right (a pending request found to be processing,
  // under the Pending filter): then it is said here, above the list, with
  // the title it is about and where the request is listed now.
  const wrongRow = wrong ? requests.find(r => r.id === wrong.id) : undefined
  const wrongOutOfView = wrong && wrongRow && !filtered.some(r => r.id === wrong.id)
    ? `${wrongRow.title}: ${wrong.says} It is listed under ${REQUEST_STATUS[wrongRow.status]?.label ?? wrongRow.status} now.`
    : ''
  const filters: { id: Filter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: requests.length },
    ...REQUEST_STATUSES.map(id => ({ id, label: REQUEST_STATUS[id].label, count: counts[id] ?? 0 })),
  ]

  return (
    <div className="req-page animate-fade-in">
      <h1 ref={headingRef} tabIndex={-1} className="req-title">{heading}</h1>
      {askRow}

      {requests.length > 0 && (
        <>
          <div role="group" aria-label="Filter requests by status" className="req-filters">
            {filters.map(f => (
              <button key={f.id} type="button" className="genre-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label} · {f.count.toLocaleString()}
              </button>
            ))}
          </div>
          {/* Pressing a filter silently rewrites the list under it: nothing
              moves the focus, and the button's own pressed state is heard
              only by someone still on it. This says what the press did. */}
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-requests-filtered="">
            {`Filter requests by status: ${filters.find(f => f.id === filter)?.label ?? ''}, ${filtered.length.toLocaleString()} shown`}
          </span>
        </>
      )}

      {wrongOutOfView && <p className="req-wrong req-wrong-page" role={wrong?.above ? 'alert' : undefined} data-requests-wrong="">{wrongOutOfView}</p>}

      {filtered.length === 0 ? (
        <div className="req-none" data-requests-none="">
          <h2 className="req-none-title">
            {requests.length === 0
              ? everyone ? 'Nobody has asked for anything yet' : 'Nothing requested yet'
              : `No requests are ${REQUEST_STATUS[filter as MediaRequest['status']]?.label.toLowerCase() ?? filter} right now`}
          </h2>
          {requests.length === 0 && (
            <p className="req-note">
              Search for a title. When the library does not have it, the search page lists what can be requested.
            </p>
          )}
        </div>
      ) : (
        <ul ref={listRef} className="req-list">
          {filtered.map(req => {
            const poster = tmdbPosterURL(req.poster_path)
            const status = REQUEST_STATUS[req.status]
            const hasOverview = !!req.overview && req.overview.trim().length > 0
            const kind = req.media_type === 'tv' ? 'Show' : 'Movie'
            const asked = formatRequestDay(req.requested_at)
            const meta = [
              kind,
              req.year > 0 ? String(req.year) : '',
              req.quality_4k ? '4K' : '',
              // `username` is on a row only in the list a session with the
              // admin powers is given.
              req.username ? `asked by ${req.username}${asked ? ` ${asked}` : ''}` : asked ? `asked ${asked}` : '',
            ].filter(Boolean).join(' · ')
            const failedSays = req.status === 'failed' && req.error_message ? humanizeRequestError(req.error_message, req.media_type) : ''
            const deletable = req.status === 'pending' || req.status === 'failed'
            // Asked for again by whoever asked for it, and not at all when
            // an admin turned it down. In a list of every member's requests
            // the new request would be the caller's and the member's row
            // would be deleted with it; and one press would undo a denial
            // (under the limit, the server sends it straight on).
            const mine = userId === undefined ? !everyone : req.user_id === userId
            // A denial is known only by the words the server stores for it
            // (internal/api/request_handlers.go, "denied by admin"); no
            // field says so. If those words change this fails open: "Try
            // again" is offered on a denied request, as it was before.
            const denied = (req.error_message ?? '').toLowerCase().includes('denied by admin')
            const retryable = req.status === 'failed' && mine && !denied
            // `completed_at` is also written when a request fails, so one
            // that failed and arrived later carries the failure's date:
            // where the row has an error on record, no date is claimed.
            const arrived = req.status === 'available' && req.completed_at && !req.error_message ? `Added to the library ${whenArrived(req.completed_at)}.` : ''
            return (
              <li key={req.id} className="req-row" data-request-id={req.id}>
                <span className="req-art" aria-hidden="true">
                  {poster
                    // key: the handler hides a poster that fails, and must
                    // not go on hiding the next one drawn in this row.
                    ? <img key={poster} src={poster} alt="" loading="lazy" decoding="async" onError={e => { e.currentTarget.style.display = 'none' }} />
                    : null}
                  <span className="req-initial">{initialOf(req.title)}</span>
                </span>
                <div className="req-text">
                  <span className="req-name">{req.title}</span>
                  <span className="req-meta">{meta}</span>
                  {/* The TMDB overview, always shown and never clamped, with
                      nothing to press: by the owner's choice (it used to sit
                      behind a Show/Hide toggle). Some older entries have
                      none: nothing renders. */}
                  {hasOverview && <p className="req-overview">{req.overview}</p>}
                </div>
                <div className="req-status" data-tone={status?.tone ?? 'unknown'}>
                  {/* An unknown status is shown as the server sent it, with
                      no colour of its own: degrading beats misreporting. */}
                  <span className="req-status-label"><span className="req-dot" aria-hidden="true" />{status?.label ?? req.status}</span>
                  <span className="req-status-note" title={failedSays ? req.error_message : undefined}>
                    {failedSays || arrived || (status?.note ?? '')}
                  </span>
                  {wrong?.id === req.id && <span className="req-wrong" role={wrong.above ? undefined : 'alert'}>{wrong.says}</span>}
                </div>
                <div
                  className="req-acts"
                  // Escape answers the question as Keep does, and like Keep
                  // does nothing while the delete is out. (Stopped here
                  // either way: the app's own Escape is for the page behind.)
                  onKeyDown={e => { if (confirming === req.id && e.key === 'Escape') { e.stopPropagation(); if (busy === null) keep(req.id) } }}
                >
                  {confirming === req.id ? (
                    // Asked on the row itself, where the request is: no
                    // native dialog over the page. Keep, the safe answer,
                    // takes the focus; the buttons stay focusable while the
                    // delete is out (aria-disabled, a second press refused).
                    <>
                      <span className="req-confirm">Delete this request?</span>
                      <button type="button" aria-disabled={busy !== null || undefined} onClick={() => { void remove(req) }} className="stage-btn stage-btn-sm stage-btn-danger stage-hit44" aria-label={`Delete the request for ${req.title}`}>
                        {busy === req.id ? 'Deleting…' : 'Delete'}
                      </button>
                      <button type="button" aria-disabled={busy !== null || undefined} onClick={() => { if (busy === null) keep(req.id) }} className="stage-btn stage-btn-sm stage-btn-ghost stage-hit44 req-keep" aria-label={`Keep the request for ${req.title}`}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <>
                      {req.status === 'available' && onFind && (
                        <button type="button" onClick={() => onFind(req.title)} className="req-act" aria-label={`Find ${req.title} in the library`}>
                          Find it
                        </button>
                      )}
                      {retryable && (
                        <button type="button" aria-disabled={busy !== null || undefined} onClick={() => { void again(req) }} className="req-act" aria-label={`Ask for ${req.title} again`}>
                          {busy === req.id ? 'Asking…' : 'Try again'}
                        </button>
                      )}
                      {deletable && (
                        <button type="button" aria-disabled={busy !== null || undefined} onClick={() => { if (busy === null) ask(req.id) }} className="req-del" aria-label={`Delete request for ${req.title}`}>
                          <Icon name="trash" size={16} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
