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

// PARTY-9 (playback review 2026-09): a play/pause/seek issued while the sync
// socket is not open is buffered and flushed when it next opens. leave() and
// end() drop the buffer, but a party that ENDS under the user (party-ended
// from the host or the server) or a join() straight into another code did
// not, so the intent was replayed into the next party joined: a guest's
// buffered pause (AllowPause is on by default) paused the new room at a
// position from a different title.

class Socket {
  static OPEN = 1
  static all: Socket[] = []
  readyState = 0
  sent: { type: string; payload?: unknown }[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  readonly url: string
  constructor(url: string) { this.url = url; Socket.all.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  receive(type: string, payload?: unknown) { this.onmessage?.({ data: JSON.stringify({ type, payload }) }) }
}

const snapshot = (code: string, revision = 1) => ({
  party: {
    code, revision, media_item_id: 10, episode_id: null,
    host_user_id: 2, media_title: 'Film', current_time_ms: 0, is_playing: true,
    scheduled_start_at: null, started_at: null,
  },
  participants: [], chat_history: [],
})

const syncSockets = () => Socket.all.filter(s => s.url.includes('/ws/party-sync'))
const roomSockets = () => Socket.all.filter(s => s.url.includes('/ws/party-room'))
const intents = (s: Socket) => s.sent.filter(m => m.type.startsWith('request-'))

beforeEach(() => {
  vi.useFakeTimers()
  Socket.all = []
  vi.stubGlobal('WebSocket', Socket)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// Join `code`, deliver its room snapshot (which opens the sync socket), and
// return the still-CONNECTING sync socket so intents buffer against it.
async function joinWithClosedSync(result: { current: ReturnType<typeof useParty> }, code: string) {
  await act(async () => { await result.current.join(code, { skipPreflight: true }) })
  const room = roomSockets().at(-1)!
  act(() => {
    room.open()
    room.receive('party-state', snapshot(code))
  })
  return { room, sync: syncSockets().at(-1)! }
}

it('does not replay an intent buffered in a party that ended into the next one', async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  const first = await joinWithClosedSync(result, 'AAAAAA')
  act(() => {
    result.current.requestPause(1_234_000)
    result.current.requestSeek(1_200_000)
  })
  expect(intents(first.sync)).toHaveLength(0) // buffered: the sync socket never opened

  act(() => { first.room.receive('party-ended') })
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })

  const second = await joinWithClosedSync(result, 'BBBBBB')
  act(() => { second.sync.open() })
  expect(second.sync.sent.map(m => m.type)).toContain('join-party')
  expect(intents(second.sync)).toEqual([])
  unmount()
})

it('does not replay an intent buffered before ending on the sync socket either', async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  const first = await joinWithClosedSync(result, 'AAAAAA')
  act(() => { result.current.requestPlay() })
  // The sync socket opens just to deliver the end: its flush happens first,
  // so re-buffer afterwards the way a drop and reconnect would.
  act(() => { first.sync.open() })
  expect(intents(first.sync).map(m => m.type)).toEqual(['request-play'])
  act(() => { first.sync.close(); first.sync.onclose?.() })
  act(() => { result.current.requestPause(5_000) })
  act(() => { first.room.receive('party-ended') })
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })

  const second = await joinWithClosedSync(result, 'BBBBBB')
  act(() => { second.sync.open() })
  expect(intents(second.sync)).toEqual([])
  unmount()
})

it('does not carry a buffered intent across a join straight into another party', async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  await joinWithClosedSync(result, 'AAAAAA')
  act(() => { result.current.requestSeek(900_000) })

  const second = await joinWithClosedSync(result, 'BBBBBB')
  act(() => { second.sync.open() })
  expect(intents(second.sync)).toEqual([])
  unmount()
})

it('still flushes an intent buffered for the party it belongs to', async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  const only = await joinWithClosedSync(result, 'AAAAAA')
  act(() => { result.current.requestSeek(42_000) })
  act(() => { only.sync.open() })
  expect(intents(only.sync)).toEqual([{ type: 'request-seek', payload: { to_ms: 42_000 } }])
  unmount()
})
