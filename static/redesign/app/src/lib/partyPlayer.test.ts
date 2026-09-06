import { describe, expect, it } from 'vitest'
import {
  castAbsToReceiverSec,
  castHostPhase,
  castPlayPauseMismatch,
  castReanchorBudgetAfter,
  castResyncAction,
  decideHostBroadcast,
  type HostBroadcastInput,
  castTargetBeforeAnchor,
  isCastHostSeekJump,
  isPartyEpisodeMismatch,
  isPlaybackResolutionCurrent,
  levelLagsPlayhead,
  needsBackwardSessionRebuild,
  needsHlsSessionRebuild,
  partyTargetAbsSec,
  pauseIntentForReplacementSeek,
  partyPlayerAutoOpenKey,
  partyPlayerDismissalKeyOnClose,
  projectPartyTickAbsMs,
  resolvePlaybackBootPause,
  shouldApplyExplicitPartySeek,
  shouldAutoOpenPartyPlayer,
  shouldClosePlayerOnPathChange,
  shouldPreservePauseForLocalSeekRebuild,
  shouldPreservePauseForBoot,
  shouldPreservePauseOnSeekRebuild,
  shouldRebuildSeekBeforeDeliveryReady,
  shouldReplaceUnreadyTargetForExplicitSeek,
  shouldResyncCastReceiver,
  type PartyPlayerSnapshot,
} from './partyPlayer'

const runningParty: PartyPlayerSnapshot = {
  code: 'JDZEUK',
  mediaItemId: 130,
  episodeId: 2866,
  hostUserId: 1,
  isPlaying: true,
  currentTimeMs: 8 * 60_000,
}

describe('party player auto-open policy', () => {
  it('honours a manual close for the same party, episode, and role', () => {
    const dismissed = partyPlayerAutoOpenKey(runningParty, 1)
    expect(shouldAutoOpenPartyPlayer(runningParty, 1, false, dismissed)).toBe(false)
  })

  it('re-arms when the party advances to another episode', () => {
    const dismissed = partyPlayerAutoOpenKey(runningParty, 1)
    expect(shouldAutoOpenPartyPlayer(
      { ...runningParty, episodeId: 2867 },
      1,
      false,
      dismissed,
    )).toBe(true)
  })

  it('re-arms for a dismissed guest who is promoted to host', () => {
    const dismissedAsGuest = partyPlayerAutoOpenKey(runningParty, 2)
    expect(shouldAutoOpenPartyPlayer(
      { ...runningParty, hostUserId: 2, isPlaying: false },
      2,
      false,
      dismissedAsGuest,
    )).toBe(true)
  })

  it('keeps a guest dismissed when two other users hand off hosting', () => {
    const dismissed = partyPlayerAutoOpenKey(runningParty, 3)
    expect(partyPlayerAutoOpenKey({ ...runningParty, hostUserId: 2 }, 3)).toBe(dismissed)
  })

  it('keeps a dismissed host closed after they hand off hosting', () => {
    const dismissedAsHost = partyPlayerAutoOpenKey(runningParty, 1)
    expect(shouldAutoOpenPartyPlayer(
      { ...runningParty, hostUserId: 2 },
      1,
      false,
      dismissedAsHost,
    )).toBe(false)
  })

  it('does not open a paused pre-start lobby for either role', () => {
    const lobby = { ...runningParty, isPlaying: false, currentTimeMs: 0 }
    expect(shouldAutoOpenPartyPlayer(lobby, 1, false, null)).toBe(false)
    expect(shouldAutoOpenPartyPlayer(lobby, 2, false, null)).toBe(false)
  })

  it('dismisses the current party lifecycle when closing a transitioning player', () => {
    expect(partyPlayerDismissalKeyOnClose(runningParty, 1, true)).toBe(
      partyPlayerAutoOpenKey(runningParty, 1),
    )
    expect(partyPlayerDismissalKeyOnClose(runningParty, 1, false)).toBeNull()
  })

  it('dismisses a pending resolver when navigation happens before a player exists', () => {
    const dismissed = partyPlayerDismissalKeyOnClose(runningParty, 1, false, true)
    expect(dismissed).toBe(partyPlayerAutoOpenKey(runningParty, 1))
    expect(shouldAutoOpenPartyPlayer(
      { ...runningParty, isPlaying: false },
      1,
      false,
      dismissed,
    )).toBe(false)
    expect(shouldAutoOpenPartyPlayer(runningParty, 1, false, dismissed)).toBe(false)
  })

  it('does not dismiss ordinary navigation from a paused lobby', () => {
    const lobby = { ...runningParty, isPlaying: false, currentTimeMs: 0 }
    const dismissed = partyPlayerDismissalKeyOnClose(lobby, 2, false, false)
    expect(dismissed).toBeNull()
    expect(shouldAutoOpenPartyPlayer(runningParty, 2, false, dismissed)).toBe(true)
  })

  it('closes for browser history path changes but preserves a minimized cast', () => {
    expect(shouldClosePlayerOnPathChange('/movies', '/series', false)).toBe(true)
    expect(shouldClosePlayerOnPathChange('/movies', '/series', true)).toBe(false)
    expect(shouldClosePlayerOnPathChange('/movies', '/movies', false)).toBe(false)
  })

  it('rejects an async play resolver invalidated by close or navigation', () => {
    expect(isPlaybackResolutionCurrent(4, 4, false)).toBe(true)
    expect(isPlaybackResolutionCurrent(4, 5, false)).toBe(false)
    expect(isPlaybackResolutionCurrent(4, 4, true)).toBe(false)
  })
})

