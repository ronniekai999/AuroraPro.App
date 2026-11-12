// @vitest-environment jsdom
//
// The bug report button and its dialog: what opens it, what the dialog says
// to whom, and where the focus is while a report is sent.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BugReportSubmitResult } from '@/lib/api'

const submitBugReport = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), submitBugReport }))

import { BugReportButton } from './BugReportButton'

const SENT: BugReportSubmitResult = { issue_number: 512, issue_url: 'https://example.test/issues/512' } as BugReportSubmitResult

beforeEach(() => { submitBugReport.mockReset().mockResolvedValue(SENT) })

function setup(props: Partial<Parameters<typeof BugReportButton>[0]> = {}) {
  const onToast = vi.fn()
  const onRefreshConfig = vi.fn()
  const view = render(<BugReportButton prefillName="morgan" onToast={onToast} onRefreshConfig={onRefreshConfig} {...props} />)
  return { onToast, onRefreshConfig, view }
}
// As a person finds it: by role and name, in the accessibility tree. A
// button that is `display: none` or hidden from it is not found.
const launcher = () => screen.getByRole('button', { name: 'Report bug' })

async function fill(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.type(within(dialog).getByLabelText(/^Title/), 'Wrong episode opens')
  await user.type(within(dialog).getByLabelText(/^Description/), 'It opened episode 4, not 5.')
}

describe('the bug report button', () => {
  it('opens the dialog with the focus on the title, asks for the config again, and gives the focus back when it closes', async () => {
    const user = userEvent.setup()
    const { onRefreshConfig } = setup()
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog', { name: 'Report a bug' })
    expect(onRefreshConfig).toHaveBeenCalledTimes(1)
    expect(within(dialog).getByLabelText(/^Title/)).toHaveFocus()
    expect(within(dialog).getByLabelText(/^Your name/)).toHaveValue('morgan')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(launcher()).toHaveFocus()
  })

  // Hidden, not unmounted: a recording in flight must outlive a player
  // opening over the page.
  it('stays mounted, with its dialog, while it is hidden', async () => {
    const user = userEvent.setup()
    const { view, onToast } = setup()
    await user.click(launcher())
    expect(launcher().style.display).toBe('')
    view.rerender(<BugReportButton prefillName="morgan" onToast={onToast} hidden />)
    // Out of the accessibility tree, and still in the page. By its title:
    // an element that is not displayed has no accessible name to be found
    // by.
    expect(screen.queryByRole('button', { name: 'Report bug' })).toBeNull()
    expect(screen.getByTitle('Report a bug or share feedback').style.display).toBe('none')
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument()
  })

  // The button floats over the end of the page, and the page leaves room
  // for it there (index.css reads this). For as long as the button is
  // mounted, hidden or not: App hides it under the player and every panel,
  // and taking the room away then shortened the page under whoever was at
  // its end.
  it('tells the page for as long as it is mounted, also while it is hidden, and not once it is gone', () => {
    const { view, onToast } = setup()
    expect(document.documentElement).toHaveAttribute('data-bug-launcher')
    view.rerender(<BugReportButton prefillName="morgan" onToast={onToast} hidden />)
    expect(document.documentElement).toHaveAttribute('data-bug-launcher')
    view.rerender(<BugReportButton prefillName="morgan" onToast={onToast} />)
    expect(document.documentElement).toHaveAttribute('data-bug-launcher')
    view.unmount()
    expect(document.documentElement).not.toHaveAttribute('data-bug-launcher')
  })

  // The server sends the token's health only to a session with admin
  // powers, and App passes it on only to one: with none, nothing is said.
  it('shows the token warning only when the token is known to be failing', async () => {
    const user = userEvent.setup()
    const { view, onToast } = setup()
    await user.click(launcher())
    expect(screen.queryByText(/GitHub token issue/)).toBeNull()
    view.rerender(<BugReportButton prefillName="morgan" onToast={onToast} tokenHealthy />)
    expect(screen.queryByText(/GitHub token issue/)).toBeNull()
    view.rerender(<BugReportButton prefillName="morgan" onToast={onToast} tokenHealthy={false} tokenHealthReason="GitHub answered 401." />)
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

  it('says a report that was refused, keeps what was written, and can be sent again', async () => {
    const user = userEvent.setup()
    submitBugReport.mockRejectedValueOnce(new Error('GitHub did not accept the report'))
    const { onToast } = setup()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog')
    await fill(user, dialog)
    const send = within(dialog).getByRole('button', { name: 'Send report' })
    send.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(dialog.querySelector('#bug-error')).toHaveTextContent('GitHub did not accept the report'))
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
    submitBugReport.mockRejectedValueOnce(new Error('GitHub did not accept the report'))
    setup()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog')
    await fill(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(dialog.querySelector('#bug-error')).toHaveTextContent('GitHub did not accept the report'))
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
