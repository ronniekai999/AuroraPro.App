// The page shown in place of the app when drawing it threw.
//
// It has to work when the app's own state is what broke, and when the
// server cannot be reached: it reads nothing from the tree it replaces, its
// two ways out are a reload and a real navigation, and it draws completely
// before any request has answered.
//
// Its own layout is written inline, with the app's tokens written out: the
// stylesheet may be what failed to load, so the page cannot read them from
// it. (The report form inside the panel is the app's form, and is drawn with
// the app's classes like everywhere else.)
//
// "Report a problem" is offered as the "Report a bug" entries are: to a
// signed-in session, on a server that takes reports. The app that knew both
// is gone, so the screen asks again: nobody stored as signed in means no
// request and no offer; otherwise a read of the reporting settings, which
// the server answers only for a session, and nothing is offered until it has
// answered, for the session the browser is on now, that reports are on. It
// asks again whenever that session changes and each time a report is
// opened.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { SESSION_EXPIRED_EVENT, getBugReportConfig, getStoredUser, type BugReportConfig, type BugReportSubmitResult } from '@/lib/api'
import { describeCaughtError, thisPage, type AppSaw } from '@/lib/errorReport'
import { readRememberedProfileId } from '@/lib/profileSession'
import { AuroraWordmark } from '@/components/AuroraWordmark'
import { AuroraMark } from '@/components/TopNav'
import { ErrorGuard } from '@/components/ErrorGuard'
import {
  BugReportFields, BugReportRecordingPill, BugReportSent, BugReportTokenNotice, useBugReportForm,
} from '@/components/BugReportForm'

// --surface-page, --surface-raised, --surface-raised-2, --ink, --ink-2,
// --ink-3, --action and what is written on it.
const PAGE = '#0e0f11'
const RAISED = '#17181b'
const RAISED_2 = '#202226'
const INK = '#f4f4f5'
const INK_2 = '#b4b6bc'
const INK_3 = '#9a9da5'
const ACTION = '#ffffff'
const DISPLAY = "'Bricolage Grotesque', system-ui, sans-serif"

const action: CSSProperties = {
  height: 52, boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', fontFamily: 'inherit', fontSize: 16, fontWeight: 600, textDecoration: 'none', cursor: 'pointer',
}
const quiet: CSSProperties = { ...action, padding: '0 22px', borderRadius: 12, background: RAISED_2, color: INK }
// In the accessibility tree and out of sight, as the stylesheet's sr-only
// is: a live region taken out of the tree while empty is not announced
// when its words arrive.
const unseen: CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
}

/** Where the app starts: Tonight, or the sign-in page when nobody is signed
 *  in (the same address shows it). The phone companion is its own small app
 *  at /join, and its way back is its own first screen. */
function homeFor(pathname: string, signedIn: boolean): { href: string; label: string } {
  const base = import.meta.env.BASE_URL
  const companion = pathname === `${base}join` || pathname.startsWith(`${base}join/`)
  if (companion) return { href: `${base}join`, label: 'Go to the join screen' }
  return { href: base, label: signedIn ? 'Go to Tonight' : 'Go to sign in' }
}

interface Session { userId: number | null; name: string | undefined; profileId: number | null }
const keyOf = (s: Session) => `${s.userId}:${s.profileId}`

/** Who this browser says is signed in, and as which profile: what the app
 *  itself keeps there. Storage that cannot be read is nobody. */
function sessionNow(): Session {
  try {
    const user = getStoredUser()
    return { userId: user?.id ?? null, name: user?.username, profileId: readRememberedProfileId() }
  } catch {
    return { userId: null, name: undefined, profileId: null }
  }
}

type Move = 'signed-out' | 'account' | 'profile'
/** How the browser's session `now` differs from `then`, if it does. */
function moveFrom(then: Session, now: Session): Move | null {
  if (now.userId === null) return then.userId === null ? null : 'signed-out'
  if (now.userId !== then.userId) return 'account'
  return now.profileId !== then.profileId ? 'profile' : null
}

