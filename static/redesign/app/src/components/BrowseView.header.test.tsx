// @vitest-environment jsdom
//
// The top of a Library grid under a live catalog refresh (a scan adding
// titles while the page is open).
//
// The page used to open with a featured band: one title from the list, held
// by id so that a refresh inserting a title ahead of it did not swap it, and
// rotated every nine seconds. That is what this file first pinned. The band
// went (the hero is Tonight's alone), and then the title block and the sticky
// toolbar under it: the top of the page is now LibraryHeader's one row, with
// the grid's controls in it, and the grid itself. What the band's test
// protected is true by construction and still pinned here: the page's top is
// its own name and count, it names no title, a refresh changes only the
// count and the grid, and nothing on the page runs on a timer.
//
// The page is composed here as App composes it: the header, with the grid's
// controls and genres in it, above the grid.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import BrowseView from './BrowseView'
import { LibraryHeader } from './LibraryHeader'
import { BrowseTools, GenreChips } from './BrowseControls'
import type { BrowseLayout } from '@/lib/browseLayout'
import type { Media } from '@/lib/types'

const m = (id: number, title: string, tags: string[] = []): Media => ({
  id, title, year: 2020, rating: 7, duration: '1h 40m', genre: 'Drama', type: 'movie',
  poster: `/p${id}.jpg`, backdrop: `/b${id}.jpg`, description: `${title}.`, tags,
})

const noop = () => {}
const page = (items: Media[], layout: BrowseLayout = 'comfortable', total = items.length) => (
  <>
    <LibraryHeader
      current="movies" navScope="full" onNavigate={noop} title="Movies"
      tools={<BrowseTools noun="movie" total={total} sortBy="recent" onSortChange={noop} layout={layout} onLayoutChange={noop} genre="" onGenreChange={noop} genres={['Drama', 'Comedy']} />}
    >
      <GenreChips genre="" onGenreChange={noop} genres={['Drama', 'Comedy']} />
    </LibraryHeader>
    <BrowseView
      items={items} total={total} layout={layout}
      onLoadMore={noop} isLoadingMore={false} onSelect={noop} onCardContext={noop} onCardPlay={noop}
    />
  </>
)
/** The card titles in the grid, in order. */
const grid = () => [...document.querySelectorAll('.poster-grid .cc-title')].map(el => el.textContent)
const header = () => document.querySelector<HTMLElement>('[data-library-header]')!
const count = () => document.querySelector('[data-browse-count]')!.textContent

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('the top of a Library grid', () => {
  it('is the page\'s own name and count, and features no title', () => {
    render(page([m(1, 'Alpha'), m(2, 'Bravo')]))
    const h1 = screen.getAllByRole('heading', { level: 1 })
    expect(h1.map(h => h.textContent)).toEqual(['Movies'])
    // The scope row shows the name, marked as the page; the heading is for
    // assistive tech.
    expect(within(header()).getByRole('button', { name: 'Movies' })).toHaveAttribute('aria-current', 'page')
    expect(count()).toMatch(/^2 movies/)
    // No hero: no backdrop band, no "More info about <a title>" control, and
    // no title set as a heading.
    expect(document.querySelector('.stage-hero-img')).toBeNull()
    expect(document.querySelector('.stage-hero-scrim')).toBeNull()
    expect(screen.queryByLabelText(/^More info about /)).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Alpha' })).toBeNull()
    expect(header().textContent).not.toContain('Alpha')
    // Every title is in the grid, the first included: none is taken out of
    // it to be featured, and nothing stands between the header and the grid.
    expect(grid()).toEqual(['Alpha', 'Bravo'])
    expect(document.querySelector('.rail-title')).toBeNull()
  })

  it('keeps that header when a refresh inserts titles ahead of the first, changing only the count and the grid', () => {
    const { rerender } = render(page([m(1, 'Alpha'), m(2, 'Bravo')]))
    const heading = screen.getByRole('heading', { level: 1 })
    const sort = screen.getByRole('combobox', { name: 'Sort titles' })
    expect(count()).toMatch(/^2 movies/)
    rerender(page([m(9, 'Zulu New'), m(1, 'Alpha'), m(2, 'Bravo')]))
    // The same heading and the same sort control, with the same text:
    // nothing at the top of the page was swapped under the reader.
    expect(screen.getByRole('heading', { level: 1 })).toBe(heading)
    expect(screen.getByRole('combobox', { name: 'Sort titles' })).toBe(sort)
    expect(heading.textContent).toBe('Movies')
    expect(count()).toMatch(/^3 movies/)
    expect(header().textContent).not.toContain('Zulu New')
    expect(grid()).toEqual(['Zulu New', 'Alpha', 'Bravo'])
  })

  it('holds under an import that puts five new titles ahead', () => {
    const old = [m(1, 'Alpha'), m(2, 'Bravo')]
    const { rerender } = render(page(old))
    const heading = screen.getByRole('heading', { level: 1 })
    const fresh = [10, 11, 12, 13, 14].map(id => m(id, `New ${id}`))
    rerender(page([...fresh, ...old]))
    expect(screen.getByRole('heading', { level: 1 })).toBe(heading)
    expect(screen.queryByLabelText(/^More info about /)).toBeNull()
    expect(grid()).toEqual([...fresh, ...old].map(x => x.title))
  })

  it('runs nothing on a timer', () => {
    vi.useFakeTimers()
    const setInterval_ = vi.spyOn(window, 'setInterval')
    render(page([m(1, 'Alpha'), m(2, 'Bravo'), m(3, 'Charlie')]))
    const before = document.body.innerHTML
    // Nothing is waiting to run: no rotation, no poll, no delayed swap.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(document.body.innerHTML).toBe(before)
    expect(setInterval_).not.toHaveBeenCalled()
  })
})

