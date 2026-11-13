// @vitest-environment jsdom
//
// The bug report dialog in its host: what it says to whom, where the focus
// is while a report is sent, and where the focus goes when it closes. What
// opens it, and over which page, is App's (hooks/useBugReportEntry and
// App.bugReport.test.tsx).

import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { APIError, type BugReportSubmitResult } from '@/lib/api'

const submitBugReport = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), submitBugReport }))

import { BugReportHost } from './BugReportHost'

const SENT: BugReportSubmitResult = { issue_number: 512, issue_url: 'https://example.test/issues/512' } as BugReportSubmitResult

beforeEach(() => { submitBugReport.mockReset().mockResolvedValue(SENT) })

type HostProps = Parameters<typeof BugReportHost>[0]
/** The host as App holds it: open by a state the page owns, and opened by
 *  a control of the page's. `keepOpener` false takes that control off the
 *  page once the dialog is open, as going back from the Me page does. */
function Page({ onToast, keepOpener = true, ...props }: Partial<HostProps> & { onToast: HostProps['onToast']; keepOpener?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <main>
      <h1>Movies</h1>
      {(keepOpener || !open) && <button type="button" onClick={() => setOpen(true)}>Report a bug</button>}
      <BugReportHost open={open} onClose={() => setOpen(false)} prefillName="morgan" onToast={onToast} {...props} />
    </main>
  )
}
function setup(props: Partial<HostProps> & { keepOpener?: boolean } = {}) {
  const onToast = vi.fn()
  const view = render(<Page onToast={onToast} {...props} />)
  return { onToast, view }
}
const launcher = () => screen.getByRole('button', { name: 'Report a bug' })

async function fill(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.type(within(dialog).getByLabelText(/^Title/), 'Wrong episode opens')
  await user.type(within(dialog).getByLabelText(/^Description/), 'It opened episode 4, not 5.')
}

describe('the bug report dialog in its host', () => {
  it('opens with the focus on the title and the sender’s name filled in, and gives the focus back to what opened it', async () => {
    const user = userEvent.setup()
    const focusFallback = vi.fn()
    setup({ focusFallback })
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog', { name: 'Report a bug' })
    expect(within(dialog).getByLabelText(/^Title/)).toHaveFocus()
    expect(within(dialog).getByLabelText(/^Your name/)).toHaveValue('morgan')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(launcher()).toHaveFocus()
    // What opened it took the focus back: nothing else was asked to.
    expect(focusFallback).not.toHaveBeenCalled()
  })

  // From the Me page the app goes back to the page the report is about, and
  // the row that was pressed is not on that page.
  it('asks where the focus goes when what opened it is gone from the page', async () => {
    const user = userEvent.setup()
    const focusFallback = vi.fn()
    setup({ focusFallback, keepOpener: false })
    await user.click(launcher())
    expect(screen.queryByRole('button', { name: 'Report a bug' })).toBeNull()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(focusFallback).toHaveBeenCalledTimes(1)
  })

  // Nothing had the focus when the dialog opened (a page that had just been
  // drawn): there is nothing to give it back to.
  it('asks the same when nothing had the focus as it opened', () => {
    const focusFallback = vi.fn()
    const onToast = vi.fn()
    const view = render(<main><BugReportHost open={false} onClose={() => {}} onToast={onToast} focusFallback={focusFallback} /></main>)
    expect(document.body).toHaveFocus()
    view.rerender(<main><BugReportHost open onClose={() => {}} onToast={onToast} focusFallback={focusFallback} /></main>)
    expect(within(screen.getByRole('dialog')).getByLabelText(/^Title/)).toHaveFocus()
    view.rerender(<main><BugReportHost open={false} onClose={() => {}} onToast={onToast} focusFallback={focusFallback} /></main>)
    expect(focusFallback).toHaveBeenCalledTimes(1)
  })

  // The dialog is App's to open and close, and nothing else's: it has no
  // launcher of its own, puts nothing on the page while it is closed, and
  // marks nothing on the document for a button that is no longer there.
  it('is nothing on the page while it is closed, and leaves no mark on the document open or closed', () => {
    const onToast = vi.fn()
    const view = render(<BugReportHost open={false} onClose={() => {}} onToast={onToast} />)
    expect(view.container).toBeEmptyDOMElement()
    expect(document.documentElement).not.toHaveAttribute('data-bug-launcher')
    view.rerender(<BugReportHost open onClose={() => {}} onToast={onToast} />)
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument()
    expect(document.documentElement).not.toHaveAttribute('data-bug-launcher')
    expect(screen.queryByRole('button', { name: /^Report (a )?bug$/ })).toBeNull()
  })

  // The server sends the token's health only to a session with admin
  // powers, and App passes it on only to one: with none, nothing is said.
  it('shows the token warning only when the token is known to be failing', async () => {
    const user = userEvent.setup()
    const { view, onToast } = setup()
    await user.click(launcher())
    expect(screen.queryByText(/GitHub token issue/)).toBeNull()
    view.rerender(<Page onToast={onToast} tokenHealthy />)
    expect(screen.queryByText(/GitHub token issue/)).toBeNull()
    view.rerender(<Page onToast={onToast} tokenHealthy={false} tokenHealthReason="GitHub answered 401." />)
    expect(screen.getByText(/GitHub token issue/).closest('[role="alert"]')).toHaveTextContent('Admin notice — GitHub token issue: GitHub answered 401. Nobody can send a bug report until this is resolved.')
  })
})

