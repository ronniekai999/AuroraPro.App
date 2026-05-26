// Aurora V2 — PartyHubModal
//
// Replaces the original "type a 6-character code" modal that App.tsx
// used to surface when the user clicked the watch-party header button
// while not in a party. The old modal was the source of the "no way
// to rejoin" complaint: after a user clicked Leave Party, the only
// path back was to remember and re-type the 6-character code.
//
// This modal is now a small Watch Party hub with three sections:
//
//   1. Recently in — read from lib/lastParty's localStorage cache.
//      Shows the just-left or just-refreshed party as a one-click
//      Rejoin pill. Per-user scoped so logging in/out doesn't leak
//      a different user's history.
//
//   2. My Rooms — calls GET /api/rooms, lists the user's persistent
//      rooms with a Live/Idle status pill. Live rooms have an
//      active_party_code that one-clicks into a join. Idle rooms
//      show a note that the user needs to start the party from a
//      media detail page (in-modal media picker is deferred — too
//      much surface for a v1 modal). Includes a small Create Room
//      affordance so users no longer need admin access just to make
//      a stable code.
//
//   3. Or enter a code — the original manual-code input, preserved
//      for friends-of-friends inviting via copy/paste.
//
// Loading semantics:
//   - The Recently in pill is synchronous (localStorage).
//   - My Rooms fetches on mount; the rest of the modal works while
//     it's in flight so the manual code path is never blocked.
//   - Create Room is optimistic: on success we prepend to the local
//     list and let the user act on it immediately.

import { useEffect, useState, useCallback } from 'react'
import { listRooms, createRoom, type Room } from '@/lib/api'
import {
  readLastParty,
  clearLastParty,
  type LastPartyEntry,
} from '@/lib/lastParty'

export interface PartyHubModalProps {
  // Current user id — used to scope the Recently in pill so users
  // don't see each other's history on a shared browser.
  currentUserId: number
  // Submit a 6-character code to join. The hook returns ok=true on
  // successful WebSocket open, ok=false with an error string otherwise.
  // The modal closes on success and surfaces the error inline on failure.
  onJoin: (code: string) => Promise<{ ok: boolean; error?: string }>
  // Close without joining (Cancel button + backdrop click).
  onClose: () => void
}

