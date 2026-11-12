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
import { APIError, type Profile } from '@/lib/api'
import { ProfilesPane } from './ProfilesPane'

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

  it('shows every profile with its limit and whether it has a PIN', async () => {
    api.listProfiles.mockResolvedValue([parent, kid, { ...sam, has_pin: true }])
    await open()
    expect(rowOf('Parent').getByRole('combobox', { name: 'Limit for Parent' })).toHaveValue('')
    // A stored limit this page does not offer is still the one shown.
    const kidLimit = rowOf('Kid').getByRole('combobox', { name: 'Limit for Kid' })
    expect(kidLimit).toHaveValue('PG')
    expect(within(kidLimit).getByRole('option', { name: 'Up to PG' })).toBeInTheDocument()
    expect(rowOf('Kid').getByText('No PIN')).toBeInTheDocument()
    expect(rowOf('Sam').getByText('PIN set')).toBeInTheDocument()
    expect(rowOf('Parent').getByText('Default profile · watching now')).toBeInTheDocument()
  })

  it('changes another profile\'s limit, reloads, and tells the app its copy is stale', async () => {
    const changed = await open()
    api.listProfiles.mockClear()
    fireEvent.change(rowOf('Kid').getByRole('combobox', { name: 'Limit for Kid' }), { target: { value: 'TV-14' } })
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith(2, { max_age_rating: 'TV-14' }))
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(api.listProfiles).toHaveBeenCalledTimes(1)
  })

  it('takes a limit off by sending an empty one', async () => {
    await open()
    fireEvent.change(rowOf('Kid').getByRole('combobox', { name: 'Limit for Kid' }), { target: { value: '' } })
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith(2, { max_age_rating: '' }))
  })

  // Limiting the profile this session acts as takes these controls away
  // from it, so nothing is sent until that is confirmed.
  it('asks before limiting the profile being watched as, and sends nothing if cancelled', async () => {
    await open()
    fireEvent.change(rowOf('Parent').getByRole('combobox', { name: 'Limit for Parent' }), { target: { value: 'TV-PG' } })
    expect(screen.getByText(/You are watching as Parent\. With a limit \(up to PG and TV-PG\), this device can no longer manage profiles/)).toBeInTheDocument()
    expect(api.updateProfile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.updateProfile).not.toHaveBeenCalled()
    expect(rowOf('Parent').getByRole('combobox', { name: 'Limit for Parent' })).toHaveValue('')

    fireEvent.change(rowOf('Parent').getByRole('combobox', { name: 'Limit for Parent' }), { target: { value: 'TV-PG' } })
    fireEvent.click(screen.getByRole('button', { name: 'Limit Parent' }))
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith(1, { max_age_rating: 'TV-PG' }))
  })

  // The server refuses to limit or delete the account's last profile without
  // a limit; the page does not offer it, and says why.
  it('does not offer to limit or delete the only profile without a limit', async () => {
    api.listProfiles.mockResolvedValue([parent, kid])
    render(<ProfilesPane actingProfile={parent} profileKnown />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rowOf('Parent').getByRole('combobox', { name: 'Limit for Parent' })).toBeDisabled()
    expect(rowOf('Parent').getByText(/Parent is the only profile without a limit\. One has to stay that way/)).toBeInTheDocument()
    expect(rowOf('Kid').getByRole('combobox', { name: 'Limit for Kid' })).toBeEnabled()
  })

  it.each([
    ['last_unrestricted_profile', /One profile has to stay without a limit/],
    ['profile_changed', /changed on another device a moment ago\. The list has been reloaded/],
    ['profile_restricted', /has a content limit, so it cannot change this\. Switch to a profile without a limit first/],
    ['session_ended', /This device has been signed out\. Sign in again/],
  ])('says a %s refusal in plain words under the row, not the server\'s', async (reason, words) => {
    await open()
    api.updateProfile.mockRejectedValue(refusal(reason, reason === 'session_ended' ? 401 : 409))
    api.listProfiles.mockClear()
    fireEvent.change(rowOf('Kid').getByRole('combobox', { name: 'Limit for Kid' }), { target: { value: 'TV-14' } })
    const alert = await rowOf('Kid').findByText(words)
    expect(alert).toHaveAttribute('role', 'alert')
    expect(screen.queryByText('server words')).toBeNull()
    // The row shows what the server still has.
    expect(rowOf('Kid').getByRole('combobox', { name: 'Limit for Kid' })).toHaveValue('PG')
    // A profile changed elsewhere is read again, so the next try is judged
    // against what is there now.
    await waitFor(() => expect(api.listProfiles).toHaveBeenCalledTimes(reason === 'profile_changed' ? 1 : 0))
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
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Set PIN' }))
    await waitFor(() => expect(api.setProfilePin).toHaveBeenCalledWith(3, '1234'))
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
    const prompt = await screen.findByRole('dialog', { name: 'Change Sam’s PIN' })
    fireEvent.change(within(prompt).getByLabelText('Profile PIN'), { target: { value: '1111' } })
    await waitFor(() => expect(api.setProfilePin).toHaveBeenCalledWith(3, '4321', { pin: '1111' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change Sam’s PIN' })).toBeNull())

    api.setProfilePin.mockClear()
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Change PIN for Sam' }))
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Remove PIN' }))
    const remove = await screen.findByRole('dialog', { name: 'Remove Sam’s PIN' })
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
    const prompt = await screen.findByRole('dialog', { name: 'Remove Sam’s PIN' })
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
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Make Sam the default' }))
    await waitFor(() => expect(api.setDefaultProfile).toHaveBeenCalledWith(3))

    api.setDefaultProfile.mockClear()
    fireEvent.click(rowOf('Lee').getByRole('button', { name: 'Edit Lee' }))
    fireEvent.click(rowOf('Lee').getByRole('button', { name: 'Make Lee the default' }))
    expect(api.setDefaultProfile).not.toHaveBeenCalled()
    const prompt = await screen.findByRole('dialog', { name: 'Make Lee the default' })
    fireEvent.click(within(prompt).getByRole('button', { name: /Use the account password/ }))
    fireEvent.change(within(prompt).getByLabelText('Account password'), { target: { value: 'hunter22' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Make default' }))
    await waitFor(() => expect(api.setDefaultProfile).toHaveBeenCalledWith(4, { password: 'hunter22' }))
    // The default itself has nothing to make.
    fireEvent.click(rowOf('Parent').getByRole('button', { name: 'Edit Parent' }))
    expect(rowOf('Parent').getByRole('button', { name: 'Make Parent the default' })).toBeDisabled()
  })

  it('deletes a profile only after a second press that says what goes with it', async () => {
    await open()
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Edit Kid' }))
    expect(rowOf('Kid').getByText(/Its watch history, lists and picks are deleted with it, and devices using it are signed out\. This cannot be undone/)).toBeInTheDocument()
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Delete Kid' }))
    expect(api.deleteProfile).not.toHaveBeenCalled()
    fireEvent.click(rowOf('Kid').getByRole('button', { name: 'Delete Kid for good' }))
    await waitFor(() => expect(api.deleteProfile).toHaveBeenCalledWith(2))
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

  it('loads a profile\'s lists when its panel opens, makes one and deletes one on a second press', async () => {
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
    fireEvent.click(rowOf('Sam').getByRole('button', { name: 'Delete “Rainy days” and what is in it' }))
    await waitFor(() => expect(api.deleteWatchlist).toHaveBeenCalledWith(3, 7))
  })

  // The limit goes with the create, so a child's profile never exists
  // without it.
  it('adds a profile with its limit in the same request', async () => {
    const changed = await open()
    const form = screen.getByRole('form', { name: 'Add a profile' })
    expect(within(form).getByRole('button', { name: 'Add profile' })).toBeDisabled()
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: ' Robin ' } })
    fireEvent.change(within(form).getByLabelText('Limit'), { target: { value: 'TV-G' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add profile' }))
    await waitFor(() => expect(api.createProfile).toHaveBeenCalledWith('Robin', { max_age_rating: 'TV-G' }))
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
    expect(await within(form).findByText('maximum number of profiles reached')).toHaveAttribute('role', 'alert')
    expect(within(form).getByLabelText('Name')).toHaveValue('Robin')
  })
})
