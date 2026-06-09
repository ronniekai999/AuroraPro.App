import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  getOnboardingGrid,
  saveOnboardingSeeds,
  skipOnboarding,
  updateProfile,
  getHeroPool,
  getDiscoverRails,
  getEngagementRails,
  type UIMedia,
  type OnboardingStatus,
} from '@/lib/api'
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
import { NEBULAS, NebulaAvatar, nebulaValue } from './NebulaAvatar'

interface OnboardingFlowProps {
  /** Active profile id, or null to use the account's default profile. */
  profileId: number | null
  status: OnboardingStatus
  /** Called once everything is persisted and the rails are warmed. */
  onDone: () => void
}

type Step = 'avatar' | 'name' | 'age' | 'style' | 'titles' | 'welcome' | 'loading'
const STEP_ORDER: readonly Step[] = ['avatar', 'name', 'age', 'style', 'titles', 'welcome', 'loading']
const INPUT_STEPS: readonly Step[] = ['avatar', 'name', 'age', 'style', 'titles']

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ratingForAge maps a chosen age to the profile's content settings, matching the
// canonical rating ladder (internal/db/ratings.go): max_age_rating is a HARD
// ceiling expanded through that ladder, maturity_pref is the SOFT recall lean
// (-1 off / 0 family / 1 teen / 2 mature). Boundaries mirror the onboarding
// mock's tiers; "TV-14" (not "PG-13") is the teen cap so teen TV is included
// while R / TV-MA stay blocked.
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

const LOADING_MESSAGES = [
  'Reading your taste signals…',
  'Scoring your library…',
  'Finding hidden gems for you…',
  'Composing your hero…',
  'Polishing your discover rails…',
]

