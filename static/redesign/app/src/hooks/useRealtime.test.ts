// @vitest-environment jsdom
//
// The /ws socket's role is fixed by the server when it connects: a session
// acting as a restricted profile on an admin account gets the user's events,
// not the admin-only ones. So the socket must reopen when the session's
// profile changes, and only then.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRealtime, type RealtimeHandlers } from './useRealtime'

class FakeSocket {
  static opened: FakeSocket[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.opened.push(this)
  }
  close() { this.closed = true }
}

beforeEach(() => {
  FakeSocket.opened = []
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => vi.unstubAllGlobals())

describe('useRealtime connection key', () => {
  it('reopens the socket when the key changes, and not when only a callback does', () => {
    const { rerender, unmount } = renderHook((h: RealtimeHandlers) => useRealtime(h), {
      initialProps: { enabled: true, connectionKey: 1, onNotification: () => {} },
    })
    expect(FakeSocket.opened).toHaveLength(1)

    rerender({ enabled: true, connectionKey: 1, onNotification: () => {} })
    expect(FakeSocket.opened).toHaveLength(1)

    rerender({ enabled: true, connectionKey: 2, onNotification: () => {} })
    expect(FakeSocket.opened).toHaveLength(2)
    expect(FakeSocket.opened[0].closed).toBe(true)
    expect(FakeSocket.opened[1].closed).toBe(false)

    unmount()
    expect(FakeSocket.opened[1].closed).toBe(true)
  })

  it('opens nothing while disabled', () => {
    renderHook(() => useRealtime({ enabled: false, connectionKey: 1 }))
    expect(FakeSocket.opened).toHaveLength(0)
  })
})
