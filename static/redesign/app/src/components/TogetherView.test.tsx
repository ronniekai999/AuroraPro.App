// @vitest-environment jsdom
//
// The Together hub's party list: what it says while it loads, and what a
// refused join says.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import TogetherView, { watchedAgo, type TogetherViewProps } from './TogetherView'
import { APIError, type ActiveParty, type MyPartyInvite } from '@/lib/api'
import { cacheLastParty, readLastParty } from '@/lib/lastParty'

// The page's own requests: the viewer's rooms and what the people they
// follow finished.
const api = vi.hoisted(() => ({ listRooms: vi.fn(), createRoom: vi.fn(), getFollowingRecent: vi.fn(), listMembers: vi.fn() }))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))
beforeEach(() => {
  localStorage.clear()
  api.listRooms.mockReset().mockResolvedValue([])
  api.createRoom.mockReset()
  api.getFollowingRecent.mockReset().mockResolvedValue([])
  api.listMembers.mockReset().mockResolvedValue([])
})

const party = (over: Partial<ActiveParty> = {}): ActiveParty => ({
  code: 'MOON42', host_user_id: 2, party_name: 'Friday crew', media_title: 'Night Train', media_poster: '',
  participant_count: 3, max_participants: 0, is_playing: true, started_at: '2026-11-11T17:20:00Z', ...over,
})
const props = (over: Partial<TogetherViewProps> = {}): TogetherViewProps => ({
  currentUserId: 1, activeParties: [], partiesLoaded: true, partiesFailed: false, invites: [], inPartyCode: null,
  onOpenPartyPanel: () => {}, onJoinParty: async () => ({ ok: true }), onRsvp: () => {},
  onRefreshInvites: () => {}, onOpenMembers: () => {}, onOpenMember: () => {}, onBrowse: () => {}, ...over,
})

afterEach(cleanup)

/** A party's row in the lists. */
const partyRowOf = (code: string) => document.querySelector(`[data-party="${code}"], [data-hosting="${code}"]`) as HTMLElement

