// Pure decisions behind the player's chrome, kept out of VideoPlayer so each
// can be tested without booting a stream. Nothing here touches delivery,
// casting or party sync: these only decide what the viewer is shown and which
// controls are offered.

import type { SkipMarker } from './api'

/** The player's one status string carries two different things: a description
 *  of the delivery ("Direct Play · h264 / aac") and transient notices
 *  ("Syncing to party…"). The delivery line belongs in Playback details; a
 *  notice belongs under the title where the viewer will see it. */
const DELIVERY_STATUS = /^(Direct Play|Remux|Transcode) · /

export function isDeliveryStatus(status: string): boolean {
  return DELIVERY_STATUS.test(status)
}

/** What to show under the title: the status when it is a notice, else nothing. */
export function statusNotice(status: string): string | null {
  const s = status.trim()
  if (!s || isDeliveryStatus(s)) return null
  return s
}

/** The delivery line to keep for Playback details. A new delivery line
 *  replaces the old one; "Loading…" means a new boot whose delivery is not
 *  known yet, so the previous title's line must not be shown for it; any other
 *  notice leaves the line as it was (a "Syncing to party…" notice does not
 *  change how the stream is delivered). */
export function nextPlaybackDetails(prev: string | null, status: string): string | null {
  const s = status.trim()
  if (isDeliveryStatus(s)) return formatDeliveryLine(s)
  if (s === 'Loading…') return null
  return prev
}

/** "Direct Play · h264 / aac" → "Direct play · H.264 / AAC". Unknown codec
 *  names pass through upper-cased; an empty side is dropped. */
export function formatDeliveryLine(status: string): string {
  const [mode, rest = ''] = status.split(' · ')
  const label = mode === 'Direct Play' ? 'Direct play' : mode
  const parts = rest.split('/').map(p => codecLabel(p.trim())).filter(Boolean)
  return parts.length ? `${label} · ${parts.join(' / ')}` : label
}

const CODEC_LABELS: Record<string, string> = {
  h264: 'H.264', avc: 'H.264', hevc: 'HEVC', h265: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8',
  aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', truehd: 'TrueHD', dts: 'DTS',
  flac: 'FLAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', hls: 'HLS', mp4: 'MP4', mkv: 'MKV',
}
function codecLabel(raw: string): string {
  if (!raw) return ''
  return CODEC_LABELS[raw.toLowerCase()] ?? raw.toUpperCase()
}

export type TimelineRangeKind = SkipMarker['kind']

export interface TimelineRange {
  kind: TimelineRangeKind
  label: string
  /** 0..100, the range's start along the timeline. */
  leftPct: number
  /** 0..100, never wider than what is left of the timeline. */
  widthPct: number
  /** False when the label would sit on top of the previous one. */
  showLabel: boolean
}

const RANGE_LABEL: Record<TimelineRangeKind, string> = {
  recap: 'Recap', intro: 'Intro', credits: 'Credits',
}
// A label needs about this share of the bar to itself; two that start closer
// together than this overlap at phone widths, so only the first is written.
const LABEL_MIN_GAP_PCT = 9

/** The marker ranges to draw on the timeline, in source order. Zero-length
 *  and inverted markers (an admin's "Off" is stored as 0→0) and markers
 *  outside the runtime draw nothing. */
export function timelineRanges(markers: readonly SkipMarker[], durationSec: number): TimelineRange[] {
  if (!(durationSec > 0)) return []
  const durMs = durationSec * 1000
  const out: TimelineRange[] = []
  const sorted = [...markers]
    .filter(m => m.end_ms > m.start_ms && m.start_ms < durMs && m.end_ms > 0)
    .sort((a, b) => a.start_ms - b.start_ms)
  let lastLabelAt = -Infinity
  for (const m of sorted) {
    const start = Math.max(0, m.start_ms)
    const end = Math.min(durMs, m.end_ms)
    const leftPct = (start / durMs) * 100
    const widthPct = ((end - start) / durMs) * 100
    if (!(widthPct > 0)) continue
    const showLabel = leftPct - lastLabelAt >= LABEL_MIN_GAP_PCT
    if (showLabel) lastLabelAt = leftPct
    out.push({ kind: m.kind, label: RANGE_LABEL[m.kind] ?? m.kind, leftPct, widthPct, showLabel })
  }
  return out
}

