// @vitest-environment jsdom
//
// The top of a browse page under a live catalog refresh (a scan adding
// titles while the page is open).
//
// The page used to open with a featured band: one title from the list, held
// by id so that a refresh inserting a title ahead of it did not swap it, and
// rotated every nine seconds. That is what this file pinned. The band is
// gone (the hero is Tonight's alone; a grid's first screen is its grid), and
// what it protected is now true by construction, which is what is pinned
// here: the page's top is its own heading and count, it names no title, a
// refresh changes only the count and the grid, and nothing on the page runs
// on a timer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import BrowseView from './BrowseView'
import type { Media } from '@/lib/types'

const m = (id: number, title: string): Media => ({
  id, title, year: 2020, rating: 7, duration: '', genre: '', type: 'movie',
  poster: `/p${id}.jpg`, backdrop: `/b${id}.jpg`, description: `${title}.`,
})

const view = (items: Media[]) => (
  <BrowseView
    items={items} title="Movies" subtitle="Everything in the library" total={items.length} sortBy="recent"
    onSortChange={() => {}} genreFilter="" onGenreChange={() => {}} availableGenres={[]}
    onLoadMore={() => {}} isLoadingMore={false} onSelect={() => {}} onCardContext={() => {}} onCardPlay={() => {}}
    mediaType="movie"
  />
)
/** The card titles in the grid, in order. */
const grid = () => [...document.querySelectorAll('.poster-grid .cc-title')].map(el => el.textContent)

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('the top of a browse page', () => {
  it('is the page\'s own heading and count, and features no title', () => {
    render(view([m(1, 'Alpha'), m(2, 'Bravo')]))
    const h1 = screen.getAllByRole('heading', { level: 1 })
    expect(h1.map(h => h.textContent)).toEqual(['Movies'])
    // No hero: no backdrop band, no "More info about <a title>" control, and
    // no title set as a heading.
    expect(document.querySelector('.stage-hero-img')).toBeNull()
    expect(document.querySelector('.stage-hero-scrim')).toBeNull()
    expect(screen.queryByLabelText(/^More info about /)).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Alpha' })).toBeNull()
    // Every title is in the grid, the first included: none is taken out of
    // it to be featured.
    expect(grid()).toEqual(['Alpha', 'Bravo'])
  })

  it('keeps that heading when a refresh inserts titles ahead of the first, changing only the count and the grid', () => {
    const { rerender } = render(view([m(1, 'Alpha'), m(2, 'Bravo')]))
    const heading = screen.getByRole('heading', { level: 1 })
    const header = heading.parentElement!
    expect(header.textContent).toContain('2 titles')
    rerender(view([m(9, 'Zulu New'), m(1, 'Alpha'), m(2, 'Bravo')]))
    // The same heading element, with the same text: nothing at the top of
    // the page was swapped under the reader.
    expect(screen.getByRole('heading', { level: 1 })).toBe(heading)
    expect(heading.textContent).toBe('Movies')
    expect(header.textContent).toContain('3 titles')
    expect(header.textContent).not.toContain('Zulu New')
    expect(grid()).toEqual(['Zulu New', 'Alpha', 'Bravo'])
  })

  it('holds under an import that puts five new titles ahead', () => {
    const old = [m(1, 'Alpha'), m(2, 'Bravo')]
    const { rerender } = render(view(old))
    const heading = screen.getByRole('heading', { level: 1 })
    const fresh = [10, 11, 12, 13, 14].map(id => m(id, `New ${id}`))
    rerender(view([...fresh, ...old]))
    expect(screen.getByRole('heading', { level: 1 })).toBe(heading)
    expect(screen.queryByLabelText(/^More info about /)).toBeNull()
    expect(grid()).toEqual([...fresh, ...old].map(x => x.title))
  })

  // The band rotated every nine seconds, which swapped a title and its
  // actions out from under a reader. Nothing here runs on a timer now.
  it('starts no timer: nothing on the page rotates', () => {
    vi.useFakeTimers()
    render(view([m(1, 'Alpha'), m(2, 'Bravo'), m(3, 'Charlie')]))
    expect(vi.getTimerCount()).toBe(0)
    const before = document.body.innerHTML
    vi.advanceTimersByTime(60_000)
    expect(document.body.innerHTML).toBe(before)
  })
})
