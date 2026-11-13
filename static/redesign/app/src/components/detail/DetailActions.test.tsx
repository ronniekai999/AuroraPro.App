// @vitest-environment jsdom
//
// The title page's action row. It replaced a side rail whose resume progress
// existed twice in the DOM (one copy over the poster for wide screens, one
// relocated for narrow ones) with CSS showing exactly one. There is one copy
// now, in the hero under the actions, shown at every width; what is pinned
// here is that it is exactly one, that nothing breakpoint-gated can hide it,
// and that it says the same thing a viewer is told by the button above it.

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DetailActions } from './DetailActions'

const base = {
  primaryLabel: 'Play',
  onPrimary: () => {},
  inLibrary: false,
  onToggleLibrary: () => {},
}
const withResume = {
  primaryLabel: 'Resume at 30:00',
  resumeFraction: 0.25,
  resumeLeftLabel: '90 min left',
}

describe('DetailActions — resume progress', () => {
  it('is shown once, at every width', () => {
    render(<DetailActions {...base} {...withResume} />)
    const bars = screen.getAllByRole('progressbar', { name: 'Resume progress' })
    expect(bars).toHaveLength(1)
    expect(bars[0]).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getAllByText('90 min left')).toHaveLength(1)
    // No ancestor hides it at some breakpoint: the old layout's two copies
    // each sat in a `hidden lg:block` / `lg:hidden` box.
    for (let el: HTMLElement | null = bars[0]; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/(^|\s)(hidden|(sm|md|lg|xl|2xl|max-\w+):hidden)(\s|$)/)
    }
  })

  it('sits with the primary action, directly under the row that holds it', () => {
    const { container } = render(<DetailActions {...base} {...withResume} />)
    const bar = screen.getByRole('progressbar', { name: 'Resume progress' })
    const play = screen.getByRole('button', { name: 'Resume at 30:00' })
    const root = container.firstElementChild!
    expect(root.children[0]).toContainElement(play)
    expect(root.children[1]).toContainElement(bar)
    expect(root).toHaveClass('flex', 'flex-col')
    expect(root.className).not.toMatch(/\bspace-[xy]-/)
  })

  it('is absent when there is nothing to resume', () => {
    render(<DetailActions {...base} />)
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0)
  })
})

describe('DetailActions — the row', () => {
  it('puts the primary action first and pre-warms playback on hover and on focus', async () => {
    const onPrimary = vi.fn(), onPrimaryIntent = vi.fn()
    render(<DetailActions {...base} onPrimary={onPrimary} onPrimaryIntent={onPrimaryIntent} onWatchTrailer={() => {}} onParty={() => {}} onRate={() => {}} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons[0]).toHaveAccessibleName('Play')
    fireEvent.mouseEnter(buttons[0])
    fireEvent.focus(buttons[0])
    expect(onPrimaryIntent).toHaveBeenCalledTimes(2)
    await userEvent.click(buttons[0])
    expect(onPrimary).toHaveBeenCalledOnce()
  })

  it('offers "Play from start", the recap, the trailer, the list and the party only when it is handed them', () => {
    const { rerender } = render(<DetailActions {...base} />)
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Play', 'My Library'])
    const handlers = { onSecondary: vi.fn(), onPrevious: vi.fn(), onWatchTrailer: vi.fn(), onAddToList: vi.fn(), onParty: vi.fn() }
    rerender(<DetailActions {...base} secondaryLabel="Play from start" {...handlers} />)
    for (const [name, fn] of [
      ['Play from start', handlers.onSecondary], ['Previously on', handlers.onPrevious], ['Trailer', handlers.onWatchTrailer],
      ['List', handlers.onAddToList], ['Watch together', handlers.onParty],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }))
      expect(fn).toHaveBeenCalledOnce()
    }
  })

  it('says whether the title is in My Library through the control\'s pressed state', () => {
    const onToggleLibrary = vi.fn()
    const { rerender } = render(<DetailActions {...base} onToggleLibrary={onToggleLibrary} />)
    const add = screen.getByRole('button', { name: 'My Library' })
    expect(add).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(add)
    expect(onToggleLibrary).toHaveBeenCalledOnce()
    rerender(<DetailActions {...base} inLibrary onToggleLibrary={onToggleLibrary} />)
    // The name does not change with the state: a toggle that renames itself
    // AND reports pressed says it twice.
    expect(screen.getByRole('button', { name: 'My Library' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: 'In My Library' })).toBeNull()
  })

  it('disables the party action for someone already in a party', () => {
    const onParty = vi.fn()
    render(<DetailActions {...base} onParty={onParty} inParty />)
    const party = screen.getByRole('button', { name: 'In a party' })
    expect(party).toBeDisabled()
    fireEvent.click(party)
    expect(onParty).not.toHaveBeenCalled()
  })
})

describe('DetailActions — rating', () => {
  const stars = () => within(screen.getByRole('group', { name: /rat/i })).getAllByRole('button')

  it('is five toggle buttons, with the saved rating pressed', () => {
    render(<DetailActions {...base} userRating={4} onRate={() => {}} />)
    expect(screen.getByRole('group', { name: 'Your rating: 4 of 5' })).toBeInTheDocument()
    expect(stars()).toHaveLength(5)
    expect(stars().map(s => s.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'true', 'false'])
    // Not a radiogroup: it has no roving tab stop, and a radio cannot be unchecked.
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('sets a rating on press, and clears it on a press of the current one', () => {
    const onRate = vi.fn()
    render(<DetailActions {...base} userRating={4} onRate={onRate} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rate 2 stars: Not for me' }))
    expect(onRate).toHaveBeenLastCalledWith(2)
    fireEvent.click(screen.getByRole('button', { name: 'Clear your 4-star rating' }))
    expect(onRate).toHaveBeenLastCalledWith(0)
  })

  it('is hidden when the caller cannot take a rating', () => {
    render(<DetailActions {...base} />)
    expect(screen.queryByRole('group', { name: /rat/i })).toBeNull()
  })
})
