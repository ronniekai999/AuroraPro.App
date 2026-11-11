// @vitest-environment jsdom
//
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createRef } from 'react'
import { BottomTabBar, TopNav, type TopNavProps } from './TopNav'
import type { Profile } from '@/lib/api'
import type { NavScope } from '@/lib/navScope'

// The admin role belongs to the account, but the server refuses its powers to
// a session acting as a restricted profile. TopNav takes that verdict as a
// prop (App computes it with showsAdminUI) and must not fall back to the role.
// What a session is offered beyond that comes from navScope, which App
// derives from the profile the server has bound.

const noop = () => {}
const profile = (id: number, name: string, over: Partial<Profile> = {}): Profile => ({
  id, user_id: 1, name, is_default: id === 1, created_at: '', updated_at: '', ...over,
})
const PARENT = profile(1, 'Parent', { has_pin: true })
const KID = profile(2, 'Kid', { max_age_rating: 'PG' })

function props(over: Partial<TopNavProps> = {}): TopNavProps {
  return {
    user: { id: 1, username: 'owner', email: 'owner@example.test', role: 'admin' },
    adminUI: true,
    navScope: 'full',
    currentView: 'home',
    pageTitle: 'Tonight',
    onNavigate: noop,
    searchQuery: '',
    onSearchQueryChange: noop,
    onSearchFocus: noop,
    onSearchClose: noop,
    searchInputRef: createRef<HTMLInputElement>(),
    presence: null,
    onPresenceClick: noop,
    onOpenServerPanel: noop,
    onOpenNotificationsPanel: noop,
    notifCount: 0,
    profiles: [PARENT, KID],
    activeProfileId: 1,
    onSelectProfile: noop,
    onOpenProfilesGate: noop,
    onManageProfiles: noop,
    onOpenMyProfile: noop,
    onOpenRequests: noop,
    onSignOut: noop,
    ...over,
  }
}
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Account menu for owner' }))
const menu = () => within(screen.getByRole('group', { name: 'Account and profiles' }))
const destinations = () => within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('button').map(b => b.textContent)

afterEach(cleanup)

describe('TopNav admin controls', () => {
  it('has no Admin destination: Admin and Server status are rows of the identity menu, shown when adminUI is set', () => {
    render(<TopNav {...props({ adminUI: true })} />)
    expect(destinations()).toEqual(['Tonight', 'Library', 'Together'])
    openMenu()
    // Exactly one of each in the whole bar: the menu rows.
    expect(screen.getAllByRole('button', { name: /^Admin/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /^Server status$/i })).toHaveLength(1)
    expect(menu().getByRole('button', { name: 'Admin' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Account menu for owner' }).getAttribute('title')).toBe('Signed in as owner (admin)')
  })

  it('hides all of them from an admin account whose session acts as a restricted profile', () => {
    render(<TopNav {...props({ adminUI: false, navScope: 'restricted', activeProfileId: 2 })} />)
    openMenu()
    expect(screen.queryAllByRole('button', { name: /^Admin/ })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: /^Server status$/i })).toHaveLength(0)
    // The rest of the menu is still there.
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    // The role is not advertised either.
    expect(screen.getByRole('button', { name: 'Account menu for owner' }).getAttribute('title')).toBe('Signed in as owner')
  })

  it('follows adminUI, not the role and not the scope', () => {
    // An unrestricted session on an admin account whose verdict is still out
    // (startup): no admin rows.
    render(<TopNav {...props({ adminUI: false, navScope: 'unknown', activeProfileId: null })} />)
    openMenu()
    expect(screen.queryAllByRole('button', { name: /^Admin/ })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: /^Server status$/i })).toHaveLength(0)
  })

  it('opens the admin page and the server panel from their rows', () => {
    const onNavigate = vi.fn()
    const onOpenServerPanel = vi.fn()
    render(<TopNav {...props({ onNavigate, onOpenServerPanel })} />)
    openMenu()
    fireEvent.click(menu().getByRole('button', { name: 'Admin' }))
    expect(onNavigate).toHaveBeenCalledWith('admin')
    openMenu()
    fireEvent.click(menu().getByRole('button', { name: 'Server status' }))
    expect(onOpenServerPanel).toHaveBeenCalledTimes(1)
  })
})

