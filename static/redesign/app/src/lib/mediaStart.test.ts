// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  MEDIA_START_ALIGN_EDGE_SEC,
  MEDIA_START_MAX_LAG_SEC,
  MEDIA_START_MAX_LEAD_SEC,
  MEDIA_START_PARTY_HOLD_MS,
  MEDIA_START_TAG,
  RemuxClock,
  alignmentWithRunwaySec,
  fetchNativeMediaWindow,
  firstVariantUri,
  mediaStartAlignmentSec,
  observePlayback,
  parseMediaPlaylistWindow,
  reportedMediaStartSec,
  sessionMediaOriginSec,
  subtitleCueShiftQuery,
  type MediaWindow,
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
  it('keeps the edge margin on top of the runway (L3)', () => {
    // into + runway exactly at the produced end used to pass with no margin.
    expect(mediaStartAlignmentSec(25, 20, 15, 10)).toBe(0)
    expect(mediaStartAlignmentSec(25, 20, 15 + MEDIA_START_ALIGN_EDGE_SEC, 10)).toBe(5)
    expect(mediaStartAlignmentSec(25, 20, 15 + MEDIA_START_ALIGN_EDGE_SEC - 0.001, 10)).toBe(0)
  })
  it('is the runway rule applied to start_sec - origin', () => {
    expect(alignmentWithRunwaySec(5, 15 + MEDIA_START_ALIGN_EDGE_SEC, 10)).toBe(5)
    expect(alignmentWithRunwaySec(5, 15 + MEDIA_START_ALIGN_EDGE_SEC - 0.001, 10)).toBe(0)
    expect(alignmentWithRunwaySec(0.04, 100, 0)).toBe(0)
    expect(alignmentWithRunwaySec(-1, 100, 0)).toBe(0)
  })
})

describe('plausibility window (L5)', () => {
  it('is [start_sec - 60, start_sec + 1], the same as the server', () => {
    expect(MEDIA_START_MAX_LAG_SEC).toBe(60)
    expect(sessionMediaOriginSec(3600, 3540, true)).toBe(3540)
    expect(sessionMediaOriginSec(3600, 3539.999, true)).toBe(3600)
    expect(sessionMediaOriginSec(3600, 3601, true)).toBe(3601)
    expect(sessionMediaOriginSec(3600, 3601.001, true)).toBe(3600)
  })
})

const NATIVE_FMP4 = [
  '#EXTM3U', '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10',
  '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-MAP:URI="init.mp4?token=t"',
  '#AURORA-MEDIA-START:19.946009', '#EXTINF:10.000000,', 'seg_00000.m4s?token=t', '#EXTINF:9.5,', 'seg_00001.m4s?token=t', '',
].join('\r\n')

describe('subtitleCueShiftQuery', () => {
  it('sends nothing without a start: direct play and sessions from 0', () => {
    expect(subtitleCueShiftQuery(0, false, null)).toBe('')
    expect(subtitleCueShiftQuery(0, true, 0.02)).toBe('')
    expect(subtitleCueShiftQuery(Number.NaN, true, null)).toBe('')
  })

  it('keeps a transcode on start_sec, whatever was measured', () => {
    expect(subtitleCueShiftQuery(25, false, null)).toBe('&start=25')
    expect(subtitleCueShiftQuery(25, false, 19.946009)).toBe('&start=25')
  })

  it('adds the measured start to a remux, beside the unchanged integer start', () => {
    // Echoed at the playlist line's 6 decimals.
    expect(subtitleCueShiftQuery(25, true, 19.946009)).toBe('&start=25&remux=1&media_start=19.946009')
    expect(subtitleCueShiftQuery(20, true, 9.96)).toBe('&start=20&remux=1&media_start=9.960000')
    expect(subtitleCueShiftQuery(5, true, 0)).toBe('&start=5&remux=1&media_start=0.000000')
  })

  it('leaves a remux with nothing measured (or nothing believable) to the server prediction', () => {
    expect(subtitleCueShiftQuery(25, true, null)).toBe('&start=25&remux=1')
    expect(subtitleCueShiftQuery(25, true, 25 + MEDIA_START_MAX_LEAD_SEC + 0.1)).toBe('&start=25&remux=1')
    expect(subtitleCueShiftQuery(3600, true, 3600 - MEDIA_START_MAX_LAG_SEC - 0.1)).toBe('&start=3600&remux=1')
    expect(subtitleCueShiftQuery(25, true, -0.5)).toBe('&start=25&remux=1')
    expect(subtitleCueShiftQuery(25, true, Number.NaN)).toBe('&start=25&remux=1')
  })
})

