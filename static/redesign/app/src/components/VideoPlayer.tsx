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
import { Airplay, Cast, Maximize2, Pause, Play, SkipForward, StopCircle, X } from 'lucide-react'
import {
  deleteSkipMarker,
  forceTokenRefresh,
  getAdminSkipMarkers,
  putSkipMarker,
  type EpisodeFile,
  type MediaFile,
  type SkipMarker,
  reportProgress,
  withToken,
} from '@/lib/api'
import { ReactionPicker } from './ReactionOverlay'
import { PlayerControls } from './PlayerControls'
import {
  createCastToken,
  createSession,
  deleteSession,
  getStreamInfo,
  keepalive,
  type AudioTrack,
  type StreamInfo,
  type SubtitleTrack,
} from '@/lib/streaming'
import { absoluteUrl, assertCastScopedToken, useCast } from '@/lib/cast'

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
  // receivedAtMs is client-local (Date.now() at frame receipt, stamped by
  // useParty) — the drift loop's clock-skew-free staleness signal.
  tickRef: React.MutableRefObject<{ abs_ms: number; server_now_ms: number; running?: boolean; rev?: number; receivedAtMs?: number } | null>
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
  // 2026-05-25 — NTP-style clock offset from server in ms. Lets the
  // drift loop's `Date.now() - tick.server_now_ms` extrapolation work
  // when client + server clocks aren't aligned. Optional because the
  // first time-sync round-trip takes ~50ms after sync-socket open;
  // when undefined OR null on first render we just don't apply it
  // (the drift loop falls back to assuming offset = 0, same as before).
  clockOffsetRef?: React.MutableRefObject<number>
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
  // Issue #177 — the season/episode NUMBERS of the currently-playing
  // episode (not IDs). Required so auto-play-next can resolve "what
  // comes after this" without re-deriving position from episodeId.
  // Undefined for movies and for any episode target that couldn't
  // supply them (auto-advance simply no-ops in that case).
  seasonNumber?: number
  episodeNumber?: number
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
  // 2026-05-27 — Forward-seek session rebuild. Aurora's transcoder is
  // sequential (segments past the current FFmpeg output position
  // aren't on disk), so a normal forward-seek past the buffered range
  // would stall hls.js indefinitely. The old behavior clamped the
  // seek to the buffered edge and toasted "Still transcoding to that
  // point — try again in a moment." Now: when this callback is wired,
  // the player asks the parent to tear down + re-create the HLS
  // session anchored at the new `start_sec` (mirroring the
  // onChangeAudioTrack path), so the user can scrub anywhere. The
  // parent should NOT wire this when in a watch party (party seek
  // broadcasts assume same-session timing; a unilateral session
  // rebuild on the host would drift the guests). Argument is in real-
  // file seconds (the absolute media position, NOT video element
  // currentTime), matching what the scrubber emits to onSeek.
  onSeekRebuild?: (newStartSec: number) => void
  // Issue #177 — fires once when playback reaches the natural end of
  // the media: the local <video> 'ended' event, OR (when casting) the
  // receiver flipping to IDLE. The parent decides whether to auto-advance
  // to the next episode (gated on the user's autoplay preference,
  // episode-vs-movie, party state, etc.) — the player itself stays dumb
  // about the episode graph. Returns whether it advanced; the cast path
  // awaits this to decide between re-pointing the receiver and stopping.
  //
  // Smart Skip — the credits-triggered "Next Episode" card drives the
  // SAME callback early (before the media actually ends). When the
  // user explicitly clicks the card's button, `force: true` asks the
  // parent to advance even with the autoplay preference off — an
  // explicit click outranks the passive-behavior setting.
  onEnded?: (opts?: { force?: boolean }) => boolean | Promise<boolean>
  // Reports whether the player has collapsed to the cast/AirPlay control
  // widget, so the parent can suppress Escape/back-to-close while casting.
  onMinimizedChange?: (minimized: boolean) => void
  // Smart Skip — gates the in-player marker editor (manual correction
  // writes through admin-only endpoints, so the UI only mounts for
  // admins).
  isAdmin?: boolean
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

// Smart Skip — read the "Auto-play next episode" preference straight
// from the aurora_prefs localStorage bucket, the same cross-component
// source of truth App.tsx's handlePlay / handlePlaybackEnded use.
// Default ON, matching the Settings toggle's own default. Decides
// whether the credits-triggered next-up card counts down on its own
// (autoplay) or waits for an explicit click (prompt).
function readAutoplayPref(): boolean {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('aurora_prefs') || '{}')
    if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).autoplay === false) {
      return false
    }
  } catch { /* malformed prefs — keep default (autoplay ON) */ }
  return true
}

// 2026-05-28 — Lift subtitle cues clear of the bottom control bar.
//
// With native <track> rendering AND our custom controls (the native
// `controls` attribute is removed — see the <video> below), the
// browser doesn't raise cues above the control overlay the way it
// does for native controls. So a low cue (e.g. Elf's "TO THE BIG
// CITY") renders right behind the scrubber. We pin every cue to
// line 90 with snapToLines=false → the cue box sits at ~90% of the
// video height (≈10% up from the bottom), which clears the ~80px
// control bar at any window size, while still reading as a normal
// bottom-anchored subtitle when controls are hidden.
//
// Aurora's text tracks are extracted from SRT/embedded subs and
// carry no authored positioning, so overriding `line` never fights
// an author's intentional top-of-frame sign placement for our
// content. Wrapped per-cue in try/catch because a few engines throw
// on out-of-range line values for cues with unusual settings.
const CUE_LINE_PERCENT = 90
function liftCuesAboveControls(tt: TextTrack | null | undefined): void {
  if (!tt || !tt.cues) return
  for (let i = 0; i < tt.cues.length; i++) {
    const cue = tt.cues[i] as VTTCue
    try {
      // Only adjust cues still at the default (auto) position so we
      // don't stomp any cue that DID carry explicit placement.
      if (cue.line === 'auto') {
        cue.snapToLines = false
        // lineAlign='end' anchors the BOTTOM of the cue box at
        // CUE_LINE_PERCENT, so multi-line cues grow UPWARD (away from
        // the controls) instead of downward off the bottom edge.
        // Deep-debug M1 — without this, a 2-3 line cue at line=90 with
        // the default 'start' align would push its tail under the
        // scrubber / past the rounded bottom.
        cue.lineAlign = 'end'
        cue.line = CUE_LINE_PERCENT
      }
    } catch { /* engine rejected the assignment — leave this cue as-is */ }
  }
}

// 2026-06 streaming review (P2) — seed hls.js's bandwidth estimator from the
// last session instead of its 500 kbps factory default. That default sits
// below every tier Aurora's ABR ladder declares (480p = 2.2 Mbps), so hls.js
// started EVERY transcode at the lowest rung — 480p on a gigabit LAN — and
// only ramped after measuring real fragments (each up-switch also cold-starts
// a new FFmpeg variant server-side). Persisting the measured estimate makes
// the second-and-later plays start at the right tier immediately; the first
// ever play uses a LAN-appropriate 8 Mbps prior. Clamped so one weird sample
// (dev-tools throttling, a flaky hotel wifi session) can't poison the seed
// outside sane bounds.
const BW_ESTIMATE_KEY = 'aurora_bw_estimate'
const BW_ESTIMATE_DEFAULT = 8_000_000
const BW_ESTIMATE_MIN = 1_000_000
const BW_ESTIMATE_MAX = 200_000_000

// Single clamp shared by load and save so the persisted and applied bounds
// can never diverge.
function clampBandwidth(bps: number): number {
  return Math.min(BW_ESTIMATE_MAX, Math.max(BW_ESTIMATE_MIN, bps))
}

function loadBandwidthEstimate(): number {
  try {
    const raw = localStorage.getItem(BW_ESTIMATE_KEY)
    const n = raw ? Number(raw) : NaN
    if (Number.isFinite(n)) return clampBandwidth(n)
  } catch { /* private browsing / quota — fall through to default */ }
  return BW_ESTIMATE_DEFAULT
}

function saveBandwidthEstimate(bps: number | undefined): void {
  if (!bps || !Number.isFinite(bps) || bps <= 0) return
  try {
    localStorage.setItem(BW_ESTIMATE_KEY, String(Math.round(clampBandwidth(bps))))
  } catch { /* best-effort */ }
}

