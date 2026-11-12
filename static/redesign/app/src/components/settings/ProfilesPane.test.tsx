// @vitest-environment jsdom
//
// "Profiles and parental controls". Two things are pinned here:
//
// - what a session is SHOWN: a session acting as a profile with a content
//   limit, or one whose profile is not known yet, sees its own profile only,
//   with no control the server would refuse; and no other profile's lists
//   are asked for on its behalf;
// - what each control SENDS, and what the person is told when the server
//   refuses (the reasons in lib/profileRefusal).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { APIError, type Profile } from '@/lib/api'
import { ProfilesPane, addProfileRefusal } from './ProfilesPane'

const api = vi.hoisted(() => ({
  listProfiles: vi.fn(), listWatchlists: vi.fn(), createWatchlist: vi.fn(), deleteWatchlist: vi.fn(),
  updateProfile: vi.fn(), createProfile: vi.fn(), deleteProfile: vi.fn(), setDefaultProfile: vi.fn(),
  setProfilePin: vi.fn(), setProfileMaturity: vi.fn(),
}))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

const profile = (id: number, extra: Partial<Profile> = {}): Profile => ({
  id, user_id: 1, name: `Profile ${id}`, is_default: id === 1, created_at: '', updated_at: '', ...extra,
})
const parent = profile(1, { name: 'Parent' })
const kid = profile(2, { name: 'Kid', max_age_rating: 'PG' })
const sam = profile(3, { name: 'Sam' })
const refusal = (reason: string, status = 409, retryAfterSec?: number) =>
  new APIError(status, 'server words', { error: { code: status, message: 'server words', reason } }, retryAfterSec)

const rows = () => screen.queryAllByRole('listitem').filter(li => li.hasAttribute('data-profile-row'))
const rowOf = (name: string) => {
  const li = rows().find(r => within(r).queryByText(name, { selector: 'p' }))
  if (!li) throw new Error(`no row for ${name}`)
  return within(li)
}
const listsAskedFor = () => api.listWatchlists.mock.calls.map(c => c[0])

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.listProfiles.mockResolvedValue([parent, kid, sam])
  api.listWatchlists.mockResolvedValue([])
  for (const fn of [api.updateProfile, api.createProfile, api.deleteProfile, api.setDefaultProfile, api.setProfilePin, api.setProfileMaturity, api.createWatchlist, api.deleteWatchlist]) fn.mockResolvedValue({})
})