describe('sequential HLS seek policy', () => {
  it('replaces an unresolved HLS target instead of treating it as direct play', () => {
    expect(shouldRebuildSeekBeforeDeliveryReady('resolving')).toBe(true)
    expect(shouldRebuildSeekBeforeDeliveryReady('direct')).toBe(false)
    expect(shouldRebuildSeekBeforeDeliveryReady('hls')).toBe(false)
  })

  it('lets a second remote seek replace the first seek while its target boots', () => {
    expect(shouldReplaceUnreadyTargetForExplicitSeek(false, true)).toBe(true)
    expect(shouldReplaceUnreadyTargetForExplicitSeek(true, true)).toBe(false)
    expect(shouldReplaceUnreadyTargetForExplicitSeek(false, false)).toBe(false)
  })

  it('keeps running intent across a teardown pause before a second local seek', () => {
    expect(pauseIntentForReplacementSeek(false, true, false)).toBe(false)
    expect(pauseIntentForReplacementSeek(false, true, true)).toBe(true)
    expect(pauseIntentForReplacementSeek(true, true, false)).toBe(true)
  })

  it('uses newer canonical state for a second seek during an unresolved boot', () => {
    // Seek A intended to keep playing at rev 10, then rev 11 paused while its
    // stream was resolving. Seek B must inherit the newer pause, not teardown.
    expect(pauseIntentForReplacementSeek(
      false,
      true,
      false,
      10,
      true,
      false,
      11,
    )).toBe(true)
  })

  it('rebuilds for the reported forward scrub beyond the produced range', () => {
    // The recording shows ~8:00 produced and attempts at 13:11 / 24:38.
    expect(needsHlsSessionRebuild(13 * 60 + 11, 0, 8 * 60 + 35)).toBe(true)
    expect(needsHlsSessionRebuild(24 * 60 + 38, 0, 8 * 60 + 35)).toBe(true)
  })

  it('keeps an in-buffer seek in the current session', () => {
    expect(needsHlsSessionRebuild(7 * 60, 0, 8 * 60 + 35)).toBe(false)
    // A relative -10s from the opening seconds clamps to 0 in the caller; it
    // must not rebuild or attempt to assign a negative video currentTime.
    expect(needsHlsSessionRebuild(-8, 0, 30)).toBe(false)
  })

  it('rebuilds when rewinding before a resumed session anchor', () => {
    expect(needsHlsSessionRebuild(120, 300, 420)).toBe(true)
  })

  it('does not rebuild again when the new session is anchored at the target', () => {
    expect(needsHlsSessionRebuild(13 * 60 + 11, 13 * 60 + 11, 0)).toBe(false)
  })

  describe('produced edge (September 2026 playback pass)', () => {
    // The encoder runs at 4x realtime: ten minutes in, hls.js has ~60s
    // buffered (t=10:00 → 11:00) but the server has published to ~40:00.
    const start = 0
    const buffered = 11 * 60
    const produced = 40 * 60

    it('keeps a forward seek inside the produced window in the current session', () => {
      expect(needsHlsSessionRebuild(20 * 60, start, buffered, 0.5, produced)).toBe(false)
      expect(needsHlsSessionRebuild(39 * 60 + 59, start, buffered, 0.5, produced)).toBe(false)
    })

    it('still rebuilds for a seek at or past the produced edge', () => {
      expect(needsHlsSessionRebuild(40 * 60, start, buffered, 0.5, produced)).toBe(true)
      expect(needsHlsSessionRebuild(55 * 60, start, buffered, 0.5, produced)).toBe(true)
    })

    it('never shrinks the window below the buffered edge', () => {
      // A stale or absent produced edge (0) must not turn an in-buffer seek
      // into a rebuild — the native-HLS path always passes 0.
      expect(needsHlsSessionRebuild(10 * 60 + 30, start, buffered, 0.5, 0)).toBe(false)
      expect(needsHlsSessionRebuild(10 * 60 + 30, start, buffered, 0.5, 5 * 60)).toBe(false)
    })

    it('rebuilds a forward jump off a just-booted session with nothing produced', () => {
      expect(needsHlsSessionRebuild(90, 60, 0, 0.5, 0)).toBe(true)
      // …but not once the playlist says the target has been produced.
      expect(needsHlsSessionRebuild(90, 60, 0, 0.5, 120)).toBe(false)
    })

    it('rewinds before the anchor still rebuild regardless of the produced edge', () => {
      expect(needsHlsSessionRebuild(30, 60, buffered, 0.5, produced)).toBe(true)
    })
  })

  describe('levelLagsPlayhead (up-switch stall containment)', () => {
    it('flags a rung whose playlist ends behind the playhead', () => {
      // Skipped to 35:00 in-session, then hls.js switched up onto a rung
      // that has published 12 s from the anchor: hls.js would rewind to
      // ~0:00 on the next playlist load once readyState drops below 4.
      expect(levelLagsPlayhead(35 * 60, 12)).toBe(true)
      // Anchored session: the edge is absolute, so is the playhead.
      expect(levelLagsPlayhead(600 + 35 * 60, 600 + 12)).toBe(true)
      // Any real excess counts — hls.js's own test has no tolerance, and a
      // small lag rewinds just the same (~18 s) rather than resolving.
      expect(levelLagsPlayhead(1200.5, 1200)).toBe(true)
      expect(levelLagsPlayhead(1212, 1200)).toBe(true)
    })

    it('leaves a stall at the produced edge to hls.js', () => {
      // An encoder slower than realtime on the level in play: the playhead
      // sits AT the edge (it cannot pass buffered content), never beyond it.
      expect(levelLagsPlayhead(1200, 1200)).toBe(false)
      expect(levelLagsPlayhead(1199.5, 1200)).toBe(false)
      // Timestamp rounding, within the tolerance.
      expect(levelLagsPlayhead(1200.05, 1200)).toBe(false)
    })

    it('never triggers on an unknown edge or a bad playhead', () => {
      expect(levelLagsPlayhead(1200, 0)).toBe(false)
      expect(levelLagsPlayhead(1200, -1)).toBe(false)
      expect(levelLagsPlayhead(NaN, 12)).toBe(false)
      expect(levelLagsPlayhead(Infinity, 12)).toBe(false)
    })

    it('does not flag the ordinary state where the edge is ahead', () => {
      expect(levelLagsPlayhead(600, 40 * 60)).toBe(false)
    })
  })

  describe('needsBackwardSessionRebuild (issue #488 guest drift loop)', () => {
    it('rebuilds when the canonical target is before this session\'s own anchor', () => {
      // Guest's session is anchored at 20:00 (e.g. started the party's
      // title from their own bookmark) while the party clock is still at
      // 1:40 — the clamp in absMsToHlsSec would otherwise pin the
      // correction loop's target at 20:00 forever (see the doc comment
      // for the concrete repeating-hard-seek failure mode).
      expect(needsBackwardSessionRebuild(100, 1200)).toBe(true)
    })

    it('does not rebuild for ordinary forward drift within the session', () => {
      expect(needsBackwardSessionRebuild(1200, 1200)).toBe(false)
      expect(needsBackwardSessionRebuild(1300, 1200)).toBe(false)
    })

    it('does not rebuild for a target far beyond the buffered edge (issue #488 review)', () => {
      // An earlier version of this fix reused needsHlsSessionRebuild's
      // forward/buffered-edge arm here, which fires on the ordinary
      // "just booted" and "buffer momentarily thin" states of a healthy
      // session — needsBackwardSessionRebuild must not, regardless of how
      // far ahead of any buffered edge the target is.
      expect(needsBackwardSessionRebuild(999_999, 0)).toBe(false)
    })

    it('normalizes both a negative target and a negative session anchor to 0', () => {
      expect(needsBackwardSessionRebuild(1, -5)).toBe(false)
      // Both clamp to 0 — no genuine backward gap, so no rebuild. An
      // earlier version of this fix clamped only the anchor, not the
      // target: a negative target compared against a 0-clamped anchor
      // read as permanently behind, and the rebuild's own
      // Math.max(0, …) call re-anchored at 0 without ever changing that
      // comparison — an unbounded rebuild loop for any negative target
      // (not reachable today: the tick's abs_ms and elapsedMs are both
      // non-negative, so projectedAbsMs — and this function's targetAbsSec
      // argument — can't go negative in practice).
      expect(needsBackwardSessionRebuild(-1, -5)).toBe(false)
      expect(needsBackwardSessionRebuild(-1, 5)).toBe(true)
    })

    it('ignores a sub-tolerance gap', () => {
      // Defensive insurance against rounding noise right at the boundary,
      // not a fix for any known scenario (every anchor-setting path floors
      // to whole seconds) — but a genuine, minutes-scale gap like the
      // reported bug must still rebuild well past this margin.
      expect(needsBackwardSessionRebuild(99.7, 100)).toBe(false)
      // Just past the default 1s tolerance: still rebuilds.
      expect(needsBackwardSessionRebuild(98.9, 100)).toBe(true)
    })
  })

  describe('isPartyEpisodeMismatch (issue #488 review — TV episode-advance race)', () => {
    it('blocks when both sides know an episode and they disagree', () => {
      expect(isPartyEpisodeMismatch(9001, 9000)).toBe(true)
    })

    it('does not block when they agree', () => {
      expect(isPartyEpisodeMismatch(9000, 9000)).toBe(false)
    })

    it('does not block when either side is unknown (movies, or a party not yet carrying an episode id)', () => {
      expect(isPartyEpisodeMismatch(undefined, 9000)).toBe(false)
      expect(isPartyEpisodeMismatch(9000, undefined)).toBe(false)
      expect(isPartyEpisodeMismatch(undefined, undefined)).toBe(false)
    })

    it('treats a `null` partyEpisodeId the same as undefined (the actual wire value for a no-episode party)', () => {
      // The server always includes episode_id in party-state, serializing
      // an absent one as JSON null (manager.go's *int64 into a map) —
      // useParty.tsx stores that verbatim, so this is the REAL runtime
      // value for a TV party missing episode context, not `undefined`.
      // A strict `!== undefined` check here would read `null` as a known,
      // disagreeing episode and permanently block the #488 fix for that
      // party.
      expect(isPartyEpisodeMismatch(null, 9000)).toBe(false)
      expect(isPartyEpisodeMismatch(null, undefined)).toBe(false)
    })
  })

  it('preserves a paused party across a session rebuild', () => {
    expect(shouldPreservePauseOnSeekRebuild(false, true)).toBe(true)
    // A running party stays authoritative even if a guest is transiently
    // paused while buffering when the seek frame arrives.
    expect(shouldPreservePauseOnSeekRebuild(true, true)).toBe(false)
  })

  it('preserves local pause state outside a party', () => {
    expect(shouldPreservePauseOnSeekRebuild(null, true)).toBe(true)
    expect(shouldPreservePauseOnSeekRebuild(null, false)).toBe(false)
  })

  it('uses the host element state when React party state lags a gesture', () => {
    // Pause → immediate scrub: server still reports running, local is paused.
    expect(shouldPreservePauseForLocalSeekRebuild(true, true, true, true)).toBe(true)
    // Play → immediate scrub: server still reports paused, local is playing.
    expect(shouldPreservePauseForLocalSeekRebuild(true, true, false, false)).toBe(false)
  })
})

