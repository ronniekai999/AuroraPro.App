import { describe, expect, it } from 'vitest'
import type { SkipMarker } from './api'
import {
  activeAudioIndex,
  audioNote,
  doubleTapDelta,
  formatDeliveryLine,
  isDeliveryStatus,
  nextPlaybackDetails,
  pipAvailable,
  speedLabel,
  speedLock,
  speedLockMessage,
  statusNotice,
  timelineRanges,
  trackLabel,
  timelineTopPx,
  nextTap,
  menuKeyTarget,
  noticeNeedsAction,
  SESSION_ENDED_NOTICE,
  DOUBLE_TAP_MS,
} from './playerChrome'

const marker = (kind: SkipMarker['kind'], start_ms: number, end_ms: number): SkipMarker =>
  ({ kind, start_ms, end_ms } as SkipMarker)

describe('the status string: delivery line vs notice', () => {
  it('recognises the three delivery lines the player writes', () => {
    expect(isDeliveryStatus('Direct Play · h264 / aac')).toBe(true)
    expect(isDeliveryStatus('Remux · mkv')).toBe(true)
    expect(isDeliveryStatus('Transcode · hevc')).toBe(true)
  })
  it('treats everything else as a notice the viewer should see', () => {
    for (const s of ['Loading…', 'Syncing to party…', 'Only the party host can seek', 'Reconnecting…']) {
      expect(isDeliveryStatus(s)).toBe(false)
      expect(statusNotice(s)).toBe(s)
    }
  })
  it('never shows a delivery line as a notice', () => {
    expect(statusNotice('Direct Play · h264 / aac')).toBeNull()
    expect(statusNotice('')).toBeNull()
  })
  it('formats codecs the way a person reads them and drops an empty side', () => {
    expect(formatDeliveryLine('Direct Play · h264 / aac')).toBe('Direct play · H.264 / AAC')
    expect(formatDeliveryLine('Transcode · hevc')).toBe('Transcode · HEVC')
    expect(formatDeliveryLine('Direct Play ·  / ')).toBe('Direct play')
    expect(formatDeliveryLine('Remux · weird')).toBe('Remux · WEIRD')
  })
  it('keeps the delivery line through a notice, replaces it on a new one, and drops it for a new boot', () => {
    let d = nextPlaybackDetails(null, 'Loading…')
    expect(d).toBeNull()
    d = nextPlaybackDetails(d, 'Direct Play · h264 / aac')
    expect(d).toBe('Direct play · H.264 / AAC')
    d = nextPlaybackDetails(d, 'Syncing to party…')
    expect(d).toBe('Direct play · H.264 / AAC')
    d = nextPlaybackDetails(d, 'Transcode · hevc')
    expect(d).toBe('Transcode · HEVC')
    // A new title is booting: the previous title's delivery must not be shown for it.
    expect(nextPlaybackDetails(d, 'Loading…')).toBeNull()
  })
})

describe('timelineRanges', () => {
  it('places each marker as a share of the runtime, in order', () => {
    const r = timelineRanges([marker('credits', 900_000, 1_000_000), marker('intro', 50_000, 100_000)], 1000)
    expect(r.map(x => x.kind)).toEqual(['intro', 'credits'])
    expect(r[0]).toMatchObject({ label: 'Intro', leftPct: 5, widthPct: 5 })
    expect(r[1]).toMatchObject({ label: 'Credits', leftPct: 90, widthPct: 10 })
  })
  it('draws nothing for a suppressed, inverted or out-of-range marker', () => {
    expect(timelineRanges([marker('intro', 0, 0)], 1000)).toEqual([])
    expect(timelineRanges([marker('intro', 200_000, 100_000)], 1000)).toEqual([])
    expect(timelineRanges([marker('credits', 2_000_000, 2_100_000)], 1000)).toEqual([])
  })
  it('draws nothing until the duration is known', () => {
    expect(timelineRanges([marker('intro', 1000, 5000)], 0)).toEqual([])
  })
  it('clips a marker that runs past the end', () => {
    const [r] = timelineRanges([marker('credits', 900_000, 1_500_000)], 1000)
    expect(r.leftPct).toBe(90)
    expect(r.widthPct).toBe(10)
  })
  it('names only the first of two ranges that start too close together', () => {
    const r = timelineRanges([marker('recap', 0, 30_000), marker('intro', 34_000, 80_000), marker('credits', 930_000, 1_000_000)], 1000)
    expect(r.map(x => x.showLabel)).toEqual([true, false, true])
  })
})

