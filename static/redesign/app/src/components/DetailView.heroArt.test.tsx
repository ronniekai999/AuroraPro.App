// @vitest-environment jsdom
//
// DetailView → DetailHero art wiring. Below lg the hero drops the poster beside
// the title for every title, so DetailView must hand the hero the poster as its
// backdrop fallback —
// otherwise a title whose payload has no backdrop shows no art at all on a
// phone. Pinned at the DetailView level because the wiring (which URL is the
// fallback, pre- and post-payload) is DetailView's, not the hero's.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import DetailView from './DetailView'
import type { Media } from '@/lib/types'
import type { MediaDetail } from '@/lib/api'
import { ambientFor } from '@/lib/ambient'

vi.mock('@/lib/ambient', async () => ({
  ...await vi.importActual<typeof import('@/lib/ambient')>('@/lib/ambient'),
  ambientFor: vi.fn(async () => null),
}))
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
// The hero is the first <section>; its first <img alt=""> is the backdrop (the
// poster beside the title sits later in the document and carries alt text).
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

  it('shows the payload POSTER when the payload has no backdrop — the rail\'s w500 URL, with no srcset', () => {
    const { container } = renderWith(movie, payload(undefined))
    expect(heroImg(container)).toHaveAttribute('src', '/api/images/w500/poster.jpg')
    expect(heroImg(container)).not.toHaveAttribute('srcset')
  })

  it('does not remount or refetch the hero when the payload lands for a backdrop-less title', () => {
    // Pre-payload the hero shows the card's poster; post-payload the fallback
    // must be the SAME URL, or the <img> (keyed by src) remounts — the hero
    // blinks blank and the art is fetched again. A larger fallback size did
    // exactly that.
    const card = { ...movie, backdrop: undefined }
    const view = (detail?: MediaDetail) => <DetailView media={card} detail={detail} onBack={() => {}} onPlay={() => {}} onToggleLib={() => {}} inLibrary={false} />
    const { container, rerender } = render(view())
    const before = heroImg(container)
    expect(before).toHaveAttribute('src', '/api/images/w500/card-poster.jpg')
    rerender(view({ ...payload(undefined), poster_path: '/card-poster.jpg' }))
    expect(heroImg(container)).toBe(before)
    expect(heroImg(container)).toHaveAttribute('src', '/api/images/w500/card-poster.jpg')
  })

  it('falls back to the payload poster when the payload backdrop fails', () => {
    const { container } = renderWith(movie, payload('/backdrop.jpg'))
    fireEvent.error(heroImg(container)!)
    expect(heroImg(container)).toHaveAttribute('src', '/api/images/w500/poster.jpg')
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

describe('DetailView hero art that is already decoded (a cache hit)', () => {
  // The hero reports its artwork's colour from a ref callback, and React
  // re-runs an inline ref callback on every render. With an image that is
  // already complete (every revisit of a title), a state update per report
  // re-rendered, re-ran the ref, and looped until React gave up and the
  // error screen replaced the page. jsdom images are never complete, so this
  // has to be said out loud. The colour now arrives a moment later, so a
  // loop would be render, answer, render, answer: counted here.
  let complete: ReturnType<typeof vi.spyOn>, width: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    width = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1280)
    vi.mocked(ambientFor).mockReset()
  })
  afterEach(() => { complete.mockRestore(); width.mockRestore() })
  const wash = (c: HTMLElement) => (c.querySelector('.stage-detail') as HTMLElement).style.getPropertyValue('--ambient')
  const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

  it('takes the colour once and settles instead of re-rendering forever', async () => {
    vi.mocked(ambientFor).mockResolvedValue('rgb(60 40 20 / 0.6)')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { container } = renderWith(movie, payload('/backdrop.jpg'))
      expect(heroImg(container)).toHaveAttribute('data-loaded')
      await flush()
      expect(wash(container)).toBe('rgb(60 40 20 / 0.6)')
      const asked = vi.mocked(ambientFor).mock.calls.length
      await flush()
      expect(vi.mocked(ambientFor).mock.calls.length).toBe(asked)
      expect(asked).toBeLessThan(6)
      expect(errors.mock.calls.flat().join(' ')).not.toMatch(/Maximum update depth|Too many re-renders/)
    } finally {
      errors.mockRestore()
    }
  })

  // Going from one title straight to another, the host still holds the
  // previous title's payload when the new page first renders. Its backdrop
  // is cached, so its colour is ready at once.
  it('does not show the previous title\u2019s artwork or its colour under the next title', async () => {
    vi.mocked(ambientFor).mockImplementation(async (img) => (
      (img as HTMLImageElement).getAttribute('src')?.includes('backdrop.jpg') ? 'rgb(60 40 20 / 0.6)' : null
    ))
    const next: Media = { ...movie, id: 8, title: 'Contact', poster: '/api/images/w500/contact.jpg', backdrop: '' }
    const stale = payload('/backdrop.jpg')
    const { container, rerender } = renderWith(movie, stale)
    await flush()
    expect(wash(container)).toBe('rgb(60 40 20 / 0.6)')
    rerender(<DetailView media={next} detail={stale} onBack={() => {}} onPlay={() => {}} onToggleLib={() => {}} inLibrary={false} />)
    // The commit that names the new title already has neither.
    expect(heroImg(container)).toHaveAttribute('src', '/api/images/w500/contact.jpg')
    expect(wash(container)).toBe('transparent')
    await flush()
    expect(wash(container)).toBe('transparent')
  })

  // A title whose card has no backdrop shows its poster as the hero's art
  // until the payload brings a backdrop. The poster's URL does not change, so
  // its colour cannot be told from the title's own by its source alone.
  it('withdraws the poster\u2019s colour when the backdrop takes its place, before the backdrop\u2019s own is known', async () => {
    vi.mocked(ambientFor).mockImplementation((img) => (
      (img as HTMLImageElement).getAttribute('src')?.includes('/w500/poster.jpg')
        ? Promise.resolve('rgb(90 40 20 / 0.6)')
        : new Promise<string | null>(() => {})
    ))
    const bare: Media = { ...movie, poster: '/api/images/w500/poster.jpg', backdrop: '' }
    const { container, rerender } = renderWith(bare)
    await flush()
    expect(heroImg(container)).toHaveAttribute('src', '/api/images/w500/poster.jpg')
    expect(wash(container)).toBe('rgb(90 40 20 / 0.6)')
    rerender(<DetailView media={bare} detail={payload('/backdrop.jpg')} onBack={() => {}} onPlay={() => {}} onToggleLib={() => {}} inLibrary={false} />)
    await flush()
    expect(heroImg(container)).toHaveAttribute('src', '/api/images/w1280/backdrop.jpg')
    expect(wash(container)).toBe('transparent')
  })

  // The colour is read after the picture has loaded. If the page has moved
  // to another picture by then, the late answer is for something no longer
  // on screen.
  it('ignores a colour that arrives for a picture the hero no longer shows', async () => {
    let answerOld!: (c: string | null) => void
    vi.mocked(ambientFor).mockImplementation((img) => (
      (img as HTMLImageElement).getAttribute('src')?.includes('card-backdrop')
        ? new Promise<string | null>(r => { answerOld = r })
        // The new picture's own colour has not come back yet, so nothing
        // else would correct a wrong one.
        : new Promise<string | null>(() => {})
    ))
    const { container, rerender } = renderWith(movie)
    rerender(<DetailView media={movie} detail={payload('/backdrop.jpg')} onBack={() => {}} onPlay={() => {}} onToggleLib={() => {}} inLibrary={false} />)
    expect(heroImg(container)).toHaveAttribute('src', '/api/images/w1280/backdrop.jpg')
    await act(async () => { answerOld('rgb(10 60 90 / 0.6)') })
    await flush()
    expect(wash(container)).toBe('transparent')
  })
})
