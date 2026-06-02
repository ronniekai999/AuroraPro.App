// Aurora V2 — streaming session management.
//
// Wraps Aurora's /api/stream/* endpoints. The streaming flow is:
//
//   1. GET /api/stream/info/{fileId} — server inspects the file's
//      codecs against client capabilities + admin profile config and
//      returns a "decision": direct_play | direct_stream | transcode.
//
//   2. POST /api/stream/sessions — creates an HLS session (FFmpeg
//      process for transcode/remux, NOP for direct_play). Returns
//      { session_id, master_playlist }.
//
//   3. The player loads master_playlist via hls.js. hls.js XHRs for
//      level + segment playlists hit /api/stream/hls/{sid}/...
//
//   4. POST /api/stream/sessions/{sid}/keepalive every ~10s so the
//      server-side TranscodeManager doesn't garbage-collect the
//      session.
//
//   5. DELETE /api/stream/sessions/{sid} on player close (best-
//      effort — server eventually GCs idle sessions, but explicit
//      cleanup releases ffmpeg + disk faster).
//
// The React player owns hls.js lifecycle; this module owns the request-side
// decision contract and records safe, source-level diagnostic breadcrumbs.

import { apiFetch } from './api'
import { detectBaselineCapabilities } from './playbackCapabilities'

// /api/stream/info response — sparse subset of what the server returns,
// covering only the fields the V2 player consumes today. Keep diagnostic
// fields here too: the bug-report console buffer captures decision summaries
// without including paths, tokens, or response bodies.
export interface StreamInfo {
  stream: StreamDecision
  audio_tracks?: AudioTrack[]
  subtitles?: SubtitleTrack[]
}

export interface StreamDecision {
  decision: 'direct_play' | 'direct_stream' | 'transcode'
  // Set by server when decision === 'direct_play'. The browser-native
  // <video> element loads this URL directly (no hls.js).
  stream_url?: string
  container?: string
  video_codec?: string
  audio_codec?: string
  resolution?: string
  transcode_reason?: string
  // Real source-file duration in milliseconds, from the ffprobe
  // metadata captured at scan time. CRITICAL for the custom
  // controls overlay — `vid.duration` reports HLS-playlist length
  // (which GROWS as the transcoder produces segments), so the
  // user-visible time "12:34 / 1:42:30" needs THIS value as the
  // total for sync-with-friends parity. Optional only because some
  // old/edge-case files may scan without a duration.
  duration_ms?: number
  // direct_stream === remux. Set so the session-create payload echoes
  // it back; the server uses it to short-circuit transcode parameter
  // selection.
  remux?: boolean
  audio_passthrough?: boolean
  audio_track_index?: number
  audio_channels?: number
  hdr_tonemap?: boolean
}

export interface AudioTrack {
  index: number
  language?: string
  title?: string
  codec?: string
  channels?: number
  default?: boolean
}

export interface SubtitleTrack {
  index: number
  language?: string
  title?: string
  codec?: string
  forced?: boolean
  // Issue #133 — server marks bitmap-format subs (PGS/VobSub/DVB)
  // with bitmap=true. These can't be converted to WebVTT text, so
  // the player picker filters them out — the server's
  // /api/stream/{id}/subtitles/{idx} endpoint returns 400 for
  // them, which the <track> element swallows silently and looks
  // like "subtitles don't work" to the user.
  bitmap?: boolean
}

export interface CreateSessionRequest {
  file_id: number
  // V1 uses 'media' for movies and 'episode' for episode files.
  // The shape of stream URLs is identical; this is just a routing
  // hint for the backend's file-lookup table.
  file_type: 'media' | 'episode'
  remux?: boolean
  audio_passthrough?: boolean
  audio_track_index?: number
  audio_channels?: number
  hdr_tonemap?: boolean
  video_codec?: string
  // FFmpeg -ss position in whole seconds. The server starts transcoding
  // from this position, so hls.js currentTime 0 maps to this offset in
  // the source file; progress reporting adds the echoed start_sec back.
  start_sec?: number
}

export interface SessionResponse {
  session_id: string
  master_playlist: string
  start_sec?: number
}

function isMacOSChrome(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return ua.includes('Macintosh') && ua.includes('Chrome/') && !ua.includes('Edg/') && !ua.includes('OPR/')
}

