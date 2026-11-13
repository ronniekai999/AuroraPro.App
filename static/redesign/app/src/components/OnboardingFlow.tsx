import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getOnboardingGrid,
  saveOnboardingSeeds,
  skipOnboarding,
  submitReferral,
  updateProfile,
  getHeroPool,
  getDiscoverRails,
  getEngagementRails,
  APIError,
  type UIMedia,
  type OnboardingStatus,
  type Profile,
  type ReferralPromptState,
} from '@/lib/api'
import { isRestrictedProfile } from '@/lib/profileSession'
import { limitPhrase } from '@/lib/profileLimits'
import { refusalMessage, refusalReason } from '@/lib/profileRefusal'
import { buildSteps, nextStep, prevStep, type Step } from '@/lib/onboardingSteps'
import {
  shuffleReferralOptions,
  REFERRAL_DETAIL_MAX,
  REFERRAL_OTHER_KEY,
  type ReferralOption,
} from '@/lib/referral'
import { nextRadioIndex } from '@/lib/radiogroup'
import { NEBULAS, NebulaAvatar, nebulaValue, parseNebula } from './NebulaAvatar'
import { AuroraMark } from './TopNav'
import { AuroraWordmark } from './AuroraWordmark'
import { SkeletonBlock } from './Skeletons'
import { ConfirmDialog } from './settings/ConfirmDialog'

