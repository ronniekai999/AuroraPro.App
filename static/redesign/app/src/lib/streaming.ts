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

import Hls from 'hls.js'

import { apiFetch, type SkipMarker } from './api'

// /api/stream/info response — sparse subset of what the server returns,
// covering only the fields the V2 player consumes today. Phase 2.5
// will surface audio_passthrough, hdr_tonemap, etc. for the codec
// settings panel.
export interface StreamInfo {
  stream: StreamDecision
  audio_tracks?: AudioTrack[]
  subtitles?: SubtitleTrack[]
  // Smart Skip windows in SOURCE-FILE milliseconds (already filtered
  // server-side to displayable, non-suppressed markers). The player
  // maps them onto the active timeline via the session's start_sec —
  // the same mapping watch progress uses.
  markers?: SkipMarker[]
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
  // Codec the session's audio output carries. Re-encode: 'aac' (stereo) or
  // 'ac3' (5.1 surround). Copy (audio_passthrough): the SOURCE codec —
  // 'aac'/'ac3'/'eac3' (E-AC-3 passthrough is fMP4-mode only). Echoed back to
  // createSession; the server re-validates it against its own track data.
  audio_codec_out?: string
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
  audio_codec_out?: string
  hdr_tonemap?: boolean
  video_codec?: string
  // FFmpeg -ss seek offset in WHOLE SECONDS (V1's playMedia floors
  // resumeMs/1000 before sending). The server starts transcoding
  // from this position, so hls.js's currentTime 0 maps to this
  // offset in the source file. The session response echoes back
  // the actual start_sec the server used (it may round-snap to a
  // GOP boundary), which the client adds back when reporting
  // progress.
  start_sec?: number
}

export interface SessionResponse {
  session_id: string
  master_playlist: string
  start_sec?: number
}

// Client capability probe. The backend's playback-decision engine
// (DecidePlayback) chooses direct play vs remux vs transcode based on what the
// client can actually decode — but ONLY when we tell it. ParseClientCaps on
// the server expects a comma-separated list of lowercase keys: video codecs
// (h264, hevc/h265, vp8, vp9, av1), audio codecs (aac, mp3, ac3, eac3, opus,
// flac, vorbis), containers (mp4_container, webm_container) and the delivery
// hints hls_js / hls_native. Unknown keys are ignored server-side; only
// SUPPORTED keys are emitted.
//
// Computed once per page load and cached — capabilities don't change within a
// session, and the probe spins up a throwaway <video> element.
let cachedCaps: string | null = null

function supports(mse: string, file: string, el: HTMLVideoElement): boolean {
  try {
    if (
      typeof MediaSource !== 'undefined' &&
      typeof MediaSource.isTypeSupported === 'function' &&
      MediaSource.isTypeSupported(mse)
    ) {
      return true
    }
  } catch {
    // isTypeSupported can throw on old / locked-down engines — fall through.
  }
  try {
    // canPlayType returns '', 'maybe', or 'probably'; non-empty = playable.
    if (el.canPlayType(file) !== '') return true
  } catch {
    // defensive — canPlayType is universally implemented, but never throw.
  }
  return false
}

// supportsMSE is the STRICT Media Source Extensions probe — MediaSource
// .isTypeSupported only, with NO canPlayType fallback. Use it for codecs Aurora
// delivers through hls.js (MSE), whose own gate is isTypeSupported-only.
// canPlayType reports NATIVE <video> decode ability, which over-reports for the
// MSE path and would mislead the server into emitting media hls.js then
// silently drops.
function supportsMSE(mse: string): boolean {
  try {
    return (
      typeof MediaSource !== 'undefined' &&
      typeof MediaSource.isTypeSupported === 'function' &&
      MediaSource.isTypeSupported(mse)
    )
  } catch {
    return false
  }
}

