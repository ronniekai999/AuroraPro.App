// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { APIError, WRONG_CURRENT_PASSWORD, type Profile, type User } from '@/lib/api'
import { AccountPane, SignInMethodsCard, passwordBytes, passwordErrorMessage } from './AccountPane'

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

  // A list that could not be read is said in the app's words.
  it('says the sign-in methods could not be loaded, not what the server said', async () => {
    api.listOAuthLinks.mockReset().mockRejectedValue(new APIError(500, 'pq: connection refused', null))
    render(<AccountPane user={USER} activeProfile={profile()} profileKnown onLogout={vi.fn()} />)
    expect(await screen.findByText('Could not load the sign-in methods just now.')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/pq:/)
  })

  // The server's logout ends every session on the account. The control must
  // never read as signing out one device: that does not exist. And since it
  // reaches every device, one press is not enough.
  it('says that signing out signs out every device, and asks before doing it', async () => {
    const user = userEvent.setup()
    const onLogout = vi.fn()
    render(<AccountPane user={USER} activeProfile={profile()} profileKnown onLogout={onLogout} />)
    const region = screen.getByRole('region', { name: 'Sign out' })
    expect(region).toHaveTextContent('Signs out every device on this account, this one included.')
    expect(document.body.textContent).not.toMatch(/on this device|this browser only|other devices stay/i)
    const signOut = within(region).getByRole('button', { name: 'Sign out' })
    await user.click(signOut)
    expect(onLogout).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByRole('heading', { name: 'Sign out of every device?' })).toBeInTheDocument()
    expect(dialog).toHaveTextContent('This signs out every device on this account: this one, and every other browser, phone and TV that is signed in.')
    // Focus is on the answer that changes nothing; Escape gives it, and
    // focus goes back to the button.
    expect(within(dialog).getByRole('button', { name: 'Stay signed in' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(onLogout).not.toHaveBeenCalled()
    await waitFor(() => expect(signOut).toHaveFocus())

    await user.click(signOut)
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Sign out everywhere' }))
    expect(onLogout).toHaveBeenCalledTimes(1)
  })

  // A link straight to this page arrives before the app knows the session's
  // profile; "can only be managed from…" would be wrong for a parent.
  it('says the sign-in methods are loading until the app has settled which profile the session acts as', async () => {
    const view = render(<AccountPane user={USER} activeProfile={null} profileKnown={false} profileSettled={false} />)
    expect(within(screen.getByRole('region', { name: 'Sign-in methods' })).getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText(/can only be managed from a profile without a content limit/)).toBeNull()
    expect(api.listOAuthLinks).not.toHaveBeenCalled()
    view.rerender(<AccountPane user={USER} activeProfile={profile()} profileKnown profileSettled />)
    expect(await screen.findByRole('button', { name: 'Change password' })).toBeInTheDocument()
  })

  it('names the account and its role', () => {
    render(<AccountPane user={USER} activeProfile={profile()} profileKnown />)
    expect(screen.getByText('morgan')).toBeInTheDocument()
    expect(screen.getByText('Admin of this server')).toBeInTheDocument()
  })

  it('changes the password with the current one, says first that every device is signed out, and says it worked before leaving', async () => {
    const onLogout = vi.fn()
    render(<AccountPane user={USER} activeProfile={profile()} profileKnown onLogout={onLogout} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change password' }))
    const form = screen.getByRole('form', { name: 'Change the password' })
    expect(form).toHaveTextContent('Signs out every device on this account, this one included. You sign in again with the new password.')
    // Focus goes to the first field, not nowhere with the button that left.
    expect(within(form).getByLabelText('Current password')).toHaveFocus()
    // A password manager is told whose password this is.
    const who = form.querySelector('input[autocomplete="username"]') as HTMLInputElement
    expect(who.value).toBe('morgan')
    expect(who.hidden).toBe(true)
    expect(within(form).getByLabelText('Current password')).toHaveAttribute('autocomplete', 'current-password')
    expect(within(form).getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password')
    const submit = within(form).getByRole('button', { name: 'Change password' })
    fireEvent.change(within(form).getByLabelText('Current password'), { target: { value: 'old secret' } })
    fireEvent.change(within(form).getByLabelText('New password'), { target: { value: 'short' } })
    // The server wants eight characters; fewer is not sent.
    expect(submit).toBeDisabled()
    expect(within(form).getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(within(form).getByLabelText('New password'), { target: { value: 'a longer secret' } })
    fireEvent.click(submit)
    await waitFor(() => expect(api.changePassword).toHaveBeenCalledWith('old secret', 'a longer secret'))
    // The page says the change took, and leaves only when asked: the app
    // going straight to the sign-in page read as the change having failed.
    const done = await screen.findByRole('status')
    expect(done).toHaveTextContent('The password is changed.')
    // The form that had the focus is gone; what replaced it has it.
    expect(done).toHaveFocus()
    expect(done).toHaveTextContent('Every device on this account has been signed out, this one included. Sign in again with the new password.')
    await act(async () => {})
    expect(onLogout).not.toHaveBeenCalled()
    fireEvent.click(within(done).getByRole('button', { name: 'Sign in again' }))
    expect(onLogout).toHaveBeenCalledTimes(1)
  })

  // The server counts a password's bytes, 8 to 128.
  it('counts a new password the way the server does, in bytes', async () => {
    expect(passwordBytes('pässword')).toBe(9)
    render(<AccountPane user={USER} activeProfile={profile()} profileKnown onLogout={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change password' }))
    const form = screen.getByRole('form', { name: 'Change the password' })
    const submit = within(form).getByRole('button', { name: 'Change password' })
    fireEvent.change(within(form).getByLabelText('Current password'), { target: { value: 'old secret' } })
    // Four characters, eight bytes: long enough for the server.
    fireEvent.change(within(form).getByLabelText('New password'), { target: { value: 'éééé' } })
    expect(submit).toBeEnabled()
    // 65 characters, 130 bytes: the server would refuse it.
    fireEvent.change(within(form).getByLabelText('New password'), { target: { value: 'é'.repeat(65) } })
    expect(submit).toBeDisabled()
    expect(within(form).getByText('That is too long for a password here. Shorten it.')).toBeInTheDocument()
    fireEvent.change(within(form).getByLabelText('New password'), { target: { value: 'é'.repeat(64) } })
    expect(submit).toBeEnabled()
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
    // Focus is on the field to correct.
    await waitFor(() => expect(within(form).getByLabelText('Current password')).toHaveFocus())
    // Cancel closes the form and hands focus back to the button that opened it.
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Change the password' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Change password' })).toHaveFocus()
  })

  it('words the other refusals of a password change', () => {
    expect(passwordErrorMessage(new APIError(429, 'rate limit exceeded, try again later', null))).toBe('Too many attempts. Wait a minute, then try again.')
    // The server's words are for a log; the form checks the length itself.
    expect(passwordErrorMessage(new APIError(400, 'new password must be at least 8 characters', null))).toBe('Could not change the password.')
    // A 500 can follow a change that went through: it is not said to have failed.
    expect(passwordErrorMessage(new APIError(500, 'password updated but session revocation failed; contact admin', null))).toBe('Something went wrong on the server, and the password may or may not have changed.')
    expect(passwordErrorMessage(new APIError(401, 'server words', { error: { code: 401, message: 'server words', reason: 'session_ended' } }))).toMatch(/signed out/)
    expect(passwordErrorMessage(new TypeError(''))).toBe('Could not change the password just now.')
  })

  // An account that signs in only through a linked account has no password
  // to change, and the server has no route that sets a first one.
  it('offers no password form to an account without a password, and says what that means', async () => {
    api.listOAuthLinks.mockResolvedValue({ linked: [{ provider: 'google', linkedAt: NOW }], available: [], hasPassword: false, canUnlinkAny: false })
    render(<AccountPane user={USER} activeProfile={profile()} profileKnown />)
    expect(await screen.findByText(/This account has no password\. It signs in through a linked account/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull()
    // Its only way in cannot be disconnected, and the row says why.
    expect(screen.getByRole('button', { name: 'Disconnect Google' })).toBeDisabled()
    expect(screen.getByText(/It is the only way to sign in to this account/)).toBeInTheDocument()
  })

  // The password is the key to every profile, so its form goes with the
  // sign-in methods: not offered to a session with a content limit.
  it('offers a restricted session no password form, and does not tell it what the password unlocks', async () => {
    const view = render(<AccountPane user={USER} activeProfile={profile({ max_age_rating: 'PG' })} profileKnown onLogout={vi.fn()} />)
    expect(screen.queryByText(/account password also unlocks every profile/)).toBeNull()
    view.rerender(<AccountPane user={USER} activeProfile={profile()} profileKnown onLogout={vi.fn()} />)
    expect(screen.getByText(/account password also unlocks every profile/)).toBeInTheDocument()
    await screen.findByRole('button', { name: 'Change password' })
    // Nor a session whose profile is not known.
    view.rerender(<AccountPane user={USER} activeProfile={null} profileKnown={false} onLogout={vi.fn()} />)
    expect(screen.queryByText(/account password also unlocks every profile/)).toBeNull()
    view.rerender(<AccountPane user={USER} activeProfile={profile({ max_age_rating: 'PG' })} profileKnown onLogout={vi.fn()} />)
    api.listOAuthLinks.mockClear()
    expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull()
    expect(screen.getByText(/can only be managed from a profile without a content limit/)).toBeInTheDocument()
    expect(api.listOAuthLinks).not.toHaveBeenCalled()
    // Signing out is still there.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('disconnects a linked account only through a dialog, gives focus back when it is cancelled, and connects one directly', async () => {
    const user = userEvent.setup()
    render(<AccountPane user={USER} activeProfile={profile()} profileKnown />)
    const disconnect = await screen.findByRole('button', { name: 'Disconnect Google' })
    await user.click(disconnect)
    expect(api.unlinkOAuth).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByRole('heading', { name: 'Disconnect Google?' })).toBeInTheDocument()
    expect(dialog).toHaveTextContent('You will no longer be able to sign in to Aurora with your Google account. You can connect it again later.')
    expect(within(dialog).getByRole('button', { name: 'Keep it' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.unlinkOAuth).not.toHaveBeenCalled()
    await waitFor(() => expect(disconnect).toHaveFocus())

    // Confirmed: the request goes, the row now offers Connect, and that
    // button has the focus the Disconnect button took with it.
    api.listOAuthLinks.mockResolvedValue({ linked: [], available: ['discord', 'google'], hasPassword: true, canUnlinkAny: false })
    await user.click(disconnect)
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(api.unlinkOAuth).toHaveBeenCalledWith('google'))
    expect(api.unlinkOAuth).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect Google' })).toHaveFocus())

    api.startOAuthLink.mockReturnValue(new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Connect Discord' }))
    expect(api.startOAuthLink).toHaveBeenCalledWith('discord')
  })
})
