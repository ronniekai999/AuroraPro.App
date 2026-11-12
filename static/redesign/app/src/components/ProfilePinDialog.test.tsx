// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { APIError } from '@/lib/api'
import { ProfilePinDialog, unlockErrorMessage } from './ProfilePinDialog'

const refusal = (reason: string, status = 403) =>
  new APIError(status, 'server words', { error: { code: status, message: 'server words', reason } })

describe('unlockErrorMessage', () => {
  it('names the mistake for each server reason', () => {
    expect(unlockErrorMessage(refusal('profile_pin_invalid'), 'pin')).toBe('That PIN is not right.')
    expect(unlockErrorMessage(refusal('profile_pin_invalid'), 'password')).toBe('That password is not right.')
    expect(unlockErrorMessage(refusal('profile_pin_locked', 429), 'pin')).toMatch(/15 minutes/)
    expect(unlockErrorMessage(new Error('network down'), 'pin')).toBe('network down')
  })
})

describe('ProfilePinDialog', () => {
  const kid = { name: 'Kid', avatar_url: '' }

  it('submits the PIN as soon as four digits are typed', async () => {
    const onSubmit = vi.fn(async () => {})
    render(<ProfilePinDialog profile={kid} onSubmit={onSubmit} onCancel={vi.fn()} />)
    // fireEvent, not userEvent.type: one change event, so the test does not
    // time out typing key by key on a loaded runner.
    fireEvent.change(screen.getByLabelText('Profile PIN'), { target: { value: '12a34' } })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ pin: '1234' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  // The four boxes are a drawing of the one field: they must show how many
  // digits it holds and never the digits themselves.
  it('draws the one field as four boxes that fill as digits are typed, without showing them', () => {
    render(<ProfilePinDialog profile={kid} onSubmit={vi.fn(() => new Promise<void>(() => {}))} onCancel={vi.fn()} />)
    const cells = () => [...document.querySelectorAll('[data-pin-cell]')].map(c => c.getAttribute('data-pin-cell'))
    expect(cells()).toEqual(['empty', 'empty', 'empty', 'empty'])
    expect(document.querySelectorAll('input')).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Profile PIN'), { target: { value: '47' } })
    expect(cells()).toEqual(['filled', 'filled', 'empty', 'empty'])
    const drawn = document.querySelector('[data-pin-cells]')!.textContent ?? ''
    expect(drawn).not.toMatch(/[0-9]/)
  })

  // The field is invisible, so its caret is too: moved off the end, the next
  // digit would be filed in front of the others and a wrong PIN submitted,
  // spending one of five attempts.
  it('keeps the caret at the end of the invisible field, whatever tries to move it', () => {
    render(<ProfilePinDialog profile={kid} onSubmit={vi.fn(() => new Promise<void>(() => {}))} onCancel={vi.fn()} />)
    const field = screen.getByLabelText('Profile PIN') as HTMLInputElement
    fireEvent.change(field, { target: { value: '12' } })
    for (const move of ['select', 'click', 'keyUp', 'focus'] as const) {
      field.setSelectionRange(0, 0)
      fireEvent[move](field)
      expect([field.selectionStart, field.selectionEnd], move).toEqual([2, 2])
    }
    // The keys that only move a caret are refused outright.
    for (const key of ['ArrowLeft', 'Home', 'ArrowUp']) expect(fireEvent.keyDown(field, { key }), key).toBe(false)
    expect(fireEvent.keyDown(field, { key: '3' })).toBe(true)
    expect(fireEvent.keyDown(field, { key: 'Backspace' })).toBe(true)
  })

  // Select all and type (or paste) is a way of replacing the digits.
  it('leaves a selection of the whole value alone, so typing over it replaces it', () => {
    render(<ProfilePinDialog profile={kid} onSubmit={vi.fn(() => new Promise<void>(() => {}))} onCancel={vi.fn()} />)
    const field = screen.getByLabelText('Profile PIN') as HTMLInputElement
    fireEvent.change(field, { target: { value: '12' } })
    field.setSelectionRange(0, 2)
    for (const after of ['select', 'keyUp'] as const) {
      fireEvent[after](field)
      expect([field.selectionStart, field.selectionEnd], after).toEqual([0, 2])
    }
    // A partial selection, or a caret in the middle, still goes to the end.
    field.setSelectionRange(0, 1)
    fireEvent.select(field)
    expect([field.selectionStart, field.selectionEnd]).toEqual([2, 2])
    // And a modified arrow is the browser's, not this field's to refuse.
    expect(fireEvent.keyDown(field, { key: 'ArrowLeft', altKey: true })).toBe(true)
    expect(fireEvent.keyDown(field, { key: 'ArrowLeft' })).toBe(false)
  })

  it('is a numeric password field: the digits are hidden by the field, not only by its being invisible', () => {
    render(<ProfilePinDialog profile={kid} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    const field = screen.getByLabelText('Profile PIN')
    expect(field).toHaveAttribute('type', 'password')
    expect(field).toHaveAttribute('inputmode', 'numeric')
    expect(field).toHaveAttribute('maxlength', '4')
  })

  // The boxes are the only visible sign of the field. An empty one is drawn
  // by its edge alone; scripts/verify-control-edges.mjs holds that edge to
  // 3:1 against the dialog and the box's own fill, from the token values.
  it('draws an empty box with the edge the contrast check measures, not the hairline', () => {
    render(<ProfilePinDialog profile={kid} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    const empty = [...document.querySelectorAll('[data-pin-cell="empty"]')]
    expect(empty).toHaveLength(4)
    // The first is where the next digit goes and carries the focus edge.
    for (const cell of empty.slice(1)) {
      expect([...cell.classList].filter(c => /^border-[a-z]/.test(c))).toEqual(['border-ink-3'])
    }
  })

  it('shows the refusal and clears the field for another try', async () => {
    const onSubmit = vi.fn(async () => { throw refusal('profile_pin_invalid') })
    render(<ProfilePinDialog profile={kid} onSubmit={onSubmit} onCancel={vi.fn()} />)
    const input = screen.getByLabelText('Profile PIN') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0000' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('That PIN is not right.')
    expect(input.value).toBe('')
  })

  it('sends the account password in password mode', async () => {
    const onSubmit = vi.fn(async () => {})
    render(<ProfilePinDialog profile={kid} onSubmit={onSubmit} onCancel={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /use the account password/i }))
    fireEvent.change(screen.getByLabelText('Account password'), { target: { value: 'hunter2' } })
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ password: 'hunter2' }))
  })

  // The account password unlocks every profile, so a password manager must
  // not fill it in for whoever is at the browser.
  it('does not invite the saved account password', async () => {
    render(<ProfilePinDialog profile={kid} onSubmit={vi.fn(async () => {})} onCancel={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /use the account password/i }))
    const field = screen.getByLabelText('Account password')
    expect(field.getAttribute('autocomplete')).toBe('new-password')
    expect(field.getAttribute('data-1p-ignore')).toBe('true')
    expect(field.getAttribute('data-lpignore')).toBe('true')
  })

  it('keeps password managers off the PIN field too', () => {
    render(<ProfilePinDialog profile={kid} onSubmit={vi.fn(async () => {})} onCancel={vi.fn()} />)
    const field = screen.getByLabelText('Profile PIN')
    expect(field.getAttribute('autocomplete')).toBe('new-password')
    expect(field.getAttribute('data-1p-ignore')).toBe('true')
  })

  it('cancels without submitting', async () => {
    const onSubmit = vi.fn(async () => {})
    const onCancel = vi.fn()
    render(<ProfilePinDialog profile={kid} onSubmit={onSubmit} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