describe('sending a report', () => {
  it('keeps the focus on Send while the report is out, sends it once, and ends on Done', async () => {
    const user = userEvent.setup()
    let land: (r: BugReportSubmitResult) => void = () => {}
    submitBugReport.mockImplementationOnce(() => new Promise<BugReportSubmitResult>(resolve => { land = resolve }))
    const { onToast } = setup()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog')
    await fill(user, dialog)
    const send = within(dialog).getByRole('button', { name: 'Send report' })
    send.focus()
    await user.keyboard('{Enter}')
    const sending = within(dialog).getByRole('button', { name: 'Sending…' })
    expect(sending).toHaveFocus()
    expect(sending).toHaveAttribute('aria-disabled', 'true')
    expect(sending).not.toBeDisabled()
    // The fields hold what was sent: read-only, and still focusable.
    expect(within(dialog).getByLabelText(/^Title/)).toHaveAttribute('readonly')
    expect(within(dialog).getByLabelText(/^Title/)).not.toBeDisabled()
    await user.keyboard('{Enter}')
    await user.keyboard('{Enter}')
    expect(submitBugReport).toHaveBeenCalledTimes(1)
    expect(submitBugReport.mock.calls[0][0]).toMatchObject({ title: 'Wrong episode opens', description: 'It opened episode 4, not 5.', name: 'morgan' })
    land(SENT)
    const done = await within(dialog).findByRole('button', { name: 'Done' })
    await waitFor(() => expect(done).toHaveFocus())
    expect(dialog).toHaveAccessibleName('Thanks, got it')
    expect(dialog).toHaveTextContent('Reported · #512')
    expect(onToast).toHaveBeenCalledWith('Bug reported as issue #512. Thank you.', 'success')
  })

  // The server has no room for an attachment: the way out is to send without it.
  it('says a report refused for want of attachment room, and how to send it', async () => {
    const user = userEvent.setup()
    submitBugReport.mockRejectedValueOnce(new APIError(507, 'attachment storage is temporarily full — please try again later or submit without an attachment', null))
    setup()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog')
    await fill(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(dialog.querySelector('#bug-error')).toHaveTextContent('The server has no room for the attachment just now. Remove it and send the report again.'))
    expect(dialog.textContent).not.toMatch(/temporarily full/)
  })

  it('says a report that was refused, keeps what was written, and can be sent again', async () => {
    const user = userEvent.setup()
    submitBugReport.mockRejectedValueOnce(new APIError(502, 'GitHub did not accept the report', null))
    const { onToast } = setup()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog')
    await fill(user, dialog)
    const send = within(dialog).getByRole('button', { name: 'Send report' })
    send.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(dialog.querySelector('#bug-error')).toHaveTextContent('Could not send the report just now.'))
    // By attribute as well as by where the focus is: jsdom leaves the focus
    // on a button that becomes disabled, where a browser drops it.
    const again = within(dialog).getByRole('button', { name: 'Send report' })
    expect(again).toHaveFocus()
    expect(again).not.toBeDisabled()
    expect(again).toHaveAttribute('aria-disabled', 'false')
    expect(within(dialog).getByLabelText(/^Title/)).toHaveValue('Wrong episode opens')
    expect(within(dialog).getByLabelText(/^Title/)).not.toHaveAttribute('readonly')
    expect(onToast).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    await within(dialog).findByRole('button', { name: 'Done' })
    expect(submitBugReport).toHaveBeenCalledTimes(2)
  })

  // Two presses before the page has drawn the first one's "Sending…".
  it('sends one report for two presses in the same tick', async () => {
    const user = userEvent.setup()
    submitBugReport.mockReturnValue(new Promise(() => {}))
    setup()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog')
    await fill(user, dialog)
    const send = within(dialog).getByRole('button', { name: 'Send report' })
    // Both inside one act(): nothing is drawn, and no effect runs, between
    // the two presses.
    act(() => { send.click(); send.click() })
    expect(submitBugReport).toHaveBeenCalledTimes(1)
  })

  it('ties a missing title or description to its field, says it again for a second press, and lets go when the field is typed in', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog')
    const title = within(dialog).getByLabelText(/^Title/)
    const description = within(dialog).getByLabelText(/^Description/)
    const alert = dialog.querySelector('#bug-error') as HTMLElement
    expect(alert).toHaveAttribute('role', 'alert')
    const send = within(dialog).getByRole('button', { name: 'Send report' })
    // Spaces only: a field left empty is stopped by the browser's own
    // "fill this in" before the form's check is reached.
    await user.type(title, '   ')
    await user.type(description, 'Something')
    await user.click(send)
    expect(alert).toHaveTextContent('Title is required.')
    expect(alert).not.toHaveAttribute('aria-live')
    expect(title).toHaveAttribute('aria-invalid', 'true')
    expect(title).toHaveAccessibleDescription('Title is required.')
    expect(description).not.toHaveAttribute('aria-invalid', 'true')
    expect(submitBugReport).not.toHaveBeenCalled()
    // The same press gets the same answer aloud. A live region whose text
    // has not changed is not read again, so the words are taken down and
    // put up on the next frame: the very same words, with nothing added.
    act(() => { send.click() })
    expect(alert.textContent).toBe('')
    await waitFor(() => expect(alert.textContent).toBe('Title is required.'))
    expect(title).toHaveAttribute('aria-invalid', 'true')
    await user.type(title, 'Now it has one')
    expect(title).not.toHaveAttribute('aria-invalid', 'true')
    expect(alert).toHaveTextContent('')
    await user.clear(description)
    await user.type(description, '  ')
    await user.click(send)
    expect(alert).toHaveTextContent('Description is required.')
    expect(description).toHaveAttribute('aria-invalid', 'true')
    expect(title).not.toHaveAttribute('aria-invalid', 'true')
    expect(submitBugReport).not.toHaveBeenCalled()
  })

  // A server's refusal is about no one field.
  it('marks no field for a report the server refused', async () => {
    const user = userEvent.setup()
    submitBugReport.mockRejectedValueOnce(new APIError(502, 'GitHub did not accept the report', null))
    setup()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog')
    await fill(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(dialog.querySelector('#bug-error')).toHaveTextContent('Could not send the report just now.'))
    expect(within(dialog).getByLabelText(/^Title/)).not.toHaveAttribute('aria-invalid', 'true')
    expect(within(dialog).getByLabelText(/^Description/)).not.toHaveAttribute('aria-invalid', 'true')
  })

  // The remove button goes with the attachment it removed.
  it('hands the focus to the attach control when an attachment is removed', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog')
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File(['%PDF-1.4 not really'], 'trace.webm', { type: 'video/webm' }))
    const remove = await within(dialog).findByRole('button', { name: 'Remove attachment' })
    remove.focus()
    await user.keyboard('{Enter}')
    expect(within(dialog).queryByRole('button', { name: 'Remove attachment' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Choose file' })).toHaveFocus()
  })

  // Every refusal goes the same way, not only the form's own checks: the
  // same oversize file picked twice is refused aloud twice.
  it('says the same refusal of a file again when the file is picked again', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog')
    const alert = dialog.querySelector('#bug-error') as HTMLElement
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement
    const big = new File(['x'], 'long.webm', { type: 'video/webm' })
    Object.defineProperty(big, 'size', { value: 30 * 1024 * 1024 })
    await user.upload(input, big)
    expect(alert.textContent).toBe('Attachment exceeds 25 MB (got 30.0 MB).')
    // Picked again: the words go and come back, so they are read again.
    act(() => { fireEvent.change(input, { target: { files: [big] } }) })
    expect(alert.textContent).toBe('')
    await waitFor(() => expect(alert.textContent).toBe('Attachment exceeds 25 MB (got 30.0 MB).'))
    expect(within(dialog).queryByRole('button', { name: 'Remove attachment' })).toBeNull()
  })

  // The three ways to attach are a group with a heading, each named by its
  // own words.
  it('names each attach control by what it says', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(launcher())
    const group = within(screen.getByRole('dialog')).getByRole('group', { name: /^Screenshot or recording/ })
    expect(within(group).getAllByRole('button').map(b => b.textContent?.trim())).toEqual(['Choose file', 'Capture this page· PNG', 'Record screen· WebM 30s'])
    expect(within(group).getByRole('button', { name: 'Choose file' })).toBeInTheDocument()
  })
})

