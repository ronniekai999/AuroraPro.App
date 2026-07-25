import { describe, expect, it } from 'vitest'
import { navTabsFor } from './TopNav'

// Aurora Stage Phase 2 — the nav swap must not change WHERE you can go.
// The sidebar's eight destinations, their ids, their order, and the admin
// gate are the contract the rest of App depends on: handleNavigate, the
// VIEW_BY_PATH popstate sync, and every deep link key off these ids. A
// typo'd id ('tvshows' for 'shows') would render a tab that navigates
// nowhere, which is exactly the kind of thing a chrome rewrite drops.
//
// Pure function, no DOM — jsdom isn't in devDependencies (see
// lib/appearance.test.ts for the same constraint).

const EXPECTED_VIEWER = ['home', 'movies', 'shows', 'collections', 'calendar', 'library', 'requests']

describe('navTabsFor', () => {
  it('gives a viewer the seven non-admin destinations, in sidebar order', () => {
    expect(navTabsFor('user').map(t => t.id)).toEqual(EXPECTED_VIEWER)
  })

  it('appends Admin for admins and nothing else', () => {
    expect(navTabsFor('admin').map(t => t.id)).toEqual([...EXPECTED_VIEWER, 'admin'])
  })

  it('treats an unknown or missing role as non-admin', () => {
    // The server enforces /api/admin/* independently, but a client-side
    // fail-open would still render a tab that 403s on every request.
    expect(navTabsFor(undefined).map(t => t.id)).toEqual(EXPECTED_VIEWER)
    expect(navTabsFor('').map(t => t.id)).toEqual(EXPECTED_VIEWER)
    expect(navTabsFor('moderator').map(t => t.id)).toEqual(EXPECTED_VIEWER)
    expect(navTabsFor('Admin').map(t => t.id)).toEqual(EXPECTED_VIEWER)
  })

  it('marks only the Admin tab with the admin badge flag', () => {
    expect(navTabsFor('admin').filter(t => t.admin).map(t => t.id)).toEqual(['admin'])
  })

  it('gives every tab a label and an icon', () => {
    for (const tab of navTabsFor('admin')) {
      expect(tab.label, `${tab.id} label`).toBeTruthy()
      expect(tab.icon, `${tab.id} icon`).toBeTruthy()
    }
  })

  it('returns a fresh array each call so a caller cannot mutate the source', () => {
    const first = navTabsFor('admin')
    first.pop()
    expect(navTabsFor('admin')).toHaveLength(8)
  })
})