describe('what a session with a content limit is shown', () => {
  // The server refuses a restricted session any other profile's lists, and
  // every management write.
  it('moves onto its own profile when the acting profile changes: one row, its own lists, no management', async () => {
    const view = render(<ProfilesPane actingProfile={parent} profileKnown />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(listsAskedFor()).toEqual([])

    view.rerender(<ProfilesPane actingProfile={kid} profileKnown />)
    // At once, not after the next load: no commit shows it the others.
    expect(rows()).toHaveLength(1)
    expect(rowOf('Kid')).toBeTruthy()
    await waitFor(() => expect(listsAskedFor()).toEqual([2]))
    expect(screen.queryByRole('combobox', { name: /Limit for/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /PIN/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Delete Kid|the default/ })).toBeNull()
    expect(screen.queryByRole('form', { name: 'Add a profile' })).toBeNull()
    expect(screen.getByText(/Kid has a content limit, so limits, PINs and the other profiles can only be managed from a profile without one/)).toBeInTheDocument()
    // What it may still change is there: its name, avatar and lean.
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Kid')
    expect(screen.getByRole('radiogroup', { name: 'Avatar for Kid' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /lean towards/ })).toBeInTheDocument()
  })

  // Until the session's profile is known it could be a restricted one, so
  // nothing is listed; once the kid's arrives, only the kid's.
  it('lists nothing while the acting profile is unknown, then only its own', async () => {
    const view = render(<ProfilesPane actingProfile={null} profileKnown={false} />)
    await waitFor(() => expect(api.listProfiles).toHaveBeenCalled())
    await act(async () => {})
    expect(rows()).toHaveLength(0)
    expect(listsAskedFor()).toEqual([])
    expect(screen.getByText(/could not be confirmed/)).toBeInTheDocument()

    view.rerender(<ProfilesPane actingProfile={kid} profileKnown />)
    await waitFor(() => expect(listsAskedFor()).toEqual([2]))
    expect(rows()).toHaveLength(1)
  })

  // A profile that is named but not yet confirmed gets no management either.
  it('treats a session whose profile is unknown as restricted even when the list has loaded', async () => {
    render(<ProfilesPane actingProfile={parent} profileKnown={false} />)
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(screen.queryByRole('combobox', { name: /Limit for/ })).toBeNull()
  })

  // A link straight to this page arrives before the app knows the session's
  // profile. That is loading, not "could not be confirmed".
  it('says it is loading until the app has settled which profile the session acts as', async () => {
    const view = render(<ProfilesPane actingProfile={null} profileKnown={false} profileSettled={false} />)
    await waitFor(() => expect(api.listProfiles).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText(/could not be confirmed/)).toBeNull()
    expect(rows()).toHaveLength(0)
    view.rerender(<ProfilesPane actingProfile={parent} profileKnown profileSettled />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  // Another device gave this session's profile a limit; the app's copy has
  // not caught up, but the list this page just read has.
  it('goes by the list it has just read when that is newer than the app\'s copy of the acting profile', async () => {
    api.listProfiles.mockResolvedValue([{ ...parent, max_age_rating: 'TV-PG' }, kid, sam])
    render(<ProfilesPane actingProfile={parent} profileKnown />)
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(screen.queryByRole('combobox', { name: /Limit for/ })).toBeNull()
    expect(screen.getByText(/Parent has a content limit/)).toBeInTheDocument()
  })

  // And the other way round: the app has re-read the session's profile and
  // knows it is limited now, while this page's list is from before. Either
  // copy saying "limited" is enough; the page must not wait for its own.
  it('treats the session as limited when the app\'s copy says so and the page\'s older list does not', async () => {
    const view = render(<ProfilesPane actingProfile={parent} profileKnown />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    // The next reads never answer: the page is left with its old list.
    api.listProfiles.mockReturnValue(new Promise(() => {}))
    view.rerender(<ProfilesPane actingProfile={{ ...parent, max_age_rating: 'TV-PG' }} profileKnown />)
    expect(rows()).toHaveLength(1)
    expect(screen.queryByRole('combobox', { name: /Limit for/ })).toBeNull()
    expect(screen.queryByRole('form', { name: 'Add a profile' })).toBeNull()
    expect(screen.queryByText(/no PIN\./)).toBeNull()
    expect(screen.getByText(/Parent has a content limit/)).toBeInTheDocument()
  })

  // The password is the key to every profile: not said to a limited session.
  it('tells only a session that manages profiles that the password unlocks them all', async () => {
    const view = render(<ProfilesPane actingProfile={kid} profileKnown />)
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(screen.queryByText(/account password also unlocks any profile/)).toBeNull()
    view.rerender(<ProfilesPane actingProfile={parent} profileKnown />)
    expect(screen.getByText(/account password also unlocks any profile/)).toBeInTheDocument()
  })
})

describe('stale loads', () => {
  // Each load supersedes the ones before it: an answer from before the
  // session moved to another profile must not land last and put back a list
  // a newer answer replaced.
  it('ignores a profile list that a newer load has superseded', async () => {
    let early!: (ps: Profile[]) => void
    api.listProfiles
      .mockImplementationOnce(() => new Promise<Profile[]>(r => { early = r }))
      .mockResolvedValue([parent, kid, sam])
    const view = render(<ProfilesPane actingProfile={parent} profileKnown />)
    view.rerender(<ProfilesPane actingProfile={sam} profileKnown />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    await act(async () => { early([parent, kid]) })
    expect(rows()).toHaveLength(3)
    expect(rowOf('Sam')).toBeTruthy()
  })
})

describe('managing profiles, from a profile without a limit', () => {
  const open = async (acting: Profile = parent, onProfilesChanged = vi.fn()) => {
    render(<ProfilesPane actingProfile={acting} profileKnown onProfilesChanged={onProfilesChanged} onToast={vi.fn()} />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    return onProfilesChanged
  }
  const limitOf = (name: string) => rowOf(name).getByRole('combobox', { name: `Limit for ${name}` }) as HTMLSelectElement
  const pick = (name: string, value: string) => fireEvent.change(limitOf(name), { target: { value } })
  const confirm = () => screen.getByRole('alertdialog')
  // Save reads the list again before it asks or sends.
  const asked = () => screen.findByRole('alertdialog')

  it('shows every profile with its limit and whether it has a PIN', async () => {
    api.listProfiles.mockResolvedValue([parent, kid, { ...sam, has_pin: true }])
    await open()
    expect(limitOf('Parent')).toHaveValue('')
    // A stored limit this page does not offer is still the one shown, in
    // its place, described by what it really lets through.
    expect(limitOf('Kid')).toHaveValue('PG')
    expect([...limitOf('Kid').options].map(o => o.textContent)).toEqual([
      'No limit', 'Up to PG-13 and TV-14', 'Up to PG and TV-PG', 'Up to PG and TV-Y7', 'Up to G and TV-Y7', 'Up to G and TV-G',
    ])
    expect(rowOf('Kid').getByText('No PIN')).toBeInTheDocument()
    expect(rowOf('Sam').getByText('PIN set')).toBeInTheDocument()
    expect(rowOf('Parent').getByText('Default profile · watching now')).toBeInTheDocument()
  })

  // On Windows and Linux an arrow key or a typed letter on a CLOSED dropdown
  // fires `change` at once, and a screen reader browsing the options does
  // the same. One stray key must not move a child's limit.
  it('sends nothing when the dropdown changes: arrows and typing only choose, Save sends', async () => {
    const user = userEvent.setup()
    await open()
    const select = limitOf('Kid')
    select.focus()
    // What the keys do in a browser: each one changes the value and fires
    // `change`. (jsdom does not act on keys in a select, so the change each
    // would cause is fired with it.)
    for (const [key, value] of [['{ArrowUp}', 'TV-PG'], ['{ArrowUp}', 'TV-14'], ['n', ''], ['{ArrowDown}', 'TV-14']] as const) {
      await user.keyboard(key)
      fireEvent.change(select, { target: { value } })
    }
    expect(api.updateProfile).not.toHaveBeenCalled()
    expect(select).toHaveFocus()
    // The row says the choice is not saved, and what the limit still is.
    expect(rowOf('Kid').getByText('Not saved. The limit for Kid is still: up to PG and TV-Y7.')).toBeInTheDocument()
    expect(select).toHaveAccessibleDescription('Not saved. The limit for Kid is still: up to PG and TV-Y7.')
    // Undo puts the stored limit back, still without a request.
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Undo' }))
    expect(select).toHaveValue('PG')
    expect(rowOf('Kid').queryByRole('button', { name: 'Save limit for Kid' })).toBeNull()
    expect(api.updateProfile).not.toHaveBeenCalled()
  })

  it('saves a stricter limit on Save, without asking, reloads, and tells the app its copy is stale', async () => {
    const changed = await open()
    api.listProfiles.mockClear()
    pick('Kid', 'TV-G')
    expect(api.updateProfile).not.toHaveBeenCalled()
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save limit for Kid' }))
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith(2, { max_age_rating: 'TV-G' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    // Read once before the write (is the row's limit still the server's?)
    // and once after it.
    expect(api.listProfiles).toHaveBeenCalledTimes(2)
    // Focus is on the control, not lost with the Save button.
    await waitFor(() => expect(limitOf('Kid')).toHaveFocus())
  })

  // A change that lets MORE through is asked about first, and removing the
  // limit always is.
  it('asks before loosening a limit, shows the stored limit again if that is cancelled, and sends only on confirm', async () => {
    await open()
    pick('Kid', 'TV-14')
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save limit for Kid' }))
    expect(within(await asked()).getByRole('heading', { name: 'Loosen the limit for Kid?' })).toBeInTheDocument()
    expect(api.updateProfile).not.toHaveBeenCalled()
    expect(confirm()).toHaveTextContent('Kid will be able to see and play more: up to PG-13 and TV-14. The limit now is: up to PG and TV-Y7.')
    // Focus goes into the dialog, on the answer that changes nothing.
    expect(within(confirm()).getByRole('button', { name: 'Keep it as it is' })).toHaveFocus()
    fireEvent.click(within(confirm()).getByRole('button', { name: 'Keep it as it is' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.updateProfile).not.toHaveBeenCalled()
    expect(limitOf('Kid')).toHaveValue('PG')
    // The Save button went with the choice; the control takes the focus.
    await waitFor(() => expect(limitOf('Kid')).toHaveFocus())

    pick('Kid', 'TV-14')
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save limit for Kid' }))
    fireEvent.click(within(await asked()).getByRole('button', { name: 'Loosen the limit' }))
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith(2, { max_age_rating: 'TV-14' }))
    expect(api.updateProfile).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(limitOf('Kid')).toHaveFocus())
  })

  it('always asks before taking a limit off, and Escape cancels', async () => {
    const user = userEvent.setup()
    await open()
    pick('Kid', '')
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save limit for Kid' }))
    expect(within(await asked()).getByRole('heading', { name: 'Take the limit off Kid?' })).toBeInTheDocument()
    expect(confirm()).toHaveTextContent('Kid will be able to see and play everything on this server.')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.updateProfile).not.toHaveBeenCalled()
    expect(limitOf('Kid')).toHaveValue('PG')

    pick('Kid', '')
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save limit for Kid' }))
    fireEvent.click(within(await asked()).getByRole('button', { name: 'Remove the limit' }))
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith(2, { max_age_rating: '' }))
  })

  // Limiting the profile this session acts as takes these controls away
  // from it, so that is asked about too.
  it('asks before limiting the profile being watched as', async () => {
    await open()
    pick('Parent', 'TV-PG')
    fireEvent.click(rowOf('Parent').getByRole('button', { name: 'Save limit for Parent' }))
    expect(within(await asked()).getByRole('heading', { name: 'Limit Parent?' })).toBeInTheDocument()
    expect(confirm()).toHaveTextContent('You are watching as Parent. With a limit (up to PG and TV-PG), this device can no longer manage profiles until it switches to one without a limit.')
    expect(api.updateProfile).not.toHaveBeenCalled()
    fireEvent.click(within(confirm()).getByRole('button', { name: 'Limit Parent' }))
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith(1, { max_age_rating: 'TV-PG' }))
  })

  // Whether a choice loosens a limit is a question about what the server
  // has now. Another device tightened Kid's limit since this row was drawn:
  // against the row's copy (PG) "TV-Y7" is stricter and would go unasked;
  // against the server's (TV-G) it is looser.
  it('reads the limit again on Save, and stops when another device has changed it', async () => {
    await open()
    pick('Kid', 'TV-Y7')
    api.listProfiles.mockResolvedValue([parent, { ...kid, max_age_rating: 'TV-G' }, sam])
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save limit for Kid' }))
    const said = await rowOf('Kid').findByText('The limit for Kid was changed on another device a moment ago, so nothing was saved. It is now: up to G and TV-G. Choose again if that is not what you want.')
    expect(said).toHaveAttribute('role', 'status')
    expect(api.updateProfile).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    // The row shows what the server has, and focus is on the control.
    await waitFor(() => expect(limitOf('Kid')).toHaveValue('TV-G'))
    expect(limitOf('Kid')).toHaveFocus()
    // Choosing again, against the limit as it is now, is asked about.
    pick('Kid', 'TV-Y7')
    expect(rowOf('Kid').queryByText(/changed on another device/)).toBeNull()
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save limit for Kid' }))
    expect(within(await asked()).getByRole('heading', { name: 'Loosen the limit for Kid?' })).toBeInTheDocument()
    expect(api.updateProfile).not.toHaveBeenCalled()
  })

  it('saves nothing when the limit cannot be checked first', async () => {
    await open()
    pick('Kid', 'TV-G')
    api.listProfiles.mockRejectedValue(new TypeError('offline'))
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save limit for Kid' }))
    expect(await rowOf('Kid').findByText('The limit for Kid could not be checked just now, so nothing was saved. Try again.')).toHaveAttribute('role', 'status')
    expect(api.updateProfile).not.toHaveBeenCalled()
    // The choice is kept for the next try.
    expect(limitOf('Kid')).toHaveValue('TV-G')
    api.listProfiles.mockResolvedValue([parent, kid, sam])
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save limit for Kid' }))
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith(2, { max_age_rating: 'TV-G' }))
  })

  // The question's words are about one stored limit. When a reload brings
  // another while it is up, it is withdrawn, not left asking "Loosen …: up
  // to G and TV-G. The limit now is: up to G and TV-G".
  it('withdraws the question when the stored limit changes under it', async () => {
    await open()
    pick('Kid', 'TV-14')
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save limit for Kid' }))
    await asked()
    // A reload from elsewhere on the page (another row's write) brings a
    // limit another device set meanwhile.
    api.listProfiles.mockResolvedValue([parent, { ...kid, max_age_rating: 'TV-14' }, sam])
    // (The page behind the dialog is hidden from the accessibility tree.)
    const samRow = within(document.querySelector('[data-profile-row="3"]') as HTMLElement)
    fireEvent.click(samRow.getByRole('button', { name: 'Edit Sam', hidden: true }))
    fireEvent.change(samRow.getByRole('textbox', { name: 'Name', hidden: true }), { target: { value: 'Sammy' } })
    fireEvent.click(samRow.getByRole('button', { name: 'Save name', hidden: true }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(limitOf('Kid')).toHaveValue('TV-14')
    expect(api.updateProfile).toHaveBeenCalledTimes(1)
    expect(api.updateProfile).toHaveBeenCalledWith(3, { name: 'Sammy' })
  })

  // The server refuses to limit or delete the account's last profile without
  // a limit; the page does not offer it, and says why.
  it('does not offer to limit or delete the only profile without a limit', async () => {
    api.listProfiles.mockResolvedValue([parent, kid])
    render(<ProfilesPane actingProfile={parent} profileKnown />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(limitOf('Parent')).toBeDisabled()
    expect(rowOf('Parent').getByText(/Parent is the only profile without a limit\. One has to stay that way/)).toBeInTheDocument()
    expect(limitOf('Kid')).toBeEnabled()
  })

  it.each([
    ['last_unrestricted_profile', 409, /One profile has to stay without a limit/, true],
    ['profile_changed', 409, /changed on another device a moment ago\. The list has been reloaded/, true],
    ['profile_restricted', 403, /has a content limit, so it cannot change this\. Switch to a profile without a limit first/, true],
    ['session_unbound', 409, /cannot hold a profile yet\. Reload the page/, false],
  ])('says a %s refusal in plain words under the row, not the server\'s', async (reason, status, words, reloads) => {
    const changed = await open()
    api.updateProfile.mockRejectedValue(refusal(reason, status))
    api.listProfiles.mockClear()
    pick('Kid', 'TV-G')
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save limit for Kid' }))
    const alert = await rowOf('Kid').findByRole('alert')
    await waitFor(() => expect(alert).toHaveTextContent(words))
    expect(screen.queryByText('server words')).toBeNull()
    // The row shows what the server still has.
    await waitFor(() => expect(limitOf('Kid')).toHaveValue('PG'))
    // A refusal that means this list is out of date reads it again (after
    // the one read every Save starts with), and tells the app, whose copy
    // says what this session may do.
    await waitFor(() => expect(api.listProfiles).toHaveBeenCalledTimes(reloads ? 2 : 1))
    expect(changed).toHaveBeenCalledTimes(reloads ? 1 : 0)
  })

  it('says a profile deleted on another device is gone, and reloads', async () => {
    await open()
    api.updateProfile.mockRejectedValue(new APIError(404, 'profile not found', { error: { code: 404, message: 'profile not found' } }))
    api.listProfiles.mockClear()
    pick('Kid', 'TV-G')
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save limit for Kid' }))
    await waitFor(() => expect(rowOf('Kid').getByRole('alert')).toHaveTextContent('Kid was deleted on another device. The list has been reloaded.'))
    await waitFor(() => expect(api.listProfiles).toHaveBeenCalledTimes(2))
  })

  it('offers the way to sign in again when the server says this device was signed out', async () => {
    const onSignInAgain = vi.fn()
    render(<ProfilesPane actingProfile={parent} profileKnown onSignInAgain={onSignInAgain} />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    api.updateProfile.mockRejectedValue(refusal('session_ended', 401))
    pick('Kid', 'TV-G')
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save limit for Kid' }))
    const alert = await rowOf('Kid').findByRole('alert')
    await waitFor(() => expect(alert).toHaveTextContent(/This device has been signed out/))
    fireEvent.click(within(alert).getByRole('button', { name: 'Sign in again' }))
    expect(onSignInAgain).toHaveBeenCalledTimes(1)
  })

  it('sets a first PIN with nothing to confirm, and says who is signed out by it', async () => {
    await open()
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Set a PIN for Sam' }))
    expect(rowOf('Sam').getByText(/signs out the account’s other devices that are using this profile; they sign in again/)).toBeInTheDocument()
    const field = rowOf('Sam').getByLabelText('PIN for Sam, four digits')
    fireEvent.change(field, { target: { value: '12a3' } })
    expect(field).toHaveValue('123')
    expect(rowOf('Sam').getByRole('button', { name: 'Set PIN' })).toBeDisabled()
    fireEvent.change(field, { target: { value: '1234' } })
    api.listProfiles.mockResolvedValue([parent, kid, { ...sam, has_pin: true }])
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Set PIN' }))
    await waitFor(() => expect(api.setProfilePin).toHaveBeenCalledWith(3, '1234'))
    // The form closes; the button that opened it has the focus, under the
    // name it has now.
    await waitFor(() => expect(rowOf('Sam').getByRole('button', { name: 'Change PIN for Sam' })).toHaveFocus())
    expect(rowOf('Sam').queryByLabelText(/PIN for Sam, four digits/)).toBeNull()
  })

  // Another device set a PIN first: the row said "no PIN", so it has no
  // field for the one the server now asks for.
  it('says what happened when a first PIN races one set on another device', async () => {
    await open()
    api.setProfilePin.mockRejectedValue(refusal('profile_pin_required', 403))
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Set a PIN for Sam' }))
    fireEvent.change(rowOf('Sam').getByLabelText('PIN for Sam, four digits'), { target: { value: '1234' } })
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Set PIN' }))
    await waitFor(() => expect(rowOf('Sam').getByRole('alert')).toHaveTextContent('Another device set a PIN on Sam a moment ago, so this one was not set. The row has been reloaded: change the PIN with that one, or with the account password.'))
  })

  it('says the default profile\'s PIN also signs out the devices that never picked a profile', async () => {
    await open(sam)
    fireEvent.click(rowOf('Parent').getByRole('button', { name: 'Set a PIN for Parent' }))
    expect(rowOf('Parent').getByText(/using this profile, and those that never picked one; they sign in again/)).toBeInTheDocument()
  })

  it('changes or removes an existing PIN only with the current PIN or the password', async () => {
    api.listProfiles.mockResolvedValue([parent, kid, { ...sam, has_pin: true }])
    await open()
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Change PIN for Sam' }))
    fireEvent.change(rowOf('Sam').getByLabelText('New PIN for Sam, four digits'), { target: { value: '4321' } })
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Change PIN' }))
    expect(api.setProfilePin).not.toHaveBeenCalled()
    const prompt = await screen.findByRole('dialog', { name: 'Change the PIN for Sam' })
    fireEvent.change(within(prompt).getByLabelText('Profile PIN'), { target: { value: '1111' } })
    await waitFor(() => expect(api.setProfilePin).toHaveBeenCalledWith(3, '4321', { pin: '1111' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change the PIN for Sam' })).toBeNull())
    // The prompt and the form behind it are both gone: the row's PIN button
    // takes the focus.
    await waitFor(() => expect(rowOf('Sam').getByRole('button', { name: 'Change PIN for Sam' })).toHaveFocus())

    api.setProfilePin.mockClear()
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Change PIN for Sam' }))
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Remove PIN' }))
    const remove = await screen.findByRole('dialog', { name: 'Remove the PIN from Sam' })
    fireEvent.change(within(remove).getByLabelText('Profile PIN'), { target: { value: '1111' } })
    await waitFor(() => expect(api.setProfilePin).toHaveBeenCalledWith(3, '', { pin: '1111' }))
  })

  // A lockout says how long, from the server's Retry-After.
  it('words a refused confirmation inside the prompt, with the wait a lockout gives', async () => {
    api.listProfiles.mockResolvedValue([parent, kid, { ...sam, has_pin: true }])
    await open()
    api.setProfilePin.mockRejectedValue(refusal('profile_pin_locked', 429, 540))
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Change PIN for Sam' }))
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Remove PIN' }))
    const prompt = await screen.findByRole('dialog', { name: 'Remove the PIN from Sam' })
    fireEvent.change(within(prompt).getByLabelText('Profile PIN'), { target: { value: '0000' } })
    expect(await within(prompt).findByText('Too many wrong attempts. Try again in about 9 minutes.')).toBeInTheDocument()
  })

  // A profile with a limit can switch into an unlocked profile and so out of
  // its limit; the page names the profiles that leave that door open.
  it('warns about the unlocked profiles a limited profile could switch into', async () => {
    await open()
    expect(screen.getByText(/Parent and Sam have no PIN\./)).toBeInTheDocument()
    expect(screen.getByText(/A profile with a limit can switch to them without one/)).toBeInTheDocument()
  })
  it('does not warn when every profile a limited one could switch into is locked', async () => {
    api.listProfiles.mockResolvedValue([{ ...parent, has_pin: true }, kid, { ...sam, has_pin: true }])
    render(<ProfilesPane actingProfile={parent} profileKnown />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(screen.queryByText(/no PIN\./)).toBeNull()
  })

  it('makes an unlocked profile the default directly, and a locked one only through its PIN or the password', async () => {
    api.listProfiles.mockResolvedValue([parent, kid, sam, profile(4, { name: 'Lee', has_pin: true })])
    render(<ProfilesPane actingProfile={parent} profileKnown />)
    await waitFor(() => expect(rows()).toHaveLength(4))
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Edit Sam' }))
    const makeSam = rowOf('Sam').getByRole('button', { name: 'Make Sam the default' })
    makeSam.focus()
    fireEvent.click(makeSam)
    await waitFor(() => expect(api.setDefaultProfile).toHaveBeenCalledWith(3))
    // The pressed button is still there to hold the focus.
    await act(async () => {})
    expect(makeSam).toHaveFocus()
    expect(makeSam).not.toBeDisabled()

    api.setDefaultProfile.mockClear()
    fireEvent.click(rowOf('Lee').getByRole('button', { name: 'Edit Lee' }))
    fireEvent.click(rowOf('Lee').getByRole('button', { name: 'Make Lee the default' }))
    expect(api.setDefaultProfile).not.toHaveBeenCalled()
    const prompt = await screen.findByRole('dialog', { name: 'Make Lee the default' })
    fireEvent.click(within(prompt).getByRole('button', { name: /Use the account password/ }))
    fireEvent.change(within(prompt).getByLabelText('Account password'), { target: { value: 'hunter22' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Make default' }))
    await waitFor(() => expect(api.setDefaultProfile).toHaveBeenCalledWith(4, { password: 'hunter22' }))
    // The default itself has nothing to make: its button is off (and says
    // why), and a press sends nothing.
    api.setDefaultProfile.mockClear()
    fireEvent.click(rowOf('Parent').getByRole('button', { name: 'Edit Parent' }))
    const isDefault = rowOf('Parent').getByRole('button', { name: 'Make Parent the default' })
    expect(isDefault).toHaveAttribute('aria-disabled', 'true')
    expect(isDefault).toHaveAccessibleDescription('Parent is the default: the profile a new sign-in with the password starts on.')
    fireEvent.click(isDefault)
    expect(api.setDefaultProfile).not.toHaveBeenCalled()
  })

  // What a new default does beyond the obvious is said before the press.
  it('says what making a limited profile the default means, and what a locked one does on an account with no default', async () => {
    await open()
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Edit Kid' }))
    expect(rowOf('Kid').getByText(/Kid has a limit, so those sign-ins would start limited\./)).toBeInTheDocument()
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Edit Sam' }))
    expect(rowOf('Sam').queryByText(/would start limited/)).toBeNull()
    expect(rowOf('Sam').queryByText(/no default yet/)).toBeNull()
  })
  it('says a locked profile made the default on an account with none signs out the devices that never picked one', async () => {
    api.listProfiles.mockResolvedValue([{ ...parent, is_default: false }, kid, { ...sam, has_pin: true }])
    render(<ProfilesPane actingProfile={parent} profileKnown />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Edit Sam' }))
    expect(rowOf('Sam').getByText(/This account has no default yet, so devices that never picked a profile will be signed out\./)).toBeInTheDocument()
  })

  it('deletes a profile only through a dialog that says what goes with it, and gives focus back when it is cancelled', async () => {
    await open()
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Edit Kid' }))
    const del = rowOf('Kid').getByRole('button', { name: 'Delete Kid' })
    del.focus()
    fireEvent.click(del)
    expect(api.deleteProfile).not.toHaveBeenCalled()
    expect(within(confirm()).getByRole('heading', { name: 'Delete Kid?' })).toBeInTheDocument()
    expect(confirm()).toHaveTextContent('The watch history, lists, ratings and picks of Kid are deleted with it, and the devices using it are signed out. This cannot be undone.')
    // Focus is in the dialog, on the answer that changes nothing, and the
    // button that opened it is still there to take it back.
    expect(within(confirm()).getByRole('button', { name: 'Keep Kid' })).toHaveFocus()
    fireEvent.click(within(confirm()).getByRole('button', { name: 'Keep Kid' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(rowOf('Kid').getByRole('button', { name: 'Delete Kid' })).toHaveFocus())
    expect(api.deleteProfile).not.toHaveBeenCalled()

    // Confirmed: the profile goes, its row with it, and the page's heading
    // takes the focus the row's button had.
    api.listProfiles.mockResolvedValue([parent, sam])
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Delete Kid' }))
    fireEvent.click(within(confirm()).getByRole('button', { name: 'Delete Kid' }))
    await waitFor(() => expect(api.deleteProfile).toHaveBeenCalledWith(2))
    expect(api.deleteProfile).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(rows()).toHaveLength(2))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Profiles and parental controls' })).toHaveFocus())
  })

  // "Delete Sam?" is up when another tab switches this session to Sam.
  // Confirming would now delete the profile this device acts as, and the
  // server does not refuse that. The question is withdrawn.
  it('withdraws a delete question when the session starts watching as that profile', async () => {
    const view = render(<ProfilesPane actingProfile={parent} profileKnown onToast={vi.fn()} />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Edit Sam' }))
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Delete Sam' }))
    expect(within(confirm()).getByRole('heading', { name: 'Delete Sam?' })).toBeInTheDocument()
    view.rerender(<ProfilesPane actingProfile={sam} profileKnown onToast={vi.fn()} />)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.deleteProfile).not.toHaveBeenCalled()
    // And its row no longer offers the delete.
    await waitFor(() => expect(rowOf('Sam').getByRole('button', { name: 'Delete Sam' })).toBeDisabled())
  })
  it('withdraws a delete question when the session gets a limit', async () => {
    const view = render(<ProfilesPane actingProfile={parent} profileKnown onToast={vi.fn()} />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Edit Sam' }))
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Delete Sam' }))
    expect(confirm()).toBeInTheDocument()
    view.rerender(<ProfilesPane actingProfile={{ ...parent, max_age_rating: 'TV-PG' }} profileKnown onToast={vi.fn()} />)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.deleteProfile).not.toHaveBeenCalled()
  })

  // Deleting the default is refused by the server; deleting the profile the
  // session acts as would end this session with it.
  it('does not offer to delete the default profile or the one being watched as', async () => {
    await open(sam)
    fireEvent.click(rowOf('Parent').getByRole('button', { name: 'Edit Parent' }))
    expect(rowOf('Parent').getByRole('button', { name: 'Delete Parent' })).toBeDisabled()
    expect(rowOf('Parent').getByText(/The default profile cannot be deleted/)).toBeInTheDocument()
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Edit Sam' }))
    expect(rowOf('Sam').getByRole('button', { name: 'Delete Sam' })).toBeDisabled()
    expect(rowOf('Sam').getByText(/You are watching as Sam\. Switch to another profile to delete this one/)).toBeInTheDocument()
  })

  it('renames a profile, and changes its avatar and lean, through the panel', async () => {
    await open()
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Edit Kid' }))
    fireEvent.change(rowOf('Kid').getByRole('textbox', { name: 'Name' }), { target: { value: '  Robin ' } })
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith(2, { name: 'Robin' }))

    const avatars = rowOf('Kid').getByRole('radiogroup', { name: 'Avatar for Kid' })
    fireEvent.click(within(avatars).getAllByRole('radio')[2])
    await waitFor(() => expect(api.updateProfile).toHaveBeenLastCalledWith(2, { avatar_url: expect.stringMatching(/^nebula:/) }))

    fireEvent.click(within(rowOf('Kid').getByRole('radiogroup', { name: /lean towards/ })).getByRole('radio', { name: /Family/ }))
    await waitFor(() => expect(api.setProfileMaturity).toHaveBeenCalledWith(2, 0))
  })

  // The server counts a name's bytes, 100 at most.
  it('does not send a name the server would refuse for its length in bytes', async () => {
    await open()
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Edit Kid' }))
    const field = rowOf('Kid').getByRole('textbox', { name: 'Name' })
    const save = rowOf('Kid').getByRole('button', { name: 'Save name' })
    fireEvent.change(field, { target: { value: 'é'.repeat(51) } })
    expect(save).toHaveAttribute('aria-disabled', 'true')
    expect(rowOf('Kid').getByText('That name is too long. Shorten it a little.')).toBeInTheDocument()
    fireEvent.click(save)
    fireEvent.submit(field.closest('form')!)
    expect(api.updateProfile).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: 'é'.repeat(50) } })
    expect(save).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(save)
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith(2, { name: 'é'.repeat(50) }))
  })

  it('loads a profile\'s lists when its panel opens, makes one, and deletes one only through a dialog', async () => {
    api.listWatchlists.mockResolvedValue([{ id: 7, profile_id: 3, name: 'Rainy days', created_at: '' }])
    await open()
    expect(listsAskedFor()).toEqual([])
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Edit Sam' }))
    await waitFor(() => expect(listsAskedFor()).toEqual([3]))
    expect(await rowOf('Sam').findByText('Rainy days')).toBeInTheDocument()

    fireEvent.change(rowOf('Sam').getByLabelText('New list for Sam'), { target: { value: ' Scary ' } })
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Add list' }))
    await waitFor(() => expect(api.createWatchlist).toHaveBeenCalledWith(3, 'Scary'))

    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Delete the list Rainy days' }))
    expect(api.deleteWatchlist).not.toHaveBeenCalled()
    expect(within(confirm()).getByRole('heading', { name: 'Delete the list “Rainy days”?' })).toBeInTheDocument()
    expect(confirm()).toHaveTextContent('The list and what Sam saved in it are deleted. The titles themselves stay on the server.')
    fireEvent.click(within(confirm()).getByRole('button', { name: 'Keep it' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.deleteWatchlist).not.toHaveBeenCalled()
    // The list is gone when the delete lands, and its button with it: the
    // "Lists" label takes the focus.
    api.listWatchlists.mockResolvedValue([])
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Delete the list Rainy days' }))
    fireEvent.click(within(confirm()).getByRole('button', { name: 'Delete the list' }))
    await waitFor(() => expect(api.deleteWatchlist).toHaveBeenCalledWith(3, 7))
    await waitFor(() => expect(rowOf('Sam').queryByText('Rainy days')).toBeNull())
    await waitFor(() => expect(rowOf('Sam').getByText('Lists')).toHaveFocus())
  })

  // The limit goes with the create, so a child's profile never exists
  // without it.
  it('adds a profile with its limit in the same request', async () => {
    const changed = await open()
    const form = screen.getByRole('form', { name: 'Add a profile' })
    // Off with no name: a press sends nothing.
    const add = within(form).getByRole('button', { name: 'Add profile' })
    expect(add).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(add)
    expect(api.createProfile).not.toHaveBeenCalled()
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: ' Robin ' } })
    fireEvent.change(within(form).getByLabelText('Limit'), { target: { value: 'TV-Y7' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add profile' }))
    await waitFor(() => expect(api.createProfile).toHaveBeenCalledWith('Robin', { max_age_rating: 'TV-Y7' }))
    await waitFor(() => expect(changed).toHaveBeenCalled())
    expect(within(form).getByLabelText('Name')).toHaveValue('')
  })
  it('adds one without a limit by sending none, and keeps the form when the server refuses', async () => {
    await open()
    api.createProfile.mockRejectedValue(new APIError(400, 'maximum number of profiles reached', { error: { code: 400, message: 'maximum number of profiles reached' } }))
    const form = screen.getByRole('form', { name: 'Add a profile' })
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Robin' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add profile' }))
    await waitFor(() => expect(api.createProfile).toHaveBeenCalledWith('Robin', {}))
    // The server words its profile count limit for a log.
    expect(await within(form).findByText('This account has as many profiles as the server allows. Delete one to add another.')).toHaveAttribute('role', 'alert')
    expect(within(form).getByLabelText('Name')).toHaveValue('Robin')
  })

  // The server refuses a limit on an account's first profile: an account
  // whose only profile is limited has nobody who can manage profiles.
  it('offers no limit for an account\'s first profile, and says why', async () => {
    api.listProfiles.mockResolvedValue([])
    render(<ProfilesPane actingProfile={null} profileKnown />)
    const form = await screen.findByRole('form', { name: 'Add a profile' })
    expect(within(form).queryByLabelText('Limit')).toBeNull()
    expect(form).toHaveTextContent('The first profile has no limit, so that someone can manage the others.')
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Morgan' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add profile' }))
    await waitFor(() => expect(api.createProfile).toHaveBeenCalledWith('Morgan', {}))
  })

  it('words the other refusals of adding a profile', () => {
    expect(addProfileRefusal(refusal('profile_restricted', 403))).toMatch(/content limit, so it cannot change this/)
    expect(addProfileRefusal(new APIError(400, 'name is required (max 100 characters)', null))).toBe('name is required (max 100 characters)')
    expect(addProfileRefusal(new TypeError(''))).toBe('The profile could not be added.')
  })
})
