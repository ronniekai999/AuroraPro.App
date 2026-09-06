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
 *  - The Chromecast-connected-guest path had the identical clamp and no
 *    rebuild path either. MOSTLY CLOSED (2026-09): `castResyncAction` detects
 *    a target before the cast session's anchor and escalates to a re-anchored
 *    cast load, the receiver-side equivalent of this rebuild. It cannot help
 *    when the receiver is SHARING the local session (no clone was needed):
 *    the server returns that session unchanged, so there is no other anchor
 *    to move to, and the guest waits for the party clock to walk back up to
 *    it. This function still covers only the local-<video> guest loop.
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

/**
 * Absolute source seconds → the RECEIVER's own timeline.
 *
 * The subtrahend is the CAST session's `-ss` anchor, which since the
 * playhead-anchoring change is routinely NOT the local <video>'s: a cast
 * clone is anchored near the sender, while the local session may still be
 * anchored wherever playback started. Passing the local anchor here maps
 * every position onto the wrong timeline — the failure this signature exists
 * to make hard to write by accident.
 *
 * The clamp is real and the reason `castTargetBeforeAnchor` exists: a
 * receiver cannot play before its session's anchor, so a target below it is
 * not a small error to be floored away, it is a position only a re-anchored
 * cast can reach.
 */
export function castAbsToReceiverSec(absSec: number, castStartSec: number): number {
  return Math.max(0, absSec - Math.max(0, castStartSec))
}

/**
 * Whether the party's position lies before the cast session's own anchor —
 * i.e. outside anything a seek can address.
 *
 * `toleranceSec` absorbs sub-second rounding at the boundary (every
 * anchor-setting path floors to whole seconds), for the same reason
 * needsBackwardSessionRebuild carries one: rebuilding a whole cast session to
 * close a gap smaller than the clamp's own noise trades a bounded stutter for
 * a much worse one.
 */
export function castTargetBeforeAnchor(
  targetAbsSec: number,
  castStartSec: number,
  toleranceSec = 1,
): boolean {
  return targetAbsSec < Math.max(0, castStartSec) - toleranceSec
}

export type CastResyncAction =
  /** The receiver is where it should be. */
  | 'none'
  /** Ordinary drift; a seek closes it. */
  | 'seek'
  /** Only a cast session anchored somewhere else can reach the target. */
  | 'reanchor'
  /**
   * The target is unreachable AND no re-anchor is available. Deliberately not
   * folded into 'none': the two are opposite states that happen to share the
   * same immediate move (do nothing this poll). A caller waiting for the
   * receiver to arrive — the host warm-up — must not read "I have given up" as
   * "it arrived", which is how a host ends up speaking for a party its TV is
   * nowhere near.
   */
  | 'blocked'

export interface CastResyncDecision {
  action: CastResyncAction
  /** The party's position on the receiver's clock — what a seek would target. */
  targetRecvSec: number
  /**
   * Whether this poll should count toward the stuck streak. Deliberately a
   * COARSER test than `action === 'seek'`: the party's target advances in real
   * time while a seek command takes ~a second to reach a TV and land, so an
   * ordinary correction reads as still-out-of-tolerance for a poll or two
   * afterwards. Counting those would re-anchor a perfectly healthy cast every
   * few seconds. Only a receiver that is nowhere near the target — the shape
   * of a seek into an unproduced part of the playlist — counts.
   */
  stuck: boolean
}

