// Playback quality-of-experience collection (August 2026 review, item #1).
//
// Aurora had rich diagnostic logging but no durable answer to the questions
// that should drive codec and buffering work: is startup regressing, which
// delivery path stalls, how often do we transcode something we could have
// direct played. This module measures one playback and reports it twice —
// at first frame, and at whatever ends it.
//
// Two properties are deliberate:
//
//   - It NEVER throws into the player. Every entry point swallows its own
//     errors. Telemetry that can break playback is worse than no telemetry,
//     and this runs on the hot path of every movie anyone starts.
//   - It reports COARSE buckets, never raw values. A raw throughput figure
//     with a timestamp is closer to a network fingerprint than to an
//     operational metric, and the buckets answer the same questions. The
//     server enforces the same vocabularies (migration 056) rather than
//     trusting these.

import { apiFetchResponse } from './api'

export type QoEDecision = 'direct_play' | 'direct_stream' | 'transcode'
export type QoEBurnIn = 'none' | 'text' | 'bitmap'
export type QoEPrewarm = 'none' | 'hit' | 'miss'
export type QoETerminal =
  | 'ended'
  | 'user_exit'
  | 'media_error'
  | 'network_error'
  | 'transcode_error'
  | 'unknown'

export interface QoEContext {
  decision: QoEDecision
  /** Coarse bucket of the server's transcode reason. */
  decisionReason?: string
  outputCodec?: string
  encoderFamily?: string
  segmentFormat?: string
  hdrConversion?: string
  burnIn?: QoEBurnIn
  subtitleMode?: string
  prewarm?: QoEPrewarm
  /**
   * performance.now() at the moment the user asked for playback. The single
   * most valuable number here — click-to-first-frame is what a viewer
   * actually experiences as "how fast is this thing".
   */
  clickAtMs?: number
  profileId?: number
}

export interface QoECollector {
  /** hls.js MANIFEST_PARSED (or the native-HLS equivalent). */
  noteManifestParsed(): void
  /** hls.js LEVEL_SWITCHED. */
  noteRenditionSwitch(): void
  /** Latest hls.js bandwidth estimate, in bits/sec. Bucketed before sending. */
  noteThroughput(bitsPerSec: number): void
  /** Terminal categories the player knows about but the DOM does not. */
  noteError(kind: 'media_error' | 'network_error' | 'transcode_error'): void
  /** Report and stop. Safe to call more than once; only the first wins. */
  finish(terminal: QoETerminal): void
  /** Detach listeners without reporting — used when a session never started. */
  detach(): void
}

/** 32 lowercase hex characters, matching the server's token validation. */
function newSessionToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function throughputClass(bitsPerSec: number): string {
  if (!Number.isFinite(bitsPerSec) || bitsPerSec <= 0) return 'unknown'
  if (bitsPerSec < 2_000_000) return 'under_2m'
  if (bitsPerSec < 5_000_000) return '2m_5m'
  if (bitsPerSec < 10_000_000) return '5m_10m'
  if (bitsPerSec < 25_000_000) return '10m_25m'
  return 'over_25m'
}

/**
 * Viewport bucket from the element's rendered size in device pixels — what the
 * viewport cap actually keys off, and the dimension that explains why one
 * device family selects lower renditions than another.
 */
function viewportClass(el: HTMLVideoElement | null): string {
  const dpr = window.devicePixelRatio || 1
  const w = Math.round((el?.clientWidth || window.innerWidth || 0) * dpr)
  if (w <= 0) return 'unknown'
  if (w < 1280) return 'sd'
  if (w < 1920) return 'hd'
  if (w < 2560) return 'fhd'
  if (w < 3840) return 'qhd'
  return 'uhd'
}

/**
 * Attach a collector to a video element.
 *
 * Rebuffering is measured from `waiting` → `playing` pairs, with seek-induced
 * waits excluded: a `seeking` event opens a window during which waits are the
 * user's own doing rather than a delivery failure, and counting them would make
 * a heavy scrubber look like a stalling server.
 */
