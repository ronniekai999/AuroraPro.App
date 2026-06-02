// Aurora V2 — browser playback capability reporting.
//
// The Go playback-decision engine already accepts a compact comma-separated
// `caps` query parameter (see internal/streaming.ParseClientCaps). The React
// redesign previously omitted it entirely, which forced HEVC and other
// browser-specific decisions through the conservative static fallback path.
//
// Keep this v1 probe intentionally conservative and synchronous:
//   - Only emit keys the current backend understands.
//   - Use native <video>/<audio> support for direct-file/container decisions.
//   - Use MediaSource support for codecs hls.js can attach to an MSE player.
//   - Let the backend retain all policy decisions (TS remux restrictions,
//     audio recode rules, Hi10P handling, and full-transcode fallback).
//
// A future capability-contract v2 can layer MediaCapabilities.decodingInfo()
// against exact source metadata (resolution, bitrate, HDR, profile) without
// changing this PR's safe compatibility unlock.

import Hls from 'hls.js'

function canPlay(element: HTMLMediaElement, mime: string): boolean {
  return element.canPlayType(mime) !== ''
}

function canMediaSource(mime: string): boolean {
  return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime)
}

function anySupported(element: HTMLMediaElement, mimes: string[]): boolean {
  return mimes.some((mime) => canPlay(element, mime) || canMediaSource(mime))
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

  // Delivery capabilities. The player prefers hls.js whenever it can attach;
  // native HLS remains relevant on Safari/iOS and cast/AirPlay-style paths.
  if (Hls.isSupported()) caps.add('hls_js')
  if (canPlay(video, 'application/vnd.apple.mpegurl') || canPlay(video, 'application/x-mpegURL')) {
    caps.add('hls_native')
  }

  // Native container support. These are only advertised with a representative
  // browser-playable codec rather than on file extension alone.
  const mp4H264 = [
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    'video/mp4; codecs="avc1.42E01E"',
  ]
  const webmVP9 = [
    'video/webm; codecs="vp09.00.10.08, opus"',
    'video/webm; codecs="vp9, opus"',
    'video/webm; codecs="vp8, vorbis"',
  ]
  if (mp4H264.some((mime) => canPlay(video, mime))) caps.add('mp4_container')
  if (webmVP9.some((mime) => canPlay(video, mime))) caps.add('webm_container')

  // Video codec decoding. Include both browser-native and MediaSource probes:
  // direct play uses native support while HLS.js playback is MSE-backed.
  if (anySupported(video, mp4H264)) caps.add('h264')
  if (anySupported(video, [
    'video/mp4; codecs="hvc1.1.6.L93.B0"',
    'video/mp4; codecs="hev1.1.6.L93.B0"',
    'video/mp4; codecs="hvc1"',
    'video/mp4; codecs="hev1"',
  ])) {
    // Server treats h265/hevc as aliases; h265 is the canonical emitted key.
    caps.add('h265')
  }
  if (anySupported(video, [
    'video/webm; codecs="vp9"',
    'video/webm; codecs="vp09.00.10.08"',
  ])) caps.add('vp9')
  if (anySupported(video, ['video/webm; codecs="vp8"'])) caps.add('vp8')
  if (anySupported(video, [
    'video/mp4; codecs="av01.0.05M.08"',
    'video/webm; codecs="av01.0.05M.08"',
  ])) caps.add('av1')

  // Audio support used for direct-file selection and the backend's existing
  // safe HLS passthrough/recode decisioning. Do not emit DTS/TrueHD: the
  // current backend does not pass them through for browser playback.
  if (anySupported(audio, [
    'audio/mp4; codecs="mp4a.40.2"',
    'audio/aac',
  ])) caps.add('aac')
  if (anySupported(audio, ['audio/mpeg'])) caps.add('mp3')
  if (anySupported(audio, [
    'audio/webm; codecs="opus"',
    'audio/ogg; codecs="opus"',
  ])) caps.add('opus')
  if (anySupported(audio, ['audio/webm; codecs="vorbis"', 'audio/ogg; codecs="vorbis"'])) caps.add('vorbis')
  if (anySupported(audio, ['audio/flac', 'audio/x-flac'])) caps.add('flac')
  if (anySupported(audio, [
    'audio/mp4; codecs="ac-3"',
    'audio/mp4; codecs="ac3"',
  ])) caps.add('ac3')
  if (anySupported(audio, [
    'audio/mp4; codecs="ec-3"',
    'audio/mp4; codecs="eac3"',
  ])) caps.add('eac3')

  return Array.from(caps).join(',')
}
