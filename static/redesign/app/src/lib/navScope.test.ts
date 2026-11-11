import { describe, expect, it } from 'vitest'
import type { Profile } from './api'
import {
  destinationForView,
  hiddenFromRestricted,
  isLibraryView,
  libraryScopesFor,
  navDestinationsFor,
  navScopeFor,
  profileSummary,
} from './navScope'

const profile = (id: number, max_age_rating = ''): Profile => ({
  id, user_id: 1, name: `p${id}`, is_default: id === 1, created_at: '', updated_at: '', max_age_rating,
})
const parent = profile(1)
const kid = profile(2, 'PG')

describe('navScopeFor', () => {
  it('is unknown until the server binding is known, whatever a browser remembers', () => {
    // activeId null = the binding has not been read. The list being loaded
    // does not make it known: a remembered kid or parent profile must not
    // decide what the bar offers.
    expect(navScopeFor([], false, null)).toBe('unknown')
    expect(navScopeFor([parent, kid], false, null)).toBe('unknown')
    expect(navScopeFor([parent, kid], true, null)).toBe('unknown')
  })

  it('is full for an account known to have no profile at all', () => {
    expect(navScopeFor([], true, null)).toBe('full')
  })

  it('follows the bound profile', () => {
    expect(navScopeFor([parent, kid], true, 1)).toBe('full')
    expect(navScopeFor([parent, kid], true, 2)).toBe('restricted')
  })

  it('is unknown when the bound profile is not in the list', () => {
    // A profile deleted on another device leaves an id the list lacks.
    expect(navScopeFor([parent], true, 9)).toBe('unknown')
  })

  it('reads a limit as profileSession does: whitespace is none, any value is one', () => {
    expect(navScopeFor([profile(3, '   ')], true, 3)).toBe('full')
    expect(navScopeFor([profile(3, 'nonsense')], true, 3)).toBe('restricted')
  })
})

describe('navDestinationsFor', () => {
  it('gives an unrestricted session Tonight, Library and Together', () => {
    expect(navDestinationsFor('full').map(d => [d.id, d.label])).toEqual([
      ['home', 'Tonight'], ['library', 'Library'], ['together', 'Together'],
    ])
  })

  it('gives a restricted session Tonight, Movies and Shows and nothing else', () => {
    expect(navDestinationsFor('restricted').map(d => [d.id, d.label])).toEqual([
      ['home', 'Tonight'], ['movies', 'Movies'], ['shows', 'Shows'],
    ])
  })

  it('offers nothing a restricted session lacks while the session is unknown', () => {
    const ids = navDestinationsFor('unknown').map(d => d.id)
    expect(ids).toEqual(['home', 'library'])
    expect(ids).not.toContain('together')
  })

  it('never lists Admin or Requests as a destination', () => {
    for (const scope of ['full', 'restricted', 'unknown'] as const) {
      const ids = navDestinationsFor(scope).map(d => d.id)
      expect(ids).not.toContain('admin')
      expect(ids).not.toContain('requests')
    }
  })

  it('gives every destination a label and an icon, in a fresh array', () => {
    for (const d of navDestinationsFor('full')) {
      expect(d.label).toBeTruthy()
      expect(d.icon).toBeTruthy()
    }
    const a = navDestinationsFor('full')
    a.pop()
    expect(navDestinationsFor('full')).toHaveLength(3)
  })
})

describe('library scopes', () => {
  it('offers all five scopes, under their old view ids, to an unrestricted session', () => {
    expect(libraryScopesFor('full').map(s => s.id)).toEqual(['movies', 'shows', 'collections', 'library', 'calendar'])
    expect(libraryScopesFor('full').find(s => s.id === 'calendar')?.label).toBe('Upcoming')
  })

  it('offers only Movies and TV Shows otherwise', () => {
    expect(libraryScopesFor('restricted').map(s => s.id)).toEqual(['movies', 'shows'])
    expect(libraryScopesFor('unknown').map(s => s.id)).toEqual(['movies', 'shows'])
  })

  it('knows every scope view, offered or not', () => {
    for (const v of ['movies', 'shows', 'collections', 'library', 'calendar']) expect(isLibraryView(v)).toBe(true)
    for (const v of ['home', 'together', 'requests', 'settings', 'detail']) expect(isLibraryView(v)).toBe(false)
  })
})

describe('destinationForView', () => {
  it('marks Library for each of its scopes', () => {
    for (const v of ['movies', 'shows', 'collections', 'library', 'calendar']) {
      expect(destinationForView(v, 'full')).toBe('library')
      expect(destinationForView(v, 'unknown')).toBe('library')
    }
  })

  it('marks Movies or Shows themselves for a restricted session', () => {
    expect(destinationForView('movies', 'restricted')).toBe('movies')
    expect(destinationForView('shows', 'restricted')).toBe('shows')
    expect(destinationForView('collections', 'restricted')).toBeNull()
  })

  it('marks Together for the hub and the member pages, for a full session only', () => {
    for (const v of ['together', 'members', 'member']) {
      expect(destinationForView(v, 'full')).toBe('together')
      expect(destinationForView(v, 'unknown')).toBeNull()
      expect(destinationForView(v, 'restricted')).toBeNull()
    }
  })

  it('marks nothing for pages outside the three', () => {
    for (const v of ['settings', 'admin', 'detail', 'search', 'requests', 'profile', 'me']) {
      expect(destinationForView(v, 'full')).toBeNull()
    }
  })
})

describe('hiddenFromRestricted', () => {
  it('covers Together, requests, members and the profile page, and not the catalog', () => {
    for (const v of ['together', 'requests', 'members', 'member', 'profile']) expect(hiddenFromRestricted(v)).toBe(true)
    for (const v of ['home', 'movies', 'shows', 'detail', 'search', 'settings', 'me']) expect(hiddenFromRestricted(v)).toBe(false)
  })
})

describe('profileSummary', () => {
  it('states only what the profile record holds', () => {
    expect(profileSummary({ is_default: true, has_pin: true })).toBe('Default · locked with a PIN')
    expect(profileSummary({ is_default: false })).toBe('No limit')
    expect(profileSummary({ is_default: false, max_age_rating: ' PG ' })).toBe('Up to PG')
    expect(profileSummary({ is_default: false, has_pin: true, max_age_rating: 'PG-13' })).toBe('Locked with a PIN · up to PG-13')
    expect(profileSummary({ is_default: true })).toBe('Default')
  })
})
