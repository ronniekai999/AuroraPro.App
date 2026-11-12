import { useEffect, useRef, useState, type FormEvent } from 'react'
import { APIError, apiFetch } from '@/lib/api'
import { refusalMessage, refusalReason, waitPhrase } from '@/lib/profileRefusal'
import { PageHeader } from '@/components/PageHeader'

interface Props {
  username: string
  initialCode: string
}

/** What the server said, in the app's words. The pairing routes send a
 *  reason for two refusals (every profile locked, this session ended) and a
 *  status for the rest; their messages are written for logs. */
function pairingRefusal(e: unknown, fallback: string): string {
  if (!(e instanceof APIError)) {
    if (e instanceof TypeError) return 'The server could not be reached. Check the connection and try again.'
    return e instanceof Error && e.message ? e.message : fallback
  }
  const reason = refusalReason(e)
  if (reason === 'profile_locked') return refusalMessage(e, fallback)
  if (reason === 'session_ended') return 'This device has been signed out, so it cannot approve a TV. Sign in again first.'
  switch (e.status) {
    case 401: return 'Sign in again on this device before approving a TV.'
    case 403: return 'A TV can only be approved from this Aurora server’s own page.'
    case 404: return 'That code has expired or was already used. Start sign-in again on the TV to get a new one.'
    case 409: return 'The account signed in on this device has changed. Find the TV again before approving it.'
    case 429: return `Too many tries. Try again ${waitPhrase(e.retryAfterSec, 'in a minute')}.`
    default: return e.status >= 500 ? 'The server could not check this just now, so the TV was not approved. Try again.' : e.message || fallback
  }
}

export default function DeviceApprovalView({ username, initialCode }: Props) {
  const [code, setCode] = useState(initialCode)
  const [device, setDevice] = useState<{ device_name: string; user_id: number; username: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [approved, setApproved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Every profile on the account has a PIN: the server approves no TV from
  // here, whichever code it is, so Approve is not offered again.
  const [locked, setLocked] = useState(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const codeComplete = code.replaceAll('-', '').trim().length === 8
  const doneRef = useRef<HTMLParagraphElement | null>(null)
  const errorRef = useRef<HTMLParagraphElement | null>(null)
  useEffect(() => { if (approved) doneRef.current?.focus() }, [approved])

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
      if (!controller.signal.aborted) setDevice(result)
    } catch (failure) {
      if (!controller.signal.aborted) setError(pairingRefusal(failure, 'This TV could not be found.'))
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
      setError(pairingRefusal(failure, 'This TV could not be approved.'))
      // What the server will refuse again is not offered again: a dead
      // code, or an account that is no longer the one the TV was found
      // under, needs a new lookup; a locked account approves nothing here.
      const status = failure instanceof APIError ? failure.status : 0
      if (refusalReason(failure) === 'profile_locked') setLocked(true)
      else if (status === 404 || status === 409) setDevice(null)
      else return
      // The Approve button has gone; the focus goes to the words that say
      // why.
      queueMicrotask(() => errorRef.current?.focus())
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

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
                field or button drops the focus it holds. */}
            <input id="device-code" name="device-code" value={code} readOnly={busy} maxLength={9}
              onChange={event => { setCode(event.target.value.toUpperCase()); setDevice(null); setError(null) }}
              autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ABCD-1234"
              aria-invalid={error !== null && !device}
              aria-describedby={error !== null ? 'device-error' : undefined}
              className="mt-2 w-full font-mono tracking-[0.2em]" />
            <button type="submit" disabled={!codeComplete} aria-disabled={busy}
              className={`stage-btn mt-4 ${device ? 'stage-btn-ghost' : 'stage-btn-primary'}`}>{busy && !device ? 'Checking…' : 'Find TV'}</button>
          </form>
          <p role="status" className="sr-only">{device ? `Found ${device.device_name}. Check its code, then approve it below.` : ''}</p>
          {device && (
            <div className="mt-6 rounded-control bg-surface-raised p-5">
              <p className="text-[17px] font-semibold leading-snug text-ink">{device.device_name} wants to sign in to your AuroraPro account.</p>
              {!locked && (
                <p className="mt-2 text-[14px] leading-snug text-ink-2">Approve only if you started sign-in on this TV and its code matches <strong className="whitespace-nowrap font-mono font-semibold tracking-[0.1em] text-ink">{code}</strong>.</p>
              )}
              {!locked && (
                <button type="button" onClick={() => void approve()} aria-disabled={busy}
                  className="stage-btn stage-btn-primary stage-btn-wrap mt-4">{busy ? 'Approving…' : `Approve TV for ${device.username}`}</button>
              )}
            </div>
          )}
          <p ref={errorRef} tabIndex={-1} id="device-error" role="alert" className={error ? 'mt-4 rounded-control text-[14px] leading-snug text-danger-ink' : 'sr-only'}>{error ?? ''}</p>
        </>
      )}
    </section>
  )
}
