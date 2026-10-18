// Profile switching for the web app. A switch takes effect only once the
// server has bound it to the session, because every ceiling is enforced from
// that binding (issue #462). The app used to switch its own display first and
// activate fire-and-forget, so a failed call left a kid's UI on the kid profile
// while the server enforced the parent's ceiling.
//
// A locked profile first asks for its PIN or the account password: the hook
// exposes the profile waiting on one (`pinTarget`), and the host renders
// ProfilePinDialog wired to `unlock` and `cancelPin`.

import { useCallback, useRef, useState } from 'react'
import { activateProfile, profileErrorReason, type Profile, type ProfileUnlock } from './api'

export function useProfileSwitch({ profiles, activeProfileId, setActiveProfileId, onError }: {
  profiles: Profile[]
  activeProfileId: number | null
  setActiveProfileId: (id: number) => void
  /** Reports a switch the server refused for a reason other than a PIN. */
  onError: (profile: Profile) => void
}) {
  const [pinTarget, setPinTarget] = useState<Profile | null>(null)
  const pinResolveRef = useRef<((switched: boolean) => void) | null>(null)

  const settle = useCallback((switched: boolean) => {
    const resolve = pinResolveRef.current
    pinResolveRef.current = null
    setPinTarget(null)
    resolve?.(switched)
  }, [])

  // Resolves true once the switch has happened, false when it did not (a
  // refused activation, a cancelled PIN prompt), so a caller such as the
  // "Who's watching?" gate can stay up until it has.
  const switchProfile = useCallback(async (id: number): Promise<boolean> => {
    if (id === activeProfileId) return true
    const target = profiles.find(p => p.id === id)
    if (!target) return false
    const askForPin = () => new Promise<boolean>(resolve => {
      pinResolveRef.current?.(false)
      pinResolveRef.current = resolve
      setPinTarget(target)
    })
    if (target.has_pin) return askForPin()
    try {
      await activateProfile(id)
    } catch (e) {
      // The list can be stale: a PIN set from another device since it loaded.
      if (profileErrorReason(e) === 'profile_pin_required') return askForPin()
      onError(target)
      return false
    }
    setActiveProfileId(id)
    return true
  }, [activeProfileId, profiles, setActiveProfileId, onError])

  // Sends the PIN or password for pinTarget. Rejects with the server's refusal,
  // which the dialog shows; the prompt stays open until this succeeds.
  const unlock = useCallback(async (credential: ProfileUnlock) => {
    const target = pinTarget
    if (!target) return
    await activateProfile(target.id, credential)
    setActiveProfileId(target.id)
    settle(true)
  }, [pinTarget, setActiveProfileId, settle])

  const cancelPin = useCallback(() => settle(false), [settle])

  return { pinTarget, switchProfile, unlock, cancelPin }
}
