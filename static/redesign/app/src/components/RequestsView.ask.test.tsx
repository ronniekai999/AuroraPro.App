// @vitest-environment jsdom
//
// The requests page as the end of a search that found nothing: it arrives
// with words to look up, opens its composer with them, and takes them once.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({ searchTmdb: vi.fn<(q: string) => Promise<unknown[]>>() }))
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  searchTmdb: api.searchTmdb,
}))

import RequestsView from './RequestsView'

const noop = () => {}
const field = () => screen.queryByPlaceholderText('Search TMDB for title…') as HTMLInputElement | null

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('the requests page, arriving from a search that found nothing', () => {
  it('opens its composer with the words already in it, looks them up, and says it has taken them', async () => {
    api.searchTmdb.mockResolvedValue([])
    const onAskTaken = vi.fn()
    render(<RequestsView requests={[]} onRequestSubmitted={noop} onRequestDeleted={noop} ask={{ query: 'the lost reel', n: 1 }} onAskTaken={onAskTaken} />)
    expect(field()!.value).toBe('the lost reel')
    await waitFor(() => expect(api.searchTmdb).toHaveBeenCalledWith('the lost reel', expect.anything()))
    expect(onAskTaken).toHaveBeenCalledTimes(1)
  })

  it('opens with nothing when it was not asked', () => {
    render(<RequestsView requests={[]} onRequestSubmitted={noop} onRequestDeleted={noop} />)
    expect(field()).toBeNull()
  })

  // App forgets the ask once it is taken; the composer stays as it is.
  it('keeps the composer open when the ask is then withdrawn, and takes a new ask when one comes', async () => {
    api.searchTmdb.mockResolvedValue([])
    const props = { requests: [], onRequestSubmitted: noop, onRequestDeleted: noop }
    const { rerender } = render(<RequestsView {...props} ask={{ query: 'the lost reel', n: 1 }} />)
    rerender(<RequestsView {...props} ask={null} />)
    expect(field()!.value).toBe('the lost reel')
    rerender(<RequestsView {...props} ask={{ query: 'another one', n: 2 }} />)
    expect(field()!.value).toBe('another one')
  })

  // The composer waits for the list; the words wait with it.
  it('holds the words while the page is still loading its list', () => {
    const props = { onRequestSubmitted: noop, onRequestDeleted: noop, ask: { query: 'the lost reel', n: 1 } }
    const { rerender } = render(<RequestsView {...props} requests={null} />)
    expect(field()).toBeNull()
    rerender(<RequestsView {...props} requests={[]} />)
    expect(field()!.value).toBe('the lost reel')
  })
})