/**
 * What to do about a receiver that is not where the party is (2026-09).
 *
 * A plain seek closes ordinary drift, and until now it was the only move
 * available — which left two positions permanently unreachable:
 *
 *   - BEFORE the cast session's anchor. `castAbsToReceiverSec` floors there,
 *     so the correction ladder aims at the anchor forever while the party sits
 *     somewhere earlier. (The local <video> loop has closed its own version of
 *     this since #488 via needsBackwardSessionRebuild; the cast path had the
 *     identical clamp and no escape.)
 *   - PAST what the receiver's playlist has produced. The seek is accepted and
 *     simply never lands — the Default Media Receiver reports an indefinite
 *     buffer, not an error, so nothing on the sender can see it directly.
 *
 * Both are answered by re-anchoring: minting a new cast session anchored at
 * the party's position, which is the same move `onSeekRebuild` makes for local
 * playback. The first is detected exactly (arithmetic); the second only by
 * inference, after `reanchorAfterPolls` consecutive polls in which the
 * receiver stayed nowhere near the target.
 *
 * `reanchorAllowed` is the caller's budget — re-anchoring costs a server-side
 * transcode session and a visible reload, so it is capped per cast rather than
 * left to fire in a loop against a receiver that is simply broken.
 */
export function castResyncAction(args: {
  receiverSec: number
  targetAbsSec: number
  castStartSec: number
  toleranceSec: number
  stuckToleranceSec: number
  stuckPolls: number
  reanchorAfterPolls: number
  /**
   * Whether the INFERRED escalation may fire — a receiver judged unable to
   * reach a target it can address, from repeated nowhere-near polls. Inference
   * can be wrong about a merely-slow receiver, so its caller caps it by count.
   */
  reanchorAllowed: boolean
  /**
   * Whether the PROVEN escalation may fire — a target before the session's own
   * anchor, which no seek can reach. Separate because a count cap is the wrong
   * bound for it: it cannot misdiagnose anything, it fires only when the party
   * genuinely moved behind the anchor, and exhausting a count leaves every
   * later host rewind unanswerable. Callers rate-limit this one by time.
   */
  unreachableReanchorAllowed: boolean
}): CastResyncDecision {
  const {
    receiverSec, targetAbsSec, castStartSec,
    toleranceSec, stuckToleranceSec, stuckPolls, reanchorAfterPolls,
    reanchorAllowed, unreachableReanchorAllowed,
  } = args
  const targetRecvSec = castAbsToReceiverSec(targetAbsSec, castStartSec)

  // Unreachable by construction. Checked before the tolerance test because a
  // target just below the anchor can floor to a value that LOOKS in-tolerance
  // while the party is genuinely elsewhere.
  if (castTargetBeforeAnchor(targetAbsSec, castStartSec)) {
    return {
      action: unreachableReanchorAllowed ? 'reanchor' : 'blocked',
      targetRecvSec,
      stuck: false,
    }
  }

  if (!shouldResyncCastReceiver(receiverSec, targetRecvSec, toleranceSec)) {
    return { action: 'none', targetRecvSec, stuck: false }
  }

  const stuck = shouldResyncCastReceiver(receiverSec, targetRecvSec, stuckToleranceSec)
  if (reanchorAllowed && stuck && stuckPolls + 1 >= reanchorAfterPolls) {
    return { action: 'reanchor', targetRecvSec, stuck }
  }
  return { action: 'seek', targetRecvSec, stuck }
}

/** The subset of a party tick these helpers read. */
export interface PartyTickLike {
  abs_ms: number
  server_now_ms: number
  running?: boolean
  receivedAtMs?: number
}

/**
 * The party's canonical position right now, in absolute source seconds, or
 * null when the tick cannot be trusted to say.
 *
 * Used wherever a position must be chosen from the party rather than from a
 * local media element — most importantly when seeding a cast, where the local
 * <video> is either frozen (a cast already began) or about to be.
 *
 * A PAUSED party is exact and ageless: no tick loop runs while paused (the
 * server suppresses them), so `receivedAtMs` grows arbitrarily old while
 * `abs_ms` stays exactly right. Applying the running party's staleness rule
 * there would reject every paused party's true position. A RUNNING party is
 * the opposite — a tick we received seconds ago may describe a server that has
 * since moved on, or a socket that died — so it ages out, with the same 3s
 * budget and the same receipt-age (not clock-difference) test the drift loops
 * use, for the same reason: client↔server skew must not masquerade as
 * staleness before the time-sync offset converges.
 */