describe('explicit party seek ownership', () => {
  it('does not replay a former host\'s own echoed seek after hand-off', () => {
    expect(shouldApplyExplicitPartySeek(7, 7)).toBe(false)
  })

  it('applies another host\'s seek and accepts legacy frames without a sender', () => {
    expect(shouldApplyExplicitPartySeek(8, 7)).toBe(true)
    expect(shouldApplyExplicitPartySeek(undefined, 7)).toBe(true)
  })
})

describe('paused-party player boot', () => {
  it('preserves pause once for a fresh auto-open token', () => {
    expect(shouldPreservePauseForBoot(42, undefined)).toBe(true)
    expect(shouldPreservePauseForBoot(42, 42)).toBe(false)
  })

  it('does not affect ordinary or running-party boots', () => {
    expect(shouldPreservePauseForBoot(undefined, undefined)).toBe(false)
  })

  it('honours a pause that arrives while a recovery stream is still booting', () => {
    expect(resolvePlaybackBootPause(false, false, true, true, false)).toBe(true)
  })

  it('honours a resume that arrives while a paused recovery stream is booting', () => {
    expect(resolvePlaybackBootPause(true, false, true, true, true)).toBe(false)
  })

  it('keeps an immediate seek intent ahead of lagging React party state', () => {
    // Host pressed Play and immediately scrubbed while the last render still
    // described the room as paused.
    expect(resolvePlaybackBootPause(false, true, true, true, false, 10, 10)).toBe(false)
  })

  it('lets newer canonical play/pause state supersede a seek during boot', () => {
    // A later pause must stop a boot that originally intended to keep running.
    expect(resolvePlaybackBootPause(false, true, true, true, false, 10, 11)).toBe(true)
    // The inverse matters too: a later resume must release a captured pause.
    expect(resolvePlaybackBootPause(true, true, true, true, true, 10, 11)).toBe(false)
  })
})

