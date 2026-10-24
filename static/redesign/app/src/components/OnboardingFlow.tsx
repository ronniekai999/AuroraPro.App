import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
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
import { buildSteps, nextStep, prevStep, type Step } from '@/lib/onboardingSteps'
import {
  shuffleReferralOptions,
  REFERRAL_DETAIL_MAX,
  REFERRAL_OTHER_KEY,
  type ReferralOption,
} from '@/lib/referral'
import { nextRadioIndex } from '@/lib/radiogroup'
import {
  FONT_OPTIONS,
  GLOW_OPTIONS,
  applyFont,
  applyGlow,
  currentFont,
  currentGlow,
  type FontChoice,
  type GlowChoice,
} from '@/lib/appearance'
import { NEBULAS, NebulaAvatar, nebulaValue, parseNebula } from './NebulaAvatar'

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

// ratingForAge maps a chosen age to the profile's content settings, matching the
// canonical rating ladder (internal/db/ratings.go): max_age_rating is a HARD
// ceiling expanded through that ladder, maturity_pref is the SOFT recall lean
// (-1 Auto — the server derives the lean from watched/seeded tiers / 0 family /
// 1 teen / 2 mature). Adults get Auto, not "no lean": the "Up to R · TV-MA"
// tag describes the unrestricted CEILING, while what surfaces first follows
// what they actually watch (an adult with an all-family history leans family
// until their history says otherwise, or they pick an explicit tone in
// Settings). Boundaries mirror the onboarding mock's tiers; "TV-14" (not
// "PG-13") is the teen cap so teen TV is included while R / TV-MA stay blocked.
function ratingForAge(age: number): {
  maxRating: string
  maturityPref: number
  tier: string
  tag: string
  tone: string
} {
  if (age < 13) return { maxRating: 'PG', maturityPref: 0, tier: 'Kids', tag: 'G · PG', tone: '#5eead4' }
  if (age < 17) return { maxRating: 'TV-14', maturityPref: 1, tier: 'Teen', tag: 'PG-13 · TV-14', tone: '#fcd34d' }
  return { maxRating: '', maturityPref: -1, tier: 'Adult', tag: 'Up to R · TV-MA', tone: '#d8b4fe' }
}

// onboardingProfilePatch is the profile write that ends onboarding. Content
// settings (the age-derived ceiling and tone lean) ride along only when the
// age slider was moved, and never for a profile that already has a ceiling:
// the server refuses a restricted profile's ceiling change, and the slider is
// disabled for one. The account's only profile without a ceiling gets the
// tone lean but no ceiling: the server refuses that too, since nothing on an
// account whose every profile is restricted could lift a limit again, and a
// single-profile account used to get there in one move of this slider.
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
  'Reading your taste signals…',
  'Scoring your library…',
  'Finding hidden gems for you…',
  'Composing your hero…',
  'Polishing your discover rails…',
]

