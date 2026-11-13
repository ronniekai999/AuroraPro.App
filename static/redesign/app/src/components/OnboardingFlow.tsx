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
  type UIMedia,
  type OnboardingStatus,
  type Profile,
  type ReferralPromptState,
} from '@/lib/api'
import { isRestrictedProfile } from '@/lib/profileSession'
import { limitPhrase } from '@/lib/profileLimits'
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
  /** Called once everything is persisted and the rails are warmed. */
  onDone: () => void
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The build's own watchdog ran out: nothing answered in time. */
class BuildTimeout extends Error {}

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

export function OnboardingFlow({ profileId, profile, status, taste, referral, soleUnrestricted = false, onDone }: OnboardingFlowProps) {
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
  // step's goes to its heading, which says where the person now is.
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  useEffect(() => {
    if (step !== 'referral') { headingRef.current?.focus(); return }
    const first = referralOptions[0]?.key
    if (first) referralRefs.current[first]?.focus()
  }, [step, referralOptions])

  // --- loading screen state ---
  const [error, setError] = useState<string | null>(null)
  const [loadNonce, setLoadNonce] = useState(0)
  const [phaseMsg, setPhaseMsg] = useState(0)
  const ranLoadRef = useRef(-1)

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

  const showMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const items = await getOnboardingGrid({
        profileId: profileId ?? undefined,
        limit: 40,
        offset: popLoadedRef.current,
      })
      popLoadedRef.current += items.length
      setGrid((prev) => [...prev, ...remember(items)])
      setHasMore(items.length >= 40)
    } catch {
      setHasMore(false)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMore, profileId, remember])

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

  // Posters for the loading screen: the user's actual picks first, padded with
  // other poster-bearing grid items so the row is always full.
  const mosaicPosters = useMemo(() => {
    const all = [...grid, ...reactive]
    const byId = new Map(all.map((m) => [m.id, m]))
    const picked = selected.map((id) => byId.get(id)).filter((m): m is UIMedia => !!m && !!m.poster)
    const pad = all.filter((m) => m.poster && !selectedSet.has(m.id))
    const seen = new Set<number>()
    return [...picked, ...pad].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true))).slice(0, 10)
  }, [grid, reactive, selected, selectedSet])

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
  const inputIndex = machine.inputs.indexOf(step)
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
  const next = () => {
    if (!canAdvance()) return
    // Commit the referral on the way OUT of its step. Back does NOT submit — reversing out of
    // a step shouldn't record an answer the user was still considering.
    if (step === 'referral') submitReferralChoice()
    const n = nextStep(machine, step)
    if (n) { goTo(n); return }
    void settleReferral().then(onDone)
  }
  const back = () => {
    const p = prevStep(machine, step)
    if (p) goTo(p)
  }

  const skip = useCallback(async () => {
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

  const retryLoad = () => {
    setError(null)
    setLoadNonce((n) => n + 1)
  }

  // ---- the loading sequence: persist everything, warm the rails, then reveal ----
  useEffect(() => {
    if (step !== 'loading') return
    if (ranLoadRef.current === loadNonce) return
    ranLoadRef.current = loadNonce

    let cancelled = false
    const t0 = Date.now()
    setPhaseMsg(0)

    // cosmetic: advance the status messages
    const msgIv = setInterval(() => setPhaseMsg((m) => Math.min(m + 1, LOADING_MESSAGES.length - 1)), 1000)

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
        // The critical writes + a best-effort hero warm:
        //  1) persist identity (+ content settings when an age was entered),
        //  2) save taste seeds — flips taste_onboarding_completed, mirrors picks to
        //     Favorites, invalidates the hero cache so the next build uses the new
        //     taste vector,
        //  3) warm the rails so the reloaded Home shows a built hero immediately —
        //     hero rebuilds fast; discover/engagement run in the background (their
        //     LLM/SQL builds finish via Home's own loading path).
        const work = (async () => {
          await updateProfile(pid, patch)
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
        await Promise.race([work, sleep(20000).then(() => void (timedOut = true))])
        if (timedOut) throw new BuildTimeout()
        // Hold a minimum beat so the celebratory loader never just flashes.
        const elapsed = Date.now() - t0
        if (elapsed < 4200) await sleep(4200 - elapsed)
        if (!cancelled) onDone()
      } catch (e) {
        if (!cancelled) {
          clearInterval(msgIv)
          // In the app's words: what the server or the browser said of a
          // failed write is written for logs.
          setError(e instanceof BuildTimeout
            ? 'This is taking longer than expected. Check your connection, then try again or skip for now.'
            : 'Your choices could not be saved just now. Try again, or skip for now.')
        }
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
  const finishes = nextStep(machine, step) === 'loading'
  const shownName = name.trim()
  // How wide each step is drawn; its footer follows it.
  const stepWidth = step === 'titles' ? 'max-w-[1040px]' : step === 'you' ? 'max-w-[640px]' : 'max-w-[560px]'

  // What the age that was entered will do, in words, and why not when it
  // will not. The limit is worded by the helper Settings uses, so both say
  // the same of the same limit.
  const ageNote = (): string => {
    if (ceilingLocked) return `This profile has a content limit (${profile?.max_age_rating}), so its age cannot be changed here.`
    if (!ageTouched) {
      return soleUnrestricted
        ? 'This is the account’s only profile without a content limit, so an age tunes what is suggested and sets no limit. To limit what a child sees, give them their own profile.'
        : `An age under 13 limits this profile to titles ${limitPhrase('PG')}, and one under 17 to titles ${limitPhrase('TV-14')}. Leave it empty to change nothing.`
    }
    const r = ratingForAge(age)
    if (r.maxRating === '') return 'Adult: no content limit. Suggestions follow what you watch.'
    if (soleUnrestricted) return `${r.tier}: suggestions lean that way, and no content limit is set, because this is the account’s only profile without one. To limit what a child sees, give them their own profile.`
    return `${r.tier}: this profile will be limited to titles ${limitPhrase(r.maxRating)}.`
  }

  // What the footer says beside its buttons: what is still missing, or what
  // comes next.
  const footNote = (): string => {
    if (step === 'you') return !avatarId ? 'Pick an avatar to continue.' : !shownName ? 'Enter a name to continue.' : ''
    if (step === 'titles') {
      if (selected.length < minPicks) return `Pick ${minPicks - selected.length} more to continue.`
      return finishes ? 'Aurora builds your first Tonight from these. It takes a few seconds.' : 'Rating or saving a title later counts too.'
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
      className="fixed inset-0 z-[80] flex flex-col overflow-hidden bg-surface-page text-ink animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={taste ? 'Set up your Aurora' : 'One quick question'}
    >
      {/* Top bar: brand, progress, skip. */}
      <header className="flex h-14 flex-none items-center gap-2.5 px-4 sm:h-16 sm:px-12">
        <AuroraMark />
        {/* Carries the accessible name "Aurora Pro". Not on the narrowest
            phones, where the progress and Skip need the room. */}
        <AuroraWordmark ink="var(--ink)" className="hidden h-[15px] w-auto min-[360px]:block" />
        <span className="flex-1" />
        {inputIndex >= 0 && machine.inputs.length > 1 && (
          <div role="img" aria-label={`Step ${inputIndex + 1} of ${machine.inputs.length}`} className="flex gap-1.5">
            {machine.inputs.map((s, i) => (
              <span key={s} className={`h-1 w-6 rounded-[2px] sm:w-12 ${i <= inputIndex ? 'bg-action' : 'bg-line-strong'}`} />
            ))}
          </div>
        )}
        {step !== 'loading' && (
          <button
            type="button"
            onClick={() => void skip()}
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
    </div>
  )

  // A step's heading, which takes the focus when the step opens (see
  // headingRef).
  function heading(text: string) {
    return (
      <h1 ref={headingRef} tabIndex={-1} className="rounded-chip font-display text-[clamp(2.25rem,9vw,3.5rem)] font-extrabold leading-none tracking-[-0.02em] text-ink">
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
                  // colour from it: the same mark a chosen poster has.
                  className={`relative block aspect-square w-full rounded-full p-0 ${sel ? 'shadow-[0_0_0_3px_var(--surface-page),0_0_0_5px_#ffffff]' : ''}`}
                >
                  <NebulaAvatar nebula={n} active={sel} className="block h-full w-full" />
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
              disabled={ceilingLocked}
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
          <p id="ob-age-note" className="basis-full text-[13px] leading-snug text-ink-2">{ageNote()}</p>
        </div>
      </div>
    )
  }

  function renderTitles() {
    return (
      <div className="flex flex-col gap-7">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[280px] flex-1">
            {heading('Pick what you love')}
            <p className="mt-2 text-[17px] leading-snug text-ink-2">
              {minPicks} or more, from this library. Aurora uses them for your first picks.
            </p>
          </div>
          <p role="status" className="text-[15px] font-semibold text-ink">{selected.length} picked</p>
        </div>

        {gridLoading ? (
          <div className="onboarding-grid" aria-hidden="true">
            {Array.from({ length: 18 }).map((_, i) => (
              <SkeletonBlock key={i} className="aspect-[2/3] rounded-art" />
            ))}
          </div>
        ) : grid.length === 0 ? (
          <div className="py-16">
            <p className="text-[15px] text-ink-2">Your library is still being prepared for recommendations.</p>
            <button type="button" onClick={() => void skip()} className="stage-btn stage-btn-ghost mt-4">
              Continue to Aurora
            </button>
          </div>
        ) : (
          <>
            <div role="group" aria-label="Titles" className="onboarding-grid">
              {grid.map((m) => (
                <PosterTile key={m.id} m={m} selected={selectedSet.has(m.id)} dim={selected.length > 0} onToggle={toggle} />
              ))}
            </div>
            {hasMore && (
              <div className="flex justify-center">
                {/* Off, not disabled, while more are fetched: it keeps the
                    focus the press gave it. showMore refuses a second press. */}
                <button type="button" onClick={() => void showMore()} aria-disabled={loadingMore} className="stage-btn stage-btn-ghost">
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
            {question} Whoever runs this server asked. It is optional.
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
        {/* What it is doing now, said as it changes. */}
        <p role="status" className="mt-2 text-[17px] leading-snug text-ink-2">{error ? '' : LOADING_MESSAGES[phaseMsg]}</p>

        {mosaicPosters.length > 0 && (
          <div className="mt-8 flex flex-wrap gap-2" aria-hidden="true">
            {mosaicPosters.map((m) => (
              <img key={m.id} src={m.poster} alt="" className="h-[92px] w-[62px] rounded-art object-cover" />
            ))}
          </div>
        )}

        {error ? (
          <div className="mt-8">
            <p role="alert" className="text-[15px] leading-snug text-danger-ink">{error}</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button type="button" onClick={retryLoad} className="stage-btn stage-btn-primary">Try again</button>
              <button type="button" onClick={() => void skip()} className="stage-btn stage-btn-ghost">Skip</button>
            </div>
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

// A title to pick: its poster and nothing drawn over it but the mark of
// having been picked. The title is the button's name. Once something is
// picked, what is not is dimmed, so the picks stand out of the wall.
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
      onClick={() => onToggle(m.id)}
      aria-pressed={selected}
      aria-label={m.year > 0 ? `${m.title} (${m.year})` : m.title}
      className={
        'relative block overflow-visible rounded-art bg-surface-raised p-0 text-left ' +
        (selected ? 'shadow-[0_0_0_3px_var(--surface-page),0_0_0_5px_#ffffff]' : '')
      }
    >
      {m.poster ? (
        <img
          src={m.poster}
          alt=""
          loading="lazy"
          className={`block aspect-[2/3] w-full rounded-art object-cover ${dim && !selected ? 'opacity-[0.72]' : ''}`}
        />
      ) : (
        // No artwork: the title stands in for it.
        <span className="flex aspect-[2/3] w-full items-end rounded-art bg-surface-raised-2 p-2.5 text-[13px] font-semibold leading-tight text-ink">
          <span className="line-clamp-3">{m.title}</span>
        </span>
      )}
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
