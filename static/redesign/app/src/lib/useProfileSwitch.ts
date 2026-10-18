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

export function useProfileSwitch({ profiles, activeProfileId, setActiveProfileId, onError, readBinding, onBound }: {
  profiles: Profile[]
  activeProfileId: number | null
  setActiveProfileId: (id: number) => void
  /** Reports a switch the server refused for a reason other than a PIN. */
  onError: (profile: Profile) => void
  /** Reads the session's binding (GET /api/profiles/active): after a switch,
   * for the server's record of the profile now bound, and after a failed
   * one, whose bind may have happened with only its answer lost. */
  readBinding?: () => Promise<Profile>
  /** Stores the server's record of the bound profile in the host's list. */
  onBound?: (profile: Profile) => void
}) {
  const [pinTarget, setPinTarget] = useState<Profile | null>(null)
  const pinResolveRef = useRef<((switched: boolean) => void) | null>(null)
  // One switch at a time. Two overlapping activations can land on the server
  // in either order while their answers come back in another, and the UI
  // would then show whichever answered last rather than the binding.
  const inFlightRef = useRef(false)
  // Counts switches started, so a background read of the binding can tell
  // that one started (and perhaps finished) while it was in flight.
  const generationRef = useRef(0)

  // Shows a bind that succeeded, with the server's record of the profile: the
  // list's copy can predate an edit from another device (a new ceiling, name
  // or PIN), and what the app then shows and allows would follow the copy.
  // The read also catches another tab's switch landing in between.
  const showBinding = useCallback(async (id: number) => {
    if (readBinding && onBound) {
      try {
        const bound = await readBinding()
        onBound(bound)
        setActiveProfileId(bound.id)
        return
      } catch { /* the bind succeeded; show it as the list has it */ }
    }
    setActiveProfileId(id)
  }, [readBinding, onBound, setActiveProfileId])

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
    if (inFlightRef.current || pinResolveRef.current) return false
    const target = profiles.find(p => p.id === id)
    if (!target) return false
    const askForPin = () => new Promise<boolean>(resolve => {
      pinResolveRef.current = resolve
      setPinTarget(target)
    })
    generationRef.current++
    if (target.has_pin) return askForPin()
    inFlightRef.current = true
    try {
      await activateProfile(id)
      await showBinding(id)
    } catch (e) {
      // The list can be stale: a PIN set from another device since it loaded.
      if (profileErrorReason(e) === 'profile_pin_required') return askForPin()
      onError(target)
      // A dropped connection can lose the answer to a bind that happened,
      // so show the binding rather than what was on screen. Still in flight
      // meanwhile, so no other switch or re-read races it.
      if (readBinding) {
        try {
          const bound = await readBinding()
          if (bound.id !== activeProfileId && profiles.some(p => p.id === bound.id)) setActiveProfileId(bound.id)
        } catch { /* the tab-visibility re-read tries again */ }
      }
      return false
    } finally {
      inFlightRef.current = false
    }
    return true
  }, [activeProfileId, profiles, setActiveProfileId, onError, readBinding, showBinding])

  // Sends the PIN or password for pinTarget. Rejects with the server's refusal,
  // which the dialog shows; the prompt stays open until this succeeds.
  const unlock = useCallback(async (credential: ProfileUnlock) => {
    const target = pinTarget
    if (!target) return
    try {
      await activateProfile(target.id, credential)
    } catch (e) {
      // A refusal (wrong PIN, lockout) is the server's answer, and carries a
      // reason. Anything else (a dropped connection, a proxy's 502 or 504)
      // can have lost the answer to a bind that happened: if the session is
      // now on the profile, the switch is done.
      if (!profileErrorReason(e) && readBinding) {
        let bound: Profile | null = null
        try { bound = await readBinding() } catch { /* the dialog shows the first error */ }
        if (bound?.id === target.id) {
          onBound?.(bound)
          setActiveProfileId(target.id)
          settle(true)
          return
        }
      }
      throw e
    }
    await showBinding(target.id)
    settle(true)
  }, [pinTarget, setActiveProfileId, settle, readBinding, showBinding, onBound])

  const cancelPin = useCallback(() => settle(false), [settle])

  // Whether a switch or a PIN prompt is under way, so a background re-read of
  // the binding (App's tab-visibility check) does not race it.
  const isSwitching = useCallback(() => inFlightRef.current || pinResolveRef.current !== null, [])
  const switchGeneration = useCallback(() => generationRef.current, [])

  return { pinTarget, switchProfile, unlock, cancelPin, isSwitching, switchGeneration }
}
