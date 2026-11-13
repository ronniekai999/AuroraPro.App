// @vitest-environment jsdom
//
// The "new version" notice: said when the server serves a newer build than
// this tab runs. It stays until dismissed, and reloads only when asked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const build = vi.hoisted(() => ({ available: false, dismiss: vi.fn() }))
vi.mock('@/lib/buildUpdate', () => ({ useNewBuildAvailable: () => build }))

import { UpdateAvailableNotice } from './UpdateAvailableNotice'

const space = () => document.documentElement.style.getPropertyValue('--update-notice-space')
/** The page's reload, to see whether it was asked for. */
const reload = vi.fn()
/** The size observers the notice made, to say its height changed. */
const observers: { changed: () => void; watching: Element[]; off: boolean }[] = []
beforeEach(() => {
  vi.stubGlobal('location', { ...window.location, reload })
  vi.stubGlobal('ResizeObserver', class {
    me = { changed: () => {}, watching: [] as Element[], off: false }
    constructor(changed: () => void) { this.me.changed = changed; observers.push(this.me) }
    observe(el: Element) { this.me.watching.push(el) }
    unobserve() {}
    disconnect() { this.me.off = true }
  })
})
afterEach(() => { cleanup(); build.available = false; vi.clearAllMocks(); vi.unstubAllGlobals(); observers.length = 0 })
/** jsdom lays nothing out: the notice is given a height to report. */
const drawnAt = (px: number) => vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
  return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: this.classList.contains('update-notice') ? px : 0, toJSON: () => ({}) } as DOMRect
})

describe('the update notice', () => {
  it('draws nothing while this tab runs the build being served, and keeps an empty status for when it does not', () => {
    render(<UpdateAvailableNotice />)
    expect(document.querySelector('.toast')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('')
    expect(space()).toBe('')
  })

  it('says a new version is ready, offers a reload, and makes room for itself under the toasts', () => {
    build.available = true
    const { unmount } = render(<UpdateAvailableNotice />)
    // Once to assistive tech (the status), once on the card.
    expect(screen.getByRole('status').textContent).toBe('A new version of Aurora is ready.')
    const card = document.querySelector('.update-notice .toast')!
    expect(card.querySelector('.toast-text')!.textContent).toBe('A new version of Aurora is ready.')
    expect(card.querySelector('[role="status"], [role="alert"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    // One row (52px) and the gap above it, where nothing can be measured.
    expect(space()).toBe('64px')
    // It is kept out of a bug report's capture.
    expect(document.querySelector('.update-notice')!.getAttribute('data-screenshot-exclude')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update notice' }))
    expect(build.dismiss).toHaveBeenCalledTimes(1)
    // Appearing and being dismissed reload nothing: only its button does.
    expect(reload).not.toHaveBeenCalled()
    unmount()
    expect(space()).toBe('')
  })

  it('reloads the page when its button is pressed, and only then', () => {
    build.available = true
    render(<UpdateAvailableNotice />)
    expect(reload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(build.dismiss).not.toHaveBeenCalled()
  })

  // Its words wrap on a narrow phone, and it is then taller than one row: a
  // fixed 64px left the toast above it touching it.
  it('makes the room it measures itself to need, and again when its height changes', () => {
    build.available = true
    const drawn = drawnAt(86.5)
    const { unmount } = render(<UpdateAvailableNotice />)
    expect(space()).toBe('99px')
    expect(observers).toHaveLength(1)
    expect(observers[0].watching).toEqual([document.querySelector('.update-notice')])
    drawn.mockRestore()
    drawnAt(52)
    act(() => observers[0].changed())
    expect(space()).toBe('64px')
    unmount()
    expect(observers[0].off).toBe(true)
    expect(space()).toBe('')
  })
})
