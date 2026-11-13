// @vitest-environment jsdom
//
// "Report a problem" on the error screen: who is offered it, that it is the
// app's one bug report form, that a report carries exactly what the page
// shows under "What the app saw", and what happens when another tab changes
// who this browser is while the screen is up.
//
// Every test starts from the state the screen really starts in: a component
// has thrown while it was drawn, the app's tree is gone, and nothing the app
// knew is known any more. What the screen knows of the session it reads
// from where the app keeps it (the stored user, the profile this browser
// last showed) and from one request of its own.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorBoundary } from './ErrorBoundary'
import { BugReportModal } from './BugReportModal'
import { APIError, SESSION_EXPIRED_EVENT } from '@/lib/api'
import { codeSpan } from '@/lib/errorReport'

const api = vi.hoisted(() => ({
  getBugReportConfig: vi.fn(),
  submitBugReport: vi.fn(),
}))
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))
// The capture library: what a capture is asked for is what these tests read.
const toBlob = vi.hoisted(() => vi.fn())
vi.mock('html-to-image', () => ({ toBlob }))

const MORGAN = { id: 1, username: 'morgan', email: 'morgan@example.test', role: 'user' }
const ROBIN = { id: 2, username: 'robin', email: 'robin@example.test', role: 'user' }
/** Where the app is served from. */
const BASE = import.meta.env.BASE_URL
/** Bytes as the server counts them: UTF-8, every line break sent as CR LF. */
const bytesSent = (s: string) => new TextEncoder().encode(s.replace(/\r\n|\r|\n/g, '\r\n')).length

function Throws(): never {
  throw new Error('Could not read the list of collections')
}
function crash() {
  return render(<ErrorBoundary><Throws /></ErrorBoundary>)
}
/** This browser as the app leaves it: who is signed in, and as which profile. */
function signedIn(user: typeof MORGAN | null = MORGAN, profileId = 1) {
  if (user) localStorage.setItem('aurora_user', JSON.stringify(user))
  else localStorage.removeItem('aurora_user')
  localStorage.setItem('aurora_active_profile_id', String(profileId))
}
/** Another tab writes what the app keeps, and this tab hears of it. */
function anotherTab(change: () => void) {
  act(() => {
    change()
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
  })
}
const opener = () => screen.queryByRole('button', { name: 'Report a problem' })
const panel = () => screen.queryByRole('complementary', { name: /^(Report a problem|Thanks, got it)$/ })
const said = () => document.querySelector('[data-error-report-said]')!.textContent
const shown = () => document.querySelector('[data-app-saw]')!.textContent!
async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Report a problem' }))
  return screen.getByRole('complementary', { name: 'Report a problem' })
}
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Title/), 'Collections will not open')
  await user.type(screen.getByLabelText(/^Description/), 'I clicked Collections and got this.')
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  api.getBugReportConfig.mockReset().mockResolvedValue({ enabled: true })
  api.submitBugReport.mockReset().mockResolvedValue({ issue_url: 'https://example.test/issues/41', issue_number: 41 })
  window.history.pushState({}, '', `${BASE}collections?sort=name`)
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  window.history.pushState({}, '', '/')
})

