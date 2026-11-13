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
import { type Profile, type ProfileUnlock } from '@/lib/api'
import { refusalMessage, refusalReason } from '@/lib/profileRefusal'
import { useReturnFocus } from '@/lib/returnFocus'

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
  /** Where focus goes when the prompt closes and what opened it cannot take
   *  it back. */
  fallbackFocus?: () => HTMLElement | null | undefined
  onCancel: () => void
}

// unlockErrorMessage turns a rejected unlock into what to tell the person.
// Exported for the tests: the wording for each server reason is the contract.
export function unlockErrorMessage(e: unknown, mode: 'pin' | 'password'): string {
  switch (refusalReason(e)) {
    case 'profile_pin_invalid':
      return mode === 'pin' ? 'That PIN is not right.' : 'That password is not right.'
    case 'profile_pin_required':
      return mode === 'pin' ? 'Enter the profile’s PIN.' : 'Enter the account password.'
    default:
      // The lockout (with how long to wait), a session the server has ended,
      // a profile changed elsewhere: the words every profile refusal gets.
      return refusalMessage(e, 'Something went wrong. Try again.', { doing: 'unlock the profile' })
  }
}

export function ProfilePinDialog({
  profile, title, description, submitLabel = 'Unlock', onSubmit, onCancel, fallbackFocus,
}: ProfilePinDialogProps) {
  const returnFocus = useReturnFocus(fallbackFocus)
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

  // The PIN field is invisible (the boxes are its picture), so its caret is
  // too. Left to move, a Left or Home, or a tap on the first box, would file
  // the next digit in front of the ones already typed: "12", Home, "34"
  // submits 3412 and spends one of five attempts before a lockout. The caret
  // stays at the end, where the boxes show it. A selection of the WHOLE value
  // is left alone: select all and type (or paste) replaces the digits, which
  // is what was asked for; collapsing it made "12", select all, "5678" append
  // to "1256" and submit that.
  const pinCaretToEnd = (el: HTMLInputElement) => {
    const end = el.value.length
    if (end > 0 && el.selectionStart === 0 && el.selectionEnd === end) return
    if (el.selectionStart !== end || el.selectionEnd !== end) {
      try { el.setSelectionRange(end, end) } catch { /* not selectable in this state */ }
    }
  }

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
        {...returnFocus}
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
                      // The boxes are the only visible sign of the field, so
                      // an empty one's edge has to be seen: --ink-3, which is
                      // 5.87:1 on the dialog and 6.54:1 on the box's own fill
                      // (the hairline token is 1.46:1 and 1.63:1).
                      className={`grid h-[68px] w-14 sm:w-16 place-items-center rounded-control bg-surface-raised text-[28px] leading-none text-ink ${
                        active ? 'border-2 border-ink' : error ? 'border border-danger-ink' : 'border border-ink-3'
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
                onFocus={e => { setFocused(true); pinCaretToEnd(e.currentTarget) }}
                onBlur={() => setFocused(false)}
                onSelect={e => pinCaretToEnd(e.currentTarget)}
                onKeyUp={e => pinCaretToEnd(e.currentTarget)}
                onClick={e => pinCaretToEnd(e.currentTarget)}
                onKeyDown={e => {
                  // The keys that only move a caret have nothing to move.
                  // Only bare ones: with a modifier they are the browser's
                  // (Alt+Left is Back) or a selection, which is handled
                  // above.
                  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
                  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) e.preventDefault()
                }}
                onChange={e => {
                  const digits = e.target.value.replace(/[^0-9]/g, '').slice(0, 4)
                  setValue(digits)
                  if (digits.length === 4) void submit(digits)
                }}
                // Its text size (16px, so a phone does not zoom the page when
                // it focuses) is set by `.profile-unlock-field` in index.css:
                // the app's global input rule outranks a utility here.
                className="profile-unlock-field absolute inset-0 h-full w-full cursor-text opacity-0"
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
              // Fill, border, radius and padding are the app's global input
              // style; `.profile-unlock-field` adds the 16px text and the
              // error border, which a utility here could not.
              className="profile-unlock-field mt-6 h-12 w-full"
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
            // 44px tall: it is the way back in when the PIN is forgotten.
            className="mt-2 min-h-11 px-2 inline-flex items-center rounded-chip text-[14px] text-ink-2 underline underline-offset-2 hover:text-ink"
          >
            {mode === 'pin' ? 'Forgot the PIN? Use the account password' : 'Use the PIN instead'}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