export function partyTargetAbsSec(
  tick: PartyTickLike | null | undefined,
  partyIsPlaying: boolean,
  clockOffsetMs: number,
  nowMs: number,
  staleAfterMs = 3000,
): number | null {
  if (!tick || !Number.isFinite(tick.abs_ms)) return null
  const running = tick.running !== false && partyIsPlaying
  if (!running) return Math.max(0, tick.abs_ms / 1000)
  const tickAgeMs = nowMs - (tick.receivedAtMs ?? nowMs)
  if (tickAgeMs > staleAfterMs) return null
  const projected = projectPartyTickAbsMs(
    tick.abs_ms, tick.server_now_ms, tickAgeMs, clockOffsetMs, nowMs,
  )
  // A non-finite server_now_ms (or clock offset) makes the projection NaN,
  // and NaN reads as "in tolerance" to every downstream comparison —
  // Math.abs(NaN) >= tol is false — which would silently report a converged
  // receiver and, for a host, a settled cast. Not a realistic wire value;
  // cheap to refuse rather than to reason about.
  if (!Number.isFinite(projected)) return null
  return Math.max(0, projected / 1000)
}

export interface CastReanchorBudget {
  /** Re-anchors spent on this cast. */
  used: number
  /** Consecutive in-tolerance polls since the last correction of any kind. */
  settledPolls: number
}

export type CastReanchorOutcome =
  | 'converged'
  | 'reanchored'
  | 'reanchor-failed'
  | 'other'

/**
 * Fold one poll's outcome into the re-anchor budget (2026-09, third review).
 *
 * Two opposite pressures meet here. The cap exists so a receiver that is
 * simply broken cannot be reloaded in a loop — each re-anchor costs a
 * server-side transcode session and a visible reload on the TV. But a cap with
 * no way back is a per-TITLE allowance, and a guest has no other recovery
 * path (`seekToRealSec` refuses guests, and their local session is never
 * rebuilt during a cast), so a host who rewinds the party past the receiver's
 * anchor a third time would strand every guest's TV for the rest of the film.
 *
 * So the budget is earned back — but only by a receiver that has SETTLED, not
 * by one that merely looked right for a moment. That distinction is the whole
 * point: a re-anchor loads the receiver AT the party position, so the first
 * poll after it lands is in tolerance almost by construction. Refunding on
 * that single poll would let a receiver that stalls a few seconds after every
 * load re-anchor indefinitely, roughly every 6-8s for the whole title, against
 * the very server whose slowness caused the stall. Requiring a RUN of
 * in-tolerance polls costs nothing in the case the replenishment is for (a
 * cast that is genuinely fine for minutes between host rewinds) and denies the
 * pathological one, whose drift re-opens long before the run completes.
 */
export function castReanchorBudgetAfter(
  budget: CastReanchorBudget,
  outcome: CastReanchorOutcome,
  settledPollsToEarnBack: number,
): CastReanchorBudget {
  switch (outcome) {
    case 'converged': {
      const settledPolls = budget.settledPolls + 1
      if (budget.used > 0 && settledPolls >= settledPollsToEarnBack) {
        return { used: budget.used - 1, settledPolls: 0 }
      }
      return { used: budget.used, settledPolls }
    }
    case 'reanchored':
      return { used: budget.used + 1, settledPolls: 0 }
    case 'reanchor-failed':
      // The load never reached the receiver, so it re-anchored nothing. Never
      // below zero: the refund is asynchronous and a reset may have landed in
      // between.
      return { used: Math.max(0, budget.used - 1), settledPolls: budget.settledPolls }
    case 'other':
      // A seek, or a poll that could take no action: the receiver is not where
      // it should be, so any run of settled polls is over.
      return { used: budget.used, settledPolls: 0 }
  }
}

export type CastHostPhase = 'warmup' | 'authoritative'

