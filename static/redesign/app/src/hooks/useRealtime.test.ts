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

describe('useRealtime library_update', () => {
  it('hands library_update payloads to onLibraryUpdate', () => {
    const onLibraryUpdate = vi.fn()
    renderHook(() => useRealtime({ enabled: true, connectionKey: 1, onLibraryUpdate }))
    const payload = { library_id: 3, library_name: 'Movies', new_items: 2, action: 'items_added' }
    FakeSocket.opened[0].onmessage?.({ data: JSON.stringify({ type: 'library_update', data: payload }) })
    FakeSocket.opened[0].onmessage?.({ data: JSON.stringify({ type: 'scan_progress', data: { library_id: 3 } }) })
    expect(onLibraryUpdate).toHaveBeenCalledTimes(1)
    expect(onLibraryUpdate).toHaveBeenCalledWith(payload)
  })
})

describe('useRealtime onReconnect', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fires when the socket opens again after dropping, not on the first open', () => {
    const onReconnect = vi.fn()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    renderHook(() => useRealtime({ enabled: true, connectionKey: 1, onReconnect }))
    FakeSocket.opened[0].onopen?.()
    expect(onReconnect).not.toHaveBeenCalled()
    FakeSocket.opened[0].onclose?.()
    vi.advanceTimersByTime(30_000)
    expect(FakeSocket.opened).toHaveLength(2)
    FakeSocket.opened[1].onopen?.()
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('does not fire for a reopen a new connection key caused', () => {
    const onReconnect = vi.fn()
    const { rerender } = renderHook((h: RealtimeHandlers) => useRealtime(h), {
      initialProps: { enabled: true, connectionKey: 1, onReconnect } as RealtimeHandlers,
    })
    FakeSocket.opened[0].onopen?.()
    rerender({ enabled: true, connectionKey: 2, onReconnect })
    FakeSocket.opened[1].onopen?.()
    expect(onReconnect).not.toHaveBeenCalled()
  })
})
