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
const trigger = () => document.querySelector<HTMLButtonElement>('[data-identity-trigger]')!
const openMenu = () => fireEvent.click(trigger())
const profileRows = () => within(screen.getByRole('group', { name: 'Watching as' })).getAllByRole('button')
const profileRow = (name: RegExp) => within(screen.getByRole('group', { name: 'Watching as' })).getByRole('button', { name })
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
    expect(trigger().getAttribute('title')).toBe('Signed in as owner (admin)')
  })

  it('hides all of them from an admin account whose session acts as a restricted profile', () => {
    render(<TopNav {...props({ adminUI: false, navScope: 'restricted', activeProfileId: 2 })} />)
    openMenu()
    expect(screen.queryAllByRole('button', { name: /^Admin/ })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: /^Server status$/i })).toHaveLength(0)
    // The rest of the menu is still there.
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    // The role is not advertised either.
    expect(trigger().getAttribute('title')).toBe('Signed in as owner')
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
    expect(onNavigate.mock.calls.map(c => c[0])).toEqual(['catalog', 'together', 'home'])
  })
})

describe('the identity control', () => {
  it('is the one control that names who is watching, and there is no second avatar or profile chip', () => {
    render(<TopNav {...props()} />)
    expect(trigger().querySelector('[data-identity-name]')?.textContent).toBe('Parent')
    expect(document.querySelectorAll('[data-identity-trigger]')).toHaveLength(1)
    expect(screen.queryByTitle(/^Switch profile/)).toBeNull()
  })

  // With several profiles on a short window the panel ran off the bottom of
  // the screen, under a bar that does not scroll, and Settings and Sign out
  // could not be reached. jsdom lays nothing out, so this pins the rule that
  // prevents it; the layout itself is checked by rendering (1280x520, six
  // profiles).
  it('opens a panel no taller than the window under the bar, which scrolls', () => {
    render(<TopNav {...props()} />)
    fireEvent.click(trigger())
    const panel = screen.getByRole('group', { name: 'Account and profiles' })
    const classes = panel.className.split(/\s+/)
    const cap = classes.find(c => c.startsWith('max-h-['))
    expect(cap, 'a height limit').toBeTruthy()
    // Relative to the viewport, less the bar.
    expect(cap).toMatch(/100dvh/)
    expect(cap).toMatch(/--chrome-h/)
    expect(classes).toContain('overflow-y-auto')
  })

  it('is named by what it shows, then what it is: the visible profile name leads its accessible name', () => {
    // The visible text is the PROFILE's name, so the accessible name must
    // contain it (label in name): a voice command for what is on screen
    // works, and a screen reader hears who is watching, then what this is.
    render(<TopNav {...props()} />)
    expect(screen.getByRole('button', { name: /^Parent, account menu for owner$/ })).toBe(trigger())
  })

  it('carries a restricted profile\'s limit in the same name, as it is on screen', () => {
    render(<TopNav {...props({ adminUI: false, navScope: 'restricted', activeProfileId: 2 })} />)
    expect(screen.getByRole('button', { name: /^Kid ?PG, account menu for owner$/ })).toBe(trigger())
  })

  it('says how many notifications are unread in its name, since nothing else in the bar does', () => {
    const { rerender } = render(<TopNav {...props({ notifCount: 3 })} />)
    expect(screen.getByRole('button', { name: /^Parent, account menu for owner, 3 unread notifications$/ })).toBe(trigger())
    rerender(<TopNav {...props({ notifCount: 1 })} />)
    expect(trigger().textContent).toContain('1 unread notification')
    expect(trigger().textContent).not.toContain('1 unread notifications')
    rerender(<TopNav {...props({ notifCount: 0 })} />)
    expect(trigger().textContent).not.toMatch(/unread/)
  })

  it('is a disclosure of ordinary buttons: no menu role anywhere, and the control says what it opens', () => {
    render(<TopNav {...props()} />)
    expect(trigger().getAttribute('aria-haspopup')).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    openMenu()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    const panel = screen.getByRole('group', { name: 'Account and profiles' })
    expect(trigger().getAttribute('aria-controls')).toBe(panel.id)
    for (const role of ['menu', 'menuitem', 'menuitemradio', 'menuitemcheckbox']) {
      expect(document.querySelectorAll(`[role="${role}"]`), role).toHaveLength(0)
    }
    // Every row is reachable by Tab: none is taken out of the tab order.
    for (const b of within(panel).getAllByRole('button')) expect(b.tabIndex).toBe(0)
  })

  it('shows the account name when no profile is bound, never a remembered one', () => {
    render(<TopNav {...props({ activeProfileId: null, navScope: 'unknown' })} />)
    expect(document.querySelector('[data-identity-name]')?.textContent).toBe('owner')
  })

  it('lists the profiles with what each is, marks the current one, and switches on choosing another', () => {
    const onSelectProfile = vi.fn()
    render(<TopNav {...props({ onSelectProfile })} />)
    openMenu()
    const rows = profileRows()
    expect(rows.map(r => r.getAttribute('aria-current'))).toEqual(['true', null])
    // The whole line of each, so a doubled or missing fact is seen, and
    // the limit first: it is what a narrow row must not cut.
    const summary = (row: HTMLElement) => row.querySelector('[data-profile-summary]')?.textContent
    expect(rows.map(summary)).toEqual(['No limit · default · locked with a PIN', 'Up to PG'])
    expect(rows[0].textContent).toContain('watching now')
    // The line is not cut off: it wraps, in a row that grows with it.
    expect(rows[0].querySelector('[data-profile-summary]')).not.toHaveClass('truncate')
    expect(rows[0].className).not.toMatch(/(^|\s)h-\[/)
    fireEvent.click(profileRow(/Kid/))
    expect(onSelectProfile).toHaveBeenCalledWith(2)
    // Choosing closes the menu.
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('does not ask for a switch when the current profile is chosen again', () => {
    const onSelectProfile = vi.fn()
    render(<TopNav {...props({ onSelectProfile })} />)
    openMenu()
    fireEvent.click(profileRow(/Parent/))
    expect(onSelectProfile).not.toHaveBeenCalled()
  })

  it('closes on Escape and returns focus to the control', () => {
    render(<TopNav {...props()} />)
    openMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger())
  })

  it('offers an unrestricted session notifications, profile, requests, settings and sign out', () => {
    const onOpenRequests = vi.fn()
    const onOpenNotificationsPanel = vi.fn()
    const onSignOut = vi.fn()
    render(<TopNav {...props({ adminUI: false, notifCount: 3, onOpenRequests, onOpenNotificationsPanel, onSignOut })} />)
    openMenu()
    expect(menu().getByRole('button', { name: /^Notifications/ }).textContent).toContain('3')
    for (const name of ['Your profile', 'My requests', 'Settings', 'Manage profiles', 'Full picker', /^Sign out/]) {
      expect(menu().getByRole('button', { name })).toBeTruthy()
    }
    fireEvent.click(menu().getByRole('button', { name: 'My requests' }))
    expect(onOpenRequests).toHaveBeenCalledTimes(1)
    openMenu()
    fireEvent.click(menu().getByRole('button', { name: /^Notifications/ }))
    expect(onOpenNotificationsPanel).toHaveBeenCalledTimes(1)
    openMenu()
    fireEvent.click(menu().getByRole('button', { name: /^Sign out/ }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it('never calls sign-out a per-device action: it ends every session on the account', () => {
    render(<TopNav {...props()} />)
    openMenu()
    const row = menu().getByRole('button', { name: /^Sign out/ })
    expect(row.textContent).toContain('Signs out every device on this account')
    expect(row.textContent).not.toMatch(/this device/i)
  })

  it.each(['restricted', 'unknown'] as const)('offers a %s session no requests, profile page or profile management', (navScope) => {
    render(<TopNav {...props({ adminUI: false, navScope, activeProfileId: navScope === 'restricted' ? 2 : null })} />)
    openMenu()
    for (const name of ['My requests', 'Your profile', 'Manage profiles']) expect(menu().queryByRole('button', { name })).toBeNull()
    // Still there: switching (the server asks for a PIN where one is set),
    // notifications, settings, sign out.
    for (const name of [/^Notifications/, 'Settings', 'Full picker', /^Sign out/]) {
      expect(menu().getByRole('button', { name })).toBeTruthy()
    }
    expect(profileRows()).toHaveLength(2)
  })

  it('calls the requests entry "Requests" for a session that is listed everyone\'s', () => {
    render(<TopNav {...props({ requestsLabel: 'Requests' })} />)
    openMenu()
    expect(menu().getByRole('button', { name: 'Requests' })).toBeTruthy()
    expect(menu().queryByRole('button', { name: 'My requests' })).toBeNull()
  })

  it('shows a restricted profile its limit on the control', () => {
    render(<TopNav {...props({ adminUI: false, navScope: 'restricted', activeProfileId: 2 })} />)
    expect(trigger().textContent).toContain('Kid')
    expect(trigger().textContent).toContain('PG')
  })
})

describe('the search field', () => {
  const field = () => screen.getByRole('textbox', { name: 'Search titles' })

  it('reports typing as it happens, and Enter as a separate ask', () => {
    const onChange = vi.fn(), onSubmit = vi.fn()
    render(<TopNav {...props({ searchQuery: 'cozy mystery', onSearchQueryChange: onChange, onSearchSubmit: onSubmit })} />)
    fireEvent.change(field(), { target: { value: 'cozy mysteries' } })
    expect(onChange).toHaveBeenCalledWith('cozy mysteries')
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    // No other key asks.
    fireEvent.keyDown(field(), { key: 'a' })
    fireEvent.keyDown(field(), { key: 'Tab' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('does not ask for nothing, or while an input method is still composing', () => {
    const onSubmit = vi.fn()
    const { rerender } = render(<TopNav {...props({ searchQuery: '   ', onSearchSubmit: onSubmit })} />)
    fireEvent.keyDown(field(), { key: 'Enter' })
    rerender(<TopNav {...props({ searchQuery: 'こ', onSearchSubmit: onSubmit })} />)
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('says a description is welcome, and tells the phone keyboard its key searches', () => {
    render(<TopNav {...props()} />)
    expect(field()).toHaveAttribute('placeholder', 'Search, or describe a mood')
    expect(field()).toHaveAttribute('enterkeyhint', 'search')
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

  // Below xl the pill draws "3 watching" alone. What is on stays in its
  // name: the short text as drawn, then the rest for assistive tech, and at
  // xl the whole label is drawn instead.
  it('keeps what is on in the pill\'s name where only the count is drawn', () => {
    render(<TopNav {...props({ presence: { label: '3 watching Night Train', short: '3 watching' } })} />)
    const pill = document.querySelector<HTMLElement>('[data-presence]')!
    const [short, rest, whole] = [...pill.querySelectorAll('span:not([aria-hidden])')]
    expect([short.textContent, short.className]).toEqual(['3 watching', 'truncate xl:hidden'])
    expect([rest.textContent, rest.className]).toEqual([' Night Train', 'sr-only xl:hidden'])
    expect([whole.textContent, whole.className]).toEqual(['3 watching Night Train', 'hidden truncate xl:inline'])
    expect(pill).not.toHaveAttribute('aria-label')
    // No tooltip either: it would repeat the name, word for word.
    expect(pill).not.toHaveAttribute('title')
  })

  it('adds nothing where the short text is not the start of the label, or is all of it', () => {
    const { unmount } = render(<TopNav {...props({ presence: { label: 'In a watch party', short: 'In a party', expanded: false } })} />)
    expect(document.querySelector('[data-presence-rest]')).toBeNull()
    unmount()
    render(<TopNav {...props({ presence: { label: '3 watching', short: '3 watching' } })} />)
    expect(document.querySelector('[data-presence-rest]')).toBeNull()
  })
})

describe('BottomTabBar', () => {
  const bar = (navScope: NavScope, over: Partial<Parameters<typeof BottomTabBar>[0]> = {}) => render(
    <BottomTabBar currentView="home" navScope={navScope} onNavigate={noop} live={false} notifCount={0} activeProfile={PARENT} username="owner" {...over} />,
  )
  const labels = () => within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('button').map(b => b.getAttribute('data-nav'))

  it('gives each session its five (or four) tabs', () => {
    bar('full')
    expect(labels()).toEqual(['home', 'catalog', 'search', 'together', 'me'])
    cleanup()
    bar('restricted')
    expect(labels()).toEqual(['home', 'movies', 'shows', 'search', 'me'])
    cleanup()
    bar('unknown')
    expect(labels()).toEqual(['home', 'catalog', 'search', 'me'])
  })

  it('marks the current tab, treating every Library scope as Library', () => {
    bar('full', { currentView: 'calendar' })
    expect(screen.getByRole('navigation', { name: 'Main' }).querySelector('[aria-current="page"]')?.getAttribute('data-nav')).toBe('catalog')
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

// "Report a bug" is one of the panel's rows, for whoever is watching: App
// hands the panel its press only while the server takes reports.
describe('the identity panel\'s "Report a bug"', () => {
  // The panel's rows below the profiles and their two buttons.
  const rows = () => menu().getAllByRole('button').filter(b => !b.closest('[data-profiles]')).map(b => b.textContent).filter(t => t !== 'Full picker' && t !== 'Manage profiles')

  it('is offered when reports are taken, with Settings and above Sign out', () => {
    render(<TopNav {...props({ onReportBug: noop })} />)
    openMenu()
    expect(rows()).toEqual(['Notifications', 'Your profile', 'My requests', 'Settings', 'Report a bug', 'Admin', 'Server status', 'Sign outSigns out every device on this account'])
  })

  it('is not offered when they are not', () => {
    render(<TopNav {...props()} />)
    openMenu()
    expect(menu().queryByRole('button', { name: 'Report a bug' })).toBeNull()
  })

  it('is offered to a profile with a content limit', () => {
    render(<TopNav {...props({ adminUI: false, navScope: 'restricted', activeProfileId: 2, onReportBug: noop })} />)
    openMenu()
    expect(rows()).toEqual(['Notifications', 'Settings', 'Report a bug', 'Sign outSigns out every device on this account'])
  })

  // The dialog gives the focus back to what had it as it opened. The panel
  // closes on the press, so that must be the panel's own control, not a row
  // that is about to leave the page.
  it('closes the panel and puts the focus on its control before it asks for the dialog', () => {
    let focusAtAsk: Element | null = null
    const onReportBug = vi.fn(() => { focusAtAsk = document.activeElement })
    render(<TopNav {...props({ onReportBug })} />)
    openMenu()
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(menu().getByRole('button', { name: 'Report a bug' }))
    expect(onReportBug).toHaveBeenCalledTimes(1)
    expect(focusAtAsk).toBe(trigger())
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
  })
})
