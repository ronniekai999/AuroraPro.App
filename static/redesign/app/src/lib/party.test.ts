import { describe, it, expect } from 'vitest'
import {
  changeMediaRequest,
  nextUpArmSecond,
  participantFromJoinEvent,
  partyPauseRequest,
  partySeekRequest,
  receivedSeekFromHello,
  shouldAcceptPartyRevision,
  PARTY_NEXT_UP_LEAD_SEC,
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

// Issue #460 — the host's next-episode swap. The wire field names are the
// load-bearing part: Go's decoder ignores unknown keys, so a renamed field
// doesn't error, it silently becomes the zero value. That's exactly how
// issue #448 turned every seek into a seek-to-zero.
describe('changeMediaRequest', () => {
  it('uses the snake_case field names changeMediaPayload decodes', () => {
    expect(changeMediaRequest({
      mediaItemId: 42,
      episodeId: 8711,
      mediaTitle: 'Severance',
      mediaPoster: '/p/abc.jpg',
    })).toEqual({
      type: 'change-media',
      payload: {
        media_item_id: 42,
        episode_id: 8711,
        media_title: 'Severance',
        media_poster: '/p/abc.jpg',
      },
    })
  })

  it('omits episode_id for a movie rather than sending 0', () => {
    // changeMediaPayload.EpisodeID is *int64 — absent means "movie".
    // Sending 0 would persist a bogus episode reference on the party row.
    const payload = changeMediaRequest({
      mediaItemId: 42, mediaTitle: 'Arrival', mediaPoster: '',
    }).payload
    expect(payload.episode_id).toBeUndefined()
  })
})

// nextUpArmSecond — when the next-up card appears. Solo behavior must not
// move (it shipped against credits markers only); the party host gets the
// extra "under two minutes" rule issue #460 asked for.
describe('nextUpArmSecond', () => {
  it('arms a solo viewer at the credits onset only', () => {
    expect(nextUpArmSecond({ creditsStartSec: 1290, durationSec: 1400, partyHost: false }))
      .toBe(1290)
  })

  it('never arms a solo viewer on an unmarked episode', () => {
    // The 2-minute rule is party-only — adding it for solo playback would
    // change shipped behavior, and with autoplay on it would pull every
    // viewer forward two minutes early.
    expect(nextUpArmSecond({ creditsStartSec: null, durationSec: 1400, partyHost: false }))
      .toBeNull()
  })

  it('arms a party host on an unmarked episode with 2 minutes left', () => {
    expect(nextUpArmSecond({ creditsStartSec: null, durationSec: 1400, partyHost: true }))
      .toBe(1400 - PARTY_NEXT_UP_LEAD_SEC)
  })

  it('prefers whichever threshold comes first', () => {
    // 23:20 episode, so the duration rule lands at 21:20 (1280). A credits
    // marker at 21:30 is later, so the duration rule wins...
    expect(nextUpArmSecond({ creditsStartSec: 1290, durationSec: 1400, partyHost: true }))
      .toBe(1280)
    // ...but a long credits sequence starting at 19:00 wins instead, so a
    // host on a marked episode still gets the card when solo viewers do.
    expect(nextUpArmSecond({ creditsStartSec: 1140, durationSec: 1400, partyHost: true }))
      .toBe(1140)
  })

  it('ignores the duration rule until the real duration is known', () => {
    // realDurationSec is 0 until stream info resolves. Without the floor
    // the card would arm at second 0 on every episode in a party.
    expect(nextUpArmSecond({ creditsStartSec: null, durationSec: 0, partyHost: true }))
      .toBeNull()
  })

  it('skips the duration rule for episodes shorter than the lead-in', () => {
    // A 90-second episode would otherwise arm before it started.
    expect(nextUpArmSecond({ creditsStartSec: null, durationSec: 90, partyHost: true }))
      .toBeNull()
    // A marker still arms it.
    expect(nextUpArmSecond({ creditsStartSec: 75, durationSec: 90, partyHost: true }))
      .toBe(75)
  })
})
