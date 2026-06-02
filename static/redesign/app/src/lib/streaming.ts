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
// This module is intentionally I/O only — the React player component
// owns the hls.js lifecycle and orchestrates calls in here.

import { apiFetch } from './api'
import { detectBaselineCapabilities } from './playbackCapabilities'

// /api/stream/info response — sparse subset of what the server returns,
// covering only the fields the V2 player consumes today. Phase 2.5
// will surface audio_passthrough, hdr_tonemap, etc. for the codec
// settings panel.
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

// /api/stream/info capability contract v2 safety gate.
//
// Issue #198 demonstrated that the legacy backend cannot distinguish native
// HEVC file playback capability from HEVC copied into its current HLS/MPEG-TS
// remux output. Until the backend exposes separate delivery-safe/source-aware
// capabilities, V2 sends the established baseline and deliberately excludes
// h265/hevc. That retains capability plumbing and existing playback choices,
// while forcing HEVC through the known-safe transcode path instead of creating
// a fragile HEVC remux session that can stop after several segments.
export async function getStreamInfo(
  fileId: number,
  fileType: 'media' | 'episode' = 'media',
  signal?: AbortSignal,
): Promise<StreamInfo> {
  const query = new URLSearchParams({ type: fileType })
  const caps = detectBaselineCapabilities()
  if (caps) query.set('caps', caps)

  return apiFetch<StreamInfo>(
    `/api/stream/info/${fileId}?${query.toString()}`,
    { signal },
  )
}

export async function createSession(
  req: CreateSessionRequest,
  signal?: AbortSignal,
): Promise<SessionResponse> {
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
