// Referral prompt — shared client logic (migration 046).
//
// "How did you hear about Aurora?", asked once of signups that came in through
// a provider whose invite-bypass toggle is on. Those signups skip the invite
// code, and the invite code was the only record of where an account came from.
//
// Two concerns live here rather than in the components that use them, because
// both are pure, both are easy to get subtly wrong, and both are worth testing
// without a DOM: the display order of the options, and the validation of the
// admin's option list.

export interface ReferralOption {
  key: string
  label: string
}

/** The implicit free-text option: always offered, always last, never listed. */
export const REFERRAL_OTHER_KEY = 'other'
/**
 * The one place this option's display text is written.
 *
 * It is product copy for an option the server does not store — configured
 * options carry admin-authored labels, this one does not — so the frontend
 * owns it, and the summary API deliberately returns a null label for the
 * `other` key rather than a second spelling of it. Every surface, user-facing
 * and admin, resolves through here: the admin sees the words the user saw,
 * which is already true of every other option and was not true of this one.
 */
export const REFERRAL_OTHER_LABEL = 'Something else'

/** Mirrors referralDetailMaxLen in internal/api/referral_handlers.go. */
export const REFERRAL_DETAIL_MAX = 200
/** Mirrors referralOptionsMaxCount / referralLabelMaxLen server-side. */
export const REFERRAL_OPTIONS_MAX = 12
export const REFERRAL_LABEL_MAX = 64
const REFERRAL_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

/**
 * Control, format, and line/paragraph separator characters — the ones that
 * change how surrounding text renders without being visible themselves.
 * Mirrors dropDeceptiveRune in internal/api/referral_handlers.go; the server
 * REJECTS admin strings containing them, so catching it here is the difference
 * between "Label contains a hidden character" on the offending row and a bare
 * "invalid value for setting" that names nothing.
 */
const DECEPTIVE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

export function hasDeceptiveRunes(s: string): boolean {
  return DECEPTIVE_RE.test(s)
}

/**
 * Returns the options in the order they should be displayed: the configured
 * options shuffled, then "other" appended.
 *
 * The shuffle is the point. Attribution surveys suffer well-documented primacy
 * bias — whichever option is listed first is over-picked, so a fixed order
 * doesn't just add noise, it systematically inflates one answer and makes the
 * whole dataset misleading. Randomising per respondent is the standard
 * correction. "Other" is exempt and pinned last: it is a catch-all, and
 * floating it into the middle of the list reads as a real option.
 *
 * `rng` is injectable so tests are deterministic; it must return [0, 1).
 */
export function shuffleReferralOptions(
  options: readonly ReferralOption[],
  rng: () => number = Math.random,
): ReferralOption[] {
  // Fisher-Yates over a copy — the caller's array is config, not scratch space.
  const out = options.filter(o => o.key !== REFERRAL_OTHER_KEY)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  out.push({ key: REFERRAL_OTHER_KEY, label: REFERRAL_OTHER_LABEL })
  return out
}

export interface ReferralOptionsIssue {
  /** Index into the edited rows, or -1 for a whole-list problem. */
  index: number
  message: string
}

/**
 * Validates the admin's option rows, mirroring parseReferralOptions in
 * internal/api/referral_handlers.go.
 *
 * The duplication is deliberate and the comment is the contract: the server's
 * settings-whitelist validator can only answer yes/no, so a rejected save would
 * surface as a bare "invalid value for setting" with no indication of WHICH row
 * is wrong. This produces per-row messages. The server remains the authority —
 * this never gates anything the server doesn't also check.
 */
export function validateReferralOptions(
  rows: readonly ReferralOption[],
  /**
   * Keys that are already stored, which the editor renders read-only because
   * renaming one orphans every answer that used it.
   *
   * This does NOT exempt them from validation — the server checks every key
   * unconditionally, so exempting one here would only move the failure to an
   * opaque save. It changes the MESSAGE, because "fix the key" is not an
   * instruction anyone can follow on a read-only field. See the branch below.
   */
  lockedKeys: ReadonlySet<string> = new Set(),
): ReferralOptionsIssue[] {
  const issues: ReferralOptionsIssue[] = []
  // An EMPTY list is legal and means "use the built-in defaults" — the same
  // contract the question field has, and what the editor's own copy promises.
  // Requiring at least one made the revert path unreachable.
  if (rows.length > REFERRAL_OPTIONS_MAX) {
    issues.push({ index: -1, message: `At most ${REFERRAL_OPTIONS_MAX} options.` })
  }
  const seen = new Set<string>()
  rows.forEach((row, index) => {
    const key = row.key.trim()
    const label = row.label.trim()
    // A locked key still has to satisfy the SAME rules — the server validates
    // every key unconditionally, so exempting one here would let Save look
    // enabled and then fail with a bare "invalid value for setting" naming no
    // row, which is precisely the opaque rejection this mirroring exists to
    // prevent. What changes for a locked row is the MESSAGE: the field is
    // read-only, so "fix the key" is not an instruction the admin can follow.
    // "Remove the row" is, and it is safe to say — the answers survive, keyed
    // by the same string, and the breakdown keeps reporting them.
    // parseReferralOptions is ALL-OR-NOTHING: one key it rejects means the
    // server discards the entire stored list and serves the built-in defaults,
    // so the operator's whole configuration is ALREADY offline. "This row is
    // invalid" reads like one bad entry in an otherwise working list; it is the
    // opposite, and it is the more urgent fact.
    //
    // The remedy is stated honestly too. Removing the row keeps its COUNTS —
    // answers are stored by key and the breakdown still totals them — but the
    // label is gone from every surface, and the key cannot be added back,
    // because the same pattern that rejects it here rejects it there. Saying
    // "its answers stay readable" implied more than that.
    const lockedNote = ' Until it is removed none of your options are in use —'
      + ' users are seeing the built-in defaults. Removing it keeps its answer counts,'
      + ' but its label will read as removed and the key cannot be added back.'
    if (key === REFERRAL_OTHER_KEY) {
      issues.push({
        index,
        message: lockedKeys.has(key)
          ? `Stored key "other" is reserved and cannot be listed.${lockedNote}`
          : '"other" is always offered and cannot be listed.',
      })
    } else if (!REFERRAL_KEY_RE.test(key)) {
      issues.push({
        index,
        message: lockedKeys.has(key)
          ? `Stored key "${key}" is no longer valid.${lockedNote}`
          : 'Key must be lowercase letters, numbers, dashes or underscores (max 32).',
      })
    }
    if (seen.has(key)) {
      issues.push({ index, message: `Duplicate key "${key}".` })
    }
    seen.add(key)
    if (!label) {
      issues.push({ index, message: 'Label is required.' })
    } else if ([...label].length > REFERRAL_LABEL_MAX) {
      issues.push({ index, message: `Label must be ${REFERRAL_LABEL_MAX} characters or fewer.` })
    } else if (hasDeceptiveRunes(label)) {
      issues.push({ index, message: 'Label contains a hidden or direction-changing character.' })
    }
  })
  return issues
}