describe('TopNav destinations by session', () => {
  const cases: [NavScope, string[]][] = [
    ['full', ['Tonight', 'Library', 'Together']],
    ['restricted', ['Tonight', 'Movies', 'Shows']],
    ['unknown', ['Tonight', 'Library']],
  ]
  it.each(cases)('%s session', (navScope, want) => {
    render(<TopNav {...props({ navScope, adminUI: false })} />)
    expect(destinations()).toEqual(want)
    // Never a tab for these, whoever is asking.
    for (const gone of ['Admin', 'Requests', 'Calendar', 'Collections', 'My Library']) expect(destinations()).not.toContain(gone)
  })

  it('marks the destination a view belongs to, and nothing for a page outside the three', () => {
    const { rerender } = render(<TopNav {...props({ currentView: 'collections' })} />)
    const current = () => screen.getByRole('navigation', { name: 'Main' }).querySelector('[aria-current="page"]')?.textContent ?? null
    expect(current()).toBe('Library')
    rerender(<TopNav {...props({ currentView: 'together' })} />)
    expect(current()).toBe('Together')
    rerender(<TopNav {...props({ currentView: 'settings' })} />)
    expect(current()).toBeNull()
    rerender(<TopNav {...props({ currentView: 'shows', navScope: 'restricted' })} />)
    expect(current()).toBe('Shows')
  })

  it('navigates by destination id', () => {
    const onNavigate = vi.fn()
    render(<TopNav {...props({ onNavigate })} />)
    for (const name of ['Library', 'Together', 'Tonight']) fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name }))
    expect(onNavigate.mock.calls.map(c => c[0])).toEqual(['library', 'together', 'home'])
  })
})

