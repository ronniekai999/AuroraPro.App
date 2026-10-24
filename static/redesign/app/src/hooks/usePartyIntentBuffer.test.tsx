// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiFetch } from '@/lib/api'
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
//
// Each clear is pinned on its own. join() is the only way into a party and it
// clears the buffer first, so a later join cannot show whether a party-ended
// teardown cleared it; those two tests read the buffer through the hook's
// test seam right after the teardown, before any join.

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
  vi.mocked(apiFetch).mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// Open the latest room socket and deliver `code`'s snapshot, which opens the
// sync socket; return both, the sync socket still CONNECTING.
function deliverSnapshot(code: string) {
  const room = roomSockets().at(-1)!
  act(() => {
    room.open()
    room.receive('party-state', snapshot(code))
  })
  return { room, sync: syncSockets().at(-1)! }
}

// Join `code`, deliver its room snapshot (which opens the sync socket), and
// return the still-CONNECTING sync socket so intents buffer against it.
async function joinWithClosedSync(result: { current: ReturnType<typeof useParty> }, code: string) {
  await act(async () => { await result.current.join(code, { skipPreflight: true }) })
  return deliverSnapshot(code)
}

// Pins the room socket's party-ended teardown clear.
it('drops an intent buffered in a party that ended on the room socket', async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  const first = await joinWithClosedSync(result, 'AAAAAA')
  act(() => {
    result.current.requestPause(1_234_000)
    result.current.requestSeek(1_200_000)
  })
  expect(intents(first.sync)).toHaveLength(0) // buffered: the sync socket never opened
  expect(Object.keys(result.current.__pendingSyncIntentsForTests()).sort()).toEqual(['playPause', 'seek'])

  act(() => { first.room.receive('party-ended') })
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(result.current.__pendingSyncIntentsForTests()).toEqual({})

  const second = await joinWithClosedSync(result, 'BBBBBB')
  act(() => { second.sync.open() })
  expect(second.sync.sent.map(m => m.type)).toContain('join-party')
  expect(intents(second.sync)).toEqual([])
  unmount()
})

// Pins the sync socket's party-ended teardown clear.
it('drops an intent buffered in a party that ended on the sync socket', async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  const first = await joinWithClosedSync(result, 'AAAAAA')
  act(() => { first.sync.open() })
  expect(first.sync.sent.map(m => m.type)).toContain('join-party')

  // The end arrives on the live sync socket, and the server then closes it.
  // The teardown waits 50 ms, and the player is still mounted meanwhile: an
  // intent it issues now finds no open sync socket and is buffered for the
  // party that just ended.
  act(() => { first.sync.receive('party-ended') })
  act(() => { first.sync.close(); first.sync.onclose?.() })
  act(() => { result.current.requestPause(5_000) })
  expect(intents(first.sync)).toEqual([])
  expect(Object.keys(result.current.__pendingSyncIntentsForTests())).toEqual(['playPause'])

  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(result.current.state.code).toBeNull() // the sync socket's teardown ran
  expect(result.current.__pendingSyncIntentsForTests()).toEqual({})

  const second = await joinWithClosedSync(result, 'BBBBBB')
  act(() => { second.sync.open() })
  expect(intents(second.sync)).toEqual([])
  unmount()
})

// Pins join()'s clear.
it('does not carry a buffered intent across a join straight into another party', async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  await joinWithClosedSync(result, 'AAAAAA')
  act(() => { result.current.requestSeek(900_000) })

  const second = await joinWithClosedSync(result, 'BBBBBB')
  act(() => { second.sync.open() })
  expect(intents(second.sync)).toEqual([])
  unmount()
})

