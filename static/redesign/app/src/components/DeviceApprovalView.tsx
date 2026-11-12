import { useEffect, useRef, useState, type FormEvent } from 'react'
import { APIError, apiFetch, type Profile } from '@/lib/api'
import { refusalMessage, refusalReason, waitPhrase } from '@/lib/profileRefusal'
import { PageHeader } from '@/components/PageHeader'

interface Props {
  username: string
  initialCode: string
  /** The profile this session acts as, as the server has bound it; null
   *  when that is not known (never a remembered choice). */
  actingProfile?: Profile | null
  /** The account's profiles, for whether any is without a PIN. */
  profiles?: readonly Profile[]
}

type Phase = 'lookup' | 'approve'

/** A request that never reached the server, as the browsers word it. Any
 *  other error that is not the server's answer is a fault of the page's own,
 *  and is not called a connection problem. */
const neverArrived = (e: unknown) => e instanceof TypeError && /fetch|network|load failed/i.test(e.message)

/** What the server said, in the app's words. The pairing routes send a
 *  reason for two refusals (every profile locked, this session ended) and a
 *  status for the rest; their messages are written for logs.
 *
 *  The lookup answers 404 for ANY code it does not hold, a mistyped one
 *  included, so on a lookup the words leave both open. On an approval the
 *  code was found a moment ago, and a 404 is a code that has run out or was
 *  already approved.
 *
 *  An approval that got no answer, or a gateway's error in place of one, may
 *  still have been written: nothing here says the TV was not approved. */
function pairingRefusal(e: unknown, phase: Phase): string {
  const approving = phase === 'approve'
  if (!(e instanceof APIError)) {
    if (neverArrived(e)) {
      return approving
        ? 'No answer came back from the server, so the TV may or may not have been approved. If it does not sign in, check the connection and find it again here.'
        : 'The server could not be reached. Check the connection and try again.'
    }
    return approving ? 'Something went wrong on this page, so the TV may not have been approved. Try again.' : 'Something went wrong on this page. Try again.'
  }
  const reason = refusalReason(e)
  if (reason === 'profile_locked') return refusalMessage(e, '')
  if (reason === 'session_ended') return 'This device’s session has ended, so it cannot approve a TV. Reload the page, and sign in again if it asks.'
  switch (e.status) {
    case 401: return 'This device is no longer signed in for this. Reload the page, and sign in again if it asks.'
    case 403: return 'The server refused this because of how it is reached: the address it sees is not this page’s. Whoever runs the server can put that right.'
    case 404: return approving
      ? 'That code has expired or was already used. Start sign-in again on the TV to get a new one.'
      : 'No TV is waiting with that code. Check it against the TV; if it has expired, start sign-in again there.'
    case 409: return 'The account signed in on this device has changed. Find the TV again before approving it.'
    case 429: return `Too many tries. Try again ${waitPhrase(e.retryAfterSec, 'in a minute')}.`
    default:
      if (e.status < 500) return e.message || (approving ? 'This TV could not be approved.' : 'This TV could not be found.')
      return approving
        ? 'The server did not confirm the approval, so the TV may or may not have been approved. If it does not sign in, find it again here.'
        : 'The server could not look the code up just now. Try again.'
  }
}

/** Which profile the TV starts on, where this page can be sure of it. The
 *  server gives the TV the approver's own profile when that has no PIN. When
 *  it has one, the TV gets a profile without a PIN, if the account has any
 *  (which one is the server's choice). When every profile has a PIN the
 *  server either refuses or, on an account with no password, picks one past
 *  its PIN, and the page cannot tell which: it says nothing. */
function startsOn(acting: Profile | null | undefined, profiles: readonly Profile[] | undefined): string | null {
  if (!acting) return null
  if (!acting.has_pin) return `The TV will start on ${acting.name}, the profile you are using here.`
  if (profiles?.some(p => p.id !== acting.id && !p.has_pin)) return `The TV will start on a profile without a PIN, not on ${acting.name}.`
  return null
}

