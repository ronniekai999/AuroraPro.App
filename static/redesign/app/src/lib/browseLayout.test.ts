// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { COMPACT_ABOVE, fallbackGenres, readBrowseLayout, resolveBrowseLayout, useGridLayout, writeBrowseLayout } from './browseLayout'

const prefs = () => JSON.parse(localStorage.getItem('aurora_prefs') ?? '{}') as Record<string, unknown>

beforeEach(() => { localStorage.clear() })

describe('a Library grid\'s layout', () => {
  it('has no stored choice until the viewer makes one', () => {
    expect(readBrowseLayout()).toBeNull()
  })

  it('keeps each of the three choices, in the prefs, beside what else is stored there', () => {
    localStorage.setItem('aurora_prefs', JSON.stringify({ player_volume: 0.4 }))
    for (const layout of ['compact', 'list', 'comfortable'] as const) {
      writeBrowseLayout(layout)
      expect(readBrowseLayout()).toBe(layout)
    }
    expect(prefs().player_volume).toBe(0.4)
    // The density is the key Settings sets too.
    expect(prefs().library_density).toBe('comfortable')
  })

  it('remembers the density under a list, so leaving the list goes back to it', () => {
    writeBrowseLayout('compact')
    writeBrowseLayout('list')
    expect(prefs().library_density).toBe('compact')
  })

  it('still honours a list chosen under the browse page\'s old key, until a new choice is made', () => {
    localStorage.setItem('aurora.browse.density', 'list')
    expect(readBrowseLayout()).toBe('list')
    writeBrowseLayout('comfortable')
    expect(readBrowseLayout()).toBe('comfortable')
  })

  it('ignores a stored value it does not know', () => {
    localStorage.setItem('aurora_prefs', JSON.stringify({ library_density: 'huge', library_view: 'table' }))
    expect(readBrowseLayout()).toBeNull()
  })

  it('opens compact above a few hundred titles when nothing is chosen, and never overrides a choice', () => {
    expect(resolveBrowseLayout(null, COMPACT_ABOVE)).toBe('comfortable')
    expect(resolveBrowseLayout(null, COMPACT_ABOVE + 1)).toBe('compact')
    expect(resolveBrowseLayout(null, null)).toBe('comfortable')
    expect(resolveBrowseLayout(null, undefined)).toBe('comfortable')
    expect(resolveBrowseLayout('comfortable', 5000)).toBe('comfortable')
    expect(resolveBrowseLayout('list', 5000)).toBe('list')
    expect(resolveBrowseLayout('compact', 3)).toBe('compact')
  })
})

describe('the layout a grid draws with', () => {
  type P = { chosen: 'comfortable' | 'compact' | 'list' | null; total: number | null; genre: string }
  const mount = (first: P) => renderHook((p: P) => useGridLayout(p.chosen, p.total, p.genre), { initialProps: first })

  it('is comfortable until the size is known, then follows it', () => {
    const { result, rerender } = mount({ chosen: null, total: null, genre: '' })
    expect(result.current).toBe('comfortable')
    rerender({ chosen: null, total: 1284, genre: '' })
    expect(result.current).toBe('compact')
  })

  // A new sort or genre empties the list, and its total with it, until the
  // first page is back.
  it('holds while the grid reloads, instead of going back to comfortable', () => {
    const { result, rerender } = mount({ chosen: null, total: 1284, genre: '' })
    rerender({ chosen: null, total: null, genre: '' })
    expect(result.current).toBe('compact')
    rerender({ chosen: null, total: 1284, genre: '' })
    expect(result.current).toBe('compact')
  })

  it('does not change under a genre, which only narrows what is listed', () => {
    const { result, rerender } = mount({ chosen: null, total: 1284, genre: '' })
    rerender({ chosen: null, total: null, genre: 'Western' })
    rerender({ chosen: null, total: 12, genre: 'Western' })
    expect(result.current).toBe('compact')
    // And a small library stays comfortable under one.
    const small = mount({ chosen: null, total: 40, genre: '' })
    small.rerender({ chosen: null, total: 7, genre: 'Western' })
    expect(small.result.current).toBe('comfortable')
  })

  it('follows a library that has grown or shrunk past the line', () => {
    const { result, rerender } = mount({ chosen: null, total: 290, genre: '' })
    expect(result.current).toBe('comfortable')
    rerender({ chosen: null, total: 320, genre: '' })
    expect(result.current).toBe('compact')
  })

  it('is the viewer\'s choice whenever there is one', () => {
    const { result, rerender } = mount({ chosen: 'list', total: 1284, genre: '' })
    expect(result.current).toBe('list')
    rerender({ chosen: 'comfortable', total: 1284, genre: '' })
    expect(result.current).toBe('comfortable')
    rerender({ chosen: null, total: 1284, genre: '' })
    expect(result.current).toBe('compact')
  })
})

describe('the genres offered when the library\'s list could not be read', () => {
  const g = (genre: string) => ({ genre })

  it('are those of the titles the grid holds, once each, in order', () => {
    expect(fallbackGenres([g('Drama'), g('Comedy'), g('Drama'), g(''), g('Action')], '')).toEqual(['Action', 'Comedy', 'Drama'])
  })

  // Filtered to one genre, the grid holds only that genre's titles, whose
  // first genre may be another: the one that is on must stay offered.
  it('always include the genre that is on, so it can be turned off', () => {
    expect(fallbackGenres([g('Drama')], 'Horror')).toEqual(['Drama', 'Horror'])
    expect(fallbackGenres(null, 'Horror')).toEqual(['Horror'])
  })

  it('are not known while there is no list and no genre is on', () => {
    expect(fallbackGenres(null, '')).toBeNull()
    expect(fallbackGenres([], '')).toEqual([])
  })
})
