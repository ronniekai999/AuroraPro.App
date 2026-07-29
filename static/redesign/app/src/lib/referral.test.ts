import { describe, it, expect } from 'vitest'
import {
  shuffleReferralOptions,
  validateReferralOptions,
  serializeReferralOptions,
  parseReferralOptionsSetting,
  referralSourceLabel,
  REFERRAL_OTHER_KEY,
  REFERRAL_OPTIONS_MAX,
  REFERRAL_LABEL_MAX,
  type ReferralOption,
} from './referral'
import { buildSteps, nextStep, prevStep } from './onboardingSteps'

const OPTS: ReferralOption[] = [
  { key: 'friend', label: 'A friend' },
  { key: 'twitch', label: 'Twitch' },
  { key: 'discord', label: 'Discord' },
  { key: 'reddit', label: 'Reddit' },
]

// A deterministic RNG so shuffle assertions are exact rather than statistical.
// Cycles a fixed sequence in [0,1).
function seededRng(seq: number[]): () => number {
  let i = 0
  return () => seq[i++ % seq.length]
}

describe('shuffleReferralOptions', () => {
  it('always ends with "other", which is never shuffled into the middle', () => {
    // Every rng extreme, because "other" is appended after the shuffle and must
    // not depend on the draw.
    for (const rng of [seededRng([0]), seededRng([0.999]), seededRng([0.5, 0.1, 0.9])]) {
      const out = shuffleReferralOptions(OPTS, rng)
      expect(out[out.length - 1].key).toBe(REFERRAL_OTHER_KEY)
      expect(out.slice(0, -1).some(o => o.key === REFERRAL_OTHER_KEY)).toBe(false)
    }
  })

  it('preserves every configured option exactly once', () => {
    const out = shuffleReferralOptions(OPTS, seededRng([0.3, 0.7, 0.1, 0.9]))
    const keys = out.map(o => o.key).filter(k => k !== REFERRAL_OTHER_KEY).sort()
    expect(keys).toEqual(['discord', 'friend', 'reddit', 'twitch'])
  })

  it('does not mutate the caller\'s array', () => {
    const input = [...OPTS]
    shuffleReferralOptions(input, seededRng([0.8, 0.2]))
    expect(input).toEqual(OPTS)
  })

  it('actually reorders — a fixed order would defeat the whole point', () => {
    // rng=0 sends each element to index 0 in turn, which reverses a 4-element
    // list under Fisher-Yates. If this ever equals the input order, the shuffle
    // has been stubbed out and primacy bias is back.
    const out = shuffleReferralOptions(OPTS, seededRng([0]))
    expect(out.slice(0, -1).map(o => o.key)).not.toEqual(OPTS.map(o => o.key))
  })

  it('drops an "other" that somehow appears in the configured list', () => {
    const withOther = [...OPTS, { key: REFERRAL_OTHER_KEY, label: 'Stale' }]
    const out = shuffleReferralOptions(withOther, seededRng([0.5]))
    expect(out.filter(o => o.key === REFERRAL_OTHER_KEY)).toHaveLength(1)
    expect(out[out.length - 1].label).not.toBe('Stale')
  })

  it('handles an empty list', () => {
    expect(shuffleReferralOptions([], seededRng([0.5]))).toEqual([
      { key: REFERRAL_OTHER_KEY, label: expect.any(String) },
    ])
  })
})

