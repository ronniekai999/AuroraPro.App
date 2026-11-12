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

import { SearchRequest, useRequesting } from './SearchRequest'

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
/** The list with the state the search page holds for it (useRequesting). */
function Held({ query, takeFocus }: { query: string; takeFocus?: boolean }) {
  const state = useRequesting(true)
  return <SearchRequest query={query} userId={1} state={state} takeFocus={takeFocus} onRequested={calls.requested} onOpenRequests={calls.open} />
}
const view = (query = 'the glass orchard', takeFocus = false) => <Held query={query} takeFocus={takeFocus} />
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
    // The matches arriving are said, in the region that said it was looking
    // (which never leaves the tree: an emptied one announced nothing).
    expect(status()).toBe('3 titles can be requested.')
    expect(document.querySelector('[data-search-request-status]')).toHaveAttribute('role', 'status')
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
    expect(status()).toBe('3 titles can be requested.')
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

  // While a request is out the buttons stay in the tab order and keep the
  // focus they hold (a disabled control can drop it); a second press does
  // nothing. When it goes through, the button's place is taken by "See my
  // requests", which takes its focus.
  it('takes one request at a time without disabling its buttons, and keeps the focus on the row', async () => {
    let answer!: (r: MediaRequest) => void
    api.createRequest.mockImplementationOnce(() => new Promise(done => { answer = done as (r: MediaRequest) => void }))
    render(view())
    await settle()
    await settle(500)
    await settle()
    const first = screen.getByRole('button', { name: 'Request The Glass Orchard (2025)' })
    first.focus()
    fireEvent.click(first)
    expect(first).not.toBeDisabled()
    expect(first).toHaveAttribute('aria-disabled', 'true')
    expect(first.textContent).toBe('Requesting…')
    expect(document.activeElement).toBe(first)
    // Pressed again, and another row's pressed: nothing more is sent.
    fireEvent.click(first)
    fireEvent.click(screen.getByRole('button', { name: 'Request Orchard of Glass' }))
    expect(api.createRequest).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Request Orchard of Glass' })).toHaveAttribute('aria-disabled', 'true')
    answer(asked(900, 10))
    await settle()
    expect(document.activeElement).toBe(within(row('movie:10')).getByRole('button', { name: /^See my requests/ }))
    expect(screen.getByRole('button', { name: 'Request Orchard of Glass' })).not.toHaveAttribute('aria-disabled')
  })

  it('takes the focus on its status line when it was opened by a press', async () => {
    render(view('the glass orchard', true))
    expect(document.activeElement).toBe(document.querySelector('[data-search-request-status]'))
    cleanup()
    render(view())
    expect(document.activeElement).not.toBe(document.querySelector('[data-search-request-status]'))
  })

  // L7: switched off after the page read that requests were on.
  it('says requests are not set up when the server refuses for that, not to try again', async () => {
    api.createRequest.mockRejectedValueOnce(new Error('requests feature is not enabled'))
    render(view())
    await settle()
    await settle(500)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Request The Glass Orchard (2025)' }))
    await settle()
    expect(within(row('movie:10')).getByRole('alert').textContent).toBe('Requests are not set up on this server.')
  })

  it('draws a poster at the size of its tile', async () => {
    api.searchTmdb.mockResolvedValueOnce([match(10, 'The Glass Orchard', { poster_path: '/orchard.jpg' })])
    render(view())
    await settle()
    await settle(500)
    await settle()
    expect(row('movie:10').querySelector('img')).toHaveAttribute('src', 'https://image.tmdb.org/t/p/w154/orchard.jpg')
    expect(status()).toBe('1 title can be requested.')
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
    // Another member's request does not take the caller's own away: the
    // server's one-request-per-title rule is per account. Their own does.
    expect(screen.getAllByRole('button', { name: /^Request / }).map(b => b.getAttribute('aria-label'))).toEqual(['Request The Glass Orchard (2019)', 'Request Orchard of Glass'])
    expect(within(row('tv:11')).queryByRole('button', { name: /^See my requests/ })).toBeNull()
    expect(within(row('movie:10')).getByRole('button', { name: /^See my requests/ })).toBeInTheDocument()
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
    const before = api.searchTmdb.mock.calls.length
    api.searchTmdb.mockRejectedValueOnce(new Error('HTTP 503'))
    render(view())
    await settle()
    await settle(500)
    await settle()
    expect(status()).toContain('The titles that can be requested could not be loaded.')
    expect(document.body.textContent).not.toMatch(/HTTP|503/)
    // A press is answered at once: looking again, the button gone, and the
    // focus on the line that says so (not fallen to the page).
    api.searchTmdb.mockRejectedValueOnce(new Error('HTTP 503'))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(status()).toBe('Looking for “the glass orchard” outside your library…')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-search-request-status]'))
    // It fails again: said again (the line changed in between), and can be tried again.
    await settle(500)
    await settle()
    expect(status()).toContain('The titles that can be requested could not be loaded.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle(500)
    await settle()
    expect(rows()).toHaveLength(3)
    expect(status()).toBe('3 titles can be requested.')
    // One lookup per try: the first, and the two presses.
    expect(api.searchTmdb.mock.calls.length - before).toBe(3)
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

// The page holds what does not change with the words (useRequesting), so a
// list that is unmounted and mounted again at every search does not ask the
// server the same two questions each time.
describe('what the search page holds for the list', () => {
  function Page({ show, enabled = true }: { show: boolean; enabled?: boolean }) {
    const state = useRequesting(enabled)
    return (
      <>
        <output data-offered={String(state.offered)} />
        {show && <SearchRequest query="the glass orchard" userId={1} state={state} onRequested={calls.requested} onOpenRequests={calls.open} />}
      </>
    )
  }
  const offered = () => document.querySelector('output')!.getAttribute('data-offered')

  it('asks whether the server takes requests once, at once, and for the list of requests once, when a list is first shown', async () => {
    const v = render(<Page show={false} />)
    await settle()
    expect(api.getRequestsConfig).toHaveBeenCalledTimes(1)
    expect(api.listRequests).not.toHaveBeenCalled()
    for (let i = 0; i < 3; i++) {
      v.rerender(<Page show />)
      await settle()
      v.rerender(<Page show={false} />)
      await settle()
    }
    expect(api.getRequestsConfig).toHaveBeenCalledTimes(1)
    expect(api.listRequests).toHaveBeenCalledTimes(1)
  })

  it('offers requests only once the server is known to take them, or could not say', async () => {
    let answer!: (c: RequestsConfig) => void
    api.getRequestsConfig.mockImplementationOnce(() => new Promise(done => { answer = done }))
    render(<Page show={false} />)
    await settle()
    expect(offered()).toBe('false')
    answer(ON)
    await settle()
    expect(offered()).toBe('true')
    cleanup()
    api.getRequestsConfig.mockResolvedValueOnce({ enabled: false, has_radarr: false, has_sonarr: false })
    render(<Page show={false} />)
    await settle()
    expect(offered()).toBe('false')
    cleanup()
    api.getRequestsConfig.mockRejectedValueOnce(new Error('HTTP 503'))
    render(<Page show={false} />)
    await settle()
    expect(offered()).toBe('true')
  })

  it('asks nothing for a session that is not offered requests', async () => {
    render(<Page show={false} enabled={false} />)
    await settle()
    expect(api.getRequestsConfig).not.toHaveBeenCalled()
    expect(api.listRequests).not.toHaveBeenCalled()
    expect(offered()).toBe('false')
  })

  it('keeps a request made in one list for the next list shown', async () => {
    const v = render(<Page show />)
    await settle()
    await settle(500)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Request The Glass Orchard (2025)' }))
    await settle()
    v.rerender(<Page show={false} />)
    await settle()
    v.rerender(<Page show />)
    await settle()
    await settle(500)
    await settle()
    expect(row('movie:10').querySelector('.search-req-state')!.textContent).toBe('Requested · sent, nothing found yet')
  })
})
