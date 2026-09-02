// Pure policy for the two places where watch-party state meets the player.
// Keeping these decisions out of App/VideoPlayer makes the lifecycle rules
// explicit and regression-testable without mounting the 4k-line player.

export interface PartyPlayerSnapshot {
  code: string | null
  mediaItemId?: number
  episodeId?: number
  hostUserId?: number
  isPlaying: boolean
  currentTimeMs: number
}

export type PlaybackDeliveryMode = 'idle' | 'resolving' | 'direct' | 'hls'

/** A seek during stream/session resolution must replace the pending target. */
export function shouldRebuildSeekBeforeDeliveryReady(
  mode: PlaybackDeliveryMode,
): boolean {
  return mode === 'idle' || mode === 'resolving'
}

/** A newer remote seek supersedes any target that has not finished booting. */
export function shouldReplaceUnreadyTargetForExplicitSeek(
  playerReady: boolean,
  canRebuild: boolean,
): boolean {
  return !playerReady && canRebuild
}

/** Ignore the synthetic media-element pause caused by target teardown. */
export function pauseIntentForReplacementSeek(
  playerReady: boolean,
  mediaElementPaused: boolean,
  inFlightPauseIntent: boolean | null,
  inFlightPartyRevision: number | null = null,
  partyControlsMedia = false,
  latestPartyRunning: boolean | null = null,
  latestPartyRevision: number | null = null,
): boolean {
  if (playerReady || inFlightPauseIntent === null) return mediaElementPaused
  return pauseIntentAfterNewerPartyState(
    inFlightPauseIntent,
    partyControlsMedia,
    latestPartyRunning,
    inFlightPartyRevision,
    latestPartyRevision,
  )
}

/** A newer canonical playback revision supersedes point-in-time seek intent. */
function pauseIntentAfterNewerPartyState(
  capturedPause: boolean,
  partyControlsMedia: boolean,
  latestPartyRunning: boolean | null,
  capturedPartyRevision: number | null,
  latestPartyRevision: number | null,
): boolean {
  if (partyControlsMedia &&
      latestPartyRunning !== null &&
      capturedPartyRevision !== null &&
      latestPartyRevision !== null &&
      latestPartyRevision > capturedPartyRevision) {
    return !latestPartyRunning
  }
  return capturedPause
}

/**
 * Identity of one auto-open lifecycle.
 *
 * The role, rather than the host's user id, is part of the key. If a guest who
 * dismissed the player is promoted, their role changes and the new host gets
 * the controls they now need. A hand-off between two *other* users leaves that
 * guest's dismissal intact.
 */
export function partyPlayerAutoOpenKey(
  party: PartyPlayerSnapshot,
  userId: number,
): string | null {
  if (!party.code || party.mediaItemId == null || party.hostUserId == null) return null
  const role = party.hostUserId === userId ? 'host' : 'guest'
  return `${party.code}:${party.mediaItemId}:${party.episodeId ?? 0}:${role}`
}

/** Manual Close dismisses a visible player or a genuinely pending resolver. */
export function partyPlayerDismissalKeyOnClose(
  party: PartyPlayerSnapshot,
  userId: number,
  hasPlayer: boolean,
  dismissPendingResolution = false,
): string | null {
  return hasPlayer || dismissPendingResolution
    ? partyPlayerAutoOpenKey(party, userId)
    : null
}

/** URL-driven navigation must share the in-app close behavior. */
export function shouldClosePlayerOnPathChange(
  previousPathname: string,
  currentPathname: string,
  playerMinimized: boolean,
): boolean {
  return previousPathname !== currentPathname && !playerMinimized
}

/** Only the newest, still-live async playback resolver may open the player. */
export function isPlaybackResolutionCurrent(
  startedGeneration: number,
  latestGeneration: number,
  aborted: boolean,
): boolean {
  return !aborted && startedGeneration === latestGeneration
}

