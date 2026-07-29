// @vitest-environment jsdom
//
// The referral step's keyboard and announcement contract.
//
// This repo has shipped four `role="radiogroup"` widgets that declared the role
// without its keyboard contract (lib/radiogroup.ts:1-9), and the documented
// lesson is that a role without its contract is WORSE than no role: NVDA and
// JAWS switch into forms mode on entering a radio and hand the arrow keys to an
// application that then ignores them. The onboarding flow's own avatar/typeface
// /glow steps are still `aria-pressed` toggle groups for that reason.
//
// So the assertions here are deliberately the ones that caught the earlier
// bugs: the tab stop must ROVE (a tabIndex rendered off a ref does not
// re-render, so it silently doesn't), arrows must move AND check (focusing
// without selecting pinned `current` and made later options unreachable), and
// the Other field must be a labelled control announced when it appears.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OnboardingFlow } from './OnboardingFlow'
import type { OnboardingStatus, ReferralPromptState } from '@/lib/api'

const submitReferral = vi.hoisted(() => vi.fn(async () => ({ pending: false, recorded: true })))
const skipOnboarding = vi.hoisted(() => vi.fn(async () => ({ skipped: true })))

// The flow imports a wide slice of the API module; stub the whole thing so the
// step renders without a server. Only the referral calls are asserted.
vi.mock('@/lib/api', () => ({
  submitReferral,
  skipOnboarding,
  getOnboardingGrid: vi.fn(async () => []),
  saveOnboardingSeeds: vi.fn(async () => ({})),
  updateProfile: vi.fn(async () => ({})),
  getHeroPool: vi.fn(async () => []),
  getDiscoverRails: vi.fn(async () => []),
  getEngagementRails: vi.fn(async () => []),
}))

const STATUS: OnboardingStatus = {
  profile_id: 1,
  completed: true,
  eligible: false,
  library_embedded: false,
  min_picks: 5,
  threshold: 3,
  seed_count: 0,
}

const PROMPT: ReferralPromptState = {
  pending: true,
  question: 'How did you hear about Aurora?',
  options: [
    { key: 'friend', label: 'A friend' },
    { key: 'twitch', label: 'Twitch' },
    { key: 'discord', label: 'Discord' },
  ],
}

// taste=false renders the referral-only pass, so the step is on screen at mount
// with no taste grid to stub out.
const renderStep = (prompt: ReferralPromptState = PROMPT, onDone = vi.fn()) => {
  render(
    <OnboardingFlow profileId={1} profile={null} status={STATUS} taste={false}
      referral={prompt} onDone={onDone} />,
  )
  return onDone
}

// Identity, not structural equality: toEqual on DOM nodes deep-compares and
// reports "expected [button] to deeply equal [button]" for two different nodes
// that happen to share a shape.
const tabStops = (list: HTMLElement[]) => list.filter(r => r.getAttribute('tabindex') === '0')

beforeEach(() => {
  submitReferral.mockClear()
  skipOnboarding.mockClear()
})

