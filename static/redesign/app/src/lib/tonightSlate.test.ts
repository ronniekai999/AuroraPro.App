// Tonight's slate: the resume-first rule, and the order the filmstrip shows.

import { describe, expect, it } from 'vitest'
import { buildSlate, RESUME_LEAD_MAX_AGE_MS, resumeLead, resumeLine, shownSlateIndex, timeLeftLabel, whereYouAre } from './tonightSlate'
import type { ContinueWatchingItem, HeroPick } from './api'
import type { Media } from './types'

const NOW = Date.parse('2026-11-11T20:00:00Z')
const cw = (id: number, over: Partial<ContinueWatchingItem> = {}): ContinueWatchingItem => ({
  media_item_id: id, title: `Title ${id}`, type: 'movie', position_ms: 600_000, duration_ms: 6_000_000, percent_complete: 10,
  updated_at: new Date(NOW - 3600_000).toISOString(), ...over,
})
const media = (id: number): Media => ({
  id, title: `Pick ${id}`, year: 2024, rating: 8, duration: '2h', genre: 'Drama', type: 'movie', poster: '', backdrop: `/wide-${id}.jpg`, description: 'About it.',
})
const pick = (id: number, reason = `Because ${id}`): HeroPick => ({ media: media(id), reason })

describe('resumeLead', () => {
  it('is the most recent record that is far enough in to resume', () => {
    expect(resumeLead([cw(1), cw(2)], NOW)?.media_item_id).toBe(1)
    // The first is only a few seconds in: opened and closed.
    expect(resumeLead([cw(1, { position_ms: 2000 }), cw(2)], NOW)?.media_item_id).toBe(2)
  })
  it('is nothing when nothing is unfinished', () => {
    expect(resumeLead([], NOW)).toBeNull()
    expect(resumeLead([cw(1, { position_ms: 0 })], NOW)).toBeNull()
    expect(resumeLead([cw(1, { completed: true })], NOW)).toBeNull()
  })
  it('does not lead with something last watched long ago', () => {
    const old = new Date(NOW - RESUME_LEAD_MAX_AGE_MS - 1000).toISOString()
    expect(resumeLead([cw(1, { updated_at: old })], NOW)).toBeNull()
    expect(resumeLead([cw(1, { updated_at: old }), cw(2)], NOW)?.media_item_id).toBe(2)
    expect(resumeLead([cw(1, { updated_at: new Date(NOW - RESUME_LEAD_MAX_AGE_MS + 1000).toISOString() })], NOW)?.media_item_id).toBe(1)
  })
  it('takes a record with no timestamp, or an unreadable one, as recent', () => {
    expect(resumeLead([cw(1, { updated_at: undefined })], NOW)?.media_item_id).toBe(1)
    expect(resumeLead([cw(1, { updated_at: 'not a date' })], NOW)?.media_item_id).toBe(1)
  })
})

