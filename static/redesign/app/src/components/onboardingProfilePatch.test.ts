import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({}))
const { onboardingProfilePatch } = await import('./OnboardingFlow')

describe('onboardingProfilePatch', () => {
  const base = { name: ' Sam ', avatarId: null, age: 30 }

  it('carries the age-derived ceiling only when the slider was moved', () => {
    expect(onboardingProfilePatch({ ...base, ageTouched: false, ceilingLocked: false })).not.toHaveProperty('max_age_rating')
    expect(onboardingProfilePatch({ ...base, age: 10, ageTouched: true, ceilingLocked: false }))
      .toMatchObject({ name: 'Sam', max_age_rating: 'PG', maturity_pref: 0 })
  })

  // A profile with a ceiling cannot change it: a moved slider must not send
  // one, or onboarding would try to lift a kid's limit (the server refuses).
  // The account's only profile without a ceiling cannot take one (the
  // server answers 409 last_unrestricted_profile): the age still sets the
  // tone lean, and no ceiling is sent.
  it('sends no ceiling for the account\'s only profile without one', () => {
    const patch = onboardingProfilePatch({ ...base, age: 10, ageTouched: true, ceilingLocked: false, soleUnrestricted: true })
    expect(patch).not.toHaveProperty('max_age_rating')
    expect(patch).toMatchObject({ maturity_pref: 0 })
  })

  it('never sends a ceiling for a profile that already has one', () => {
    const patch = onboardingProfilePatch({ ...base, age: 30, ageTouched: true, ceilingLocked: true })
    expect(patch).not.toHaveProperty('max_age_rating')
    expect(patch).not.toHaveProperty('maturity_pref')
  })
})