// As the "Report a bug" entries are: a signed-in session, on a server that
// takes reports. The app that knew both is gone.
describe('the error screen: who is offered a report', () => {
  it('asks nothing and offers nothing when nobody is signed in', async () => {
    signedIn(null)
    crash()
    await act(async () => {})
    expect(api.getBugReportConfig).not.toHaveBeenCalled()
    expect(opener()).toBeNull()
    expect(panel()).toBeNull()
    // The page is whole all the same; its way out is the sign-in page.
    expect(screen.getByRole('heading', { level: 1, name: 'That did not load.' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toBeInTheDocument()
  })

  it('offers nothing on a server that takes no reports', async () => {
    signedIn()
    api.getBugReportConfig.mockResolvedValue({ enabled: false })
    crash()
    await waitFor(() => expect(api.getBugReportConfig).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(opener()).toBeNull()
  })

  // Nothing is offered on what the app once knew: only on the server's
  // answer, and not before it. Meanwhile the page is complete, with nothing
  // that waits or spins.
  it('offers nothing until the server has said it takes reports, and is complete meanwhile', async () => {
    signedIn()
    let answer!: (config: { enabled: boolean }) => void
    api.getBugReportConfig.mockImplementation(() => new Promise(resolve => { answer = resolve }))
    crash()
    await act(async () => {})
    expect(opener()).toBeNull()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled()
    expect(screen.getByRole('link', { name: 'Go to Tonight' })).toBeInTheDocument()
    expect(shown()).toContain('Could not read the list of collections')
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(document.body.textContent).not.toMatch(/loading|checking|please wait/i)
    await act(async () => { answer({ enabled: true }) })
    expect(opener()).toBeInTheDocument()
    // Not open by itself: the page is about getting back to the app first.
    expect(panel()).toBeNull()
  })

  // The server cannot be reached: no request succeeds.
  it('offers nothing when the server cannot be reached, and says nothing is wrong with that', async () => {
    signedIn()
    api.getBugReportConfig.mockRejectedValue(new TypeError('Failed to fetch'))
    crash()
    await waitFor(() => expect(api.getBugReportConfig).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(opener()).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(said()).toBe('')
    // The line that would say why a report closed is in the page and in the
    // accessibility tree while it is empty, so that its words are announced
    // when they arrive; it is out of sight meanwhile.
    const line = document.querySelector<HTMLElement>('[data-error-report-said]')!
    expect(line).toHaveAttribute('role', 'status')
    expect(line.style.display).not.toBe('none')
    expect(line.style.visibility).not.toBe('hidden')
    expect(line).toHaveStyle({ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden' })
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled()
  })

  // The app's entries ask again each time the dialog is opened; so does
  // this. A server that has stopped taking reports closes the panel.
  it('asks the server again at each opening, and closes when reports have been turned off', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    await openPanel(user)
    expect(api.getBugReportConfig).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    api.getBugReportConfig.mockResolvedValue({ enabled: false })
    await user.click(await screen.findByRole('button', { name: 'Report a problem' }))
    expect(api.getBugReportConfig).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(panel()).toBeNull())
    expect(said()).toBe('The report was closed because the server stopped taking reports.')
    expect(opener()).toBeNull()
  })

  it('offers nothing to a session the server no longer knows', async () => {
    signedIn()
    api.getBugReportConfig.mockRejectedValue(new APIError(401, 'not signed in', { error: { code: 401, message: 'not signed in' } }))
    crash()
    await waitFor(() => expect(api.getBugReportConfig).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(opener()).toBeNull()
  })
})

describe('the error screen: reporting the problem', () => {
  it('opens the app\'s own form as a panel on the page, with the focus in it', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    const aside = await openPanel(user)
    // The button that opened it is gone while it is open.
    expect(opener()).toBeNull()
    await waitFor(() => expect(screen.getByLabelText(/^Title/)).toHaveFocus())
    // The form the dialog shows: its fields, its three ways to show the
    // problem, its Cancel and Send.
    expect(within(aside).getByLabelText(/^Your name/)).toHaveValue('morgan')
    expect(within(aside).getByLabelText(/^Description/)).toBeInTheDocument()
    for (const name of [/^Choose file/, /^Capture this page/, /^Record screen/, 'Cancel', 'Send report']) {
      expect(within(aside).getByRole('button', { name })).toBeInTheDocument()
    }
    // The username, never the email: it lands in the issue.
    expect(aside.textContent).not.toContain('morgan@example.test')
    // Left out of a capture of the page it is on.
    expect(aside).toHaveAttribute('data-screenshot-exclude', 'true')
    // It says what else this report carries, and promises nothing about
    // what it leaves out.
    const note = aside.querySelector('[data-evidence-note]')!
    expect(note).toHaveTextContent('This report also carries what the app saw, exactly as it is shown on this page: the error\'s text, the page\'s address, the time and the build. With the log, that can show which pages and titles were open.')
    expect(aside.textContent).not.toMatch(/never includes/i)
    // What a capture shows is said for this page: not the app's library or
    // what was playing, which are gone.
    expect(aside).toHaveTextContent('A capture shows the top of this page at the size of the window, with the space this panel takes left empty.')
    expect(aside.textContent).not.toMatch(/currently playing media/)
  })

  // On a narrow window the panel is under the page's text, and opening it
  // moves the window down to it: a capture from there was mostly the
  // panel's empty place. The dialog, over the page, captures the window.
  // The button is disabled only once the capture library has loaded: a
  // second press before then started a second capture over the first (its
  // blanking of secret fields and its restore interleaved with the first's).
  it('takes one capture for two presses made before the capture library has loaded', async () => {
    toBlob.mockReset()
    let release!: (blob: Blob | null) => void
    toBlob.mockImplementation(() => new Promise(r => { release = r }))
    render(<BugReportModal prefillName="morgan" onClose={() => {}} onSubmitted={() => {}} />)
    const dialog = screen.getByRole('dialog')
    const capture = within(dialog).getByRole('button', { name: /Capture this page/ })
    fireEvent.click(capture)
    fireEvent.click(capture)
    await waitFor(() => expect(toBlob).toHaveBeenCalled())
    // Time for a second capture to reach the library, or fail on its way.
    await new Promise(r => setTimeout(r, 500))
    expect(toBlob).toHaveBeenCalledTimes(1)
    expect(dialog.querySelector('#bug-error')?.textContent ?? '').toBe('')
    await act(async () => { release(null) })
  })

  it('takes a capture from the top of the page, where the dialog takes the window', async () => {
    const user = userEvent.setup()
    toBlob.mockReset()
    toBlob.mockResolvedValue(null)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 640 })
    try {
      signedIn()
      const { unmount } = crash()
      const aside = await openPanel(user)
      await user.click(within(aside).getByRole('button', { name: /Capture this page/ }))
      await waitFor(() => expect(toBlob).toHaveBeenCalledTimes(1))
      const fromPanel = (toBlob.mock.calls[0][1] as { fontEmbedCSS: string }).fontEmbedCSS
      expect(fromPanel).toContain('top:0px!important')
      expect(fromPanel).not.toContain('top:-640px')
      // The panel's place is kept in the picture, and nothing of it drawn.
      const keep = toBlob.mock.calls[0][1].filter as (node: Node) => boolean
      expect(keep(aside)).toBe(true)
      expect(keep(within(aside).getByLabelText(/^Title/))).toBe(false)
      unmount()

      render(<BugReportModal prefillName="morgan" onClose={() => {}} onSubmitted={() => {}} />)
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Capture this page/ }))
      await waitFor(() => expect(toBlob).toHaveBeenCalledTimes(2))
      expect((toBlob.mock.calls[1][1] as { fontEmbedCSS: string }).fontEmbedCSS).toContain('top:-640px!important')
    } finally {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    }
  })

  // What is sent is what is shown: the lines under "What the app saw", as
  // they stand on the page, after the person's own words; and the address
  // of the page that stopped.
  it('sends exactly what the page shows, once, and says it was sent', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    const aside = await openPanel(user)
    await fill(user)
    await user.click(within(aside).getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(api.submitBugReport).toHaveBeenCalledTimes(1))
    const [sent] = api.submitBugReport.mock.calls[0] as [{ title: string; description: string; name?: string; attachment?: File; context?: { url?: string } }]
    expect(sent.title).toBe('Collections will not open')
    // Each line as a code span: shown by the tracker as written, and acted
    // on not at all.
    expect(sent.description).toBe(`I clicked Collections and got this.\n\nWhat the app saw:\n${shown().split('\n').map(codeSpan).join('\n')}`)
    expect(shown().split('\n').slice(0, 2)).toEqual(['The page stopped while it was being drawn.', 'Could not read the list of collections'])
    expect(sent.name).toBe('morgan')
    expect(sent.attachment).toBeUndefined()
    expect(sent.context?.url).toBe(`${BASE}collections?sort=name`)
    expect(shown()).toContain(`Page: ${BASE}collections?sort=name · `)
    // The rest of what every report carries is still there.
    expect(Object.keys(sent.context ?? {})).toEqual(expect.arrayContaining(['url', 'userAgent', 'clientTime']))

    const done = await screen.findByRole('complementary', { name: 'Thanks, got it' })
    expect(done).toHaveTextContent('issue #41')
    await user.click(within(done).getByRole('button', { name: 'Done' }))
    expect(panel()).toBeNull()
    // The focus goes back to what opened the panel.
    await waitFor(() => expect(opener()).toHaveFocus())
    expect(api.submitBugReport).toHaveBeenCalledTimes(1)
  })

  // The address a report names is the page that stopped, whatever the
  // address bar has moved to since (Back, with no app left to follow it).
  it('names the page that stopped, not where the address bar has gone since', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    const aside = await openPanel(user)
    window.history.pushState({}, '', `${BASE}title/123`)
    await fill(user)
    await user.click(within(aside).getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(api.submitBugReport).toHaveBeenCalledTimes(1))
    const [sent] = api.submitBugReport.mock.calls[0] as [{ description: string; context?: { url?: string } }]
    expect(sent.context?.url).toBe(`${BASE}collections?sort=name`)
    expect(sent.description).not.toContain('/title/123')
  })

  // The description and what the page adds to it share the server's
  // limit, which counts the bytes it receives: a description the form lets
  // go is one the server takes, line breaks and accents included.
  it('leaves room in the description for what it adds, counted as the server counts', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    const aside = await openPanel(user)
    await user.type(within(aside).getByLabelText(/^Title/), 'Collections will not open')
    const field = within(aside).getByLabelText(/^Description/)
    const room = Number(aside.textContent!.match(/0 \/ (\d+) bytes/)![1])
    // Two lines of accented words, filled to the last byte.
    const line = 'Élan café — the list stopped\n'
    let text = line.repeat(Math.floor(room / bytesSent(line)))
    text += 'x'.repeat(room - bytesSent(text))
    expect(bytesSent(text)).toBe(room)
    fireEvent.change(field, { target: { value: `${text}y` } })
    expect(aside).toHaveTextContent(`${room + 1} / ${room} bytes`)
    await user.click(within(aside).getByRole('button', { name: 'Send report' }))
    expect(within(aside).getByRole('alert')).toHaveTextContent(`Description is too long.`)
    expect(api.submitBugReport).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: text } })
    expect(aside).toHaveTextContent(`${room} / ${room} bytes`)
    await user.click(within(aside).getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(api.submitBugReport).toHaveBeenCalledTimes(1))
    const [sent] = api.submitBugReport.mock.calls[0] as [{ description: string }]
    // What goes out is exactly at the server's limit.
    expect(bytesSent(sent.description)).toBe(10_000)
    expect(sent.description.endsWith(shown().split('\n').map(codeSpan).join('\n'))).toBe(true)
  })

  it('shows a refused send where it was pressed, keeps the focus there, and sends once per press', async () => {
    const user = userEvent.setup()
    signedIn()
    let refuse!: (e: Error) => void
    api.submitBugReport.mockReset()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject }))
      .mockResolvedValue({ issue_url: '', issue_number: 42 })
    crash()
    const aside = await openPanel(user)
    await fill(user)
    const send = within(aside).getByRole('button', { name: 'Send report' })
    send.focus()
    await user.keyboard('{Enter}')
    // A second press while the first is out sends nothing more.
    await user.keyboard('{Enter}')
    expect(api.submitBugReport).toHaveBeenCalledTimes(1)
    await act(async () => { refuse(new APIError(503, 'bug reporting is enabled but misconfigured — administrator needs to set BUG_REPORT_GITHUB_TOKEN and BUG_REPORT_GITHUB_REPO', null)) })
    // Said in the app's words, not the server's.
    // A server set up wrong: no retry works until its admin acts.
    expect(within(aside).getByRole('alert')).toHaveTextContent('This server cannot send reports at the moment. If a file is attached, try sending without it.')
    expect(aside.textContent).not.toMatch(/misconfigured|GITHUB/)
    expect(within(aside).getByRole('button', { name: 'Send report' })).toHaveFocus()
    // What was written is still there, and the next press sends it.
    expect(within(aside).getByLabelText(/^Title/)).toHaveValue('Collections will not open')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(api.submitBugReport).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('complementary', { name: 'Thanks, got it' })).toHaveTextContent('issue #42')
  })

  it('closes on Cancel with nothing sent, and gives the focus back', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    const aside = await openPanel(user)
    await fill(user)
    await user.click(within(aside).getByRole('button', { name: 'Cancel' }))
    expect(panel()).toBeNull()
    await waitFor(() => expect(opener()).toHaveFocus())
    expect(api.submitBugReport).not.toHaveBeenCalled()
    // A new report starts empty.
    await user.click(opener()!)
    expect(screen.getByLabelText(/^Title/)).toHaveValue('')
  })

  // The server tells a session with the admin's powers when its token is
  // failing; nobody's report can be sent then.
  it('tells an admin when the server cannot file reports', async () => {
    const user = userEvent.setup()
    signedIn()
    api.getBugReportConfig.mockResolvedValue({ enabled: true, token_healthy: false, token_health_reason: 'The token has expired.' })
    crash()
    const aside = await openPanel(user)
    expect(within(aside).getByText(/GitHub token issue/)).toBeInTheDocument()
    expect(aside).toHaveTextContent('The token has expired.')
  })

  it('says nothing of the token to a session the server told nothing', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    const aside = await openPanel(user)
    expect(within(aside).queryByText(/GitHub token issue/)).toBeNull()
  })
})

