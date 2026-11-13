// @vitest-environment jsdom
//
// My Library: the profile's saved titles. The page has no heading block of
// its own; its count and its kind control are handed to the Library header's
// row (LibraryTools), which this file renders both ways: with the header
// above, as App does, and alone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import LibraryView from './LibraryView'
import { LibraryHeader, LibraryToolsProvider, scopeScrollLeft } from './LibraryHeader'
import type { Media } from '@/lib/types'

const m = (id: number, title: string, type: Media['type'] = 'movie'): Media => ({
  id, title, year: 2020, rating: 7, duration: '1h 40m', genre: 'Drama', type, poster: `/p${id}.jpg`, description: '',
})
const SAVED = [m(1, 'Alpha'), m(2, 'Bravo', 'show'), m(3, 'Charlie'), m(4, 'Delta', 'anime')]
const noop = () => {}

function view(props: Partial<Parameters<typeof LibraryView>[0]> = {}) {
  return <LibraryView library={SAVED} continueItems={[]} onSelect={noop} onToggleLib={noop} onCardContext={noop} profileName="Morgan" {...props} />
}
/** The page as App composes it: the header, and the view under it. */
function Page(props: Partial<Parameters<typeof LibraryView>[0]>) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <>
      <LibraryHeader current="library" navScope="full" onNavigate={noop} toolsRef={setSlot} />
      <LibraryToolsProvider value={slot}><main>{view(props)}</main></LibraryToolsProvider>
    </>
  )
}
const titles = () => [...document.querySelectorAll('.poster-grid .cc-title')].map(el => el.textContent)
const count = () => document.querySelector('[data-library-count]')!.textContent

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('My Library', () => {
  it('puts its count and its kind control in the Library header\'s row, not in a heading block of its own', () => {
    render(<Page />)
    const header = document.querySelector<HTMLElement>('[data-library-header]')!
    expect(within(header).getByRole('status').textContent).toBe('4 saved for Morgan')
    expect(within(header).getByRole('group', { name: 'Kind' })).toBeInTheDocument()
    // One heading names the page, for assistive tech; the header's row shows it.
    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['My Library'])
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('sr-only')
    expect(within(header).getByRole('button', { name: 'My Library' })).toHaveAttribute('aria-current', 'page')
    // Nothing of the kind control is left in the page under the header.
    expect(within(document.querySelector('main')!).queryByRole('group', { name: 'Kind' })).toBeNull()
  })

  it('draws them in place when there is no header above', () => {
    render(view())
    expect(count()).toBe('4 saved for Morgan')
    expect(screen.getByRole('group', { name: 'Kind' })).toBeInTheDocument()
  })

  it('counts without a name when the profile is not known', () => {
    render(view({ profileName: undefined }))
    expect(count()).toBe('4 saved')
  })

  it('shows every saved title, and only a kind when one is chosen', () => {
    render(view())
    const kind = screen.getByRole('group', { name: 'Kind' })
    // Each kind says how many it holds (anime counts as a show, as the grid
    // under it treats it).
    expect(within(kind).getAllByRole('button').map(b => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['All4', 'true'], ['Movies2', 'false'], ['TV Shows2', 'false'],
    ])
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta'])
    fireEvent.click(within(kind).getByRole('button', { name: /^Movies/ }))
    expect(titles()).toEqual(['Alpha', 'Charlie'])
    expect(within(kind).getByRole('button', { name: /^Movies/ })).toHaveAttribute('aria-pressed', 'true')
    // The page's live region says what the choice did.
    expect(count()).toBe('2 movies of 4 saved for Morgan')
    expect(document.querySelector('[data-library-count]')).toHaveAttribute('role', 'status')
    // Anime is a show here, as it is everywhere else.
    fireEvent.click(within(kind).getByRole('button', { name: /^TV Shows/ }))
    expect(titles()).toEqual(['Bravo', 'Delta'])
    expect(count()).toBe('2 TV shows of 4 saved for Morgan')
    fireEvent.click(within(kind).getByRole('button', { name: /^All/ }))
    expect(count()).toBe('4 saved for Morgan')
  })

  it('says so when nothing of a kind is saved', () => {
    render(view({ library: [m(1, 'Alpha')] }))
    fireEvent.click(screen.getByRole('button', { name: /^TV Shows/ }))
    expect(screen.getByText('No TV shows saved.')).toBeInTheDocument()
    expect(count()).toBe('0 TV shows of 1 saved for Morgan')
    expect(titles()).toEqual([])
    // One of a kind is said as one.
    fireEvent.click(screen.getByRole('button', { name: /^Movies/ }))
    expect(count()).toBe('1 movie of 1 saved for Morgan')
  })

  it('has no kind control, and says how to save, when nothing is saved', () => {
    render(view({ library: [] }))
    expect(count()).toBe('0 saved for Morgan')
    expect(screen.queryByRole('group', { name: 'Kind' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Nothing saved yet' })).toBeInTheDocument()
    // The marker a profile-switch test reads the empty state by.
    expect(screen.getByRole('heading', { name: 'Nothing saved yet' }).closest('[data-library-empty]')).not.toBeNull()
  })

  // An empty page offers the next thing to do, in place: a search for
  // something to save, and the two catalogs. (It was a sentence about
  // buttons that are elsewhere.)
  it('offers a search and the two catalogs where nothing is saved', () => {
    const onFind = vi.fn(), onBrowse = vi.fn()
    render(view({ library: [], onFind, onBrowse }))
    const empty = document.querySelector('[data-library-empty]') as HTMLElement
    const field = within(empty).getByRole('searchbox', { name: 'Find something to save' })
    // Nothing typed: nothing to look for.
    fireEvent.submit(field.closest('form')!)
    fireEvent.change(field, { target: { value: '   ' } })
    fireEvent.submit(field.closest('form')!)
    expect(onFind).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: 'night train' } })
    fireEvent.submit(field.closest('form')!)
    expect(onFind).toHaveBeenCalledWith('night train')
    fireEvent.click(within(empty).getByRole('button', { name: 'Browse movies' }))
    fireEvent.click(within(empty).getByRole('button', { name: 'Browse shows' }))
    expect(onBrowse.mock.calls).toEqual([['movies'], ['shows']])
    cleanup()
    // Where the page is given neither, it draws neither.
    render(view({ library: [] }))
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Browse/ })).toBeNull()
    cleanup()
    // And nothing of it once something is saved.
    render(view({ onFind, onBrowse }))
    expect(screen.queryByRole('searchbox', { name: 'Find something to save' })).toBeNull()
  })

  // An empty list that is still loading is not "0 saved".
  it('gives no count, and a skeleton, while an empty list is still loading', () => {
    render(view({ library: [], loading: true }))
    expect(count()).toBe('')
    expect(screen.queryByRole('heading', { name: 'Nothing saved yet' })).toBeNull()
    expect(document.querySelector('[data-library-empty]')).toBeNull()
    expect(document.querySelector('.poster-grid[aria-hidden="true"]')).not.toBeNull()
  })
})

