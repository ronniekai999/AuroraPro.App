import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearProgress, markWatched, reportProgress } from './api'
const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())
it('sends the profile with heartbeat and Mark as Watched JSON', async () => {
  await reportProgress(12, { position_ms: 4000, duration_ms: 10000, episode_id: 25, profile_id: 7 })
  await markWatched(12, { profile_id: 7 })
  expect(fetchMock.mock.calls.map(([url, options]) => [url, options.method, JSON.parse(options.body)])).toEqual([
    ['/api/progress/12', 'PUT', { position_ms: 4000, duration_ms: 10000, episode_id: 25, profile_id: 7 }],
    ['/api/progress/12/watched', 'POST', { profile_id: 7 }],
  ])
})
it('scopes Clear Progress to the selected profile', async () => {
  await clearProgress(12, 7)
  expect(fetchMock).toHaveBeenCalledWith('/api/progress/12?profile_id=7', expect.objectContaining({ method: 'DELETE' }))
})
it('preserves the server acting-profile fallback when no profile is selected', async () => {
  await clearProgress(12)
  expect(fetchMock).toHaveBeenCalledWith('/api/progress/12', expect.objectContaining({ method: 'DELETE' }))
})
