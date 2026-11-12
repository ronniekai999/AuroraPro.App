// @vitest-environment jsdom
//
// A Library grid's controls: the count, the sort, the layout and the genres
// in the header's row (a wide screen), and the same choices in the Filters
// sheet (a phone). Each choice is reported at once; nothing here holds state
// of its own except whether the sheet is open.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { BrowseTools, GenreChips, LetterStrip, countLabel, type BrowseControlsProps } from './BrowseControls'
import { JUMP_LETTERS, type LetterState } from '@/lib/letterJump'

afterEach(cleanup)

const GENRES = ['Comedy', 'Drama', 'Horror']
function tools(over: Partial<BrowseControlsProps> = {}) {
  const props: BrowseControlsProps = {
    noun: 'movie', total: 1284, sortBy: 'title', onSortChange: vi.fn(), layout: 'comfortable', onLayoutChange: vi.fn(),
    genre: '', onGenreChange: vi.fn(), genres: GENRES, ...over,
  }
  render(<><BrowseTools {...props} /><GenreChips genre={props.genre} onGenreChange={props.onGenreChange} genres={props.genres} /></>)
  return props
}
const count = () => document.querySelector('[data-browse-count]')!
const openSheet = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
  return screen.getByRole('dialog', { name: 'Filters' })
}

describe('the count', () => {
  it('says how many, of what, and under which genre', () => {
    expect(countLabel(1284, 'movie', '')).toBe('1,284 movies')
    expect(countLabel(1, 'show', '')).toBe('1 show')
    expect(countLabel(212, 'movie', 'Drama')).toBe('212 Drama movies')
    expect(countLabel(0, 'show', 'Western')).toBe('0 Western shows')
  })

  it('is empty while the number is unknown, not a zero', () => {
    expect(countLabel(null, 'movie', '')).toBe('')
    tools({ total: null })
    expect(count().textContent).toBe('')
  })

  // It is the whole answer to "did my filter do anything".
  it('is the page\'s live region', () => {
    tools({ total: 212, genre: 'Drama' })
    expect(count()).toHaveAttribute('role', 'status')
    expect(count()).toHaveAttribute('aria-live', 'polite')
    expect(count().textContent).toContain('212 Drama movies')
  })
})

describe('the header row', () => {
  it('offers the four sorts in order, and reports a change', () => {
    const p = tools({ sortBy: 'recent' })
    const sort = screen.getByRole('combobox', { name: 'Sort titles' }) as HTMLSelectElement
    expect([...sort.options].map(o => o.textContent)).toEqual(['Recently added', 'Top rated', 'Newest', 'Title, A to Z'])
    expect(sort.value).toBe('recent')
    fireEvent.change(sort, { target: { value: 'rating' } })
    expect(p.onSortChange).toHaveBeenCalledWith('rating')
  })

  it('reports a layout that is chosen', () => {
    const p = tools()
    const group = screen.getByRole('group', { name: 'View density' })
    fireEvent.click(within(group).getByRole('button', { name: 'List' }))
    fireEvent.click(within(group).getByRole('button', { name: 'Compact grid' }))
    expect((p.onLayoutChange as ReturnType<typeof vi.fn>).mock.calls).toEqual([['list'], ['compact']])
  })

  it('lists every genre after "All genres", marks the one on, and reports a press', () => {
    const p = tools({ genre: 'Drama' })
    const chips = within(document.querySelector('.stage-genres')!).getAllByRole('button')
    expect(chips.map(c => [c.textContent, c.getAttribute('aria-pressed')])).toEqual([
      ['All genres', 'false'], ['Comedy', 'false'], ['Drama', 'true'], ['Horror', 'false'],
    ])
    fireEvent.click(chips[3])
    expect(p.onGenreChange).toHaveBeenCalledWith('Horror')
    fireEvent.click(chips[0])
    expect(p.onGenreChange).toHaveBeenLastCalledWith('')
  })

  it('draws no genre row while the genres are unknown, or when there are none', () => {
    tools({ genres: null })
    expect(document.querySelector('.stage-genres')).toBeNull()
    cleanup()
    tools({ genres: [] })
    expect(document.querySelector('.stage-genres')).toBeNull()
  })
})

