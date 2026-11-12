// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { APIError, WRONG_CURRENT_PASSWORD, type Profile, type User } from '@/lib/api'
import { AccountPane, SignInMethodsCard, passwordErrorMessage } from './AccountPane'

const api = vi.hoisted(() => ({ listOAuthLinks: vi.fn(), unlinkOAuth: vi.fn(), startOAuthLink: vi.fn(), changePassword: vi.fn() }))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

const profile = (extra: Partial<Profile> = {}): Profile => ({
  id: 1, user_id: 1, name: 'p', is_default: true, created_at: '', updated_at: '', ...extra,
})

describe('SignInMethodsCard', () => {
  beforeEach(() => { api.listOAuthLinks.mockReset().mockResolvedValue({ linked: [], available: [], hasPassword: true, canUnlinkAny: false }) })

  // A fresh sign-in through a link a kid added would land on the account
  // default without its PIN; the server refuses, and the card is not offered.
  it('offers a restricted session a note, not the sign-in methods', () => {
    render(<SignInMethodsCard activeProfile={profile({ max_age_rating: 'PG' })} profileKnown />)
    expect(screen.getByText(/can only be managed from a profile without a content limit/)).toBeTruthy()
    expect(api.listOAuthLinks).not.toHaveBeenCalled()
  })

  it('shows an unrestricted session its sign-in methods', async () => {
    render(<SignInMethodsCard activeProfile={profile()} profileKnown />)
    await waitFor(() => expect(api.listOAuthLinks).toHaveBeenCalled())
    expect(screen.queryByText(/can only be managed from a profile without a content limit/)).toBeNull()
  })

  // The startup profile list failed: the session could be a kid's.
  it('treats a session whose profile is unknown as restricted', () => {
    render(<SignInMethodsCard activeProfile={null} profileKnown={false} />)
    expect(screen.getByText(/can only be managed from a profile without a content limit/)).toBeTruthy()
    expect(api.listOAuthLinks).not.toHaveBeenCalled()
  })

  it('shows an account with no profile at all its sign-in methods', async () => {
    render(<SignInMethodsCard activeProfile={null} profileKnown />)
    await waitFor(() => expect(api.listOAuthLinks).toHaveBeenCalled())
  })
})

const USER: User = { id: 1, username: 'morgan', email: 'm@example.test', role: 'admin' }
const NOW = '2026-11-01T00:00:00Z'

