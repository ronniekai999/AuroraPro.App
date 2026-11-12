// @vitest-environment jsdom
//
// The requests page: what was asked for and what became of each. It makes
// no request itself (asking is the end of a search); what a row can do is
// what the server's routes allow.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { MediaRequest } from '@/lib/api'

const api = vi.hoisted(() => ({
  createRequest: vi.fn<(body: Record<string, unknown>) => Promise<unknown>>(),
  deleteRequest: vi.fn<(id: number) => Promise<void>>(),
}))
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  ...api,
}))

import RequestsView from './RequestsView'

const NOW = Date.parse('2026-11-10T12:00:00Z')
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString()
const request = (id: number, extra: Partial<MediaRequest> = {}): MediaRequest => ({
  id, user_id: 1, media_type: 'movie', tmdb_id: 1000 + id, title: `Title ${id}`, poster_path: '', overview: '', year: 2025,
  status: 'pending', quality_1080p: true, quality_4k: false, requested_at: ago(3), updated_at: ago(3), ...extra,
})
const SIX = [
  request(1, { title: 'The Glass Orchard' }),
  request(2, { title: 'Winter Ferry', media_type: 'tv', year: 0, status: 'pending_approval', requested_at: ago(50) }),
  request(3, { title: 'Orchard of Glass', status: 'processing', quality_4k: true, quality_1080p: false }),
  request(4, { title: 'Copper Sky', status: 'available', completed_at: ago(26), poster_path: '/copper.jpg' }),
  request(5, { title: 'Little Atlas', media_type: 'tv', status: 'available' }),
  request(6, { title: 'Paper Lanterns', status: 'failed', error_message: 'radarr: api error (status 500): connection refused', year: 1998 }),
]
const calls = { submitted: vi.fn(), deleted: vi.fn(), ask: vi.fn(), find: vi.fn() }
const page = (requests: MediaRequest[] | null, over: Record<string, unknown> = {}) => (
  <RequestsView requests={requests} onRequestSubmitted={calls.submitted} onRequestDeleted={calls.deleted} onAsk={calls.ask} onFind={calls.find} {...over} />
)
const row = (id: number) => document.querySelector<HTMLElement>(`[data-request-id="${id}"]`)!
const names = () => [...document.querySelectorAll('.req-name')].map(n => n.textContent)
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  api.createRequest.mockImplementation(async body => request(77, { title: body.title as string, status: 'pending' }))
  api.deleteRequest.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