describe('the Filters sheet', () => {
  it('holds the sort, the genres and the layout, each reported when pressed', () => {
    const p = tools()
    const sheet = openSheet()
    const set = (legend: string) => within(sheet).getByRole('group', { name: legend })
    expect(within(set('Sort by')).getAllByRole('button').map(b => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Recently added', 'false'], ['Top rated', 'false'], ['Newest', 'false'], ['Title, A to Z', 'true'],
    ])
    fireEvent.click(within(set('Sort by')).getByRole('button', { name: 'Newest' }))
    expect(p.onSortChange).toHaveBeenCalledWith('year')
    fireEvent.click(within(set('Genre')).getByRole('button', { name: 'Comedy' }))
    expect(p.onGenreChange).toHaveBeenCalledWith('Comedy')
    expect(within(set('Show as')).getAllByRole('button').map(b => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Posters', 'true'], ['Compact', 'false'], ['List', 'false'],
    ])
    fireEvent.click(within(set('Show as')).getByRole('button', { name: 'List' }))
    expect(p.onLayoutChange).toHaveBeenCalledWith('list')
    // Still open: every choice applies at once, behind it.
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument()
  })

  it('has nothing to reset until a sort or a genre is chosen', () => {
    tools()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    const sheet = openSheet()
    expect(within(sheet).getByRole('button', { name: 'Reset' })).toBeDisabled()
  })

  it('says on its button that something is applied, and Reset goes back to every genre and the opening sort', () => {
    const p = tools({ genre: 'Drama', sortBy: 'rating', total: 212 })
    expect(screen.getByRole('button', { name: 'Filters, some applied' })).toBeInTheDocument()
    const sheet = openSheet()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Reset' }))
    expect(p.onGenreChange).toHaveBeenCalledWith('')
    expect(p.onSortChange).toHaveBeenCalledWith('title')
  })

  it('counts a changed sort alone as something applied', () => {
    tools({ sortBy: 'recent' })
    expect(screen.getByRole('button', { name: 'Filters, some applied' })).toBeInTheDocument()
  })

  // The choices have already applied; the button only closes the sheet, and
  // says what is now behind it.
  it('closes on its main button, which says how many titles there now are', () => {
    tools({ genre: 'Drama', total: 212 })
    const sheet = openSheet()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show 212 Drama movies' }))
    expect(screen.queryByRole('dialog', { name: 'Filters' })).toBeNull()
  })

  it('says "Done" there while the number is unknown', () => {
    tools({ total: null })
    const sheet = openSheet()
    expect(within(sheet).getByRole('button', { name: 'Done' })).toBeInTheDocument()
  })
})

