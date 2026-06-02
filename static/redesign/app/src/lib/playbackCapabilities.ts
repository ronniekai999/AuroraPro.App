// Aurora V2 — browser playback capability reporting.
//
// PR #197 established client capability plumbing. Issue #198 exposed an
// important contract problem: the Go decision engine currently uses the same
// `h265` flag for native direct-file playback AND HEVC copied into HLS/MPEG-TS.
// A browser proving that it can decode HEVC in an MP4 does not prove that the
// same source is stable after hls.js/TS remuxing.
//
// Contract v2 therefore exposes two intentionally separate capability sets:
//   - baseline caps: the stable pre-HEVC behavior used for every first decision;
//   - HEVC direct-file caps: a second, opt-in query that may be accepted only
//     when the server responds with `direct_play` for a qualified source file.
//
// HEVC HLS remux is deliberately NOT enabled here. It remains deferred until
// Aurora has a packaging/source-profile contract suitable for validating it.

import Hls from 'hls.js'

function canPlay(element: HTMLMediaElement, mime: string): boolean {
  return element.canPlayType(mime) !== ''
}

function nativeSupportsAny(element: HTMLMediaElement, mimes: string[]): boolean {
  return mimes.some((mime) => canPlay(element, mime))
}

function baselineCapabilitySet(): Set<string> | null {
  if (typeof document === 'undefined' || !Hls.isSupported()) return null

  const video = document.createElement('video')
  const caps = new Set<string>([
    'hls_js',
    'h264', 'vp8', 'vp9', 'av1',
    'aac', 'mp3',
    'mp4_container', 'webm_container',
  ])

  if (canPlay(video, 'application/vnd.apple.mpegurl') || canPlay(video, 'application/x-mpegURL')) {
    caps.add('hls_native')
  }

  return caps
}

/**
 * Stable capability request used for the initial stream decision.
 * It intentionally excludes HEVC and newly inferred audio/container pairings.
 */
export function detectBaselineCapabilities(): string {
  const caps = baselineCapabilitySet()
  return caps ? Array.from(caps).join(',') : ''
}

/**
 * Returns an HEVC-capable variant of the baseline for an explicit direct-file
 * candidate check. Callers MUST accept its response only when the server
 * chooses `direct_play`; a `direct_stream` response would re-enter the unsafe
 * HEVC-in-HLS-TS route demonstrated by issue #198.
 */
export function detectHEVCDirectPlayCapabilities(): string {
  const caps = baselineCapabilitySet()
  if (!caps || typeof document === 'undefined') return ''

  const video = document.createElement('video')
  const hevc = [
    'video/mp4; codecs="hvc1.1.6.L93.B0"',
    'video/mp4; codecs="hev1.1.6.L93.B0"',
    'video/mp4; codecs="hvc1"',
    'video/mp4; codecs="hev1"',
  ]
  if (!nativeSupportsAny(video, hevc)) return ''

  caps.add('h265')
  return Array.from(caps).join(',')
}