describe('Chromecast receiver-driven party sync (issue #461)', () => {
  describe('castPlayPauseMismatch', () => {
    it('flags a receiver paused while the party is playing', () => {
      expect(castPlayPauseMismatch(true, true)).toBe(true)
    })
    it('flags a receiver playing while the party is paused', () => {
      expect(castPlayPauseMismatch(false, false)).toBe(true)
    })
    it('agrees when both are playing', () => {
      expect(castPlayPauseMismatch(true, false)).toBe(false)
    })
    it('agrees when both are paused', () => {
      expect(castPlayPauseMismatch(false, true)).toBe(false)
    })
  })

  describe('isCastHostSeekJump', () => {
    it('is not a seek when the receiver simply kept playing', () => {
      // 4s of real playback since the last poll, reported 4.1s later — well
      // inside jitter.
      expect(isCastHostSeekJump(104.1, 100, 4, 3)).toBe(false)
    })
    it('is a seek when the receiver jumped far ahead of natural progression', () => {
      // Only 1s of wall-clock passed but currentTime jumped 30s — a scrub.
      expect(isCastHostSeekJump(130, 100, 1, 3)).toBe(true)
    })
    it('is a seek when the receiver jumped backward', () => {
      expect(isCastHostSeekJump(10, 100, 1, 3)).toBe(true)
    })
    it('treats a negative poll interval as zero elapsed rather than going negative', () => {
      // Defensive: Date.now() is monotonic in practice, but a clock oddity
      // should never make the tolerance window wider than intended.
      expect(isCastHostSeekJump(100, 100, -5, 3)).toBe(false)
      expect(isCastHostSeekJump(105, 100, -5, 3)).toBe(true)
    })
  })

  describe('projectPartyTickAbsMs', () => {
    it('projects forward by elapsed server time when the tick is fresh', () => {
      // Tick said abs_ms=10_000 at server_now_ms=1_000_000; 2500ms of
      // wall-clock have since passed and the tick itself is 2500ms old
      // (receivedAtMs consistent with elapsed), so the clamp doesn't bite.
      expect(projectPartyTickAbsMs(10_000, 1_000_000, 2_500, 0, 1_002_500)).toBe(12_500)
    })
    it('applies the NTP-style clock offset before projecting', () => {
      // Client clock runs 800ms behind the server; without correction the
      // naive Date.now() - server_now_ms would under-project by 800ms.
      expect(projectPartyTickAbsMs(10_000, 1_000_000, 1_800, 800, 1_001_000)).toBe(11_800)
    })
    it('clamps projection to the tick age plus jitter margin', () => {
      // The tick is already 2000ms old (tickAgeMs) but the raw wall-clock
      // delta computes to 5000ms (e.g. a burst of clock skew) — clamp to
      // tickAgeMs + 500 so a skew spike can't run the target far ahead of
      // where the tick could plausibly be.
      const result = projectPartyTickAbsMs(10_000, 1_000_000, 2_000, 0, 1_005_000)
      expect(result).toBe(10_000 + 2_500)
    })
    it('never projects backward even if the raw delta is negative', () => {
      expect(projectPartyTickAbsMs(10_000, 1_000_000, 0, 0, 999_000)).toBe(10_000)
    })
  })

  describe('shouldResyncCastReceiver', () => {
    it('ignores drift under the tolerance', () => {
      expect(shouldResyncCastReceiver(100, 101.5, 2)).toBe(false)
    })
    it('resyncs at exactly the tolerance boundary', () => {
      expect(shouldResyncCastReceiver(100, 102, 2)).toBe(true)
    })
    it('resyncs when the receiver is far ahead', () => {
      expect(shouldResyncCastReceiver(110, 100, 2)).toBe(true)
    })
    it('resyncs when the receiver is far behind', () => {
      expect(shouldResyncCastReceiver(90, 100, 2)).toBe(true)
    })
  })
})