interface ReportAccess {
  /** The session the rest is about. */
  session: Session
  /** A report can be offered: signed in, and the server has said, for
   *  this session, that it takes reports. False until it has. */
  offered: boolean
  /** The server's latest answer for this session says it takes no reports. */
  refused: boolean
  /** Fills in "Your name": the username, never the email. */
  name: string | undefined
  /** The token's health, which the server tells only a session with the
   *  admin's powers. */
  tokenHealthy: boolean | undefined
  tokenHealthReason: string | undefined
  /** Ask the server again (each time a report is opened, as the app's
   *  entries do). */
  askAgain: () => void
}

function useReportAccess(): ReportAccess {
  const [session, setSession] = useState(sessionNow)
  // Counts the changes of session: an answer is good only for the stretch
  // it was asked in, so a return to an earlier session waits for a new one.
  const [stretch, setStretch] = useState(0)
  const [asked, setAsked] = useState(0)
  // The server's answer, with what it was asked for: given to no other.
  const [answer, setAnswer] = useState<{ key: string; config: BugReportConfig } | null>(null)
  const key = `${keyOf(session)}#${stretch}`

  // Another tab signing out, signing in or switching profile writes what
  // sessionNow reads, and this tab hears of it; so does this tab's own
  // request ending the session. A page frozen, hidden or kept by the
  // back/forward cache may have missed either, so it reads again as it
  // comes back.
  const current = useRef(session)
  useEffect(() => {
    const reread = () => {
      const now = sessionNow()
      const was = current.current
      if (was.userId === now.userId && was.profileId === now.profileId) return
      current.current = now
      setSession(now)
      setStretch(n => n + 1)
    }
    const onVisible = () => { if (document.visibilityState === 'visible') reread() }
    window.addEventListener('storage', reread)
    window.addEventListener(SESSION_EXPIRED_EVENT, reread)
    window.addEventListener('pageshow', reread)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('storage', reread)
      window.removeEventListener(SESSION_EXPIRED_EVENT, reread)
      window.removeEventListener('pageshow', reread)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  useEffect(() => {
    if (session.userId === null) return
    const ac = new AbortController()
    getBugReportConfig(ac.signal)
      .then(config => { if (!ac.signal.aborted) setAnswer({ key, config }) })
      // No answer (signed out after all, or no server to answer): nothing
      // new is known, so nothing changes.
      .catch(() => {})
    return () => ac.abort()
  }, [key, session.userId, asked])

  const config = answer && answer.key === key ? answer.config : null
  return {
    session,
    offered: session.userId !== null && config?.enabled === true,
    refused: config !== null && config.enabled !== true,
    name: session.name,
    tokenHealthy: config?.token_healthy,
    tokenHealthReason: config?.token_health_reason,
    askAgain: () => setAsked(n => n + 1),
  }
}

export function ErrorScreen({ error }: { error: unknown }) {
  // Fixed when the screen opens: the page that stopped, and when, and who
  // this browser was then.
  const [saw] = useState(() => describeCaughtError(error, new Date()))
  const [stoppedIn] = useState(sessionNow)
  const access = useReportAccess()
  const [stoppedAt] = useState(() => window.location.pathname)
  const home = homeFor(stoppedAt, access.session.userId !== null)

  // The session the open report was started in; null while none is open.
  const [openedFor, setOpenedFor] = useState<Session | null>(null)
  const open = openedFor !== null
  // Why the report closed by itself, when it did.
  const [said, setSaid] = useState('')
  // A report this opening sent.
  const sentRef = useRef<BugReportSubmitResult | null>(null)

  // A report is one session's, and is only offered while the server takes
  // reports. Either changing while one is open closes it, as soon as
  // nothing of its own is in flight.
  const why: Move | 'refused' | null = openedFor === null
    ? null
    : moveFrom(openedFor, access.session) ?? (access.refused ? 'refused' : null)

  const headingRef = useRef<HTMLHeadingElement>(null)
  const openerRef = useRef<HTMLButtonElement>(null)
  const saidRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => { headingRef.current?.focus() }, [])
  // When the panel goes, the focus it held goes to what opened it, or to
  // the page's heading when that is no longer offered. When it closed by
  // itself, the focus goes to the line that says why: that is read out,
  // where moving the focus elsewhere would talk over it.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open) { wasOpen.current = true; return }
    if (!wasOpen.current) return
    wasOpen.current = false
    ;((said ? saidRef.current : null) ?? openerRef.current ?? headingRef.current)?.focus()
    // Only the closing moves the focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const moved = moveFrom(stoppedIn, access.session)
  const switched = moved === 'account' || moved === 'profile' ? moved : null

  return (
    <div
      data-error-screen=""
      style={{
        minHeight: '100vh', boxSizing: 'border-box', padding: '0 clamp(16px, 4vw, 48px) 40px',
        display: 'flex', flexDirection: 'column',
        background: PAGE, color: INK, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 15, lineHeight: 1.5,
      }}
    >
      <header style={{ height: 64, display: 'flex', alignItems: 'center' }}>
        <a
          href={home.href}
          aria-label={`AuroraPro, ${home.label.charAt(0).toLowerCase()}${home.label.slice(1)}`}
          style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 10, color: INK }}
        >
          {/* The mark and the name, in the page's ink. Sized by their
              boxes: the classes that size them elsewhere come from the
              stylesheet. */}
          <span data-error-mark="" style={{ display: 'block', width: 28, height: 28, flex: 'none' }}>
            <AuroraMark size={28} />
          </span>
          <span aria-hidden="true" style={{ display: 'block', width: 92 }}>
            <AuroraWordmark ink={INK} decorative className="block h-auto w-full" />
          </span>
        </a>
      </header>

      <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '48px 80px' }}>
        <main style={{ flex: '1 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <h1
            ref={headingRef}
            tabIndex={-1}
            // As wide as its words, so the ring it shows when the keys
            // brought the focus here is drawn round them.
            style={{ margin: 0, alignSelf: 'flex-start', fontFamily: DISPLAY, fontSize: 'clamp(40px, 9vw, 72px)', lineHeight: 0.95, fontWeight: 800, letterSpacing: '-0.02em' }}
          >
            That did not load.
          </h1>
          <p style={{ margin: 0, maxWidth: 520, fontSize: 17, color: INK_2 }}>
            This page hit a problem and stopped. That changed nothing in your library. If something was playing,
            the app saves your place every ten seconds as you watch.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
            {/* Reload keeps the address. Nothing here reloads or leaves by
                itself: either would lose what the person was doing. */}
            <button
              type="button"
              onClick={() => thisPage.reload()}
              style={{ ...action, padding: '0 28px', borderRadius: 999, background: ACTION, color: PAGE }}
            >
              Reload
            </button>
            {/* A link, so the browser loads the page: it does not go
                through the app that has just stopped. */}
            <a href={home.href} style={quiet}>{home.label}</a>
            {access.offered && !open && (
              <button
                ref={openerRef}
                type="button"
                onClick={() => {
                  setSaid('')
                  sentRef.current = null
                  setOpenedFor(access.session)
                  access.askAgain()
                }}
                style={quiet}
              >
                Report a problem
              </button>
            )}
          </div>

          <div style={{ marginTop: 16, maxWidth: 560, padding: 16, borderRadius: 12, background: RAISED }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: INK_3 }}>
              What the app saw
            </h2>
            <p
              data-app-saw=""
              style={{
                margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.6,
                color: INK_2, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
              }}
            >
              {saw.lines.join('\n')}
            </p>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: INK_3 }}>
            If a new version was installed while this tab was open, a reload usually fixes it.
          </p>
          {/* Always in the page and in the accessibility tree, so that its
              words arriving are what is announced; out of sight while it
              has none. */}
          <p
            ref={saidRef}
            role="status"
            tabIndex={-1}
            data-error-report-said=""
            style={said ? { margin: 0, fontSize: 14, color: INK } : unseen}
          >
            {said}
          </p>
        </main>

        {open && (
          // Each opening is a new form behind a new guard: closing
          // unmounts both.
          <ErrorGuard
            fallback={<PanelFailed onClose={() => setOpenedFor(null)} />}
          >
            <ErrorReportPanel
              saw={saw}
              access={access}
              switched={switched}
              dismissed={why !== null}
              onClose={() => setOpenedFor(null)}
              onSubmitted={(result) => { sentRef.current = result }}
              onDismissed={(unsent) => {
                const because = why === 'refused'
                  ? 'the server is not taking reports now'
                  : why === 'signed-out'
                    ? 'this browser has signed out'
                    : `this browser is now on another ${why === 'account' ? 'account' : 'profile'}`
                const sent = sentRef.current
                const line = `The report was closed because ${because}`
                setSaid(sent
                  ? `${line}. It had been sent, as issue #${sent.issue_number}.`
                  : unsent ? `${line}, and it was not sent: ${unsent}` : `${line}.`)
                setOpenedFor(null)
              }}
            />
          </ErrorGuard>
        )}
      </div>
    </div>
  )
}

