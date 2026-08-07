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

// The real id App gives ServerPanel, and the one TopNav's trigger points
// `aria-controls` at while it is open. The hook reads it off the panel node to
// recognise the panel's own trigger, so the test must use a real one.
const PANEL_ID = 'stage-server-panel'

/** A panel shaped exactly like ServerPanel/NotificationPanel: unmounted when
 *  closed, opened from a trigger, with an inline onClose from the parent. */
function Harness({ onCloseSpy }: { onCloseSpy?: () => void }) {
  const [open, setOpen] = useState(false)
  const [tick, setTick] = useState(0)
  const close = () => { setOpen(false); onCloseSpy?.() }
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open panel</button>
      {/* Shaped like TopNav's bell/server buttons, which is what issue #445 is
          actually about: a TOGGLE (`setNotifOpen(!notifOpen)`) that publishes
          `aria-controls` only while its panel is open. mousedown precedes
          click, so an outside-click dismissal that doesn't recognise this
          button closes on mousedown and re-opens on the click. */}
      <button
        onClick={() => { if (open) close(); else setOpen(true) }}
        aria-expanded={open}
        aria-controls={open ? PANEL_ID : undefined}
      >
        Toggle panel
      </button>
      {/* Stands in for any unrelated App state change — the hero rotation, a WS
          notification, an unread count. It must NOT disturb the panel. */}
      <button onClick={() => setTick(t => t + 1)}>Unrelated re-render {tick}</button>
      {/* Inert page content behind the panel. Not focusable, on purpose: that is
          the case where the browser drops focus to <body> on mousedown, and so
          the case where a careless restore yanks a focus ring onto the trigger. */}
      <div data-testid="page-background">Background content</div>
      {open && <Panel onClose={close} />}
    </div>
  )
}

function Panel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  usePanelDismiss(true, onClose, ref)
  return (
    <div id={PANEL_ID} ref={ref} role="dialog" aria-label="Server status" tabIndex={-1}>
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

  // ── Issue #445: clicking elsewhere on the page never dismissed these panels.
  // The hook shipped with Escape-while-focused and focus restore only, so the X
  // button was the sole pointer route out.

  it('closes when a mousedown lands outside the panel', async () => {
    const user = userEvent.setup()
    const onCloseSpy = vi.fn()
    render(<Harness onCloseSpy={onCloseSpy} />)
    await user.click(screen.getByRole('button', { name: 'Open panel' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())

    await user.click(screen.getByTestId('page-background'))

    expect(onCloseSpy).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does NOT restore focus to the trigger on an outside-click dismissal', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open panel' })
    await user.click(trigger)
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())

    // A pointer dismissal on inert background lands in exactly the `focusLost`
    // branch the close-path restore relies on (the panel is torn out from under
    // the focused element), so without a guard it flings a focus ring onto a
    // trigger the user was walking away from — the policy ProfileSwitcher's
    // handler already spells out. It is not merely cosmetic: any outside target
    // that preventDefaults mousedown to keep focus put, as SearchPalette's
    // options do, has that focus stolen by the restore.
    //
    // `fireEvent`, not `user.click`: user-event also runs the browser's own
    // post-mousedown focus behaviour (blur to <body> when the target isn't
    // focusable), which lands on the same end state and so masks a wrong restore
    // completely — this assertion SURVIVED removing the guard when written that
    // way. The bare mousedown leaves whatever focus the hook moves in place.
    fireEvent.mouseDown(screen.getByTestId('page-background'))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).not.toHaveFocus()
    expect(document.activeElement).toBe(document.body)
  })

  it('ignores a mousedown INSIDE the panel', async () => {
    const user = userEvent.setup()
    const onCloseSpy = vi.fn()
    render(<Harness onCloseSpy={onCloseSpy} />)
    await user.click(screen.getByRole('button', { name: 'Open panel' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(onCloseSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('ignores a mousedown on the trigger that OWNS the panel, so the toggle does not flicker', async () => {
    const user = userEvent.setup()
    const onCloseSpy = vi.fn()
    render(<Harness onCloseSpy={onCloseSpy} />)
    const toggle = screen.getByRole('button', { name: 'Toggle panel' })
    await user.click(toggle)
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())
    // The wiring the hook keys off — no extra ref threaded down from App.
    expect(toggle).toHaveAttribute('aria-controls', PANEL_ID)

    // mousedown alone must not dismiss...
    fireEvent.mouseDown(toggle)
    expect(onCloseSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // ...so that a whole click closes it ONCE and leaves it closed. Without the
    // owner guard this closes on mousedown and the click that follows re-opens
    // it, which looks to the user like the dismissal never worked at all.
    await user.click(toggle)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onCloseSpy).toHaveBeenCalledTimes(1)
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
