import { useEffect, useLayoutEffect, useRef } from 'react'
import { buildAppWsUrl } from '@/lib/party'
import type { AppNotification, MediaRequest } from '@/lib/api'

// request_status WebSocket payload (server: broadcastRequestStatus +
// RequestMonitor inline maps in request_handlers.go). error_message is present
// only on failure transitions.
export interface RequestStatusEvent {
  request_id: number
  status: MediaRequest['status']
  title?: string
  media_type?: string
  error_message?: string
}

// discover_ready WebSocket payload (server: hero_handlers.go kickDiscoverBuild
// → BroadcastToUser). Fired when a profile's LLM-curated Discover rails finish
// building on the cold path, so the client can re-fetch + splice them live.
export interface DiscoverReadyEvent {
  profile_id: number
}

export interface RealtimeHandlers {
  // Gate: open the socket only while logged in. Flipping false tears it down.
  enabled: boolean
  onRequestStatus?: (ev: RequestStatusEvent) => void
  onNotification?: (n: AppNotification) => void
  onDiscoverReady?: (ev: DiscoverReadyEvent) => void
}

// useRealtime maintains ONE app-lifetime WebSocket to the shared hub (/ws) while
// `enabled`, dispatching the server's {type, data} envelopes to the supplied
// callbacks and reconnecting with capped, jittered backoff. It is the SPA's only
// always-on socket (the party sockets are watch-party-scoped and on-demand).
//
// Auth rides the same-origin httpOnly access cookie (the /ws upgrade reads it via
// requireQueryTokenClaims), so no token is passed. The hub pings every ~50s and
// the browser auto-pongs, so no client-side heartbeat is required.
//
// Callbacks are read through a ref so changing their identity each render does
// NOT reconnect the socket — only `enabled` drives connect/teardown.
export function useRealtime(handlers: RealtimeHandlers): void {
  const handlersRef = useRef(handlers)

  useLayoutEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  const enabled = handlers.enabled

  useEffect(() => {
    if (!enabled) return

    let ws: WebSocket | null = null
    let closedByUs = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    const scheduleReconnect = () => {
      if (closedByUs || reconnectTimer) return
      attempt += 1
      // Exponential backoff capped at 30s, halved + jittered to avoid a
      // thundering-herd reconnect after a server blip.
      const base = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5))
      const delay = base / 2 + Math.random() * (base / 2)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    const connect = () => {
      if (closedByUs) return
      let socket: WebSocket
      try {
        socket = new WebSocket(buildAppWsUrl())
      } catch {
        scheduleReconnect()
        return
      }
      ws = socket

      socket.onopen = () => {
        attempt = 0 // reset backoff on a healthy connection
      }

      socket.onmessage = (e) => {
        if (typeof e.data !== 'string') return
        let msg: { type?: unknown; data?: unknown }
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }
        if (!msg || typeof msg.type !== 'string') return
        const h = handlersRef.current
        switch (msg.type) {
          case 'request_status':
            if (h.onRequestStatus && msg.data && typeof msg.data === 'object') {
              h.onRequestStatus(msg.data as RequestStatusEvent)
            }
            break
          case 'notification':
            if (h.onNotification && msg.data && typeof msg.data === 'object') {
              h.onNotification(msg.data as AppNotification)
            }
            break
          case 'discover_ready':
            if (h.onDiscoverReady && msg.data && typeof msg.data === 'object') {
              h.onDiscoverReady(msg.data as DiscoverReadyEvent)
            }
            break
          // request_progress / scan_progress / now_playing / party_* are not
          // consumed here — ignored so unrelated hub traffic is a cheap no-op.
          default:
            break
        }
      }

      socket.onclose = () => {
        ws = null
        scheduleReconnect()
      }

      socket.onerror = () => {
        // Force a close so onclose (and thus the reconnect) fires consistently.
        try {
          socket.close()
        } catch {
          /* already closing */
        }
      }
    }

    connect()

    return () => {
      closedByUs = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (ws) {
        // Detach handlers so a late close/message after unmount is inert.
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
        try {
          ws.close()
        } catch {
          /* noop */
        }
        ws = null
      }
    }
  }, [enabled])
}