export const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

export function speedLabel(rate: number): string {
  return `${Number.isInteger(rate) ? rate : String(rate).replace(/0+$/, '')}x`
}

export type SpeedLock = 'party' | 'remote' | null

/** Why the speed control is locked, or null when the viewer may change it.
 *
 *  A watch party owns `playbackRate`: the drift loop nudges it up or down to
 *  pull a guest back to the host's clock, so a viewer-chosen rate would be
 *  overwritten every tick and, worse, read by that loop as drift. It is locked
 *  for ANY party membership, not only while the party controls this media,
 *  because the room can start controlling it at any moment.
 *
 *  On a remote surface the local element is not what plays (Chromecast) or is
 *  being mirrored by the OS (AirPlay), so a local rate would be a lie or an
 *  untested interaction. */
export function speedLock(inParty: boolean, remoteActive: boolean): SpeedLock {
  if (inParty) return 'party'
  if (remoteActive) return 'remote'
  return null
}

export function speedLockMessage(lock: SpeedLock): string | null {
  if (lock === 'party') return 'Playback speed is locked to the party'
  if (lock === 'remote') return 'Playback speed is not available on another screen'
  return null
}

/** The longer explanation, shown when a viewer presses the locked control. */
export function speedLockExplanation(lock: SpeedLock): string | null {
  if (lock === 'party') {
    return 'Everyone in a watch party plays at the same speed, so the party keeps you in step. Leave the party to change it.'
  }
  if (lock === 'remote') {
    return 'This is playing on another screen, which plays at normal speed. Stop casting to change it here.'
  }
  return null
}

/** The session is gone and the player cannot rebuild it by itself. */
export const SESSION_ENDED_NOTICE = 'Playback session ended — reload to resume'

// The notices the viewer has to act on, by identity: the player sets its
// status FROM these constants, so rewording one cannot silently stop it being
// kept on screen.
const ACTION_NOTICES: ReadonlySet<string> = new Set([SESSION_ENDED_NOTICE])

/** A notice the viewer has to act on. It must stay on screen while it holds,
 *  whether or not the controls are showing: the bars fade away during
 *  playback, and a dead session looks exactly like a paused picture. */
export function noticeNeedsAction(status: string): boolean {
  return ACTION_NOTICES.has(status)
}

/** What the next tap on the picture means, given the taps before it.
 *
 *  A first tap is held for one double-tap window: it becomes a single tap
 *  (toggle playback) only if nothing follows. A second tap inside the window
 *  makes a double tap, which seeks. From then on every further tap inside the
 *  window is another seek, so three or four quick taps skip twenty or thirty
 *  seconds; they never fall back to a single tap and pause. */
export type TapState = { lastAt: number; seeking: boolean } | null
export function nextTap(state: TapState, now: number): { action: 'hold' | 'seek'; state: TapState } {
  if (state !== null && now - state.lastAt <= DOUBLE_TAP_MS) {
    return { action: 'seek', state: { lastAt: now, seeking: true } }
  }
  return { action: 'hold', state: { lastAt: now, seeking: false } }
}

/** The item a menu key moves focus to, or null when the key is not one a
 *  menu handles. Arrows wrap; Home and End jump to the ends. */
export function menuKeyTarget(key: string, current: number, length: number): number | null {
  if (length === 0) return null
  switch (key) {
    case 'ArrowDown': return current < 0 ? 0 : (current + 1) % length
    case 'ArrowUp': return current < 0 ? length - 1 : (current - 1 + length) % length
    case 'Home': return 0
    case 'End': return length - 1
    default: return null
  }
}

