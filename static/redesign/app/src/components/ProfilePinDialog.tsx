// PIN prompt for a locked profile. Used for switching into one and for
// changing or removing a PIN. The server checks the PIN; this dialog only
// collects it and explains the answer. It never decides success itself:
// `onSubmit` resolving is the only way it closes as unlocked.
//
// The account password stands in for any PIN (the recovery path when a PIN is
// forgotten), so the dialog offers it as a second mode. Each has its own
// server-side budget: five PIN misses lock the profile for 15 minutes, and
// five password misses pause the password for 15 minutes for the
// sessions acting as the same profile, and a PIN lockout does not stop the
// password.

import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ProfileAvatar } from './ProfileAvatar'
import { profileErrorReason, type Profile, type ProfileUnlock } from '@/lib/api'

interface ProfilePinDialogProps {
  profile: Pick<Profile, 'name' | 'avatar_url'>
  /** Heading; defaults to the switch wording. */
  title?: string
  /** One line under the heading. */
  description?: string
  /** Label of the confirm button. */
  submitLabel?: string
  /** Sends the PIN or password. Resolve on success; reject with the APIError. */
  onSubmit: (unlock: ProfileUnlock) => Promise<void>
  onCancel: () => void
}

// unlockErrorMessage turns a rejected unlock into what to tell the person.
// Exported for the tests: the wording for each server reason is the contract.
export function unlockErrorMessage(e: unknown, mode: 'pin' | 'password'): string {
  switch (profileErrorReason(e)) {
    case 'profile_pin_invalid':
      return mode === 'pin' ? 'That PIN is not right.' : 'That password is not right.'
    case 'profile_pin_locked':
      return 'Too many wrong attempts. Try again in 15 minutes.'
    case 'profile_pin_required':
      return mode === 'pin' ? 'Enter the profile’s PIN.' : 'Enter the account password.'
    case 'profile_restricted':
      return 'This profile can’t change that.'
    default:
      return e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.'
  }
}

export function ProfilePinDialog({
  profile, title, description, submitLabel = 'Unlock', onSubmit, onCancel,
}: ProfilePinDialogProps) {
  const [mode, setMode] = useState<'pin' | 'password'>('pin')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // A submit that resolves after the dialog unmounted must not set state.
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  useEffect(() => {
    setValue('')
    setError(null)
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [mode])

  const ready = mode === 'pin' ? /^[0-9]{4}$/.test(value) : value.length > 0

  const submit = async (v: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(mode === 'pin' ? { pin: v } : { password: v })
    } catch (e) {
      if (!mounted.current) return
      setError(unlockErrorMessage(e, mode))
      setValue('')
      window.setTimeout(() => inputRef.current?.focus(), 0)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onCancel() }}>
      <DialogContent
        showCloseButton={false}
        // Above ProfilesGate (z-85): picking a locked profile there opens this
        // over the gate, and the gate stays up until the unlock succeeds.
        overlayClassName="z-[90] bg-black/80 backdrop-blur-md"
        className="z-[91] w-[calc(100%-2rem)] max-w-[380px] rounded-[var(--r-2xl)] border border-purple-400/25 bg-[#15131f] p-6 text-white shadow-[shadow:var(--shadow-modal)]"
      >
        <form
          className="flex flex-col items-center text-center"
          onSubmit={e => { e.preventDefault(); if (ready) void submit(value) }}
        >
          <ProfileAvatar avatarUrl={profile.avatar_url} name={profile.name} size={72} />
          <DialogTitle className="mt-4 font-display text-xl font-bold">
            {title ?? `${profile.name} is locked`}
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-sm text-white/60">
            {description ?? (mode === 'pin'
              ? 'Enter this profile’s 4-digit PIN.'
              : 'Enter the account password to unlock it.')}
          </DialogDescription>

          <label htmlFor="profile-unlock-input" className="sr-only">
            {mode === 'pin' ? 'Profile PIN' : 'Account password'}
          </label>
          {mode === 'pin' ? (
            <input
              id="profile-unlock-input"
              ref={inputRef}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              maxLength={4}
              value={value}
              disabled={busy}
              aria-invalid={!!error}
              aria-describedby={error ? 'profile-unlock-error' : undefined}
              onChange={e => {
                const digits = e.target.value.replace(/[^0-9]/g, '').slice(0, 4)
                setValue(digits)
                if (digits.length === 4) void submit(digits)
              }}
              className="mt-5 w-40 rounded-xl border border-white/15 bg-white/[0.06] px-4 py-3 text-center font-display text-2xl tracking-[0.6em] text-white"
            />
          ) : (
            // Never offered the saved account password: it unlocks every
            // profile, so on a browser a child uses, one click from a
            // password manager here would undo every lock. "new-password"
            // is what browsers honour for that ("off" is ignored on password
            // fields, so the PIN field above uses it too); the data
            // attributes ask the common password-manager extensions to stay
            // out as well.
            <input
              id="profile-unlock-input"
              ref={inputRef}
              type="password"
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              value={value}
              disabled={busy}
              aria-invalid={!!error}
              aria-describedby={error ? 'profile-unlock-error' : undefined}
              onChange={e => setValue(e.target.value)}
              className="mt-5 w-full rounded-xl border border-white/15 bg-white/[0.06] px-4 py-3 text-sm text-white"
            />
          )}

          <p id="profile-unlock-error" role="alert" className="mt-3 min-h-[1.25rem] text-sm text-red-300">
            {error ?? ''}
          </p>

          <div className="mt-3 flex w-full gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="stage-btn stage-btn-sm stage-btn-quiet flex-1"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !ready}
              className="stage-btn stage-btn-sm stage-btn-primary flex-1"
            >
              {busy ? 'Checking…' : submitLabel}
            </button>
          </div>

          <button
            type="button"
            onClick={() => setMode(m => (m === 'pin' ? 'password' : 'pin'))}
            disabled={busy}
            className="mt-4 rounded text-xs text-white/55 underline-offset-2 hover:text-white/85 hover:underline"
          >
            {mode === 'pin' ? 'Forgot the PIN? Use the account password' : 'Use the PIN instead'}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