/** Whether party recovery should open a player on this render. */
export function shouldAutoOpenPartyPlayer(
  party: PartyPlayerSnapshot,
  userId: number,
  hasPlayer: boolean,
  dismissedKey: string | null,
): boolean {
  const key = partyPlayerAutoOpenKey(party, userId)
  if (!key || hasPlayer) return false

  // Promotion needs to re-arm controls for the new host. Demotion does not:
  // someone who deliberately closed as host should remain closed after a
  // hand-off instead of being reopened merely because they are now a guest.
  const lifecyclePrefix = key.slice(0, key.lastIndexOf(':') + 1)
  const dismissedForThisLifecycle = dismissedKey === key ||
    (key === `${lifecyclePrefix}guest` && dismissedKey === `${lifecyclePrefix}host`)
  if (dismissedForThisLifecycle) return false

  const isHost = party.hostUserId === userId
  // Guests enter only once playback starts. A newly promoted host also needs
  // controls for a paused, already-started party so they can resume it.
  return party.isPlaying || (isHost && party.currentTimeMs > 0)
}

/**
 * Sequential HLS can seek only inside the active session's produced window.
 * A target before the FFmpeg -ss anchor or at/past the servable edge needs a
 * fresh session anchored at that absolute media position.
 *
 * The servable edge is the FURTHER of two things: what hls.js has buffered
 * around the playhead, and what the server has actually produced — the end
 * of the last fragment in the current level's playlist (`producedEndSec`,
 * absolute seconds). Before that second input existed this compared against
 * the buffered edge alone, which is 30–60 s ahead of the playhead at most,
 * while the encoder (paced at 4× realtime) can be tens of minutes ahead. So
 * every skip longer than the buffer tore the session down and paid a cold
 * FFmpeg start for content that was already on disk. hls.js seeks anywhere
 * inside a playlist's fragment range by itself, including inside a
 * still-growing EVENT playlist, so only a target past what has been produced
 * needs the rebuild. Callers without a produced edge (native HLS, older
 * servers) pass 0 and keep the buffered-edge behaviour.
 */
export function needsHlsSessionRebuild(
  targetSec: number,
  sessionStartSec: number,
  bufferedEndSec: number,
  edgeToleranceSec = 0.5,
  producedEndSec = 0,
): boolean {
  const target = Math.max(0, targetSec)
  const start = Math.max(0, sessionStartSec)
  if (target < start) return true

  const servableEndSec = Math.max(bufferedEndSec, producedEndSec)

  // A just-booted session may not have emitted `progress` (or loaded a
  // playlist) yet. We still know that a forward jump away from its anchor
  // cannot be served; rebuilding is safer than assigning currentTime into an
  // empty future range and stalling.
  if (servableEndSec <= start) return target > start + edgeToleranceSec

  return target >= servableEndSec - edgeToleranceSec
}

/**
 * Tolerance for `levelLagsPlayhead`. hls.js's own test is `currentTime <=
 * edge` with no tolerance at all, and the playhead cannot get past what
 * hls.js has buffered — which the level playlist always covers — so any real
 * excess means the playhead is beyond everything the level in play has
 * published. 100 ms absorbs timestamp rounding, nothing more.
 */
export const LEVEL_LAG_TOLERANCE_SEC = 0.1

/**
 * Up-switch stall containment (September 2026 playback pass; second and
 * third reviews).
 *
 * Every rung encodes sequentially from the session anchor, so a rung hls.js
 * switches onto minutes into a title publishes from the anchor, and hls.js
 * 1.6 does NOT wait for it quietly. Its stream controller runs
 * `synchronizeToLiveEdge` on every load of a live (no ENDLIST) playlist, and
 * when the playhead is past that level's edge with `readyState < 4` it
 * REWINDS the element to the live-sync position, ~three segments behind the
 * lagging level's edge — from a 25-minute in-session skip, a 20-minute
 * rewind. `readyState` drops below 4 at the buffer underflow on Chromium,
 * while several seconds of buffer still remain on Firefox, and it is 1 right
 * after any seek. Before the produced-edge seek rule a long skip rebuilt the
 * session at the target and re-anchored every rung there, which kept the gap
 * short enough for the chase to close inside the buffer.
 *
 * This is the rule: the loaded level's produced edge (absolute seconds, from
 * its playlist) is behind the playhead. The player applies it at two points,
 * and both rebuild the session at the playhead so every rung re-anchors there
 * and playback resumes after a cold start: on LEVEL_UPDATED, which hls.js
 * emits inside its own onLevelLoaded BEFORE synchronizeToLiveEdge — the one
 * listener that runs before the rewind — under the rewind's own condition
 * (`readyState < 4`), pre-empting it; and on hls.js's non-fatal
 * BUFFER_STALLED_ERROR, which Chromium reports within ~100 ms of the
 * underflow, seconds before the next playlist reload would. A stall with the
 * edge at or ahead of the playhead — a hole, a slow network, an encoder that
 * is simply slower than realtime on the level in play — is left to hls.js.
 * An unknown edge (0: nothing loaded yet, native HLS) never triggers.
 */
