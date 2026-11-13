// @vitest-environment jsdom
//
// The boundary around the app, and the screen it shows in the app's place.
// Each test starts where the app really is when the screen appears: a
// component has thrown while it was being drawn, or a lazy view's chunk did
// not load. What the screen offers for reporting the problem has its own
// file (ErrorScreen.test.tsx).

import { Suspense, lazy, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'
import { STALE_BUNDLE_EVENT } from '@/lib/buildUpdate'
import { thisPage } from '@/lib/errorReport'

function Throws({ message }: { message: string }): never {
  throw new TypeError(message)
}
/** This browser as the app leaves it with someone signed in. */
function signedIn() {
  localStorage.setItem('aurora_user', JSON.stringify({ id: 1, username: 'morgan', email: 'morgan@example.test', role: 'user' }))
  localStorage.setItem('aurora_active_profile_id', '1')
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Nothing is asked of a server in these tests: the screen asks only
    // for a session, and these that sign in get no answer.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
    // Where the app is: under its base path.
    window.history.pushState({}, '', `${import.meta.env.BASE_URL}movies`)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.head.querySelector('meta[name="aurora-build"]')?.remove()
    localStorage.clear()
    window.history.pushState({}, '', '/')
  })

  it('draws the app when nothing has thrown', () => {
    render(<ErrorBoundary><p>the app</p></ErrorBoundary>)
    expect(screen.getByText('the app')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'That did not load.' })).toBeNull()
  })

  it('shows the error screen in place of a tree that threw while it was drawn, with the focus on its heading', async () => {
    const meta = document.createElement('meta')
    meta.name = 'aurora-build'
    meta.content = '1a2b3c4d5e'
    document.head.appendChild(meta)
    signedIn()
    render(<ErrorBoundary><p>the app</p><Throws message="Cannot read properties of undefined (reading 'map')" /></ErrorBoundary>)
    expect(screen.queryByText('the app')).toBeNull()
    const heading = screen.getByRole('heading', { level: 1, name: 'That did not load.' })
    await waitFor(() => expect(heading).toHaveFocus())
    // What it says of the person's library and of what they were watching
    // is what the app does, not a promise about this moment.
    expect(screen.getByText('This page hit a problem and stopped. That changed nothing in your library. If something was playing, the app saves your place every ten seconds as you watch.')).toBeInTheDocument()
    // What the app saw: the kind of failure, the error's own message, the
    // page, the time and the build.
    const saw = document.querySelector('[data-app-saw]')!.textContent!.split('\n')
    expect(saw[0]).toBe('The page stopped while it was being drawn.')
    expect(saw[1]).toBe("Cannot read properties of undefined (reading 'map')")
    expect(saw[2].startsWith(`Page: ${import.meta.env.BASE_URL}movies · `)).toBe(true)
    expect(saw[2]).toMatch(/ · \S.*\d\d.* · build 1a2b3c4d5e$/)
    expect(saw).toHaveLength(3)
    expect(screen.getByText('If a new version was installed while this tab was open, a reload usually fixes it.')).toBeInTheDocument()
    // Two ways out, and no "try again": the same tree from the same state
    // stops at the same place.
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to Tonight' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
  })

  it('reloads the page it is on, and nothing reloads or leaves by itself', () => {
    const reload = vi.spyOn(thisPage, 'reload').mockImplementation(() => {})
    render(<ErrorBoundary><Throws message="boom" /></ErrorBoundary>)
    expect(reload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  // The app's own state may be what broke. "Go to Tonight" is a link the
  // browser follows: a page load, not a call into the tree that stopped.
  it('goes to Tonight by a real navigation', () => {
    signedIn()
    render(<ErrorBoundary><Throws message="boom" /></ErrorBoundary>)
    for (const link of [screen.getByRole('link', { name: 'Go to Tonight' }), screen.getByRole('link', { name: 'AuroraPro, go to Tonight' })]) {
      expect(link.tagName).toBe('A')
      expect(link).toHaveAttribute('href', import.meta.env.BASE_URL)
      expect(link).not.toHaveAttribute('target')
      const click = createEvent.click(link)
      fireEvent(link, click)
      expect(click.defaultPrevented).toBe(false)
    }
  })

  // With nobody signed in the same address is the sign-in page, and the
  // link says so.
  it('says the way out leads to sign-in when nobody is signed in', () => {
    render(<ErrorBoundary><Throws message="boom" /></ErrorBoundary>)
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', import.meta.env.BASE_URL)
    expect(screen.getByRole('link', { name: 'AuroraPro, go to sign in' })).toHaveAttribute('href', import.meta.env.BASE_URL)
    expect(screen.queryByRole('link', { name: 'Go to Tonight' })).toBeNull()
  })

  // A lazy view whose chunk the last deploy deleted. Retrying cannot work:
  // the browser keeps the failed import.
  it('offers a reload for a chunk that will not load, and asks for an update check', async () => {
    const heard = vi.fn()
    window.addEventListener(STALE_BUNDLE_EVENT, heard)
    const Gone = lazy(() => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${window.location.origin}/v2/assets/AdminView-x.js`)))
    render(<ErrorBoundary><Suspense fallback={<p>loading the view</p>}><Gone /></Suspense></ErrorBoundary>)
    const heading = await screen.findByRole('heading', { level: 1, name: 'That did not load.' })
    window.removeEventListener(STALE_BUNDLE_EVENT, heard)
    expect(heading).toBeInTheDocument()
    // Not a claim of a deploy: going offline fails the same import.
    const saw = document.querySelector('[data-app-saw]')!.textContent!
    expect(saw).toContain('the app was updated while this tab was open, or the connection dropped')
    // The server's own address is not shown.
    expect(saw).toContain('Failed to fetch dynamically imported module: /v2/assets/AdminView-x.js')
    expect(window.location.origin).toMatch(/^http/)
    expect(saw).not.toContain(window.location.origin)
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('asks for no update check for any other error', () => {
    const heard = vi.fn()
    window.addEventListener(STALE_BUNDLE_EVENT, heard)
    render(<ErrorBoundary><Throws message="Cannot read properties of undefined" /></ErrorBoundary>)
    window.removeEventListener(STALE_BUNDLE_EVENT, heard)
    expect(heard).not.toHaveBeenCalled()
  })

  // It is drawn with inline values (the stylesheet may be what failed), and
  // they are the app's: its page colour, a white primary action, a quiet
  // second one. It used to be a violet button on a blue-black of its own.
  // The logo's mark is the one place its gradient is drawn.
  it('is drawn in the app\'s own colours, with nothing violet but the logo\'s mark', () => {
    signedIn()
    render(<ErrorBoundary><Throws message="Cannot read properties of undefined" /></ErrorBoundary>)
    const page = document.querySelector<HTMLElement>('[data-error-screen]')!
    expect(page).toHaveStyle({ background: 'rgb(14, 15, 17)', color: 'rgb(244, 244, 245)' })
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveStyle({ background: 'rgb(255, 255, 255)', color: 'rgb(14, 15, 17)' })
    expect(screen.getByRole('link', { name: 'Go to Tonight' })).toHaveStyle({ background: 'rgb(32, 34, 38)', color: 'rgb(244, 244, 245)' })
    // The mark is in the header's link, beside the name, out of the
    // accessibility tree (the link's label names it).
    const mark = page.querySelector('header a [data-error-mark] svg')!
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(mark.outerHTML).toMatch(/a855f7/i)
    const rest = page.cloneNode(true) as HTMLElement
    rest.querySelector('[data-error-mark]')!.remove()
    expect(rest.outerHTML).not.toMatch(/7c3aed|a855f7|124, 58, 237|168, 85, 247/i)
  })

  // Anything can be thrown. The tree that threw is not drawn again because
  // what it threw was falsy, and the screen says what it can.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['an empty string', ''],
  ])('shows the screen for %s thrown', (_what, thrown) => {
    function ThrowsValue(): never { throw thrown }
    render(<ErrorBoundary><p>the app</p><ThrowsValue /></ErrorBoundary>)
    expect(screen.queryByText('the app')).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'That did not load.' })).toBeInTheDocument()
    expect(document.querySelector('[data-app-saw]')!.textContent!.split('\n')).toHaveLength(2)
  })

  it('shows the screen for an error whose message is not text, or cannot be read', () => {
    const odd = new Error('x')
    Object.defineProperty(odd, 'message', { value: { not: 'text' } })
    function ThrowsOdd(): never { throw odd }
    const view = render(<ErrorBoundary><ThrowsOdd /></ErrorBoundary>)
    expect(screen.getByRole('heading', { level: 1, name: 'That did not load.' })).toBeInTheDocument()
    expect(document.querySelector('[data-app-saw]')!.textContent).toMatch(/^The page stopped while it was being drawn\.\nPage: /)
    view.unmount()
    const getter = new Error('x')
    Object.defineProperty(getter, 'message', { get() { throw new Error('unreadable') } })
    function ThrowsGetter(): never { throw getter }
    render(<ErrorBoundary><ThrowsGetter /></ErrorBoundary>)
    expect(screen.getByRole('heading', { level: 1, name: 'That did not load.' })).toBeInTheDocument()
  })

  // The app runs for a while before something goes wrong: a tree that was
  // drawn throws on an update.
  it('shows the screen for a tree that throws on an update', () => {
    function Breaks() {
      const [broken, setBroken] = useState(false)
      if (broken) throw new Error('The list changed under the page')
      return <button type="button" onClick={() => setBroken(true)}>Break it</button>
    }
    render(<ErrorBoundary><Breaks /></ErrorBoundary>)
    fireEvent.click(screen.getByRole('button', { name: 'Break it' }))
    expect(screen.getByRole('heading', { level: 1, name: 'That did not load.' })).toBeInTheDocument()
    expect(document.querySelector('[data-app-saw]')!.textContent!.split('\n')[1]).toBe('The list changed under the page')
  })

  // The phone companion is its own small app under the same boundary: its
  // way back is its own first screen, not the full app's.
  it('sends a companion page back to the join screen', () => {
    window.history.pushState({}, '', `${import.meta.env.BASE_URL}join/FRD4YC`)
    try {
      render(<ErrorBoundary><Throws message="boom" /></ErrorBoundary>)
      const link = screen.getByRole('link', { name: 'Go to the join screen' })
      expect(link).toHaveAttribute('href', `${import.meta.env.BASE_URL}join`)
      expect(screen.queryByRole('link', { name: 'Go to Tonight' })).toBeNull()
      expect(screen.queryByRole('link', { name: 'Go to sign in' })).toBeNull()
    } finally {
      window.history.pushState({}, '', '/')
    }
  })

  it('hands a caller\'s own fallback the error and a way to draw the tree again', () => {
    function Flaky() {
      const [bad] = useState(() => Flaky.fail)
      if (bad) throw new Error('first time')
      return <p>second time</p>
    }
    Flaky.fail = true
    render(
      <ErrorBoundary fallback={(error, retry) => <button type="button" onClick={() => { Flaky.fail = false; retry() }}>{error.message}</button>}>
        <Flaky />
      </ErrorBoundary>,
    )
    expect(screen.queryByRole('heading', { name: 'That did not load.' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'first time' }))
    expect(screen.getByText('second time')).toBeInTheDocument()
  })
})
