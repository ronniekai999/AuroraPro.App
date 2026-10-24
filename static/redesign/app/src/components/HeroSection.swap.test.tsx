// @vitest-environment jsdom
//
// The hero's text lines are keyed on the pick so a rotation remounts them with
// their entrance (Stage refresh, H2). They are siblings, so their keys must be
// distinct: with a bare `hero.id` on each, React kept stale copies and the
// running app showed the reason and title three times over. Nothing in the
// suite rendered HeroSection across a rotation, so nothing saw it.

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HeroSection } from './HeroSection'
import type { Media } from '@/lib/types'

const pick = (id: number, title: string, description: string): Media => ({
  id, title, year: 2024, rating: 8, duration: '2h', genre: 'Drama', type: 'movie',
  poster: '', backdrop: '', description,
})

describe('HeroSection rotation', () => {
  it('replaces the text lines of the previous pick instead of keeping copies', () => {
    const a = pick(1, 'The Long Quiet', 'A listening post goes silent.')
    const b = pick(2, 'Glass Harbor', 'A town that keeps its secrets.')
    const props = { onPlay: vi.fn(), onInfo: vi.fn() }
    const { rerender } = render(<HeroSection {...props} hero={a} reason="Because you watched Arrival" />)
    rerender(<HeroSection {...props} hero={b} reason="Because you watched Meridian" />)
    rerender(<HeroSection {...props} hero={a} reason="Because you watched Arrival" />)

    expect(screen.getAllByRole('heading', { name: 'The Long Quiet' })).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Glass Harbor' })).toBeNull()
    expect(screen.getAllByText('Because you watched Arrival')).toHaveLength(1)
    expect(screen.queryByText('Because you watched Meridian')).toBeNull()
    expect(screen.getAllByText('A listening post goes silent.')).toHaveLength(1)
    expect(screen.queryByText('A town that keeps its secrets.')).toBeNull()
  })

  it('does the same for the compact band\'s "Featured" line', () => {
    const a = pick(1, 'The Long Quiet', '')
    const b = pick(2, 'Glass Harbor', '')
    const props = { onPlay: vi.fn(), onInfo: vi.fn(), compact: true, pageTitle: 'Movies', titleAs: 'h1' as const }
    const { rerender } = render(<HeroSection {...props} hero={a} />)
    rerender(<HeroSection {...props} hero={b} />)

    expect(screen.getAllByRole('heading', { name: 'Movies' })).toHaveLength(1)
    expect(screen.getAllByText('Glass Harbor')).toHaveLength(1)
    expect(screen.queryByText('The Long Quiet')).toBeNull()
  })
})
