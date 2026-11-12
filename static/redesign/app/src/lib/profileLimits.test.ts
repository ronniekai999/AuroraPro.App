// The limits Settings offers, checked against the server's own rating ladder.
//
// A label such as "Up to PG and TV-PG" is a claim about what a ceiling lets
// through, and the ladder that decides it is the server's
// (internal/db/ratings.go). The ladder is read from that file here, and the
// copy the app words its labels from must equal it, so a label that stops
// being true (a rating moved, a tier added) fails this test instead of
// misleading a parent.

import { describe, expect, it } from 'vitest'
import ratingsGo from '../../../../../internal/db/ratings.go?raw'
import {
  LIMIT_OPTIONS, RATING_LEVELS, canonicalLimit, limitLabel, limitLevel, limitOptionValue, limitOptionsFor, limitPhrase, loosensLimit,
} from './profileLimits'

/** `var ageRatingOrder = map[string]int{ "G": 0, ... }` from the Go source. */
function serverLadder(): Map<string, number> {
  const start = ratingsGo.indexOf('var ageRatingOrder = map[string]int{')
  expect(start, 'the ladder is where this test expects it').toBeGreaterThan(-1)
  const body = ratingsGo.slice(start, ratingsGo.indexOf('\n}', start))
  return new Map([...body.matchAll(/"([A-Z0-9-]+)":\s*(\d+)/g)].map(m => [m[1], Number(m[2])]))
}
const FILM = ['G', 'PG', 'PG-13', 'R', 'NC-17']
const TV = ['TV-Y', 'TV-G', 'TV-Y7', 'TV-PG', 'TV-14', 'TV-MA']

describe('the app\'s copy of the ladder', () => {
  const ladder = serverLadder()

  it('is the server\'s, rating for rating and level for level', () => {
    expect([...ladder.keys()].sort()).toEqual([...FILM, ...TV].sort())
    expect(Object.fromEntries(ladder)).toEqual({ ...RATING_LEVELS })
  })

  // "Up to X and Y": X is the highest film rating the ceiling lets through
  // and Y the highest TV rating, by the server's own levels. Checked for
  // EVERY rating on the ladder, since any of them can be stored.
  it('labels every ceiling with the highest film and TV rating the server lets through under it', () => {
    for (const [ceiling, level] of ladder) {
      const allowed = (system: string[]) => system.filter(r => ladder.get(r)! <= level)
      const top = (system: string[]) => allowed(system).sort((a, b) => ladder.get(b)! - ladder.get(a)!)[0]
      // TV-Y, TV-G and G share the all-ages level; the label names G and TV-G.
      const tv = top(TV) === 'TV-Y' ? 'TV-G' : top(TV)
      expect(limitLabel(ceiling), ceiling).toBe(`Up to ${top(FILM)} and ${tv}`)
      // And nothing above the two it names is let through.
      for (const r of [...FILM, ...TV]) {
        if (ladder.get(r)! > level) expect(allowed([...FILM, ...TV]), `${ceiling} hides ${r}`).not.toContain(r)
      }
    }
  })

  it('says which of two limits lets more through, as the server orders them', () => {
    expect(loosensLimit('TV-PG', 'TV-14')).toBe(true)
    expect(loosensLimit('TV-PG', '')).toBe(true)
    expect(loosensLimit('PG', 'TV-PG')).toBe(true)
    expect(loosensLimit('TV-14', 'TV-PG')).toBe(false)
    expect(loosensLimit('', 'TV-G')).toBe(false)
    expect(loosensLimit('TV-G', 'G')).toBe(false)
    // An unknown stored value is enforced as all ages, so anything else loosens it.
    expect(limitLevel('XYZ')).toBe(0)
    expect(loosensLimit('XYZ', 'TV-Y7')).toBe(true)
  })
})

describe('the limits Settings offers', () => {
  const ladder = serverLadder()

  it('are ceilings the server accepts, loosest first, with a tier for young children', () => {
    expect(LIMIT_OPTIONS.map(o => o.value)).toEqual(['', 'TV-14', 'TV-PG', 'TV-Y7', 'TV-G'])
    for (const o of LIMIT_OPTIONS.slice(1)) expect(ladder.has(o.value), o.value).toBe(true)
    const levels = LIMIT_OPTIONS.slice(1).map(o => ladder.get(o.value)!)
    expect(levels).toEqual([...levels].sort((a, b) => b - a))
    expect(new Set(levels).size).toBe(levels.length)
  })

  it('reads as what each lets through', () => {
    expect(LIMIT_OPTIONS.map(o => o.label)).toEqual([
      'No limit', 'Up to PG-13 and TV-14', 'Up to PG and TV-PG', 'Up to G and TV-Y7', 'Up to G and TV-G',
    ])
  })
})

describe('a stored limit', () => {
  it('is read as the server spells it', () => {
    expect(canonicalLimit(' pg ')).toBe('PG')
    expect(canonicalLimit(undefined)).toBe('')
    expect(canonicalLimit('   ')).toBe('')
  })

  // Onboarding writes "PG" and the API accepts any rating on the ladder: the
  // control must show the limit the profile has, in its place, and say what
  // it really lets through.
  it('that the list does not offer is shown in its place, described from the ladder', () => {
    expect(limitOptionsFor('TV-14')).toBe(LIMIT_OPTIONS)
    expect(limitOptionsFor(undefined)).toBe(LIMIT_OPTIONS)
    // "PG" hides TV-PG: it sits between the TV-PG and TV-Y7 tiers.
    expect(limitOptionsFor('pg').map(o => o.value)).toEqual(['', 'TV-14', 'TV-PG', 'PG', 'TV-Y7', 'TV-G'])
    expect(limitLabel('PG')).toBe('Up to PG and TV-Y7')
    // "R" lets TV-MA through, and sits just under no limit.
    expect(limitOptionsFor('R').map(o => o.value)).toEqual(['', 'R', 'TV-14', 'TV-PG', 'TV-Y7', 'TV-G'])
    expect(limitLabel('R')).toBe('Up to R and TV-MA')
    expect(limitLabel('PG-13')).toBe('Up to PG-13 and TV-PG')
  })

  it('that lets the same through as an offered one is that option', () => {
    expect(limitOptionValue('G')).toBe('TV-G')
    expect(limitOptionValue('tv-y')).toBe('TV-G')
    expect(limitOptionValue('TV-PG')).toBe('TV-PG')
    expect(limitOptionValue('')).toBe('')
    expect(limitOptionValue('PG')).toBe('PG')
    expect(limitOptionsFor('G')).toBe(LIMIT_OPTIONS)
  })

  // The server enforces a ceiling it does not know as all ages. Saying "Up
  // to XYZ" would be saying something the server does not do.
  it('that the ladder does not know is described as what the server does with it', () => {
    expect(limitLabel('XYZ')).toBe('All ages only (“XYZ” is not a rating Aurora knows)')
    expect(limitOptionValue('XYZ')).toBe('XYZ')
    expect(limitOptionsFor('XYZ').at(-1)).toEqual({ value: 'XYZ', label: 'All ages only (“XYZ” is not a rating Aurora knows)' })
  })

  it('reads as a phrase in a sentence', () => {
    expect(limitPhrase('')).toBe('no limit')
    expect(limitPhrase('TV-PG')).toBe('up to PG and TV-PG')
    expect(limitPhrase('R')).toBe('up to R and TV-MA')
  })
})
