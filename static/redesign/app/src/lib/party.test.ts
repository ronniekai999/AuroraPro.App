import { describe, it, expect } from 'vitest'
import { participantFromJoinEvent } from './party'

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