describe('parseMediaPlaylistWindow (native path)', () => {
  it('reads the start, the produced end and the reload runway of a live playlist', () => {
    expect(parseMediaPlaylistWindow(NATIVE_FMP4)).toEqual({ reportedSec: 19.946009, producedEndSec: 19.5, runwaySec: 9.5 })
  })
  it('needs no runway once the playlist is finished', () => {
    expect(parseMediaPlaylistWindow(NATIVE_FMP4 + '#EXT-X-ENDLIST\n').runwaySec).toBe(0)
  })
  it('reports no start without the line, after the first segment, or when it is not seconds', () => {
    expect(parseMediaPlaylistWindow(NATIVE_FMP4.replace('#AURORA-MEDIA-START:19.946009\r\n', '')).reportedSec).toBeNull()
    const late = NATIVE_FMP4.replace('#AURORA-MEDIA-START:19.946009\r\n', '').replace('seg_00000.m4s?token=t', 'seg_00000.m4s?token=t\r\n#AURORA-MEDIA-START:19.9')
    expect(parseMediaPlaylistWindow(late).reportedSec).toBeNull()
    expect(parseMediaPlaylistWindow(NATIVE_FMP4.replace('19.946009', 'NaN')).reportedSec).toBeNull()
  })
  it('finds the first variant of a master playlist', () => {
    expect(firstVariantUri('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=20000000\nsource/stream.m3u8\n')).toBe('source/stream.m3u8')
    expect(firstVariantUri('#EXTM3U\n')).toBeNull()
  })
})

describe('fetchNativeMediaWindow', () => {
  const response = (body: string, ok = true) => ({ ok, text: async () => body }) as Response
  it('reads the master, then its variant, relative to the master URL', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith('master.m3u8')
      ? response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nsource/stream.m3u8\n')
      : response(NATIVE_FMP4))
    const w = await fetchNativeMediaWindow('/api/stream/hls/sess/master.m3u8', undefined, fetchImpl as unknown as typeof fetch)
    expect(w?.reportedSec).toBe(19.946009)
    expect(fetchImpl.mock.calls.map(c => new URL(c[0]).pathname)).toEqual(['/api/stream/hls/sess/master.m3u8', '/api/stream/hls/sess/source/stream.m3u8'])
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ credentials: 'include' })
  })
  it.each([
    ['master refused', async () => response('', false)],
    ['variant refused', async (url: string) => url.endsWith('master.m3u8') ? response('#EXTM3U\nsource/stream.m3u8\n') : response('', false)],
    ['no variant listed', async () => response('#EXTM3U\n')],
    ['network error', async () => { throw new TypeError('Failed to fetch') }],
  ])('is null, never a throw, when the %s', async (_name, impl) => {
    await expect(fetchNativeMediaWindow('/m/master.m3u8', undefined, vi.fn(impl) as unknown as typeof fetch)).resolves.toBeNull()
  })
})

