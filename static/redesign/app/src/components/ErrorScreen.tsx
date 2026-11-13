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
// request and no offer; otherwise one read of the reporting settings, which
// the server answers only for a session, and nothing is offered until it has
// answered that reports are on.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { getBugReportConfig, getStoredUser, type BugReportConfig } from '@/lib/api'
import { describeCaughtError, thisPage, type AppSaw } from '@/lib/errorReport'
import { readRememberedProfileId } from '@/lib/profileSession'
import { AuroraWordmark } from '@/components/AuroraWordmark'
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

/** Where the app starts: Tonight. The phone companion is its own small app
 *  at /join, and its way back is its own first screen. */
function homeFor(pathname: string): { href: string; label: string } {
  const base = import.meta.env.BASE_URL
  const companion = pathname === `${base}join` || pathname.startsWith(`${base}join/`)
  return companion ? { href: `${base}join`, label: 'Go to the join screen' } : { href: base, label: 'Go to Tonight' }
}

interface Session { userId: number | null; name: string | undefined; profileId: number | null }

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

interface ReportAccess {
  /** The session the rest is about. */
  key: string
  /** A report can be offered: signed in, and the server has just said it
   *  takes reports. False until it has. */
  offered: boolean
  /** Fills in "Your name": the username, never the email. */
  name: string | undefined
  /** The token's health, which the server tells only a session with the
   *  admin's powers. */
  tokenHealthy: boolean | undefined
  tokenHealthReason: string | undefined
  /** This browser has changed account or profile since the screen opened
   *  (another tab did it; this one cannot). */
  switched: 'account' | 'profile' | null
}

function useReportAccess(): ReportAccess {
  const [session, setSession] = useState(sessionNow)
  const [switched, setSwitched] = useState<ReportAccess['switched']>(null)
  // The server's answer, with the session it was asked for: given to no other.
  const [answer, setAnswer] = useState<{ key: string; config: BugReportConfig } | null>(null)
  const key = `${session.userId}:${session.profileId}`

  // Another tab signing out, signing in or switching profile writes what
  // sessionNow reads, and this tab hears of it.
  const current = useRef(session)
  useEffect(() => {
    const onStorage = () => {
      const now = sessionNow()
      const was = current.current
      if (was.userId === now.userId && was.profileId === now.profileId) return
      current.current = now
      const what = was.userId !== now.userId ? 'account' : 'profile'
      setSwitched(before => (before === 'account' ? before : what))
      setSession(now)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    if (session.userId === null) return
    const ac = new AbortController()
    getBugReportConfig(ac.signal)
      .then(config => { if (!ac.signal.aborted) setAnswer({ key, config }) })
      // No answer (signed out after all, or no server to answer): nothing
      // is known, so nothing is offered.
      .catch(() => {})
    return () => ac.abort()
  }, [key, session.userId])

  const config = answer && answer.key === key ? answer.config : null
  return {
    key,
    offered: session.userId !== null && config?.enabled === true,
    name: session.name,
    tokenHealthy: config?.token_healthy,
    tokenHealthReason: config?.token_health_reason,
    switched,
  }
}

export function ErrorScreen({ error }: { error: Error }) {
  // Fixed when the screen opens: the page that stopped, and when.
  const [saw] = useState(() => describeCaughtError(error, new Date()))
  const [home] = useState(() => homeFor(window.location.pathname))
  const access = useReportAccess()

  // The session the open report was started in; null while none is open.
  const [openedFor, setOpenedFor] = useState<string | null>(null)
  const open = openedFor !== null
  // Why the report closed by itself, when it did.
  const [said, setSaid] = useState('')

  const headingRef = useRef<HTMLHeadingElement>(null)
  const openerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { headingRef.current?.focus() }, [])
  // When the panel goes, the focus it held goes to what opened it, or to
  // the page's heading when that is no longer offered.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open) { wasOpen.current = true; return }
    if (!wasOpen.current) return
    wasOpen.current = false
    ;(openerRef.current ?? headingRef.current)?.focus()
  }, [open])

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
          style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', color: INK }}
        >
          {/* The name, in the page's ink. Sized by its box: the classes
              that size it elsewhere come from the stylesheet. */}
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
                onClick={() => { setSaid(''); setOpenedFor(access.key) }}
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
          {/* Always in the page, so that its words arriving are what is
              announced; it takes no room while it has none. */}
          <p role="status" data-error-report-said="" style={{ margin: 0, fontSize: 14, color: INK, display: said ? 'block' : 'none' }}>
            {said}
          </p>
        </main>

        {open && (
          <ErrorReportPanel
            saw={saw}
            access={access}
            // A report is one session's. This browser moving to another
            // while it is open closes it, as soon as nothing of its own is
            // in flight, and the person is told why.
            dismissed={openedFor !== access.key}
            onClose={() => setOpenedFor(null)}
            onDismissed={(unsent) => {
              const why = `The report was closed because this browser is now on another ${access.switched === 'account' ? 'account' : 'profile'}`
              setSaid(unsent ? `${why}, and it was not sent: ${unsent}` : `${why}.`)
              setOpenedFor(null)
            }}
          />
        )}
      </div>
    </div>
  )
}

/** The report form, as a panel on the page. The form is the app's one bug
 *  report form (components/BugReportForm); this is its frame here. */
function ErrorReportPanel({ saw, access, dismissed, onClose, onDismissed }: {
  saw: AppSaw
  access: ReportAccess
  dismissed: boolean
  onClose: () => void
  onDismissed: (unsent: string | null) => void
}) {
  const form = useBugReportForm({
    prefillName: access.name,
    onClose,
    // The panel shows that it was sent; there is no page behind it to tell.
    onSubmitted: () => {},
    dismissed,
    onDismissed,
    // What the page shows under "What the app saw", as it shows it.
    evidence: { text: saw.text, url: saw.page },
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
          {!submittedResult && access.switched && (
            <p data-error-report-switched="" style={{ margin: '8px 0 0', fontSize: 14, color: INK }}>
              This browser has moved to another {access.switched} since this page stopped. A report is sent from the one it is on now.
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
