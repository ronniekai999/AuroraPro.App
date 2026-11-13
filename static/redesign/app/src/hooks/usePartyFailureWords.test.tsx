// @vitest-environment jsdom
//
// The party's own failures in the app's words: a code no party holds and an
// end that did not go through. What the server said ("party not found or
// has ended", "pq: …") is written for a log.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { APIError, NetworkError, apiFetch, getStoredUser } from '@/lib/api'
import { useParty } from './useParty'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
  getStoredUser: vi.fn(() => ({ id: 1 })),
  refreshAccessToken: async () => true,
}))
vi.mock('@/lib/voice', () => ({
  createVoiceController: () => ({ subscribe() {}, getState: () => ({}), leave() {}, destroy() {}, onRoomSocketDown() {} }),
}))

class Socket {
  static OPEN = 1
  static all: Socket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  readonly url: string
  constructor(url: string) { this.url = url; Socket.all.push(this) }
  send() {}
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  receive(type: string, payload?: unknown) { this.onmessage?.({ data: JSON.stringify({ type, payload }) }) }
}

beforeEach(() => {
  Socket.all = []
  vi.stubGlobal('WebSocket', Socket)
  vi.mocked(apiFetch).mockReset()
  vi.mocked(getStoredUser).mockImplementation(() => ({ id: 1 }) as ReturnType<typeof getStoredUser>)
  localStorage.clear()
})
afterEach(() => { vi.unstubAllGlobals() })

it('says a code no party holds now as that, not in the server\'s words', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new APIError(404, 'code not found', null))
  const { result, unmount } = renderHook(() => useParty(1, 3))
  let said: { ok: boolean; error?: string } | undefined
  await act(async () => { said = await result.current.join('ABC123') })
  // Beside the sentence, a field for code to branch on: never the words.
  expect(said).toEqual({ ok: false, error: 'No party is using that code right now.', reason: 'http_404' })
  expect(result.current.state.error).toBe('No party is using that code right now.')
  unmount()
})

it('says an end that did not go through in the app\'s words', async () => {
  const { result, unmount } = renderHook(() => useParty(1, 3))
  await act(async () => { await result.current.join('ABC123', { skipPreflight: true }) })
  const room = Socket.all.filter(s => s.url.includes('/ws/party-room')).at(-1)!
  act(() => {
    room.open()
    room.receive('party-state', {
      party: {
        code: 'ABC123', revision: 1, media_item_id: 10, episode_id: null, party_name: 'Friday crew',
        host_user_id: 1, media_title: 'Film', current_time_ms: 0, is_playing: true,
        scheduled_start_at: null, started_at: null,
      },
      participants: [], chat_history: [],
    })
  })
  vi.mocked(apiFetch).mockRejectedValue(new APIError(500, 'pq: connection refused', null))
  let ended: boolean | undefined
  await act(async () => { ended = await result.current.end() })
  expect(ended).toBe(false)
  expect(result.current.state.error).toBe('Could not end the party just now.')
  unmount()
})

// A persistent room with no live party: the hook knows the case from the
// lookup's answer and says so in the field. Its words keep "persistent
// room" while a caller still reads them.
it('marks a persistent room with no live party, and keeps its words', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ type: 'offline_room' })
  const { result, unmount } = renderHook(() => useParty(1, 3))
  let said: { ok: boolean; error?: string; reason?: string } | undefined
  await act(async () => { said = await result.current.join('ROOM42') })
  expect(said?.ok).toBe(false)
  expect(said?.reason).toBe('offline_room')
  expect(said?.error).toMatch(/persistent room/)
  unmount()
})

it('marks a lookup that got no answer', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new NetworkError('Failed to fetch'))
  const { result, unmount } = renderHook(() => useParty(1, 3))
  let said: { ok: boolean; error?: string; reason?: string } | undefined
  await act(async () => { said = await result.current.join('ABC123') })
  expect(said).toEqual({ ok: false, error: 'Could not reach the server. Check the connection and try again.', reason: 'network' })
  unmount()
})

it('marks a code that is not six letters or digits', async () => {
  const { result, unmount } = renderHook(() => useParty(1, 3))
  let said: { ok: boolean; error?: string; reason?: string } | undefined
  await act(async () => { said = await result.current.join('AB') })
  expect(said).toEqual({ ok: false, error: 'Party code must be 6 letters or digits.', reason: 'invalid_code' })
  expect(apiFetch).not.toHaveBeenCalled()
  unmount()
})

it('marks a join with nobody signed in', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ type: 'active' })
  vi.mocked(getStoredUser).mockImplementation(() => null)
  const { result, unmount } = renderHook(() => useParty(1, 3))
  let said: { ok: boolean; error?: string; reason?: string } | undefined
  await act(async () => { said = await result.current.join('ABC123') })
  expect(said).toEqual({ ok: false, error: 'You must be signed in to join a party.', reason: 'signed_out' })
  unmount()
})