describe('a Library grid\'s layouts', () => {
  const tagged = [m(1, 'Alpha', ['4K', 'HDR', 'PG-13']), m(2, 'Bravo', ['R'])]
  const caption = (title: string) =>
    [...document.querySelectorAll('.card-caption')].find(c => c.querySelector('.cc-title')?.textContent === title)!

  it('comfortable: the facts line with the runtime, and no chips', () => {
    render(page(tagged, 'comfortable'))
    expect(document.querySelector('.poster-grid')).not.toHaveClass('is-compact')
    expect(caption('Alpha').textContent).toContain('1h 40m')
    expect(document.querySelectorAll('.co-chip')).toHaveLength(0)
  })

  // The compact grid is for a large library, where a person chooses by what
  // a file is (4K, HDR) and who it is for (the rating): those are its chips.
  it('compact: smaller cards whose line is the year and the quality and rating chips', () => {
    render(page(tagged, 'compact'))
    expect(document.querySelector('.poster-grid')).toHaveClass('is-compact')
    expect([...caption('Alpha').querySelectorAll('.co-chip')].map(c => c.textContent)).toEqual(['4K', 'HDR', 'PG-13'])
    expect([...caption('Bravo').querySelectorAll('.co-chip')].map(c => c.textContent)).toEqual(['R'])
    expect(caption('Alpha').querySelector('.co-meta')!.textContent).toContain('2020')
    expect(caption('Alpha').textContent).not.toContain('1h 40m')
  })

  it('names quality and rating in every card\'s accessible name, whatever the layout', () => {
    for (const layout of ['comfortable', 'compact'] as const) {
      const { unmount } = render(page(tagged, layout))
      expect(screen.getByRole('button', { name: /^Alpha \(2020\).*4K, HDR, PG-13/ })).toBeInTheDocument()
      unmount()
    }
  })

  it('list: rows, not cards', () => {
    render(page(tagged, 'list'))
    expect(document.querySelector('.poster-grid')).toBeNull()
    expect(document.querySelectorAll('.media-list-row')).toHaveLength(2)
  })

  // The list's own columns: the content rating and the score each have one,
  // quality is not drawn (it is the compact grid's and the title page's),
  // and a title the viewer has started says where they are.
  it('list: each row reads title, genre, length, year, rating, score and where the viewer is', () => {
    render(
      <BrowseView
        items={tagged} total={2} layout="list"
        onLoadMore={noop} isLoadingMore={false} onSelect={noop} onCardContext={noop} onCardPlay={noop}
        progressById={new Map([[2, { label: 'S2 E4 · 29 min left', fraction: 0.44 }]])}
      />,
    )
    expect([...document.querySelectorAll('.media-list-head > span')].map(c => c.textContent)).toEqual(
      ['Title', 'Genre', 'Length', 'Year', 'Rating', 'Score', 'Where you are', ''])
    const cells = (title: string) => {
      const row = [...document.querySelectorAll('.media-list-row')].find(r => r.querySelector('.mlr-title')?.textContent === title)!
      return [...row.querySelectorAll('.mlr-title, .mlr-cell')].map(c => c.textContent)
    }
    expect(cells('Alpha')).toEqual(['Alpha', 'Drama', '1h 40m', '2020', 'PG-13', '7.0', ''])
    expect(cells('Bravo')).toEqual(['Bravo', 'Drama', '1h 40m', '2020', 'R', '7.0', 'S2 E4 · 29 min left'])
    expect(document.querySelectorAll('.co-chip, .mlr-tag')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('4K')
    // The phone's line under the title says the same in one place.
    const sub = (title: string) =>
      [...document.querySelectorAll('.media-list-row')].find(r => r.querySelector('.mlr-title')?.textContent === title)!.querySelector('.mlr-sub')?.textContent
    expect(sub('Alpha')).toBe('2020 · PG-13')
    expect(sub('Bravo')).toBe('2020 · R · S2 E4 · 29 min left')
    const bars = document.querySelectorAll<HTMLElement>('.mlr-bar-fill')
    expect(bars).toHaveLength(1)
    expect(bars[0].style.width).toBe('44%')
  })

  it('list: a title with no rating, score, length or year says so with a dash, not a zero', () => {
    const bare: Media = { id: 3, title: 'Bare', year: 0, rating: 0, duration: '', genre: '', type: 'movie', poster: '', description: '' }
    render(<BrowseView items={[bare]} total={1} layout="list" onLoadMore={noop} isLoadingMore={false} onSelect={noop} onCardContext={noop} onCardPlay={noop} />)
    expect([...document.querySelectorAll('.media-list-row .mlr-cell')].map(c => c.textContent)).toEqual(['—', '—', '—', '—', '—', ''])
    expect(document.querySelector('.mlr-thumb-img')).toBeNull()
    expect(document.querySelector('.mlr-sub')).toBeNull()
  })

  it('says which layout is on, among three', () => {
    render(page(tagged, 'compact'))
    const group = within(header()).getByRole('group', { name: 'View density' })
    expect(within(group).getAllByRole('button').map(b => [b.getAttribute('aria-label'), b.getAttribute('aria-pressed')])).toEqual([
      ['Comfortable grid', 'false'], ['Compact grid', 'true'], ['List', 'false'],
    ])
  })
})

// A row offers what a card offers: the one menu by right click, a long
// press, the More button and the keyboard, and Play that resumes. On an
// iPhone a long press fires no contextmenu, so without the timer and the
// More button the menu could not be reached from the list at all.
describe('a list row\'s actions', () => {
  const items = [m(1, 'Alpha'), m(2, 'Bravo')]
  function list(over: Record<string, unknown> = {}) {
    const calls = { select: vi.fn(), menu: vi.fn(), play: vi.fn(), toggle: vi.fn() }
    render(
      <BrowseView
        items={items} total={2} layout="list" onLoadMore={noop} isLoadingMore={false}
        onSelect={calls.select} onCardContext={calls.menu} onCardPlay={calls.play} onToggleLib={calls.toggle}
        resumableIds={new Set([2])} libraryIds={new Set([2])} {...over}
      />,
    )
    const row = (title: string) => [...document.querySelectorAll<HTMLElement>('.media-list-row')].find(r => r.querySelector('.mlr-title')?.textContent === title)!
    return { calls, row }
  }
  const touch = (el: Element, type: string, at = { clientX: 40, clientY: 40 }) =>
    fireEvent(el, Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, ...at }), { pointerType: 'touch' }))

  it('has a More button in the tab order that opens the menu for its title, and does not open the title', () => {
    const { calls } = list()
    const more = screen.getByRole('button', { name: 'More actions for Alpha' })
    expect(more.tabIndex).toBe(0)
    expect(more).toHaveAttribute('aria-haspopup', 'menu')
    fireEvent.click(more)
    expect(calls.menu).toHaveBeenCalledTimes(1)
    expect(calls.menu.mock.calls[0][1]).toBe(items[0])
    expect(calls.select).not.toHaveBeenCalled()
  })

  it('plays from the row, saying Resume for a title the viewer has a place in', () => {
    const { calls } = list()
    fireEvent.click(screen.getByRole('button', { name: 'Play Alpha' }))
    expect(calls.play).toHaveBeenLastCalledWith(items[0])
    fireEvent.click(screen.getByRole('button', { name: 'Resume Bravo' }))
    expect(calls.play).toHaveBeenLastCalledWith(items[1])
    expect(calls.select).not.toHaveBeenCalled()
    // Pointer conveniences, like a card's: out of the tab order. More is the stop.
    expect(screen.getByRole('button', { name: 'Play Alpha' }).tabIndex).toBe(-1)
    expect(screen.getByRole('button', { name: 'Add Alpha to My Library' }).tabIndex).toBe(-1)
    expect(screen.getByRole('button', { name: 'Remove Bravo from My Library' }).tabIndex).toBe(-1)
  })

  it('opens the menu on a right click, which is also the keyboard\'s menu key', () => {
    const { calls, row } = list()
    fireEvent.contextMenu(row('Bravo'))
    expect(calls.menu).toHaveBeenCalledTimes(1)
    expect(calls.menu.mock.calls[0][1]).toBe(items[1])
    // The menu key fires on what has the focus: the title's button, which
    // is also what names the shortcut.
    const title = within(row('Bravo')).getByRole('button', { name: /^Bravo/ })
    expect(title).toHaveAttribute('aria-keyshortcuts', 'Shift+F10')
    fireEvent.contextMenu(title)
    expect(calls.menu).toHaveBeenCalledTimes(2)
    expect(calls.menu.mock.calls[1][1]).toBe(items[1])
    expect(calls.select).not.toHaveBeenCalled()
  })

  it('opens the menu on a long press, and the finger lifting does not also open the title', () => {
    vi.useFakeTimers()
    const { calls, row } = list()
    touch(row('Alpha'), 'pointerdown')
    act(() => { vi.advanceTimersByTime(499) })
    expect(calls.menu).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(calls.menu).toHaveBeenCalledTimes(1)
    expect(calls.menu.mock.calls[0][1]).toBe(items[0])
    touch(row('Alpha'), 'pointerup')
    fireEvent.click(row('Alpha'))
    expect(calls.select).not.toHaveBeenCalled()
    // The next tap is a tap.
    fireEvent.click(row('Alpha'))
    expect(calls.select).toHaveBeenCalledTimes(1)
  })

  it('takes a short tap, a drag and a mouse press as what they are', () => {
    vi.useFakeTimers()
    const { calls, row } = list()
    // A tap: lifted before the time is up.
    touch(row('Alpha'), 'pointerdown')
    act(() => { vi.advanceTimersByTime(200) })
    touch(row('Alpha'), 'pointerup')
    act(() => { vi.advanceTimersByTime(1000) })
    // A scroll: the finger moved.
    touch(row('Alpha'), 'pointerdown')
    touch(row('Alpha'), 'pointermove', { clientX: 40, clientY: 80 })
    act(() => { vi.advanceTimersByTime(1000) })
    // A mouse held down has its own right click.
    fireEvent(row('Alpha'), Object.assign(new MouseEvent('pointerdown', { bubbles: true }), { pointerType: 'mouse' }))
    act(() => { vi.advanceTimersByTime(1000) })
    // A press that starts on one of the row's actions is that button's.
    touch(screen.getByRole('button', { name: 'More actions for Alpha' }), 'pointerdown')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(calls.menu).not.toHaveBeenCalled()
    // The title is a button too, and most of what a finger lands on: a
    // long press there is the row's.
    touch(within(row('Alpha')).getByRole('button', { name: /^Alpha/ }), 'pointerdown')
    act(() => { vi.advanceTimersByTime(500) })
    expect(calls.menu).toHaveBeenCalledTimes(1)
  })

  it('opens the title from its button (Enter and Space are a button\'s click) and from a click anywhere on the row', () => {
    const { calls, row } = list()
    const title = within(row('Alpha')).getByRole('button', { name: /^Alpha/ })
    expect(title.tagName).toBe('BUTTON')
    expect(title.tabIndex).toBe(0)
    fireEvent.click(title)
    expect(calls.select).toHaveBeenCalledTimes(1)
    expect(calls.select).toHaveBeenLastCalledWith(items[0])
    fireEvent.click(row('Alpha').querySelector('.mlr-year')!)
    expect(calls.select).toHaveBeenCalledTimes(2)
  })

  // Children of a button are presentational to assistive tech: a More
  // button inside one can be dropped from the accessibility tree while it
  // stays in the tab order. The row is a plain container, its title is the
  // button, and the actions sit beside it.
  it('nests nothing interactive inside a button', () => {
    const { row } = list()
    for (const r of [row('Alpha'), row('Bravo')]) {
      expect(r.getAttribute('role')).toBeNull()
      expect(r.hasAttribute('tabindex')).toBe(false)
      expect(r.querySelectorAll('button button, [role="button"] button, button [tabindex]')).toHaveLength(0)
      // Title, Play, Add, More: four buttons, each a child of the row's cells.
      expect(within(r).getAllByRole('button')).toHaveLength(4)
      expect(r.querySelector('.mlr-main')!.contains(r.querySelector('.mlr-more'))).toBe(false)
    }
  })
})
