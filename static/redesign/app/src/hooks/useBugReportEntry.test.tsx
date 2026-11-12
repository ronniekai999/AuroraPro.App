// @vitest-environment jsdom
//
// Where "Report a bug" opens its dialog: over the page on screen from the
// identity panel, and from the Me page over the page the person came from.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { RETURN_GIVE_UP_MS, SKELETON_WAIT_MS, useBugReportEntry, type BugReportEntryInput } from './useBugReportEntry'
import { focusPageStart } from '@/lib/returnFocus'

type Where = BugReportEntryInput['location']
const viewOf = (pathname: string) => (pathname === '/' ? 'home' : pathname.split('/')[1])

/** The hook under an app that is told where it is. `go` is a navigation:
 *  the address and the page drawn change together unless `shownView` says
 *  the page has not followed yet. */
function mount(start: string, over: Partial<BugReportEntryInput> = {}) {
  let n = 0
  const at = (pathname: string, search = ''): Where => ({ pathname, search, key: `k${++n}` })
  const goTo = vi.fn<(path: string) => void>()
  const goBack = vi.fn<() => void>()
  const onAsk = vi.fn()
  let props: BugReportEntryInput = {
    enabled: true, userId: 1, profileId: 10, location: at(start), arrivedBy: 'POP', viewOf, shownView: viewOf(start),
    mayShow: () => true, goTo, goBack, onAsk, ...over,
  }
  const hook = renderHook((p: BugReportEntryInput) => useBugReportEntry(p), { initialProps: props })
  const set = (next: Partial<BugReportEntryInput>) => { props = { ...props, ...next }; hook.rerender(props) }
  return {
    hook, goTo, goBack, onAsk, set,
    /** A step forward to an address, as a link or a tab does. */
    go(pathname: string, search = '', arrivedBy = 'PUSH') {
      const location = at(pathname, search)
      set({ location, arrivedBy, shownView: viewOf(pathname) })
      return location
    },
    /** Back or forward onto an entry already in history. */
    pop(location: Where) { set({ location, arrivedBy: 'POP', shownView: viewOf(location.pathname) }) },
    open: () => hook.result.current.open,
  }
}

afterEach(() => { cleanup(); vi.useRealTimers(); document.body.innerHTML = '' })

describe('"Report a bug" from the identity panel', () => {
  it('opens the dialog over the page on screen and goes nowhere', () => {
    const app = mount('/movies')
    expect(app.open()).toBe(false)
    act(() => app.hook.result.current.openHere())
    expect(app.open()).toBe(true)
    expect(app.onAsk).toHaveBeenCalledTimes(1)
    expect(app.goTo).not.toHaveBeenCalled()
    expect(app.goBack).not.toHaveBeenCalled()
    act(() => app.hook.result.current.close())
    expect(app.open()).toBe(false)
  })
})

