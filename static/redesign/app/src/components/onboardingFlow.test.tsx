// @vitest-environment jsdom
//
// The onboarding flow's steps: who the profile is ("Make it yours"), what it
// likes ("Pick what you love"), and the build that ends it. The referral
// question has its own file (referralStep.test.tsx).
//
// What matters most here is what the age does. An age is optional; one that
// is entered sets the profile's content limit and its tone lean, except
// that the account's only profile without a limit gets the lean alone, and
// a profile that already has a limit cannot change it at all. The patch
// itself is pinned in onboardingProfilePatch.test.ts; this pins the page
// that feeds it, through to what is sent.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OnboardingFlow } from './OnboardingFlow'
import type { OnboardingStatus, Profile, ReferralPromptState } from '@/lib/api'

const api = vi.hoisted(() => ({
  submitReferral: vi.fn(async () => ({ pending: false, recorded: true })),
  skipOnboarding: vi.fn(async () => ({ skipped: true })),
  getOnboardingGrid: vi.fn(),
  saveOnboardingSeeds: vi.fn(async () => ({})),
  updateProfile: vi.fn(async () => ({})),
  getHeroPool: vi.fn(async () => []),
  getDiscoverRails: vi.fn(async () => []),
  getEngagementRails: vi.fn(async () => []),
}))
vi.mock('@/lib/api', () => api)

const STATUS: OnboardingStatus = {
  profile_id: 7, completed: false, eligible: true, library_embedded: true, min_picks: 2, threshold: 9, seed_count: 0,
}
const TITLES = [
  { id: 1, title: 'Kestrel', year: 2021, poster: '/p1.jpg' },
  { id: 2, title: 'Harbor Lights', year: 2019, poster: '/p2.jpg' },
  { id: 3, title: 'Paper Moons', year: 0, poster: '' },
]
const profile = (over: Partial<Profile> = {}): Profile => ({
  id: 7, user_id: 1, name: 'Sam', is_default: true, avatar_url: 'nebula:tidal', created_at: '', updated_at: '', ...over,
})
const PROMPT: ReferralPromptState = {
  pending: true, question: 'How did you hear about Aurora?', options: [{ key: 'friend', label: 'A friend' }],
}

type FlowProps = Parameters<typeof OnboardingFlow>[0]
function flow(over: Partial<FlowProps> = {}) {
  const onDone = vi.fn()
  render(<OnboardingFlow profileId={7} profile={profile()} status={STATUS} taste referral={{ pending: false }} onDone={onDone} {...over} />)
  return onDone
}
const next = () => screen.getByRole('button', { name: /^(Continue|Finish)$/ })
const age = () => screen.getByLabelText(/^Age/) as HTMLInputElement
const ageNote = () => document.getElementById('ob-age-note')!.textContent
/** What the footer says Continue is waiting for. */
const waitingFor = () => within(screen.getByRole('contentinfo')).getByRole('status').textContent
/** From "Make it yours" through the picks to the build, and what was written. */
async function finish(user: ReturnType<typeof userEvent.setup>) {
  await user.click(next())
  await user.click(await screen.findByRole('button', { name: 'Kestrel (2021)' }))
  await user.click(screen.getByRole('button', { name: 'Harbor Lights (2019)' }))
  await user.click(next())
  await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1))
  return (api.updateProfile.mock.calls[0] as unknown as [number, Record<string, unknown>])
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockClear()
  api.getOnboardingGrid.mockReset().mockResolvedValue(TITLES)
  api.updateProfile.mockReset().mockResolvedValue({})
})

