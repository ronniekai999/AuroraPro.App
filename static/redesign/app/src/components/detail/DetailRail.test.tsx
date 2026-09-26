// @vitest-environment jsdom
//
// DetailRail's single-column (below lg) layout. The rail's 216px desktop poster
// column rendered FULL-WIDTH in the one-column grid: ~530px tall on a 390px
// phone and ~990px on an iPad in portrait, between the hero and the Play button
// — which pushed the page's primary action 1.4 to 2 screens below the fold
// under a second copy of art the hero already shows.
//
// jsdom has no layout, so what is pinned here is the WIRING that makes the
// breakpoint behaviour true: which element carries `hidden lg:block`, that the
// relocated progress bar is its exact complement (`lg:hidden`), and that
// neither happens for a title whose poster is the page's only artwork. The
// breakpoint classes themselves are Tailwind's and are not re-tested.

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

describe('DetailRail — below lg with a backdrop in the hero (heroShowsArt)', () => {
  it('drops the poster below lg and keeps it from lg up', () => {
    render(<DetailRail {...base} heroShowsArt />)
    expect(posterBox()).toHaveClass('hidden', 'lg:block')
  })

  it('relocates the resume progress as the poster\'s exact complement', () => {
    render(<DetailRail {...base} {...withResume} heroShowsArt />)
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

  it('places the relocated progress ABOVE the primary action', () => {
    render(<DetailRail {...base} {...withResume} heroShowsArt />)
    const outside = bars().find(b => !posterBox().contains(b))!
    const play = screen.getByRole('button', { name: 'Play' })
    expect(outside.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('adds no relocated progress when there is nothing to resume', () => {
    render(<DetailRail {...base} heroShowsArt />)
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0)
  })
})

describe('DetailRail — no backdrop: the poster is the only artwork', () => {
  it('keeps the poster at every width and renders a single progress bar', () => {
    render(<DetailRail {...base} {...withResume} />)
    expect(posterBox()).not.toHaveClass('hidden')
    expect(bars()).toHaveLength(1)
    expect(posterBox().contains(bars()[0])).toBe(true)
  })
})
