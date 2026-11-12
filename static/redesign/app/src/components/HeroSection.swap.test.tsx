// @vitest-environment jsdom
//
// The hero's text lines are keyed on the title so a change remounts them with
// their entrance. They are siblings, so their keys must be distinct: with a
// bare `hero.id` on each, React kept stale copies and the running app showed
// the reason and title three times over. Nothing in the suite rendered
// HeroSection across a change, so nothing saw it.

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HeroSection } from './HeroSection'
import type { Media } from '@/lib/types'
import type { ContinueWatchingItem } from '@/lib/api'

const pick = (id: number, title: string, description: string, genre = 'Drama'): Media => ({
  id, title, year: 2020 + id, rating: 8, duration: '2h', genre, type: 'movie',
  poster: '', backdrop: '', description,
})
const record = (id: number, title: string, episode: number): ContinueWatchingItem => ({
  media_item_id: id, title, type: 'show', season_number: 1, episode_number: episode, episode_title: `Part ${episode}`,
  position_ms: 20 * 60_000, duration_ms: 50 * 60_000, percent_complete: 40,
})

describe('HeroSection across a change of title', () => {
  it('replaces the text lines of the previous pick instead of keeping copies', () => {
    const a = pick(1, 'The Long Quiet', 'A listening post goes silent.', 'Thriller')
    const b = pick(2, 'Glass Harbor', 'A town that keeps its secrets.', 'Mystery')
    const props = { onPlay: vi.fn(), onInfo: vi.fn() }
    const { rerender } = render(<HeroSection {...props} hero={a} reason="Because you watched Arrival" />)
    rerender(<HeroSection {...props} hero={b} reason="Because you watched Meridian" />)
    rerender(<HeroSection {...props} hero={a} reason="Because you watched Arrival" />)

    expect(screen.getAllByRole('heading', { name: 'The Long Quiet' })).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Glass Harbor' })).toBeNull()
    expect(screen.getAllByText('Because you watched Arrival')).toHaveLength(1)
    expect(screen.queryByText('Because you watched Meridian')).toBeNull()
    // The eyebrow and the facts line are keyed siblings of those too.
    expect(screen.getAllByText('Picked by Aurora')).toHaveLength(1)
    expect(screen.getAllByText('2021 · Thriller · 2h')).toHaveLength(1)
    expect(screen.queryByText('2022 · Mystery · 2h')).toBeNull()
  })

  it('does the same for a pick with no reason, whose line is its description', () => {
    const a = pick(1, 'The Long Quiet', 'A listening post goes silent.')
    const b = pick(2, 'Glass Harbor', 'A town that keeps its secrets.')
    const props = { onPlay: vi.fn(), onInfo: vi.fn() }
    const { rerender } = render(<HeroSection {...props} hero={a} />)
    rerender(<HeroSection {...props} hero={b} />)
    rerender(<HeroSection {...props} hero={a} />)

    expect(screen.getAllByText('A listening post goes silent.')).toHaveLength(1)
    expect(screen.queryByText('A town that keeps its secrets.')).toBeNull()
  })

  it('does the same for a title to resume: where the viewer is, and how long is left', () => {
    const a = { ...pick(1, 'The Long Quiet', ''), type: 'show' as const }
    const b = { ...pick(2, 'Glass Harbor', ''), type: 'show' as const }
    const ra = record(1, 'The Long Quiet', 3)
    const rb = { ...record(2, 'Glass Harbor', 7), position_ms: 40 * 60_000 }
    const props = { onPlay: vi.fn(), onInfo: vi.fn(), kind: 'resume' as const }
    const onResume = vi.fn()
    const { rerender } = render(<HeroSection {...props} hero={a} resume={{ item: ra, onPlay: onResume }} />)
    rerender(<HeroSection {...props} hero={b} resume={{ item: rb, onPlay: onResume }} />)
    rerender(<HeroSection {...props} hero={a} resume={{ item: ra, onPlay: onResume }} />)

    expect(screen.getAllByText('Pick up where you left off')).toHaveLength(1)
    expect(screen.getAllByText('Season 1, episode 3 · Part 3')).toHaveLength(1)
    expect(screen.queryByText('Season 1, episode 7 · Part 7')).toBeNull()
    expect(screen.getAllByText('30 min left')).toHaveLength(1)
    expect(screen.queryByText('10 min left')).toBeNull()
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
  })

  it("does the same in a child's hero", () => {
    const a = pick(1, 'The Long Quiet', '', 'Family')
    const b = pick(2, 'Glass Harbor', '', 'Animation')
    const props = { onPlay: vi.fn(), onInfo: vi.fn(), kids: true }
    const { rerender } = render(<HeroSection {...props} hero={a} />)
    rerender(<HeroSection {...props} hero={b} />)
    rerender(<HeroSection {...props} hero={a} />)

    expect(screen.getAllByRole('heading', { name: 'The Long Quiet' })).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Glass Harbor' })).toBeNull()
    expect(screen.getAllByText('2021 · Family · 2h')).toHaveLength(1)
    expect(screen.queryByText('2022 · Animation · 2h')).toBeNull()
  })
})
