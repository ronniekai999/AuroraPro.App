// Unit tests for the pure helpers in lib/cast.
//
// castSessionIdFromPlaylist is small but load-bearing: the ID it recovers is
// how the player knows which transcode session the TV is streaming, which is
// what stops the player's own teardown from deleting it and what lets the
// keepalive ticker keep it warm. Get it wrong and the failure is a cast that
// dies minutes later for no visible reason.

import { describe, expect, it } from 'vitest'
import { castSessionIdFromPlaylist, describeCastError } from './cast'

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
