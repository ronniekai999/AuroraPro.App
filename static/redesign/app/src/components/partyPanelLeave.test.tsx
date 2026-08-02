// @vitest-environment jsdom
//
// Host succession (2026-08) — the PartyPanel side of "a party survives
// its host leaving". The server hands the party to the most senior
// remaining watcher on a host leave (promoteSuccessorLocked); the
// panel's job is to offer the right choices:
//
//   - host with an eligible successor → button says "Leave Party", and
//     the dialog offers "Hand off & leave" (plain onLeave — the server
//     does the promoting) vs "End for everyone" (onEndParty → the
//     deliberate POST /end).
//   - host with NO eligible successor (alone, or only phone companions,
//     who can't inherit — no player) → the historical "End the party?"
//     confirm, because their leave really does end it.
//   - guest → silent leave, no dialog. Unchanged.

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PartyPanel } from './PartyPanel'
import type { PartyState } from '@/hooks/useParty'
import type { PartyParticipant } from '@/lib/party'

const HOST: PartyParticipant = {
  user_id: 1, username: 'miles', is_host: true, is_buffering: false, last_seen: '', ready: true,
}
const GUEST: PartyParticipant = {
  user_id: 2, username: 'ron', is_host: false, is_buffering: false, last_seen: '', ready: true,
}
const PHONE: PartyParticipant = {
  user_id: 3, username: 'javon', is_host: false, is_buffering: false, last_seen: '', ready: false,
  companion: true,
}

const baseState = (participants: PartyParticipant[]): PartyState => ({
  joining: false,
  code: 'AH2T5Y',
  partyName: "miles's Party",
  mediaTitle: 'The Haunted Mansion',
  hostUserId: 1,
  participants,
  chat: [],
  recentReactions: [],
  isPlaying: true,
  currentTimeMs: 0,
  hlsStartSec: 0,
  rev: 0,
  roomConnected: true,
  syncConnected: true,
  reconnecting: false,
  syncReconnecting: false,
  error: null,
})

const renderPanel = (opts: {
  participants: PartyParticipant[]
  currentUserId: number
  onLeave?: () => void
  onEndParty?: () => void
}) =>
  render(
    <PartyPanel
      state={baseState(opts.participants)}
      currentUserId={opts.currentUserId}
      onSendChat={() => {}}
      onLeave={opts.onLeave ?? (() => {})}
      onClose={() => {}}
      onEndParty={opts.onEndParty}
    />,
  )

describe('host with an eligible successor', () => {
  it('labels the action "Leave Party" — leaving no longer ends the show', () => {
    renderPanel({ participants: [HOST, GUEST], currentUserId: 1 })
    expect(screen.getByRole('button', { name: 'Leave Party' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'End Party' })).toBeNull()
  })

  it('offers hand-off vs end-for-everyone, wired to the right callbacks', async () => {
    const user = userEvent.setup()
    const onLeave = vi.fn()
    const onEndParty = vi.fn()
    renderPanel({ participants: [HOST, GUEST], currentUserId: 1, onLeave, onEndParty })

    await user.click(screen.getByRole('button', { name: 'Leave Party' }))
    // Hand-off is a plain leave — the SERVER promotes; the client must
    // not pretend to know the successor.
    await user.click(screen.getByRole('button', { name: 'Hand off & leave' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(onEndParty).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Leave Party' }))
    await user.click(screen.getByRole('button', { name: 'End for everyone' }))
    expect(onEndParty).toHaveBeenCalledTimes(1)
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('omits "End for everyone" when the parent did not wire onEndParty', async () => {
    const user = userEvent.setup()
    renderPanel({ participants: [HOST, GUEST], currentUserId: 1 })
    await user.click(screen.getByRole('button', { name: 'Leave Party' }))
    expect(screen.getByRole('button', { name: 'Hand off & leave' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'End for everyone' })).toBeNull()
  })
})

describe('host with no eligible successor', () => {
  it('keeps the historical end-confirm when only companions remain', async () => {
    // A phone companion can't inherit the party (no player, no sync
    // socket — the server's rule), so this host's leave still ends it
    // and the UI must say so, not promise a hand-off.
    const user = userEvent.setup()
    const onLeave = vi.fn()
    renderPanel({ participants: [HOST, PHONE], currentUserId: 1, onLeave })

    await user.click(screen.getByRole('button', { name: 'End Party' }))
    expect(screen.queryByRole('button', { name: 'Hand off & leave' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'End party' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('keeps the historical end-confirm for a lone host', async () => {
    const user = userEvent.setup()
    renderPanel({ participants: [HOST], currentUserId: 1 })
    await user.click(screen.getByRole('button', { name: 'End Party' }))
    expect(screen.queryByRole('button', { name: 'Hand off & leave' })).toBeNull()
    expect(screen.getByRole('button', { name: 'End party' })).toBeInTheDocument()
  })
})

describe('guest', () => {
  it('leaves silently — no dialog, callback fires directly', async () => {
    const user = userEvent.setup()
    const onLeave = vi.fn()
    renderPanel({ participants: [HOST, GUEST], currentUserId: 2, onLeave })
    await user.click(screen.getByRole('button', { name: 'Leave Party' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Hand off & leave' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'End for everyone' })).toBeNull()
  })
})