// Pins sendOrBuffer's no-active-party guard. join() clears the buffer and
// then awaits the code lookup with no party active; the previous party's
// player can still issue an intent in that window, and without the guard it
// was buffered after the clear and flushed into the party being joined.
it('never sends an intent issued while no party is active', async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  await joinWithClosedSync(result, 'AAAAAA')

  let answerLookup!: (info: unknown) => void
  vi.mocked(apiFetch).mockImplementationOnce(() => new Promise(resolve => { answerLookup = resolve }))
  let joined!: Promise<{ ok: boolean; error?: string }>
  act(() => { joined = result.current.join('BBBBBB') })
  expect(apiFetch).toHaveBeenCalledWith('/api/code/BBBBBB/info')

  act(() => { result.current.requestPause(7_000) })
  expect(result.current.__pendingSyncIntentsForTests()).toEqual({})

  await act(async () => {
    answerLookup({ type: 'active' })
    expect(await joined).toEqual({ ok: true })
  })
  const room = roomSockets().at(-1)!
  act(() => {
    room.open()
    room.receive('party-state', snapshot('BBBBBB'))
  })
  const sync = syncSockets().at(-1)!
  act(() => { sync.open() })
  expect(sync.sent.map(m => m.type)).toContain('join-party')
  expect(intents(sync)).toEqual([])
  unmount()
})

// Retained callbacks model player events queued before its old binding is
// cleaned up. They must carry the originating party even after join completes.
it.each(['connecting', 'open'])('drops old player requests when the new party sync socket is %s', async status => {
  const { result, unmount } = renderHook(() => useParty(1))
  await joinWithClosedSync(result, 'AAAAAA')
  const oldPlayer = result.current
  const second = await joinWithClosedSync(result, 'BBBBBB')
  if (status === 'open') act(() => { second.sync.open() })

  act(() => {
    result.current.requestSeek(42_000)
    result.current.requestPause(42_000)
  })
  const pending = result.current.__pendingSyncIntentsForTests()
  const sent = [...intents(second.sync)]
  act(() => {
    oldPlayer.requestPlay()
    oldPlayer.requestPause(7_000)
    oldPlayer.requestSeek(9_000)
  })
  expect(result.current.__pendingSyncIntentsForTests()).toEqual(pending)
  expect(intents(second.sync)).toEqual(sent)

  if (status === 'connecting') act(() => { second.sync.open() })
  expect(intents(second.sync)).toEqual([
    { type: 'request-seek', payload: { to_ms: 42_000 } },
    { type: 'request-pause', payload: { at_ms: status === 'connecting' ? -1 : 42_000 } },
  ])
  act(() => { result.current.requestPlay() })
  expect(intents(second.sync).at(-1)).toEqual({ type: 'request-play' })
  unmount()
})

it('drops a callback created without a party after a party becomes active', async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  const unboundPlayer = result.current
  const only = await joinWithClosedSync(result, 'AAAAAA')
  act(() => { only.sync.open() })
  act(() => {
    unboundPlayer.requestPlay()
    unboundPlayer.requestPause(7_000)
    unboundPlayer.requestSeek(9_000)
  })
  expect(result.current.__pendingSyncIntentsForTests()).toEqual({})
  expect(intents(only.sync)).toEqual([])
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

it.each([false, true])('drops requests from the previous party when the new sync socket is open: %s', async (open) => {
  const { result, unmount } = renderHook(() => useParty(1))
  await joinWithClosedSync(result, 'AAAAAA')
  // Player listeners and delayed work may retain these callbacks after a join.
  const previous = result.current

  const second = await joinWithClosedSync(result, 'BBBBBB')
  if (open) act(() => { second.sync.open() })
  act(() => {
    result.current.requestSeek(42_000)
    result.current.requestPause(43_000)
  })
  const sentBefore = [...intents(second.sync)]
  const pendingBefore = result.current.__pendingSyncIntentsForTests()
  act(() => {
    previous.requestPlay()
    previous.requestPause(900_000)
    previous.requestSeek(950_000)
  })
  expect(intents(second.sync)).toEqual(sentBefore)
  expect(result.current.__pendingSyncIntentsForTests()).toEqual(pendingBefore)

  if (!open) act(() => { second.sync.open() })
  expect(intents(second.sync)).toEqual([
    { type: 'request-seek', payload: { to_ms: 42_000 } },
    { type: 'request-pause', payload: { at_ms: open ? 43_000 : -1 } },
  ])
  act(() => { result.current.requestPlay() })
  expect(intents(second.sync).at(-1)).toEqual({ type: 'request-play' })
  unmount()
})

it('drops requests retained from a render with no active party', async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  const inactive = result.current
  const only = await joinWithClosedSync(result, 'AAAAAA')
  act(() => {
    inactive.requestPlay()
    inactive.requestPause(5_000)
    inactive.requestSeek(10_000)
  })
  expect(result.current.__pendingSyncIntentsForTests()).toEqual({})
  act(() => { only.sync.open() })
  expect(intents(only.sync)).toEqual([])
  unmount()
})

