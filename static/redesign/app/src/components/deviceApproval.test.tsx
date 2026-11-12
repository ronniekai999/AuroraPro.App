// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DeviceApprovalView from './DeviceApprovalView'
import { APIError, apiFetch } from '@/lib/api'

// The real module but for the request itself: the page tells a refusal by
// the error type the real one throws.
vi.mock('@/lib/api', async original => ({ ...(await original<typeof import('@/lib/api')>()), apiFetch: vi.fn() }))
const fetch = vi.mocked(apiFetch)
beforeEach(() => fetch.mockReset())

const refused = (status: number, message: string, reason?: string, retryAfterSec?: number) =>
  new APIError(status, message, { error: { code: status, message, ...(reason ? { reason } : {}) } }, retryAfterSec)
const tv = { device_name: 'Living room TV', user_id: 7, username: 'alice' }

describe('TV device approval', () => {
  it('requires lookup and explicit approval, with account and code visible', async () => {
    const user = userEvent.setup()
    fetch.mockResolvedValueOnce({ device_name: 'Living room TV', user_id: 7, username: 'alice' }).mockResolvedValueOnce({ message: 'device authorized' })
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getByText('Signing in as alice')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve TV for alice' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    expect(await screen.findByText('Living room TV wants to sign in to your AuroraPro account.')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/device/preview?code=ABCD-1234')
    await user.click(screen.getByRole('button', { name: 'Approve TV for alice' }))
    expect(fetch.mock.calls[1][0]).toBe('/api/auth/device/authorize')
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', body: { user_code: 'ABCD-1234', expected_user_id: 7 } })
    expect(await screen.findByRole('status')).toHaveTextContent('TV approved')
  })

  it('editing a verified code removes permission to approve the old device', async () => {
    const user = userEvent.setup()
    fetch.mockResolvedValue({ device_name: 'TV', user_id: 7, username: 'alice' })
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await screen.findByRole('button', { name: 'Approve TV for alice' })
    await user.clear(screen.getByLabelText('Enter the code shown on your TV'))
    expect(screen.queryByRole('button', { name: 'Approve TV for alice' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Find TV' })).toBeDisabled()
  })

  it('uses the verified account instead of a stale cached username', async () => {
    const user = userEvent.setup()
    fetch.mockResolvedValueOnce({ device_name: 'TV', user_id: 9, username: 'bob' }).mockResolvedValueOnce({ message: 'device authorized' })
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await user.click(await screen.findByRole('button', { name: 'Approve TV for bob' }))
    expect(fetch.mock.calls[1][1]).toMatchObject({ body: { expected_user_id: 9 } })
  })

  // A button that is disabled while its own request is out drops the focus
  // it holds, and the next Tab starts from the top of the page.
  it('keeps the focus through the lookup and the approval, and sends each once', async () => {
    const user = userEvent.setup()
    let found: (v: unknown) => void = () => {}
    let done: (v: unknown) => void = () => {}
    fetch.mockImplementationOnce(() => new Promise(resolve => { found = resolve }))
    fetch.mockImplementationOnce(() => new Promise(resolve => { done = resolve }))
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    const find = screen.getByRole('button', { name: 'Find TV' })
    find.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Checking…' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(fetch).toHaveBeenCalledTimes(1)
    found({ device_name: 'Living room TV', user_id: 7, username: 'alice' })
    const approve = await screen.findByRole('button', { name: 'Approve TV for alice' })
    expect(screen.getByRole('button', { name: 'Find TV' })).toHaveFocus()
    // Found is said, and the focus is not put on Approve: a second Enter
    // must not approve a TV nobody has looked at.
    expect(screen.getByText('Found Living room TV. Check its code, then approve it below.')).toHaveAttribute('role', 'status')
    approve.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Approving…' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(fetch).toHaveBeenCalledTimes(2)
    done({ message: 'device authorized' })
    const said = await screen.findByText(/TV approved/)
    await waitFor(() => expect(said).toHaveFocus())
  })

  it('ties a refusal to the code field', async () => {
    const user = userEvent.setup()
    fetch.mockRejectedValueOnce(new Error('device code is expired or already used'))
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    const field = screen.getByLabelText('Enter the code shown on your TV')
    expect(field).not.toHaveAttribute('aria-invalid', 'true')
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'))
    expect(field).toHaveAccessibleDescription('device code is expired or already used')
    await user.type(field, '{Backspace}')
    expect(field).not.toHaveAttribute('aria-invalid', 'true')
  })

  // The server's messages are written for logs. Each refusal it can send is
  // said in the app's words, and what it will refuse again is not offered
  // again.
  it('approves no TV when every profile has a PIN, and stops offering to', async () => {
    const user = userEvent.setup()
    fetch.mockResolvedValueOnce(tv).mockRejectedValueOnce(
      refused(409, 'every profile on this account has a PIN; sign in on the device with the account password instead', 'profile_locked'))
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await user.click(await screen.findByRole('button', { name: 'Approve TV for alice' }))
    const alert = screen.getByRole('alert')
    await waitFor(() => expect(alert).toHaveTextContent('Every profile on this account has a PIN, so a TV cannot be approved from here. Sign in on the TV with the account password instead.'))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Approve TV/ })).toBeNull())
    await waitFor(() => expect(alert).toHaveFocus())
    // Another lookup finds the TV again, and still does not offer it.
    fetch.mockResolvedValueOnce(tv)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    expect(await screen.findByText('Living room TV wants to sign in to your AuroraPro account.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Approve TV/ })).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it.each([
    [404, 'device code is expired or already used', 'That code has expired or was already used. Start sign-in again on the TV to get a new one.'],
    [409, 'your signed-in account changed; look up this TV again before approving', 'The account signed in on this device has changed. Find the TV again before approving it.'],
  ])('takes Approve away after a %i, which a second press would get again', async (status, serverWords, shown) => {
    const user = userEvent.setup()
    fetch.mockResolvedValueOnce(tv).mockRejectedValueOnce(refused(status, serverWords))
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await user.click(await screen.findByRole('button', { name: 'Approve TV for alice' }))
    const alert = screen.getByRole('alert')
    await waitFor(() => expect(alert).toHaveTextContent(shown))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Approve TV/ })).toBeNull())
    await waitFor(() => expect(alert).toHaveFocus())
    expect(screen.getByLabelText('Enter the code shown on your TV')).toHaveAccessibleDescription(shown)
    // The way on is a new lookup, which is still there.
    expect(screen.getByRole('button', { name: 'Find TV' })).toBeEnabled()
  })

  it.each([
    [refused(429, 'too many device sign-in attempts; try again in a minute', undefined, 60), 'Too many tries. Try again in about a minute.'],
    [refused(401, 'this session has ended; sign in again', 'session_ended'), 'This device has been signed out, so it cannot approve a TV. Sign in again first.'],
    [refused(401, 'sign in again before authorizing this device'), 'Sign in again on this device before approving a TV.'],
    [refused(403, 'authorize this device from your Aurora server'), 'A TV can only be approved from this Aurora server’s own page.'],
    [refused(500, 'could not check the active profile'), 'The server could not check this just now, so the TV was not approved. Try again.'],
    [new TypeError('Failed to fetch'), 'The server could not be reached. Check the connection and try again.'],
  ])('says a refused approval in plain words and keeps Approve for another try (%#)', async (failure, shown) => {
    const user = userEvent.setup()
    fetch.mockResolvedValueOnce(tv).mockRejectedValueOnce(failure)
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    const approve = await screen.findByRole('button', { name: 'Approve TV for alice' })
    approve.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(shown))
    expect(screen.getByRole('alert').textContent).toBe(shown)
    expect(screen.getByRole('button', { name: 'Approve TV for alice' })).toHaveFocus()
    expect(screen.queryByRole('status', { name: /approved/ })).toBeNull()
  })

  it('says a refused lookup in plain words', async () => {
    const user = userEvent.setup()
    fetch.mockRejectedValueOnce(refused(404, 'device code is expired or already used'))
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That code has expired or was already used. Start sign-in again on the TV to get a new one.'))
    expect(screen.queryByRole('button', { name: /Approve TV/ })).toBeNull()
  })

  it('handles expiry and cancels lookup when leaving the page', async () => {
    const user = userEvent.setup()
    fetch.mockRejectedValueOnce(new Error('device code is expired or already used'))
    const view = render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('expired')
    fetch.mockImplementationOnce(() => new Promise(() => {}))
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    const signal = fetch.mock.calls[1][1]?.signal
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })
})