describe('the requests page', () => {
  it('is headed for whose requests it lists, and its first row opens the search page, where a title is asked for', () => {
    render(page(SIX))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('My requests')
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a movie or show that is not in the library' }))
    expect(calls.ask).toHaveBeenCalledTimes(1)
    // It makes no request itself: no composer, and no count it was not given.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.querySelector('[data-requests-ask]')!.textContent).not.toMatch(/\d/)
    cleanup()
    render(page(SIX, { everyone: true }))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Requests')
    cleanup()
    render(page(SIX, { onAsk: undefined }))
    expect(document.querySelector('[data-requests-ask]')).toBeNull()
  })

  it('has its heading and the way to ask while the list is still loading', () => {
    render(page(null))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('My requests')
    expect(screen.getByRole('status').textContent).toBe('Loading requests…')
    expect(screen.getByRole('button', { name: /^Ask for a movie or show/ })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Filter requests by status' })).toBeNull()
  })

  it('filters by status, each with how many it holds, and says so when a status has none', () => {
    render(page(SIX.slice(0, 5)))
    const filters = screen.getByRole('group', { name: 'Filter requests by status' })
    expect(within(filters).getAllByRole('button').map(b => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['All · 5', 'true'], ['Pending · 1', 'false'], ['Waiting for approval · 1', 'false'], ['Processing · 1', 'false'], ['Available · 2', 'false'], ['Failed · 0', 'false'],
    ])
    const said = () => document.querySelector('[data-requests-filtered]')!
    expect(said()).toHaveAttribute('role', 'status')
    expect(said().textContent).toBe('Filter requests by status: All, 5 shown')
    fireEvent.click(within(filters).getByRole('button', { name: 'Available · 2' }))
    expect(names()).toEqual(['Copper Sky', 'Little Atlas'])
    // What the press did is said: nothing else tells a screen reader.
    expect(said().textContent).toBe('Filter requests by status: Available, 2 shown')
    expect(within(filters).getByRole('button', { name: 'Available · 2' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(filters).getByRole('button', { name: 'Failed · 0' }))
    expect(names()).toEqual([])
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('No requests are failed right now')
    expect(said().textContent).toBe('Filter requests by status: Failed, 0 shown')
    fireEvent.click(within(filters).getByRole('button', { name: 'All · 5' }))
    expect(names()).toHaveLength(5)
  })

  it('says how to ask when nothing has been requested, and has no filters to press', () => {
    render(page([]))
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Nothing requested yet')
    expect(document.querySelector('[data-requests-none]')!.textContent).toContain('the search page lists what can be requested')
    expect(screen.queryByRole('group', { name: 'Filter requests by status' })).toBeNull()
    cleanup()
    render(page([], { everyone: true }))
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Nobody has asked for anything yet')
  })
})

describe('a request\'s row', () => {
  it('says what it is and when it was asked for, and who asked where the list holds every member\'s', () => {
    render(page(SIX))
    const meta = (id: number) => row(id).querySelector('.req-meta')!.textContent
    expect(meta(1)).toBe('Movie · 2025 · asked today')
    // No year known; two days back.
    expect(meta(2)).toBe('Show · asked 2 days ago')
    expect(meta(3)).toBe('Movie · 2025 · 4K · asked today')
    cleanup()
    render(page([request(1, { username: 'Dana', user_id: 7 })], { everyone: true }))
    expect(meta(1)).toBe('Movie · 2025 · asked by Dana today')
  })

  it('says an older day by its date, with the year when it is not this one', () => {
    render(page([
      request(1, { requested_at: '2026-10-19T09:00:00Z', status: 'available', completed_at: '2026-10-30T09:00:00Z' }),
      request(2, { requested_at: '2025-12-24T09:00:00Z' }),
    ]))
    expect(row(1).querySelector('.req-meta')!.textContent).toBe('Movie · 2025 · asked Oct 19')
    expect(row(1).querySelector('.req-status-note')!.textContent).toBe('Added to the library on Oct 30.')
    expect(row(2).querySelector('.req-meta')!.textContent).toBe('Movie · 2025 · asked Dec 24, 2025')
  })

  it('draws the poster over the title\'s letter, which is what shows without one', () => {
    render(page(SIX))
    expect(row(4).querySelector('.req-art img')).toHaveAttribute('src', 'https://image.tmdb.org/t/p/w500/copper.jpg')
    expect(row(1).querySelector('.req-art img')).toBeNull()
    // Past the article: "The Glass Orchard" is G.
    expect(row(1).querySelector('.req-initial')!.textContent).toBe('G')
  })

  it('says its status in words with one sentence about it, and marks its tone', () => {
    render(page(SIX))
    const status = (id: number) => {
      const el = row(id).querySelector<HTMLElement>('.req-status')!
      return [el.querySelector('.req-status-label')!.textContent, el.querySelector('.req-status-note')!.textContent, el.dataset.tone]
    }
    expect(status(1)).toEqual(['Pending', 'Not sent to the downloader yet.', 'wait'])
    expect(status(2)).toEqual(['Waiting for approval', 'Over the limit, so an admin has to say yes.', 'wait'])
    expect(status(3)).toEqual(['Processing', 'With the downloader.', 'wait'])
    expect(status(4)).toEqual(['Available', 'Added to the library yesterday.', 'ok'])
    // No date for when it arrived: said without one.
    expect(status(5)).toEqual(['Available', 'In the library.', 'ok'])
    // Why it failed, in a sentence; the server's own words are the tooltip.
    expect(status(6)).toEqual(['Failed', 'Couldn\'t reach the download server. Check that Radarr/Sonarr is online.', 'bad'])
    expect(row(6).querySelector('.req-status-note')).toHaveAttribute('title', 'radarr: api error (status 500): connection refused')
    expect(row(1).querySelector('.req-status-note')).not.toHaveAttribute('title')
  })

  it('says an admin turned it down, and shows a status it does not know as the server sent it', () => {
    render(page([
      request(1, { status: 'failed', error_message: 'denied by admin' }),
      request(2, { status: 'on_hold' as MediaRequest['status'] }),
      request(3, { status: 'failed' }),
    ]))
    expect(row(1).querySelector('.req-status-note')!.textContent).toBe('An admin turned this request down.')
    expect(row(2).querySelector('.req-status-label')!.textContent).toBe('on_hold')
    expect(row(2).querySelector<HTMLElement>('.req-status')!.dataset.tone).toBe('unknown')
    expect(row(2).querySelector('.req-status-note')!.textContent).toBe('')
    // Failed with no reason given.
    expect(row(3).querySelector('.req-status-note')!.textContent).toBe('It could not be fetched.')
  })

  it('finds a request that is in the library by its title', () => {
    render(page(SIX))
    fireEvent.click(screen.getByRole('button', { name: 'Find Copper Sky in the library' }))
    expect(calls.find).toHaveBeenCalledWith('Copper Sky')
    // Only for one that is available.
    expect(screen.getAllByRole('button', { name: /^Find / })).toHaveLength(2)
    cleanup()
    render(page(SIX, { onFind: undefined }))
    expect(screen.queryByRole('button', { name: /^Find / })).toBeNull()
  })

  it('asks again for one that failed, with what the first request held, and the failed row goes without a word', async () => {
    render(page(SIX))
    fireEvent.click(screen.getByRole('button', { name: 'Ask for Paper Lanterns again' }))
    await flush()
    expect(api.createRequest).toHaveBeenCalledTimes(1)
    expect(api.createRequest.mock.calls[0][0]).toEqual({
      media_type: 'movie', tmdb_id: 1006, title: 'Paper Lanterns', poster_path: '', overview: '', year: 1998, quality_1080p: true, quality_4k: false,
    })
    expect(calls.submitted).toHaveBeenCalledTimes(1)
    expect(calls.submitted.mock.calls[0][0]).toMatchObject({ id: 77, title: 'Paper Lanterns' })
    expect(api.deleteRequest).toHaveBeenCalledWith(6)
    // `true`: replaced, so the app says nothing about a deletion.
    expect(calls.deleted).toHaveBeenCalledWith(6, true)
    // Only a failed request can be asked for again.
    expect(screen.getAllByRole('button', { name: /^Ask for .* again$/ })).toHaveLength(1)
  })

  it('keeps the failed row when it cannot be cleared away, and says so on the row when the request cannot be sent again', async () => {
    api.deleteRequest.mockRejectedValueOnce(new Error('HTTP 500'))
    render(page(SIX))
    fireEvent.click(screen.getByRole('button', { name: 'Ask for Paper Lanterns again' }))
    await flush()
    expect(calls.submitted).toHaveBeenCalledTimes(1)
    expect(calls.deleted).not.toHaveBeenCalled()
    expect(within(row(6)).queryByRole('alert')).toBeNull()
    cleanup()
    vi.clearAllMocks()
    api.createRequest.mockRejectedValueOnce(new Error('HTTP 502'))
    render(page(SIX))
    fireEvent.click(screen.getByRole('button', { name: 'Ask for Paper Lanterns again' }))
    await flush()
    expect(within(row(6)).getByRole('alert').textContent).toBe('The request could not be sent again. Try again in a moment.')
    expect(calls.submitted).not.toHaveBeenCalled()
    expect(api.deleteRequest).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toMatch(/HTTP|502/)
    expect(screen.getByRole('button', { name: 'Ask for Paper Lanterns again' })).toBeEnabled()
  })

  // DELETE /api/requests/{id} takes a pending or a failed request and no other.
  it('can be deleted only while it is pending or failed, after being asked on the row itself', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(page(SIX))
    expect(screen.getAllByRole('button', { name: /^Delete request for / }).map(b => b.getAttribute('aria-label')))
      .toEqual(['Delete request for The Glass Orchard', 'Delete request for Paper Lanterns'])
    fireEvent.click(screen.getByRole('button', { name: 'Delete request for The Glass Orchard' }))
    expect(api.deleteRequest).not.toHaveBeenCalled()
    expect(row(1).querySelector('.req-confirm')!.textContent).toBe('Delete this request?')
    // Kept.
    fireEvent.click(screen.getByRole('button', { name: 'Keep the request for The Glass Orchard' }))
    expect(row(1).querySelector('.req-confirm')).toBeNull()
    expect(api.deleteRequest).not.toHaveBeenCalled()
    // Deleted.
    fireEvent.click(screen.getByRole('button', { name: 'Delete request for The Glass Orchard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete the request for The Glass Orchard' }))
    await flush()
    expect(api.deleteRequest).toHaveBeenCalledWith(1)
    expect(calls.deleted).toHaveBeenCalledTimes(1)
    expect(calls.deleted.mock.calls[0]).toEqual([1])
    // No native dialog over the page, for the question or for a failure.
    expect(confirm).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })

  it('says so on the row when a delete fails, and leaves the question up to try again', async () => {
    api.deleteRequest.mockRejectedValueOnce(new Error('HTTP 500'))
    render(page(SIX))
    fireEvent.click(screen.getByRole('button', { name: 'Delete request for The Glass Orchard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete the request for The Glass Orchard' }))
    await flush()
    expect(within(row(1)).getByRole('alert').textContent).toBe('It could not be deleted. Try again in a moment.')
    expect(calls.deleted).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toMatch(/HTTP|500/)
    fireEvent.click(screen.getByRole('button', { name: 'Delete the request for The Glass Orchard' }))
    await flush()
    expect(calls.deleted).toHaveBeenCalledWith(1)
  })
})