export function OnboardingFlow({ profileId, status, onDone }: OnboardingFlowProps) {
  const minPicks = status.min_picks ?? 5
  const previewThreshold = status.threshold ?? 3

  const [step, setStep] = useState<Step>('avatar')
  const [avatarId, setAvatarId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [age, setAge] = useState(24)
  const [font, setFont] = useState<FontChoice>(() => currentFont())
  const [glow, setGlow] = useState<GlowChoice>(() => currentGlow())

  // --- taste grid (reuses the existing onboarding endpoints) ---
  const [grid, setGrid] = useState<UIMedia[]>([])
  const [gridLoading, setGridLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [reactive, setReactive] = useState<UIMedia[]>([])
  const [selected, setSelected] = useState<number[]>([])

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
  }, [profileId, remember])

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

  // ---- navigation ----
  const stepIndex = STEP_ORDER.indexOf(step)
  const inputIndex = INPUT_STEPS.indexOf(step)
  const canAdvance = (): boolean => {
    switch (step) {
      case 'avatar':
        return !!avatarId
      case 'name':
        return name.trim().length >= 1
      case 'titles':
        return selected.length >= minPicks
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
    const i = STEP_ORDER.indexOf(step)
    if (i < STEP_ORDER.length - 1) goTo(STEP_ORDER[i + 1])
  }
  const back = () => {
    const i = STEP_ORDER.indexOf(step)
    if (i > 0) goTo(STEP_ORDER[i - 1])
  }

  const skip = useCallback(async () => {
    try {
      await skipOnboarding(profileId ?? undefined)
    } catch {
      /* never trap the user behind the overlay, even if the skip write fails */
    } finally {
      onDone()
    }
  }, [profileId, onDone])

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
        const r = ratingForAge(age)
        // status.profile_id is the resolved (default) profile even when the
        // profileId prop is null, so we always have a concrete id to PUT.
        const pid = profileId ?? status.profile_id
        // The critical writes + a best-effort hero warm:
        //  1) persist identity (nickname, chosen nebula, age-derived content gate),
        //  2) save taste seeds — flips taste_onboarding_completed, mirrors picks to
        //     Favorites, invalidates the hero cache so the next build uses the new
        //     taste vector,
        //  3) warm the rails so the reloaded Home shows a built hero immediately —
        //     hero rebuilds fast; discover/engagement run in the background (their
        //     LLM/SQL builds finish via Home's own loading path).
        const work = (async () => {
          await updateProfile(pid, {
            name: name.trim(),
            avatar_url: nebulaValue(avatarId ?? 'aurora'),
            max_age_rating: r.maxRating,
            maturity_pref: r.maturityPref,
          })
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

  const showNav = step === 'avatar' || step === 'name' || step === 'age' || step === 'style' || step === 'titles'
  const nebulaForWelcome = avatarId ?? 'aurora'

  return (
    <div className="fixed inset-0 z-[80] flex flex-col overflow-hidden bg-[#07060c] aurora-bg animate-fade-in">
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
            Aurora<span className="font-medium text-[#d8b4fe]/85"> Pro</span>
          </span>
        </div>
        <div className="hidden flex-1 items-center justify-center gap-1.5 sm:flex">
          {INPUT_STEPS.map((s, i) => (
            <span
              key={s}
              className={
                'h-1 rounded-full transition-all duration-500 ' +
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
              Step {inputIndex + 1} of {INPUT_STEPS.length}
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
            className="rounded-full bg-gradient-to-b from-[#b66bff] to-[#9333ea] px-7 py-3 text-sm font-bold text-white shadow-[0_0_22px_rgba(168,85,247,0.45)] transition-all hover:-translate-y-0.5 hover:shadow-[0_0_34px_rgba(168,85,247,0.65)] disabled:pointer-events-none disabled:opacity-40 disabled:shadow-none"
          >
            {step === 'titles' ? 'Build my Aurora →' : 'Continue →'}
          </button>
        </footer>
      )}
    </div>
  )

  function navHint(): string {
    if (step === 'avatar') return 'Tap a nebula — change it anytime'
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
                    (sel ? 'scale-110' : 'hover:-translate-y-0.5 hover:scale-[1.04]')
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
    const pct = ((age - 4) / (80 - 4)) * 100
    return (
      <div className="text-center">
        <Eyebrow>A little about you</Eyebrow>
        <h1 className="font-display text-[clamp(1.9rem,4.4vw,3rem)] font-bold tracking-tight text-white">
          How old are you?
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-[0.95rem] leading-relaxed text-white/55">
          This tailors your recommendations and keeps things age-appropriate.
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
          <span className="text-[0.74rem] text-white/55">{r.tag}</span>
        </div>
        <input
          type="range"
          min={4}
          max={80}
          value={age}
          onChange={(e) => setAge(parseInt(e.target.value, 10))}
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
                  'glass-card relative rounded-2xl p-4 text-left transition-all ' +
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
                  'glass-card rounded-2xl p-4 text-center transition-all ' +
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
                <b className="font-semibold text-[#d8b4fe]">{selected.length}</b> picked · the more you
                choose, the sharper your Aurora ✨
              </>
            ) : (
              <>
                <b className="font-semibold text-[#d8b4fe]">{selected.length}</b> selected · pick {remaining}{' '}
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
          onClick={() => goTo('loading')}
          className="mt-9 rounded-full bg-gradient-to-b from-[#b66bff] to-[#9333ea] px-8 py-3.5 text-sm font-bold text-white shadow-[0_0_22px_rgba(168,85,247,0.5)] transition-all hover:-translate-y-0.5 hover:shadow-[0_0_34px_rgba(168,85,247,0.7)]"
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
                className="h-full rounded-full bg-gradient-to-r from-[#a855f7] to-[#d8b4fe] shadow-[0_0_14px_rgba(168,85,247,0.7)] transition-all duration-500"
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
        'group relative aspect-[2/3] overflow-hidden rounded-xl border text-left transition-all ' +
        (selected
          ? 'border-transparent outline outline-2 outline-[#a981ff] shadow-[0_0_0_1px_#a981ff,0_14px_38px_-12px_rgba(169,129,255,0.55)]'
          : 'border-white/[0.08] hover:-translate-y-1 hover:shadow-2xl')
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
          'absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full border-2 transition-all ' +
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