// ──────────────────────────────────────────────────────────────────
// Casting mid-party (2026-09).
//
// Three things had to change for "someone casts, nobody else notices, the
// cast joins the timeline" to hold: cast sessions can now be anchored
// independently of the local player's, a host does not speak for the party
// until its receiver has actually arrived, and a correction that cannot land
// escalates past a seek instead of repeating forever.

describe('cast session anchoring', () => {
  describe('castAbsToReceiverSec', () => {
    it('subtracts the CAST anchor, not the local one', () => {
      // A clone anchored at 2385 while the local session still starts at 0:
      // 40 minutes in, the receiver is 15s into its own timeline.
      expect(castAbsToReceiverSec(2400, 2385)).toBe(15)
    })
    it('is the identity for an unanchored session', () => {
      expect(castAbsToReceiverSec(2400, 0)).toBe(2400)
    })
    it('floors below the anchor rather than going negative', () => {
      expect(castAbsToReceiverSec(100, 2385)).toBe(0)
    })
    it('treats a nonsense negative anchor as zero', () => {
      expect(castAbsToReceiverSec(100, -50)).toBe(100)
    })
  })

  describe('castTargetBeforeAnchor', () => {
    it('is false for a target inside the session', () => {
      expect(castTargetBeforeAnchor(2400, 2385)).toBe(false)
    })
    it('is true for a target the session can never reach', () => {
      expect(castTargetBeforeAnchor(100, 2385)).toBe(true)
    })
    it('tolerates sub-second noise at the boundary', () => {
      // Not worth re-anchoring a whole cast session over rounding.
      expect(castTargetBeforeAnchor(2384.5, 2385)).toBe(false)
    })
    it('is false for any target when the session is unanchored', () => {
      expect(castTargetBeforeAnchor(0, 0)).toBe(false)
    })
  })
})

describe('castResyncAction (closing the cast correction dead ends)', () => {
  const base = {
    receiverSec: 100,
    targetAbsSec: 100,
    castStartSec: 0,
    toleranceSec: 2,
    stuckToleranceSec: 6,
    stuckPolls: 0,
    reanchorAfterPolls: 5,
    reanchorAllowed: true,
    unreachableReanchorAllowed: true,
  }

  it('does nothing while the receiver is within tolerance', () => {
    const d = castResyncAction({ ...base, receiverSec: 101 })
    expect(d.action).toBe('none')
    expect(d.stuck).toBe(false)
  })

  it('seeks for ordinary drift', () => {
    const d = castResyncAction({ ...base, receiverSec: 97 })
    expect(d.action).toBe('seek')
    expect(d.targetRecvSec).toBe(100)
  })

  it('targets the RECEIVER clock, not the absolute one', () => {
    const d = castResyncAction({ ...base, receiverSec: 0, targetAbsSec: 2400, castStartSec: 2385 })
    expect(d.action).toBe('seek')
    expect(d.targetRecvSec).toBe(15)
  })

  it('never counts an unreachable-target poll toward the stuck streak', () => {
    // The streak infers "this seek cannot land" from repeated nowhere-near
    // readings. A target before the anchor is a different failure with its own
    // immediate answer, and letting it inflate the streak would make an
    // unrelated forward escalation fire early.
    const before = castResyncAction({ ...base, receiverSec: 0, targetAbsSec: 60, castStartSec: 2385 })
    expect(before.stuck).toBe(false)
    const blocked = castResyncAction({
      ...base, receiverSec: 0, targetAbsSec: 60, castStartSec: 2385,
      unreachableReanchorAllowed: false,
    })
    expect(blocked.stuck).toBe(false)
  })

  it('re-anchors immediately for a target before the session anchor', () => {
    // The dead end: absMsToCastSec floors here, so the correction ladder
    // would aim at the anchor forever while the party sits earlier.
    const d = castResyncAction({ ...base, receiverSec: 0, targetAbsSec: 60, castStartSec: 2385 })
    expect(d.action).toBe('reanchor')
  })

  it('reports BLOCKED, not none, when an unreachable target has no re-anchor left', () => {
    const d = castResyncAction({
      ...base, receiverSec: 0, targetAbsSec: 60, castStartSec: 2385,
      unreachableReanchorAllowed: false,
    })
    // A seek to the floored target would just re-pin the receiver at the
    // anchor it is already stuck on, so the poll takes no action either way —
    // but this is the opposite of 'none'. A host warm-up waiting to converge
    // must not read "I have given up" as "it arrived" and start speaking for
    // a party its TV is nowhere near.
    expect(d.action).toBe('blocked')
  })

  it('does not count an ordinary correction as stuck', () => {
    // Command latency plus a target that keeps advancing leaves a WORKING
    // correction out of tolerance for a poll or two. Counting those would
    // re-anchor healthy casts every few seconds.
    const d = castResyncAction({ ...base, receiverSec: 97 })
    expect(d.stuck).toBe(false)
  })

  it('counts a receiver nowhere near the target as stuck', () => {
    const d = castResyncAction({ ...base, receiverSec: 40 })
    expect(d.stuck).toBe(true)
    expect(d.action).toBe('seek') // not yet — the streak has to build
  })

  it('escalates to a re-anchor once the stuck streak completes', () => {
    const d = castResyncAction({ ...base, receiverSec: 40, stuckPolls: 4 })
    expect(d.action).toBe('reanchor')
  })

  it('never escalates on a streak of merely-drifting polls', () => {
    // stuckPolls can only have been raised by genuinely stuck readings, but
    // pin the pairing: a poll inside stuckToleranceSec stays a seek however
    // long the streak.
    const d = castResyncAction({ ...base, receiverSec: 97, stuckPolls: 99 })
    expect(d.action).toBe('seek')
    expect(d.stuck).toBe(false)
  })

  it('falls back to seeking when the re-anchor budget is spent', () => {
    const d = castResyncAction({ ...base, receiverSec: 40, stuckPolls: 9, reanchorAllowed: false })
    expect(d.action).toBe('seek')
  })
})

