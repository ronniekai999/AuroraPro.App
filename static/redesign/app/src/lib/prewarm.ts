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
//     of paying that cost again. (Phase 2) In 'full' mode we ALSO pre-encode
//     the FIRST SEGMENT of the tier hls.js will start at, so the click hits
//     ready segments instead of a cold ~3–8s ffmpeg startup — the dominant
//     remaining latency. EnsureVariant is idempotent, so the player adopting
//     the session and fetching the same tier reuses this encode.
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
  loadBandwidthEstimate,
  sessionRequestKey,
  type CreateSessionRequest,
  type SessionProfile,
} from './streaming'
import { apiFetchResponse, withToken } from './api'
import { currentMaxStreamBps } from './appearance'

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
  // (Phase 2) aborts the in-flight first-segment pre-encode fetch when the warm
  // is discarded. The real ffmpeg teardown is deleteSession; this just releases
  // the hanging GET. Undefined in 'light' mode or when no tier was predicted.
  encodeAbort?: AbortController
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

export type PrewarmMode = 'off' | 'light' | 'full'

// Feature flag with a per-browser override via localStorage `aurora.prewarm`:
//   'off'   → no pre-warm at all (instant kill switch)
//   'light' → Phase 1 only: pre-create the session, no speculative encoding
//   (unset / anything else) → 'full': also pre-encode the predicted start tier
// Defensive global access keeps the module importable in non-DOM contexts.
export function prewarmMode(): PrewarmMode {
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem('aurora.prewarm')
      if (v === 'off') return 'off'
      if (v === 'light') return 'light'
    }
  } catch {
    // localStorage can throw in private mode / sandboxed frames — treat as full.
  }
  return 'full'
}

// Back-compat helper: pre-warm is active unless explicitly turned off.
export function prewarmEnabled(): boolean {
  return prewarmMode() !== 'off'
}

function targetKey(t: PrewarmTarget): string {
  return `${t.fileType}:${t.fileId}:${t.startSec}`
}

// Predict which ABR tier hls.js will START at, so we pre-encode that one. The
// player runs hls.js with startLevel -1 (auto) + capLevelToPlayerSize, seeded by
// abrEwmaDefaultEstimate = loadBandwidthEstimate(). We replicate BOTH gates:
//
//   1. Player-size cap (hls.js capLevelToPlayerSize, v1.6.16): it caps to the
//      smallest level whose WIDTH **or** HEIGHT >= squareSize, where
//      squareSize = max(playerW, playerH) * devicePixelRatio. The player isn't
//      open at hover time, so we approximate its element with the viewport
//      (it opens as a near-fullscreen overlay). NOTE: a height-only screen cap
//      is WRONG here — hls.js's cap is driven by the width-or-height compare,
//      so e.g. a Retina laptop with a big window starts 2160p even though its
//      screen HEIGHT is < 2160 (review 2026-06 finding).
//   2. Bandwidth: among the size-allowed tiers, the highest whose declared
//      BANDWIDTH <= the persisted estimate.
//
// `profiles` order from the server is not trusted — we sort highest-first here.
// A wrong guess is cheap (the session is still adopted, so it's never a latency
// regression — just one mis-encoded tier idle-reaped in ~75s), so an
// approximation of the player element by the viewport is the right call.
function predictTier(profiles: SessionProfile[] | undefined): string | null {
  if (!profiles || profiles.length === 0) return null
  const ladder = [...profiles].sort((a, b) => b.bandwidth - a.bandwidth) // highest-first
  const bw = loadBandwidthEstimate()

  // squareSize = max(viewportW, viewportH) * dpr; Infinity (= no cap) in non-DOM.
  let squareSize = Infinity
  try {
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1
    const w = typeof innerWidth === 'number' ? innerWidth : 0
    const h = typeof innerHeight === 'number' ? innerHeight : 0
    if (w > 0 && h > 0) squareSize = Math.max(w, h) * dpr
  } catch {
    // non-DOM / blocked — leave uncapped (bandwidth-only prediction).
  }

  // Resolution cap = the smallest (lowest-res) tier whose width OR height
  // reaches squareSize; higher-res tiers are capped out. None reach it → no cap
  // (allow the top tier). Mirrors hls.js getMaxLevelByMediaSize.
  let capIdx = 0
  for (let i = ladder.length - 1; i >= 0; i--) {
    if (ladder[i].width >= squareSize || ladder[i].height >= squareSize) {
      capIdx = i
      break
    }
  }
  // Among the size-allowed tiers (capIdx..lowest), the highest whose bandwidth
  // fits the seed; fall back to the lowest tier when nothing fits.
  for (let i = capIdx; i < ladder.length; i++) {
    if (ladder[i].bandwidth <= bw) return ladder[i].name
  }
  return ladder[ladder.length - 1].name
}

// Pre-encode the first segment of `tier` by fetching its variant playlist — a
// GET that triggers EnsureVariant server-side and blocks until the first segment
// is written to disk. We go through apiFetchResponse so it rides the same
// httpOnly cookie AND gets the 401→refresh→retry path (a long hover can outlive
// the 15-min access cookie). Fire-and-forget so prewarm() returns promptly while
// ffmpeg works; the returned controller lets discardWarmed() / adoption release
// the hanging GET (real ffmpeg teardown is via deleteSession). The playlist body
// is irrelevant — the GET's SIDE EFFECT is the point — so we just drain it to
// free the socket.
function preEncodeFirstSegment(sessionId: string, tier: string): AbortController {
  const ac = new AbortController()
  void apiFetchResponse(`/api/stream/hls/${sessionId}/${encodeURIComponent(tier)}/stream.m3u8`, {
    signal: ac.signal,
  })
    .then((r) => { void r.text() })
    .catch(() => {
      // aborted / network / 503 readiness-timeout — speculative, ignore.
    })
  return ac
}

// Delete a warmed session we created but never handed to the player, and stop
// any in-flight first-segment pre-encode.
function discardWarmed(): void {
  if (warmed) {
    warmed.encodeAbort?.abort()
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
  const mode = prewarmMode()
  if (mode === 'off') return
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
      // Same source the player reads — a mismatch here would make every
      // warmed session miss its request key and get thrown away.
      maxBps: currentMaxStreamBps(),
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
    // Phase 2 ('full' mode): pre-encode the FIRST SEGMENT of the tier hls.js
    // will start at, so the click hits ready segments instead of a cold ffmpeg
    // (~3s at 1080p, ~8s at 4K — the dominant click→play latency). The warm is
    // already stored above, so a supersede/cancel deletes the session (and thus
    // this ffmpeg) cleanly. 'light' mode and profile-less responses skip this.
    if (mode === 'full') {
      const tier = predictTier(session.profiles)
      if (tier) warmed.encodeAbort = preEncodeFirstSegment(session.session_id, tier)
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
    // The player opens its OWN variant fetch for this session, so abort our now-
    // redundant speculative pre-encode GET — otherwise it keeps a second blocked
    // connection/goroutine for the whole first-segment readiness window. The
    // ffmpeg keeps running (EnsureVariant is idempotent; the player's fetch joins
    // the same encode), so we lose nothing but the duplicate socket.
    s.encodeAbort?.abort()
    return { sessionId: s.sessionId, masterPlaylist: s.masterPlaylist, startSec: s.startSec }
  }
  cancelPrewarm() // no-op when idle
  return null
}