// The window CodeRabbit reported on #541, exactly: join() with skipPreflight
// makes the new code active before React renders anything, and the old
// party's player listeners can fire at once. The tests above fire them only
// after the join has rendered and the new room has sent its snapshot.
it("drops an old binding's requests made as a skipPreflight join starts, before it renders", async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  const first = await joinWithClosedSync(result, 'AAAAAA')
  act(() => { first.sync.open() })
  const oldPlayer = result.current

  await act(async () => {
    const joining = result.current.join('BBBBBB', { skipPreflight: true })
    oldPlayer.requestPause(1_234_000)
    oldPlayer.requestSeek(1_200_000)
    expect(await joining).toEqual({ ok: true })
  })

  const second = deliverSnapshot('BBBBBB')
  act(() => { second.sync.open() })
  expect(second.sync.sent.map(m => m.type)).toContain('join-party')
  expect(intents(second.sync)).toEqual([])
  expect(intents(first.sync)).toEqual([])
  unmount()
})

// The joined party's own callbacks buffer from the moment the join renders,
// before its room snapshot arrives (the tests above buffer only after it),
// and flush when its sync socket opens.
it("still buffers a request made through the joined party's own callbacks before its snapshot", async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  await joinWithClosedSync(result, 'AAAAAA')
  await act(async () => { await result.current.join('BBBBBB', { skipPreflight: true }) })
  act(() => { result.current.requestSeek(42_000) })
  const second = deliverSnapshot('BBBBBB')
  act(() => { second.sync.open() })
  expect(intents(second.sync)).toEqual([{ type: 'request-seek', payload: { to_ms: 42_000 } }])
  unmount()
})

// Binding requests to their party must not drop ones from callbacks held
// across a sync-socket reconnect inside that same party.
it('keeps delivering requests from callbacks held across a sync reconnect in the same party', async () => {
  const { result, unmount } = renderHook(() => useParty(1))
  const only = await joinWithClosedSync(result, 'AAAAAA')
  act(() => { only.sync.open() })
  const held = result.current
  act(() => { held.requestPause(10_000) })
  expect(intents(only.sync)).toEqual([{ type: 'request-pause', payload: { at_ms: 10_000 } }])

  // The sync socket drops; a request made meanwhile is buffered and flushed
  // when the room's next snapshot reopens it.
  act(() => { only.sync.close(); only.sync.onclose?.() })
  act(() => { held.requestSeek(20_000) })
  act(() => { only.room.receive('party-state', snapshot('AAAAAA', 2)) })
  const reopened = syncSockets().at(-1)!
  expect(reopened).not.toBe(only.sync)
  act(() => { reopened.open() })
  expect(intents(reopened)).toEqual([{ type: 'request-seek', payload: { to_ms: 20_000 } }])
  act(() => { held.requestPlay() })
  expect(intents(reopened).map(m => m.type)).toEqual(['request-seek', 'request-play'])
  unmount()
})
