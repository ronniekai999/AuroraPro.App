import { useCallback, useEffect, useState } from 'react'
import {
  getOnboardingStatus,
  getOnboardingGrid,
  getOnboardingPreview,
  saveOnboardingSeeds,
  skipOnboarding,
  type UIMedia,
  type OnboardingStatus,
} from '@/lib/api'

interface TasteOnboardingGateProps {
  /** Active profile id, or null to use the account's default profile. */
  profileId: number | null
  /** Called after the user finishes or skips — host can refresh Home. */
  onComplete?: () => void
}

type Phase = 'checking' | 'show' | 'hidden'

/**
 * TasteOnboardingGate fetches the per-profile onboarding status and, when the
 * profile is eligible and hasn't completed onboarding, renders the full-screen
 * "Pick What You Love" overlay. Renders nothing otherwise — so it's safe to
 * mount once, unconditionally, in the authenticated app tree. Existing users
 * (whose profiles default to not-completed after the migration) get prompted
 * once at their next login.
 */
export function TasteOnboardingGate({ profileId, onComplete }: TasteOnboardingGateProps) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [status, setStatus] = useState<OnboardingStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    setPhase('checking')
    getOnboardingStatus(profileId ?? undefined, ac.signal)
      .then((s) => {
        if (cancelled) return
        setStatus(s)
        setPhase(s.eligible && !s.completed ? 'show' : 'hidden')
      })
      .catch(() => {
        // Never block the app on this — onboarding is a nicety, not a gate.
        if (!cancelled) setPhase('hidden')
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [profileId])

  if (phase !== 'show' || !status) return null

  return (
    <TasteOnboardingOverlay
      profileId={profileId}
      status={status}
      onDone={() => {
        setPhase('hidden')
        onComplete?.()
      }}
    />
  )
}

interface OverlayProps {
  profileId: number | null
  status: OnboardingStatus
  onDone: () => void
}

