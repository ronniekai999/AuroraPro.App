// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useParty } from './useParty'

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getStoredUser: () => ({ id: 1 }),
  refreshAccessToken: async () => true,
}))
vi.mock('@/lib/voice', () => ({
  createVoiceController: () => ({ subscribe() {}, getState: () => ({}), leave() {}, destroy() {}, onRoomSocketDown() {} }),
}))

class Socket {
  static OPEN = 1
  static all: Socket[] = []
  readyState = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  readonly url: string
  constructor(url: string) { this.url = url; Socket.all.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  drop() { this.close(); this.onclose?.() }
  receive(type: string, payload: unknown) { this.onmessage?.({ data: JSON.stringify({ type, payload }) }) }
}

const snapshot = (revision: number, mediaTitle = 'Scheduled film') => ({
  party: {
    code: 'REST01', revision, media_item_id: 10, episode_id: null,
    host_user_id: 1, media_title: mediaTitle, current_time_ms: 0, is_playing: false,
    scheduled_start_at: '2030-10-02T19:00:00Z', started_at: null,
  },
  participants: [], chat_history: [],
})

beforeEach(() => {
  vi.useFakeTimers()
  Socket.all = []
  vi.stubGlobal('WebSocket', Socket)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('replaces a retained revision floor on room restart, then orders both sockets normally', async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  await act(async () => { await result.current.join('REST01', { skipPreflight: true }) })
  const firstRoom = Socket.all[0]
  act(() => {
    firstRoom.open()
    firstRoom.receive('party-state', snapshot(80))
  })
  const firstSync = Socket.all[1]
  act(() => {
    firstSync.open()
    firstSync.receive('hello', { rev: 80, abs_ms: 65_000, server_now_ms: Date.now(), running: false })
  })
  expect(result.current.state.rev).toBe(80)
  expect(result.current.seekRef.current?.abs_ms).toBe(65_000)

  // This is the client side of the real DB shutdown→rehydration regression:
  // the page remains mounted and retains revision 80 while the server starts
  // the restored scheduled party at revision 1.
  act(() => { firstRoom.drop() })
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  const nextRoom = Socket.all[2]
  act(() => {
    nextRoom.open()
    nextRoom.receive('party-state', snapshot(1, 'Restored scheduled film'))
  })
  expect(result.current.state.rev).toBe(1)
  expect(result.current.state.mediaTitle).toBe('Restored scheduled film')
  expect(result.current.state.currentTimeMs).toBe(0)
  expect(result.current.tickRef.current).toBeNull()
  expect(result.current.seekRef.current).toBeNull()
  const nextSync = Socket.all[3]
  act(() => {
    nextSync.open()
    // Queued messages from old connections cannot re-establish the old floor.
    firstRoom.receive('party-state', snapshot(99, 'Stale film'))
    firstSync.receive('tick', { rev: 99, abs_ms: 999_000, server_now_ms: Date.now(), running: true })
    nextSync.receive('hello', { rev: 1, abs_ms: 0, server_now_ms: Date.now(), running: false })
    nextSync.receive('tick', { rev: 2, abs_ms: 1_000, server_now_ms: Date.now(), running: true })
  })
  expect(result.current.state.rev).toBe(2)
  expect(result.current.state.isPlaying).toBe(true)
  expect(result.current.tickRef.current?.abs_ms).toBe(1_000)
  act(() => {
    nextRoom.receive('party-state', snapshot(1, 'Out-of-order film'))
    nextSync.receive('pause', { rev: 1, abs_ms: 0 })
  })
  expect(result.current.state.rev).toBe(2)
  expect(result.current.state.mediaTitle).toBe('Restored scheduled film')
  expect(result.current.state.isPlaying).toBe(true)

  // A sync-only reconnect has no fresh room snapshot and must not reset
  // ordering; an old hello remains older than the current canonical state.
  act(() => { nextSync.drop() })
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  const syncOnly = Socket.all[4]
  act(() => {
    syncOnly.open()
    syncOnly.receive('hello', { rev: 1, abs_ms: 0, server_now_ms: Date.now(), running: false })
  })
  expect(result.current.state.rev).toBe(2)
  expect(result.current.state.isPlaying).toBe(true)
  unmount()
})
