// Aurora V2 — browser playback capability reporting.
//
// PR #197 established client capability plumbing. Issue #198 exposed an
// important contract problem: the current Go decision engine uses one `h265`
// capability for both original-file playback and HEVC copied into HLS/MPEG-TS.
// A generic browser HEVC claim is not sufficient proof that an arbitrary source
// stream will remain playable through the current TS remux transport.
//
// Contract v2 safety gate:
//   - Continue reporting the known-stable hls.js baseline.
//   - Do NOT advertise h265/hevc under the legacy combined-capability contract.
//   - Do NOT add newly inferred audio/container pairings until capabilities are
//     source- and delivery-aware.
//
// This preserves PR #197's plumbing while routing HEVC through the established
// transcode fallback until a later PR can separately prove native direct play
// and remux/fMP4 safety for the actual source profile.

import Hls from 'hls.js'

function canPlay(element: HTMLMediaElement, mime: string): boolean {
  return element.canPlayType(mime) !== ''
}

/**
 * Returns the stable capability keys understood by
 * internal/streaming.ParseClientCaps. An empty string deliberately keeps the
 * backend on its pre-capability static fallback path.
 */
export function detectBaselineCapabilities(): string {
  if (typeof document === 'undefined' || !Hls.isSupported()) return ''

  const video = document.createElement('video')
  const caps = new Set<string>([
    'hls_js',
    'h264', 'vp8', 'vp9', 'av1',
    'aac', 'mp3',
    'mp4_container', 'webm_container',
  ])

  // Some desktop Safari configurations expose hls.js and native HLS. Keep the
  // flag for existing server policy, but do not enable new HEVC decisions here.
  if (canPlay(video, 'application/vnd.apple.mpegurl') || canPlay(video, 'application/x-mpegURL')) {
    caps.add('hls_native')
  }

  return Array.from(caps).join(',')
}