describe('RemuxClock', () => {
  const S = 25
  const O = 19.946009
  const windowOf = (reportedSec: number | null, producedEndSec: number, runwaySec = 10): MediaWindow => ({ reportedSec, producedEndSec, runwaySec })
  const owner = (currentTime = 0) => ({ currentTime, ownsPlayhead: true })

  it('adopts a plausible start before playback and aligns when there is runway', () => {
    const c = new RemuxClock(S, true)
    expect(c.noteLevel(windowOf(O, 20), owner())).toEqual({ originChanged: true, alignTo: S - O })
    expect(c.originSec).toBe(O)
    expect(c.noteLevel(windowOf(O, 30), owner(1))).toEqual({ originChanged: false, alignTo: null })
  })

  it('refuses a start that arrives after playback began, keeping start_sec (M2)', () => {
    const c = new RemuxClock(S, true)
    c.noteLevel(windowOf(null, 10), owner())
    c.notePlayed()
    expect(c.noteLevel(windowOf(O, 20), owner(9.8))).toEqual({ originChanged: false, alignTo: null })
    expect(c.originSec).toBe(S)
    expect(c.refusedLateStart).toBe(true)
    // and keeps refusing
    expect(c.noteLevel(windowOf(O, 30), owner(12)).originChanged).toBe(false)
  })

  it('never moves a transcode or an unseeked session', () => {
    expect(new RemuxClock(S, false).noteLevel(windowOf(O, 20), owner()).originChanged).toBe(false)
    expect(new RemuxClock(0, true).noteLevel(windowOf(0.02, 20), owner()).originChanged).toBe(false)
  })

  describe('measuredStartSec (the subtitle cue shift)', () => {
    it('is the adopted start', () => {
      const c = new RemuxClock(S, true)
      expect(c.measuredStartSec).toBeNull()
      c.noteLevel(windowOf(O, 20), owner())
      expect(c.measuredStartSec).toBe(O)
    })

    it('is a refused late start too: the element still begins there', () => {
      const c = new RemuxClock(S, true)
      c.noteLevel(windowOf(null, 10), owner())
      expect(c.measuredStartSec).toBeNull()
      c.notePlayed()
      c.noteLevel(windowOf(O, 20), owner(9.8))
      expect(c.originSec).toBe(S)
      expect(c.measuredStartSec).toBe(O)
    })

    it('keeps the first start a session reported', () => {
      const c = new RemuxClock(S, true)
      c.noteLevel(windowOf(O, 20), owner())
      c.noteLevel(windowOf(O - 10, 30), owner(1))
      expect(c.measuredStartSec).toBe(O)
    })

    it('is null for an implausible start, a transcode and an unseeked session', () => {
      const late = new RemuxClock(S, true)
      late.noteLevel(windowOf(S + MEDIA_START_MAX_LEAD_SEC + 0.5, 20), owner())
      expect(late.measuredStartSec).toBeNull()
      const transcode = new RemuxClock(S, false)
      transcode.noteLevel(windowOf(O, 20), owner())
      expect(transcode.measuredStartSec).toBeNull()
      const fromZero = new RemuxClock(0, true)
      fromZero.noteLevel(windowOf(0.02, 20), owner())
      expect(fromZero.measuredStartSec).toBeNull()
    })
  })

  it('retries the alignment on later loads while the playhead is short of start_sec (H1)', () => {
    const c = new RemuxClock(S, true)
    expect(c.noteLevel(windowOf(O, 10), owner()).alignTo).toBeNull() // only segment 0: no runway
    c.notePlayed()
    expect(c.noteLevel(windowOf(O, 20), owner(1.2)).alignTo).toBeCloseTo(S - O, 9)
  })

  it('stops retrying once playback reaches start_sec on its own', () => {
    const c = new RemuxClock(S, true)
    c.noteLevel(windowOf(O, 10), owner())
    c.notePlayed()
    expect(c.noteLevel(windowOf(O, 30), owner(5.2)).alignTo).toBeNull()
    expect(c.noteLevel(windowOf(O, 40), owner(0.5)).alignTo).toBeNull()
  })

  it('never aligns a party guest without a room position: the drift loop owns it', () => {
    const c = new RemuxClock(S, true)
    expect(c.noteLevel(windowOf(O, 30), { currentTime: 0, ownsPlayhead: false }).alignTo).toBeNull()
    expect(c.originSec).toBe(O)
    const unknown = new RemuxClock(S, true)
    expect(unknown.noteLevel(windowOf(O, 30), { currentTime: 0, ownsPlayhead: false, roomAbsSec: null }).alignTo).toBeNull()
  })

  describe('a party guest before it plays (L2)', () => {
    const guest = (roomAbsSec: number | null, currentTime = 0) => ({ currentTime, ownsPlayhead: false, roomAbsSec })

    it("aligns to the room's projected position, not to start_sec", () => {
      // An aligned host's room, 0.3 s on: the guest starts there, not at the
      // key frame the gap behind it, and not at start_sec 0.3 s behind it.
      const c = new RemuxClock(S, true)
      expect(c.noteLevel(windowOf(O, 20), guest(S + 0.3)).alignTo).toBeCloseTo(S + 0.3 - O, 9)
      // A host that re-anchored into the gap: the guest follows it there.
      const reanchored = new RemuxClock(S, true)
      expect(reanchored.noteLevel(windowOf(O, 20), guest(O + 0.35)).alignTo).toBeCloseTo(0.35, 9)
      // The echo of that seek is consumed like a host's alignment.
      expect(reanchored.consumeAlignmentSeeked(0.36)).toBe(true)
    })

    it('keeps the runway rule, and retries on later loads only until it plays', () => {
      const c = new RemuxClock(S, true)
      // 5.35 s into a single published 10 s segment would stall at its end.
      expect(c.noteLevel(windowOf(O, 10), guest(S + 0.3)).alignTo).toBeNull()
      expect(c.noteLevel(windowOf(O, 20), guest(S + 0.6)).alignTo).toBeCloseTo(S + 0.6 - O, 9)
      const played = new RemuxClock(S, true)
      played.noteLevel(windowOf(O, 10), guest(S + 0.3))
      played.notePlayed()
      expect(played.noteLevel(windowOf(O, 30), guest(S + 2, 1)).alignTo).toBeNull()
    })

    it('leaves a guest with no gap, no measured start, or a moved playhead alone', () => {
      expect(new RemuxClock(40, true).noteLevel(windowOf(39.98, 30), guest(41)).alignTo).toBeNull()
      expect(new RemuxClock(S, true).noteLevel(windowOf(null, 30), guest(S + 1)).alignTo).toBeNull()
      expect(new RemuxClock(S, false).noteLevel(windowOf(O, 30), guest(S + 1)).alignTo).toBeNull()
      expect(new RemuxClock(S, true).noteLevel(windowOf(O, 30), guest(S + 1, 2)).alignTo).toBeNull()
      // A room at or before the origin is the rebuild path's, not a seek's.
      expect(new RemuxClock(S, true).noteLevel(windowOf(O, 30), guest(O - 3)).alignTo).toBeNull()
      expect(new RemuxClock(S, true).noteLevel(windowOf(O, 30), guest(Number.NaN)).alignTo).toBeNull()
    })

    it('is done once a party seek was applied to it', () => {
      const c = new RemuxClock(S, true)
      c.noteLevel(windowOf(O, 10), guest(null))
      c.noteUserSeek()
      expect(c.noteLevel(windowOf(O, 30), guest(S + 1)).alignTo).toBeNull()
    })
  })

  describe('holdsPartyPosition (L1)', () => {
    const NOW = 1_000_000
    const guest0 = () => ({ currentTime: 0, ownsPlayhead: false, roomAbsSec: null })

    it('holds a position a plausible start could serve until the first level load', () => {
      const c = new RemuxClock(S, true)
      expect(c.awaitingMeasuredStart).toBe(true)
      // A host's re-anchor into the gap, start_sec itself, and past it.
      expect(c.holdsPartyPosition(O + 0.35, NOW)).toBe(true)
      expect(c.holdsPartyPosition(S, NOW)).toBe(true)
      expect(c.holdsPartyPosition(S + 30, NOW)).toBe(true)
      c.noteLevel(windowOf(O, 20), guest0())
      expect(c.awaitingMeasuredStart).toBe(false)
      expect(c.holdsPartyPosition(O + 0.35, NOW)).toBe(false)
    })

    it('stops holding when the load reports nothing, or the native fetch failed', () => {
      const none = new RemuxClock(S, true)
      none.noteLevel(windowOf(null, 20), guest0())
      expect(none.holdsPartyPosition(O + 0.35, NOW)).toBe(false)
      const failed = new RemuxClock(S, true)
      failed.noteNoMeasurement()
      expect(failed.holdsPartyPosition(O + 0.35, NOW)).toBe(false)
    })

    it('never holds before any start the clock would accept', () => {
      const c = new RemuxClock(100, true)
      expect(c.holdsPartyPosition(100 - MEDIA_START_MAX_LAG_SEC, NOW)).toBe(true)
      expect(c.holdsPartyPosition(100 - MEDIA_START_MAX_LAG_SEC - 0.001, NOW)).toBe(false)
      expect(c.holdsPartyPosition(Number.NaN, NOW)).toBe(false)
    })

    it('is bounded from the first hold', () => {
      const c = new RemuxClock(S, true)
      expect(c.holdsPartyPosition(O + 0.35, NOW)).toBe(true)
      expect(c.holdsPartyPosition(O + 0.35, NOW + MEDIA_START_PARTY_HOLD_MS - 1)).toBe(true)
      expect(c.holdsPartyPosition(O + 0.35, NOW + MEDIA_START_PARTY_HOLD_MS)).toBe(false)
      expect(c.holdsPartyPosition(S, NOW + MEDIA_START_PARTY_HOLD_MS + 250)).toBe(false)
    })

    it('never holds for a transcode or an unseeked session', () => {
      expect(new RemuxClock(S, false).holdsPartyPosition(O + 0.35, NOW)).toBe(false)
      expect(new RemuxClock(0, true).holdsPartyPosition(0.2, NOW)).toBe(false)
    })
  })

  it('never jumps a playhead a seek moved', () => {
    const before = new RemuxClock(S, true)
    expect(before.noteLevel(windowOf(O, 30), owner(3)).alignTo).toBeNull() // moved before playing
    const scrubbed = new RemuxClock(S, true)
    scrubbed.noteLevel(windowOf(O, 10), owner())
    scrubbed.notePlayed(); scrubbed.noteUserSeek()
    expect(scrubbed.noteLevel(windowOf(O, 30), owner(1)).alignTo).toBeNull()
  })

  it('consumes exactly one seeked, matched by position, for its alignment (L2)', () => {
    const c = new RemuxClock(S, true)
    const into = c.noteLevel(windowOf(O, 20), owner()).alignTo!
    expect(c.consumeAlignmentSeeked(into + 3)).toBe(false)
    expect(c.consumeAlignmentSeeked(into + 0.04)).toBe(true)
    expect(c.consumeAlignmentSeeked(into)).toBe(false)
    expect(new RemuxClock(S, true).consumeAlignmentSeeked(0)).toBe(false)
  })

  describe('hostReanchorSec', () => {
    const unaligned = () => { const c = new RemuxClock(S, true); c.noteLevel(windowOf(O, 10), owner()); c.notePlayed(); return c }
    it('returns the true position once for an unaligned host, then never, and ends retries', () => {
      const c = unaligned()
      expect(c.hostReanchorSec(0.5, S + 1.5)).toBeCloseTo(O + 0.5, 9)
      expect(c.hostReanchorSec(0.75, S + 1.75)).toBeNull()
      expect(c.noteLevel(windowOf(O, 30), owner(1)).alignTo).toBeNull()
    })
    it('falls back to the gap when the room position is unknown', () => {
      expect(unaligned().hostReanchorSec(0.5, null)).toBeCloseTo(O + 0.5, 9)
    })
    it('sends nothing when the room already agrees, and decides once', () => {
      const c = unaligned()
      expect(c.hostReanchorSec(0.5, O + 0.6)).toBeNull()
      expect(c.hostReanchorSec(0.6, S + 3)).toBeNull()
    })
    it('covers a host that reached start_sec by playing a gap late', () => {
      const c = unaligned()
      c.noteLevel(windowOf(O, 30), owner(6))
      expect(c.hostReanchorSec(6, S + 6)).toBeCloseTo(O + 6, 9)
    })
    it('is never due for an aligned host, no gap, a scrub, or no measured start', () => {
      const aligned = new RemuxClock(S, true); aligned.noteLevel(windowOf(O, 20), owner())
      expect(aligned.hostReanchorSec(0.5, S + 5)).toBeNull()
      const noGap = new RemuxClock(40, true); noGap.noteLevel(windowOf(39.98, 10), owner())
      expect(noGap.hostReanchorSec(0.5, 45)).toBeNull()
      const scrubbed = unaligned(); scrubbed.noteUserSeek()
      expect(scrubbed.hostReanchorSec(0.5, S + 5)).toBeNull()
      const provisional = new RemuxClock(S, true); provisional.notePlayed()
      expect(provisional.hostReanchorSec(0.5, S + 5)).toBeNull()
      // not decided yet: a later adoption could still need it
      provisional.noteLevel(windowOf(O, 10), owner())
      expect(provisional.refusedLateStart).toBe(true)
    })
  })
})

