import { useEffect, useLayoutEffect, useRef } from 'react'
import type { NotificationsResponse } from '@/lib/api'

export interface NotificationSeedOptions {
  // Gate: read the feed only while true.
  enabled: boolean
  // A change re-reads the feed. The server leaves the admin alerts out for a
  // session without the admin powers (one acting as a restricted profile on
  // an admin account), so the app passes the session's profile and powers.
  sessionKey: string | number | null
  load: (signal: AbortSignal) => Promise<NotificationsResponse>
  // Called before each read, to drop what was read for the previous key.
  onReset: () => void
  // Called with the read's answer, unless the key, the gate or the component
  // moved on before it arrived.
  onLoaded: (res: NotificationsResponse) => void
}

// useNotificationSeed reads the notification feed (the bell and its unread
// count) when enabled, and again whenever sessionKey changes, aborting a read
// still in flight and dropping its answer. Callbacks are read through a ref, so
// changing their identity each render does not re-read.
export function useNotificationSeed(opts: NotificationSeedOptions): void {
  const optsRef = useRef(opts)

  useLayoutEffect(() => {
    optsRef.current = opts
  }, [opts])

  const { enabled, sessionKey } = opts

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const ac = new AbortController()
    optsRef.current.onReset()
    optsRef.current
      .load(ac.signal)
      .then(res => {
        if (!cancelled) optsRef.current.onLoaded(res)
      })
      .catch(() => {
        /* non-fatal — the bell just stays empty */
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [enabled, sessionKey])
}