describe('castHostPhase (a casting host does not start out authoritative)', () => {
  it('starts in warm-up', () => {
    expect(castHostPhase(false, 1_000, 1_000, 12_000)).toBe('warmup')
  })
  it('becomes authoritative the moment the receiver converges', () => {
    expect(castHostPhase(true, 1_000, 1_100, 12_000)).toBe('authoritative')
  })
  it('stays in warm-up while the budget has time left', () => {
    expect(castHostPhase(false, 1_000, 12_999, 12_000)).toBe('warmup')
  })
  it('takes authority anyway once the budget is spent', () => {
    // A receiver that never arrives must not leave the host permanently
    // unable to pause the room from their own TV.
    expect(castHostPhase(false, 1_000, 13_000, 12_000)).toBe('authoritative')
  })
  it('a converged host is never sent back to warm-up by the clock', () => {
    expect(castHostPhase(true, 1_000, 1_001, 12_000)).toBe('authoritative')
  })
  it('treats an unarmed clock as not-yet-started, not as long-expired', () => {
    // 0 is the ref's initial value. Reading `now - 0 >= budget` as an expired
    // budget skips the warm-up on every path that reaches the first poll
    // without arming it — a host already casting solo who then joins a party,
    // or a first poll that finds the media already loaded.
    expect(castHostPhase(false, 0, Date.now(), 12_000)).toBe('warmup')
    expect(castHostPhase(false, -1, Date.now(), 12_000)).toBe('warmup')
  })
})

describe('partyTargetAbsSec', () => {
  // Emitted and received at the same instant on a shared clock, so elapsed
  // time is simply `now - 5_000`.
  const running = { abs_ms: 600_000, server_now_ms: 5_000, running: true, receivedAtMs: 5_000 }

  it('projects a running party forward by elapsed time', () => {
    // 2s since the tick was emitted and received.
    expect(partyTargetAbsSec(running, true, 0, 7_000)).toBe((600_000 + 2_000) / 1000)
  })

  it('returns null when a running party tick has gone stale', () => {
    // Free-run rather than seed a cast from a server that may have moved on.
    expect(partyTargetAbsSec(running, true, 0, 9_001)).toBeNull()
  })

  it('reports a paused party exactly, however old the tick', () => {
    // No tick loop runs while paused, so receivedAtMs ages without bound
    // while abs_ms stays exactly right. Ageing this out would reject every
    // paused party's true position.
    const paused = { abs_ms: 600_000, server_now_ms: 5_000, running: false, receivedAtMs: 5_000 }
    expect(partyTargetAbsSec(paused, false, 0, 10_000_000)).toBe(600)
  })

  it('treats a party the client believes is paused as frozen too', () => {
    // isPlaying is the client's own view of the canonical flag; a tick that
    // still says running while the party has paused must not be projected.
    expect(partyTargetAbsSec(running, false, 0, 10_000_000)).toBe(600)
  })

  it('returns null with no tick at all', () => {
    expect(partyTargetAbsSec(null, true, 0, 1_000)).toBeNull()
    expect(partyTargetAbsSec(undefined, true, 0, 1_000)).toBeNull()
  })

  it('applies the clock offset like the local drift loop does', () => {
    // A client 500ms behind the server sees a correspondingly larger elapsed.
    const withOffset = partyTargetAbsSec(running, true, 500, 7_000)
    const withNone = partyTargetAbsSec(running, true, 0, 7_000)
    expect(withOffset).toBeGreaterThan(withNone as number)
  })

  it('refuses a non-finite projection rather than reporting NaN', () => {
    // NaN reads as "in tolerance" to every downstream comparison
    // (Math.abs(NaN) >= tol is false), which would silently report a converged
    // receiver and a settled cast.
    const bad = { abs_ms: 600_000, server_now_ms: Number.NaN, running: true, receivedAtMs: 5_000 }
    expect(partyTargetAbsSec(bad, true, 0, 7_000)).toBeNull()
    expect(partyTargetAbsSec(running, true, Number.NaN, 7_000)).toBeNull()
  })

  it('never returns a negative position', () => {
    const weird = { abs_ms: -1, server_now_ms: 5_000, running: false, receivedAtMs: 5_000 }
    expect(partyTargetAbsSec(weird, false, 0, 6_000)).toBe(0)
  })
})

