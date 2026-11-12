import { useEffect, useRef, useState, type FormEvent } from 'react'
import { APIError, apiFetch } from '@/lib/api'
import { refusalMessage, refusalReason, waitPhrase } from '@/lib/profileRefusal'
import { Icon } from '@/components/Icon'

interface Props {
  username: string
  initialCode: string
  /** Whether the account has a profile without a PIN: true or false once
   *  its profiles are known, null until then. */
  someProfileUnlocked?: boolean | null
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

/** What stops a TV that did get in. The server's logout ends every session
 *  on the account, and cancels an approval a TV has not collected yet.
 *  Sign out is in the identity panel, and on a phone on the Me page. */
const SIGN_OUT = 'If that TV is not yours, use Sign out (in the account menu, or under Me on a phone): that signs out every device on this account, that TV included.'
/** An approval was sent and nothing says how it went. */
const OUTCOME_UNKNOWN = `An approval was sent from this page a moment ago, and it is not known whether it went through. ${SIGN_OUT}`
/** After that, the server no longer holds the code: it answers so for a code
 *  that has run out, and for one whose approval was written. Moments after
 *  an approval was sent, the second is by far the likelier. */
const CODE_USED = `That code has just been used, most likely by the approval sent from this page a moment ago, so that TV is probably signed in. ${SIGN_OUT}`

/** What happens on the TV after an approval. The TV does not start on a
 *  profile: it opens its own "who is watching" list, whichever profile the
 *  server bound it to. That binding only decides which profile it may enter
 *  without a PIN, and when the account has a profile without one, that is
 *  the kind it binds: every profile with a PIN still asks for it. When
 *  every profile has a PIN the server either refuses, or on an account with
 *  no password lets the TV into one of them past its PIN, and this page
 *  cannot tell which, so it says nothing of PINs; nor while the profiles
 *  are not known. */
const afterApproval = (someProfileUnlocked: boolean | null | undefined) =>
  `After you approve, go back to the TV and choose who is watching.${someProfileUnlocked ? ' Profiles with a PIN still ask for it there.' : ''}`

/** A code as the TV shows it, four and four, whatever dashes it was typed
 *  with. */
function asShown(code: string): string {
  const bare = code.replaceAll('-', '')
  return bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : code
}

export default function DeviceApprovalView({ username, initialCode, someProfileUnlocked }: Props) {
  // A code can arrive in the link the TV shows. It is read as a typed one
  // is: no spaces, upper case.
  const [code, setCode] = useState(() => initialCode.replace(/\s+/g, '').toUpperCase())
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
  // What is known of an approval sent for the code in the field. 'unknown':
  // one was sent and no answer says how it went (a gateway's error, a
  // connection that dropped), so the server may have written it all the
  // same. 'used': after that, the server said it no longer holds the code,
  // which most likely means that approval went through. Forgotten when the
  // code is edited, and when the TV is found waiting again (an approval
  // that was written leaves no TV waiting).
  const [sent, setSent] = useState<'unknown' | 'used' | null>(null)
  // "Not my TV" was pressed: said in the page's status line, in sight, since
  // the TV's card has just gone and nothing else shows that it was heard.
  // What the line says depends on `sent` (below): "nothing was approved"
  // only when nothing was sent that might have been written.
  const [putAside, setPutAside] = useState(false)
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
    setPutAside(false)
    try {
      const result = await apiFetch<{ device_name: string; user_id: number; username: string }>(`/api/auth/device/preview?code=${encodeURIComponent(code.trim())}`, {
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setLocked(null)
      setSent(null)
      setDevice(result)
    } catch (failure) {
      if (controller.signal.aborted) return
      const gone = failure instanceof APIError && failure.status === 404
      // The same code as the approval was sent for: an edit would have
      // forgotten it. The code is not mistyped, so the field is not marked.
      if (gone && sent) {
        setSent('used')
        setError({ text: CODE_USED, aboutCode: false })
      } else {
        setError({ text: pairingRefusal(failure, 'lookup'), aboutCode: gone })
      }
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
        // A second try after one of unknown outcome, and the code is gone:
        // the first most likely went through.
        const used = status === 404 && sent !== null
        if (used) setSent('used')
        setError({ text: used ? CODE_USED : words, aboutCode: false })
        if (status === 404) { setDevice(null); focusNext.current = 'field' }
        else if (status === 409) { setDevice(null); focusNext.current = 'find' }
        // Every refusal the server's own handler sends comes before the
        // approval is written. A 5xx can be a gateway's, and an error that
        // is not the server's answer at all says nothing of what happened
        // to the request: after those the approval may have been written.
        else if (!(failure instanceof APIError) || status >= 500) setSent('unknown')
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  // "Not my TV": the found TV is put aside. Nothing is sent: the server has
  // no route to refuse a TV with, and its code runs out by itself. The page
  // says what it knows. Ordinarily that is that nothing was approved from
  // here. After an approval of unknown outcome it is not, and the status
  // line says that instead (below): that one may have gone through, and
  // what stops a TV that did get in. The alert goes either way: after an
  // unknown outcome its advice was for someone who wants the TV in ("find
  // it again here"), and the status line now says the rest.
  function notMine() {
    if (busy) return
    setDevice(null)
    setLocked(null)
    setError(null)
    setPutAside(true)
    focusNext.current = 'field'
  }

  const invalid = error?.aboutCode === true
  const offered = device !== null && !locked
  // An approval of unknown outcome and no TV on screen, however it left
  // (put aside, a new lookup on its way or failed, the account changed):
  // the warning that it may have gone through is not let go of.
  const unsure = sent === 'unknown' && device === null

  return (
    // One column in the middle of the page's width. Its top is fixed, not
    // centred in the height: centred, the heading and the field moved up
    // when the TV's card arrived and down when it went, under a focus that
    // stayed put. The offset from md up puts the page with a TV found about
    // in the middle of a 900px-high window.
    <section className="mx-auto flex w-full max-w-[520px] flex-col gap-7 md:pt-16">
      <div>
        <h1 className="font-display text-[clamp(2.25rem,11vw,3.5rem)] font-extrabold leading-none tracking-[-0.02em] text-ink">Connect your TV</h1>
        {!approved && <p className="mt-2 text-[17px] leading-snug text-ink-2">Enter the code shown on the TV. It signs the TV in to this account without typing a password on a remote.</p>}
        <p className={`${approved ? 'mt-2' : 'mt-1.5'} text-[14px] leading-snug text-ink-2`}>Signing in as {device?.username ?? username}</p>
      </div>
      {approved ? (
        // Takes the focus the Approve button had: the button goes with the
        // form it was in.
        <p ref={doneRef} tabIndex={-1} role="status" className="rounded-control text-[17px] leading-snug text-ink">
          TV approved. Return to your TV to choose a profile and start watching.
        </p>
      ) : (
        <>
          <form onSubmit={lookup} className="flex flex-col">
            <label htmlFor="device-code" className="text-[13px] font-semibold text-ink-2">Code from the TV</label>
            {/* Read-only, not disabled, while a request is out: a disabled
                field or button drops the focus it holds. Spaces go as they
                are typed or pasted: the server takes a code with its ends
                trimmed, and a space inside one is never part of it. */}
            <input ref={fieldRef} id="device-code" name="device-code" value={code} readOnly={busy}
              onChange={event => { setCode(event.target.value.replace(/\s+/g, '').toUpperCase()); setDevice(null); setError(null); setPutAside(false); setSent(null) }}
              autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ABCD-1234"
              aria-invalid={invalid}
              aria-describedby={invalid ? 'device-code-hint device-error' : 'device-code-hint'}
              className="device-code-field mt-1.5 w-full" />
            <p id="device-code-hint" className="mt-2 text-[13px] leading-snug text-ink-2">8 letters and numbers, as on the TV. The dash is optional.</p>
            {/* The page's one main action until a TV is found; a small
                second one after that, when approving is the main action. It
                stays, and keeps the focus it had: Enter looks up again and
                never approves. */}
            <button ref={findRef} type="submit" disabled={!codeComplete} aria-disabled={busy}
              className={device ? 'stage-btn stage-btn-ghost mt-4 self-start' : 'stage-btn stage-btn-primary stage-btn-tall mt-5 w-full'}>{busy && !device ? 'Checking…' : 'Find TV'}</button>
          </form>
          <p role="status" className={unsure || putAside ? `text-[14px] leading-snug ${unsure ? 'text-ink' : 'text-ink-2'}` : 'sr-only'}>
            {unsure ? OUTCOME_UNKNOWN
              : putAside ? 'Nothing was approved from this page.'
              : offered ? `Found ${device.device_name}. Check its code, then approve it below.` : ''}
          </p>
          {device && (
            <div className="rounded-control bg-surface-raised p-4">
              <div className="flex items-start gap-3">
                <Icon name="tv" size={22} className="mt-0.5 flex-none text-ink-2" />
                {/* The name is whatever the device called itself: it can be
                    one long unbroken word. */}
                <p className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="block text-[15px] font-semibold leading-snug text-ink">{device.device_name}</span>{' '}
                  <span className="block text-[13px] leading-snug text-ink-2">wants to sign in to your AuroraPro account.</span>
                </p>
              </div>
              {locked ? (
                // In Approve's place, for as long as this TV is shown: the
                // card must not sit there with no button and no reason. It
                // takes the focus Approve had; it is not a live region, so
                // it is read once, by that.
                <p ref={lockedRef} tabIndex={-1} className="mt-3 rounded-chip border-t border-line pt-3 text-[14px] leading-snug text-danger-ink">{locked}</p>
              ) : (
                <p className="mt-3 border-t border-line pt-3 text-[13px] leading-snug text-ink-2">{afterApproval(someProfileUnlocked)}</p>
              )}
            </div>
          )}
          {offered && (
            <>
              <p className="flex gap-2.5 text-[14px] leading-snug text-ink">
                <Icon name="alertTriangle" size={18} className="mt-0.5 flex-none text-warn" />
                {/* The code as the TV shows it, on one line: typed with more
                    dashes it is the same code, and would not fit. */}
                <span>Approve only if you started sign-in on this TV and its code matches <strong className="whitespace-nowrap font-mono font-semibold tracking-[0.1em] text-ink">{asShown(code)}</strong>.</span>
              </p>
              {/* Two equal halves, side by side; one over the other below
                  375px, where "Approve this TV" broke in two (measured at
                  360). In the order they are read either way. Whose
                  account it is for is said under the heading. */}
              <div className="flex flex-col gap-3 min-[375px]:flex-row">
                <button type="button" onClick={notMine} aria-disabled={busy}
                  className="stage-btn stage-btn-ghost stage-btn-tall stage-btn-wrap flex-1 basis-0">Not my TV</button>
                <button type="button" onClick={() => void approve()} aria-disabled={busy}
                  className="stage-btn stage-btn-primary stage-btn-tall stage-btn-wrap flex-1 basis-0">{busy ? 'Approving…' : 'Approve this TV'}</button>
              </div>
            </>
          )}
          <p id="device-error" role="alert" className={error ? 'text-[14px] leading-snug text-danger-ink' : 'sr-only'}>{error?.text ?? ''}</p>
        </>
      )}
    </section>
  )
}
