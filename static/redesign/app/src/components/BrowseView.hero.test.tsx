// @vitest-environment jsdom
//
// The browse grid's featured hero is held by id: a live catalog refresh (a
// scan adding titles) that puts a new title ahead of it must not swap it,
// from the first render on, not only after the first 9 s rotation, which a
// reduced-motion reader never reaches.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import BrowseView from './BrowseView'
import type { Media } from '@/lib/types'

const m = (id: number, title: string): Media => ({
  id, title, year: 2020, rating: 7, duration: '', genre: '', type: 'movie',
  poster: `/p${id}.jpg`, backdrop: `/b${id}.jpg`, description: `${title}.`,
})

const view = (items: Media[]) => (
  <BrowseView
    items={items} title="Movies" subtitle="" total={items.length} sortBy="recent"
    onSortChange={() => {}} genreFilter="" onGenreChange={() => {}} availableGenres={[]}
    onLoadMore={() => {}} isLoadingMore={false} onSelect={() => {}} onPlay={() => {}}
    mediaType="movie"
  />
)

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('BrowseView featured hero', () => {
  it('stays on the title showing when a refresh inserts one ahead of it', () => {
    const { rerender } = render(view([m(1, 'Alpha'), m(2, 'Bravo')]))
    expect(screen.getByLabelText('More info about Alpha')).toBeTruthy()
    rerender(view([m(9, 'Zulu New'), m(1, 'Alpha'), m(2, 'Bravo')]))
    expect(screen.getByLabelText('More info about Alpha')).toBeTruthy()
    expect(screen.queryByLabelText('More info about Zulu New')).toBeNull()
  })

  it('falls back to the first title when the one showing leaves the pool', () => {
    const { rerender } = render(view([m(1, 'Alpha'), m(2, 'Bravo')]))
    rerender(view([m(3, 'Charlie'), m(2, 'Bravo')]))
    expect(screen.getByLabelText('More info about Charlie')).toBeTruthy()
  })
})