describe('validateReferralOptions', () => {
  const ok = (rows: ReferralOption[]) => expect(validateReferralOptions(rows)).toEqual([])
  const failsAt = (rows: ReferralOption[], index: number, match: RegExp) => {
    const issues = validateReferralOptions(rows)
    expect(issues.some(i => i.index === index && match.test(i.message))).toBe(true)
  }

  it('accepts a well-formed list', () => ok(OPTS))
  it('accepts keys with digits, dashes and underscores', () =>
    ok([{ key: 'yt-shorts_2', label: 'YouTube Shorts' }]))
  it('accepts a label at the cap', () =>
    ok([{ key: 'a', label: 'x'.repeat(REFERRAL_LABEL_MAX) }]))

  it('ACCEPTS an empty list — that is how an operator reverts to the defaults', () => {
    // Rejecting it made the editor's "leave blank to use the defaults" copy a
    // lie and left no path back to the built-in options: Save stayed disabled
    // forever once the last row was removed.
    ok([])
  })
  it('rejects too many options', () =>
    failsAt(
      Array.from({ length: REFERRAL_OPTIONS_MAX + 1 }, (_, i) => ({ key: `k${i}`, label: `L${i}` })),
      -1, /at most/i,
    ))
  it('rejects an uppercase key', () => failsAt([{ key: 'Friend', label: 'A' }], 0, /lowercase/i))
  it('rejects a key with a space', () => failsAt([{ key: 'a friend', label: 'A' }], 0, /lowercase/i))
  it('rejects an empty key', () => failsAt([{ key: '', label: 'A' }], 0, /lowercase/i))
  it('rejects a key starting with a dash', () => failsAt([{ key: '-a', label: 'A' }], 0, /lowercase/i))
  it('rejects an over-long key', () => failsAt([{ key: 'a'.repeat(33), label: 'A' }], 0, /lowercase/i))
  it('rejects an explicit "other" — it is implicit and not deletable', () =>
    failsAt([{ key: REFERRAL_OTHER_KEY, label: 'Other' }], 0, /always offered/i))
  it('flags the SECOND of a duplicate pair, not the first', () => {
    const issues = validateReferralOptions([
      { key: 'a', label: 'A' },
      { key: 'a', label: 'B' },
    ])
    expect(issues.some(i => i.index === 1 && /duplicate/i.test(i.message))).toBe(true)
    expect(issues.some(i => i.index === 0)).toBe(false)
  })
  it('rejects a missing label', () => failsAt([{ key: 'a', label: '  ' }], 0, /label is required/i))
  it('rejects an over-long label', () =>
    failsAt([{ key: 'a', label: 'x'.repeat(REFERRAL_LABEL_MAX + 1) }], 0, /characters or fewer/i))
  it('rejects a label with a hidden or direction-changing character', () =>
    failsAt([{ key: 'a', label: 'A\u202Eb' }], 0, /hidden or direction-changing/i))
  it('rejects a label with a zero-width space', () =>
    failsAt([{ key: 'a', label: 'A\u200Bb' }], 0, /hidden or direction-changing/i))

  it('does not flag a LOCKED key that today\'s pattern would reject', () => {
    // A stored key is a historical fact and the editor renders it read-only, so
    // flagging it would point an error at a field the admin cannot edit and
    // wedge Save with no escape but deleting the option — the exact answer-loss
    // the lock exists to prevent. Its label is still validated.
    const rows = [{ key: 'LegacyKey', label: 'Legacy' }]
    expect(validateReferralOptions(rows, new Set(['LegacyKey']))).toEqual([])
    expect(validateReferralOptions(rows).length).toBeGreaterThan(0)
  })

  it('still flags a locked row\'s LABEL, which is editable', () => {
    const issues = validateReferralOptions(
      [{ key: 'LegacyKey', label: '' }], new Set(['LegacyKey']))
    expect(issues.some(i => /label is required/i.test(i.message))).toBe(true)
  })

  it('counts label length in characters, not UTF-16 units', () => {
    // A cap-length emoji label is legal to the user and to the Go validator,
    // which counts runes. Counting .length would reject it.
    ok([{ key: 'a', label: '🎬'.repeat(REFERRAL_LABEL_MAX) }])
  })
})

