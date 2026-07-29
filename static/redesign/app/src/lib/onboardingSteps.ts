// The onboarding flow's step machine.
//
// This used to be three module-level constants inside OnboardingFlow.tsx — the
// Step union, STEP_ORDER (navigation), and INPUT_STEPS (the progress bar and
// "Step N of M") — hand-kept in sync. That was fine while the flow was fixed,
// but the referral prompt is CONDITIONAL: it appears only for signups the
// server marked pending, and never for password or invited users. A conditional
// step needs a derived list, and deriving three lists by hand at three call
// sites is how they drift.
//
// Building them from one function also makes the machine testable without a
// DOM, which the flow has never had.

export type Step = 'avatar' | 'name' | 'age' | 'style' | 'titles' | 'referral' | 'welcome' | 'loading'

export interface StepMachine {
  /** Full navigation order, including the terminal welcome/loading steps. */
  order: readonly Step[]
  /** The steps the progress bar counts — "Step N of {inputs.length}". */
  inputs: readonly Step[]
}

export interface BuildStepsOptions {
  /** The server says this user still owes a referral answer. */
  referralPending: boolean
  /**
   * The taste-onboarding half of the flow applies (the profile is eligible and
   * hasn't completed it). When false, the only reason we're on screen at all is
   * the referral prompt, so the flow collapses to asking it and getting out of
   * the way — no identity steps, no taste grid, and no loading step, because
   * there are no seeds to save or rails to warm.
   *
   * That collapsed pass is what stops attribution from being lost to the
   * flow-level "Skip for now" button, and to libraries with no embeddings where
   * the taste flow never renders at all. Both leave a user permanently pending
   * and, without this, permanently unasked.
   */
  taste: boolean
}

const TASTE_INPUT_STEPS: readonly Step[] = ['avatar', 'name', 'age', 'style', 'titles']

export function buildSteps({ referralPending, taste }: BuildStepsOptions): StepMachine {
  if (!taste) {
    // Referral-only pass. 'welcome' still terminates the flow (its button calls
    // onDone directly), so the user gets an ending rather than an abrupt close.
    if (!referralPending) return { order: ['welcome'], inputs: [] }
    return { order: ['referral', 'welcome'], inputs: ['referral'] }
  }
  const inputs: Step[] = [...TASTE_INPUT_STEPS]
  if (referralPending) inputs.push('referral')
  return { order: [...inputs, 'welcome', 'loading'], inputs }
}

/** Next step after `step`, or null at the end of the order. */
export function nextStep(machine: StepMachine, step: Step): Step | null {
  const i = machine.order.indexOf(step)
  if (i < 0 || i >= machine.order.length - 1) return null
  return machine.order[i + 1]
}

/** Previous step before `step`, or null at the start of the order. */
export function prevStep(machine: StepMachine, step: Step): Step | null {
  const i = machine.order.indexOf(step)
  if (i <= 0) return null
  return machine.order[i - 1]
}