describe('onboarding: "Make it yours"', () => {
  it('opens on its heading, as step 1 of 2, and says what Continue is waiting for', async () => {
    const user = userEvent.setup()
    flow({ profile: null })
    expect(screen.getByRole('dialog', { name: 'Set up your Aurora' })).toHaveAttribute('aria-modal', 'true')
    const heading = screen.getByRole('heading', { level: 1, name: 'Make it yours' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByRole('img', { name: 'Step 1 of 2' })).toBeInTheDocument()
    const avatars = within(screen.getByRole('group', { name: 'Pick your avatar' })).getAllByRole('button')
    expect(avatars).toHaveLength(10)
    expect(avatars.every(a => a.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect(next()).toBeDisabled()
    expect(waitingFor()).toBe('Pick an avatar to continue.')
    // No Back on the first step.
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Tidal' }))
    expect(screen.getByRole('button', { name: 'Tidal' })).toHaveAttribute('aria-pressed', 'true')
    expect(next()).toBeDisabled()
    expect(waitingFor()).toBe('Enter a name to continue.')
    await user.type(screen.getByLabelText('Name'), '  ')
    expect(next()).toBeDisabled()
    await user.type(screen.getByLabelText('Name'), 'Sam')
    expect(next()).toBeEnabled()
    expect(waitingFor()).toBe('')
  })

  it('waits for an avatar as well as a name, whichever comes first', async () => {
    const user = userEvent.setup()
    flow({ profile: null })
    await user.type(screen.getByLabelText('Name'), 'Sam')
    expect(next()).toBeDisabled()
    expect(waitingFor()).toBe('Pick an avatar to continue.')
    await user.click(screen.getByRole('button', { name: 'Ember' }))
    expect(next()).toBeEnabled()
  })

  it('starts from what the profile already has, with no age', () => {
    flow()
    expect(screen.getByLabelText('Name')).toHaveValue('Sam')
    expect(screen.getByRole('button', { name: 'Tidal' })).toHaveAttribute('aria-pressed', 'true')
    expect(age()).toHaveValue('')
    expect(next()).toBeEnabled()
  })

  it('says what an age will do before it is entered, and as it is typed', async () => {
    const user = userEvent.setup()
    flow()
    expect(age()).toHaveAccessibleDescription(ageNote()!)
    expect(ageNote()).toBe('An age under 13 limits this profile to titles up to PG and TV-Y7, and one under 17 to titles up to PG-13 and TV-14. Leave it empty to change nothing.')
    await user.type(age(), '1')
    expect(ageNote()).toBe('Kids: this profile will be limited to titles up to PG and TV-Y7.')
    await user.type(age(), '5')
    expect(ageNote()).toBe('Teen: this profile will be limited to titles up to PG-13 and TV-14.')
    await user.clear(age())
    await user.type(age(), '3x4y9')
    // Digits only, two at most.
    expect(age()).toHaveValue('34')
    expect(ageNote()).toBe('Adult: no content limit. Suggestions follow what you watch.')
    await user.clear(age())
    expect(ageNote()).toMatch(/^An age under 13 limits this profile/)
  })
})

describe('onboarding: what an age writes', () => {
  it('writes nothing about content when no age was entered', async () => {
    const user = userEvent.setup()
    flow()
    const [id, patch] = await finish(user)
    expect(id).toBe(7)
    expect(patch).toEqual({ name: 'Sam', avatar_url: 'nebula:tidal' })
  })

  it('writes the limit and the lean of the age that was entered', async () => {
    const user = userEvent.setup()
    flow()
    await user.type(age(), '10')
    const [, patch] = await finish(user)
    expect(patch).toEqual({ name: 'Sam', avatar_url: 'nebula:tidal', max_age_rating: 'PG', maturity_pref: 0 })
  })

  it('writes nothing about content when the age was entered and taken out again', async () => {
    const user = userEvent.setup()
    flow()
    await user.type(age(), '10')
    await user.clear(age())
    const [, patch] = await finish(user)
    expect(patch).toEqual({ name: 'Sam', avatar_url: 'nebula:tidal' })
  })

  // The server refuses a limit on an account's only profile without one:
  // nothing on the account could lift a limit again.
  it('writes the lean and no limit for the account\'s only profile without a limit, and says so', async () => {
    const user = userEvent.setup()
    flow({ soleUnrestricted: true })
    expect(ageNote()).toBe('This is the account’s only profile without a content limit, so an age tunes what is suggested and sets no limit. To limit what a child sees, give them their own profile.')
    await user.type(age(), '10')
    expect(ageNote()).toBe('Kids: suggestions lean that way, and no content limit is set, because this is the account’s only profile without one. To limit what a child sees, give them their own profile.')
    expect(ageNote()).not.toMatch(/will be limited/)
    const [, patch] = await finish(user)
    expect(patch).toEqual({ name: 'Sam', avatar_url: 'nebula:tidal', maturity_pref: 0 })
    expect(patch).not.toHaveProperty('max_age_rating')
  })

  // A session acting as a profile with a limit cannot change that limit.
  it('takes no age for a profile that already has a limit, and writes nothing about content', async () => {
    const user = userEvent.setup()
    flow({ profile: profile({ max_age_rating: 'PG' }) })
    expect(age()).toBeDisabled()
    expect(ageNote()).toBe('This profile has a content limit (PG), so its age cannot be changed here.')
    const [, patch] = await finish(user)
    expect(patch).toEqual({ name: 'Sam', avatar_url: 'nebula:tidal' })
  })
})

describe('onboarding: "Pick what you love"', () => {
  it('names each poster by its title, counts the picks, and says how many more it needs', async () => {
    const user = userEvent.setup()
    flow()
    await user.click(next())
    const heading = await screen.findByRole('heading', { level: 1, name: 'Pick what you love' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByRole('img', { name: 'Step 2 of 2' })).toBeInTheDocument()
    expect(screen.getByText('2 or more, from this library. Aurora uses them for your first picks.')).toBeInTheDocument()
    const posters = await within(screen.getByRole('group', { name: 'Titles' })).findAllByRole('button')
    // A title with no year is named by its title alone.
    expect(posters.map(b => b.getAttribute('aria-label'))).toEqual(['Kestrel (2021)', 'Harbor Lights (2019)', 'Paper Moons'])
    // Nothing is written over the art; a title with no art shows its name.
    expect(posters[0].textContent).toBe('')
    expect(posters[2].textContent).toBe('Paper Moons')
    expect(screen.getByText('0 picked')).toHaveAttribute('role', 'status')
    expect(next()).toBeDisabled()
    expect(next()).toHaveTextContent('Finish')
    expect(waitingFor()).toBe('Pick 2 more to continue.')

    await user.click(posters[0])
    expect(posters[0]).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('1 picked')).toBeInTheDocument()
    expect(waitingFor()).toBe('Pick 1 more to continue.')
    await user.click(posters[0])
    expect(posters[0]).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('0 picked')).toBeInTheDocument()
    await user.click(posters[0])
    await user.click(posters[2])
    expect(next()).toBeEnabled()
    expect(waitingFor()).toBe('Aurora builds your first Tonight from these. It takes a few seconds.')

    // Back keeps what was entered.
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Sam')
  })

  it('saves the picks after the profile, and ends on the build', async () => {
    const user = userEvent.setup()
    flow()
    await finish(user)
    const heading = screen.getByRole('heading', { level: 1, name: 'Building your Tonight' })
    await waitFor(() => expect(heading).toHaveFocus())
    await waitFor(() => expect(api.saveOnboardingSeeds).toHaveBeenCalledWith([1, 2], 7))
    expect(api.updateProfile.mock.invocationCallOrder[0]).toBeLessThan(api.saveOnboardingSeeds.mock.invocationCallOrder[0])
    // Nothing to skip or go back to while it builds.
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
  })

  it('keeps the focus on "Show more" while more are fetched', async () => {
    const user = userEvent.setup()
    const page = Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, title: `Title ${i}`, year: 2000, poster: '/p.jpg' }))
    let land!: (items: unknown[]) => void
    api.getOnboardingGrid.mockResolvedValueOnce(page).mockImplementationOnce(() => new Promise(resolve => { land = resolve }))
    flow()
    await user.click(next())
    const more = await screen.findByRole('button', { name: 'Show more' })
    more.focus()
    await user.keyboard('{Enter}')
    const loading = screen.getByRole('button', { name: 'Loading…' })
    expect(loading).toBe(more)
    expect(loading).toHaveAttribute('aria-disabled', 'true')
    expect(loading).not.toBeDisabled()
    expect(loading).toHaveFocus()
    await act(async () => { land([]) })
    expect(screen.queryByRole('button', { name: /Show more|Loading…/ })).toBeNull()
  })
})