describe('speed', () => {
  it('labels rates without trailing zeros', () => {
    expect(speedLabel(1)).toBe('1x')
    expect(speedLabel(1.5)).toBe('1.5x')
    expect(speedLabel(0.75)).toBe('0.75x')
    expect(speedLabel(2)).toBe('2x')
  })
  it('is locked in any party, whatever else is true', () => {
    expect(speedLock(true, false)).toBe('party')
    expect(speedLock(true, true)).toBe('party')
  })
  it('is locked on a remote surface and free otherwise', () => {
    expect(speedLock(false, true)).toBe('remote')
    expect(speedLock(false, false)).toBeNull()
  })
  it('says why in words', () => {
    expect(speedLockMessage('party')).toBe('Playback speed is locked to the party')
    expect(speedLockMessage('remote')).toMatch(/another screen/)
    expect(speedLockMessage(null)).toBeNull()
  })
})

describe('pipAvailable', () => {
  const video = { requestPictureInPicture: () => {} }
  it('needs the document to allow it and the element to offer it', () => {
    expect(pipAvailable({ pictureInPictureEnabled: true }, video, false)).toBe(true)
    expect(pipAvailable({ pictureInPictureEnabled: false }, video, false)).toBe(false)
    expect(pipAvailable({ pictureInPictureEnabled: true }, {}, false)).toBe(false)
    expect(pipAvailable({ pictureInPictureEnabled: true }, { ...video, disablePictureInPicture: true }, false)).toBe(false)
    expect(pipAvailable(null, video, false)).toBe(false)
    expect(pipAvailable({ pictureInPictureEnabled: true }, null, false)).toBe(false)
  })
  it('is never offered while playback is on another screen', () => {
    expect(pipAvailable({ pictureInPictureEnabled: true }, video, true)).toBe(false)
  })
})

describe('doubleTapDelta', () => {
  const rect = { left: 100, width: 400 }
  it('goes back on the left half and forward on the right', () => {
    expect(doubleTapDelta(120, rect)).toBe(-10)
    expect(doubleTapDelta(299, rect)).toBe(-10)
    expect(doubleTapDelta(300, rect)).toBe(10)
    expect(doubleTapDelta(480, rect)).toBe(10)
  })
  it('does nothing against a surface with no width', () => {
    expect(doubleTapDelta(10, { left: 0, width: 0 })).toBeNull()
  })
})

describe('track names', () => {
  it('prefers the title, then the language name, then a numbered fallback', () => {
    expect(trackLabel({ index: 2, title: 'Commentary', language: 'eng' }, 'Track')).toBe('Commentary')
    expect(trackLabel({ index: 2, language: 'eng' }, 'Track')).toBe('English')
    expect(trackLabel({ index: 2, language: 'und' }, 'Track')).toBe('Track 2')
    expect(trackLabel({ index: 5 }, 'Subtitle')).toBe('Subtitle 5')
  })
  it('describes an audio track by codec and layout', () => {
    expect(audioNote('eac3', 6)).toBe('Dolby Digital Plus 5.1')
    expect(audioNote('aac', 2)).toBe('AAC stereo')
    expect(audioNote(undefined, undefined)).toBe('')
  })
})

