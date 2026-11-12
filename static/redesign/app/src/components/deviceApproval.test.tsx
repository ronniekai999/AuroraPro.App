// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DeviceApprovalView from './DeviceApprovalView'
import { APIError, apiFetch, type Profile } from '@/lib/api'

// The real module but for the request itself: the page tells a refusal by
// the error type the real one throws.
vi.mock('@/lib/api', async original => ({ ...(await original<typeof import('@/lib/api')>()), apiFetch: vi.fn() }))
const fetch = vi.mocked(apiFetch)
beforeEach(() => fetch.mockReset())

const refused = (status: number, message: string, reason?: string, retryAfterSec?: number) =>
  new APIError(status, message, { error: { code: status, message, ...(reason ? { reason } : {}) } }, retryAfterSec)
const tv = { device_name: 'Living room TV', user_id: 7, username: 'alice' }
const LOCKED = 'Every profile on this account has a PIN, so a TV cannot be approved from here. Sign in on the TV with the account password instead.'
const lockedRefusal = () => refused(409, 'every profile on this account has a PIN; sign in on the device with the account password instead', 'profile_locked')
const profile = (id: number, name: string, extra: Partial<Profile> = {}): Profile => ({ id, user_id: 7, name, is_default: id === 1, created_at: '', updated_at: '', ...extra })
const field = () => screen.getByLabelText('Enter the code shown on your TV')
const alertText = () => screen.getByRole('alert').textContent

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
    // By attribute as well as by where the focus is: jsdom leaves the focus
    // on a button that becomes disabled, where a browser drops it.
    const checking = screen.getByRole('button', { name: 'Checking…' })
    expect(checking).toHaveFocus()
    expect(checking).not.toBeDisabled()
    expect(checking).toHaveAttribute('aria-disabled', 'true')
    expect(field()).not.toBeDisabled()
    expect(field()).toHaveAttribute('readonly')
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
    const approving = screen.getByRole('button', { name: 'Approving…' })
    expect(approving).toHaveFocus()
    expect(approving).not.toBeDisabled()
    expect(approving).toHaveAttribute('aria-disabled', 'true')
    await user.keyboard('{Enter}')
    expect(fetch).toHaveBeenCalledTimes(2)
    done({ message: 'device authorized' })
    const said = await screen.findByText(/TV approved/)
    await waitFor(() => expect(said).toHaveFocus())
  })

  // The code as the server reads it: the ends trimmed, upper case, the dash
  // optional. A space is never part of one.
  it('says what a code looks like, and takes one pasted with spaces or in lower case', async () => {
    const user = userEvent.setup()
    fetch.mockResolvedValue(tv)
    render(<DeviceApprovalView username="alice" initialCode="" />)
    expect(field()).toHaveAccessibleDescription('8 letters and numbers, as on the TV. The dash is optional.')
    expect(field()).not.toHaveAttribute('maxlength')
    expect(screen.getByRole('button', { name: 'Find TV' })).toBeDisabled()
    await user.click(field())
    await user.paste('  abcd-12 34 \n')
    expect(field()).toHaveValue('ABCD-1234')
    expect(screen.getByRole('button', { name: 'Find TV' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await screen.findByRole('button', { name: 'Approve TV for alice' })
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/device/preview?code=ABCD-1234')
    // Without its dash it is still a whole code.
    await user.clear(field())
    await user.type(field(), 'wxyz5678')
    expect(field()).toHaveValue('WXYZ5678')
    expect(screen.getByRole('button', { name: 'Find TV' })).toBeEnabled()
  })

  // The lookup answers "not found" for any code it does not hold, a
  // mistyped one included. The page says both, marks the field, and says
  // nothing of the kind for a refusal that is not about the code.
  it('says a code that was not found may be mistyped or expired, and marks the field for that alone', async () => {
    const user = userEvent.setup()
    fetch.mockRejectedValueOnce(refused(404, 'device code is expired or already used'))
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    expect(field()).not.toHaveAttribute('aria-invalid', 'true')
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    const shown = 'No TV is waiting with that code. Check it against the TV; if it has expired, start sign-in again there.'
    await waitFor(() => expect(alertText()).toBe(shown))
    expect(field()).toHaveAttribute('aria-invalid', 'true')
    expect(field()).toHaveAccessibleDescription(`8 letters and numbers, as on the TV. The dash is optional. ${shown}`)
    expect(screen.queryByRole('button', { name: /Approve TV/ })).toBeNull()
    await user.type(field(), '{Backspace}')
    expect(field()).not.toHaveAttribute('aria-invalid', 'true')
    expect(alertText()).toBe('')
  })

  it.each([
    [refused(429, 'too many device sign-in attempts; try again in a minute', undefined, 60), 'Too many tries. Try again in about a minute.'],
    [refused(500, 'internal error'), 'The server could not look the code up just now. Try again.'],
    [new TypeError('Failed to fetch'), 'The server could not be reached. Check the connection and try again.'],
    [new TypeError("Cannot read properties of undefined (reading 'x')"), 'Something went wrong on this page. Try again.'],
  ])('says a failed lookup that is not about the code without marking the code wrong (%#)', async (failure, shown) => {
    const user = userEvent.setup()
    fetch.mockRejectedValueOnce(failure)
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await waitFor(() => expect(alertText()).toBe(shown))
    expect(field()).not.toHaveAttribute('aria-invalid', 'true')
    expect(field()).toHaveAccessibleDescription('8 letters and numbers, as on the TV. The dash is optional.')
    // Nothing was being approved: it is not said that a TV was not.
    expect(alertText()).not.toMatch(/approved/)
  })

  // Every profile has a PIN: the server approves no TV. The reason takes
  // Approve's place in the TV's card, and nothing tells anyone to "approve
  // it below". The condition is the account's, and can change without this
  // page hearing: the next TV found is offered again.
  it('puts the reason where Approve was when every profile has a PIN, and offers again at the next lookup', async () => {
    const user = userEvent.setup()
    fetch.mockResolvedValueOnce(tv).mockRejectedValueOnce(lockedRefusal())
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await user.click(await screen.findByRole('button', { name: 'Approve TV for alice' }))
    const reason = await screen.findByText(LOCKED)
    expect(screen.queryByRole('button', { name: /Approve TV/ })).toBeNull()
    // In the card, with the TV it is about; read once, by taking the focus,
    // and not a second time by a live region.
    expect(reason.parentElement).toHaveTextContent('Living room TV wants to sign in to your AuroraPro account.')
    await waitFor(() => expect(reason).toHaveFocus())
    expect(reason).not.toHaveAttribute('role')
    expect(alertText()).toBe('')
    expect(screen.queryByText(/approve it below/)).toBeNull()
    expect(screen.queryByText(/Approve only if/)).toBeNull()

    // Find TV again: the reason stays until the TV is found, then Approve
    // is offered once more.
    fetch.mockResolvedValueOnce(tv).mockRejectedValueOnce(lockedRefusal())
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    const again = await screen.findByRole('button', { name: 'Approve TV for alice' })
    expect(screen.queryByText(LOCKED)).toBeNull()
    expect(screen.getByText('Found Living room TV. Check its code, then approve it below.')).toBeInTheDocument()
    await user.click(again)
    expect(await screen.findByText(LOCKED)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Approve TV/ })).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  // On an approval the code was found a moment ago, so "not found" is a
  // code that has run out or was already approved; a plain 409 is another
  // account signed in since. Either way a second press would get the same,
  // so Approve goes, and the focus goes to what the person does next: not
  // onto the alert, which would be read out twice.
  it.each([
    [404, 'device code is expired or already used', 'That code has expired or was already used. Start sign-in again on the TV to get a new one.', 'field'],
    [409, 'your signed-in account changed; look up this TV again before approving', 'The account signed in on this device has changed. Find the TV again before approving it.', 'find'],
  ] as const)('takes Approve away after a %i on an approval, and moves the focus on', async (status, serverWords, shown, next) => {
    const user = userEvent.setup()
    fetch.mockResolvedValueOnce(tv).mockRejectedValueOnce(refused(status, serverWords))
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await user.click(await screen.findByRole('button', { name: 'Approve TV for alice' }))
    await waitFor(() => expect(alertText()).toBe(shown))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Approve TV/ })).toBeNull())
    const target = next === 'field' ? field() : screen.getByRole('button', { name: 'Find TV' })
    await waitFor(() => expect(target).toHaveFocus())
    expect(screen.getByRole('alert')).not.toHaveAttribute('tabindex')
    // The code is not what was wrong with the request.
    expect(field()).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Find TV' })).toBeEnabled()
  })

  // An approval that got no answer, or a gateway's error in place of one,
  // may still have been written: none of these say the TV was not approved.
  it.each([
    [refused(429, 'too many device sign-in attempts; try again in a minute', undefined, 60), 'Too many tries. Try again in about a minute.'],
    [refused(401, 'this session has ended; sign in again', 'session_ended'), 'This device’s session has ended, so it cannot approve a TV. Reload the page, and sign in again if it asks.'],
    [refused(401, 'sign in again before authorizing this device'), 'This device is no longer signed in for this. Reload the page, and sign in again if it asks.'],
    [refused(403, 'authorize this device from your Aurora server'), 'The server refused this because of how it is reached: the address it sees is not this page’s. Whoever runs the server can put that right.'],
    [refused(500, 'could not check the active profile'), 'The server did not confirm the approval, so the TV may or may not have been approved. If it does not sign in, find it again here.'],
    [refused(502, 'Bad Gateway'), 'The server did not confirm the approval, so the TV may or may not have been approved. If it does not sign in, find it again here.'],
    [new TypeError('Failed to fetch'), 'No answer came back from the server, so the TV may or may not have been approved. If it does not sign in, check the connection and find it again here.'],
  ])('says a refused approval in plain words and keeps Approve for another try (%#)', async (failure, shown) => {
    const user = userEvent.setup()
    fetch.mockResolvedValueOnce(tv).mockRejectedValueOnce(failure)
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    const approve = await screen.findByRole('button', { name: 'Approve TV for alice' })
    approve.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(alertText()).toBe(shown))
    expect(alertText()).not.toMatch(/was not approved/)
    expect(screen.getByRole('button', { name: 'Approve TV for alice' })).toHaveFocus()
    expect(field()).not.toHaveAttribute('aria-invalid', 'true')
  })

  // The server gives the TV the approver's own profile when that has no
  // PIN. A parent approving from their own profile hands a child's TV the
  // profile without a limit, so the page says which it will be, where it
  // can be sure.
  it('says which profile the TV will start on when the profile in use here has no PIN', async () => {
    const user = userEvent.setup()
    fetch.mockResolvedValue(tv)
    const parent = profile(1, 'Parent')
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" actingProfile={parent} profiles={[parent, profile(2, 'Kid', { has_pin: true })]} />)
    expect(screen.queryByText(/The TV will start on/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await screen.findByRole('button', { name: 'Approve TV for alice' })
    expect(screen.getByText('The TV will start on Parent, the profile you are using here.')).toBeInTheDocument()
  })

  it('says the TV will not start on the profile in use here when that has a PIN and another has none', async () => {
    const user = userEvent.setup()
    fetch.mockResolvedValue(tv)
    const parent = profile(1, 'Parent', { has_pin: true })
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" actingProfile={parent} profiles={[parent, profile(2, 'Kid'), profile(3, 'Sam', { has_pin: true })]} />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await screen.findByRole('button', { name: 'Approve TV for alice' })
    expect(screen.getByText('The TV will start on a profile without a PIN, not on Parent.')).toBeInTheDocument()
  })

  // Every profile locked: the server refuses, or on an account with no
  // password picks a profile past its PIN, and the page cannot tell which.
  // Nor can it say anything of a profile it does not know.
  it.each([
    ['every profile has a PIN', profile(1, 'Parent', { has_pin: true }), [profile(1, 'Parent', { has_pin: true }), profile(2, 'Kid', { has_pin: true })]],
    ['the profile in use here is not known', null, [profile(1, 'Parent'), profile(2, 'Kid')]],
    ['nothing was passed', undefined, undefined],
  ] as const)('says nothing about the TV\'s profile when %s', async (_, acting, all) => {
    const user = userEvent.setup()
    fetch.mockResolvedValue(tv)
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" actingProfile={acting} profiles={all} />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await screen.findByRole('button', { name: 'Approve TV for alice' })
    expect(screen.queryByText(/The TV will start on/)).toBeNull()
  })

  it('handles expiry and cancels lookup when leaving the page', async () => {
    const user = userEvent.setup()
    fetch.mockRejectedValueOnce(refused(404, 'device code is expired or already used'))
    const view = render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    // The alert's paragraph is always there; it is its words that arrive.
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('expired'))
    fetch.mockImplementationOnce(() => new Promise(() => {}))
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    const signal = fetch.mock.calls[1][1]?.signal
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })
})
