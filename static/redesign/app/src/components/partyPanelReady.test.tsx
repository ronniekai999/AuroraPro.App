// @vitest-environment jsdom
//
// The host's ready summary must count the same people the server's
// spoiler-free start gate waits for (spoilerGateBlockersLocked in
// internal/watchparty/sync_v3.go). Phone companions have no player and no
// Ready control (useCompanion never sends `ready`), so the server exempts
// them. Counting them here told the host "Waiting on 1 of 2 — javon" for
// the whole lobby while the server would already start the party.

import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PartyPanel } from './PartyPanel'
import type { PartyState } from '@/hooks/useParty'
import type { PartyParticipant } from '@/lib/party'

const HOST: PartyParticipant = {
  user_id: 1, username: 'miles', is_host: true, is_buffering: false, last_seen: '', ready: false,
}
const GUEST: PartyParticipant = {
  user_id: 2, username: 'ron', is_host: false, is_buffering: false, last_seen: '', ready: true,
}
const LATE_GUEST: PartyParticipant = {
  user_id: 4, username: 'ada', is_host: false, is_buffering: false, last_seen: '', ready: false,
}
const PHONE: PartyParticipant = {
  user_id: 3, username: 'javon', is_host: false, is_buffering: false, last_seen: '', ready: false,
  companion: true,
}

const state = (participants: PartyParticipant[]): PartyState => ({
  joining: false,
  code: 'AH2T5Y',
  partyName: "miles's Party",
  mediaTitle: 'The Haunted Mansion',
  hostUserId: 1,
  participants,
  chat: [],
  recentReactions: [],
  isPlaying: false,
  currentTimeMs: 0,
  hlsStartSec: 0,
  rev: 0,
  roomConnected: true,
  syncConnected: true,
  reconnecting: false,
  syncReconnecting: false,
  scheduledStartAt: null,
  startedAt: null,
  error: null,
})

const renderHostPanel = (participants: PartyParticipant[]) =>
  render(
    <PartyPanel
      state={state(participants)}
      currentUserId={1}
      onSendChat={() => {}}
      onLeave={() => {}}
      onClose={() => {}}
      onSendReady={() => {}}
    />,
  )

// The summary is the heading line plus, while anyone is pending, the line of
// names under it; both live in the heading's parent.
const summaryText = (heading: HTMLElement) => heading.parentElement?.textContent ?? ''

it('does not wait on a phone companion, which has no Ready control', () => {
  renderHostPanel([HOST, GUEST, PHONE])
  const heading = screen.getByText("Everyone's ready (1)")
  expect(screen.queryByText(/^Waiting on \d+ of \d+$/)).toBeNull()
  expect(summaryText(heading)).not.toContain('javon')
})

it('still names a guest who has not marked ready, and only them', () => {
  renderHostPanel([HOST, GUEST, LATE_GUEST, PHONE])
  const heading = screen.getByText('Waiting on 1 of 2')
  expect(summaryText(heading)).toContain('ada')
  expect(summaryText(heading)).not.toContain('javon')
})