/**
 * Whether a casting HOST may speak for the party yet (2026-09).
 *
 * The host branch of the receiver-driven sync effect treats the TV as the
 * party's source of truth: it watches `cast.remote` and pushes what it sees
 * outward as requestPlay/requestPause/requestSeek. That is right once the TV
 * IS the party's position, and wrong for the several seconds before it — a
 * cast takes real time to connect, load and buffer, and the party's clock does
 * not stop while it does. Broadcasting during that window rewinds every guest
 * by the cast's own startup latency, which is the opposite of what casting
 * mid-party is supposed to cost other people.
 *
 * So the host starts in `warmup`, where it behaves like a guest — correcting
 * the receiver TOWARD the party and broadcasting nothing — and becomes
 * `authoritative` the moment the receiver has actually reached the party's
 * position.
 *
 * The budget is the escape hatch, and it is why this is bounded rather than
 * "wait for convergence". A receiver that never converges (a title the party
 * has since moved past, a wedged device) must not leave the host permanently
 * unable to pause the room from their own TV. When it expires the host takes
 * authority regardless, accepting the one corrective jump that entails —
 * bounded and rare, versus silent and permanent.
 */
export function castHostPhase(
  converged: boolean,
  warmupStartedAtMs: number,
  nowMs: number,
  budgetMs: number,
): CastHostPhase {
  if (converged) return 'authoritative'
  // An unarmed clock (0, the ref's initial value) is "the warm-up has not
  // started", never "its budget expired in 1970". Getting that backwards
  // skips the warm-up entirely on any path that reaches the first poll
  // without passing through the arming branch — a host already casting solo
  // who then joins a party, or a first poll that finds the media already
  // loaded — which is exactly when a host is least caught up.
  if (warmupStartedAtMs <= 0) return 'warmup'
  if (nowMs - warmupStartedAtMs >= budgetMs) return 'authoritative'
  return 'warmup'
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

// ──────────────────────────────────────────────────────────────────
// The casting host's broadcast decision (2026-09, ninth review).
//
// This is the one decision in the cast path that has been got wrong in four
// consecutive review rounds, always the same way: a guard added to stop the
// host broadcasting something it should not, placed where control still fell
// through to the code that records the next comparison baseline — which
// destroys the very transition the guard was protecting instead of deferring
// it. A host's pause is then lost rather than delayed, and a paused receiver
// never moves, so no later poll finds anything to broadcast.
//
// It lives here, as data in and data out, because that failure is mechanically
// checkable and was never going to be caught by reading a 6,975-line
// component. Every guard's effect on the baseline is now stated in one place
// and pinned by a table.

/** One poll's reading of the receiver, on the RECEIVER's clock. */
export interface CastReceiverSample {
  paused: boolean
  sec: number
  atMs: number
}

export type HostBroadcast =
  | { kind: 'none' }
  /** Pause the party at the receiver's position. */
  | { kind: 'pause-at-receiver' }
  | { kind: 'play' }
  /** Correct the party's position to the receiver's, then resume. */
  | { kind: 'seek-then-play' }
  /** Re-state a paused party's position after a scrub on the TV. */
  | { kind: 'pause-rescrub' }
  /** The receiver was scrubbed while playing. */
  | { kind: 'seek' }

/**
 * What to do with `hostLastSnapshotRef` after this poll.
 *
 * `keep` is the one that matters: a guard that declines to act must leave the
 * PRE-guard baseline standing, so the comparison happens once the guard lifts.
 * `record` belongs only to paths that consumed the reading.
 */
export type HostBaselineDisposition = 'keep' | 'record' | 'clear'

export interface HostBroadcastDecision {
  broadcast: HostBroadcast
  baseline: HostBaselineDisposition
}

export interface HostBroadcastInput {
  prev: CastReceiverSample | null
  now: CastReceiverSample
  /**
   * True on the poll that takes authority by spending the warm-up budget
   * without the receiver ever arriving — the one poll where the warm-up's own
   * play/pause arm no longer runs, so a transition sitting in `prev` has to be
   * read here or it is lost for good.
   */
  latchingAuthority: boolean
  /** One of our own loads is between issued and resolved. */
  loadInFlight: boolean
  /** The party has moved to an episode this player has not caught up to. */
  episodeMismatch: boolean
  /** The cast session's anchor is unknown, so no conversion is honest. */
  anchorUnknown: boolean
  /** A corrective seek we issued is still landing. */
  correctionSettling: boolean
  pausedScrubToleranceSec: number
  seekJumpToleranceSec: number
}

/**
 * Decide what an AUTHORITATIVE casting host tells the party this poll, and
 * what happens to the baseline.
 *
 * Scope is deliberate: the warm-up phase is NOT here. Warm-up broadcasts no
 * position at all — it mirrors the party onto the receiver and corrects it,
 * which is effects rather than a decision — so folding it in would mean
 * inventing action variants for playOrPause, reloadCastAtAbsSec and
 * correctReceiverToward and routing them through this type. The caller runs
 * warm-up inline and returns on every one of its paths, so reaching this
 * function at all means that phase is already over. `latchingAuthority` marks
 * the single poll where it just ended without convergence.
 *
 * Order is load-bearing. The guards come first and all `keep`; the arms that
 * consume `prev` come after and all `record`. Anything that returns without
 * looking at `prev` must not touch it.
 */
export function decideHostBroadcast(input: HostBroadcastInput): HostBroadcastDecision {
  const {
    prev, now, latchingAuthority,
    loadInFlight, episodeMismatch, anchorUnknown, correctionSettling,
    pausedScrubToleranceSec, seekJumpToleranceSec,
  } = input

  // ── Guards. Every one keeps the baseline. ──
  // No honest conversion between the two clocks exists.
  if (anchorUnknown) return { broadcast: { kind: 'none' }, baseline: 'keep' }
  // The receiver's state is ours, not the user's, and the seed that says so
  // does not land until the load resolves.
  if (loadInFlight) return { broadcast: { kind: 'none' }, baseline: 'keep' }
  // The two sides are on different episodes; a position means nothing across
  // that boundary.
  if (episodeMismatch) return { broadcast: { kind: 'none' }, baseline: 'keep' }

  // ── Taking authority by spending the budget. ──
  // Read the transition BEFORE discarding the warm-up baseline: past this
  // poll the warm-up arm no longer runs and no later transition exists.
  if (latchingAuthority) {
    if (prev && prev.paused !== now.paused) {
      return {
        broadcast: now.paused ? { kind: 'pause-at-receiver' } : { kind: 'play' },
        baseline: 'record',
      }
    }
    return { broadcast: { kind: 'none' }, baseline: 'clear' }
  }

  // ── Authoritative: the TV speaks for the party. ──
  if (!prev) return { broadcast: { kind: 'none' }, baseline: 'record' }

  // A corrective seek cannot change whether the receiver is PAUSED, so the
  // suppression below applies to POSITION only and this arm runs regardless.
  if (prev.paused !== now.paused) {
    if (now.paused) return { broadcast: { kind: 'pause-at-receiver' }, baseline: 'record' }
    // Scrubbed while paused (TV remote, another Cast app): correct the party's
    // position before resuming, or it resumes from the pre-scrub spot.
    const scrubbed = Math.abs(now.sec - prev.sec) > pausedScrubToleranceSec
    return {
      broadcast: scrubbed ? { kind: 'seek-then-play' } : { kind: 'play' },
      baseline: 'record',
    }
  }

  if (correctionSettling) return { broadcast: { kind: 'none' }, baseline: 'keep' }

  if (now.paused) {
    // Still paused, so any movement is a direct scrub.
    const scrubbed = Math.abs(now.sec - prev.sec) > pausedScrubToleranceSec
    return {
      broadcast: scrubbed ? { kind: 'pause-rescrub' } : { kind: 'none' },
      baseline: 'record',
    }
  }

  const elapsedSec = (now.atMs - prev.atMs) / 1000
  const jumped = isCastHostSeekJump(now.sec, prev.sec, elapsedSec, seekJumpToleranceSec)
  return { broadcast: jumped ? { kind: 'seek' } : { kind: 'none' }, baseline: 'record' }
}
