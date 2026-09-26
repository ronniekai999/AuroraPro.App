// @vitest-environment jsdom
//
// The meta row's DOM STRUCTURE. The one-line layout (index.css `.co-meta`) makes
// tokens that do not fit wrap onto a clipped second line and vanish whole — which
// is only clean if each token carries the dot that PRECEDES it. With the dot as
// its own sibling, a wrapped token leaves a stray trailing "·" on the visible
// line. scripts/verify-mobile-layout.mjs measures the real layout but rebuilds
// this markup from class names, so it cannot see the structure drift; this can.

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { MediaCardCinema } from './MediaCardCinema'

const item = { id: 1, title: 'The Matrix', year: 1999, rating: 9.2, genre: 'Science Fiction', duration: '2h 16m' }
const metaOf = (c: HTMLElement) => c.querySelector('.co-meta') as HTMLElement

describe('MediaCardCinema meta row structure', () => {
  it('renders one .co-tok per token, and nothing else, as the row\'s children', () => {
    const { container } = render(<MediaCardCinema item={item} onSelect={() => {}} showLength />)
    const kids = [...metaOf(container).children]
    expect(kids).toHaveLength(4)
    for (const k of kids) expect(k).toHaveClass('co-tok')
  })

  it('puts each separator INSIDE the token it precedes, and none before the first', () => {
    const { container } = render(<MediaCardCinema item={item} onSelect={() => {}} showLength />)
    const [first, ...rest] = [...metaOf(container).children]
    expect(first.querySelector('.sep')).toBeNull()
    for (const k of rest) {
      const sep = k.querySelector('.sep')
      expect(sep).not.toBeNull()
      expect(k.firstElementChild).toBe(sep)
      expect(sep).toHaveAttribute('aria-hidden', 'true')
    }
    // " 9.2": the star is an <svg> followed by a space, then the value.
    expect(metaOf(container).textContent).toBe(' 9.2·1999·2h 16m·Science Fiction')
  })

  it('wraps text tokens in .co-txt (the element that ellipsizes) and the rating in .star', () => {
    const { container } = render(<MediaCardCinema item={item} onSelect={() => {}} showLength />)
    const [rating, ...text] = [...metaOf(container).children]
    expect(rating.querySelector('.star')).not.toBeNull()
    expect(text.map(k => k.querySelector('.co-txt')?.textContent)).toEqual(['1999', '2h 16m', 'Science Fiction'])
  })

  it('renders a caller subtitle as a single ellipsizable token', () => {
    const { container } = render(<MediaCardCinema item={item} onSelect={() => {}} subtitle="S5E14 · 23m left" />)
    const kids = [...metaOf(container).children]
    expect(kids).toHaveLength(1)
    expect(kids[0].querySelector('.sep')).toBeNull()
    expect(kids[0].querySelector('.co-txt')?.textContent).toBe('S5E14 · 23m left')
  })
})
