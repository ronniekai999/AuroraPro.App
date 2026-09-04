// Unit tests for the pure helpers in lib/cast.
//
// castSessionIdFromPlaylist is small but load-bearing: the ID it recovers is
// how the player knows which transcode session the TV is streaming, which is
// what stops the player's own teardown from deleting it and what lets the
// keepalive ticker keep it warm. Get it wrong and the failure is a cast that
// dies minutes later for no visible reason.

import { describe, expect, it } from 'vitest'
import {
  castDirectLoadEligible,
  castDirectMatches,
  castDirectPlaySupported,
  castLoadedIsDirectFor,
  castObservationShowsMedia,
  castProbeStatusIsFatal,
  decideCastEnd,
  castSessionIdFromPlaylist,
  describeCastError,
} from './cast'

describe('castSessionIdFromPlaylist', () => {
  it('reads the session ID out of the URL the cast-token endpoint returns', () => {
    expect(castSessionIdFromPlaylist('/api/stream/hls/abc123/master.m3u8?token=eyJhbGc.payload.sig'))
      .toBe('abc123')
  })

  it('works on the absolute form handed to the receiver', () => {
    expect(castSessionIdFromPlaylist('https://aurora.example.com/api/stream/hls/def456/master.m3u8?token=t'))
      .toBe('def456')
  })

  it('handles a token-less URL', () => {
    expect(castSessionIdFromPlaylist('/api/stream/hls/ghi789/master.m3u8')).toBe('ghi789')
  })

  // The clone is a different session from the local player's — that
  // difference is the entire reason this function exists.
  it('reports the clone ID, not whatever the caller passed in', () => {
    expect(castSessionIdFromPlaylist('/api/stream/hls/cast-clone-1/master.m3u8?token=t'))
      .toBe('cast-clone-1')
  })

  it('returns null for shapes it does not recognize', () => {
    expect(castSessionIdFromPlaylist('')).toBeNull()
    expect(castSessionIdFromPlaylist('/api/stream/hls//master.m3u8')).toBeNull()
    expect(castSessionIdFromPlaylist('/api/stream/hls/abc/720p/stream.m3u8')).toBeNull()
    expect(castSessionIdFromPlaylist('/api/stream/direct/12?type=media')).toBeNull()
  })
})

// Kept alongside because it guards the same flow's error surface: issue #311
// was a cast failure that reached the user as "Cast failed: unknown".
describe('describeCastError', () => {
  it('maps a bare error-code string to something actionable', () => {
    expect(describeCastError('session_error')).toContain('Wi-Fi')
    expect(describeCastError('receiver_unavailable')).toContain('No Cast devices')
  })
  it('maps the structured chrome.cast.Error shape', () => {
    expect(describeCastError({ code: 'timeout' })).toContain('did not respond')
  })
  it('preserves unmapped detail rather than collapsing to "unknown"', () => {
    expect(describeCastError({ code: 'weird_code', description: 'the details' }))
      .toBe('weird_code: the details')
    expect(describeCastError('some_new_code')).toBe('some_new_code')
  })
})


