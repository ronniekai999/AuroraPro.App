// Content-tone (maturity lean) options — one list, two consumers.
//
// WHAT THIS FIELD IS, because getting it wrong is easy and I did:
// `Profile.maturity_pref` is a SMALLINT constrained to {-1, 0, 1, 2} by
// migrations/041_profile_maturity_pref.up.sql, and it is a SOFT recall bias, not
// a filter:
//
//     -1  Auto    the recommender derives the lean from the dominant rating
//                 tier of the profile's watched/seeded titles
//      0  Family  G–PG / TV-G
//      1  Teen    PG-13 / TV-14
//      2  Mature  R / TV-MA / NC-17
//
// It nudges what surfaces first. It hides NOTHING — the hard ceiling is a
// different field, `Profile.max_age_rating`. So a label like "Kids-safe" is
// wrong twice over: wrong scale, and it implies parental filtering this dial
// does not do.
//
// Aurora Stage Phase 7a — extracted because a first attempt at the profile
// switcher's subtitle re-derived this from scratch and treated the value as an
// AGE, with thresholds (<=7 kids, <=13 family, <=16 teen) lifted from the
// onboarding age ladder, which is a different field on a different scale. The
// result: 0, 1 and 2 — the only non-sentinel values the database permits — all
// rendered "Kids-safe", and the other three labels were unreachable. A profile
// set to Mature displayed as Kids-safe.
//
// Having Settings' dial and the switcher's subtitle read the same list is what
// makes that class of drift unrepresentable rather than merely unlikely.

/** The only values the DB permits (CHECK maturity_pref BETWEEN -1 AND 2). */
export type MaturityPref = -1 | 0 | 1 | 2

/** Auto — the recommender infers the lean. The column's DEFAULT. */
export const MATURITY_AUTO: MaturityPref = -1

export interface MaturityOption {
  v: MaturityPref
  label: string
  desc: string
}

// Order + copy are Settings → Content Tone's, which is the surface that WRITES
// the field; the switcher only reports it.
export const MATURITY_OPTIONS: readonly MaturityOption[] = [
  { v: -1, label: 'Auto', desc: 'Follows what you watch (default)' },
  { v: 0, label: 'Family', desc: 'Gentle · G–PG / TV-G' },
  { v: 1, label: 'Teen', desc: 'PG-13 · TV-14' },
  { v: 2, label: 'Mature', desc: 'Intense · R · TV-MA' },
]

/**
 * Short label for a profile's lean, for the switcher's subtitle row.
 *
 * Returns null for Auto and for anything out of range, so the caller shows
 * nothing rather than a guess — Auto means "not chosen", and reporting a lean
 * the user never picked would be inventing a preference.
 *
 * "lean" is in the string on purpose: it keeps the subtitle from reading as a
 * content restriction. `max_age_rating` is the field that restricts.
 */
export function maturityLeanLabel(pref: number | undefined): string | null {
  if (pref === undefined) return null
  const opt = MATURITY_OPTIONS.find(o => o.v === pref)
  if (!opt || opt.v === MATURITY_AUTO) return null
  return `${opt.label} lean`
}
