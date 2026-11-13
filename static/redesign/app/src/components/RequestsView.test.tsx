// @vitest-environment jsdom
//
// The requests page: what was asked for and what became of each. It makes
// no request itself (asking is the end of a search); what a row can do is
// what the server's routes allow.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { APIError, type MediaRequest } from '@/lib/api'

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
const calls = { submitted: vi.fn(), deleted: vi.fn(), moved: vi.fn(), ask: vi.fn(), find: vi.fn() }
const page = (requests: MediaRequest[] | null, over: Record<string, unknown> = {}) => (
  <RequestsView requests={requests} onRequestSubmitted={calls.submitted} onRequestDeleted={calls.deleted} onRequestMoved={calls.moved} onAsk={calls.ask} onFind={calls.find} {...over} />
)
/** The page with the list its parent keeps: a deleted request leaves it, a
 *  moved one changes status, as App's does. */
function Kept({ start, ...over }: { start: MediaRequest[] } & Record<string, unknown>) {
  const [list, setList] = useState(start)
  return (
    <RequestsView
      requests={list} onRequestSubmitted={calls.submitted}
      onRequestDeleted={id => { calls.deleted(id); setList(l => l.filter(r => r.id !== id)) }}
      onRequestMoved={(id, status) => { calls.moved(id, status); setList(l => l.map(r => (r.id === id ? { ...r, status } : r))) }}
      {...over}
    />
  )
}
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

// Review 23.
describe('whose request can be asked for again', () => {
  const failedBy = (id: number, user_id: number, extra: Partial<MediaRequest> = {}) =>
    request(id, { status: 'failed', user_id, title: `Failed ${id}`, username: user_id === 1 ? 'ronnie' : 'Dana', ...extra })

  // In a list of every member's requests, "Try again" would make the new
  // request the caller's and then delete the member's row.
  it('only the caller\'s own, in a list that holds every member\'s; a delete stays where the server allows it', () => {
    render(page([failedBy(1, 1), failedBy(2, 7)], { everyone: true, userId: 1 }))
    expect(screen.getAllByRole('button', { name: /^Ask for .* again$/ }).map(b => b.getAttribute('aria-label'))).toEqual(['Ask for Failed 1 again'])
    expect(screen.getAllByRole('button', { name: /^Delete request for / })).toHaveLength(2)
  })

  it('none in such a list when the page is not told who the caller is', () => {
    render(page([failedBy(1, 1), failedBy(2, 7)], { everyone: true }))
    expect(screen.queryByRole('button', { name: /^Ask for .* again$/ })).toBeNull()
  })

  // One press would undo the denial: under the limit, the server sends a
  // new request straight to the downloader.
  it('not one an admin turned down, which can still be deleted', () => {
    render(page([request(1, { status: 'failed', error_message: 'denied by admin', title: 'Denied' }), request(2, { status: 'failed', title: 'Broke' })], { userId: 1 }))
    expect(screen.getAllByRole('button', { name: /^Ask for .* again$/ }).map(b => b.getAttribute('aria-label'))).toEqual(['Ask for Broke again'])
    expect(screen.getByRole('button', { name: 'Delete request for Denied' })).toBeInTheDocument()
  })
})

