// @vitest-environment jsdom
//
// DetailView → DetailHero art wiring. Below lg DetailRail drops its poster for
// every title, so DetailView must hand the hero the poster as its fallback —
// otherwise a title whose payload has no backdrop shows no art at all on a
// phone. Pinned at the DetailView level because the wiring (which URL is the
// fallback, pre- and post-payload) is DetailView's, not the hero's.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import DetailView from './DetailView'
import type { Media } from '@/lib/types'
import type { MediaDetail } from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getRecapStatus: vi.fn().mockResolvedValue({ available: false }),
    getUserRating: vi.fn().mockResolvedValue(0),
  }
})

const movie: Media = {
  id: 7,
  title: 'Arrival',
  year: 2016,
  rating: 8,
  duration: '1h 56m',
  genre: 'Drama',
  type: 'movie',
  poster: '/api/images/w500/card-poster.jpg',
  backdrop: '/api/images/w1280/card-backdrop.jpg',
  description: '',
}
const payload = (backdrop_path?: string): MediaDetail => ({
  id: 7, library_id: 1, type: 'movie', title: 'Arrival', poster_path: '/poster.jpg', backdrop_path,
  added_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
})
const renderWith = (media: Media, detail?: MediaDetail) => render(
  <DetailView media={media} detail={detail} onBack={() => {}} onPlay={() => {}} onToggleLib={() => {}} inLibrary={false} />,
)
// The hero is the first <section>; its <img> is the backdrop (DetailRail's
// poster <img> sits later in the document and carries alt text).
const heroImg = (c: HTMLElement) => c.querySelector('section img[alt=""]') as HTMLImageElement | null

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
})

describe('DetailView hero art', () => {
  it('shows the payload backdrop when there is one', () => {
    const { container } = renderWith(movie, payload('/backdrop.jpg'))
    expect(heroImg(container)).toHaveAttribute('src', '/api/images/w1280/backdrop.jpg')
  })

  it('shows the payload POSTER, at w780, when the payload has no backdrop', () => {
    const { container } = renderWith(movie, payload(undefined))
    // w780, not the rail's w500 — it is stretched across the full-width hero.
    expect(heroImg(container)).toHaveAttribute('src', '/api/images/w780/poster.jpg')
  })

  it('falls back to the payload poster when the payload backdrop fails', () => {
    const { container } = renderWith(movie, payload('/backdrop.jpg'))
    fireEvent.error(heroImg(container)!)
    expect(heroImg(container)).toHaveAttribute('src', '/api/images/w780/poster.jpg')
  })

  it('before the payload, shows the card\'s backdrop', () => {
    const { container } = renderWith(movie)
    expect(heroImg(container)).toHaveAttribute('src', '/api/images/w1280/card-backdrop.jpg')
  })

  it('before the payload, falls back to the card\'s poster when the card\'s backdrop FAILS', () => {
    // Exercises the `fallback` prop pre-payload. (A card with no backdrop at all
    // shows its poster through realBackdrop's own `|| media.poster`, which is
    // why that case alone could not pin the wiring.)
    const { container } = renderWith(movie)
    fireEvent.error(heroImg(container)!)
    expect(heroImg(container)).toHaveAttribute('src', '/api/images/w500/card-poster.jpg')
  })
})
