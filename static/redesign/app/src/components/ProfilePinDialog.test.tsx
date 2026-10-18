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

  it('cancels without submitting', async () => {
    const onSubmit = vi.fn(async () => {})
    const onCancel = vi.fn()
    render(<ProfilePinDialog profile={kid} onSubmit={onSubmit} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