describe('referral step — radiogroup contract', () => {
  it('is a radiogroup named by the question', () => {
    renderStep()
    expect(screen.getByRole('radiogroup')).toHaveAccessibleName('How did you hear about Aurora?')
  })

  it('renders every configured option plus the implicit Other', () => {
    renderStep()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(4)
    const labels = radios.map(r => r.textContent)
    for (const l of ['A friend', 'Twitch', 'Discord']) expect(labels).toContain(l)
    // Other is pinned last regardless of how the rest were shuffled.
    expect(radios[radios.length - 1].textContent).toBe('Something else')
  })

  it('exposes exactly one tab stop before any selection', () => {
    renderStep()
    expect(tabStops(screen.getAllByRole('radio'))).toHaveLength(1)
  })

  it('arrows MOVE AND CHECK, and the single tab stop follows', async () => {
    const user = userEvent.setup()
    renderStep()
    const radios = screen.getAllByRole('radio')

    radios[0].focus()
    await user.keyboard('{ArrowRight}')

    expect(radios[1]).toHaveFocus()
    // Move-and-check: focusing without checking is what made later options
    // unreachable in ProfilesGate, because `current` never advanced.
    expect(radios[1]).toHaveAttribute('aria-checked', 'true')
    expect(radios[0]).toHaveAttribute('aria-checked', 'false')
    // And the roving tabIndex must actually rove — this is the assertion a
    // ref-rendered tabIndex silently fails.
    expect(tabStops(radios)).toHaveLength(1)
    expect(tabStops(radios)[0]).toBe(radios[1])
  })

  it('wraps at both ends and honours Home/End', async () => {
    const user = userEvent.setup()
    renderStep()
    const radios = screen.getAllByRole('radio')
    const last = radios.length - 1

    radios[0].focus()
    await user.keyboard('{ArrowLeft}')
    expect(radios[last]).toHaveFocus()
    expect(radios[last]).toHaveAttribute('aria-checked', 'true')

    await user.keyboard('{ArrowRight}')
    expect(radios[0]).toHaveFocus()

    await user.keyboard('{End}')
    expect(radios[last]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(radios[0]).toHaveFocus()
  })

  it('leaves unrelated keys alone', async () => {
    const user = userEvent.setup()
    renderStep()
    const radios = screen.getAllByRole('radio')
    radios[0].focus()
    await user.keyboard('{PageDown}')
    expect(radios[0]).toHaveFocus()
    expect(tabStops(radios)).toHaveLength(1)
  })

  it('selects on click', async () => {
    const user = userEvent.setup()
    renderStep()
    const twitch = screen.getByRole('radio', { name: 'Twitch' })
    await user.click(twitch)
    expect(twitch).toHaveAttribute('aria-checked', 'true')
  })
})

describe('referral step — the Other free-text field', () => {
  it('is hidden until Other is chosen', () => {
    renderStep()
    expect(screen.queryByLabelText(/where, specifically/i)).not.toBeInTheDocument()
  })

  it('appears with a real label inside a live region when Other is chosen', async () => {
    const user = userEvent.setup()
    const { container } = { container: document.body }
    renderStep()
    await user.click(screen.getByRole('radio', { name: 'Something else' }))

    // getByLabelText proves the <label for> association — a placeholder alone
    // would not satisfy this, and placeholder-as-label is the failure mode.
    const field = screen.getByLabelText(/where, specifically/i)
    expect(field).toBeInTheDocument()
    // Its appearance must be announced, or a screen-reader user never learns a
    // new control showed up in response to their selection.
    expect(container.querySelector('[aria-live="polite"]')).toContainElement(field)
  })

  it('caps the note at the length the API enforces', async () => {
    const user = userEvent.setup()
    renderStep()
    await user.click(screen.getByRole('radio', { name: 'Something else' }))
    expect(screen.getByLabelText(/where, specifically/i)).toHaveAttribute('maxlength', '200')
  })

  it('hides again when a different option is chosen', async () => {
    const user = userEvent.setup()
    renderStep()
    await user.click(screen.getByRole('radio', { name: 'Something else' }))
    await user.click(screen.getByRole('radio', { name: 'Twitch' }))
    expect(screen.queryByLabelText(/where, specifically/i)).not.toBeInTheDocument()
  })
})

describe('referral step — skip is a real control', () => {
  it('is a button in the tab ring, not a decoration', () => {
    renderStep()
    const skip = screen.getByRole('button', { name: /skip this question/i })
    // A negative tabIndex would take it out of the tab ring — the "low-contrast
    // afterthought" failure this step is specifically supposed to avoid.
    expect(skip.getAttribute('tabindex')).not.toBe('-1')
  })

  it('records the skip and advances', async () => {
    const user = userEvent.setup()
    renderStep()
    await user.click(screen.getByRole('button', { name: /skip this question/i }))
    expect(submitReferral).toHaveBeenCalledWith({ skip: true })
    // Advanced off the question.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })
})

describe('referral step — submission', () => {
  const advance = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: /continue/i }))

  it('sends the chosen key, not its label', async () => {
    const user = userEvent.setup()
    renderStep()
    await user.click(screen.getByRole('radio', { name: 'Twitch' }))
    await advance(user)
    expect(submitReferral).toHaveBeenCalledWith({ source: 'twitch' })
  })

  it('sends the note alongside other', async () => {
    const user = userEvent.setup()
    renderStep()
    await user.click(screen.getByRole('radio', { name: 'Something else' }))
    await user.type(screen.getByLabelText(/where, specifically/i), 'a podcast')
    await advance(user)
    expect(submitReferral).toHaveBeenCalledWith({ source: 'other', detail: 'a podcast' })
  })

  it('omits an empty note rather than sending a blank detail', async () => {
    const user = userEvent.setup()
    renderStep()
    await user.click(screen.getByRole('radio', { name: 'Something else' }))
    await advance(user)
    expect(submitReferral).toHaveBeenCalledWith({ source: 'other' })
  })

  it('cannot continue without a choice — skip is the alternative', () => {
    renderStep()
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled()
  })

  it('lets the user through even when the write fails', async () => {
    const user = userEvent.setup()
    submitReferral.mockRejectedValueOnce(new Error('offline'))
    renderStep()
    await user.click(screen.getByRole('radio', { name: 'Twitch' }))
    await advance(user)
    // Attribution is worth less than a signup: a failed POST must not trap the
    // user on the question.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('submits only once even if the flow-level skip follows', async () => {
    const user = userEvent.setup()
    renderStep()
    await user.click(screen.getByRole('radio', { name: 'Twitch' }))
    await advance(user)
    await user.click(screen.getByRole('button', { name: /skip for now/i }))
    expect(submitReferral).toHaveBeenCalledTimes(1)
    expect(submitReferral).toHaveBeenCalledWith({ source: 'twitch' })
  })

  it('treats the flow-level skip DURING the question as declining it', async () => {
    const user = userEvent.setup()
    renderStep()
    // This is the attribution leak the referral-only pass exists to close: the
    // header skip is prominent, and a user who presses it here has seen the
    // question and declined, so it must resolve rather than stay pending.
    await user.click(screen.getByRole('button', { name: /skip for now/i }))
    expect(submitReferral).toHaveBeenCalledWith({ skip: true })
  })
})

