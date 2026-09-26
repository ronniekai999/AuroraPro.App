// @vitest-environment jsdom
//
// DetailHero's art fallback. Below lg, DetailRail drops its poster for every
// title, so the hero is the page's only artwork there and must not go blank
// while any art exists: no backdrop, or a backdrop that fails to load (the
// image proxy 502s on a TMDB miss), falls back to the poster.

import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { DetailHero } from './DetailHero'

const BACKDROP = '/api/images/w1280/backdrop.jpg'
const POSTER = '/api/images/w500/poster.jpg'
const renderHero = (backdrop: string, fallback?: string) => render(
  <DetailHero backdrop={backdrop} fallback={fallback} title="Arrival" kindLabel="Movie" onBack={() => {}} />,
)
const heroImg = (c: HTMLElement) => c.querySelector('section img') as HTMLImageElement | null

describe('DetailHero art', () => {
  it('shows the backdrop, with its 2x srcset', () => {
    const { container } = renderHero(BACKDROP, POSTER)
    expect(heroImg(container)).toHaveAttribute('src', BACKDROP)
    expect(heroImg(container)!.getAttribute('srcset')).toContain('/api/images/original/backdrop.jpg 2x')
  })

  it('shows the poster when there is no backdrop', () => {
    const { container } = renderHero('', POSTER)
    expect(heroImg(container)).toHaveAttribute('src', POSTER)
  })

  // backdropSrcSet keys on the SIZE in the URL (w780/w1280), not on what the
  // image is — so a poster fallback at w780 would get an `original` 2x and pull
  // the full-size (~2000x3000) poster on every 2x/3x screen. Only the backdrop
  // may carry the srcset. A w500 poster cannot test this (the helper never
  // matches w500), which is how the first version of this test passed while
  // the bug shipped.
  it.each([
    ['no backdrop', ''],
    ['a failed backdrop', BACKDROP],
  ])('gives a poster fallback at a srcset-matching size NO srcset — %s', (_, backdrop) => {
    const W780_POSTER = '/api/images/w780/poster.jpg'
    const { container } = renderHero(backdrop, W780_POSTER)
    if (backdrop) fireEvent.error(heroImg(container)!)
    expect(heroImg(container)).toHaveAttribute('src', W780_POSTER)
    expect(heroImg(container)).not.toHaveAttribute('srcset')
  })

  it('falls back to the poster when the backdrop FAILS to load', () => {
    const { container } = renderHero(BACKDROP, POSTER)
    fireEvent.error(heroImg(container)!)
    expect(heroImg(container)).toHaveAttribute('src', POSTER)
  })

  it('renders no image once every source has failed — the gradient carries the frame', () => {
    const { container } = renderHero(BACKDROP, POSTER)
    fireEvent.error(heroImg(container)!)
    fireEvent.error(heroImg(container)!)
    expect(heroImg(container)).toBeNull()
  })

  it('does not retry a fallback that IS the failed backdrop', () => {
    // Pre-payload DetailView passes the poster as the backdrop too.
    const { container } = renderHero(POSTER, POSTER)
    fireEvent.error(heroImg(container)!)
    expect(heroImg(container)).toBeNull()
  })

  it('renders no image when there is no art at all', () => {
    const { container } = renderHero('', '')
    expect(heroImg(container)).toBeNull()
  })

  it('tries a NEW backdrop fresh after an earlier one failed', () => {
    const { container, rerender } = renderHero(BACKDROP, POSTER)
    fireEvent.error(heroImg(container)!)
    expect(heroImg(container)).toHaveAttribute('src', POSTER)
    const next = '/api/images/w1280/other.jpg'
    rerender(<DetailHero backdrop={next} fallback={POSTER} title="Arrival" kindLabel="Movie" onBack={() => {}} />)
    expect(heroImg(container)).toHaveAttribute('src', next)
  })
})
