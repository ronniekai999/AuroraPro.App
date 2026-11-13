// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ambientCacheSize, ambientFor, clampAmbient, clearAmbientCache, weightedAverage } from './ambient'

const parse = (css: string) => {
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(css)!
  return { r: +m[1], g: +m[2], b: +m[3], a: +m[4] }
}
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

describe('clampAmbient', () => {
  it('keeps the hue and darkens a bright colour', () => {
    const c = parse(clampAmbient(255, 120, 40)!)
    expect(c.r).toBeGreaterThan(c.g)
    expect(c.g).toBeGreaterThan(c.b)
    expect(Math.max(c.r, c.g, c.b)).toBeLessThan(100)
    expect(c.a).toBe(0.6)
  })

  it('lifts a dark but clearly tinted colour only as far as its floor', () => {
    const c = parse(clampAmbient(30, 14, 8)!)
    expect(c.r).toBeGreaterThan(c.b)
    expect(Math.max(c.r, c.g, c.b)).toBeGreaterThan(30)
    expect(Math.max(c.r, c.g, c.b)).toBeLessThan(90)
  })

  it('never returns a wash the page text cannot be read on', () => {
    // The page's ink over the wash at FULL strength, for the most saturated
    // primaries and mixes: the wash is clamped so even these stay far above
    // the 4.5:1 floor. (The page lays it at 0.6 over graphite, darker still.)
    const ink = lum(0xf4, 0xf4, 0xf5), ink2 = lum(0xb4, 0xb6, 0xbc)
    for (const [r, g, b] of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 200, 180], [40, 80, 255]]) {
      const c = parse(clampAmbient(r, g, b)!)
      const wash = lum(c.r, c.g, c.b)
      expect(contrast(ink, wash), `ink on ${r},${g},${b}`).toBeGreaterThan(9)
      expect(contrast(ink2, wash), `ink-2 on ${r},${g},${b}`).toBeGreaterThan(5)
    }
  })

  it('gives nothing for a picture with no colour to borrow', () => {
    expect(clampAmbient(128, 128, 128)).toBeNull()
    expect(clampAmbient(0, 0, 0)).toBeNull()
    expect(clampAmbient(250, 250, 248)).toBeNull()
    // Too dark for the difference between channels to mean anything.
    expect(clampAmbient(3, 2, 2)).toBeNull()
  })
})

describe('weightedAverage', () => {
  it('lets a few colourful pixels outweigh many grey ones', () => {
    const data: number[] = []
    for (let i = 0; i < 20; i++) data.push(20, 20, 20, 255)
    for (let i = 0; i < 4; i++) data.push(255, 80, 0, 255)
    const [r, g, b] = weightedAverage(data)!
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
    expect(r).toBeGreaterThan(120)
  })

  it('ignores transparent pixels and reports nothing when that is all there is', () => {
    expect(weightedAverage([255, 0, 0, 0, 255, 0, 0, 0])).toBeNull()
    expect(weightedAverage([])).toBeNull()
  })
})

describe('ambientFor', () => {
  const decoded = (src: string) => ({ src, currentSrc: src, complete: true, naturalWidth: 1280 }) as HTMLImageElement
  // jsdom has no canvas: one is supplied whose pixels, or whose refusal to
  // give them, the test decides.
  let read: () => { data: number[] }
  beforeEach(() => {
    clearAmbientCache()
    read = () => ({ data: Array.from({ length: 16 * 16 }, () => [220, 90, 30, 255]).flat() })
    const create = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return create(tag)
      return { width: 0, height: 0, getContext: () => ({ drawImage: () => {}, getImageData: () => read() }) }
    }) as typeof document.createElement)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('is null, never a rejection, without an image or a URL', async () => {
    await expect(ambientFor(null)).resolves.toBeNull()
    await expect(ambientFor({ src: '', currentSrc: '' } as HTMLImageElement)).resolves.toBeNull()
  })

  it('reads the colour of a decoded picture and answers from the cache the next time', async () => {
    const first = await ambientFor(decoded('/warm.jpg'))
    const c = parse(first!)
    expect(c.r).toBeGreaterThan(c.b)
    read = () => { throw new Error('the cache should have answered') }
    await expect(ambientFor(decoded('/warm.jpg'))).resolves.toBe(first)
  })

  // Cached as "no colour", a picture asked about before it had decoded would
  // never get one.
  it('does not remember an answer for a picture that has not decoded yet', async () => {
    const pending = { src: '/slow.jpg', currentSrc: '/slow.jpg', complete: false, naturalWidth: 0 } as HTMLImageElement
    await expect(ambientFor(pending)).resolves.toBeNull()
    expect(ambientCacheSize()).toBe(0)
    await expect(ambientFor(decoded('/slow.jpg'))).resolves.not.toBeNull()
  })

  // A picture from another origin without CORS approval taints the canvas,
  // and reading it throws. The page stays neutral.
  it('is null, never a rejection, when the canvas refuses to be read', async () => {
    read = () => { throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError') }
    await expect(ambientFor(decoded('/elsewhere.jpg'))).resolves.toBeNull()
    expect(ambientCacheSize()).toBe(1)
  })

  it('is null when there is no canvas to read at all', async () => {
    vi.mocked(document.createElement).mockImplementation((() => ({ getContext: () => null })) as unknown as typeof document.createElement)
    await expect(ambientFor(decoded('/nocanvas.jpg'))).resolves.toBeNull()
  })

  // One picture is asked about from its ref callback, from its load event
  // and from every render until the first answer lands.
  it('samples a picture once however many ask while the first answer is on its way', async () => {
    let reads = 0
    read = () => { reads++; return { data: [220, 90, 30, 255] } }
    const answers = await Promise.all([ambientFor(decoded('/once.jpg')), ambientFor(decoded('/once.jpg')), ambientFor(decoded('/once.jpg'))])
    expect(reads).toBe(1)
    expect(new Set(answers).size).toBe(1)
    expect(answers[0]).not.toBeNull()
  })

  it('keeps a bounded number of answers, dropping the oldest', async () => {
    for (let i = 0; i < 80; i++) await ambientFor(decoded(`/p${i}.jpg`))
    expect(ambientCacheSize()).toBe(64)
    // The first is gone (it is read again), the last is still there.
    let reads = 0
    read = () => { reads++; return { data: [220, 90, 30, 255] } }
    await ambientFor(decoded('/p79.jpg'))
    expect(reads).toBe(0)
    await ambientFor(decoded('/p0.jpg'))
    expect(reads).toBe(1)
  })
})
