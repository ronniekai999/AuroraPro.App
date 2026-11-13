// The content limits Settings offers for a profile, and how any stored
// limit is described.
//
// The server owns the rating ladder (internal/db/ratings.go). It validates
// every value written and is the only thing that ever decides whether a
// title is shown. The copy of it here is for WORDS ONLY: what a limit lets
// through ("Up to PG and TV-PG"), and which of two limits is the looser one,
// so that loosening can be asked about first. profileLimits.test.ts reads
// the ladder from the server's source and fails if this copy differs from it
// in any rating or level, so a label cannot go on describing a ladder that
// has moved.

/** Each rating's level, as the server orders them. Only the order matters. */
export const RATING_LEVELS: Readonly<Record<string, number>> = {
  'G': 0, 'TV-Y': 0, 'TV-G': 0,
  'TV-Y7': 7,
  'PG': 8, 'TV-PG': 10,
  'PG-13': 13, 'TV-14': 14,
  'R': 17, 'TV-MA': 17,
  'NC-17': 18,
}
const FILM = ['G', 'PG', 'PG-13', 'R', 'NC-17']
// TV-Y shares the all-ages level with TV-G and G; the label names TV-G.
const TV = ['TV-G', 'TV-Y7', 'TV-PG', 'TV-14', 'TV-MA']

export interface LimitOption {
  /** What is stored: '' for none, otherwise a rating the ladder knows. */
  value: string
  label: string
}

export const NO_LIMIT = ''

/** How the server spells a stored limit: trimmed, upper case. */
export function canonicalLimit(stored: string | undefined | null): string {
  return (stored ?? '').trim().toUpperCase()
}

/** How much a limit lets through: Infinity for none, the ladder's level for
 *  a rating on it, and the all-ages level for anything else, which is what
 *  the server does with a ceiling it does not know (it fails closed). */
export function limitLevel(stored: string | undefined | null): number {
  const value = canonicalLimit(stored)
  if (value === NO_LIMIT) return Infinity
  return RATING_LEVELS[value] ?? 0
}

/** Whether changing a limit from `from` to `to` lets MORE through. */
export function loosensLimit(from: string | undefined | null, to: string | undefined | null): boolean {
  return limitLevel(to) > limitLevel(from)
}

const highest = (system: string[], level: number) =>
  [...system].reverse().find(r => RATING_LEVELS[r] <= level)

/** What a limit lets through, in words: the highest film rating and the
 *  highest TV rating at or under it. "PG" is "Up to PG and TV-Y7", which is
 *  how a reader learns that it hides TV-PG. */
export function limitLabel(stored: string | undefined | null): string {
  const value = canonicalLimit(stored)
  if (value === NO_LIMIT) return 'No limit'
  if (!(value in RATING_LEVELS)) return `All ages only (“${value}” is not a rating Aurora knows)`
  const level = RATING_LEVELS[value]
  return `Up to ${highest(FILM, level)} and ${highest(TV, level)}`
}

// Each offered value is the TV rating of its tier, not the film one, because
// the ladder puts TV-PG above PG and TV-14 above PG-13: a ceiling of "PG"
// hides TV-PG, and "PG-13" hides TV-14.
const OFFERED = [NO_LIMIT, 'TV-14', 'TV-PG', 'TV-Y7', 'TV-G']

/** The limits offered, loosest first. */
export const LIMIT_OPTIONS: readonly LimitOption[] = OFFERED.map(value => ({ value, label: limitLabel(value) }))

/** The option that stands for a stored limit: the offered one that lets the
 *  same through ("G" and "TV-Y" are the TV-G option), else the stored value
 *  itself. Saving that option again changes nothing. */
export function limitOptionValue(stored: string | undefined | null): string {
  const value = canonicalLimit(stored)
  const level = limitLevel(value)
  const known = value === NO_LIMIT || value in RATING_LEVELS
  return (known && OFFERED.find(o => limitLevel(o) === level)) || value
}

/** The options to show for a profile whose stored limit is `stored`: the
 *  offered ones, plus the stored one in its place by level when it is a
 *  ceiling the list does not offer (onboarding writes "PG"; the API accepts
 *  any rating on the ladder), so the control never shows a limit the profile
 *  does not have. */
export function limitOptionsFor(stored: string | undefined | null): readonly LimitOption[] {
  const value = limitOptionValue(stored)
  if (LIMIT_OPTIONS.some(o => o.value === value)) return LIMIT_OPTIONS
  const extra = { value, label: limitLabel(value) }
  const at = LIMIT_OPTIONS.findIndex(o => limitLevel(o.value) < limitLevel(value))
  return at < 0 ? [...LIMIT_OPTIONS, extra] : [...LIMIT_OPTIONS.slice(0, at), extra, ...LIMIT_OPTIONS.slice(at)]
}

/** A limit in words, for a sentence: "no limit", "up to PG and TV-PG". */
export function limitPhrase(stored: string | undefined | null): string {
  const label = limitLabel(stored)
  return label[0].toLowerCase() + label.slice(1)
}