// castDirectPlaySupported decides whether a direct-play file can go to the
// Default Media Receiver as-is. Its two failure modes are NOT symmetric,
// which is the whole reason it is a conservative allowlist rather than a
// denylist: a false negative shows an honest "can't cast this format"
// message, while a false positive resolves loadMedia and then spins on the
// TV forever with nothing for the sender to report (issue #503).
describe('castDirectPlaySupported', () => {
  const ok = { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', resolution: '1920x1080' }

  it('admits H.264 + AAC in MP4 — the case every Cast device decodes', () => {
    expect(castDirectPlaySupported(ok)).toBe(true)
  })

  it('admits MP3 audio', () => {
    expect(castDirectPlaySupported({ ...ok, audioCodec: 'mp3' })).toBe(true)
  })

  it('normalizes case and stray whitespace', () => {
    expect(castDirectPlaySupported({
      container: ' MP4 ', videoCodec: 'H264', audioCodec: 'AAC', resolution: ' 1280 x 720 ',
    })).toBe(true)
  })

  // Each of these direct-plays fine in a browser, which is exactly the trap:
  // "the browser can play it" says nothing about the receiver.
  it('refuses codecs whose support varies by device generation', () => {
    for (const videoCodec of ['hevc', 'h265', 'vp8', 'vp9', 'av1']) {
      expect(castDirectPlaySupported({ ...ok, videoCodec })).toBe(false)
    }
  })

  it('refuses audio the receiver does not decode', () => {
    for (const audioCodec of ['opus', 'vorbis', 'flac', 'ac3', 'eac3', 'dts']) {
      expect(castDirectPlaySupported({ ...ok, audioCodec })).toBe(false)
    }
  })

  it('refuses non-MP4 containers', () => {
    for (const container of ['webm', 'mkv', 'ts', 'avi']) {
      expect(castDirectPlaySupported({ ...ok, container })).toBe(false)
    }
  })

  // Codec identity is not the receiver's only limit. Only Ultra/Google TV
  // decode 4K, and the sender never learns which device it is.
  it('refuses anything taller than 1080p', () => {
    expect(castDirectPlaySupported({ ...ok, resolution: '3840x2160' })).toBe(false)
    expect(castDirectPlaySupported({ ...ok, resolution: '4096x2160' })).toBe(false)
    expect(castDirectPlaySupported({ ...ok, resolution: '1920x1081' })).toBe(false)
  })

  it('admits heights up to and including 1080, ultrawide included', () => {
    expect(castDirectPlaySupported({ ...ok, resolution: '1920x1080' })).toBe(true)
    expect(castDirectPlaySupported({ ...ok, resolution: '1280x720' })).toBe(true)
    // Wider than 4K but only 800 tall — the height is the constraint.
    expect(castDirectPlaySupported({ ...ok, resolution: '3840x800' })).toBe(true)
  })

  // Fail CLOSED, every field. An absent value means we could not establish
  // the property, and an unestablished property is precisely the case that
  // hangs the receiver.
  it('refuses anything it cannot positively identify', () => {
    expect(castDirectPlaySupported({})).toBe(false)
    expect(castDirectPlaySupported({ container: 'mp4' })).toBe(false)
    expect(castDirectPlaySupported({ ...ok, container: undefined })).toBe(false)
    expect(castDirectPlaySupported({ ...ok, videoCodec: 'something-new' })).toBe(false)
    expect(castDirectPlaySupported({ ...ok, resolution: undefined })).toBe(false)
    expect(castDirectPlaySupported({ ...ok, resolution: 'unknown' })).toBe(false)
    expect(castDirectPlaySupported({ ...ok, resolution: '1920x' })).toBe(false)
    expect(castDirectPlaySupported({ ...ok, resolution: '0x0' })).toBe(false)
  })

  // Defensive only: "" is not reachable from the real data path, because
  // OutputAudioCodec falls back to "aac" when a decision carries no audio
  // codec — so a genuinely silent file arrives as "aac" and is admitted,
  // which is right (a silent MP4 casts fine). This pins the fail-closed
  // behaviour for a value only a contract change could produce.
  it('refuses an audio codec it cannot identify', () => {
    expect(castDirectPlaySupported({ ...ok, audioCodec: '' })).toBe(false)
    expect(castDirectPlaySupported({ ...ok, audioCodec: undefined })).toBe(false)
  })
})

// These two exist so the load path, the pre-flight check and the seek path
// cannot drift apart — an adversarial review caught them having already done
// so, with the seek path keying on delivery mode alone.
describe('castDirectMatches / castDirectLoadEligible', () => {
  const dc = { fileId: 42, fileType: 'media' as const, supported: true }
  const target = { fileId: 42, fileType: 'media' as const }

  it('matches a target the direct-cast state describes', () => {
    expect(castDirectMatches(dc, target)).toBe(true)
  })

  it('refuses a different file, which is what makes a stale ref harmless', () => {
    expect(castDirectMatches(dc, { fileId: 43, fileType: 'media' })).toBe(false)
  })

  // An episode file and a media file can share an id — they are different
  // tables — so the type is part of the identity, not decoration.
  it('refuses the same id under the other file type', () => {
    expect(castDirectMatches(dc, { fileId: 42, fileType: 'episode' })).toBe(false)
  })

  it('treats missing state as no match', () => {
    expect(castDirectMatches(null, target)).toBe(false)
    expect(castDirectMatches(dc, null)).toBe(false)
    expect(castDirectMatches(undefined, undefined)).toBe(false)
  })

  it('is eligible only when direct delivery, a target match, and support agree', () => {
    expect(castDirectLoadEligible('direct', dc, target)).toBe(true)
    expect(castDirectLoadEligible('hls', dc, target)).toBe(false)
    expect(castDirectLoadEligible('resolving', dc, target)).toBe(false)
    expect(castDirectLoadEligible('idle', dc, target)).toBe(false)
    expect(castDirectLoadEligible('direct', { ...dc, supported: false }, target)).toBe(false)
    expect(castDirectLoadEligible('direct', dc, { fileId: 43, fileType: 'media' })).toBe(false)
    expect(castDirectLoadEligible('direct', null, target)).toBe(false)
  })
})

// What the RECEIVER is playing, which is not the same question as what the
// local player is doing. Inferring one from the other is how a scrub came to
// seek the wrong title: the tracker is per-player-mount while the CAF session
// is not, so a page reload mid-cast re-joins a live session against a fresh
// player that has committed nothing.
describe('castLoadedIsDirectFor', () => {
  const target = { fileId: 42, fileType: 'media' as const }

  it('is true only for a direct load of this exact file', () => {
    expect(castLoadedIsDirectFor({ kind: 'direct', fileId: 42, fileType: 'media' }, target))
      .toBe(true)
  })

  it('is false when the receiver is on an HLS session', () => {
    expect(castLoadedIsDirectFor({ kind: 'session', sessionId: 'clone-1' }, target)).toBe(false)
  })

  // The reload case: nothing has been committed by this player instance, so
  // nothing is known about the receiver and no in-window seek may be assumed.
  it('is false when nothing is known about the receiver', () => {
    expect(castLoadedIsDirectFor(null, target)).toBe(false)
    expect(castLoadedIsDirectFor(undefined, target)).toBe(false)
  })

  it('is false for a direct load of a different file', () => {
    expect(castLoadedIsDirectFor({ kind: 'direct', fileId: 43, fileType: 'media' }, target))
      .toBe(false)
    expect(castLoadedIsDirectFor({ kind: 'direct', fileId: 42, fileType: 'episode' }, target))
      .toBe(false)
  })

  it('is false without a target', () => {
    expect(castLoadedIsDirectFor({ kind: 'direct', fileId: 42, fileType: 'media' }, null))
      .toBe(false)
  })
})

// Whether a failed self-test aborts the cast. The question is never "did the
// probe fail" but "will the receiver's own fetch meet the same answer": abort
// on a verdict, proceed on a hiccup. Getting it wrong costs a silent spinner
// in one direction and a refused-but-workable cast in the other.
describe('castProbeStatusIsFatal', () => {
  it('aborts on a verdict about this URL', () => {
    // Token rejected or revoked between mint and load.
    expect(castProbeStatusIsFatal(401)).toBe(true)
    expect(castProbeStatusIsFatal(403)).toBe(true)
    // File gone.
    expect(castProbeStatusIsFatal(404)).toBe(true)
    expect(castProbeStatusIsFatal(410)).toBe(true)
    // ServeFile answers 500 deterministically when it cannot stat the file,
    // so this one is a verdict despite being 5xx — the case a bare
    // "status < 500" test let through to the indefinite spinner.
    expect(castProbeStatusIsFatal(500)).toBe(true)
  })

  it('proceeds on a transient, which says nothing about the receiver', () => {
    expect(castProbeStatusIsFatal(502)).toBe(false)
    expect(castProbeStatusIsFatal(503)).toBe(false)
    expect(castProbeStatusIsFatal(504)).toBe(false)
    expect(castProbeStatusIsFatal(429)).toBe(false)
    expect(castProbeStatusIsFatal(408)).toBe(false)
  })

  // This route only acquired its HEAD registration for the probe, so a proxy
  // that refuses HEAD must not abort a cast that would have worked.
  it('proceeds when the probe METHOD is what was refused', () => {
    expect(castProbeStatusIsFatal(405)).toBe(false)
    expect(castProbeStatusIsFatal(501)).toBe(false)
  })

  it('never aborts on success', () => {
    for (const ok of [200, 204, 206, 304]) {
      expect(castProbeStatusIsFatal(ok)).toBe(false)
    }
  })
})

// The cast-lifecycle rules. These were mutable refs read by three effects
// hundreds of lines apart in an untested component, and three consecutive
// review rounds each found a defect that the previous round's patch had
// introduced. Every scenario those rounds reasoned about in prose is a case
// here.
describe('castObservationShowsMedia', () => {
  const base = {
    connected: true, settling: false, isMediaLoaded: true,
    updateSeq: 7, seqAtConnect: 3,
  }

  it('accepts a loaded receiver on a fresh reading', () => {
    expect(castObservationShowsMedia(base)).toBe(true)
  })

  it('rejects everything that is not a connected, loaded receiver', () => {
    expect(castObservationShowsMedia({ ...base, connected: false })).toBe(false)
    expect(castObservationShowsMedia({ ...base, isMediaLoaded: false })).toBe(false)
  })

  // `remote` is explicitly not trusted while settling — its freeze lifts at
  // the reconnect edge, before the SDK has necessarily caught up.
  it('rejects a reading taken during the settle window', () => {
    expect(castObservationShowsMedia({ ...base, settling: true })).toBe(false)
  })

  // THE ONE THAT MATTERS. stop() bypasses the disconnect debounce and never
  // forces a republish, and the player is never unmounted, so isMediaLoaded
  // can still read true from a cast that already ended. Believing it at the
  // next connect edge marks a brand-new session as already loaded — and a
  // failed cast then closes the player over a half-watched film.
  it('rejects a reading carried over from the previous session', () => {
    expect(castObservationShowsMedia({ ...base, updateSeq: 3, seqAtConnect: 3 }))
      .toBe(false)
  })

  it('accepts the first genuine update after the connect edge', () => {
    expect(castObservationShowsMedia({ ...base, updateSeq: 4, seqAtConnect: 3 }))
      .toBe(true)
  })

  // A re-joined session (page reload mid-cast) has no connect edge of ours to
  // sample, and the receiver really is playing — that is the case this whole
  // observation path exists to cover.
  it('accepts a reading when no connect edge was sampled', () => {
    expect(castObservationShowsMedia({ ...base, seqAtConnect: null })).toBe(true)
  })
})

describe('decideCastEnd', () => {
  it('closes the player when the cast was a real viewing', () => {
    expect(decideCastEnd({ everLoaded: true, pausedByCast: true, partyControlsMedia: false }))
      .toBe('close')
    expect(decideCastEnd({ everLoaded: true, pausedByCast: false, partyControlsMedia: false }))
      .toBe('close')
  })

  // The failed attempt: the user pressed Cast, not Pause. Local playback was
  // paused on the promise that a close would follow, and it will not.
  it('resumes local playback when the cast never carried media', () => {
    expect(decideCastEnd({ everLoaded: false, pausedByCast: true, partyControlsMedia: false }))
      .toBe('resume')
  })

  // Nothing to give back: the user had already paused, or we never paused.
  it('does nothing when we did not pause the local element', () => {
    expect(decideCastEnd({ everLoaded: false, pausedByCast: false, partyControlsMedia: false }))
      .toBe('none')
  })

  // Under a party the cast ending is not the end of the viewing, and the party
  // mirror owns play state — closing kicks the user out of the party UI,
  // resuming plays against a party that may be paused.
  it('leaves a party-controlled viewing entirely alone', () => {
    for (const everLoaded of [true, false]) {
      for (const pausedByCast of [true, false]) {
        expect(decideCastEnd({ everLoaded, pausedByCast, partyControlsMedia: true }))
          .toBe('none')
      }
    }
  })

  // The pair: for one cast, exactly one of close/resume can be chosen, and
  // never both. Reasoning about them in separate effects is what let them come
  // apart three rounds running.
  it('never both closes and resumes', () => {
    for (const everLoaded of [true, false]) {
      for (const pausedByCast of [true, false]) {
        for (const partyControlsMedia of [true, false]) {
          const a = decideCastEnd({ everLoaded, pausedByCast, partyControlsMedia })
          expect(['close', 'resume', 'none']).toContain(a)
          if (a === 'close') expect(everLoaded).toBe(true)
          if (a === 'resume') expect(everLoaded).toBe(false)
        }
      }
    }
  })
})
