// Aurora V2 — real HLS video player (M10 Phase 2).
//
// Replaces the prototype's fake VideoPlayer that animated a static
// currentTime. This one talks to /api/stream/* and uses hls.js to
// play actual media.
//
// Compared to V1's playMedia (aurora_pro.html ~line 3828, ~700 lines)
// this port deliberately drops:
//   - Hardware-profile auto-fallback when MEDIA_ERROR fires (Phase 2.5)
//   - Inline HLS subtitle track surfacing (Phase 2.5)
//   - Session recovery on FFmpeg crash (Phase 2.5)
//   - Audio-track switching UI (Phase 2.5)
//   - Party-sync hooks (Phase 4)
//
// What it ships:
//   - direct_play vs HLS routing based on /api/stream/info decision
//   - hls.js with Bearer-token xhrSetup
//   - 10-second progress reporting to /api/progress/{mediaId}
//   - 10-second session keepalive
//   - Resume position support (the FFmpeg -ss path)
//   - Basic HLS.js error recovery (recoverMediaError + startLoad)
//   - Clean session DELETE + hls.js destroy on close
//
// The user-facing controls (play/pause/seek/volume) are entirely
// browser-native via the <video controls> attribute. V1 has a
// custom controls overlay; that's a polish item, deferred.

import { useEffect, useRef, useState, useCallback } from 'react'
import Hls from 'hls.js'
import {
  forceTokenRefresh,
  type EpisodeFile,
  type MediaFile,
  reportProgress,
  withToken,
} from '@/lib/api'
import { ReactionPicker } from './ReactionOverlay'
import { PlayerControls } from './PlayerControls'
import {
  createSession,
  deleteSession,
  getStreamInfo,
  keepalive,
  type AudioTrack,
  type StreamInfo,
  type SubtitleTrack,
} from '@/lib/streaming'

// M10 Phase 4 — party-sync handle. When provided, the player mirrors
// the party's playback state (pause/play/seek) and, for the host,
// broadcasts local user actions to all guests. Designed to be a
// thin pass-through: the party state lives in useParty's React
// state; the player just reads refs (no re-render on tick) and
// fires callbacks on user interaction.
//
// Drift correction is intentionally simplified vs V1: hard snap on
// >1s drift, no rate-adjust catch-up. Phase 4.5 should port V1's
// rate-up/rate-down algorithm + the target-aware seek-echo suppression
// (the 2026-05-15 seek-storm fix in aurora_pro.html ~line 6517).
export interface PartySync {
  isHost: boolean
  // Live refs the player polls each second. tick.abs_ms is in
  // SOURCE coordinates; player adds back hello.hls_start_sec via
  // helloAbsMsRef → 0 mapping to map to hls.js currentTime.
  tickRef: React.MutableRefObject<{ abs_ms: number; server_now_ms: number; running?: boolean; rev?: number } | null>
  helloAbsMsRef: React.MutableRefObject<number>
  // Server-reported hls_start_sec (FFmpeg -ss snapped offset). Tick
  // abs_ms minus this gives hls.js-relative seconds.
  hlsStartSec: number
  // The server's last-known isPlaying. Drives guest-side play/pause
  // mirroring when no recent tick has arrived to disambiguate.
  isPlaying: boolean
  // Audit H3 (Phase 4.5 final-6) — the party's authoritative
  // mediaItemId. Mirror only fires when this matches the player's
  // current target.mediaItemId; otherwise we'd seek the wrong
  // movie to the party's currentTimeMs.
  partyMediaItemId?: number
  // Host actions — fire when the host's video element generates a
  // local event that should propagate to guests.
  requestPlay: () => void
  requestPause: (absMs: number) => void
  requestSeek: (absMs: number) => void
}

export interface PlayTarget {
  // The MediaItem.id — the parent show or movie. Required for
  // progress reporting (Aurora's /api/progress endpoint is keyed
  // by media_item_id, NOT by file or episode).
  mediaItemId: number
  // The MediaFile.id (movie) or EpisodeFile.id (episode) to stream.
  fileId: number
  // Which file table to query on the server side.
  fileType: 'media' | 'episode'
  // EpisodeId if this is a TV episode — threaded through to
  // /api/progress for per-episode tracking. Undefined for movies.
  episodeId?: number
  // For the player UI title.
  title: string
  subtitle?: string
  // FFmpeg -ss position in MS. If 0, starts from the beginning.
  resumePositionMs?: number
  // M10 Phase 4.5 — audio track override. When set, overrides the
  // server's automatic audio_track_index. Used by the in-player
  // audio picker which re-fires play with the new index.
  audioTrackIndex?: number
  // Phase 5 — force a full transcode regardless of the server's
  // codec-decision result. Used by the auto-fallback path when
  // remux fails with MEDIA_ERROR (the browser can't decode the
  // source codecs even with container rewrap).
  forceTranscode?: boolean
}

interface VideoPlayerProps {
  target: PlayTarget | null
  onClose: () => void
  party?: PartySync
  // M10 Phase 4.5 — audio-track picker callback. The parent owns
  // playerTarget state; on user pick, we ask the parent to update
  // it with a new audioTrackIndex which retriggers the play effect.
  // Audit M2 fix — the parent rebuilds the session on audio
  // switch; we pass the LIVE playback position so the new session
  // resumes from where the user was, not from the original
  // resumePositionMs (which could be 0 if playback started from
  // the beginning).
  onChangeAudioTrack?: (index: number, resumeMs: number) => void
  // M10 Phase 4.5 — reaction send callback. Wires up to
  // party.sendReaction; only meaningful when in a party.
  onSendReaction?: (emoji: string) => void
  // Phase 5 — hardware-profile fallback. When remux fails with
  // MEDIA_ERROR, the player asks the parent to retry the same
  // content with `forceTranscode=true` on the target. Parent
  // updates the target accordingly; play effect re-runs.
  onFallbackToTranscode?: () => void
}

// Pick a file to play from the available list.
//
// Phase 5 — quality-aware picker. V1's pattern:
//   - Default: prefer 1080p when available; 4K is opt-in via the
//     user's preference. This conserves bandwidth + transcode load.
//   - When `preferQuality === '4k'` (the user explicitly picked
//     "4K version" or has a preference setting): prefer 2160p /
//     "4k" / "uhd" tagged files; fall back to 1080p; fall back to
//     anything.
//   - When `preferQuality === '1080p'` (default): prefer 1080p;
//     fall back to anything except 4K.
// The 4K → 1080p fallback never reverses: a 4K-preference can use
// 1080p (smaller is acceptable); a 1080p-preference avoids 4K
// unless that's all that exists.
export type QualityPreference = '1080p' | '4k' | 'auto'
function fileQuality(f: MediaFile | EpisodeFile): '4k' | '1080p' | '720p' | 'other' {
  const res = ((f.resolution || '') + '').toLowerCase()
  const tag = (('version_tag' in f ? f.version_tag : '') || '').toLowerCase()
  if (res.includes('2160') || res === '4k' || res === 'uhd' || tag.includes('4k') || tag.includes('uhd')) return '4k'
  if (res.includes('1080') || tag.includes('1080')) return '1080p'
  if (res.includes('720')) return '720p'
  return 'other'
}
export function pickFile(
  files: MediaFile[] | EpisodeFile[] | undefined,
  prefer: QualityPreference = 'auto',
): MediaFile | EpisodeFile | null {
  if (!files || files.length === 0) return null
  const grouped: Record<string, (MediaFile | EpisodeFile)[]> = { '4k': [], '1080p': [], '720p': [], other: [] }
  for (const f of files) grouped[fileQuality(f)].push(f)
  // Order = preference-aware.
  const order = prefer === '4k'
    ? ['4k', '1080p', '720p', 'other']
    : prefer === '1080p'
      ? ['1080p', '720p', 'other', '4k']
      : ['1080p', '720p', '4k', 'other'] // auto: 1080 preferred, 4k as last resort
  for (const k of order) {
    if (grouped[k].length > 0) return grouped[k][0]
  }
  return files[0]
}

