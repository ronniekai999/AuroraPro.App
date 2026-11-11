// @vitest-environment jsdom
//
// The Together hub's party list: what it says while it loads, and what a
// refused join says.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import TogetherView, { type TogetherViewProps } from './TogetherView'
import type { ActiveParty } from '@/lib/api'

const party = (over: Partial<ActiveParty> = {}): ActiveParty => ({
  code: 'MOON42', host_user_id: 2, party_name: 'Friday crew', media_title: 'Night Train', media_poster: '',
  participant_count: 3, max_participants: 0, is_playing: true, started_at: '2026-11-11T17:20:00Z', ...over,
})
const props = (over: Partial<TogetherViewProps> = {}): TogetherViewProps => ({
  currentUserId: 1, activeParties: [], partiesLoaded: true, partiesFailed: false, invites: [], inPartyCode: null,
  onOpenPartyPanel: () => {}, onJoinParty: async () => ({ ok: true }), onJoinByCode: () => {}, onRsvp: () => {},
  onRefreshInvites: () => {}, onOpenMembers: () => {}, onOpenMember: () => {}, onBrowse: () => {}, ...over,
})

afterEach(cleanup)

describe('joining a party from the list', () => {
  it('says why when the server refuses, under the party it was for', async () => {
    const onJoinParty = vi.fn(async () => ({ ok: false, error: 'This party is full.' }))
    render(<TogetherView {...props({ activeParties: [party(), party({ code: 'OTHER1', party_name: 'Other' })], onJoinParty })} />)
    const row = screen.getByText('Friday crew').closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'Join' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('This party is full.')
    expect(row.contains(alert)).toBe(true)
    expect(onJoinParty).toHaveBeenCalledWith('MOON42')
    // The button is usable again.
    expect(within(row).getByRole('button', { name: 'Join' })).not.toBeDisabled()
  })

  it('says something even when the refusal carries no reason, or the join throws', async () => {
    const onJoinParty = vi.fn<TogetherViewProps['onJoinParty']>().mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error('offline'))
    render(<TogetherView {...props({ activeParties: [party()], onJoinParty })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Could not join the party. Try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    await waitFor(() => expect(onJoinParty).toHaveBeenCalledTimes(2))
    expect((await screen.findByRole('alert')).textContent).toBe('Could not join the party. Try again.')
  })

  it('says nothing when the join works, and clears an earlier refusal when another is tried', async () => {
    const onJoinParty = vi.fn<TogetherViewProps['onJoinParty']>().mockResolvedValueOnce({ ok: false, error: 'Full.' }).mockResolvedValueOnce({ ok: true })
    render(<TogetherView {...props({ activeParties: [party()], onJoinParty })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
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
    expect(status.textContent).toBe('1 watch party listed.')
    // Read out, not drawn: the list itself is on screen.
    expect(status.className).toBe('sr-only')
    rerender(<TogetherView {...props({ partiesLoaded: false, partiesFailed: true })} />)
    expect(document.querySelector('[data-party-status]')).toBe(status)
    expect(status.textContent).toBe('Couldn’t load watch parties. Trying again…')
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })
})