export function levelLagsPlayhead(
  playheadAbsSec: number,
  producedEdgeSec: number,
  toleranceSec = LEVEL_LAG_TOLERANCE_SEC,
): boolean {
  if (!(producedEdgeSec > 0) || !Number.isFinite(playheadAbsSec)) return false
  return playheadAbsSec - producedEdgeSec > toleranceSec
}

/**
 * The periodic guest drift-correction tick (VideoPlayer.tsx) converts the
 * party's canonical absolute position into THIS session's HLS-relative
 * seconds via `Math.max(0, absMs/1000 - sessionStartSec)`. When the
 * canonical target falls before this session's own anchor, that clamp maps
 * the target to 0, pinning the correction ladder's target at the session
 * anchor forever:
 * currentTime advances away from 0, drift grows past the hard-snap
 * threshold, hard-snap teleports back to the anchor, and the cycle repeats
 * every ~2s (a visible, looping stutter — NOT a silent "reads as in sync",
 * the anomaly telemetry logs a `hard-seek` every cycle) while the guest
 * stays pinned `sessionStartSec` seconds ahead of the party with no way to
 * actually close the gap (neither rate-adjust nor hard-snap can seek to a
 * position before this session's own anchor).
 *
 * Reachable via: App.tsx's `handlePlayContinue` uses the party's CURRENT
 * position instead of a guest's personal bookmark — EXCEPT for a party
 * still in its lobby (`!isPlaying && currentTimeMs === 0`), where it
 * deliberately falls back to the bookmark (`App.tsx` ~4491-4492, so a
 * not-yet-started party doesn't force everyone to 0). A guest who resumes
 * that way from deep in the file, then has the host start the room, ends
 * up anchored ahead of the party's real (now non-zero) position — NOT via
 * joining a party that's already ahead, since the sync socket's `hello`
 * synthesizes a one-shot rebase seek on join that the explicit-seek branch
 * a few dozen lines above already rebuilds correctly via
 * needsHlsSessionRebuild's own backward arm. The gap this function closes
 * is specifically the case where no such rebase frame follows.
 *
 * Deliberately narrower than needsHlsSessionRebuild's forward/buffered-edge
 * arm: applied every 250ms against a continuously advancing target, that
 * arm is true for the ordinary "just booted" and "buffer momentarily thin"
 * states of a healthy session (and for the last half-second of every
 * title) — reusing it here (an earlier version of this fix did) turned
 * those transient, already-correctly-handled states into a session-rebuild
 * storm on nearly every guest.
 *
 * Known gaps, left as follow-ups rather than guessed at under this fix's
 * time budget:
 *  - The mirror-image case (a guest anchored far BEHIND the party, past
 *    this session's produced window) hits the same dead end and isn't
 *    fixed here. Closing it needs a hysteresis-gated version of the
 *    forward arm (e.g. sustained across several ticks) so it doesn't
 *    reintroduce the storm this function exists to avoid.
 *  - The Chromecast-connected-guest path (VideoPlayer.tsx `absMsToCastSec`)
 *    has the identical clamp and no rebuild path either; this fix only
 *    covers the local-<video> guest loop.
 *  - The explicit-seek branch (VideoPlayer.tsx, a few dozen lines above
 *    this function's call site) has no equivalent isPartyEpisodeMismatch
 *    guard and runs BEFORE the drift-loop check in the same tick, so on a
 *    room-socket reconnect (which always re-sends a `hello` and its
 *    one-shot rebase seek) it's that branch, not this one, that ends up
 *    handling a stale `target` during a TV episode advance — meaning the
 *    episode guard here is hardening against a narrower window than it
 *    may read as covering. Worth the same guard if that branch turns out
 *    to hit it in practice.
 *
 * `toleranceSec` is defensive insurance against sub-second floating-point/
 * rounding noise right at the boundary, not a fix for any known scenario —
 * every anchor-setting path floors its target in whole seconds and the
 * server echoes it verbatim, so a genuine sub-second backward gap isn't
 * expected to occur in practice. It does mean a gap inside the tolerance
 * window still hits the ~2s hard-seek loop described above, just bounded
 * to that window's amplitude instead of running away — rebuilding a whole
 * session to close a sub-second gap would trade a small, self-limiting
 * stutter for a strictly worse one.
 */
