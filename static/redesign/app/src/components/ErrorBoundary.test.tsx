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

describe('ErrorBoundary', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => {
    vi.restoreAllMocks()
    document.head.querySelector('meta[name="aurora-build"]')?.remove()
    localStorage.clear()
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
    expect(saw[2]).toMatch(/^Page: \/ · \d+:\d\d [AP]M · build 1a2b3c4d5e$/)
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
  it('is drawn in the app\'s own colours, with nothing violet', () => {
    render(<ErrorBoundary><Throws message="Cannot read properties of undefined" /></ErrorBoundary>)
    const page = document.querySelector<HTMLElement>('[data-error-screen]')!
    expect(page).toHaveStyle({ background: 'rgb(14, 15, 17)', color: 'rgb(244, 244, 245)' })
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveStyle({ background: 'rgb(255, 255, 255)', color: 'rgb(14, 15, 17)' })
    expect(screen.getByRole('link', { name: 'Go to Tonight' })).toHaveStyle({ background: 'rgb(32, 34, 38)', color: 'rgb(244, 244, 245)' })
    expect(page.outerHTML).not.toMatch(/7c3aed|a855f7|124, 58, 237|168, 85, 247/i)
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
