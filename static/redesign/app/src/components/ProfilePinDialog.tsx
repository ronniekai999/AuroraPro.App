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
import { Lock } from 'lucide-react'
import { ProfileAvatar } from './ProfileAvatar'
import { profileErrorReason, type Profile, type ProfileUnlock } from '@/lib/api'

interface ProfilePinDialogProps {
  // `id` picks the avatar's colour, so the disc here is the one in the picker.
  profile: Pick<Profile, 'name' | 'avatar_url'> & { id?: number }
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
  const [focused, setFocused] = useState(false)
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
        overlayClassName="z-[90] bg-[rgba(6,7,8,0.72)]"
        className="z-[91] w-[calc(100%-2rem)] max-w-[420px] rounded-sheet border-0 bg-surface-raised-2 p-6 sm:p-8 text-ink shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
      >
        <form
          className="flex flex-col items-center text-center"
          onSubmit={e => { e.preventDefault(); if (ready) void submit(value) }}
        >
          <span className="relative" aria-hidden="true">
            <ProfileAvatar avatarUrl={profile.avatar_url} name={profile.name} colorKey={profile.id} size={88} />
            <span className="absolute -right-0.5 -bottom-0.5 h-8 w-8 rounded-full bg-ink text-action-on grid place-items-center border-[3px] border-surface-raised-2">
              <Lock size={14} strokeWidth={2.25} />
            </span>
          </span>
          <DialogTitle className="mt-5 font-display text-[28px] leading-tight font-bold tracking-[-0.015em] text-ink">
            {title ?? `${profile.name} is locked`}
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-[15px] text-ink-2">
            {description ?? (mode === 'pin'
              ? 'Enter this profile’s 4-digit PIN.'
              : 'Enter the account password to unlock it.')}
          </DialogDescription>

          <label htmlFor="profile-unlock-input" className="sr-only">
            {mode === 'pin' ? 'Profile PIN' : 'Account password'}
          </label>
          {mode === 'pin' ? (
            // ONE real field, drawn as four boxes. Four separate inputs would
            // each need a label, break paste and backspace, and give password
            // managers four fields to offer a saved password into. The field
            // lies invisibly over the boxes, which show what it holds; the
            // box the next digit goes into carries the focus indicator.
            <div className="relative mt-6" data-pin-cells="">
              <div className="flex gap-3" aria-hidden="true">
                {[0, 1, 2, 3].map(i => {
                  const active = focused && !busy && i === Math.min(value.length, 3)
                  return (
                    <span
                      key={i}
                      data-pin-cell={i < value.length ? 'filled' : 'empty'}
                      className={`grid h-[68px] w-14 sm:w-16 place-items-center rounded-control bg-surface-raised text-[28px] leading-none text-ink ${
                        active ? 'border-2 border-ink' : error ? 'border border-danger-ink' : 'border border-line-strong'
                      }`}
                    >
                      {i < value.length ? '\u2022' : ''}
                    </span>
                  )
                })}
              </div>
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
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={e => {
                  const digits = e.target.value.replace(/[^0-9]/g, '').slice(0, 4)
                  setValue(digits)
                  if (digits.length === 4) void submit(digits)
                }}
                // 16px so a phone does not zoom the page when it focuses.
                className="absolute inset-0 h-full w-full cursor-text rounded-control text-[16px] opacity-0"
              />
            </div>
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
              className={`mt-6 h-12 w-full rounded-control bg-surface-raised px-4 text-[16px] text-ink focus:outline-none focus-visible:border-ink border ${error ? 'border-danger-ink' : 'border-line-strong'}`}
            />
          )}

          <p id="profile-unlock-error" role="alert" className="mt-3 min-h-[1.375rem] text-[14px] text-danger-ink">
            {error ?? ''}
          </p>

          <div className="mt-3 flex w-full gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="h-12 flex-1 rounded-control bg-action-soft text-[15px] font-semibold text-ink transition-[filter] hover:brightness-125 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !ready}
              className="h-12 flex-[2] rounded-full bg-action text-[15px] font-semibold text-action-on transition-[filter] hover:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? 'Checking…' : submitLabel}
            </button>
          </div>

          <button
            type="button"
            onClick={() => setMode(m => (m === 'pin' ? 'password' : 'pin'))}
            disabled={busy}
            className="mt-5 rounded-chip text-[14px] text-ink-2 underline underline-offset-2 hover:text-ink"
          >
            {mode === 'pin' ? 'Forgot the PIN? Use the account password' : 'Use the PIN instead'}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
