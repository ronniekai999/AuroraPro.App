// @vitest-environment jsdom
//
// Tonight's hero with nothing to show has two states. While a pick is still
// on its way it draws the hero-shaped skeleton; once nothing is coming (an
// empty library, a limit no title passes, a failed fetch) it must be the
// static card with its heading visible. The first cut drew the skeleton in
// both, so the settled state shimmered for the life of the page with no
// visible heading (a review measured ~16x the idle main-thread time).

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HeroSection } from './HeroSection'

const props = { onPlay: vi.fn(), onInfo: vi.fn() }

describe('HeroSection with no pick', () => {
  it('is the static card, heading visible and nothing animating, once settled', () => {
    const { container } = render(<HeroSection {...props} />)
    const heading = screen.getByRole('heading', { name: 'Welcome to Aurora' })
    expect(heading).not.toHaveClass('sr-only')
    expect(container.querySelector('.stage-skel')).toBeNull()
  })

  it('draws the skeleton only while a pick is loading', () => {
    const { container } = render(<HeroSection {...props} loading />)
    expect(container.querySelector('.stage-skel')).not.toBeNull()
    // The heading is still there for assistive tech.
    expect(screen.getByRole('heading', { name: 'Welcome to Aurora' })).toHaveClass('sr-only')
  })

  it("draws no picks, no actions and no title of a previous hero in either state", () => {
    // A profile switch renders the hero with nothing for one commit: what
    // it shows then must be none of the previous profile's.
    for (const loading of [true, false]) {
      const { container, unmount } = render(<HeroSection {...props} loading={loading} slate={[]} kids={false} />)
      expect(container.querySelector('[data-hero-picks]')).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.getAllByRole('heading')).toHaveLength(1)
      unmount()
    }
  })
})