describe('castReanchorBudgetAfter (the re-anchor budget)', () => {
  const SETTLED = 10
  const fresh = { used: 0, settledPolls: 0 }

  it('charges a re-anchor and clears any settled run', () => {
    const b = castReanchorBudgetAfter({ used: 0, settledPolls: 4 }, 'reanchored', SETTLED)
    expect(b).toEqual({ used: 1, settledPolls: 0 })
  })

  it('refunds a re-anchor whose load never reached the receiver', () => {
    // A mint that 429s on the per-user session cap, or a getter that finds no
    // media because the local session is mid-reboot, re-anchored nothing.
    const b = castReanchorBudgetAfter({ used: 1, settledPolls: 0 }, 'reanchor-failed', SETTLED)
    expect(b.used).toBe(0)
  })

  it('never refunds below zero', () => {
    // The refund is async; a per-title reset can land in between.
    expect(castReanchorBudgetAfter(fresh, 'reanchor-failed', SETTLED).used).toBe(0)
  })

  it('does NOT earn a re-anchor back on a single in-tolerance poll', () => {
    // This is the whole point. A re-anchor loads the receiver AT the party
    // position, so the first poll after it lands is in tolerance almost by
    // construction — refunding there would let a receiver that stalls a few
    // seconds after every load re-anchor for the entire title.
    const b = castReanchorBudgetAfter({ used: 2, settledPolls: 0 }, 'converged', SETTLED)
    expect(b.used).toBe(2)
    expect(b.settledPolls).toBe(1)
  })

  it('earns one back after a sustained run of in-tolerance polls', () => {
    let b = { used: 2, settledPolls: 0 }
    for (let i = 0; i < SETTLED; i++) b = castReanchorBudgetAfter(b, 'converged', SETTLED)
    expect(b.used).toBe(1)
    expect(b.settledPolls).toBe(0) // the run restarts; the next one costs another full run
  })

  it('breaks the run on any correction, so a stalling receiver never earns one back', () => {
    // Plays in tolerance for a few polls after each load, then drifts.
    let b = { used: 2, settledPolls: 0 }
    for (let cycle = 0; cycle < 20; cycle++) {
      for (let i = 0; i < 4; i++) b = castReanchorBudgetAfter(b, 'converged', SETTLED)
      b = castReanchorBudgetAfter(b, 'other', SETTLED)
    }
    expect(b.used).toBe(2)
  })

  it('does not go below zero on a converged run with nothing spent', () => {
    let b = fresh
    for (let i = 0; i < SETTLED * 3; i++) b = castReanchorBudgetAfter(b, 'converged', SETTLED)
    expect(b.used).toBe(0)
  })
})

describe('castResyncAction: the two escalations are budgeted separately', () => {
  const base = {
    receiverSec: 0,
    targetAbsSec: 60,
    castStartSec: 2385,
    toleranceSec: 2,
    stuckToleranceSec: 6,
    stuckPolls: 0,
    reanchorAfterPolls: 5,
    reanchorAllowed: true,
    unreachableReanchorAllowed: true,
  }

  it('answers a target before the anchor even when the INFERRED budget is spent', () => {
    // The count cap exists because inference can misjudge a slow receiver. A
    // target before the anchor is arithmetic — it cannot be a misdiagnosis —
    // so spending the count on earlier stuck-inference escalations must not
    // leave a host's rewind permanently unanswerable.
    const d = castResyncAction({ ...base, reanchorAllowed: false })
    expect(d.action).toBe('reanchor')
  })

  it('blocks a target before the anchor only when ITS own allowance is spent', () => {
    const d = castResyncAction({ ...base, unreachableReanchorAllowed: false })
    expect(d.action).toBe('blocked')
  })

  it('does not let the unreachable allowance answer an inferred stuck receiver', () => {
    // Target is reachable (after the anchor); the receiver is just nowhere
    // near it. That is the inference path, and only its own budget applies.
    const d = castResyncAction({
      ...base, targetAbsSec: 2500, receiverSec: 0, stuckPolls: 9,
      reanchorAllowed: false, unreachableReanchorAllowed: true,
    })
    expect(d.action).toBe('seek')
  })
})