describe('"Report a bug" from the Me page', () => {
  it('opens over Me when the tab has shown no other page', () => {
    const app = mount('/me')
    act(() => app.hook.result.current.openFromMe())
    expect(app.open()).toBe(true)
    expect(app.onAsk).toHaveBeenCalledTimes(1)
    expect(app.goTo).not.toHaveBeenCalled()
    expect(app.goBack).not.toHaveBeenCalled()
  })

  // One step back is that page as the person left it, scrolled to where
  // they were: the app keeps the scroll of each history entry.
  it('steps back to the page the person came from, and opens once that page is the one drawn', async () => {
    const app = mount('/movies', { location: { pathname: '/movies', search: '?sort=title', key: 'movies' } })
    const movies = { pathname: '/movies', search: '?sort=title', key: 'movies' }
    app.go('/me')
    act(() => app.hook.result.current.openFromMe())
    expect(app.goBack).toHaveBeenCalledTimes(1)
    expect(app.goTo).not.toHaveBeenCalled()
    expect(app.onAsk).toHaveBeenCalledTimes(1)
    // Still on Me: nothing opens over it.
    expect(app.open()).toBe(false)
    // The address is the page's a render before the page is drawn.
    app.set({ location: movies, arrivedBy: 'POP', shownView: 'me' })
    await new Promise(r => setTimeout(r, 80))
    expect(app.open()).toBe(false)
    app.set({ shownView: 'movies' })
    await waitFor(() => expect(app.open()).toBe(true))
  })

  it('goes back once for two presses in the same moment', () => {
    const app = mount('/movies')
    app.go('/me')
    act(() => { app.hook.result.current.openFromMe(); app.hook.result.current.openFromMe() })
    expect(app.goBack).toHaveBeenCalledTimes(1)
    expect(app.onAsk).toHaveBeenCalledTimes(1)
  })

  // Settings is reached through Me on a phone; a report asked for on Me
  // after a look at Settings is still about the page before both.
  it('goes to the address, query and all, when one step back is not that page; Settings opened from Me is not that page', async () => {
    const app = mount('/movies', { location: { pathname: '/movies', search: '?sort=title', key: 'movies' } })
    app.go('/me')
    app.go('/settings/profiles')
    app.go('/settings/account')
    app.go('/me')
    act(() => app.hook.result.current.openFromMe())
    expect(app.goBack).not.toHaveBeenCalled()
    expect(app.goTo).toHaveBeenCalledTimes(1)
    expect(app.goTo).toHaveBeenCalledWith('/movies?sort=title')
    app.go('/movies', '?sort=title')
    await waitFor(() => expect(app.open()).toBe(true))
  })

  it('goes back to the whole address, a fragment included', () => {
    const app = mount('/movies')
    app.set({ location: { pathname: '/title/107', search: '?from=search', hash: '#episodes', key: 'title' }, arrivedBy: 'PUSH', shownView: 'title' })
    app.go('/me')
    app.go('/settings/account')
    app.go('/me')
    act(() => app.hook.result.current.openFromMe())
    expect(app.goTo).toHaveBeenCalledWith('/title/107?from=search#episodes')
  })

  it('counts Settings as a page of its own when it was not opened from Me', () => {
    const app = mount('/movies')
    app.go('/settings/playback')
    app.go('/me')
    act(() => app.hook.result.current.openFromMe())
    // One step back from Me is that Settings page.
    expect(app.goBack).toHaveBeenCalledTimes(1)
    expect(app.goTo).not.toHaveBeenCalled()
  })

  // Me was reached by a step forward from Movies; the person then went on
  // to Shows and came Back onto that Me entry. The last page shown is
  // Shows, and one step back from Me is Movies.
  it('does not step back when the entry behind Me is no longer the last page shown', () => {
    const app = mount('/movies')
    const me = app.go('/me')
    app.go('/shows')
    app.pop(me)
    act(() => app.hook.result.current.openFromMe())
    expect(app.goBack).not.toHaveBeenCalled()
    expect(app.goTo).toHaveBeenCalledWith('/shows')
  })

  // The tab opened on Me; the person went to Movies, on to Me again, and
  // then Back twice, onto the first Me entry. One step back from the second
  // Me entry was Movies; one step back from this one is out of the app.
  it('does not step back from a Me entry other than the one it came to from the page', () => {
    const app = mount('/me')
    // The entry the tab opened on (the harness numbers its entries from k1).
    const first = { pathname: '/me', search: '', key: 'k1' }
    const movies = app.go('/movies')
    app.go('/me')
    app.pop(movies)
    app.pop(first)
    act(() => app.hook.result.current.openFromMe())
    expect(app.goBack).not.toHaveBeenCalled()
    expect(app.goTo).toHaveBeenCalledWith('/movies')
  })

  // A replacement takes the page's place in history: one step back from
  // it is whatever came before that page, not the page.
  it('does not step back from a Me entry that took the page\'s place in history', () => {
    const app = mount('/shows')
    app.go('/movies')
    app.go('/me', '', 'REPLACE')
    act(() => app.hook.result.current.openFromMe())
    expect(app.goBack).not.toHaveBeenCalled()
    expect(app.goTo).toHaveBeenCalledWith('/movies')
  })

  it('opens where the person is when going back comes to nothing', () => {
    vi.useFakeTimers()
    const app = mount('/movies')
    app.go('/me')
    act(() => app.hook.result.current.openFromMe())
    expect(app.goBack).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(RETURN_GIVE_UP_MS - 50) })
    expect(app.open()).toBe(false)
    act(() => { vi.advanceTimersByTime(100) })
    expect(app.open()).toBe(true)
  })

  it('waits for a page that is still drawn as loading shapes, and not for ever', () => {
    vi.useFakeTimers()
    const main = document.createElement('main')
    main.innerHTML = '<div class="stage-skel"></div>'
    document.body.appendChild(main)
    const app = mount('/movies')
    app.go('/me')
    act(() => app.hook.result.current.openFromMe())
    app.go('/movies', '', 'POP')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(app.open()).toBe(false)
    // The page arrives: the dialog opens over it.
    main.innerHTML = '<h1>Movies</h1>'
    act(() => { vi.advanceTimersByTime(50) })
    expect(app.open()).toBe(true)

    // And a page that never finishes loading does not keep the dialog back.
    act(() => app.hook.result.current.close())
    main.innerHTML = '<div class="stage-skel"></div>'
    app.go('/me')
    act(() => app.hook.result.current.openFromMe())
    app.go('/movies', '', 'POP')
    act(() => { vi.advanceTimersByTime(SKELETON_WAIT_MS - 200) })
    expect(app.open()).toBe(false)
    act(() => { vi.advanceTimersByTime(400) })
    expect(app.open()).toBe(true)
  })

  it('sends the session nowhere its routes would not show it now', () => {
    const mayShow = vi.fn((pathname: string) => pathname !== '/together')
    const app = mount('/together', { mayShow })
    app.go('/me')
    act(() => app.hook.result.current.openFromMe())
    expect(mayShow).toHaveBeenCalledWith('/together')
    expect(app.goBack).not.toHaveBeenCalled()
    expect(app.goTo).not.toHaveBeenCalled()
    // Over Me, then.
    expect(app.open()).toBe(true)
  })
})