/** Picture-in-picture is offered only where the browser can do it for this
 *  element and playback is on this device. While casting the local element is
 *  held paused, so a PiP window would show a frozen frame. */
export function pipAvailable(
  doc: Pick<Document, 'pictureInPictureEnabled'> | null | undefined,
  video: { requestPictureInPicture?: unknown; disablePictureInPicture?: boolean } | null | undefined,
  remoteActive: boolean,
): boolean {
  if (remoteActive) return false
  if (!doc || !video) return false
  if (!doc.pictureInPictureEnabled) return false
  if (video.disablePictureInPicture) return false
  return typeof video.requestPictureInPicture === 'function'
}

/** Which way a double tap seeks: the left half goes back, the right half
 *  forward. Null when the surface has no width to judge against. */
export function doubleTapDelta(clientX: number, rect: { left: number; width: number }): -10 | 10 | null {
  if (!(rect.width > 0)) return null
  return clientX - rect.left < rect.width / 2 ? -10 : 10
}

/** Two taps count as a double tap when they land this close together in time. */
export const DOUBLE_TAP_MS = 280

/** A track's name for the Audio and subtitles sheet. */
export function trackLabel(
  t: { title?: string; language?: string; index: number },
  fallback: string,
): string {
  return t.title || languageName(t.language) || `${fallback} ${t.index}`
}

function languageName(code?: string): string {
  if (!code) return ''
  const c = code.toLowerCase()
  if (c === 'und' || c === 'unk') return ''
  try {
    // Three-letter codes the scanner stores ("eng") resolve too.
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(c)
    if (name && name.toLowerCase() !== c) return name
  } catch { /* an unknown code is shown as written */ }
  return code
}

/** "eac3", 6 → "Dolby Digital Plus 5.1". */
export function audioNote(codec?: string, channels?: number): string {
  const c = codec ? codecLabel(codec) : ''
  const ch = channels ? channelLayout(channels) : ''
  return [c, ch].filter(Boolean).join(' ')
}

function channelLayout(n: number): string {
  if (n === 1) return 'mono'
  if (n === 2) return 'stereo'
  if (n === 6) return '5.1'
  if (n === 8) return '7.1'
  return `${n}ch`
}

/** The `index` of the audio track that is playing, for marking it in the
 *  sheet. The viewer's own pick wins. Without one, the session was built on
 *  the stream decision's `audio_track_index`: a POSITION in the track list,
 *  already steered by the viewer's preferred language, or -1 (or absent) for
 *  the file's own default. That default is what every player starts on by
 *  itself: the first track flagged default, or the first track when none is
 *  flagged (the server's effectiveDefaultIndex).
 *
 *  Undefined when there is nothing to mark. */
export function activeAudioIndex(
  tracks: readonly { index: number; default?: boolean; is_default?: boolean }[],
  picked: number | undefined,
  decided: number | undefined,
): number | undefined {
  if (tracks.length === 0) return undefined
  if (picked !== undefined && tracks.some(t => t.index === picked)) return picked
  if (decided !== undefined && decided >= 0 && decided < tracks.length) return tracks[decided].index
  const flagged = tracks.find(t => t.default || t.is_default)
  return (flagged ?? tracks[0]).index
}

/** Where the top of the timeline is, in px up from the bottom of the controls
 *  band: the band's height less the timeline's offset inside it. `null` while
 *  the band has no layout (not rendered, or hidden with `display: none`), so
 *  the caller falls back to the stylesheet's figure instead of publishing 0. */
export function timelineTopPx(bandHeight: number, timelineOffsetTop: number): number | null {
  if (!Number.isFinite(bandHeight) || !Number.isFinite(timelineOffsetTop)) return null
  if (bandHeight <= 0 || timelineOffsetTop < 0 || timelineOffsetTop >= bandHeight) return null
  return Math.round(bandHeight - timelineOffsetTop)
}
