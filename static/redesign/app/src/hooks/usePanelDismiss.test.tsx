// @vitest-environment jsdom
//
// The hook TWO independent reviewers found broken in the same pass, in a PR whose
// whole thesis was that untested code is broken code. It shipped with no test.
//
// Both of its bugs are asserted here, and both were inverted in the same way — the
// path that was supposed to work never ran, and the path that was supposed to stay
// quiet ran constantly:
//
//   1. Focus was NEVER restored on close. Both panels are `if (!open) return null`,
//      so React detaches the host ref during the mutation phase and `ref.current`
//      is already null when the passive cleanup reads it. The restore guard
//      short-circuited on `undefined` every single time and focus fell to <body>.
//   2. Focus WAS stolen on every unrelated parent render, because the effect
//      depended on an inline `onClose`. There the cleanup ran while focus was
//      still inside the panel, so the restore fired — the one case it worked was
//      the one where it was wrong. App rotates the home hero every 9 seconds, so
//      opening a panel from Home looped it.

import { describe, expect, it, vi } from 'vitest'
import { useRef, useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { usePanelDismiss } from './usePanelDismiss'

/** A panel shaped exactly like ServerPanel/NotificationPanel: unmounted when
 *  closed, opened from a trigger, with an inline onClose from the parent. */
function Harness({ onCloseSpy }: { onCloseSpy?: () => void }) {
  const [open, setOpen] = useState(false)
  const [tick, setTick] = useState(0)
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open panel</button>
      {/* Stands in for any unrelated App state change — the hero rotation, a WS
          notification, an unread count. It must NOT disturb the panel. */}
      <button onClick={() => setTick(t => t + 1)}>Unrelated re-render {tick}</button>
      {open && (
        <Panel onClose={() => { setOpen(false); onCloseSpy?.() }} />
      )}
    </div>
  )
}

function Panel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  usePanelDismiss(true, onClose, ref)
  return (
    <div ref={ref} role="dialog" aria-label="Server status" tabIndex={-1}>
      <button onClick={onClose}>Close</button>
      <button>Refresh</button>
    </div>
  )
}

describe('usePanelDismiss', () => {
  it('moves focus to the panel container on open', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open panel' }))
    // The CONTAINER, not the first control: the first control is Close, and
    // landing there announces "Close" as the panel's opening word.
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())
  })

  it('RESTORES focus to the trigger when the panel closes', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open panel' })
    await user.click(trigger)
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Close' }))

    // The bug: `ref.current` was already null in the cleanup, so this never
    // happened and focus fell to <body> on every close path.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
    expect(trigger).toHaveFocus()
  })

  it('does NOT disturb focus when the parent re-renders for unrelated reasons', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open panel' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())

    // Park focus somewhere inside the panel, as a user would.
    const refresh = screen.getByRole('button', { name: 'Refresh' })
    refresh.focus()
    expect(refresh).toHaveFocus()

    // Three unrelated parent state changes. With `onClose` in the deps this tore
    // the effect down and back up each time, yanking focus to the trigger and
    // then dragging it back to the container — destroying the user's position
    // and visiting an element OUTSIDE the dialog in between.
    //
    // `fireEvent`, not `user.click`: user-event focuses what it clicks, so driving
    // the re-render through it moved focus itself and then the test re-focused
    // `refresh` afterwards — which masked the theft completely. Putting `onClose`
    // back in the deps SURVIVED that version. fireEvent dispatches the click
    // without touching focus, so `refresh` stays focused across the re-render and
    // any steal is visible.
    const bump = screen.getByRole('button', { name: /Unrelated re-render/ })
    for (let i = 0; i < 3; i++) {
      fireEvent.click(bump)
      await waitFor(() => expect(bump).toHaveTextContent(String(i + 1)))
    }

    expect(refresh).toHaveFocus()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes on Escape when the panel owns focus', async () => {
    const user = userEvent.setup()
    const onCloseSpy = vi.fn()
    render(<Harness onCloseSpy={onCloseSpy} />)
    await user.click(screen.getByRole('button', { name: 'Open panel' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())

    await user.keyboard('{Escape}')
    expect(onCloseSpy).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ignores Escape when focus is NOT inside the panel', async () => {
    const user = userEvent.setup()
    const onCloseSpy = vi.fn()
    render(<Harness onCloseSpy={onCloseSpy} />)
    await user.click(screen.getByRole('button', { name: 'Open panel' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())

    // These panels are NON-MODAL by design — the nav behind them stays clickable
    // (BUG-005) — so several Escape handlers are live at once. Swallowing every
    // Escape from a panel that merely happens to be open in the background is the
    // bug ContextMenu's stopPropagation fixed from the other direction.
    screen.getByRole('button', { name: 'Open panel' }).focus()
    await user.keyboard('{Escape}')

    expect(onCloseSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('stops Escape from reaching the window when it does act', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open panel' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())

    // App's window-level Escape handler guards only on `paletteOpen`, so a leak
    // here reaches `view === 'detail' && handleBack()` — dismissing the panel AND
    // navigating off the title.
    const windowSpy = vi.fn()
    window.addEventListener('keydown', windowSpy)
    try {
      await user.keyboard('{Escape}')
      const escapes = windowSpy.mock.calls.filter(c => (c[0] as KeyboardEvent).key === 'Escape')
      expect(escapes).toHaveLength(0)
    } finally {
      window.removeEventListener('keydown', windowSpy)
    }
  })
})
