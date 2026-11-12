// @vitest-environment jsdom
//
// The card menu, opened by something other than a right click.
//
// A long press on a touch screen opens it while the finger is still down, and
// on a phone it is a sheet with a scrim across the whole screen. Whatever the
// browser sends when the finger lifts lands on that scrim: the release, and,
// on an engine that follows a touch with compatibility mouse events, a
// mousedown and a click. Which engines do that after a half-second hold has
// not been measured on a device, so the menu must stay open either way, and
// must still close for a real press outside afterwards.
//
// Also here: the control that opened the menu (a card's More button) gets
// focus back and says the menu is open, and a pick's reason heads the menu.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ContextMenu, PRESS_HOLD_CAP_MS, PRESS_RELEASE_GRACE_MS } from './ContextMenu'

const items = [{ label: 'Play', onClick: () => {} }, { label: 'Add to My Library', onClick: () => {} }]

function phone(on: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: on && q.includes('max-width: 767px'), media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }))
}
const touch = (id: number) => ({ pointerType: 'touch', pointerId: id })
/** The listener for presses outside is bound a tick after the menu opens. */
const settle = () => act(() => { vi.advanceTimersByTime(0) })
const scrim = () => document.querySelector('.stage-scrim-in') as HTMLElement

describe('a menu opened by a press that is still held', () => {
  beforeEach(() => { vi.useFakeTimers(); phone(true) })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

  function openMidPress(id: number) {
    const onClose = vi.fn()
    fireEvent.pointerDown(document.body, touch(id))
    render(<ContextMenu x={100} y={200} items={items} onClose={onClose} title="Kestrel" />)
    settle()
    expect(scrim()).not.toBeNull()
    return onClose
  }

  it('stays open when the lift is followed by compatibility mouse events on the scrim', () => {
    const onClose = openMidPress(11)
    fireEvent.pointerUp(scrim(), touch(11))
    fireEvent.mouseDown(scrim())
    fireEvent.mouseUp(scrim())
    fireEvent.click(scrim())
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('stays open when nothing follows the lift, and then closes for a real tap outside', () => {
    const onClose = openMidPress(12)
    fireEvent.pointerUp(scrim(), touch(12))
    act(() => { vi.advanceTimersByTime(PRESS_RELEASE_GRACE_MS) })
    expect(onClose).not.toHaveBeenCalled()
    // A new touch, down and up, and the mousedown the browser sends for it.
    fireEvent.pointerDown(scrim(), touch(13))
    fireEvent.pointerUp(scrim(), touch(13))
    fireEvent.mouseDown(scrim())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores a press outside while the opening finger is still down', () => {
    const onClose = openMidPress(14)
    fireEvent.mouseDown(scrim())
    act(() => { vi.advanceTimersByTime(PRESS_RELEASE_GRACE_MS * 4) })
    fireEvent.mouseDown(scrim())
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerUp(scrim(), touch(14))
    act(() => { vi.advanceTimersByTime(PRESS_RELEASE_GRACE_MS) })
    fireEvent.mouseDown(scrim())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // A release can go unseen: a native dialog takes the screen, the page goes
  // to the background mid-touch. The menu must not wait for it for ever; a
  // phone's sheet has no Escape key to fall back on.
  it('stops waiting for a lift it never sees, and closes for a press outside after the cap', () => {
    const onClose = openMidPress(17)
    act(() => { vi.advanceTimersByTime(PRESS_HOLD_CAP_MS - 1) })
    fireEvent.mouseDown(scrim())
    expect(onClose).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    fireEvent.mouseDown(scrim())
    expect(onClose).toHaveBeenCalledTimes(1)
    // The touch is released for the tests that follow.
    fireEvent.pointerUp(document.body, touch(17))
  })

  // The cap ends the wait, but a release that then IS seen still sends its
  // click, and that click lands on the scrim like any other.
  it('gives a touch lifted after the cap its grace too', () => {
    const onClose = openMidPress(19)
    act(() => { vi.advanceTimersByTime(PRESS_HOLD_CAP_MS + 2000) })
    fireEvent.pointerUp(scrim(), touch(19))
    fireEvent.mouseDown(scrim())
    fireEvent.click(scrim())
    expect(onClose).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(PRESS_RELEASE_GRACE_MS) })
    fireEvent.mouseDown(scrim())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('forgets a touch whose release it never saw once the page is hidden, so the next menu is not held by it', () => {
    fireEvent.pointerDown(document.body, touch(18))
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    hidden.mockRestore()
    // No pointerup for 18 was ever dispatched.
    const onClose = vi.fn()
    render(<ContextMenu x={100} y={200} items={items} onClose={onClose} title="Kestrel" />)
    settle()
    fireEvent.mouseDown(scrim())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('treats a cancelled touch (the browser took the gesture) as its release', () => {
    const onClose = openMidPress(15)
    fireEvent.pointerCancel(scrim(), touch(15))
    act(() => { vi.advanceTimersByTime(PRESS_RELEASE_GRACE_MS) })
    fireEvent.mouseDown(scrim())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('still closes at once for a press outside when no touch was holding it open (a right click, More)', () => {
    const onClose = vi.fn()
    render(<ContextMenu x={100} y={200} items={items} onClose={onClose} title="Kestrel" />)
    settle()
    fireEvent.mouseDown(scrim())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close for a press inside the menu', () => {
    const onClose = openMidPress(16)
    fireEvent.pointerUp(scrim(), touch(16))
    act(() => { vi.advanceTimersByTime(PRESS_RELEASE_GRACE_MS) })
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Play' }))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('the control that opened the menu', () => {
  beforeEach(() => phone(false))
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('says the menu is open while it is, and gets focus back when it closes', () => {
    const more = document.createElement('button')
    more.setAttribute('aria-haspopup', 'menu')
    more.setAttribute('aria-expanded', 'false')
    document.body.appendChild(more)
    // Focus is elsewhere, as it is after a click on a button in Safari.
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    const { unmount } = render(<ContextMenu x={10} y={10} items={items} onClose={() => {}} title="Kestrel" opener={more} />)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    unmount()
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(more)
    more.remove()
    elsewhere.remove()
  })

  it('goes back to whatever had focus when what opened it is not a control (a right click on a card)', () => {
    const cardRoot = document.createElement('div')
    const art = document.createElement('button')
    cardRoot.appendChild(art)
    document.body.appendChild(cardRoot)
    art.focus()
    const { unmount } = render(<ContextMenu x={10} y={10} items={items} onClose={() => {}} title="Kestrel" opener={cardRoot} />)
    expect(cardRoot.hasAttribute('aria-expanded')).toBe(false)
    unmount()
    expect(document.activeElement).toBe(art)
    cardRoot.remove()
  })
})

describe('a pick\'s reason', () => {
  beforeEach(() => phone(false))
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('heads the menu in full, as its description and not as an item', () => {
    render(<ContextMenu x={10} y={10} items={items} onClose={() => {}} title="Kestrel" reason="A slow-burn thriller with the patient tension you gave five stars." />)
    const menu = screen.getByRole('menu')
    const reason = document.getElementById(menu.getAttribute('aria-describedby')!)!
    expect(reason.textContent).toBe('Picked by Aurora: A slow-burn thriller with the patient tension you gave five stars.')
    expect(menu.contains(reason)).toBe(true)
    expect(reason.getAttribute('role')).toBe('none')
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Play', 'Add to My Library'])
  })

  it('is absent, with no description, for a title Aurora did not pick', () => {
    render(<ContextMenu x={10} y={10} items={items} onClose={() => {}} title="Kestrel" />)
    expect(screen.getByRole('menu').hasAttribute('aria-describedby')).toBe(false)
    expect(document.querySelector('[data-menu-reason]')).toBeNull()
  })
})