describe('activeAudioIndex', () => {
  const tracks = [{ index: 3 }, { index: 5 }, { index: 7 }]
  it('is the viewer\'s pick when they made one', () => {
    expect(activeAudioIndex(tracks, 5, 0)).toBe(5)
  })
  it('ignores a pick that is not one of this file\'s tracks', () => {
    expect(activeAudioIndex(tracks, 99, 2)).toBe(7)
  })
  it('reads the stream decision as a position in the list, not as a track index', () => {
    expect(activeAudioIndex(tracks, undefined, 1)).toBe(5)
  })
  it('falls back to the file\'s own default: the first flagged track, else the first', () => {
    expect(activeAudioIndex(tracks, undefined, -1)).toBe(3)
    expect(activeAudioIndex(tracks, undefined, undefined)).toBe(3)
    expect(activeAudioIndex([{ index: 3 }, { index: 5, is_default: true }, { index: 7, is_default: true }], undefined, -1)).toBe(5)
    expect(activeAudioIndex([{ index: 3 }, { index: 5, default: true }], undefined, 9)).toBe(5)
  })
  it('marks nothing when there are no tracks', () => {
    expect(activeAudioIndex([], 1, 1)).toBeUndefined()
  })
})

describe('timelineTopPx', () => {
  it('is the band height less the timeline offset inside it', () => {
    expect(timelineTopPx(184, 56)).toBe(128)
    expect(timelineTopPx(233.6, 63.2)).toBe(170)
  })
  it('is null, never 0, while the band has no layout', () => {
    expect(timelineTopPx(0, 0)).toBeNull()
    expect(timelineTopPx(184, 184)).toBeNull()
    expect(timelineTopPx(184, 200)).toBeNull()
    expect(timelineTopPx(184, -1)).toBeNull()
    expect(timelineTopPx(Number.NaN, 56)).toBeNull()
  })
})

describe('nextTap', () => {
  it('holds a first tap and seeks on a second inside the window', () => {
    const first = nextTap(null, 1000)
    expect(first.action).toBe('hold')
    const second = nextTap(first.state, 1000 + DOUBLE_TAP_MS)
    expect(second.action).toBe('seek')
  })
  it('keeps seeking on every further tap inside the window, and starts over after it', () => {
    let t = 1000
    let step = nextTap(nextTap(null, t).state, t += 100)
    for (let i = 0; i < 3; i++) {
      step = nextTap(step.state, t += 100)
      expect(step.action).toBe('seek')
    }
    expect(nextTap(step.state, t + DOUBLE_TAP_MS + 1).action).toBe('hold')
  })
})

describe('menuKeyTarget', () => {
  it('moves down and up through the items and wraps at the ends', () => {
    expect(menuKeyTarget('ArrowDown', 0, 3)).toBe(1)
    expect(menuKeyTarget('ArrowDown', 2, 3)).toBe(0)
    expect(menuKeyTarget('ArrowUp', 0, 3)).toBe(2)
    expect(menuKeyTarget('ArrowUp', 2, 3)).toBe(1)
  })
  it('enters from outside the list at the nearest end', () => {
    expect(menuKeyTarget('ArrowDown', -1, 3)).toBe(0)
    expect(menuKeyTarget('ArrowUp', -1, 3)).toBe(2)
  })
  it('jumps with Home and End, and ignores every other key and an empty menu', () => {
    expect(menuKeyTarget('Home', 2, 3)).toBe(0)
    expect(menuKeyTarget('End', 0, 3)).toBe(2)
    expect(menuKeyTarget('a', 0, 3)).toBeNull()
    expect(menuKeyTarget('ArrowDown', 0, 0)).toBeNull()
  })
})

describe('noticeNeedsAction', () => {
  it('is true for the notices the player sets from the named constants, and for nothing else', () => {
    expect(noticeNeedsAction(SESSION_ENDED_NOTICE)).toBe(true)
    expect(noticeNeedsAction('Reconnecting…')).toBe(false)
    expect(noticeNeedsAction('please reload to resume')).toBe(false)
    expect(noticeNeedsAction('')).toBe(false)
  })
})
