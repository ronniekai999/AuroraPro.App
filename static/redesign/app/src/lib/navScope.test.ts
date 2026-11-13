import { describe, expect, it } from 'vitest'
import type { Profile } from './api'
import {
  destinationForView,
  LIBRARY_DESTINATION,
  hiddenFromRestricted,
  isLibraryView,
  libraryScopesFor,
  mayRenderHidden,
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
      ['home', 'Tonight'], [LIBRARY_DESTINATION, 'Library'], ['together', 'Together'],
    ])
  })

  it('gives a restricted session Tonight, Movies and Shows and nothing else', () => {
    expect(navDestinationsFor('restricted').map(d => [d.id, d.label])).toEqual([
      ['home', 'Tonight'], ['movies', 'Movies'], ['shows', 'Shows'],
    ])
  })

  it('offers nothing a restricted session lacks while the session is unknown', () => {
    const ids = navDestinationsFor('unknown').map(d => d.id)
    expect(ids).toEqual(['home', LIBRARY_DESTINATION])
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

  it('gives the Library destination an id no view has, so the My Library scope is not mistaken for it', () => {
    // The scope ids ARE view ids (and URL segments). The destination id must
    // be none of them: 'library' is My Library's.
    const viewIds = libraryScopesFor('full').map(s => s.id as string)
    expect(viewIds).toContain('library')
    expect(viewIds).not.toContain(LIBRARY_DESTINATION)
    for (const scope of ['full', 'restricted', 'unknown'] as const) {
      for (const d of navDestinationsFor(scope)) {
        if (d.label === 'Library') expect(d.id).toBe(LIBRARY_DESTINATION)
      }
    }
  })

  it('knows every scope view, offered or not', () => {
    for (const v of ['movies', 'shows', 'collections', 'library', 'calendar']) expect(isLibraryView(v)).toBe(true)
    for (const v of ['home', 'together', 'requests', 'settings', 'detail']) expect(isLibraryView(v)).toBe(false)
  })
})

describe('destinationForView', () => {
  it('marks Library for each of its scopes', () => {
    for (const v of ['movies', 'shows', 'collections', 'library', 'calendar']) {
      expect(destinationForView(v, 'full')).toBe(LIBRARY_DESTINATION)
      expect(destinationForView(v, 'unknown')).toBe(LIBRARY_DESTINATION)
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
  it('covers everything but Tonight, Movies, Shows, search, a title, Settings and the account page', () => {
    for (const v of ['together', 'requests', 'members', 'member', 'profile', 'collections', 'library', 'calendar']) {
      expect(hiddenFromRestricted(v), v).toBe(true)
    }
    for (const v of ['home', 'movies', 'shows', 'detail', 'search', 'settings', 'me', 'device']) {
      expect(hiddenFromRestricted(v), v).toBe(false)
    }
  })

  it('covers every Library scope a restricted session is not offered', () => {
    const offered = libraryScopesFor('restricted').map(s => s.id as string)
    for (const s of libraryScopesFor('full')) {
      expect(hiddenFromRestricted(s.id), s.id).toBe(!offered.includes(s.id))
    }
  })
})

describe('mayRenderHidden', () => {
  const startup = (settled: boolean, askingForProfile = false) => ({ settled, askingForProfile })

  it('always renders for a session known to be unrestricted', () => {
    expect(mayRenderHidden('full', startup(false))).toBe(true)
    expect(mayRenderHidden('full', startup(true, true))).toBe(true)
  })

  it('never renders for a session known to be restricted', () => {
    for (const st of [startup(false), startup(true), startup(true, true)]) {
      expect(mayRenderHidden('restricted', st)).toBe(false)
    }
  })

  it('does not render while startup has yet to say who the session is', () => {
    expect(mayRenderHidden('unknown', startup(false))).toBe(false)
    expect(mayRenderHidden('unknown', startup(false, true))).toBe(false)
  })

  it('does not render while the app is asking which profile this is', () => {
    expect(mayRenderHidden('unknown', startup(true, true))).toBe(false)
  })

  it('renders once startup has settled and nothing can answer the question, so nobody is locked out', () => {
    expect(mayRenderHidden('unknown', startup(true, false))).toBe(true)
  })
})

describe('profileSummary', () => {
  it('states only what the profile record holds', () => {
    expect(profileSummary({ is_default: false })).toBe('No limit')
    expect(profileSummary({ is_default: false, max_age_rating: ' PG ' })).toBe('Up to PG')
    expect(profileSummary({ is_default: false, has_pin: true, max_age_rating: 'PG-13' })).toBe('Up to PG-13 · locked with a PIN')
  })

  // The limit is the fact a person choosing a profile most needs. It used to
  // be left out whenever there was anything else to say, so the same profile
  // read "Default" in the identity menu and "Default · no limit" in the
  // picker, which had to write its own line. And it leads the line: at the
  // end, it was the part a narrow row cut off.
  it('always states the limit, "no limit" included, and states it first', () => {
    expect(profileSummary({ is_default: true })).toBe('No limit · default')
    expect(profileSummary({ is_default: true, has_pin: true })).toBe('No limit · default · locked with a PIN')
    expect(profileSummary({ is_default: false, has_pin: true })).toBe('No limit · locked with a PIN')
    expect(profileSummary({ is_default: true, max_age_rating: 'PG' })).toBe('Up to PG · default')
    expect(profileSummary({ is_default: true, has_pin: true, max_age_rating: 'PG' })).toBe('Up to PG · default · locked with a PIN')
    // Whitespace is no limit, as the app reads a ceiling elsewhere.
    expect(profileSummary({ is_default: true, max_age_rating: '  ' })).toBe('No limit · default')
  })
})