export function attachPlaybackQoE(
  video: HTMLVideoElement,
  ctx: QoEContext,
): QoECollector {
  const sessionToken = newSessionToken()

  let manifestAtMs: number | null = null
  let firstFrameReported = false
  let finished = false
  let detached = false

  let rebufferCount = 0
  let rebufferMs = 0
  let rebufferStartedAt: number | null = null
  let renditionSwitches = 0
  let throughputBits = 0
  let pendingError: QoETerminal | null = null

  // Seek window: waits inside it are not rebuffers.
  let seeking = false

  // Watch time: accumulated only while actually playing.
  let watchedMs = 0
  let playingSince: number | null = null

  const post = (path: string, payload: unknown, beacon: boolean) => {
    try {
      const body = JSON.stringify({ ...(payload as object), session_token: sessionToken, profile_id: ctx.profileId })
      if (beacon && typeof navigator.sendBeacon === 'function') {
        // sendBeacon is the only transport guaranteed to survive unload. Auth
        // rides the same-origin httpOnly cookie, which beacons carry.
        const blob = new Blob([body], { type: 'application/json' })
        if (navigator.sendBeacon(path, blob)) return
      }
      void apiFetchResponse(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch(() => {
        // Telemetry is best-effort by design.
      })
    } catch {
      // Never propagate into the player.
    }
  }

  const reportFirstFrame = () => {
    if (firstFrameReported) return
    firstFrameReported = true
    const now = performance.now()
    const clickToFirstFrame =
      ctx.clickAtMs != null ? Math.round(now - ctx.clickAtMs) : null
    const manifestToFirstFrame =
      manifestAtMs != null ? Math.round(now - manifestAtMs) : null

    post(
      '/api/stream/qoe/start',
      {
        decision: ctx.decision,
        decision_reason: ctx.decisionReason || 'unspecified',
        output_codec: ctx.outputCodec || 'none',
        encoder_family: ctx.encoderFamily || 'none',
        segment_format: ctx.segmentFormat || 'none',
        hdr_conversion: ctx.hdrConversion || 'none',
        burn_in: ctx.burnIn || 'none',
        subtitle_mode: ctx.subtitleMode || 'none',
        prewarm: ctx.prewarm || 'none',
        viewport_class: viewportClass(video),
        click_to_first_frame_ms: clickToFirstFrame,
        manifest_to_first_frame_ms: manifestToFirstFrame,
      },
      false,
    )
  }

  const closeRebuffer = () => {
    if (rebufferStartedAt == null) return
    rebufferMs += Math.round(performance.now() - rebufferStartedAt)
    rebufferStartedAt = null
  }

  const accrueWatch = () => {
    if (playingSince == null) return
    watchedMs += Math.round(performance.now() - playingSince)
    playingSince = null
  }

  const onPlaying = () => {
    closeRebuffer()
    if (playingSince == null) playingSince = performance.now()
    reportFirstFrame()
  }
  const onWaiting = () => {
    accrueWatch()
    // A wait during a seek is the user's own doing, not a delivery stall.
    if (seeking || rebufferStartedAt != null) return
    rebufferStartedAt = performance.now()
    rebufferCount++
  }
  const onPause = () => accrueWatch()
  const onSeeking = () => {
    seeking = true
    accrueWatch()
    // A seek supersedes an open rebuffer window; the remaining wait belongs
    // to the seek.
    closeRebuffer()
  }
  const onSeeked = () => {
    seeking = false
  }
  const onEnded = () => collector.finish('ended')
  const onError = () => {
    // MediaError.code 2 is NETWORK, everything else reads as a decode/source
    // problem from here.
    const code = video.error?.code
    collector.finish(code === 2 ? 'network_error' : 'media_error')
  }
  // A page being unloaded mid-playback is a user exit, and the beacon is the
  // only thing that will still run.
  const onPageHide = () => collector.finish('user_exit')

  video.addEventListener('playing', onPlaying)
  video.addEventListener('waiting', onWaiting)
  video.addEventListener('pause', onPause)
  video.addEventListener('seeking', onSeeking)
  video.addEventListener('seeked', onSeeked)
  video.addEventListener('ended', onEnded)
  video.addEventListener('error', onError)
  window.addEventListener('pagehide', onPageHide)

  const removeListeners = () => {
    if (detached) return
    detached = true
    video.removeEventListener('playing', onPlaying)
    video.removeEventListener('waiting', onWaiting)
    video.removeEventListener('pause', onPause)
    video.removeEventListener('seeking', onSeeking)
    video.removeEventListener('seeked', onSeeked)
    video.removeEventListener('ended', onEnded)
    video.removeEventListener('error', onError)
    window.removeEventListener('pagehide', onPageHide)
  }

  const collector: QoECollector = {
    noteManifestParsed() {
      if (manifestAtMs == null) manifestAtMs = performance.now()
    },
    noteRenditionSwitch() {
      renditionSwitches++
    },
    noteThroughput(bitsPerSec: number) {
      if (Number.isFinite(bitsPerSec) && bitsPerSec > 0) throughputBits = bitsPerSec
    },
    noteError(kind) {
      pendingError = kind
    },
    finish(terminal: QoETerminal) {
      if (finished) return
      finished = true
      accrueWatch()
      closeRebuffer()
      removeListeners()

      // A session that never reached first frame still has a story worth
      // telling — it failed to start — so emit the start row before the
      // terminal one, with no timing rather than a fabricated one.
      if (!firstFrameReported) {
        const savedClick = ctx.clickAtMs
        ctx.clickAtMs = undefined
        reportFirstFrame()
        ctx.clickAtMs = savedClick
      }

      post(
        '/api/stream/qoe/finish',
        {
          rebuffer_count: rebufferCount,
          rebuffer_ms: rebufferMs,
          rendition_switches: renditionSwitches,
          watched_ms: watchedMs,
          throughput_class: throughputClass(throughputBits),
          terminal: pendingError || terminal,
        },
        true,
      )
    },
    detach() {
      finished = true
      removeListeners()
    },
  }

  return collector
}
