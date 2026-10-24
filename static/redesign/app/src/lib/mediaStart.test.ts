import { describe, expect, it } from 'vitest'
import {
  MEDIA_START_ALIGN_EDGE_SEC,
  MEDIA_START_MAX_LAG_SEC,
  MEDIA_START_MAX_LEAD_SEC,
  MEDIA_START_TAG,
  mediaStartAlignmentSec,
  reportedMediaStartSec,
  sessionMediaOriginSec,
} from './mediaStart'

// The shape hls.js 1.6 gives a playlist comment `#AURORA-MEDIA-START:<s>` in
// the header: [name, value] on the FIRST fragment's tagList, beside its INF.
const fragments = (value: string | undefined, where: 'first' | 'second' = 'first') => {
  const tag = value === undefined ? [MEDIA_START_TAG] : [MEDIA_START_TAG, value]
  return [
    { tagList: where === 'first' ? [tag, ['INF', '10.000000']] : [['INF', '10.000000']] },
    { tagList: where === 'second' ? [tag, ['INF', '10.000000']] : [['INF', '10.000000']] },
  ]
}

describe('reportedMediaStartSec', () => {
  it('reads the measured start from the first fragment', () => {
    expect(reportedMediaStartSec(fragments('19.946009'))).toBe(19.946009)
    expect(reportedMediaStartSec(fragments('30'))).toBe(30)
  })
  it('is null when the playlist carries none (older servers, transcodes)', () => {
    expect(reportedMediaStartSec(undefined)).toBeNull()
    expect(reportedMediaStartSec([])).toBeNull()
    expect(reportedMediaStartSec([{ tagList: [['INF', '10']] }])).toBeNull()
    expect(reportedMediaStartSec([{}])).toBeNull()
  })
  it('only looks at the first fragment', () => {
    expect(reportedMediaStartSec(fragments('19.946009', 'second'))).toBeNull()
  })
  it("also reads a header copy, which hls.js files on an fMP4 playlist's init segment", () => {
    // What Chromium's hls.js 1.6.17 produced for the line placed in the header
    // of a playlist with #EXT-X-MAP: fragments[0] held only its INF.
    const init = { tagList: [[MEDIA_START_TAG, '19.946009']] }
    expect(reportedMediaStartSec([{ tagList: [['INF', '10.000000']], initSegment: init }])).toBe(19.946009)
    expect(reportedMediaStartSec([{ tagList: [['INF', '10.000000']], initSegment: null }])).toBeNull()
  })
  it.each([undefined, '', ' ', 'NaN', 'Infinity', '-1', '1e3', '0x10', '19.9.4', 'abc'])(
    'rejects %j rather than reading it as a number of seconds', value => {
      expect(reportedMediaStartSec(fragments(value))).toBeNull()
    })
})

describe('sessionMediaOriginSec', () => {
  it('moves a mid-file remux onto its measured key frame', () => {
    expect(sessionMediaOriginSec(25, 19.946009, true)).toBe(19.946009)
    // Matroska's dts heuristic: asked for 40 on a key frame, landed a GOP back.
    expect(sessionMediaOriginSec(40, 29.952993, true)).toBe(29.952993)
  })
  it('never moves a transcode clock: its media time 0 IS start_sec', () => {
    expect(sessionMediaOriginSec(25, 19.946009, false)).toBe(25)
  })
  it('keeps start_sec when the playlist reported nothing', () => {
    expect(sessionMediaOriginSec(25, null, true)).toBe(25)
  })
  it('has nothing to refine for a session that did not seek', () => {
    expect(sessionMediaOriginSec(0, 0.023, true)).toBe(0)
    expect(sessionMediaOriginSec(NaN, 3, true)).toBe(0)
    expect(sessionMediaOriginSec(-4, 3, true)).toBe(0)
  })
  it('ignores a start this anchor could not have produced', () => {
    expect(sessionMediaOriginSec(25, 25 + MEDIA_START_MAX_LEAD_SEC + 0.001, true)).toBe(25)
    expect(sessionMediaOriginSec(25, 25 + MEDIA_START_MAX_LEAD_SEC, true)).toBe(25 + MEDIA_START_MAX_LEAD_SEC)
    expect(sessionMediaOriginSec(3600, 3600 - MEDIA_START_MAX_LAG_SEC - 1, true)).toBe(3600)
    expect(sessionMediaOriginSec(25, -0.5, true)).toBe(25)
    expect(sessionMediaOriginSec(25, Number.NaN, true)).toBe(25)
  })
})

describe('mediaStartAlignmentSec', () => {
  it('starts playback at start_sec when the produced window leaves runway after it', () => {
    // Two 10 s segments published, the next reload ~10 s away: 5.05 + 10 <= 20.
    expect(mediaStartAlignmentSec(25, 19.946009, 20, 10)).toBeCloseTo(5.053991, 9)
    // A finished playlist needs no reload, only the edge margin.
    expect(mediaStartAlignmentSec(25, 19.946009, 10, 0)).toBeCloseTo(5.053991, 9)
  })
  it('does not trade the skipped seconds for a stall', () => {
    // Only the first segment published: hls.js would play 4.9 s, then wait
    // ~5 s for its next reload to list segment 1. Start at the key frame.
    expect(mediaStartAlignmentSec(25, 19.946009, 10, 10)).toBe(0)
    // Matroska key-frame case: the gap is the whole first segment.
    expect(mediaStartAlignmentSec(40, 29.952993, 20, 10)).toBe(0)
    expect(mediaStartAlignmentSec(40, 29.952993, 30, 10)).toBeCloseTo(10.047007, 9)
    // Never at or past the edge, even on a finished playlist.
    expect(mediaStartAlignmentSec(25, 19.946009, 5.053991 + MEDIA_START_ALIGN_EDGE_SEC - 0.001, 0)).toBe(0)
    // An unknown runway is not a free pass.
    expect(mediaStartAlignmentSec(25, 19.946009, 1000, Number.NaN)).toBe(0)
  })
  it('does not seek for nothing', () => {
    expect(mediaStartAlignmentSec(25, 25, 20, 10)).toBe(0)
    expect(mediaStartAlignmentSec(25, 24.99, 20, 10)).toBe(0)
    expect(mediaStartAlignmentSec(25, 19.9, 0, 0)).toBe(0)
    expect(mediaStartAlignmentSec(25, 26, 20, 10)).toBe(0)
  })
})
