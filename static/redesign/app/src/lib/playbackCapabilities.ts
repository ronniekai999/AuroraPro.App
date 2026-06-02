// Aurora V2 — browser playback capability reporting.
//
// The Go playback-decision engine already accepts a compact comma-separated
// `caps` query parameter (see internal/streaming.ParseClientCaps). The React
// redesign previously omitted it entirely, which forced HEVC and other
// browser-specific decisions through the conservative static fallback path.
//
// Keep this v1 probe intentionally narrow and backward compatible:
//   - Only report capabilities when this player will use hls.js. The backend
//     already prevents VP8/VP9/AV1 MPEG-TS remux on HLSJS sessions, but does
//     not yet represent the same distinction for native-HLS-only paths.
//   - Start with the backend's existing static browser baseline. Sending caps
//     must not turn ordinary H.264/AAC or VP9/AV1 direct play into a transcode
//     merely because an optional capability probe returned an empty result.
//   - Add HEVC only when native playback and MediaSource both confirm it,
//     because HEVC may be direct-played or copied through hls.js remux.
//   - Add optional audio codecs only where the backend's current HLSJS policy
//     either safely passes them or safely recodes them.
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

  // Mirror the pre-existing nil-caps baseline so capability plumbing cannot
  // regress previously working standard playback decisions. The only new
  // claims below are capability-probed extensions to that baseline.
  const caps = new Set<string>([
    'hls_js',
    'h264', 'vp8', 'vp9', 'av1',
    'aac', 'mp3',
    'mp4_container', 'webm_container',
  ])

  // macOS Safari can expose hls.js and native HLS. HLSJS remains present so
  // the server applies its guarded hls.js policy for any non-direct path.
  if (canPlay(video, 'application/vnd.apple.mpegurl') || canPlay(video, 'application/x-mpegURL')) {
    caps.add('hls_native')
  }

  // HEVC is the immediate capability win for this PR. The current backend may
  // use this same key for native MP4 playback and hls.js remux, so require
  // positive evidence on both playback surfaces before enabling it.
  const hevc = [
    'video/mp4; codecs="hvc1.1.6.L93.B0"',
    'video/mp4; codecs="hev1.1.6.L93.B0"',
    'video/mp4; codecs="hvc1"',
    'video/mp4; codecs="hev1"',
  ]
  if (remuxSafe(video, hevc)) caps.add('h265')

  // AC-3 can be copied in current HLS-TS delivery, so enable it only where
  // both native playback and MediaSource support are confirmed.
  const ac3 = ['audio/mp4; codecs="ac-3"', 'audio/mp4; codecs="ac3"']
  if (remuxSafe(audio, ac3)) caps.add('ac3')

  // These are useful only for native direct play. When HLSJS remux is needed,
  // the Go backend filters them out of HLS caps and recodes audio to AAC.
  if (nativeSupportsAny(audio, ['audio/webm; codecs="opus"', 'audio/ogg; codecs="opus"'])) caps.add('opus')
  if (nativeSupportsAny(audio, ['audio/webm; codecs="vorbis"', 'audio/ogg; codecs="vorbis"'])) caps.add('vorbis')
  if (nativeSupportsAny(audio, ['audio/flac', 'audio/x-flac'])) caps.add('flac')
  if (nativeSupportsAny(audio, ['audio/mp4; codecs="ec-3"', 'audio/mp4; codecs="eac3"'])) caps.add('eac3')

  return Array.from(caps).join(',')
}
