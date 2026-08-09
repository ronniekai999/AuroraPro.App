import { describe, it, expect } from 'vitest'
import {
  participantFromJoinEvent,
  partyPauseRequest,
  partySeekRequest,
  receivedSeekFromHello,
  shouldAcceptPartyRevision,
} from './party'

describe('party sync wire requests', () => {
  it('uses the Go endpoint\'s to_ms field for an absolute seek', () => {
    expect(partySeekRequest(13 * 60_000 + 11_000)).toEqual({
      type: 'request-seek',
      payload: { to_ms: 791_000 },
    })
  })

  it('uses the Go endpoint\'s at_ms field for an absolute pause', () => {
    expect(partyPauseRequest(482_500)).toEqual({
      type: 'request-pause',
      payload: { at_ms: 482_500 },
    })
  })
})

describe('cross-socket party revision ordering', () => {
  it('rejects an old sync frame after a newer room event', () => {
    expect(shouldAcceptPartyRevision(12, 11)).toBe(false)
    expect(shouldAcceptPartyRevision(12, 12)).toBe(true)
    expect(shouldAcceptPartyRevision(12, 13)).toBe(true)
  })

  it('accepts legacy unversioned frames only before a versioned boundary', () => {
    expect(shouldAcceptPartyRevision(0, undefined)).toBe(true)
    expect(shouldAcceptPartyRevision(1, undefined)).toBe(false)
  })
})

describe('sync reconnect rebase', () => {
  it('turns hello into the explicit one-shot seek a reconnecting guest missed', () => {
    expect(receivedSeekFromHello(
      { abs_ms: 791_000, server_now_ms: 100_000, running: true, rev: 14 },
      100_250,
      3,
    )).toEqual({
      abs_ms: 791_000,
      running: true,
      rev: 14,
      receivedAtMs: 100_250,
      sequence: 3,
    })
  })
})

// participantFromJoinEvent — every field the participant-join event
// carries must land in the optimistic patch. The `companion` case is the
// one that shipped broken (host-succession review, 2026-08): the old
// inline patch dropped it, a phone-companion joiner read as a regular
// watcher, and PartyPanel's hand-off dialog promised the host a hand-off
// that the server — which excludes companions from succession — turned
// into an end-for-everyone.
describe('participantFromJoinEvent', () => {
  it('carries the companion flag through — the shipped hand-off bug', () => {
    const p = participantFromJoinEvent({ user_id: 3, username: 'javon', companion: true })
    expect(p.companion).toBe(true)
  })

  it('carries ready through so a rejoining peer keeps their green dot', () => {
    // The server includes `ready` on participant-join precisely so the
    // optimistic patch can't erase a reconnecting peer's state.
    expect(participantFromJoinEvent({ user_id: 2, username: 'ron', ready: true }).ready).toBe(true)
  })

  it('defaults absent flags to false, never undefined', () => {
    const p = participantFromJoinEvent({ user_id: 2, username: 'ron' })
    expect(p.is_host).toBe(false)
    expect(p.ready).toBe(false)
    expect(p.companion).toBe(false)
    expect(p.is_buffering).toBe(false)
  })
})
