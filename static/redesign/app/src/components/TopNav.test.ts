import { describe, expect, it } from 'vitest'
import { bottomTabsFor } from './TopNav'
import { LIBRARY_DESTINATION, navDestinationsFor } from '@/lib/navScope'

// The bar's destinations are lib/navScope's (tested there: three for an
// unrestricted session, Tonight/Movies/Shows for a restricted one, and never
// Admin or Requests). What is pinned here is how the phone tab bar arranges
// them around its two fixed tabs.

const ids = (scope: Parameters<typeof bottomTabsFor>[0]) => bottomTabsFor(scope).map(t => t.id)

describe('bottomTabsFor', () => {
  it('gives an unrestricted session Tonight, Library, Search, Together, Me', () => {
    expect(bottomTabsFor('full').map(t => t.label)).toEqual(['Tonight', 'Library', 'Search', 'Together', 'Me'])
    expect(ids('full')).toEqual(['home', LIBRARY_DESTINATION, 'search', 'together', 'me'])
  })

  it('gives a restricted session Tonight, Movies, Shows, Search, Me: no Together', () => {
    expect(bottomTabsFor('restricted').map(t => t.label)).toEqual(['Tonight', 'Movies', 'Shows', 'Search', 'Me'])
    expect(ids('restricted')).not.toContain('together')
    expect(ids('restricted')).not.toContain(LIBRARY_DESTINATION)
  })

  it('offers no Together tab while the session is unknown', () => {
    expect(ids('unknown')).toEqual(['home', LIBRARY_DESTINATION, 'search', 'me'])
  })

  it('always has Search and Me, with Me last, and never Admin or Requests', () => {
    for (const scope of ['full', 'restricted', 'unknown'] as const) {
      const t = ids(scope)
      expect(t).toContain('search')
      expect(t[t.length - 1]).toBe('me')
      expect(t).not.toContain('admin')
      expect(t).not.toContain('requests')
    }
  })

  it('holds every top-bar destination for the same session, in the same order', () => {
    for (const scope of ['full', 'restricted', 'unknown'] as const) {
      const dest = navDestinationsFor(scope).map(d => d.id)
      expect(ids(scope).filter(id => dest.includes(id))).toEqual(dest)
    }
  })

  it('gives every tab a label and an icon', () => {
    for (const t of bottomTabsFor('full')) {
      expect(t.label).toBeTruthy()
      expect(t.icon).toBeTruthy()
    }
  })
})
