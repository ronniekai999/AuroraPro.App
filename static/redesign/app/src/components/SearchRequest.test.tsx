// @vitest-environment jsdom
//
// Where a search that found nothing in the library ends: the words are
// looked up outside it, and each match can be requested where it stands.
// (This was a trip to the requests page, whose composer opened with the
// words in it; the list is on the search page itself now.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { MediaRequest, RequestsConfig, TmdbSearchResult } from '@/lib/api'

const api = vi.hoisted(() => ({
  searchTmdb: vi.fn<(q: string, signal?: AbortSignal) => Promise<unknown[]>>(),
  createRequest: vi.fn<(body: Record<string, unknown>) => Promise<unknown>>(),
  listRequests: vi.fn<() => Promise<unknown[]>>(),
  getRequestsConfig: vi.fn<() => Promise<unknown>>(),
}))
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  ...api,
}))

import { SearchRequest } from './SearchRequest'

const NOW = '2026-10-01T00:00:00Z'
const match = (tmdb_id: number, title: string, over: Partial<TmdbSearchResult> = {}): TmdbSearchResult =>
  ({ tmdb_id, media_type: 'movie', title, year: 2025, overview: `About ${title}.`, poster_path: '', ...over })
const asked = (id: number, tmdb_id: number, over: Partial<MediaRequest> = {}): MediaRequest => ({
  id, user_id: 1, media_type: 'movie', tmdb_id, title: 'x', poster_path: '', overview: '', year: 2025, status: 'pending',
  quality_1080p: true, quality_4k: false, requested_at: NOW, updated_at: NOW, ...over,
})
const ON: RequestsConfig = { enabled: true, has_radarr: true, has_sonarr: true }
const ORCHARD = [
  match(10, 'The Glass Orchard'),
  match(11, 'The Glass Orchard', { media_type: 'tv', year: 2019, overview: '' }),
  match(12, 'Orchard of Glass', { year: 0 }),
]

const calls = { requested: vi.fn(), open: vi.fn() }
const view = (query = 'the glass orchard') =>
  <SearchRequest query={query} userId={1} onRequested={calls.requested} onOpenRequests={calls.open} />
const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const status = () => document.querySelector('[data-search-request-status]')!.textContent
const rows = () => [...document.querySelectorAll<HTMLElement>('.search-req-row')]
const row = (key: string) => document.querySelector<HTMLElement>(`[data-request-key="${key}"]`)!