describe('observePlayback', () => {
  it('marks the clock played on `playing`, or the clock advancing while playing; unbinds', () => {
    const vid = document.createElement('video')
    let paused = true
    Object.defineProperty(vid, 'paused', { get: () => paused })
    const playedOn = (setup: () => void) => {
      const c = new RemuxClock(25, true)
      const unbind = observePlayback(vid, c)
      setup()
      unbind()
      // played <=> a late start is refused
      c.noteLevel({ reportedSec: 19.9, producedEndSec: 20, runwaySec: 10 }, { currentTime: 0, ownsPlayhead: true })
      return c.refusedLateStart
    }
    expect(playedOn(() => vid.dispatchEvent(new Event('playing')))).toBe(true)
    expect(playedOn(() => { vid.currentTime = 3; paused = true; vid.dispatchEvent(new Event('timeupdate')) })).toBe(false)
    expect(playedOn(() => { vid.currentTime = 3; paused = false; vid.dispatchEvent(new Event('timeupdate')) })).toBe(true)
    const c = new RemuxClock(25, true)
    observePlayback(vid, c)()
    vid.dispatchEvent(new Event('playing'))
    c.noteLevel({ reportedSec: 19.9, producedEndSec: 20, runwaySec: 10 }, { currentTime: 0, ownsPlayhead: true })
    expect(c.refusedLateStart).toBe(false)
  })
})