// ageForRating reverse-maps a profile's stored content ceiling to a
// representative age, so the slider starts in the profile's CURRENT tier.
// Leaving it untouched then preserves their existing setting (we only write
// content settings when the user actually moves it).
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
  const [ageTouched, setAgeTouched] = useState(false)
  // A profile that already has a content limit is the one this session acts
  // as, so it is restricted, and the server refuses any change to its limit.
  // The age step shows the limit instead of offering a slider that would fail.
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
  const [font, setFont] = useState<FontChoice>(() => currentFont())
  const [glow, setGlow] = useState<GlowChoice>(() => currentGlow())

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

  // Place focus inside the referral step when it opens.
  //
  // Without this the step is reachable only by Tabbing from the top of the
  // document. The footer's Continue button is OUTSIDE the key={step} wrapper,
  // so React keeps the same DOM node across the transition and merely flips it
  // to disabled (the referral step can't advance until something is chosen) —
  // and per the HTML focus fixup rule, disabling the element a keyboard user is
  // standing on drops focus to <body>. They pressed Enter on "Build my Aurora"
  // and landed nowhere, with the question they now have to answer several tab
  // stops away behind the brand and the header skip.
  //
  // A roving tabIndex=0 makes the group a tab TARGET; it does not put focus
  // there. This does.
  useEffect(() => {
    if (step !== 'referral') return
    const first = referralOptions[0]?.key
    if (first) referralRefs.current[first]?.focus()
  }, [step, referralOptions])

  // --- loading screen state ---
  const [error, setError] = useState<string | null>(null)
  const [loadNonce, setLoadNonce] = useState(0)
  const [phaseMsg, setPhaseMsg] = useState(0)
  const [mosaicShimmer, setMosaicShimmer] = useState(false)
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

  // Posters for the loading mosaic: the user's actual picks first, padded with
  // other poster-bearing grid items so it always tiles a full wall.
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
      case 'avatar':
        return !!avatarId
      case 'name':
        return name.trim().length >= 1
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
    // 2026-07-25 (Aurora Stage Phase 0 follow-up) — commit the appearance
    // choices when leaving the "style" step, even if the user never tapped
    // a chip.
    //
    // Why this matters: the chips seed from currentFont()/currentGlow() and
    // render the seeded one as SELECTED (ring + check badge), but applyFont
    // was only ever called from onClick. A user who liked what "Make it
    // yours" showed them and pressed Continue therefore left with NO
    // font_choice stored at all — even though the UI told them they had
    // chosen. That was invisible until the default flipped nova → eclipse:
    // those users would silently become Bricolage users despite having
    // "picked" Nova. Persisting the accepted default closes the one hole in
    // the flip's non-destructiveness.
    if (step === 'style') {
      applyFont(font)
      applyGlow(glow)
    }
    setStep(s)
  }
  const next = () => {
    if (!canAdvance()) return
    // Commit the referral on the way OUT of its step, mirroring how the style
    // step commits appearance on leave. Back does NOT submit — reversing out of
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
    setMosaicShimmer(false)

    // cosmetic: advance the status messages + reveal the mosaic shimmer
    const msgIv = setInterval(() => setPhaseMsg((m) => Math.min(m + 1, LOADING_MESSAGES.length - 1)), 1000)
    const shimmerTo = setTimeout(() => setMosaicShimmer(true), 250 + mosaicPosters.length * 140 + 300)

    ;(async () => {
      try {
        // status.profile_id is the resolved (acting) profile even when the
        // profileId prop is null, so we always have a concrete id to PUT.
        const pid = profileId ?? status.profile_id
        // Identity always persists (nickname + chosen nebula). Content settings
        // (age-derived ceiling + tone lean) persist ONLY if the user actually
        // moved the age slider — so a returning profile that breezes past the
        // pre-filled age keeps its existing rating/tone (e.g. a kids profile is
        // never silently un-restricted).
        const patch = onboardingProfilePatch({ name, avatarId, age, ageTouched, ceilingLocked, soleUnrestricted })
        // The critical writes + a best-effort hero warm:
        //  1) persist identity (+ content settings when the age step was used),
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
        if (timedOut) throw new Error('This is taking longer than expected — check your connection.')
        // Hold a minimum beat so the celebratory loader never just flashes.
        const elapsed = Date.now() - t0
        if (elapsed < 4200) await sleep(4200 - elapsed)
        if (!cancelled) onDone()
      } catch (e) {
        if (!cancelled) {
          clearInterval(msgIv)
          clearTimeout(shimmerTo)
          setError(e instanceof Error ? e.message : 'Something went wrong building your Aurora.')
        }
      }
    })()

    return () => {
      cancelled = true
      clearInterval(msgIv)
      clearTimeout(shimmerTo)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, loadNonce])

  // The nav bar belongs to the input steps — the ones with a Back/Continue
  // contract. Derived from the machine so a new input step gets it for free.
  const showNav = machine.inputs.includes(step)
  const nebulaForWelcome = avatarId ?? 'aurora'

  return (
    // role="dialog" + aria-modal, matching ProfilesGate. This overlay has always
    // covered the whole app without saying so, but it used to appear only to
    // profiles that had never onboarded. The referral-only pass shows it to
    // people who finished onboarding long ago, so a screen reader now has to be
    // told a modal question arrived rather than leaving the user reading the
    // still-exposed app underneath.
    <div
      className="fixed inset-0 z-[80] flex flex-col overflow-hidden bg-[#07060c] aurora-bg animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={taste ? 'Set up your Aurora' : 'One quick question'}
    >
      <div className="onb-bg">
        <div className="onb-blob onb-blob1" />
        <div className="onb-blob onb-blob2" />
        <div className="onb-blob onb-blob3" />
      </div>

      {/* Top bar: brand · progress · step count · skip */}
      <header className="relative z-10 flex shrink-0 items-center gap-4 px-6 pt-6 sm:px-12">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 36 36" className="h-7 w-7 drop-shadow-[0_0_12px_rgba(168,85,247,0.55)]">
            <circle cx="18" cy="18" r="16" fill="#A855F7" />
            <path d="M14 11L26 18L14 25Z" fill="#fff" />
          </svg>
          <span className="font-display text-[1.05rem] font-bold tracking-tight text-white">
            {/* Literal hex, not the --stage-purple-lt token: Tailwind 3 drops
                an opacity modifier on a var() colour and emits NOTHING for
                the class (review finding on the token sweep). */}
            Aurora<span className="font-medium text-[#d8b4fe]/85"> Pro</span>
          </span>
        </div>
        <div className="hidden flex-1 items-center justify-center gap-1.5 sm:flex">
          {machine.inputs.map((s, i) => (
            <span
              key={s}
              className={
                'h-1 rounded-full transition-[width] duration-500 ' +
                (i < inputIndex
                  ? 'w-8 bg-gradient-to-r from-[#a981ff] to-[#6ad7ff]'
                  : i === inputIndex
                    ? 'w-12 bg-gradient-to-r from-[#a981ff] to-[#6ad7ff]'
                    : 'w-8 bg-white/[0.12]')
              }
            />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-4">
          {inputIndex >= 0 && (
            <span className="hidden text-xs tracking-wide text-white/40 sm:inline">
              Step {inputIndex + 1} of {machine.inputs.length}
            </span>
          )}
          {step !== 'loading' && (
            <button
              type="button"
              onClick={() => void skip()}
              className="text-xs font-semibold text-white/45 transition-colors hover:text-white/80"
            >
              Skip for now
            </button>
          )}
        </div>
      </header>

      {/* Stage — auto margins center short steps and let tall steps (titles)
          scroll from the top instead of clipping their header. */}
      <div className="relative z-10 flex flex-1 flex-col overflow-y-auto px-6 sm:px-12">
        <div
          key={step}
          className={
            'onb-stagger m-auto w-full py-6 ' + (step === 'titles' ? 'max-w-5xl' : 'max-w-xl')
          }
        >
          {step === 'avatar' && renderAvatar()}
          {step === 'name' && renderName()}
          {step === 'age' && renderAge()}
          {step === 'style' && renderStyle()}
          {step === 'titles' && renderTitles()}
          {step === 'referral' && renderReferral()}
          {step === 'welcome' && renderWelcome()}
          {step === 'loading' && renderLoading()}
        </div>
      </div>

      {/* Bottom nav */}
      {showNav && (
        <footer className="relative z-10 flex shrink-0 items-center justify-between gap-4 px-6 pb-7 pt-2 sm:px-12">
          <button
            type="button"
            onClick={back}
            disabled={stepIndex === 0}
            className="rounded-full px-5 py-3 text-sm font-semibold text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white disabled:pointer-events-none disabled:opacity-0"
          >
            ← Back
          </button>
          <span className="hidden text-xs text-white/30 sm:inline">{navHint()}</span>
          <button
            type="button"
            onClick={next}
            disabled={!canAdvance()}
            className="rounded-full bg-gradient-to-b from-[#b66bff] to-[#9333ea] px-7 py-3 text-sm font-bold text-white shadow-[0_0_22px_rgba(168,85,247,0.45)] transition-ui motion-safe:hover:-translate-y-0.5 hover:shadow-[0_0_34px_rgba(168,85,247,0.65)] disabled:pointer-events-none disabled:opacity-40 disabled:shadow-none"
          >
            {step === 'titles' ? 'Build my Aurora →' : 'Continue →'}
          </button>
        </footer>
      )}
    </div>
  )

  function navHint(): string {
    if (step === 'avatar') return 'Tap a nebula — change it anytime'
    if (step === 'referral') return 'Arrow keys move between options'
    if (step === 'titles') return `Pick at least ${minPicks} — more is better`
    if (step === 'style') return 'Applies live, everywhere'
    return ''
  }

  function renderAvatar() {
    return (
      <>
        <Eyebrow>Pick your aura</Eyebrow>
        <h1 className="font-display text-[clamp(1.9rem,4vw,2.8rem)] font-bold leading-[1.05] tracking-tight text-white">
          Choose the nebula that’s you.
        </h1>
        <p className="mt-3 max-w-md text-[0.95rem] leading-relaxed text-white/55">
          Each one is a living Aurora Pro signature. It follows your profile everywhere — and you can
          switch it anytime.
        </p>
        <div className="mt-8 grid grid-cols-5 gap-3 sm:gap-5">
          {NEBULAS.map((n) => {
            const sel = avatarId === n.id
            return (
              <div key={n.id} className="text-center">
                <button
                  type="button"
                  onClick={() => setAvatarId(n.id)}
                  aria-pressed={sel}
                  aria-label={n.name}
                  className={
                    'relative block aspect-square w-full rounded-full p-0 transition-transform duration-300 ' +
                    (sel ? 'motion-safe:scale-110' : 'motion-safe:hover:-translate-y-0.5 motion-safe:hover:scale-[1.04]')
                  }
                  style={
                    sel
                      ? { boxShadow: '0 0 0 3px rgba(255,255,255,0.16), 0 10px 44px rgba(168,85,247,0.4)' }
                      : undefined
                  }
                >
                  <NebulaAvatar nebula={n} active={sel} className="block h-full w-full" />
                  {sel && (
                    <span className="absolute bottom-[6%] right-[6%] z-[3] grid h-5 w-5 place-items-center rounded-full bg-white text-[#0a0810] shadow">
                      <CheckIcon className="h-3 w-3" />
                    </span>
                  )}
                </button>
                <div
                  className={
                    'mt-2 text-[0.72rem] tracking-wide transition-colors ' +
                    (sel ? 'text-white' : 'text-white/40')
                  }
                >
                  {n.name}
                </div>
              </div>
            )
          })}
        </div>
      </>
    )
  }

  function renderName() {
    return (
      <div className="text-center">
        <Eyebrow>The basics</Eyebrow>
        <h1 className="font-display text-[clamp(1.9rem,4.4vw,3rem)] font-bold leading-[1.04] tracking-tight text-white">
          What should we call you?
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-[0.95rem] leading-relaxed text-white/55">
          Your first name or a nickname — whatever feels like you.
        </p>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canAdvance()) next()
          }}
          maxLength={24}
          placeholder="Type your name"
          className="font-display mt-8 w-full border-b-2 border-white/[0.14] bg-transparent pb-3 text-center text-[clamp(2rem,6vw,3rem)] font-bold text-white outline-none transition-colors placeholder:text-white/15 focus:border-[#a855f7]"
        />
        <div className="mt-6 min-h-[1.4em] text-[1.05rem] text-white/60">
          {name.trim() ? (
            <>
              Nice to meet you, <b className="font-semibold text-white">{name.trim()}</b> 👋
            </>
          ) : (
            ''
          )}
        </div>
      </div>
    )
  }

  function renderAge() {
    const r = ratingForAge(age)
    // What a limit-free sole profile gets is the lean alone, so say so.
    const noLimit = soleUnrestricted && !ceilingLocked && r.maxRating !== ''
    const pct = ((age - 4) / (80 - 4)) * 100
    return (
      <div className="text-center">
        <Eyebrow>A little about you</Eyebrow>
        <h1 className="font-display text-[clamp(1.9rem,4.4vw,3rem)] font-bold tracking-tight text-white">
          How old are you?
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-[0.95rem] leading-relaxed text-white/55">
          {ceilingLocked
            ? `This profile has a content limit (${profile?.max_age_rating}), so its age can’t be changed here.`
            : noLimit
              ? 'This is the account’s only profile without a content limit, so your age tunes what’s recommended but sets no limit. To limit what a child sees, give them their own profile.'
              : 'This tailors your recommendations and keeps things age-appropriate.'}
        </p>
        <div
          className="font-display mt-6 bg-gradient-to-b from-white to-[#d8b4fe] bg-clip-text text-[clamp(3.2rem,10vw,5rem)] font-bold leading-none text-transparent"
          style={{ WebkitTextFillColor: 'transparent' }}
        >
          {age}
        </div>
        <div
          className="mt-5 inline-flex items-center gap-2.5 rounded-full border px-4 py-2"
          style={{ background: `${r.tone}22`, borderColor: `${r.tone}55` }}
        >
          <span className="text-[0.86rem] font-semibold" style={{ color: r.tone }}>
            {r.tier}
          </span>
          <span className="h-1 w-1 rounded-full bg-white/30" />
          <span className="text-[0.74rem] text-white/55">{noLimit ? 'No content limit' : r.tag}</span>
        </div>
        <input
          type="range"
          min={4}
          max={80}
          value={age}
          disabled={ceilingLocked}
          aria-label="Age"
          onChange={(e) => {
            setAge(parseInt(e.target.value, 10))
            setAgeTouched(true)
          }}
          className="onb-range mt-8 w-full"
          style={{ '--p': `${pct}%` } as CSSProperties}
        />
        <div className="mt-3 flex justify-between text-[0.7rem] text-white/35">
          <span>4</span>
          <span>18</span>
          <span>40</span>
          <span>60</span>
          <span>80</span>
        </div>
      </div>
    )
  }

  function renderStyle() {
    return (
      <>
        <Eyebrow>Make it yours</Eyebrow>
        <h1 className="font-display text-[clamp(1.9rem,4vw,2.8rem)] font-bold tracking-tight text-white">
          Set the mood.
        </h1>
        <p className="mt-3 max-w-md text-[0.95rem] leading-relaxed text-white/55">
          Your typeface and glow apply instantly — across this whole experience and the app.
        </p>

        <div className="mt-7 text-[0.72rem] uppercase tracking-[0.16em] text-white/50">Typeface</div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {FONT_OPTIONS.map((f) => {
            const sel = font === f.id
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setFont(f.id)
                  applyFont(f.id)
                }}
                className={
                  'glass-card relative rounded-2xl p-4 text-left transition-ui ' +
                  (sel ? 'ring-2 ring-[#a855f7]/70' : '')
                }
              >
                {sel && (
                  <span className="absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full bg-[#a855f7]">
                    <CheckIcon className="h-3 w-3" />
                  </span>
                )}
                <div className="text-[1.3rem] font-bold text-white" style={{ fontFamily: f.font }}>
                  Aurora Pro
                </div>
                <div className="mt-0.5 text-[0.72rem] text-white/45">{f.label} · {f.desc}</div>
                <div className="mt-2 text-[0.8rem] text-white/60" style={{ fontFamily: f.font }}>
                  The quick stream brings stories to life.
                </div>
              </button>
            )
          })}
        </div>

        <div className="mt-6 text-[0.72rem] uppercase tracking-[0.16em] text-white/50">Glow style</div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          {GLOW_OPTIONS.map((g) => {
            const sel = glow === g.id
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => {
                  setGlow(g.id)
                  applyGlow(g.id)
                }}
                className={
                  'glass-card rounded-2xl p-4 text-center transition-ui ' +
                  (sel ? 'ring-2 ring-[#a855f7]/70' : '')
                }
              >
                <div
                  className="mx-auto mb-3 h-10 w-10 rounded-full"
                  style={{
                    background: 'radial-gradient(circle at 40% 35%, #fff, #a855f7 60%, #7e22ce)',
                    boxShadow:
                      g.id === 'subtle'
                        ? '0 0 0 1px rgba(255,255,255,.18), 0 0 10px rgba(255,255,255,.12)'
                        : g.id === 'heavy'
                          ? '0 0 0 1px rgba(220,200,255,.6), 0 0 36px rgba(168,85,247,.8), 0 0 70px rgba(255,255,255,.25)'
                          : '0 0 0 1px rgba(220,200,255,.4), 0 0 22px rgba(168,85,247,.5), 0 0 44px rgba(255,255,255,.1)',
                  }}
                />
                <div className="text-[0.88rem] font-semibold text-white">{g.label}</div>
                <div className="mt-0.5 text-[0.66rem] text-white/45">{g.desc}</div>
              </button>
            )
          })}
        </div>
      </>
    )
  }

  function renderTitles() {
    const remaining = Math.max(0, minPicks - selected.length)
    return (
      <>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Eyebrow>Pick what you love</Eyebrow>
            <h1 className="font-display text-[clamp(1.7rem,3.6vw,2.4rem)] font-bold tracking-tight text-white">
              Tap a few you’re into.
            </h1>
          </div>
          <div className="text-[0.82rem] text-white/55">
            {selected.length >= minPicks ? (
              <>
                <b className="font-semibold text-[color:var(--stage-purple-lt)]">{selected.length}</b> picked · the more you
                choose, the sharper your Aurora ✨
              </>
            ) : (
              <>
                <b className="font-semibold text-[color:var(--stage-purple-lt)]">{selected.length}</b> selected · pick {remaining}{' '}
                more (min {minPicks})
              </>
            )}
          </div>
        </div>

        {gridLoading ? (
          <div className="mt-6 grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className="aspect-[2/3] animate-pulse rounded-xl bg-white/[0.04]" />
            ))}
          </div>
        ) : grid.length === 0 ? (
          <div className="py-20 text-center text-white/50">
            <p>Your library is still being prepared for recommendations.</p>
            <button type="button" onClick={() => void skip()} className="mt-4 text-[#a981ff] hover:underline">
              Continue to Aurora
            </button>
          </div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
              {grid.map((m) => (
                <PosterTile key={m.id} m={m} selected={selectedSet.has(m.id)} onToggle={toggle} />
              ))}
            </div>
            {hasMore && (
              <div className="mt-6 flex justify-center">
                <button
                  type="button"
                  onClick={() => void showMore()}
                  disabled={loadingMore}
                  className="rounded-full border border-white/[0.12] bg-white/[0.04] px-6 py-2.5 text-sm font-semibold text-white/80 transition-colors hover:bg-white/[0.08] disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Show more'}
                </button>
              </div>
            )}
            {reactive.length > 0 && (
              <section className="mt-10">
                <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-white/70">
                  More like your picks
                </h3>
                <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                  {reactive.map((m) => (
                    <PosterTile key={m.id} m={m} selected={selectedSet.has(m.id)} onToggle={toggle} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </>
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
    // The single tab stop, computed the SAME way the arrow handler computes
    // "current" so the two cannot disagree. Deriving it from an index rather
    // than from `active` also keeps the group in the tab ring when nothing is
    // selected yet — and, unlike an `active || isFirst` test, it cannot land in
    // a state where NO option is focusable if referralChoice ever holds a key
    // that isn't in the list.
    const tabStop = Math.max(0, keys.indexOf(referralChoice ?? ''))
    return (
      <>
        <Eyebrow>One quick thing</Eyebrow>
        {/* Admin-authored text, rendered as text. Never dangerouslySetInnerHTML. */}
        <h1 className="font-display text-[clamp(1.9rem,4vw,2.8rem)] font-bold leading-[1.05] tracking-tight text-white">
          {referral?.question || 'How did you hear about Aurora?'}
        </h1>
        <p className="mt-3 max-w-md text-[0.95rem] leading-relaxed text-white/55">
          It helps us know where to show up. Entirely optional — skip if you'd rather not say.
        </p>

        <div
          role="radiogroup"
          aria-label={referral?.question || 'How did you hear about Aurora?'}
          className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2"
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
                className="stage-opt text-left"
              >
                <p className={`text-sm font-medium ${active ? 'text-white' : 'text-white/80'}`}>
                  {opt.label}
                </p>
              </button>
            )
          })}
        </div>

        <div className="mt-5">
          {/* The reveal is announced: the field appears in response to a
              selection, which a screen-reader user would otherwise never learn
              about. A real <label>, not a placeholder — placeholders vanish on
              input and aren't reliably announced. */}
          <div aria-live="polite" className="min-h-[5.25rem]">
            {otherChosen && (
              <div>
                <label
                  htmlFor="referral-detail"
                  className="block text-[0.8rem] font-medium text-white/75"
                >
                  Where, specifically? <span className="text-white/45">(optional)</span>
                </label>
                <input
                  id="referral-detail"
                  type="text"
                  value={referralDetail}
                  maxLength={REFERRAL_DETAIL_MAX}
                  onChange={(e) => setReferralDetail(e.target.value)}
                  placeholder="A podcast, a forum, a friend's setup…"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder:text-white/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a855f7]/70"
                />
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              sendReferral({ skip: true })
              const n = nextStep(machine, 'referral')
              if (n) { goTo(n); return }
              void settleReferral().then(onDone)
            }}
            className="mt-4 rounded-full px-5 py-2.5 text-sm font-semibold text-white/75 ring-1 ring-white/[0.16] transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            Skip this question
          </button>
        </div>
      </>
    )
  }

  function renderWelcome() {
    return (
      <div className="text-center">
        <div className="onb-floaty mx-auto mb-8 h-[140px] w-[140px]">
          <NebulaAvatar nebula={nebulaForWelcome} size={140} />
        </div>
        <h1 className="font-display text-[clamp(2.1rem,6vw,3.4rem)] font-extrabold tracking-tight text-white">
          Welcome to Aurora,
          <br />
          <span className="onb-shimmer-text">{name.trim() || 'friend'}.</span>
        </h1>
        <p className="mt-4 text-[1.05rem] text-white/60">
          Your universe is being arranged around your taste.
        </p>
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
          className="mt-9 rounded-full bg-gradient-to-b from-[#b66bff] to-[#9333ea] px-8 py-3.5 text-sm font-bold text-white shadow-[0_0_22px_rgba(168,85,247,0.5)] transition-ui motion-safe:hover:-translate-y-0.5 hover:shadow-[0_0_34px_rgba(168,85,247,0.7)]"
        >
          Take me in →
        </button>
      </div>
    )
  }

  function renderLoading() {
    return (
      <div className="relative text-center">
        <Constellation accent={NEBULAS.find((n) => n.id === nebulaForWelcome)?.c1 ?? '#a855f7'} />
        <div className="relative z-[2] mx-auto max-w-xl">
          <div className="relative mx-auto h-24 w-24">
            <div className="onb-ring" />
            <div className="onb-ring2" />
            <svg viewBox="0 0 36 36" className="onb-pulse-mark h-24 w-24">
              <circle cx="18" cy="18" r="16" fill="none" stroke="#A855F7" strokeWidth="2" opacity="0.5" />
              <path d="M14 11L26 18L14 25Z" fill="#A855F7" />
            </svg>
          </div>
          <div className="font-display mt-7 text-[clamp(1.5rem,4vw,2.1rem)] font-bold text-white">
            Building your Aurora
          </div>
          <div className="mt-2 text-[0.95rem] text-white/50">{LOADING_MESSAGES[phaseMsg]}</div>

          <div
            className={'mx-auto mt-8 flex max-w-[640px] flex-wrap justify-center gap-2 ' + (mosaicShimmer ? 'onb-mosaic-shimmer' : '')}
          >
            {mosaicPosters.map((m, i) => (
              <span
                key={m.id}
                className="onb-mtile onb-in block h-[92px] w-[62px]"
                style={
                  {
                    '--rot': `${(i % 2 ? 1 : -1) * (2 + (i % 3))}deg`,
                    animationDelay: `${250 + i * 140}ms`,
                    backgroundImage: m.poster ? `url(${m.poster})` : undefined,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  } as CSSProperties
                }
              >
                <span className="onb-shine" />
              </span>
            ))}
          </div>

          {error ? (
            <div className="mx-auto mt-8 max-w-sm">
              <p className="text-sm text-red-300">{error}</p>
              <div className="mt-3 flex justify-center gap-3">
                <button
                  type="button"
                  onClick={retryLoad}
                  className="rounded-full bg-gradient-to-b from-[#b66bff] to-[#9333ea] px-5 py-2.5 text-sm font-bold text-white"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => void skip()}
                  className="rounded-full border border-white/[0.12] px-5 py-2.5 text-sm font-semibold text-white/70 hover:bg-white/[0.06]"
                >
                  Skip
                </button>
              </div>
            </div>
          ) : (
            <div className="mx-auto mt-7 h-[5px] max-w-[330px] overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#a855f7] to-[#d8b4fe] shadow-[0_0_14px_rgba(168,85,247,0.7)] transition-[width] duration-500"
                style={{ width: `${((phaseMsg + 1) / LOADING_MESSAGES.length) * 100}%` }}
              />
            </div>
          )}
        </div>
      </div>
    )
  }
}