describe('decideHostBroadcast', () => {
  const now = { paused: false, sec: 100, atMs: 10_000 }
  const playing = { paused: false, sec: 99, atMs: 9_000 }
  const paused = { paused: true, sec: 99, atMs: 9_000 }
  const base = {
    prev: playing,
    now,
    latchingAuthority: false,
    loadInFlight: false,
    episodeMismatch: false,
    anchorUnknown: false,
    correctionSettling: false,
    pausedScrubToleranceSec: 1,
    seekJumpToleranceSec: 3,
  }

  // THE invariant. Four review rounds broke it in four different places: a
  // guard that declines to act must leave the pre-guard baseline standing, or
  // the transition it was protecting is destroyed rather than deferred.
  //
  // Note which guards are TOTAL and which are not. `correctionSettling` is
  // deliberately absent: it suppresses POSITION comparisons only, because a
  // corrective seek cannot change whether the receiver is paused — extending
  // it over pause/play is what lost a host's pause on the headline path, and
  // it has its own test below. Stating that difference here rather than
  // assuming it uniform is the point of the table.
  describe('every TOTAL guard keeps the baseline', () => {
    const guards: Array<[string, Partial<HostBroadcastInput>]> = [
      ['unknown anchor', { anchorUnknown: true }],
      ['load in flight', { loadInFlight: true }],
      ['episode mismatch', { episodeMismatch: true }],
    ]
    for (const [name, patch] of guards) {
      it(`${name}: a host pause made during it survives to be broadcast later`, () => {
        // The host pauses the TV while the guard is up.
        const guarded = decideHostBroadcast({
          ...base, ...patch, prev: playing, now: { paused: true, sec: 100, atMs: 10_000 },
        })
        expect(guarded.broadcast.kind).toBe('none')
        expect(guarded.baseline).toBe('keep')

        // The guard lifts on the next poll. Because the baseline was KEPT, the
        // transition is still there to find.
        const after = decideHostBroadcast({
          ...base, prev: playing, now: { paused: true, sec: 100, atMs: 11_000 },
        })
        expect(after.broadcast.kind).toBe('pause-at-receiver')
      })
    }
  })

  it('is silent on the first sample after a (re)connect', () => {
    const d = decideHostBroadcast({ ...base, prev: null })
    expect(d.broadcast.kind).toBe('none')
    expect(d.baseline).toBe('record')
  })

  it('broadcasts a pause the host makes on the TV', () => {
    const d = decideHostBroadcast({ ...base, prev: playing, now: { paused: true, sec: 100, atMs: 10_000 } })
    expect(d.broadcast.kind).toBe('pause-at-receiver')
    expect(d.baseline).toBe('record')
  })

  it('corrects the position first when the TV was scrubbed while paused', () => {
    const d = decideHostBroadcast({ ...base, prev: paused, now: { paused: false, sec: 300, atMs: 10_000 } })
    expect(d.broadcast.kind).toBe('seek-then-play')
  })

  it('just resumes when a paused TV was not scrubbed', () => {
    const d = decideHostBroadcast({ ...base, prev: paused, now: { paused: false, sec: 99.2, atMs: 10_000 } })
    expect(d.broadcast.kind).toBe('play')
  })

  it('re-states a paused party position after a scrub on the TV', () => {
    const d = decideHostBroadcast({ ...base, prev: paused, now: { paused: true, sec: 300, atMs: 10_000 } })
    expect(d.broadcast.kind).toBe('pause-rescrub')
  })

  it('reads a jump bigger than playback progression as a scrub', () => {
    const d = decideHostBroadcast({ ...base, prev: playing, now: { paused: false, sec: 300, atMs: 10_000 } })
    expect(d.broadcast.kind).toBe('seek')
  })

  it('does not read natural progression as a scrub', () => {
    const d = decideHostBroadcast({ ...base, prev: playing, now: { paused: false, sec: 100, atMs: 10_000 } })
    expect(d.broadcast.kind).toBe('none')
    expect(d.baseline).toBe('record')
  })

  it('reads pause/play through the correction window, but not position', () => {
    // A corrective seek cannot change whether the receiver is paused, so
    // suppressing pause/play there is what lost a host's pause on the
    // headline path.
    const pause = decideHostBroadcast({
      ...base, correctionSettling: true, prev: playing, now: { paused: true, sec: 100, atMs: 10_000 },
    })
    expect(pause.broadcast.kind).toBe('pause-at-receiver')
    const jump = decideHostBroadcast({
      ...base, correctionSettling: true, prev: playing, now: { paused: false, sec: 300, atMs: 10_000 },
    })
    expect(jump.broadcast.kind).toBe('none')
    expect(jump.baseline).toBe('keep')
  })

  describe('taking authority on an expired warm-up budget', () => {
    // Exactly what the call site passes on that poll. The earlier version of
    // this block set an `authoritative` flag alongside it that the component
    // could never produce, so all three cases passed while pinning a branch no
    // user reached — and the real latch path had no test at all.
    const latch = { ...base, latchingAuthority: true }

    it('reads a pause from the last warm-up poll before dropping the baseline', () => {
      const d = decideHostBroadcast({ ...latch, prev: playing, now: { paused: true, sec: 100, atMs: 10_000 } })
      expect(d.broadcast.kind).toBe('pause-at-receiver')
      expect(d.baseline).toBe('record')
    })

    it('reads a play the same way — the mirror image is just as permanent', () => {
      const d = decideHostBroadcast({ ...latch, prev: paused, now: { paused: false, sec: 100, atMs: 10_000 } })
      expect(d.broadcast.kind).toBe('play')
    })

    it('otherwise starts clean, with no pre-correction baseline', () => {
      const d = decideHostBroadcast({ ...latch, prev: playing, now: { paused: false, sec: 100, atMs: 10_000 } })
      expect(d.broadcast.kind).toBe('none')
      expect(d.baseline).toBe('clear')
    })
  })

  it('guards win over the arms, in order', () => {
    // A load in flight during an episode mismatch on an unknown anchor is
    // still just "do nothing, keep the baseline" — no arm can fire past a
    // guard however the flags combine.
    const d = decideHostBroadcast({
      ...base, anchorUnknown: true, loadInFlight: true, episodeMismatch: true,
      prev: playing, now: { paused: true, sec: 300, atMs: 10_000 },
    })
    expect(d.broadcast.kind).toBe('none')
    expect(d.baseline).toBe('keep')
  })
})

describe('decideHostBroadcast: the latch poll as the component actually calls it', () => {
  // Regression cover for a wiring bug the earlier tests hid. They passed an
  // `authoritative` flag alongside `latchingAuthority`, a combination the call
  // site cannot produce, so three cases passed while pinning an unreachable
  // branch — and the poll that really does hand a host authority on an expired
  // warm-up budget had no test at all.
  const now = { paused: true, sec: 100, atMs: 10_000 }
  const playingBefore = { paused: false, sec: 99, atMs: 9_000 }
  const latch = {
    prev: playingBefore,
    now,
    latchingAuthority: true,
    loadInFlight: false,
    episodeMismatch: false,
    anchorUnknown: false,
    correctionSettling: false,
    pausedScrubToleranceSec: 1,
    seekJumpToleranceSec: 3,
  }

  it('broadcasts the RECEIVER position, not the party position', () => {
    // The room and the TV are apart — that is why the budget expired — and the
    // latch is where the TV becomes the truth. Broadcasting the party's own
    // position here would leave them apart permanently, since an authoritative
    // host never corrects itself.
    expect(decideHostBroadcast(latch).broadcast).toEqual({ kind: 'pause-at-receiver' })
  })

  it('broadcasts it regardless of whether the room is already paused', () => {
    // There is no partyIsPlaying input on this path by design: the TV's
    // position has to reach the room even when the room is already stopped.
    expect(decideHostBroadcast(latch).broadcast.kind).toBe('pause-at-receiver')
  })
})
