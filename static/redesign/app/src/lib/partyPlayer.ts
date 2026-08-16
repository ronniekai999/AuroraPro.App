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
 * A target before the FFmpeg -ss anchor or at/past the buffered edge needs a
 * fresh session anchored at that absolute media position.
 */
export function needsHlsSessionRebuild(
  targetSec: number,
  sessionStartSec: number,
  bufferedEndSec: number,
  edgeToleranceSec = 0.5,
): boolean {
  const target = Math.max(0, targetSec)
  const start = Math.max(0, sessionStartSec)
  if (target < start) return true

  // A just-booted session may not have emitted `progress` yet. We still know
  // that a forward jump away from its anchor cannot be served; rebuilding is
  // safer than assigning currentTime into an empty future range and stalling.
  if (bufferedEndSec <= start) return target > start + edgeToleranceSec

  return target >= bufferedEndSec - edgeToleranceSec
}

/**
 * The periodic guest drift-correction tick (VideoPlayer.tsx) converts the
 * party's canonical absolute position into THIS session's HLS-relative
 * seconds via `Math.max(0, absMs/1000 - sessionStartSec)`. When the
 * canonical target falls before this session's own anchor — e.g. a guest
 * joined a party by resuming a personal bookmark far into the file while
 * the party clock sat near its start — that clamp maps the target to 0 and
 * the ordinary drift math reads "in sync" while the guest is actually
 * pinned `sessionStartSec` seconds ahead, with no way to correct (neither
 * rate-adjust nor hard-snap can seek to a position before this session's
 * own anchor).
 *
 * Deliberately narrower than needsHlsSessionRebuild's forward/buffered-edge
 * arm: applied every 250ms against a continuously advancing target, that
 * arm is true for the ordinary "just booted" and "buffer momentarily thin"
 * states of a healthy session (and for the last half-second of every
 * title), which would turn transient conditions the existing rate-adjust/
 * hard-snap ladder already handles into session-rebuild storms. Only the
 * backward case is unrepresentable without a rebuild.
 */
export function needsBackwardSessionRebuild(targetAbsSec: number, sessionStartSec: number): boolean {
  return targetAbsSec < Math.max(0, sessionStartSec)
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