export default function DeviceApprovalView({ username, initialCode, actingProfile, profiles }: Props) {
  const [code, setCode] = useState(initialCode)
  const [device, setDevice] = useState<{ device_name: string; user_id: number; username: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [approved, setApproved] = useState(false)
  // A refusal, and whether it was the lookup's "no such code": only that one
  // is about what is in the field.
  const [error, setError] = useState<{ text: string; aboutCode: boolean } | null>(null)
  // Every profile on the account has a PIN: the server approved no TV, and
  // these are its words for it. It is true of the account, not of a code,
  // but it can stop being true without this page hearing of it (a PIN
  // removed in another tab), so it is forgotten at the next TV found; at
  // worst that costs one more refusal.
  const [locked, setLocked] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  // As the server reads a code: dashes dropped.
  const codeComplete = code.replaceAll('-', '').length === 8
  const doneRef = useRef<HTMLParagraphElement | null>(null)
  const lockedRef = useRef<HTMLParagraphElement | null>(null)
  const fieldRef = useRef<HTMLInputElement | null>(null)
  const findRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { if (approved) doneRef.current?.focus() }, [approved])
  // Where the focus goes when a refusal has taken Approve away: to the
  // reason, or to what the person does next. Never onto the alert that
  // announces the refusal, which would have it read out twice. Set beside
  // the state that removes the button, and used once that has rendered.
  const focusNext = useRef<'locked' | 'field' | 'find' | null>(null)
  useEffect(() => {
    const to = focusNext.current
    if (!to) return
    focusNext.current = null
    ;({ locked: lockedRef, field: fieldRef, find: findRef })[to].current?.focus()
  })

  async function lookup(event: FormEvent) {
    event.preventDefault()
    if (busy || !codeComplete) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError(null)
    setDevice(null)
    try {
      const result = await apiFetch<{ device_name: string; user_id: number; username: string }>(`/api/auth/device/preview?code=${encodeURIComponent(code.trim())}`, {
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setLocked(null)
      setDevice(result)
    } catch (failure) {
      if (controller.signal.aborted) return
      setError({ text: pairingRefusal(failure, 'lookup'), aboutCode: failure instanceof APIError && failure.status === 404 })
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  async function approve() {
    if (busy || !device) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError(null)
    try {
      await apiFetch('/api/auth/device/authorize', { method: 'POST', body: { user_code: code.trim(), expected_user_id: device.user_id }, signal: controller.signal })
      if (!controller.signal.aborted) setApproved(true)
    } catch (failure) {
      if (controller.signal.aborted) return
      const words = pairingRefusal(failure, 'approve')
      const status = failure instanceof APIError ? failure.status : 0
      // What the server will refuse again is not offered again. A locked
      // account approves nothing: the reason takes Approve's place in the
      // TV's card, and stays there. A code that is gone, or an account that
      // is no longer the one the TV was found under, needs a new lookup.
      if (refusalReason(failure) === 'profile_locked') {
        setLocked(words)
        focusNext.current = 'locked'
      } else {
        setError({ text: words, aboutCode: false })
        if (status === 404) { setDevice(null); focusNext.current = 'field' }
        else if (status === 409) { setDevice(null); focusNext.current = 'find' }
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  const profileLine = startsOn(actingProfile, profiles)
  const invalid = error?.aboutCode === true

  return (
    <section className="max-w-xl">
      <PageHeader eyebrow="AuroraPro on TV" title="Connect your TV" sub={`Signing in as ${device?.username ?? username}`} />
      {approved ? (
        // Takes the focus the Approve button had: the button goes with the
        // form it was in.
        <p ref={doneRef} tabIndex={-1} role="status" className="rounded-control text-[17px] leading-snug text-ink">
          TV approved. Return to your TV to choose a profile and start watching.
        </p>
      ) : (
        <>
          <form onSubmit={lookup}>
            <label htmlFor="device-code" className="block text-[15px] font-semibold text-ink">Enter the code shown on your TV</label>
            {/* Read-only, not disabled, while a request is out: a disabled
                field or button drops the focus it holds. Spaces go as they
                are typed or pasted: the server takes a code with its ends
                trimmed, and a space inside one is never part of it. */}
            <input ref={fieldRef} id="device-code" name="device-code" value={code} readOnly={busy}
              onChange={event => { setCode(event.target.value.replace(/\s+/g, '').toUpperCase()); setDevice(null); setError(null) }}
              autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ABCD-1234"
              aria-invalid={invalid}
              aria-describedby={invalid ? 'device-code-hint device-error' : 'device-code-hint'}
              className="mt-2 w-full font-mono tracking-[0.2em]" />
            <p id="device-code-hint" className="mt-2 text-[13px] leading-snug text-ink-2">8 letters and numbers, as on the TV. The dash is optional.</p>
            <button ref={findRef} type="submit" disabled={!codeComplete} aria-disabled={busy}
              className={`stage-btn mt-4 ${device ? 'stage-btn-ghost' : 'stage-btn-primary'}`}>{busy && !device ? 'Checking…' : 'Find TV'}</button>
          </form>
          <p role="status" className="sr-only">{device && !locked ? `Found ${device.device_name}. Check its code, then approve it below.` : ''}</p>
          {device && (
            <div className="mt-6 rounded-control bg-surface-raised p-5">
              {/* The name is whatever the device called itself: it can be
                  one long unbroken word. */}
              <p className="text-[17px] font-semibold leading-snug text-ink [overflow-wrap:anywhere]">{device.device_name} wants to sign in to your AuroraPro account.</p>
              {locked ? (
                // In Approve's place, for as long as this TV is shown: the
                // card must not sit there with no button and no reason. It
                // takes the focus Approve had; it is not a live region, so
                // it is read once, by that.
                <p ref={lockedRef} tabIndex={-1} className="mt-3 rounded-control text-[14px] leading-snug text-danger-ink">{locked}</p>
              ) : (
                <>
                  <p className="mt-2 text-[14px] leading-snug text-ink-2">Approve only if you started sign-in on this TV and its code matches <strong className="whitespace-nowrap font-mono font-semibold tracking-[0.1em] text-ink">{code}</strong>.</p>
                  {profileLine && <p className="mt-2 text-[14px] leading-snug text-ink">{profileLine}</p>}
                  <button type="button" onClick={() => void approve()} aria-disabled={busy}
                    className="stage-btn stage-btn-primary stage-btn-wrap mt-4">{busy ? 'Approving…' : `Approve TV for ${device.username}`}</button>
                </>
              )}
            </div>
          )}
          <p id="device-error" role="alert" className={error ? 'mt-4 text-[14px] leading-snug text-danger-ink' : 'sr-only'}>{error?.text ?? ''}</p>
        </>
      )}
    </section>
  )
}