function TasteOnboardingOverlay({ profileId, status, onDone }: OverlayProps) {
  const minPicks = status.min_picks || 5
  const previewThreshold = status.threshold || 3

  const [grid, setGrid] = useState<UIMedia[]>([])
  const [gridLoading, setGridLoading] = useState(true)
  const [selected, setSelected] = useState<number[]>([])
  const [preview, setPreview] = useState<UIMedia[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load the poster grid once.
  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    setGridLoading(true)
    getOnboardingGrid(profileId ?? undefined, 40, ac.signal)
      .then((items) => {
        if (!cancelled) setGrid(items)
      })
      .catch(() => {
        if (!cancelled) setGrid([])
      })
      .finally(() => {
        if (!cancelled) setGridLoading(false)
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [profileId])

  // Debounced instant preview once enough picks are selected.
  useEffect(() => {
    if (selected.length < previewThreshold) {
      setPreview([])
      return
    }
    const ac = new AbortController()
    const t = setTimeout(() => {
      getOnboardingPreview(selected, profileId ?? undefined, ac.signal)
        .then(setPreview)
        .catch(() => {
          /* keep the prior preview on a transient error */
        })
    }, 350)
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [selected, previewThreshold, profileId])

  const toggle = useCallback((id: number) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  const canFinish = selected.length >= minPicks && !submitting

  const finish = useCallback(async () => {
    if (selected.length < minPicks) return
    setSubmitting(true)
    setError(null)
    try {
      await saveOnboardingSeeds(selected, profileId ?? undefined)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong — please try again.')
      setSubmitting(false)
    }
  }, [selected, minPicks, profileId, onDone])

  const skip = useCallback(async () => {
    setSubmitting(true)
    try {
      await skipOnboarding(profileId ?? undefined)
    } catch {
      /* even if the skip write fails, never trap the user behind the overlay */
    } finally {
      onDone()
    }
  }, [profileId, onDone])

  const remaining = Math.max(0, minPicks - selected.length)
  const selectedSet = new Set(selected)

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-[#07060c] aurora-bg animate-fade-in">
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            'radial-gradient(1100px 600px at 20% -10%, rgba(123,76,196,0.22), transparent 60%), radial-gradient(900px 500px at 95% 0%, rgba(56,140,180,0.12), transparent 55%)',
        }}
      />

      <header className="sticky top-0 z-10 border-b border-white/[0.06] bg-[#07060c]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-5">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight text-white">
              <SparkleIcon /> Let’s tune AuroraPro to your taste
            </h1>
            <p className="mt-1 text-sm text-white/55">
              Pick {minPicks} movies or shows you love and we’ll build your recommendations around
              them. No pressure — you can skip and do this anytime from Settings.
            </p>
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={skip}
            disabled={submitting}
            className="px-4 py-2 text-sm font-semibold text-white/60 transition-colors hover:text-white disabled:opacity-50"
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={finish}
            disabled={!canFinish}
            className="rounded-full bg-gradient-to-br from-[#a981ff] to-[#c8a6ff] px-6 py-2 text-sm font-extrabold text-[#160f24] shadow-[0_8px_30px_-8px_rgba(169,129,255,0.55)] transition-all disabled:bg-none disabled:bg-white/[0.08] disabled:text-white/40 disabled:shadow-none"
          >
            {submitting ? 'Saving…' : selected.length >= minPicks ? `Done · ${selected.length}` : 'Done'}
          </button>
        </div>
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 pb-4">
          <div className="flex gap-1.5">
            {Array.from({ length: minPicks }).map((_, i) => (
              <span
                key={i}
                className={
                  'h-1.5 w-6 rounded-full transition-all ' +
                  (i < selected.length
                    ? 'bg-gradient-to-r from-[#a981ff] to-[#6ad7ff]'
                    : 'bg-white/[0.12]')
                }
              />
            ))}
          </div>
          <span className="text-xs text-white/50">
            {selected.length >= minPicks
              ? '✓ Looks great — these go straight to your Home.'
              : selected.length >= previewThreshold
                ? `Nice — a preview is ready below. Pick ${remaining} more to finish.`
                : `Choose ${remaining} to unlock your picks.`}
          </span>
        </div>
      </header>

      <main className="relative mx-auto max-w-6xl px-6 pb-40 pt-6">
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        {gridLoading ? (
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className="aspect-[2/3] animate-pulse rounded-xl bg-white/[0.04]" />
            ))}
          </div>
        ) : grid.length === 0 ? (
          <div className="py-20 text-center text-white/50">
            <p>Your library is still being prepared for recommendations.</p>
            <button type="button" onClick={skip} className="mt-4 text-[#a981ff] hover:underline">
              Continue to AuroraPro
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {grid.map((m) => {
              const isSel = selectedSet.has(m.id)
              return (
                <button
                  type="button"
                  key={m.id}
                  onClick={() => toggle(m.id)}
                  aria-pressed={isSel}
                  className={
                    'group relative aspect-[2/3] overflow-hidden rounded-xl border text-left transition-all ' +
                    (isSel
                      ? 'border-transparent outline outline-2 outline-[#a981ff] shadow-[0_0_0_1px_#a981ff,0_14px_38px_-12px_rgba(169,129,255,0.55)]'
                      : 'border-white/[0.08] hover:-translate-y-1 hover:shadow-2xl')
                  }
                >
                  {m.poster ? (
                    <img
                      src={m.poster}
                      alt={m.title}
                      loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-gradient-to-br from-[#1d1330] to-[#050409]" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
                  <span
                    className={
                      'absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full border-2 transition-all ' +
                      (isSel
                        ? 'border-transparent bg-gradient-to-br from-[#a981ff] to-[#c8a6ff]'
                        : 'border-white/60 bg-black/30 backdrop-blur-sm')
                    }
                  >
                    {isSel && <CheckIcon />}
                  </span>
                  <div className="absolute bottom-2 left-2.5 right-2.5 z-[1]">
                    <div className="line-clamp-2 text-[13px] font-bold leading-tight text-white drop-shadow">
                      {m.title}
                    </div>
                    {m.year > 0 && <div className="mt-0.5 text-[11px] text-white/65">{m.year}</div>}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </main>

      {preview.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-white/[0.12] bg-gradient-to-t from-[#0a0812]/95 to-[#0c0a16]/85 shadow-[0_-20px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl animate-fade-in">
          <div className="mx-auto max-w-6xl px-6 py-4">
            <h2 className="flex items-center gap-2 text-[15px] font-extrabold text-white">
              <SparkleIcon className="h-4 w-4" /> Your first recommendations
            </h2>
            <p className="mb-3 mt-0.5 text-xs text-white/50">
              Based on what you’ve picked so far — these land on your Home when you’re done.
            </p>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {preview.map((m) => (
                <div key={m.id} className="w-[104px] flex-none">
                  <div className="aspect-[2/3] overflow-hidden rounded-lg border border-white/[0.08]">
                    {m.poster ? (
                      <img
                        src={m.poster}
                        alt={m.title}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full bg-gradient-to-br from-[#10243f] to-[#050409]" />
                    )}
                  </div>
                  <div className="mt-1.5 line-clamp-2 text-[11px] font-semibold leading-tight text-white/80">
                    {m.title}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SparkleIcon({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2l1.9 5.6L19.5 9l-5.6 1.9L12 16l-1.9-5.1L4.5 9l5.6-1.4L12 2z" fill="#c8a6ff" />
      <path d="M19 14l.8 2.3L22 17l-2.2.7L19 20l-.8-2.3L16 17l2.2-.7L19 14z" fill="#6ad7ff" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="M5 12.5l4.2 4.2L19 7"
        stroke="#160f24"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
