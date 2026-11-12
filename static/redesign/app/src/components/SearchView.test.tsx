// @vitest-environment jsdom
//
// The search page finds titles two ways. Typing matches titles, asked of the
// server as a title search and nothing else; asking (Enter, or the page's
// button) searches by what the words describe, which costs the server a model
// call and so must run once per ask, never per keystroke.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Media } from '@/lib/types'

type Mode = 'literal' | 'semantic' | undefined
interface Ask { query: string; mode: Mode; signal?: AbortSignal; answer: (items: Media[], mode?: 'literal' | 'semantic') => void; fail: (e: Error) => void }
const asks: Ask[] = []
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  searchMedia: (query: string, _limit: number, signal: AbortSignal | undefined, mode: Mode) =>
    new Promise((resolve, reject) => {
      asks.push({
        query, mode, signal,
        answer: (items, served) => resolve({ items, mode: served ?? mode ?? 'literal' }),
        fail: reject,
      })
    }),
}))

import SearchView from './SearchView'
import { forgetDescribedAnswer } from '@/lib/describedSearch'

const media = (id: number, title: string): Media => ({
  id, title, year: 2024, rating: 8, duration: '2h', genre: 'Drama', type: 'movie', poster: '', backdrop: '', description: '',
})
const base = { onSelect: vi.fn(), onCardContext: vi.fn(), onQueryChange: vi.fn() }
const status = () => screen.getByRole('status').textContent
const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => { asks.length = 0; forgetDescribedAnswer(); vi.useFakeTimers(); base.onQueryChange.mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('typing', () => {
  it('matches titles only, after a pause, and never asks the model', async () => {
    const { rerender } = render(<SearchView {...base} query="har" onDescribe={vi.fn()} />)
    await settle(299)
    expect(asks).toHaveLength(0)
    rerender(<SearchView {...base} query="harb" onDescribe={vi.fn()} />)
    await settle(299)
    expect(asks).toHaveLength(0)
    await settle(1)
    expect(asks.map(a => [a.query, a.mode])).toEqual([['harb', 'literal']])
    expect(status()).toBe('Searching for "harb"…')
    asks[0].answer([media(1, 'Harbor Lights')])
    await settle()
    expect(status()).toBe('1 result for "harb"')
    expect(screen.getAllByRole('button', { name: /Harbor Lights/ }).length).toBeGreaterThan(0)
    // The results are not presented as the model's.
    expect(screen.queryByText('Smart search')).toBeNull()
  })

  it('then offers the search by description, which is asked for, not started', async () => {
    const onDescribe = vi.fn()
    render(<SearchView {...base} query="something cozy" onDescribe={onDescribe} />)
    await settle(300)
    // Not while the title search is still out.
    expect(screen.queryByRole('button', { name: 'Search by description' })).toBeNull()
    asks[0].answer([media(1, 'Something Cozy')])
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Search by description' }))
    expect(onDescribe).toHaveBeenCalledWith('something cozy')
    // Only the caller's ask starts it.
    await settle(1000)
    expect(asks).toHaveLength(1)
  })

  it('says so when no title matches, and makes the description search the way on', async () => {
    const onDescribe = vi.fn()
    render(<SearchView {...base} query="a slow mystery for a rainy night" onDescribe={onDescribe} />)
    await settle(300)
    asks[0].answer([])
    await settle()
    expect(screen.getByRole('heading', { name: /No title matches .a slow mystery for a rainy night./ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Search by description' }))
    expect(onDescribe).toHaveBeenCalledWith('a slow mystery for a rainy night')
  })
})

describe('asking for a search by description', () => {
  it('runs the model-backed search for those words at once, and says the results are its', async () => {
    const { rerender } = render(<SearchView {...base} query="cozy mystery" onDescribe={vi.fn()} />)
    await settle(300)
    asks[0].answer([])
    await settle()
    rerender(<SearchView {...base} query="cozy mystery" describe={{ query: 'cozy mystery', n: 1 }} onDescribe={vi.fn()} />)
    await settle(0)
    expect(asks.map(a => [a.query, a.mode])).toEqual([['cozy mystery', 'literal'], ['cozy mystery', 'semantic']])
    expect(status()).toBe('Looking for titles like "cozy mystery"…')
    asks[1].answer([media(2, 'Quiet Harbor')], 'semantic')
    await settle()
    expect(status()).toBe('1 result for "cozy mystery"')
    expect(screen.getByText('Smart search')).toBeInTheDocument()
    // These are the description search's own: nothing says they are title
    // matches standing in for it.
    expect(document.querySelector('[data-search-by-title-instead]')).toBeNull()
    // It has been asked: the offer is gone.
    expect(screen.queryByRole('button', { name: 'Search by description' })).toBeNull()
  })

  it('does not run it for a mount that already carries the ask twice, and runs it at once on arrival from another page', async () => {
    // Enter in the top bar on another page: the search page mounts with the ask.
    render(<SearchView {...base} query="cozy mystery" describe={{ query: 'cozy mystery', n: 1 }} />)
    await settle(0)
    expect(asks.map(a => a.mode)).toEqual(['semantic'])
    await settle(1000)
    expect(asks).toHaveLength(1)
  })

  it('goes back to matching titles as soon as the words change', async () => {
    const ask = { query: 'cozy mystery', n: 1 }
    const { rerender } = render(<SearchView {...base} query="cozy mystery" describe={ask} />)
    await settle(0)
    asks[0].answer([media(2, 'Quiet Harbor')], 'semantic')
    await settle()
    // The field is edited; App would clear the ask, but even with it still
    // passed, other words are not the words that were asked about.
    rerender(<SearchView {...base} query="cozy mysteries" describe={ask} />)
    await settle(300)
    expect(asks.map(a => [a.query, a.mode])).toEqual([['cozy mystery', 'semantic'], ['cozy mysteries', 'literal']])
  })

  // The model can fail (the server answers 500). The page says so in words,
  // never with the transport's status code, and offers to try again.
  it('says in words when it did not work, and asks again when told to', async () => {
    const onDescribe = vi.fn()
    const { rerender } = render(<SearchView {...base} query="cozy mystery" describe={{ query: 'cozy mystery', n: 1 }} onDescribe={onDescribe} />)
    await settle(0)
    asks[0].fail(new Error('HTTP 500'))
    await settle()
    expect(status()).toBe('The search by description did not work.')
    expect(document.body.textContent).not.toMatch(/HTTP|500/)
    // Not "nothing found", and no offer of the search that just failed.
    expect(screen.queryByRole('heading', { name: /Nothing found|No title matches/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Search by description' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onDescribe).toHaveBeenCalledWith('cozy mystery')
    // App gives the new ask a new number: the search runs again.
    rerender(<SearchView {...base} query="cozy mystery" describe={{ query: 'cozy mystery', n: 2 }} onDescribe={onDescribe} />)
    await settle(0)
    expect(asks.map(a => a.mode)).toEqual(['semantic', 'semantic'])
    asks[1].answer([media(2, 'Quiet Harbor')], 'semantic')
    await settle()
    expect(status()).toBe('1 result for "cozy mystery"')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('says in words when a title search did not work, and tries it again', async () => {
    render(<SearchView {...base} query="harbor" onDescribe={vi.fn()} />)
    await settle(300)
    asks[0].fail(new Error('HTTP 502'))
    await settle()
    expect(status()).toBe('The search did not work.')
    expect(document.body.textContent).not.toMatch(/HTTP|502/)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle(300)
    expect(asks.map(a => [a.query, a.mode])).toEqual([['harbor', 'literal'], ['harbor', 'literal']])
    asks[1].answer([media(1, 'Harbor Lights')])
    await settle()
    expect(status()).toBe('1 result for "harbor"')
  })

  // With no model set up the server answers a description search with title
  // matches, and it does the same when its description search finds nothing.
  // It says "literal" either way, and the page must not call them results by
  // description.
  it('does not pass title matches off as results by description', async () => {
    render(<SearchView {...base} query="cozy mystery" describe={{ query: 'cozy mystery', n: 1 }} onDescribe={vi.fn()} />)
    await settle(0)
    expect(status()).toBe('Looking for titles like "cozy mystery"…')
    asks[0].answer([media(3, 'Cozy Mystery Hour')], 'literal')
    await settle()
    expect(screen.queryByText('Smart search')).toBeNull()
    expect(document.querySelector('[data-search-by-title-instead]')!.textContent)
      .toBe('These match the title. A search by description found nothing for these words, or is not set up on this server.')
    cleanup()
    // And with nothing at all.
    render(<SearchView {...base} query="cozy mystery" describe={{ query: 'cozy mystery', n: 2 }} onDescribe={vi.fn()} />)
    await settle(0)
    asks[1].answer([], 'literal')
    await settle()
    expect(document.querySelector('[data-search-by-title-instead]')!.textContent)
      .toBe('A search by description found nothing for these words, or is not set up on this server.')
    expect(screen.getByRole('heading', { name: 'Nothing found' })).toBeInTheDocument()
  })

  // Opening a result unmounts this page; Back mounts it again with the same
  // ask standing. Asked again each time, that was a model call per Back.
  it('shows the same answer again for the same ask after coming back, without asking again', async () => {
    const ask = { query: 'cozy mystery', n: 7, owner: '1:1' }
    const first = render(<SearchView {...base} query="cozy mystery" describe={ask} />)
    await settle(0)
    asks[0].answer([media(2, 'Quiet Harbor')], 'semantic')
    await settle()
    first.unmount()
    render(<SearchView {...base} query="cozy mystery" describe={ask} />)
    await settle(1000)
    expect(asks).toHaveLength(1)
    expect(status()).toBe('1 result for "cozy mystery"')
    expect(screen.getByText('Smart search')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Quiet Harbor/ }).length).toBeGreaterThan(0)
  })

  it('keeps that answer for that ask alone: not for another ask, another person, or once it is forgotten', async () => {
    const ask = { query: 'cozy mystery', n: 7, owner: '1:1' }
    const first = render(<SearchView {...base} query="cozy mystery" describe={ask} />)
    await settle(0)
    asks[0].answer([media(2, 'Quiet Harbor')], 'semantic')
    await settle()
    first.unmount()
    // The same words asked again (a new number), by someone else, or after
    // a sign-out or a profile switch: each asks the server.
    for (const [again, forget] of [[{ ...ask, n: 8 }, false], [{ ...ask, owner: '1:2' }, false], [ask, true]] as const) {
      if (forget) forgetDescribedAnswer()
      const before = asks.length
      const page = render(<SearchView {...base} query="cozy mystery" describe={again} />)
      await settle(0)
      expect(asks.length).toBe(before + 1)
      expect(screen.queryAllByRole('button', { name: /Quiet Harbor/ })).toEqual([])
      page.unmount()
    }
  })

  it('drops an answer that arrives after the words have changed, or the page has gone', async () => {
    const { rerender, unmount } = render(<SearchView {...base} query="cozy mystery" describe={{ query: 'cozy mystery', n: 1 }} />)
    await settle(0)
    rerender(<SearchView {...base} query="harbor" describe={null} />)
    expect(asks[0].signal?.aborted).toBe(true)
    asks[0].answer([media(2, 'Quiet Harbor')], 'semantic')
    await settle(300)
    expect(screen.queryByRole('button', { name: /Quiet Harbor/ })).toBeNull()
    expect(screen.queryByText('Smart search')).toBeNull()
    expect(status()).toBe('Searching for "harbor"…')
    unmount()
    expect(asks[1].signal?.aborted).toBe(true)
  })
})

describe("the page's own field (a phone has none in the top bar)", () => {
  it('asks for the search by description on Enter or the keyboard\'s Search key, and not for nothing', () => {
    const onDescribe = vi.fn()
    const { rerender } = render(<SearchView {...base} query="   " onDescribe={onDescribe} />)
    const form = screen.getByRole('search')
    fireEvent.submit(form)
    expect(onDescribe).not.toHaveBeenCalled()
    rerender(<SearchView {...base} query="cozy mystery" onDescribe={onDescribe} />)
    fireEvent.submit(form)
    expect(onDescribe).toHaveBeenCalledTimes(1)
    expect(onDescribe).toHaveBeenCalledWith('cozy mystery')
  })

  it('reports typing, and clears', () => {
    render(<SearchView {...base} query="cozy" onDescribe={vi.fn()} />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search titles' }), { target: { value: 'cozy m' } })
    expect(base.onQueryChange).toHaveBeenLastCalledWith('cozy m')
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(base.onQueryChange).toHaveBeenLastCalledWith('')
  })
})

describe('words with a space at either end', () => {
  // A space typed before the next word. The answer used to be compared with
  // the field's text, untrimmed, and dropped as stale: a skeleton for good.
  it('still shows what was found for them', async () => {
    render(<SearchView {...base} query="harbor " />)
    await settle(300)
    expect(asks.map(a => a.query)).toEqual(['harbor'])
    asks[0].answer([media(1, 'Harbor Lights')])
    await settle()
    expect(screen.getByText('Harbor Lights')).toBeInTheDocument()
    expect(status()).toBe('1 result for "harbor "')
  })
})

// Requesting has no tab of its own: it is where a search that found nothing
// ends.
describe('a search that finds nothing', () => {
  const offer = () => document.querySelector('[data-search-request]')
  async function searchFor(words: string, props: Record<string, unknown> = {}) {
    const view = render(<SearchView {...base} query={words} {...props} />)
    await settle(300)
    return view
  }

  it('offers to request it, with the words that were searched for', async () => {
    const onRequest = vi.fn()
    await searchFor('  the lost reel ', { onRequest, onDescribe: vi.fn() })
    asks[0].answer([])
    await settle()
    expect(offer()!.textContent).toContain('Not in the library?')
    fireEvent.click(screen.getByRole('button', { name: 'Request it' }))
    expect(onRequest).toHaveBeenCalledWith('the lost reel')
  })

  it('still offers it after a search by description has found nothing either', async () => {
    const onRequest = vi.fn()
    await searchFor('cozy mystery', { onRequest, describe: { query: 'cozy mystery', n: 1 }, onDescribe: vi.fn() })
    asks[0].answer([], 'semantic')
    await settle()
    expect(screen.getByRole('heading', { name: 'Nothing found' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Request it' }))
    expect(onRequest).toHaveBeenCalledWith('cozy mystery')
  })

  // A profile that is not offered requests is given no handler.
  it('does not offer it to a session that has no requests', async () => {
    await searchFor('the lost reel', { onDescribe: vi.fn() })
    asks[0].answer([])
    await settle()
    expect(document.querySelector('[data-search-empty]')).not.toBeNull()
    expect(offer()).toBeNull()
  })

  it('does not offer it while there are results, while it is still looking, or when the search failed', async () => {
    const onRequest = vi.fn()
    await searchFor('harbor', { onRequest })
    // Still looking.
    expect(offer()).toBeNull()
    asks[0].answer([media(1, 'Harbor Lights')])
    await settle()
    expect(offer()).toBeNull()
    cleanup()
    asks.length = 0
    await searchFor('harbor', { onRequest })
    asks[0].fail(new Error('HTTP 500'))
    await settle()
    expect(offer()).toBeNull()
  })
})

// While nothing is typed, the page offers what this profile searched for
// lately.
describe('recent searches', () => {
  const section = () => document.querySelector<HTMLElement>('[data-search-recent]')

  it('are listed while nothing is typed, newest first, and picking one searches for it', () => {
    const onPickRecent = vi.fn()
    render(<SearchView {...base} query="" recent={['night train', 'harbor']} onPickRecent={onPickRecent} onClearRecent={vi.fn()} />)
    // The page is headed "Search" until there is something to have results for.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Search')
    expect(screen.getByRole('heading', { name: 'Recent searches' })).toBeInTheDocument()
    const rows = [...section()!.querySelectorAll('li button')]
    expect(rows.map(r => r.textContent)).toEqual(['night train', 'harbor'])
    fireEvent.click(rows[1])
    expect(onPickRecent).toHaveBeenCalledWith('harbor')
  })

  it('go away once something is typed', async () => {
    render(<SearchView {...base} query="har" recent={['night train']} onPickRecent={vi.fn()} />)
    await settle(300)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Search Results')
    expect(section()).toBeNull()
  })

  it('are not drawn when there are none', () => {
    render(<SearchView {...base} query="" recent={[]} onPickRecent={vi.fn()} onClearRecent={vi.fn()} />)
    expect(section()).toBeNull()
    cleanup()
    render(<SearchView {...base} query="" />)
    expect(section()).toBeNull()
  })

  it('can be cleared', () => {
    const onClearRecent = vi.fn()
    render(<SearchView {...base} query="" recent={['harbor']} onPickRecent={vi.fn()} onClearRecent={onClearRecent} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onClearRecent).toHaveBeenCalledTimes(1)
  })
})