describe('serialize / parse round-trip', () => {
  it('round-trips and trims', () => {
    const raw = serializeReferralOptions([{ key: ' friend ', label: ' A friend ' }])
    expect(parseReferralOptionsSetting(raw)).toEqual([{ key: 'friend', label: 'A friend' }])
  })
  it('returns [] for empty, malformed, or wrong-shaped values', () => {
    for (const raw of ['', '   ', 'not json', '{"key":"a"}', '[1,2,3]', 'null']) {
      expect(parseReferralOptionsSetting(raw)).toEqual([])
    }
  })
  it('drops entries missing key or label rather than yielding undefined fields', () => {
    expect(parseReferralOptionsSetting('[{"key":"a","label":"A"},{"key":"b"}]')).toEqual([
      { key: 'a', label: 'A' },
    ])
  })
})

describe('referralSourceLabel', () => {
  it('resolves a configured key to its current label', () =>
    expect(referralSourceLabel('twitch', OPTS)).toBe('Twitch'))
  it('renders "other" as Other', () =>
    expect(referralSourceLabel(REFERRAL_OTHER_KEY, OPTS)).toBe('Other'))
  it('marks a deleted option instead of hiding the answer', () =>
    expect(referralSourceLabel('myspace', OPTS)).toBe('<removed: myspace>'))
  it('follows a renamed label, since answers store the key', () =>
    expect(referralSourceLabel('twitch', [{ key: 'twitch', label: 'Twitch.tv' }])).toBe('Twitch.tv'))
})

describe('buildSteps', () => {
  it('omits the referral step when the server says not pending', () => {
    const m = buildSteps({ referralPending: false, taste: true })
    expect(m.order).toEqual(['avatar', 'name', 'age', 'style', 'titles', 'welcome', 'loading'])
    expect(m.inputs).toHaveLength(5)
  })

  it('inserts referral between titles and welcome, and counts it', () => {
    const m = buildSteps({ referralPending: true, taste: true })
    expect(m.order).toEqual(['avatar', 'name', 'age', 'style', 'titles', 'referral', 'welcome', 'loading'])
    expect(m.inputs).toHaveLength(6)
    expect(m.inputs[m.inputs.length - 1]).toBe('referral')
  })

  it('collapses to referral → welcome when only the referral is owed', () => {
    // The flow-skip and no-embeddings cases: nothing to seed, so no loading step.
    const m = buildSteps({ referralPending: true, taste: false })
    expect(m.order).toEqual(['referral', 'welcome'])
    expect(m.order).not.toContain('loading')
    expect(m.inputs).toEqual(['referral'])
  })

  it('has nothing to ask when neither applies', () => {
    const m = buildSteps({ referralPending: false, taste: false })
    expect(m.order).toEqual(['welcome'])
    expect(m.inputs).toEqual([])
  })

  it('never lets the progress bar exceed the step count', () => {
    for (const referralPending of [true, false]) {
      for (const taste of [true, false]) {
        const m = buildSteps({ referralPending, taste })
        expect(m.inputs.length).toBeLessThanOrEqual(m.order.length)
        for (const s of m.inputs) expect(m.order).toContain(s)
      }
    }
  })
})

describe('nextStep / prevStep', () => {
  const m = buildSteps({ referralPending: true, taste: true })
  it('walks forward through the referral step', () => {
    expect(nextStep(m, 'titles')).toBe('referral')
    expect(nextStep(m, 'referral')).toBe('welcome')
  })
  it('walks backward through it too', () => {
    expect(prevStep(m, 'welcome')).toBe('referral')
    expect(prevStep(m, 'referral')).toBe('titles')
  })
  it('skips it entirely when it is not in the machine', () => {
    const noRef = buildSteps({ referralPending: false, taste: true })
    expect(nextStep(noRef, 'titles')).toBe('welcome')
    expect(prevStep(noRef, 'welcome')).toBe('titles')
  })
  it('returns null at the ends', () => {
    expect(prevStep(m, 'avatar')).toBeNull()
    expect(nextStep(m, 'loading')).toBeNull()
  })
  it('returns null for a step not in the machine', () => {
    const noRef = buildSteps({ referralPending: false, taste: true })
    expect(nextStep(noRef, 'referral')).toBeNull()
    expect(prevStep(noRef, 'referral')).toBeNull()
  })
})