function decisionBreadcrumb(fileId: number, fileType: 'media' | 'episode', stream: StreamDecision): Record<string, unknown> {
  return {
    fileId,
    fileType,
    decision: stream.decision,
    remux: !!stream.remux,
    container: stream.container ?? '',
    videoCodec: stream.video_codec ?? '',
    audioCodec: stream.audio_codec ?? '',
    resolution: stream.resolution ?? '',
    audioPassthrough: !!stream.audio_passthrough,
    audioTrackIndex: stream.audio_track_index ?? -1,
    audioChannels: stream.audio_channels ?? 0,
    hdrTonemap: !!stream.hdr_tonemap,
    transcodeReason: stream.transcode_reason ?? '',
  }
}

// /api/stream/info capability and recovery safety gate.
//
// PR #200 removed HEVC promotion after #198, but #201 and #202 reproduced the
// same ~15-second stop on the deployed no-h265 build. That proves the symptom
// is not solved by HEVC capability removal alone. The repeated affected client
// is Chrome on macOS, and the observed follow-up full-transcode session in
// #201 strongly points at an unstable direct_stream/remux startup on that path.
//
// Until the HLS transport can identify its exact failing stream combination,
// quarantine only Chrome/macOS direct_stream decisions: retain direct_play,
// but turn remux into a full-transcode session before the fragile session is
// created. We log the original decision and the containment action so the next
// bug report proves whether this guard actually applied to Free Willy.
export async function getStreamInfo(
  fileId: number,
  fileType: 'media' | 'episode' = 'media',
  signal?: AbortSignal,
): Promise<StreamInfo> {
  const query = new URLSearchParams({ type: fileType })
  const caps = detectBaselineCapabilities()
  if (caps) query.set('caps', caps)

  const info = await apiFetch<StreamInfo>(
    `/api/stream/info/${fileId}?${query.toString()}`,
    { signal },
  )
  console.info('[Aurora.playback] stream-info decision', decisionBreadcrumb(fileId, fileType, info.stream))

  if (isMacOSChrome() && info.stream.decision === 'direct_stream' && !!info.stream.remux) {
    console.warn('[Aurora.playback] Chrome/macOS remux quarantined; creating full transcode session', {
      ...decisionBreadcrumb(fileId, fileType, info.stream),
      issueGuard: '#201/#202',
    })
    return {
      ...info,
      stream: {
        ...info.stream,
        decision: 'transcode',
        remux: false,
        audio_passthrough: false,
        transcode_reason: 'Chrome/macOS direct_stream temporarily quarantined after early remux stalls',
      },
    }
  }

  return info
}

export async function createSession(
  req: CreateSessionRequest,
  signal?: AbortSignal,
): Promise<SessionResponse> {
  console.info('[Aurora.playback] creating HLS session', {
    fileId: req.file_id,
    fileType: req.file_type,
    remux: !!req.remux,
    audioPassthrough: !!req.audio_passthrough,
    audioTrackIndex: req.audio_track_index ?? -1,
    audioChannels: req.audio_channels ?? 0,
    hdrTonemap: !!req.hdr_tonemap,
    videoCodec: req.video_codec ?? '',
    startSec: req.start_sec ?? 0,
  })
  return apiFetch<SessionResponse>('/api/stream/sessions', {
    method: 'POST',
    body: req,
    signal,
  })
}

// Best-effort. Returns void even on error — the server GCs idle
// sessions eventually, so a failed DELETE just delays cleanup, it
// doesn't strand resources.
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await apiFetch(`/api/stream/sessions/${sessionId}`, { method: 'DELETE' })
  } catch {
    // intentionally swallowed — best-effort cleanup
  }
}

export async function keepalive(sessionId: string, signal?: AbortSignal): Promise<void> {
  try {
    await apiFetch(`/api/stream/sessions/${sessionId}/keepalive`, {
      method: 'POST',
      signal,
    })
  } catch {
    // Keepalive failures are silent — if the session is gone, the
    // next segment fetch will 404 and HLS.js's error handler will
    // surface the real failure (and trigger session recovery in
    // Phase 2.5).
  }
}

// Cast / AirPlay support — mint a session-scoped token to hand to a
// Chromecast or AirPlay receiver. Returned `playlist` is a relative URL
// already containing the token; the caller must prepend window.location.origin
// before handing it off (receivers fetch over the network from outside the
// page and need a fully-qualified URL).
export interface CastTokenResponse {
  token: string
  expires_at: number // Unix seconds
  playlist: string // /api/stream/hls/{sid}/master.m3u8?token=...
}

export async function createCastToken(
  sessionId: string,
  signal?: AbortSignal,
): Promise<CastTokenResponse> {
  return apiFetch<CastTokenResponse>(
    `/api/stream/sessions/${sessionId}/cast-token`,
    { method: 'POST', signal },
  )
}
