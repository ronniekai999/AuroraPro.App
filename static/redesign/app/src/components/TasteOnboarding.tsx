import { useEffect, useState } from 'react'
import { getOnboardingStatus, type OnboardingStatus } from '@/lib/api'
import { OnboardingFlow } from './OnboardingFlow'

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
 * onboarding flow (avatar → name → age → appearance → "Pick What You Love" →
 * welcome → building). Renders nothing otherwise — so it's safe to mount once,
 * unconditionally, in the authenticated app tree. Existing users (whose profiles
 * default to not-completed after the taste-seeds migration) get prompted once at
 * their next login.
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
    <OnboardingFlow
      profileId={profileId}
      status={status}
      onDone={() => {
        setPhase('hidden')
        onComplete?.()
      }}
    />
  )
}
