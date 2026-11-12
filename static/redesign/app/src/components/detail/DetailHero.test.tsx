// @vitest-environment jsdom
//
// DetailHero's art. Below lg the poster beside the title is dropped for every
// title, so the backdrop is the page's only artwork there and must not go
// blank while any art exists: no backdrop, or a backdrop that fails to load
// (the image proxy 502s on a TMDB miss), falls back to the poster.
//
// The poster itself is a wide-screen element of the hero. jsdom has no
// layout, so what is pinned for it is the WIRING that makes the breakpoint
// behaviour true: `hidden lg:block` for every title (a data-dependent
// version flipped between the pre-payload and payload renders), lazy loading
// (a display:none lazy image is never fetched, so a phone does not download
// a poster it cannot show), and a flex gap rather than `space-*` between it
// and the text.

import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DetailHero } from './DetailHero'

const BACKDROP = '/api/images/w1280/backdrop.jpg'
const POSTER = '/api/images/w500/poster.jpg'
const renderHero = (backdrop: string, fallback?: string) => render(
  <DetailHero backdrop={backdrop} fallback={fallback} title="Arrival" onBack={() => {}} />,
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
    rerender(<DetailHero backdrop={next} fallback={POSTER} title="Arrival" onBack={() => {}} />)
    expect(heroImg(container)).toHaveAttribute('src', next)
  })
})

describe('DetailHero — the poster is a wide-screen (lg+) element', () => {
  const withPoster = (poster: string) => render(
    <DetailHero backdrop={BACKDROP} fallback={POSTER} poster={poster} title="The Dark Knight" onBack={() => {}} />,
  )
  // The poster box is the <img alt="… poster">'s parent.
  const posterImg = () => screen.getByAltText('The Dark Knight poster')
  const posterBox = () => posterImg().parentElement!

  it.each([
    ['a poster', POSTER],
    ['no poster', ''],
  ])('is dropped below lg and kept from lg up, with %s', (_, poster) => {
    withPoster(poster)
    expect(posterBox()).toHaveClass('hidden', 'lg:block')
  })

  it('loads lazily, so the display:none poster is never fetched below lg', () => {
    withPoster(POSTER)
    expect(posterImg()).toHaveAttribute('loading', 'lazy')
  })

  it('comes after the backdrop in the document, so the backdrop stays the hero\'s first image', () => {
    const { container } = withPoster(POSTER)
    expect(heroImg(container)).toHaveAttribute('src', BACKDROP)
    expect(heroImg(container)!.compareDocumentPosition(posterImg()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // Tailwind's space-x/space-y selector (`> :not([hidden]) ~ :not([hidden])`)
  // skips only the hidden ATTRIBUTE, so a poster hidden by `hidden lg:block`
  // would still earn the text beside it a margin below lg. A display:none
  // flex item takes no gap, so the row must space its children with flex + gap.
  it('is spaced from the text with a flex gap, not space-x or space-y', () => {
    withPoster(POSTER)
    const row = posterBox().parentElement!
    expect(row).toHaveClass('flex', 'gap-8')
    expect(row.className).not.toMatch(/\bspace-[xy]-/)
    // The text column stacks its own children the same way.
    const column = screen.getByRole('heading', { level: 1 }).parentElement!
    expect(column).toHaveClass('flex', 'flex-col')
    expect(column.className).not.toMatch(/\bspace-[xy]-/)
  })

  it('is not rendered at all when the caller passes no poster prop', () => {
    renderHero(BACKDROP, POSTER)
    expect(screen.queryByAltText(/poster$/)).toBeNull()
  })
})

describe('DetailHero — the facts line and the action slot', () => {
  it('prints the facts in order, dropping empty ones, with the rating last', () => {
    render(
      <DetailHero backdrop={BACKDROP} title="Arrival" facts={['2016', undefined, '1h 56m', '', 'Drama']} rating={7.9} onBack={() => {}} />,
    )
    const line = screen.getByText('2016').closest('p')!
    expect(line.textContent).toBe('2016·1h 56m·Drama·Rated 7.9')
  })

  it('renders its children (the action row) inside the hero, under the title', () => {
    render(
      <DetailHero backdrop={BACKDROP} title="Arrival" onBack={() => {}}>
        <button type="button">Play</button>
      </DetailHero>,
    )
    const play = screen.getByRole('button', { name: 'Play' })
    const hero = screen.getByRole('region', { name: 'Arrival' })
    expect(hero).toContainElement(play)
    expect(screen.getByRole('heading', { level: 1 }).compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('reports no ambient colour when the artwork fails', () => {
    const seen: (string | null)[] = []
    const { container } = render(
      <DetailHero backdrop={BACKDROP} title="Arrival" onBack={() => {}} onAmbient={c => seen.push(c)} />,
    )
    const before = seen.length
    fireEvent.error(heroImg(container)!)
    // The failure is reported, as "no colour", and nothing but "no colour"
    // has ever been said for a picture that never loaded. (A change of
    // picture also withdraws the colour, so there is more than one report.)
    expect(seen.length).toBeGreaterThan(before)
    expect(seen.every(c => c === null)).toBe(true)
  })
})