describe('onboarding: with the question owed', () => {
  it('is three steps, and the last says what happens next', async () => {
    const user = userEvent.setup()
    flow({ referral: PROMPT })
    expect(screen.getByRole('img', { name: 'Step 1 of 3' })).toBeInTheDocument()
    await user.click(next())
    await user.click(await screen.findByRole('button', { name: 'Kestrel (2021)' }))
    await user.click(screen.getByRole('button', { name: 'Harbor Lights (2019)' }))
    // Not the last step now: it leads to the question.
    expect(next()).toHaveTextContent('Continue')
    expect(waitingFor()).toBe('Rating or saving a title later counts too.')
    await user.click(next())
    expect(screen.getByRole('heading', { level: 1, name: 'One quick thing' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Step 3 of 3' })).toBeInTheDocument()
    expect(screen.getByText('Welcome, Sam. After this Aurora builds your first Tonight from the 2 titles you picked. It takes a few seconds.')).toBeInTheDocument()
    expect(next()).toHaveTextContent('Finish')
    expect(next()).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Skip this question' }))
    expect(api.submitReferral).toHaveBeenCalledWith({ skip: true })
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('heading', { level: 1, name: 'Building your Tonight' })).toBeInTheDocument()
  })
})

describe('onboarding: the build', () => {
  it('says what went wrong, tries again, and can be left', async () => {
    const user = userEvent.setup()
    api.updateProfile.mockReset().mockRejectedValueOnce(new Error('The server refused the profile.')).mockResolvedValue({})
    const onDone = flow()
    await user.click(next())
    await user.click(await screen.findByRole('button', { name: 'Kestrel (2021)' }))
    await user.click(screen.getByRole('button', { name: 'Harbor Lights (2019)' }))
    await user.click(next())
    const alert = await screen.findByRole('alert')
    // In the app's words, not the server's.
    expect(alert).toHaveTextContent('Your choices could not be saved just now. Try again, or skip for now.')
    expect(api.saveOnboardingSeeds).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(api.saveOnboardingSeeds).toHaveBeenCalledTimes(1))
    expect(onDone).not.toHaveBeenCalled()
  })

  it('offers Skip beside Try again, which leaves the flow', async () => {
    const user = userEvent.setup()
    api.updateProfile.mockReset().mockRejectedValue(new Error('offline'))
    const onDone = flow()
    await user.click(next())
    await user.click(await screen.findByRole('button', { name: 'Kestrel (2021)' }))
    await user.click(screen.getByRole('button', { name: 'Harbor Lights (2019)' }))
    await user.click(next())
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(api.skipOnboarding).toHaveBeenCalledWith(7)
  })
})