// The tab that stopped cannot switch profile, but another tab of the same
// browser can, and they share one session. A report is one session's: what
// was written under one profile must not go out under another without the
// person knowing.
describe('the error screen: another tab changes who this browser is', () => {
  it('closes an open report, says why, and asks the server again', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    await openPanel(user)
    await fill(user)
    anotherTab(() => signedIn(MORGAN, 2))
    await waitFor(() => expect(panel()).toBeNull())
    expect(said()).toBe('The report was closed because this browser moved to another profile.')
    expect(document.querySelector('[data-error-report-said]')).toHaveAttribute('role', 'status')
    expect(api.submitBugReport).not.toHaveBeenCalled()
    // The line that says why has the focus, so that it is what is read.
    expect(document.querySelector('[data-error-report-said]')).toHaveFocus()
    // What it is offered now is the new session's to say (asked when the
    // page opened, when the report did, and now).
    await waitFor(() => expect(api.getBugReportConfig).toHaveBeenCalledTimes(3))
    // A report started now starts empty, and says whose it will be.
    await user.click(await screen.findByRole('button', { name: 'Report a problem' }))
    expect(said()).toBe('')
    expect(screen.getByLabelText(/^Title/)).toHaveValue('')
    expect(document.querySelector('[data-error-report-switched]')).toHaveTextContent('This browser has moved to another profile since this page stopped. A report is sent from the one it is on now.')
  })

  it('says that a report it could not send was not sent', async () => {
    const user = userEvent.setup()
    signedIn()
    api.submitBugReport.mockReset().mockRejectedValue(new APIError(502, 'bug report submission failed — please try again later or contact your administrator', null))
    crash()
    const aside = await openPanel(user)
    await fill(user)
    await user.click(within(aside).getByRole('button', { name: 'Send report' }))
    await within(aside).findByRole('alert')
    anotherTab(() => signedIn(MORGAN, 2))
    await waitFor(() => expect(panel()).toBeNull())
    expect(said()).toBe('The report was closed because this browser moved to another profile, and it was not sent: Could not send the report just now.')
  })

  // A send that is out is not cut off: the report closes when it has
  // answered.
  it('lets a send that is out finish first', async () => {
    const user = userEvent.setup()
    signedIn()
    let land!: (r: { issue_url: string; issue_number: number }) => void
    api.submitBugReport.mockReset().mockImplementation(() => new Promise(resolve => { land = resolve }))
    crash()
    const aside = await openPanel(user)
    await fill(user)
    await user.click(within(aside).getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(api.submitBugReport).toHaveBeenCalledTimes(1))
    anotherTab(() => signedIn(MORGAN, 2))
    await act(async () => {})
    expect(panel()).not.toBeNull()
    await act(async () => { land({ issue_url: '', issue_number: 43 }) })
    await waitFor(() => expect(panel()).toBeNull())
    // It was sent: the number is given, so that it is not filed again.
    expect(said()).toBe('The report was closed because this browser moved to another profile. It had been sent, as issue #43.')
  })

  it('offers nothing once another tab has signed out, and says so', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    await openPanel(user)
    expect(api.getBugReportConfig).toHaveBeenCalledTimes(2)
    anotherTab(() => signedIn(null))
    await waitFor(() => expect(panel()).toBeNull())
    expect(said()).toBe('The report was closed because this browser signed out.')
    await act(async () => {})
    expect(opener()).toBeNull()
    expect(api.getBugReportConfig).toHaveBeenCalledTimes(2)
    // And the way out now leads to the sign-in page.
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toBeInTheDocument()
  })

  it('says another account for another person', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    await openPanel(user)
    anotherTab(() => signedIn(ROBIN, 5))
    await waitFor(() => expect(panel()).toBeNull())
    expect(said()).toBe('The report was closed because this browser moved to another account.')
    await user.click(await screen.findByRole('button', { name: 'Report a problem' }))
    expect(document.querySelector('[data-error-report-switched]')).toHaveTextContent('This browser has moved to another account since this page stopped.')
    expect(screen.getByLabelText(/^Your name/)).toHaveValue('robin')
  })

  // The page stopped with nobody signed in: it was on no account, so it
  // has not moved to another one.
  it('says someone has signed in when the page stopped with nobody signed in', async () => {
    const user = userEvent.setup()
    signedIn(null)
    crash()
    await act(async () => {})
    expect(opener()).toBeNull()
    anotherTab(() => signedIn(MORGAN, 1))
    await openPanel(user)
    expect(document.querySelector('[data-error-report-switched]')).toHaveTextContent('Someone has signed in on this browser since this page stopped. A report is sent from that account.')
    expect(document.body.textContent).not.toMatch(/another account/)
  })

  // The closure line is kept as it was written, so it says what happened in
  // the past tense: a move back afterwards does not make it false.
  it('says why a report closed in the past tense', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    await openPanel(user)
    anotherTab(() => signedIn(MORGAN, 2))
    await waitFor(() => expect(panel()).toBeNull())
    anotherTab(() => signedIn(MORGAN, 1))
    await act(async () => {})
    expect(said()).toBe('The report was closed because this browser moved to another profile.')
  })

  // What the panel says is judged against the session the page stopped in,
  // as the browser holds it now: a move and back is no move.
  it('says nothing of a move once the browser is back on the profile the page stopped in', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    await screen.findByRole('button', { name: 'Report a problem' })
    anotherTab(() => signedIn(MORGAN, 2))
    await waitFor(() => expect(api.getBugReportConfig).toHaveBeenCalledTimes(2))
    anotherTab(() => signedIn(MORGAN, 1))
    await waitFor(() => expect(api.getBugReportConfig).toHaveBeenCalledTimes(3))
    await openPanel(user)
    expect(document.querySelector('[data-error-report-switched]')).toBeNull()
  })

  it('says nothing of a move when the same person signs out and in again', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    await screen.findByRole('button', { name: 'Report a problem' })
    anotherTab(() => signedIn(null))
    await waitFor(() => expect(opener()).toBeNull())
    anotherTab(() => signedIn(MORGAN, 1))
    await openPanel(user)
    expect(document.querySelector('[data-error-report-switched]')).toBeNull()
  })

  // This tab's own request can end the session: the app's request layer
  // clears the stored user and says so with an event, not a storage write.
  it('hears this tab\'s own request ending the session', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    await openPanel(user)
    act(() => {
      localStorage.removeItem('aurora_user')
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
    })
    await waitFor(() => expect(panel()).toBeNull())
    expect(said()).toBe('The report was closed because this browser signed out.')
    expect(opener()).toBeNull()
  })

  // A page restored from the back/forward cache, or shown again after it was
  // hidden or frozen, may have missed what changed meanwhile.
  it.each([
    ['restored from the back/forward cache', () => window.dispatchEvent(new Event('pageshow'))],
    ['shown again', () => document.dispatchEvent(new Event('visibilitychange'))],
  ])('reads the session again when the page is %s', async (_how, comeBack) => {
    const user = userEvent.setup()
    signedIn()
    crash()
    await openPanel(user)
    await fill(user)
    // Changed while this page heard nothing.
    signedIn(MORGAN, 2)
    await act(async () => {})
    expect(panel()).not.toBeNull()
    act(() => comeBack())
    await waitFor(() => expect(panel()).toBeNull())
    expect(said()).toBe('The report was closed because this browser moved to another profile.')
  })

  // An answer is the session's that was asked for, and only for the stretch
  // it was asked in: back on an earlier session, the earlier answer is not
  // used, and nothing is offered until the server answers again.
  it('does not use an earlier answer for a session the browser has come back to', async () => {
    signedIn()
    crash()
    await screen.findByRole('button', { name: 'Report a problem' })
    let answer!: (config: { enabled: boolean }) => void
    api.getBugReportConfig.mockImplementation(() => new Promise(resolve => { answer = resolve }))
    anotherTab(() => signedIn(MORGAN, 3))
    await waitFor(() => expect(api.getBugReportConfig).toHaveBeenCalledTimes(2))
    anotherTab(() => signedIn(MORGAN, 1))
    await waitFor(() => expect(api.getBugReportConfig).toHaveBeenCalledTimes(3))
    expect(opener()).toBeNull()
    await act(async () => { answer({ enabled: true }) })
    expect(opener()).toBeInTheDocument()
  })

  // The stored user is rewritten for other reasons too (an avatar, a name).
  it('is not disturbed by a change that is not a change of person or profile', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    await openPanel(user)
    await fill(user)
    anotherTab(() => signedIn({ ...MORGAN, email: 'new@example.test' }, 1))
    await act(async () => {})
    expect(panel()).not.toBeNull()
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Collections will not open')
    expect(said()).toBe('')
    // Nor is the report said to be going from another profile.
    expect(document.querySelector('[data-error-report-switched]')).toBeNull()
    // Asked once when the page opened, once when the report did.
    expect(api.getBugReportConfig).toHaveBeenCalledTimes(2)
  })

  // With nothing open there is nothing to close, and nothing to say.
  it('only asks the server again when no report is open', async () => {
    signedIn()
    crash()
    await screen.findByRole('button', { name: 'Report a problem' })
    anotherTab(() => signedIn(MORGAN, 2))
    await waitFor(() => expect(api.getBugReportConfig).toHaveBeenCalledTimes(2))
    expect(said()).toBe('')
    // The first session's answer is not the second's: nothing is offered
    // until the server has answered for it.
    let answer!: (config: { enabled: boolean }) => void
    api.getBugReportConfig.mockImplementation(() => new Promise(resolve => { answer = resolve }))
    anotherTab(() => signedIn(MORGAN, 3))
    await waitFor(() => expect(api.getBugReportConfig).toHaveBeenCalledTimes(3))
    expect(opener()).toBeNull()
    await act(async () => { answer({ enabled: true }) })
    expect(opener()).toBeInTheDocument()
    fireEvent.click(opener()!)
    expect(document.querySelector('[data-error-report-switched]')).not.toBeNull()
  })
})

