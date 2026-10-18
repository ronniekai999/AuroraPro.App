// @vitest-environment jsdom
//
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { TopNav, type TopNavProps } from './TopNav'

// The admin role belongs to the account, but the server refuses its powers to
// a session acting as a restricted profile. TopNav takes that verdict as a
// prop (App computes it with showsAdminUI) and must not fall back to the role.

const noop = () => {}

function renderNav(adminUI: boolean) {
  const props: TopNavProps = {
    user: { id: 1, username: 'owner', email: 'owner@example.test', role: 'admin' },
    adminUI,
    currentView: 'home',
    onNavigate: noop,
    searchQuery: '',
    onSearchQueryChange: noop,
    onSearchFocus: noop,
    onSearchClose: noop,
    searchInputRef: createRef<HTMLInputElement>(),
    onOpenPalette: noop,
    partyActive: false,
    partyLabel: 'Watch party',
    onPartyClick: noop,
    partyPanelOpen: false,
    serverOpen: false,
    onToggleServer: noop,
    onOpenServerPanel: noop,
    notifOpen: false,
    onToggleNotifications: noop,
    onOpenNotificationsPanel: noop,
    notifCount: 0,
    profiles: [],
    activeProfileId: null,
    onSelectProfile: noop,
    onSignOut: noop,
  }
  render(<TopNav {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Account menu for owner' }))
}

describe('TopNav admin controls', () => {
  afterEach(cleanup)

  it('shows the Admin tab, the Admin menu row and the server button when adminUI is set', () => {
    renderNav(true)
    // Each is in two places: the tab strip (whose Admin tab carries an
    // "admin" badge) or the nav icon, and the open account menu.
    expect(screen.getAllByRole('button', { name: /^Admin/ })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /^Server status$/i })).toHaveLength(2)
  })

  it('hides all of them from an admin account whose session acts as a restricted profile', () => {
    renderNav(false)
    expect(screen.queryAllByRole('button', { name: /^Admin/ })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: /^Server status$/i })).toHaveLength(0)
    // The menu did open: its other rows are there.
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
  })
})
