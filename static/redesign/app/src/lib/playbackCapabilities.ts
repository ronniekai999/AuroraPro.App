// Aurora V2 — browser playback capability reporting.
//
// The Go playback-decision engine already accepts a compact comma-separated
// `caps` query parameter (see internal/streaming.ParseClientCaps). The React
// redesign previously omitted it entirely, which forced HEVC and other
// browser-specific decisions through the conservative static fallback path.
//
// Keep this v1 probe intentionally conservative and synchronous:
//   - Only emit keys the current backend understands.
//   - H.264 and HEVC may enter today's HLS copy/remux path. Because V2 prefers
//     hls.js where available, an hls.js client must confirm BOTH native and
//     MediaSource support before either codec is advertised.
//   - VP8, VP9, AV1, Opus, Vorbis, and FLAC are native direct-play signals on
//     today's transport. They are not advertised for native-HLS-only clients,
//     where a fallback remux could otherwise package them into MPEG-TS.
//   - AAC and AC-3 can be copied on today's HLS-TS remux path; on an hls.js
//     client they are reported only when native and MediaSource support agree.
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
  const hasNativeHLS = canPlay(video, 'application/vnd.apple.mpegurl') || canPlay(video, 'application/x-mpegURL')
  const canAdvertiseNativeOnlySignals = usesHlsJS || !hasNativeHLS

  // Delivery capabilities. The player prefers hls.js whenever it can attach;
  // native HLS remains relevant on Safari/iOS and cast/AirPlay-style paths.
  if (usesHlsJS) caps.add('hls_js')
  if (hasNativeHLS) caps.add('hls_native')

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

  // These video codecs can be copied into the current HLS transport. On an
  // hls.js client, require support for both direct-file playback and MSE.
  if (safeForCurrentDelivery(video, mp4H264, usesHlsJS)) caps.add('h264')
  if (safeForCurrentDelivery(video, [
    'video/mp4; codecs="hvc1.1.6.L93.B0"',
    'video/mp4; codecs="hev1.1.6.L93.B0"',
    'video/mp4; codecs="hvc1"',
    'video/mp4; codecs="hev1"',
  ], usesHlsJS)) {
    caps.add('h265')
  }

  // The current backend refuses these codecs on hls.js TS-remux paths. Do
  // not emit them on native-HLS-only clients until the backend contract can
  // prevent a native-HLS remux fallback from incorrectly copying them to TS.
  if (canAdvertiseNativeOnlySignals && nativeSupportsAny(video, [
    'video/webm; codecs="vp9"',
    'video/webm; codecs="vp09.00.10.08"',
  ])) caps.add('vp9')
  if (canAdvertiseNativeOnlySignals && nativeSupportsAny(video, ['video/webm; codecs="vp8"'])) caps.add('vp8')
  if (canAdvertiseNativeOnlySignals && nativeSupportsAny(video, [
    'video/mp4; codecs="av01.0.05M.08"',
    'video/webm; codecs="av01.0.05M.08"',
  ])) caps.add('av1')

  // AAC and AC-3 may be copied by the backend on current HLS-TS paths, so
  // hls.js clients must also confirm that MediaSource can accept them.
  const aac = ['audio/mp4; codecs="mp4a.40.2"', 'audio/aac']
  const ac3 = ['audio/mp4; codecs="ac-3"', 'audio/mp4; codecs="ac3"']
  if (safeForCurrentDelivery(audio, aac, usesHlsJS)) caps.add('aac')
  if (safeForCurrentDelivery(audio, ac3, usesHlsJS)) caps.add('ac3')

  // MP3 is forced to AAC if it reaches remux, so it remains safe to report.
  if (nativeSupportsAny(audio, ['audio/mpeg'])) caps.add('mp3')

  // These remain native direct-play signals and are withheld on native-HLS-
  // only clients for the same MPEG-TS fallback reason as VP8/VP9/AV1 above.
  if (canAdvertiseNativeOnlySignals && nativeSupportsAny(audio, [
    'audio/webm; codecs="opus"',
    'audio/ogg; codecs="opus"',
  ])) caps.add('opus')
  if (canAdvertiseNativeOnlySignals && nativeSupportsAny(audio, [
    'audio/webm; codecs="vorbis"',
    'audio/ogg; codecs="vorbis"',
  ])) caps.add('vorbis')
  if (canAdvertiseNativeOnlySignals && nativeSupportsAny(audio, ['audio/flac', 'audio/x-flac'])) caps.add('flac')

  // Native HLS clients such as Safari support E-AC-3 in the existing path;
  // hls.js clients will already recode E-AC-3 in the backend's HLS caps filter.
  if (nativeSupportsAny(audio, [
    'audio/mp4; codecs="ec-3"',
    'audio/mp4; codecs="eac3"',
  ])) caps.add('eac3')

  return Array.from(caps).join(',')
}