/** Serialises rows for the `referral_prompt_options` setting (trimmed). */
export function serializeReferralOptions(rows: readonly ReferralOption[]): string {
  return JSON.stringify(rows.map(r => ({ key: r.key.trim(), label: r.label.trim() })))
}

/**
 * Parses a stored `referral_prompt_options` value into editable rows. Returns
 * [] for anything unparseable, which the editor renders as "using defaults" —
 * the same fallback the server applies, so the two agree about what an operator
 * is currently looking at.
 */
export function parseReferralOptionsSetting(raw: string): ReferralOption[] {
  if (!raw.trim()) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((o): o is ReferralOption =>
        !!o && typeof o === 'object'
        && typeof (o as ReferralOption).key === 'string'
        && typeof (o as ReferralOption).label === 'string')
      .map(o => ({ key: o.key, label: o.label }))
  } catch {
    return []
  }
}

/**
 * Resolves a stored source key to display text for the admin surfaces.
 *
 * A key with no matching option means the operator deleted that option after
 * users had already chosen it. Those answers are shown as "<removed: key>"
 * rather than dropped, because dropping them would quietly under-report history
 * every time someone tidies the list — the reason the column stores keys and
 * not labels in the first place.
 *
 * The implicit `other` key is NOT a removal: it has no stored option by design,
 * so it resolves to REFERRAL_OTHER_LABEL. Callers deciding whether to style a
 * row as removed must ask isRemovedSummaryRow, not whether a label was found.
 */
export function referralSourceLabel(key: string, options: readonly ReferralOption[]): string {
  if (key === REFERRAL_OTHER_KEY) return REFERRAL_OTHER_LABEL
  const hit = options.find(o => o.key === key)
  return hit ? hit.label : `<removed: ${key}>`
}

/**
 * Derives an option list for referralSourceLabel from the admin summary's
 * by_source rows — the option list AS THE SERVER SERVES IT.
 *
 * This exists because the obvious alternative shipped broken, in exactly the
 * shape the isRemovedSummaryRow comment below warns about. The Users table
 * resolved its Referral column by parsing the raw `referral_prompt_options`
 * setting — but an EMPTY setting is the normal state and means "the built-in
 * defaults are in use" (the server's promptConfig contract, and the editor's
 * own copy). Parsed client-side, empty became `[]`, which asserts "nothing is
 * configured", so every live default key rendered as "<removed: friend>" on
 * any instance whose operator never touched the list.
 *
 * The summary endpoint labels each answered key against the EFFECTIVE options
 * server-side, so its rows are the one admin-visible source that cannot drift
 * from what users were actually shown. Null-label rows are dropped, not mapped:
 * a deleted option must keep resolving to "<removed: key>", and the implicit
 * `other` must keep resolving through REFERRAL_OTHER_LABEL rather than gaining
 * a fake stored option.
 *
 * Completeness holds by construction: any key on a user row has at least one
 * answer, so it appears in the all-time summary — fetch with windowDays 0;
 * a windowed summary would drop labels for keys whose answers all pre-date it.
 */
export function referralOptionsFromSummary(
  rows: readonly { key: string; label: string | null }[],
): ReferralOption[] {
  return rows.flatMap(r => (r.label === null ? [] : [{ key: r.key, label: r.label }]))
}

/**
 * Whether a summary row describes an option the operator has since deleted —
 * the rows the breakdown dims as history rather than live configuration.
 *
 * Takes the WIRE SHAPE, deliberately. The previous signature asked for the
 * configured option list, which the breakdown panel does not have in scope and
 * never will: it renders the server's aggregate, not the settings. Its only
 * caller therefore passed `[]`, which asserts "nothing is configured" and so
 * marked every live option as deleted — the whole panel rendered as history.
 * A predicate that cannot be called correctly from the one place that needs it
 * is the wrong predicate, so this one asks for what that place actually holds.
 *
 * The server sends a null label for exactly two keys: one whose option was
 * deleted, and the implicit `other`, which never has a stored option. The key
 * separates them — `parseReferralOptions` refuses to store `other`, so no
 * configured option can ever collide with it.
 */
export function isRemovedSummaryRow(row: { key: string; label: string | null }): boolean {
  return row.label === null && row.key !== REFERRAL_OTHER_KEY
}
