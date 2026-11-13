// @vitest-environment jsdom
//
// The onboarding flow's steps: who the profile is ("Make it yours"), what it
// likes ("Pick what you love"), and the build that ends it. The referral
// question has its own file (referralStep.test.tsx).
//
// What matters most here is what the age does. An age is optional; one that
// is entered sets the profile's content limit and its tone lean, except
// that the account's only profile without a limit gets the lean alone, and
// a profile that already has a limit cannot change it at all. The limit is
// written when setup finishes, by the build: so every way out that does not
// run the build asks first when it would leave that limit unset, and a build
// that fails says which of its writes landed. The patch itself is pinned in
// onboardingProfilePatch.test.ts; this pins the page that feeds it, through
// to what is sent.
//
// The numbers are the server's: five picks to finish, and "more like your
// picks" from the third.

import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OnboardingFlow } from './OnboardingFlow'
import { ProfilesGate } from './ProfilesGate'
import { APIError, type OnboardingStatus, type Profile, type ReferralPromptState } from '@/lib/api'

const api = vi.hoisted(() => ({
  submitReferral: vi.fn(async () => ({ pending: false, recorded: true })),
  skipOnboarding: vi.fn(async () => ({ skipped: true })),
  getOnboardingGrid: vi.fn(),
  saveOnboardingSeeds: vi.fn(),
  updateProfile: vi.fn(),
  getHeroPool: vi.fn(async () => []),
  getDiscoverRails: vi.fn(async () => []),
  getEngagementRails: vi.fn(async () => []),
}))
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

const STATUS: OnboardingStatus = {
  profile_id: 7, completed: false, eligible: true, library_embedded: true, min_picks: 5, threshold: 3, seed_count: 0,
}
const TITLES = [
  { id: 1, title: 'Kestrel', year: 2021, poster: '/p1.jpg' },
  { id: 2, title: 'Harbor Lights', year: 2019, poster: '/p2.jpg' },
  { id: 3, title: 'Paper Moons', year: 0, poster: '' },
  { id: 4, title: 'Ironwood', year: 2018, poster: '/p4.jpg' },
  { id: 5, title: 'Small Hours', year: 2020, poster: '/p5.jpg' },
  { id: 6, title: 'Glasshouse', year: 2022, poster: '/p6.jpg' },
  { id: 7, title: 'Copper Sky', year: 2017, poster: '/p7.jpg' },
  { id: 8, title: 'Field Notes', year: 2016, poster: '/p8.jpg' },
]
/** What the server offers once three are picked. */
const MORE = [{ id: 21, title: 'Blackwater County', year: 2015, poster: '/p21.jpg' }]
const FIVE = ['Kestrel (2021)', 'Harbor Lights (2019)', 'Ironwood (2018)', 'Small Hours (2020)', 'Glasshouse (2022)']
const FIVE_IDS = [1, 2, 4, 5, 6]

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: 7, user_id: 1, name: 'Sam', is_default: true, avatar_url: 'nebula:tidal', created_at: '', updated_at: '', ...over,
})
const PROMPT: ReferralPromptState = {
  pending: true, question: 'How did you hear about Aurora?', options: [{ key: 'friend', label: 'A friend' }],
}
/** A refusal as the server writes one. */
const refusal = (status: number, message: string, reason?: string) =>
  new APIError(status, message, { error: { code: status, message, ...(reason ? { reason } : {}) } })
const PICKS_REFUSED = () => refusal(400, "some picks aren't allowed for this profile's age rating")

type FlowProps = Parameters<typeof OnboardingFlow>[0]
function flow(over: Partial<FlowProps> = {}) {
  const onDone = vi.fn()
  const props: FlowProps = { profileId: 7, profile: profile(), status: STATUS, taste: true, referral: { pending: false }, onDone, ...over }
  const view = render(<OnboardingFlow {...props} />)
  return Object.assign(onDone, { rerender: (more: Partial<FlowProps>) => view.rerender(<OnboardingFlow {...props} {...more} />) })
}
const next = () => screen.getByRole('button', { name: /^(Continue|Finish)$/ })
const age = () => screen.getByLabelText(/^Age/) as HTMLInputElement
const ageNote = () => document.getElementById('ob-age-note')!.textContent
/** What the footer says Continue is waiting for: the step's one status. */
const waitingFor = () => within(screen.getByRole('contentinfo')).getByRole('status').textContent
const tile = (name: string) => screen.getByRole('button', { name })
const headerSkip = () => screen.getByRole('button', { name: 'Skip for now' })
const question = () => screen.queryByRole('alertdialog')
const patchOf = (call = 0) => (api.updateProfile.mock.calls[call] as unknown as [number, Record<string, unknown>])

/** From "Make it yours" to the titles, with five picked. */
async function pickFive(user: ReturnType<typeof userEvent.setup>) {
  await user.click(next())
  await user.click(await screen.findByRole('button', { name: FIVE[0] }))
  for (const name of FIVE.slice(1)) await user.click(tile(name))
}
/** Through to the build, and what the profile write carried. */
async function finish(user: ReturnType<typeof userEvent.setup>) {
  await pickFive(user)
  await user.click(next())
  await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1))
  return patchOf()
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockClear()
  api.getOnboardingGrid.mockReset().mockImplementation(async (opts: { selected?: number[] }) => (opts.selected ? MORE : TITLES))
  api.updateProfile.mockReset().mockResolvedValue({})
  api.saveOnboardingSeeds.mockReset().mockResolvedValue({})
  api.skipOnboarding.mockReset().mockResolvedValue({ skipped: true })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear() })

