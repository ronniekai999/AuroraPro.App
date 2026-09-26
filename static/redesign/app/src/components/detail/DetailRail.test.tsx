// @vitest-environment jsdom
//
// DetailRail's single-column (below lg) layout. The rail's 216px desktop poster
// column rendered FULL-WIDTH in the one-column grid: ~530px tall on a 390px
// phone and ~990px on an iPad in portrait, between the hero and the Play button
// — which pushed the page's primary action 1.4 to 2 screens below the fold
// under a second copy of art the hero already shows.
//
// jsdom has no layout, so what is pinned here is the WIRING that makes the
// breakpoint behaviour true: the poster carries `hidden lg:block` for every
// title (a data-dependent version flipped between the pre-payload and payload
// renders — see the component), and the relocated progress bar is its exact
// complement (`lg:hidden`). The breakpoint classes themselves are Tailwind's.

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DetailRail } from './DetailRail'

const base = {
  poster: '/api/images/w500/p.jpg',
  title: 'The Dark Knight',
  primaryLabel: 'Play',
  onPrimary: () => {},
  inLibrary: false,
  onToggleLibrary: () => {},
  detailRows: [],
}
const withResume = {
  resumeFraction: 0.25,
  resumeLeftLabel: 'Resume · 30:00',
  resumeRightLabel: '2:00:00',
}

// The poster box is the <img alt={title}>'s parent.
const posterBox = () => screen.getByAltText('The Dark Knight').parentElement!
const bars = () => screen.getAllByRole('progressbar', { name: 'Resume progress' })

describe('DetailRail — the poster is a desktop (lg+) element', () => {
  it.each([
    ['a poster', base.poster],
    ['no poster', ''],
  ])('is dropped below lg and kept from lg up, with %s', (_, poster) => {
    render(<DetailRail {...base} poster={poster} />)
    expect(posterBox()).toHaveClass('hidden', 'lg:block')
  })

  it('loads lazily, so the display:none poster is never fetched below lg', () => {
    render(<DetailRail {...base} />)
    expect(screen.getByAltText('The Dark Knight')).toHaveAttribute('loading', 'lazy')
  })
})

describe('DetailRail — resume progress below lg', () => {
  it('is relocated as the poster\'s exact complement', () => {
    render(<DetailRail {...base} {...withResume} />)
    // Two copies exist in the DOM; CSS shows exactly one at any width. The
    // overlay copy lives inside the poster box (hidden below lg); the other
    // must be lg:hidden and must NOT be inside the poster box.
    const all = bars()
    expect(all).toHaveLength(2)
    const inPoster = all.filter(b => posterBox().contains(b))
    const outside = all.filter(b => !posterBox().contains(b))
    expect(inPoster).toHaveLength(1)
    expect(outside).toHaveLength(1)
    expect(outside[0].closest('.lg\\:hidden')).not.toBeNull()
    // Same value and labels in both, so which one is displayed does not change
    // what the user is told.
    expect(outside[0]).toHaveAttribute('aria-valuenow', '25')
    expect(inPoster[0]).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getAllByText('Resume · 30:00')).toHaveLength(2)
  })

  it('sits ABOVE the primary action', () => {
    render(<DetailRail {...base} {...withResume} />)
    const outside = bars().find(b => !posterBox().contains(b))!
    const play = screen.getByRole('button', { name: 'Play' })
    expect(outside.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('is absent when there is nothing to resume', () => {
    render(<DetailRail {...base} />)
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0)
  })
})

describe('DetailRail — spacing', () => {
  // Tailwind 3's space-y selector (`> :not([hidden]) ~ :not([hidden])`) skips
  // only the hidden ATTRIBUTE, so a poster hidden by `hidden lg:block` still
  // earned the next child a 20px top margin below lg. A display:none flex item
  // takes no gap, so the root must space its children with flex + gap.
  it('spaces its children with a flex gap, not space-y', () => {
    render(<DetailRail {...base} />)
    const root = posterBox().parentElement!
    expect(root).toHaveClass('flex', 'flex-col', 'gap-5')
    expect(root.className).not.toMatch(/\bspace-y-/)
  })
})
