// Aurora V2 — browser playback capability reporting.
//
// The Go playback-decision engine already accepts a compact comma-separated
// `caps` query parameter (see internal/streaming.ParseClientCaps). The React
// redesign previously omitted it entirely, which forced HEVC and other
// browser-specific decisions through the conservative static fallback path.
//
// Keep this v1 probe intentionally conservative and synchronous:
//   - Only emit keys the current backend understands.
//   - The current backend uses one video-codec flag for both original-file
//     direct play and HLS remux decisions. Because V2 prefers hls.js where
//     available, an hls.js client must confirm BOTH native and MediaSource
//     support before a video codec is advertised. Native-HLS-only clients may
//     rely on native playback support alone.
//   - AAC and AC-3 can be copied on today's HLS-TS remux path; on an hls.js
//     client they are reported only when both native and MediaSource support
//     are confirmed. Audio formats that the backend never copies into HLS-TS
//     remain native-only direct-play signals.
//
// A future capability-contract v2 can separately report native playback,
// MediaSource support, and MediaCapabilities.decodingInfo() results against
// exact source metadata (resolution, bitrate, HDR, profile).

import Hls from 'hls.js'

function canPlay(element: HTMLMediaElement, mime: string): boolean {
  return element.canPlayType(mime) !== ''
}

function nativeSupportsAny(element: HTMLMediaElement, mimes: string[]): boolean {
  return mimes.some((mime) => canPlay(element, mime))
}

function mediaSourceSupportsAny(mimes: string[]): boolean {
  return typeof MediaSource !== 'undefined' && mimes.some((mime) => MediaSource.isTypeSupported(mime))
}

function safeForCurrentDelivery(element: HTMLMediaElement, mimes: string[], usesHlsJS: boolean): boolean {
  if (!nativeSupportsAny(element, mimes)) return false
  return !usesHlsJS || mediaSourceSupportsAny(mimes)
}

/**
 * Returns capability keys understood by internal/streaming.ParseClientCaps.
 * An empty string means the server should use its existing static fallback.
 */
export function detectCapabilities(): string {
  if (typeof document === 'undefined') return ''

  const video = document.createElement('video')
  const audio = document.createElement('audio')
  const caps = new Set<string>()
  const usesHlsJS = Hls.isSupported()

  // Delivery capabilities. The player prefers hls.js whenever it can attach;
  // native HLS remains relevant on Safari/iOS and cast/AirPlay-style paths.
  if (usesHlsJS) caps.add('hls_js')
  if (canPlay(video, 'application/vnd.apple.mpegurl') || canPlay(video, 'application/x-mpegURL')) {
    caps.add('hls_native')
  }

  // Native container support. These are advertised with representative
  // browser-playable codecs rather than on extension alone.
  const mp4H264 = [
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    'video/mp4; codecs="avc1.42E01E"',
  ]
  const webmVP9 = [
    'video/webm; codecs="vp09.00.10.08, opus"',
    'video/webm; codecs="vp9, opus"',
    'video/webm; codecs="vp8, vorbis"',
  ]
  if (nativeSupportsAny(video, mp4H264)) caps.add('mp4_container')
  if (nativeSupportsAny(video, webmVP9)) caps.add('webm_container')

  // Video codec support. With today's single-capability contract, hls.js
  // clients must support both direct-file playback and MSE delivery.
  if (safeForCurrentDelivery(video, mp4H264, usesHlsJS)) caps.add('h264')
  if (safeForCurrentDelivery(video, [
    'video/mp4; codecs="hvc1.1.6.L93.B0"',
    'video/mp4; codecs="hev1.1.6.L93.B0"',
    'video/mp4; codecs="hvc1"',
    'video/mp4; codecs="hev1"',
  ], usesHlsJS)) {
    caps.add('h265')
  }
  if (safeForCurrentDelivery(video, [
    'video/webm; codecs="vp9"',
    'video/webm; codecs="vp09.00.10.08"',
  ], usesHlsJS)) caps.add('vp9')
  if (safeForCurrentDelivery(video, ['video/webm; codecs="vp8"'], usesHlsJS)) caps.add('vp8')
  if (safeForCurrentDelivery(video, [
    'video/mp4; codecs="av01.0.05M.08"',
    'video/webm; codecs="av01.0.05M.08"',
  ], usesHlsJS)) caps.add('av1')

  // AAC and AC-3 may be copied by the backend on current HLS-TS paths, so
  // hls.js clients must also confirm that MediaSource can accept them.
  const aac = ['audio/mp4; codecs="mp4a.40.2"', 'audio/aac']
  const ac3 = ['audio/mp4; codecs="ac-3"', 'audio/mp4; codecs="ac3"']
  if (safeForCurrentDelivery(audio, aac, usesHlsJS)) caps.add('aac')
  if (safeForCurrentDelivery(audio, ac3, usesHlsJS)) caps.add('ac3')

  // These formats remain useful as native direct-play signals. The current
  // HLS.js remux policy either recodes them or excludes them from passthrough.
  if (nativeSupportsAny(audio, ['audio/mpeg'])) caps.add('mp3')
  if (nativeSupportsAny(audio, [
    'audio/webm; codecs="opus"',
    'audio/ogg; codecs="opus"',
  ])) caps.add('opus')
  if (nativeSupportsAny(audio, ['audio/webm; codecs="vorbis"', 'audio/ogg; codecs="vorbis"'])) caps.add('vorbis')
  if (nativeSupportsAny(audio, ['audio/flac', 'audio/x-flac'])) caps.add('flac')
  if (nativeSupportsAny(audio, [
    'audio/mp4; codecs="ec-3"',
    'audio/mp4; codecs="eac3"',
  ])) caps.add('eac3')

  return Array.from(caps).join(',')
}
