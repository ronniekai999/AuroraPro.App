// The content limits Settings offers for a profile.
//
// The server owns the rating ladder (internal/db/ratings.go) and validates
// every value written; this list is only which of its ceilings the app offers
// and what each is called. A label names the highest film rating and the
// highest TV rating its ceiling lets through, which is a claim about that
// ladder, so profileLimits.test.ts reads the ladder from the server's source
// and fails if a label stops being true.
//
// Each value is the TV rating of its tier, not the film one, because the
// ladder puts TV-PG above PG and TV-14 above PG-13: a ceiling of "PG" hides
// TV-PG, and "PG-13" hides TV-14.

export interface LimitOption {
  /** What is stored: '' for none, otherwise a rating the ladder knows. */
  value: string
  label: string
}

export const NO_LIMIT = ''

export const LIMIT_OPTIONS: readonly LimitOption[] = [
  { value: NO_LIMIT, label: 'No limit' },
  { value: 'TV-14', label: 'Up to PG-13 and TV-14' },
  { value: 'TV-PG', label: 'Up to PG and TV-PG' },
  { value: 'TV-G', label: 'Up to G and TV-G' },
]

/** How the server spells a stored limit: trimmed, upper case. */
export function canonicalLimit(stored: string | undefined | null): string {
  return (stored ?? '').trim().toUpperCase()
}

/** The options to show for a profile whose stored limit is `stored`: the
 *  offered ones, plus the stored one when it is a ceiling this list does not
 *  offer (onboarding writes "PG"; the API accepts any rating on the ladder),
 *  so the control never shows a limit the profile does not have. */
export function limitOptionsFor(stored: string | undefined | null): readonly LimitOption[] {
  const value = canonicalLimit(stored)
  if (LIMIT_OPTIONS.some(o => o.value === value)) return LIMIT_OPTIONS
  return [...LIMIT_OPTIONS, { value, label: `Up to ${value}` }]
}

/** A limit in words, for a sentence: "no limit", "up to PG and TV-PG". */
export function limitPhrase(stored: string | undefined | null): string {
  const value = canonicalLimit(stored)
  const label = limitOptionsFor(value).find(o => o.value === value)?.label ?? 'No limit'
  return label[0].toLowerCase() + label.slice(1)
}
