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

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import Hls from 'hls.js'
import { Airplay, Cast, Maximize2, Pause, Play, SkipForward, StopCircle, VolumeX, X } from 'lucide-react'
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
import { playerSurface } from '@/lib/playerSurface'
import { bindInputModalityTracking, focusInChrome } from '@/lib/chromeFocus'
import { writePrefKey } from '@/lib/appearance'
import {
  buildSessionRequest,
  createCastToken,
  createDirectCastToken,
  createSession,
  deleteSession,
  getStreamInfo,
  keepalive,
  loadBandwidthEstimate,
  saveBandwidthEstimate,
  type AudioTrack,
  type SessionResponse,
  type StreamInfo,
  type SubtitleTrack,
} from '@/lib/streaming'
import { prewarmEnabled, takeWarmedSession } from '@/lib/prewarm'
import { attachPlaybackQoE, type QoECollector } from '@/lib/playbackQoE'
import { absoluteUrl, assertCastScopedToken, useCast } from '@/lib/cast'
import { isSyncDebugEnabled, recordSyncSample, type SyncDecision, type SyncSample } from '@/lib/syncDebug'
import {
  castPlayPauseMismatch,
  isCastHostSeekJump,
  needsHlsSessionRebuild,
  pauseIntentForReplacementSeek,
  projectPartyTickAbsMs,
  resolvePlaybackBootPause,
  shouldApplyExplicitPartySeek,
  shouldRebuildSeekBeforeDeliveryReady,
  shouldReplaceUnreadyTargetForExplicitSeek,
  shouldPreservePauseForBoot,
  shouldPreservePauseForLocalSeekRebuild,
  shouldPreservePauseOnSeekRebuild,
  shouldResyncCastReceiver,
  type PlaybackDeliveryMode,
} from '@/lib/partyPlayer'
import { nextUpArmSecond, type ReceivedSeekPayload } from '@/lib/party'

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
  currentUserId: number
  // Live refs the player polls each second. tick.abs_ms is in
  // SOURCE coordinates; player adds back hello.hls_start_sec via
  // helloAbsMsRef → 0 mapping to map to hls.js currentTime.
  // receivedAtMs is client-local (Date.now() at frame receipt, stamped by
  // useParty) — the drift loop's clock-skew-free staleness signal.
  tickRef: React.MutableRefObject<{ abs_ms: number; server_now_ms: number; running?: boolean; rev?: number; receivedAtMs?: number } | null>
  // Most recent explicit host seek, enriched client-side with a monotonic
  // sequence. Guests use this to rebase sequential HLS exactly once.
  seekRef: React.MutableRefObject<ReceivedSeekPayload | null>
  helloAbsMsRef: React.MutableRefObject<number>
  // Server-reported hls_start_sec (FFmpeg -ss snapped offset). Tick
  // abs_ms minus this gives hls.js-relative seconds.
  hlsStartSec: number
  // The server's last-known isPlaying. Drives guest-side play/pause
  // mirroring when no recent tick has arrived to disambiguate.
  isPlaying: boolean
  // Shared monotonic room/sync revision. A seek boot captures this so a newer
  // canonical Pause/Play received while the stream resolves can supersede the
  // point-in-time seek intent without letting same-revision React lag win.
  rev: number
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
  // 2026-06-15 — smoothed round-trip time from the same NTP-style
  // time-sync that fills clockOffsetRef. Only read by the opt-in
  // sync-debug instrumentation (syncDebug.ts); the drift loop itself
  // doesn't use it. Optional so non-debug callers needn't thread it.
  rttRef?: React.MutableRefObject<number>
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
  // One-shot token assigned when party recovery auto-opens a player while the
  // canonical room is Paused. VideoPlayer consumes each token once so later
  // audio/fallback/seek target mutations do not become permanently paused.
  pauseOnBootToken?: number
  // Marks targets created by party auto-open/media-change resolution. Those
  // network-bound boots re-check canonical play/pause state when they finish.
  partyRecoveryBoot?: boolean
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
  // Re-emit the target with forceTranscode=true. resumeAtMs carries the
  // current playback position into the retry so a mid-movie fallback
  // resumes where the user was (2026-07 review).
  onFallbackToTranscode?: (resumeAtMs?: number) => void
  // 2026-05-27 — Forward-seek session rebuild. Aurora's transcoder is
  // sequential (segments past the current FFmpeg output position
  // aren't on disk), so a normal forward-seek past the buffered range
  // would stall hls.js indefinitely. The old behavior clamped the
  // seek to the buffered edge and toasted "Still transcoding to that
  // point — try again in a moment." Now: when this callback is wired,
  // the player asks the parent to tear down + re-create the HLS
  // session anchored at the new `start_sec` (mirroring the
  // onChangeAudioTrack path), so the user can scrub anywhere. The
  // In a watch party the host broadcasts the absolute seek before using this
  // callback; guests consume that explicit frame and invoke the same callback
  // for their independent sessions. Argument is in real-file seconds (the
  // absolute media position, NOT video element currentTime), matching what the
  // scrubber emits to onSeek.
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
  // Issue #460 — the next-up card's party counterpart. In a watch party
  // the host's advance must move the ROOM, not this player, so the card
  // routes here instead of onEnded (which refuses to advance in a party
  // precisely because a unilateral re-point desyncs guests). The parent
  // resolves the next episode and sends `change-media`; the resulting
  // server broadcast is what actually re-points every client, host
  // included. Only wired for the host — guests never see the card.
  onPartyAdvance?: () => Promise<'advanced' | 'end' | 'failed'>
  // Reports whether the player has collapsed to the cast/AirPlay control
  // widget, so the parent can suppress Escape/back-to-close while casting.
  onMinimizedChange?: (minimized: boolean) => void
  // Aurora Stage Phase 7b (D5). Reports which surface the player is presenting
  // so the parent can dim + inert the app behind the theater box. 'theater' is
  // the only value that needs anything from the parent — fullscreen covers the
  // viewport and minimized is off-screen, so in both cases what's behind is
  // invisible anyway and dimming it would be wasted compositing.
  onSurfaceChange?: (surface: 'theater' | 'fullscreen' | 'minimized' | null) => void
  // Smart Skip — gates the in-player marker editor (manual correction
  // writes through admin-only endpoints, so the UI only mounts for
  // admins).
  isAdmin?: boolean
}

interface SeekBootIntent {
  preservePause: boolean
  partyRevision: number | null
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

// Issue #460 — how long the host's card waits for a sent party swap to
// come back as a `media-change` broadcast before re-offering the button.
// Generous: it covers a server round-trip plus the guest-side episode
// resolve, and the only cost of waiting is a card that lingers on a room
// that already moved (the file change clears it the moment it lands).
const PARTY_SWAP_WATCHDOG_MS = 12_000

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

// Persisted player volume, same aurora_prefs bucket as the autoplay pref
// above. The <video> element fully unmounts between playback sessions, so
// without this every player open boots at useState(1) — 100% volume — and
// the night-time viewer lunges for the slider on every title. Volume only:
// mute is deliberately session-scoped, because the watch-party muted-
// autoplay fallback (#334) mutes the element programmatically, and a
// persisted flag would replay a mute the user never chose onto the next,
// unrelated playback.
function readVolumePref(): number | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('aurora_prefs') || '{}')
    if (raw && typeof raw === 'object') {
      const v = (raw as Record<string, unknown>).player_volume
      if (typeof v === 'number' && Number.isFinite(v)) {
        return Math.min(1, Math.max(0, v))
      }
    }
  } catch { /* malformed prefs — no restore */ }
  return null
}

