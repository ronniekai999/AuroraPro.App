import { describe, expect, it } from 'vitest'
import {
  isPlaybackResolutionCurrent,
  needsHlsSessionRebuild,
  pauseIntentForReplacementSeek,
  partyPlayerAutoOpenKey,
  partyPlayerDismissalKeyOnClose,
  resolvePlaybackBootPause,
  shouldApplyExplicitPartySeek,
  shouldAutoOpenPartyPlayer,
  shouldClosePlayerOnPathChange,
  shouldPreservePauseForLocalSeekRebuild,
  shouldPreservePauseForBoot,
  shouldPreservePauseOnSeekRebuild,
  shouldRebuildSeekBeforeDeliveryReady,
  shouldReplaceUnreadyTargetForExplicitSeek,
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
