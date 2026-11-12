// @vitest-environment jsdom
//
// The trailer dialog: one press plays it, focus stays inside it and goes back
// where it came from, and Escape closes it without the title page going back.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TrailerModal } from './TrailerModal'
import { pushEscapeLayer } from '@/lib/escapeLayers'

afterEach(cleanup)

describe('TrailerModal', () => {
  // Pressing Trailer is the request to play it: the embed is there as the
  // dialog opens, with no second press.
  it('plays as it opens: the privacy-enhanced embed, autoplaying, with a referrer YouTube can see', () => {
    render(<TrailerModal youtubeKey="a b/c" title="Kestrel" onClose={() => {}} />)
    const frame = screen.getByTitle('Kestrel trailer') as HTMLIFrameElement
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/a%20b%2Fc?autoplay=1&rel=0&modestbranding=1')
    expect(frame).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
    expect(frame.getAttribute('allow')).toContain('autoplay')
    expect(screen.queryByRole('button', { name: /play/i })).toBeNull()
  })

  it('puts focus on Close, which outlives the embed loading, and keeps it there', () => {
    render(<TrailerModal youtubeKey="abc" title="Kestrel" onClose={() => {}} />)
    const close = screen.getByRole('button', { name: 'Close trailer' })
    expect(close).toHaveFocus()
    fireEvent.load(screen.getByTitle('Kestrel trailer'))
    expect(close).toHaveFocus()
  })

  it('wraps Tab at the dialog\u2019s two ends and leaves it alone in between', () => {
    render(<TrailerModal youtubeKey="abc" title="Kestrel" onClose={() => {}} />)
    const close = screen.getByRole('button', { name: 'Close trailer' })
    const back = screen.getByRole('button', { name: 'Back to Kestrel' })
    back.focus()
    expect(fireEvent.keyDown(back, { key: 'Tab' })).toBe(false)
    expect(close).toHaveFocus()
    expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(back).toHaveFocus()
    close.focus()
    expect(fireEvent.keyDown(close, { key: 'Tab' })).toBe(true)
  })

  // A key pressed outside the dialog never reaches the dialog's own handler,
  // so what keeps the page behind out of reach cannot be that handler: the
  // page is inert while the trailer is open, and reachable again after.
  it('makes the page behind inert while it is open, and only then', () => {
    const page = document.createElement('div')
    const link = document.createElement('button')
    page.appendChild(link); document.body.appendChild(page)
    const already = document.createElement('div')
    already.setAttribute('inert', ''); document.body.appendChild(already)
    const view = render(<TrailerModal youtubeKey="abc" title="Kestrel" onClose={() => {}} />)
    expect(page).toHaveAttribute('inert')
    expect(screen.getByRole('dialog', { name: 'Kestrel trailer' })).not.toHaveAttribute('inert')
    view.unmount()
    expect(page).not.toHaveAttribute('inert')
    // Something that was inert for its own reasons is left as it was.
    expect(already).toHaveAttribute('inert')
    page.remove(); already.remove()
  })

  it('brings focus back when it lands outside the dialog', () => {
    render(<TrailerModal youtubeKey="abc" title="Kestrel" onClose={() => {}} />)
    // Added after the dialog opened, so not covered by the inert pass.
    const late = document.createElement('button')
    document.body.appendChild(late)
    late.focus()
    expect(screen.getByRole('button', { name: 'Close trailer' })).toHaveFocus()
    late.remove()
  })

  it('closes on Escape, on the close button, on "Back to", and on a press outside, but not on a press inside', () => {
    const onClose = vi.fn()
    render(<TrailerModal youtubeKey="abc" title="Kestrel" onClose={onClose} />)
    fireEvent.click(screen.getByRole('heading', { name: /Kestrel/ }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close trailer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to Kestrel' }))
    fireEvent.click(screen.getByRole('dialog', { name: 'Kestrel trailer' }))
    expect(onClose).toHaveBeenCalledTimes(4)
  })

  it('keeps Escape to itself: the app\'s own Escape handler (which leaves the title page) never sees it', () => {
    const onClose = vi.fn(), appHandler = vi.fn()
    window.addEventListener('keydown', appHandler)
    render(<TrailerModal youtubeKey="abc" title="Kestrel" onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close trailer' }), { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close trailer' }), { key: 'a' })
    window.removeEventListener('keydown', appHandler)
    expect(onClose).toHaveBeenCalledOnce()
    expect(appHandler.mock.calls.map(([e]) => (e as KeyboardEvent).key)).toEqual(['a'])
  })

  // Something of the party's left open underneath (a reaction picker in the
  // rail) closes on Escape too. One press closes the trailer, which is on
  // top; the thing under it takes the next.
  it('is the top layer: one Escape closes the trailer and not what was open under it', () => {
    const under = vi.fn(), onClose = vi.fn()
    const dropUnder = pushEscapeLayer(under)
    const view = render(<TrailerModal youtubeKey="abc" title="Kestrel" onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close trailer' }), { key: 'Escape' })
    expect([onClose.mock.calls.length, under.mock.calls.length]).toEqual([1, 0])
    view.unmount()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect([onClose.mock.calls.length, under.mock.calls.length]).toEqual([1, 1])
    dropUnder()
  })

  // The palette opens inside the page, which is inert under the trailer.
  it('keeps the search shortcut from the app while it is open', () => {
    const appHandler = vi.fn()
    window.addEventListener('keydown', appHandler)
    const view = render(<TrailerModal youtubeKey="abc" title="Kestrel" onClose={() => {}} />)
    expect(fireEvent.keyDown(document.body, { key: 'k', metaKey: true })).toBe(false)
    expect(fireEvent.keyDown(document.body, { key: 'K', ctrlKey: true })).toBe(false)
    expect(appHandler).not.toHaveBeenCalled()
    // A plain k is not the shortcut.
    fireEvent.keyDown(document.body, { key: 'k' })
    expect(appHandler).toHaveBeenCalledTimes(1)
    view.unmount()
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true })
    expect(appHandler).toHaveBeenCalledTimes(2)
    window.removeEventListener('keydown', appHandler)
  })

  it('gives focus back to whatever opened it', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const view = render(<TrailerModal youtubeKey="abc" onClose={() => {}} />)
    expect(opener).not.toHaveFocus()
    view.unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })
})