export function VideoPlayer({ target, onClose, party, onChangeAudioTrack, onSendReaction, onFallbackToTranscode }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const startSecRef = useRef<number>(0)
  const [status, setStatus] = useState<string>('Loading…')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // M10 Phase 4.5 — surface audio/sub tracks from /api/stream/info so
  // the user can pick. Server-probed tracks are the source of truth.
  // hls.js's own subtitleTracks are not used in this Phase 4.5 port;
  // Phase 4.6 can layer on inline-subtitle support like V1's
  // SUBTITLE_TRACKS_UPDATED handler does.
  const [availableAudio, setAvailableAudio] = useState<AudioTrack[]>([])
  const [availableSubs, setAvailableSubs] = useState<SubtitleTrack[]>([])
  const [audioMenuOpen, setAudioMenuOpen] = useState(false)
  const [subsMenuOpen, setSubsMenuOpen] = useState(false)
  const [currentSubIndex, setCurrentSubIndex] = useState<number>(-1) // -1 = off

  // Phase 7 — custom-controls playback state. Mirrors the <video>
  // element via `*event` handlers below. All in REAL-FILE units so
  // the seek bar + time display work whether we're on HLS (with
  // its growing playlist) or direct-play (with the real source
  // duration available immediately).
  const [playing, setPlaying] = useState(false)
  // currentSec / bufferedSec are in REAL-FILE coords: hls.currentTime
  // PLUS the session's startSec offset. For direct_play they equal
  // vid.currentTime / vid.buffered.end directly.
  const [currentSec, setCurrentSec] = useState(0)
  const [bufferedSec, setBufferedSec] = useState(0)
  // realDurationSec is the source-file duration from streamInfo.
  // Falls back to vid.duration when not provided.
  const [realDurationSec, setRealDurationSec] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  // Controls visibility — true when paused, or recently
  // mouse-moved, or first 2s after mount. Auto-fades after 3s of
  // inactivity while playing. Hover or any keydown resets.
  const [controlsVisible, setControlsVisible] = useState(true)
  const hideTimerRef = useRef<number | null>(null)
  const overlayRootRef = useRef<HTMLDivElement | null>(null)
  // Audit H1 fix — playingRef lets the stable showControlsTemporarily
  // read CURRENT playing state regardless of which closure (effect,
  // handler) calls it. Without this, keyboard-only users were never
  // seeing controls auto-hide because the keydown effect's deps were
  // `[target]` (capturing the initial playing=false on bind).
  const playingRef = useRef(false)
  // Phase 8 follow-up — tracks whether the cursor is currently in
  // the player's bottom intent zone (where the seek bar + button
  // row live). Updated on every mousemove against the overlay's
  // own bounding rect (so the zone math survives any future
  // wrapping/margins around the player). Read by
  // `showControlsTemporarily` to decide whether to schedule the
  // auto-hide timer. Stays false on touch-only sessions (no
  // mousemove events ever fire), which preserves tap-to-reveal +
  // 3s-fade UX on mobile.
  const lastInBottomZoneRef = useRef(false)
  // Audit H2 fix — track whether the server supplied a real
  // duration. When false (some files scan without ffprobe duration),
  // the `durationchange` listener takes the LATEST vid.duration
  // instead of locking the first (small) HLS-playlist value.
  const serverDurationRef = useRef(false)
  // Audit M4 fix — refs so the menu-open state is readable from
  // the video's onClick without participating in the closure dance.
  const audioMenuOpenRef = useRef(false)
  const subsMenuOpenRef = useRef(false)
  // Active <track> ref for cleanup when switching subs. Aurora exposes
  // sub extraction via /api/stream/{fileId}/subtitles/{index}.vtt
  // (V1's loadSubtitles path); we use the same.
  const activeTrackRef = useRef<HTMLTrackElement | null>(null)
  // Phase 5 — guard so the transcode fallback fires at most once per
  // target. Without this, a chronically broken codec would loop
  // (fallback to transcode → also fails → fallback again).
  const mediaErrorFallbackTriedRef = useRef<boolean>(false)

  // M10 Phase 4.5 — apply a subtitle track. Server exposes per-track
  // VTT extraction at /api/stream/{fileId}/subtitles/{index}?type=...
  // (V1 uses the same path). We add a <track> element with the URL
  // and switch the video element's TextTrack to showing. index=-1
  // turns subs off and removes the track element entirely.
  //
  // Audit M3 (Phase 4.5) — TextTrack promotion is async in some
  // browsers (Firefox especially). The setTimeout(0) trick would
  // fire before vid.textTracks contained the new track in those
  // cases, causing the "last index" loop to disable the wrong
  // tracks. We now poll for newTrack.track being non-null and
  // match by reference instead of by index.
  const applySubtitle = useCallback((index: number) => {
    if (!target) return
    const vid = videoRef.current
    if (!vid) return
    // Remove any existing track first.
    if (activeTrackRef.current) {
      try {
        if (activeTrackRef.current.parentNode) {
          activeTrackRef.current.parentNode.removeChild(activeTrackRef.current)
        }
      } catch { /* defensive */ }
      activeTrackRef.current = null
    }
    setCurrentSubIndex(index)
    if (index < 0) return
    // Inject a <track> child.
    const track = document.createElement('track')
    track.kind = 'subtitles'
    track.src = withToken(`/api/stream/${target.fileId}/subtitles/${index}?type=${target.fileType}`)
    track.default = true
    const meta = availableSubs.find(s => s.index === index)
    if (meta?.language) track.srclang = meta.language
    if (meta?.title || meta?.language) track.label = meta.title || meta.language || `Sub ${index}`
    vid.appendChild(track)
    activeTrackRef.current = track
    // Poll until the browser has promoted our <track> into
    // vid.textTracks, then enable it by reference. Max ~1s wait;
    // give up silently after that (browser is misbehaving).
    let tries = 0
    const promote = () => {
      tries++
      if (track.track) {
        for (let i = 0; i < vid.textTracks.length; i++) {
          vid.textTracks[i].mode = vid.textTracks[i] === track.track ? 'showing' : 'disabled'
        }
        return
      }
      if (tries < 30) setTimeout(promote, 33)
    }
    promote()
  }, [target, availableSubs])

  // Stable close handler — does NOT depend on `target`, so the
  // teardown effect's cleanup doesn't change identity across renders
  // (which would trigger spurious cleanup runs).
  const closeAndCleanup = useCallback(() => {
    // hls.js teardown — destroy() detaches the media source and
    // releases the worker thread. Skipping this leaks the segment
    // buffer; running it twice is a no-op.
    if (hlsRef.current) {
      try { hlsRef.current.destroy() } catch { /* defensive */ }
      hlsRef.current = null
    }
    const sid = sessionIdRef.current
    sessionIdRef.current = null
    if (sid) {
      // Best-effort — no await, just fire and forget. The server
      // GCs idle sessions anyway, so a missed DELETE costs at most
      // a few minutes of ffmpeg keepalive.
      void deleteSession(sid)
    }
    if (videoRef.current) {
      try {
        videoRef.current.pause()
        videoRef.current.removeAttribute('src')
        videoRef.current.load()
      } catch { /* defensive */ }
    }
  }, [])

  // Main play effect — runs when `target` changes from null → object
  // or from one target to another. Cleanup tears down the current
  // session before the next one starts so we never have two ffmpeg
  // processes running for one user.
  useEffect(() => {
    if (!target) return
    let cancelled = false
    const ac = new AbortController()

    setStatus('Loading…')
    setErrorMsg(null)
    sessionIdRef.current = null
    startSecRef.current = 0
    mediaErrorFallbackTriedRef.current = false
    // Audit M1 fix — reset session-bound playback state so the
    // scrub bar doesn't render with the OLD session's coords while
    // the new one boots. Without this, audio-track switches show a
    // visible "scrub bar flies to wrong position then snaps back"
    // glitch during the ~half-second transition between sessions.
    setCurrentSec(0)
    setBufferedSec(0)
    setRealDurationSec(0)
    setPlaying(false)
    serverDurationRef.current = false

    ;(async () => {
      try {
        // 1. Stream-info: server decides direct vs HLS.
        const info: StreamInfo = await getStreamInfo(target.fileId, target.fileType, ac.signal)
        if (cancelled) return
        const stream = info.stream
        // M10 Phase 4.5 — expose tracks for the picker.
        setAvailableAudio(info.audio_tracks || [])
        setAvailableSubs(info.subtitles || [])
        // Phase 7 — capture REAL source-file duration from the
        // server. This is what the custom controls' time display
        // shows; without it the user only sees the growing HLS
        // playlist duration, useless for syncing with friends.
        // Audit H2 fix — track whether we got an authoritative
        // value so the durationchange fallback below can take the
        // LATEST vid.duration on HLS (instead of locking the first
        // small one).
        serverDurationRef.current = !!(stream.duration_ms && stream.duration_ms > 0)
        if (serverDurationRef.current) {
          setRealDurationSec(stream.duration_ms! / 1000)
        } else {
          setRealDurationSec(0)
        }
        // Audit M2 (Phase 4.5) — preserve the user's subtitle
        // selection across audio-track switches. Audio switches
        // re-trigger the play effect (target identity changes); the
        // selected sub would otherwise reset to -1 (off). Capture
        // the prior index in a ref-like read here and reapply it
        // after the new session loads. The `applySubtitle` call
        // happens below, threaded into the HLS MANIFEST_PARSED /
        // direct-play canplay hooks.
        const subToRestore = currentSubIndex
        // Always clear the local <track> + state first; the new
        // session's <video> may have re-created its TextTracks list.
        if (activeTrackRef.current) {
          try {
            if (activeTrackRef.current.parentNode) {
              activeTrackRef.current.parentNode.removeChild(activeTrackRef.current)
            }
          } catch { /* defensive */ }
          activeTrackRef.current = null
        }
        setCurrentSubIndex(-1)

        const resumeSec = (target.resumePositionMs && target.resumePositionMs > 0)
          ? Math.floor(target.resumePositionMs / 1000)
          : 0

        if (stream.decision === 'direct_play' && stream.stream_url) {
          // Direct play: <video src> + token query param. The server's
          // token-promotion middleware whitelists /api/stream/, so the
          // ?token= rides safely.
          setStatus(`Direct Play · ${stream.video_codec ?? ''} / ${stream.audio_codec ?? ''}`)
          const vid = videoRef.current
          if (!vid) return
          vid.src = withToken(stream.stream_url)
          vid.load()
          if (resumeSec > 0) {
            // Wait for canplay so the seek lands inside a buffered
            // range — seeking before the metadata is parsed is a
            // no-op on most browsers.
            const onCanPlay = () => {
              vid.currentTime = resumeSec
              vid.removeEventListener('canplay', onCanPlay)
            }
            vid.addEventListener('canplay', onCanPlay)
          }
          // Audit M2 (Phase 4.5) — reapply the user's prior subtitle
          // selection once the new src is loadable.
          // Audit H1 (Phase 4.5 final-6) — only reapply if the
          // saved index actually exists in the NEW content's track
          // list. Different media items have different sub layouts;
          // a sub index from movie A may map to no track (or worse,
          // the wrong language) in episode B.
          const newSubs = info.subtitles || []
          if (subToRestore >= 0 && newSubs.some(s => s.index === subToRestore)) {
            const onCanPlayForSub = () => {
              applySubtitle(subToRestore)
              vid.removeEventListener('canplay', onCanPlayForSub)
            }
            vid.addEventListener('canplay', onCanPlayForSub)
          }
          try { await vid.play() } catch { /* autoplay-blocked, user clicks play */ }
          return
        }

        // 2. HLS path (transcode or direct_stream remux). Create the
        //    session first, then load the master playlist via hls.js.
        const sessionReq = {
          file_id: target.fileId,
          file_type: target.fileType,
          // Phase 5 — forceTranscode disables the server's remux
          // path (used by the MEDIA_ERROR auto-fallback to skip
          // straight to a full transcode on retry).
          remux: target.forceTranscode ? false : !!stream.remux,
          audio_passthrough: stream.audio_passthrough,
          // M10 Phase 4.5 — user-selected audio track override.
          // Passing a different index forces FFmpeg to map that
          // stream as audio_0; the session re-creates from scratch.
          audio_track_index: target.audioTrackIndex ?? stream.audio_track_index,
          audio_channels: stream.audio_channels,
          hdr_tonemap: stream.hdr_tonemap,
          video_codec: stream.video_codec,
          start_sec: resumeSec > 0 ? resumeSec : undefined,
        }
        const session = await createSession(sessionReq, ac.signal)
        if (cancelled) {
          // Race: cancelled between info and session — clean up the
          // just-created session before unwinding.
          void deleteSession(session.session_id)
          return
        }
        sessionIdRef.current = session.session_id
        startSecRef.current = session.start_sec ?? 0
        setStatus(
          stream.decision === 'direct_stream'
            ? `Remux · ${stream.container ?? 'hls'}`
            : `Transcode · ${stream.video_codec ?? ''}`
        )

        const masterUrl = withToken(session.master_playlist)
        const vid = videoRef.current
        if (!vid) return

        if (!Hls.isSupported()) {
          // Safari falls through to native HLS — hls.js doesn't run
          // here but the <video> element loads the m3u8 directly.
          // The ?token= query promotion handles auth.
          vid.src = masterUrl
          vid.load()
          try { await vid.play() } catch { /* autoplay-blocked */ }
          return
        }

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          // Generous timeouts — transcode sessions take a beat to
          // produce the first segment. V1 uses 15s for remux and 45s
          // for transcode; we don't have the decision split yet so
          // 30s is a middle ground.
          manifestLoadingTimeOut: 30000,
          manifestLoadingMaxRetry: 3,
          levelLoadingTimeOut: 30000,
          levelLoadingMaxRetry: 3,
          fragLoadingTimeOut: 30000,
          xhrSetup(xhr) {
            // Bearer token on every hls.js request. The xhrSetup
            // override is the supported extension point — we don't
            // need to monkey-patch the loader.
            const tok = localStorage.getItem('aurora_token')
            if (tok) xhr.setRequestHeader('Authorization', 'Bearer ' + tok)
          },
        })
        hlsRef.current = hls
        hls.loadSource(masterUrl)
        hls.attachMedia(vid)

        // When the server -ss'd, HLS time 0 IS the resume position
        // already, so don't seek client-side. When start_sec=0 but
        // resumeSec>0 (server didn't honour our offset for some
        // reason), fall back to client-side seek on MANIFEST_PARSED.
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (resumeSec > 0 && (session.start_sec ?? 0) === 0) {
            try { vid.currentTime = resumeSec } catch { /* defensive */ }
          }
          // Audit M2 (Phase 4.5) — reapply prior subtitle now that
          // the new HLS session is loaded.
          // Audit H1 (Phase 4.5 final-6) — only reapply if the
          // saved index is present in the NEW track list. See the
          // direct-play branch above for the rationale.
          const newSubsHls = info.subtitles || []
          if (subToRestore >= 0 && newSubsHls.some(s => s.index === subToRestore)) {
            applySubtitle(subToRestore)
          }
          vid.play().catch(() => { /* autoplay-blocked, user clicks play */ })
        })

        // Error handling — basic. V1's full ladder is in Phase 2.5.
        // We do the standard hls.js advisories: media errors → try
        // recoverMediaError once; network errors → startLoad to
        // resume after transient connectivity hiccups.
        //
        // Audit H2 (2026-05-16) — 401 detection. Aurora access tokens
        // expire after 15 minutes; movies are 90-120+. The xhrSetup
        // reads the token from localStorage synchronously, but if the
        // token expires and no other API call has triggered a
        // background refresh, segment XHRs will start 401-ing. hls.js
        // packages this as a NETWORK_ERROR; without intervention,
        // startLoad just re-fires the same expired token. Detect the
        // 401 specifically, force a refresh, then resume.
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (cancelled) return
          if (!data.fatal) return
          // Look for 401 in the response shape hls.js exposes.
          // `data.response?.code` is the standard place; `data.networkDetails`
          // can also be an XHR with .status.
          const status =
            (data.response && (data.response.code as number | undefined)) ??
            ((data.networkDetails as XMLHttpRequest | undefined)?.status)
          if (status === 401 && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            void (async () => {
              const refreshed = await forceTokenRefresh()
              if (cancelled) return
              if (refreshed) {
                try { hls.startLoad() } catch { setErrorMsg('Playback failed — token refresh') }
              } else {
                setErrorMsg('Session expired. Please sign in again.')
              }
            })()
            return
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            // Phase 5 — hardware-profile auto-fallback.
            //
            // V1's ladder: if a remux session hits MEDIA_ERROR (the
            // browser can't decode the source codecs even with
            // container rewrap), retry once with a full transcode
            // by re-emitting the play effect WITHOUT remux=true.
            //
            // Audit H2 (Phase 5.1 audit-7) — bail out if we're
            // ALREADY in the transcoded retry. Without this guard,
            // a chronically-broken codec loops: remux → MEDIA_ERROR
            // → setPlayerTarget(forceTranscode:true) → new identity
            // → effect re-runs → ref reset → transcode also fails →
            // setPlayerTarget(forceTranscode:true) AGAIN (no change
            // but identity churns) → loop. target.forceTranscode is
            // the unambiguous signal "we've already tried fallback;
            // don't try again."
            if (
              !mediaErrorFallbackTriedRef.current &&
              !target.forceTranscode &&
              stream.decision === 'direct_stream' &&
              onFallbackToTranscode
            ) {
              mediaErrorFallbackTriedRef.current = true
              setStatus('Remux failed — retrying with transcode…')
              // Tear down before re-emitting so the next session
              // starts clean.
              closeAndCleanup()
              onFallbackToTranscode()
              return
            }
            try { hls.recoverMediaError() } catch {
              setErrorMsg('Playback failed — media error')
              // Audit HIGH-2 (Phase 4.5 final) — fatal-non-recoverable
              // path. Without this teardown the hls instance stays
              // alive AND the keepalive interval keeps pinging the
              // server-side FFmpeg session for the lifetime of the
              // browser tab. The user sees an error screen and
              // walks away; FFmpeg burns CPU until tab close.
              closeAndCleanup()
            }
          } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            try { hls.startLoad() } catch {
              setErrorMsg('Playback failed — network error')
              closeAndCleanup()
            }
          } else {
            setErrorMsg('Playback failed — ' + (data.details ?? 'unknown'))
            closeAndCleanup()
          }
        })
      } catch (err) {
        if (cancelled) return
        if (err && (err as Error).name === 'AbortError') return
        const msg = err instanceof Error ? err.message : 'Failed to start playback'
        setErrorMsg(msg)
      }
    })()

    return () => {
      cancelled = true
      ac.abort()
      closeAndCleanup()
    }
    // currentSubIndex is read once to restore subtitles across target changes;
    // adding it as a dependency would restart playback when the user toggles subs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, closeAndCleanup])

  // Keepalive ticker — runs while a session is active. V1 uses 10s.
  // setInterval re-creates per session because sessionIdRef is a ref
  // (no re-render when it changes); the effect re-runs only on
  // target change, which is the right granularity.
  useEffect(() => {
    if (!target) return
    const id = window.setInterval(() => {
      const sid = sessionIdRef.current
      if (sid) void keepalive(sid)
    }, 10000)
    return () => window.clearInterval(id)
  }, [target])

  // M10 Phase 4 — party sync. Two responsibilities:
  //
  // 1. Guest mirror: every 1s, read party.tickRef. If party.tick.abs_ms
  //    maps to a hls.js position more than ~1s off from current play
  //    head, snap. If party.isPlaying differs from the local play
  //    state, sync the play/pause state.
  //
  // 2. Host broadcast: subscribe to video element's 'play', 'pause',
  //    'seeked' events. When the host triggers any of them naturally
  //    (NOT as a remote-apply), fire the corresponding party.request*
  //    callback.
  //
  // Audit H2 (Phase 4) — suppression of broadcast-echo from a remote
  // apply uses a MONOTONIC timestamp window rather than a boolean
  // flag + setTimeout. The boolean+timeout pattern released the latch
  // too early when multiple remote applies stacked (the first
  // setTimeout fires and clears the flag, even though later applies
  // haven't yet had their browser-echo events fire). The window
  // pattern extends with `Math.max(prev, now+150)` so every apply
  // pushes the gate forward; broadcasts inside the gate are silently
  // dropped, and the gate is naturally cleared by wall-clock time.
  const applyingRemoteUntilRef = useRef<number>(0)
  const isApplyingRemote = () => Date.now() < applyingRemoteUntilRef.current
  const extendSuppression = (ms = 150) => {
    applyingRemoteUntilRef.current = Math.max(applyingRemoteUntilRef.current, Date.now() + ms)
  }
  useEffect(() => {
    if (!target || !party) return
    const vid = videoRef.current
    if (!vid) return

    // Map abs_ms (source) → hls.js currentTime (HLS-relative seconds).
    // The session's start_sec is the FFmpeg -ss offset; hls time 0
    // corresponds to that offset in the source file.
    const absMsToHlsSec = (absMs: number) => Math.max(0, (absMs / 1000) - (startSecRef.current ?? 0))

    // Audit H3 (Phase 4.5 final-6) — only mirror when this player
    // is showing the SAME content as the party. If the user is
    // watching movie A locally while in a party watching show B,
    // mirroring would seek the local movie to nonsensical positions
    // based on the party's tick. We bail out at the top of every
    // mirror interval if the target's mediaItemId doesn't match
    // the party's. Resumes the moment the user clicks Play on the
    // party's media (handlePlay sets a new target with a matching
    // mediaItemId, the effect re-binds, mirroring fires).

    // Guest mirror tick — re-checks every 250ms. The faster cadence
    // (vs the 1s of Phase 4) is what makes rate-adjust effective:
    // we need to be sampling drift fast enough to converge inside
    // ~5 seconds at the 3% rate differential.
    //
    // M10 Phase 4.5 — drift correction port from V1 (aurora_pro.html
    // ~line 6484 `partyApplyTick`):
    //   |drift| < 200ms : no-op, ensure rate=1.0
    //   |drift| < 3000ms: gradient rate-adjust (1.03 catch-up, 0.97 ease-back)
    //   |drift| >= 3s   : hard-snap with seek-echo suppression
    //
    // We also extrapolate tick.abs_ms by (now - server_now_ms) when
    // the tick says running, so the target moves linearly between
    // ticks instead of jumping in 0.5-2s steps. Without extrapolation
    // the rate-adjust algorithm sees a sawtooth drift that it can't
    // converge on.
    const DRIFT_IGNORE_MS = 200
    const DRIFT_HARD_MS = 3000
    const RATE_UP = 1.03
    const RATE_DN = 0.97
    const id = window.setInterval(() => {
      // Host doesn't pull from server tick (it IS the source of truth).
      if (party.isHost) return
      // Audit H3 — bail out if the local player isn't showing the
      // party's media. Avoids cross-content seeks.
      if (party.partyMediaItemId !== undefined && party.partyMediaItemId !== target.mediaItemId) return
      const t = party.tickRef.current
      if (!t) return
      // Play/pause mirror — use the server's isPlaying as authority.
      // Do this BEFORE drift checking so we don't try to seek a
      // paused player.
      if (party.isPlaying && vid.paused) {
        extendSuppression(150)
        vid.play().catch(() => { /* autoplay-blocked */ })
      } else if (!party.isPlaying && !vid.paused) {
        extendSuppression(150)
        vid.pause()
        // Ensure rate is reset to 1.0 on pause so when we resume
        // we're not still in catch-up mode from a previous drift.
        if (vid.playbackRate !== 1.0) vid.playbackRate = 1.0
      }
      // Skip drift correction when paused — abs_ms shouldn't be
      // advancing and snapping during pause causes spurious echoes
      // (audit M4 Phase 4).
      if (t.running === false || !party.isPlaying) return
      // Audit M5 (Phase 4.5) — also skip while the video is still
      // paused (buffering / autoplay-blocked / play() in flight).
      // The play() call above is async; the next 250ms tick will
      // re-evaluate once vid.paused has flipped to false. Running
      // drift while paused snaps to a position the video hasn't
      // yet started playing from — visually janky.
      if (vid.paused) return

      // Extrapolate the tick by elapsed wall-clock since the server
      // emitted it. If the tick is older than ~3s, fall back to its
      // own abs_ms (server might be stalled or we're disconnected).
      const elapsedMs = Math.max(0, Date.now() - t.server_now_ms)
      const projectedAbsMs = elapsedMs > 3000 ? t.abs_ms : (t.abs_ms + elapsedMs)
      const targetSec = absMsToHlsSec(projectedAbsMs)
      const localSec = vid.currentTime
      const driftMs = (localSec - targetSec) * 1000
      const absDrift = Math.abs(driftMs)

      if (absDrift < DRIFT_IGNORE_MS) {
        if (vid.playbackRate !== 1.0) vid.playbackRate = 1.0
        return
      }
      if (absDrift >= DRIFT_HARD_MS) {
        // Hard-snap. Suppress the resulting seeked echo (the local
        // listener would re-broadcast as request-seek otherwise —
        // ping-pong). Reset rate to 1.0 since we just teleported.
        extendSuppression(300)
        try { vid.currentTime = targetSec } catch { /* defensive */ }
        vid.playbackRate = 1.0
        return
      }
      // Small drift: rate-adjust. Behind → speed up; ahead → slow down.
      vid.playbackRate = driftMs < 0 ? RATE_UP : RATE_DN
    }, 250)

    // Host broadcast — only fire on local-origin events. Audit H3
    // — also bail out if the host's local player is on a different
    // media than the party's; broadcasting from the wrong content
    // would corrupt the party's currentTimeMs.
    const hostShouldBroadcast = () =>
      party.isHost &&
      !isApplyingRemote() &&
      (party.partyMediaItemId === undefined || party.partyMediaItemId === target.mediaItemId)
    const onPlay = () => {
      if (!hostShouldBroadcast()) return
      party.requestPlay()
    }
    const onPause = () => {
      if (!hostShouldBroadcast()) return
      const absMs = Math.round((vid.currentTime + (startSecRef.current ?? 0)) * 1000)
      party.requestPause(absMs)
    }
    const onSeeked = () => {
      if (!hostShouldBroadcast()) return
      const absMs = Math.round((vid.currentTime + (startSecRef.current ?? 0)) * 1000)
      party.requestSeek(absMs)
    }
    vid.addEventListener('play', onPlay)
    vid.addEventListener('pause', onPause)
    vid.addEventListener('seeked', onSeeked)

    return () => {
      window.clearInterval(id)
      vid.removeEventListener('play', onPlay)
      vid.removeEventListener('pause', onPause)
      vid.removeEventListener('seeked', onSeeked)
    }
  // party.isPlaying changes drive re-bind so the play/pause mirror
  // is current. partyMediaItemId is in deps so the H3 guard
  // re-evaluates when the party media changes. The refs inside
  // party (tickRef, helloAbsMsRef) are mutable across renders
  // without retriggering — exactly what we want for high-frequency
  // tick data.
  }, [target, party, party?.isHost, party?.isPlaying, party?.partyMediaItemId])

  // Phase 7 — sync custom-controls state with the <video> element.
  // We mirror playback events into React state so PlayerControls
  // can render reactively. Heart of the system:
  //   - 'play'/'pause' → playing
  //   - 'timeupdate' → currentSec (in REAL-FILE coords via the
  //     session's startSec offset)
  //   - 'progress' → bufferedSec (transcoder progress visualizer)
  //   - 'durationchange' → realDurationSec fallback when server's
  //     duration_ms is missing
  //   - 'volumechange' → volume + muted
  //   - 'fullscreenchange' (document-level) → fullscreen
  //
  // Throttle timeupdate to ~4Hz manually since the browser fires
  // it at ~250ms by default but in tight resize/animation loops it
  // can fire faster — we don't need sub-second precision for the
  // displayed time and re-rendering React on every fire is wasteful.
  useEffect(() => {
    const vid = videoRef.current
    if (!vid) return
    const lastTUpdateRef = { current: 0 }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onTimeUpdate = () => {
      const now = performance.now()
      if (now - lastTUpdateRef.current < 200) return // ~5Hz cap
      lastTUpdateRef.current = now
      setCurrentSec(vid.currentTime + (startSecRef.current ?? 0))
    }
    const onProgress = () => {
      // Audit H4 fix — TimeRanges can be non-contiguous after a
      // backward seek (hls.js evicts forward buffer + builds a new
      // range at the new position). The previous code took the
      // LAST range's end, which would overstate buffering by
      // claiming "buffered to t=600" when current playback is at
      // t=50 with only [0,200] actually loaded. Now: find the
      // range CONTAINING vid.currentTime and report its end.
      const b = vid.buffered
      const t = vid.currentTime
      let bestEnd = t
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= t && b.end(i) > bestEnd) bestEnd = b.end(i)
      }
      setBufferedSec(bestEnd + (startSecRef.current ?? 0))
    }
    const onDurationChange = () => {
      // Audit H2 fix — when the server supplied an authoritative
      // duration (ffprobe at scan time), skip the fallback
      // entirely. Otherwise take the LATEST vid.duration —
      // critical for HLS where vid.duration GROWS as the playlist
      // arrives. The old `prev > 0 ? prev : vid.duration` locked
      // the first small (~6s) HLS-playlist value and never
      // updated; the new Math.max(prev, current) converges on the
      // real duration as the playlist completes.
      if (!Number.isFinite(vid.duration) || vid.duration <= 0) return
      if (serverDurationRef.current) return
      setRealDurationSec(prev => Math.max(prev, vid.duration))
    }
    const onVolumeChange = () => {
      setVolume(vid.volume)
      setMuted(vid.muted)
    }
    const onFullscreenChange = () => {
      setFullscreen(document.fullscreenElement === overlayRootRef.current)
    }
    vid.addEventListener('play', onPlay)
    vid.addEventListener('pause', onPause)
    vid.addEventListener('timeupdate', onTimeUpdate)
    vid.addEventListener('progress', onProgress)
    vid.addEventListener('durationchange', onDurationChange)
    vid.addEventListener('volumechange', onVolumeChange)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    // Hydrate initial state from the element (it may already be
    // playing if we're re-mounting on a target change).
    setPlaying(!vid.paused)
    setVolume(vid.volume)
    setMuted(vid.muted)
    return () => {
      vid.removeEventListener('play', onPlay)
      vid.removeEventListener('pause', onPause)
      vid.removeEventListener('timeupdate', onTimeUpdate)
      vid.removeEventListener('progress', onProgress)
      vid.removeEventListener('durationchange', onDurationChange)
      vid.removeEventListener('volumechange', onVolumeChange)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
    }
  }, [target])

  // Audit H1 fix — stable showControlsTemporarily reads playingRef
  // (not the captured `playing` value). The useCallback has empty
  // deps so its identity is stable across renders; effects and
  // handlers that reference it never see a stale closure.
  //
  // Pin state (Phase 8 follow-up) — `lastInBottomZoneRef` tracks
  // whether the cursor was last seen in the bottom intent zone of
  // the player (the "I'm reaching for the seek bar" region). When
  // true, controls show but the auto-hide timer is NOT scheduled.
  // Reading the ref inside this function means every caller
  // (mousemove, keyboard shortcut, touch, play/pause effect) gets
  // pin behavior consistent with the user's actual cursor
  // position — without having to remember to pass a flag. Matches
  // Netflix/YouTube/Plex behavior; fixes "older resolution videos
  // hide the controls" complaint from passive viewers.
  // 2026-05-20 — auto-hide TEMPORARILY disabled. Production
  // reproed a bug where controls would hide at the 3s timer and
  // never reappear on hover/click despite three layered fixes
  // (React-19 inert rewrite, click handler showControls call,
  // document-level mousemove listener). Without a way to debug
  // live, the failure mode in front of users is "stuck hidden,
  // can't pause" which is much worse than "always visible."
  //
  // Reverting to always-visible during playback is a UX
  // regression (chrome over the bottom edge of the video) but
  // unblocks playback. Re-enable auto-hide after we can repro
  // the stuck-hidden bug locally with DevTools open.
  //
  // The setTimeout + ref machinery is preserved so callers
  // (mousemove handler, keyboard shortcut, click handler) can
  // still call showControlsTemporarily() without changes — it
  // just becomes setControlsVisible(true) and nothing else.
  const showControlsTemporarily = useCallback(() => {
    setControlsVisible(true)
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    // Auto-hide schedule disabled — see comment above.
  }, [])

  // Phase 7 — controls visibility timer driven by play/pause flip.
  // Pause → instantly visible (no timer). Play → visible + schedule
  // fade. Cleanup clears any pending timer on unmount.
  useEffect(() => {
    playingRef.current = playing
    showControlsTemporarily()
    return () => {
      if (hideTimerRef.current) {
        window.clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [playing, showControlsTemporarily])

  // 2026-05-20 — document-level mousemove + keydown backstop.
  //
  // The wrapper-div's onMouseMove was sometimes failing to bring
  // controls back during playback (reproduced in production:
  // controls hide at the 3s timer, then mouse hover doesn't
  // re-reveal them). Suspected causes: an inert/pointer-events
  // ancestor in the React tree, an event-target weirdness with
  // the fullscreen-style overlay, or React 19's synthetic-event
  // pipeline interacting unexpectedly with the `cursor: none`
  // style we apply when controls are hidden.
  //
  // Document-level listeners bypass all of that — if the user
  // moves the mouse or presses a key ANYWHERE on the page, we
  // know they're active and want controls back.
  //
  // Gated on `target` (audit HIGH) — VideoPlayer is rendered
  // unconditionally from App.tsx; the early-return-null happens
  // AFTER hooks run, so without this gate the listeners would
  // fire continuously across the entire app session even when
  // no video is open.
  //
  // keydown skips editable targets (audit MED) — matches the
  // existing keyboard-shortcut effect below in this same file
  // (the one that handles space/arrow shortcuts). PartyPanel's
  // chat input is a sibling of VideoPlayer in the DOM, so a
  // global keydown listener would otherwise reveal controls on
  // every chat keystroke.
  useEffect(() => {
    if (!target) return
    const mouseHandler = () => showControlsTemporarily()
    const keyHandler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const inEditable = !!t && (
        t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
      )
      if (inEditable) return
      showControlsTemporarily()
    }
    document.addEventListener('mousemove', mouseHandler)
    document.addEventListener('keydown', keyHandler)
    document.addEventListener('touchstart', mouseHandler)
    return () => {
      document.removeEventListener('mousemove', mouseHandler)
      document.removeEventListener('keydown', keyHandler)
      document.removeEventListener('touchstart', mouseHandler)
    }
  }, [target, showControlsTemporarily])

  // Keep menu-open refs in sync with state for the click-outside
  // dismiss path (audit M4).
  useEffect(() => { audioMenuOpenRef.current = audioMenuOpen }, [audioMenuOpen])
  useEffect(() => { subsMenuOpenRef.current = subsMenuOpen }, [subsMenuOpen])

  // Phase 7 — document-level keyboard shortcuts while the player is
  // open. Space=play/pause, ArrowLeft/Right=seek±10s, ArrowUp/Down
  // = volume, F=fullscreen, M=mute. Skipped when the user is typing
  // in an editable element (chat input, etc.) so we don't steal
  // keystrokes from elsewhere.
  useEffect(() => {
    if (!target) return
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const inEditable = !!t && (
        t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
      )
      if (inEditable) return
      // Audit M3 fix — don't steal Space/Enter from focused buttons.
      // The audio/subs menu items + control buttons rely on the
      // browser synthesizing a click for Space/Enter on a focused
      // <button>. If we preventDefault here, the menu items
      // become unactivatable via keyboard.
      if (t && t.closest && t.closest('button') && (e.key === ' ' || e.key === 'Enter')) {
        return
      }
      const vid = videoRef.current
      if (!vid) return
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          if (vid.paused) void vid.play().catch(() => { /* defensive */ })
          else vid.pause()
          break
        case 'ArrowLeft':
          e.preventDefault()
          vid.currentTime = Math.max(0, vid.currentTime - 10)
          break
        case 'ArrowRight':
          e.preventDefault()
          vid.currentTime = vid.currentTime + 10
          break
        case 'ArrowUp':
          e.preventDefault()
          vid.volume = Math.min(1, vid.volume + 0.05)
          break
        case 'ArrowDown':
          e.preventDefault()
          vid.volume = Math.max(0, vid.volume - 0.05)
          break
        case 'm':
        case 'M':
          e.preventDefault()
          vid.muted = !vid.muted
          break
        case 'f':
        case 'F':
          e.preventDefault()
          handleFullscreenToggle()
          break
      }
      showControlsTemporarily()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  // Fullscreen toggle. Some browsers reject requestFullscreen
  // without a user gesture; we treat rejection as "no fullscreen
  // for you" silently rather than surfacing an error.
  const handleFullscreenToggle = () => {
    const el = overlayRootRef.current
    if (!el) return
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => { /* defensive */ })
    } else {
      void el.requestFullscreen().catch(() => { /* defensive */ })
    }
  }

  // Audit H2 — pre-emptive token refresh during long playback. Aurora's
  // access tokens last 15 minutes; we refresh every 12 to keep a buffer.
  // The refresh is silent (apiFetch background path) and updates
  // localStorage so the NEXT segment XHR via hls.js's xhrSetup picks up
  // the fresh token. This complements the 401 error-handler above —
  // belt + suspenders. Without this, hls.js can fire segment requests
  // for up to ~1 minute with an expired token before the error handler
  // kicks in (hls.js's own retry budget).
  useEffect(() => {
    if (!target) return
    const id = window.setInterval(() => {
      void forceTokenRefresh()
    }, 12 * 60 * 1000)
    return () => window.clearInterval(id)
  }, [target])

  // Progress reporter — runs every 10s while playing. Matches V1's
  // cadence (aurora_pro.html:4651). Skips when paused or no duration
  // is known yet. Adds back the server-side -ss offset so the stored
  // position is in source-file coordinates, not hls.js coordinates.
  useEffect(() => {
    if (!target) return
    const id = window.setInterval(() => {
      const vid = videoRef.current
      if (!vid || vid.paused) return
      const offsetMs = (startSecRef.current ?? 0) * 1000
      const posMs = Math.round(vid.currentTime * 1000) + offsetMs
      const durMs = Math.round((vid.duration || 0) * 1000) + offsetMs
      if (durMs <= 0) return
      void reportProgress(target.mediaItemId, {
        position_ms: posMs,
        duration_ms: durMs,
        episode_id: target.episodeId,
      }).catch(() => { /* fire-and-forget */ })
    }, 10000)
    return () => window.clearInterval(id)
  }, [target])

  if (!target) return null

  return (
    <div
      ref={overlayRootRef}
      // Phase 7 — mouse/touch on the overlay (anywhere, including
      // letterbox bars) reveals the controls. Same handler also
      // schedules the auto-hide. Prevents the "cursor over black
      // letterbox doesn't trigger native controls" Chrome+Mac bug
      // since OUR overlay renders independently of cursor-over-
      // video state.
      //
      // Phase 8 follow-up — intent-zone pin. When the cursor is in
      // the bottom ~22% of the PLAYER (where the seek bar + button
      // row live), treat it as "user is reaching for controls" and
      // keep them visible indefinitely. Without this, passive
      // viewers (esp. older shows where the watcher rarely touches
      // the mouse mid-episode) lose controls after 3s and have no
      // affordance to find them — which is why the bug surfaced as
      // "older resolution videos hide the controls."
      //
      // Audit M1 (deep-debug round 2) — math is relative to the
      // overlay's own bounding rect (NOT `window.innerHeight`) so
      // it survives any future wrapping/margins around the player.
      // For today's `fixed inset-0` overlay the two are equal, but
      // tying the threshold to the actual element is more robust.
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const bottomZoneThreshold = rect.top + rect.height * 0.78
        lastInBottomZoneRef.current = e.clientY >= bottomZoneThreshold
        showControlsTemporarily()
      }}
      onTouchStart={() => showControlsTemporarily()}
      // Hide the cursor when the controls auto-hide so the screen
      // is fully chrome-less while watching. Reappears on the next
      // mousemove (which also un-hides the controls via the handler
      // above). Matches Plex/Netflix/YouTube behavior.
      style={{ cursor: controlsVisible ? 'auto' : 'none' }}
      className="fixed inset-0 z-[60] bg-black/95 flex items-center justify-center"
    >
      <div className="relative w-full h-full flex flex-col">
        {/* Top bar */}
        <div className="flex items-center justify-between px-6 py-3 bg-gradient-to-b from-black/80 to-transparent z-10">
          <div>
            <h2 className="text-white text-lg font-semibold">{target.title}</h2>
            {target.subtitle && <p className="text-white/60 text-sm">{target.subtitle}</p>}
            <p className="text-white/40 text-xs mt-0.5">{status}</p>
          </div>
          <div className="flex items-center gap-2 relative">
            {/* M10 Phase 4.5 — Audio track picker. Only shown when
                more than one audio track exists. Switching forces
                a session re-create (FFmpeg maps audio_0 at session
                spawn) — that's why this is a click-and-rebuild
                pattern, not a hls.js property toggle. */}
            {availableAudio.length > 1 && (
              <div className="relative">
                <button
                  onClick={() => { setAudioMenuOpen(o => !o); setSubsMenuOpen(false) }}
                  className="px-3 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg text-sm transition-colors"
                  aria-label="Audio tracks"
                  title="Audio tracks"
                >
                  Audio
                </button>
                {audioMenuOpen && (
                  <div className="absolute top-full right-0 mt-1 w-64 max-h-80 overflow-y-auto bg-[#1a1a22] border border-white/[0.08] rounded-lg shadow-xl z-20 py-1">
                    {availableAudio.map(a => (
                      <button
                        key={a.index}
                        onClick={() => {
                          setAudioMenuOpen(false)
                          if (onChangeAudioTrack) {
                            // Audit M2 — capture live position
                            // in REAL-FILE ms (local vid.currentTime
                            // PLUS the session's startSec offset)
                            // so the parent rebuilds the session
                            // resuming from where we are right now.
                            const vid = videoRef.current
                            const liveMs = vid
                              ? Math.round((vid.currentTime + (startSecRef.current ?? 0)) * 1000)
                              : 0
                            onChangeAudioTrack(a.index, liveMs)
                          }
                        }}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-white/[0.06] transition-colors ${
                          (target.audioTrackIndex ?? -2) === a.index ? 'text-purple-300' : 'text-white/80'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span>{a.title || a.language || `Track ${a.index}`}</span>
                          <span className="text-white/40 text-xs">{a.codec}{a.channels ? ` · ${a.channels}ch` : ''}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* M10 Phase 4.5 — Subtitle picker. Off + each available
                track. Subtitle switching is seamless (no session
                rebuild); applySubtitle handles add/remove of the
                <track> element. */}
            {availableSubs.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => { setSubsMenuOpen(o => !o); setAudioMenuOpen(false) }}
                  className="px-3 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg text-sm transition-colors"
                  aria-label="Subtitles"
                  title="Subtitles"
                >
                  CC
                </button>
                {subsMenuOpen && (
                  <div className="absolute top-full right-0 mt-1 w-64 max-h-80 overflow-y-auto bg-[#1a1a22] border border-white/[0.08] rounded-lg shadow-xl z-20 py-1">
                    <button
                      onClick={() => { applySubtitle(-1); setSubsMenuOpen(false) }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-white/[0.06] transition-colors ${
                        currentSubIndex === -1 ? 'text-purple-300' : 'text-white/80'
                      }`}
                    >
                      Off
                    </button>
                    {availableSubs.map(s => (
                      <button
                        key={s.index}
                        onClick={() => { applySubtitle(s.index); setSubsMenuOpen(false) }}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-white/[0.06] transition-colors ${
                          currentSubIndex === s.index ? 'text-purple-300' : 'text-white/80'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span>{s.title || s.language || `Sub ${s.index}`}</span>
                          {s.forced && <span className="text-amber-300 text-[10px] uppercase">forced</span>}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* M10 Phase 4.5 — reaction picker (party only). */}
            {onSendReaction && (
              <ReactionPicker onSend={onSendReaction} />
            )}
            <button
              onClick={onClose}
              className="px-4 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg text-sm transition-colors"
              aria-label="Close player"
            >
              Close
            </button>
          </div>
        </div>

        {/* Video */}
        {/* 2026-05-20 — `min-h-0` is the canonical Tailwind/flexbox fix
            for the "child overflows flex parent by N pixels" bug. By
            default, a flex child gets `min-height: auto` which prevents
            it from shrinking below its intrinsic content size. With a
            <video object-contain> child, that intrinsic size depends
            on the video's natural dimensions and can exceed the
            available flex space — pushing the container's bottom past
            the viewport.
            Symptom in production: controls (positioned `absolute bottom-0`
            of this container) rendered 1.25px below the viewport,
            invisible behind macOS browser chrome / dock. DevTools
            opening triggered a layout recompute that pulled things
            back into view, which is why the bug only surfaced
            "without DevTools open."
            `overflow-hidden` is belt-and-suspenders — if any future
            child still overflows for some reason, it clips visually
            instead of pushing absolute-positioned descendants past
            the viewport. */}
        <div className="flex-1 min-h-0 flex items-center justify-center bg-black relative overflow-hidden">
          {errorMsg ? (
            <div className="text-center px-8">
              <p className="text-red-400 text-lg font-medium">Playback Error</p>
              <p className="text-white/60 text-sm mt-2 max-w-md">{errorMsg}</p>
              <button
                onClick={onClose}
                className="mt-6 px-6 py-2.5 bg-white/10 hover:bg-white/15 text-white rounded-lg text-sm transition-colors"
              >
                Back
              </button>
            </div>
          ) : (
            <>
              {/* Phase 7 — native `controls` attribute REMOVED. Our
                  custom PlayerControls overlay below renders the
                  full controls UI, with REAL source-file duration
                  (not the growing HLS playlist length) so users
                  can sync with friends. */}
              <video
                ref={videoRef}
                className="w-full h-full object-contain cursor-pointer"
                playsInline
                preload="auto"
                // Click on the video toggles play/pause. Mirrors
                // YouTube/Plex muscle memory.
                // Audit M4 fix — if a menu (audio/subs picker) is
                // open, the click should DISMISS the menu, not
                // toggle play. Otherwise users get a "I clicked
                // outside the menu and now the video paused" jank.
                onClick={() => {
                  if (audioMenuOpenRef.current || subsMenuOpenRef.current) {
                    setAudioMenuOpen(false)
                    setSubsMenuOpen(false)
                    return
                  }
                  // 2026-05-20 — reveal controls on EVERY click,
                  // not just on state-changing ones. Previously
                  // controls came back via the [playing]-effect
                  // when play/pause state flipped, but if vid.play()
                  // promise-rejected silently (autoplay policy,
                  // suspended audio context) the state wouldn't
                  // change and controls stayed hidden — operator
                  // saw "I clicked the video and nothing happened".
                  showControlsTemporarily()
                  const vid = videoRef.current
                  if (!vid) return
                  if (vid.paused) void vid.play().catch(() => { /* defensive */ })
                  else vid.pause()
                }}
              />
              <PlayerControls
                playing={playing}
                currentSec={currentSec}
                durationSec={realDurationSec}
                bufferedSec={bufferedSec}
                volume={volume}
                muted={muted}
                fullscreen={fullscreen}
                visible={controlsVisible}
                onPlayPause={() => {
                  const vid = videoRef.current
                  if (!vid) return
                  if (vid.paused) void vid.play().catch(() => { /* defensive */ })
                  else vid.pause()
                }}
                onSeek={(sec) => {
                  // Map a REAL-FILE second back into the local
                  // video element's currentTime by subtracting the
                  // session's startSec offset.
                  const vid = videoRef.current
                  if (!vid) return
                  const localSec = sec - (startSecRef.current ?? 0)
                  // Backward-seek BEFORE the session's start_sec
                  // offset isn't possible without session rebuild;
                  // clamp to the start of the local timeline.
                  if (localSec < 0) {
                    try { vid.currentTime = 0 } catch { /* defensive */ }
                    return
                  }
                  // Audit H3 fix — forward-seek past the buffered
                  // range stalls hls.js indefinitely (the
                  // transcoder is sequential; segments past the
                  // current FFmpeg output position aren't on disk
                  // yet). Detect by checking if the requested local
                  // sec exceeds the buffered-range end. Clamp to a
                  // safe spot just inside the buffered range and
                  // surface a status hint so the user understands
                  // why the seek didn't jump all the way.
                  const safeBufferedEnd = bufferedSec - (startSecRef.current ?? 0)
                  if (safeBufferedEnd > 0 && localSec > safeBufferedEnd) {
                    try {
                      // Land 1s back from the buffered edge to
                      // avoid landing right at the boundary where
                      // hls.js stalls waiting for the next segment.
                      vid.currentTime = Math.max(0, safeBufferedEnd - 1)
                    } catch { /* defensive */ }
                    setStatus('Still transcoding to that point — try again in a moment')
                    return
                  }
                  try {
                    vid.currentTime = localSec
                  } catch { /* defensive */ }
                }}
                onSeekRelative={(delta) => {
                  const vid = videoRef.current
                  if (!vid) return
                  try {
                    vid.currentTime = Math.max(0, vid.currentTime + delta)
                  } catch { /* defensive */ }
                }}
                onVolumeChange={(v) => {
                  const vid = videoRef.current
                  if (!vid) return
                  vid.volume = v
                  // Setting volume>0 also implicitly unmutes — match
                  // YouTube/Netflix behavior so the user doesn't get
                  // a "no sound after dragging slider up" surprise.
                  if (v > 0 && vid.muted) vid.muted = false
                }}
                onMuteToggle={() => {
                  const vid = videoRef.current
                  if (!vid) return
                  vid.muted = !vid.muted
                }}
                onFullscreenToggle={handleFullscreenToggle}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
