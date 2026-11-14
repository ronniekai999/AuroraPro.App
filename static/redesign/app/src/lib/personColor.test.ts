import { describe, expect, it, vi } from 'vitest'
import {
  NAME_BUBBLE_DIM_OPACITY, NAME_BUBBLE_FILL_ALPHA, NAME_BUBBLE_FILL_RGB, PERSON_COLORS, personColor, personInitial,
} from './personColor'

const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const lum = ([r, g, b]: readonly number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const contrast = (a: readonly number[], b: readonly number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const over = (top: readonly number[], alpha: number, under: readonly number[]) => top.map((c, i) => c * alpha + under[i] * (1 - alpha))

describe('personColor', () => {
  it('is stable for a key, and consecutive ids get different colours', () => {
    expect(personColor(4)).toBe(personColor(4))
    expect(personColor('priya')).toBe(personColor('priya'))
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9].map(personColor)).size).toBe(PERSON_COLORS.length)
  })
  it('gives an initial, or a question mark for no name', () => {
    expect(personInitial(' morgan')).toBe('M')
    expect(personInitial('')).toBe('?')
    expect(personInitial(null)).toBe('?')
  })
  // One whole character, never half of one: charAt(0) gave the first half of
  // an emoji's surrogate pair, drawn as a replacement glyph.
  it('takes the first whole character of a name', () => {
    expect(personInitial('🎬 Movies')).toBe('🎬')
    expect(personInitial('👨‍👩‍👧 Family')).toBe('👨‍👩‍👧')
    expect(personInitial('🇫🇷 Amélie')).toBe('🇫🇷')
    expect(personInitial('e\u0301clair')).toBe('E\u0301')
    expect(personInitial('éclair')).toBe('É')
  })
  // Without Intl.Segmenter (Firefox before 125) it falls back to the first
  // code point: still never half a surrogate pair, though a flag gives its
  // first regional letter and a joined emoji its first person.
  it('falls back to the first code point where there is no Intl.Segmenter', async () => {
    // Removed to model a browser without it; the flag's answer below shows
    // the fallback really ran.
    const segmenter = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!
    Reflect.deleteProperty(Intl, 'Segmenter')
    try {
      vi.resetModules()
      const { personInitial: initial } = await import('./personColor')
      expect(initial('🎬 Movies')).toBe('🎬')
      expect(initial('🇫🇷 Amélie')).toBe('🇫')
      expect(initial('👨‍👩‍👧 Family')).toBe('👨')
      expect(initial('sam')).toBe('S')
      expect(initial(' ')).toBe('?')
    } finally {
      Object.defineProperty(Intl, 'Segmenter', segmenter)
      vi.resetModules()
    }
  })
})

// A name in the party's chat ticker is drawn in the person's colour on a dark
// bubble over PLAYING video. The worst frame is white. The bubble has two
// states: lit, and dimmed before it leaves, when the whole bubble (fill and
// text) is partly transparent over that same frame.
describe('a name on the chat bubble over a white frame', () => {
  const WHITE = [255, 255, 255]
  const INK = hex('#f4f4f5')
  for (const [state, opacity] of [['lit', 1], ['dimmed before it leaves', NAME_BUBBLE_DIM_OPACITY]] as const) {
    const fill = over(NAME_BUBBLE_FILL_RGB, NAME_BUBBLE_FILL_ALPHA * opacity, WHITE)
    it(`keeps every person colour at 4.5:1 or better while ${state}`, () => {
      for (const color of PERSON_COLORS) {
        const text = over(hex(color), opacity, WHITE)
        expect(contrast(text, fill), `${color} ${state}`).toBeGreaterThanOrEqual(4.5)
      }
    })
    it(`keeps the message text at 4.5:1 or better while ${state}`, () => {
      expect(contrast(over(INK, opacity, WHITE), fill)).toBeGreaterThanOrEqual(4.5)
    })
  }
})