export function VideoPlayer({ target, onClose, party, onChangeAudioTrack, onSendReaction, onFallbackToTranscode, onSeekRebuild, onEnded, onMinimizedChange, isAdmin }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // Issue #177 — hold the latest onEnded in a ref so the 'ended'
  // listener (bound in the [target] effect) always invokes the current
  // callback without re-subscribing on every render.
  const onEndedRef = useRef(onEnded)
  onEndedRef.current = onEnded
  const hlsRef = useRef<Hls | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const startSecRef = useRef<number>(0)
  // Watch-party sync — false while the player is (re)booting a
  // session. Gates host play/pause/seek broadcasts so the transient
  // currentTime=0 / startSec=0 boot window can't propagate abs_ms=0 to the
  // party (which would yank every other participant to the start).
  const playerReadyRef = useRef<boolean>(false)
  // Issue #141 — true when the active HLS session is REMUXING (-c:v
  // copy), false when full-transcoding. Drives the subtitle cue-shift
  // offset: remux can't accurate-seek so the stream's t=0 is the
  // keyframe BEFORE startSec; transcode accurate-seeks so t=0 ≈
  // startSec. The server needs to know which to align cues correctly.
  // Stays false for direct-play (startSecRef is 0 there, so no shift
  // is requested at all).
  const sessionRemuxRef = useRef<boolean>(false)
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
  // Issue #133 — transient error string for the subtitle picker.
  // Set when a <track> element fails to load (server 4xx, network,
  // or VTT parse failure). Auto-clears after 4s. Without surfacing,
  // every failure was completely invisible to the user (toggle the
  // sub, nothing visible changes).
  const [subError, setSubError] = useState<string | null>(null)
  // Mirror of `currentSubIndex` for use inside hls.js event listeners
  // that are registered once per play effect and would otherwise see
  // a stale closure value. Updated whenever applySubtitle / the reset
  // calls setCurrentSubIndex. Reading state via ref instead of closure
  // is essential for the SUBTITLE_TRACK_SWITCH guard below — if we
  // read stale -1, a level-switch event would wipe the user's picked
  // sub mid-playback.
  const currentSubIndexRef = useRef<number>(-1)

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
  // Issue #133 (deep-debug H1+M1) — ref mirror of realDurationSec for
  // the progress reporter to read INSIDE its setInterval callback.
  // Reading state from the effect's closure forced us to put
  // realDurationSec in the effect's dep array, which on HLS-fallback
  // (server didn't return duration_ms) caused the interval to tear
  // down + recreate on EVERY durationchange event from hls.js — the
  // playlist-length value grows continuously during transcode, so the
  // 10s progress timer reset constantly and the user's progress never
  // got saved. The ref pattern also closes a smaller race where
  // serverDurationRef.current goes true *before* setRealDurationSec
  // commits, briefly leaving the fallback branch active.
  const realDurationSecRef = useRef(0)
  useEffect(() => { realDurationSecRef.current = realDurationSec }, [realDurationSec])
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

  // ── Smart Skip ───────────────────────────────────────────────────
  // Markers arrive inside the stream-info payload (source-file ms);
  // currentSec is already in real-file coords, so window membership
  // is a direct comparison — no per-decision timeline math.
  const [skipMarkers, setSkipMarkers] = useState<SkipMarker[]>([])
  // Window the user already skipped/dismissed this playback, keyed
  // `${kind}:${start_ms}` so the pill doesn't reappear when the
  // post-skip seek lands inside the same window's tail.
  const [skipDismissedKey, setSkipDismissedKey] = useState<string | null>(null)
  // Credits-triggered next-up card lifecycle. 'finale' = the advance
  // came back empty (series end) — brief feedback, then 'spent'.
  // 'spent' = fired or dismissed; never re-shown for this playback.
  const [nextUpPhase, setNextUpPhase] = useState<'idle' | 'countdown' | 'prompt' | 'finale' | 'spent'>('idle')
  const [nextUpSecs, setNextUpSecs] = useState(5)
  // True while an early advance (next-up card) is in flight or has
  // succeeded — gates the <video> 'ended' DOM handler so reaching the
  // real end of the credits can't double-advance past TWO episodes.
  const advanceFiredRef = useRef(false)
  // Identity of the file the skip state belongs to. Audio-track
  // switches and forward-seek session rebuilds change the TARGET
  // identity (the play effect re-runs) but not the file — and a
  // dismissed next-up card / skip pill must stay dismissed across
  // those rebuilds, otherwise a rebuild mid-credits re-pops the card
  // the user just closed and (autoplay on) auto-advances anyway.
  const skipStateFileRef = useRef<string | null>(null)
  // Admin marker editor visibility (top-bar "Markers" menu).
  const [markersMenuOpen, setMarkersMenuOpen] = useState(false)

  // ── Chromecast / AirPlay (Cast & AirPlay milestone) ─────────────
  // AirPlay is handled entirely by Safari's native UI: setting
  // `x-webkit-airplay="allow"` on the <video> below makes Safari
  // render its own AirPlay glyph + open the system picker. We add
  // no custom AirPlay button — a second one would be redundant
  // clutter that drives the same picker.
  //
  // castError is a transient banner under the Cast button, NOT
  // the main errorMsg state — a cast failure should not tear down
  // local playback. Cleared automatically after 4s.
  //
  // The dismiss timer ID lives in a ref so a rapid second cast
  // attempt within the 4-second window cancels the prior timer
  // before scheduling its own; otherwise the first timer would
  // race ahead and clear the SECOND error message early (or, if
  // the second attempt succeeded, briefly flash null after the
  // first timer fires).
  const [castError, setCastError] = useState<string | null>(null)
  const castErrorTimerRef = useRef<number | null>(null)
  const flashCastError = useCallback((msg: string) => {
    if (castErrorTimerRef.current !== null) {
      window.clearTimeout(castErrorTimerRef.current)
    }
    setCastError(msg)
    castErrorTimerRef.current = window.setTimeout(() => {
      setCastError(null)
      castErrorTimerRef.current = null
    }, 4000)
  }, [])
  // Clean up any pending toast timer on unmount.
  useEffect(() => {
    return () => {
      if (castErrorTimerRef.current !== null) {
        window.clearTimeout(castErrorTimerRef.current)
      }
    }
  }, [])
  //
  // Build CastLoadArgs at click-time by minting a session-scoped
  // token. The hook awaits this after the device picker resolves,
  // so a dismissed picker does not waste a token. Watch parties
  // currently disable casting (the receiver runs an independent
  // playback timeline that won't stay in sync with the party).
  const castLoadGetter = useCallback(async () => {
    const sid = sessionIdRef.current
    if (!sid || !target) return null
    const resp = await createCastToken(sid)
    // Defense-in-depth: confirm the server actually gave us a
    // cast-scoped JWT before we hand its URL to a receiver. A future
    // bug that wired this path to a different token-mint endpoint
    // (or returned the user's regular access token) would otherwise
    // leak full account credentials onto a Chromecast. Server-side
    // ValidateAccessToken refuses scoped tokens, so the asymmetry
    // exists; this just catches the wrong-direction failure at the
    // source rather than letting it propagate to the receiver.
    assertCastScopedToken(resp.token)
    return {
      contentUrl: absoluteUrl(resp.playlist),
      contentType: 'application/x-mpegURL',
      title: target.title,
      subtitle: target.subtitle,
      // The receiver fetches the SAME session playlist the local <video>
      // element is playing, and that playlist is resume-relative: when the
      // session was created with a resume offset the server FFmpeg-`-ss`'d
      // the transcode, so playlist-time 0 maps to the resume point and
      // vid.currentTime is already HLS-relative (0 = resume point). The
      // receiver must therefore seek to the element's CURRENT position
      // directly — NOT startSec + currentTime.
      //
      // Issue #172: adding startSecRef double-counted the resume offset and
      // seeked the receiver `start_sec` seconds PAST what the on-demand
      // transcoder had produced, so the Default Media Receiver connected but
      // buffered forever ("let me connect but did not play"). The bug only
      // surfaced on resume (start_sec>0); play-from-start casts were fine.
      //
      // When start_sec==0 (play-from-start, direct-play, or the MANIFEST_PARSED
      // client-seek fallback at line ~1068) vid.currentTime is the absolute
      // source position, so this expression is still correct there.
      startTime: videoRef.current?.currentTime ?? 0,
    }
  }, [target])
  const cast = useCast(castLoadGetter)
  const [airplayActive, setAirplayActive] = useState(false)
  const [airplayAvailable, setAirplayAvailable] = useState(false)
  const [minimized, setMinimized] = useState(false)
  // Playback is on a REMOTE surface — the Chromecast receiver OR an AirPlay
  // target — rather than the local <video>. Gated on !party: casting is
  // intentionally disabled in a watch party (the receiver runs an independent
  // timeline the party can't sync), and an AirPlay target would desync it the
  // same way, so the minimize/widget flow stays out of party mode entirely.
  const remoteActive = !party && (cast.status.connected || airplayActive)
  // "Minimized" only counts when there's actually a remote to control. This
  // collapses the 1-frame gap when a cast ends (remoteActive flips false the
  // same render, snapping the full player back in) and is the single source
  // of truth for the off-screen render + the keyboard/Escape gates.
  const minimizedActive = minimized && remoteActive
  // Latest flag for handlers/parent that close over an early render (the
  // keyboard effect deps are [target]; App's Escape gate reads a ref).
  const minimizedRef = useRef(false)
  minimizedRef.current = minimizedActive

  // While a Cast session is connected, pause local playback. The
  // receiver runs its own copy of the stream; running the local
  // <video> in parallel wastes bandwidth and double-counts as "now
  // playing" upstream. Restore play state when the session ends —
  // but only auto-resume if we were the one who paused (don't fight
  // a user-initiated pause).
  //
  // The "pause" event listener below clears pausedByCastRef whenever
  // the local video is paused while cast is connected — covering two
  // cases the simpler "set on connect / play on disconnect" pattern
  // would mishandle: (a) the user manually presses pause during a
  // cast session, (b) the local video pauses for a non-user reason
  // (buffering on a paused-then-disconnected receiver). Either way,
  // on cast end we no longer override their state.
  const pausedByCastRef = useRef(false)
  useEffect(() => {
    const vid = videoRef.current
    if (!vid) return
    if (cast.status.connected) {
      if (!vid.paused) {
        pausedByCastRef.current = true
        vid.pause()
      }
      // While connected, ANY subsequent pause (not the one we just
      // caused — that was synchronous above) means the user took
      // explicit action. Clear the auto-resume flag.
      const onLocalPause = () => {
        // The synchronous pause above won't fire this handler before
        // the listener is attached (microtask ordering), so anything
        // that does fire is necessarily user-driven or post-our-pause.
        pausedByCastRef.current = false
      }
      vid.addEventListener('pause', onLocalPause)
      // While Chromecasting, the receiver is the playback surface — never let
      // the local <video> actually play (any control/keyboard that resumes it
      // would double the audio against the TV). Re-pause on local play. This
      // branch only runs for a connected Chromecast session; AirPlay (where
      // the local element IS the mirrored source) is unaffected.
      const onLocalPlay = () => { vid.pause() }
      vid.addEventListener('play', onLocalPlay)
      return () => {
        vid.removeEventListener('pause', onLocalPause)
        vid.removeEventListener('play', onLocalPlay)
      }
    }
    // Cast ended. Do NOT auto-resume LOCAL playback — the cast-end effect
    // below closes the player rather than handing a finished/stopped
    // Chromecast back to a phantom full-screen local player over whatever
    // view the user navigated to (which would also briefly double the audio).
    // Just clear the flag. AirPlay never sets this ref (its <video> is the
    // live mirrored source and keeps playing on handoff), so it's unaffected.
    pausedByCastRef.current = false
  }, [cast.status.connected])

  // AirPlay active-state detection. Safari fires
  // 'webkitcurrentplaybacktargetiswirelesschanged' on the <video> when the
  // user picks/drops an AirPlay target via the native glyph. While active,
  // the local <video> element IS the source mirrored to the TV — so it must
  // stay mounted and we drive it directly (unlike Chromecast, where the
  // receiver fetches the stream itself). We deliberately do NOT pause local
  // playback for AirPlay (the pausedByCastRef effect above keys on the
  // Chromecast session only).
  useEffect(() => {
    const vid = videoRef.current
    if (!vid) return
    const sync = () => setAirplayActive(!!vid.webkitCurrentPlaybackTargetIsWireless)
    sync()
    // Availability drives our custom AirPlay button (the native glyph is
    // suppressed by our custom controls). Chrome never fires this event, so
    // the button stays hidden there.
    const onAvail = (e: Event & { availability?: string }) => {
      setAirplayAvailable(e.availability === 'available')
    }
    vid.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', sync)
    vid.addEventListener('webkitplaybacktargetavailabilitychanged', onAvail as EventListener)
    return () => {
      vid.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', sync)
      vid.removeEventListener('webkitplaybacktargetavailabilitychanged', onAvail as EventListener)
    }
  }, [target])

  // Auto-minimize to the floating control widget when playback moves to a
  // remote surface; expand back when it returns to local. The full player
  // stays MOUNTED (just hidden) so the Chromecast streaming session and the
  // AirPlay <video> source survive — closing the laptop view no longer kills
  // the cast (the prior bug). A manual expand (widget → expand) leaves
  // remoteActive unchanged, so this effect won't fight the user back down.
  useEffect(() => {
    setMinimized(remoteActive)
    if (remoteActive) {
      // Move focus off the (about-to-be-hidden) full player so it isn't
      // stranded inside the off-screen/aria-hidden subtree.
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      // Drop browser-fullscreen so we don't strand a black fullscreen surface
      // (the root goes opacity-0 while minimized). Issue #309 — handle the
      // webkit-prefixed API for iOS Safari, which lacks the standard names.
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => { /* defensive */ })
      } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
        document.webkitExitFullscreen()
      }
    }
  }, [remoteActive])

  // Report minimized-widget state up so the parent's global Escape/back
  // handlers don't unmount the player while casting (which would tear down the
  // streaming session feeding the receiver). See App's Escape gate.
  useEffect(() => {
    onMinimizedChange?.(minimizedActive)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minimizedActive])

  // ── Cast end-of-life ──────────────────────────────────────────────────
  // The minimized cast widget must end ONLY when the user stops it or the
  // media finishes — never on navigation (gated in App) — and without
  // resuming a phantom local player over whatever view the user browsed to.

  // Media finished: the Default Media Receiver keeps the SESSION connected at
  // end-of-media and flips the RemotePlayer's playerState to 'IDLE'. We only
  // act once the receiver has actually started PLAYING, so the initial
  // IDLE-before-load doesn't trigger. Keying off playerState (rather than a
  // currentTime/duration heuristic) is robust to HLS streams whose duration is
  // unknown or grows as the playlist arrives, and it never fires mid-playback:
  // a seek/buffer reports BUFFERING and a pause reports PAUSED — only a genuine
  // end/stop reports IDLE.
  //
  // On finish we try the SAME next-episode advance as local playback (via
  // onEnded — the local <video> is paused while casting, so its 'ended' event
  // never fires). If it advances, the local player reboots its server session
  // for the next episode and the reload effect below re-points the receiver at
  // it (the receiver mirrors the local session). If there's nothing to advance
  // to (movie, autoplay off, party, series end), we stop — which routes through
  // the Chromecast-end effect below and closes the player (the prior behavior).
  const castHasPlayedRef = useRef(false)
  // True from the moment we decide to advance until the receiver has been
  // re-pointed at the next episode. Gates the reload effect so unrelated
  // session reboots (audio-track switch, seek-rebuild) don't reload the cast.
  const castAdvancePendingRef = useRef(false)
  // Bumped by the main play effect once a new local session is established;
  // drives the reload effect at exactly the moment castLoadGetter can mint a
  // cast token for the new target.
  const [castReloadEpoch, setCastReloadEpoch] = useState(0)
  useEffect(() => {
    if (!cast.status.connected) {
      // Cast gone: disarm both flags so a stale advance can't survive a
      // disconnect→reconnect and misfire on a later session (e.g. a re-cast).
      castHasPlayedRef.current = false
      castAdvancePendingRef.current = false
      return
    }
    if (cast.remote.playerState === 'PLAYING') { castHasPlayedRef.current = true; return }
    if (castHasPlayedRef.current && cast.remote.playerState === 'IDLE') {
      // De-arm synchronously so a re-render mid-advance can't re-enter here.
      castHasPlayedRef.current = false
      // Only a NATURAL end-of-media should auto-advance. A user stop on the TV
      // remote reports CANCELLED/INTERRUPTED, and an ERROR shouldn't silently
      // skip ahead — those close out instead (cast.stop → Chromecast-end →
      // onClose). FINISHED, and null/unknown (to preserve the prior any-IDLE
      // behavior on receivers that don't surface a reason), advance. idleReason
      // rides the same MEDIA_STATUS as playerState, so it's current here.
      const reason = cast.remote.idleReason
      if (reason === 'CANCELLED' || reason === 'INTERRUPTED' || reason === 'ERROR') {
        cast.stop()
      } else {
        // Arm BEFORE the async advance so the next session's epoch bump (which
        // is network-bound and always lands later) can never beat the flag.
        castAdvancePendingRef.current = true
        void (async () => {
          const advanced = await onEndedRef.current?.()
          if (!advanced) {
            // Nothing to advance to — clear the arm and close out (the prior
            // end-of-media behavior: stop → Chromecast-end effect → onClose).
            castAdvancePendingRef.current = false
            cast.stop()
          }
        })()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cast.status.connected, cast.remote.playerState])

  // Re-point a live receiver at a freshly-booted local session after a cast
  // auto-advance. Keyed on castReloadEpoch (bumped once sessionIdRef is set for
  // the new target). Gated on a pending advance + a still-connected receiver;
  // any load failure (e.g. the next episode is direct-play and has no castable
  // HLS session) stops the cast, closing the player rather than leaving an idle
  // receiver hanging.
  useEffect(() => {
    if (!castAdvancePendingRef.current) return
    castAdvancePendingRef.current = false
    if (!cast.status.connected) return
    void cast.loadCurrent().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[Aurora Cast] auto-advance load failed; stopping cast', err)
      cast.stop()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [castReloadEpoch])

  // Chromecast SESSION ended (widget Stop, TV remote, network drop, or the
  // media-finish stop() above): close the player. We deliberately do NOT
  // resume local playback — the receiver was the surface and the user has
  // likely navigated away, so a full-screen local player slamming over the
  // current view (and starting audio) is wrong. AirPlay keeps its seamless
  // local handoff via the auto-minimize effect (its <video> IS the mirrored
  // source), so this is gated on the Chromecast session only.
  const castConnectedRef = useRef(false)
  useEffect(() => {
    const was = castConnectedRef.current
    castConnectedRef.current = cast.status.connected
    if (was && !cast.status.connected && !party) onClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cast.status.connected, party])

  // QA 2026-05-25 — disable every TextTrack on the <video>. Called
  // after a new HLS manifest or direct-play source loads so any
  // DEFAULT=YES subtitle group baked into the master playlist
  // (especially forced-foreign tracks added by ffmpeg's subtitle
  // pass-through) doesn't auto-show before the user picks one.
  //
  // The QA report flagged "Ladies First defaulted to 'SPA SUBRIP
  // Forced'" — that's the m3u8 marking a Spanish forced track as
  // DEFAULT, and hls.js/the browser dutifully enabling it. Our
  // player manages subtitles via the picker + applySubtitle (which
  // already loops + disables others); this sweep is the missing
  // initial-state-reset so the picker's "Off" choice is honored
  // when the user hasn't touched anything.
  const disableAllTextTracks = (vid: HTMLVideoElement) => {
    try {
      for (let i = 0; i < vid.textTracks.length; i++) {
        vid.textTracks[i].mode = 'disabled'
      }
    } catch { /* defensive */ }
  }

  // Issue #137 — return true if ANY text track on the video element
  // is currently in 'showing' or 'hidden' mode. Used by enforceNoAutoSub
  // to skip disableAllTextTracks when nothing needs disabling — that
  // skip is what breaks the SUBTITLE_TRACK_SWITCH feedback loop where
  // hls.js fires the event, we disable, the disable changes a track
  // mode, hls.js fires the event again, etc.
  const anyTextTrackEnabled = (vid: HTMLVideoElement): boolean => {
    try {
      for (let i = 0; i < vid.textTracks.length; i++) {
        if (vid.textTracks[i].mode !== 'disabled') return true
      }
    } catch { /* defensive */ }
    return false
  }

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
    // Mirror to ref so hls.js event listeners see the latest pick.
    currentSubIndexRef.current = index
    // Issue #135 — diagnostic logging. The console.warn calls are
    // intentional and load-bearing: the bug reporter's diagnostic
    // buffer captures `warn` entries, and <track> requests bypass
    // the fetch interceptor entirely. Without instrumentation, a
    // failing subtitle is fully invisible to triagers (we hit this
    // exact situation on Elf — subrip codec passes the bitmap
    // filter, the <track> apparently loads (no error event), but
    // no cues display). Every step now emits a log entry so we
    // can pinpoint which one breaks.
    // Issue #135 (deep-debug L1) — happy-path entries use console.info
    // so DevTools doesn't paint the whole picker yellow during normal
    // use; the diagnostic buffer captures both info and warn so bug
    // reports get the same data either way. console.warn is reserved
    // for actual problem signals (errors, races, hls.js conflicts).
    console.info('[Aurora.sub] applySubtitle called', {
      requestedIndex: index,
      target: { fileId: target.fileId, fileType: target.fileType },
      startSec: startSecRef.current,
      currentTime: vid.currentTime,
      vidDuration: vid.duration,
      existingTextTracks: vid.textTracks.length,
    })
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
    if (index < 0) {
      console.info('[Aurora.sub] subtitles turned OFF (index=-1)')
      return
    }
    // Clear any prior error before kicking off the new request.
    setSubError(null)
    // Deep-debug M3 — short-circuit if the caller somehow picked a
    // bitmap track (deep-link, session-restore, or a future caller
    // that bypasses the picker filter). The server would 400 and our
    // <track> error handler would catch it, but skipping the round-
    // trip is cheaper + gives a more specific error message.
    const pickedMeta = availableSubs.find(s => s.index === index)
    if (pickedMeta?.bitmap) {
      console.warn('[Aurora.sub] pick blocked: bitmap format', { trackIndex: index, codec: pickedMeta?.codec })
      setSubError('Bitmap subtitles need burn-in (not yet supported in the picker)')
      setCurrentSubIndex(-1)
      currentSubIndexRef.current = -1
      return
    }
    // Inject a <track> child.
    // Issue #131 — pass the active session's resume offset so the server
    // shifts every cue timestamp by -start_sec. Without this, the VTT
    // uses original-file timestamps but the player's currentTime is
    // HLS-relative (0 = resume point), so every cue fires `startSec`
    // seconds late — or never, when past EOF. The server endpoint
    // ignores start=0, so this is safe to always send.
    const startSec = startSecRef.current
    // Issue #141 — tell the server whether this session is REMUXING.
    // It picks the cue-shift offset accordingly: keyframe-≤-startSec
    // for remux (input seek can't land mid-GOP), raw startSec for
    // transcode (accurate seek lands exactly on startSec). Only
    // meaningful when startSec>0; direct-play keeps startSec=0 and
    // sends neither param (cues already match native currentTime).
    const trackURL = `/api/stream/${target.fileId}/subtitles/${index}?type=${target.fileType}` +
      (startSec > 0 ? `&start=${startSec}${sessionRemuxRef.current ? '&remux=1' : ''}` : '')
    const track = document.createElement('track')
    track.kind = 'subtitles'
    track.src = withToken(trackURL)
    track.default = true
    const meta = pickedMeta // already looked up above
    if (meta?.language) track.srclang = meta.language
    if (meta?.title || meta?.language) track.label = meta.title || meta.language || `Sub ${index}`
    const trackLabel = meta?.title || meta?.language || `Sub ${index}`
    console.info('[Aurora.sub] <track> created', {
      trackIndex: index,
      codec: meta?.codec,
      bitmap: meta?.bitmap,
      label: trackLabel,
      // Safe to log: trackURL is built BEFORE withToken() is applied
      // (the token only enters track.src below via withToken(trackURL)).
      // withToken is pure and doesn't mutate the input string, so the
      // logged URL stays token-free. NOTE: redactURL in
      // diagnosticBuffer only runs on the NETWORK buffer, NOT the
      // console buffer — don't rely on it as a backstop for console
      // logs. (Deep-debug M4.)
      url: trackURL,
    })
    // Issue #133 — surface load failures. <track> swallows fetch
    // errors silently by default; without this handler a 4xx
    // response from the server produces no UI feedback at all.
    track.addEventListener('error', () => {
      const msg = `Couldn't load "${trackLabel}" subtitle track`
      console.warn('[Aurora.sub] <track> error event fired', {
        trackIndex: index,
        url: trackURL,
        label: trackLabel,
      })
      setSubError(msg)
      // Roll back UI selection so the picker reflects "off" rather
      // than "stuck on a track that isn't actually rendering."
      setCurrentSubIndex(-1)
      currentSubIndexRef.current = -1
      // Remove the dead track element so a subsequent retry doesn't
      // try to reuse it.
      try {
        if (track.parentNode) track.parentNode.removeChild(track)
      } catch { /* defensive */ }
      if (activeTrackRef.current === track) activeTrackRef.current = null
    })
    // Issue #135 — log when the <track>'s underlying TextTrack
    // populates. This tells us if the VTT was fetched + parsed
    // successfully. cues.length === 0 with no error event means
    // either the VTT was empty after our cue-shift OR the browser's
    // WebVTT parser rejected the body silently (mistuned BOM /
    // malformed timestamps / wrong content-type).
    //
    // Deep-debug H1 — the `load` event fires when the network fetch
    // completes, but `track.track.cues` populates on a SEPARATE
    // microtask in some Chromium / Safari versions. Reading cues
    // synchronously can return 0 even when cues are about to arrive,
    // producing a false-positive toast. Defer the cue-count check by
    // 150ms (well past the typical microtask flush) and only set the
    // error then. The diagnostic log still emits immediately for the
    // bug-report trail.
    track.addEventListener('load', () => {
      // Deep-debug H1 — stale-track guard. The VTT fetch is async; by
      // the time the load event fires, the user may have already
      // moved to a different sub or turned them off, in which case
      // applySubtitle has REMOVED this track from the DOM and
      // possibly attached a NEW one. Without this guard, the new
      // track's mode would get force-disabled below (the loop sets
      // every track that ISN'T `tt` to 'disabled', but `tt` here is
      // the orphan that no longer matches what the user wants).
      //
      // Symptom: user picks track A, picks track B before A's VTT
      // loads, track B briefly shows then disappears as A's load
      // handler fires and overwrites the modes.
      const isStale =
        currentSubIndexRef.current !== index ||
        activeTrackRef.current !== track
      const tt = track.track
      const initialCueCount = tt?.cues?.length ?? -1
      const initialMode = tt?.mode
      console.info('[Aurora.sub] <track> load event fired', {
        trackIndex: index,
        initialCueCount,
        textTrackMode: initialMode,
        textTrackKind: tt?.kind,
        textTrackLabel: tt?.label,
        stale: isStale,
      })
      if (isStale) {
        // Don't touch any modes — the user has moved on.
        return
      }
      // Issue #139 — Chrome/Blink resets track.mode after the VTT
      // load completes. The browser's HTML-spec internal "default
      // mode" logic re-runs on cue-list finalization, considering
      // user preferences + group-default semantics, and may flip
      // our explicitly-set 'showing' back to 'hidden'.
      //
      // Observed in bug #139's diagnostic capture:
      //   T+0   : track.mode = 'showing' (our promote() set it)
      //   T+150 : load event fires, track.mode = 'hidden'   ← spec-allowed reset
      //
      // 'hidden' parses cues into track.cues but does NOT render
      // them — exactly the "subtitles don't load" symptom. Force it
      // back to 'showing' explicitly here, BEFORE the user notices.
      // Defense-in-depth: also re-disable any other text track that
      // may have been re-enabled in the same reset pass.
      //
      // Deep-debug S1 — guard mode writes so we only assign when the
      // value actually differs. Avoids spurious `change` events on
      // already-correct tracks (defense in depth against any future
      // event-loop pattern like #138).
      if (tt && tt.mode !== 'showing') {
        console.info('[Aurora.sub] re-asserting mode=showing post-load', {
          trackIndex: index,
          wasMode: initialMode,
        })
        const vidEl = videoRef.current
        if (vidEl) {
          for (let i = 0; i < vidEl.textTracks.length; i++) {
            const desired = vidEl.textTracks[i] === tt ? 'showing' : 'disabled'
            if (vidEl.textTracks[i].mode !== desired) {
              vidEl.textTracks[i].mode = desired
            }
          }
        } else {
          tt.mode = 'showing'
        }
      }
      // 2026-05-28 — Lift cues above the control bar now that they're
      // parsed (initialCueCount confirms the list is populated).
      liftCuesAboveControls(tt)
      // Re-check cue count after the browser's parser has had a
      // chance to populate the cue list. Only surface an error if
      // BOTH readings are 0 (i.e., the cue list is truly empty,
      // not just not-yet-populated).
      setTimeout(() => {
        const finalCueCount = track.track?.cues?.length ?? -1
        const finalMode = track.track?.mode
        if (finalCueCount === 0) {
          console.warn('[Aurora.sub] <track> loaded but produced zero cues', {
            trackIndex: index,
            initialCueCount,
            finalCueCount,
          })
          setSubError(`"${trackLabel}" loaded but has no cues — possible format mismatch`)
        } else if (initialCueCount === 0 && finalCueCount > 0) {
          // Browser populated cues after the load event — log so we
          // know the race exists for this browser/file combo, and
          // lift them now (the load-event lift saw an empty list).
          console.info('[Aurora.sub] cues arrived after load event', {
            trackIndex: index,
            finalCueCount,
          })
          liftCuesAboveControls(track.track)
        }
        // Issue #139 — second-chance check: if mode is STILL not
        // 'showing' 150ms after our re-assertion, something else is
        // fighting us. Surface as a warning so the next bug report
        // shows the pattern (and we know to look for a different
        // race source — possibly hls.js group-default logic still
        // running on a delayed tick).
        if (currentSubIndexRef.current === index && finalMode !== 'showing') {
          console.warn('[Aurora.sub] track mode reverted post-reassertion', {
            trackIndex: index,
            finalMode,
            userPickedIndex: currentSubIndexRef.current,
          })
        }
      }, 150)
    })
    vid.appendChild(track)
    activeTrackRef.current = track
    // Poll until the browser has promoted our <track> into
    // vid.textTracks, then enable it by reference. Max ~1s wait;
    // give up silently after that (browser is misbehaving).
    let tries = 0
    const promote = () => {
      tries++
      if (track.track) {
        const modes: string[] = []
        for (let i = 0; i < vid.textTracks.length; i++) {
          vid.textTracks[i].mode = vid.textTracks[i] === track.track ? 'showing' : 'disabled'
          modes.push(`[${i}]=${vid.textTracks[i].mode}`)
        }
        console.info('[Aurora.sub] track promoted + mode set', {
          tries,
          totalTracks: vid.textTracks.length,
          modes: modes.join(' '),
        })
        return
      }
      if (tries < 30) setTimeout(promote, 33)
      else console.warn('[Aurora.sub] track.track never populated after 30 polls (~1s)')
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
      // Persist the measured bandwidth before teardown so the next session
      // seeds its ABR at the right tier (review P2).
      try { saveBandwidthEstimate(hlsRef.current.bandwidthEstimate) } catch { /* defensive */ }
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
    if (!target) {
      // Player closed: forget the skip-state file identity so a later
      // re-open of the SAME file starts a fresh playback (dismissals
      // and the next-up lifecycle are per-playback, not per-file-ever).
      skipStateFileRef.current = null
      return
    }
    let cancelled = false
    const ac = new AbortController()

    setStatus('Loading…')
    setErrorMsg(null)
    sessionIdRef.current = null
    startSecRef.current = 0
    // Suppress host party-broadcasts until this session has (re)booted —
    // see playerReadyRef. Set true right before each vid.play() below.
    playerReadyRef.current = false
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
    // Smart Skip — markers for the new target arrive with its
    // stream-info below. Dismissals/next-up state reset only when the
    // FILE changes: same-file session rebuilds (audio switch, forward-
    // seek) must not resurrect a dismissed card or re-arm a fired
    // advance.
    setSkipMarkers([])
    setMarkersMenuOpen(false)
    {
      const fileKey = `${target.fileType}:${target.fileId}`
      if (skipStateFileRef.current !== fileKey) {
        skipStateFileRef.current = fileKey
        setSkipDismissedKey(null)
        setNextUpPhase('idle')
        setNextUpSecs(5)
        advanceFiredRef.current = false
      }
    }

    ;(async () => {
      try {
        // 1. Stream-info: server decides direct vs HLS.
        const info: StreamInfo = await getStreamInfo(target.fileId, target.fileType, ac.signal)
        if (cancelled) return
        const stream = info.stream
        // M10 Phase 4.5 — expose tracks for the picker.
        setAvailableAudio(info.audio_tracks || [])
        // Issue #133 — filter out bitmap-format subtitles (PGS/VobSub/
        // DVB) before showing in the picker. The server can't convert
        // these to WebVTT and returns 400 from
        // /api/stream/{id}/subtitles/{idx}, which the <track> element
        // swallows silently — user toggles "eng", nothing visible
        // changes. Common on Blu-ray rips: Elf 2003 has PGS as its
        // primary English track, so toggling it appeared to do
        // nothing. Bitmap subs CAN still be burned in via the
        // pre-play setup; that path uses a different code path so
        // filtering the in-player picker doesn't lose functionality.
        // The backend already marks these with `bitmap: true` in
        // /api/stream/info/{id} (phase2_handlers.go:1447).
        setAvailableSubs((info.subtitles || []).filter(s => !s.bitmap))
        // Smart Skip windows for this file (already filtered to
        // displayable markers server-side).
        setSkipMarkers(info.markers || [])
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
        currentSubIndexRef.current = -1

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
          //
          // QA 2026-05-25 — also defensive-disable any auto-selected
          // TextTrack the browser promoted from the file's embedded
          // subs. Done on BOTH loadedmetadata and canplay so the
          // tracks are caught regardless of which event populates
          // textTracks first (browser-dependent — Chromium promotes
          // at loadedmetadata, some others at canplay).
          const newSubs = info.subtitles || []
          const onLoadedMetadata = () => {
            disableAllTextTracks(vid)
          }
          const onCanPlayForSub = () => {
            disableAllTextTracks(vid)
            if (subToRestore >= 0 && newSubs.some(s => s.index === subToRestore)) {
              applySubtitle(subToRestore)
            }
            vid.removeEventListener('canplay', onCanPlayForSub)
            vid.removeEventListener('loadedmetadata', onLoadedMetadata)
          }
          vid.addEventListener('loadedmetadata', onLoadedMetadata)
          vid.addEventListener('canplay', onCanPlayForSub)
          // Booted: re-enable host broadcasts. The deferred resume seek + play
          // below are the host's intended state, safe to propagate.
          playerReadyRef.current = true
          try { await vid.play() } catch { /* autoplay-blocked, user clicks play */ }
          // A direct-play target has no castable HLS session; bump anyway so a
          // pending cast auto-advance resolves (loadCurrent finds no media and
          // stops the cast — direct-play can't be cast).
          setCastReloadEpoch(n => n + 1)
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
          // Audio output codec from the stream-info decision: the re-encode
          // target ('aac' stereo / 'ac3' 5.1) or, when audio is copied, the
          // SOURCE codec ('aac'/'ac3'/'eac3'). Echoed back verbatim; the
          // server re-validates against its own track data
          // (NormalizeSessionAudio), so a stale echo can never produce a
          // manifest/segment codec mismatch.
          audio_codec_out: stream.audio_codec_out,
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
        // Issue #141 — record the EFFECTIVE remux state (sessionReq.remux
        // already folds in forceTranscode). The subtitle endpoint uses
        // this to pick the cue-shift offset: keyframe for remux, raw
        // startSec for transcode.
        sessionRemuxRef.current = sessionReq.remux
        // Cast follows the local session: now that the new session exists,
        // signal the reload effect so a pending cast auto-advance re-points the
        // receiver at this episode (no-op when not casting / nothing pending).
        setCastReloadEpoch(n => n + 1)
        setStatus(
          stream.decision === 'direct_stream'
            ? `Remux · ${stream.container ?? 'hls'}`
            : `Transcode · ${stream.video_codec ?? ''}`
        )

        const masterUrl = withToken(session.master_playlist)
        const vid = videoRef.current
        if (!vid) return

        // Prefer native HLS when the browser supports it natively (Safari on
        // macOS/iOS; all iOS WebKit browsers). This fires even when
        // Hls.isSupported() is true — modern Safari supports MSE but AirPlay
        // cannot forward an MSE/blob source to an Apple TV. With a real m3u8
        // URL set on vid.src, Safari hands the URL to the receiver directly,
        // fixing the "device connects, no content plays" symptom (#314).
        const usesNativeHls =
          !Hls.isSupported() || vid.canPlayType('application/vnd.apple.mpegurl') !== ''
        if (usesNativeHls) {
          // withToken() is a no-op: tokens live in httpOnly cookies that the
          // browser sends automatically, but which Apple TV cannot access.
          // Without a ?token= in the URL, the Apple TV gets 401 on the master
          // playlist and every subsequent HLS sub-resource — it shows
          // "Connected" but nothing plays (#317, regression from #314 fix).
          // Mint a cast token (same path as Chromecast) so the receiver gets
          // a URL it can authenticate without browser cookies (#317).
          let airplaySrc = masterUrl
          try {
            // forAirplay=true skips CloneForCast on the server: Apple TV and
            // the browser's native HLS player decode H.264 remux natively, so
            // a full-transcode clone is unnecessary here. Without this flag a
            // remux session spawns a fresh FFmpeg transcode whose first segment
            // hasn't been written yet, making vid.src point at an empty
            // playlist and breaking local playback entirely (#326).
            const ct = await createCastToken(session.session_id, { forAirplay: true })
            airplaySrc = absoluteUrl(ct.playlist)
          } catch {
            // Token mint failed — local cookie auth still works for the
            // browser; AirPlay will fail auth but won't crash the player.
          }
          vid.src = airplaySrc
          vid.load()
          // Resume fallback: server -ss'd in the normal case (start_sec > 0 means
          // HLS-time-0 IS the resume point). When start_sec === 0 despite a
          // resume position, seek client-side once metadata is ready — mirrors
          // the MANIFEST_PARSED fallback in the hls.js path.
          if (resumeSec > 0 && (session.start_sec ?? 0) === 0) {
            const onCanPlaySeek = () => {
              vid.currentTime = resumeSec
              vid.removeEventListener('canplay', onCanPlaySeek)
            }
            vid.addEventListener('canplay', onCanPlaySeek)
          }
          // Disable DEFAULT=YES subtitle groups the native player auto-selects
          // and reapply the user's prior sub choice. Mirrors the direct_play
          // loadedmetadata/canplay pattern (lines ~1287-1299).
          const newSubsNative = info.subtitles || []
          const onNativeLoadedMetadata = () => { disableAllTextTracks(vid) }
          const onNativeCanPlay = () => {
            disableAllTextTracks(vid)
            if (subToRestore >= 0 && newSubsNative.some(s => s.index === subToRestore)) {
              applySubtitle(subToRestore)
            }
            vid.removeEventListener('canplay', onNativeCanPlay)
            vid.removeEventListener('loadedmetadata', onNativeLoadedMetadata)
          }
          vid.addEventListener('loadedmetadata', onNativeLoadedMetadata)
          vid.addEventListener('canplay', onNativeCanPlay)
          playerReadyRef.current = true
          try { await vid.play() } catch { /* autoplay-blocked */ }
          return
        }

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          // 2026-06 streaming review (P2) — ABR tuning for a self-hosted,
          // LAN-dominant server:
          //  * abrEwmaDefaultEstimate: seed from the last measured session
          //    (8 Mbps first run). hls.js's 500 kbps factory default sits
          //    below the whole ladder → every play started at 480p.
          //  * capLevelToPlayerSize: don't pull 2160p fragments into a
          //    small window; recomputed automatically on fullscreen.
          //  * backBufferLength: the Infinity default keeps every played
          //    byte in the SourceBuffer — on a 2h movie that's the whole
          //    film in memory, relying on browser quota eviction. 90s of
          //    back-buffer covers instant-replay seeks.
          abrEwmaDefaultEstimate: loadBandwidthEstimate(),
          capLevelToPlayerSize: true,
          backBufferLength: 90,
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
            // Issue #165 (deep-debug) — auth moved to an httpOnly cookie in
            // the H10 migration (#152). The old localStorage('aurora_token')
            // read here was DEAD post-H10: getAccessToken() returns null and
            // nothing writes that key anymore, so hls.js's manifest + segment
            // XHRs went out with NO Authorization header AND no ?token=
            // (withToken() is also a no-op now). They authenticated solely by
            // the implicit same-origin `aurora_access` cookie — which silently
            // breaks on any cross-origin / reverse-proxy deploy that doesn't
            // forward the cookie onto /api/stream/*, producing the "video
            // won't play, 401s in console" report. (The 401s are invisible in
            // the bug-report network log because diagnosticBuffer patches
            // window.fetch, not hls.js's XHR — the lone /api/auth/refresh at
            // +160ms is the 401-recovery tell.)
            //
            // Fix: send credentials on every hls.js request. Same-origin
            // sends the cookie regardless; withCredentials makes it ride
            // cross-origin too. The server already returns
            // Access-Control-Allow-Credentials=true with a non-wildcard
            // Allow-Origin (router.go), and RequireStreamAuth reads the cookie
            // via tokenFromRequest (middleware.go), so this is all the client
            // needs to authenticate the stream.
            xhr.withCredentials = true
          },
        })
        hlsRef.current = hls
        hls.loadSource(masterUrl)
        hls.attachMedia(vid)

        // QA 2026-05-25 (round 4) — hls.js manages SUBTITLES groups
        // from the m3u8 master via its OWN internal track state
        // (`hls.subtitleTrack`), separate from the DOM TextTracks
        // list. When the master has `DEFAULT=YES` on a SUBTITLES
        // group (which ffmpeg's subtitle pass-through emits for any
        // file with embedded subs), hls.js promotes that track and
        // enables it BEFORE MANIFEST_PARSED fires — and even if we
        // call `disableAllTextTracks(vid)` after, hls.js will
        // re-enable it on the next subtitle-track update event.
        //
        // The browser-visible bug: every playback started with
        // English subs auto-on, regardless of our DOM-level disable.
        // Verified at aurorapro.app on 2026-05-25: vid.textTracks[0]
        // mode = 'showing' throughout playback.
        //
        // Fix: tell hls.js itself that NO subtitle track should be
        // selected. Our picker still works via the separate <track>
        // element / VTT extraction path; we just need hls.js to
        // stop fighting us over the m3u8's DEFAULT hint.
        try { hls.subtitleTrack = -1 } catch { /* hls.js property */ }
        try { hls.subtitleDisplay = false } catch { /* defensive */ }

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
          //
          // QA 2026-05-25 — disable any DEFAULT=YES subtitle group
          // the m3u8 master might have included (e.g. SPA forced
          // tracks from foreign-film source files). Our picker is
          // the source of truth for subs; the m3u8's hint is just
          // metadata.
          disableAllTextTracks(vid)
          // Re-assert the hls.js-level disable here too — hls.js's
          // SUBTITLE_TRACKS_UPDATED can fire AFTER MANIFEST_PARSED
          // and re-promote DEFAULT tracks; this idempotent set keeps
          // them off until the user opts in via the picker.
          try { hls.subtitleTrack = -1 } catch { /* defensive */ }
          const newSubsHls = info.subtitles || []
          if (subToRestore >= 0 && newSubsHls.some(s => s.index === subToRestore)) {
            applySubtitle(subToRestore)
          }
          // Booted: manifest parsed + start_sec applied. Re-enable host
          // broadcasts so the play below (and later host seeks) propagate,
          // while the transient boot seeks stayed suppressed. Guard against a
          // superseded target (defensive — hls.destroy() also detaches this).
          if (cancelled) return
          playerReadyRef.current = true
          vid.play().catch(() => { /* autoplay-blocked, user clicks play */ })
        })

        // Belt-and-suspenders: if hls.js fires SUBTITLE_TRACKS_UPDATED
        // (master playlist parsed) or SUBTITLE_TRACK_SWITCHED (track
        // changed by ABR / DEFAULT hint), force the index back to -1
        // unless the user has explicitly picked one via our picker.
        // This is the event hls.js uses to re-promote DEFAULT tracks
        // after parsing the subtitle playlist, which is what was
        // sneaking past our MANIFEST_PARSED disable.
        // eventName parameter (not `event`, to avoid cognitive collision
        // with hls.js's event-object arg) identifies which hls.js event
        // fired. The hls.js callback args are intentionally discarded —
        // the data payload is large and we don't use any of its fields.
        const enforceNoAutoSub = (eventName: string) => {
          // CRITICAL: read via ref. This listener is registered once
          // per play effect and would capture a stale closure value.
          // If we read stale -1 here after the user picks a sub via
          // the picker, a level-switch SUBTITLE_TRACK_SWITCH event
          // would silently wipe the user's selection mid-playback.
          if (currentSubIndexRef.current >= 0) {
            console.info('[Aurora.sub] hls.js sub-event ignored (user has pick)', {
              eventName,
              userPickedIndex: currentSubIndexRef.current,
            })
            return
          }
          // Issue #137 — guard the assignment to break the infinite
          // feedback loop with hls.js. Without this guard, setting
          // `hls.subtitleTrack = -1` causes hls.js to fire another
          // SUBTITLE_TRACK_SWITCH event (because the value changed),
          // which re-invokes this handler, which sets -1 again, etc.
          // The user's bug report #137 captured 500 identical
          // "forced off" entries in 2 milliseconds — the loop also
          // ran `disableAllTextTracks(vid)` continuously, which
          // disabled the user's freshly-injected <track> element
          // mode='showing' BEFORE the browser could render its cues.
          // That was THE bug behind "subtitles don't load on Elf"
          // across issues #131, #133, #135, #137.
          //
          // The guard is two-part:
          //   1. Skip the hls.subtitleTrack setter when already -1
          //      (avoids the re-fire from hls.js's setter).
          //   2. Skip disableAllTextTracks when no track is enabled
          //      (cheaper; also avoids needless mode='disabled'
          //      assignments that some browsers also event-emit).
          const currentHlsTrack = hls.subtitleTrack
          const someTrackEnabled = anyTextTrackEnabled(vid)
          if (currentHlsTrack === -1 && !someTrackEnabled) {
            // Already in target state — no-op. The handler will be
            // invoked many times (especially on SUBTITLE_TRACKS_UPDATED
            // at manifest parse) but only does work when there's
            // actually a track to disable.
            return
          }
          console.info('[Aurora.sub] hls.js sub-event forced off', {
            eventName,
            wasHlsTrack: currentHlsTrack,
            hadEnabledTextTrack: someTrackEnabled,
          })
          if (currentHlsTrack !== -1) {
            try { hls.subtitleTrack = -1 } catch { /* defensive */ }
          }
          if (someTrackEnabled) {
            disableAllTextTracks(vid)
          }
        }
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => enforceNoAutoSub('SUBTITLE_TRACKS_UPDATED'))
        hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, () => enforceNoAutoSub('SUBTITLE_TRACK_SWITCH'))

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
        // If a cast auto-advance was waiting on this boot, it just failed
        // (sessionIdRef was never set). Tick the reload epoch so the cast
        // reload effect runs and — finding no castable session — stops the
        // cast and closes, instead of leaving the receiver stuck on the
        // finished episode's last frame. No-op when nothing is pending.
        setCastReloadEpoch(n => n + 1)
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
    const ping = () => {
      const sid = sessionIdRef.current
      if (sid) void keepalive(sid)
    }
    const id = window.setInterval(ping, 10000)
    // Background tabs and locked phones throttle or suspend setInterval, so
    // the 10s ping can stall long enough for the server to GC the session
    // (segments deleted → playback breaks on return). Ping the instant the
    // tab becomes visible again to re-extend the session before the next
    // segment fetch would otherwise 404.
    const onVisible = () => {
      if (document.visibilityState === 'visible') ping()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
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
  // 2026-05-25 deep-debug (High #3) — gate PR #81's race-recovery
  // requestPlay() so it fires at most once per player-bind. Reset
  // below in a target-identity useEffect when fileId/mediaItemId
  // changes. See the recovery block in the play/pause/seek useEffect
  // for the full rationale.
  const hostBroadcastRecoveryFiredRef = useRef<boolean>(false)
  useEffect(() => {
    hostBroadcastRecoveryFiredRef.current = false
  }, [target?.fileId, target?.mediaItemId])
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
    // 2026-05-25 — tightened from the original (200/3000/1.03/0.97) to
    // converge faster on the steady-state 1-2s drift observed during the
    // KG4K7J / 7PRH73 live tests. Old values closed 1s of drift in ~33s
    // (RATE_UP=1.03 gains 0.03s/s), so any persistent backpressure on
    // the guest's HLS pipeline produced a stable 1-2s offset that the
    // soft-correction couldn't catch. New constants:
    //   DRIFT_IGNORE_MS 200 → 150 (tighter dead zone)
    //   RATE_UP 1.03 → 1.06     (close 1s in ~17s, still smooth audio)
    //   RATE_DN 0.97 → 0.94
    //   DRIFT_HARD_MS 3000 → 1800 (snap >1.8s — combined with time-sync,
    //                              hard-snaps should be rare in practice)
    // Combined with the new time-sync clock-offset correction (below),
    // expected steady-state drift drops to 300-600ms — meaningfully
    // better than Plex/Jellyfin's typical 1-2s baseline.
    // 2026-05-25 deep-debug (Medium #5) — Plex / Jellyfin both stay
    // under 5% rate-adjust because vocal formants shift audibly above
    // that (chipmunk effect on dialogue, slowdown sounds drugged on
    // ease-back). PR #82's 6% was already verging on perceptible on
    // dialogue-heavy SD content (Drake & Josh tests). Pull back to 5%
    // — closes 1s of drift in ~20s instead of ~17s. If users still
    // see persistent drift, prefer dropping DRIFT_HARD_MS further so
    // the snap path takes over; never raise these above 1.05.
    const DRIFT_IGNORE_MS = 150
    const DRIFT_HARD_MS = 1800
    const RATE_UP = 1.05
    const RATE_DN = 0.95
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
      //
      // 2026-05-25 — apply NTP-style clock-offset correction. Without
      // this, the subtraction `Date.now() - t.server_now_ms` carries
      // the client's clock skew into elapsedMs, which becomes false
      // drift. A guest with their machine clock running 800ms behind
      // the server's would see persistent 800ms behind-target drift
      // that no rate-correction could close (the target keeps moving
      // away). The offset is filled by repeated time-syncs on the
      // sync socket (see useParty.tsx).
      // 2026-06 review (bug 4) — a tick we received more than ~3s ago
      // means the sync socket is down or the server stalled. The old
      // fallback corrected against the FROZEN t.abs_ms, which during any
      // outage longer than a few seconds produced a snap-back loop: the
      // guest plays forward, drifts past the frozen target, and gets
      // yanked back ~every 2s until sync recovers. Free-run instead:
      // reset the rate and skip correction until a fresh tick/hello
      // arrives (reconnect repopulates tickRef; the give-up paths in
      // useParty null it entirely).
      //
      // Staleness is judged by LOCAL receipt age (receivedAtMs, stamped
      // by useParty), NOT by Date.now() - t.server_now_ms: the latter
      // includes client↔server clock skew, so before the time-sync
      // offset converges a machine whose clock runs >3s fast would
      // misclassify every fresh tick as stale and silently never correct.
      const tickAgeMs = Date.now() - (t.receivedAtMs ?? Date.now())
      if (tickAgeMs > 3000) {
        if (vid.playbackRate !== 1.0) vid.playbackRate = 1.0
        return
      }
      const clockOffset = party.clockOffsetRef?.current ?? 0
      const correctedNow = Date.now() + clockOffset
      // Project the tick forward by elapsed server time, clamped to the
      // local receipt age (+ a small jitter margin): with a fresh tick the
      // true elapsed can't exceed how long ago we received it, so the
      // clamp stops residual clock skew from inflating the target.
      const elapsedMs = Math.min(
        Math.max(0, correctedNow - t.server_now_ms),
        tickAgeMs + 500,
      )
      const projectedAbsMs = t.abs_ms + elapsedMs
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
      // Never broadcast while the player is still (re)booting:
      // startSecRef is 0 and currentTime snaps to 0 during boot, so a transient
      // 'seeked'/'pause' would otherwise propagate abs_ms=0 to the whole party.
      playerReadyRef.current &&
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

    // 2026-05-25 — Race-recovery for host broadcast. The play event can
    // fire BEFORE `party.isHost` resolves to true: when the player
    // opens, hls.js often autoplays as soon as MANIFEST_PARSED fires,
    // which can land in the same render where `party.state.hostUserId`
    // is still undefined (it's set atomically with party-state but
    // React's render order can split it from `playerTarget`). At that
    // moment, App.tsx computes `isHost: party.state.hostUserId ===
    // user.id` as `undefined === 1 → false`, the play listener
    // captures isHost=false, hostShouldBroadcast() returns false, and
    // request-play never goes out. Server's ps.IsPlaying stays false,
    // brother never gets a tick, brother's auto-open never fires.
    //
    // The useEffect re-runs when party.isHost flips (it's in the
    // dep array), so the second binding has isHost=true — but the
    // play event has already passed; no new play event fires because
    // the video is already playing locally.
    //
    // Fix: on every re-bind, if we're the host AND the video is
    // already playing locally AND the party doesn't yet know,
    // re-broadcast. This catches the race and any other timing edge
    // that suppressed the initial play.
    //
    // 2026-05-25 deep-debug (High #3) — gate the recovery behind a
    // per-target ref. Without this, unrelated parent re-renders (a
    // chat message arrives in PartyPanel, a participant joins, a
    // reaction overlay state ticks) re-run this useEffect (`party` is
    // a fresh inline-object literal in App.tsx on every render), and
    // re-fire requestPlay between the original wire-send and the
    // server's first tick. Server is idempotent on request-play so
    // those are mostly waste, BUT: if the host seeks inside that
    // window before the sync WS is open, `pendingSyncIntentRef` in
    // useParty buffers the seek (last-write-wins), and the next
    // recovery fire overwrites the buffered seek with request-play.
    // Seek is lost. The ref resets only when target identity changes
    // (new movie/episode), so a single recovery per player-bind.
    if (party.isHost && playerReadyRef.current && !vid.paused && !party.isPlaying && !isApplyingRemote() &&
        !hostBroadcastRecoveryFiredRef.current &&
        (party.partyMediaItemId === undefined || party.partyMediaItemId === target.mediaItemId)) {
      hostBroadcastRecoveryFiredRef.current = true
      party.requestPlay()
    }

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
  //
  // Med-fix (2026-05-29) — DROPPED the raw `party` object from the
  // dep array. App.tsx builds the `party` prop as a fresh object
  // literal (`party.state.code ? { … } : undefined`) on EVERY render,
  // so depending on its identity tore this effect down + rebound it
  // (clearing the 250ms drift interval and re-adding the play/pause/
  // seeked listeners) on every unrelated App re-render — a chat
  // message, a participant joining, a reaction tick. We now depend on
  // the stable primitive fields the effect's body actually reads at
  // bind time, plus `Boolean(party)` so the effect still re-runs when
  // the party transitions null↔active. Everything the bound event
  // handlers reference at event time — requestPlay/requestPause/
  // requestSeek (stable useCallbacks over a no-dep sendOrBuffer in
  // useParty) and tickRef/clockOffsetRef (stable useRefs) — keeps
  // working across renders without a rebind.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, Boolean(party), party?.isHost, party?.isPlaying, party?.partyMediaItemId])

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
      // Issue #309 — iOS Safari reports the active fullscreen element via the
      // webkit-prefixed property, so check both.
      const fsEl = document.fullscreenElement ?? document.webkitFullscreenElement
      setFullscreen(fsEl === overlayRootRef.current)
    }
    // Issue #177 — natural end of playback. Defer entirely to the
    // parent (auto-play-next decision lives there). 'ended' fires once
    // per playthrough; the parent re-targets on advance, which tears
    // down + rebuilds this effect for the next episode.
    //
    // Smart Skip — when the credits-triggered next-up card already
    // fired an early advance, the old <video> can still reach its real
    // end before teardown; the guard stops that from advancing a
    // SECOND time (skipping an episode).
    const onEndedDom = () => {
      if (advanceFiredRef.current) return
      void onEndedRef.current?.()
    }
    vid.addEventListener('play', onPlay)
    vid.addEventListener('pause', onPause)
    vid.addEventListener('timeupdate', onTimeUpdate)
    vid.addEventListener('progress', onProgress)
    vid.addEventListener('durationchange', onDurationChange)
    vid.addEventListener('volumechange', onVolumeChange)
    vid.addEventListener('ended', onEndedDom)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    // iOS Safari fires the webkit-prefixed event instead (issue #309).
    document.addEventListener('webkitfullscreenchange', onFullscreenChange)
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
      vid.removeEventListener('ended', onEndedDom)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
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
  //
  // 2026-05-20 — auto-hide TEMPORARILY disabled while we hunted a
  // stuck-hidden bug: controls would fade at 3s and never reappear
  // on hover. Root cause turned out to be the flexbox overflow
  // issue (min-h-0 missing on the video container — the <video>
  // was pushing the container 1.25px past the viewport bottom, so
  // PlayerControls — `absolute bottom-0` inside it — rendered
  // off-screen the moment ANY layout reflow happened).
  //
  // 2026-05-21 — re-enabled now that the min-h-0 fix has been
  // running in production for a day with zero stuck-control
  // reports. The setTimeout + ref machinery was preserved
  // throughout the disable so re-enabling is a 5-line change.
  const showControlsTemporarily = useCallback(() => {
    setControlsVisible(true)
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    // Only schedule the auto-hide when:
    //   - playingRef.current is true — hiding during pause is just
    //     hostile UX; the user is contemplating their next move
    //   - lastInBottomZoneRef.current is false — the user's cursor
    //     is NOT in the seek-bar/buttons region; pinning visible
    //     when they're clearly aiming at controls matches
    //     Netflix / YouTube / Plex behavior
    if (playingRef.current && !lastInBottomZoneRef.current) {
      hideTimerRef.current = window.setTimeout(() => {
        setControlsVisible(false)
        hideTimerRef.current = null
      }, 3000)
    }
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

  // Med-fix (2026-05-29) — single seek entry point in REAL-FILE
  // seconds. Previously the forward-seek-rebuild logic lived ONLY in
  // the scrub bar's inline onSeek; the +30s skip button (onSeekRelative)
  // and the ArrowRight keyboard shortcut did a raw `vid.currentTime +=`
  // which, on a sequential transcode, seeks PAST the FFmpeg output head
  // and stalls hls.js indefinitely (the segment isn't on disk yet).
  // Routing every seek through here means the skip button + ArrowRight
  // trigger the same transcode rebuild the scrubber does, instead of
  // stalling. `sec` is the absolute media position (REAL-FILE seconds),
  // matching what PlayerControls' onSeek emits.
  const seekToRealSec = useCallback((sec: number) => {
    // Map a REAL-FILE second back into the local video element's
    // currentTime by subtracting the session's startSec offset.
    const vid = videoRef.current
    if (!vid) return
    const localSec = sec - (startSecRef.current ?? 0)
    // Party gate is shared by both the backward-seek and forward-seek
    // rebuild paths below; compute it once here.
    const isPartySyncingThisMedia = !!party
      && party.partyMediaItemId !== undefined
      && target?.mediaItemId === party.partyMediaItemId
    // Backward-seek BEFORE the session's start_sec offset requires a
    // session rebuild — FFmpeg can't rewind a sequential transcode.
    // Use the same rebuild gate as the forward-seek path: if
    // onSeekRebuild is wired and we're not party-syncing, kick off a
    // new session anchored at the requested position. Otherwise clamp
    // to the local timeline start (legacy fallback).
    if (localSec < 0) {
      if (onSeekRebuild && !isPartySyncingThisMedia) {
        onSeekRebuild(Math.max(0, sec))
      } else {
        try { vid.currentTime = 0 } catch { /* defensive */ }
      }
      return
    }
    // Audit H3 fix — forward-seek past the buffered range stalls
    // hls.js indefinitely (the transcoder is sequential; segments
    // past the current FFmpeg output position aren't on disk yet).
    // Two paths:
    //
    // 2026-05-27 (preferred) — if onSeekRebuild is wired AND this
    // player isn't participating in a watch-party sync for THIS media,
    // ask the parent to tear down + re-create the session anchored at
    // the requested seconds. The play effect handles teardown /
    // re-init the same way it does for audio-track switches. This is
    // the Plex / Jellyfin pattern.
    //
    // The party gate (deep-debug M1) is intentionally narrow: blocked
    // ONLY when the local target IS the party-tracked media. A user
    // who joined a party but is currently watching something else
    // locally can still rebuild — no guest is mirroring this stream
    // so there's nothing to drift.
    //
    // Deep-debug H2 — boundary tolerance: a 0.5s slack ensures
    // near-edge clicks (where users intend a forward jump but click
    // exactly on the buffered edge) still trigger the rebuild instead
    // of landing on the stall point.
    //
    // Fallback (legacy) — clamp the seek to the buffered edge and
    // toast a status hint. Reachable in two cases now: (a) when no
    // onSeekRebuild handler is wired (defensive — App always wires it
    // today), and (b) when party-sync is active for this media (host
    // rebuild would desync guests; tracked as a follow-up). See
    // App.tsx where the player is mounted for the rebuild wiring.
    const safeBufferedEnd = bufferedSec - (startSecRef.current ?? 0)
    if (safeBufferedEnd > 0 && localSec >= safeBufferedEnd - 0.5) {
      if (onSeekRebuild && !isPartySyncingThisMedia) {
        // No interim status — the play effect's teardown immediately
        // re-sets status to 'Loading…' (deep-debug M2: 'Jumping to
        // that point…' would only flash for one render frame because
        // both setStatus calls batch together, so it's not worth
        // setting).
        onSeekRebuild(sec)
        return
      }
      try {
        // Land 1s back from the buffered edge to avoid landing right
        // at the boundary where hls.js stalls waiting for the next
        // segment.
        vid.currentTime = Math.max(0, safeBufferedEnd - 1)
      } catch { /* defensive */ }
      setStatus(isPartySyncingThisMedia
        ? 'Forward-seek past buffer blocked while syncing with the party'
        : 'Still transcoding to that point — try again in a moment')
      return
    }
    try {
      vid.currentTime = localSec
    } catch { /* defensive */ }
  }, [bufferedSec, party, target, onSeekRebuild])

  // Med-fix (2026-05-29) — ref mirror of seekToRealSec so the
  // keyboard-shortcut effect (registered once per `target`, with an
  // eslint-disabled dep array) can reach the LATEST seek logic without
  // re-binding the listener on every bufferedSec change. Reading via
  // ref is the same stale-closure-avoidance pattern used elsewhere in
  // this file (playingRef, currentSubIndexRef, …).
  const seekToRealSecRef = useRef(seekToRealSec)
  useEffect(() => { seekToRealSecRef.current = seekToRealSec }, [seekToRealSec])

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
      // When minimized to the cast/AirPlay widget, don't hijack global keys
      // (space/arrows) for the off-screen local player — the widget owns
      // control. Ref so this [target]-bound handler sees the live value.
      if (minimizedRef.current) return
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          if (vid.paused) void vid.play().catch(() => { /* defensive */ })
          else vid.pause()
          break
        case 'ArrowLeft':
          e.preventDefault()
          // Med-fix (2026-05-29) — route through the shared seek path
          // (REAL-FILE seconds = local currentTime + startSec offset).
          // Backward seeks just clamp; the rebuild branch is never hit
          // going back, so this preserves the old -10s behavior.
          seekToRealSecRef.current((vid.currentTime + (startSecRef.current ?? 0)) - 10)
          break
        case 'ArrowRight':
          e.preventDefault()
          // Med-fix (2026-05-29) — was a raw `vid.currentTime + 10`,
          // which seeks past the FFmpeg output head and stalls hls.js
          // on a sequential transcode. Routing through seekToRealSec
          // triggers a transcode rebuild when the +10s jump lands past
          // the buffered head, matching the scrub bar.
          seekToRealSecRef.current((vid.currentTime + (startSecRef.current ?? 0)) + 10)
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
  //
  // Issue #309 — iOS Safari does not implement the standard
  // `requestFullscreen`/`exitFullscreen` on a <div>; it only exposes the
  // `webkit`-prefixed names. Calling the standard method unconditionally
  // throws "requestFullscreen is not a function", which crashed the player
  // and could disrupt an in-flight AirPlay session. Feature-detect both.
  const handleFullscreenToggle = () => {
    const el = overlayRootRef.current
    if (!el) return
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) {
        void document.exitFullscreen().catch(() => { /* defensive */ })
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen()
      }
    } else if (el.requestFullscreen) {
      void el.requestFullscreen().catch(() => { /* defensive */ })
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen()
    }
  }

  // Issue #133 — auto-clear the subtitle-error toast after 4s so the
  // picker UI doesn't get stuck in an error state. The user can also
  // dismiss it by picking another track (applySubtitle clears it
  // explicitly at the start of every attempt).
  useEffect(() => {
    if (!subError) return
    const id = window.setTimeout(() => setSubError(null), 4000)
    return () => window.clearTimeout(id)
  }, [subError])

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
  //
  // Issue #133 — duration source: PREFER the server-provided
  // realDurationSec over vid.duration. vid.duration is the HLS EVENT
  // playlist length, which GROWS as ffmpeg produces segments — it's
  // not the file duration. Using it gives inflated progress
  // percentages on the Continue Watching home rail (and everywhere
  // else that reads percent_complete) until ffmpeg catches up to
  // end-of-file (which, for a slow transcode of a long movie, may
  // never happen in a single viewing session). The custom controls'
  // time display already uses realDurationSec; the progress saver
  // was the missed spot.
  useEffect(() => {
    if (!target) return
    const id = window.setInterval(() => {
      const vid = videoRef.current
      if (!vid || vid.paused) return
      const offsetMs = (startSecRef.current ?? 0) * 1000
      const posMs = Math.round(vid.currentTime * 1000) + offsetMs
      // realDurationSec is the FULL file duration (from
      // /api/stream/info/{id}.stream.duration_ms). It's NOT
      // offset-shifted, so no +offsetMs. Read via ref so the
      // setInterval closure always sees the latest value WITHOUT
      // forcing the effect to retear on every change (which on
      // HLS-fallback would happen on every durationchange and
      // defer the 10s timer indefinitely — deep-debug H1).
      // Fall back to the old playlist-length math only if the
      // server didn't return a duration (legacy/missing-probe case
      // — serverDurationRef.current is FALSE).
      let durMs: number
      const realDur = realDurationSecRef.current
      if (serverDurationRef.current && realDur > 0) {
        durMs = Math.round(realDur * 1000)
      } else {
        durMs = Math.round((vid.duration || 0) * 1000) + offsetMs
      }
      if (durMs <= 0) return
      void reportProgress(target.mediaItemId, {
        position_ms: posMs,
        duration_ms: durMs,
        episode_id: target.episodeId,
      }).catch(() => { /* fire-and-forget */ })
    }, 10000)
    return () => window.clearInterval(id)
  }, [target])

  // ── Smart Skip: credits-triggered "Next Episode" card ────────────
  // Crossing the credits onset on a TV episode surfaces the next-up
  // card: a 5s countdown when the autoplay preference is on, an
  // explicit button when it's off. Both routes drive the SAME parent
  // advance path the <video> 'ended' event uses — the card just moves
  // the decision to the start of the credits instead of the end.
  // Suppressed in watch parties (a unilateral advance would desync
  // guests; same rule as the parent's 'ended' handling) and while
  // casting (the receiver's IDLE transition owns end-of-media there).
  const creditsMarker = target?.fileType === 'episode'
    ? skipMarkers.find(m => m.kind === 'credits' && m.end_ms > m.start_ms) ?? null
    : null

  const fireAdvance = useCallback(async (force: boolean) => {
    if (advanceFiredRef.current) return
    advanceFiredRef.current = true
    setNextUpPhase('spent')
    let advanced = false
    try {
      advanced = !!(await onEndedRef.current?.(force ? { force: true } : undefined))
    } catch { /* parent resolve failed — stay parked on this episode */ }
    if (!advanced) {
      // No next episode (series end) or the resolve failed. Re-arm the
      // natural 'ended' flow so close-out behavior matches a playthrough
      // without markers, and show brief "that's the last one" feedback
      // instead of a card that promised a next episode and vanished.
      advanceFiredRef.current = false
      setNextUpPhase('finale')
    }
  }, [])

  useEffect(() => {
    if (nextUpPhase !== 'idle' || !creditsMarker) return
    if (!playing) return // don't pop the card under a paused frame
    if (party || cast.status.connected) return
    if (currentSec < creditsMarker.start_ms / 1000) return
    setNextUpSecs(5)
    setNextUpPhase(readAutoplayPref() ? 'countdown' : 'prompt')
  }, [nextUpPhase, creditsMarker, playing, party, cast.status.connected, currentSec])

  // Seeking back OUT of the credits window (rewatching the final
  // scene) cancels an armed card — without this the countdown keeps
  // ticking and yanks the viewer to the next episode mid-rewatch.
  // Back to 'idle' so re-crossing the onset arms it again.
  useEffect(() => {
    if (nextUpPhase !== 'countdown' && nextUpPhase !== 'prompt') return
    if (!creditsMarker) return
    if (currentSec < creditsMarker.start_ms / 1000 - 1) {
      setNextUpPhase('idle')
    }
  }, [nextUpPhase, creditsMarker, currentSec])

  // Countdown tick — freezes while paused (pausing mid-countdown is
  // a "wait, I'm not done" signal; resuming resumes the count).
  useEffect(() => {
    if (nextUpPhase !== 'countdown' || !playing) return
    if (nextUpSecs <= 0) {
      void fireAdvance(false)
      return
    }
    const id = window.setTimeout(() => setNextUpSecs(s => s - 1), 1000)
    return () => window.clearTimeout(id)
  }, [nextUpPhase, nextUpSecs, playing, fireAdvance])

  // Finale notice auto-dismisses to 'spent' (terminal for this
  // playback) after a few seconds.
  useEffect(() => {
    if (nextUpPhase !== 'finale') return
    const id = window.setTimeout(() => setNextUpPhase('spent'), 4000)
    return () => window.clearTimeout(id)
  }, [nextUpPhase])

  if (!target) return null

  // Smart Skip — which skippable window is the playhead inside right
  // now? Intro/recap pills on any file; the credits pill only for
  // MOVIES (episodes route credits through the next-up card above).
  // Hidden for party GUESTS (a guest seek would fight the host's
  // sync; the host's skip propagates to everyone via the normal seek
  // broadcast) and while casting (currentSec tracks the paused local
  // element, not the receiver). The pill stays up for the whole
  // window minus its last second — a skip that close to the boundary
  // isn't worth a seek.
  const activeSkipMarker = (() => {
    if (cast.status.connected || minimizedActive || errorMsg) return null
    if (party && !party.isHost) return null
    for (const m of skipMarkers) {
      if (m.end_ms <= m.start_ms) continue
      const isOpener = m.kind === 'intro' || m.kind === 'recap'
      const isMovieCredits = m.kind === 'credits' && target.fileType === 'media'
      if (!isOpener && !isMovieCredits) continue
      if (skipDismissedKey === `${m.kind}:${m.start_ms}`) continue
      // Movie credits seek to ~EOF. On a sequential transcode that
      // hasn't produced the tail yet, the jump would force a session
      // rebuild anchored at (metadata-reported) EOF — which stalls
      // when the metadata overshoots the real duration. Only offer
      // the pill when the destination is already reachable: direct
      // play (no session) or a transcode buffered to the end.
      if (isMovieCredits && sessionIdRef.current !== null &&
          m.end_ms / 1000 - 0.25 > bufferedSec - 1) continue
      if (currentSec >= m.start_ms / 1000 && currentSec < m.end_ms / 1000 - 1) return m
    }
    return null
  })()
  const skipLabel = activeSkipMarker?.kind === 'recap'
    ? 'Skip Recap'
    : activeSkipMarker?.kind === 'credits' ? 'Skip Credits' : 'Skip Intro'
  const handleSkip = () => {
    if (!activeSkipMarker) return
    setSkipDismissedKey(`${activeSkipMarker.kind}:${activeSkipMarker.start_ms}`)
    // Movie credits: land just shy of EOF so 'ended' fires naturally
    // (progress marks watched; player parks on the final frame).
    const dest = activeSkipMarker.kind === 'credits'
      ? Math.max(activeSkipMarker.start_ms / 1000, activeSkipMarker.end_ms / 1000 - 0.25)
      : activeSkipMarker.end_ms / 1000
    seekToRealSec(dest)
  }

  // Minimized-widget control surface — drives the active remote: the
  // Chromecast receiver (via cast.remote / cast.playOrPause) or, for AirPlay,
  // the local <video> element that Safari is mirroring to the TV.
  const widgetPaused = cast.status.connected ? cast.remote.isPaused : !playing
  const widgetCurSec = cast.status.connected ? cast.remote.currentTime : currentSec
  const widgetDurSec = cast.status.connected ? cast.remote.duration : realDurationSec
  const widgetToggle = () => {
    if (cast.status.connected) { cast.playOrPause(); return }
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => { /* defensive */ })
    else v.pause()
  }
  const widgetStopAndClose = () => {
    if (cast.status.connected) cast.stop()
    else videoRef.current?.pause() // AirPlay ends when the source <video> unmounts on close
    onClose()
  }

  return (
    <>
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
      aria-hidden={minimizedActive || undefined}
      className={
        minimizedActive
          // Keep the full player MOUNTED but off-screen while minimized: the
          // Chromecast streaming session and the AirPlay <video> source must
          // stay alive (closing the laptop view must not kill the cast). The
          // floating widget below is the visible surface.
          ? 'fixed inset-0 -z-10 opacity-0 pointer-events-none'
          : 'fixed inset-0 z-[60] bg-black flex items-center justify-center'
      }
    >
      {/* 2026-05-28 — Player shell. WINDOWED (not browser-fullscreen):
          a centered card capped below the viewport so there's a clear
          black margin all around (the `bg-black` backdrop shows
          through), with rounded corners + a soft ring so it reads as
          an intentional theater surface rather than a chrome-less
          takeover. FULLSCREEN: fills the viewport edge-to-edge (the
          card chrome would look wrong against the screen bezel).
          The backdrop's `items-center justify-center` centers the
          capped card automatically. The <video> inside still uses
          object-contain, so the picture letterboxes within the card —
          margins you see are (card inset) + (aspect letterbox). */}
      <div
        className={
          fullscreen
            ? 'relative w-full h-full flex flex-col'
            : 'relative w-full h-full max-w-[94vw] max-h-[88vh] flex flex-col rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10'
        }
      >
        {/* Top bar. WINDOWED: a chrome strip above the video (part of the
            theater card), always visible. FULLSCREEN: an auto-hiding OVERLAY —
            positioned absolute so it no longer reserves layout space (the video
            fills the whole screen edge-to-edge), and gated on controlsVisible so
            the title / episode / "Remux · mkv" / Close fade out with the
            controls when the pointer is idle, leaving a clean full-screen
            picture. A mouse-move / touch reveals it again with the controls. */}
        <div
          className={
            fullscreen
              ? `absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-3 bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-200 ${
                  controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                }`
              : 'flex items-center justify-between px-6 py-3 bg-gradient-to-b from-black/80 to-transparent z-10'
          }
        >
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
                  onClick={() => { setAudioMenuOpen(o => !o); setSubsMenuOpen(false); setMarkersMenuOpen(false) }}
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
                {/* Issue #133 — transient error pill rendered above
                    the CC button when a subtitle track fails to
                    load. Auto-dismisses after 4s via the effect on
                    subError. role="status" so screen readers
                    announce it as a polite update. */}
                {subError && (
                  <div
                    role="status"
                    // top-full (opens downward) — this pill is anchored
                    // to a TOP-BAR button; opening upward (bottom-full)
                    // would clip against the windowed card's
                    // overflow-hidden (#98).
                    className="absolute top-full right-0 mt-1 px-2 py-1 bg-red-500/15 border border-red-500/40 text-red-200 rounded text-xs whitespace-nowrap pointer-events-none"
                  >
                    {subError}
                  </div>
                )}
                <button
                  onClick={() => { setSubsMenuOpen(o => !o); setAudioMenuOpen(false); setMarkersMenuOpen(false) }}
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
            {/* Smart Skip — admin-only marker editor. Lives in the
                player (not an admin page) because correcting a marker
                means eyeballing the timeline: pause on the intro's
                last frame, hit "End = now". Writes detector='manual'
                rows the background analyzer never overwrites. Hidden
                in parties — pausing/scrubbing to fix markers would
                drag every guest along. */}
            {isAdmin && !party && (
              <div className="relative">
                <button
                  onClick={() => { setMarkersMenuOpen(o => !o); setAudioMenuOpen(false); setSubsMenuOpen(false) }}
                  className="px-3 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg text-sm transition-colors"
                  aria-label="Edit skip markers"
                  title="Edit skip markers (admin)"
                >
                  Markers
                </button>
                {markersMenuOpen && (
                  <SkipMarkerEditor
                    fileId={target.fileId}
                    fileType={target.fileType}
                    currentSec={currentSec}
                    onMarkersChanged={(all) => setSkipMarkers(all.filter(m => m.end_ms > m.start_ms))}
                  />
                )}
              </div>
            )}
            {/* 2026-05-25 — "Resync Now" button. Guest-only escape hatch
                for when soft drift-correction hasn't caught up yet (e.g.
                after a quick network blip, a long pause, or because the
                guest's HLS pipeline is structurally a beat behind). Snaps
                the local player to the host's projected target position.
                Hidden for the host (would be a no-op + confusing UX) and
                hidden outside a party. Equivalent in spirit to Plex's
                "Sync" button + Jellyfin's "Re-sync" link. */}
            {party && !party.isHost && (
              <button
                onClick={() => {
                  const vid = videoRef.current
                  const t = party.tickRef.current
                  if (!vid || !t) return
                  // 2026-05-25 deep-debug (Medium #4) — media-match guard.
                  // tickRef can outlive the party that produced it (it's
                  // a ref, not state, so `party-ended` → setState(
                  // INITIAL_STATE) doesn't clear it). If the user joined
                  // a new party but kept the previous player open, the
                  // raw click would snap to the OLD party's projected
                  // position on the NEW party's media — confusing seek.
                  // The steady-state drift loop has the same guard at
                  // VideoPlayer.tsx ~941; mirror it here.
                  if (party.partyMediaItemId !== undefined && party.partyMediaItemId !== target.mediaItemId) return
                  // Apply same clock-offset + extrapolation logic as
                  // the steady-state drift loop so a manual click
                  // lands on EXACTLY where the loop is targeting.
                  // Without this, the button could undo all the
                  // existing soft-corrections by snapping to a stale
                  // tick position.
                  const clockOffset = party.clockOffsetRef?.current ?? 0
                  const correctedNow = Date.now() + clockOffset
                  const elapsedMs = Math.max(0, correctedNow - t.server_now_ms)
                  const projectedAbsMs = elapsedMs > 3000 ? t.abs_ms : (t.abs_ms + elapsedMs)
                  const targetSec = Math.max(0, (projectedAbsMs / 1000) - (startSecRef.current ?? 0))
                  // Same 300ms suppression as the hard-snap path so
                  // the resulting `seeked` event isn't re-broadcast
                  // by the guest's onSeeked handler as a request-seek
                  // (which would ping-pong every other guest).
                  extendSuppression(300)
                  try { vid.currentTime = targetSec } catch { /* defensive */ }
                  vid.playbackRate = 1.0
                }}
                className="px-3 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg text-sm transition-colors"
                aria-label="Resync to host"
                title="Snap to host's current position"
              >
                ⟳ Sync
              </button>
            )}
            {/* M10 Phase 4.5 — reaction picker (party only). */}
            {onSendReaction && (
              // vertical="down" — top-bar trigger; opening upward would
              // clip against the windowed card's overflow-hidden (#98).
              <ReactionPicker onSend={onSendReaction} vertical="down" />
            )}
            <button
              onClick={remoteActive ? () => setMinimized(true) : onClose}
              className="px-4 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg text-sm transition-colors"
              aria-label={remoteActive ? 'Minimize player' : 'Close player'}
              title={remoteActive ? 'Minimize — keeps the cast going' : 'Close player'}
            >
              {remoteActive ? 'Minimize' : 'Close'}
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
                // Opt the video into Safari's AirPlay target picker.
                // No-op everywhere else; ignored by non-WebKit browsers.
                x-webkit-airplay="allow"
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
              {/* Cast button. Visible whenever the Cast SDK loaded
                  successfully, NOT gated on a currently-reachable
                  receiver — mDNS discovery is slow and unreliable
                  on some networks, and YouTube/Netflix both show
                  the button even when no devices are yet visible
                  (the picker itself handles the "no devices"
                  case). Hidden in watch parties because the
                  receiver runs an independent playback timeline
                  the party can't sync with.

                  AirPlay deliberately has no custom button: Safari
                  renders its own native AirPlay glyph on the video
                  element when `x-webkit-airplay="allow"` is set
                  and a receiver is reachable. A second button
                  would be visual clutter that opens the same
                  picker. Chrome has no AirPlay support at all,
                  so there's nothing to add there either.

                  UPDATE (cast/AirPlay controls) — our custom controls SUPPRESS
                  Safari's native AirPlay glyph, so we surface our own button
                  that opens the system target picker. Shown only when a
                  wireless target is available (Chrome never fires availability,
                  so it stays hidden there). */}
              {!party && airplayAvailable && !cast.status.connected && (
                <div
                  className={`absolute ${fullscreen ? 'top-24' : 'top-4'} right-4 flex items-center gap-2 transition-opacity duration-200 ${
                    controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => videoRef.current?.webkitShowPlaybackTargetPicker?.()}
                    title="AirPlay to an Apple TV or AirPlay device"
                    aria-label="AirPlay"
                    className="inline-flex items-center justify-center rounded-full w-9 h-9 text-white bg-black/60 hover:bg-black/80"
                  >
                    <Airplay size={18} />
                  </button>
                </div>
              )}
              {!party && cast.status.supported && (
                <div
                  className={`absolute ${fullscreen ? 'top-24' : 'top-4'} right-4 flex items-center gap-2 transition-opacity duration-200 ${
                    controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                  }`}
                >
                  {cast.status.connected ? (
                    <button
                      type="button"
                      onClick={() => cast.stop()}
                      title={`Stop casting to ${cast.status.deviceName ?? 'device'}`}
                      aria-label="Stop casting"
                      className="inline-flex items-center gap-2 rounded-full bg-purple-600/90 hover:bg-purple-600 px-3 h-9 text-white text-xs font-medium"
                    >
                      <StopCircle size={16} />
                      <span className="hidden sm:inline">
                        Casting to {cast.status.deviceName ?? 'device'}
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        void cast.start().catch((err) => {
                          // Log + briefly flag the button. Deliberately
                          // do NOT call setErrorMsg here — that would
                          // surface the full-screen "Playback Error"
                          // overlay used for actual hls.js failures,
                          // killing the in-progress local playback over
                          // a transient cast hiccup. The user can just
                          // click Cast again to retry.
                          const msg = err instanceof Error ? err.message : String(err)
                          if (!/cancel|dismiss/i.test(msg)) {
                            // eslint-disable-next-line no-console
                            console.warn('[Aurora Cast] start failed:', msg)
                            flashCastError(msg)
                          }
                        })
                      }}
                      title={
                        cast.status.available
                          ? 'Cast to a Chromecast device'
                          : 'Cast (no devices found — check that your Chromecast is on the same Wi-Fi)'
                      }
                      aria-label="Cast"
                      // Dim the button when no devices are visible so users
                      // get a visual hint that it may not do anything yet,
                      // without hiding it entirely (the SDK's picker will
                      // surface the real status if they click).
                      className={`inline-flex items-center justify-center rounded-full w-9 h-9 text-white ${
                        cast.status.available
                          ? 'bg-black/60 hover:bg-black/80'
                          : 'bg-black/40 hover:bg-black/60 text-white/70'
                      }`}
                    >
                      <Cast size={18} />
                    </button>
                  )}
                </div>
              )}
              {/* Cast error toast — positioned just under the Cast
                  button cluster. Auto-clears after 4s via setTimeout
                  in the click handler. Local playback continues
                  unaffected. */}
              {castError && (
                <div
                  className="absolute top-16 right-4 max-w-xs px-3 py-2 rounded-md bg-red-600/90 text-white text-xs shadow-lg"
                  role="status"
                  aria-live="polite"
                >
                  Cast failed: {castError}
                </div>
              )}
              {/* Smart Skip pill — Netflix-style bottom-right button
                  while the playhead is inside an intro/recap (or, for
                  movies, credits) window. Always visible during the
                  window regardless of controls auto-hide: surfacing
                  it IS the feature. Advisory only — a click seeks,
                  nothing ever auto-seeks. z-[55] floats it above the
                  controls overlay (z-50) so it stays clickable over
                  the gradient. */}
              {activeSkipMarker && (
                <button
                  type="button"
                  onClick={handleSkip}
                  className="absolute bottom-28 right-6 z-[55] inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-black/75 hover:bg-black/90 ring-1 ring-white/25 text-white text-sm font-medium shadow-xl backdrop-blur-sm transition-colors"
                >
                  {skipLabel}
                  <SkipForward size={16} />
                </button>
              )}
              {/* Smart Skip next-up card — appears when an episode
                  crosses its credits onset. Countdown mode when the
                  autoplay pref is on; explicit-button mode when off
                  (the click then forces the advance past the pref —
                  an explicit click outranks a passive setting). */}
              {(nextUpPhase === 'countdown' || nextUpPhase === 'prompt') && (
                <div className="absolute bottom-28 right-6 z-[55] w-72 rounded-xl bg-[#1a1a22]/95 ring-1 ring-white/10 shadow-2xl p-4">
                  <p className="text-white/50 text-[11px] uppercase tracking-wide">Up next</p>
                  <p className="text-white text-sm font-medium mt-1">
                    {nextUpPhase === 'countdown'
                      ? `Next episode in ${Math.max(0, nextUpSecs)}s`
                      : 'Next episode'}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { void fireAdvance(true) }}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium transition-colors"
                    >
                      <Play size={14} />
                      Play now
                    </button>
                    <button
                      type="button"
                      onClick={() => setNextUpPhase('spent')}
                      aria-label="Dismiss next-episode card"
                      title="Keep watching the credits"
                      className="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/80 text-sm transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )}
              {/* Series end: the advance found nothing to play. Brief
                  honest feedback (auto-dismisses) instead of a card
                  that promised a next episode and silently vanished. */}
              {nextUpPhase === 'finale' && (
                <div
                  role="status"
                  className="absolute bottom-28 right-6 z-[55] rounded-xl bg-[#1a1a22]/95 ring-1 ring-white/10 shadow-2xl px-4 py-3"
                >
                  <p className="text-white/80 text-sm">That's the last episode — you're all caught up.</p>
                </div>
              )}
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
                  // While Chromecasting, the play/pause control drives the
                  // RECEIVER (the local <video> is held paused as the surface).
                  if (cast.status.connected) { cast.playOrPause(); return }
                  const vid = videoRef.current
                  if (!vid) return
                  if (vid.paused) void vid.play().catch(() => { /* defensive */ })
                  else vid.pause()
                }}
                onSeek={seekToRealSec}
                onSeekRelative={(delta) => {
                  // Med-fix (2026-05-29) — was a raw
                  // `vid.currentTime = max(0, currentTime + delta)`,
                  // so the +30s skip button seeked past the FFmpeg
                  // output head and stalled hls.js. Convert the
                  // relative delta to a REAL-FILE absolute target
                  // (local currentTime + startSec offset + delta) and
                  // route through seekToRealSec, which triggers a
                  // transcode rebuild on a forward jump past the
                  // buffered head — same path the scrubber uses.
                  // Backward deltas flow through unchanged (the
                  // rebuild branch only fires near/past the buffered
                  // edge; going back just clamps).
                  const vid = videoRef.current
                  if (!vid) return
                  seekToRealSec((vid.currentTime + (startSecRef.current ?? 0)) + delta)
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
    {minimizedActive && (
      <div
        className="fixed bottom-4 left-4 z-[70] w-72 max-w-[calc(100vw-2rem)] rounded-2xl bg-zinc-900/95 backdrop-blur ring-1 ring-white/10 shadow-2xl p-3 text-white"
        role="dialog"
        aria-label="Cast controls"
      >
        <div className="flex items-center gap-2">
          {cast.status.connected ? (
            <Cast size={16} className="text-purple-400 shrink-0" />
          ) : (
            <Airplay size={16} className="text-sky-400 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{target.title}</p>
            <p className="text-[11px] text-white/50 truncate">
              {cast.status.connected
                ? `Casting to ${cast.status.deviceName ?? 'device'}`
                : 'Playing via AirPlay'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setMinimized(false)}
            title="Expand player"
            aria-label="Expand player"
            className="p-1.5 rounded-full hover:bg-white/10 transition-colors"
          >
            <Maximize2 size={15} />
          </button>
          <button
            type="button"
            onClick={widgetStopAndClose}
            title={cast.status.connected ? 'Stop casting' : 'Stop'}
            aria-label="Stop and close"
            className="p-1.5 rounded-full hover:bg-white/10 text-white/80 hover:text-red-400 transition-colors"
          >
            <X size={15} />
          </button>
        </div>
        <div className="mt-2.5 flex items-center gap-3">
          <button
            type="button"
            onClick={widgetToggle}
            aria-label={widgetPaused ? 'Play' : 'Pause'}
            className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-white text-black hover:bg-white/90 shrink-0 transition-colors"
          >
            {widgetPaused ? <Play size={16} className="ml-0.5" /> : <Pause size={16} />}
          </button>
          <div className="h-1 flex-1 rounded-full bg-white/15 overflow-hidden">
            <div
              className="h-full bg-white/80"
              style={{
                width: `${
                  widgetDurSec > 0
                    ? Math.min(100, Math.max(0, (widgetCurSec / widgetDurSec) * 100))
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      </div>
    )}
    </>
  )
}

// ── Smart Skip: admin marker editor ─────────────────────────────────
//
// Per-kind manual correction panel, anchored under the top bar's
// "Markers" button. Workflow: scrub/pause the video where the window
// should start, hit "Start = now", same for the end, Save. "Off"
// stores a zero-length suppression (the analyzer won't re-add the
// marker; the player never shows it); "Auto" deletes the row and
// queues fresh auto-detection server-side.

const MARKER_KINDS: SkipMarker['kind'][] = ['recap', 'intro', 'credits']

function fmtMarkerTime(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function SkipMarkerEditor({ fileId, fileType, currentSec, onMarkersChanged }: {
  fileId: number
  fileType: 'media' | 'episode'
  currentSec: number
  // Fires with the file's full updated marker list after every write
  // so the player's live overlay state stays in sync (the caller
  // filters out zero-length suppressions).
  onMarkersChanged: (markers: SkipMarker[]) => void
}) {
  type Draft = { start_ms: number; end_ms: number; detector?: string }
  const [drafts, setDrafts] = useState<Partial<Record<SkipMarker['kind'], Draft>>>({})
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const seedFromServer = useCallback((markers: SkipMarker[]) => {
    const next: Partial<Record<SkipMarker['kind'], Draft>> = {}
    for (const m of markers) {
      next[m.kind] = { start_ms: m.start_ms, end_ms: m.end_ms, detector: m.detector }
    }
    setDrafts(next)
  }, [])

  // Load the FULL marker list (including suppressions) on mount.
  useEffect(() => {
    const ac = new AbortController()
    getAdminSkipMarkers(fileId, fileType, ac.signal)
      .then(markers => { seedFromServer(markers); setLoaded(true) })
      .catch(e => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setErr('Failed to load markers')
        setLoaded(true)
      })
    return () => ac.abort()
  }, [fileId, fileType, seedFromServer])

  const setNow = (kind: SkipMarker['kind'], field: 'start_ms' | 'end_ms') => {
    const nowMs = Math.max(0, Math.round(currentSec * 1000))
    setDrafts(prev => {
      const d = prev[kind] ?? { start_ms: 0, end_ms: 0 }
      return { ...prev, [kind]: { ...d, [field]: nowMs } }
    })
  }

  const write = async (kind: SkipMarker['kind'], startMs: number, endMs: number) => {
    setBusy(true)
    setErr(null)
    try {
      const markers = await putSkipMarker(fileId, fileType, { kind, start_ms: startMs, end_ms: endMs })
      seedFromServer(markers)
      onMarkersChanged(markers)
    } catch {
      setErr('Save failed')
    } finally {
      setBusy(false)
    }
  }

  const redetect = async (kind: SkipMarker['kind']) => {
    setBusy(true)
    setErr(null)
    try {
      await deleteSkipMarker(fileId, fileType, kind)
      const markers = await getAdminSkipMarkers(fileId, fileType)
      seedFromServer(markers)
      onMarkersChanged(markers)
    } catch {
      setErr('Update failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="absolute top-full right-0 mt-1 w-80 bg-[#1a1a22] border border-white/[0.08] rounded-lg shadow-xl z-20 p-3">
      <p className="text-white/50 text-[11px] uppercase tracking-wide mb-2">Skip markers (admin)</p>
      {!loaded && <p className="text-white/40 text-sm">Loading…</p>}
      {loaded && MARKER_KINDS.map(kind => {
        const d = drafts[kind]
        const suppressed = !!d && d.start_ms === 0 && d.end_ms === 0 && d.detector === 'manual'
        const invalid = !!d && d.end_ms < d.start_ms
        return (
          <div key={kind} className="py-2 border-t border-white/[0.06] first:border-t-0">
            <div className="flex items-center justify-between">
              <span className="text-white/85 text-sm capitalize">{kind}</span>
              <span className="text-white/40 text-xs font-mono">
                {!d
                  ? 'none'
                  : suppressed
                    ? 'disabled'
                    : `${fmtMarkerTime(d.start_ms)} → ${fmtMarkerTime(d.end_ms)}${d.detector === 'manual' ? ' · manual' : ''}`}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
              <MarkerEditButton label="Start = now" disabled={busy} onClick={() => setNow(kind, 'start_ms')} />
              <MarkerEditButton label="End = now" disabled={busy} onClick={() => setNow(kind, 'end_ms')} />
              <MarkerEditButton
                label="Save"
                emphasis
                disabled={busy || !d || invalid}
                onClick={() => { if (d) void write(kind, d.start_ms, d.end_ms) }}
              />
              <MarkerEditButton label="Off" disabled={busy || suppressed} onClick={() => void write(kind, 0, 0)} />
              <MarkerEditButton label="Auto" disabled={busy || !d} onClick={() => void redetect(kind)} />
            </div>
            {invalid && <p className="text-amber-300/80 text-[11px] mt-1">End must be at or after start.</p>}
          </div>
        )
      })}
      {err && <p className="text-red-300 text-xs mt-2">{err}</p>}
      <p className="text-white/30 text-[11px] mt-2 leading-snug">
        Manual values stick — auto-detection never overwrites them.
        "Off" hides the marker; "Auto" re-queues detection.
      </p>
    </div>
  )
}

function MarkerEditButton({ label, onClick, disabled, emphasis }: {
  label: string
  onClick: () => void
  disabled?: boolean
  emphasis?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-2 py-1 rounded text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        emphasis
          ? 'bg-purple-600 hover:bg-purple-500 text-white'
          : 'bg-white/10 hover:bg-white/15 text-white/80'
      }`}
    >
      {label}
    </button>
  )
}