describe('the delete question and the keyboard', () => {
  const bin = (title: string) => screen.getByRole('button', { name: `Delete request for ${title}` })
  const keepBtn = (title: string) => screen.getByRole('button', { name: `Keep the request for ${title}` })

  it('puts the focus on Keep when it opens, and back on the bin when it is kept', () => {
    render(page(SIX))
    bin('The Glass Orchard').focus()
    fireEvent.click(bin('The Glass Orchard'))
    expect(document.activeElement).toBe(keepBtn('The Glass Orchard'))
    fireEvent.click(keepBtn('The Glass Orchard'))
    expect(document.activeElement).toBe(bin('The Glass Orchard'))
    // Also when the focus was nowhere (a pointer's press focuses no button
    // in Safari): the question still puts it on Keep, and Keep on the bin.
    // (Without this the two only passed because the bin and Keep happen to
    // be one element in one place.)
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.click(bin('The Glass Orchard'))
    expect(document.activeElement).toBe(keepBtn('The Glass Orchard'))
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.click(keepBtn('The Glass Orchard'))
    expect(document.activeElement).toBe(bin('The Glass Orchard'))
  })

  it('takes Escape as Keep, and keeps the key from the page behind', () => {
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    render(page(SIX))
    fireEvent.click(bin('The Glass Orchard'))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(row(1).querySelector('.req-confirm')).toBeNull()
    expect(document.activeElement).toBe(bin('The Glass Orchard'))
    expect(api.deleteRequest).not.toHaveBeenCalled()
    expect(behind).not.toHaveBeenCalled()
    // With no question up, Escape is the page's own again.
    fireEvent.keyDown(bin('The Glass Orchard'), { key: 'Escape' })
    expect(behind).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', behind)
  })

  it('moves the focus to the next row that has something to press when a row is deleted, or to the heading', async () => {
    // Rows: a pending one, then one with nothing to press, then a failed one.
    const list = [request(1, { title: 'First' }), request(2, { title: 'Second', status: 'processing' }), request(3, { title: 'Third', status: 'failed' })]
    render(<Kept start={list} userId={1} />)
    fireEvent.click(bin('First'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete the request for First' }))
    await flush()
    expect(names()).toEqual(['Second', 'Third'])
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ask for Third again' }))
    // The last row with anything to press: the heading takes the focus.
    fireEvent.click(bin('Third'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete the request for Third' }))
    await flush()
    expect(names()).toEqual(['Second'])
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('keeps its buttons focusable while the delete is out, and takes no second press and no Escape', async () => {
    let done!: () => void
    api.deleteRequest.mockImplementationOnce(() => new Promise<void>(r => { done = r }))
    render(page(SIX))
    fireEvent.click(bin('The Glass Orchard'))
    const del = screen.getByRole('button', { name: 'Delete the request for The Glass Orchard' })
    fireEvent.click(del)
    expect(del).not.toBeDisabled()
    expect(del).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(del)
    fireEvent.click(keepBtn('The Glass Orchard'))
    expect(api.deleteRequest).toHaveBeenCalledTimes(1)
    expect(row(1).querySelector('.req-confirm')).not.toBeNull()
    // Escape is Keep's key, and like Keep answers nothing while the delete
    // is out; it is still not the page's behind.
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    fireEvent.keyDown(del, { key: 'Escape' })
    window.removeEventListener('keydown', behind)
    expect(row(1).querySelector('.req-confirm')).not.toBeNull()
    expect(behind).not.toHaveBeenCalled()
    done()
    await flush()
    expect(calls.deleted).toHaveBeenCalledWith(1)
  })
})

describe('what a refusal says on the requests page', () => {
  it('says why a retry was refused in the server\'s terms, where it gave any', async () => {
    api.createRequest.mockRejectedValueOnce(new Error('you already have an active request for this media'))
    render(page(SIX))
    fireEvent.click(screen.getByRole('button', { name: 'Ask for Paper Lanterns again' }))
    await flush()
    expect(within(row(6)).getByRole('alert').textContent).toBe('You have already asked for this one.')
    api.createRequest.mockRejectedValueOnce(new Error('requests feature is not enabled'))
    fireEvent.click(screen.getByRole('button', { name: 'Ask for Paper Lanterns again' }))
    await flush()
    expect(within(row(6)).getByRole('alert').textContent).toBe('Requests are not set up on this server.')
  })

  // A pending request is with the downloader within seconds, and the server
  // deletes only a pending or a failed one.
  it('says a pending request has moved on when its delete is refused for that, and puts the row right', async () => {
    api.deleteRequest.mockRejectedValueOnce(new Error('can only delete pending or failed requests'))
    render(<Kept start={[request(1, { title: 'First' }), request(2, { title: 'Second', status: 'failed' })]} userId={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete request for First' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete the request for First' }))
    await flush()
    expect(calls.moved).toHaveBeenCalledWith(1, 'processing')
    expect(calls.deleted).not.toHaveBeenCalled()
    expect(within(row(1)).getByRole('alert').textContent).toBe('It is with the downloader now and can no longer be deleted.')
    expect(row(1).querySelector('.req-status-label')!.textContent).toBe('Processing')
    // The question and the bin are gone from that row; the focus is on the next thing to press.
    expect(row(1).querySelector('.req-confirm')).toBeNull()
    expect(within(row(1)).queryByRole('button')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ask for Second again' }))
  })

  // With the Pending filter on, the row that is put right is no longer in
  // the list shown, and what it says would go with it.
  it('says it above the list, with the title, when the row it is about has left the list shown', async () => {
    api.deleteRequest.mockRejectedValueOnce(new Error('can only delete pending or failed requests'))
    render(<Kept start={[request(1, { title: 'First' }), request(2, { title: 'Second' }), request(3, { title: 'Third', status: 'failed' })]} userId={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pending · 2' }))
    expect(document.querySelector('[data-requests-wrong]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete request for First' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete the request for First' }))
    await flush()
    expect(names()).toEqual(['Second'])
    const said = screen.getByRole('alert')
    expect(said.textContent).toBe('First: It is with the downloader now and can no longer be deleted. It is listed under Processing now.')
    expect(said.closest('[data-request-id]')).toBeNull()
    // With the row back in view the words are on the row, and are not
    // announced a second time: they were said above the list.
    fireEvent.click(screen.getByRole('button', { name: 'All · 3' }))
    expect(document.querySelector('[data-requests-wrong]')).toBeNull()
    expect(row(1).querySelector('.req-wrong')!.textContent).toBe('It is with the downloader now and can no longer be deleted.')
    expect(screen.queryAllByRole('alert')).toEqual([])
  })

  // The other way round: said on the row first, then the viewer filters the
  // row out. The words move above the list, and are not announced again.
  it('announces it once when it was said on the row first and the row is then filtered out', async () => {
    api.deleteRequest.mockRejectedValueOnce(new Error('can only delete pending or failed requests'))
    render(<Kept start={[request(1, { title: 'First' }), request(2, { title: 'Second' })]} userId={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete request for First' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete the request for First' }))
    await flush()
    expect(within(row(1)).getByRole('alert').textContent).toBe('It is with the downloader now and can no longer be deleted.')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Pending · 1' }))
    expect(document.querySelector('[data-requests-wrong]')!.textContent).toBe('First: It is with the downloader now and can no longer be deleted. It is listed under Processing now.')
    expect(screen.queryAllByRole('alert')).toEqual([])
  })

  // Deleted already, from another tab or by an admin: the server has no
  // such request. It is gone, which is what was asked for.
  it('counts a request the server no longer has as deleted, where "try again" could never work', async () => {
    api.deleteRequest.mockRejectedValueOnce(new APIError(404, 'request not found', null))
    render(<Kept start={[request(1, { title: 'First' }), request(2, { title: 'Second', status: 'failed' })]} userId={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete request for First' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete the request for First' }))
    await flush()
    expect(calls.deleted).toHaveBeenCalledWith(1)
    expect(names()).toEqual(['Second'])
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ask for Second again' }))
    // The same for the failed row a retry clears away.
    api.deleteRequest.mockRejectedValueOnce(new APIError(404, 'request not found', null))
    fireEvent.click(screen.getByRole('button', { name: 'Ask for Second again' }))
    await flush()
    expect(calls.deleted).toHaveBeenLastCalledWith(2)
    expect(names()).toEqual([])
    // Any other status is a failure, and says so.
    cleanup()
    api.deleteRequest.mockRejectedValueOnce(new APIError(500, 'failed to delete request', null))
    render(<Kept start={[request(1, { title: 'First' })]} userId={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete request for First' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete the request for First' }))
    await flush()
    expect(within(row(1)).getByRole('alert').textContent).toBe('It could not be deleted. Try again in a moment.')
  })

  it('says only "could not be deleted" for any other failure, and for that refusal on a row that was not pending', async () => {
    api.deleteRequest.mockRejectedValueOnce(new Error('can only delete pending or failed requests'))
    render(page(SIX))
    fireEvent.click(screen.getByRole('button', { name: 'Delete request for Paper Lanterns' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete the request for Paper Lanterns' }))
    await flush()
    expect(within(row(6)).getByRole('alert').textContent).toBe('It could not be deleted. Try again in a moment.')
    expect(calls.moved).not.toHaveBeenCalled()
  })
})

describe('one thing at a time on the requests page', () => {
  it('takes no second retry, on that row or another, while one is out', async () => {
    let answer!: (r: MediaRequest) => void
    api.createRequest.mockImplementationOnce(() => new Promise(done => { answer = done as (r: MediaRequest) => void }))
    render(page([request(1, { status: 'failed', title: 'A' }), request(2, { status: 'failed', title: 'B' })], { userId: 1 }))
    const a = screen.getByRole('button', { name: 'Ask for A again' })
    const b = screen.getByRole('button', { name: 'Ask for B again' })
    fireEvent.click(a)
    expect(a.textContent).toBe('Asking…')
    expect(b).toHaveAttribute('aria-disabled', 'true')
    expect(b).not.toBeDisabled()
    fireEvent.click(b)
    fireEvent.click(a)
    fireEvent.click(screen.getByRole('button', { name: 'Delete request for B' }))
    expect(api.createRequest).toHaveBeenCalledTimes(1)
    expect(row(2).querySelector('.req-confirm')).toBeNull()
    answer(request(77, { title: 'A' }))
    await flush()
    await flush()
    expect(b).not.toHaveAttribute('aria-disabled')
    fireEvent.click(b)
    expect(api.createRequest).toHaveBeenCalledTimes(2)
  })
})

describe('when a request arrived', () => {
  // completed_at is written at a failure too: a request that failed and
  // arrived later would be dated by its failure.
  it('is not dated on a row that has an error on record', () => {
    render(page([
      request(1, { status: 'available', completed_at: ago(26) }),
      request(2, { status: 'available', completed_at: ago(26), error_message: 'radarr: timeout' }),
    ]))
    expect(row(1).querySelector('.req-status-note')!.textContent).toBe('Added to the library yesterday.')
    expect(row(2).querySelector('.req-status-note')!.textContent).toBe('In the library.')
  })
})