describe('joining a party from the list', () => {
  it('says why when the join is refused, above the list, naming the party', async () => {
    const onJoinParty = vi.fn(async () => ({ ok: false, error: 'No party is using that code right now.', reason: 'http_404' }))
    render(<TogetherView {...props({ activeParties: [party(), party({ code: 'OTHER1', party_name: 'Other' })], onJoinParty })} />)
    const row = partyRowOf('MOON42')
    // Each row's button says which party it is for.
    const button = within(row).getByRole('button', { name: 'Join Friday crew' })
    button.focus()
    fireEvent.click(button)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Couldn’t join Friday crew: No party is using that code right now.')
    expect(alert.getAttribute('data-join-error')).toBe('MOON42')
    expect(onJoinParty).toHaveBeenCalledWith('MOON42')
    // Not in the party's row: the next poll takes an ended party's row away.
    expect(row.contains(alert)).toBe(false)
    expect(alert.closest('ul')).toBeNull()
    // The button is usable again, and never lost the focus it was pressed with.
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'false')
    expect(button).toHaveFocus()
  })

  // The buttons stay focusable while a join is out, so a second press has to
  // be refused by the page.
  it('sends one join while one is out, and keeps focus on the button that was pressed', async () => {
    let answer!: (r: { ok: boolean }) => void
    const onJoinParty = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { answer = resolve }))
    render(<TogetherView {...props({ activeParties: [party(), party({ code: 'OTHER1', party_name: 'Other' })], onJoinParty })} />)
    const button = screen.getByRole('button', { name: 'Join Friday crew' })
    button.focus()
    fireEvent.click(button)
    expect(button).toHaveTextContent('Joining…')
    expect(button).toHaveFocus()
    expect(button).not.toBeDisabled()
    const other = screen.getByRole('button', { name: 'Join Other' })
    expect(other).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(other)
    fireEvent.click(button)
    expect(onJoinParty).toHaveBeenCalledTimes(1)
    await act(async () => { answer({ ok: true }) })
    expect(button).toHaveFocus()
    // Said for someone who cannot see the party panel open.
    expect(document.querySelector('[data-said]')!.textContent).toBe(' Joined Friday crew.')
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('keeps the message when the party leaves the list', async () => {
    const onJoinParty = vi.fn(async () => ({ ok: false, error: 'No party is using that code right now.', reason: 'http_404' }))
    const { rerender } = render(<TogetherView {...props({ activeParties: [party()], onJoinParty })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Join Friday crew' }))
    await screen.findByRole('alert')
    // The poll that follows no longer lists it.
    rerender(<TogetherView {...props({ activeParties: [], onJoinParty })} />)
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t join Friday crew: No party is using that code right now.')
    expect(document.querySelector('[data-party-status]')!.textContent).toBe('Nobody is watching together right now.')
  })

  it('says something even when the refusal carries no reason, or the join throws', async () => {
    const onJoinParty = vi.fn<TogetherViewProps['onJoinParty']>().mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error('offline'))
    render(<TogetherView {...props({ activeParties: [party()], onJoinParty })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Join Friday crew' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t join Friday crew: Could not join the party. Try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Join Friday crew' }))
    await waitFor(() => expect(onJoinParty).toHaveBeenCalledTimes(2))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t join Friday crew: Could not join the party. Try again.')
  })

  it('says nothing when the join works, and clears an earlier refusal when another is tried', async () => {
    const onJoinParty = vi.fn<TogetherViewProps['onJoinParty']>().mockResolvedValueOnce({ ok: false, error: 'Ended.' }).mockResolvedValueOnce({ ok: true })
    render(<TogetherView {...props({ activeParties: [party()], onJoinParty })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Join Friday crew' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Join Friday crew' }))
    await waitFor(() => expect(onJoinParty).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('what the list says about itself', () => {
  // One polite status region, mounted throughout: a region that is added to
  // the page together with its text is not announced.
  it('uses one status region for loading, empty, listed and failed', () => {
    const { rerender } = render(<TogetherView {...props({ partiesLoaded: false })} />)
    const status = document.querySelector('[data-party-status]')!
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toBe('Looking for parties…')
    rerender(<TogetherView {...props()} />)
    expect(document.querySelector('[data-party-status]')).toBe(status)
    expect(status.textContent).toBe('Nobody is watching together right now.')
    rerender(<TogetherView {...props({ activeParties: [party()] })} />)
    expect(document.querySelector('[data-party-status]')).toBe(status)
    expect(status.textContent).toBe('1 watch party running now.')
    // Read out, not drawn: the list itself is on screen.
    expect(status.className).toBe('sr-only')
    rerender(<TogetherView {...props({ partiesLoaded: false, partiesFailed: true })} />)
    expect(document.querySelector('[data-party-status]')).toBe(status)
    expect(status.textContent).toBe('Couldn’t load watch parties. Trying again…')
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })
})

// What used to be a dialog ("Watch Party": recently in, my rooms, enter a
// code) is on the page.
describe('the ways into a party', () => {
  // On a phone the code field is below every list: a refusal shown above
  // the lists was a screen or more away from the person who typed the code.
  it('joins with a typed code: six letters or digits, upper case, and says a refusal under the field it is about', async () => {
    const onJoinParty = vi.fn<TogetherViewProps['onJoinParty']>().mockResolvedValueOnce({ ok: false, error: 'Invalid party code.' }).mockResolvedValueOnce({ ok: true })
    render(<TogetherView {...props({ activeParties: [party()], onJoinParty })} />)
    const field = screen.getByLabelText('Party code, six letters or digits')
    const submit = screen.getByRole('button', { name: 'Join with this code' })
    fireEvent.change(field, { target: { value: 'ab-1 2' } })
    expect(field).toHaveValue('AB12')
    // Off with fewer than six characters: a press sends nothing.
    expect(submit).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(submit)
    expect(onJoinParty).not.toHaveBeenCalled()
    expect(field).toHaveAttribute('aria-invalid', 'false')
    fireEvent.change(field, { target: { value: 'abc123' } })
    expect(field).toHaveValue('ABC123')
    submit.focus()
    fireEvent.click(submit)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Couldn’t join with that code: Invalid party code.')
    expect(onJoinParty).toHaveBeenCalledWith('ABC123')
    // Beside the field, tied to it, and said once: not also above the lists.
    expect(alert.closest('section')).toBe(field.closest('section'))
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription('Couldn’t join with that code: Invalid party code.')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(document.querySelector('[data-join-error]')).toBeNull()
    // The code stays to be corrected, with the caret in it; a join that
    // works clears it.
    expect(field).toHaveValue('ABC123')
    await waitFor(() => expect(field).toHaveFocus())
    submit.focus()
    fireEvent.click(submit)
    await waitFor(() => expect(field).toHaveValue(''))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(field).toHaveAttribute('aria-invalid', 'false')
    // The pressed button is still there to hold the focus.
    expect(submit).toHaveFocus()
  })

  // A join can take seconds to be refused.
  it('does not pull the caret back to the code field from someone who has moved on', async () => {
    let answer!: (r: { ok: boolean; error?: string }) => void
    const onJoinParty = vi.fn(() => new Promise<{ ok: boolean; error?: string }>(resolve => { answer = resolve }))
    render(<TogetherView {...props({ activeParties: [party()], onJoinParty })} />)
    const field = screen.getByLabelText('Party code, six letters or digits')
    fireEvent.change(field, { target: { value: 'ABC123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join with this code' }))
    const elsewhere = screen.getByRole('button', { name: 'New room' })
    elsewhere.focus()
    await act(async () => { answer({ ok: false, error: 'Invalid party code.' }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid party code.')
    expect(elsewhere).toHaveFocus()
  })

  it('offers the party this browser was just in, for the person who was in it', async () => {
    cacheLastParty({ code: 'LAST01', partyName: 'Friday crew', userId: 1, wasHost: true })
    const onJoinParty = vi.fn(async () => ({ ok: true }))
    const view = render(<TogetherView {...props({ onJoinParty })} />)
    const region = screen.getByRole('region', { name: 'You were just in' })
    expect(region).toHaveTextContent('Friday crew')
    expect(region).toHaveTextContent('LAST01')
    expect(region).toHaveTextContent(/You were its host\. Leaving handed it to whoever had been there longest/)
    fireEvent.click(within(region).getByRole('button', { name: 'Rejoin Friday crew' }))
    await waitFor(() => expect(onJoinParty).toHaveBeenCalledWith('LAST01'))
    view.unmount()
    // Not to someone else signed in on the same browser, and not while in it.
    render(<TogetherView {...props({ currentUserId: 2 })} />)
    expect(screen.queryByRole('region', { name: 'You were just in' })).toBeNull()
    cleanup()
    render(<TogetherView {...props({ inPartyCode: 'LAST01' })} />)
    expect(screen.queryByRole('region', { name: 'You were just in' })).toBeNull()
  })

  // What join returns for a code no party holds now, and for a room with no
  // live party: the page reads the reason, never the words.
  it.each([
    ['ended', { ok: false, error: 'No party is using that code right now.', reason: 'http_404' }],
    ['a room with no live party', { ok: false, error: 'That code is a persistent room; no live session right now.', reason: 'offline_room' }],
    ['a code that is not a code', { ok: false, error: 'Party code must be 6 letters or digits.', reason: 'invalid_code' }],
  ])('stops offering a party that has %s', async (_case, refused) => {
    cacheLastParty({ code: 'LAST01', partyName: 'Friday crew', userId: 1, wasHost: false })
    render(<TogetherView {...props({ onJoinParty: async () => refused })} />)
    fireEvent.click(within(screen.getByRole('region', { name: 'You were just in' })).getByRole('button', { name: 'Rejoin Friday crew' }))
    // Its section goes with the party, so the refusal is said where a
    // row's would be, once.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'You were just in' })).toBeNull())
    expect(screen.getByRole('alert').textContent).toBe(`Couldn’t join Friday crew: ${refused.error}`)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(readLastParty(1)).toBeNull()
  })

  it('says a refusal that leaves the party on offer beside its Rejoin button', async () => {
    cacheLastParty({ code: 'LAST01', partyName: 'Friday crew', userId: 1, wasHost: false })
    render(<TogetherView {...props({ activeParties: [party()], onJoinParty: async () => ({ ok: false, error: 'Could not reach the server. Check the connection and try again.', reason: 'network' }) })} />)
    const region = screen.getByRole('region', { name: 'You were just in' })
    const rejoin = within(region).getByRole('button', { name: 'Rejoin Friday crew' })
    rejoin.focus()
    fireEvent.click(rejoin)
    const alert = await within(region).findByRole('alert')
    expect(alert.textContent).toBe('Couldn’t rejoin: Could not reach the server. Check the connection and try again.')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(document.querySelector('[data-join-error]')).toBeNull()
    expect(rejoin).toHaveFocus()
  })

  // After a Rejoin that works the section is gone (the viewer is in that
  // party): the header's way to the party takes the focus its button had.
  it('moves focus to "Open your party" when a Rejoin works', async () => {
    cacheLastParty({ code: 'LAST01', partyName: 'Friday crew', userId: 1, wasHost: false })
    const onJoinParty = vi.fn(async () => ({ ok: true }))
    const view = render(<TogetherView {...props({ onJoinParty })} />)
    const rejoin = screen.getByRole('button', { name: 'Rejoin Friday crew' })
    rejoin.focus()
    fireEvent.click(rejoin)
    await waitFor(() => expect(onJoinParty).toHaveBeenCalledWith('LAST01'))
    await act(async () => {})
    view.rerender(<TogetherView {...props({ onJoinParty, inPartyCode: 'LAST01' })} />)
    expect(screen.queryByRole('region', { name: 'You were just in' })).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open your party' })).toHaveFocus())
  })

  // Two profiles of one account are two people: one must not be offered
  // the party the other was in.
  it('remembers the last party per profile, and reads nothing kept under the old single key', () => {
    cacheLastParty({ code: 'KIDS01', partyName: 'Cartoons', userId: 1, wasHost: false }, 7)
    const view = render(<TogetherView {...props({ profileId: 7 })} />)
    expect(screen.getByRole('region', { name: 'You were just in' })).toHaveTextContent('Cartoons')
    view.unmount()
    render(<TogetherView {...props({ profileId: 8 })} />)
    expect(screen.queryByRole('region', { name: 'You were just in' })).toBeNull()
    cleanup()
    // A record written before records were kept per profile names none.
    localStorage.clear()
    localStorage.setItem('aurora_last_party', JSON.stringify({ code: 'OLD001', partyName: 'Old', userId: 1, wasHost: false, touchedAt: new Date().toISOString() }))
    render(<TogetherView {...props({ profileId: 7 })} />)
    expect(screen.queryByRole('region', { name: 'You were just in' })).toBeNull()
    expect(readLastParty(1, 7)).toBeNull()
  })

  // The record is written when a party is left. Someone who leaves from
  // this page is offered the way back without reloading it.
  it('offers the party just left without a reload', () => {
    const view = render(<TogetherView {...props({ inPartyCode: 'LIVE01' })} />)
    expect(screen.queryByRole('region', { name: 'You were just in' })).toBeNull()
    cacheLastParty({ code: 'LIVE01', partyName: 'Friday crew', userId: 1, wasHost: false })
    view.rerender(<TogetherView {...props({ inPartyCode: null })} />)
    expect(screen.getByRole('region', { name: 'You were just in' })).toHaveTextContent('Friday crew')
  })

  it('lists the viewer\'s rooms, joins one that is live, and makes a new one', async () => {
    api.listRooms.mockResolvedValue([
      { id: 1, code: 'FRD4YC', name: 'Friday crew', owner_user_id: 1, created_at: '', active_party_code: 'FRD4YC' },
      { id: 2, code: 'H8M2QA', name: 'Family room', owner_user_id: 1, created_at: '' },
    ])
    api.createRoom.mockResolvedValue({ id: 3, code: 'SC7T3N', name: 'Slow cinema', owner_user_id: 1, created_at: '' })
    const onJoinParty = vi.fn(async () => ({ ok: true }))
    render(<TogetherView {...props({ onJoinParty })} />)
    const rooms = within(screen.getByRole('region', { name: 'Your rooms' }))
    const live = (await rooms.findByText('Friday crew', { selector: 'div' })).closest('li')!
    expect(live).toHaveTextContent('FRD4YC · live now')
    expect(rooms.getByText('Family room').closest('li')).toHaveTextContent('H8M2QA · nothing on')
    // Only a room with a party running can be joined.
    expect(rooms.getAllByRole('button', { name: /^Join / })).toHaveLength(1)
    fireEvent.click(within(live).getByRole('button', { name: 'Join Friday crew' }))
    await waitFor(() => expect(onJoinParty).toHaveBeenCalledWith('FRD4YC'))

    fireEvent.click(rooms.getByRole('button', { name: 'New room' }))
    // Off with no name: a press sends nothing.
    expect(rooms.getByRole('button', { name: 'Make room' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(rooms.getByRole('button', { name: 'Make room' }))
    expect(api.createRoom).not.toHaveBeenCalled()
    fireEvent.change(rooms.getByLabelText('Room name'), { target: { value: ' Slow cinema ' } })
    fireEvent.click(rooms.getByRole('button', { name: 'Make room' }))
    await waitFor(() => expect(api.createRoom).toHaveBeenCalledWith({ name: 'Slow cinema' }))
    const made = (await rooms.findByText('Slow cinema')).closest('li')!
    expect(made).toHaveTextContent('SC7T3N')
    expect(rooms.queryByLabelText('Room name')).toBeNull()
    // The form is gone: the new room's row has the focus it held, and the
    // page says what happened.
    await waitFor(() => expect(made).toHaveFocus())
    expect(document.querySelector('[data-said]')!.textContent).toBe(' Room made: Slow cinema.')
  })

  it('says a refused join of a room in that room\'s row', async () => {
    api.listRooms.mockResolvedValue([
      { id: 1, code: 'FRD4YC', name: 'Friday crew', owner_user_id: 1, created_at: '', active_party_code: 'FRD4YC' },
      { id: 2, code: 'H8M2QA', name: 'Family room', owner_user_id: 1, created_at: '', active_party_code: 'H8M2QA' },
    ])
    render(<TogetherView {...props({ activeParties: [party()], onJoinParty: async () => ({ ok: false, error: 'This room is full.' }) })} />)
    const rooms = within(screen.getByRole('region', { name: 'Your rooms' }))
    const join = await rooms.findByRole('button', { name: 'Join Family room' })
    join.focus()
    fireEvent.click(join)
    const alert = await rooms.findByRole('alert')
    expect(alert.textContent).toBe('Couldn’t join: This room is full.')
    expect(alert.closest('li')).toBe(join.closest('li'))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(document.querySelector('[data-join-error]')).toBeNull()
    expect(join).toHaveFocus()
  })

  it('keeps focus on a room\'s row when its party ends and its Join button goes', async () => {
    api.listRooms.mockResolvedValue([{ id: 1, code: 'FRD4YC', name: 'Friday crew', owner_user_id: 1, created_at: '', active_party_code: 'FRD4YC' }])
    const live = party({ code: 'FRD4YC', party_name: 'In the room' })
    const view = render(<TogetherView {...props({ activeParties: [live] })} />)
    const rooms = within(screen.getByRole('region', { name: 'Your rooms' }))
    const join = await rooms.findByRole('button', { name: 'Join Friday crew' })
    join.focus()
    api.listRooms.mockResolvedValue([{ id: 1, code: 'FRD4YC', name: 'Friday crew', owner_user_id: 1, created_at: '' }])
    view.rerender(<TogetherView {...props({ activeParties: [] })} />)
    await waitFor(() => expect(rooms.queryByRole('button', { name: 'Join Friday crew' })).toBeNull())
    const row = rooms.getByText('Friday crew', { selector: 'div' }).closest('li')!
    expect(row).toHaveTextContent('nothing on')
    await waitFor(() => expect(row).toHaveFocus())
  })

  // The row takes the focus only from its own button, at the moment that
  // button goes. It used to be remembered as "the room that last had focus"
  // for good, so at every later change of the party list it took the focus
  // (and on a phone the page with it) from anyone whose focus was on
  // nothing: someone who had tapped the page and gone back up to read.
  it('leaves focus where it is when the person has left a room\'s row before its party ends', async () => {
    api.listRooms.mockResolvedValue([{ id: 1, code: 'FRD4YC', name: 'Friday crew', owner_user_id: 1, created_at: '', active_party_code: 'FRD4YC' }])
    const view = render(<TogetherView {...props({ activeParties: [party({ code: 'FRD4YC', party_name: 'In the room' })] })} />)
    const rooms = within(screen.getByRole('region', { name: 'Your rooms' }))
    const join = await rooms.findByRole('button', { name: 'Join Friday crew' })
    join.focus()
    // A tap on the page: the focus is on nothing.
    join.blur()
    expect(document.body).toHaveFocus()
    api.listRooms.mockResolvedValue([{ id: 1, code: 'FRD4YC', name: 'Friday crew', owner_user_id: 1, created_at: '' }])
    view.rerender(<TogetherView {...props({ activeParties: [] })} />)
    await waitFor(() => expect(rooms.queryByRole('button', { name: 'Join Friday crew' })).toBeNull())
    await act(async () => {})
    expect(document.body).toHaveFocus()

    // The same for a row that held the focus itself, as a room just made
    // does: once left, a later change of the party list does not bring the
    // focus back to it.
    const row = rooms.getByText('Friday crew', { selector: 'div' }).closest('li')!
    row.focus()
    row.blur()
    view.rerender(<TogetherView {...props({ activeParties: [party({ code: 'OTHER1', party_name: 'Elsewhere' })] })} />)
    await waitFor(() => expect(api.listRooms).toHaveBeenCalledTimes(3))
    await act(async () => {})
    expect(document.body).toHaveFocus()
  })

  // Another app or tab took the window's focus: the button gets a blur, but
  // it is still the page's focused element, and the person comes back to it.
  it('hands the focus to the row when the Join button goes while the window is not focused', async () => {
    api.listRooms.mockResolvedValue([{ id: 1, code: 'FRD4YC', name: 'Friday crew', owner_user_id: 1, created_at: '', active_party_code: 'FRD4YC' }])
    const view = render(<TogetherView {...props({ activeParties: [party({ code: 'FRD4YC', party_name: 'In the room' })] })} />)
    const rooms = within(screen.getByRole('region', { name: 'Your rooms' }))
    const join = await rooms.findByRole('button', { name: 'Join Friday crew' })
    join.focus()
    // The blur a window switch sends: the event, with the focus left where
    // it is.
    fireEvent.blur(join)
    expect(join).toHaveFocus()
    await act(async () => {})
    api.listRooms.mockResolvedValue([{ id: 1, code: 'FRD4YC', name: 'Friday crew', owner_user_id: 1, created_at: '' }])
    view.rerender(<TogetherView {...props({ activeParties: [] })} />)
    await waitFor(() => expect(rooms.queryByRole('button', { name: 'Join Friday crew' })).toBeNull())
    const row = rooms.getByText('Friday crew', { selector: 'div' }).closest('li')!
    await waitFor(() => expect(row).toHaveFocus())
  })

  // A room made at once, before the first read of the rooms has answered,
  // is not the person's rooms: when that read fails, it is said.
  it('says the rooms could not be loaded when a room was made before the first read failed', async () => {
    let failRead: (err: Error) => void = () => {}
    api.listRooms.mockImplementationOnce(() => new Promise((_, reject) => { failRead = reject }))
    api.createRoom.mockResolvedValue({ id: 3, code: 'SC7T3N', name: 'Slow cinema', owner_user_id: 1, created_at: '' })
    render(<TogetherView {...props({ activeParties: [] })} />)
    const rooms = within(screen.getByRole('region', { name: 'Your rooms' }))
    fireEvent.click(rooms.getByRole('button', { name: 'New room' }))
    fireEvent.change(rooms.getByLabelText('Room name'), { target: { value: 'Slow cinema' } })
    fireEvent.click(rooms.getByRole('button', { name: 'Make room' }))
    await rooms.findByText('Slow cinema')
    expect(rooms.queryByText('Your rooms could not be loaded.')).toBeNull()
    await act(async () => { failRead(new Error('boom')) })
    expect(rooms.getByText('Your rooms could not be loaded.')).toBeInTheDocument()
    expect(rooms.getByText('Slow cinema')).toBeInTheDocument()
  })

  // "Only the first read failing leaves nothing to show" forgot a room made
  // after that first read failed: the next failed read emptied the list.
  it('keeps a room just made when the rooms could not be read before it and cannot be read after', async () => {
    api.listRooms.mockRejectedValue(new Error('boom'))
    api.createRoom.mockResolvedValue({ id: 3, code: 'SC7T3N', name: 'Slow cinema', owner_user_id: 1, created_at: '' })
    const view = render(<TogetherView {...props({ activeParties: [] })} />)
    const rooms = within(screen.getByRole('region', { name: 'Your rooms' }))
    await rooms.findByText('Your rooms could not be loaded.')
    fireEvent.click(rooms.getByRole('button', { name: 'New room' }))
    fireEvent.change(rooms.getByLabelText('Room name'), { target: { value: 'Slow cinema' } })
    fireEvent.click(rooms.getByRole('button', { name: 'Make room' }))
    await rooms.findByText('Slow cinema')
    view.rerender(<TogetherView {...props({ activeParties: [party()] })} />)
    await waitFor(() => expect(api.listRooms).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(rooms.getByText('Slow cinema')).toBeInTheDocument()
  })

  // "live now" was only as true as the moment the page opened.
  it('reads the rooms again when the parties running change, and not on a poll that brings the same list', async () => {
    api.listRooms.mockResolvedValue([{ id: 1, code: 'FRD4YC', name: 'Friday crew', owner_user_id: 1, created_at: '' }])
    const view = render(<TogetherView {...props({ activeParties: [party()] })} />)
    const rooms = within(screen.getByRole('region', { name: 'Your rooms' }))
    expect((await rooms.findByText('Friday crew')).closest('li')).toHaveTextContent('nothing on')
    expect(api.listRooms).toHaveBeenCalledTimes(1)
    // A poll with the same parties (a new array, as each poll's is).
    view.rerender(<TogetherView {...props({ activeParties: [party()] })} />)
    expect(api.listRooms).toHaveBeenCalledTimes(1)
    // A party starts in the room.
    api.listRooms.mockResolvedValue([{ id: 1, code: 'FRD4YC', name: 'Friday crew', owner_user_id: 1, created_at: '', active_party_code: 'FRD4YC' }])
    view.rerender(<TogetherView {...props({ activeParties: [party(), party({ code: 'FRD4YC', party_name: 'In the room' })] })} />)
    await waitFor(() => expect(api.listRooms).toHaveBeenCalledTimes(2))
    expect(await rooms.findByRole('button', { name: 'Join Friday crew' })).toBeInTheDocument()
    // A reload that fails keeps the rooms it has.
    api.listRooms.mockRejectedValue(new Error('boom'))
    view.rerender(<TogetherView {...props({ activeParties: [party()] })} />)
    await waitFor(() => expect(api.listRooms).toHaveBeenCalledTimes(3))
    await act(async () => {})
    expect(rooms.getByText('Friday crew', { selector: 'div' })).toBeInTheDocument()
    expect(rooms.queryByText('Your rooms could not be loaded.')).toBeNull()
  })

  it('says so when the rooms cannot be loaded or a room cannot be made, and the rest of the page still works', async () => {
    api.listRooms.mockRejectedValue(new Error('boom'))
    api.createRoom.mockRejectedValue(new APIError(400, 'room name too long (max 200 chars)', null))
    render(<TogetherView {...props({ activeParties: [party()] })} />)
    const rooms = within(screen.getByRole('region', { name: 'Your rooms' }))
    expect(await rooms.findByText('Your rooms could not be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Join Friday crew' })).toBeEnabled()
    fireEvent.click(rooms.getByRole('button', { name: 'New room' }))
    const field = rooms.getByLabelText('Room name')
    fireEvent.change(field, { target: { value: 'One more' } })
    field.focus()
    fireEvent.submit(field.closest('form')!)
    // The refusal in the app's words, not the server's.
    // The server counts the name in bytes: the page says what to do.
    expect(await rooms.findByText('That name is too long for a room. Shorten it: accents and emoji count for more than one letter.')).toHaveAttribute('role', 'alert')
    expect(rooms.queryByText(/max 200/)).toBeNull()
    // The name is kept, the field still has the focus (it was never
    // disabled), and the refusal is tied to it.
    expect(field).toHaveValue('One more')
    expect(field).toHaveFocus()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription('That name is too long for a room. Shorten it: accents and emoji count for more than one letter.')
  })
})

// A party can sit unstarted past its planned time (its start was blocked, or
// nobody came): the server keeps it for a while, longer while someone is in
// its lobby, and lists its invitations for as long. Nothing on the page then
// says it is still to come.
describe('a planned start that has passed', () => {
  const ago = new Date(Date.now() - 4 * 60_000).toISOString()
  const ahead = new Date(Date.now() + 7 * 86_400_000).toISOString()

  it('is not given as "Starts" under Coming up', () => {
    const late = party({ code: 'LATE01', party_name: 'Late', scheduled_start_at: ago, started_at: null })
    const later = party({ code: 'LATER1', party_name: 'Later', scheduled_start_at: ahead, started_at: null })
    const answered: MyPartyInvite = { invite_id: 3, party_code: 'LATE01', media_title: 'Night Train', host_username: 'priya', rsvp: 'going', scheduled_start_at: ago, created_at: '' }
    render(<TogetherView {...props({ activeParties: [late, later], invites: [answered] })} />)
    const coming = screen.getByRole('region', { name: 'Coming up' })
    expect(coming.contains(partyRowOf('LATE01'))).toBe(true)
    expect(partyRowOf('LATE01').textContent).toMatch(/Was planned for .+ · \d+:\d\d [AP]M · you’re in/)
    expect(partyRowOf('LATE01').textContent).not.toMatch(/Starts/)
    // One still to come reads as it did.
    expect(partyRowOf('LATER1').textContent).toMatch(/Starts .+ · \d+:\d\d [AP]M/)
    expect(partyRowOf('LATER1').textContent).not.toMatch(/planned/)
  })

  it('nor on a party the viewer is hosting', () => {
    const late = party({ code: 'MINE01', host_user_id: 1, party_name: 'My night', scheduled_start_at: ago, started_at: null })
    const later = party({ code: 'MINE02', host_user_id: 1, party_name: 'My next', scheduled_start_at: ahead, started_at: null })
    render(<TogetherView {...props({ activeParties: [late, later] })} />)
    expect(screen.getByRole('region', { name: 'You are hosting' }).contains(partyRowOf('MINE01'))).toBe(true)
    expect(partyRowOf('MINE01').textContent).toMatch(/Was planned for .+ · \d+:\d\d [AP]M · code MINE01/)
    expect(partyRowOf('MINE01').textContent).not.toMatch(/Starts/)
    expect(partyRowOf('MINE02').textContent).toMatch(/Starts .+ · \d+:\d\d [AP]M · code MINE02/)
    expect(partyRowOf('MINE02').textContent).not.toMatch(/planned/)
  })

  it('nor under an invitation still waiting for a reply', () => {
    const invite = (id: number, title: string, at: string): MyPartyInvite => ({
      invite_id: id, party_code: `INV00${id}`, media_title: title, host_username: 'jonah', rsvp: 'pending', scheduled_start_at: at, started_at: null, created_at: '',
    })
    render(<TogetherView {...props({ invites: [invite(1, 'Kestrel', ago), invite(2, 'Orchard', ahead)] })} />)
    const row = (title: string) => screen.getByText(`jonah invited you to watch ${title}`).closest('li')!
    expect(row('Kestrel').textContent).toMatch(/Was planned for .+ · \d+:\d\d [AP]M/)
    // To come: the time alone.
    expect(row('Orchard').textContent).toMatch(/ · \d+:\d\d [AP]M/)
    expect(row('Orchard').textContent).not.toMatch(/planned|Starts/)
  })
})

describe('the parties the viewer is part of', () => {
  it('lists the viewer\'s own parties apart, with their code, and opens the one they are in', async () => {
    const onJoinParty = vi.fn(async () => ({ ok: true })), onOpenPartyPanel = vi.fn()
    const mine = party({ code: 'MINE01', host_user_id: 1, party_name: 'My night', scheduled_start_at: '2026-11-15T19:30:00Z', started_at: null })
    const view = render(<TogetherView {...props({ activeParties: [party(), mine], onJoinParty, onOpenPartyPanel })} />)
    // Not among other people's parties: the status still counts one.
    expect(document.querySelector('[data-party-status]')!.textContent).toBe('1 watch party running now.')
    const hosting = within(screen.getByRole('region', { name: 'You are hosting' }))
    expect(partyRowOf('MINE01')).toHaveTextContent('code MINE01')
    fireEvent.click(hosting.getByRole('button', { name: 'Open lobby My night' }))
    await waitFor(() => expect(onJoinParty).toHaveBeenCalledWith('MINE01'))
    await act(async () => {})
    view.rerender(<TogetherView {...props({ activeParties: [party(), mine], inPartyCode: 'MINE01', onJoinParty, onOpenPartyPanel })} />)
    fireEvent.click(within(screen.getByRole('region', { name: 'You are hosting' })).getByRole('button', { name: 'Open My night' }))
    expect(onOpenPartyPanel).toHaveBeenCalledTimes(1)
    expect(onJoinParty).toHaveBeenCalledTimes(1)
  })

  // The viewer's own running party is listed under "You are hosting":
  // "Nobody is watching" above it would be wrong about the people in it.
  it('does not say nobody is watching while the viewer hosts a running party', () => {
    const mine = party({ code: 'MINE01', host_user_id: 1, party_name: 'My night', participant_count: 4 })
    render(<TogetherView {...props({ activeParties: [mine] })} />)
    expect(document.querySelector('[data-party-status]')!.textContent).toBe('Nobody else is watching together right now.')
    expect(partyRowOf('MINE01')).toHaveTextContent('Live now · 4 watching · code MINE01')
    // The live dot is up: something is live.
    expect(document.querySelector('[data-live-dot]')).not.toBeNull()
  })

  // The dot beside "Happening now" means live.
  it('shows the live dot only while something is live', () => {
    const later = party({ code: 'LATER1', party_name: 'Later', scheduled_start_at: '2026-11-20T20:00:00Z', started_at: null })
    const view = render(<TogetherView {...props({ activeParties: [later] })} />)
    expect(document.querySelector('[data-live-dot]')).toBeNull()
    view.rerender(<TogetherView {...props({ activeParties: [later, party()] })} />)
    expect(document.querySelector('[data-live-dot]')).not.toBeNull()
  })

  // A party whose host is on the way back has nobody counted.
  it('does not say "0 watching"', () => {
    render(<TogetherView {...props({ activeParties: [
      party({ participant_count: 0 }),
      party({ code: 'MINE01', host_user_id: 1, party_name: 'My night', participant_count: 0 }),
    ] })} />)
    expect(partyRowOf('MOON42')).toHaveTextContent('Live now · Night Train')
    expect(partyRowOf('MOON42')).not.toHaveTextContent('0 watching')
    expect(partyRowOf('MINE01')).toHaveTextContent('Live now · code MINE01')
  })

  // A guest who had not replied, and then inherited the party, would be
  // asked to reply to an invitation to their own party.
  it('lists a party the viewer now hosts once, not also as an invitation to it', () => {
    const mine = party({ code: 'MINE01', host_user_id: 1, party_name: 'My night', scheduled_start_at: '2026-11-15T19:30:00Z', started_at: null })
    const stale: MyPartyInvite = { invite_id: 5, party_code: 'MINE01', media_title: 'Night Train', host_username: 'morgan', rsvp: 'pending', scheduled_start_at: '2026-11-15T19:30:00Z', created_at: '' }
    render(<TogetherView {...props({ activeParties: [mine], invites: [stale] })} />)
    expect(screen.queryByRole('region', { name: 'Invitations' })).toBeNull()
    expect(screen.getByRole('region', { name: 'You are hosting' })).toHaveTextContent('My night')
  })

  it('opens, not joins, a listed party the viewer is already in', () => {
    const onJoinParty = vi.fn(async () => ({ ok: true })), onOpenPartyPanel = vi.fn()
    render(<TogetherView {...props({ activeParties: [party()], inPartyCode: 'MOON42', onJoinParty, onOpenPartyPanel })} />)
    const row = partyRowOf('MOON42')
    expect(within(row).queryByRole('button', { name: /^Join/ })).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'Open Friday crew' }))
    expect(onOpenPartyPanel).toHaveBeenCalledTimes(1)
    expect(onJoinParty).not.toHaveBeenCalled()
  })

  it('puts running parties before the ones still to start, which have a heading of their own', () => {
    // A week from whenever this runs: the line reads "Starts" only while
    // the time is still to come.
    const later = party({ code: 'LATER1', party_name: 'Later', scheduled_start_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), started_at: null })
    render(<TogetherView {...props({ activeParties: [later, party()] })} />)
    expect([...document.querySelectorAll('[data-party]')].map(li => li.getAttribute('data-party'))).toEqual(['MOON42', 'LATER1'])
    const coming = screen.getByRole('region', { name: 'Coming up' })
    expect(coming.contains(document.querySelector('[data-party="LATER1"]'))).toBe(true)
    expect(coming.contains(document.querySelector('[data-party="MOON42"]'))).toBe(false)
    expect(within(coming).getByRole('button', { name: 'Open lobby Later' })).toBeInTheDocument()
    expect(coming).toHaveTextContent(/^Coming upLaterStarts /)
  })

  // A party booked for later is not "happening now": with nothing running,
  // the page says so, and still lists what is coming.
  it('says nobody is watching when the only parties are still to start', () => {
    const later = party({ code: 'LATER1', party_name: 'Later', scheduled_start_at: '2026-11-20T20:00:00Z', started_at: null })
    render(<TogetherView {...props({ activeParties: [later] })} />)
    const status = document.querySelector('[data-party-status]')!
    expect(status.textContent).toBe('Nobody is watching together right now.')
    expect(status.className).not.toBe('sr-only')
    expect(screen.getByRole('region', { name: 'Coming up' }).contains(partyRowOf('LATER1'))).toBe(true)
  })

  // An invited party is also in the list of active parties. Each is on the
  // page once, where its next step is.
  it('shows each party once: an invitation to answer, a booked party already answered, a running party to join', () => {
    const booked = (code: string, name: string) => party({ code, party_name: name, scheduled_start_at: '2026-11-20T20:00:00Z', started_at: null })
    const invite = (id: number, code: string, rsvp: MyPartyInvite['rsvp'], title: string): MyPartyInvite => ({
      invite_id: id, party_code: code, media_title: title, host_username: 'jonah', rsvp, scheduled_start_at: '2026-11-20T20:00:00Z', created_at: '',
    })
    render(<TogetherView {...props({
      activeParties: [party(), booked('ASKED1', 'Asked'), booked('GOING1', 'Going'), booked('MAYBE1', 'Perhaps'), booked('OPEN01', 'Open to all')],
      invites: [
        invite(1, 'ASKED1', 'pending', 'Kestrel'), invite(2, 'GOING1', 'going', 'Wren'), invite(3, 'MAYBE1', 'maybe', 'Low Tide'),
        { ...invite(4, 'MOON42', 'pending', 'Night Train'), started_at: '2026-11-11T17:20:00Z' },
      ],
    })} />)
    // Waiting for an answer: under Invitations, and not also under Coming up.
    const invitations = screen.getByRole('region', { name: 'Invitations' })
    expect(within(invitations).getAllByRole('listitem')).toHaveLength(1)
    expect(invitations).toHaveTextContent('jonah invited you to watch Kestrel')
    const coming = screen.getByRole('region', { name: 'Coming up' })
    expect([...coming.querySelectorAll('[data-party]')].map(li => li.getAttribute('data-party'))).toEqual(['GOING1', 'MAYBE1', 'OPEN01'])
    // Answered: the booked party says what was answered.
    expect(coming.querySelector('[data-party="GOING1"]')).toHaveTextContent(/ · you’re inOpen lobby/)
    expect(coming.querySelector('[data-party="MAYBE1"]')).toHaveTextContent('· you said maybe')
    expect(coming.querySelector('[data-party="OPEN01"]')).not.toHaveTextContent(/you/)
    // Running: the party's own row, which says who asked, with Join.
    const live = partyRowOf('MOON42')
    expect(live).toHaveTextContent('Live now · 3 watching Night Train · jonah invited you')
    expect(within(live).getByRole('button', { name: 'Join Friday crew' })).toBeInTheDocument()
    expect(invitations).not.toHaveTextContent('Night Train')
  })

  it('does not say "invited you" on a running party whose invitation was declined', () => {
    const declined: MyPartyInvite = { invite_id: 4, party_code: 'MOON42', media_title: 'Night Train', host_username: 'jonah', rsvp: 'declined', started_at: '2026-11-11T17:20:00Z', created_at: '' }
    render(<TogetherView {...props({ activeParties: [party()], invites: [declined] })} />)
    expect(partyRowOf('MOON42')).toHaveTextContent('Live now · 3 watching Night Train')
    expect(partyRowOf('MOON42')).not.toHaveTextContent('invited you')
  })

  // The party list can lag the invitation (still loading, failed, a poll
  // behind): the invitation's own `started_at` says the party is running.
  it('says "Live now" on an invitation to a party that has started, even before the party list has it', () => {
    const started: MyPartyInvite = { invite_id: 4, party_code: 'KSTRL1', media_title: 'Kestrel', host_username: 'jonah', rsvp: 'pending', scheduled_start_at: '2026-11-11T17:00:00Z', started_at: '2026-11-11T17:20:00Z', created_at: '' }
    render(<TogetherView {...props({ activeParties: [], invites: [started] })} />)
    const row = document.querySelector('[data-invite="4"]') as HTMLElement
    expect(row).toHaveTextContent('Live now')
    expect(row).not.toHaveTextContent('Starts')
  })

  // Parties are polled; invitations were only asked for when the page
  // opened. One to a party that has ended must not keep its buttons.
  it('asks for the invitations again when the parties change, not on every poll', () => {
    const onRefreshInvites = vi.fn()
    const view = render(<TogetherView {...props({ partiesLoaded: false, onRefreshInvites })} />)
    expect(onRefreshInvites).toHaveBeenCalledTimes(1)
    // The first answer is the starting point, not a change.
    view.rerender(<TogetherView {...props({ activeParties: [party()], onRefreshInvites })} />)
    expect(onRefreshInvites).toHaveBeenCalledTimes(1)
    // A poll that brings the same parties.
    view.rerender(<TogetherView {...props({ activeParties: [party()], onRefreshInvites })} />)
    expect(onRefreshInvites).toHaveBeenCalledTimes(1)
    // The party ends.
    view.rerender(<TogetherView {...props({ activeParties: [], onRefreshInvites })} />)
    expect(onRefreshInvites).toHaveBeenCalledTimes(2)
    // A booked party starts.
    const booked = party({ code: 'LATER1', scheduled_start_at: '2026-11-20T20:00:00Z', started_at: null })
    view.rerender(<TogetherView {...props({ activeParties: [booked], onRefreshInvites })} />)
    expect(onRefreshInvites).toHaveBeenCalledTimes(3)
    view.rerender(<TogetherView {...props({ activeParties: [{ ...booked, started_at: '2026-11-20T20:00:00Z' }], onRefreshInvites })} />)
    expect(onRefreshInvites).toHaveBeenCalledTimes(4)
  })

  it('shows an invitation that needs a reply, with the host\'s note, and sends the reply chosen', () => {
    const onRsvp = vi.fn()
    const invite: MyPartyInvite = {
      invite_id: 7, party_code: 'KSTRL1', media_title: 'Kestrel', host_username: 'jonah', rsvp: 'pending',
      note: 'Bring snacks.', scheduled_start_at: '2026-11-14T20:00:00Z', created_at: '',
    }
    const answered: MyPartyInvite = { ...invite, invite_id: 8, media_title: 'Answered', rsvp: 'going' }
    render(<TogetherView {...props({ invites: [invite, answered], onRsvp })} />)
    const row = screen.getByText('jonah invited you to watch Kestrel').closest('li')!
    expect(row).toHaveTextContent('Reply needed')
    expect(row).toHaveTextContent('“Bring snacks.”')
    const reply = within(within(row).getByRole('group', { name: 'Reply to jonah’s invitation' }))
    fireEvent.click(reply.getByRole('button', { name: 'I’m in' }))
    fireEvent.click(reply.getByRole('button', { name: 'Maybe' }))
    fireEvent.click(reply.getByRole('button', { name: 'Can’t' }))
    expect(onRsvp.mock.calls).toEqual([[7, 'going'], [7, 'maybe'], [7, 'declined']])
    // One already answered is not asked again.
    expect(screen.queryByText(/Answered/)).toBeNull()
  })

  // A reply moves its row, and the pressed button with it. Focus follows
  // the party, and the page says the reply was taken.
  describe('after a reply', () => {
    const booked = (code: string, name: string) => party({ code, party_name: name, scheduled_start_at: '2026-11-20T20:00:00Z', started_at: null })
    const invite = (id: number, code: string, title: string, rsvp: MyPartyInvite['rsvp'] = 'pending'): MyPartyInvite => ({
      invite_id: id, party_code: code, media_title: title, host_username: 'jonah', rsvp, scheduled_start_at: '2026-11-20T20:00:00Z', created_at: '',
    })
    // The app flips the reply at once and re-renders the page with it.
    const answering = (parties: ActiveParty[], invites: MyPartyInvite[]) => {
      let list = invites
      const onRsvp = vi.fn((id: number, rsvp: 'going' | 'maybe' | 'declined') => {
        list = list.map(i => (i.invite_id === id ? { ...i, rsvp } : i))
        view.rerender(<TogetherView {...props({ activeParties: parties, invites: list, onRsvp })} />)
      })
      const view = render(<TogetherView {...props({ activeParties: parties, invites: list, onRsvp })} />)
      return onRsvp
    }
    const press = (inviteId: number, name: string) => {
      const button = within(document.querySelector(`[data-invite="${inviteId}"]`) as HTMLElement).getByRole('button', { name })
      button.focus()
      fireEvent.click(button)
    }
    const said = () => document.querySelector('[data-said]')!.textContent

    it('moves focus to the party\'s row under Coming up, and says "You’re in"', async () => {
      answering([booked('KSTRL1', 'Kestrel night')], [invite(7, 'KSTRL1', 'Kestrel')])
      press(7, 'I’m in')
      expect(screen.queryByRole('region', { name: 'Invitations' })).toBeNull()
      const row = partyRowOf('KSTRL1')
      expect(screen.getByRole('region', { name: 'Coming up' }).contains(row)).toBe(true)
      await waitFor(() => expect(within(row).getByRole('button', { name: 'Open lobby Kestrel night' })).toHaveFocus())
      expect(said()).toBe(' You’re in for Kestrel.')
      expect(screen.getAllByRole('status')).toHaveLength(1)
    })

    it('moves focus to the next invitation when the party is not listed, and says "maybe"', async () => {
      answering([], [invite(7, 'KSTRL1', 'Kestrel'), invite(8, 'WREN01', 'Wren')])
      press(7, 'Maybe')
      await waitFor(() => expect(within(document.querySelector('[data-invite="8"]') as HTMLElement).getByRole('button', { name: 'I’m in' })).toHaveFocus())
      expect(said()).toBe(' You said maybe for Kestrel.')
    })

    it('moves focus to the party\'s row when a declined invitation leaves it listed under Coming up', async () => {
      answering([booked('KSTRL1', 'Kestrel night')], [invite(7, 'KSTRL1', 'Kestrel')])
      press(7, 'Can’t')
      expect(screen.queryByRole('region', { name: 'Invitations' })).toBeNull()
      // Declined: the booked party is listed again for anyone, with its lobby.
      await waitFor(() => expect(within(partyRowOf('KSTRL1')).getByRole('button')).toHaveFocus())
      expect(said()).toBe(' You said you can’t make Kestrel.')
    })

    it('moves focus to the heading when nothing of the party is left on the page', async () => {
      answering([], [invite(7, 'KSTRL1', 'Kestrel')])
      press(7, 'Can’t')
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Happening now' })).toHaveFocus())
    })
  })
})

describe('what the people the viewer follows finished', () => {
  it('lists it with who and when, and opens the title', async () => {
    api.getFollowingRecent.mockResolvedValue([
      { id: 41, title: 'Copper Sky', type: 'movie', watched_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), watched_by: 'Priya', watched_by_username: 'priya' },
    ])
    const onOpenTitle = vi.fn()
    render(<TogetherView {...props({ onOpenTitle })} />)
    const feed = within(await screen.findByRole('region', { name: 'What people you follow finished' }))
    const item = (await feed.findByText('Copper Sky')).closest('button')!
    expect(item).toHaveTextContent('Priya · 3 days ago')
    fireEvent.click(item)
    expect(onOpenTitle).toHaveBeenCalledWith(41)
  })

  it('says what to do when there is nothing yet, and shows nothing at all if the feed cannot be loaded', async () => {
    const onOpenMembers = vi.fn()
    const view = render(<TogetherView {...props({ onOpenMembers })} />)
    const feed = within(await screen.findByRole('region', { name: 'What people you follow finished' }))
    fireEvent.click(feed.getByRole('button', { name: 'Find people' }))
    expect(onOpenMembers).toHaveBeenCalledTimes(1)
    view.unmount()
    // A failed request cannot say "nothing yet".
    api.getFollowingRecent.mockRejectedValue(new Error('boom'))
    render(<TogetherView {...props()} />)
    await waitFor(() => expect(api.getFollowingRecent).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByRole('region', { name: 'What people you follow finished' })).toBeNull()
    expect(screen.queryByText(/Nothing yet/)).toBeNull()
  })

  it('says how long ago in whole words', () => {
    const now = new Date('2026-11-12T12:00:00Z')
    const ago = (days: number) => watchedAgo(new Date(now.getTime() - days * 86_400_000).toISOString(), now)
    expect([ago(0), ago(1), ago(3), ago(7), ago(15)]).toEqual(['today', 'yesterday', '3 days ago', '1 week ago', '2 weeks ago'])
    expect(watchedAgo('not a date', now)).toBe('')
  })
})

// A party's poster is stored as the image's path, not as an address.
describe('a party\'s poster', () => {
  const src = (code: string) => document.querySelector(`[data-party="${code}"] img, [data-hosting="${code}"] img, [data-invite="${code}"] img`)?.getAttribute('src') ?? null
  it('is asked of the image proxy, whether or not the stored path starts with a slash', () => {
    const invite: MyPartyInvite = {
      invite_id: 9, party_code: 'ASKED1', media_title: 'Kestrel', media_poster: '/kestrel.jpg', host_username: 'jonah', rsvp: 'pending',
      scheduled_start_at: '2026-11-20T20:00:00Z', created_at: '',
    }
    render(<TogetherView {...props({
      activeParties: [
        party({ code: 'SLASH1', media_poster: '/abc.jpg' }),
        party({ code: 'BARE01', media_poster: 'def.jpg' }),
        party({ code: 'BOOKD1', media_poster: '/later.jpg', scheduled_start_at: '2026-11-20T20:00:00Z', started_at: null }),
        party({ code: 'MINE01', host_user_id: 1, media_poster: '/mine.jpg' }),
        party({ code: 'NONE01', media_poster: '' }),
      ],
      invites: [invite],
    })} />)
    expect(src('SLASH1')).toBe('/api/images/w154/abc.jpg')
    expect(src('BARE01')).toBe('/api/images/w154/def.jpg')
    expect(src('BOOKD1')).toBe('/api/images/w154/later.jpg')
    expect(src('MINE01')).toBe('/api/images/w154/mine.jpg')
    expect(document.querySelector('[data-invite="9"] img')?.getAttribute('src')).toBe('/api/images/w154/kestrel.jpg')
    // No path: an empty box, and no request for the page itself.
    expect(src('NONE01')).toBeNull()
    expect(document.querySelector('[data-party="NONE01"] [data-no-poster]')).not.toBeNull()
  })
})

describe('the people on this server', () => {
  const member = (id: number, username: string, following = false, display = '') =>
    ({ user_id: id, username, display_name: display, is_following: following })

  it('names a few, the ones followed first, never the viewer, and opens a member\'s page', async () => {
    api.listMembers.mockResolvedValue([
      member(1, 'morgan'), member(2, 'ada'), member(3, 'bo', true, 'Bo B.'), member(4, 'cy'), member(5, 'di', true),
      member(6, 'ed'), member(7, 'flo'), member(8, 'gus'),
    ])
    const onOpenMember = vi.fn(), onOpenMembers = vi.fn()
    render(<TogetherView {...props({ onOpenMember, onOpenMembers })} />)
    const people = within(screen.getByRole('region', { name: 'People on this server' }))
    await people.findByText('Bo B.')
    const rows = people.getAllByRole('listitem')
    expect(rows.map(li => li.getAttribute('data-member'))).toEqual(['bo', 'di', 'ada', 'cy', 'ed'])
    // A person is one button, named by their name and whether they are followed.
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Bo B. Following' }))
    expect(onOpenMember).toHaveBeenCalledWith('bo')
    expect(within(rows[2]).getByRole('button', { name: 'ada' })).toBeInTheDocument()
    // Seven other people, five shown: the button says how many there are.
    fireEvent.click(people.getByRole('button', { name: 'All 7 members' }))
    expect(onOpenMembers).toHaveBeenCalledTimes(1)
  })

  it('still offers the directory when the list is short, empty or cannot be loaded', async () => {
    api.listMembers.mockResolvedValue([member(1, 'morgan'), member(2, 'ada')])
    const view = render(<TogetherView {...props()} />)
    const people = () => within(screen.getByRole('region', { name: 'People on this server' }))
    await people().findByText('ada')
    expect(people().getByRole('button', { name: 'Members' })).toBeInTheDocument()
    view.unmount()
    api.listMembers.mockRejectedValue(new Error('boom'))
    render(<TogetherView {...props()} />)
    await waitFor(() => expect(api.listMembers).toHaveBeenCalledTimes(2))
    expect(people().queryAllByRole('listitem')).toHaveLength(0)
    expect(people().getByRole('button', { name: 'Members' })).toBeInTheDocument()
  })
})

describe('getting to the code field on a narrow screen', () => {
  // There it is below every list. The header's button puts the caret in it.
  it('takes focus to the code field from the header', () => {
    render(<TogetherView {...props({ activeParties: [party()] })} />)
    const button = screen.getByRole('button', { name: 'Enter a code' })
    // Offered only below the width where the field is beside the lists.
    expect(button.className).toContain('lg:hidden')
    fireEvent.click(button)
    expect(screen.getByLabelText('Party code, six letters or digits')).toHaveFocus()
  })
})

describe('the phone companion', () => {
  it('is linked from the code field, at its own address', () => {
    render(<TogetherView {...props()} />)
    const link = screen.getByRole('link', { name: 'the companion' })
    expect(link.getAttribute('href')).toMatch(/\/join$/)
    expect(link.closest('p')).toHaveTextContent('On your phone, the same code opens the companion: the party’s chat, reactions and voice, without the video.')
  })
})
