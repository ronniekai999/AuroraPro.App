import { afterEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

const response = (status: number): Response => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => ({}),
  text: async () => '',
}) as unknown as Response

afterEach(() => {
  fetchMock.mockReset()
  vi.resetModules()
})

describe('recordRecommendationExposure', () => {
  it('posts the exact slate/profile/position visibility snapshot', async () => {
    fetchMock.mockResolvedValue(response(204))
    const { recordRecommendationExposure } = await import('./api')
    await expect(recordRecommendationExposure({
      slateToken: 'a'.repeat(32), mediaItemId: 42, position: 3,
      visibleMs: 1500, profileId: 9,
    })).resolves.toBe(true)

    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/me/recommendation-exposure?profile_id=9')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      slate_token: 'a'.repeat(32), media_item_id: 42,
      position: 3, visible_ms: 1500,
    })
  })

  it('returns false on 202 so the visibility hook retries the async-insert race', async () => {
    fetchMock.mockResolvedValue(response(202))
    const { recordRecommendationExposure } = await import('./api')
    await expect(recordRecommendationExposure({
      slateToken: 'b'.repeat(32), mediaItemId: 7, position: 0, visibleMs: 1500,
    })).resolves.toBe(false)
  })
})