describe('the Library header above it', () => {
  // On a phone the scope names scroll sideways, and the last ones start off
  // the edge of the strip.
  it('scrolls its own strip to the scope that is on screen, and again when the scope changes; never the page', () => {
    const pageScrolls = vi.fn()
    Element.prototype.scrollIntoView = pageScrolls
    // jsdom lays nothing out: give the strip and its names a geometry.
    const names = ['Movies', 'TV Shows', 'Collections', 'My Library', 'Upcoming']
    // The strip starts 20px in from the page's edge (so a measure from the
    // page, or from an offset parent, would be 20px out), and its names are
    // 110px wide, 120px apart, 18px into its content.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.tagName === 'NAV') return { left: 20, width: 390 } as DOMRect
      const strip = this.closest('nav')
      return { left: 20 + 18 + names.indexOf(this.textContent ?? '') * 120 - (strip?.scrollLeft ?? 0), width: 110 } as DOMRect
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390)
    const { rerender } = render(<LibraryHeader current="library" navScope="full" onNavigate={noop} />)
    const strip = screen.getByRole('navigation', { name: 'Library' })
    // "My Library" starts at 378 and is 110 wide: centred in 390, the strip is at 238.
    expect(strip.scrollLeft).toBe(238)
    rerender(<LibraryHeader current="movies" navScope="full" onNavigate={noop} />)
    expect(strip.scrollLeft).toBe(0)
    rerender(<LibraryHeader current="calendar" navScope="full" onNavigate={noop} />)
    expect(strip.scrollLeft).toBe(358)
    expect(pageScrolls).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('never scrolls the strip before its start', () => {
    expect(scopeScrollLeft(18, 110, 390)).toBe(0)
    expect(scopeScrollLeft(378, 110, 390)).toBe(238)
  })

  it('keeps no empty place for controls a scope has not handed it', () => {
    render(<LibraryHeader current="collections" navScope="full" onNavigate={noop} toolsRef={noop} />)
    const slot = document.querySelector('[data-library-tools]')!
    expect(slot.childNodes).toHaveLength(0)
    expect(slot).toHaveClass('stage-libhead-tools')
  })
})