export function needsBackwardSessionRebuild(
  targetAbsSec: number,
  sessionStartSec: number,
  toleranceSec = 1,
): boolean {
  const target = Math.max(0, targetAbsSec)
  const start = Math.max(0, sessionStartSec)
  return target < start - toleranceSec
}

/**
 * For a TV show, the party's mediaItemId is the SERIES id and stays
 * constant across an episode advance — it can't tell needsBackwardSessionRebuild's
 * caller that `target` is momentarily the OLD episode while the party has
 * already moved to a new one (App.tsx's resolve from a party media-change
 * event to a new `target` is documented as taking "seconds on a long
 * series"). During that window a stale-but-series-matching `target` reads
 * as a genuine backward gap and would trigger a session rebuild of the
 * wrong episode. True only when both sides know an episode and they
 * disagree — missing on either side (movies, or a party not yet carrying
 * an episode id) means "don't know, don't block".
 *
 * `partyEpisodeId` is typed `number | undefined` on PartySync, but the
 * server always includes `episode_id` in party-state and serializes an
 * absent one as JSON `null` (manager.go's *int64 into a map), which
 * useParty.tsx stores verbatim — so a no-episode party's live value is
 * `null` at runtime, not `undefined`. `!= null` (loose) catches both;
 * `!== undefined` (strict) would not, and would leave the #488 fix
 * permanently disabled for any TV party missing episode context (a state
 * App.tsx already warns about elsewhere).
 */
export function isPartyEpisodeMismatch(
  partyEpisodeId: number | null | undefined,
  targetEpisodeId: number | undefined,
): boolean {
  return partyEpisodeId != null && targetEpisodeId != null && partyEpisodeId !== targetEpisodeId
}

/** Preserve the state that was authoritative when a seek forced a reboot. */
export function shouldPreservePauseOnSeekRebuild(
  partyRunning: boolean | null,
  localPaused: boolean,
): boolean {
  // In a party the server's Running flag wins. Outside a party, seeking a
  // paused local player should behave like a normal media element and stay
  // paused after the replacement HLS session is ready.
  return partyRunning === null ? localPaused : !partyRunning
}

/** Resolve pause intent at the instant a local scrub requests a new session. */
export function shouldPreservePauseForLocalSeekRebuild(
  partyControlsMedia: boolean,
  isHost: boolean,
  partyRunning: boolean,
  localPaused: boolean,
): boolean {
  // The host's element is the immediate source of a Pause/Play gesture; React
  // party state may still be one WebSocket round-trip behind that gesture.
  if (partyControlsMedia && isHost) return localPaused
  return shouldPreservePauseOnSeekRebuild(
    partyControlsMedia ? partyRunning : null,
    localPaused,
  )
}

/** A participant must never replay their own echoed host seek as a guest. */
export function shouldApplyExplicitPartySeek(
  senderUserId: number | undefined,
  currentUserId: number,
): boolean {
  // Older servers may omit `by`; apply those frames for compatibility.
  return senderUserId === undefined || senderUserId !== currentUserId
}

/** One-shot pause intent for auto-opening a player into a paused party. */
export function shouldPreservePauseForBoot(
  pauseOnBootToken: number | undefined,
  consumedToken: number | undefined,
): boolean {
  return pauseOnBootToken !== undefined && pauseOnBootToken !== consumedToken
}

