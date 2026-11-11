// Which episode a show's watch party opens on. A party created for a show
// with no episode cannot be joined once it is playing (the guest gets an
// empty file list and bails silently), so the title page's Party action and
// a card's "Watch together" both go through here.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { partyEpisodeId, resolvePartyEpisodeId } from './partyEpisode'

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

describe('resolvePartyEpisodeId', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A show with seasons 2 and 1 (listed out of order); season 1 has no
   *  file, season 2's episodes are listed out of order. */
  function stub({ fail = false } = {}) {
    const asked: string[] = []
    vi.stubGlobal('fetch', async (input: string) => {
      const p = new URL(input, 'http://localhost').pathname
      asked.push(p)
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

  it('rejects when the episodes cannot be read, so the caller does not start a party nobody can join', async () => {
    stub({ fail: true })
    await expect(resolvePartyEpisodeId(show, undefined)).rejects.toBeTruthy()
  })
})
