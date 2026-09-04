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

  // "" reaches us both for a genuinely silent file and for one whose scan
  // recorded no audio codec. Only the second hangs the receiver, and the two
  // are indistinguishable here — so refuse, which costs at most a silent
  // video that will not cast.
  it('refuses an unestablished audio codec rather than guessing it is silent', () => {
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