describe('the page a report goes back to is one session\'s', () => {
  it('is not used after the session changes profile', () => {
    const app = mount('/movies')
    app.go('/me')
    app.set({ profileId: 20 })
    act(() => app.hook.result.current.openFromMe())
    expect(app.goBack).not.toHaveBeenCalled()
    expect(app.goTo).not.toHaveBeenCalled()
    expect(app.open()).toBe(true)
  })

  it('is the new profile\'s own from the pages it is shown', () => {
    const app = mount('/movies')
    app.set({ profileId: 20 })
    app.go('/shows')
    app.go('/me')
    act(() => app.hook.result.current.openFromMe())
    expect(app.goBack).toHaveBeenCalledTimes(1)
  })

  it('is not gone back to when the profile changes on the way there', () => {
    vi.useFakeTimers()
    const app = mount('/movies')
    app.go('/me')
    act(() => app.hook.result.current.openFromMe())
    app.set({ profileId: 20 })
    app.go('/movies', '', 'POP')
    act(() => { vi.advanceTimersByTime(RETURN_GIVE_UP_MS + SKELETON_WAIT_MS) })
    expect(app.open()).toBe(false)
  })

  // The app stays mounted through a sign-out, so an open dialog must not be
  // there for the next person to sign in.
  it('closes with the session, and is closed for the next person to sign in', () => {
    const app = mount('/movies')
    act(() => app.hook.result.current.openHere())
    expect(app.open()).toBe(true)
    app.set({ userId: null, profileId: null })
    expect(app.open()).toBe(false)
    app.set({ userId: 2, profileId: 30 })
    expect(app.open()).toBe(false)
  })

  it('is not handed to the next person to sign in on the tab', () => {
    const app = mount('/movies')
    app.go('/me')
    app.set({ userId: null, profileId: null })
    app.set({ userId: 2, profileId: 30 })
    act(() => app.hook.result.current.openFromMe())
    expect(app.goBack).not.toHaveBeenCalled()
    expect(app.goTo).not.toHaveBeenCalled()
    expect(app.open()).toBe(true)
  })

  // A parent's capture of a page, left open, could be sent from a child's
  // session after a switch made in another tab. The dialog is told to
  // close; it does so itself once nothing of its own is in flight (the
  // dialog's own tests), and until it has it is still mounted.
  it('dismisses an open dialog when the session changes profile, and is closed once the dialog says so', () => {
    const app = mount('/movies')
    expect(app.hook.result.current.dismissed).toBe(false)
    act(() => app.hook.result.current.openHere())
    expect(app.hook.result.current.dismissed).toBe(false)
    app.set({ profileId: 20 })
    expect(app.hook.result.current.dismissed).toBe(true)
    expect(app.open()).toBe(true)
    act(() => app.hook.result.current.close())
    expect(app.open()).toBe(false)
    expect(app.hook.result.current.dismissed).toBe(false)
    // The next one opened is an ordinary one.
    act(() => app.hook.result.current.openHere())
    expect(app.hook.result.current.dismissed).toBe(false)
  })

  it('dismisses nothing when no dialog was open at the switch', () => {
    const app = mount('/movies')
    app.set({ profileId: 20 })
    expect(app.hook.result.current.dismissed).toBe(false)
    expect(app.open()).toBe(false)
  })

  // The config is asked for again at every change of the session's admin
  // powers; an "open" left standing would bring the dialog back unasked.
  it('closes when the server stops taking reports, and stays closed when it takes them again', () => {
    const app = mount('/movies')
    act(() => app.hook.result.current.openHere())
    app.set({ enabled: false })
    expect(app.open()).toBe(false)
    app.set({ enabled: true })
    expect(app.open()).toBe(false)
  })

  it('drops a return that is on its way when the server stops taking reports', () => {
    vi.useFakeTimers()
    const app = mount('/movies')
    app.go('/me')
    act(() => app.hook.result.current.openFromMe())
    app.set({ enabled: false })
    app.set({ enabled: true })
    app.go('/movies', '', 'POP')
    act(() => { vi.advanceTimersByTime(RETURN_GIVE_UP_MS + SKELETON_WAIT_MS) })
    expect(app.open()).toBe(false)
  })
})

describe('where the focus goes when the dialog closes over a page that did not open it', () => {
  it('goes to the page\'s main heading, without scrolling the page', () => {
    document.body.innerHTML = '<main><a href="/">Aurora</a><h1>Movies</h1><button>Sort</button></main>'
    const heading = document.querySelector('h1')!
    const focus = vi.spyOn(heading, 'focus')
    focusPageStart()
    expect(heading).toHaveFocus()
    expect(heading).toHaveAttribute('tabindex', '-1')
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('goes to the first control when the page has no heading that takes it', () => {
    document.body.innerHTML = '<main><span>nothing</span><button disabled>Off</button><button>Sort</button></main>'
    focusPageStart()
    expect(document.activeElement?.textContent).toBe('Sort')
    document.body.innerHTML = '<main><h1 hidden>Movies</h1><a href="/x">First</a></main>'
    // jsdom focuses a hidden element; a browser does not. Stand in for it.
    vi.spyOn(document.querySelector('h1')!, 'focus').mockImplementation(() => {})
    focusPageStart()
    expect(document.activeElement?.textContent).toBe('First')
  })
})
