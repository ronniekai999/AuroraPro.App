// @vitest-environment jsdom
//
// The server leaves the admin alerts (a member's new request, scan results)
// out of the notification feed for a session without the admin powers, one
// acting as a restricted profile on an admin account. So the feed must be read
// again, and the previous profile's dropped, when the session's profile or its
// admin powers change, and a read made for the previous one must not land.

import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useNotificationSeed, type NotificationSeedOptions } from './useNotificationSeed'
import type { NotificationsResponse } from '@/lib/api'

function deferred() {
  let resolve!: (res: NotificationsResponse) => void
  const promise = new Promise<NotificationsResponse>(r => { resolve = r })
  return { promise, resolve }
}

const feed = (unread: number): NotificationsResponse => ({ notifications: [], unread })

describe('useNotificationSeed', () => {
  it('re-reads when the session key changes, and drops the earlier answer', async () => {
    const reads = [deferred(), deferred()]
    const signals: AbortSignal[] = []
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return reads[signals.length - 1].promise
    })
    const onReset = vi.fn()
    const onLoaded = vi.fn()
    const props = (sessionKey: string): NotificationSeedOptions => ({
      enabled: true, sessionKey, load, onReset, onLoaded,
    })
    const { rerender, unmount } = renderHook((o: NotificationSeedOptions) => useNotificationSeed(o), {
      initialProps: props('parent:true'),
    })
    expect(load).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledTimes(1)

    // New callbacks, same key: no re-read.
    rerender({ ...props('parent:true'), onReset: vi.fn(), onLoaded })
    expect(load).toHaveBeenCalledTimes(1)

    // A switch to the kid's profile: the parent's read is aborted, the feed
    // reset, and read again.
    rerender(props('kid:false'))
    expect(load).toHaveBeenCalledTimes(2)
    expect(onReset).toHaveBeenCalledTimes(2)
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)

    // The parent's answer arriving late does not land; the kid's does.
    await act(async () => { reads[0].resolve(feed(3)) })
    expect(onLoaded).not.toHaveBeenCalled()
    await act(async () => { reads[1].resolve(feed(1)) })
    expect(onLoaded).toHaveBeenCalledTimes(1)
    expect(onLoaded).toHaveBeenCalledWith(feed(1))

    unmount()
    expect(signals[1].aborted).toBe(true)
  })

  it('reads nothing until enabled', () => {
    const load = vi.fn(() => deferred().promise)
    const onReset = vi.fn()
    const { rerender } = renderHook((o: NotificationSeedOptions) => useNotificationSeed(o), {
      initialProps: { enabled: false, sessionKey: 'k', load, onReset, onLoaded: () => {} },
    })
    expect(load).not.toHaveBeenCalled()
    expect(onReset).not.toHaveBeenCalled()
    rerender({ enabled: true, sessionKey: 'k', load, onReset, onLoaded: () => {} })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('treats a failed read as an empty bell', async () => {
    const onLoaded = vi.fn()
    renderHook(() => useNotificationSeed({
      enabled: true, sessionKey: 'k', load: () => Promise.reject(new Error('down')), onReset: () => {}, onLoaded,
    }))
    await act(async () => {})
    expect(onLoaded).not.toHaveBeenCalled()
  })
})
