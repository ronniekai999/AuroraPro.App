// @vitest-environment jsdom
// L4: the media-start comment through the INSTALLED hls.js playlist parser,
// not a hand-built tagList. package.json allows ^1.6.17, so a minor upgrade
// that stops surfacing comment lines (or files them elsewhere) fails here
// before it silently returns every remuxing viewer to the start_sec clock.
//
// The playlists are what ServeVariantPlaylist served for real FFmpeg remux
// output (internal/streaming/media_start_test.go pins that shape server-side:
// the line directly before the first #EXTINF).
import { describe, expect, it } from 'vitest'
import { M3U8Parser } from 'hls.js'
import { MEDIA_START_TAG, levelMediaWindow, reportedMediaStartSec } from './mediaStart'

// PlaylistLevelType.MAIN; the enum is `const` in hls.js's typings, which
// verbatimModuleSyntax cannot read.
const MAIN = 'main' as Parameters<typeof M3U8Parser.parseLevelPlaylist>[3]

const BASE = 'http://aurora.test/api/stream/hls/sess/source/stream.m3u8'

const FMP4_SERVED = [
  '#EXTM3U',
  '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:EVENT',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-MAP:URI="init.mp4"',
  '#AURORA-MEDIA-START:19.946009',
  '#EXTINF:10.000000,',
  'seg_00000.m4s',
  '#EXTINF:10.000000,',
  'seg_00001.m4s',
  '',
].join('\n')

const TS_SERVED = [
  '#EXTM3U',
  '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES',
  '#EXT-X-VERSION:6',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:EVENT',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#AURORA-MEDIA-START:19.946000',
  '#EXTINF:10.000000,',
  'seg_00000.ts',
  '',
].join('\n')

function parse(text: string) {
  return M3U8Parser.parseLevelPlaylist(text, BASE, 0, MAIN, 0, null)
}

describe('the media-start comment through the installed hls.js parser', () => {
  it('lands on the first media fragment of an fMP4 playlist', () => {
    const details = parse(FMP4_SERVED)
    expect(details.fragments).toHaveLength(2)
    expect(details.fragments[0].tagList).toContainEqual([MEDIA_START_TAG, '19.946009'])
    expect(reportedMediaStartSec(details.fragments)).toBe(19.946009)
    expect(levelMediaWindow(details)).toEqual({ reportedSec: 19.946009, producedEndSec: 20, runwaySec: 10 })
  })

  it('lands on the first media fragment of a TS playlist', () => {
    const details = parse(TS_SERVED)
    expect(details.fragments[0].tagList).toContainEqual([MEDIA_START_TAG, '19.946000'])
    expect(reportedMediaStartSec(details.fragments)).toBe(19.946)
  })

  it('would land on the fMP4 init segment from the header, which the reader also accepts', () => {
    // Why the server writes it before the first #EXTINF: from the header,
    // hls.js files it on the #EXT-X-MAP fragment.
    const header = FMP4_SERVED
      .replace('#AURORA-MEDIA-START:19.946009\n', '')
      .replace('#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n', '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n#AURORA-MEDIA-START:19.946009\n')
    const details = parse(header)
    expect(details.fragments[0].tagList).not.toContainEqual([MEDIA_START_TAG, '19.946009'])
    expect(details.fragments[0].initSegment?.tagList).toContainEqual([MEDIA_START_TAG, '19.946009'])
    expect(reportedMediaStartSec(details.fragments)).toBe(19.946009)
  })

  it('reports nothing for a playlist without the line', () => {
    const details = parse(TS_SERVED.replace('#AURORA-MEDIA-START:19.946000\n', ''))
    expect(reportedMediaStartSec(details.fragments)).toBeNull()
  })

  it('reads a finished playlist as needing no reload runway', () => {
    const details = parse(TS_SERVED + '#EXT-X-ENDLIST\n')
    expect(details.live).toBe(false)
    expect(levelMediaWindow(details).runwaySec).toBe(0)
  })
})
