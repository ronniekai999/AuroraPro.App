// @vitest-environment jsdom
//
// The search page finds titles two ways. Typing matches titles, asked of the
// server as a title search and nothing else; asking (Enter, or the page's
// button) searches by what the words describe, which costs the server a model
// call and so must run once per ask, never per keystroke.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Media } from '@/lib/types'

type Mode = 'literal' | 'semantic' | undefined
interface Ask { query: string; mode: Mode; signal?: AbortSignal; answer: (items: Media[], mode?: 'literal' | 'semantic') => void; fail: (e: Error) => void }
const asks: Ask[] = []
/** The collections the server lists, and how many times it was asked. */
const collectionList = { items: [] as Record<string, unknown>[], asks: 0, fails: false }
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  listCollections: async () => {
    collectionList.asks++
    if (collectionList.fails) throw new Error('HTTP 503')
    return collectionList.items
  },
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
/** The mark and the sentence that say the description search is what ran:
 *  both or neither (it was a "Smart search" chip beside the heading). */
const MOOD = 'Aurora read this as a mood, not a title. Showing the closest matches in your library.'
const readAsMood = () => {
  const mark = document.querySelector('[data-search-read-as-mood]') !== null
  expect(status() === MOOD).toBe(mark)
  return mark
}
const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => {
  asks.length = 0; forgetDescribedAnswer(); vi.useFakeTimers(); base.onQueryChange.mockReset()
  base.onSelect.mockReset(); base.onCardContext.mockReset()
  collectionList.items = []; collectionList.asks = 0; collectionList.fails = false
})
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
    expect(readAsMood()).toBe(false)
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
    expect(status()).toBe(MOOD)
    expect(readAsMood()).toBe(true)
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
    expect(status()).toBe(MOOD)
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
    expect(readAsMood()).toBe(false)
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
    expect(status()).toBe(MOOD)
    expect(readAsMood()).toBe(true)
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
    expect(readAsMood()).toBe(false)
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

  // They used to go once something was typed. They stay beside the results
  // now: a search that was not the one wanted is one press from another.
  it('stay beside the results once something is typed, and still search when picked', async () => {
    const onPickRecent = vi.fn()
    render(<SearchView {...base} query="har" recent={['night train']} onPickRecent={onPickRecent} />)
    await settle(300)
    asks[0].answer([media(1, 'Harbor Lights')])
    await settle()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Search Results')
    expect(section()!.closest('aside')).not.toBeNull()
    fireEvent.click(within(section()!).getByRole('button', { name: 'night train' }))
    expect(onPickRecent).toHaveBeenCalledWith('night train')
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

// What an answer looks like on the page: the first title as a row of its
// own, the rest as cards, the collections that hold the words, and beside
// them what can be done with the search.
describe('the results', () => {
  const film = (id: number, title: string, over: Partial<Media> = {}): Media => ({ ...media(id, title), ...over })
  const found = [
    film(1, 'Harbor Lights', { year: 2021, duration: '1h 52m', genre: 'Drama', tags: ['4K', 'PG-13'], description: 'A lighthouse keeper comes home.' }),
    film(2, 'Harbor Nights', { type: 'show' }),
    film(3, 'Harbor Days', { type: 'anime' }),
    film(4, 'Harbor Dawn'),
  ]
  const section = (name: string) => document.querySelector<HTMLElement>(`[data-search-${name}]`)
  /** The width the page asks about: from md up, or a phone's. */
  const screenIs = (wide: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q === '(min-width: 768px)' ? wide : false, media: q,
    addEventListener() {}, removeEventListener() {},
  }))
  beforeEach(() => screenIs(true))
  afterEach(() => { vi.unstubAllGlobals() })
  async function answered(props: Record<string, unknown> = {}, items: Media[] = found, query = 'harbor') {
    const view = render(<SearchView {...base} query={query} {...props} />)
    await settle(300)
    asks[asks.length - 1].answer(items)
    await settle()
    return view
  }

  it('draws the first title as the best match: what it is, Play, and the menu, with nothing nested in a button', async () => {
    const onCardPlay = vi.fn()
    await answered({ onCardPlay, resumableIds: new Set([4]) })
    const best = section('best')!
    expect(within(best).getByRole('heading', { name: 'Best match' })).toBeInTheDocument()
    const row = best.querySelector<HTMLElement>('.search-best')!
    expect(row.querySelector('.search-best-title')!.textContent).toBe('Harbor Lights')
    // Year, content rating (not the quality mark), length, genre.
    expect(row.querySelector('.search-best-facts')!.textContent).toBe('2021 · PG-13 · 1h 52m · Drama')
    expect(row.querySelector('.search-best-line')!.textContent).toBe('A lighthouse keeper comes home.')
    // The title is the button; Play and More are beside it.
    const open = within(row).getByRole('button', { name: /^Harbor Lights/ })
    expect(open.tagName).toBe('BUTTON')
    expect(open).toHaveAttribute('aria-keyshortcuts', 'Shift+F10')
    expect(row.getAttribute('role')).toBeNull()
    expect(row.querySelectorAll('button button')).toHaveLength(0)
    fireEvent.click(open)
    expect(base.onSelect).toHaveBeenCalledTimes(1)
    expect(base.onSelect).toHaveBeenLastCalledWith(found[0])
    fireEvent.click(within(row).getByRole('button', { name: 'Play Harbor Lights' }))
    expect(onCardPlay).toHaveBeenLastCalledWith(found[0])
    const more = within(row).getByRole('button', { name: 'More actions for Harbor Lights' })
    expect(more).toHaveAttribute('aria-haspopup', 'menu')
    fireEvent.click(more)
    expect(base.onCardContext).toHaveBeenCalledTimes(1)
    expect(base.onCardContext.mock.calls[0][1]).toBe(found[0])
    // Neither button also opened the title.
    expect(base.onSelect).toHaveBeenCalledTimes(1)
    // A right click, which is also the keyboard's menu key.
    fireEvent.contextMenu(open)
    expect(base.onCardContext).toHaveBeenCalledTimes(2)
    expect(base.onCardContext.mock.calls[1][1]).toBe(found[0])
  })

  it('says Resume, and where the viewer is, for a best match they have started', async () => {
    const onCardPlay = vi.fn()
    await answered({ onCardPlay, resumableIds: new Set([1]), progressById: new Map([[1, { label: '41 min left', fraction: 0.6 }]]) })
    const row = section('best')!.querySelector<HTMLElement>('.search-best')!
    expect(within(row).getByRole('button', { name: 'Resume Harbor Lights' }).textContent).toContain('Resume')
    expect(row.querySelector('.search-best-facts')!.textContent).toBe('2021 · PG-13 · 1h 52m · Drama · 41 min left')
  })

  it('opens the menu on a long press of the best match, and the finger lifting does not open the title', async () => {
    await answered()
    const row = section('best')!.querySelector<HTMLElement>('.search-best')!
    const touch = (el: Element, type: string) =>
      fireEvent(el, Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }), { pointerType: 'touch' }))
    touch(row.querySelector('.search-best-title')!, 'pointerdown')
    await settle(499)
    expect(base.onCardContext).not.toHaveBeenCalled()
    await settle(1)
    expect(base.onCardContext).toHaveBeenCalledTimes(1)
    expect(base.onCardContext.mock.calls[0][1]).toBe(found[0])
    touch(row, 'pointerup')
    fireEvent.click(row)
    expect(base.onSelect).not.toHaveBeenCalled()
    // A press that starts on Play or More is that button's.
    touch(within(row).getByRole('button', { name: 'More actions for Harbor Lights' }), 'pointerdown')
    await settle(1000)
    expect(base.onCardContext).toHaveBeenCalledTimes(1)
  })

  it('lists the rest as cards under "Titles", with how many, and no such section for a lone result', async () => {
    const view = await answered()
    const titles = section('titles')!
    expect(within(titles).getByRole('heading', { name: /^Titles/ }).textContent).toBe('Titles3 more')
    expect([...titles.querySelectorAll('.cc-title')].map(t => t.textContent)).toEqual(['Harbor Nights', 'Harbor Days', 'Harbor Dawn'])
    // The best match is not also one of the cards.
    expect(titles.textContent).not.toContain('Harbor Lights')
    view.unmount()
    await answered({}, [found[0]])
    expect(section('best')).not.toBeNull()
    expect(section('titles')).toBeNull()
    expect(status()).toBe('1 result for "harbor"')
  })

  it('narrows to a kind, says how many are left, and says so when there are none of it', async () => {
    await answered()
    const filters = screen.getByRole('group', { name: 'Filter results' })
    // No Collections filter for a session that is not shown collections.
    expect(within(filters).getAllByRole('button').map(b => [b.textContent, b.getAttribute('aria-pressed')]))
      .toEqual([['Everything', 'true'], ['Movies', 'false'], ['TV Shows', 'false']])
    const shown = () => [section('best')?.querySelector('.search-best-title')?.textContent, ...[...(section('titles')?.querySelectorAll('.cc-title') ?? [])].map(t => t.textContent)]
    fireEvent.click(within(filters).getByRole('button', { name: 'Movies' }))
    expect(shown()).toEqual(['Harbor Lights', 'Harbor Dawn'])
    expect(status()).toBe('2 results for "harbor"')
    // Anime is a show here, as it is everywhere else.
    fireEvent.click(within(filters).getByRole('button', { name: 'TV Shows' }))
    expect(shown()).toEqual(['Harbor Nights', 'Harbor Days'])
    expect(within(filters).getByRole('button', { name: 'TV Shows' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(filters).getByRole('button', { name: 'Everything' }))
    expect(shown()).toEqual(['Harbor Lights', 'Harbor Nights', 'Harbor Days', 'Harbor Dawn'])
    cleanup()
    // Only movies were found: "TV Shows" leaves nothing, and the page says
    // so in its one line, with the filter still there to undo it.
    await answered({}, [found[0], found[3]])
    fireEvent.click(screen.getByRole('button', { name: 'TV Shows' }))
    expect(status()).toBe('No TV shows match "harbor"')
    expect(section('best')).toBeNull()
    expect(screen.getByRole('group', { name: 'Filter results' })).toBeInTheDocument()
    // Not the empty page: nothing is offered as if the search had failed.
    expect(document.querySelector('[data-search-empty]')).toBeNull()
  })

  it('has no filter while there is nothing to narrow, and starts the next search from everything', async () => {
    const view = render(<SearchView {...base} query="harbor" />)
    await settle(300)
    expect(screen.queryByRole('group', { name: 'Filter results' })).toBeNull()
    asks[0].answer(found)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Movies' }))
    view.rerender(<SearchView {...base} query="" />)
    await settle()
    expect(screen.queryByRole('group', { name: 'Filter results' })).toBeNull()
    view.rerender(<SearchView {...base} query="harbor" />)
    await settle(300)
    asks[asks.length - 1].answer(found)
    await settle()
    expect(screen.getByRole('button', { name: 'Everything' })).toHaveAttribute('aria-pressed', 'true')
  })

  describe('collections', () => {
    const col = (id: number, name: string, over: Record<string, unknown> = {}) =>
      ({ id, owner_user_id: 1, name, kind: 'manual', is_public: false, item_count: 3, created_at: '', updated_at: '', ...over })
    beforeEach(() => {
      collectionList.items = [
        col(1, 'Harbor towns', { item_count: 9, kind: 'ai', is_public: true, poster_paths: ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg'] }),
        col(2, 'Rainy Sunday', { description: 'Slow films for a harbor morning', item_count: 1 }),
        col(3, 'Best of 2025', { prompt: 'award winners' }),
      ]
    })

    it('lists the ones whose name, note or description holds every word, and opens the one pressed', async () => {
      const onOpenCollection = vi.fn()
      await answered({ onOpenCollection })
      const rows = [...section('collections')!.querySelectorAll<HTMLElement>('.search-colrow')]
      expect(rows.map(r => [r.querySelector('.search-colrow-name')!.textContent, r.querySelector('.search-colrow-facts')!.textContent])).toEqual([
        ['Harbor towns', '9 titles · built by Aurora · public'],
        ['Rainy Sunday', '1 title'],
      ])
      // Three of its posters at most.
      expect(rows[0].querySelectorAll('img')).toHaveLength(3)
      // They count as results, and have a filter of their own.
      expect(status()).toBe('6 results for "harbor"')
      fireEvent.click(rows[1])
      expect(onOpenCollection).toHaveBeenCalledWith(2)
      fireEvent.click(screen.getByRole('button', { name: 'Collections' }))
      expect(section('best')).toBeNull()
      expect(section('titles')).toBeNull()
      expect(section('collections')!.querySelectorAll('.search-colrow')).toHaveLength(2)
      expect(status()).toBe('2 results for "harbor"')
      fireEvent.click(screen.getByRole('button', { name: 'Movies' }))
      expect(section('collections')).toBeNull()
    })

    it('matches every word of the search, in any order, and nothing on an empty one', async () => {
      const onOpenCollection = vi.fn()
      await answered({ onOpenCollection }, found, 'morning harbor')
      expect([...section('collections')!.querySelectorAll('.search-colrow-name')].map(n => n.textContent)).toEqual(['Rainy Sunday'])
      cleanup()
      await answered({ onOpenCollection }, found, 'harbor winners')
      expect(section('collections')).toBeNull()
    })

    it('are a result by themselves: a search that matches no title but a collection is not an empty one', async () => {
      await answered({ onOpenCollection: vi.fn(), onRequest: vi.fn() }, [], 'rainy')
      expect(document.querySelector('[data-search-empty]')).toBeNull()
      expect([...section('collections')!.querySelectorAll('.search-colrow-name')].map(n => n.textContent)).toEqual(['Rainy Sunday'])
      expect(status()).toBe('1 result for "rainy"')
    })

    // While the next words are still being searched for, the titles on
    // screen are the last answer's: so are the collections beside them.
    it('are matched on the words the titles on screen answer, not on what is being typed', async () => {
      const view = await answered({ onOpenCollection: vi.fn() })
      const names = () => [...(section('collections')?.querySelectorAll('.search-colrow-name') ?? [])].map(n => n.textContent)
      expect(names()).toEqual(['Harbor towns', 'Rainy Sunday'])
      view.rerender(<SearchView {...base} query="winners" onOpenCollection={vi.fn()} />)
      await settle(300)
      expect(names()).toEqual(['Harbor towns', 'Rainy Sunday'])
      asks[asks.length - 1].answer([])
      await settle()
      expect(names()).toEqual(['Best of 2025'])
    })

    it('are neither asked for nor listed for a session that may not open them', async () => {
      await answered()
      expect(collectionList.asks).toBe(0)
      expect(section('collections')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Collections' })).toBeNull()
    })

    it('are asked for once, and a failed read lists none', async () => {
      collectionList.fails = true
      const view = await answered({ onOpenCollection: vi.fn() })
      expect(section('collections')).toBeNull()
      expect(status()).toBe('4 results for "harbor"')
      view.rerender(<SearchView {...base} query="harbo" onOpenCollection={vi.fn()} />)
      await settle(300)
      expect(collectionList.asks).toBe(1)
    })
  })

  describe('what can be done with a search', () => {
    it('offers a watch party with the best match and a request, each only to a session that may', async () => {
      const onWatchTogether = vi.fn()
      const onRequest = vi.fn()
      const view = await answered({ onWatchTogether, onRequest })
      const actions = section('actions')!
      expect(actions.closest('aside')).not.toBeNull()
      expect(within(actions).getByRole('heading', { name: 'Actions' })).toBeInTheDocument()
      fireEvent.click(within(actions).getByRole('button', { name: 'Start a watch party with Harbor Lights' }))
      expect(onWatchTogether).toHaveBeenCalledWith(found[0])
      fireEvent.click(within(actions).getByRole('button', { name: 'Not here? Request a title' }))
      expect(onRequest).toHaveBeenCalledWith('harbor')
      // The party is with what the filter leaves first.
      fireEvent.click(screen.getByRole('button', { name: 'TV Shows' }))
      fireEvent.click(within(section('actions')!).getByRole('button', { name: 'Start a watch party with Harbor Nights' }))
      expect(onWatchTogether).toHaveBeenLastCalledWith(found[1])
      view.unmount()
      await answered({ onRequest })
      expect(screen.queryByRole('button', { name: /^Start a watch party/ })).toBeNull()
      expect(screen.getByRole('button', { name: 'Not here? Request a title' })).toBeInTheDocument()
      cleanup()
      await answered()
      expect(section('actions')).toBeNull()
    })

    it('offers nothing to do while nothing is found or typed', async () => {
      render(<SearchView {...base} query="" onWatchTogether={vi.fn()} onRequest={vi.fn()} />)
      expect(section('actions')).toBeNull()
      cleanup()
      await answered({ onWatchTogether: vi.fn(), onRequest: vi.fn() }, [])
      // The empty page makes its own offer to request.
      expect(section('actions')).toBeNull()
      expect(document.querySelector('[data-search-request]')).not.toBeNull()
    })

    it('says how the two ways of searching differ, only where there are two', () => {
      render(<SearchView {...base} query="" onDescribe={vi.fn()} />)
      expect(document.querySelector('.search-hint')!.textContent).toMatch(/^Titles appear as you type\. Press Enter to search by mood or description/)
      cleanup()
      render(<SearchView {...base} query="" />)
      expect(document.querySelector('.search-hint')).toBeNull()
    })
  })

  // A phone: titles are rows, every one of them (no best match's row), the
  // filter is not drawn, and a kind chosen on a wide screen does not narrow.
  describe('on a phone', () => {
    it('lists every title as a row with its menu, and no best match or filter', async () => {
      screenIs(false)
      const onCardPlay = vi.fn()
      await answered({ onCardPlay, onWatchTogether: vi.fn(), progressById: new Map([[2, { label: 'S1 E2 · 12 min left', fraction: 0.5 }]]) })
      expect(section('best')).toBeNull()
      expect(screen.queryByRole('group', { name: 'Filter results' })).toBeNull()
      const rows = [...document.querySelectorAll<HTMLElement>('[data-search-rows] .media-list-row')]
      expect(rows.map(r => r.querySelector('.mlr-title')!.textContent)).toEqual(['Harbor Lights', 'Harbor Nights', 'Harbor Days', 'Harbor Dawn'])
      expect(rows[1].querySelector('.mlr-sub')!.textContent).toBe('2024 · S1 E2 · 12 min left')
      expect(within(section('titles')!).getByRole('heading').textContent).toBe('Titles')
      fireEvent.click(within(rows[2]).getByRole('button', { name: /^Harbor Days/ }))
      expect(base.onSelect).toHaveBeenLastCalledWith(found[2])
      fireEvent.click(within(rows[2]).getByRole('button', { name: 'More actions for Harbor Days' }))
      expect(base.onCardContext.mock.calls[0][1]).toBe(found[2])
      fireEvent.click(within(rows[0]).getByRole('button', { name: 'Play Harbor Lights' }))
      expect(onCardPlay).toHaveBeenLastCalledWith(found[0])
      // What else there is, under the results: headed "More" there.
      expect(within(section('actions')!).getByRole('heading').textContent).toBe('More')
      expect(screen.getByRole('button', { name: 'Start a watch party with Harbor Lights' })).toBeInTheDocument()
    })

    it('is not narrowed by a kind chosen while the window was wide', async () => {
      // A window that tells its listeners when it is made narrow.
      let wide = true
      const listeners = new Set<() => void>()
      vi.stubGlobal('matchMedia', (q: string) => ({
        get matches() { return q === '(min-width: 768px)' ? wide : false }, media: q,
        addEventListener(_: string, fn: () => void) { listeners.add(fn) },
        removeEventListener(_: string, fn: () => void) { listeners.delete(fn) },
      }))
      await answered()
      fireEvent.click(screen.getByRole('button', { name: 'Movies' }))
      expect(section('titles')!.querySelectorAll('.cc-title')).toHaveLength(1)
      wide = false
      act(() => { for (const fn of listeners) fn() })
      expect([...document.querySelectorAll('[data-search-rows] .mlr-title')].map(t => t.textContent))
        .toEqual(['Harbor Lights', 'Harbor Nights', 'Harbor Days', 'Harbor Dawn'])
      expect(status()).toBe('4 results for "harbor"')
    })
  })
})
