// @vitest-environment jsdom
//
// The companion's connection, against a stand-in for the room socket.
//
// What is pinned is the ORDER the connection really goes through, since the
// room draws from it: the socket is "connected" as it opens, and the room's
// state (the people, the chat's history, what is playing) arrives in a
// message after that. A screen that treated "connected" as "the history is
// here" read the whole history aloud.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  getStoredUser: () => ({ id: 1, username: 'morgan' }),
  refreshAccessToken: vi.fn(async () => true),
}))
vi.mock('@/lib/voice', () => ({
  createVoiceController: () => ({
    getState: () => ({ enabled: false, muted: true, peers: [], selfSpeaking: false, status: '' }),
    subscribe: () => () => {},
    handleInbound: () => {},
    onRoomSocketDown: () => {},
    join: async () => {},
    toggleMute: () => {},
    leave: () => {},
  }),
}))

import { useCompanion } from './useCompanion'

/** A socket the test opens, feeds and drops. */
class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  sent: { type: string; payload?: unknown }[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) { this.url = url; FakeSocket.all.push(this) }
  send(raw: string) { this.sent.push(JSON.parse(raw)) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
  drop() { this.readyState = 3; this.onclose?.() }
}
const socket = () => FakeSocket.all[FakeSocket.all.length - 1]
const STATE = {
  type: 'party-state',
  payload: {
    party: { code: 'FRD4YC', party_name: 'Friday crew', media_item_id: 107, media_title: 'Kestrel', host_user_id: 2, is_playing: true, current_time_ms: 1000 },
    participants: [{ user_id: 2, username: 'priya', is_host: true, is_buffering: false, last_seen: '', ready: true }],
    chat_history: [{ id: 'c1', user_id: 2, username: 'priya', message: 'hello', timestamp: '' }],
  },
}

beforeEach(() => { FakeSocket.all = []; vi.stubGlobal('WebSocket', FakeSocket) })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('the companion\'s connection', () => {
  it('is connected as the socket opens, and has the room\'s state only once the server has sent it', () => {
    const { result } = renderHook(() => useCompanion())
    expect(result.current.state).toMatchObject({ status: 'idle', connected: false, synced: false })
    act(() => { result.current.join('frd4yc') })
    expect(result.current.state).toMatchObject({ status: 'joining', connected: false, synced: false, code: 'FRD4YC' })
    expect(socket().url).toContain('companion=1')

    act(() => socket().open())
    // Open, and asked to join; nothing has arrived yet.
    expect(socket().sent).toEqual([{ type: 'join-party', payload: { party_code: 'FRD4YC' } }])
    expect(result.current.state).toMatchObject({ status: 'connected', connected: true, synced: false, chat: [] })

    act(() => socket().receive(STATE))
    expect(result.current.state).toMatchObject({ status: 'connected', connected: true, synced: true, partyName: 'Friday crew' })
    expect(result.current.state.chat).toHaveLength(1)
  })

  it('has no state again from a drop until the server sends it anew', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCompanion())
    act(() => { result.current.join('FRD4YC') })
    act(() => socket().open())
    act(() => socket().receive(STATE))
    const first = socket()
    act(() => first.drop())
    expect(result.current.state).toMatchObject({ status: 'reconnecting', connected: false, reconnecting: true, synced: false })
    // The history it had is still held, and is not news when it returns.
    expect(result.current.state.chat).toHaveLength(1)
  })

  it('says whether a message was sent', () => {
    const { result } = renderHook(() => useCompanion())
    // Nothing to send to.
    expect(result.current.sendChat('hello')).toBe(false)
    act(() => { result.current.join('FRD4YC') })
    // Not open yet.
    expect(result.current.sendChat('hello')).toBe(false)
    act(() => socket().open())
    expect(result.current.sendChat('   ')).toBe(false)
    expect(result.current.sendChat('  hello  ')).toBe(true)
    expect(socket().sent[socket().sent.length - 1]).toEqual({ type: 'chat', payload: { message: 'hello' } })
    const open = socket()
    act(() => open.drop())
    expect(result.current.sendChat('lost?')).toBe(false)
  })

  it('starts from nothing at each join', () => {
    const { result } = renderHook(() => useCompanion())
    act(() => { result.current.join('FRD4YC') })
    act(() => socket().open())
    act(() => socket().receive(STATE))
    act(() => { result.current.join('MOON42') })
    expect(result.current.state).toMatchObject({ status: 'joining', synced: false, code: 'MOON42', chat: [] })
  })
})