export function clientCaps(): string {
  if (cachedCaps !== null) return cachedCaps
  // Non-DOM contexts (SSR, tests): no probe possible → empty string makes the
  // server fall back to its conservative static allowlist.
  if (typeof document === 'undefined') {
    cachedCaps = ''
    return cachedCaps
  }

  const el = document.createElement('video')
  const caps: string[] = []

  // Video codecs — supported if the MSE/hls.js path OR native <video> can play.
  if (supports('video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.42E01E"', el)) {
    caps.push('h264')
  }
  if (
    supports('video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hvc1.1.6.L93.B0"', el) ||
    supports('video/mp4; codecs="hev1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"', el)
  ) {
    caps.push('hevc', 'h265')
  }
  if (supports('video/webm; codecs="vp8"', 'video/webm; codecs="vp8"', el)) {
    caps.push('vp8')
  }
  if (supports('video/webm; codecs="vp09.00.10.08"', 'video/mp4; codecs="vp09.00.10.08"', el)) {
    caps.push('vp9')
  }
  if (supports('video/mp4; codecs="av01.0.04M.08"', 'video/mp4; codecs="av01.0.04M.08"', el)) {
    caps.push('av1')
  }

  // Containers.
  if (el.canPlayType('video/mp4') !== '') caps.push('mp4_container')
  if (el.canPlayType('video/webm') !== '') caps.push('webm_container')

  // Audio codecs.
  if (supports('audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="mp4a.40.2"', el)) caps.push('aac')
  if (supports('audio/mpeg', 'audio/mpeg', el)) caps.push('mp3')
  // AC-3 (Dolby Digital): gate STRICTLY on MediaSource.isTypeSupported, NOT the
  // canPlayType OR. Aurora delivers transcoded/remuxed audio via hls.js, whose
  // MPEG-TS demuxer only emits AC-3 when MediaSource.isTypeSupported(
  // 'audio/mp4; codecs="ac-3"') is true and SILENTLY drops it otherwise (no
  // error, no fallback → silent video). Matching hls.js's own typeSupported.ac3
  // gate makes the platform matrix self-correct: Linux, Firefox, Windows 11
  // 24H2, and Chromium-derived browsers all report false here.
  if (supportsMSE('audio/mp4; codecs="ac-3"')) caps.push('ac3')
  // E-AC-3 (Dolby Digital Plus) ships as TWO caps because two delivery paths
  // gate on different probes:
  //  * eac3 — native-or-MSE (canPlayType fallback OK). Gates DIRECT PLAY of
  //    e.g. mp4+h264+eac3, where the native <video> decoder is what matters,
  //    and the remux path on native-HLS-only clients (no hls.js), where the
  //    native HLS player decodes.
  //  * eac3_mse — MediaSource.isTypeSupported ONLY. Gates the server copying
  //    E-AC-3 into fMP4 HLS segments consumed by hls.js, which hands the
  //    track straight to an MSE SourceBuffer — canPlayType over-reports for
  //    that path (same rationale as the MSE-strict ac3 cap above). Servers
  //    older than the eac3-passthrough change ignore the unknown key.
  if (supports('audio/mp4; codecs="ec-3"', 'audio/mp4; codecs="ec-3"', el)) caps.push('eac3')
  if (supportsMSE('audio/mp4; codecs="ec-3"')) caps.push('eac3_mse')
  if (supports('audio/webm; codecs="opus"', 'audio/ogg; codecs="opus"', el)) caps.push('opus')
  if (supports('audio/ogg; codecs="flac"', 'audio/mp4; codecs="flac"', el)) caps.push('flac')
  if (supports('audio/webm; codecs="vorbis"', 'audio/ogg; codecs="vorbis"', el)) caps.push('vorbis')

  // HLS delivery. The server restricts HLS audio handling when hls_js is set
  // (hls.js's TS demuxer only does aac/mp3/ac3), so this flag is significant.
  if (Hls.isSupported()) caps.push('hls_js')
  if (el.canPlayType('application/vnd.apple.mpegurl') !== '') caps.push('hls_native')

  cachedCaps = caps.join(',')
  return cachedCaps
}

// /api/stream/info call. Sends the probed client capabilities (see clientCaps)
// as a comma-separated `caps` param so the server's client-aware
// DecidePlayback engine can choose direct play / remux / transcode based on
// what THIS browser can actually decode (e.g. HEVC or HDR direct play on
// Safari; AV1 only where supported). When caps is empty (non-DOM context) the
// param is omitted and the server falls back to its conservative static
// allowlist.
export async function getStreamInfo(
  fileId: number,
  fileType: 'media' | 'episode' = 'media',
  signal?: AbortSignal,
): Promise<StreamInfo> {
  const caps = clientCaps()
  const capsParam = caps ? `&caps=${encodeURIComponent(caps)}` : ''
  return apiFetch<StreamInfo>(
    `/api/stream/info/${fileId}?type=${fileType}${capsParam}`,
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