export function PartyHubModal({ currentUserId, onJoin, onClose }: PartyHubModalProps) {
  // Read the cached entry once on open. We deliberately don't
  // subscribe to localStorage changes — the modal is short-lived and
  // any change while it's open is from the user's own actions inside
  // this same component, so we update local state directly.
  const [lastParty, setLastParty] = useState<LastPartyEntry | null>(() =>
    readLastParty(currentUserId)
  )

  // Manual code input. Uppercase + alphanumeric-only to match the
  // server's 6-char [A-Z0-9] code format. Pre-filled from the cache
  // when present so the manual flow benefits from the rejoin context
  // too (the user can tweak the last digit if they fat-fingered it).
  const [code, setCode] = useState(() => lastParty?.code ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // My Rooms async fetch. Null = loading; [] = loaded empty; Room[] =
  // loaded with items. Errors are captured in roomsError and surfaced
  // inline; we don't block the rest of the modal on a /api/rooms
  // failure since the manual-code path is independent.
  const [rooms, setRooms] = useState<Room[] | null>(null)
  const [roomsError, setRoomsError] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    listRooms(ac.signal)
      .then(setRooms)
      .catch((err: unknown) => {
        // AbortError fires when the modal unmounts mid-fetch — that's
        // expected, not a user-facing problem.
        if (err instanceof Error && err.name === 'AbortError') return
        setRoomsError(err instanceof Error ? err.message : 'Failed to load rooms')
        setRooms([]) // unblock the UI even on failure
      })
    return () => ac.abort()
  }, [])

  // Submit helper shared between the Recently in pill, My Rooms join,
  // and the manual code input. Centralizes the busy/error handling so
  // each call site is one line.
  const attemptJoin = useCallback(async (target: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await onJoin(target)
    setBusy(false)
    if (!result.ok) {
      // Surface the server's error message. If the cached code is the
      // one that failed AND it looks like a "party ended" failure, clear
      // the cache so the user isn't re-prompted to click a dead link.
      setError(result.error ?? 'Failed to join party')
      if (lastParty && target === lastParty.code) {
        const msg = (result.error ?? '').toLowerCase()
        if (msg.includes('invalid') || msg.includes('ended') ||
            msg.includes('not found') || msg.includes('persistent room')) {
          clearLastParty()
          setLastParty(null)
        }
      }
      return
    }
    // onJoin success path — App.tsx is responsible for closing the
    // modal and opening the panel; we just call onClose to be safe in
    // case App.tsx's state update hasn't propagated yet.
    onClose()
  }, [busy, onJoin, onClose, lastParty])

  // Create Room inline form state. Hidden behind a "Create a room"
  // toggle so the modal doesn't look noisy when the user just wants
  // to enter a code.
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const submitCreateRoom = useCallback(async () => {
    const name = createName.trim()
    if (!name) return
    setCreateBusy(true)
    setCreateError(null)
    try {
      const room = await createRoom({ name })
      // Optimistic prepend so the new room shows up at the top with a
      // brief flash. Reloading from the server would be more
      // authoritative but the createRoom response already contains
      // the canonical row.
      setRooms(prev => prev ? [room, ...prev] : [room])
      setCreateName('')
      setCreateOpen(false)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create room')
    } finally {
      setCreateBusy(false)
    }
  }, [createName])

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-[#0a0a0f] border border-white/[0.06] rounded-2xl p-6 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-white text-lg font-semibold mb-1">Watch Party</h2>
        <p className="text-white/50 text-xs mb-5">
          Rejoin where you left off, pick a room, or enter a code.
        </p>

        {/* ─── Section 1: Recently in ─────────────────────────────────── */}
        {lastParty && (
          <div className="mb-5">
            <p className="text-white/40 text-[10px] uppercase tracking-wider mb-2">Recently in</p>
            <button
              disabled={busy}
              onClick={() => void attemptJoin(lastParty.code)}
              className="w-full text-left p-3 rounded-lg bg-purple-600/10 hover:bg-purple-600/20 border border-purple-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="text-white/95 text-sm font-medium truncate">
                  {lastParty.partyName || lastParty.mediaTitle || 'Watch Party'}
                  {lastParty.wasHost && (
                    <span className="ml-2 text-purple-300 text-[10px] font-semibold uppercase">
                      was host
                    </span>
                  )}
                </p>
                <p className="text-purple-300/80 text-xs font-mono mt-0.5">{lastParty.code}</p>
              </div>
              <span className="px-3 py-1.5 rounded-md bg-purple-600/30 text-purple-100 text-xs font-medium flex-shrink-0">
                Rejoin →
              </span>
            </button>
            {lastParty.wasHost && (
              <p className="text-amber-300/70 text-[11px] mt-2 leading-snug">
                Quick parties end when the host leaves — rejoin may say the party has ended.
                Persistent rooms (below) survive host leaves.
              </p>
            )}
          </div>
        )}

        {/* ─── Section 2: My Rooms ────────────────────────────────────── */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-white/40 text-[10px] uppercase tracking-wider">My Rooms</p>
            <button
              onClick={() => setCreateOpen(o => !o)}
              className="text-purple-400 hover:text-purple-300 text-xs"
            >
              {createOpen ? 'Cancel' : '+ New room'}
            </button>
          </div>

          {/* Inline create form */}
          {createOpen && (
            <div className="mb-3 p-3 rounded-lg bg-white/[0.03] border border-white/[0.06]">
              <input
                type="text"
                autoFocus
                maxLength={200}
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void submitCreateRoom() }}
                placeholder="Room name (e.g. Movie Night Crew)"
                className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm placeholder:text-white/30 focus:bg-white/[0.06] focus:outline-none"
              />
              {createError && <p className="text-red-400 text-xs mt-2">{createError}</p>}
              <div className="flex justify-end mt-2">
                <button
                  disabled={!createName.trim() || createBusy}
                  onClick={() => void submitCreateRoom()}
                  className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {createBusy ? 'Creating…' : 'Create'}
                </button>
              </div>
              <p className="text-white/40 text-[10px] mt-2">
                Stable code that survives across watch parties. Start a party from any movie's
                detail page — your friends rejoin via the same code every time.
              </p>
            </div>
          )}

          {rooms === null && <p className="text-white/40 text-xs py-2">Loading…</p>}
          {rooms !== null && rooms.length === 0 && !createOpen && (
            <p className="text-white/40 text-xs py-2">
              No persistent rooms yet. Create one above for a stable join code.
            </p>
          )}
          {roomsError && (
            <p className="text-amber-300/80 text-xs mb-2">Couldn't load rooms: {roomsError}</p>
          )}
          {rooms && rooms.length > 0 && (
            <div className="space-y-1.5">
              {rooms.map(r => {
                const live = !!r.active_party_code
                return (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-white/90 text-sm font-medium truncate">{r.name}</p>
                      <p className="text-white/40 text-[10px] font-mono mt-0.5">{r.code}</p>
                    </div>
                    {live ? (
                      <button
                        disabled={busy}
                        onClick={() => void attemptJoin(r.active_party_code!)}
                        className="px-3 py-1.5 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/40 text-emerald-200 text-xs font-medium transition-colors disabled:opacity-50 flex items-center gap-1.5 flex-shrink-0"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        Join now
                      </button>
                    ) : (
                      <span
                        className="px-2.5 py-1 rounded-md bg-white/[0.04] text-white/40 text-[10px] uppercase flex-shrink-0"
                        title="Start a party from any movie's detail page — your room's code will be reused."
                      >
                        Idle
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ─── Section 3: Enter a code ─────────────────────────────────── */}
        <div>
          <p className="text-white/40 text-[10px] uppercase tracking-wider mb-2">Or enter a code</p>
          <input
            type="text"
            maxLength={6}
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            onKeyDown={e => {
              if (e.key === 'Enter' && code.length === 6 && !busy) {
                void attemptJoin(code)
              }
            }}
            placeholder="ABC123"
            className="w-full px-4 py-3 bg-white/[0.04] border border-white/[0.06] rounded-lg text-white text-center text-2xl tracking-[0.4em] font-mono uppercase focus:outline-none focus:bg-white/[0.06]"
          />
          {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
          <div className="mt-4 flex gap-2 justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-white/70 hover:text-white text-sm transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={code.length !== 6 || busy}
              onClick={() => void attemptJoin(code)}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? 'Joining…' : 'Join'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
