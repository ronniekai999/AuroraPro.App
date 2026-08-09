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