describe('referral step — the machine', () => {
  it('does not render the question when the server says not pending', () => {
    renderStep({ pending: false })
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(submitReferral).not.toHaveBeenCalled()
  })

  it('falls back to a default question if the server omits one', () => {
    renderStep({ pending: true, question: '', options: [{ key: 'friend', label: 'A friend' }] })
    expect(screen.getByRole('radiogroup')).toHaveAccessibleName(/how did you hear/i)
  })

  it('renders the question as TEXT, never as markup', () => {
    renderStep({
      pending: true,
      question: 'Where did you <img src=x onerror=alert(1)> hear about us?',
      options: [{ key: 'friend', label: 'A friend' }],
    })
    // Admin-authored text reaching a user's browser: it must appear literally.
    expect(screen.getByRole('radiogroup')).toHaveAccessibleName(
      'Where did you <img src=x onerror=alert(1)> hear about us?',
    )
    expect(document.querySelector('img')).toBeNull()
  })

  it('skips the taste flow entirely in a referral-only pass', async () => {
    const user = userEvent.setup()
    renderStep()
    await user.click(screen.getByRole('button', { name: /skip this question/i }))
    // Lands on the send-off, and never touches the profile-scoped skip endpoint
    // — that flow was already complete or ineligible.
    expect(screen.getByRole('button', { name: /take me in/i })).toBeInTheDocument()
    expect(skipOnboarding).not.toHaveBeenCalled()
  })
})
