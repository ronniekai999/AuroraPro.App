// Which episode a show's watch party opens on. A party created for a show
// with no episode cannot be joined once it is playing (the guest gets an
// empty file list and bails silently), so the title page's Party action and
// a card's "Watch together" both go through here.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { partyEpisodeId, regularSeasonsFirst, resolvePartyEpisodeId } from './partyEpisode'

const show = { id: 5, type: 'show' }
const movie = { id: 6, type: 'movie' }
const file = [{ id: 1 }]

describe('partyEpisodeId', () => {
  it('is nothing for a movie, whatever else is known', () => {
    expect(partyEpisodeId(movie, { type: 'movie', episode_id: 9 }, [{ id: 3, files: file }])).toBeUndefined()
  })
  it('is the viewer\'s resume episode for a show', () => {
    expect(partyEpisodeId(show, { type: 'show', episode_id: 42 }, [{ id: 3, files: file }])).toBe(42)
  })
  it('is the first episode that has a file when there is no resume episode', () => {
    expect(partyEpisodeId(show, undefined, [{ id: 1, files: [] }, { id: 2 }, { id: 3, files: file }, { id: 4, files: file }])).toBe(3)
    expect(partyEpisodeId(show, { type: 'show', episode_id: null }, [{ id: 7, files: file }])).toBe(7)
  })
  it('is nothing when no episode is known to be playable', () => {
    expect(partyEpisodeId(show, undefined, [{ id: 1, files: [] }])).toBeUndefined()
    expect(partyEpisodeId(show, undefined, null)).toBeUndefined()
  })
})

describe('regularSeasonsFirst', () => {
  const nums = (list: { season_number: number }[]) => regularSeasonsFirst(list).map(s => s.season_number)
  it('orders regular seasons by number and puts Specials (season 0) last', () => {
    expect(nums([{ season_number: 2 }, { season_number: 0 }, { season_number: 1 }])).toEqual([1, 2, 0])
    expect(nums([{ season_number: 0 }])).toEqual([0])
    expect(nums([])).toEqual([])
  })
  it('does not reorder the list it was given', () => {
    const given = [{ season_number: 2 }, { season_number: 0 }, { season_number: 1 }]
    regularSeasonsFirst(given)
    expect(given.map(s => s.season_number)).toEqual([2, 0, 1])
  })
})

describe('resolvePartyEpisodeId', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A show with seasons 2 and 1 (listed out of order); season 1 has no
   *  file, season 2's episodes are listed out of order. */
  function stub({ fail = false } = {}) {
    const asked: string[] = []
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const p = new URL(input, 'http://localhost').pathname
      asked.push(p)
      // An aborted request rejects, as fetch's does.
      if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (fail) return json({ error: 'unavailable' }, 503)
      if (p === '/api/media/5/seasons') return json([{ id: 20, media_item_id: 5, season_number: 2 }, { id: 10, media_item_id: 5, season_number: 1 }])
      if (p === '/api/media/5/seasons/1/episodes') return json([{ id: 101, episode_number: 1, files: [] }])
      if (p === '/api/media/5/seasons/2/episodes') return json([{ id: 203, episode_number: 3, files: file }, { id: 202, episode_number: 2, files: file }, { id: 201, episode_number: 1 }])
      return json([])
    })
    return asked
  }

  it('asks the server nothing when the resume record names the episode, or for a movie', async () => {
    const asked = stub()
    expect(await resolvePartyEpisodeId(show, { type: 'show', episode_id: 42 })).toBe(42)
    expect(await resolvePartyEpisodeId(movie, undefined)).toBeUndefined()
    expect(asked).toEqual([])
  })

  it('reads the seasons in order and takes the first episode with a file', async () => {
    const asked = stub()
    expect(await resolvePartyEpisodeId(show, undefined)).toBe(202)
    expect(asked).toEqual(['/api/media/5/seasons', '/api/media/5/seasons/1/episodes', '/api/media/5/seasons/2/episodes'])
  })

  it('does not start a show on a Special when a regular season has an episode, and does when none has', async () => {
    const asked: string[] = []
    let regularHasFile = true
    vi.stubGlobal('fetch', async (input: string) => {
      const p = new URL(input, 'http://localhost').pathname
      asked.push(p)
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (p === '/api/media/5/seasons') return json([{ id: 1, media_item_id: 5, season_number: 0 }, { id: 2, media_item_id: 5, season_number: 1 }])
      if (p === '/api/media/5/seasons/0/episodes') return json([{ id: 900, episode_number: 1, files: file }])
      if (p === '/api/media/5/seasons/1/episodes') return json([{ id: 101, episode_number: 1, files: regularHasFile ? file : [] }])
      return json([])
    })
    expect(await resolvePartyEpisodeId(show, undefined)).toBe(101)
    // Specials were not even read.
    expect(asked).toEqual(['/api/media/5/seasons', '/api/media/5/seasons/1/episodes'])
    regularHasFile = false
    expect(await resolvePartyEpisodeId(show, undefined)).toBe(900)
  })

  it('stops when it is told the viewer has moved on', async () => {
    stub()
    const gone = new AbortController()
    gone.abort()
    await expect(resolvePartyEpisodeId(show, undefined, gone.signal)).rejects.toBeTruthy()
  })

  it('rejects when the episodes cannot be read, so the caller does not start a party nobody can join', async () => {
    stub({ fail: true })
    await expect(resolvePartyEpisodeId(show, undefined)).rejects.toBeTruthy()
  })
})
