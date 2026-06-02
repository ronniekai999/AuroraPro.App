// Aurora V2 — browser playback capability reporting.
//
// The Go playback-decision engine already accepts a compact comma-separated
// `caps` query parameter (see internal/streaming.ParseClientCaps). The React
// redesign previously omitted it entirely, which forced HEVC and other
// browser-specific decisions through the conservative static fallback path.
//
// Keep this v1 probe intentionally narrow and synchronous:
//   - Only report capabilities when this player will use hls.js. The current
//     backend already prevents VP8/VP9/AV1 MPEG-TS remux on HLSJS sessions,
//     but does not yet express the same distinction for native-HLS-only paths.
//     Omitting caps on native-HLS-only clients preserves the existing fallback
//     until contract v2 models direct-file support separately from remux safety.
//   - H.264, HEVC, AAC and AC-3 may enter today's HLS copy/remux path, so they
//     are reported only when native playback and MediaSource both confirm them.
//   - VP8, VP9, AV1, Opus, Vorbis, FLAC and E-AC-3 remain native direct-play
//     signals; the backend's HLSJS restrictions prevent unsafe TS passthrough.
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

function remuxSafe(element: HTMLMediaElement, mimes: string[]): boolean {
  return nativeSupportsAny(element, mimes) && mediaSourceSupportsAny(mimes)
}

/**
 * Returns capability keys understood by internal/streaming.ParseClientCaps.
 * An empty string means the server should use its existing static fallback.
 */
export function detectCapabilities(): string {
  if (typeof document === 'undefined' || !Hls.isSupported()) return ''

  const video = document.createElement('video')
  const audio = document.createElement('audio')
  const caps = new Set<string>(['hls_js'])

  // macOS Safari can expose hls.js and native HLS. HLSJS remains present so
  // the server applies its guarded hls.js policy for any non-direct path.
  if (canPlay(video, 'application/vnd.apple.mpegurl') || canPlay(video, 'application/x-mpegURL')) {
    caps.add('hls_native')
  }

  // Native container support. These are advertised with representative
  // browser-playable codecs rather than on extension alone.
  const h264 = [
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    'video/mp4; codecs="avc1.42E01E"',
  ]
  const hevc = [
    'video/mp4; codecs="hvc1.1.6.L93.B0"',
    'video/mp4; codecs="hev1.1.6.L93.B0"',
    'video/mp4; codecs="hvc1"',
    'video/mp4; codecs="hev1"',
  ]
  const vp9 = ['video/webm; codecs="vp9"', 'video/webm; codecs="vp09.00.10.08"']
  const webm = [
    'video/webm; codecs="vp09.00.10.08, opus"',
    'video/webm; codecs="vp9, opus"',
    'video/webm; codecs="vp8, vorbis"',
  ]
  const av1 = [
    'video/mp4; codecs="av01.0.05M.08"',
    'video/webm; codecs="av01.0.05M.08"',
  ]

  if (nativeSupportsAny(video, h264) || nativeSupportsAny(video, hevc) || nativeSupportsAny(video, av1)) {
    caps.add('mp4_container')
  }
  if (nativeSupportsAny(video, webm)) caps.add('webm_container')

  // These codecs can be copied into current HLS delivery, so require MSE.
  if (remuxSafe(video, h264)) caps.add('h264')
  if (remuxSafe(video, hevc)) caps.add('h265')

  // Current Go logic prevents these codecs from TS remux when HLSJS is true;
  // native direct play can therefore be advertised without MSE confirmation.
  if (nativeSupportsAny(video, vp9)) caps.add('vp9')
  if (nativeSupportsAny(video, ['video/webm; codecs="vp8"'])) caps.add('vp8')
  if (nativeSupportsAny(video, av1)) caps.add('av1')

  // AAC and AC-3 can be copied into current HLS delivery, so require MSE.
  const aac = ['audio/mp4; codecs="mp4a.40.2"', 'audio/aac']
  const ac3 = ['audio/mp4; codecs="ac-3"', 'audio/mp4; codecs="ac3"']
  if (remuxSafe(audio, aac)) caps.add('aac')
  if (remuxSafe(audio, ac3)) caps.add('ac3')

  // These are direct-play signals or force audio recode on the HLSJS path.
  if (nativeSupportsAny(audio, ['audio/mpeg'])) caps.add('mp3')
  if (nativeSupportsAny(audio, ['audio/webm; codecs="opus"', 'audio/ogg; codecs="opus"'])) caps.add('opus')
  if (nativeSupportsAny(audio, ['audio/webm; codecs="vorbis"', 'audio/ogg; codecs="vorbis"'])) caps.add('vorbis')
  if (nativeSupportsAny(audio, ['audio/flac', 'audio/x-flac'])) caps.add('flac')
  if (nativeSupportsAny(audio, ['audio/mp4; codecs="ec-3"', 'audio/mp4; codecs="eac3"'])) caps.add('eac3')

  return Array.from(caps).join(',')
}
