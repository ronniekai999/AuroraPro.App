// @vitest-environment jsdom
//
// The bug report button and its dialog: what opens it, what the dialog says
// to whom, and where the focus is while a report is sent.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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
const launcher = () => screen.getByRole('button', { name: 'Report bug', hidden: true })
// The button's inline `bottom` is a calc() over a custom property, which
// jsdom's computed style cannot resolve; the pointer-events check that reads
// it is skipped (nothing here is about pointer-events).
const POINTER = { pointerEventsCheck: 0 } as const

async function fill(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.type(within(dialog).getByLabelText(/^Title/), 'Wrong episode opens')
  await user.type(within(dialog).getByLabelText(/^Description/), 'It opened episode 4, not 5.')
}

describe('the bug report button', () => {
  it('opens the dialog with the focus on the title, asks for the config again, and gives the focus back when it closes', async () => {
    const user = userEvent.setup(POINTER)
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
    const user = userEvent.setup(POINTER)
    const { view, onToast } = setup()
    await user.click(launcher())
    view.rerender(<BugReportButton prefillName="morgan" onToast={onToast} hidden />)
    // By title and by selector: jsdom cannot compute the hidden button's
    // style, which a query by role and name needs.
    expect(screen.getByTitle('Report a bug or share feedback').style.display).toBe('none')
    expect(document.querySelector('[role="dialog"]')).toHaveTextContent('Report a bug')
  })

  // The server sends the token's health only to a session with admin
  // powers, and App passes it on only to one: with none, nothing is said.
  it('shows the token warning only when the token is known to be failing', async () => {
    const user = userEvent.setup(POINTER)
    const { view, onToast } = setup()
    await user.click(launcher())
    expect(screen.queryByText(/GitHub token issue/)).toBeNull()
    view.rerender(<BugReportButton prefillName="morgan" onToast={onToast} tokenHealthy />)
    expect(screen.queryByText(/GitHub token issue/)).toBeNull()
    view.rerender(<BugReportButton prefillName="morgan" onToast={onToast} tokenHealthy={false} tokenHealthReason="GitHub answered 401." />)
    expect(screen.getByRole('alert')).toHaveTextContent('Admin notice — GitHub token issue: GitHub answered 401.')
  })
})

describe('sending a report', () => {
  it('keeps the focus on Send while the report is out, sends it once, and ends on Done', async () => {
    const user = userEvent.setup(POINTER)
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
    const user = userEvent.setup(POINTER)
    submitBugReport.mockRejectedValueOnce(new Error('GitHub did not accept the report'))
    const { onToast } = setup()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog')
    await fill(user, dialog)
    const send = within(dialog).getByRole('button', { name: 'Send report' })
    send.focus()
    await user.keyboard('{Enter}')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('GitHub did not accept the report')
    expect(within(dialog).getByRole('button', { name: 'Send report' })).toHaveFocus()
    expect(within(dialog).getByLabelText(/^Title/)).toHaveValue('Wrong episode opens')
    expect(within(dialog).getByLabelText(/^Title/)).not.toHaveAttribute('readonly')
    expect(onToast).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    await within(dialog).findByRole('button', { name: 'Done' })
    expect(submitBugReport).toHaveBeenCalledTimes(2)
  })

  it('sends nothing without a title and a description', async () => {
    const user = userEvent.setup(POINTER)
    setup()
    await user.click(launcher())
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/^Title/), '   ')
    await user.type(within(dialog).getByLabelText(/^Description/), 'Something')
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Title is required.')
    expect(submitBugReport).not.toHaveBeenCalled()
  })
})
