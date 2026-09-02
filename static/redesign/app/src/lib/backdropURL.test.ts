// backdropURL / backdropSrcSet — the per-surface sizing the UI polish pass
// introduced. `original` used to be every surface's size; the default is
// now w1280 (heroes), cards ask for w780, and the two heroes get a 2x srcset
// so Retina displays are not upscaled from 1280. Both sizes must stay inside
// the Go proxy's allowlist (internal/metadata/imageproxy.go).

import { describe, expect, it } from 'vitest'
import { backdropSrcSet, backdropURL } from './api'

describe('backdropURL', () => {
  it('defaults to w1280 and strips the leading slash TMDB paths carry', () => {
    expect(backdropURL('/abc.jpg')).toBe('/api/images/w1280/abc.jpg')
    expect(backdropURL('abc.jpg')).toBe('/api/images/w1280/abc.jpg')
  })
  it('honours an explicit size', () => {
    expect(backdropURL('/abc.jpg', 'w780')).toBe('/api/images/w780/abc.jpg')
    expect(backdropURL('/abc.jpg', 'original')).toBe('/api/images/original/abc.jpg')
  })
  it('returns an empty string for a missing path', () => {
    expect(backdropURL(undefined)).toBe('')
    expect(backdropURL('')).toBe('')
  })
})

describe('backdropSrcSet', () => {
  it('pairs a sized proxy URL with the original at 2x', () => {
    expect(backdropSrcSet('/api/images/w1280/abc.jpg')).toBe('/api/images/w1280/abc.jpg 1x, /api/images/original/abc.jpg 2x')
    expect(backdropSrcSet('/api/images/w780/dir/abc.jpg')).toBe('/api/images/w780/dir/abc.jpg 1x, /api/images/original/dir/abc.jpg 2x')
  })
  it('gives no srcset for anything that is not a sized proxy backdrop', () => {
    // An `original` URL has no larger candidate.
    expect(backdropSrcSet('/api/images/original/abc.jpg')).toBeUndefined()
    // A poster used as a backdrop fallback, an absolute TVDB URL, nothing.
    expect(backdropSrcSet('/api/images/w500/abc.jpg')).toBeUndefined()
    expect(backdropSrcSet('https://artworks.thetvdb.com/banners/x.jpg')).toBeUndefined()
    expect(backdropSrcSet('')).toBeUndefined()
    expect(backdropSrcSet(undefined)).toBeUndefined()
  })
})