// The session changed profile under the open dialog (a switch made in
// another tab). What it holds was the other profile's: a capture of a page,
// a description. It closes, and says why, once nothing is in flight.
describe('a dialog the app dismisses', () => {
  function Held(props: { dismissed: boolean; onClose: () => void; onToast: HostProps['onToast'] }) {
    return <main><BugReportHost open {...props} /></main>
  }

  it('closes at once when it is idle, and says why', () => {
    const onClose = vi.fn()
    const onToast = vi.fn()
    const view = render(<Held dismissed={false} onClose={onClose} onToast={onToast} />)
    expect(onClose).not.toHaveBeenCalled()
    view.rerender(<Held dismissed onClose={onClose} onToast={onToast} />)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onToast).toHaveBeenCalledWith('The bug report was closed because this tab is now on another profile.', 'info')
  })

  it('says nothing of the kind when the person closes it', async () => {
    const user = userEvent.setup()
    const { onToast } = setup()
    await user.click(launcher())
    await user.keyboard('{Escape}')
    expect(onToast).not.toHaveBeenCalled()
  })

  it('lets a send that is under way finish, then closes', async () => {
    const user = userEvent.setup()
    let land: (r: BugReportSubmitResult) => void = () => {}
    submitBugReport.mockImplementationOnce(() => new Promise<BugReportSubmitResult>(resolve => { land = resolve }))
    const onClose = vi.fn()
    const onToast = vi.fn()
    const view = render(<Held dismissed={false} onClose={onClose} onToast={onToast} />)
    const dialog = screen.getByRole('dialog')
    await fill(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    expect(within(dialog).getByRole('button', { name: 'Sending…' })).toBeInTheDocument()
    view.rerender(<Held dismissed onClose={onClose} onToast={onToast} />)
    // Still there, and the request has not been abandoned.
    expect(onClose).not.toHaveBeenCalled()
    expect(submitBugReport).toHaveBeenCalledTimes(1)
    expect((submitBugReport.mock.calls[0][1] as AbortSignal).aborted).toBe(false)
    await act(async () => { land(SENT) })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    // The report was filed, and that is said too.
    expect(onToast).toHaveBeenCalledWith('Bug reported as issue #512. Thank you.', 'success')
  })

  // The refusal would have been shown in the dialog, and the dialog is
  // going in the same pass: without this the person is told only that it
  // closed, and may take the report for filed.
  it('says that the report was not sent when the send it waited for is refused', async () => {
    const user = userEvent.setup()
    let fail: (e: Error) => void = () => {}
    submitBugReport.mockImplementationOnce(() => new Promise<BugReportSubmitResult>((_, reject) => { fail = reject }))
    const onClose = vi.fn()
    const onToast = vi.fn()
    const view = render(<Held dismissed={false} onClose={onClose} onToast={onToast} />)
    const dialog = screen.getByRole('dialog')
    await fill(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    view.rerender(<Held dismissed onClose={onClose} onToast={onToast} />)
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { fail(new APIError(502, 'GitHub did not accept the report', null)) })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onToast).toHaveBeenCalledWith('The bug report was closed because this tab is now on another profile, and the report was not sent: Could not send the report just now.', 'error')
  })

  // A refusal from before the switch counts too, for as long as nothing has
  // been sent since; one that was followed by a report that went does not.
  it('says it of a send that had already been refused, and not once a later one has gone', async () => {
    const user = userEvent.setup()
    submitBugReport.mockRejectedValueOnce(new APIError(502, 'GitHub did not accept the report', null))
    const onClose = vi.fn()
    const onToast = vi.fn()
    const view = render(<Held dismissed={false} onClose={onClose} onToast={onToast} />)
    const dialog = screen.getByRole('dialog')
    await fill(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(dialog.querySelector('#bug-error')).toHaveTextContent('Could not send the report just now.'))
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    await within(dialog).findByRole('button', { name: 'Done' })
    onToast.mockClear()
    view.rerender(<Held dismissed onClose={onClose} onToast={onToast} />)
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onToast).toHaveBeenCalledWith('The bug report was closed because this tab is now on another profile.', 'info')
  })

  // The person closed it; the dialog did not close itself.
  it('says nothing of a dismissal when the person closes the dialog while it waits for a send', async () => {
    const user = userEvent.setup()
    submitBugReport.mockImplementationOnce(() => new Promise<BugReportSubmitResult>(() => {}))
    const onClose = vi.fn()
    const onToast = vi.fn()
    const view = render(<Held dismissed={false} onClose={onClose} onToast={onToast} />)
    const dialog = screen.getByRole('dialog')
    await fill(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    view.rerender(<Held dismissed onClose={onClose} onToast={onToast} />)
    expect(onClose).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onToast).not.toHaveBeenCalled()
  })

  it('stops a recording that is running, then closes', async () => {
    const user = userEvent.setup()
    const stopped = vi.fn()
    // A recorder as the browser's behaves: stop() ends it and reports so.
    class Recorder {
      static isTypeSupported() { return true }
      state = 'inactive'
      ondataavailable: ((e: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start() { this.state = 'recording' }
      stop() { stopped(); this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'], { type: 'video/webm' }) }); this.onstop?.() }
    }
    vi.stubGlobal('MediaRecorder', Recorder)
    const track = { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), kind: 'video' }
    const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] }
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: vi.fn(async () => stream) } })
    try {
      const onClose = vi.fn()
      const onToast = vi.fn()
      const view = render(<Held dismissed={false} onClose={onClose} onToast={onToast} />)
      await user.click(within(screen.getByRole('dialog', { hidden: true })).getByRole('button', { name: /Record screen/ }))
      await screen.findByRole('button', { name: 'Stop screen recording' })
      view.rerender(<Held dismissed onClose={onClose} onToast={onToast} />)
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
      expect(stopped).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
    }
  })
})

