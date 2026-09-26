// @vitest-environment jsdom
//
// DetailView → DetailRail `heroShowsArt` wiring. DetailRail drops its poster
// below lg only when told the hero above it is showing genuine backdrop art;
// this pins that judgement: no backdrop in the payload, the pre-payload poster
// fallback, and a backdrop that fails to load all count as NO art, so the
// poster — then the only art on the page — stays.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import DetailView from './DetailView'
import type { Media } from '@/lib/types'
import type { MediaDetail } from '@/lib/api'

const seen = vi.hoisted(() => ({ heroShowsArt: [] as (boolean | undefined)[] }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getRecapStatus: vi.fn().mockResolvedValue({ available: false }),
    getUserRating: vi.fn().mockResolvedValue(0),
  }
})

vi.mock('@/components/detail/DetailRail', () => ({
  DetailRail: ({ heroShowsArt }: { heroShowsArt?: boolean }) => {
    seen.heroShowsArt.push(heroShowsArt)
    return null
  },
}))

const movie: Media = {
  id: 7,
  title: 'Arrival',
  year: 2016,
  rating: 8,
  duration: '1h 56m',
  genre: 'Drama',
  type: 'movie',
  poster: '/api/images/w500/poster.jpg',
  backdrop: '/api/images/w1280/backdrop.jpg',
  description: '',
}
const payload = (backdrop_path?: string): MediaDetail => ({
  id: 7, library_id: 1, type: 'movie', title: 'Arrival', poster_path: '/poster.jpg', backdrop_path,
  added_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
})

const last = () => seen.heroShowsArt[seen.heroShowsArt.length - 1]
const renderWith = (media: Media, detail?: MediaDetail) => render(
  <DetailView media={media} detail={detail} onBack={() => {}} onPlay={() => {}} onToggleLib={() => {}} inLibrary={false} />,
)

beforeEach(() => {
  seen.heroShowsArt.length = 0
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
})

describe('DetailView heroShowsArt', () => {
  it('is true when the detail payload has a backdrop', () => {
    renderWith(movie, payload('/backdrop.jpg'))
    expect(last()).toBe(true)
  })

  it('is FALSE when the detail payload has no backdrop — the poster is the only art', () => {
    renderWith(movie, payload(undefined))
    expect(last()).toBe(false)
  })

  it('before the payload lands, follows the card\'s own backdrop', () => {
    renderWith(movie)
    expect(last()).toBe(true)
  })

  it('does NOT count the hero\'s pre-payload POSTER fallback as backdrop art', () => {
    // Before the payload, realBackdrop falls back to the poster. Counting that
    // hid the rail's poster for a title with no backdrop, then restored it
    // ~530px tall when the payload landed — shoving Play down after the page
    // had settled. Both answers must agree for a backdrop-less title.
    const noBackdrop = { ...movie, backdrop: '' }
    const r = renderWith(noBackdrop)
    expect(last()).toBe(false)
    r.rerender(<DetailView media={noBackdrop} detail={payload(undefined)} onBack={() => {}} onPlay={() => {}} onToggleLib={() => {}} inLibrary={false} />)
    expect(last()).toBe(false)
  })

  it('is false once the hero\'s backdrop FAILS to load — the hero is then showing no art', () => {
    const { container } = renderWith(movie, payload('/backdrop.jpg'))
    expect(last()).toBe(true)
    const heroImg = container.querySelector('section img') as HTMLImageElement
    expect(heroImg.getAttribute('src')).toBe('/api/images/w1280/backdrop.jpg')
    fireEvent.error(heroImg)
    expect(last()).toBe(false)
  })
})