function writeVolumePref(volume: number): void {
  // Through the blob's owner rather than a local read-modify-write. The clamp
  // stays here: it is this key's contract, not the writer's.
  writePrefKey('player_volume', Math.min(1, Math.max(0, volume)))
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
// loadBandwidthEstimate / saveBandwidthEstimate (the persisted ABR seed used by
// the Hls config's abrEwmaDefaultEstimate) now live in lib/streaming.ts so the
// details-page pre-warm can read the SAME estimate to predict the start tier.

// attemptPlay starts playback with a muted-autoplay fallback for the
// watch-party case. Browsers block a *sounded* programmatic play() that
// isn't tied to a fresh user gesture (autoplay policy) — which is exactly
// how a party starts playback (driven by a WebSocket tick/hello, not a
// click). The result is the video silently stays paused until the user
// performs some gesture (issue #334: "didn't start until I went full
// screen" — entering fullscreen runs play() inside a gesture). Muted
// autoplay IS permitted without a gesture, so on a block we retry muted
// and call onMutedAutostart() so the UI can offer a one-tap unmute.
//
// muteFallback is false for ordinary single-viewer playback: there we'd
// rather leave the video paused for an explicit click (with sound) than
// start it muted, since the user is right there and a gesture is one tap
// away. In a party, a stuck/desynced player is the worse outcome, so the
// caller passes true.
async function attemptPlay(
  vid: HTMLVideoElement,
  muteFallback: boolean,
  onMutedAutostart: () => void,
): Promise<void> {
  try {
    await vid.play()
    return
  } catch {
    // NotAllowedError (sounded autoplay refused) or a teardown race.
    if (!muteFallback) return // leave it to the user's explicit play
  }
  const prevMuted = vid.muted
  try {
    vid.muted = true
    await vid.play()
    onMutedAutostart()
  } catch {
    // Still blocked (or play() raced a teardown). Restore the prior mute
    // state so we don't leave a paused element silently muted with no
    // "Tap for sound" pill (which only shows on a SUCCESSFUL muted start).
    vid.muted = prevMuted
  }
}

// focusInChrome now lives in lib/chromeFocus, gated on input MODALITY:
// only keyboard-originated focus pins the chrome. The pre-2026-08-09 version
// read focus alone, so a mouse click on any chrome control (the fullscreen
// button being the usual last click before sitting back) stranded focus
// inside `data-player-chrome` and suppressed the auto-hide timer forever.

export function VideoPlayer({ target, onClose, party, onChangeAudioTrack, onSendReaction, onFallbackToTranscode, onSeekRebuild, onEnded, onPartyAdvance, onMinimizedChange,
  onSurfaceChange, isAdmin }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // Issue #177 — hold the latest onEnded in a ref so the 'ended'
  // listener (bound in the [target] effect) always invokes the current
  // callback without re-subscribing on every render.
  const onEndedRef = useRef(onEnded)
  onEndedRef.current = onEnded
  // Issue #460 — same ref treatment for the party advance, read by
  // fireAdvance (which holds no deps so the countdown effect stays stable).
  const onPartyAdvanceRef = useRef(onPartyAdvance)
  onPartyAdvanceRef.current = onPartyAdvance
  const hlsRef = useRef<Hls | null>(null)
  // Playback QoE collector for the CURRENT playback (August 2026 review item
  // #1). Held in a ref rather than state because nothing renders from it and a
  // re-render must never restart the measurement.
  const qoeRef = useRef<QoECollector | null>(null)
  // performance.now() at the moment the user asked for playback. Captured as
  // early as the effect runs so click-to-first-frame measures what the viewer
  // actually waited through, not just the part after the manifest resolved.
  const playRequestedAtRef = useRef<number | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  // sessionId=null means both "native direct play" and "an HLS target is
  // still resolving". Keep the delivery state explicit so a second rapid seek
  // replaces the pending HLS target instead of touching a detached video node.
  const deliveryModeRef = useRef<PlaybackDeliveryMode>('idle')
  const startSecRef = useRef<number>(0)
  // Per-play listener cleanup for <video> event handlers registered by ANY
  // delivery path — direct play's error/resume/subtitle listeners AND the
  // native-HLS diagnostics set (renamed from mediaCleanupRef,
  // 2026-07 review: the old Safari-diag name invited scoping it to one
  // branch). Invoked from the play-effect teardown and from the error
  // handlers before closeAndCleanup, so one-shot listeners that never fired
  // can't survive into the NEXT target's playback on the same element and
  // apply the previous title's resume position or subtitle pick. Exactly
  // one delivery path writes it per play; writers must not overwrite a
  // non-null value without invoking it.
  const mediaCleanupRef = useRef<(() => void) | null>(null)
  // Watch-party sync — false while the player is (re)booting a
  // session. Gates host play/pause/seek broadcasts so the transient
  // currentTime=0 / startSec=0 boot window can't propagate abs_ms=0 to the
  // party (which would yank every other participant to the start).
  const playerReadyRef = useRef<boolean>(false)
  // Set immediately before a seek-triggered session replacement when the
  // authoritative state is Paused. The next delivery-path boot consumes it
  // without calling play(), so a synthetic boot event cannot resume a party.
  const pauseAfterSeekRebuildRef = useRef<SeekBootIntent | null>(null)
  // The detached video element reports `paused=true` while a replacement
  // target is still resolving. Retain the intended state separately so a
  // second rapid seek does not mistake teardown for a user pause.
  const inFlightPauseIntentRef = useRef<SeekBootIntent | null>(null)
  const consumedPauseOnBootTokenRef = useRef<number | undefined>(undefined)
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
  // Party sync polls from a stable interval whose dependencies intentionally
  // exclude high-frequency buffer updates. This ref gives an explicit remote
  // seek the current absolute produced edge without tearing down that interval.
  const bufferedSecRef = useRef(0)
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
  // Debounce bookkeeping for persisting the volume pref (see
  // readVolumePref/writeVolumePref above the component).
  const volumeSaveTimerRef = useRef<number | null>(null)
  const pendingVolumeRef = useRef<number | null>(null)
  // #334 — true when we auto-started playback MUTED because the browser
  // blocked a sounded autoplay (party start fires play() outside a user
  // gesture). Drives the "Tap for sound" affordance. Distinct from the
  // user's own mute choice (`muted`); only ever set by attemptPlay's
  // muted fallback, and cleared when the user restores sound or the
  // target changes.
  const [autoStartedMuted, setAutoStartedMuted] = useState(false)
  // Latest party-active flag for async play() sites whose effect closure
  // would otherwise capture a stale `party`. Assigned during render so it
  // always reflects the current prop by the time a deferred boot play
  // resolves. Only the party path opts into attemptPlay's muted fallback.
  const partyActiveRef = useRef(false)
  partyActiveRef.current = Boolean(party)
  const partySyncRef = useRef<PartySync | undefined>(party)
  partySyncRef.current = party
  const completePlaybackBoot = useCallback(async (
    vid: HTMLVideoElement,
    preservePause: boolean,
  ) => {
    if (preservePause) {
      // Keep broadcasts gated while enforcing pause. Most browsers are already
      // paused during boot, but native HLS may have begun autonomously.
      try { if (!vid.paused) vid.pause() } catch { /* defensive */ }
      playerReadyRef.current = true
      return
    }
    playerReadyRef.current = true
    await attemptPlay(vid, partyActiveRef.current, () => setAutoStartedMuted(true))
  }, [])
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
  // 2026-08-09 — the auto-hide timer also reads these (plus the two
  // popovers below) so an OPEN picker can't be faded out mid-read.
  // Until the modality gate went in, menus staying open piggybacked on
  // the stuck-focus bug: clicking the trigger pinned the chrome. With
  // that gone, open popovers need an explicit pin.
  const markersMenuOpenRef = useRef(false)
  const reactionPickerOpenRef = useRef(false)
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
  // Issue #460 — pending re-offer for a party swap that went out but never
  // landed. `changeMedia` only reports that the frame left the socket; the
  // server can still reject it (host succession racing the send, party
  // gone) and its error frame never reaches this card. Since 'spent' is
  // otherwise terminal until the FILE changes, a rejection would strand
  // the host with no button on a room that never moved.
  const swapWatchdogRef = useRef<number | null>(null)
  const clearSwapWatchdog = useCallback(() => {
    if (swapWatchdogRef.current !== null) {
      window.clearTimeout(swapWatchdogRef.current)
      swapWatchdogRef.current = null
    }
  }, [])
  useEffect(() => clearSwapWatchdog, [clearSwapWatchdog])
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
  // Whether the party the user is in actually controls the media THIS
  // player is showing right now — mirrors the same predicate already used
  // for the seek-rebuild guard and the guest-mirror bail-out (H3 audit,
  // ~needsHlsSessionRebuild call sites below). Merely being a member of a
  // party room while watching unrelated solo content is NOT "party controls
  // this media" — casting that content behaves exactly like solo playback.
  // Cast/AirPlay gating keys off THIS, not off raw party membership: the
  // old `!party` gates hid the buttons even for a user who joined a party
  // but pressed Play on something else entirely (issue #461 follow-up).
  const partyControlsMedia = !!party &&
    (party.partyMediaItemId === undefined || party.partyMediaItemId === target?.mediaItemId)
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
  //
  // castTokenExpRef records the minted token's expiry (Unix seconds)
  // so resumeCast can tell when the URL the receiver holds has gone
  // stale during a long pause (see below).
  const castTokenExpRef = useRef(0)
  const castLoadGetter = useCallback(async () => {
    const sid = sessionIdRef.current
    if (!sid || !target) return null
    const resp = await createCastToken(sid)
    castTokenExpRef.current = resp.expires_at
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
  // Stable-identity access to the latest `cast` for the receiver-driven
  // party-sync effect (below the local guest-mirror/host-broadcast effect).
  // useCast's start/stop/playOrPause/seek/loadCurrent are plain closures
  // recreated every render (not useCallback-wrapped) but internally read
  // from refs (remotePlayerRef/remoteControllerRef), so calling a
  // render-old copy through this ref is always equivalent to calling the
  // latest one — the same trick partySyncRef already relies on for `party`.
  // This lets that effect's deps stay coarse (status.connected, not the
  // high-frequency `remote` object) without ever calling a function that
  // captured stale internal state.
  const castRef = useRef(cast)
  castRef.current = cast
  // Cast token renewal on resume (2026-08 review fix). The session-scoped
  // cast token baked into the receiver's playlist URL expires after
  // auth.cast_token_hours (default 4h). A receiver paused LONGER than that
  // 401s on every segment fetch the moment it resumes — and the Default
  // Media Receiver surfaces that as an indefinite buffer, not an error.
  // So: resuming a paused cast whose token has expired re-loads the media
  // with a freshly-minted token instead of issuing a bare play command.
  // The resume position is the RECEIVER's timeline (cast.remote.currentTime)
  // — the local <video> froze when the cast began, so its currentTime would
  // jump the receiver backwards. loadCurrent re-mints via castLoadGetter,
  // which also refreshes castTokenExpRef.
  const isCastTokenExpired = () => {
    const exp = castTokenExpRef.current
    return exp > 0 && Date.now() / 1000 >= exp
  }
  // In-flight guard shared by every automatic (poll-driven) token-renewal
  // reload — resumeCast's manual click doesn't need it (a human can't
  // out-race a network round trip the way a 1s poll loop can), but the
  // receiver-driven party-sync effect's automatic corrections can otherwise
  // fire a SECOND loadCurrent() while the first is still in flight (2026-08
  // review, issue #461 follow-up): castTokenExpRef isn't refreshed until the
  // in-flight call resolves, so a slow network leaves every poll tick in
  // between seeing the same stale "expired" token and racing another
  // session.loadMedia() against the receiver.
  const castReloadInFlightRef = useRef(false)
  // Plain functions, not useCallback: everything they read (castTokenExpRef,
  // castReloadInFlightRef, castRef) is a ref, so a "stale" closure captured
  // by an effect at bind time is exactly as correct as a fresh one — the
  // same equivalence useCast's own start/stop/seek/etc. rely on. No
  // memoization needed, and it sidesteps having to thread these through
  // dependency arrays anywhere they're used.
  const reloadCastWithFreshToken = (targetSec: number) => {
    if (castReloadInFlightRef.current) return // already refreshing — next poll retries if still needed
    castReloadInFlightRef.current = true
    void castRef.current.loadCurrent(targetSec)
      .catch(() => { /* best-effort — next poll retries */ })
      .finally(() => { castReloadInFlightRef.current = false })
  }
  const resumeCast = () => {
    if (cast.remote.isPaused && isCastTokenExpired()) {
      reloadCastWithFreshToken(cast.remote.currentTime)
      return
    }
    cast.playOrPause()
  }
  // Seek the Cast receiver, renewing an expired session-scoped token first
  // if needed (same reasoning as resumeCast — an expired token 401s every
  // subsequent segment fetch, which the receiver surfaces as an indefinite
  // buffer rather than an error). Shared by the receiver-driven party-sync
  // effect's automatic drift correction below.
  const seekCastSafely = (targetSec: number) => {
    if (isCastTokenExpired()) { reloadCastWithFreshToken(targetSec); return }
    castRef.current.seek(targetSec)
  }
  const [airplayActive, setAirplayActive] = useState(false)
  const [airplayAvailable, setAirplayAvailable] = useState(false)
  const [minimized, setMinimized] = useState(false)
  // Playback is on a REMOTE surface — the Chromecast receiver OR an AirPlay
  // target — rather than the local <video>. No longer gated on party
  // membership: during a party this collapses to the widget exactly like
  // solo casting, which is deliberate — the widget already reads/drives
  // cast.remote.* correctly (see widgetPaused/widgetCurSec/widgetDurSec
  // below), so reusing it avoids a second, parallel "party cast" UI that
  // would need its own seek bar wired to the receiver instead of the
  // (paused, frozen) local <video>. The full player stays MOUNTED while
  // minimized (see the effect below), so the receiver-driven party-sync
  // effect and AirPlay's local-<video>-mirroring keep running headless —
  // only the chrome collapses, not the sync. PartyPanel (chat/participants)
  // is rendered by App.tsx outside this component and is unaffected.
  const remoteActive = cast.status.connected || airplayActive
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
      } else if (videoRef.current?.webkitDisplayingFullscreen) {
        // Issue #436 — iPhone's native video fullscreen isn't tracked by
        // document.*fullscreenElement at all; check the <video> directly.
        videoRef.current.webkitExitFullscreen?.()
      }
    }
  }, [remoteActive])

  // Report minimized-widget state up so the parent's global Escape/back
  // handlers don't unmount the player while casting (which would tear down the
  // streaming session feeding the receiver). See App's Escape gate.
  // Focus management for the theater (Aurora Stage Phase 7b).
  //
  // This is not optional politeness — it repairs damage the inert app causes.
  // The moment App marks <main> inert, the HTML focus-fixup rule unfocuses
  // whatever was focused inside it (the card or Play button the user just
  // activated) and document.activeElement becomes <body>. So without this the
  // act of starting playback DESTROYED focus: a keyboard user was left at the
  // top of the document, and a screen-reader user's virtual cursor sat on
  // <body> with no announcement of what had happened.
  //
  // Captures the opener before moving focus and restores it on unmount, so
  // closing after a 45-minute episode returns you to the card you launched
  // from rather than to the top of the page (WCAG 2.4.3, APG Dialog).
  const openerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!target) return
    openerRef.current = document.activeElement as HTMLElement | null
    // rAF, not a bare call: <main> goes inert in the same commit, and focusing
    // before that lands means the fixup rule takes the focus straight back off.
    const raf = requestAnimationFrame(() => overlayRootRef.current?.focus({ preventScroll: true }))
    return () => {
      cancelAnimationFrame(raf)
      const opener = openerRef.current
      openerRef.current = null
      if (opener && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [target])

  // Aurora Stage Phase 7b — report the presented surface so App can dim and
  // inert the tree behind the theater. Derived, not stored: `target` decides
  // whether the player is up at all, and minimized/fullscreen are already
  // state, so a separate mode variable would be a fourth source of truth able
  // to disagree with the other three.
  //
  // useLayoutEffect, not useEffect: this runs BEFORE paint. As a passive effect
  // it always trailed the player's own mount/unmount by one commit, so closing
  // painted one frame of the app at `opacity: .5, saturate(.7)` with no player
  // on screen, and opening painted the mirror image. The precedence itself lives
  // in lib/playerSurface so all eight (target, minimized, fullscreen)
  // combinations can be asserted without a DOM.
  useLayoutEffect(() => {
    onSurfaceChange?.(playerSurface(!!target, minimizedActive, fullscreen))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, minimizedActive, fullscreen])

  // Fullscreen is only ever cleared by the `fullscreenchange` listener, and that
  // listener lives in an effect keyed on [target] — so closing the player while
  // browser-fullscreen races: the UA queues fullscreenchange when the fullscreen
  // element unmounts, but the passive cleanup may have removed the listener
  // first. Lose that race and `fullscreen` stayed true, so the NEXT open
  // rendered fullscreen chrome (auto-hiding bar, no theater box) in a window
  // that isn't fullscreen, with <main> neither dimmed nor inert. Pre-existing,
  // and it fails safe with respect to `inert`, but the visual delta is much
  // larger now that the non-fullscreen surface is a framed box.
  useEffect(() => {
    if (!target) setFullscreen(false)
  }, [target])

  // Tell the parent the player has gone for good on unmount, so a stale
  // 'theater' can't leave <main> dimmed and inert with no player on screen.
  useEffect(() => () => onSurfaceChange?.(null), [onSurfaceChange])

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
    // When the party controls this media, a cast ending is NOT the end of
    // the viewing session — playback falls back to the local, party-synced
    // <video> (the receiver-driven sync effect's cleanup + the local
    // guest-mirror/host-broadcast effect's re-bind handle that automatically).
    // Closing the player would also kick the user out of the party UI.
    if (was && !cast.status.connected && !partyControlsMedia) onClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cast.status.connected, party, partyControlsMedia])

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
      // seeds its ABR at the right tier (review P2). The same estimate is the
      // most accurate throughput figure the QoE row will ever see, so it is
      // handed over here rather than sampled at some arbitrary earlier moment.
      try { saveBandwidthEstimate(hlsRef.current.bandwidthEstimate) } catch { /* defensive */ }
      try { qoeRef.current?.noteThroughput(hlsRef.current.bandwidthEstimate) } catch { /* defensive */ }
      try { hlsRef.current.destroy() } catch { /* defensive */ }
      hlsRef.current = null
    }
    // Close the QoE row. Reaching closeAndCleanup without the <video> having
    // fired 'ended' means the viewer left, which is a distinct outcome from a
    // completed playthrough and worth counting separately.
    try {
      qoeRef.current?.finish('user_exit')
      qoeRef.current = null
    } catch { /* never let telemetry break teardown */ }
    const sid = sessionIdRef.current
    sessionIdRef.current = null
    deliveryModeRef.current = 'idle'
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
      pauseAfterSeekRebuildRef.current = null
      inFlightPauseIntentRef.current = null
      deliveryModeRef.current = 'idle'
      return
    }
    // A seek-rebuild writes this immediately before replacing `target`. Consume
    // it at effect setup so a cancelled callback from the prior target cannot
    // steal the pause intent meant for this new session.
    const preserveTargetPause = shouldPreservePauseForBoot(
      target.pauseOnBootToken,
      consumedPauseOnBootTokenRef.current,
    )
    if (preserveTargetPause) {
      consumedPauseOnBootTokenRef.current = target.pauseOnBootToken
    }
    const seekBootIntent = pauseAfterSeekRebuildRef.current
    const preservePauseAfterBoot = seekBootIntent?.preservePause ?? preserveTargetPause
    pauseAfterSeekRebuildRef.current = null
    inFlightPauseIntentRef.current = {
      preservePause: preservePauseAfterBoot,
      partyRevision: seekBootIntent?.partyRevision ?? partySyncRef.current?.rev ?? null,
    }
    const completeTargetPlaybackBoot = (vid: HTMLVideoElement) => {
      const liveParty = partySyncRef.current
      const partyControlsMedia = Boolean(liveParty) &&
        (liveParty?.partyMediaItemId === undefined || liveParty.partyMediaItemId === target.mediaItemId)
      const resolvedPause = resolvePlaybackBootPause(
        preservePauseAfterBoot,
        seekBootIntent !== null,
        target.partyRecoveryBoot === true,
        partyControlsMedia,
        liveParty?.isPlaying ?? null,
        seekBootIntent?.partyRevision ?? null,
        liveParty?.rev ?? null,
      )
      inFlightPauseIntentRef.current = {
        preservePause: resolvedPause,
        partyRevision: liveParty?.rev ?? seekBootIntent?.partyRevision ?? null,
      }
      return completePlaybackBoot(vid, resolvedPause)
    }
    let cancelled = false
    const ac = new AbortController()

    setStatus('Loading…')
    setErrorMsg(null)
    sessionIdRef.current = null
    deliveryModeRef.current = 'resolving'
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
    bufferedSecRef.current = 0
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
        // A new file IS the party swap landing (or any other re-target),
        // so the pending re-offer is moot.
        clearSwapWatchdog()
      }
    }

    ;(async () => {
      try {
        // Click-to-first-frame starts HERE, before stream-info: the probe,
        // the session create and the encoder warmup are all latency the
        // viewer sits through, and a measurement that started later would
        // flatter exactly the part of the pipeline this is meant to watch.
        playRequestedAtRef.current = performance.now()
        // 1. Stream-info: server decides direct vs HLS.
        const info: StreamInfo = await getStreamInfo(target.fileId, target.fileType, ac.signal)
        if (cancelled) return
        const stream = info.stream

        // Playback QoE (August 2026 review item #1). Attached once the
        // decision is known and before any delivery path is chosen, so both
        // direct play and HLS report through the same collector. Every entry
        // point swallows its own errors — telemetry must never be able to
        // break playback.
        qoeRef.current?.detach()
        qoeRef.current = null
        if (videoRef.current) {
          try {
            qoeRef.current = attachPlaybackQoE(videoRef.current, {
              decision: stream.decision,
              decisionReason: stream.reason_code,
              outputCodec: stream.decision === 'direct_stream' ? 'copy' : (stream.video_codec_out || 'none'),
              segmentFormat: stream.decision === 'direct_play' ? 'none' : 'fmp4',
              hdrConversion: stream.hdr_tonemap ? 'tonemap_cpu' : 'none',
              clickAtMs: playRequestedAtRef.current ?? undefined,
            })
          } catch { /* never let telemetry break playback */ }
        }
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

        // Shared terminal-failure teardown for ALL delivery paths (2026-07
        // review — was previously re-inlined per path). The pairing matters:
        // setErrorMsg without closeAndCleanup once shipped and leaked the
        // server-side FFmpeg session for the life of the tab (Audit HIGH-2).
        const failPlayback = (msg: string) => {
          setErrorMsg(msg)
          closeAndCleanup()
        }
        // Shared one-shot fallback to a full transcode, used by the direct-
        // play error handler and the hls.js MEDIA_ERROR remux fallback.
        // Returns false when the fallback is unavailable or already spent
        // (caller then fails terminally). resumeAtMs carries the current
        // position so a mid-movie fallback resumes where the user was.
        const tryFallbackToTranscode = (statusMsg: string, resumeAtMs?: number): boolean => {
          if (mediaErrorFallbackTriedRef.current || target.forceTranscode || !onFallbackToTranscode) {
            return false
          }
          mediaErrorFallbackTriedRef.current = true
          setStatus(statusMsg)
          closeAndCleanup()
          onFallbackToTranscode(resumeAtMs)
          return true
        }
        // Current absolute playback position in ms (REAL-file timeline —
        // adds back the session's -ss offset), for fallback resume points.
        const currentPositionMs = (vid: HTMLVideoElement): number =>
          Math.max(0, Math.floor((vid.currentTime + (startSecRef.current ?? 0)) * 1000))

        // forceTranscode also bypasses DIRECT PLAY (2026-07 review): the
        // MEDIA_ERROR fallback below re-emits the target with
        // forceTranscode=true, and for a direct-play decision that retry
        // must land on the HLS transcode path — the decision engine's
        // "direct play" was, empirically, wrong for this browser+file.
        if (stream.decision === 'direct_play' && stream.stream_url && !target.forceTranscode) {
          // Direct play: the browser fetches the file URL itself, carrying
          // the httpOnly auth cookie on every same-origin range request.
          setStatus(`Direct Play · ${stream.video_codec ?? ''} / ${stream.audio_codec ?? ''}`)
          const vid = videoRef.current
          if (!vid) return
          // AirPlay auth (#317's direct-play twin, 2026-07 review): the
          // Apple TV can't send our httpOnly cookie, so an AirPlayed
          // direct-play title 401'd on every range request. When the
          // environment exposes AirPlay APIs (all WebKit), mint a
          // FILE-scoped cast token (server binds it to exactly this file)
          // and use the token-bearing /api/stream/direct/{id} URL instead —
          // same pattern the native-HLS branch uses for its session URL.
          // Trade-off (same as #317): the token expires after the cast TTL
          // (default 4h), so a Safari playback paused past that fails its
          // next range request; the error handler below then rebuilds at
          // the current position with a fresh token. On mint failure we
          // keep the cookie URL so local playback never breaks.
          let directSrc = stream.stream_url
          if ('WebKitPlaybackTargetAvailabilityEvent' in window) {
            try {
              const dct = await createDirectCastToken(target.fileId, target.fileType, ac.signal)
              directSrc = absoluteUrl(dct.url)
            } catch { /* cookie URL still plays locally; AirPlay will 401 */ }
            if (cancelled) return
          }
          vid.src = directSrc
          vid.load()
          deliveryModeRef.current = 'direct'
          // Wait for canplay so the resume seek lands inside a buffered
          // range — seeking before the metadata is parsed is a no-op on
          // most browsers. Declared unconditionally so the cleanup below
          // can always removeEventListener (a no-op if never added).
          const onCanPlayResume = () => {
            vid.currentTime = resumeSec
            vid.removeEventListener('canplay', onCanPlayResume)
          }
          if (resumeSec > 0) {
            vid.addEventListener('canplay', onCanPlayResume)
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
          // 2026-07 review — direct play previously had NO error handling:
          // a decode/network failure mid-stream froze the player with the
          // status still reading "Direct Play". Ladder:
          //  1. Mid-stream failure after ≥60s of healthy playback (network
          //     blip, AirPlay cast-token expiry after a long pause): rebuild
          //     DIRECT PLAY once at the current position — fresh stream-info,
          //     fresh token. Loop-safe: a rebuild that fails again fails
          //     within its own first 60s and takes branch 2.
          //  2. Early failure: the decision engine's direct-play call was
          //     wrong for this browser+file (e.g. 10-bit HEVC on a Main-only
          //     decoder) — one-shot fallback to a full transcode at the
          //     current position.
          //  3. Fallback unavailable/spent: terminal error + teardown.
          const playbackBootAt = performance.now()
          const onDirectError = () => {
            if (cancelled) return
            const e = vid.error
            console.warn('[Aurora direct-play] media error code', e?.code, '—', e?.message)
            const positionMs = currentPositionMs(vid)
            // Detach these listeners BEFORE closeAndCleanup(): it calls
            // vid.load() on an empty src, which can re-queue an error
            // event and re-enter this handler (same pattern as the
            // native-HLS onNativeError).
            mediaCleanupRef.current?.()
            mediaCleanupRef.current = null
            const playedHealthyMs = performance.now() - playbackBootAt
            if (playedHealthyMs > 60_000 && positionMs > 0 && onSeekRebuild) {
              setStatus('Recovering direct play…')
              onSeekRebuild(Math.floor(positionMs / 1000))
              return
            }
            if (tryFallbackToTranscode('Direct play failed — retrying with transcode…', positionMs)) {
              return
            }
            failPlayback('Playback failed — this file could not be played in your browser')
          }
          vid.addEventListener('error', onDirectError)
          // Registered under the shared per-play cleanup ref (the
          // play-effect cleanup invokes it): removes the error handler AND
          // the one-shot canplay/loadedmetadata listeners above. Without
          // this, a listener that never fired (quick target switch before
          // canplay) survived into the NEXT target's playback on the same
          // <video> element and applied the PREVIOUS title's resume
          // position / subtitle pick (2026-07 review).
          mediaCleanupRef.current = () => {
            vid.removeEventListener('error', onDirectError)
            vid.removeEventListener('canplay', onCanPlayForSub)
            vid.removeEventListener('loadedmetadata', onLoadedMetadata)
            vid.removeEventListener('canplay', onCanPlayResume)
          }
          // Booted: either preserve a seek-rebuild pause or re-enable host
          // broadcasts immediately before the intended play.
          await completeTargetPlaybackBoot(vid)
          // A direct-play target has no castable HLS session; bump anyway so a
          // pending cast auto-advance resolves (loadCurrent finds no media and
          // stops the cast — direct-play can't be cast to Chromecast).
          setCastReloadEpoch(n => n + 1)
          return
        }

        // 2. HLS path (transcode or direct_stream remux). Create the
        //    session first, then load the master playlist via hls.js.
        // Build the EXACT session request via the shared helper so the
        // details-page pre-warm (lib/prewarm.ts) can produce a byte-identical
        // one — forceTranscode disables remux (Phase 5 MEDIA_ERROR
        // auto-fallback), audioTrackIndex is the in-player override, and the
        // audio_* / hdr / codec fields echo the stream-info decision (the
        // server re-validates via NormalizeSessionAudio, so a stale echo can
        // never cause a manifest/segment codec mismatch).
        const sessionReq = buildSessionRequest(stream, {
          fileId: target.fileId,
          fileType: target.fileType,
          startSec: resumeSec,
          audioTrackIndex: target.audioTrackIndex,
          forceTranscode: target.forceTranscode,
        })
        // Pre-warm fast path: if the details page already created a session
        // for this EXACT request, adopt it and skip CreateSession's ffprobe +
        // ladder-build latency. takeWarmedSession matches on the request key
        // only and consumes the entry (we now own its teardown); any mismatch
        // returns null and we create a fresh session exactly as before.
        let session: SessionResponse
        const warmed = prewarmEnabled() ? takeWarmedSession(sessionReq) : null
        if (warmed) {
          session = {
            session_id: warmed.sessionId,
            master_playlist: warmed.masterPlaylist,
            start_sec: warmed.startSec,
          }
        } else {
          session = await createSession(sessionReq, ac.signal)
        }
        if (cancelled) {
          // Race: cancelled between info and session — clean up the
          // just-created (or adopted) session before unwinding.
          void deleteSession(session.session_id)
          return
        }
        sessionIdRef.current = session.session_id
        deliveryModeRef.current = 'hls'
        startSecRef.current = session.start_sec ?? 0
        // Issue #141 — record the EFFECTIVE remux state (sessionReq.remux
        // already folds in forceTranscode). The subtitle endpoint uses
        // this to pick the cue-shift offset: keyframe for remux, raw
        // startSec for transcode. (remux is optional on the request type;
        // buildSessionRequest always sets a concrete boolean.)
        sessionRemuxRef.current = !!sessionReq.remux
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
        // Chrome on macOS returns non-empty for canPlayType('application/vnd.apple.mpegurl')
        // (macOS advertises HLS at the system level) but Chrome's native media pipeline
        // cannot demux fMP4/CMAF HLS segments — it fails immediately with
        // DEMUXER_ERROR_COULD_NOT_PARSE (MediaError code 4). Restrict the native-HLS
        // branch to browsers where hls.js is unavailable (true iOS WebKit) or to Safari
        // specifically, where a real m3u8 URL on vid.src is required for AirPlay (#314/#317).
        const isSafari = !('chrome' in window) && /\bsafari\b/i.test(navigator.userAgent)
        const usesNativeHls =
          !Hls.isSupported() || (isSafari && vid.canPlayType('application/vnd.apple.mpegurl') !== '')
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
          // the MANIFEST_PARSED fallback in the hls.js path. Declared
          // unconditionally so cleanup can always removeEventListener.
          const onCanPlaySeekNative = () => {
            vid.currentTime = resumeSec
            vid.removeEventListener('canplay', onCanPlaySeekNative)
          }
          if (resumeSec > 0 && (session.start_sec ?? 0) === 0) {
            vid.addEventListener('canplay', onCanPlaySeekNative)
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

          // Diagnostic listeners + stall recovery for the native-HLS path.
          // The hls.js path has MEDIA_ERROR recovery; native HLS had none (#340).
          const NATIVE_RECOVERY_DELAY_MS = 3000
          const MAX_NATIVE_RECOVERY = 5
          let nativeRecoveryTimer: ReturnType<typeof setTimeout> | null = null
          let nativeRecoveryAttempts = 0

          const cancelNativeRecovery = () => {
            if (nativeRecoveryTimer !== null) {
              clearTimeout(nativeRecoveryTimer)
              nativeRecoveryTimer = null
            }
          }

          const scheduleNativeRecovery = () => {
            if (nativeRecoveryTimer !== null || nativeRecoveryAttempts >= MAX_NATIVE_RECOVERY) return
            nativeRecoveryTimer = setTimeout(() => {
              nativeRecoveryTimer = null
              if (cancelled || vid.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return
              // Find the furthest buffered position ahead of currentTime.
              const buf = vid.buffered
              let nudgeTo: number | null = null
              for (let i = 0; i < buf.length; i++) {
                if (buf.end(i) > vid.currentTime + 0.05) {
                  nudgeTo = Math.max(vid.currentTime, buf.end(i) - 0.1)
                  break
                }
              }
              nativeRecoveryAttempts++
              if (nudgeTo !== null && nudgeTo > vid.currentTime) {
                console.debug(
                  '[Aurora native-HLS] nudge', vid.currentTime.toFixed(3),
                  '→', nudgeTo.toFixed(3), 's (attempt', nativeRecoveryAttempts, ')'
                )
                vid.currentTime = nudgeTo
              } else {
                // No buffered data ahead yet — transcoder still catching up.
                console.debug(
                  '[Aurora native-HLS] no buffered range ahead at',
                  vid.currentTime.toFixed(3), 's — re-arming (attempt', nativeRecoveryAttempts, ')'
                )
                scheduleNativeRecovery()
              }
            }, NATIVE_RECOVERY_DELAY_MS)
          }

          const onNativeSeeking = () => {
            if (cancelled) return
            console.debug('[Aurora native-HLS] seeking → target', vid.currentTime.toFixed(3), 's')
          }
          const onNativeSeeked = () => {
            if (cancelled) return
            console.debug('[Aurora native-HLS] seeked  → landed', vid.currentTime.toFixed(3), 's')
          }
          const onNativePlaying = () => {
            if (cancelled) return
            cancelNativeRecovery()
            nativeRecoveryAttempts = 0
          }
          const onNativeWaiting = () => {
            if (cancelled) return
            console.debug('[Aurora native-HLS] waiting at', vid.currentTime.toFixed(3), 's')
            scheduleNativeRecovery()
          }
          const onNativeStalled = () => {
            if (cancelled) return
            console.debug('[Aurora native-HLS] stalled at', vid.currentTime.toFixed(3), 's')
            scheduleNativeRecovery()
          }
          const onNativeError = () => {
            if (cancelled) return
            const e = vid.error
            console.warn('[Aurora native-HLS] error code', e?.code, '—', e?.message, 'at', vid.currentTime.toFixed(3), 's')
            // MEDIA_ERR_SRC_NOT_SUPPORTED (code 4): the browser cannot demux this
            // stream at all — retrying in-place won't help. Surface the error and
            // release the server session so FFmpeg doesn't idle until tab close.
            // Detach diag listeners before closeAndCleanup(): that function calls
            // vid.load() which can re-queue an error event on an empty src,
            // re-entering onNativeError while it's still attached.
            if (e?.code === 4) {
              mediaCleanupRef.current?.()
              mediaCleanupRef.current = null
              setErrorMsg('Playback failed — this stream format is not supported by your browser')
              closeAndCleanup()
            }
          }
          vid.addEventListener('seeking', onNativeSeeking)
          vid.addEventListener('seeked', onNativeSeeked)
          vid.addEventListener('playing', onNativePlaying)
          vid.addEventListener('waiting', onNativeWaiting)
          vid.addEventListener('stalled', onNativeStalled)
          vid.addEventListener('error', onNativeError)
          mediaCleanupRef.current = () => {
            cancelNativeRecovery()
            vid.removeEventListener('seeking', onNativeSeeking)
            vid.removeEventListener('seeked', onNativeSeeked)
            vid.removeEventListener('playing', onNativePlaying)
            vid.removeEventListener('waiting', onNativeWaiting)
            vid.removeEventListener('stalled', onNativeStalled)
            vid.removeEventListener('error', onNativeError)
            // 2026-07 review — also remove the one-shot canplay/
            // loadedmetadata listeners: if they never fired (quick target
            // switch before canplay), they'd survive into the NEXT
            // target's playback on the same <video> element and apply the
            // PREVIOUS title's resume position / subtitle pick.
            vid.removeEventListener('canplay', onNativeCanPlay)
            vid.removeEventListener('loadedmetadata', onNativeLoadedMetadata)
            vid.removeEventListener('canplay', onCanPlaySeekNative)
          }

          await completeTargetPlaybackBoot(vid)
          return
        }

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          // Issue #433 — every seek past the buffer rebuilds the session
          // (VideoPlayer.seekToRealSec -> onSeekRebuild), and the new
          // session's playlist is served while FFmpeg is still writing it,
          // so it has no #EXT-X-ENDLIST yet. hls.js flags any playlist
          // without ENDLIST as `live` (EXT-X-PLAYLIST-TYPE:EVENT does NOT
          // clear that) and defaults startPosition to the live edge —
          // roughly (bufferedSoFar - 3 segments) into the NEW session,
          // which is already anchored at the clicked time. On a fast
          // remux (unpaced, can be tens of seconds ahead by the time the
          // playlist is parsed) that put playback well past where the
          // user clicked; a second click "corrected" it because the
          // repeat seek stayed inside the already-buffered range and hit
          // the plain vid.currentTime path instead of a rebuild. HLS time
          // 0 IS the requested position (server -ss'd), so force hls.js
          // to start there instead of guessing a live edge.
          //
          // Scope: this only covers the hls.js path. Native HLS (Safari /
          // iOS / AirPlay, `usesNativeHls` above) hits the same
          // no-ENDLIST-yet playlist through the browser's own HLS
          // implementation, which has no equivalent client-side knob —
          // still tracked separately, not fixed here.
          startPosition: 0,
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
        // Rendition churn is one of the review's requested QoE dimensions:
        // frequent switching on a healthy connection points at a ladder whose
        // declared bandwidth disagrees with what the segments actually cost.
        hls.on(Hls.Events.LEVEL_SWITCHED, () => {
          qoeRef.current?.noteRenditionSwitch()
        })
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          qoeRef.current?.noteManifestParsed()
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
          // Booted: manifest parsed + start_sec applied. completePlaybackBoot
          // either preserves a seek-rebuild pause or re-enables broadcasts for
          // the intended play; transient boot seeks stayed suppressed. Guard
          // against a superseded target (hls.destroy() also detaches this).
          if (cancelled) return
          void completeTargetPlaybackBoot(vid)
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

        // Error handling — the standard hls.js recovery ladder, BOUNDED
        // (2026-07 review; previously every branch retried without a
        // budget, so a chronically-failing stream looped recover→error→
        // recover for the life of the tab — endless stutter, never an
        // error screen, ffmpeg kept alive by the keepalive ticker).
        //
        //  * MEDIA_ERROR: remux→transcode fallback first (one-shot);
        //    then hls.js's documented pattern — recoverMediaError(); if
        //    another fatal media error lands within 3s, swapAudioCodec()
        //    before the next recover; hard cap on total attempts.
        //  * NETWORK_ERROR: 401 → token refresh (bounded); anything else
        //    → startLoad() with a small retry budget, reset by any
        //    successfully loaded fragment so a long movie can survive
        //    many isolated blips but a dead session can't retry forever.
        //
        // Audit H2 (2026-05-16) — 401 detection. Aurora access tokens
        // expire after 15 minutes; movies are 90-120+. If the token
        // expires and no other API call has triggered a background
        // refresh, segment XHRs start 401-ing; hls.js packages that as a
        // NETWORK_ERROR and startLoad alone would re-fire the same
        // expired token. Detect the 401 specifically, refresh, resume.
        const MEDIA_RECOVER_MAX = 4
        const MEDIA_SWAP_WINDOW_MS = 3000
        const NETWORK_RETRY_MAX = 3
        const AUTH_REFRESH_MAX = 2
        let mediaRecoverAttempts = 0
        let lastMediaRecoverAt = 0
        let audioCodecSwapped = false
        let networkRetryAttempts = 0
        let authRefreshAttempts = 0
        let lastFatalMediaAt = -1 // vid.currentTime at the last fatal media error
        hls.on(Hls.Events.FRAG_LOADED, () => {
          // Forward progress: transient-blip budgets refill so bounded
          // retries never accumulate across a 2-hour movie's lifetime.
          networkRetryAttempts = 0
          authRefreshAttempts = 0
        })
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          // Media-recovery budget refills only on APPEND success (this
          // event fires after SourceBuffer append, unlike FRAG_LOADED)
          // AND with playback progressed past the last failure point.
          // The progress gate matters: hls.js can emit one trailing
          // FRAG_BUFFERED for a fragment whose appends errored (the
          // operation queue advances past failed ops), so an event-count
          // refill would re-arm an append-failure loop forever — while a
          // 3-hour movie with sparse recovered decode hiccups must not
          // accumulate toward the cap and die on the 5th (2026-07 review).
          if (mediaRecoverAttempts > 0 && vid.currentTime > lastFatalMediaAt + 0.5) {
            mediaRecoverAttempts = 0
          }
        })
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
            if (authRefreshAttempts >= AUTH_REFRESH_MAX) {
              // Refresh "succeeded" but streams still 401 (revoked token
              // version, clock skew, proxy stripping cookies) — retrying
              // forever would hammer the auth endpoint for the tab's life.
              failPlayback('Session expired. Please sign in again.')
              return
            }
            authRefreshAttempts++
            void (async () => {
              const refreshed = await forceTokenRefresh()
              if (cancelled) return
              if (refreshed) {
                // startLoad() with no argument is startLoad(-1), which
                // re-arms hls.js's own live-edge start-position guess
                // (see the startPosition:0 comment above) if this fires
                // before the first fragment was ever requested. Passing
                // the element's current time keeps the restart anchored
                // where playback actually is.
                try { hls.startLoad(vid.currentTime) } catch { failPlayback('Playback failed — token refresh') }
              } else {
                failPlayback('Session expired. Please sign in again.')
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
            lastFatalMediaAt = vid.currentTime
            if (
              stream.decision === 'direct_stream' &&
              tryFallbackToTranscode('Remux failed — retrying with transcode…', currentPositionMs(vid))
            ) {
              // One-shot guard + teardown live in tryFallbackToTranscode.
              return
            }
            // hls.js's documented recovery ladder, bounded. A second fatal
            // media error inside the swap window means plain recovery
            // didn't take — swapAudioCodec() re-creates the audio
            // SourceBuffer with the alternate codec mapping before the
            // next recover (the hls.js-recommended second step). The
            // total cap catches slow loops the window can't (a decode
            // that fails every ~5s "recovers" forever otherwise).
            if (mediaRecoverAttempts >= MEDIA_RECOVER_MAX) {
              failPlayback('Playback failed — media error')
              return
            }
            mediaRecoverAttempts++
            const now = Date.now()
            const withinSwapWindow = now - lastMediaRecoverAt < MEDIA_SWAP_WINDOW_MS
            lastMediaRecoverAt = now
            try {
              if (withinSwapWindow && !audioCodecSwapped) {
                audioCodecSwapped = true
                hls.swapAudioCodec()
              }
              hls.recoverMediaError()
            } catch {
              failPlayback('Playback failed — media error')
            }
          } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            // Fatal network error = hls.js's own per-request retries are
            // already exhausted. A bounded startLoad budget covers
            // transient connectivity loss (wifi handoff, server restart);
            // a GC'd session whose segments 404/410 forever hits the cap
            // and surfaces instead of silently retrying for hours.
            if (networkRetryAttempts >= NETWORK_RETRY_MAX) {
              failPlayback('Playback failed — network error')
              return
            }
            networkRetryAttempts++
            // See the token-refresh recovery above: pass currentTime so a
            // retry can't re-trigger the live-edge start-position guess.
            try { hls.startLoad(vid.currentTime) } catch {
              failPlayback('Playback failed — network error')
            }
          } else {
            failPlayback('Playback failed — ' + (data.details ?? 'unknown'))
          }
        })
      } catch (err) {
        if (cancelled) return
        if (err && (err as Error).name === 'AbortError') return
        deliveryModeRef.current = 'idle'
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
      mediaCleanupRef.current?.()
      mediaCleanupRef.current = null
      closeAndCleanup()
    }
    // currentSubIndex is read once to restore subtitles across target changes;
    // adding it as a dependency would restart playback when the user toggles subs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, closeAndCleanup, completePlaybackBoot])

  // Keepalive ticker — runs while a session is active. V1 uses 10s.
  // setInterval re-creates per session because sessionIdRef is a ref
  // (no re-render when it changes); the effect re-runs only on
  // target change, which is the right granularity.
  //
  // A 404 means the session is gone server-side — almost always because a
  // deploy restarted the service (StopAllSessions) while this player sat
  // paused. Before 2026-08 the ping result was discarded, so the client kept
  // pinging a corpse forever (370 pings / 62 minutes in one production case)
  // and the user saw a frozen frame with no error and no way back except a
  // reload that lost their position. Now: stop the ticker and rebuild the
  // session at the current position, reusing the same machinery the
  // forward-seek path uses.
  //
  // The recovery inputs (party, onSeekRebuild) are read through a ref rather
  // than listed as dependencies. `party` is rebuilt as a FRESH OBJECT LITERAL
  // on every App render (see where VideoPlayer is mounted in App.tsx), so
  // depending on it would clear and re-arm this interval on every render —
  // and during party sync App re-renders faster than 10s, which would mean
  // the ping never fires at all and the server GCs the session. That is the
  // exact failure this effect exists to prevent.
  const keepaliveRecoveryRef = useRef({ party, onSeekRebuild })
  // Updated in an effect rather than during render — a render-phase ref
  // mutation is a side effect, and StrictMode's double render would run it
  // twice. No dependency array: refresh after every commit, which is exactly
  // the "always the latest props" semantics the ticker needs.
  useEffect(() => {
    keepaliveRecoveryRef.current = { party, onSeekRebuild }
  })

  useEffect(() => {
    if (!target) return
    let stopped = false
    let recovering = false

    const ping = () => {
      const sid = sessionIdRef.current
      if (!sid || stopped) return
      void keepalive(sid).then((result) => {
        if (result !== 'gone' || stopped) return
        // Latch immediately: the visibilitychange handler can fire a second
        // ping while this promise is settling, and two concurrent rebuilds
        // would race the play effect's teardown.
        if (recovering) return
        recovering = true
        stopped = true
        window.clearInterval(id)

        const vid = videoRef.current
        // Absolute media position — currentTime is relative to the session's
        // start_sec anchor, and the rebuild wants absolute seconds (same
        // convention as onSeek / the forward-seek rebuild above).
        const absSec = vid
          ? Math.max(0, vid.currentTime + (startSecRef.current ?? 0))
          : Math.max(0, startSecRef.current ?? 0)

        // The session is already dead, so nothing here can make playback
        // worse — but a host rebuilding mid-party would drift the guests
        // (same reasoning as the seek-rebuild party gate). Guests and hosts
        // watching the party's media get a message instead of a silent
        // freeze; the non-party case self-heals.
        const { party: livePartyState, onSeekRebuild: rebuild } = keepaliveRecoveryRef.current
        const isPartySyncingThisMedia = !!livePartyState
          && livePartyState.partyMediaItemId !== undefined
          && target?.mediaItemId === livePartyState.partyMediaItemId

        if (rebuild && !isPartySyncingThisMedia) {
          setStatus('Reconnecting…')
          rebuild(absSec)
        } else {
          // No rebuild available: surface it rather than leaving a dead
          // player on screen. This is the branch that used to be silent.
          setStatus('Playback session ended — reload to resume')
        }
      })
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
      stopped = true
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // Deps stay at [target] deliberately — see the ref note above. Adding
    // `party` or `onSeekRebuild` here re-arms the interval on every render.
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
  // A host seek is broadcast from the UI intent before the browser can emit
  // `seeked` (which may be delayed by a session rebuild). Ignore that later
  // DOM echo so it cannot reset the running party clock to the same, now-stale
  // absolute second after guests have already started from the new anchor.
  const locallyBroadcastSeekUntilRef = useRef<number>(0)
  // An explicit server seek remains in useParty.seekRef until the next seek.
  // Remember the client-local sequence so a guest applies/rebases it once,
  // including across the target change caused by a session rebuild.
  const lastAppliedPartySeekSequenceRef = useRef(0)
  // 2026-05-25 deep-debug (High #3) — gate PR #81's race-recovery
  // requestPlay() so it fires at most once per player-bind. Reset
  // below in a target-identity useEffect when fileId/mediaItemId
  // changes. See the recovery block in the play/pause/seek useEffect
  // for the full rationale.
  const hostBroadcastRecoveryFiredRef = useRef<boolean>(false)
  useEffect(() => {
    hostBroadcastRecoveryFiredRef.current = false
    // New media: clear any stale "auto-muted" affordance from the prior
    // title. If this one also gets a blocked autoplay, attemptPlay re-sets it.
    setAutoStartedMuted(false)
  }, [target?.fileId, target?.mediaItemId])
  useEffect(() => {
    if (!target || !party) return
    // While a Chromecast receiver is the active surface for THIS party's
    // media, the sibling receiver-driven sync effect below owns play/pause/
    // seek mirroring and host broadcast — the local <video> is paused for
    // the whole cast session (pausedByCastRef effect above) and would only
    // fight that effect (attemptPlay() on every tick, a repaint's worth of
    // spurious 'play' events immediately re-paused by the cast-connected
    // effect). Bailing here is what lets that sibling effect exist without
    // the two racing. The moment cast.status.connected goes false — user
    // stops casting, session drops — this effect re-runs (it's in the dep
    // array) and local-video sync resumes exactly where it left off.
    // AirPlay is NOT part of this gate: the local <video> IS the AirPlay-
    // mirrored source, so this effect keeps driving it during AirPlay too.
    if (partyControlsMedia && cast.status.connected) return
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
    // 2026-06-15 — opt-in sync telemetry. `dbg` is a single boolean read
    // (window.__auroraSyncDebug); when off, every recordSyncSample call
    // below is skipped and the drift loop is byte-for-byte the old hot
    // path. bufferedAheadSec is the smoking-gun signal: near-zero buffer
    // right before a hard-seek ⇒ the guest's HLS pipeline can't keep up
    // (network/transcode); healthy buffer + hard-seek ⇒ a target/clock
    // miscalc. See lib/syncDebug.ts.
    const bufferedAheadOf = (v: HTMLVideoElement): number => {
      try {
        const b = v.buffered
        const cur = v.currentTime
        for (let i = 0; i < b.length; i++) {
          if (cur >= b.start(i) - 0.25 && cur <= b.end(i) + 0.25) return Math.max(0, b.end(i) - cur)
        }
      } catch { /* TimeRanges can throw if the element is torn down */ }
      return 0
    }
    const id = window.setInterval(() => {
      const dbg = isSyncDebugEnabled()
      const explicitSeek = party.seekRef.current
      if (explicitSeek && !shouldApplyExplicitPartySeek(explicitSeek.by, party.currentUserId)) {
        // The sync socket echoes a host's own request. Consume it even after a
        // role hand-off so the former host cannot replay that stale frame as a
        // newly-demoted guest.
        lastAppliedPartySeekSequenceRef.current = Math.max(
          lastAppliedPartySeekSequenceRef.current,
          explicitSeek.sequence,
        )
      }
      // Host doesn't pull from server tick (it IS the source of truth). Consume
      // any persisted hello/rebase sequence before returning so a later role
      // hand-off cannot replay that old position after this user is demoted.
      if (party.isHost) {
        if (explicitSeek) {
          lastAppliedPartySeekSequenceRef.current = Math.max(
            lastAppliedPartySeekSequenceRef.current,
            explicitSeek.sequence,
          )
        }
        return
      }
      // Audit H3 — bail out if the local player isn't showing the
      // party's media. Avoids cross-content seeks.
      if (party.partyMediaItemId !== undefined && party.partyMediaItemId !== target.mediaItemId) return

      // An explicit host scrub is qualitatively different from ordinary
      // clock drift. Sequential HLS cannot jump outside this participant's
      // independently produced window, so every guest whose session cannot
      // serve the new absolute position rebuilds at that anchor. The server
      // seek frame supplies a client-local sequence, making this exactly-once
      // even though the ref persists through the target change/reboot.
      if (explicitSeek &&
          explicitSeek.sequence !== lastAppliedPartySeekSequenceRef.current) {
        const targetAbsSec = Math.max(0, explicitSeek.abs_ms / 1000)
        const rebuild = keepaliveRecoveryRef.current.onSeekRebuild
        if (shouldReplaceUnreadyTargetForExplicitSeek(
          playerReadyRef.current,
          Boolean(rebuild),
        ) && rebuild) {
          // Seek B supersedes a still-booting seek A. Replacing the target now
          // avoids waiting for A to finish (or fail) before moving to B.
          lastAppliedPartySeekSequenceRef.current = explicitSeek.sequence
          const preservePause = shouldPreservePauseOnSeekRebuild(
            explicitSeek.running ?? party.isPlaying,
            vid.paused,
          )
          const bootIntent = {
            preservePause,
            partyRevision: explicitSeek.rev ?? party.rev,
          }
          pauseAfterSeekRebuildRef.current = bootIntent
          inFlightPauseIntentRef.current = bootIntent
          extendSuppression(500)
          setStatus('Syncing to latest party position…')
          rebuild(targetAbsSec)
          return
        }
        // Direct/in-window application needs a live media element. Leave the
        // sequence pending until the current delivery path finishes booting.
        if (!playerReadyRef.current) return

        lastAppliedPartySeekSequenceRef.current = explicitSeek.sequence
        if (sessionIdRef.current !== null && rebuild && needsHlsSessionRebuild(
          targetAbsSec,
          startSecRef.current ?? 0,
          bufferedSecRef.current,
        )) {
          const preservePause = shouldPreservePauseOnSeekRebuild(
            explicitSeek.running ?? party.isPlaying,
            vid.paused,
          )
          const bootIntent = {
            preservePause,
            partyRevision: explicitSeek.rev ?? party.rev,
          }
          pauseAfterSeekRebuildRef.current = bootIntent
          inFlightPauseIntentRef.current = bootIntent
          extendSuppression(500)
          setStatus('Syncing to party…')
          rebuild(targetAbsSec)
          return
        }

        // Direct play, or a target already inside this HLS session's window.
        // Apply it locally; the normal play/pause mirror below preserves the
        // server's running state on the same interval turn.
        extendSuppression(300)
        try { vid.currentTime = absMsToHlsSec(explicitSeek.abs_ms) } catch { /* defensive */ }
      }
      const t = party.tickRef.current
      if (!t) {
        if (dbg) recordSyncSample({ ms: Date.now(), decision: 'no-tick', readyState: vid.readyState, bufferedAheadSec: bufferedAheadOf(vid) })
        return
      }
      // Build a telemetry sample from the tick + local element state.
      // Only invoked under `if (dbg)`, so it costs nothing in production.
      const mkSample = (decision: SyncDecision, extra?: Partial<SyncSample>): SyncSample => ({
        ms: Date.now(),
        decision,
        readyState: vid.readyState,
        playbackRate: vid.playbackRate,
        bufferedAheadSec: bufferedAheadOf(vid),
        clockOffsetMs: party.clockOffsetRef?.current,
        rttMs: party.rttRef?.current,
        absMs: t.abs_ms,
        rev: t.rev,
        ...extra,
      })
      // Play/pause mirror — use the server's isPlaying as authority.
      // Do this BEFORE drift checking so we don't try to seek a
      // paused player.
      if (party.isPlaying && vid.paused) {
        extendSuppression(150)
        // #334 — muted fallback so a guest whose browser blocks sounded
        // autoplay still joins the timeline (muted) instead of sitting
        // paused and drifting; the "Tap for sound" pill restores audio.
        void attemptPlay(vid, true, () => setAutoStartedMuted(true))
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
      if (vid.paused) {
        if (dbg) recordSyncSample(mkSample('buffering'))
        return
      }

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
        if (dbg) recordSyncSample(mkSample('stale', { tickAgeMs }))
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

      const sampleExtra: Partial<SyncSample> = { driftMs, localSec, targetSec, projectedAbsMs, tickAgeMs }

      if (absDrift < DRIFT_IGNORE_MS) {
        if (vid.playbackRate !== 1.0) vid.playbackRate = 1.0
        if (dbg) recordSyncSample(mkSample('ignore', sampleExtra))
        return
      }
      if (absDrift >= DRIFT_HARD_MS) {
        // Hard-snap. Suppress the resulting seeked echo (the local
        // listener would re-broadcast as request-seek otherwise —
        // ping-pong). Reset rate to 1.0 since we just teleported.
        extendSuppression(300)
        try { vid.currentTime = targetSec } catch { /* defensive */ }
        vid.playbackRate = 1.0
        if (dbg) recordSyncSample(mkSample('hard-seek', sampleExtra))
        return
      }
      // Small drift: rate-adjust. Behind → speed up; ahead → slow down.
      vid.playbackRate = driftMs < 0 ? RATE_UP : RATE_DN
      if (dbg) recordSyncSample(mkSample(driftMs < 0 ? 'rate-up' : 'rate-down', sampleExtra))
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
      if (Date.now() < locallyBroadcastSeekUntilRef.current) return
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
  // working across renders without a rebind. cast.status.connected is added
  // so the local↔receiver handoff above (bail while cast owns sync) rebinds
  // this effect at exactly the moment a cast session starts or ends —
  // otherwise the bail check would only be re-evaluated on the next
  // unrelated re-bind, briefly running both sync effects at once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, Boolean(party), party?.isHost, party?.isPlaying, party?.partyMediaItemId, cast.status.connected])

  // M10 Phase 4 (receiver extension, issue #461 follow-up) — party sync
  // while a Chromecast receiver is the active playback surface. Mutually
  // exclusive with the local-video sync effect above: that effect bails
  // out under the identical `partyControlsMedia && cast.status.connected`
  // condition, so exactly one of the two is ever bound.
  //
  // AirPlay needs none of this — the local <video> IS the AirPlay-mirrored
  // source, so it stays covered by the (unmodified) local-video effect
  // above the whole time AirPlay is active.
  //
  //   - Guest: every second, compares the party's projected tick position
  //     against cast.remote.currentTime and corrects via cast.seek(). No
  //     rate-adjust catch-up (unlike the local loop's playbackRate
  //     nudging) — the Default Media Receiver's remote-control surface
  //     doesn't expose a usable playback-rate knob, and round-trip latency
  //     to a TV makes fine-grained chasing impractical anyway. Tolerance is
  //     therefore coarser (2s) than the local loop's (150ms soft / 1.8s
  //     hard) — appropriate for a TV that was never going to be
  //     frame-synced with phones/laptops. Deliberately does NOT special-
  //     case party.seekRef's explicit-seek frame the way the local loop
  //     does: any seek shows up as ordinary drift on the very next poll,
  //     which keeps this branch simple at the cost of up to ~1s of extra
  //     latency after a host seek. Also deliberately does NOT attempt a
  //     session rebuild for a seek past the current session's produced
  //     edge — bufferedSecRef tracks the LOCAL <video>'s buffered ranges,
  //     which stop advancing once local playback is paused for casting, so
  //     it can't reliably describe what the receiver's independent fetch
  //     has actually reached. A far-forward host seek during a cast
  //     session is a known limitation (the receiver's own buffering is the
  //     visible symptom) rather than something this effect silently
  //     mishandles by guessing at a signal it doesn't have.
  //   - Host: derives party broadcasts from OBSERVED cast.remote state
  //     (polling, not an event subscription — the CAF RemotePlayerController
  //     is private to cast.ts's closure) instead of local <video> events,
  //     since the local element is paused for the whole cast session and
  //     never fires them. Poll-based also means it doesn't matter whether
  //     the state change came from our own widget, the physical TV remote,
  //     or another Cast-aware app — the party sees it either way.
  //   - Cast-token renewal reuses the same expiry check as resumeCast: a
  //     correction after a long pause re-mints via loadCurrent instead of
  //     issuing a seek the receiver's already-expired URL can't serve.
  useEffect(() => {
    if (!target || !party || !partyControlsMedia || !cast.status.connected) return

    const GUEST_POLL_MS = 1000
    const HOST_POLL_MS = 1000
    const GUEST_DRIFT_RESYNC_SEC = 2
    const HOST_SEEK_JUMP_TOLERANCE_SEC = 3
    // Any position change while the receiver is paused can only be a scrub —
    // nothing advances a paused receiver on its own — so this just needs to
    // be bigger than CAF's currentTime reporting jitter, not a real
    // progression tolerance like HOST_SEEK_JUMP_TOLERANCE_SEC.
    const HOST_PAUSED_SCRUB_TOLERANCE_SEC = 1

    const absMsToCastSec = (absMs: number) => Math.max(0, (absMs / 1000) - (startSecRef.current ?? 0))
    const castSecToAbsMs = (sec: number) => Math.round((sec + (startSecRef.current ?? 0)) * 1000)

    if (party.isHost) {
      let lastSnapshot: { paused: boolean; sec: number; atMs: number } | null = null
      const id = window.setInterval(() => {
        const c = castRef.current
        if (!c.status.connected || !c.remote.isMediaLoaded) return
        const nowPaused = c.remote.isPaused
        const nowSec = c.remote.currentTime
        const prev = lastSnapshot
        lastSnapshot = { paused: nowPaused, sec: nowSec, atMs: Date.now() }
        // First sample after (re)connect — nothing to compare against yet.
        // Avoids broadcasting a spurious event off the transient state
        // between loadMedia() resolving and the receiver reaching the
        // requested startTime.
        if (!prev) return

        if (nowPaused !== prev.paused) {
          if (nowPaused) {
            party.requestPause(castSecToAbsMs(nowSec))
          } else {
            // 2026-08 review fix — the receiver may have been scrubbed WHILE
            // paused (TV remote, another Cast app): correct the server's
            // position before resuming, or the party resumes from the old
            // pre-scrub spot instead of where the host's TV actually is.
            if (Math.abs(nowSec - prev.sec) > HOST_PAUSED_SCRUB_TOLERANCE_SEC) {
              party.requestSeek(castSecToAbsMs(nowSec))
            }
            party.requestPlay()
          }
          return
        }
        if (nowPaused) {
          // Still paused. A position change here is, again, only possible via
          // a direct scrub — re-broadcast the pause with the corrected
          // position so a later resume starts from the right spot even if
          // the user never presses play again before checking back in.
          if (Math.abs(nowSec - prev.sec) > HOST_PAUSED_SCRUB_TOLERANCE_SEC) {
            party.requestPause(castSecToAbsMs(nowSec))
          }
          return
        }
        // A jump bigger than natural playback progression over this poll
        // window means the user (via our widget) or the TV remote scrubbed
        // the receiver directly.
        const elapsedSec = (Date.now() - prev.atMs) / 1000
        if (isCastHostSeekJump(nowSec, prev.sec, elapsedSec, HOST_SEEK_JUMP_TOLERANCE_SEC)) {
          party.requestSeek(castSecToAbsMs(nowSec))
        }
      }, HOST_POLL_MS)
      return () => window.clearInterval(id)
    }

    // Guest branch.
    const id = window.setInterval(() => {
      const c = castRef.current
      if (!c.status.connected || !c.remote.isMediaLoaded) return
      // H3-equivalent guard: only mirror when this player is showing the
      // same content the party is. Belt-and-suspenders — the whole effect
      // is already gated on partyControlsMedia, which is reactive to the
      // same fields via the dependency array below.
      if (party.partyMediaItemId !== undefined && party.partyMediaItemId !== target.mediaItemId) return

      const t = party.tickRef.current
      if (!t) return

      // Play/pause mirror first, same ordering as the local loop — no point
      // drift-checking a receiver that isn't even running yet.
      const nowPaused = c.remote.isPaused
      if (castPlayPauseMismatch(party.isPlaying, nowPaused)) {
        if (nowPaused) {
          // About to resume — reuse the same token-expiry-safe path as the
          // widget's own resume button (2026-08 review fix): a bare
          // playOrPause() against an already-expired cast token just 401s on
          // every segment fetch, which the receiver reports as an
          // indefinite buffer rather than an error.
          if (isCastTokenExpired()) {
            reloadCastWithFreshToken(c.remote.currentTime)
          } else {
            castRef.current.playOrPause()
          }
        } else {
          castRef.current.playOrPause()
        }
        return
      }
      if (t.running === false || !party.isPlaying || nowPaused) return

      const tickAgeMs = Date.now() - (t.receivedAtMs ?? Date.now())
      // Sync socket down / server stalled — free-run rather than chase a
      // frozen target (same reasoning as the local loop).
      if (tickAgeMs > 3000) return

      const clockOffset = party.clockOffsetRef?.current ?? 0
      const projectedAbsMs = projectPartyTickAbsMs(t.abs_ms, t.server_now_ms, tickAgeMs, clockOffset, Date.now())
      const targetSec = absMsToCastSec(projectedAbsMs)
      if (!shouldResyncCastReceiver(c.remote.currentTime, targetSec, GUEST_DRIFT_RESYNC_SEC)) return
      seekCastSafely(targetSec)
    }, GUEST_POLL_MS)
    return () => window.clearInterval(id)
  // Same coarse-dependency reasoning as the local-video sync effect above:
  // party/cast internals are read live through castRef/party's own stable
  // refs+callbacks, so the effect only needs to rebind on the handful of
  // primitive signals that change its BEHAVIOR (host/guest role, party
  // transitioning null↔active, the party's media changing, target
  // identity, and the local↔receiver handoff itself).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, Boolean(party), party?.isHost, party?.isPlaying, party?.partyMediaItemId, cast.status.connected])

  // Host cast→local handoff (2026-08 review fix, issue #461 follow-up).
  //
  // When a HOST stops Chromecasting mid-party, the local <video> has been
  // paused and frozen since the cast began — potentially a long time ago —
  // and the local-video sync effect's `party.isHost` branch (which reclaims
  // control the instant cast.status.connected goes false, per that effect's
  // own bail condition) deliberately never plays or drift-corrects it: the
  // host is normally assumed to BE the ground truth, so nothing else
  // corrects their video. Without this, the host would have to notice and
  // manually scrub back to the live position themselves, and their very
  // next play/pause/seek would broadcast that stale position to every
  // guest — silently teleporting the whole party backward.
  //
  // Rebuild the local session at the party's live position instead. The
  // server already has it correct: the receiver-driven effect above kept
  // broadcasting the host's actual (TV) position via requestPlay/Pause/Seek
  // for the whole cast session, and party.tickRef is populated from server
  // ticks for every participant regardless of role (useParty.tsx), so it
  // reflects that live position here even though the host branch elsewhere
  // never reads it for anything else.
  const wasCastConnectedForHostHandoffRef = useRef(false)
  useEffect(() => {
    const was = wasCastConnectedForHostHandoffRef.current
    wasCastConnectedForHostHandoffRef.current = cast.status.connected
    if (!was || cast.status.connected) return // only a true→false transition
    if (!target || !party || !party.isHost || !partyControlsMedia) return
    const t = party.tickRef.current
    if (!t) return
    const rebuild = keepaliveRecoveryRef.current.onSeekRebuild
    if (!rebuild) return
    const targetSec = Math.max(0, t.abs_ms / 1000)
    const bootIntent = { preservePause: !party.isPlaying, partyRevision: party.rev }
    pauseAfterSeekRebuildRef.current = bootIntent
    inFlightPauseIntentRef.current = bootIntent
    setStatus('Reconnecting local playback to the party…')
    rebuild(targetSec)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cast.status.connected])

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
      const absoluteEnd = bestEnd + (startSecRef.current ?? 0)
      bufferedSecRef.current = absoluteEnd
      setBufferedSec(absoluteEnd)
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
      // #334 — once sound is restored (via the pill or the normal mute
      // control), the auto-muted affordance has served its purpose.
      if (!vid.muted) setAutoStartedMuted(false)
      // Debounced persist — dragging the slider fires a burst of
      // volumechange events; write once the level settles.
      pendingVolumeRef.current = vid.volume
      if (volumeSaveTimerRef.current != null) window.clearTimeout(volumeSaveTimerRef.current)
      volumeSaveTimerRef.current = window.setTimeout(() => {
        volumeSaveTimerRef.current = null
        if (pendingVolumeRef.current !== null) writeVolumePref(pendingVolumeRef.current)
        pendingVolumeRef.current = null
      }, 400)
    }
    const onFullscreenChange = () => {
      // Issue #309 — iOS Safari reports the active fullscreen element via the
      // webkit-prefixed property, so check both.
      const fsEl = document.fullscreenElement ?? document.webkitFullscreenElement
      setFullscreen(fsEl === overlayRootRef.current)
    }
    // Issue #436 — iPhone's native video-element fullscreen (see
    // handleFullscreenToggle) never sets document.fullscreenElement, so it
    // doesn't fire the listener above; it fires these on the <video> itself.
    //
    // KNOWN GAP (unverified on-device): WebKit's `webkitDisplayingFullscreen`
    // is spec'd as "is the video in ANY non-inline presentation mode", which
    // includes Picture-in-Picture, not just true fullscreen — and entering
    // PiP from the native fullscreen player is expected to fire this same
    // event. If so, `fullscreen` stays true while the page is visible again
    // (PiP), briefly rendering fullscreen-only chrome in a windowed page
    // until PiP ends. Self-heals; not reproducible in this headless
    // environment to confirm or fix with confidence.
    const onVideoFullscreenChange = () => {
      setFullscreen(!!vid.webkitDisplayingFullscreen)
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
    // iPhone-only native video fullscreen (issue #436).
    vid.addEventListener('webkitbeginfullscreen', onVideoFullscreenChange)
    vid.addEventListener('webkitendfullscreen', onVideoFullscreenChange)
    // Apply the persisted volume BEFORE hydrating state from the element,
    // so a fresh player doesn't open at the useState(1) default. Re-runs
    // on target change are no-ops: the element keeps its volume and the
    // persisted value already matches (cleanup below flushes any pending
    // write before this effect re-runs).
    const savedVolume = readVolumePref()
    if (savedVolume !== null) vid.volume = savedVolume
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
      vid.removeEventListener('webkitbeginfullscreen', onVideoFullscreenChange)
      vid.removeEventListener('webkitendfullscreen', onVideoFullscreenChange)
      // Flush a pending debounced volume write so the last adjustment
      // before a close or episode-advance isn't lost.
      if (volumeSaveTimerRef.current != null) {
        window.clearTimeout(volumeSaveTimerRef.current)
        volumeSaveTimerRef.current = null
      }
      if (pendingVolumeRef.current !== null) {
        writeVolumePref(pendingVolumeRef.current)
        pendingVolumeRef.current = null
      }
    }
  }, [target])

  // True while any popover inside the chrome is open (audio / subtitle /
  // markers pickers, reaction picker). Read by showControlsTemporarily at
  // both schedule and fire time so an open menu can't be auto-hidden out
  // from under a reading user. Ref-based so the zero-dep useCallback below
  // always sees current state.
  const chromePopoverOpen = () =>
    audioMenuOpenRef.current || subsMenuOpenRef.current ||
    markersMenuOpenRef.current || reactionPickerOpenRef.current

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
    const scheduleHide = () => {
      hideTimerRef.current = window.setTimeout(() => {
        // Re-check at FIRE time, not only at schedule time. Focus can move into
        // the controls during the 3s window (Tab from the video surface onto the
        // scrub bar is one keystroke), and hiding then is destructive rather
        // than merely rude: the chrome goes `inert`, which triggers the HTML
        // focus-fixup rule — the focused element is unfocused and
        // document.activeElement becomes <body>. So a keyboard user who paused
        // on the seek bar to read the timestamp lost their place entirely
        // (WCAG 2.4.3). Re-arm instead; the pointer path is unaffected because
        // a mouse user has nothing focused inside the chrome (and since
        // 2026-08-09 focusInChrome only counts keyboard-originated focus,
        // incidental click-focus can't strand the timer either).
        //
        // An open popover (audio/subs/markers picker, reaction picker) also
        // re-arms: the user is reading a list, and fading the chrome would
        // yank the menu off screen mid-read.
        //
        // RE-ARM, not drop: before 2026-08-09 this branch nulled the timer and
        // returned, contradicting the comment above it — if focus entered the
        // chrome mid-window, auto-hide silently died until some later event
        // happened to re-arm it. Re-arming every 3s while a keyboard user
        // stays parked costs one sleeping timeout and keeps the hide correct
        // the moment they Tab back out.
        if (focusInChrome() || chromePopoverOpen()) {
          scheduleHide()
          return
        }
        setControlsVisible(false)
        hideTimerRef.current = null
      }, 3000)
    }
    // Only schedule the auto-hide when:
    //   - playingRef.current is true — hiding during pause is just
    //     hostile UX; the user is contemplating their next move
    //   - lastInBottomZoneRef.current is false — the user's cursor
    //     is NOT in the seek-bar/buttons region; pinning visible
    //     when they're clearly aiming at controls matches
    //     Netflix / YouTube / Plex behavior
    //   - no chrome popover is open — an open audio/subs/markers/reaction
    //     picker means the user is mid-read; Netflix/YouTube keep the
    //     chrome up in exactly this state
    if (playingRef.current && !lastInBottomZoneRef.current && !focusInChrome() && !chromePopoverOpen()) {
      scheduleHide()
    }
  }, [])

  // Input-modality tracking for focusInChrome (2026-08-09). Capture-phase
  // listeners on window record whether the last input was keyboard or
  // pointer; the hide timer's chrome-focus guard only trusts keyboard
  // focus. Without this, clicking the fullscreen button left mouse-focus
  // stranded inside the chrome and auto-hide never scheduled again.
  useEffect(() => bindInputModalityTracking(window), [])

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
    const targetSec = Math.max(0, sec)
    const localSec = targetSec - (startSecRef.current ?? 0)
    // Reuses the component-level partyControlsMedia rather than
    // recomputing the same predicate (2026-08 review nit, issue #461
    // follow-up) — both read the exact same party/target closure in the
    // same render, so they're always value-equivalent; keeping just one
    // copy means a future change to the match rule only needs one edit.
    const isPartyControllingThisMedia = partyControlsMedia

    // Guests mirror the host. Letting a guest scrub locally either causes a
    // brief snap-back inside the current buffer or stalls outside it, and the
    // server rejects their request-seek anyway. Give one honest response.
    if (isPartyControllingThisMedia && party && !party.isHost) {
      setStatus('Only the party host can seek')
      return
    }
    const broadcastHostPartySeek = () => {
      if (!isPartyControllingThisMedia || !party?.isHost) return
      // Broadcast from the user intent itself. Depending solely on the DOM
      // `seeked` echo is racy: hls.js may snap an out-of-window assignment
      // back before that event, leaving the canonical party position behind.
      // Suppress the delayed DOM echo too: repeating the fixed target after
      // the party clock has advanced would briefly rewind every participant.
      locallyBroadcastSeekUntilRef.current = Date.now() + 10_000
      party.requestSeek(Math.round(targetSec * 1000))
    }
    const rebuildAtTarget = (): boolean => {
      if (!onSeekRebuild) return false
      const liveParty = partySyncRef.current
      const livePartyControlsMedia = Boolean(liveParty) &&
        (liveParty?.partyMediaItemId === undefined || liveParty.partyMediaItemId === target?.mediaItemId)
      const inFlightIntent = inFlightPauseIntentRef.current
      const localPauseIntent = pauseIntentForReplacementSeek(
        playerReadyRef.current,
        vid.paused,
        inFlightIntent?.preservePause ?? null,
        inFlightIntent?.partyRevision ?? null,
        livePartyControlsMedia,
        liveParty?.isPlaying ?? null,
        liveParty?.rev ?? null,
      )
      const preservePause = shouldPreservePauseForLocalSeekRebuild(
        livePartyControlsMedia,
        liveParty?.isHost ?? false,
        liveParty?.isPlaying ?? false,
        localPauseIntent,
      )
      const bootIntent = {
        preservePause,
        partyRevision: livePartyControlsMedia ? liveParty?.rev ?? null : null,
      }
      pauseAfterSeekRebuildRef.current = bootIntent
      inFlightPauseIntentRef.current = bootIntent
      broadcastHostPartySeek()
      onSeekRebuild(targetSec)
      return true
    }

    // While Chromecasting, the RECEIVER — not the frozen local <video>
    // (pausedByCastRef holds it paused for the whole session) — is the
    // actual playback surface. This is reachable even mid-party: the
    // minimized-widget's "Expand player" button deliberately un-minimizes
    // without stopping the cast (remoteActive stays true), which un-inerts
    // the full player's seek bar / skip buttons / keyboard shortcuts.
    //
    // 2026-08 review fix (issue #461 follow-up): before this, every one of
    // those controls fell through to the ordinary branches below, which
    // assign vid.currentTime on the paused-and-frozen local element and (for
    // a party host) broadcast THAT meaningless local position to every
    // guest via broadcastHostPartySeek — corrupting the whole party's
    // position while the host's own TV never actually moved.
    //
    // Routed through a full session rebuild rather than an in-window
    // cast.seek(): bufferedSecRef/bufferedSec track the LOCAL element's
    // buffered ranges, which stop advancing once local playback is paused
    // for casting, so they can't reliably describe what the receiver's
    // independent fetch has actually reached — an in-window-vs-rebuild
    // decision here can't be trusted the way it can for local playback.
    // Rebuilding unconditionally is a few seconds slower than an in-window
    // seek would be, but it's the only option that's provably correct: a
    // fresh session anchored exactly at targetSec, with the receiver
    // re-pointed at it via castAdvancePendingRef + the existing
    // castReloadEpoch reload effect — the same machinery next-episode
    // auto-advance already uses to re-point a live receiver.
    if (cast.status.connected) {
      castAdvancePendingRef.current = true
      if (rebuildAtTarget()) return
      // Defensive — shouldn't happen for any delivery mode that supports
      // casting at all (direct-play has no castable HLS session, so
      // cast.status.connected implies onSeekRebuild is wired). Undo the arm
      // and fall through to the ordinary paths below so the seek at least
      // does SOMETHING rather than silently no-op.
      castAdvancePendingRef.current = false
    }

    // A target replacement clears sessionId before stream-info/createSession
    // finish. That is not direct play: a second rapid seek must supersede the
    // pending target or the host boots at the first target after broadcasting
    // the second one to everyone else.
    if (shouldRebuildSeekBeforeDeliveryReady(deliveryModeRef.current)) {
      if (rebuildAtTarget()) return
      setStatus('Player is still loading — try again in a moment')
      return
    }

    // DIRECT PLAY: the browser seeks natively via
    // byte-range requests, so the buffered-edge / session-rebuild logic
    // below — which exists for SEQUENTIAL TRANSCODES whose future
    // segments aren't on disk yet — must not run. Before this guard,
    // every jump past the (small) native buffer paid a full session
    // teardown + stream-info + reload; the skip-marker path already had
    // exactly this exemption (2026-07 review).
    if (deliveryModeRef.current === 'direct') {
      try {
        vid.currentTime = localSec
        broadcastHostPartySeek()
      } catch { /* defensive */ }
      return
    }
    // Sequential HLS can seek only inside the session's produced window.
    // Rebase for either direction outside it. In a party the host first moves
    // the canonical server anchor; every guest receives that explicit seek and
    // independently rebuilds its own session in the sync interval above.
    if (needsHlsSessionRebuild(
      targetSec,
      startSecRef.current ?? 0,
      bufferedSec,
    )) {
      if (rebuildAtTarget()) return

      // Defensive legacy fallback when a parent omits the rebuild callback.
      // Rewinds clamp to the session anchor; forward jumps land just behind
      // the produced edge rather than assigning an impossible currentTime.
      const safeBufferedEnd = bufferedSec - (startSecRef.current ?? 0)
      try {
        vid.currentTime = localSec < 0 ? 0 : Math.max(0, safeBufferedEnd - 1)
      } catch { /* defensive */ }
      setStatus('Still transcoding to that point — try again in a moment')
      return
    }
    try {
      vid.currentTime = localSec
      broadcastHostPartySeek()
    } catch { /* defensive */ }
  }, [bufferedSec, party, target, onSeekRebuild, cast.status.connected, partyControlsMedia])

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
  useEffect(() => { markersMenuOpenRef.current = markersMenuOpen }, [markersMenuOpen])

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
      // 2026-08 review fix (issue #461 follow-up) — while Chromecasting
      // (reachable here even though minimizedRef normally blocks these keys:
      // the widget's "Expand player" button un-minimizes without stopping
      // the cast), vid is paused/frozen and isn't the actual playback
      // surface. Same substitution as onPlayPause/onSeekRelative above.
      //
      // Deliberately re-reads everything through castRef/isCastTokenExpired
      // /reloadCastWithFreshToken rather than calling the outer resumeCast()
      // directly: this effect binds once per `target` (not per cast-state
      // change — see the eslint-disable below), so a captured resumeCast
      // closure could read a many-renders-stale cast.remote.isPaused and
      // silently skip the token-refresh check it exists to perform. Those
      // three all resolve through refs, so there's no equivalent staleness
      // risk reading them here.
      const c = castRef.current
      const castConnectedNow = c.status.connected
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          if (castConnectedNow) {
            if (c.remote.isPaused && isCastTokenExpired()) {
              reloadCastWithFreshToken(c.remote.currentTime)
            } else {
              c.playOrPause()
            }
            break
          }
          if (vid.paused) void vid.play().catch(() => { /* defensive */ })
          else vid.pause()
          break
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault()
          // Med-fix (2026-05-29) — route through the shared seek path
          // (REAL-FILE seconds = local currentTime + startSec offset).
          // Backward seeks just clamp; forward seeks trigger a transcode
          // rebuild when they land past the buffered head, matching the
          // scrub bar — was a raw `vid.currentTime +=` that stalled hls.js
          // on a sequential transcode.
          const baseSec = castConnectedNow ? c.remote.currentTime : vid.currentTime
          const delta = e.key === 'ArrowLeft' ? -10 : 10
          seekToRealSecRef.current((baseSec + (startSecRef.current ?? 0)) + delta)
          break
        }
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
        // Smart Skip. The pill was pointer-only: no shortcut and no focus of its
        // own, so the one control the player deliberately keeps visible through
        // the auto-hide was the one a keyboard user could not reach without
        // tabbing into chrome that may already have faded. `s` sits beside the
        // existing single-letter transport keys; the handler is a no-op outside
        // a skip window, so it can't misfire.
        case 's':
        case 'S': {
          e.preventDefault()
          // Dispatched at the DOM rather than through a callback ref, because
          // `handleSkip` and `activeSkipMarker` are both computed BELOW this
          // component's `if (!target) return null`, so no hook here can close
          // over them and no ref can be assigned to them without writing to a
          // ref during render (which react-hooks/refs correctly forbids).
          // Clicking the button also keeps one implementation of "what skipping
          // does" instead of two that can drift. No pill rendered → no-op.
          overlayRootRef.current
            ?.querySelector<HTMLButtonElement>('[data-skip-pill]')
            ?.click()
          break
        }
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
  //
  // Issue #436 — on iPhone (unlike iPad/desktop) Safari exposes NEITHER of
  // those on a <div> at all, so the button became a silent no-op there.
  // iPhone's only fullscreen surface is native video-element fullscreen
  // (OS chrome, not ours); fall back to it when div-fullscreen isn't
  // available. `onVideoFullscreenChange` (below, in the playback-event
  // effect) keeps `fullscreen` state in sync via the webkitbegin/end events
  // this path fires instead of document-level fullscreenchange.
  const handleFullscreenToggle = () => {
    const el = overlayRootRef.current
    if (!el) return
    const vid = videoRef.current
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) {
        void document.exitFullscreen().catch(() => { /* defensive */ })
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen()
      }
    } else if (vid?.webkitDisplayingFullscreen) {
      vid.webkitExitFullscreen?.()
    } else if (el.requestFullscreen) {
      void el.requestFullscreen().catch(() => { /* defensive */ })
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen()
    } else if (vid?.webkitEnterFullscreen) {
      // Unlike the div-fullscreen calls above, this one is SYNCHRONOUS and
      // WebKit specifies it as THROWING (InvalidStateError) when the element
      // can't enter fullscreen — no media player yet, or the gesture
      // requirement unmet. Swallow it for the same reason #309 feature-detects
      // rather than calling blind: an uncaught throw out of this handler is
      // exactly the failure mode that crashed the player before.
      try { vid.webkitEnterFullscreen() } catch { /* defensive — no fullscreen for you */ }
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
  // While casting the receiver's IDLE transition owns end-of-media, so
  // the card stays suppressed there.
  //
  // Issue #460 — in a watch party the card is HOST-ONLY, and its button
  // advances the ROOM (see onPartyAdvance) rather than this player. A
  // guest still never gets it: their advance would either desync them or
  // be rejected by the server's host-only check.
  const creditsMarker = target?.fileType === 'episode'
    ? skipMarkers.find(m => m.kind === 'credits' && m.end_ms > m.start_ms) ?? null
    : null

  // The card may only advance a party that is actually watching THIS
  // media. A host can hold a party while the player shows something else
  // — a scheduled lobby that hasn't started, or a party player they
  // closed — and arming there would shove the whole room into an
  // unrelated series still labelled with the party's old title.
  //
  // Strict equality on purpose. seekToRealSec's sibling check treats an
  // undefined partyMediaItemId as "controlling", which is the safe
  // default for BLOCKING a guest seek; here the same guess would push
  // content at everyone, so an unknown party media means don't touch it.
  //
  // Season/episode numbers are required too: without them the parent's
  // resolve can't run, and the host would be left clicking a live-looking
  // button that silently does nothing.
  const partyAdvanceHost = !!party?.isHost && !!onPartyAdvance &&
    party.partyMediaItemId !== undefined &&
    party.partyMediaItemId === target?.mediaItemId &&
    target?.seasonNumber != null && target?.episodeNumber != null
  // fireAdvance carries no deps (the countdown effect depends on its
  // identity), so the party branch reads through a ref.
  const partyAdvanceHostRef = useRef(false)
  partyAdvanceHostRef.current = partyAdvanceHost

  // Where the card arms. Credits onset when the file has a marker —
  // markers are optional, though, and issue #460 asks for the button on
  // any episode in a party, so the host also arms on "under 2 minutes
  // left". Whichever comes first wins.
  //
  // serverDurationRef is read during render rather than tracked as state
  // because it only ever changes in lockstep with the realDurationSec
  // state update beside it (see the stream-info boot), so a render that
  // sees one always sees the other.
  const nextUpArmSec = target?.fileType !== 'episode' ? null : nextUpArmSecond({
    creditsStartSec: creditsMarker ? creditsMarker.start_ms / 1000 : null,
    durationSec: realDurationSec,
    durationTrusted: serverDurationRef.current,
    partyHost: partyAdvanceHost,
  })

  const fireAdvance = useCallback(async (force: boolean) => {
    if (advanceFiredRef.current) return
    advanceFiredRef.current = true
    setNextUpPhase('spent')
    if (partyAdvanceHostRef.current) {
      // Party: the parent reports which of the three outcomes happened,
      // because "no next episode" and "the socket dropped" want opposite
      // UI — a finale notice vs. the button back so the host can retry.
      let outcome: 'advanced' | 'end' | 'failed' = 'failed'
      try {
        outcome = (await onPartyAdvanceRef.current?.()) ?? 'failed'
      } catch { /* treated as 'failed' — re-offer below */ }
      if (outcome === 'advanced') {
        // Stays 'spent' — the server's broadcast is what re-points us, and
        // the resulting file change resets this state (clearing the
        // watchdog with it). If neither happens the swap was rejected, so
        // hand the button back rather than leave a dead card.
        clearSwapWatchdog()
        swapWatchdogRef.current = window.setTimeout(() => {
          swapWatchdogRef.current = null
          advanceFiredRef.current = false
          setNextUpPhase('prompt')
        }, PARTY_SWAP_WATCHDOG_MS)
        return
      }
      advanceFiredRef.current = false
      setNextUpPhase(outcome === 'end' ? 'finale' : 'prompt')
      return
    }
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
  }, [clearSwapWatchdog])

  useEffect(() => {
    if (nextUpPhase !== 'idle' || nextUpArmSec == null) return
    if (!playing) return // don't pop the card under a paused frame
    if (cast.status.connected) return
    if (party && !partyAdvanceHost) return // guests never advance the room
    if (currentSec < nextUpArmSec) return
    setNextUpSecs(5)
    // In a party the card is explicit-button-only. The autoplay pref
    // governs what happens when a lone viewer does nothing; letting it
    // silently pull a whole room into the next episode is a different
    // act, and one nobody in the room opted into.
    setNextUpPhase(party ? 'prompt' : (readAutoplayPref() ? 'countdown' : 'prompt'))
  }, [nextUpPhase, nextUpArmSec, playing, party, partyAdvanceHost, cast.status.connected, currentSec])

  // Seeking back OUT of the arming window (rewatching the final scene)
  // cancels an armed card — without this the countdown keeps ticking and
  // yanks the viewer to the next episode mid-rewatch. Back to 'idle' so
  // re-crossing the threshold arms it again.
  useEffect(() => {
    if (nextUpPhase !== 'countdown' && nextUpPhase !== 'prompt') return
    if (nextUpArmSec == null) return
    if (currentSec < nextUpArmSec - 1) {
      setNextUpPhase('idle')
    }
  }, [nextUpPhase, nextUpArmSec, currentSec])

  // Countdown tick — freezes while paused (pausing mid-countdown is
  // a "wait, I'm not done" signal; resuming resumes the count).
  useEffect(() => {
    if (nextUpPhase !== 'countdown' || !playing) return
    // Issue #460 — "no passive advance in a party" has to hold at FIRE
    // time, not just when the card arms. A solo viewer can arm a
    // countdown, pause, join or create a party, and resume: the timer
    // survives all of that, and firing it would move a room nobody asked
    // to move. Demote to the explicit-button card instead of ticking.
    if (party) {
      setNextUpPhase('prompt')
      return
    }
    if (nextUpSecs <= 0) {
      void fireAdvance(false)
      return
    }
    const id = window.setTimeout(() => setNextUpSecs(s => s - 1), 1000)
    return () => window.clearTimeout(id)
  }, [nextUpPhase, nextUpSecs, playing, party, fireAdvance])

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
    if (cast.status.connected) { resumeCast(); return }
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
      // `inert` alongside aria-hidden: the minimized surface is
      // `opacity-0 pointer-events-none`, which hides it from the mouse and from
      // AT but leaves every button inside it TABBABLE — the exact 4.1.2 failure
      // PlayerControls cites inert to avoid, in the same file. The .blur() on
      // entering minimized mode handles the moment of transition, not subsequent
      // Tab presses.
      inert={minimizedActive || undefined}
      aria-hidden={minimizedActive || undefined}
      // role="dialog" + aria-modal are TRUTHFUL now, and weren't before.
      // Phase 7b makes App mark <main> inert while the theater plays, so the
      // rest of the app really is unavailable — which is exactly the condition
      // aria-modal asserts. When the backdrop was just `bg-black` the app behind
      // stayed interactive and claiming modality would have been a lie.
      //
      // Naming it also fixes the announcement gap: without a role the surface
      // was a bare div, so a screen-reader user got NOTHING when playback
      // started — their whole browse buffer silently swapped (main having become
      // AT-hidden) with no event to explain it.
      role={minimizedActive ? undefined : 'dialog'}
      aria-modal={minimizedActive ? undefined : true}
      aria-label={minimizedActive ? undefined : `Playing ${target?.title ?? 'video'}`}
      // Focusable so the surface can take focus on open. -1: reachable
      // programmatically, never a tab stop of its own.
      tabIndex={minimizedActive ? undefined : -1}
      className={
        minimizedActive
          // STACKING CONTEXT: irrelevant here, and that is the point. This element
          // carries `opacity-0`, which makes it a stacking context in its own right,
          // and it is `fixed inset-0 pointer-events-none` — fully transparent and
          // non-interactive. The `-z-10` is belt-and-braces to keep a mounted-but-
          // invisible player out of the paint order; wherever it lands it is
          // invisible by construction, so no ancestor's motion-dependence can
          // change what the user sees. Annotated rather than removed because
          // audit-reduced-motion.mjs Check 2 rightly asks about every negative z.
          // Keep the full player MOUNTED but off-screen while minimized: the
          // Chromecast streaming session and the AirPlay <video> source must
          // stay alive (closing the laptop view must not kill the cast). The
          // floating widget below is the visible surface.
          ? 'fixed inset-0 -z-10 opacity-0 pointer-events-none'
          // No `bg-black` and no flex centring any more (D5). The surface is
          // transparent; what fills it is the veil over the dimmed app plus the
          // theater box, both absolutely positioned. In fullscreen the box
          // covers the viewport and the veil is skipped entirely — there is
          // nothing to see behind it, so compositing a blur there would be pure
          // cost. See the .stage-dim-veil note in index.css about that budget.
          : 'fixed inset-0 z-[60]'
      }
    >
      {/* The veil. Theater only — see above. */}
      {!fullscreen && !minimizedActive && <div className="stage-dim-veil" aria-hidden="true" />}
      {/* Player shell.
          THEATER (Aurora Stage Phase 7b, D5): the mockup's inset box — 90px
          sides, 58px top/bottom, 20px radius — with the dimmed app visible
          behind it. This REPLACES the previous treatment, which was a card
          capped at 94vw/88vh centred inside an opaque black backdrop. The
          asymmetric inset is why it is absolute edge offsets rather than a
          max-width card: a centred `max-w` cannot express 90/58, and the black
          backdrop it used to sit on is now the app.
          It falls back to full-bleed below lg — 90px per side leaves 195px of
          picture on a phone; see .stage-theater's media query.
          FULLSCREEN: fills the viewport edge-to-edge (box chrome looks wrong
          against the screen bezel).
          The <video> inside still uses object-contain, so the picture
          letterboxes within the box — margins are (inset) + (aspect letterbox).

          NOTE the word "windowed" is deliberately gone from this file. It used
          to mean "not browser-fullscreen", which collided with 7b's windowed
          theater; the two states are now `theater` and `fullscreen`. */}
      <div
        className={
          fullscreen
            ? 'relative w-full h-full flex flex-col'
            : 'stage-theater flex flex-col'
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
          // data-player-chrome marks every auto-hiding region, so the hide
          // timer can refuse to fire while KEYBOARD focus is inside one
          // (lib/chromeFocus gates the guard on input modality — pointer
          // click-focus must not suppress auto-hide). See
          // showControlsTemporarily.
          data-player-chrome=""
          // `pointer-events-none` alone hid this from the MOUSE and left it in
          // the tab ring: in fullscreen, three seconds of idle made the title
          // bar's Close and track pickers invisible-but-focusable, so Tab
          // painted a focus ring on nothing (WCAG 2.4.7, 2.4.11). `inert`
          // removes them from the tab order and the a11y tree too — the same
          // treatment PlayerControls already applies to its own row.
          inert={(fullscreen && !controlsVisible) || undefined}
          className={
            fullscreen
              ? `stage-player-topbar absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-3 transition-opacity duration-200 ${
                  controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                }`
              : 'stage-player-topbar flex items-center justify-between px-6 py-3 z-10'
          }
        >
          {/* Title block — the mockup's .t-title: one 17px display line with the
              episode and the stream status stacked under it as one small line,
              rather than three stacked paragraphs at three sizes. */}
          <div className="min-w-0 flex items-center gap-3">
            <div className="min-w-0">
              <h2 className="text-white font-display text-[17px] font-bold truncate">{target.title}</h2>
              <p className="text-white/60 text-[11.5px] font-medium mt-0.5 truncate">
                {[target.subtitle, status].filter(Boolean).join(' · ')}
              </p>
            </div>
            {/* Casting status pill. Net-new chrome for state that already
                existed but was only inferable from the Cast button's colour:
                while a remote session is live, the local surface is a REMOTE
                CONTROL, not the thing playing, and nothing said so. Cyan
                rather than purple because it is a different kind of state from
                an Aurora control. Only when a session is actually connected —
                never as decoration. */}
            {remoteActive && (
              // No role="status". Once connected the text never changes, so it
              // would be a live region that can never fire again — and the
              // announcement it was meant to make is unreliable anyway, since the
              // region and its content are inserted in the SAME mutation, which
              // many screen readers do not announce (a live region generally has
              // to pre-exist to be watched). Plain labelled text is honest; the
              // state also reaches AT through the Cast button's own name.
              <span className="stage-cast-pill inline-flex flex-none">
                <i className="stage-cast-dot" aria-hidden="true" />
                {cast.status.connected ? 'Casting' : 'AirPlay'}
              </span>
            )}
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
              <ReactionPicker
                onSend={onSendReaction}
                vertical="down"
                // Pin the auto-hide timer while the picker is open so the
                // emoji row can't fade out mid-choice (fullscreen chrome
                // auto-hides; this trigger lives in it).
                onOpenChange={(o) => { reactionPickerOpenRef.current = o }}
              />
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
              {/* #334 — "Tap for sound" affordance. Shown only when we
                  auto-started playback muted because the browser blocked a
                  sounded autoplay (almost always a party start, where play()
                  fires from a WebSocket event rather than a click). NOT gated
                  on controlsVisible — it's a call to action that must stay
                  put until the user acts. One tap restores audio and clears
                  the flag (also cleared via onVolumeChange if they use the
                  normal mute control). */}
              {autoStartedMuted && (
                <button
                  type="button"
                  aria-label="Playback started muted — tap for sound"
                  onClick={() => {
                    const vid = videoRef.current
                    if (vid) {
                      vid.muted = false
                      if (vid.volume === 0) vid.volume = 1
                    }
                    setAutoStartedMuted(false)
                  }}
                  className="absolute bottom-24 left-1/2 -translate-x-1/2 z-20 inline-flex items-center gap-2 rounded-full bg-purple-600/90 hover:bg-purple-600 px-4 h-10 text-white text-sm font-semibold shadow-lg animate-fade-in"
                >
                  <VolumeX size={18} />
                  Tap for sound
                </button>
              )}
              {/* Cast button. Visible whenever the Cast SDK loaded
                  successfully, NOT gated on a currently-reachable
                  receiver — mDNS discovery is slow and unreliable
                  on some networks, and YouTube/Netflix both show
                  the button even when no devices are yet visible
                  (the picker itself handles the "no devices"
                  case).

                  Available during a watch party too: when the party
                  controls this media, a dedicated receiver-driven sync
                  effect (below the local guest-mirror/host-broadcast
                  effect) takes over — the receiver itself becomes the
                  mirrored/broadcast surface instead of the local <video>.
                  A party room playing UNRELATED solo content behaves
                  exactly like solo casting (nothing to sync).

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
                  so it stays hidden there).

                  AirPlay needs no special party-sync wiring at all: unlike
                  Chromecast, the local <video> element IS the AirPlay-mirrored
                  source (see the airplayActive effect above), so it stays
                  driven by the ordinary, unmodified local guest-mirror /
                  host-broadcast effect the whole time — full sync fidelity
                  "for free." */}
              {airplayAvailable && !cast.status.connected && (
                <div
                  data-player-chrome=""
                  inert={!controlsVisible || undefined}
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
              {cast.status.supported && (
                <div
                  data-player-chrome=""
                  inert={!controlsVisible || undefined}
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
              {/* One-shot announcement. The pill is a transient, time-boxed
                  offer — it appears for a few seconds and then it's gone — so a
                  screen-reader user who never tabs into the video surface had no
                  way to learn it existed (WCAG 4.1.3 Status Messages). The live
                  line is separate from the button so the button's own label
                  isn't re-read, and it is keyed on the marker so re-entering a
                  window announces again while a re-render does not. */}
              {activeSkipMarker && (
                <p key={`${activeSkipMarker.kind}:${activeSkipMarker.start_ms}`} role="status" className="sr-only">
                  {skipLabel} available — press S
                </p>
              )}
              {activeSkipMarker && (
                <button
                  type="button"
                  onClick={handleSkip}
                  // The shortcut is in the accessible name, not only in a
                  // `title`: a tooltip is neither keyboard- nor AT-discoverable.
                  aria-keyshortcuts="S"
                  title={`${skipLabel} (S)`}
                  data-skip-pill=""
                  // .stage-skip-pill: white-on-dark, not the previous
                  // dark-on-video. This appears over an arbitrary frame for a
                  // few seconds and is the one control that has to be
                  // unmissable in that window — a translucent black pill on a
                  // night-time scene was close to invisible, which defeats the
                  // feature. Position stays where it was.
                  className="stage-skip-pill absolute bottom-28 right-[26px] z-[55] inline-flex"
                >
                  {skipLabel}
                  <SkipForward size={15} />
                </button>
              )}
              {/* Smart Skip next-up card — appears when an episode
                  crosses its credits onset. Countdown mode when the
                  autoplay pref is on; explicit-button mode when off
                  (the click then forces the advance past the pref —
                  an explicit click outranks a passive setting). */}
              {(nextUpPhase === 'countdown' || nextUpPhase === 'prompt') && (!party || partyAdvanceHost) && (
                // Issue #460 — the party clause covers host succession: if
                // the host is demoted while their card is up, it has to go.
                // Without this the ex-host keeps a button that would fall
                // through to the solo advance path, which refuses to move a
                // party and reports "that's the last episode" instead.
                //
                // .stage-upnext. The mockup's card leads with a purple
                // "UP NEXT" eyebrow and puts the countdown in the corner rather
                // than in the body line, so the card reads the same whether the
                // autoplay pref is on or off — only the counter appears.
                // No thumbnail: the mockup shows one, but nothing here knows the
                // next episode's still until the advance resolves it, and
                // rendering a placeholder frame would imply we do.
                // NO role="status" on this wrapper. Adding one (which the first
                // version of this restyle did) turned the card into a live region
                // that CONTAINS the countdown, so every tick re-announced —
                // "in 5s… in 4s… in 3s…" queued over whatever the user was
                // doing. The classic countdown-in-a-live-region anti-pattern.
                // The card's appearance is announced once by the sr-only line
                // below; the ticking counter is aria-hidden.
                <div className="stage-upnext absolute bottom-28 right-[26px] z-[55]">
                  <div className="p-[15px] pb-3.5">
                    {/* One polite announcement when the card appears, with no
                        number in it, so it never re-fires. */}
                    {/* Still number-free so it announces exactly once, but
                        it has to carry the blast radius: the visible
                        "plays for everyone" line sits outside the live
                        region, so without this a screen-reader host hears
                        precisely what a solo viewer hears before taking an
                        action that moves the whole room. */}
                    <span className="sr-only" role="status">
                      {partyAdvanceHost
                        ? 'Next episode available — playing it starts it for everyone in the party'
                        : 'Next episode available'}
                    </span>
                    <p className="stage-upnext-eyebrow" aria-hidden="true">Up next</p>
                    <p className="text-white text-[13.5px] font-semibold mt-1">Next episode</p>
                    {/* Issue #460 — name the blast radius. The host's click
                        moves every person in the room, and a button that
                        looks identical to the solo one hides that. */}
                    {partyAdvanceHost && (
                      <p className="text-white/60 text-[11px] mt-0.5">Plays for everyone in the party</p>
                    )}
                    <div className="mt-2.5 flex items-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => { void fireAdvance(true) }}
                        className="inline-flex items-center gap-1.5 h-[30px] px-3.5 rounded-lg bg-white hover:bg-white/90 text-[#0a0a0a] text-[11.5px] font-bold transition-colors"
                      >
                        <Play size={12} />
                        {partyAdvanceHost ? 'Play for all' : 'Play now'}
                      </button>
                      {nextUpPhase === 'countdown' && (
                        // aria-hidden: a per-second counter is information for
                        // the eye. The "Play now" button says what the action is,
                        // and re-announcing a number every second is noise.
                        <span className="text-white/70 text-[11px] tabular-nums" aria-hidden="true">
                          in {Math.max(0, nextUpSecs)}s
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setNextUpPhase('spent')}
                        aria-label="Dismiss next-episode card"
                        title="Keep watching the credits"
                        className="ml-auto w-[26px] h-[26px] rounded-full grid place-items-center bg-black/60 hover:bg-black/80 border border-white/20 text-white/85 transition-colors"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {/* Series end: the advance found nothing to play. Brief
                  honest feedback (auto-dismisses) instead of a card
                  that promised a next episode and silently vanished. */}
              {nextUpPhase === 'finale' && (!party || partyAdvanceHost) && (
                // Same party gate as the card above: a guest who armed
                // this while watching alone and then joined a party must
                // not be told the series ended on the host's behalf.
                <div
                  role="status"
                  className="absolute bottom-28 right-6 z-[55] rounded-xl bg-[#1a1a22]/95 ring-1 ring-white/10 shadow-2xl px-4 py-3"
                >
                  <p className="text-white/80 text-sm">That's the last episode — you're all caught up.</p>
                </div>
              )}
              {/* 2026-08 review fix (issue #461 follow-up) — while
                  Chromecasting (reachable via "Expand player" without
                  stopping the cast, in or out of a party), playing/
                  currentSec/bufferedSec are local-<video> state that
                  pausedByCastRef holds paused/frozen for the whole cast
                  session. onSeek/onSeekRelative/onPlayPause below already
                  act on the receiver when casting — display what they'd
                  actually act on too, or the scrub bar shows a frozen
                  position/wrong icon that visibly jumps once touched.
                  cast.remote.currentTime is receiver/session-relative (like
                  local vid.currentTime), so it needs the same +startSecRef
                  conversion used everywhere else in this file to become
                  REAL-FILE absolute; cast.remote.duration is comparatively
                  unreliable for a growing HLS transcode, so durationSec
                  keeps using the already-absolute, receiver-independent
                  realDurationSec regardless of cast state. There's no
                  receiver-side "buffered ahead" concept to substitute for
                  bufferedSec, so it just tracks the (also substituted)
                  playhead — no buffered-ahead fill rather than a stale or
                  fabricated one. */}
              <PlayerControls
                playing={cast.status.connected ? !cast.remote.isPaused : playing}
                currentSec={cast.status.connected ? cast.remote.currentTime + (startSecRef.current ?? 0) : currentSec}
                durationSec={realDurationSec}
                bufferedSec={cast.status.connected ? cast.remote.currentTime + (startSecRef.current ?? 0) : bufferedSec}
                volume={volume}
                muted={muted}
                fullscreen={fullscreen}
                visible={controlsVisible}
                onPlayPause={() => {
                  // While Chromecasting, the play/pause control drives the
                  // RECEIVER (the local <video> is held paused as the surface).
                  // resumeCast renews an expired cast token before resuming.
                  if (cast.status.connected) { resumeCast(); return }
                  const vid = videoRef.current
                  if (!vid) return
                  if (vid.paused) void vid.play().catch(() => { /* defensive */ })
                  else vid.pause()
                }}
                onSeek={seekToRealSec}
                onSeekRelative={(delta) => {
                  // Med-fix (2026-05-29) — was a raw
                  // `vid.currentTime = max(0, currentTime + delta)`,
                  // so the forward skip button (then +30s, now +10s)
                  // seeked past the FFmpeg
                  // output head and stalled hls.js. Convert the
                  // relative delta to a REAL-FILE absolute target
                  // (local currentTime + startSec offset + delta) and
                  // route through seekToRealSec, which triggers a
                  // transcode rebuild on a forward jump past the
                  // buffered head — same path the scrubber uses.
                  // Backward deltas flow through unchanged (the
                  // rebuild branch only fires near/past the buffered
                  // edge; going back just clamps).
                  //
                  // 2026-08 review fix (issue #461 follow-up) — while
                  // Chromecasting, vid.currentTime is frozen wherever local
                  // playback was paused when the cast began; basing a
                  // relative skip off it would compute a target completely
                  // disconnected from where the receiver's TV actually is.
                  // Use the receiver's own live position instead.
                  const baseSec = cast.status.connected
                    ? cast.remote.currentTime
                    : videoRef.current?.currentTime
                  if (baseSec === undefined) return
                  seekToRealSec((baseSec + (startSecRef.current ?? 0)) + delta)
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