// A repeated refusal is taken down and put back a frame later, so that it
// is read out again. In that frame nothing else may be undone by it.
describe('a refusal that is waiting to be said again', () => {
  it('does not come back over a newer refusal, nor on a field that has since been typed in', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog')
    const title = within(dialog).getByLabelText(/^Title/)
    const description = within(dialog).getByLabelText(/^Description/)
    const alert = dialog.querySelector('#bug-error') as HTMLElement
    const send = within(dialog).getByRole('button', { name: 'Send report' })
    await user.type(title, '   ')
    await user.type(description, 'Something')
    await user.click(send)
    expect(alert.textContent).toBe('Title is required.')
    // Pressed again, and the field typed in before the frame comes round.
    act(() => { send.click() })
    expect(alert.textContent).toBe('')
    // The line keeps its height while it waits: the actions do not jump.
    expect(alert.className).not.toMatch(/sr-only/)
    fireEvent.change(title, { target: { value: 'Now it has one' } })
    await new Promise(done => setTimeout(done, 60))
    expect(alert.textContent).toBe('')
    expect(title).not.toHaveAttribute('aria-invalid', 'true')
    expect(alert.className).toMatch(/sr-only/)

    // And a different refusal in that frame is the one that stays.
    fireEvent.change(title, { target: { value: '   ' } })
    await user.click(send)
    expect(alert.textContent).toBe('Title is required.')
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement
    const big = new File(['x'], 'long.webm', { type: 'video/webm' })
    Object.defineProperty(big, 'size', { value: 30 * 1024 * 1024 })
    act(() => { send.click(); fireEvent.change(input, { target: { files: [big] } }) })
    await new Promise(done => setTimeout(done, 60))
    expect(alert.textContent).toBe('Attachment exceeds 25 MB (got 30.0 MB).')
  })
})