/** In place of the report panel when it could not be drawn: the rest of
 *  the page, Reload and the way out, is untouched. */
function PanelFailed({ onClose }: { onClose: () => void }) {
  const lineRef = useRef<HTMLParagraphElement>(null)
  // The focus was in the panel, which is gone.
  useEffect(() => { lineRef.current?.focus() }, [])
  return (
    <aside
      data-error-report-failed=""
      aria-label="Report a problem"
      style={{ flex: '1 1 400px', maxWidth: 520, minWidth: 0, boxSizing: 'border-box', padding: 24, borderRadius: 20, background: RAISED_2 }}
    >
      <p ref={lineRef} role="alert" tabIndex={-1} style={{ margin: '0 0 16px', fontSize: 15, color: INK }}>
        The report form could not be shown. Reload, and report the problem from the app once it is back.
      </p>
      <button type="button" onClick={onClose} style={{ ...quiet, height: 44 }}>Close</button>
    </aside>
  )
}

/** The report form, as a panel on the page. The form is the app's one bug
 *  report form (components/BugReportForm); this is its frame here. */
function ErrorReportPanel({ saw, access, switched, dismissed, onClose, onSubmitted, onDismissed }: {
  saw: AppSaw
  access: ReportAccess
  switched: 'account' | 'profile' | null
  dismissed: boolean
  onClose: () => void
  onSubmitted: (result: BugReportSubmitResult) => void
  onDismissed: (unsent: string | null) => void
}) {
  const form = useBugReportForm({
    prefillName: access.name,
    onClose,
    // The panel shows that it was sent; the page keeps the number, to say
    // it if the panel then closes by itself.
    onSubmitted,
    dismissed,
    onDismissed,
    // What the page shows under "What the app saw", as it shows it.
    evidence: { text: saw.text, url: saw.page },
    captureShows: 'A capture shows this page as it is now: the error and what the app saw. This panel is left out of it.',
  })
  const { capturing, recording, submitting, submittedResult, titleInputRef } = form
  useEffect(() => { titleInputRef.current?.focus() }, [titleInputRef])

  return (
    <>
      <aside
        aria-labelledby="error-report-title"
        aria-busy={capturing || submitting || recording}
        data-error-report=""
        // Left out of a capture of the page, and out of sight while one is
        // taken or the screen is recorded, as the dialog is.
        data-screenshot-exclude="true"
        style={{
          flex: '1 1 400px', maxWidth: 520, minWidth: 0, boxSizing: 'border-box', borderRadius: 20,
          background: RAISED_2, boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
          ...(recording ? { visibility: 'hidden' } : capturing ? { opacity: 0, pointerEvents: 'none' } : {}),
        }}
      >
        <div style={{ padding: '24px 24px 0' }}>
          <h2 id="error-report-title" style={{ margin: 0, fontFamily: DISPLAY, fontSize: 26, lineHeight: 1.15, fontWeight: 700, letterSpacing: '-0.015em', color: INK }}>
            {submittedResult ? 'Thanks, got it' : 'Report a problem'}
          </h2>
          {!submittedResult && (
            <p style={{ margin: '4px 0 0', fontSize: 14, color: INK_2 }}>
              This opens a GitHub issue with the details below.
            </p>
          )}
          {!submittedResult && switched && (
            <p data-error-report-switched="" style={{ margin: '8px 0 0', fontSize: 14, color: INK }}>
              This browser has moved to another {switched} since this page stopped. A report is sent from the one it is on now.
            </p>
          )}
        </div>
        {submittedResult
          ? <BugReportSent result={submittedResult} onClose={onClose} />
          : (
              <>
                {access.tokenHealthy === false && <BugReportTokenNotice reason={access.tokenHealthReason} />}
                <BugReportFields form={form} />
              </>
            )}
      </aside>
      <BugReportRecordingPill form={form} />
    </>
  )
}
