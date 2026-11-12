// @vitest-environment jsdom
//
// The phone companion's preview of a party, as read from the server's
// answer for a code. The server answers "active" for any party it holds,
// one planned for later included, and says when each started and when it is
// planned to: the join screen must be able to tell the two apart.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCompanionPartyPreview } from './api'

const answer = (body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })))

afterEach(() => vi.unstubAllGlobals())

describe('the companion\'s preview of a party', () => {
  it('carries when the party started', async () => {
    answer({ type: 'active', party: { code: 'FRD4YC', party_name: 'Friday crew', media_title: 'Kestrel', participant_count: 3, started_at: '2026-10-01T19:00:00Z', scheduled_start_at: null } })
    expect(await getCompanionPartyPreview('frd4yc')).toMatchObject({ code: 'FRD4YC', partyName: 'Friday crew', participantCount: 3, startedAt: '2026-10-01T19:00:00Z', scheduledStartAt: null })
  })

  it('says a planned party has not started, and when it is planned for', async () => {
    answer({ type: 'active', party: { code: 'LATER7', media_title: 'The Orchard', participant_count: 0, started_at: null, scheduled_start_at: '2026-10-03T19:00:00Z' } })
    expect(await getCompanionPartyPreview('LATER7')).toMatchObject({ startedAt: null, scheduledStartAt: '2026-10-03T19:00:00Z' })
  })

  it('reads an answer that says nothing of either as not started', async () => {
    answer({ type: 'active', party: { code: 'OLDER1' } })
    expect(await getCompanionPartyPreview('OLDER1')).toMatchObject({ startedAt: null, scheduledStartAt: null })
  })
})