describe('the A to Z strip', () => {
  /** Every letter further on, but those named. */
  const states = (over: Record<string, LetterState>) =>
    Object.fromEntries(JUMP_LETTERS.map(l => [l, over[l] ?? 'further'])) as Record<string, LetterState>
  const some = states({ '#': 'none', A: 'here', B: 'here', C: 'none', D: 'here' })
  function strip(props: Partial<Parameters<typeof LetterStrip>[0]> = {}) {
    const onJump = vi.fn()
    render(<LetterStrip states={some} pending={null} missing={null} onJump={onJump} {...props} />)
    const bar = screen.getByRole('toolbar', { name: 'Jump to letter' })
    return { onJump, bar, button: (name: string) => within(bar).getByRole('button', { name }) }
  }

  it('offers the numbers and every letter, each in its state', () => {
    const { bar, button } = strip()
    const all = within(bar).getAllByRole('button')
    expect(all.map(b => b.textContent).join('')).toBe('#ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    expect(button('Numbers and symbols').textContent).toBe('#')
    expect(all.map(b => b.dataset.state).slice(0, 6)).toEqual(['none', 'here', 'here', 'none', 'here', 'further'])
    // A letter with no title anywhere is off; one that is further on is not.
    // Off is aria-disabled, never the disabled attribute (see the next test).
    expect(button('Numbers and symbols')).toHaveAttribute('aria-disabled', 'true')
    expect(button('C')).toHaveAttribute('aria-disabled', 'true')
    expect(button('A')).not.toHaveAttribute('aria-disabled')
    expect(button('M')).not.toHaveAttribute('aria-disabled')
    expect(all.filter(b => (b as HTMLButtonElement).disabled)).toEqual([])
  })

  // A letter pressed from the keyboard that turns out to have nothing used
  // to become `disabled` while it held the focus, which drops the focus to
  // the page: the next Tab started from the top of the document.
  it('keeps the focus on a letter that goes off under it, which then does nothing when pressed', () => {
    const onJump = vi.fn()
    const { rerender } = render(<LetterStrip states={some} pending={null} missing={null} onJump={onJump} />)
    const bar = screen.getByRole('toolbar', { name: 'Jump to letter' })
    const q = within(bar).getByRole('button', { name: 'Q' })
    q.focus()
    fireEvent.click(q)
    expect(onJump).toHaveBeenCalledWith('Q')
    rerender(<LetterStrip states={{ ...some, Q: 'none' }} pending={null} missing="Q" onJump={onJump} />)
    expect(document.activeElement).toBe(q)
    expect(q).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(q)
    expect(onJump).toHaveBeenCalledTimes(1)
    // And the arrow keys still go on from where it stands.
    fireEvent.keyDown(q, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(within(bar).getByRole('button', { name: 'R' }))
    q.focus()
    fireEvent.keyDown(q, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(within(bar).getByRole('button', { name: 'P' }))
  })

  it('reports the letter that is pressed', () => {
    const { onJump, button } = strip()
    fireEvent.click(button('D'))
    fireEvent.click(button('M'))
    expect(onJump.mock.calls).toEqual([['D'], ['M']])
  })

  // Twenty-seven tab stops would stand between the genres and the grid.
  it('is one tab stop: the first letter that can be pressed, then the one last used', () => {
    const { bar, button } = strip()
    const stops = () => within(bar).getAllByRole('button').filter(b => b.tabIndex === 0).map(b => b.textContent)
    expect(stops()).toEqual(['A'])
    fireEvent.click(button('D'))
    expect(stops()).toEqual(['D'])
  })

  it('moves along the letters that can be pressed with the arrow keys, Home and End', () => {
    const { button } = strip()
    button('A').focus()
    fireEvent.keyDown(button('A'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(button('B'))
    // C has nothing: skipped.
    fireEvent.keyDown(button('B'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(button('D'))
    expect(button('D').tabIndex).toBe(0)
    expect(button('A').tabIndex).toBe(-1)
    fireEvent.keyDown(button('D'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(button('B'))
    fireEvent.keyDown(button('B'), { key: 'End' })
    expect(document.activeElement).toBe(button('Z'))
    // No further than the end, or the start.
    fireEvent.keyDown(button('Z'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(button('Z'))
    fireEvent.keyDown(button('Z'), { key: 'Home' })
    expect(document.activeElement).toBe(button('A'))
    fireEvent.keyDown(button('A'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(button('A'))
  })

  it('leaves every other key alone', () => {
    const { button } = strip()
    button('A').focus()
    const tab = fireEvent.keyDown(button('A'), { key: 'Tab' })
    expect(tab).toBe(true)
    expect(document.activeElement).toBe(button('A'))
  })

  it('gives the tab stop to another letter when the one that held it can no longer be pressed', () => {
    const onJump = vi.fn()
    const { rerender } = render(<LetterStrip states={some} pending={null} missing={null} onJump={onJump} />)
    const bar = screen.getByRole('toolbar', { name: 'Jump to letter' })
    fireEvent.click(within(bar).getByRole('button', { name: 'M' }))
    expect(within(bar).getByRole('button', { name: 'M' }).tabIndex).toBe(0)
    // M was looked for and has nothing.
    rerender(<LetterStrip states={{ ...some, M: 'none' }} pending={null} missing="M" onJump={onJump} />)
    expect(within(bar).getAllByRole('button').filter(b => b.tabIndex === 0).map(b => b.textContent)).toEqual(['A'])
  })

  it('says what it is doing, and what it found, in a status line', () => {
    const { bar, button } = strip({ pending: 'M', progress: { loaded: 1200, total: 4800 } })
    // How far the loading has got, when that is known.
    expect(within(bar).getByRole('status').textContent).toBe('Loading titles to find M… 1,200 of 4,800')
    cleanup()
    expect(within(strip({ pending: 'M' }).bar).getByRole('status').textContent).toBe('Loading titles to find M…')
    cleanup()
    const loading = strip({ pending: 'M' })
    expect(loading.button('M')).toHaveAttribute('aria-busy', 'true')
    expect(loading.button('A')).not.toHaveAttribute('aria-busy')
    void bar; void button
    cleanup()
    const again = strip({ missing: 'Q', states: { ...some, Q: 'none' } })
    expect(within(again.bar).getByRole('status').textContent).toBe('No titles under Q.')
    cleanup()
    expect(within(strip().bar).getByRole('status').textContent).toBe('')
  })
})

describe('the height the A to Z strip takes', () => {
  // It wraps to a second row in a narrow window and on a touch screen. The
  // page's scroll padding is taken from its measured height, so a title it
  // scrolls to stops under it either way.
  it('is published for the page\'s scroll padding, kept current, and withdrawn with the strip', () => {
    let resized: (() => void) | null = null
    const watched: Element[] = []
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resized = cb } observe(el: Element) { watched.push(el) } disconnect() {} })
    let height = 48
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height } as DOMRect))
    const states = Object.fromEntries(JUMP_LETTERS.map(l => [l, 'here'])) as Record<string, LetterState>
    const { unmount } = render(<LetterStrip states={states} pending={null} missing={null} onJump={vi.fn()} />)
    const published = () => document.documentElement.style.getPropertyValue('--jumpbar-h')
    expect(published()).toBe('48px')
    // The strip itself is what is watched for a change of size.
    expect(watched).toEqual([document.querySelector('[data-letter-strip]')])
    // It wraps.
    height = 105.2
    resized!()
    expect(published()).toBe('106px')
    unmount()
    expect(published()).toBe('')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
})
