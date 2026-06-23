// Aurora V2 — playback pre-warm.
//
// While the user lingers on a title's details page with clear intent to play
// (hovering / focusing the Play or Resume button), do the expensive
// click→play setup AHEAD of the click so playback starts faster:
//
//   - transcode / direct_stream titles: pre-create the HLS session. The
//     server's CreateSession runs two ffprobe passes + builds the ABR profile
//     ladder + spawns directories — all latency that otherwise sits between
//     the click and first frame. The player adopts the warmed session instead
//     of paying that cost again.
//   - direct_play titles: there is no session/ffmpeg, so warm the server's OS
//     page cache + the TLS/connection with a tiny ranged fetch of the file
//     head.
//
// This trades a little SPECULATIVE server work for lower latency (the opposite
// tradeoff from eliminating transcoding), so it is:
//   - INTENT-GATED — driven by button hover/focus, never by mere page view.
//   - SINGLE-SLOT  — at most one warmed session per tab; starting a new warm
//     discards the previous one.
//   - CONSUME-ONCE — the player TAKES the warmed session and owns its
//     teardown; an un-played warm is deleted on cancel, and the server's idle
//     reaper reclaims anything we miss.
//
// Correctness: takeWarmedSession() only returns a session when the warmed
// request is byte-identical (same sessionRequestKey) to what the player is
// about to send. Any mismatch returns null and the player creates a fresh
// session — a missed optimization, never a wrong stream.

import {
  buildSessionRequest,
  createSession,
  deleteSession,
  getStreamInfo,
  sessionRequestKey,
  type CreateSessionRequest,
} from './streaming'
import { withToken } from './api'

export interface PrewarmTarget {
  fileId: number
  fileType: 'media' | 'episode'
  // resume position in WHOLE seconds (0 = from the start)
  startSec: number
}

interface WarmedSession {
  // fileType:fileId:startSec — identity of the TARGET, used for hover dedup.
  targetKey: string
  // sessionRequestKey(req) — the exact request the session was created for.
  reqKey: string
  sessionId: string
  masterPlaylist: string
  startSec: number
  createdAt: number
}

// A warmed session goes stale after this; the player won't adopt an old one.
const WARM_TTL_MS = 60_000
// Direct-play page-cache warm: pull the first 2 MiB of the file head.
const DIRECT_WARM_BYTES = 2 * 1024 * 1024

// At most one warmed transcode session per tab (single-slot).
let warmed: WarmedSession | null = null
// Bookkeeping for the warm in progress so repeated hovers dedup and a
// navigate-away can cancel it.
let inflightTargetKey: string | null = null
let inflightAbort: AbortController | null = null

// Feature flag: default ON, with an instant per-browser kill switch via
// localStorage (`aurora.prewarm = "off"`). Defensive global access keeps the
// module importable in non-DOM contexts (SSR / tests).
export function prewarmEnabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('aurora.prewarm') === 'off') {
      return false
    }
  } catch {
    // localStorage can throw in private mode / sandboxed frames — treat as on.
  }
  return true
}

function targetKey(t: PrewarmTarget): string {
  return `${t.fileType}:${t.fileId}:${t.startSec}`
}

// Delete a warmed session we created but never handed to the player.
function discardWarmed(): void {
  if (warmed) {
    void deleteSession(warmed.sessionId)
    warmed = null
  }
}

// Cancel any in-flight warm and discard an unconsumed warmed session. Call on
// details-page unmount / navigate-away / button blur. Safe to call repeatedly.
export function cancelPrewarm(): void {
  inflightTargetKey = null
  if (inflightAbort) {
    inflightAbort.abort()
    inflightAbort = null
  }
  discardWarmed()
}

// Pre-warm playback for a target. No-op when disabled. Safe to call on every
// hover/focus event — deduped by target identity, and the previous warm is
// discarded when a different target supersedes it (single-slot).
export async function prewarm(t: PrewarmTarget): Promise<void> {
  if (!prewarmEnabled()) return
  const tkey = targetKey(t)
  // Already warming or already warmed this exact target → nothing to do.
  if (inflightTargetKey === tkey) return
  if (warmed && warmed.targetKey === tkey) return

  // A different target supersedes any previous warm.
  cancelPrewarm()

  const ac = new AbortController()
  inflightTargetKey = tkey
  inflightAbort = ac
  try {
    const info = await getStreamInfo(t.fileId, t.fileType, ac.signal)
    if (ac.signal.aborted || inflightTargetKey !== tkey) return
    const decision = info.stream.decision

    if (decision === 'direct_play') {
      // No ffmpeg — warm the server page cache + connection. Best-effort.
      const url = info.stream.stream_url
      if (url) {
        try {
          await fetch(withToken(url), {
            method: 'GET',
            headers: { Range: `bytes=0-${DIRECT_WARM_BYTES - 1}` },
            signal: ac.signal,
          })
        } catch {
          // network error / abort — the warm is purely opportunistic.
        }
      }
      return
    }

    // transcode / direct_stream → pre-create the session the player will use.
    const req = buildSessionRequest(info.stream, {
      fileId: t.fileId,
      fileType: t.fileType,
      startSec: t.startSec,
    })
    // Deliberately NOT abortable: a transcode CreateSession spawns a server-side
    // ffmpeg session, so we must always learn its session_id to delete it if
    // this warm was superseded/cancelled while the POST was in flight. Aborting
    // the request would lose the id and strand the session until the server's
    // idle reaper (~5 min). We instead let it complete and delete it below.
    const session = await createSession(req)
    if (ac.signal.aborted || inflightTargetKey !== tkey) {
      // Superseded / cancelled between create and store — don't strand it.
      void deleteSession(session.session_id)
      return
    }
    warmed = {
      targetKey: tkey,
      reqKey: sessionRequestKey(req),
      sessionId: session.session_id,
      masterPlaylist: session.master_playlist,
      startSec: session.start_sec ?? 0,
      createdAt: Date.now(),
    }
  } catch {
    // getStreamInfo / createSession failed or was aborted — leave nothing.
  } finally {
    if (inflightTargetKey === tkey) {
      inflightTargetKey = null
      inflightAbort = null
    }
  }
}

// Called by the player immediately before it would createSession. Returns a
// warmed session ONLY when its request is byte-identical to `req` and still
// fresh; the entry is removed (consume-once) so the player owns its teardown.
//
// On ANY miss (no warm / mismatch / stale), the player is about to create its
// OWN session, so we cancelPrewarm() to tear down a stale/mismatched warmed
// session AND cancel an in-flight warm — otherwise that warm's eventual session
// would be orphaned: it can never be adopted (its key won't match this play),
// and the App cleanup effect doesn't fire while the player overlay is open.
export function takeWarmedSession(
  req: CreateSessionRequest,
): { sessionId: string; masterPlaylist: string; startSec: number } | null {
  if (
    warmed &&
    warmed.reqKey === sessionRequestKey(req) &&
    Date.now() - warmed.createdAt <= WARM_TTL_MS
  ) {
    const s = warmed
    warmed = null // consume-once: the player now owns this session's lifecycle.
    return { sessionId: s.sessionId, masterPlaylist: s.masterPlaylist, startSec: s.startSec }
  }
  cancelPrewarm() // no-op when idle
  return null
}