// ──────────────────────────────────────────────────────────────────
// Chromecast receiver-driven party sync (issue #461 follow-up).
//
// Extracted so the receiver-sync effect in VideoPlayer.tsx (which polls
// cast.remote instead of a local <video> element while a Chromecast
// session is the active surface for a party's media) has the same
// regression-testable, un-mounted-component coverage as the rest of the
// party/player policy in this file.

/** Whether the party's authoritative isPlaying and the Cast receiver's
 * reported paused state disagree — the receiver-sync effect's guest branch
 * uses this to decide whether to call cast.playOrPause() before checking
 * drift (a paused receiver has nothing to drift-correct). */
export function castPlayPauseMismatch(partyIsPlaying: boolean, receiverPaused: boolean): boolean {
  return partyIsPlaying === receiverPaused
}

/** Whether a Cast receiver's reported currentTime jumped further between two
 * poll samples than natural playback progression over that interval could
 * explain — i.e. the receiver was scrubbed directly (the TV remote, another
 * Cast-aware app, or our own minimized-widget controls) rather than just
 * continuing to play. The receiver-sync effect's host branch polls
 * cast.remote instead of subscribing to local <video> 'seeked' events (the
 * CAF RemotePlayerController that would fire such an event is private to
 * cast.ts's closure), so a host-initiated seek is detected this way instead. */
export function isCastHostSeekJump(
  nowSec: number,
  prevSec: number,
  elapsedSec: number,
  toleranceSec: number,
): boolean {
  const expectedSec = prevSec + Math.max(0, elapsedSec)
  return Math.abs(nowSec - expectedSec) > toleranceSec
}

/** Project the party's tick forward by elapsed wall-clock time, clamped to
 * the tick's local receipt age (+ a small jitter margin) so residual
 * client↔server clock skew can't inflate the target indefinitely. Mirrors
 * the local guest-mirror loop's own extrapolation (VideoPlayer.tsx) so the
 * receiver-sync effect's guest branch targets the exact same absolute
 * position a local (non-casting) guest would. */
export function projectPartyTickAbsMs(
  tickAbsMs: number,
  tickServerNowMs: number,
  tickAgeMs: number,
  clockOffsetMs: number,
  nowMs: number,
): number {
  const correctedNow = nowMs + clockOffsetMs
  const elapsedMs = Math.min(Math.max(0, correctedNow - tickServerNowMs), tickAgeMs + 500)
  return tickAbsMs + elapsedMs
}

/** Whether a Cast receiver's reported position has drifted far enough from
 * the party's projected target to warrant a corrective seek. Chromecast's
 * remote-control surface exposes no usable playback-rate knob (unlike the
 * local <video> loop's smooth rate-adjust catch-up) and meaningful command
 * latency to a TV makes fine-grained chasing impractical anyway, so the
 * caller is expected to pass a coarser tolerance than local drift
 * correction uses. */
export function shouldResyncCastReceiver(
  receiverSec: number,
  targetSec: number,
  toleranceSec: number,
): boolean {
  return Math.abs(receiverSec - targetSec) >= toleranceSec
}

/** Resolve late party-state changes at the instant an async boot completes. */
export function resolvePlaybackBootPause(
  capturedPreservePause: boolean,
  hasSeekPauseOverride: boolean,
  isPartyRecoveryBoot: boolean,
  partyControlsMedia: boolean,
  latestPartyRunning: boolean | null,
  capturedSeekPartyRevision: number | null = null,
  latestPartyRevision: number | null = null,
): boolean {
  // A local/explicit seek carries its own point-in-time intent. In particular,
  // a host may press Play then scrub before React receives the server echo.
  // It wins only while the canonical revision is unchanged: a later Pause or
  // Play received during the async stream boot must supersede it.
  if (hasSeekPauseOverride) {
    return pauseIntentAfterNewerPartyState(
      capturedPreservePause,
      partyControlsMedia,
      latestPartyRunning,
      capturedSeekPartyRevision,
      latestPartyRevision,
    )
  }

  // Auto-open and media-change resolution can take seconds. Once they finish,
  // use the freshest canonical state instead of the state captured at setup.
  if (isPartyRecoveryBoot && partyControlsMedia && latestPartyRunning !== null) {
    return !latestPartyRunning
  }
  return capturedPreservePause
}