describe('AccountPane', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    api.listOAuthLinks.mockResolvedValue({ linked: [{ provider: 'google', linkedAt: NOW }], available: ['discord'], hasPassword: true, canUnlinkAny: true })
    api.unlinkOAuth.mockResolvedValue(undefined)
    api.changePassword.mockResolvedValue(undefined)
  })

  // The server's logout ends every session on the account. The control must
  // never read as signing out one device: that does not exist.
  it('says that signing out signs out every device, and nothing about one device only', () => {
    const onLogout = vi.fn()
    render(<AccountPane user={USER} activeProfile={profile()} profileKnown onLogout={onLogout} />)
    const region = screen.getByRole('region', { name: 'Sign out' })
    expect(region).toHaveTextContent('Signs out every device on this account, this one included.')
    expect(document.body.textContent).not.toMatch(/on this device|this browser only|other devices stay/i)
    fireEvent.click(within(region).getByRole('button', { name: 'Sign out' }))
    expect(onLogout).toHaveBeenCalledTimes(1)
  })

  it('names the account and its role', () => {
    render(<AccountPane user={USER} activeProfile={profile()} profileKnown />)
    expect(screen.getByText('morgan')).toBeInTheDocument()
    expect(screen.getByText('Admin of this server')).toBeInTheDocument()
  })

  it('changes the password with the current one, says first that every device is signed out, then signs out', async () => {
    const onLogout = vi.fn()
    render(<AccountPane user={USER} activeProfile={profile()} profileKnown onLogout={onLogout} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change password' }))
    const form = screen.getByRole('form', { name: 'Change the password' })
    expect(form).toHaveTextContent('Signs out every device on this account, this one included. You sign in again with the new password.')
    const submit = within(form).getByRole('button', { name: 'Change password' })
    fireEvent.change(within(form).getByLabelText('Current password'), { target: { value: 'old secret' } })
    fireEvent.change(within(form).getByLabelText('New password'), { target: { value: 'short' } })
    // The server wants eight characters; fewer is not sent.
    expect(submit).toBeDisabled()
    expect(within(form).getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(within(form).getByLabelText('New password'), { target: { value: 'a longer secret' } })
    fireEvent.click(submit)
    await waitFor(() => expect(api.changePassword).toHaveBeenCalledWith('old secret', 'a longer secret'))
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1))
  })

  it('says a wrong current password plainly, stays signed in, and keeps the form', async () => {
    const onLogout = vi.fn()
    api.changePassword.mockRejectedValue(new APIError(401, WRONG_CURRENT_PASSWORD, null))
    render(<AccountPane user={USER} activeProfile={profile()} profileKnown onLogout={onLogout} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change password' }))
    const form = screen.getByRole('form', { name: 'Change the password' })
    fireEvent.change(within(form).getByLabelText('Current password'), { target: { value: 'wrong' } })
    fireEvent.change(within(form).getByLabelText('New password'), { target: { value: 'a longer secret' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Change password' }))
    expect(await within(form).findByText('That is not the current password.')).toHaveAttribute('role', 'alert')
    expect(onLogout).not.toHaveBeenCalled()
    expect(within(form).getByRole('button', { name: 'Change password' })).toBeEnabled()
  })

  it('words the other refusals of a password change', () => {
    expect(passwordErrorMessage(new APIError(429, 'rate limit exceeded, try again later', null))).toBe('Too many attempts. Wait a minute, then try again.')
    expect(passwordErrorMessage(new APIError(400, 'new password must be at least 8 characters', null))).toBe('new password must be at least 8 characters')
    expect(passwordErrorMessage(new APIError(401, 'server words', { error: { code: 401, message: 'server words', reason: 'session_ended' } }))).toMatch(/signed out/)
    expect(passwordErrorMessage(new TypeError(''))).toBe('The password could not be changed. Try again.')
  })

  // An account that signs in only through a linked account has no password
  // to change, and the server has no route that sets a first one.
  it('offers no password form to an account without a password, and says what that means', async () => {
    api.listOAuthLinks.mockResolvedValue({ linked: [{ provider: 'google', linkedAt: NOW }], available: [], hasPassword: false, canUnlinkAny: false })
    render(<AccountPane user={USER} activeProfile={profile()} profileKnown />)
    expect(await screen.findByText(/This account has no password\. It signs in through a linked account/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull()
    // Its only way in cannot be disconnected, and the row says why.
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled()
    expect(screen.getByText(/It is the only way to sign in to this account/)).toBeInTheDocument()
  })

  // The password is the key to every profile, so its form goes with the
  // sign-in methods: not offered to a session with a content limit.
  it('offers a restricted session no password form', () => {
    render(<AccountPane user={USER} activeProfile={profile({ max_age_rating: 'PG' })} profileKnown onLogout={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull()
    expect(screen.getByText(/can only be managed from a profile without a content limit/)).toBeInTheDocument()
    expect(api.listOAuthLinks).not.toHaveBeenCalled()
    // Signing out is still there.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('disconnects a linked account only on a second press, and connects one on the first', async () => {
    render(<AccountPane user={USER} activeProfile={profile()} profileKnown />)
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    expect(api.unlinkOAuth).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(api.unlinkOAuth).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google' }))
    await waitFor(() => expect(api.unlinkOAuth).toHaveBeenCalledWith('google'))
    api.startOAuthLink.mockReturnValue(new Promise(() => {}))
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    expect(api.startOAuthLink).toHaveBeenCalledWith('discord')
  })
})