// ---- small pieces ----

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    // Literal hex with its alpha: `text-[color:var(--stage-purple-lt)]/80`
    // compiles to no CSS in Tailwind 3 (opacity modifiers need a parseable
    // colour), which silently turned every eyebrow white.
    <div className="mb-3 flex items-center gap-2 text-[0.72rem] uppercase tracking-[0.22em] text-[#d8b4fe]/80">
      <span className="h-1.5 w-1.5 rounded-full bg-[#a855f7] shadow-[0_0_8px_#a855f7]" />
      {children}
    </div>
  )
}

function PosterTile({
  m,
  selected,
  onToggle,
}: {
  m: UIMedia
  selected: boolean
  onToggle: (id: number) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(m.id)}
      aria-pressed={selected}
      className={
        'group relative aspect-[2/3] overflow-hidden rounded-xl border text-left transition-ui ' +
        (selected
          ? 'border-transparent outline outline-2 outline-[#a981ff] shadow-[0_0_0_1px_#a981ff,0_14px_38px_-12px_rgba(169,129,255,0.55)]'
          : 'border-white/[0.08] motion-safe:hover:-translate-y-1 hover:shadow-2xl')
      }
    >
      {m.poster ? (
        <img src={m.poster} alt={m.title} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-[#1d1330] to-[#050409]" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
      <span
        className={
          'absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full border-2 transition-ui ' +
          (selected ? 'border-transparent bg-gradient-to-br from-[#a981ff] to-[#c8a6ff]' : 'border-white/60 bg-black/30 backdrop-blur-sm')
        }
      >
        {selected && <CheckIcon className="h-3.5 w-3.5" stroke="#160f24" />}
      </span>
      <div className="absolute bottom-2 left-2.5 right-2.5 z-[1]">
        <div className="line-clamp-2 text-[13px] font-bold leading-tight text-white drop-shadow">{m.title}</div>
        {m.year > 0 && <div className="mt-0.5 text-[11px] text-white/65">{m.year}</div>}
      </div>
    </button>
  )
}

function CheckIcon({ className = 'h-3.5 w-3.5', stroke = '#0a0810' }: { className?: string; stroke?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M5 12.5l4.2 4.2L19 7" stroke={stroke} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Constellation — particle field that drifts toward the centre and links nearby
// nodes, forming a loose constellation behind the building loader. Pure canvas.
function Constellation({ accent }: { accent: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let raf = 0
    const resize = () => {
      cv.width = cv.clientWidth * dpr
      cv.height = cv.clientHeight * dpr
    }
    resize()
    const N = 60
    const pts = Array.from({ length: N }, () => ({
      x: Math.random() * cv.width,
      y: Math.random() * cv.height,
      vx: (Math.random() - 0.5) * 0.25 * dpr,
      vy: (Math.random() - 0.5) * 0.25 * dpr,
      r: (Math.random() * 1.6 + 0.6) * dpr,
    }))
    let t = 0
    const frame = () => {
      t += 0.006
      const cx = cv.width / 2
      const cy = cv.height * 0.32
      ctx.clearRect(0, 0, cv.width, cv.height)
      for (const p of pts) {
        p.x += p.vx
        p.y += p.vy
        p.x += (cx - p.x) * 0.0006 * Math.min(t, 1)
        p.y += (cy - p.y) * 0.0006 * Math.min(t, 1)
        if (p.x < 0 || p.x > cv.width) p.vx *= -1
        if (p.y < 0 || p.y > cv.height) p.vy *= -1
      }
      const max = 120 * dpr
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const a = pts[i]
          const b = pts[j]
          const d = Math.hypot(a.x - b.x, a.y - b.y)
          if (d < max) {
            ctx.strokeStyle = `rgba(168,85,247,${(1 - d / max) * 0.28})`
            ctx.lineWidth = 0.6 * dpr
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }
      for (const p of pts) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, 7)
        ctx.fillStyle = 'rgba(216,180,254,0.85)'
        ctx.shadowColor = accent
        ctx.shadowBlur = 8 * dpr
        ctx.fill()
      }
      ctx.shadowBlur = 0
      // Honor reduced-motion: draw one static constellation frame, don't loop.
      if (!reduceMotion) raf = requestAnimationFrame(frame)
    }
    frame()
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [accent])
  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" />
}