describe('buildSlate', () => {
  it('is the picks in the recommender\'s order when there is nothing to resume', () => {
    const slate = buildSlate(null, [pick(10), pick(11), pick(12)])
    expect(slate.map(e => [e.kind, e.media.id, e.poolIndex])).toEqual([['pick', 10, 0], ['pick', 11, 1], ['pick', 12, 2]])
    expect(slate[1].reason).toBe('Because 11')
  })
  it('leads with the title to resume, then the picks', () => {
    const slate = buildSlate(cw(1), [pick(10), pick(11)])
    expect(slate.map(e => [e.kind, e.media.id, e.poolIndex])).toEqual([['resume', 1, null], ['pick', 10, 0], ['pick', 11, 1]])
    expect(slate[0].record?.media_item_id).toBe(1)
    expect(slate[0].media.progress).toBeCloseTo(0.1)
  })
  it('shows a title that is both once, as the lead', () => {
    const slate = buildSlate(cw(11), [pick(10), pick(11), pick(12)])
    expect(slate.map(e => [e.kind, e.media.id, e.poolIndex])).toEqual([['resume', 11, 1], ['pick', 10, 0], ['pick', 12, 2]])
    // The pool's copy carries the wide art.
    expect(slate[0].media.backdrop).toBe('/wide-11.jpg')
    expect(slate[0].media.progress).toBeCloseTo(0.1)
  })
  // What an exposure is reported under: the pick's place in the slate as the
  // server sent it, which is not its place in the pool once a title has been
  // taken out of the pool (a low rating). The lead has none, whatever it is.
  it('gives each pick the place the server sent it at, and the lead none', () => {
    const sent = [10, 11, 12].map((id, position) => ({ ...pick(id), position }))
    // The first pick was rated away: the pool is now the other two.
    const slate = buildSlate(cw(12), sent.slice(1))
    expect(slate.map(e => [e.kind, e.media.id, e.position])).toEqual([['resume', 12, null], ['pick', 11, 1]])
    // A pool from before picks carried a place: its place in the pool.
    expect(buildSlate(null, [pick(10), pick(11)]).map(e => e.position)).toEqual([0, 1])
  })

  it('is the lead alone with no picks, and empty with neither', () => {
    expect(buildSlate(cw(1), []).map(e => e.kind)).toEqual(['resume'])
    expect(buildSlate(null, [])).toEqual([])
  })
  it('gives every entry its own key', () => {
    const keys = buildSlate(cw(1), [pick(10), pick(11)]).map(e => e.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('shownSlateIndex', () => {
  const slate = buildSlate(cw(1), [pick(10), pick(11)])
  it('is the lead until the viewer moves off it', () => {
    expect(shownSlateIndex(slate, true, 0)).toBe(0)
    expect(shownSlateIndex(slate, true, 1)).toBe(0)
  })
  it('is the pick at the recommender\'s position once they have', () => {
    expect(shownSlateIndex(slate, false, 0)).toBe(1)
    expect(shownSlateIndex(slate, false, 1)).toBe(2)
  })
  it('follows the recommender\'s position when there is no lead', () => {
    const picks = buildSlate(null, [pick(10), pick(11)])
    expect(shownSlateIndex(picks, true, 1)).toBe(1)
    expect(shownSlateIndex(picks, false, 0)).toBe(0)
  })
  it('finds a lead that is also a pick by its position', () => {
    const both = buildSlate(cw(11), [pick(10), pick(11)])
    expect(shownSlateIndex(both, false, 1)).toBe(0)
  })
  it('falls back to the first pick when the position is gone, and to -1 with nothing', () => {
    expect(shownSlateIndex(slate, false, 7)).toBe(1)
    expect(shownSlateIndex(buildSlate(cw(1), []), false, 3)).toBe(0)
    expect(shownSlateIndex([], true, 0)).toBe(-1)
  })
})

describe('the lead\'s lines', () => {
  it('says how long is left', () => {
    expect(timeLeftLabel(23 * 60000, 52 * 60000)).toBe('29 min left')
    expect(timeLeftLabel(10 * 60000, 82 * 60000)).toBe('1 h 12 min left')
    expect(timeLeftLabel(0, 120 * 60000)).toBe('2 h left')
    expect(timeLeftLabel(600_000, 0)).toBe('')
    expect(timeLeftLabel(6_000_000, 6_010_000)).toBe('')
  })
  it('says where in a show, or what film', () => {
    expect(resumeLine(cw(1, { type: 'show', season_number: 2, episode_number: 4, episode_title: 'The Weight of Water' }))).toBe('Season 2, episode 4 · The Weight of Water')
    expect(resumeLine(cw(1, { type: 'show', season_number: 0, episode_number: 0 }))).toBe('Season 0, episode 0')
    expect(resumeLine(cw(1, { year: 2025, genre: 'Thriller' }))).toBe('2025 · Thriller')
    expect(resumeLine(cw(1))).toBe('')
  })
})

describe('where the viewer is in a title, for a list', () => {
  it('names a show\'s episode and the time left in it, and how far through it is', () => {
    expect(whereYouAre({ type: 'show', season_number: 2, episode_number: 4, position_ms: 23 * 60000, duration_ms: 52 * 60000 }))
      .toEqual({ label: 'S2 E4 · 29 min left', fraction: 23 / 52 })
  })

  it('gives a film its time left', () => {
    expect(whereYouAre({ type: 'movie', position_ms: 70 * 60000, duration_ms: 141 * 60000 }).label).toBe('1 h 11 min left')
  })

  // A Special is season 0, and a pilot can be episode 0.
  it('names season 0 and episode 0', () => {
    expect(whereYouAre({ type: 'show', season_number: 0, episode_number: 0, position_ms: 60000, duration_ms: 600000 }).label).toBe('S0 E0 · 9 min left')
  })

  it('says what it can when the length is unknown', () => {
    expect(whereYouAre({ type: 'show', season_number: 1, episode_number: 3, position_ms: 60000, duration_ms: 0 })).toEqual({ label: 'S1 E3', fraction: 0 })
    expect(whereYouAre({ type: 'movie', position_ms: 60000, duration_ms: 0 })).toEqual({ label: 'Started', fraction: 0 })
  })

  it('never reports more than the whole of it', () => {
    expect(whereYouAre({ type: 'movie', position_ms: 700000, duration_ms: 600000 }).fraction).toBe(1)
  })
})