interface OnboardingFlowProps {
  /** Active profile id, or null for the session's acting profile. */
  profileId: number | null
  /** The active profile, used to PRE-FILL identity steps so returning users
   *  aren't forced to re-enter (and their existing settings aren't clobbered). */
  profile?: Profile | null
  status: OnboardingStatus
  /**
   * Whether the taste half of the flow applies. False means the profile has
   * already completed (or can't run) taste onboarding and the ONLY reason we're
   * on screen is an unanswered referral prompt — see buildSteps.
   */
  taste: boolean
  /** Server-decided referral prompt state. Absent/not-pending hides the step. */
  referral?: ReferralPromptState | null
  /** The profile is the account's only one without a content limit, which
   *  the server refuses to give one (see onboardingProfilePatch). */
  soleUnrestricted?: boolean
  /** Something is drawn over the flow (the "Who's watching?" picker, a PIN
   *  prompt): the flow is out of reach until it goes. */
  covered?: boolean
  /** Called once everything is persisted and the rails are warmed. */
  onDone: () => void
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The build's own watchdog ran out: nothing answered in time. */
class BuildTimeout extends Error {}
/** How long the build waits for its writes, and for the re-read that can
 *  follow them, before it says so and offers a way out. */
const BUILD_WAIT_MS = 20_000

// ratingForAge maps a chosen age to the profile's content settings, matching the
// canonical rating ladder (internal/db/ratings.go): max_age_rating is a HARD
// ceiling expanded through that ladder, maturity_pref is the SOFT recall lean
// (-1 Auto — the server derives the lean from watched/seeded tiers / 0 family /
// 1 teen / 2 mature). Adults get Auto, not "no lean": the "Up to R · TV-MA"
// tag describes the unrestricted CEILING, while what surfaces first follows
// what they actually watch (an adult with an all-family history leans family
// until their history says otherwise, or they pick an explicit tone in
// Settings). "TV-14" (not "PG-13") is the teen cap so teen TV is included
// while R / TV-MA stay blocked.
function ratingForAge(age: number): { maxRating: string; maturityPref: number; tier: 'Kids' | 'Teen' | 'Adult' } {
  if (age < 13) return { maxRating: 'PG', maturityPref: 0, tier: 'Kids' }
  if (age < 17) return { maxRating: 'TV-14', maturityPref: 1, tier: 'Teen' }
  return { maxRating: '', maturityPref: -1, tier: 'Adult' }
}

// onboardingProfilePatch is the profile write that ends onboarding. Content
// settings (the age-derived ceiling and tone lean) ride along only when an
// age was entered, and never for a profile that already has a ceiling: the
// server refuses a restricted profile's ceiling change, and the age field is
// disabled for one. The account's only profile without a ceiling gets the
// tone lean but no ceiling: the server refuses that too, since nothing on an
// account whose every profile is restricted could lift a limit again, and a
// single-profile account used to get there in one entry of an age.
export function onboardingProfilePatch({ name, avatarId, age, ageTouched, ceilingLocked, soleUnrestricted = false }: {
  name: string
  avatarId: string | null
  age: number
  ageTouched: boolean
  ceilingLocked: boolean
  soleUnrestricted?: boolean
}): { name: string; avatar_url: string; max_age_rating?: string; maturity_pref?: number } {
  const patch: { name: string; avatar_url: string; max_age_rating?: string; maturity_pref?: number } = {
    name: name.trim(),
    avatar_url: nebulaValue(avatarId ?? 'aurora'),
  }
  if (ageTouched && !ceilingLocked) {
    const r = ratingForAge(age)
    if (!soleUnrestricted) patch.max_age_rating = r.maxRating
    patch.maturity_pref = r.maturityPref
  }
  return patch
}

/** Refusals of a profile write that carried a content limit which an age
 *  can avoid: the way on is back to the age. */
function fixableInDetails(reason: string | null | undefined): boolean {
  return reason === 'last_unrestricted_profile' || reason === 'profile_restricted'
}

/** A seeds write the server refused as a bad request. Under a limit this
 *  flow has just written, that is how it refuses picks above the limit; it
 *  has no code of its own for it, so the refusal is confirmed by what the
 *  grid no longer offers (see recoverPicksUnderLimit). */
function refusedAsBadRequest(e: unknown): boolean {
  return e instanceof APIError && e.status === 400
}

const LOADING_MESSAGES = [
  'Reading what you picked…',
  'Going through your library…',
  'Finding titles you might have missed…',
  'Choosing tonight’s first pick…',
  'Putting your shelves in order…',
]

// ageForRating reverse-maps a profile's stored content ceiling to a
// representative age: what `age` holds until one is entered. It is not
// shown, and nothing is written from it: content settings are written only
// from an age the person typed.
function ageForRating(maxRating?: string | null): number {
  const r = (maxRating ?? '').trim()
  if (!r) return 24
  if (['G', 'TV-Y', 'TV-G', 'TV-Y7', 'PG', 'TV-PG'].includes(r)) return 10
  if (['PG-13', 'TV-14'].includes(r)) return 15
  return 24 // R / TV-MA / NC-17 / unknown → adult
}

export function OnboardingFlow({ profileId, profile, status, taste, referral, soleUnrestricted = false, covered = false, onDone }: OnboardingFlowProps) {
  const minPicks = status.min_picks ?? 5
  const previewThreshold = status.threshold ?? 3

  // The step machine is DERIVED, not a constant: the referral step appears only
  // when the server says this user still owes an answer, and when the referral
  // is the only thing owed the flow collapses to just that. Frozen on mount so
  // a late-arriving prop can't renumber the steps mid-flow under the user.
  const referralPending = !!referral?.pending
  const [machine] = useState(() => buildSteps({ referralPending, taste }))
  const [step, setStep] = useState<Step>(() => machine.order[0])
  // Pre-fill identity from the existing profile: an already-chosen nebula, the
  // current nickname, and an age that reflects the current content rating.
  const [avatarId, setAvatarId] = useState<string | null>(() => parseNebula(profile?.avatar_url)?.id ?? null)
  const [name, setName] = useState(() => (profile?.name ?? '').slice(0, 24))
  const [age, setAge] = useState(() => ageForRating(profile?.max_age_rating))
  // An age has been entered. The field starts empty and may be emptied
  // again, which is "no age": nothing about content is then written.
  const [ageTouched, setAgeTouched] = useState(false)
  const [ageText, setAgeText] = useState('')
  // A profile that already has a content limit is the one this session acts
  // as, so it is restricted, and the server refuses any change to its limit.
  // The age field says so instead of taking an age that would be refused.
  const ceilingLocked = isRestrictedProfile(profile)

  // The profile can arrive AFTER mount (App's listProfiles can lose the race to
  // the gate's getOnboardingStatus, so `profile` is briefly null). Back-fill the
  // pre-fill when it lands, but only for fields the user hasn't set yet — never
  // overwrite a choice already made.
  useEffect(() => {
    if (!profile) return
    setAvatarId((prev) => prev ?? parseNebula(profile.avatar_url)?.id ?? null)
    setName((prev) => (prev === '' ? (profile.name ?? '').slice(0, 24) : prev))
    setAge((prev) => (ageTouched ? prev : ageForRating(profile.max_age_rating)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id])

  // --- taste grid (reuses the existing onboarding endpoints) ---
  const [grid, setGrid] = useState<UIMedia[]>([])
  const [gridLoading, setGridLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [reactive, setReactive] = useState<UIMedia[]>([])
  const [selected, setSelected] = useState<number[]>([])

  // --- referral prompt state ---
  // The display order is shuffled ONCE per mount. Attribution surveys have a
  // well-documented primacy bias: whatever sits first gets over-picked, which
  // doesn't just add noise, it skews the answer the operator acts on. Freezing
  // it in a useState initializer keeps the list from re-ordering under the
  // user's cursor on every render.
  const [referralOptions] = useState<ReferralOption[]>(() =>
    shuffleReferralOptions(referral?.options ?? []),
  )
  const [referralChoice, setReferralChoice] = useState<string | null>(null)
  const [referralDetail, setReferralDetail] = useState('')
  const referralRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  // The in-flight referral write, so the flow can await it before onDone tears
  // the page down. See settleReferral.
  const referralInFlightRef = useRef<Promise<void> | null>(null)

  // Place focus inside each step when it opens.
  //
  // Without this a step is reachable only by Tabbing from the top of the
  // document. The footer's Continue button is OUTSIDE the key={step} wrapper,
  // so React keeps the same DOM node across the transition and merely flips it
  // to disabled (a step can't advance until its answer is given) — and per the
  // HTML focus fixup rule, disabling the element a keyboard user is standing
  // on drops focus to <body>. They pressed Enter on Continue and landed
  // nowhere, with what they now have to answer several tab stops away behind
  // the brand and the header skip.
  //
  // The referral step's focus goes to its first answer: a roving tabIndex=0
  // makes the group a tab TARGET; it does not put focus there. Every other
  // step's goes to its heading, which says where the person now is; or, on
  // the titles step after picks were taken back out, to the line that says so.
  //
  // A step the person moved to by their own press always takes the focus.
  // The flow appearing does not take it from something drawn above the flow
  // (the "Who's watching?" picker, a PIN prompt): there the keys belong to
  // what is on top, and the flow takes the focus when it is uncovered.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const noticeRef = useRef<HTMLParagraphElement | null>(null)
  const enteredRef = useRef(false)
  const focusStep = useCallback(() => {
    if (step === 'referral') {
      const first = referralOptions[0]?.key
      if (first) referralRefs.current[first]?.focus()
      return
    }
    ;(noticeRef.current ?? headingRef.current)?.focus()
  }, [step, referralOptions])
  /** The focus is the flow's to take: it is nowhere, in the flow already,
   *  or on the page the flow has just covered. Not when another dialog
   *  holds it: that one is drawn above the flow. */
  const focusIsOurs = () => {
    const at = document.activeElement
    if (!at || at === document.body || rootRef.current?.contains(at)) return true
    return !at.closest('[role="dialog"], [role="alertdialog"]')
  }
  useEffect(() => {
    const first = !enteredRef.current
    enteredRef.current = true
    if (first && (covered || !focusIsOurs())) return
    focusStep()
    // `covered` is read as it was when the step opened; uncovering has its
    // own effect, below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusStep])
  const wasCovered = useRef(covered)
  useEffect(() => {
    const was = wasCovered.current
    wasCovered.current = covered
    if (was && !covered && focusIsOurs()) focusStep()
  }, [covered, focusStep])

  // --- loading screen state ---
  // The build's failure, kept as what failed rather than as words: what it
  // says was saved is read from `landed` as it is drawn, so a write that
  // lands after the failure was shown changes the sentence.
  const [error, setError] = useState<{ failure: unknown; carriedLimit: boolean } | null>(null)
  // A build that failed in a way trying again cannot change, but a change
  // on the first step can: the failure then offers the way back there.
  // Set with every failure, and read only while one is shown.
  const [fixInDetails, setFixInDetails] = useState(false)
  const [loadNonce, setLoadNonce] = useState(0)
  const [phaseMsg, setPhaseMsg] = useState(0)
  const ranLoadRef = useRef(-1)
  // What the build says aloud: that it has started, and that it is done.
  // (A failure is the alert's; the lines that tick by are not announced.)
  const [buildSaid, setBuildSaid] = useState('')
  // What this flow's own writes have put on the server so far: the profile
  // (its name and avatar), and the content limit when the age set one. A
  // failure says what is true of these, and a way out that is taken after
  // the limit was written no longer leaves one unset.
  const [landed, setLanded] = useState<{ profile: boolean; limit: string | null }>({ profile: false, limit: null })
  const landedRef = useRef(landed)
  // A profile write has been sent and has not answered: whether it will
  // land is not known. True through a build that gave up waiting for it,
  // and through a Try again whose own write answered first: what is out is
  // a fact about the profile, not about one build, so the writes out are
  // counted, and a build that was given up on still counts its own back in.
  const [profileWriteOut, setProfileWriteOut] = useState(false)
  const profileWritesOutRef = useRef(0)
  // A write that answers after its build was given up on still says what
  // it did, while this flow is about the profile it wrote. (The host takes
  // the flow down when the profile changes; this holds for the one render
  // in between.)
  const writingForRef = useRef<number | null>(null)
  writingForRef.current = profileId ?? status.profile_id
  // Picks taken back out because the grid, read again under a limit that
  // had just been written, no longer offered them.
  const [removedPicks, setRemovedPicks] = useState(0)
  // The referral answer has been sent: the question is not asked twice
  // when the flow comes back to the picks after a refused build.
  const [referralSent, setReferralSent] = useState(false)
  // "Show more" has run the list out.
  const [listEnded, setListEnded] = useState(false)

  // seenRef dedupes ids across grid + reactive; popLoadedRef is the page cursor.
  const seenRef = useRef<Set<number>>(new Set())
  const popLoadedRef = useRef(0)
  const remember = useCallback((items: UIMedia[]): UIMedia[] => {
    const fresh: UIMedia[] = []
    for (const m of items) {
      if (!seenRef.current.has(m.id)) {
        seenRef.current.add(m.id)
        fresh.push(m)
      }
    }
    return fresh
  }, [])

  // Initial popularity load (once — the grid is reused for the mosaic too).
  useEffect(() => {
    // No taste steps in a referral-only pass, so nothing consumes this grid.
    if (!taste) { setGridLoading(false); return }
    let cancelled = false
    const ac = new AbortController()
    setGridLoading(true)
    getOnboardingGrid({ profileId: profileId ?? undefined, limit: 40, offset: 0, signal: ac.signal })
      .then((items) => {
        if (cancelled) return
        setGrid(remember(items))
        popLoadedRef.current = items.length
        setHasMore(items.length >= 40)
      })
      .catch(() => {
        if (!cancelled) {
          setGrid([])
          setHasMore(false)
        }
      })
      .finally(() => {
        if (!cancelled) setGridLoading(false)
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [profileId, remember, taste])

  // "Show more" goes away when the list has run out (a short page, or a page
  // that could not be read). The focus it held goes to the first title it
  // added, or to the last title when it added none, and the status says that
  // is everything.
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const focusTileRef = useRef<number | 'last' | null>(null)
  const showMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    let added: UIMedia[] = []
    let more = false
    try {
      const items = await getOnboardingGrid({
        profileId: profileId ?? undefined,
        limit: 40,
        offset: popLoadedRef.current,
      })
      popLoadedRef.current += items.length
      added = remember(items)
      setGrid((prev) => [...prev, ...added])
      more = items.length >= 40
    } catch {
      more = false
    } finally {
      setLoadingMore(false)
    }
    setHasMore(more)
    if (more) return
    setListEnded(true)
    // Only when the button still has the focus: a person who has moved on
    // is left where they are.
    if (document.activeElement === moreRef.current) focusTileRef.current = added[0]?.id ?? 'last'
  }, [loadingMore, hasMore, profileId, remember])
  useEffect(() => {
    const want = focusTileRef.current
    if (want === null || hasMore) return
    focusTileRef.current = null
    const tiles = gridRef.current?.querySelectorAll<HTMLElement>('button[data-tile]')
    if (!tiles || tiles.length === 0) return
    const tile = want === 'last' ? null : gridRef.current?.querySelector<HTMLElement>(`button[data-tile="${want}"]`)
    ;(tile ?? tiles[tiles.length - 1]).focus()
  }, [grid, hasMore])

  // Reactive "more like your picks" — appends as the user keeps choosing.
  useEffect(() => {
    if (selected.length < previewThreshold) return
    const ac = new AbortController()
    const t = setTimeout(() => {
      getOnboardingGrid({ profileId: profileId ?? undefined, limit: 24, offset: 0, selected, signal: ac.signal })
        .then((items) => setReactive((prev) => [...prev, ...remember(items)]))
        .catch(() => {
          /* transient — leave reactive as-is */
        })
    }, 450)
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [selected, previewThreshold, profileId, remember])

  const toggle = useCallback((id: number) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  const selectedSet = useMemo(() => new Set(selected), [selected])

  // The build's row: the titles that were picked, in the order they were.
  const pickedTitles = useMemo(() => {
    const byId = new Map([...grid, ...reactive].map((m) => [m.id, m]))
    return selected.map((id) => byId.get(id)).filter((m): m is UIMedia => !!m).slice(0, 10)
  }, [grid, reactive, selected])

  // ---- referral submission ----
  // Fire-and-forget by design: attribution is worth less than a signup, so a
  // failed write logs and lets the user through rather than trapping them
  // behind a retry. The row simply stays 'pending' and they may be asked once
  // more on a later visit.
  const sendReferral = useCallback(
    (answer: { source: string; detail?: string } | { skip: true }) => {
      // No send-once flag. Every caller either advances off the step in the
      // same handler or is gated on `step === 'referral'`, and React commits
      // that transition before the next click can be dispatched — so a second
      // send is unreachable, and a flag here would be dead code that reads as
      // live protection. If one ever did slip through, POST /api/me/referral
      // is idempotent server-side: the second call is a 200 no-op that cannot
      // overwrite the first answer.
      //
      // Keep the promise so the flow can wait for it before tearing the page
      // down — see settleReferral. Errors are swallowed here so no caller has
      // to handle them; a failed write leaves the row pending, which is the
      // designed fallback.
      setReferralSent(true)
      referralInFlightRef.current = submitReferral(answer)
        .then(() => undefined)
        .catch((e) => {
          console.warn('referral: submit failed, continuing', e)
        })
    },
    [],
  )

  // Wait (briefly) for an in-flight referral write before closing the flow.
  //
  // onDone reloads the page (App passes window.location.reload), and a
  // fire-and-forget fetch is cancelled by navigation. In the referral-only pass
  // nothing else awaited, so the whole skip path ran in a single synchronous
  // turn and the POST was aborted before it left — the row stayed pending and
  // the user was re-prompted on the very next paint, which is precisely the
  // double-nag this step exists to avoid.
  //
  // Bounded, because attribution must never hold the user at a spinner: if the
  // write hasn't settled in two seconds we go anyway and they may be asked once
  // more later.
  const settleReferral = useCallback(async () => {
    const inFlight = referralInFlightRef.current
    if (!inFlight) return
    await Promise.race([inFlight, sleep(2000)])
  }, [])
  const submitReferralChoice = useCallback(() => {
    if (!referralChoice) {
      sendReferral({ skip: true })
      return
    }
    const detail = referralDetail.trim()
    sendReferral(
      referralChoice === REFERRAL_OTHER_KEY && detail
        ? { source: referralChoice, detail }
        : { source: referralChoice },
    )
  }, [referralChoice, referralDetail, sendReferral])

  // ---- navigation ----
  const stepIndex = machine.order.indexOf(step)
  // The steps the bar counts. The question, once it has been answered and
  // passed, is not one of them any more (see stepAfter).
  const countedSteps = referralSent && step !== 'referral' ? machine.inputs.filter((s) => s !== 'referral') : machine.inputs
  const inputIndex = countedSteps.indexOf(step)
  const canAdvance = (): boolean => {
    switch (step) {
      case 'you':
        // An avatar and a name; the age is optional.
        return !!avatarId && name.trim().length >= 1
      case 'titles':
        return selected.length >= minPicks
      case 'referral':
        // Continue needs a choice; Skip is the escape hatch beside it, so this
        // is a disabled button with an obvious alternative, not a dead end.
        return referralChoice !== null
      default:
        return true
    }
  }
  const goTo = (s: Step) => {
    setError(null)
    setStep(s)
  }
  // The step after this one. The question, once answered, is passed over:
  // the flow can come back to the picks after a build was refused, and what
  // was answered then is not asked, or sent, again.
  const stepAfter = (from: Step): Step | null => {
    const n = nextStep(machine, from)
    return n === 'referral' && referralSent ? nextStep(machine, 'referral') : n
  }
  const next = () => {
    if (!canAdvance()) return
    // Commit the referral on the way OUT of its step. Back does NOT submit — reversing out of
    // a step shouldn't record an answer the user was still considering.
    if (step === 'referral') submitReferralChoice()
    if (step === 'titles') setRemovedPicks(0)
    const n = stepAfter(step)
    if (n) { goTo(n); return }
    void settleReferral().then(onDone)
  }
  const back = () => {
    const p = prevStep(machine, step)
    if (p) goTo(p)
  }

  // One skip per press: a second press before the first has answered would
  // send the skip again and close the flow twice.
  const skippingRef = useRef(false)
  const skip = useCallback(async () => {
    if (skippingRef.current) return
    skippingRef.current = true
    // The flow-level "Skip for now" closes EVERYTHING. If it's pressed while
    // the referral question is on screen, the user has seen it and declined —
    // record that, so a later session doesn't ask again. Pressed from any other
    // step they never saw it, so it stays pending and they get one more chance.
    if (step === 'referral') sendReferral({ skip: true })
    try {
      if (taste) await skipOnboarding(profileId ?? undefined)
    } catch {
      /* never trap the user behind the overlay, even if the skip write fails */
    } finally {
      // Let the referral write land before onDone reloads the page.
      await settleReferral()
      onDone()
    }
  }, [profileId, onDone, step, taste, sendReferral, settleReferral])

  // ---- leaving without finishing ----
  // An age can set a content limit, and the limit is written when setup
  // finishes (the build), not when the age is typed. So a way out that does
  // not run the build can leave a profile without the limit its page has
  // just described. These two functions are all of that rule: the first
  // says which limit the age in the field would set, the second which limit
  // a way out taken now would leave unset.
  const limitToSet = (): string | null => {
    if (!ageTouched || ceilingLocked || soleUnrestricted) return null
    return ratingForAge(age).maxRating || null
  }
  const limitLeftUnset = (): string | null => (landed.limit !== null ? null : limitToSet())
  // The limit the open question is about; null while it is not asked.
  // `unknown`: the write that carries it is out and has not answered, so
  // the question cannot say that skipping sets no limit.
  // It is worded from what is known as it is read: a write that answers
  // while it is open changes what it can say.
  const [leaveAsk, setLeaveAsk] = useState<{ limit: string } | null>(null)
  const askUnknown = profileWriteOut
  // Every way out that does not finish setup: the header's Skip, "Continue
  // to Aurora" on an empty list, Skip after a build that failed.
  const leave = () => {
    const limit = limitLeftUnset()
    if (limit) { setLeaveAsk({ limit }); return }
    void skip()
  }
  // The limit landed while the question was open: there is nothing left to
  // ask, and the page under it says the limit is set.
  const askMoot = leaveAsk !== null && landed.limit !== null
  useEffect(() => { if (askMoot) setLeaveAsk(null) }, [askMoot])

  const retryLoad = () => {
    // The button goes with the failure it was under: the focus it holds goes
    // to the build's heading before it does.
    headingRef.current?.focus()
    setError(null)
    setLoadNonce((n) => n + 1)
  }
  // From a failed build back to the first step, with the picks kept. The
  // next Finish is a new build.
  const backToDetails = () => {
    setLoadNonce((n) => n + 1)
    goTo(machine.order[0])
  }

  // ---- a build refused because of the limit it had just written ----
  // The grid on the page was read before the limit existed, so it can hold
  // titles the limit now hides, and picks among them are refused. A retry
  // would send the same picks and be refused for good. Instead: read the
  // grid again (the server now leaves out what the limit hides), keep the
  // picks that are still on it, and go back to the titles step, which says
  // how many went. Returns false when nothing went (the refusal was about
  // something else) or the grid could not be read: the caller then reports
  // the failure as any other.
  const recoverPicksUnderLimit = async (stillHere: () => boolean): Promise<boolean> => {
    const offered: UIMedia[] = []
    let full = true
    try {
      // As many as were on the page, in pages the server allows.
      const want = Math.max(40, popLoadedRef.current)
      while (offered.length < want && full) {
        // Given up on (the build's time ran out, or a Try again started
        // another): no more pages are asked for.
        if (!stillHere()) return true
        const size = Math.min(100, want - offered.length)
        const items = await getOnboardingGrid({ profileId: profileId ?? undefined, limit: size, offset: offered.length })
        offered.push(...items)
        full = items.length >= size
      }
    } catch {
      return false
    }
    if (!stillHere()) return true
    const onOffer = new Set(offered.map((m) => m.id))
    const kept = selected.filter((id) => onOffer.has(id))
    if (kept.length === selected.length) return false
    seenRef.current = new Set()
    popLoadedRef.current = offered.length
    setGrid(remember(offered))
    setHasMore(full)
    setListEnded(false)
    setReactive([])
    setSelected(kept)
    setRemovedPicks(selected.length - kept.length)
    // The next Finish is a new build.
    setLoadNonce((n) => n + 1)
    setError(null)
    setStep('titles')
    return true
  }

  // What to say of a build that did not finish, which is first of all what
  // it did save: once the profile has been written its name and avatar are
  // kept, and so is the limit when the age set one, whatever failed after.
  const buildFailure = (e: unknown, saved: { profile: boolean; limit: string | null }, carriedLimit: boolean): string => {
    const kept = saved.profile
      ? `Your name and avatar are saved${saved.limit ? `, and this profile is now limited to titles ${limitPhrase(saved.limit)}` : ''}. `
      : ''
    if (e instanceof BuildTimeout) {
      return `${kept}${saved.profile ? 'The rest' : 'This'} is taking longer than expected. Check your connection, then try again or skip for now.`
    }
    if (saved.profile) return `${kept}Your picks could not be saved just now. Try again, or skip for now.`
    // The profile write itself was refused. A refusal with a reason is
    // worded as Settings words it; here there is no list that was reloaded.
    const reason = refusalReason(e)
    // These two can be about the limit the age would set: when the write
    // carried one, without the age there is nothing to refuse, and the way
    // back to it is offered. (The second is also the answer to any edit
    // from a session on a restricted profile, whatever it carries.)
    if (carriedLimit && fixableInDetails(reason)) {
      return `${refusalMessage(e, '', { reloaded: false })} Nothing was saved. Without an age the rest can be saved: go back to your details, or skip for now.`
    }
    if (reason) return `${refusalMessage(e, '', { reloaded: false })} Nothing was saved.`
    return 'Your choices could not be saved just now. Try again, or skip for now.'
  }

  // ---- the loading sequence: persist everything, warm the rails, then reveal ----
  useEffect(() => {
    if (step !== 'loading') return
    if (ranLoadRef.current === loadNonce) return
    ranLoadRef.current = loadNonce

    let cancelled = false
    const t0 = Date.now()
    setPhaseMsg(0)
    setBuildSaid('Saving your choices and building your Tonight.')

    // cosmetic: advance the status messages
    const msgIv = setInterval(() => setPhaseMsg((m) => Math.min(m + 1, LOADING_MESSAGES.length - 1)), 1000)

    let carriedLimit = false
    ;(async () => {
      try {
        // status.profile_id is the resolved (acting) profile even when the
        // profileId prop is null, so we always have a concrete id to PUT.
        const pid = profileId ?? status.profile_id
        // Identity always persists (nickname + chosen nebula). Content settings
        // (age-derived ceiling + tone lean) persist ONLY if the user actually
        // entered an age — so a returning profile that leaves the age empty
        // keeps its existing rating/tone (e.g. a kids profile is never
        // silently un-restricted).
        const patch = onboardingProfilePatch({ name, avatarId, age, ageTouched, ceilingLocked, soleUnrestricted })
        carriedLimit = patch.max_age_rating !== undefined
        // The critical writes + a best-effort hero warm:
        //  1) persist identity (+ content settings when an age was entered),
        //  2) save taste seeds — flips taste_onboarding_completed, mirrors picks to
        //     Favorites, invalidates the hero cache so the next build uses the new
        //     taste vector,
        //  3) warm the rails so the reloaded Home shows a built hero immediately —
        //     hero rebuilds fast; discover/engagement run in the background (their
        //     LLM/SQL builds finish via Home's own loading path).
        const work = (async () => {
          // Counted out and back in whatever becomes of this build.
          const ours = () => writingForRef.current === pid
          profileWritesOutRef.current += 1
          if (ours()) setProfileWriteOut(true)
          try {
            await updateProfile(pid, patch)
          } finally {
            profileWritesOutRef.current -= 1
            if (ours()) setProfileWriteOut(profileWritesOutRef.current > 0)
          }
          // The profile is written, and with it the limit when the patch
          // carried one. Known from here on, whatever happens next, also
          // when this build was given up on before the answer came.
          if (ours()) {
            landedRef.current = { profile: true, limit: patch.max_age_rating || landedRef.current.limit }
            setLanded(landedRef.current)
          }
          // A build given up on stops at its own write: only the current
          // build sends picks and warms the rails.
          if (cancelled) return
          await saveOnboardingSeeds(selected, profileId ?? undefined)
          await Promise.race([
            getHeroPool(true, profileId ?? undefined).then(() => {}).catch(() => {}),
            sleep(8000),
          ])
          void getDiscoverRails(profileId ?? undefined).catch(() => {})
          void getEngagementRails(profileId ?? undefined).catch(() => {})
        })()
        // Watchdog: the loading step hides Skip/Back, so a stalled request must
        // never trap the user here. If the writes don't settle in time, surface
        // the error UI (Try again / Skip) instead of spinning forever.
        let timedOut = false
        await Promise.race([work, sleep(BUILD_WAIT_MS).then(() => void (timedOut = true))])
        if (timedOut) throw new BuildTimeout()
        if (!cancelled) setBuildSaid('Your Tonight is ready.')
        // Hold a minimum beat so the celebratory loader never just flashes.
        const elapsed = Date.now() - t0
        if (elapsed < 4200) await sleep(4200 - elapsed)
        if (!cancelled) onDone()
      } catch (e) {
        if (cancelled) return
        clearInterval(msgIv)
        // The person is told in the app's words; what the server or the
        // browser said is kept for whoever looks at the console.
        console.warn('onboarding: the build did not finish', e)
        const saved = landedRef.current
        let failure: unknown = e
        if (saved.limit !== null && refusedAsBadRequest(e)) {
          // The re-read is part of the build, and under the same watchdog:
          // what is left of the build's time, and no longer. One that
          // answers after that changes nothing on the page.
          let gaveUp = false
          const left = Math.max(0, BUILD_WAIT_MS - (Date.now() - t0))
          const recovered = await Promise.race([
            recoverPicksUnderLimit(() => !cancelled && !gaveUp),
            sleep(left).then(() => { gaveUp = true; return null }),
          ])
          if (cancelled || recovered === true) return
          if (recovered === null) failure = new BuildTimeout()
        }
        setBuildSaid('')
        // A refusal the same write would meet again, which a change of the
        // age can avoid: the way on is back to the first step.
        const reason = saved.profile ? null : refusalReason(failure)
        setFixInDetails(carriedLimit && fixableInDetails(reason))
        setError({ failure, carriedLimit })
      }
    })()

    return () => {
      cancelled = true
      clearInterval(msgIv)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, loadNonce])

  // The nav bar belongs to the input steps — the ones with a Back/Continue
  // contract. Derived from the machine so a new input step gets it for free.
  const showNav = machine.inputs.includes(step)
  // The step after which the flow builds: its button says so.
  const finishes = stepAfter(step) === 'loading'
  const shownName = name.trim()
  // How wide each step is drawn; its footer follows it.
  const stepWidth = step === 'titles' ? 'max-w-[1040px]' : step === 'you' ? 'max-w-[640px]' : 'max-w-[560px]'

  // A limit this profile has (it came with one, or this flow has just
  // written one): its age cannot be changed here.
  const ageLocked = ceilingLocked || landed.limit !== null

  // What the age that was entered will do, in words, and why not when it
  // will not. It says WHEN: the limit is written when setup finishes, not as
  // the age is typed. The limit is worded by the helper Settings uses, so
  // both say the same of the same limit.
  const ageNote = (): string => {
    if (ageLocked) return `This profile is limited to titles ${limitPhrase(landed.limit ?? profile?.max_age_rating)}, so its age cannot be changed here.`
    if (!ageTouched) {
      return soleUnrestricted
        ? 'This is the account’s only profile without a content limit, so an age tunes what is suggested and sets no limit. To limit what a child sees, give them their own profile.'
        : `When you finish setup, an age under 13 limits this profile to titles ${limitPhrase('PG')}, and one under 17 to titles ${limitPhrase('TV-14')}. Leave it empty to change nothing.`
    }
    const r = ratingForAge(age)
    if (r.maxRating === '') return 'Adult: no content limit. Suggestions follow what you watch.'
    if (soleUnrestricted) return `${r.tier}: suggestions lean that way, and no content limit is set, because this is the account’s only profile without one. To limit what a child sees, give them their own profile.`
    return `${r.tier}: when you finish setup, this profile will be limited to titles ${limitPhrase(r.maxRating)}.`
  }

  // What the footer says beside its buttons: what is still missing, or what
  // comes next.
  const footNote = (): string => {
    if (step === 'you') return !avatarId ? 'Pick an avatar to continue.' : !shownName ? 'Enter a name to continue.' : ''
    if (step === 'titles') {
      // "Show more" has gone: said here, the step's one status.
      const end = listEnded ? 'That is every title. ' : ''
      if (selected.length < minPicks) return `${end}Pick ${minPicks - selected.length} more to continue.`
      return end + (finishes ? 'Aurora builds your first Tonight from these. It takes a few seconds.' : 'Rating or saving a title later counts too.')
    }
    return ''
  }

  return (
    // role="dialog" + aria-modal, matching ProfilesGate. This overlay has always
    // covered the whole app without saying so, but it used to appear only to
    // profiles that had never onboarded. The referral-only pass shows it to
    // people who finished onboarding long ago, so a screen reader now has to be
    // told a modal question arrived rather than leaving the user reading the
    // still-exposed app underneath.
    <div
      ref={rootRef}
      className="fixed inset-0 z-[80] flex flex-col overflow-hidden bg-surface-page text-ink animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={taste ? 'Set up your Aurora' : 'One quick question'}
      // Out of reach while something is drawn over it: the keys then belong
      // to what is on top, and none of them may land on a control down here.
      inert={covered || undefined}
    >
      {/* Top bar: brand, progress, skip. */}
      <header className="flex h-14 flex-none items-center gap-2.5 px-4 sm:h-16 sm:px-12">
        <AuroraMark />
        {/* Carries the accessible name "Aurora Pro". Not on the narrowest
            phones, where the progress and Skip need the room. */}
        <AuroraWordmark ink="var(--ink)" className="hidden h-[15px] w-auto min-[360px]:block" />
        <span className="flex-1" />
        {inputIndex >= 0 && countedSteps.length > 1 && (
          <div role="img" aria-label={`Step ${inputIndex + 1} of ${countedSteps.length}`} className="flex gap-1.5">
            {countedSteps.map((s, i) => (
              <span key={s} className={`h-1 w-6 rounded-[2px] sm:w-12 ${i <= inputIndex ? 'bg-action' : 'bg-line-strong'}`} />
            ))}
          </div>
        )}
        {/* Not beside the question that ends setup: "Skip this question"
            there goes on to the build, and a second Skip that discards
            everything would sit on the same screen. Back reaches this one. */}
        {step !== 'loading' && !(taste && step === 'referral') && (
          <button
            type="button"
            onClick={leave}
            className="-mr-2 ml-2 inline-flex min-h-11 items-center rounded-control px-2 text-sm text-ink-2 hover:text-ink hover:underline sm:ml-4"
          >
            Skip for now
          </button>
        )}
      </header>

      {/* Stage — auto margins center short steps and let tall steps (titles)
          scroll from the top instead of clipping their header. */}
      <div className="flex flex-1 flex-col overflow-y-auto px-4 sm:px-12">
        <div
          key={step}
          className={`m-auto w-full py-6 ${stepWidth}`}
        >
          {step === 'you' && renderYou()}
          {step === 'titles' && renderTitles()}
          {step === 'referral' && renderReferral()}
          {step === 'welcome' && renderWelcome()}
          {step === 'loading' && renderLoading()}
        </div>
      </div>

      {/* Bottom nav: what is missing or what comes next, Back, and the way on.
          Outside the scrolling stage, so it stays in reach under a long grid. */}
      {showNav && (
        <footer className="flex-none px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 sm:px-12 sm:pb-10">
          {/* As wide as the step above it, so its buttons end where the
              step's own right edge is. */}
          <div className={`mx-auto flex w-full flex-wrap items-center justify-end gap-x-3 gap-y-2 ${stepWidth}`}>
          <div className="min-w-0 flex-1 basis-full text-[13px] leading-snug text-ink-2 sm:basis-0">
            {step === 'referral' ? (
              <button
                type="button"
                onClick={() => {
                  sendReferral({ skip: true })
                  const n = nextStep(machine, 'referral')
                  if (n) { goTo(n); return }
                  void settleReferral().then(onDone)
                }}
                className="-ml-2 inline-flex min-h-11 items-center rounded-control px-2 text-sm text-ink-2 hover:text-ink hover:underline"
              >
                Skip this question
              </button>
            ) : (
              // Says what Continue is waiting for, as the choices are made.
              <p role="status">{footNote()}</p>
            )}
          </div>
          {stepIndex > 0 && (
            <button type="button" onClick={back} className="stage-btn stage-btn-ghost stage-btn-tall">
              Back
            </button>
          )}
          <button
            type="button"
            onClick={next}
            disabled={!canAdvance()}
            className="stage-btn stage-btn-primary stage-btn-pill stage-btn-tall min-w-[132px]"
          >
            {finishes ? 'Finish' : 'Continue'}
          </button>
          </div>
        </footer>
      )}

      {/* Asked before any way out that would leave unset the limit this page
          has described (see limitLeftUnset). Drawn above the flow, under the
          "Who's watching?" picker. */}
      <ConfirmDialog
        open={leaveAsk !== null}
        title={askUnknown ? 'Skip without knowing whether the limit was set?' : 'Skip without setting a limit?'}
        cancelLabel="Go back"
        confirmLabel={askUnknown ? 'Skip anyway' : 'Skip, no limit'}
        destructive
        safeFirst
        overlayClassName="z-[82]"
        contentClassName="z-[83]"
        onCancel={() => setLeaveAsk(null)}
        onConfirm={() => { setLeaveAsk(null); void skip() }}
        fallbackFocus={() => headingRef.current}
      >
        {askUnknown
          // The write that carries the limit was sent and has not answered:
          // the page cannot say which way it went.
          ? <>The age you entered limits this profile to titles {limitPhrase(leaveAsk?.limit)}. That was sent, and the server has not answered: the limit may or may not have been set. If you skip, look in Settings, under Profiles and parental controls, and set it there if it is not.</>
          : <>The age you entered would have limited this profile to titles {limitPhrase(leaveAsk?.limit)}. Skipping now sets no limit and saves nothing from this page. You can set a limit in Settings, under Profiles and parental controls.</>}
      </ConfirmDialog>
    </div>
  )

  // A step's heading, which takes the focus when the step opens (see
  // headingRef).
  function heading(text: string) {
    return (
      <h1 ref={headingRef} tabIndex={-1} className="rounded-chip font-display text-[clamp(2.25rem,9vw,3.5rem)] font-extrabold leading-none tracking-[-0.02em] text-ink [overflow-wrap:anywhere]">
        {text}
      </h1>
    )
  }

  // Who this profile is: an avatar, a name, and an age for whoever wants to
  // give one.
  function renderYou() {
    return (
      <div className="flex flex-col gap-8 sm:gap-9">
        <div>
          {heading('Make it yours')}
          <p className="mt-2 text-[17px] leading-snug text-ink-2">A face and a name for this profile. You can change both later.</p>
        </div>

        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-3 p-0 text-[13px] font-semibold text-ink-2">Pick your avatar</legend>
          {/* Two rows of five at every width: the discs shrink with a
              narrow phone instead of running to four rows. */}
          <div className="grid max-w-[384px] grid-cols-5 gap-3 sm:gap-4">
            {NEBULAS.map((n) => {
              const sel = avatarId === n.id
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setAvatarId(n.id)}
                  aria-pressed={sel}
                  aria-label={n.name}
                  // The chosen one is ringed in white, a gap of the page's
                  // colour from it, and checked: the marks a chosen poster
                  // has. The check is what still says "chosen" while the
                  // focus ring is drawn where the ring was.
                  className={`relative block aspect-square w-full rounded-full p-0 ${sel ? 'shadow-[0_0_0_3px_var(--surface-page),0_0_0_5px_#ffffff]' : ''}`}
                >
                  <NebulaAvatar nebula={n} active={sel} className="block h-full w-full" />
                  {sel && (
                    <span aria-hidden="true" data-avatar-check="" className="absolute -right-0.5 -top-0.5 grid h-6 w-6 place-items-center rounded-full bg-action text-action-on">
                      <CheckIcon className="h-3.5 w-3.5" />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </fieldset>

        <div className="flex flex-wrap gap-5">
          <div className="flex min-w-[240px] flex-[2] flex-col gap-1.5">
            <label htmlFor="ob-name" className="text-[13px] font-semibold text-ink-2">Name</label>
            <input
              id="ob-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canAdvance()) next()
              }}
              maxLength={24}
              autoComplete="off"
              className="onboarding-field w-full"
            />
          </div>
          <div className="flex min-w-[120px] flex-1 flex-col gap-1.5">
            <label htmlFor="ob-age" className="text-[13px] font-semibold text-ink-2">
              Age <span className="font-normal text-ink-3">optional</span>
            </label>
            <input
              id="ob-age"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={2}
              value={ageText}
              disabled={ageLocked}
              aria-describedby="ob-age-note"
              autoComplete="off"
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, '').slice(0, 2)
                setAgeText(digits)
                if (digits === '') { setAgeTouched(false); return }
                setAge(parseInt(digits, 10))
                setAgeTouched(true)
              }}
              className="onboarding-field w-full"
            />
          </div>
          {/* Said as the age is typed: what it will do changes with it. */}
          <p id="ob-age-note" aria-live="polite" className="basis-full text-[13px] leading-snug text-ink-2">{ageNote()}</p>
        </div>
      </div>
    )
  }

  function renderTitles() {
    const limit = landed.limit
    return (
      <div className="flex flex-col gap-7">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[280px] flex-1">
            {heading('Pick what you love')}
            <p className="mt-2 text-[17px] leading-snug text-ink-2">
              {minPicks} or more, from this library. Aurora uses them for your first picks.
            </p>
          </div>
          {/* A count to look at. What is said aloud as picks are made is the
              footer's line (how many more it needs): one voice, not two. */}
          <p className="text-[15px] font-semibold text-ink" data-picked="">{selected.length} picked</p>
        </div>

        {/* After a build that was refused because of the limit it had just
            written: what happened to the picks. It takes the focus when the
            step opens, so it is what is read first. */}
        {removedPicks > 0 && limit && (
          <p ref={noticeRef} tabIndex={-1} data-picks-removed="" className="rounded-control bg-surface-raised px-4 py-3 text-[15px] leading-snug text-ink">
            This profile is now limited to titles {limitPhrase(limit)}, so the titles here were loaded again.{' '}
            {removedPicks === 1 ? '1 of your picks is no longer among them and was removed.' : `${removedPicks} of your picks are no longer among them and were removed.`}
          </p>
        )}

        {gridLoading ? (
          <div className="onboarding-grid" aria-hidden="true">
            {Array.from({ length: 18 }).map((_, i) => (
              <SkeletonBlock key={i} className="aspect-[2/3] rounded-art" />
            ))}
          </div>
        ) : grid.length === 0 ? (
          <div className="py-16">
            <p className="text-[15px] text-ink-2">Your library is still being prepared for recommendations.</p>
            <button type="button" onClick={leave} className="stage-btn stage-btn-ghost mt-4">
              Continue to Aurora
            </button>
          </div>
        ) : (
          <>
            <div ref={gridRef} role="group" aria-label="Titles" className="onboarding-grid">
              {grid.map((m) => (
                <PosterTile key={m.id} m={m} selected={selectedSet.has(m.id)} dim={selected.length > 0} onToggle={toggle} />
              ))}
            </div>
            {hasMore && (
              <div className="flex justify-center">
                {/* Off, not disabled, while more are fetched: it keeps the
                    focus the press gave it. showMore refuses a second press. */}
                <button ref={moreRef} type="button" onClick={() => void showMore()} aria-disabled={loadingMore} className="stage-btn stage-btn-ghost">
                  {loadingMore ? 'Loading…' : 'Show more'}
                </button>
              </div>
            )}
            {reactive.length > 0 && (
              <section aria-labelledby="ob-more">
                <h2 id="ob-more" className="mb-3 font-display text-[22px] font-bold leading-tight tracking-[-0.01em] text-ink">More like your picks</h2>
                <div role="group" aria-label="More like your picks" className="onboarding-grid">
                  {reactive.map((m) => (
                    <PosterTile key={m.id} m={m} selected={selectedSet.has(m.id)} dim={selected.length > 0} onToggle={toggle} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    )
  }

  // The referral step. A real radiogroup — `role="radiogroup"` with arrow-key
  // movement, one tab stop, and activation on move — because a group of
  // `aria-pressed` buttons announces as independent toggles and hands the arrow
  // keys to an application that ignores them. See lib/radiogroup for the four
  // shipped bugs that lesson comes from.
  function renderReferral() {
    const keys = referralOptions.map((o) => o.key)
    const otherChosen = referralChoice === REFERRAL_OTHER_KEY
    const question = referral?.question || 'How did you hear about Aurora?'
    // The single tab stop, computed the SAME way the arrow handler computes
    // "current" so the two cannot disagree. Deriving it from an index rather
    // than from `active` also keeps the group in the tab ring when nothing is
    // selected yet — and, unlike an `active || isFirst` test, it cannot land in
    // a state where NO option is focusable if referralChoice ever holds a key
    // that isn't in the list.
    const tabStop = Math.max(0, keys.indexOf(referralChoice ?? ''))
    return (
      <div className="flex flex-col gap-8">
        <div>
          {heading('One quick thing')}
          {/* Admin-authored text, rendered as text. Never dangerouslySetInnerHTML. */}
          <p className="mt-2 text-[17px] leading-snug text-ink-2" data-referral-ask="">
            {question} It is optional.
          </p>
        </div>

        <div>
          <div
            role="radiogroup"
            aria-label={question}
            className="grid grid-cols-1 gap-2"
            // Inline handler rather than a factory taking a focus callback:
            // react-hooks flags PASSING a ref-reading function during render,
            // while reading a ref inside an event handler is exactly what the
            // rule permits. The arithmetic still lives in tested nextRadioIndex.
            onKeyDown={(e) => {
              const n = nextRadioIndex(e.key, Math.max(0, keys.indexOf(referralChoice ?? '')), keys.length)
              if (n === null) return
              e.preventDefault()
              // State BEFORE focus. Reversing these was a real keyboard trap
              // once: `current` is derived from the selection, so focusing
              // without selecting left it pinned and later options unreachable.
              setReferralChoice(keys[n])
              referralRefs.current[keys[n]]?.focus()
            }}
          >
            {referralOptions.map((opt, i) => {
              const active = referralChoice === opt.key
              return (
                <button
                  key={opt.key}
                  ref={(el) => {
                    referralRefs.current[opt.key] = el
                  }}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  tabIndex={i === tabStop ? 0 : -1}
                  onClick={() => setReferralChoice(opt.key)}
                  className="stage-opt flex min-h-14 items-center gap-3.5 text-left text-base text-ink"
                >
                  {/* The radio's own mark: a ring, filled when chosen. */}
                  <span aria-hidden="true" className={`grid h-5 w-5 flex-none place-items-center rounded-full border-2 ${active ? 'border-ink' : 'border-ink-3'}`}>
                    <span className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-ink' : ''}`} />
                  </span>
                  {opt.label}
                </button>
              )
            })}
          </div>

          {/* The reveal is announced: the field appears in response to a
              selection, which a screen-reader user would otherwise never learn
              about. A real <label>, not a placeholder — placeholders vanish on
              input and aren't reliably announced. */}
          <div aria-live="polite">
            {otherChosen && (
              <div className="mt-4">
                <label htmlFor="referral-detail" className="block text-[13px] font-semibold text-ink-2" data-referral-detail-label="">
                  Where, specifically? <span className="font-normal">(optional)</span>
                </label>
                <input
                  id="referral-detail"
                  type="text"
                  value={referralDetail}
                  maxLength={REFERRAL_DETAIL_MAX}
                  onChange={(e) => setReferralDetail(e.target.value)}
                  placeholder="A podcast, a forum, a friend's setup…"
                  className="onboarding-field mt-1.5 w-full"
                />
              </div>
            )}
          </div>
        </div>

        {finishes && (
          <p className="flex items-start gap-2 text-[13px] leading-snug text-ink-2">
            {/* The mark of Aurora's own work. */}
            <span aria-hidden="true" className="mt-1 h-2 w-2 flex-none rounded-full" style={{ background: 'var(--aurora)' }} />
            <span>
              {shownName ? `Welcome, ${shownName}. ` : ''}After this Aurora builds your first Tonight from the {selected.length} titles you picked. It takes a few seconds.
            </span>
          </p>
        )}
      </div>
    )
  }

  // The send-off when a question was all there was to do: nothing was picked
  // and nothing is being built, so it says neither.
  function renderWelcome() {
    return (
      <div>
        {heading(shownName ? `That is all, ${shownName}` : 'That is all')}
        <p className="mt-2 text-[17px] leading-snug text-ink-2">Back to what you came for.</p>
        <button
          type="button"
          // In the referral-only pass there is no loading step — nothing to
          // seed and no rails to warm — so this ends the flow directly.
          onClick={() => {
            const n = nextStep(machine, 'welcome')
            if (n) { goTo(n); return }
            // Terminal (referral-only pass): same reload race as the header
            // skip — wait for the answer to land before the page goes away.
            void settleReferral().then(onDone)
          }}
          className="stage-btn stage-btn-primary stage-btn-pill stage-btn-tall mt-8 min-w-[132px]"
        >
          Take me in
        </button>
      </div>
    )
  }

  function renderLoading() {
    return (
      <div>
        {heading('Building your Tonight')}
        {/* What it is doing now. These lines tick by on a timer and are not
            announced; what is, is below. */}
        <p className="mt-2 text-[17px] leading-snug text-ink-2" data-build-line="">{error ? '' : LOADING_MESSAGES[phaseMsg]}</p>
        {/* Said aloud: that the build has started, and that it is done. */}
        <p role="status" className="sr-only">{buildSaid}</p>

        {pickedTitles.length > 0 && (
          <div className="mt-8 flex flex-wrap gap-2" aria-hidden="true" data-build-picks="">
            {pickedTitles.map((m) => (
              <span key={m.id} className="block h-[92px] w-[62px]">
                <TitleArt m={m} className="h-full w-full" small />
              </span>
            ))}
          </div>
        )}

        {error ? (
          <div className="mt-8">
            <p role="alert" className="max-w-[560px] text-[15px] leading-snug text-danger-ink">{buildFailure(error.failure, landed, error.carriedLimit)}</p>
            <div className="mt-4 flex flex-wrap gap-3">
              {fixInDetails
                ? <button type="button" onClick={backToDetails} className="stage-btn stage-btn-primary">Back to your details</button>
                : <button type="button" onClick={retryLoad} className="stage-btn stage-btn-primary">Try again</button>}
              <button type="button" onClick={leave} className="stage-btn stage-btn-ghost">Skip</button>
            </div>
            {/* The limit is already written: skipping does not take it back. */}
            {landed.limit && (
              <p className="mt-3 max-w-[560px] text-[13px] leading-snug text-ink-2" data-skip-keeps-limit="">
                Skipping leaves the limit set. Your picks can wait: rating or saving a title later counts too.
              </p>
            )}
          </div>
        ) : (
          <div className="mt-8 h-1 max-w-[330px] overflow-hidden rounded-[2px]" style={{ background: 'var(--track)' }}>
            <div
              className="h-full rounded-[2px] bg-action transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${((phaseMsg + 1) / LOADING_MESSAGES.length) * 100}%` }}
            />
          </div>
        )}
      </div>
    )
  }
}

// ---- small pieces ----

// A title's tile: its name on the app's raised surface, with its poster
// drawn over that. The name is the base, not a fallback: it is what the
// tile shows while the picture is on its way, when the picture fails to
// load, and when the title has none.
function TitleArt({ m, className = '', small = false }: { m: UIMedia; className?: string; small?: boolean }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className={`relative block overflow-hidden rounded-art bg-surface-raised-2 ${className}`}>
      <span aria-hidden="true" className={`absolute inset-0 flex items-end font-semibold leading-tight text-ink ${small ? 'p-1 text-[12px]' : 'p-2.5 text-[13px]'}`}>
        <span className="line-clamp-3 [overflow-wrap:anywhere]">{m.title}</span>
      </span>
      {m.poster && !failed && (
        <img
          src={m.poster}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 block h-full w-full object-cover"
        />
      )}
    </span>
  )
}

// A title to pick: its tile, and the mark of having been picked. The title
// is the button's name. Once something is picked, what is not is dimmed, so
// the picks stand out of the wall.
function PosterTile({
  m,
  selected,
  dim,
  onToggle,
}: {
  m: UIMedia
  selected: boolean
  dim: boolean
  onToggle: (id: number) => void
}) {
  return (
    <button
      type="button"
      data-tile={m.id}
      onClick={() => onToggle(m.id)}
      aria-pressed={selected}
      aria-label={m.year > 0 ? `${m.title} (${m.year})` : m.title}
      className={
        'relative block overflow-visible rounded-art bg-surface-raised p-0 text-left ' +
        (selected ? 'shadow-[0_0_0_3px_var(--surface-page),0_0_0_5px_#ffffff]' : '')
      }
    >
      <TitleArt m={m} className={`aspect-[2/3] w-full ${dim && !selected ? 'opacity-[0.72]' : ''}`} />
      {selected && (
        <span aria-hidden="true" className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-action text-action-on">
          <CheckIcon className="h-4 w-4" />
        </span>
      )}
    </button>
  )
}

function CheckIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
