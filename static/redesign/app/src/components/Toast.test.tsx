// @vitest-environment jsdom
//
// A toast: a row of words, with at most one thing to press beside
// dismissing it. One with an action (Undo) stays long enough to reach it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToastContainer, type Toast } from './Toast'

const onRemove = vi.fn()
const show = (...toasts: Toast[]) => render(<ToastContainer toasts={toasts} onRemove={onRemove} />)
const after = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

describe('a toast', () => {
  it('says its message as a status, and goes after three seconds or when dismissed', async () => {
    show({ id: 'a', message: 'Saved Kestrel to My Library.', type: 'success' })
    expect(screen.getByRole('status').textContent).toBe('Saved Kestrel to My Library.')
    // Only the message is the live region: its button is not read out with it.
    expect(screen.getByRole('status').querySelector('button')).toBeNull()
    await after(2999)
    expect(onRemove).not.toHaveBeenCalled()
    // It leaves (an exit plays), then asks to be removed.
    await after(1 + 220)
    expect(onRemove).toHaveBeenCalledWith('a')
    cleanup(); onRemove.mockClear()
    show({ id: 'b', message: 'Request deleted', type: 'info' })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    await after(220)
    expect(onRemove).toHaveBeenCalledWith('b')
  })

  it('marks an error, and only an error, and says it as an alert', () => {
    show({ id: 'e', message: 'Could not save Kestrel', type: 'error' }, { id: 'i', message: 'Request deleted', type: 'info' })
    expect(screen.getByRole('alert').textContent).toBe('Could not save Kestrel')
    expect(document.querySelectorAll('.toast-mark')).toHaveLength(1)
    expect(screen.getByRole('alert').closest('.toast')!.querySelector('.toast-mark')).not.toBeNull()
  })

  it('with an action offers it in place of the dismiss button, stays seven seconds, and goes when the action is pressed', async () => {
    const run = vi.fn()
    show({ id: 'u', message: 'Removed Kestrel from My Library.', type: 'info', action: { label: 'Undo', run } })
    expect(screen.queryByRole('button', { name: 'Dismiss notification' })).toBeNull()
    await after(6999)
    expect(onRemove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(run).toHaveBeenCalledTimes(1)
    await after(220)
    expect(onRemove).toHaveBeenCalledWith('u')
    cleanup(); onRemove.mockClear()
    // Left alone, it goes by itself at seven.
    show({ id: 'v', message: 'Removed Kestrel from My Library.', type: 'info', action: { label: 'Undo', run } })
    await after(7000 + 220)
    expect(onRemove).toHaveBeenCalledWith('v')
  })

  it('waits while the pointer or the focus is on it', async () => {
    show({ id: 'p', message: 'Request deleted', type: 'info' })
    const toast = document.querySelector('.toast')!
    fireEvent.mouseEnter(toast)
    await after(10_000)
    expect(onRemove).not.toHaveBeenCalled()
    fireEvent.mouseLeave(toast)
    await after(3000 + 220)
    expect(onRemove).toHaveBeenCalledWith('p')
  })

  // One flag for both: the pointer leaving restarted the timer under a
  // viewer whose focus was still on Undo.
  it('goes on waiting for the focus when the pointer leaves, and for the pointer when the focus does', async () => {
    const run = vi.fn()
    show({ id: 'f', message: 'Removed Kestrel from My Library.', type: 'info', action: { label: 'Undo', run } })
    const toast = document.querySelector('.toast')!
    const undo = screen.getByRole('button', { name: 'Undo' })
    fireEvent.mouseEnter(toast)
    fireEvent.focus(undo)
    fireEvent.mouseLeave(toast)
    await after(20_000)
    expect(onRemove).not.toHaveBeenCalled()
    fireEvent.mouseEnter(toast)
    fireEvent.blur(undo)
    await after(20_000)
    expect(onRemove).not.toHaveBeenCalled()
    fireEvent.mouseLeave(toast)
    await after(7000 + 220)
    expect(onRemove).toHaveBeenCalledWith('f')
  })

  // The toast is still on the page while it leaves (220ms), its button with
  // it: a second Enter there ran the action again.
  it('takes its action once, however often it is pressed while the toast leaves', async () => {
    const run = vi.fn()
    show({ id: 'o', message: 'Removed Kestrel from My Library.', type: 'info', action: { label: 'Undo', run } })
    const undo = screen.getByRole('button', { name: 'Undo' })
    fireEvent.click(undo)
    fireEvent.click(undo)
    await after(100)
    fireEvent.click(undo)
    expect(run).toHaveBeenCalledTimes(1)
    await after(220)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('sits in the stack that is kept out of a bug report\'s capture', () => {
    show({ id: 'a', message: 'Request deleted', type: 'info' })
    const stack = document.querySelector('.toast-stack')!
    expect(stack.getAttribute('data-screenshot-exclude')).toBe('true')
    expect(stack.querySelector('.toast')).not.toBeNull()
  })
})
