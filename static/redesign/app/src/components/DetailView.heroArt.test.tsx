// @vitest-environment jsdom
//
// DetailView → DetailRail `heroShowsArt` wiring. DetailRail drops its poster
// below lg only when told the hero above it carries artwork; this pins that the
// flag tracks the image the hero is ACTUALLY given (`realBackdrop`), including
// the case that matters most — a title whose detail payload has no backdrop,
// where the poster is the only art on the page and must stay.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
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

  it('before the payload lands, follows the card art the hero is given', () => {
    renderWith(movie)
    expect(last()).toBe(true)
    seen.heroShowsArt.length = 0
    renderWith({ ...movie, backdrop: undefined, poster: '' })
    expect(last()).toBe(false)
  })
})
