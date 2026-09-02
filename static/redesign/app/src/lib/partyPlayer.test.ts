import { describe, expect, it } from 'vitest'
import {
  castPlayPauseMismatch,
  isCastHostSeekJump,
  isPartyEpisodeMismatch,
  isPlaybackResolutionCurrent,
  levelLagsPlayhead,
  needsBackwardSessionRebuild,
  needsHlsSessionRebuild,
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