describe('the identity control', () => {
  it('is the one control that names who is watching, and there is no second avatar or profile chip', () => {
    render(<TopNav {...props()} />)
    const trigger = screen.getByRole('button', { name: 'Account menu for owner' })
    expect(trigger.querySelector('[data-identity-name]')?.textContent).toBe('Parent')
    expect(document.querySelectorAll('[data-identity-trigger]')).toHaveLength(1)
    expect(screen.queryByTitle(/^Switch profile/)).toBeNull()
  })

  it('shows the account name when no profile is bound, never a remembered one', () => {
    render(<TopNav {...props({ activeProfileId: null, navScope: 'unknown' })} />)
    expect(document.querySelector('[data-identity-name]')?.textContent).toBe('owner')
  })

  it('lists the profiles as radio items with what each is, and switches on choosing another', () => {
    const onSelectProfile = vi.fn()
    render(<TopNav {...props({ onSelectProfile })} />)
    openMenu()
    const rows = within(screen.getByRole('menu', { name: 'Switch profile' })).getAllByRole('menuitemradio')
    expect(rows.map(r => r.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    expect(rows[0].textContent).toContain('Default · locked with a PIN')
    expect(rows[1].textContent).toContain('Up to PG')
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Kid/ }))
    expect(onSelectProfile).toHaveBeenCalledWith(2)
    // Choosing closes the menu.
    expect(screen.getByRole('button', { name: 'Account menu for owner' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('does not ask for a switch when the current profile is chosen again', () => {
    const onSelectProfile = vi.fn()
    render(<TopNav {...props({ onSelectProfile })} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Parent/ }))
    expect(onSelectProfile).not.toHaveBeenCalled()
  })

  it('moves between profiles with the arrow keys without choosing one', () => {
    const onSelectProfile = vi.fn()
    render(<TopNav {...props({ onSelectProfile })} />)
    openMenu()
    const list = screen.getByRole('menu', { name: 'Switch profile' })
    const [first, second] = within(list).getAllByRole('menuitemradio')
    first.focus()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(second)
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(list, { key: 'End' })
    expect(document.activeElement).toBe(second)
    expect(onSelectProfile).not.toHaveBeenCalled()
  })

  it('closes on Escape and returns focus to the control', () => {
    render(<TopNav {...props()} />)
    openMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    const trigger = screen.getByRole('button', { name: 'Account menu for owner' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('offers an unrestricted session notifications, profile, requests, settings and sign out', () => {
    const onOpenRequests = vi.fn()
    const onOpenNotificationsPanel = vi.fn()
    const onSignOut = vi.fn()
    render(<TopNav {...props({ adminUI: false, notifCount: 3, onOpenRequests, onOpenNotificationsPanel, onSignOut })} />)
    openMenu()
    expect(menu().getByRole('button', { name: /^Notifications/ }).textContent).toContain('3')
    for (const name of ['Your profile', 'My requests', 'Settings', 'Manage profiles', 'Full picker', 'Sign out of this device']) {
      expect(menu().getByRole('button', { name })).toBeTruthy()
    }
    fireEvent.click(menu().getByRole('button', { name: 'My requests' }))
    expect(onOpenRequests).toHaveBeenCalledTimes(1)
    openMenu()
    fireEvent.click(menu().getByRole('button', { name: /^Notifications/ }))
    expect(onOpenNotificationsPanel).toHaveBeenCalledTimes(1)
    openMenu()
    fireEvent.click(menu().getByRole('button', { name: 'Sign out of this device' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it.each(['restricted', 'unknown'] as const)('offers a %s session no requests, profile page or profile management', (navScope) => {
    render(<TopNav {...props({ adminUI: false, navScope, activeProfileId: navScope === 'restricted' ? 2 : null })} />)
    openMenu()
    for (const name of ['My requests', 'Your profile', 'Manage profiles']) expect(menu().queryByRole('button', { name })).toBeNull()
    // Still there: switching (the server asks for a PIN where one is set),
    // notifications, settings, sign out.
    for (const name of [/^Notifications/, 'Settings', 'Full picker', 'Sign out of this device']) {
      expect(menu().getByRole('button', { name })).toBeTruthy()
    }
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2)
  })

  it('shows a restricted profile its limit on the control', () => {
    render(<TopNav {...props({ adminUI: false, navScope: 'restricted', activeProfileId: 2 })} />)
    const trigger = screen.getByRole('button', { name: 'Account menu for owner' })
    expect(trigger.textContent).toContain('Kid')
    expect(trigger.textContent).toContain('PG')
  })
})

describe('the presence pill', () => {
  it('is absent when nothing is live', () => {
    render(<TopNav {...props()} />)
    expect(document.querySelector('[data-presence]')).toBeNull()
  })

  it('says what is live and reports a click', () => {
    const onPresenceClick = vi.fn()
    render(<TopNav {...props({ presence: { label: '3 watching Night Train', short: '3 watching' }, onPresenceClick })} />)
    const pill = document.querySelector<HTMLElement>('[data-presence]')!
    expect(pill.textContent).toContain('3 watching Night Train')
    fireEvent.click(pill)
    expect(onPresenceClick).toHaveBeenCalledTimes(1)
  })
})

describe('BottomTabBar', () => {
  const bar = (navScope: NavScope, over: Partial<Parameters<typeof BottomTabBar>[0]> = {}) => render(
    <BottomTabBar currentView="home" navScope={navScope} onNavigate={noop} live={false} notifCount={0} activeProfile={PARENT} username="owner" {...over} />,
  )
  const labels = () => within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('button').map(b => b.getAttribute('data-nav'))

  it('gives each session its five (or four) tabs', () => {
    bar('full')
    expect(labels()).toEqual(['home', 'library', 'search', 'together', 'me'])
    cleanup()
    bar('restricted')
    expect(labels()).toEqual(['home', 'movies', 'shows', 'search', 'me'])
    cleanup()
    bar('unknown')
    expect(labels()).toEqual(['home', 'library', 'search', 'me'])
  })

  it('marks the current tab, treating every Library scope as Library', () => {
    bar('full', { currentView: 'calendar' })
    expect(screen.getByRole('navigation', { name: 'Main' }).querySelector('[aria-current="page"]')?.getAttribute('data-nav')).toBe('library')
    cleanup()
    bar('full', { currentView: 'me' })
    expect(screen.getByRole('navigation', { name: 'Main' }).querySelector('[aria-current="page"]')?.getAttribute('data-nav')).toBe('me')
  })

  it('says in words when something is live and when notifications are unread', () => {
    bar('full', { live: true, notifCount: 2 })
    expect(screen.getByRole('button', { name: /Together.*live now/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Me.*2 unread notifications/ })).toBeTruthy()
  })

  it('navigates by tab id', () => {
    const onNavigate = vi.fn()
    bar('full', { onNavigate })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.click(screen.getByRole('button', { name: 'Me' }))
    expect(onNavigate.mock.calls.map(c => c[0])).toEqual(['search', 'me'])
  })
})
