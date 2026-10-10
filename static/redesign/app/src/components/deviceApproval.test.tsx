// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DeviceApprovalView from './DeviceApprovalView'
import { apiFetch } from '@/lib/api'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
const fetch = vi.mocked(apiFetch)
beforeEach(() => fetch.mockReset())

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