beforeEach(() => {
  vi.useFakeTimers()
  api.getRequestsConfig.mockResolvedValue(ON)
  api.listRequests.mockResolvedValue([])
  api.searchTmdb.mockResolvedValue(ORCHARD)
  api.createRequest.mockImplementation(async body => asked(900, body.tmdb_id as number, { title: body.title as string, media_type: body.media_type as 'movie' | 'tv' }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

describe('the titles that can be requested', () => {
  it('looks the words up after a pause, once, and lists what it finds: kind, year, what it is about', async () => {
    render(view())
    expect(status()).toBe('Looking for “the glass orchard” outside your library…')
    // Whether the server takes requests is asked first.
    await settle()
    expect(api.getRequestsConfig).toHaveBeenCalledTimes(1)
    await settle(499)
    expect(api.searchTmdb).not.toHaveBeenCalled()
    await settle(1)
    expect(api.searchTmdb).toHaveBeenCalledTimes(1)
    expect(api.searchTmdb.mock.calls[0][0]).toBe('the glass orchard')
    await settle()
    expect(status()).toBe('')
    expect(screen.getByRole('list', { name: 'Matches you can request' })).toBeInTheDocument()
    expect(rows().map(r => [
      r.querySelector('.search-req-title')!.textContent,
      r.querySelector('.search-req-facts')!.textContent,
      r.querySelector('.search-req-overview')?.textContent ?? null,
    ])).toEqual([
      ['The Glass Orchard', 'Movie · 2025', 'About The Glass Orchard.'],
      ['The Glass Orchard', 'TV show · 2019', null],
      ['Orchard of Glass', 'Movie', 'About Orchard of Glass.'],
    ])
    // No poster: the letter the title is filed under, past its article.
    expect(rows().map(r => r.querySelector('.search-req-initial')!.textContent)).toEqual(['G', 'G', 'O'])
    // Told apart by their year where the titles are the same; the first is
    // the page's one primary button.
    const buttons = screen.getAllByRole('button', { name: /^Request / })
    expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual(['Request The Glass Orchard (2025)', 'Request The Glass Orchard (2019)', 'Request Orchard of Glass'])
    expect(buttons.map(b => b.className.includes('stage-btn-primary'))).toEqual([true, false, false])
  })

  it('looks up the new words when they change, and drops the answer for the old ones', async () => {
    let answerOld!: (r: unknown[]) => void
    api.searchTmdb.mockImplementationOnce(() => new Promise(done => { answerOld = done }))
    const v = render(view('glass'))
    await settle()
    await settle(500)
    v.rerender(view('glass orchard'))
    await settle(500)
    await settle()
    expect(api.searchTmdb.mock.calls.map(c => c[0])).toEqual(['glass', 'glass orchard'])
    expect(rows()).toHaveLength(3)
    answerOld([match(99, 'Old Answer')])
    await settle()
    expect(document.body.textContent).not.toContain('Old Answer')
    // And the list that was up stays up: the late answer is not taken for
    // "still looking".
    expect(rows()).toHaveLength(3)
    expect(status()).toBe('')
  })

  it('requests the one pressed, in 1080p, says what became of it, and tells the app', async () => {
    render(view())
    await settle()
    await settle(500)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Request The Glass Orchard (2019)' }))
    await settle()
    expect(api.createRequest).toHaveBeenCalledTimes(1)
    expect(api.createRequest.mock.calls[0][0]).toEqual({
      media_type: 'tv', tmdb_id: 11, title: 'The Glass Orchard', poster_path: '', overview: '', year: 2019, quality_1080p: true, quality_4k: false,
    })
    expect(calls.requested).toHaveBeenCalledTimes(1)
    expect(calls.requested.mock.calls[0][0]).toMatchObject({ id: 900, tmdb_id: 11 })
    const tv = row('tv:11')
    expect(tv.querySelector('.search-req-state')!.textContent).toBe('Requested · sent, nothing found yet')
    // It cannot be asked for twice; the way on is the requests page.
    expect(within(tv).queryByRole('button', { name: /^Request / })).toBeNull()
    fireEvent.click(within(tv).getByRole('button', { name: /^See my requests/ }))
    expect(calls.open).toHaveBeenCalledTimes(1)
    // The others still can be, and the primary button is now the first of them.
    expect(screen.getAllByRole('button', { name: /^Request / }).map(b => b.className.includes('stage-btn-primary'))).toEqual([true, false])
  })

  it('says so when the server holds the request for an admin', async () => {
    api.createRequest.mockResolvedValue(asked(901, 10, { status: 'pending_approval' }))
    render(view())
    await settle()
    await settle(500)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Request The Glass Orchard (2025)' }))
    await settle()
    expect(row('movie:10').querySelector('.search-req-state')!.textContent).toBe('Requested · waiting for an admin to approve it')
  })

  it('marks what was asked for already: the caller\'s own, another member\'s where the list holds it, and lets a failed one be asked again', async () => {
    api.listRequests.mockResolvedValue([
      asked(1, 10, { status: 'processing' }),
      // Only a session with the admin powers is listed other members' requests.
      asked(2, 11, { media_type: 'tv', user_id: 7, username: 'Dana', status: 'pending' }),
      asked(3, 12, { status: 'failed' }),
    ])
    render(view())
    await settle()
    await settle(500)
    await settle()
    expect(row('movie:10').querySelector('.search-req-state')!.textContent).toBe('Requested · being fetched')
    expect(row('tv:11').querySelector('.search-req-state')!.textContent).toBe('Already requested by Dana · sent, nothing found yet')
    // That list names who asked on every row, the caller's own included:
    // their own is still just "Requested".
    cleanup()
    api.listRequests.mockResolvedValue([asked(1, 10, { status: 'processing', username: 'ronnie' })])
    render(view())
    await settle()
    await settle(500)
    await settle()
    expect(row('movie:10').querySelector('.search-req-state')!.textContent).toBe('Requested · being fetched')
    cleanup()
    api.listRequests.mockResolvedValue([
      asked(1, 10, { status: 'processing' }),
      asked(2, 11, { media_type: 'tv', user_id: 7, username: 'Dana', status: 'pending' }),
      asked(3, 12, { status: 'failed' }),
    ])
    render(view())
    await settle()
    await settle(500)
    await settle()
    expect(row('movie:12').querySelector('.search-req-state')).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Request / }).map(b => b.getAttribute('aria-label'))).toEqual(['Request Orchard of Glass'])
    // The amber of "under way", and green for one that has arrived.
    expect(row('movie:10').querySelector('.search-req-state')).toHaveAttribute('data-status', 'processing')
  })

  it('says a request that is now in the library is', async () => {
    api.listRequests.mockResolvedValue([asked(1, 10, { status: 'available' })])
    render(view())
    await settle()
    await settle(500)
    await settle()
    const state = row('movie:10').querySelector('.search-req-state')!
    expect(state.textContent).toBe('Requested · in the library now')
    expect(state).toHaveAttribute('data-status', 'available')
  })

  it('says a refusal in words on its row, never the transport\'s, and leaves the buttons usable', async () => {
    api.createRequest.mockRejectedValueOnce(new Error('you already have an active request for this media'))
    render(view())
    await settle()
    await settle(500)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Request The Glass Orchard (2025)' }))
    await settle()
    expect(within(row('movie:10')).getByRole('alert').textContent).toBe('You have already asked for this one.')
    expect(calls.requested).not.toHaveBeenCalled()
    api.createRequest.mockRejectedValueOnce(new Error('HTTP 502'))
    fireEvent.click(screen.getByRole('button', { name: 'Request Orchard of Glass' }))
    await settle()
    expect(within(row('movie:12')).getByRole('alert').textContent).toBe('The request could not be sent. Try again in a moment.')
    // The earlier row's refusal went with the new attempt.
    expect(within(row('movie:10')).queryByRole('alert')).toBeNull()
    expect(document.body.textContent).not.toMatch(/HTTP|502/)
    expect(screen.getByRole('button', { name: 'Request Orchard of Glass' })).toBeEnabled()
    // Asked again, it goes through: the row says so, and no longer says it was refused.
    fireEvent.click(screen.getByRole('button', { name: 'Request Orchard of Glass' }))
    await settle()
    expect(row('movie:12').querySelector('.search-req-state')!.textContent).toBe('Requested · sent, nothing found yet')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers 4K only where the server has it, and asks for it when ticked', async () => {
    render(view())
    await settle()
    await settle(500)
    await settle()
    expect(screen.queryByRole('checkbox')).toBeNull()
    cleanup()
    api.getRequestsConfig.mockResolvedValue({ ...ON, has_4k: true })
    render(view())
    await settle()
    await settle(500)
    await settle()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ask for 4K where the server has it' }))
    fireEvent.click(screen.getByRole('button', { name: 'Request The Glass Orchard (2025)' }))
    await settle()
    expect(api.createRequest.mock.calls[0][0]).toMatchObject({ quality_1080p: false, quality_4k: true })
  })

  it('offers no request for a kind the server cannot fetch, and says why', async () => {
    api.getRequestsConfig.mockResolvedValue({ enabled: true, has_radarr: false, has_sonarr: true })
    render(view())
    await settle()
    await settle(500)
    await settle()
    expect(screen.getAllByRole('button', { name: /^Request / }).map(b => b.getAttribute('aria-label'))).toEqual(['Request The Glass Orchard (2019)'])
    expect(row('movie:10').textContent).toContain('This server is not set up to fetch movies.')
    // The one that can be fetched is the primary button.
    expect(screen.getByRole('button', { name: 'Request The Glass Orchard (2019)' }).className).toContain('stage-btn-primary')
  })

  it('says requests are not set up, and looks nothing up, on a server that takes none', async () => {
    api.getRequestsConfig.mockResolvedValue({ enabled: false, has_radarr: false, has_sonarr: false })
    render(view())
    await settle()
    await settle(600)
    await settle()
    expect(document.querySelector('[data-search-requests-off]')!.textContent).toBe('Requests are not set up on this server.')
    expect(api.searchTmdb).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /See my requests/ })).toBeNull()
  })

  // Whether the server takes requests is asked first, however long that
  // takes: nothing is looked up for a server that may turn out to take none.
  it('looks nothing up until it knows whether the server takes requests', async () => {
    let answer!: (c: RequestsConfig) => void
    api.getRequestsConfig.mockImplementationOnce(() => new Promise(done => { answer = done }))
    render(view())
    await settle(3000)
    expect(api.searchTmdb).not.toHaveBeenCalled()
    expect(status()).toBe('Looking for “the glass orchard” outside your library…')
    answer(ON)
    await settle()
    await settle(500)
    await settle()
    expect(api.searchTmdb).toHaveBeenCalledTimes(1)
    expect(rows()).toHaveLength(3)
  })

  it('still looks the words up when that question cannot be answered: the server refuses what it must', async () => {
    api.getRequestsConfig.mockRejectedValueOnce(new Error('HTTP 503'))
    render(view())
    await settle()
    await settle(500)
    await settle()
    expect(rows()).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: /^Request / })).toHaveLength(3)
  })

  it('says when nothing can be requested for the words, and when the list could not be loaded, with a way to try again', async () => {
    api.searchTmdb.mockResolvedValueOnce([])
    render(view())
    await settle()
    await settle(500)
    await settle()
    expect(status()).toBe('Nothing to request was found for these words. Check the spelling, or try the original title.')
    expect(screen.queryByRole('list')).toBeNull()
    cleanup()
    api.searchTmdb.mockRejectedValueOnce(new Error('HTTP 503'))
    render(view())
    await settle()
    await settle(500)
    await settle()
    expect(status()).toContain('The titles that can be requested could not be loaded.')
    expect(document.body.textContent).not.toMatch(/HTTP|503/)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle(500)
    await settle()
    expect(rows()).toHaveLength(3)
  })

  it('always has the way to the requests page under the list, and says what the limit does without a number', async () => {
    render(view())
    await settle()
    await settle(500)
    await settle()
    const foot = document.querySelector<HTMLElement>('.search-req-foot')!
    expect(foot.textContent).toBe('Past the server’s limit, a request waits for an admin to approve it.See my requests')
    expect(foot.textContent).not.toMatch(/\d/)
    fireEvent.click(within(foot).getByRole('button', { name: 'See my requests' }))
    expect(calls.open).toHaveBeenCalledTimes(1)
  })
})
