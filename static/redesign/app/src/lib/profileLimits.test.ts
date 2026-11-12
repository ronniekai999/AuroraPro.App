// The limits Settings offers, checked against the server's own rating ladder.
//
// A label such as "Up to PG and TV-PG" is a claim about what a ceiling lets
// through, and the ladder that decides it is the server's
// (internal/db/ratings.go). The ladder is read from that file here, so a
// label that stops being true (a rating moved, a tier added) fails this test
// instead of misleading a parent.

import { describe, expect, it } from 'vitest'
import ratingsGo from '../../../../../internal/db/ratings.go?raw'
import { LIMIT_OPTIONS, canonicalLimit, limitOptionsFor, limitPhrase } from './profileLimits'

/** `var ageRatingOrder = map[string]int{ "G": 0, ... }` from the Go source. */
function serverLadder(): Map<string, number> {
  const start = ratingsGo.indexOf('var ageRatingOrder = map[string]int{')
  expect(start, 'the ladder is where this test expects it').toBeGreaterThan(-1)
  const body = ratingsGo.slice(start, ratingsGo.indexOf('\n}', start))
  return new Map([...body.matchAll(/"([A-Z0-9-]+)":\s*(\d+)/g)].map(m => [m[1], Number(m[2])]))
}
const FILM = ['G', 'PG', 'PG-13', 'R', 'NC-17']
const TV = ['TV-Y', 'TV-G', 'TV-Y7', 'TV-PG', 'TV-14', 'TV-MA']

describe('the limits Settings offers', () => {
  const ladder = serverLadder()

  it('reads the whole ladder', () => {
    expect([...ladder.keys()].sort()).toEqual([...FILM, ...TV].sort())
  })

  it('offers only ceilings the server accepts', () => {
    for (const o of LIMIT_OPTIONS) {
      if (o.value !== '') expect(ladder.has(o.value), o.value).toBe(true)
    }
    expect(LIMIT_OPTIONS[0]).toEqual({ value: '', label: 'No limit' })
  })

  // "Up to X and Y": X is the highest film rating the ceiling lets through
  // and Y the highest TV rating, by the server's own levels.
  it('names, for each ceiling, the highest film and TV rating it really allows', () => {
    for (const o of LIMIT_OPTIONS) {
      if (o.value === '') continue
      const ceiling = ladder.get(o.value)!
      const top = (system: string[]) => system.filter(r => ladder.get(r)! <= ceiling).sort((a, b) => ladder.get(b)! - ladder.get(a)!)[0]
      // TV-Y, TV-G and G share the all-ages level; the label names G and TV-G.
      const film = top(FILM), tv = ceiling === 0 ? 'TV-G' : top(TV)
      expect(o.label, o.value).toBe(`Up to ${film} and ${tv}`)
    }
  })

  it('orders them from loosest to strictest', () => {
    const levels = LIMIT_OPTIONS.slice(1).map(o => ladder.get(o.value)!)
    expect(levels).toEqual([...levels].sort((a, b) => b - a))
    expect(new Set(levels).size).toBe(levels.length)
  })
})

describe('a stored limit', () => {
  it('is read as the server spells it', () => {
    expect(canonicalLimit(' pg ')).toBe('PG')
    expect(canonicalLimit(undefined)).toBe('')
    expect(canonicalLimit('   ')).toBe('')
  })

  // Onboarding writes "PG" and the API accepts any rating on the ladder: the
  // control must show the limit the profile has, not the nearest offered one.
  it('is always among the options shown for it', () => {
    expect(limitOptionsFor('TV-14')).toBe(LIMIT_OPTIONS)
    expect(limitOptionsFor(undefined)).toBe(LIMIT_OPTIONS)
    const withPg = limitOptionsFor('pg')
    expect(withPg).toHaveLength(LIMIT_OPTIONS.length + 1)
    expect(withPg.at(-1)).toEqual({ value: 'PG', label: 'Up to PG' })
  })

  it('reads as a phrase in a sentence', () => {
    expect(limitPhrase('')).toBe('no limit')
    expect(limitPhrase('TV-PG')).toBe('up to PG and TV-PG')
    expect(limitPhrase('R')).toBe('up to R')
  })
})
