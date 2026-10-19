import { useEffect, useState } from 'react'
import {
  getOnboardingStatus,
  getReferralPrompt,
  type OnboardingStatus,
  type Profile,
  type ReferralPromptState,
} from '@/lib/api'
import { OnboardingFlow } from './OnboardingFlow'

interface TasteOnboardingGateProps {
  /** Active profile id, or null for the session's acting profile. */
  profileId: number | null
  /** The active profile, used to PRE-FILL the flow (name, avatar, current age
   *  rating) so returning users don't have their existing settings clobbered. */
  profile?: Profile | null
  /** The profile is the account's only one without a content limit. */
  soleUnrestricted?: boolean
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
 *
 * It also carries the referral prompt (migration 046), which is ACCOUNT-scoped
 * rather than profile-scoped and has its own independent trigger. Two reasons
 * it rides along here instead of getting its own gate: it belongs in the same
 * first-run moment, and mounting a second full-screen overlay would put it in a
 * z-order fight with this one and with ProfilesGate.
 *
 * The referral prompt can therefore show even when taste onboarding does not.
 * That is deliberate. The taste flow doesn't run for a profile that already
 * completed it, or on a library with no embeddings — and its prominent "Skip
 * for now" closes everything from step one. Without an independent trigger, an
 * eligible user who took any of those paths would stay pending forever and
 * never be asked, which is exactly the attribution gap this feature exists to
 * close. When only the referral is owed, the flow collapses to that one
 * question plus a send-off (see buildSteps).
 */
export function TasteOnboardingGate({ profileId, profile, soleUnrestricted, onComplete }: TasteOnboardingGateProps) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [taste, setTaste] = useState(false)
  const [referral, setReferral] = useState<ReferralPromptState | null>(null)

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    setPhase('checking')
    // Both reads in parallel, and neither can veto the other: allSettled means a
    // referral-endpoint failure still lets taste onboarding run, and vice versa.
    Promise.allSettled([
      getOnboardingStatus(profileId ?? undefined, ac.signal),
      getReferralPrompt(ac.signal),
    ])
      .then(([statusRes, referralRes]) => {
        if (cancelled) return
        const s = statusRes.status === 'fulfilled' ? statusRes.value : null
        const r = referralRes.status === 'fulfilled' ? referralRes.value : null
        const wantsTaste = !!s && s.eligible && !s.completed
        const wantsReferral = !!r?.pending
        setStatus(s)
        setTaste(wantsTaste)
        setReferral(r)
        setPhase(wantsTaste || wantsReferral ? 'show' : 'hidden')
      })
    // No .catch: allSettled never rejects, and each result is unwrapped
    // defensively above — a failed fetch simply contributes nothing, which is
    // the "never block the app on a nicety" behaviour this gate has always had.
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [profileId])

  if (phase !== 'show') return null
  // The flow reads status.profile_id and status.min_picks. In a referral-only
  // pass the status fetch may have failed or reported ineligible, so synthesize
  // the shape rather than making every consumer null-check a field it only uses
  // on the taste path.
  const effectiveStatus: OnboardingStatus = status ?? {
    profile_id: profileId ?? 0,
    completed: true,
    eligible: false,
    library_embedded: false,
    min_picks: 5,
    threshold: 3,
    seed_count: 0,
  }

  return (
    <OnboardingFlow
      profileId={profileId}
      profile={profile}
      status={effectiveStatus}
      taste={taste}
      referral={referral}
      soleUnrestricted={soleUnrestricted}
      onDone={() => {
        setPhase('hidden')
        onComplete?.()
      }}
    />
  )
}