// The same form in its other frame. What the error screen adds to a report
// is the error screen's: the dialog adds nothing, says nothing of it, and
// names the page the tab is on.
describe('the bug report dialog carries no such evidence', () => {
  it('sends the description as written, with the whole limit to write in', async () => {
    const user = userEvent.setup()
    render(<BugReportModal prefillName="morgan" onClose={() => {}} onSubmitted={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('[data-evidence-note]')).toBeNull()
    expect(within(dialog).getByLabelText(/^Description/)).toHaveAttribute('maxlength', '10000')
    expect(dialog).toHaveTextContent('0 / 10000')
    await fill(user)
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(api.submitBugReport).toHaveBeenCalledTimes(1))
    const [sent] = api.submitBugReport.mock.calls[0] as [Record<string, unknown>]
    expect(sent.description).toBe('I clicked Collections and got this.')
    expect(sent).not.toHaveProperty('context')
  })

  // The server counts bytes, with each line break sent as two: the
  // dialog's limit is the server's.
  it('counts the description as the server does', async () => {
    const user = userEvent.setup()
    render(<BugReportModal prefillName="morgan" onClose={() => {}} onSubmitted={() => {}} />)
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/^Title/), 'Accents')
    const field = within(dialog).getByLabelText(/^Description/)
    // 5,000 string units, 10,001 bytes as sent.
    const over = `${'é\n'.repeat(2_500)}`.slice(0, -1) + 'éx'
    expect(over.length).toBe(5_001)
    expect(bytesSent(over)).toBeGreaterThan(10_000)
    fireEvent.change(field, { target: { value: over } })
    expect(dialog).toHaveTextContent(`${bytesSent(over)} / 10000 bytes`)
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Description is too long.')
    expect(api.submitBugReport).not.toHaveBeenCalled()
    const fits = 'é'.repeat(5_000)
    expect(bytesSent(fits)).toBe(10_000)
    fireEvent.change(field, { target: { value: fits } })
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(api.submitBugReport).toHaveBeenCalledTimes(1))
  })

  it('counts the name as the server does', async () => {
    const user = userEvent.setup()
    render(<BugReportModal prefillName="" onClose={() => {}} onSubmitted={() => {}} />)
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/^Title/), 'A long name')
    await user.type(within(dialog).getByLabelText(/^Description/), 'Cyrillic is two bytes a letter')
    // 60 letters, 120 bytes: over the server's 100.
    fireEvent.change(within(dialog).getByLabelText(/^Your name/), { target: { value: 'Ж'.repeat(60) } })
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Your name is too long: 120 of 100 bytes.')
    expect(within(dialog).getByLabelText(/^Your name/)).toHaveAttribute('aria-invalid', 'true')
    expect(api.submitBugReport).not.toHaveBeenCalled()
    fireEvent.change(within(dialog).getByLabelText(/^Your name/), { target: { value: 'Ж'.repeat(50) } })
    expect(within(dialog).getByLabelText(/^Your name/)).toHaveAttribute('aria-invalid', 'false')
    expect(within(dialog).queryByText(/Your name is too long/)).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(api.submitBugReport).toHaveBeenCalledTimes(1))
  })

  it('counts the title as the server does', async () => {
    const user = userEvent.setup()
    render(<BugReportModal prefillName="morgan" onClose={() => {}} onSubmitted={() => {}} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'é'.repeat(101) } })
    expect(dialog).toHaveTextContent('202 / 200 bytes')
    await user.type(within(dialog).getByLabelText(/^Description/), 'Long title')
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Title is too long.')
    expect(api.submitBugReport).not.toHaveBeenCalled()
  })
})