describe('onboarding: "Make it yours"', () => {
  // A profile on the list has a name; it may have no avatar yet.
  it('opens on its heading, as step 1 of 2, and says what Continue is waiting for', async () => {
    const user = userEvent.setup()
    flow({ profile: profile({ avatar_url: '' }) })
    expect(screen.getByRole('dialog', { name: 'Set up your Aurora' })).toHaveAttribute('aria-modal', 'true')
    const heading = screen.getByRole('heading', { level: 1, name: 'Make it yours' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByRole('img', { name: 'Step 1 of 2' })).toBeInTheDocument()
    const avatars = within(screen.getByRole('group', { name: 'Pick your avatar' })).getAllByRole('button')
    expect(avatars).toHaveLength(10)
    expect(avatars.every(a => a.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect(document.querySelector('[data-avatar-check]')).toBeNull()
    expect(next()).toBeDisabled()
    expect(waitingFor()).toBe('Pick an avatar to continue.')
    // No Back on the first step.
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Tidal' }))
    const tidal = screen.getByRole('button', { name: 'Tidal' })
    expect(tidal).toHaveAttribute('aria-pressed', 'true')
    // Chosen is marked by more than the ring, which the focus ring replaces
    // while the avatar has the focus: it carries the check a pick has.
    expect(tidal.querySelector('[data-avatar-check]')).not.toBeNull()
    expect(document.querySelectorAll('[data-avatar-check]')).toHaveLength(1)
    expect(next()).toBeEnabled()
    await user.clear(screen.getByLabelText('Name'))
    expect(next()).toBeDisabled()
    expect(waitingFor()).toBe('Enter a name to continue.')
    await user.type(screen.getByLabelText('Name'), '  ')
    expect(next()).toBeDisabled()
    await user.type(screen.getByLabelText('Name'), 'Sam')
    expect(next()).toBeEnabled()
    expect(waitingFor()).toBe('')
  })

  it('goes on with Enter in the name field, and only when it may', async () => {
    const user = userEvent.setup()
    flow({ profile: profile({ avatar_url: '' }) })
    await user.type(screen.getByLabelText('Name'), '{Enter}')
    // No avatar yet: Enter does nothing.
    expect(screen.getByRole('heading', { level: 1, name: 'Make it yours' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Ember' }))
    await user.type(screen.getByLabelText('Name'), '{Enter}')
    expect(await screen.findByRole('heading', { level: 1, name: 'Pick what you love' })).toBeInTheDocument()
  })

  it('starts from what the profile already has, with no age', () => {
    flow()
    expect(screen.getByLabelText('Name')).toHaveValue('Sam')
    expect(screen.getByRole('button', { name: 'Tidal' })).toHaveAttribute('aria-pressed', 'true')
    expect(age()).toHaveValue('')
    expect(next()).toBeEnabled()
  })

  // The limit is written when setup finishes, and the sentence says so:
  // typing the age writes nothing.
  it('says what an age will do, and when, before it is entered and as it is typed', async () => {
    const user = userEvent.setup()
    flow()
    expect(age()).toHaveAccessibleDescription(ageNote()!)
    // Said as it changes.
    expect(document.getElementById('ob-age-note')).toHaveAttribute('aria-live', 'polite')
    expect(ageNote()).toBe('When you finish setup, an age under 13 limits this profile to titles up to PG and TV-Y7, and one under 17 to titles up to PG-13 and TV-14. Leave it empty to change nothing.')
    await user.type(age(), '1')
    expect(ageNote()).toBe('Kids: when you finish setup, this profile will be limited to titles up to PG and TV-Y7.')
    await user.type(age(), '5')
    expect(ageNote()).toBe('Teen: when you finish setup, this profile will be limited to titles up to PG-13 and TV-14.')
    await user.clear(age())
    await user.type(age(), '3x4y9')
    // Digits only, two at most.
    expect(age()).toHaveValue('34')
    expect(ageNote()).toBe('Adult: no content limit. Suggestions follow what you watch.')
    await user.clear(age())
    expect(ageNote()).toMatch(/^When you finish setup, an age under 13 limits this profile/)
    expect(api.updateProfile).not.toHaveBeenCalled()
  })

  // A name can be 24 characters with no break in it.
  it('lets a long name wrap in a heading', async () => {
    flow({ taste: false, referral: PROMPT, profile: profile({ name: 'Wolfeschlegelsteinhausen' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Skip this question' }))
    const heading = await screen.findByRole('heading', { level: 1, name: 'That is all, Wolfeschlegelsteinhausen' })
    expect(heading.className.split(/\s+/)).toContain('[overflow-wrap:anywhere]')
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
  it('takes no age for a profile that already has a limit, and says the limit as Settings does', async () => {
    const user = userEvent.setup()
    flow({ profile: profile({ max_age_rating: 'PG' }) })
    expect(age()).toBeDisabled()
    expect(ageNote()).toBe('This profile is limited to titles up to PG and TV-Y7, so its age cannot be changed here.')
    const [, patch] = await finish(user)
    expect(patch).toEqual({ name: 'Sam', avatar_url: 'nebula:tidal' })
  })

  // An age typed while the profile had no limit must not ride along once it
  // has one (another device set it while this page was open): the field
  // locks, and what was typed writes nothing about content.
  it('writes nothing about content when the profile gains a limit after an age was typed', async () => {
    const user = userEvent.setup()
    const page = flow()
    await user.type(age(), '15')
    expect(ageNote()).toMatch(/^Teen: when you finish setup/)
    page.rerender({ profile: profile({ max_age_rating: 'PG' }) })
    expect(age()).toBeDisabled()
    expect(ageNote()).toBe('This profile is limited to titles up to PG and TV-Y7, so its age cannot be changed here.')
    const [, patch] = await finish(user)
    expect(patch).toEqual({ name: 'Sam', avatar_url: 'nebula:tidal' })
  })

  // That typed age would set nothing now, so leaving leaves nothing unset.
  it('asks nothing on the way out when the profile gained its limit after an age was typed', async () => {
    const user = userEvent.setup()
    const page = flow()
    await user.type(age(), '15')
    page.rerender({ profile: profile({ max_age_rating: 'PG' }) })
    await user.click(headerSkip())
    await waitFor(() => expect(page).toHaveBeenCalledTimes(1))
    expect(question()).toBeNull()
  })
})

// The limit is written by the build. A way out that does not run the build
// (the header's Skip, "Continue to Aurora" on an empty list, Skip after a
// build that failed) would leave a profile without the limit its page had
// just described, having said nothing. Each asks first.
describe('onboarding: leaving without finishing', () => {
  const ASK = 'Skip without setting a limit?'
  const WORDS = 'The age you entered would have limited this profile to titles up to PG and TV-Y7. Skipping now sets no limit and saves nothing from this page. You can set a limit in Settings, under Profiles and parental controls.'

  it('asks before the header\'s Skip leaves a limit unset, and sends nothing until it is answered', async () => {
    const user = userEvent.setup()
    const onDone = flow()
    await user.type(age(), '8')
    await user.click(headerSkip())
    const dialog = await screen.findByRole('alertdialog', { name: ASK })
    expect(dialog).toHaveTextContent(WORDS)
    // The answer that changes nothing comes first, and has the focus.
    const buttons = within(dialog).getAllByRole('button')
    expect(buttons.map(b => b.textContent)).toEqual(['Go back', 'Skip, no limit'])
    await waitFor(() => expect(buttons[0]).toHaveFocus())
    // And first to the eye where they stack: the app's dialogs draw their
    // buttons last first on a phone, and this one does not.
    const row = buttons[0].parentElement!.className.split(/\s+/)
    expect(row).toContain('flex-col')
    expect(row).not.toContain('flex-col-reverse')
    expect(api.skipOnboarding).not.toHaveBeenCalled()
    expect(api.updateProfile).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()

    // "Go back": nothing is sent, the page is as it was, and the focus is
    // back on what asked.
    await user.click(buttons[0])
    await waitFor(() => expect(question()).toBeNull())
    expect(api.skipOnboarding).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    expect(age()).toHaveValue('8')
    await waitFor(() => expect(headerSkip()).toHaveFocus())

    // "Skip, no limit": the skip, once, and nothing else.
    await user.click(headerSkip())
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Skip, no limit' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(api.skipOnboarding).toHaveBeenCalledTimes(1)
    expect(api.skipOnboarding).toHaveBeenCalledWith(7)
    expect(api.updateProfile).not.toHaveBeenCalled()
    expect(api.saveOnboardingSeeds).not.toHaveBeenCalled()
  })

  it('takes Escape as "Go back"', async () => {
    const user = userEvent.setup()
    const onDone = flow()
    await user.type(age(), '8')
    await user.click(headerSkip())
    await screen.findByRole('alertdialog', { name: ASK })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(question()).toBeNull())
    expect(api.skipOnboarding).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    // The flow is still there, with what was entered, and has the focus back.
    expect(age()).toHaveValue('8')
    await waitFor(() => expect(headerSkip()).toHaveFocus())
  })

  it('asks on the titles step too, where the age is no longer in sight', async () => {
    const user = userEvent.setup()
    flow()
    await user.type(age(), '14')
    await user.click(next())
    await screen.findByRole('heading', { level: 1, name: 'Pick what you love' })
    await user.click(headerSkip())
    expect(await screen.findByRole('alertdialog', { name: ASK })).toHaveTextContent('would have limited this profile to titles up to PG-13 and TV-14')
    expect(api.skipOnboarding).not.toHaveBeenCalled()
  })

  // No age, an adult's age, the account's only profile without a limit, a
  // profile that has its limit already: leaving discards no limit.
  it.each<[string, Partial<FlowProps>, string]>([
    ['no age was entered', {}, ''],
    ['the age is an adult\'s', {}, '30'],
    ['the age would set no limit on the account\'s only profile without one', { soleUnrestricted: true }, '8'],
  ])('skips straight away when %s', async (_why, over, typed) => {
    const user = userEvent.setup()
    const onDone = flow(over)
    if (typed) await user.type(age(), typed)
    await user.click(headerSkip())
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(question()).toBeNull()
    expect(api.skipOnboarding).toHaveBeenCalledTimes(1)
  })

  // The field is what counts, not what was once in it.
  it('skips straight away when a limiting age was entered and taken out again', async () => {
    const user = userEvent.setup()
    const onDone = flow()
    await user.type(age(), '8')
    await user.clear(age())
    await user.click(headerSkip())
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(question()).toBeNull()
  })

  it('skips straight away for a profile that already has its limit', async () => {
    const user = userEvent.setup()
    const onDone = flow({ profile: profile({ max_age_rating: 'PG' }) })
    await user.click(headerSkip())
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(question()).toBeNull()
  })

  // On a library with nothing to pick, Finish can never be pressed: this
  // button is the only way on, and it does not write the limit either.
  it('asks before "Continue to Aurora" on an empty list leaves a limit unset', async () => {
    const user = userEvent.setup()
    api.getOnboardingGrid.mockReset().mockResolvedValue([])
    const onDone = flow()
    await user.type(age(), '8')
    await user.click(next())
    const on = await screen.findByRole('button', { name: 'Continue to Aurora' })
    await user.click(on)
    const dialog = await screen.findByRole('alertdialog', { name: ASK })
    expect(api.skipOnboarding).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Go back' }))
    await waitFor(() => expect(question()).toBeNull())
    expect(api.skipOnboarding).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue to Aurora' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Continue to Aurora' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Skip, no limit' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(api.skipOnboarding).toHaveBeenCalledTimes(1)
    expect(api.updateProfile).not.toHaveBeenCalled()
  })

  it('goes on from an empty list straight away when no limit is at stake', async () => {
    const user = userEvent.setup()
    api.getOnboardingGrid.mockReset().mockResolvedValue([])
    const onDone = flow()
    await user.click(next())
    await user.click(await screen.findByRole('button', { name: 'Continue to Aurora' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(question()).toBeNull()
  })

  // The profile write is what was refused, so the limit is not set.
  it('asks before Skip after a build whose profile write failed', async () => {
    const user = userEvent.setup()
    api.updateProfile.mockReset().mockRejectedValue(new Error('offline'))
    const onDone = flow()
    await user.type(age(), '8')
    await pickFive(user)
    await user.click(next())
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Skip' }))
    const dialog = await screen.findByRole('alertdialog', { name: ASK })
    expect(api.skipOnboarding).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Skip, no limit' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(api.skipOnboarding).toHaveBeenCalledTimes(1)
  })

  // The limit was written before the build failed: skipping leaves no limit
  // unset, and the page says the limit is there.
  it('does not ask before Skip once the limit has been written, and says the limit is set', async () => {
    const user = userEvent.setup()
    api.saveOnboardingSeeds.mockReset().mockRejectedValue(refusal(500, 'failed to save picks'))
    const onDone = flow()
    await user.type(age(), '8')
    await pickFive(user)
    await user.click(next())
    expect(await screen.findByRole('alert')).toHaveTextContent('Your name and avatar are saved, and this profile is now limited to titles up to PG and TV-Y7. Your picks could not be saved just now. Try again, or skip for now.')
    expect(document.querySelector('[data-skip-keeps-limit]')).toHaveTextContent('Skipping leaves the limit set.')
    await user.click(screen.getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(question()).toBeNull()
    expect(api.skipOnboarding).toHaveBeenCalledTimes(1)
  })

  it('sends one skip for two presses', async () => {
    let land!: () => void
    api.skipOnboarding.mockReset().mockImplementation(() => new Promise(resolve => { land = () => resolve({ skipped: true }) }))
    const onDone = flow()
    fireEvent.click(headerSkip())
    fireEvent.click(headerSkip())
    await act(async () => { land() })
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(api.skipOnboarding).toHaveBeenCalledTimes(1)
  })
})

describe('onboarding: "Pick what you love"', () => {
  it('names each poster by its title, counts the picks, and says how many more it needs in one voice', async () => {
    const user = userEvent.setup()
    flow()
    await user.click(next())
    const heading = await screen.findByRole('heading', { level: 1, name: 'Pick what you love' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByRole('img', { name: 'Step 2 of 2' })).toBeInTheDocument()
    expect(screen.getByText('5 or more, from this library. Aurora uses them for your first picks.')).toBeInTheDocument()
    // The list is asked for once, for this profile, from its start.
    expect(api.getOnboardingGrid).toHaveBeenCalledTimes(1)
    expect(api.getOnboardingGrid.mock.calls[0][0]).toMatchObject({ profileId: 7, limit: 40, offset: 0 })
    const posters = await within(screen.getByRole('group', { name: 'Titles' })).findAllByRole('button')
    // A title with no year is named by its title alone.
    expect(posters.map(b => b.getAttribute('aria-label'))).toEqual([
      'Kestrel (2021)', 'Harbor Lights (2019)', 'Paper Moons', 'Ironwood (2018)', 'Small Hours (2020)', 'Glasshouse (2022)', 'Copper Sky (2017)', 'Field Notes (2016)',
    ])
    // The count is to look at; what is said as picks are made is the
    // footer's line. One status on the step, not two.
    const count = document.querySelector('[data-picked]')!
    expect(count).toHaveTextContent('0 picked')
    expect(count).not.toHaveAttribute('role')
    expect(count).not.toHaveAttribute('aria-live')
    expect(within(screen.getByRole('dialog', { name: 'Set up your Aurora' })).getAllByRole('status')).toHaveLength(1)
    expect(next()).toBeDisabled()
    expect(next()).toHaveTextContent('Finish')
    expect(waitingFor()).toBe('Pick 5 more to continue.')

    await user.click(posters[0])
    expect(posters[0]).toHaveAttribute('aria-pressed', 'true')
    expect(count).toHaveTextContent('1 picked')
    expect(waitingFor()).toBe('Pick 4 more to continue.')
    await user.click(posters[0])
    expect(posters[0]).toHaveAttribute('aria-pressed', 'false')
    expect(count).toHaveTextContent('0 picked')
    for (const i of [0, 1, 3, 4]) await user.click(posters[i])
    expect(next()).toBeDisabled()
    expect(waitingFor()).toBe('Pick 1 more to continue.')
    await user.click(posters[2])
    expect(next()).toBeEnabled()
    expect(waitingFor()).toBe('Aurora builds your first Tonight from these. It takes a few seconds.')

    // Back keeps what was entered.
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Sam')
  })

  // The state every real visit is in before Finish can be pressed: the
  // server offers more like the picks from the third one.
  it('adds "More like your picks" once three are picked, asked of the server with the picks', async () => {
    const user = userEvent.setup()
    flow()
    await user.click(next())
    await user.click(await screen.findByRole('button', { name: FIVE[0] }))
    await user.click(tile(FIVE[1]))
    await new Promise(done => setTimeout(done, 600))
    expect(api.getOnboardingGrid).toHaveBeenCalledTimes(1)
    await user.click(tile(FIVE[2]))
    const more = await screen.findByRole('group', { name: 'More like your picks' }, { timeout: 2000 })
    expect(api.getOnboardingGrid.mock.calls[1][0]).toMatchObject({ profileId: 7, limit: 24, offset: 0, selected: [1, 2, 4] })
    expect(screen.getByRole('heading', { level: 2, name: 'More like your picks' })).toBeInTheDocument()
    // A title from there is a pick like any other.
    await user.click(within(more).getByRole('button', { name: 'Blackwater County (2015)' }))
    await user.click(tile(FIVE[3]))
    expect(next()).toBeEnabled()
    await user.click(next())
    await waitFor(() => expect(api.saveOnboardingSeeds).toHaveBeenCalledWith([1, 2, 4, 21, 5], 7))
  })

  // The title is the tile; the picture is drawn over it. So a tile says
  // which title it is while its picture is on the way, when the picture
  // fails, and when there is none.
  it('shows a title\'s name under its picture, and when the picture fails to load', async () => {
    const user = userEvent.setup()
    flow()
    await user.click(next())
    const kestrel = await screen.findByRole('button', { name: 'Kestrel (2021)' })
    expect(kestrel).toHaveTextContent('Kestrel')
    expect(kestrel.querySelector('img')).toHaveAttribute('src', '/p1.jpg')
    // The name is not said twice: the button is named by its label.
    expect(kestrel.querySelector('img')!.previousElementSibling).toHaveAttribute('aria-hidden', 'true')
    // No picture at all: the same tile, with no image.
    expect(tile('Paper Moons')).toHaveTextContent('Paper Moons')
    expect(tile('Paper Moons').querySelector('img')).toBeNull()
    // The picture fails: it is taken away, and the name is what is left.
    fireEvent.error(kestrel.querySelector('img')!)
    expect(kestrel.querySelector('img')).toBeNull()
    expect(kestrel).toHaveTextContent('Kestrel')
    // The others keep theirs.
    expect(tile('Harbor Lights (2019)').querySelector('img')).not.toBeNull()
  })

  it('dims every tile that is not picked alike, with or without a picture', async () => {
    const user = userEvent.setup()
    flow()
    await user.click(next())
    await user.click(await screen.findByRole('button', { name: 'Kestrel (2021)' }))
    const dimmed = (name: string) => tile(name).firstElementChild!.className.split(/\s+/).includes('opacity-[0.72]')
    expect(dimmed('Kestrel (2021)')).toBe(false)
    expect(dimmed('Harbor Lights (2019)')).toBe(true)
    expect(dimmed('Paper Moons')).toBe(true)
  })

  describe('"Show more"', () => {
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, title: `Title ${from + i}`, year: 2000, poster: '/p.jpg' }))

    it('keeps the focus while more are fetched, and asks from where the list ends', async () => {
      const user = userEvent.setup()
      let land!: (items: unknown[]) => void
      api.getOnboardingGrid.mockReset().mockResolvedValueOnce(page(100, 40)).mockImplementationOnce(() => new Promise(resolve => { land = resolve }))
      flow()
      await user.click(next())
      const more = await screen.findByRole('button', { name: 'Show more' })
      more.focus()
      await user.keyboard('{Enter}')
      expect(api.getOnboardingGrid.mock.calls[1][0]).toMatchObject({ profileId: 7, limit: 40, offset: 40 })
      const loading = screen.getByRole('button', { name: 'Loading…' })
      expect(loading).toBe(more)
      expect(loading).toHaveAttribute('aria-disabled', 'true')
      expect(loading).not.toBeDisabled()
      expect(loading).toHaveFocus()
      // A second press while it loads asks for nothing more.
      await user.keyboard('{Enter}')
      expect(api.getOnboardingGrid).toHaveBeenCalledTimes(2)
      // A full page: there may be more, and the button stays, with the focus.
      await act(async () => { land(page(200, 40)) })
      expect(screen.getByRole('button', { name: 'Show more' })).toHaveFocus()
      expect(waitingFor()).toBe('Pick 5 more to continue.')
    })

    // The button goes when the list has run out, and the focus it held
    // must not fall to the page.
    it('puts the focus on the first title of a last, short page, and says that is everything', async () => {
      const user = userEvent.setup()
      api.getOnboardingGrid.mockReset().mockResolvedValueOnce(page(100, 40)).mockResolvedValueOnce(page(200, 3))
      flow()
      await user.click(next())
      const more = await screen.findByRole('button', { name: 'Show more' })
      more.focus()
      await user.keyboard('{Enter}')
      await waitFor(() => expect(screen.queryByRole('button', { name: /Show more|Loading…/ })).toBeNull())
      await waitFor(() => expect(tile('Title 200 (2000)')).toHaveFocus())
      expect(waitingFor()).toBe('That is every title. Pick 5 more to continue.')
    })

    it('puts the focus on the last title when the last page adds none', async () => {
      const user = userEvent.setup()
      api.getOnboardingGrid.mockReset().mockResolvedValueOnce(page(100, 40)).mockResolvedValueOnce([])
      flow()
      await user.click(next())
      const more = await screen.findByRole('button', { name: 'Show more' })
      more.focus()
      await user.keyboard('{Enter}')
      await waitFor(() => expect(tile('Title 139 (2000)')).toHaveFocus())
      expect(screen.queryByRole('button', { name: /Show more|Loading…/ })).toBeNull()
      expect(waitingFor()).toBe('That is every title. Pick 5 more to continue.')
    })

    it('and when the page cannot be read', async () => {
      const user = userEvent.setup()
      api.getOnboardingGrid.mockReset().mockResolvedValueOnce(page(100, 40)).mockRejectedValueOnce(new Error('offline'))
      flow()
      await user.click(next())
      const more = await screen.findByRole('button', { name: 'Show more' })
      more.focus()
      await user.keyboard('{Enter}')
      await waitFor(() => expect(tile('Title 139 (2000)')).toHaveFocus())
    })

    it('leaves the focus with a person who has moved on while it loaded', async () => {
      const user = userEvent.setup()
      let land!: (items: unknown[]) => void
      api.getOnboardingGrid.mockReset().mockResolvedValueOnce(page(100, 40)).mockImplementationOnce(() => new Promise(resolve => { land = resolve }))
      flow()
      await user.click(next())
      await user.click(await screen.findByRole('button', { name: 'Show more' }))
      tile('Title 100 (2000)').focus()
      await act(async () => { land(page(200, 3)) })
      await waitFor(() => expect(screen.queryByRole('button', { name: /Show more|Loading…/ })).toBeNull())
      expect(tile('Title 100 (2000)')).toHaveFocus()
    })
  })
})

describe('onboarding: with the question owed', () => {
  it('is three steps, and the last says what happens next', async () => {
    const user = userEvent.setup()
    flow({ referral: PROMPT })
    expect(screen.getByRole('img', { name: 'Step 1 of 3' })).toBeInTheDocument()
    await pickFive(user)
    // Not the last step now: it leads to the question.
    expect(next()).toHaveTextContent('Continue')
    expect(waitingFor()).toBe('Rating or saving a title later counts too.')
    await user.click(next())
    expect(screen.getByRole('heading', { level: 1, name: 'One quick thing' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Step 3 of 3' })).toBeInTheDocument()
    // The question, and that it need not be answered. Nothing about who
    // asked: the page is not told.
    expect(document.querySelector('[data-referral-ask]')).toHaveTextContent(/^How did you hear about Aurora\? It is optional\.$/)
    expect(screen.getByText('Welcome, Sam. After this Aurora builds your first Tonight from the 5 titles you picked. It takes a few seconds.')).toBeInTheDocument()
    expect(next()).toHaveTextContent('Finish')
    expect(next()).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Skip this question' }))
    expect(api.submitReferral).toHaveBeenCalledWith({ skip: true })
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('heading', { level: 1, name: 'Building your Tonight' })).toBeInTheDocument()
  })

  // Two Skips with opposite outcomes on one screen would be a trap: "Skip
  // this question" goes on to the build, the header's discards everything.
  // The header's is not on the step that ends setup; Back reaches it.
  it('has no header Skip on the step that ends setup, and Back reaches it', async () => {
    const user = userEvent.setup()
    flow({ referral: PROMPT })
    expect(headerSkip()).toBeInTheDocument()
    await pickFive(user)
    expect(headerSkip()).toBeInTheDocument()
    await user.click(next())
    await screen.findByRole('heading', { level: 1, name: 'One quick thing' })
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Skip this question' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(headerSkip()).toBeInTheDocument()
  })

  it('sends the answer once and the build\'s writes once, on Finish with an answer', async () => {
    const user = userEvent.setup()
    flow({ referral: PROMPT })
    await pickFive(user)
    await user.click(next())
    await user.click(await screen.findByRole('radio', { name: 'A friend' }))
    expect(next()).toBeEnabled()
    await user.dblClick(next())
    await waitFor(() => expect(api.saveOnboardingSeeds).toHaveBeenCalledTimes(1))
    expect(api.submitReferral).toHaveBeenCalledTimes(1)
    expect(api.submitReferral).toHaveBeenCalledWith({ source: 'friend' })
    expect(api.updateProfile).toHaveBeenCalledTimes(1)
    expect(api.saveOnboardingSeeds).toHaveBeenCalledWith(FIVE_IDS, 7)
    expect(api.skipOnboarding).not.toHaveBeenCalled()
  })
})

describe('onboarding: the build', () => {
  it('saves the picks after the profile, and ends on the build', async () => {
    const user = userEvent.setup()
    flow()
    await finish(user)
    const heading = screen.getByRole('heading', { level: 1, name: 'Building your Tonight' })
    await waitFor(() => expect(heading).toHaveFocus())
    await waitFor(() => expect(api.saveOnboardingSeeds).toHaveBeenCalledWith(FIVE_IDS, 7))
    expect(api.updateProfile.mock.invocationCallOrder[0]).toBeLessThan(api.saveOnboardingSeeds.mock.invocationCallOrder[0])
    // Nothing to skip or go back to while it builds.
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    // Its row is the picks, and only the picks.
    const row = document.querySelector('[data-build-picks]')!
    expect(row.children).toHaveLength(5)
    // A pick's name, where its picture is missing, is not drawn under 12px.
    const names = row.querySelectorAll('[aria-hidden="true"]')
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) expect(name.className).toMatch(/(^|\s)text-\[1[2-9]px\]/)
    expect(row).toHaveTextContent('KestrelHarbor LightsIronwoodSmall HoursGlasshouse')
  })

  it('builds once for two presses of Finish', async () => {
    const user = userEvent.setup()
    flow()
    await pickFive(user)
    await user.dblClick(next())
    await waitFor(() => expect(api.saveOnboardingSeeds).toHaveBeenCalledTimes(1))
    expect(api.updateProfile).toHaveBeenCalledTimes(1)
  })

  /** To the build with the clock in hand: the build holds for a few seconds
   *  before it ends, and gives up after twenty. */
  async function buildOnFakeClock(over: Partial<FlowProps> = {}) {
    vi.useFakeTimers()
    const onDone = flow(over)
    await act(async () => {})
    fireEvent.click(next())
    await act(async () => {})
    for (const name of FIVE) fireEvent.click(tile(name))
    fireEvent.click(next())
    await act(async () => {})
    return onDone
  }
  const pass = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  const said = () => within(screen.getByRole('dialog', { name: 'Set up your Aurora' })).getAllByRole('status').map(s => s.textContent)

  it('warms what Tonight shows, says it is done, and ends', async () => {
    const onDone = await buildOnFakeClock()
    expect(api.updateProfile).toHaveBeenCalledTimes(1)
    expect(api.saveOnboardingSeeds).toHaveBeenCalledWith(FIVE_IDS, 7)
    expect(api.getHeroPool).toHaveBeenCalledWith(true, 7)
    expect(api.getDiscoverRails).toHaveBeenCalledWith(7)
    expect(api.getEngagementRails).toHaveBeenCalledWith(7)
    // Said aloud: that it started, then that it is done. The lines that
    // tick by on a timer are not in a live region.
    expect(said()).toEqual(['Your Tonight is ready.'])
    const line = document.querySelector('[data-build-line]')!
    expect(line).not.toHaveAttribute('role')
    expect(line).not.toHaveAttribute('aria-live')
    expect(onDone).not.toHaveBeenCalled()
    await pass(2000)
    expect(line).toHaveTextContent('Finding titles you might have missed…')
    expect(said()).toEqual(['Your Tonight is ready.'])
    await pass(2300)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('says it has started while the writes are out', async () => {
    api.updateProfile.mockReset().mockImplementation(() => new Promise(() => {}))
    await buildOnFakeClock()
    expect(said()).toEqual(['Saving your choices and building your Tonight.'])
    await pass(3000)
    expect(said()).toEqual(['Saving your choices and building your Tonight.'])
  })

  it('gives up on a profile write that never answers, having saved nothing it can vouch for', async () => {
    api.updateProfile.mockReset().mockImplementation(() => new Promise(() => {}))
    const onDone = await buildOnFakeClock()
    await pass(19_000)
    expect(screen.queryByRole('alert')).toBeNull()
    await pass(1_100)
    expect(screen.getByRole('alert')).toHaveTextContent(/^This is taking longer than expected\. Check your connection, then try again or skip for now\.$/)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('says what was saved when it is the picks that never answer', async () => {
    api.saveOnboardingSeeds.mockReset().mockImplementation(() => new Promise(() => {}))
    await buildOnFakeClock()
    await pass(20_100)
    expect(screen.getByRole('alert')).toHaveTextContent(/^Your name and avatar are saved\. The rest is taking longer than expected\. Check your connection, then try again or skip for now\.$/)
  })

  it('says what went wrong in the app\'s words, tries again with the focus on its heading, and can go on', async () => {
    const user = userEvent.setup()
    api.updateProfile.mockReset().mockRejectedValueOnce(new Error('The server refused the profile.')).mockResolvedValue({})
    const onDone = flow()
    await pickFive(user)
    await user.click(next())
    const alert = await screen.findByRole('alert')
    // In the app's words, not the server's; what the server said is logged.
    expect(alert).toHaveTextContent(/^Your choices could not be saved just now\. Try again, or skip for now\.$/)
    expect(console.warn).toHaveBeenCalledWith('onboarding: the build did not finish', expect.any(Error))
    expect(api.saveOnboardingSeeds).not.toHaveBeenCalled()
    const again = screen.getByRole('button', { name: 'Try again' })
    again.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
    // The button went with the failure; the focus did not fall to the page.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Building your Tonight' })).toHaveFocus()
    await waitFor(() => expect(api.saveOnboardingSeeds).toHaveBeenCalledTimes(1))
    expect(onDone).not.toHaveBeenCalled()
  })

  it('offers Skip beside Try again, which leaves the flow', async () => {
    const user = userEvent.setup()
    api.updateProfile.mockReset().mockRejectedValue(new Error('offline'))
    const onDone = flow()
    await pickFive(user)
    await user.click(next())
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(api.skipOnboarding).toHaveBeenCalledWith(7)
  })

  it('says the name and avatar are saved when only the picks failed, and reads no list again', async () => {
    const user = userEvent.setup()
    api.saveOnboardingSeeds.mockReset().mockRejectedValue(refusal(500, 'failed to save picks'))
    flow()
    await pickFive(user)
    const asked = api.getOnboardingGrid.mock.calls.length
    await user.click(next())
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Your name and avatar are saved\. Your picks could not be saved just now\. Try again, or skip for now\.$/)
    // No limit was written, so nothing says one was, and skipping is plain.
    expect(document.querySelector('[data-skip-keeps-limit]')).toBeNull()
    expect(api.getOnboardingGrid.mock.calls.length).toBe(asked)
  })

  // The profile write's own refusals, in the words Settings has for them.
  // Two of them are about the limit the age would set, and the same write
  // would meet them again: in place of a Try again that cannot work, the
  // way back to the age.
  const BACK = ' Without an age the rest can be saved: go back to your details, or skip for now.'
  it.each([
    [409, 'last_unrestricted_profile', `One profile has to stay without a limit, so that someone can manage the others. Take the limit off another profile first. Nothing was saved.${BACK}`, 'Back to your details'],
    [403, 'profile_restricted', `The profile you are watching as has a content limit, so it cannot change this. Switch to a profile without a limit first. Nothing was saved.${BACK}`, 'Back to your details'],
    // There is no list here to have been reloaded; and this one can be tried again.
    [409, 'profile_changed', 'This profile was changed on another device a moment ago. Try again. Nothing was saved.', 'Try again'],
  ])('words a refused profile write as Settings does, and offers what can work (%i %s)', async (status, reason, words, button) => {
    const user = userEvent.setup()
    api.updateProfile.mockReset().mockRejectedValue(refusal(status, 'a message written for logs', reason))
    flow()
    await user.type(age(), '8')
    await pickFive(user)
    await user.click(next())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(words)
    expect(api.saveOnboardingSeeds).not.toHaveBeenCalled()
    expect(document.querySelector('[data-skip-keeps-limit]')).toBeNull()
    const offered = within(alert.parentElement!).getAllByRole('button').map(b => b.textContent)
    expect(offered).toEqual([button, 'Skip'])
  })

  // A session on a restricted profile is refused any edit, whatever the
  // patch carries (another tab moved it onto a child's profile, say). With
  // no age entered there is no limit to take out: Try again, not the way
  // back to an age that is not the reason.
  it('does not send the person back to the age for a refusal of a patch that carried no limit', async () => {
    const user = userEvent.setup()
    api.updateProfile.mockReset().mockRejectedValue(refusal(403, 'a restricted profile can only edit itself', 'profile_restricted'))
    flow()
    await pickFive(user)
    await user.click(next())
    const alert = await screen.findByRole('alert')
    expect(patchOf()[1]).not.toHaveProperty('max_age_rating')
    expect(alert.textContent).toBe('The profile you are watching as has a content limit, so it cannot change this. Switch to a profile without a limit first. Nothing was saved.')
    expect(within(alert.parentElement!).getAllByRole('button').map(b => b.textContent)).toEqual(['Try again', 'Skip'])
  })

  // The question is owed, and was answered (or passed over with its own
  // Skip) before the build was refused: the way back to the details and on
  // to a second build neither asks it nor sends it again.
  it.each([
    ['answered', 'A friend'],
    ['skipped', null],
  ])('goes back to the details with the question already %s, and neither asks nor sends it again', async (_how, choice) => {
    const user = userEvent.setup()
    api.updateProfile.mockReset()
      .mockRejectedValueOnce(refusal(409, 'refused', 'last_unrestricted_profile'))
      .mockResolvedValue({})
    flow({ referral: PROMPT })
    await user.type(age(), '8')
    await pickFive(user)
    await user.click(next())
    await screen.findByRole('heading', { level: 1, name: 'One quick thing' })
    if (choice) {
      await user.click(screen.getByRole('radio', { name: choice }))
      await user.click(next())
    } else {
      await user.click(screen.getByRole('button', { name: 'Skip this question' }))
    }
    await user.click(await screen.findByRole('button', { name: 'Back to your details' }))
    expect(api.submitReferral).toHaveBeenCalledTimes(1)
    expect(api.submitReferral).toHaveBeenCalledWith(choice ? expect.objectContaining({ source: 'friend' }) : expect.objectContaining({ skip: true }))
    await user.clear(age())
    await user.click(next())
    // The picks end the flow now: the question is passed over.
    expect(next()).toHaveTextContent('Finish')
    await user.click(next())
    await waitFor(() => expect(api.saveOnboardingSeeds).toHaveBeenCalledWith(FIVE_IDS, 7))
    expect(screen.queryByRole('heading', { level: 1, name: 'One quick thing' })).toBeNull()
    expect(api.updateProfile).toHaveBeenCalledTimes(2)
    expect(api.submitReferral).toHaveBeenCalledTimes(1)
  })

  it('goes back to the details with the picks kept, and the next Finish is a new build', async () => {
    const user = userEvent.setup()
    api.updateProfile.mockReset()
      .mockRejectedValueOnce(refusal(409, 'refused', 'last_unrestricted_profile'))
      .mockResolvedValue({})
    flow()
    await user.type(age(), '8')
    await pickFive(user)
    await user.click(next())
    await user.click(await screen.findByRole('button', { name: 'Back to your details' }))
    const heading = screen.getByRole('heading', { level: 1, name: 'Make it yours' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.queryByRole('alert')).toBeNull()
    // The age is still what it was, to be changed.
    expect(age()).toHaveValue('8')
    await user.clear(age())
    await user.click(next())
    // The picks are as they were left.
    expect(document.querySelector('[data-picked]')).toHaveTextContent('5 picked')
    await user.click(next())
    await waitFor(() => expect(api.saveOnboardingSeeds).toHaveBeenCalledWith(FIVE_IDS, 7))
    expect(api.updateProfile).toHaveBeenCalledTimes(2)
    expect(patchOf(1)[1]).toEqual({ name: 'Sam', avatar_url: 'nebula:tidal' })
  })

  // The profile write was sent and has not answered. The page cannot say
  // that skipping sets no limit: the write may still land.
  describe('after a profile write that has not answered', () => {
    const UNKNOWN = 'Skip without knowing whether the limit was set?'

    async function stalled() {
      let answer!: { land: () => void; fail: (e: Error) => void }
      api.updateProfile.mockReset().mockImplementation(() => new Promise((resolve, reject) => { answer = { land: () => resolve({}), fail: reject } }))
      vi.useFakeTimers()
      const onDone = flow()
      await act(async () => {})
      fireEvent.change(age(), { target: { value: '8' } })
      fireEvent.click(next())
      await act(async () => {})
      for (const name of FIVE) fireEvent.click(tile(name))
      fireEvent.click(next())
      await act(async () => {})
      await pass(20_100)
      expect(screen.getByRole('alert')).toHaveTextContent(/^This is taking longer than expected\./)
      return { onDone, answer }
    }

    it('says the limit may or may not have been set, and where to look', async () => {
      const { onDone } = await stalled()
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
      await act(async () => {})
      const dialog = screen.getByRole('alertdialog', { name: UNKNOWN })
      expect(dialog).toHaveTextContent('The age you entered limits this profile to titles up to PG and TV-Y7. That was sent, and the server has not answered: the limit may or may not have been set. If you skip, look in Settings, under Profiles and parental controls, and set it there if it is not.')
      expect(dialog).not.toHaveTextContent(/sets no limit|saves nothing/)
      expect(within(dialog).getAllByRole('button').map(b => b.textContent)).toEqual(['Go back', 'Skip anyway'])
      expect(api.skipOnboarding).not.toHaveBeenCalled()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Skip anyway' }))
      await act(async () => {})
      expect(api.skipOnboarding).toHaveBeenCalledTimes(1)
      expect(onDone).toHaveBeenCalledTimes(1)
    })

    it('asks nothing once the write has landed after all, and says the limit is set', async () => {
      const { onDone, answer } = await stalled()
      await act(async () => { answer.land() })
      expect(document.querySelector('[data-skip-keeps-limit]')).toHaveTextContent('Skipping leaves the limit set.')
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
      await act(async () => {})
      expect(question()).toBeNull()
      expect(onDone).toHaveBeenCalledTimes(1)
    })

    // Write 1 (carrying the limit) stalls and the build gives up; Try again
    // sends write 2, which fails at once. Write 1 is still out: what is out
    // is the profile's, not the build's.
    async function stalledThenRetriedAndFailed() {
      let answer!: { land: () => void; fail: (e: Error) => void }
      api.updateProfile.mockReset()
        .mockImplementationOnce(() => new Promise((resolve, reject) => { answer = { land: () => resolve({}), fail: reject } }))
        .mockRejectedValueOnce(new Error('offline'))
      vi.useFakeTimers()
      const onDone = flow()
      await act(async () => {})
      fireEvent.change(age(), { target: { value: '8' } })
      fireEvent.click(next())
      await act(async () => {})
      for (const name of FIVE) fireEvent.click(tile(name))
      fireEvent.click(next())
      await act(async () => {})
      await pass(20_100)
      expect(screen.getByRole('alert')).toHaveTextContent(/^This is taking longer than expected\./)
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await act(async () => {})
      expect(api.updateProfile).toHaveBeenCalledTimes(2)
      expect(patchOf(1)[1]).toMatchObject({ max_age_rating: 'PG' })
      expect(screen.getByRole('alert')).toHaveTextContent(/^Your choices could not be saved just now\./)
      // Skip: the first write may still land, so skipping cannot be said
      // to set no limit.
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
      await act(async () => {})
      expect(screen.getByRole('alertdialog', { name: UNKNOWN })).toBeInTheDocument()
      expect(api.skipOnboarding).not.toHaveBeenCalled()
      return { onDone, answer }
    }

    it('does not say skipping sets no limit while a given-up write is out after a Try again, and says the limit is set when it lands', async () => {
      const { onDone, answer } = await stalledThenRetriedAndFailed()
      await act(async () => { answer.land() })
      // Nothing is left to ask: the question goes, and the page says the
      // limit is set and the age can no longer change it.
      expect(question()).toBeNull()
      // The build that sent the write was given up on: it stops at its
      // write, and sends no picks nor warms the rails.
      await pass(10_000)
      expect(api.saveOnboardingSeeds).not.toHaveBeenCalled()
      expect(api.getHeroPool).not.toHaveBeenCalled()
      expect(document.querySelector('[data-skip-keeps-limit]')).toHaveTextContent('Skipping leaves the limit set.')
      expect(api.skipOnboarding).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
      await act(async () => {})
      expect(question()).toBeNull()
      expect(api.skipOnboarding).toHaveBeenCalledTimes(1)
      expect(onDone).toHaveBeenCalledTimes(1)
    })

    // The failure's sentence and its buttons say what was saved as they are
    // drawn: a write given up on that lands after the failure was shown
    // changes both. Write 2 is refused as the server refuses it in this
    // race: once write 1 has set the limit, the acting profile is
    // restricted (403 profile_restricted, the manager's recheck).
    it('says what was saved, and offers Try again, once a given-up write lands under a later refusal', async () => {
      let answer!: { land: () => void }
      api.updateProfile.mockReset()
        .mockImplementationOnce(() => new Promise((resolve) => { answer = { land: () => resolve({}) } }))
        .mockRejectedValueOnce(refusal(403, 'restricted', 'profile_restricted'))
      vi.useFakeTimers()
      flow()
      await act(async () => {})
      fireEvent.change(age(), { target: { value: '8' } })
      fireEvent.click(next())
      await act(async () => {})
      for (const name of FIVE) fireEvent.click(tile(name))
      fireEvent.click(next())
      await act(async () => {})
      await pass(20_100)
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await act(async () => {})
      // Refused, with nothing landed: the way on is back to the age.
      expect(screen.getByRole('alert').textContent).toMatch(/Nothing was saved\. Without an age the rest can be saved/)
      expect(screen.getByRole('button', { name: 'Back to your details' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
      await act(async () => { answer.land() })
      expect(screen.getByRole('alert').textContent).toBe('Your name and avatar are saved, and this profile is now limited to titles up to PG and TV-Y7. Your picks could not be saved just now. Try again, or skip for now.')
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Back to your details' })).toBeNull()
      expect(document.querySelector('[data-skip-keeps-limit]')).toHaveTextContent('Skipping leaves the limit set.')
    })

    it('asks the plain question when a given-up write fails after a Try again has failed too', async () => {
      const { answer } = await stalledThenRetriedAndFailed()
      await act(async () => { answer.fail(new Error('offline')) })
      const dialog = screen.getByRole('alertdialog', { name: 'Skip without setting a limit?' })
      expect(dialog).toHaveTextContent('Skipping now sets no limit and saves nothing from this page.')
      expect(document.querySelector('[data-skip-keeps-limit]')).toBeNull()
      expect(within(dialog).getAllByRole('button').map(b => b.textContent)).toEqual(['Go back', 'Skip, no limit'])
    })

    it('asks the plain question once the write has failed after all', async () => {
      const { answer } = await stalled()
      await act(async () => { answer.fail(new Error('offline')) })
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
      await act(async () => {})
      expect(screen.getByRole('alertdialog', { name: 'Skip without setting a limit?' })).toHaveTextContent('Skipping now sets no limit and saves nothing from this page.')
    })
  })
})

// The grid is read before any limit exists. An age then sets one, the build
// writes it, and the picks are refused under it: some are above it. A retry
// would send the same picks for good.
describe('onboarding: picks refused under the limit the build has just written', () => {
  // Under PG the server no longer offers these two.
  const OVER = [2, 5]
  const UNDER_LIMIT = TITLES.filter(t => !OVER.includes(t.id))

  async function refused(user: ReturnType<typeof userEvent.setup>, reread: () => Promise<unknown>) {
    const onDone = flow()
    await user.type(age(), '10')
    await pickFive(user)
    // "More like your picks" is on the page by now, read before the limit.
    await screen.findByRole('button', { name: 'Blackwater County (2015)' }, { timeout: 2000 })
    // From here the server answers under the limit.
    api.saveOnboardingSeeds.mockReset().mockRejectedValueOnce(PICKS_REFUSED()).mockResolvedValue({})
    api.getOnboardingGrid.mockReset().mockImplementation(async (opts: { selected?: number[] }) => (opts.selected ? [] : reread()))
    await user.click(next())
    return onDone
  }

  it('reads the list again, takes out the picks no longer on it, and goes back to the picks to say so', async () => {
    const user = userEvent.setup()
    const onDone = await refused(user, async () => UNDER_LIMIT)
    // PUT 200, then the seeds 400, then the list read again as it was read.
    const notice = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-picks-removed]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(api.updateProfile).toHaveBeenCalledTimes(1)
    expect(api.saveOnboardingSeeds).toHaveBeenCalledTimes(1)
    expect(api.getOnboardingGrid.mock.calls[0][0]).toMatchObject({ profileId: 7, limit: 40, offset: 0 })
    expect(screen.getByRole('heading', { level: 1, name: 'Pick what you love' })).toBeInTheDocument()
    expect(notice.textContent).toBe('This profile is now limited to titles up to PG and TV-Y7, so the titles here were loaded again. 2 of your picks are no longer among them and were removed.')
    // It is what is read first.
    await waitFor(() => expect(notice).toHaveFocus())
    expect(screen.queryByRole('alert')).toBeNull()
    // The two are gone from the page; the three that are still offered are
    // still picked; the step says how many more it needs.
    expect(screen.queryByRole('button', { name: 'Harbor Lights (2019)' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Small Hours (2020)' })).toBeNull()
    // So is what was offered as "more like your picks": that was read
    // before the limit too, and is asked for again under it.
    expect(screen.queryByRole('button', { name: 'Blackwater County (2015)' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'More like your picks' })).toBeNull()
    for (const name of ['Kestrel (2021)', 'Ironwood (2018)', 'Glasshouse (2022)']) expect(tile(name)).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelector('[data-picked]')).toHaveTextContent('3 picked')
    expect(waitingFor()).toBe('Pick 2 more to continue.')
    expect(next()).toBeDisabled()
    expect(onDone).not.toHaveBeenCalled()

    // Two more, and Finish succeeds: the same profile write, the new picks.
    await user.click(tile('Copper Sky (2017)'))
    await user.click(tile('Field Notes (2016)'))
    await user.click(next())
    await waitFor(() => expect(api.saveOnboardingSeeds).toHaveBeenCalledTimes(2))
    expect(api.updateProfile).toHaveBeenCalledTimes(2)
    expect(patchOf(1)[1]).toEqual(patchOf(0)[1])
    expect(patchOf(1)[1]).toEqual({ name: 'Sam', avatar_url: 'nebula:tidal', max_age_rating: 'PG', maturity_pref: 0 })
    expect(api.saveOnboardingSeeds.mock.calls[1]).toEqual([[1, 4, 6, 7, 8], 7])
    expect(screen.getByRole('heading', { level: 1, name: 'Building your Tonight' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // The limit is in force from the moment it was written.
  it('locks the age and asks nothing on the way out, once the limit is written', async () => {
    const user = userEvent.setup()
    const onDone = await refused(user, async () => UNDER_LIMIT)
    await waitFor(() => expect(document.querySelector('[data-picks-removed]')).not.toBeNull())
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(age()).toBeDisabled()
    expect(age()).toHaveValue('10')
    expect(ageNote()).toBe('This profile is limited to titles up to PG and TV-Y7, so its age cannot be changed here.')
    await user.click(headerSkip())
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(question()).toBeNull()
  })

  // The re-read is part of the build. One that never answers must not
  // leave the build screen with no way out.
  it('gives up on a re-read that never answers, within the build\'s own wait, and offers the ways out', async () => {
    vi.useFakeTimers()
    api.saveOnboardingSeeds.mockReset().mockRejectedValue(PICKS_REFUSED())
    flow()
    await act(async () => {})
    fireEvent.change(age(), { target: { value: '10' } })
    fireEvent.click(next())
    await act(async () => {})
    for (const name of FIVE) fireEvent.click(tile(name))
    // The re-read is held; "more like your picks", asked for on a timer of
    // its own, is answered.
    let late!: (items: unknown[]) => void
    api.getOnboardingGrid.mockReset().mockImplementation((opts: { selected?: number[] }) =>
      (opts.selected ? Promise.resolve([]) : new Promise(resolve => { late = resolve })))
    fireEvent.click(next())
    await act(async () => {})
    // The profile is written, the picks are refused, the re-read is out.
    expect(api.updateProfile).toHaveBeenCalledTimes(1)
    expect(api.saveOnboardingSeeds).toHaveBeenCalledTimes(1)
    expect(api.getOnboardingGrid.mock.calls.filter(c => !(c[0] as { selected?: number[] }).selected)).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(19_000) })
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
    expect(screen.getByRole('alert')).toHaveTextContent(/^Your name and avatar are saved, and this profile is now limited to titles up to PG and TV-Y7\. The rest is taking longer than expected\. Check your connection, then try again or skip for now\.$/)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Building your Tonight' })).toBeInTheDocument()
    // An answer that comes after the build gave up changes nothing: the
    // person is not moved off the screen they were just told about.
    await act(async () => { late(TITLES.filter(t => t.id !== 2)) })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Building your Tonight' })).toBeInTheDocument()
    expect(document.querySelector('[data-picks-removed]')).toBeNull()
  })

  // A re-read given up on asks for no more pages.
  it('asks for no more pages of a re-read once it has been given up on', async () => {
    const user = userEvent.setup()
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, title: `Title ${from + i}`, year: 2000, poster: '/p.jpg' }))
    api.getOnboardingGrid.mockReset().mockImplementation(async (opts: { selected?: number[]; offset?: number }) => (opts.selected ? [] : page(100 + (opts.offset ?? 0), 40)))
    flow()
    await user.type(age(), '10')
    await user.click(next())
    await user.click(await screen.findByRole('button', { name: 'Show more' }))
    await screen.findByRole('button', { name: 'Title 140 (2000)' })
    await user.click(screen.getByRole('button', { name: 'Show more' }))
    await screen.findByRole('button', { name: 'Title 180 (2000)' })
    for (const n of [100, 101, 102, 150, 219]) await user.click(tile(`Title ${n} (2000)`))
    api.saveOnboardingSeeds.mockReset().mockRejectedValue(PICKS_REFUSED())
    // The first page of the re-read (120 titles were on the page, so two
    // pages) is held until the build has given up; every other is answered.
    let late!: (items: unknown[]) => void
    api.getOnboardingGrid.mockReset().mockImplementation((opts: { selected?: number[]; offset?: number; limit?: number }) =>
      (opts.selected ? Promise.resolve([])
        : opts.offset ? Promise.resolve(page(100 + opts.offset, opts.limit ?? 40))
          : new Promise(resolve => { late = resolve })))
    const rereads = () => api.getOnboardingGrid.mock.calls.filter(c => !(c[0] as { selected?: number[] }).selected).length
    vi.useFakeTimers()
    fireEvent.click(next())
    await act(async () => {})
    expect(api.saveOnboardingSeeds).toHaveBeenCalledTimes(1)
    expect(rereads()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(20_100) })
    expect(screen.getByRole('alert')).toHaveTextContent(/The rest is taking longer than expected\./)
    await act(async () => { late(page(100, 100)) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(rereads()).toBe(1)
  })

  // A title picked from "More like your picks" is not on the list that is
  // read again: it goes with the ones the limit hides, and is counted.
  it('takes out a pick that came from "More like your picks"', async () => {
    const user = userEvent.setup()
    flow()
    await user.type(age(), '10')
    await user.click(next())
    await user.click(await screen.findByRole('button', { name: FIVE[0] }))
    for (const name of [FIVE[2], FIVE[4], 'Copper Sky (2017)']) await user.click(tile(name))
    await user.click(await screen.findByRole('button', { name: 'Blackwater County (2015)' }, { timeout: 2000 }))
    api.saveOnboardingSeeds.mockReset().mockRejectedValueOnce(PICKS_REFUSED()).mockResolvedValue({})
    api.getOnboardingGrid.mockReset().mockImplementation(async (opts: { selected?: number[] }) => (opts.selected ? [] : TITLES))
    await user.click(next())
    const notice = await waitFor(() => {
      const el = document.querySelector('[data-picks-removed]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(notice).toHaveTextContent('1 of your picks is no longer among them and was removed.')
    expect(document.querySelector('[data-picked]')).toHaveTextContent('4 picked')
    expect(screen.queryByRole('button', { name: 'Blackwater County (2015)' })).toBeNull()
  })

  // As many titles as were on the page are read again, in pages the server
  // allows (a hundred at most).
  it('reads again as many titles as were on the page, a hundred at a time', async () => {
    const user = userEvent.setup()
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, title: `Title ${from + i}`, year: 2000, poster: '/p.jpg' }))
    api.getOnboardingGrid.mockReset().mockImplementation(async (opts: { selected?: number[]; offset?: number }) => (opts.selected ? [] : page(100 + (opts.offset ?? 0), 40)))
    flow()
    await user.type(age(), '10')
    await user.click(next())
    await user.click(await screen.findByRole('button', { name: 'Show more' }))
    await screen.findByRole('button', { name: 'Title 140 (2000)' })
    await user.click(screen.getByRole('button', { name: 'Show more' }))
    await screen.findByRole('button', { name: 'Title 180 (2000)' })
    for (const n of [100, 101, 102, 150, 219]) await user.click(tile(`Title ${n} (2000)`))
    api.saveOnboardingSeeds.mockReset().mockRejectedValueOnce(PICKS_REFUSED()).mockResolvedValue({})
    // Under the limit the server's list is the same but for one title,
    // which it leaves out before it cuts the page.
    const underLimit = page(100, 400).filter(t => t.id !== 150)
    api.getOnboardingGrid.mockReset().mockImplementation(async (opts: { selected?: number[]; offset?: number; limit?: number }) =>
      (opts.selected ? [] : underLimit.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 40))))
    await user.click(next())
    await waitFor(() => expect(document.querySelector('[data-picks-removed]')).not.toBeNull())
    const reread = api.getOnboardingGrid.mock.calls.map(c => c[0] as { limit: number; offset: number; selected?: number[] }).filter(o => !o.selected)
    expect(reread.map(o => [o.limit, o.offset])).toEqual([[100, 0], [20, 100]])
    expect(document.querySelector('[data-picked]')).toHaveTextContent('4 picked')
    expect(tile('Title 219 (2000)')).toHaveAttribute('aria-pressed', 'true')
  })

  it('says one pick was removed as one', async () => {
    const user = userEvent.setup()
    await refused(user, async () => TITLES.filter(t => t.id !== 2))
    const notice = await waitFor(() => {
      const el = document.querySelector('[data-picks-removed]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(notice.textContent).toBe('This profile is now limited to titles up to PG and TV-Y7, so the titles here were loaded again. 1 of your picks is no longer among them and was removed.')
    expect(waitingFor()).toBe('Pick 1 more to continue.')
  })

  // A 400 that is not about the limit (the picks are all still offered):
  // the failure is reported, with what was saved.
  it('reports the failure when the list still offers every pick', async () => {
    const user = userEvent.setup()
    await refused(user, async () => TITLES)
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Your name and avatar are saved, and this profile is now limited to titles up to PG and TV-Y7\. Your picks could not be saved just now\. Try again, or skip for now\.$/)
    expect(document.querySelector('[data-picks-removed]')).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Building your Tonight' })).toBeInTheDocument()
  })

  it('and when the list cannot be read again', async () => {
    const user = userEvent.setup()
    await refused(user, async () => { throw new Error('offline') })
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Your name and avatar are saved, and this profile is now limited to titles up to PG and TV-Y7\. Your picks could not be saved just now\./)
  })

  // Only the refusal the server gives picks it will not take (a 400) is
  // this. Any other failure of the picks is a failure: nothing is read
  // again, and no pick is taken out behind the person's back.
  it('does not take picks out after any other failure of the picks', async () => {
    const user = userEvent.setup()
    flow()
    await user.type(age(), '10')
    await pickFive(user)
    api.saveOnboardingSeeds.mockReset().mockRejectedValue(refusal(500, 'failed to save picks'))
    api.getOnboardingGrid.mockReset().mockImplementation(async (opts: { selected?: number[] }) => (opts.selected ? [] : UNDER_LIMIT))
    await user.click(next())
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Your name and avatar are saved, and this profile is now limited to titles up to PG and TV-Y7\. Your picks could not be saved just now\./)
    expect(api.getOnboardingGrid).not.toHaveBeenCalled()
    expect(document.querySelector('[data-picks-removed]')).toBeNull()
  })

  // Without a limit written, a 400 from the picks is not this: nothing is
  // read again.
  it('does not read the list again for a refusal with no limit in force', async () => {
    const user = userEvent.setup()
    flow()
    await pickFive(user)
    api.saveOnboardingSeeds.mockReset().mockRejectedValue(refusal(400, "selected titles aren't ready for personalization yet"))
    const asked = api.getOnboardingGrid.mock.calls.length
    await user.click(next())
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Your name and avatar are saved\. Your picks could not be saved just now\./)
    expect(api.getOnboardingGrid.mock.calls.length).toBe(asked)
  })

  // The answer to the question was sent on the way to the build. Coming
  // back to the picks does not ask it, or send it, again.
  it('does not ask the question a second time on the way back to the build', async () => {
    const user = userEvent.setup()
    flow({ referral: PROMPT })
    await user.type(age(), '10')
    await pickFive(user)
    api.saveOnboardingSeeds.mockReset().mockRejectedValueOnce(PICKS_REFUSED()).mockResolvedValue({})
    api.getOnboardingGrid.mockReset().mockImplementation(async (opts: { selected?: number[] }) => (opts.selected ? [] : UNDER_LIMIT))
    await user.click(next())
    await user.click(await screen.findByRole('radio', { name: 'A friend' }))
    await user.click(next())
    await waitFor(() => expect(document.querySelector('[data-picks-removed]')).not.toBeNull())
    expect(api.submitReferral).toHaveBeenCalledTimes(1)
    await user.click(tile('Copper Sky (2017)'))
    await user.click(tile('Field Notes (2016)'))
    // The picks are the last step now, and the bar counts it so.
    expect(next()).toHaveTextContent('Finish')
    expect(screen.getByRole('img', { name: 'Step 2 of 2' })).toBeInTheDocument()
    await user.click(next())
    await waitFor(() => expect(api.saveOnboardingSeeds).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('heading', { level: 1, name: 'One quick thing' })).toBeNull()
    expect(api.submitReferral).toHaveBeenCalledTimes(1)
  })
})

// The "Who's watching?" picker is drawn over the flow (pick who you are,
// then set that profile up), and so is a PIN prompt. While either is up the
// keys are theirs.
describe('onboarding: under the profile picker', () => {
  const OTHER = profile({ id: 8, name: 'Robin', is_default: false, avatar_url: 'nebula:ember' })

  /** As the app mounts them: the picker, and the flow under it once the
   *  app knows the profile needs setting up. */
  function Stage({ withFlow }: { withFlow: boolean }) {
    const [gateOpen, setGateOpen] = useState(false)
    return (
      <>
        <ProfilesGate profiles={[profile(), OTHER]} activeProfileId={7} onSelect={() => true} ready onOpenChange={setGateOpen} />
        {withFlow && <OnboardingFlow profileId={7} profile={profile()} status={STATUS} taste referral={{ pending: false }} covered={gateOpen} onDone={() => {}} />}
      </>
    )
  }

  it('does not take the focus from the picker when it appears, and is out of reach until the picker goes', async () => {
    const user = userEvent.setup()
    const view = render(<Stage withFlow={false} />)
    const picker = await screen.findByRole('dialog', { name: "Who's watching?" })
    await waitFor(() => expect(picker.contains(document.activeElement)).toBe(true))
    const held = document.activeElement

    // The flow mounts underneath.
    view.rerender(<Stage withFlow />)
    const overlay = screen.getByRole('dialog', { name: 'Set up your Aurora', hidden: true })
    await act(async () => {})
    expect(document.activeElement).toBe(held)
    expect(overlay).toHaveAttribute('inert')

    // The picker's own keys still work.
    await user.keyboard('{ArrowRight}')
    expect(picker.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(held)

    // A profile is picked: the picker goes, and the flow takes the focus
    // it had waited for.
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: "Who's watching?" })).toBeNull())
    expect(overlay).not.toHaveAttribute('inert')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Make it yours' })).toHaveFocus())
  })

  it('takes the focus when it appears with nothing above it', async () => {
    flow()
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Make it yours' })).toHaveFocus())
    expect(screen.getByRole('dialog', { name: 'Set up your Aurora' })).not.toHaveAttribute('inert')
  })

  // Another dialog has the focus (a PIN prompt's field, say), and nothing
  // has told the flow it is covered yet.
  it('leaves the focus where it is when another dialog holds it', async () => {
    const prompt = document.createElement('div')
    prompt.setAttribute('role', 'alertdialog')
    const field = document.createElement('input')
    prompt.appendChild(field)
    document.body.appendChild(prompt)
    field.focus()
    flow()
    await act(async () => {})
    expect(field).toHaveFocus()
    prompt.remove()
  })

  // The page the flow has just covered is not "above" it: a control there
  // that had the focus gives it up, or the keys would go on working a page
  // nobody can see.
  it('takes the focus from the page it has just covered', async () => {
    const main = document.createElement('main')
    const link = document.createElement('button')
    main.appendChild(link)
    document.body.appendChild(main)
    link.focus()
    flow()
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Make it yours' })).toHaveFocus())
    main.remove()
  })

  // A step the person moved to themselves always takes it.
  it('takes the focus on a step the person moved to', async () => {
    const user = userEvent.setup()
    flow()
    await user.click(next())
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Pick what you love' })).toHaveFocus())
  })
})
