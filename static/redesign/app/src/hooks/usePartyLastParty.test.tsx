// @vitest-environment jsdom
//
// "You were just in": the party hook writes the record when a party is
// joined and when it is left, under the profile the session acted as when
// it joined. The page that shows it reads under the acting profile, so the
// two agree. It used to be filed under the profile this browser REMEMBERED,
// which is a different thing: on an account with no profile it could be a
// profile id from an earlier sign-in, and the record was then filed where
// nothing read it.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readLastParty } from '@/lib/lastParty'
import { rememberProfileId } from '@/lib/profileSession'
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

const snapshot = (code: string) => ({
  party: {
    code, revision: 1, media_item_id: 10, episode_id: null, party_name: 'Friday crew',
    host_user_id: 2, media_title: 'Film', current_time_ms: 0, is_playing: true,
    scheduled_start_at: null, started_at: null,
  },
  participants: [], chat_history: [],
})

beforeEach(() => {
  vi.useFakeTimers()
  Socket.all = []
  vi.stubGlobal('WebSocket', Socket)
  localStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function joinParty(result: { current: ReturnType<typeof useParty> }, code: string) {
  await act(async () => { await result.current.join(code, { skipPreflight: true }) })
  const room = Socket.all.filter(s => s.url.includes('/ws/party-room')).at(-1)!
  act(() => {
    room.open()
    room.receive('party-state', snapshot(code))
  })
}

it('files the record under the profile the session acts as, whatever this browser remembers', async () => {
  // A profile id left by an earlier sign-in on this browser.
  rememberProfileId(7)
  const { result, unmount } = renderHook(() => useParty(1, 3))
  await joinParty(result, 'AAAAAA')
  expect(readLastParty(1, 3)).toMatchObject({ code: 'AAAAAA', partyName: 'Friday crew', userId: 1 })
  expect(readLastParty(1, 7)).toBeNull()
  expect(readLastParty(1, null)).toBeNull()
  unmount()
})

it('keeps a record for an account with no profile, and reads it back the same way', async () => {
  rememberProfileId(7)
  const { result, unmount } = renderHook(() => useParty(1, null))
  await joinParty(result, 'BBBBBB')
  expect(readLastParty(1, null)).toMatchObject({ code: 'BBBBBB' })
  expect(readLastParty(1)).toMatchObject({ code: 'BBBBBB' })
  expect(readLastParty(1, 7)).toBeNull()
  unmount()
})

it('files a leave, and what the room sends meanwhile, under the profile the party was joined as', async () => {
  const { result, rerender, unmount } = renderHook(({ profile }: { profile: number | null }) => useParty(1, profile), { initialProps: { profile: 3 as number | null } })
  await joinParty(result, 'CCCCCC')
  expect(readLastParty(1, 3)).toMatchObject({ code: 'CCCCCC' })
  // The session moves to another profile with the room socket still open.
  // That profile was never in this party: nothing is filed under it, by the
  // room's next snapshot or by the leave.
  rerender({ profile: 4 })
  const room = Socket.all.filter(s => s.url.includes('/ws/party-room')).at(-1)!
  act(() => { room.receive('party-state', { ...snapshot('CCCCCC'), party: { ...snapshot('CCCCCC').party, party_name: 'Renamed', revision: 2 } }) })
  expect(readLastParty(1, 4)).toBeNull()
  expect(readLastParty(1, 3)).toMatchObject({ code: 'CCCCCC', partyName: 'Renamed' })
  act(() => { result.current.leave() })
  expect(readLastParty(1, 4)).toBeNull()
  expect(readLastParty(1, 3)).toMatchObject({ code: 'CCCCCC' })
  unmount()
})

it('files the next party under the profile that joins it', async () => {
  const { result, rerender, unmount } = renderHook(({ profile }: { profile: number | null }) => useParty(1, profile), { initialProps: { profile: 3 as number | null } })
  await joinParty(result, 'DDDDDD')
  rerender({ profile: 4 })
  await joinParty(result, 'EEEEEE')
  expect(readLastParty(1, 4)).toMatchObject({ code: 'EEEEEE' })
  expect(readLastParty(1, 3)).toMatchObject({ code: 'DDDDDD' })
  act(() => { result.current.leave() })
  expect(readLastParty(1, 4)).toMatchObject({ code: 'EEEEEE' })
  unmount()
})
