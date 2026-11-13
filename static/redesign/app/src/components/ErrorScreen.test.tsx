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
import { APIError } from '@/lib/api'

const api = vi.hoisted(() => ({
  getBugReportConfig: vi.fn(),
  submitBugReport: vi.fn(),
}))
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

const MORGAN = { id: 1, username: 'morgan', email: 'morgan@example.test', role: 'user' }

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
  window.history.pushState({}, '', '/collections?sort=name')
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
    // The page is whole all the same.
    expect(screen.getByRole('heading', { level: 1, name: 'That did not load.' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to Tonight' })).toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled()
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
    expect(sent.description).toBe(`I clicked Collections and got this.\n\nWhat the app saw:\n${shown()}`)
    expect(shown().split('\n').slice(0, 2)).toEqual(['The page stopped while it was being drawn.', 'Could not read the list of collections'])
    expect(sent.name).toBe('morgan')
    expect(sent.attachment).toBeUndefined()
    expect(sent.context?.url).toBe('/collections?sort=name')
    expect(shown()).toContain('Page: /collections?sort=name · ')
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
    window.history.pushState({}, '', '/title/123')
    await fill(user)
    await user.click(within(aside).getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(api.submitBugReport).toHaveBeenCalledTimes(1))
    const [sent] = api.submitBugReport.mock.calls[0] as [{ description: string; context?: { url?: string } }]
    expect(sent.context?.url).toBe('/collections?sort=name')
    expect(sent.description).not.toContain('/title/123')
  })

  // The description and what the page adds to it share the server's limit.
  it('leaves room in the description for what it adds', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    const aside = await openPanel(user)
    const room = 10_000 - (`What the app saw:\n${shown()}`.length + 2)
    const field = within(aside).getByLabelText(/^Description/)
    expect(field).toHaveAttribute('maxlength', String(room))
    expect(aside).toHaveTextContent(`0 / ${room}`)
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
    await act(async () => { refuse(new APIError(503, 'Reports cannot be filed right now.', { error: { code: 503, message: 'Reports cannot be filed right now.' } })) })
    expect(within(aside).getByRole('alert')).toHaveTextContent('Reports cannot be filed right now.')
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
    expect(said()).toBe('The report was closed because this browser is now on another profile.')
    expect(document.querySelector('[data-error-report-said]')).toHaveAttribute('role', 'status')
    expect(api.submitBugReport).not.toHaveBeenCalled()
    // What it is offered now is the new session's to say.
    await waitFor(() => expect(api.getBugReportConfig).toHaveBeenCalledTimes(2))
    // A report started now starts empty, and says whose it will be.
    await user.click(await screen.findByRole('button', { name: 'Report a problem' }))
    expect(said()).toBe('')
    expect(screen.getByLabelText(/^Title/)).toHaveValue('')
    expect(document.querySelector('[data-error-report-switched]')).toHaveTextContent('This browser has moved to another profile since this page stopped. A report is sent from the one it is on now.')
  })

  it('says that a report it could not send was not sent', async () => {
    const user = userEvent.setup()
    signedIn()
    api.submitBugReport.mockReset().mockRejectedValue(new APIError(503, 'Reports cannot be filed right now.', null))
    crash()
    const aside = await openPanel(user)
    await fill(user)
    await user.click(within(aside).getByRole('button', { name: 'Send report' }))
    await within(aside).findByRole('alert')
    anotherTab(() => signedIn(MORGAN, 2))
    await waitFor(() => expect(panel()).toBeNull())
    expect(said()).toBe('The report was closed because this browser is now on another profile, and it was not sent: Reports cannot be filed right now.')
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
    expect(said()).toBe('The report was closed because this browser is now on another profile.')
  })

  it('offers nothing once another tab has signed out, and says another account for another person', async () => {
    const user = userEvent.setup()
    signedIn()
    crash()
    await openPanel(user)
    anotherTab(() => signedIn(null))
    await waitFor(() => expect(panel()).toBeNull())
    expect(said()).toBe('The report was closed because this browser is now on another account.')
    await act(async () => {})
    expect(opener()).toBeNull()
    expect(api.getBugReportConfig).toHaveBeenCalledTimes(1)
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
    expect(api.getBugReportConfig).toHaveBeenCalledTimes(1)
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
})
