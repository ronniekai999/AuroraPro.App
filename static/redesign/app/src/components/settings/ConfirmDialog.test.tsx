// @vitest-environment jsdom

import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfirmDialog } from './ConfirmDialog'

// A caller as Settings uses it: a button that opens the question, and the
// dialog opened by state.
function Harness({ onConfirm = vi.fn(), onCancel = vi.fn(), removeOpener = false, moveFocus = false }: {
  onConfirm?: () => void
  onCancel?: () => void
  /** The opener goes away when the dialog closes (a Save button that goes
   *  with the choice it saved). */
  removeOpener?: boolean
  /** The caller puts focus somewhere itself after the dialog is confirmed. */
  moveFocus?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [used, setUsed] = useState(false)
  return (
    <div>
      {!(removeOpener && used) && <button type="button" onClick={() => setOpen(true)}>Delete it</button>}
      <button type="button" id="elsewhere">Elsewhere</button>
      <button type="button" id="fallback">Fallback</button>
      <ConfirmDialog
        open={open}
        title="Delete it?"
        confirmLabel="Delete"
        cancelLabel="Keep it"
        destructive
        onCancel={() => { setOpen(false); setUsed(true); onCancel() }}
        onConfirm={() => {
          setOpen(false)
          setUsed(true)
          // As a caller does it: once its write is back, by which time the
          // dialog no longer holds focus inside itself.
          if (moveFocus) void Promise.resolve().then(() => document.getElementById('elsewhere')?.focus())
          onConfirm()
        }}
        fallbackFocus={() => document.getElementById('fallback')}
      >
        It cannot be brought back.
      </ConfirmDialog>
    </div>
  )
}

describe('ConfirmDialog', () => {
  it('is an alert dialog named by its question, described by what happens, with focus on the answer that changes nothing', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Delete it' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete it?' })
    expect(dialog).toHaveAccessibleDescription('It cannot be brought back.')
    expect(within(dialog).getByRole('button', { name: 'Keep it' })).toHaveFocus()
    // Tab stays inside the dialog.
    await user.tab()
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveFocus()
    await user.tab()
    expect(within(dialog).getByRole('button', { name: 'Keep it' })).toHaveFocus()
  })

  it.each([
    ['the cancel button', async (user: ReturnType<typeof userEvent.setup>) => { await user.click(screen.getByRole('button', { name: 'Keep it' })) }],
    ['Escape', async (user: ReturnType<typeof userEvent.setup>) => { await user.keyboard('{Escape}') }],
  ])('cancels on %s, without confirming, and gives focus back to what opened it', async (_how, close) => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<Harness onConfirm={onConfirm} onCancel={onCancel} />)
    await user.click(screen.getByRole('button', { name: 'Delete it' }))
    await close(user)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete it' })).toHaveFocus())
  })

  it('confirms once, without also reporting a cancel, and gives focus back', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<Harness onConfirm={onConfirm} onCancel={onCancel} />)
    await user.click(screen.getByRole('button', { name: 'Delete it' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete it' })).toHaveFocus())
  })

  // The button that opened the dialog can be gone by the time it closes.
  it('sends focus to the caller\'s fallback when what opened it is gone', async () => {
    const user = userEvent.setup()
    render(<Harness removeOpener />)
    await user.click(screen.getByRole('button', { name: 'Delete it' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fallback' })).toHaveFocus())
    expect(screen.queryByRole('button', { name: 'Delete it' })).toBeNull()
  })

  it('leaves focus where the caller put it on purpose', async () => {
    const user = userEvent.setup()
    render(<Harness moveFocus />)
    await user.click(screen.getByRole('button', { name: 'Delete it' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    // Past the dialog's own hand-back, which runs a tick after it closes.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus()
  })

  // A caller that keeps the dialog up while what it confirmed is sent.
  it('takes one confirm while it stays open, and ignores every answer until the request ends', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    function Sending() {
      const [pending, setPending] = useState(false)
      return (
        <ConfirmDialog open pending={pending} title="Delete it?" confirmLabel="Delete" onCancel={onCancel} onConfirm={() => { onConfirm(); setPending(true) }}>
          It cannot be brought back.
        </ConfirmDialog>
      )
    }
    render(<Sending />)
    const confirm = within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    await user.click(confirm)
    await user.click(confirm)
    await user.keyboard('{Escape}')
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })
})
