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
const LOCKED = 'Every profile on this account has a PIN, so a TV cannot be approved from here. Sign in on the TV with the account password instead.'
const lockedRefusal = () => refused(409, 'every profile on this account has a PIN; sign in on the device with the account password instead', 'profile_locked')
// The found TV's card: its name as the title, and what it is asking for.
const card = () => screen.getByText('wants to sign in to your AuroraPro account.').closest('div')!.parentElement as HTMLElement
const AFTER = 'After you approve, go back to the TV and choose who is watching.'
const field = () => screen.getByLabelText('Code from the TV')
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
    await screen.findByRole('button', { name: 'Approve TV for alice' })
    expect(card()).toHaveTextContent('Living room TV wants to sign in to your AuroraPro account.')
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
    await user.clear(screen.getByLabelText('Code from the TV'))
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
    expect(reason.parentElement).toBe(card())
    expect(card()).toHaveTextContent('Living room TV wants to sign in to your AuroraPro account.')
    expect(card()).not.toHaveTextContent(AFTER)
    expect(screen.queryByRole('button', { name: 'Not my TV' })).toBeNull()
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

  // The TV does not start on a profile: it opens its own "who is watching"
  // list. The page says that, and says locked profiles still ask for their
  // PIN there only when it knows the account has a profile without one
  // (then that is the kind the server lets the TV into unasked).
  it.each([
    ['the account has a profile without a PIN', true, `${AFTER} Profiles with a PIN still ask for it there.`],
    ['every profile has a PIN', false, AFTER],
    ['the profiles are not known yet', null, AFTER],
    ['nothing is said of the profiles', undefined, AFTER],
  ] as const)('says what happens on the TV after an approval when %s', async (_, someProfileUnlocked, words) => {
    const user = userEvent.setup()
    fetch.mockResolvedValue(tv)
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" someProfileUnlocked={someProfileUnlocked} />)
    expect(screen.queryByText(/After you approve/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await screen.findByRole('button', { name: 'Approve TV for alice' })
    expect(screen.getByText(/After you approve/).textContent).toBe(words)
    expect(screen.getByText(/After you approve/).closest('div')).toBe(card())
    // No profile is named anywhere on the page.
    expect(document.body.textContent).not.toMatch(/will start on/)
  })

  // There is no route that refuses a TV: "Not my TV" sends nothing. It puts
  // the found TV aside, says nothing was approved, and gives the focus to
  // the code field.
  it('puts a TV aside with "Not my TV": no request, the words said, the focus on the code', async () => {
    const user = userEvent.setup()
    fetch.mockResolvedValue(tv)
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await screen.findByRole('button', { name: 'Approve TV for alice' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const notMine = screen.getByRole('button', { name: 'Not my TV' })
    notMine.focus()
    await user.keyboard('{Enter}')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /Approve TV/ })).toBeNull()
    expect(screen.queryByText('wants to sign in to your AuroraPro account.')).toBeNull()
    const said = screen.getByText('Nothing was approved. That TV has not been signed in.')
    expect(said).toHaveAttribute('role', 'status')
    expect(said.className).not.toMatch(/sr-only/)
    await waitFor(() => expect(field()).toHaveFocus())
    expect(field()).toHaveValue('ABCD-1234')
    expect(alertText()).toBe('')
    // It is one status line: looking the code up again replaces the words.
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await screen.findByRole('button', { name: 'Approve TV for alice' })
    expect(screen.queryByText(/Nothing was approved/)).toBeNull()
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not put a TV aside while its approval is being sent', async () => {
    const user = userEvent.setup()
    fetch.mockResolvedValueOnce(tv).mockImplementationOnce(() => new Promise(() => {}))
    render(<DeviceApprovalView username="alice" initialCode="ABCD-1234" />)
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await user.click(await screen.findByRole('button', { name: 'Approve TV for alice' }))
    const notMine = screen.getByRole('button', { name: 'Not my TV' })
    expect(notMine).toHaveAttribute('aria-disabled', 'true')
    await user.click(notMine)
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeInTheDocument()
    expect(screen.queryByText(/Nothing was approved/)).toBeNull()
  })

  // Typed with more dashes it is the same code, as the server reads it. The
  // page shows it the way the TV does, which also fits a narrow phone.
  it('shows the code to check as the TV shows it, whatever dashes it was typed with', async () => {
    const user = userEvent.setup()
    fetch.mockResolvedValue(tv)
    render(<DeviceApprovalView username="alice" initialCode="" />)
    await user.type(field(), 'ab-cd--12-34----')
    await user.click(screen.getByRole('button', { name: 'Find TV' }))
    await screen.findByRole('button', { name: 'Approve TV for alice' })
    expect(screen.getByText(/Approve only if you started sign-in on this TV/)).toHaveTextContent('its code matches ABCD-1234.')
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
